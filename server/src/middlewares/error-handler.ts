/**
 * Strands Sentinel - Global Error Handler Middleware
 * Masks internal errors in production and formats validation issues
 */

import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export function errorHandler(error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  req.log.error({
    err: error,
    url: req.raw.url,
    method: req.raw.method,
    userId: req.user?.id,
  }, 'Unhandled request error');

  // 1. Handle Zod Validation Errors
  if (error instanceof ZodError) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  // 2. Handle Fastify Validation Errors (Schema validation)
  if ('validation' in error && (error as any).validation) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: error.message,
      issues: (error as any).validation,
    });
  }

  // 3. Handle Explicit HTTP status errors (e.g. 401, 403, 404, 429)
  const statusCode = (error as FastifyError).statusCode || 500;
  if (statusCode < 500) {
    return reply.status(statusCode).send({
      statusCode,
      error: error.name || 'Request Error',
      message: error.message,
    });
  }

  // 4. Handle 500 Internal Server Errors
  const isProduction = process.env.NODE_ENV === 'production';
  return reply.status(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: isProduction
      ? 'An unexpected error occurred. Please try again later.'
      : error.message,
    ...(isProduction ? {} : { stack: error.stack }),
  });
}
