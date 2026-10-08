/**
 * Strands Sentinel - User Routes
 * Endpoints for user profile inspection and push notification device registration
 */

import { FastifyPluginAsync } from 'fastify';
import { usersController } from './users.controller.js';

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/users/me
   * Returns the authenticated user's profile details.
   */
  fastify.get('/me', usersController.getMe.bind(usersController));

  /**
   * POST /api/users/devices
   * Registers or updates a device push token for notifications.
   */
  fastify.post('/devices', usersController.registerDevice.bind(usersController));

  /**
   * GET /api/users/devices
   * Lists all registered devices for the authenticated user.
   */
  fastify.get('/devices', usersController.getDevices.bind(usersController));
};
