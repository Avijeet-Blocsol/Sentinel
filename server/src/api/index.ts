/**
 * Strands Sentinel - Master API Router
 * Aggregates and registers all modular API routes and WebSocket handlers onto Fastify.
 */

import { FastifyInstance } from 'fastify';
import { userRoutes } from './users/index.js';
import { conversationRoutes } from './conversations/index.js';
import { ruleRoutes } from './rules/index.js';
import { interruptRoutes } from './interrupts/index.js';
import { alertRoutes } from './alerts/index.js';
import { engineRoutes } from './engine/index.js';
import { wsTicketRoutes } from './ws_ticket/index.js';
import { wsRoutes } from './realtime/index.js';

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(conversationRoutes, { prefix: '/api/conversations' });
  await app.register(ruleRoutes, { prefix: '/api/rules' });
  await app.register(interruptRoutes, { prefix: '/api/interrupts' });
  await app.register(alertRoutes, { prefix: '/api/alerts' });
  await app.register(engineRoutes, { prefix: '/api/engine' });
  await app.register(wsTicketRoutes, { prefix: '/api/ws' });
  await app.register(wsRoutes, { prefix: '/ws/conversation' });
}

export {
  userRoutes,
  conversationRoutes,
  ruleRoutes,
  interruptRoutes,
  alertRoutes,
  engineRoutes,
  wsTicketRoutes,
  wsRoutes,
};
