/**
 * Strands Sentinel - Users Controller
 * Handles HTTP requests for user profile and push device registration.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { RegisterDeviceBodySchema } from './users.schema.js';
import { usersService } from './users.service.js';
import { sendBadRequest } from '../common/errors.js';

export class UsersController {
  async getMe(req: FastifyRequest, reply: FastifyReply) {
    return reply.status(200).send({
      user: req.user,
    });
  }

  async registerDevice(req: FastifyRequest, reply: FastifyReply) {
    const parseResult = RegisterDeviceBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid request body', parseResult.error.issues);
    }

    const device = await usersService.registerDevice(req.user.id, parseResult.data);
    return reply.status(201).send({
      success: true,
      device,
    });
  }

  async getDevices(req: FastifyRequest, reply: FastifyReply) {
    const devices = await usersService.getDevices(req.user.id);
    return reply.status(200).send({
      devices,
    });
  }
}

export const usersController = new UsersController();
