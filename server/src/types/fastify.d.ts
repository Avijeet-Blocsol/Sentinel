import { User } from '@sentinel/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}
