/**
 * Strands Sentinel - WebSocket Ticket Service
 * Issues signed, short-lived tokens for authenticating WebSocket upgrade requests.
 */

import { issueWsTicket } from '../../middlewares/ws_ticket.js';

export type IssuedWsTicket = ReturnType<typeof issueWsTicket>;

export class WsTicketService {
  issueTicket(userId: string): IssuedWsTicket {
    return issueWsTicket(userId);
  }
}

export const wsTicketService = new WsTicketService();
