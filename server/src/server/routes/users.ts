/**
 * Strands Sentinel - User Routes
 * Endpoints for user profile inspection and push notification device registration
 */

import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { userDeviceRepository, type UserDevice } from '../../db/index.js';

const RegisterDeviceBodySchema = z.object({
  push_token: z.string().trim().min(1, 'push_token is required').max(4096),
  platform: z.enum(['ios', 'android', 'web']),
});

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/users/me
   * Returns the authenticated user's profile details.
   */
  fastify.get('/me', async (req, reply) => {
    return reply.status(200).send({
      user: req.user,
    });
  });

  /**
   * POST /api/users/devices
   * Registers or updates a device push token for notifications.
   */
  fastify.post('/devices', async (req, reply) => {
    const parseResult = RegisterDeviceBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid request body',
        issues: parseResult.error.issues,
      });
    }

    const { push_token, platform } = parseResult.data;

    const existingDevices = await userDeviceRepository.getByUserId(req.user.id);
    const existing = existingDevices.find((candidate) => candidate.push_token === push_token);
    const device: UserDevice = {
      id: existing?.id || randomUUID(),
      user_id: req.user.id,
      push_token,
      platform,
      last_active_at: Date.now(),
    };

    await userDeviceRepository.registerDevice(device);

    return reply.status(201).send({
      success: true,
      device,
    });
  });

  /**
   * GET /api/users/devices
   * Lists all registered devices for the authenticated user.
   */
  fastify.get('/devices', async (req, reply) => {
    const devices = await userDeviceRepository.getByUserId(req.user.id);
    return reply.status(200).send({
      devices,
    });
  });
};
