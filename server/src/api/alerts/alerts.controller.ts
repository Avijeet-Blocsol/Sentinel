/**
 * Strands Sentinel - Alerts Controller
 * Handles HTTP requests for alert history and timeline views.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { AlertQuerySchema } from './alerts.schema.js';
import { alertsService, AlertNotFoundError, AlertForbiddenError } from './alerts.service.js';
import { sendBadRequest, sendNotFound, sendForbidden } from '../common/errors.js';

export class AlertsController {
  async list(req: FastifyRequest, reply: FastifyReply) {
    const parseResult = AlertQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid alert query parameters', parseResult.error.issues);
    }

    const alerts = await alertsService.getAlerts(req.user.id, parseResult.data);
    return reply.status(200).send({
      alerts,
    });
  }

  async getById(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    try {
      const alert = await alertsService.getAlertById(req.user.id, id);
      return reply.status(200).send({
        alert,
      });
    } catch (err) {
      if (err instanceof AlertNotFoundError) {
        return sendNotFound(reply, err.message);
      }
      if (err instanceof AlertForbiddenError) {
        return sendForbidden(reply, err.message);
      }
      throw err;
    }
  }
}

export const alertsController = new AlertsController();
