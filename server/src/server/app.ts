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
import { registerApiRoutes } from '../api/index.js';
import { activeProvider, checkDatabaseReadiness } from '../db/index.js';
import { getProductionConfigurationIssues } from '../config/production_readiness.js';
import { redactRequestUrl } from '../middlewares/error-handler.js';

export interface BuildServerOptions extends FastifyServerOptions {
  /** Optional custom auth preHandler hook (useful for testing/mocking) */
  authPreHandler?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const { authPreHandler = requireAuth, ...fastifyOpts } = opts;
  const defaultLogger = {
    serializers: {
      req: (request: { method?: string; url?: string; hostname?: string; ip?: string }) => ({
        method: request.method,
        url: redactRequestUrl(request.url || '/'),
        hostname: request.hostname,
        remoteAddress: request.ip,
      }),
    },
  };

  const app = fastify({
    logger: fastifyOpts.logger === undefined ? defaultLogger : fastifyOpts.logger,
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
    await registerApiRoutes(protectedApp);
  });

  return app;
}
