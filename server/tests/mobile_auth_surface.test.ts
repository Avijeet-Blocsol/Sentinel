import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/server/app.js';

async function run(): Promise<void> {
  const app = await buildServer({ logger: false });
  const id = randomUUID();
  const privateRoutes = [
    { method: 'GET', url: '/api/users/me' },
    { method: 'POST', url: '/api/users/devices', payload: {} },
    { method: 'GET', url: '/api/users/devices' },
    { method: 'GET', url: '/api/conversations' },
    { method: 'POST', url: '/api/conversations', payload: {} },
    { method: 'GET', url: `/api/conversations/${id}` },
    { method: 'PATCH', url: `/api/conversations/${id}/status`, payload: {} },
    { method: 'GET', url: '/api/rules' },
    { method: 'GET', url: `/api/rules/${id}` },
    { method: 'PATCH', url: `/api/rules/${id}/status`, payload: {} },
    { method: 'DELETE', url: `/api/rules/${id}` },
    { method: 'GET', url: '/api/interrupts/pending' },
    { method: 'GET', url: `/api/interrupts/${id}` },
    { method: 'GET', url: '/api/alerts' },
    { method: 'GET', url: `/api/alerts/${id}` },
    { method: 'POST', url: '/api/ws/ticket', payload: {} },
    { method: 'GET', url: `/ws/conversation/${id}` },
    { method: 'POST', url: '/api/engine/tick', payload: {} },
    { method: 'POST', url: `/api/engine/evaluate-rule/${id}`, payload: {} },
  ] as const;

  try {
    for (const route of privateRoutes) {
      const response = await app.inject(route as any);
      assert.equal(
        response.statusCode,
        401,
        `${route.method} ${route.url} must reject a request without credentials`,
      );
    }

    const rawUserIdBearer = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: 'Bearer test-user-id' },
    });
    assert.equal(rawUserIdBearer.statusCode, 401, 'raw user IDs must never bypass Clerk verification');

    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    assert.notEqual((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 401);
  } finally {
    await app.close();
  }

  console.log(`PASS ${privateRoutes.length} private HTTP/WebSocket routes reject anonymous requests`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
