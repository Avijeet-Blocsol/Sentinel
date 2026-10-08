/**
 * Strands Sentinel - API Common Utilities
 * Reusable HTTP error and response helpers for Fastify API controllers.
 */

import { FastifyReply } from 'fastify';

export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  issues?: unknown[];
}

export function sendBadRequest(reply: FastifyReply, message: string, issues?: unknown[]): FastifyReply {
  return reply.status(400).send({
    statusCode: 400,
    error: 'Bad Request',
    message,
    ...(issues ? { issues } : {}),
  });
}

export function sendNotFound(reply: FastifyReply, message: string = 'Not Found'): FastifyReply {
  return reply.status(404).send({
    statusCode: 404,
    error: 'Not Found',
    message,
  });
}

export function sendForbidden(reply: FastifyReply, message: string = 'Forbidden'): FastifyReply {
  return reply.status(403).send({
    statusCode: 403,
    error: 'Forbidden',
    message,
  });
}

export function sendServiceUnavailable(reply: FastifyReply, message: string = 'Service Unavailable'): FastifyReply {
  return reply.status(503).send({
    statusCode: 503,
    error: 'Service Unavailable',
    message,
  });
}
