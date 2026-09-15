/**
 * Best-effort Expo push delivery for durable Sentinel events.
 *
 * Alerts and interrupt actions are persisted before this dispatcher is called.
 * A failed push therefore never loses the event: the client can rehydrate it
 * from the API, while this process logs the delivery failure for operations.
 */

import { userDeviceRepository } from '../../db/index.js';
import type { UserDevice } from '@sentinel/shared';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH_SIZE = 100;

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
}

export interface PushDeliveryResult {
  attempted: number;
  accepted: number;
  failed: number;
}

function pushNotificationsEnabled(): boolean {
  return process.env.SENTINEL_PUSH_NOTIFICATIONS_ENABLED === 'true' ||
    (process.env.NODE_ENV === 'production' && process.env.SENTINEL_PUSH_NOTIFICATIONS_ENABLED !== 'false');
}

function isExpoPushToken(token: string): boolean {
  return /^ExponentPushToken\[[^\]]+\]$/.test(token);
}

export async function sendUserPushNotification(
  userId: string,
  message: PushMessage,
): Promise<PushDeliveryResult> {
  if (!pushNotificationsEnabled()) {
    return { attempted: 0, accepted: 0, failed: 0 };
  }

  let devices: UserDevice[];
  try {
    devices = await userDeviceRepository.getByUserId(userId);
  } catch (error) {
    console.warn('[PushNotifications] Device lookup failed:', error);
    return { attempted: 0, accepted: 0, failed: 1 };
  }
  const tokens = [...new Map(
    devices
      .map((device) => [device.push_token.trim(), device] as const)
      .filter(([token]) => isExpoPushToken(token)),
  ).values()];
  if (tokens.length === 0) return { attempted: 0, accepted: 0, failed: 0 };

  let accepted = 0;
  let failed = 0;
  for (let offset = 0; offset < tokens.length; offset += MAX_BATCH_SIZE) {
    const batch = tokens.slice(offset, offset + MAX_BATCH_SIZE);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref?.();
    try {
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch.map((device) => ({
          to: device.push_token.trim(),
          title: message.title.slice(0, 120),
          body: message.body.slice(0, 1000),
          data: message.data,
          sound: message.sound ?? 'default',
        }))),
        signal: controller.signal,
      });
      if (!response.ok) {
        failed += batch.length;
        console.warn('[PushNotifications] Expo rejected push batch', response.status);
        continue;
      }
      const payload = await response.json().catch(() => null) as {
        data?: Array<{ status?: string; details?: { error?: string } }>;
      } | null;
      const receipts = Array.isArray(payload?.data) ? payload.data : [];
      if (receipts.length !== batch.length) {
        failed += batch.length;
        console.warn('[PushNotifications] Expo returned an incomplete receipt batch');
        continue;
      }
      for (let index = 0; index < receipts.length; index++) {
        const receipt = receipts[index];
        if (receipt.status === 'ok') {
          accepted += 1;
          continue;
        }
        failed += 1;
        if (receipt.details?.error === 'DeviceNotRegistered') {
          try {
            await userDeviceRepository.removeById(batch[index].id);
          } catch (error) {
            console.warn('[PushNotifications] Failed to remove inactive device:', error);
          }
        }
      }
    } catch (error) {
      failed += batch.length;
      console.warn('[PushNotifications] Expo push delivery failed:', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { attempted: tokens.length, accepted, failed };
}
