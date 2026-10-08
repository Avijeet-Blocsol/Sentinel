/**
 * Strands Sentinel - WebSocket Ticket Controller
 * Handles HTTP requests to issue WebSocket upgrade tickets.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { wsTicketService } from './ws_ticket.service.js';
import { sendServiceUnavailable } from '../common/errors.js';

export class WsTicketController {
  async issue(req: FastifyRequest, reply: FastifyReply) {
    try {
      const ticket = wsTicketService.issueTicket(req.user.id);
      return reply.status(200).send(ticket);
    } catch (error: any) {
      req.log.error({ err: error }, 'Failed to issue WebSocket ticket');
      return sendServiceUnavailable(reply, 'Realtime authentication is not configured');
    }
  }
}

export const wsTicketController = new WsTicketController();
