/**
 * Sentinel Backend - Clerk Authentication Service
 * Verifies JWT session tokens from mobile client requests.
 */
import { createClerkClient, verifyToken } from '@clerk/backend';

const secretKey = process.env.CLERK_SECRET_KEY;
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;

export const clerkClient = createClerkClient({
  secretKey: secretKey || '',
  publishableKey: publishableKey || '',
});

export interface AuthenticatedUser {
  userId: string;
  sessionId?: string;
}

/**
 * Verify a Clerk session JWT token from an Authorization: Bearer <token> header
 * or WebSocket handshake query parameter.
 */
export async function verifyClerkToken(token: string): Promise<AuthenticatedUser> {
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is not configured in server environment.');
  }

  const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();

  // Verify the JWT token using Clerk's backend verifier
  const verifiedPayload = await verifyToken(cleanToken, {
    secretKey,
  });

  if (!verifiedPayload || !verifiedPayload.sub) {
    throw new Error('Invalid or expired Clerk session token.');
  }

  return {
    userId: verifiedPayload.sub,
    sessionId: verifiedPayload.sid as string | undefined,
  };
}

/**
 * Fetch full Clerk user profile details
 */
export async function getClerkUser(userId: string) {
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is not configured.');
  }
  return await clerkClient.users.getUser(userId);
}
