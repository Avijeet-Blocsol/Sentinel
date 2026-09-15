/**
 * Strands Sentinel - Fastify Server Factory
 * Configures security, rate limiting, global authentication, and route modules
 */

import fastify, { FastifyInstance, FastifyServerOptions, FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import {
  registerSecurityHeaders,
  registerRateLimiting,
  errorHandler,
  requireAuth,
} from '../middlewares/index.js';
import { userRoutes } from './routes/users.js';
import { conversationRoutes } from './routes/conversations.js';
import { ruleRoutes } from './routes/rules.js';
import { interruptRoutes } from './routes/interrupts.js';
import { alertRoutes } from './routes/alerts.js';
import { wsRoutes } from './routes/ws.js';
import { engineRoutes } from './routes/engine.js';
import { wsTicketRoutes } from './routes/ws_ticket.js';
import { activeProvider, checkDatabaseReadiness } from '../db/index.js';
import { getProductionConfigurationIssues } from '../config/production_readiness.js';

export interface BuildServerOptions extends FastifyServerOptions {
  /** Optional custom auth preHandler hook (useful for testing/mocking) */
  authPreHandler?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const { authPreHandler = requireAuth, ...fastifyOpts } = opts;

  const app = fastify({
    logger: true,
    bodyLimit: 1048576, // 1MB payload ceiling
    ...fastifyOpts,
  });

  // 1. Register Global Error Handler
  app.setErrorHandler(errorHandler);

  // 2. Register HTTP Security Headers (@fastify/helmet)
  await registerSecurityHeaders(app);

  // 3. Register Rate Limiting (@fastify/rate-limit)
  await registerRateLimiting(app);

  // 3b. Allow the separately hosted web client to call the API. Native
  // mobile clients do not use CORS, but Expo web does.
  const configuredOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const corsOrigin = configuredOrigins.length > 0
    ? configuredOrigins
    : process.env.NODE_ENV === 'development'
      ? true
      : false;
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  // 4. Register WebSocket support
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024, // 64KB frame limit
    },
  });

  // Health endpoints are intentionally public so load balancers can determine
  // liveness/readiness without possessing an end-user token.
  app.get('/healthz', async () => ({ status: 'ok', service: 'sentinel-server' }));
  app.get('/readyz', async (_req, reply) => {
    const production = process.env.NODE_ENV === 'production';
    const provider = activeProvider;
    const configurationIssues = getProductionConfigurationIssues();
    if (configurationIssues.length > 0) {
      app.log.warn({ configurationIssues }, 'Production runtime configuration is incomplete');
      return reply.status(503).send({ status: 'not_ready', reason: 'runtime_configuration_incomplete' });
    }
    if (production && provider !== 'dynamodb') {
      return reply.status(503).send({ status: 'not_ready', reason: 'production_database_provider_not_configured' });
    }
    try {
      await checkDatabaseReadiness();
    } catch (error) {
      app.log.warn({ err: error }, 'Database readiness check failed');
      return reply.status(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    }
    return reply.status(200).send({ status: 'ready', databaseProvider: provider });
  });

  // 5. Keep the private application surface in one authenticated Fastify
  // scope. Hooks are encapsulated by plugin context, so /healthz and /readyz
  // above remain the only intentionally public endpoints.
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authPreHandler);

    // 6. Register API and realtime routes
    await protectedApp.register(userRoutes, { prefix: '/api/users' });
    await protectedApp.register(conversationRoutes, { prefix: '/api/conversations' });
    await protectedApp.register(ruleRoutes, { prefix: '/api/rules' });
    await protectedApp.register(interruptRoutes, { prefix: '/api/interrupts' });
    await protectedApp.register(alertRoutes, { prefix: '/api/alerts' });
    await protectedApp.register(engineRoutes, { prefix: '/api/engine' });
    await protectedApp.register(wsTicketRoutes, { prefix: '/api/ws' });
    await protectedApp.register(wsRoutes, { prefix: '/ws/conversation' });
  });

  return app;
}
