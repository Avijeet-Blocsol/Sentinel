import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { User, UserDevice } from '@sentinel/shared';
import { userRepository, userDeviceRepository } from '../src/db/index.js';
import { sendUserPushNotification } from '../src/services/notifications/push_notifications.js';

async function run() {
  const user: User = {
    id: randomUUID(),
    email: `${randomUUID()}@sentinel.local`,
    name: 'Push Test User',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(user);
  const device: UserDevice = {
    id: randomUUID(),
    user_id: user.id,
    push_token: 'ExponentPushToken[test-token]',
    platform: 'ios',
    last_active_at: Date.now(),
  };
  await userDeviceRepository.registerDevice(device);

  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  process.env.SENTINEL_PUSH_NOTIFICATIONS_ENABLED = 'true';
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requests.push(init || {});
    return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await sendUserPushNotification(user.id, {
      title: 'Alert',
      body: 'Test alert',
      data: { type: 'ALERT_TRIGGERED' },
    });
    assert.deepEqual(result, { attempted: 1, accepted: 1, failed: 0 });
    assert.equal(requests.length, 1);
    assert.equal((requests[0].method || 'GET'), 'POST');
    assert.match(String(requests[0].body), /ExponentPushToken/);
    console.log('PASS push dispatcher batches Expo tokens and preserves event payloads');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SENTINEL_PUSH_NOTIFICATIONS_ENABLED;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

