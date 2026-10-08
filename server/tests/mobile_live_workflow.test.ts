import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import NodeWebSocket from 'ws';
import { HttpAdapter } from '../../mobile/src/api/http_adapter.ts';
import { WsAdapter, type WsEventMap } from '../../mobile/src/api/ws_adapter.ts';

function waitForStatus(ws: WsAdapter, expected: string, timeoutMs = 5_000): Promise<void> {
  if (ws.getStatus() === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for WebSocket status ${expected}`));
    }, timeoutMs);
    const unsubscribe = ws.onStatusChange((status) => {
      if (status !== expected) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function waitForEvent<K extends keyof WsEventMap>(
  ws: WsAdapter,
  type: K,
  predicate: (event: WsEventMap[K]) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<WsEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const unsubscribe = ws.on(type, (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function run(): Promise<void> {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'sentinel-mobile-live-'));
  process.env.NODE_ENV = 'test';
  process.env.SENTINEL_INFRASTRUCTURE_MODE = 'local';
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_PATH = join(tempDirectory, 'sentinel.db');
  process.env.WS_TICKET_SECRET = 'mobile-live-test-secret';
  process.env.SENTINEL_PUSH_NOTIFICATIONS_ENABLED = 'false';

  const [{ buildServer }, repositories, deployment] = await Promise.all([
    import('../src/server/app.js'),
    import('../src/db/index.js'),
    import('../src/services/deployment_workflow.js'),
  ]);
  const userId = `mobile_live_${Date.now()}`;
  const app = await buildServer({
    logger: false,
    // Test authentication is injected at the server boundary instead of
    // weakening the production Clerk verifier with a local token fallback.
    authPreHandler: async (request) => {
      request.user = {
        id: userId,
        email: `${userId}@test.invalid`,
        name: 'Mobile Workflow Test User',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  console.log('STEP server listening');
  await repositories.userRepository.create({
    id: userId,
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    email: `${userId}@test.invalid`,
    name: 'Mobile Workflow Test User',
    avatar_url: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  const http = new HttpAdapter({
    baseUrl: address,
    getToken: async () => userId,
    timeoutMs: 5_000,
  });
  process.env.EXPO_PUBLIC_API_URL = address;
  process.env.EXPO_PUBLIC_WS_URL = address.replace(/^http/, 'ws');
  const previousWebSocket = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = NodeWebSocket;
  let mobileClient: import('../../mobile/src/api/sentinel_client.ts').SentinelClient | undefined;

  try {
    const title = `Hackathon BTC Sentinel ${Date.now()}`;
    const created = await http.createConversation({ title });
    console.log('STEP authenticated conversation created');
    const conversationId = created.conversation.id;
    assert.equal(created.conversation.title, title);

    const listed = await http.listConversations({ limit: 25 });
    assert.ok(listed.conversations.some((conversation) => conversation.id === conversationId));
    const searched = await http.listConversations({ q: 'Hackathon BTC Sentinel', limit: 25 });
    assert.ok(searched.conversations.some((conversation) => conversation.id === conversationId));

    const now = Date.now();
    const ruleId = randomUUID();
    const subSentinelId = randomUUID();
    const alertId = randomUUID();
    const rule = {
      id: ruleId,
      user_id: userId,
      conversation_id: conversationId,
      title: 'BTC price above 100,000 USD',
      natural_language_intent: 'Notify me when BTC trades above 100,000 USD',
      category: 'CRYPTO',
      combinator: 'SINGLE',
      condition_tree: null,
      trigger_mode: 'PERSISTENT',
      cooldown_minutes: 30,
      audio_tone: 'chime',
      status: 'PAUSED',
      expires_at: null,
      last_triggered_at: null,
      action_template: null,
      created_at: now,
      updated_at: now,
    } as const;
    const subSentinel = {
      id: subSentinelId,
      rule_id: ruleId,
      sentinel_type: 'CRYPTO',
      target_source: 'BTC-USD',
      operator: 'GREATER_THAN',
      threshold: JSON.stringify({
        assetSymbol: 'BTC',
        currency: 'USD',
        venue: 'COINBASE',
        targetPrice: 100_000,
        operator: 'GREATER_THAN',
      }),
      ttl_seconds: 300,
      last_evaluated_at: null,
      last_triggered_at: null,
      is_satisfied: 0,
      satisfied_at: null,
      state_payload: null,
      health_status: 'HEALTHY',
      error_count: 0,
      last_error: null,
    } as const;
    const stagedInterrupt = await deployment.stageDeploymentProposal({
      rule,
      subSentinels: [subSentinel],
      baselineValue: '99,500 USD',
      baselineSeeds: ['btc-live-fixture-baseline'],
    });
    const interruptId = stagedInterrupt.id;
    console.log('STEP deployment proposal staged');
    await repositories.alertEventRepository.create({
      id: alertId,
      rule_id: ruleId,
      user_id: userId,
      title: 'BTC Sentinel fixture alert',
      summary: 'Dashboard alert routing fixture',
      audio_tone: 'chime',
      snapshot_data: '{}',
      created_at: now,
    });

    const [{ SentinelClient }, { useSentinelStore }] = await Promise.all([
      import('../../mobile/src/api/sentinel_client.ts'),
      import('../../mobile/src/store/useSentinelStore.ts'),
    ]);
    console.log('STEP mobile domain client loaded');
    mobileClient = new SentinelClient({ getToken: async () => userId });
    await mobileClient.syncDashboard();
    console.log('STEP dashboard synchronized');
    let mobileState = useSentinelStore.getState();
    assert.ok(mobileState.conversations.some((conversation) => conversation.id === conversationId));
    assert.ok(mobileState.rules.some((candidate) => candidate.id === ruleId && candidate.status === 'PAUSED'));
    assert.ok(mobileState.alerts.some((alert) => alert.id === alertId));
    assert.ok(mobileState.pendingActions.some((interrupt) =>
      interrupt.id === interruptId && interrupt.conversation_id === conversationId));

    const interruptRequest = waitForEvent(mobileClient.ws, 'INTERRUPT_REQUEST', (event) => event.payload.id === interruptId);
    await mobileClient.connectConversation(conversationId, title);
    await waitForStatus(mobileClient.ws, 'CONNECTED');
    console.log('STEP conversation restored and socket connected');
    assert.equal((await interruptRequest).payload.conversation_id, conversationId);
    mobileState = useSentinelStore.getState();
    assert.equal(mobileState.activeConversationId, conversationId);
    assert.equal(mobileState.activeConversationTitle, title);

    const statusResponse = waitForEvent(mobileClient.ws, 'AGENT_CHAT_DONE');
    mobileClient.sendMessage('What has happened in this task so far?');
    assert.match((await statusResponse).payload.content, /interrupt|confirmation|pending/i);
    console.log('STEP task-status response streamed');
    await waitUntil(
      () => useSentinelStore.getState().chatMessages.some((message) =>
        /interrupt|confirmation|pending/i.test(message.content)),
      'streamed task-status response in the mobile conversation store',
    );

    const resolved = waitForEvent(
      mobileClient.ws,
      'INTERRUPT_RESOLVED',
      (event) => event.payload.interruptId === interruptId,
    );
    mobileClient.resolveInterrupt(interruptId, 'APPROVED', 'approve');
    assert.equal(useSentinelStore.getState().resolvingInterruptIds[interruptId], true);
    assert.equal((await resolved).payload.resolution, 'APPROVED');
    console.log('STEP interrupt approved');

    await waitUntil(
      () => useSentinelStore.getState().rules.some((candidate) =>
        candidate.id === ruleId && candidate.status === 'ACTIVE') &&
        !useSentinelStore.getState().pendingActions.some((interrupt) => interrupt.id === interruptId),
      'active Sentinel and cleared interrupt in the mobile dashboard store',
    );
    const activeRule = useSentinelStore.getState().rules.find((candidate) => candidate.id === ruleId);
    assert.ok(activeRule);
    assert.equal(useSentinelStore.getState().subSentinels[ruleId]?.length, 1);
    const restoredConversation = await http.getConversation(conversationId);
    assert.ok(restoredConversation.messages.some((message) => /interrupt|confirmation|pending/i.test(message.content)));
  } finally {
    mobileClient?.destroy();
    (globalThis as any).WebSocket = previousWebSocket;
    await app.close();
    await repositories.closeDatabase();
    rmSync(tempDirectory, { recursive: true, force: true });
    delete process.env.WS_TICKET_SECRET;
  }

  console.log('PASS live mobile HTTP + WebSocket + search + dashboard + interrupt workflow');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
