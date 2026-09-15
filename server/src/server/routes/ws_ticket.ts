import { FastifyPluginAsync } from 'fastify';
import { issueWsTicket } from '../../middlewares/ws_ticket.js';

export const wsTicketRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/ticket', async (req, reply) => {
    try {
      return reply.status(200).send(issueWsTicket(req.user.id));
    } catch (error: any) {
      req.log.error({ err: error }, 'Failed to issue WebSocket ticket');
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Realtime authentication is not configured',
      });
    }
  });
};
