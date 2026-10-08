/**
 * Strands Sentinel - Alerts Service
 * Encapsulates alert notification queries and ownership validation.
 */

import { alertEventRepository, type AlertEvent } from '../../db/index.js';
import type { AlertQuery } from './alerts.schema.js';

export class AlertForbiddenError extends Error {
  constructor(message: string = 'You do not have permission to access this alert') {
    super(message);
    this.name = 'AlertForbiddenError';
  }
}

export class AlertNotFoundError extends Error {
  constructor(message: string = 'Alert event not found') {
    super(message);
    this.name = 'AlertNotFoundError';
  }
}

export class AlertsService {
  async getAlerts(userId: string, query: AlertQuery): Promise<AlertEvent[]> {
    return alertEventRepository.getByUserId(userId, query.limit, query.rule_id);
  }

  async getAlertById(userId: string, alertId: string): Promise<AlertEvent> {
    const alert = await alertEventRepository.getById(alertId);
    if (!alert) {
      throw new AlertNotFoundError();
    }
    if (alert.user_id !== userId) {
      throw new AlertForbiddenError();
    }
    return alert;
  }
}

export const alertsService = new AlertsService();
