/**
 * Strands Sentinel - Clerk Authentication Middleware
 * Validates Clerk RS256 JWTs and injects typed `req.user`
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createClerkClient, verifyToken as clerkVerifyToken } from '@clerk/backend';
import { userRepository, type User } from '../db/index.js';
import { consumeWsTicket } from './ws_ticket.js';

const secretKey = process.env.CLERK_SECRET_KEY || '';
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || '';
const configuredServiceSecret = process.env.ENGINE_API_SECRET || process.env.SENTINEL_SERVICE_SECRET || '';

if (process.env.NODE_ENV === 'production' && !configuredServiceSecret) {
  throw new Error('Production requires ENGINE_API_SECRET or SENTINEL_SERVICE_SECRET');
}
if (process.env.NODE_ENV === 'production' && !secretKey) {
  throw new Error('Production requires CLERK_SECRET_KEY');
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export const clerkClient = createClerkClient({
  secretKey,
  publishableKey,
});

/**
 * Extracts and verifies Clerk token from Authorization header or query parameter
 */
export async function verifyToken(token: string): Promise<string> {
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is not configured');
  }

  try {
    const verified = await clerkVerifyToken(token, {
      secretKey,
    });
    if (verified && verified.sub) {
      return verified.sub;
    }
  } catch (verifyErr) {
    throw verifyErr;
  }

  throw new Error('Clerk token verification failed');
}

/**
 * Just-in-time (JIT) user lookup or creation from Clerk
 */
export async function getOrCreateUser(userId: string): Promise<User> {
  // 1. Check local DB
  const existing = await userRepository.getById(userId);
  if (existing) {
    return existing;
  }

  const createOrReadConcurrent = async (candidate: User): Promise<User> => {
    try {
      await userRepository.create(candidate);
      return candidate;
    } catch (createError) {
      // Two simultaneous first requests can both observe a missing user. If
      // the unique insert lost the race, return the user created by the winner.
      const concurrent = await userRepository.getById(userId);
      if (concurrent) return concurrent;
      throw createError;
    }
  };

  // 2. Fetch full user profile from Clerk
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const primaryEmail =
      clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ||
      clerkUser.emailAddresses[0]?.emailAddress ||
      '';

    const name =
      `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() ||
      clerkUser.username ||
      'Sentinel User';

    const newUser: User = {
      id: userId,
      google_sub: null,
      apple_sub: null,
      github_sub: null,
      email: primaryEmail,
      name,
      avatar_url: clerkUser.imageUrl || null,
      created_at: clerkUser.createdAt || Date.now(),
      updated_at: clerkUser.updatedAt || Date.now(),
    };

    return await createOrReadConcurrent(newUser);
  } catch (err) {
    // A verified session still requires a successful Clerk profile lookup so
    // the persisted identity is never synthesized from a placeholder.
    throw err;
  }
}

/**
 * Fastify preHandler hook for authenticating HTTP and WebSocket upgrade requests.
 * Extracts a Clerk bearer token for HTTP, or a short-lived WebSocket ticket for
 * upgrade requests, verifies it, and attaches `req.user`.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let token: string | undefined;

  // 1. Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. WebSockets use an opaque, short-lived signed ticket instead of putting
  // a long-lived Clerk JWT in URL logs.
  const requestPath = req.url.split('?')[0];
  const isWebSocketUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket' &&
    requestPath.startsWith('/ws/conversation/');
  const wsTicket = (req.query as { ticket?: string })?.ticket;
  if (!token && wsTicket && isWebSocketUpgrade) {
    const claims = consumeWsTicket(wsTicket);
    if (!claims) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or expired WebSocket ticket',
      });
    }

    try {
      req.user = await getOrCreateUser(claims.userId);
      return;
    } catch (err: any) {
      req.log.warn({ err }, 'WebSocket ticket user lookup failed');
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'WebSocket ticket user is unavailable',
      });
    }
  }

  // 3. Check for M2M Engine Secret (Amazon EventBridge Scheduler, SQS Consumer, Lambda)
  const serviceSecret = process.env.ENGINE_API_SECRET || process.env.SENTINEL_SERVICE_SECRET || configuredServiceSecret;
  const headerSecret = (req.headers['x-engine-secret'] as string) || '';
  const isEngineRoute = req.url.split('?')[0].startsWith('/api/engine/');
  if (isEngineRoute && serviceSecret && ((token && secretsEqual(token, serviceSecret)) || secretsEqual(headerSecret, serviceSecret))) {
    req.user = {
      id: 'system_engine_worker',
      email: 'engine@sentinel.internal',
      name: 'Sentinel Engine Worker',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    return;
  }

  if (!token) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Authentication token required',
    });
  }

  try {
    const userId = await verifyToken(token);
    const user = await getOrCreateUser(userId);
    req.user = user;
  } catch (err: any) {
    req.log.warn({ err }, 'Authentication failed');
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Authentication could not be verified',
    });
  }
}
