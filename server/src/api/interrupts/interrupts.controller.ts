/**
 * Strands Sentinel - Interrupts Controller
 * Handles HTTP requests for pending interrupt inspection.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { interruptsService } from './interrupts.service.js';
import { sendNotFound } from '../common/errors.js';

export class InterruptsController {
  async getPending(req: FastifyRequest, reply: FastifyReply) {
    const interrupts = await interruptsService.getPendingInterrupts(req.user.id);
    return reply.status(200).send({
      interrupts,
    });
  }

  async getById(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const interrupt = await interruptsService.getInterruptById(id);

    if (!interrupt) {
      return sendNotFound(reply, 'Interrupt action not found');
    }

    return reply.status(200).send({
      interrupt,
    });
  }
}

export const interruptsController = new InterruptsController();
