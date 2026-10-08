/**
 * Strands Sentinel - HTTP & WebSocket Adapters Comprehensive Verification Suite
 * Tests URL formation, token injection, schema compliance, event routing, and store reactivity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UserSchema,
  RuleSchema,
  SubSentinelSchema,
  AlertEventSchema,
  InterruptActionSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
  GetMeResponseSchema,
  ListConversationsResponseSchema,
  ListRulesResponseSchema,
  GetPendingInterruptsResponseSchema,
  ListAlertsResponseSchema,
} from '@sentinel/shared';
import { HttpAdapter, HttpError, isCancellation } from '../http_adapter';
import { WsAdapter } from '../ws_adapter';
import { SentinelClient } from '../sentinel_client';
import { useSentinelStore } from '../../store/useSentinelStore';

describe('HTTP Adapter & Schema Verification', () => {
  it('instantiates HttpAdapter with custom token provider and base URL', async () => {
    let tokenCalled = false;
    const adapter = new HttpAdapter({
      baseUrl: 'http://localhost:8080',
      getToken: async () => {
        tokenCalled = true;
        return 'mock_clerk_jwt_token_12345';
      },
    });

    assert.ok(adapter);
    assert.strictEqual(tokenCalled, false);
  });

  it('validates GetMeResponseSchema schema against simulated server payload', () => {
    const mockUserPayload = {
      user: {
        id: 'user_mock_001',
        google_sub: null,
        apple_sub: null,
        github_sub: null,
        email: 'agent@sentinel.network',
        name: 'Sentinel Agent',
        avatar_url: 'https://sentinel.network/avatar.png',
        created_at: 1720000000000,
        updated_at: 1720000000000,
      },
    };

    const parsed = GetMeResponseSchema.safeParse(mockUserPayload);
    assert.ok(parsed.success, 'GetMeResponseSchema must parse valid payload');
    assert.strictEqual(parsed.data.user.email, 'agent@sentinel.network');
  });

  it('validates ListRulesResponseSchema with child sub_sentinels', () => {
    const mockRulesPayload = {
      rules: [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          user_id: 'user_mock_001',
          conversation_id: '123e4567-e89b-12d3-a456-426614174001',
          title: 'BTC Spike Monitor',
          natural_language_intent: 'Alert if Bitcoin moves > 5%',
          category: 'CRYPTO' as const,
          combinator: 'SINGLE' as const,
          condition_tree: null,
          trigger_mode: 'PERSISTENT' as const,
          cooldown_minutes: 30,
          audio_tone: 'cash_register' as const,
          status: 'ACTIVE' as const,
          expires_at: null,
          last_triggered_at: null,
          action_template: null,
          created_at: 1720000000000,
          updated_at: 1720000000000,
          sub_sentinels: [
            {
              id: '123e4567-e89b-12d3-a456-426614174002',
              rule_id: '123e4567-e89b-12d3-a456-426614174000',
              sentinel_type: 'CRYPTO' as const,
              target_source: 'BTC-USD',
              operator: 'PERCENT_CHANGE' as const,
              threshold: JSON.stringify({ assetSymbol: 'BTC', currency: 'USD' }),
              ttl_seconds: 300,
              last_evaluated_at: null,
              last_triggered_at: null,
              is_satisfied: 0,
              satisfied_at: null,
              state_payload: null,
              health_status: 'HEALTHY' as const,
              error_count: 0,
              last_error: null,
            },
          ],
        },
      ],
    };

    const parsed = ListRulesResponseSchema.safeParse(mockRulesPayload);
    assert.ok(parsed.success, 'ListRulesResponseSchema must successfully validate rule with sub_sentinels');
    assert.strictEqual(parsed.data.rules.length, 1);
    assert.strictEqual(parsed.data.rules[0].sub_sentinels.length, 1);
  });

  it('correctly constructs HttpError instances', () => {
    const error = new HttpError(404, 'Not Found', 'Conversation session expired');
    assert.strictEqual(error.statusCode, 404);
    assert.strictEqual(error.error, 'Not Found');
    assert.strictEqual(error.message, 'Conversation session expired');
  });

  it('distinguishes caller cancellation from a transport timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject({ name: 'AbortError' }), { once: true });
    })) as typeof fetch;
    try {
      const controller = new AbortController();
      const adapter = new HttpAdapter({
        baseUrl: 'http://localhost:8080',
        getToken: async () => 'mock_clerk_jwt_token_12345',
      });
      const request = adapter.getMe({ signal: controller.signal });
      controller.abort();
      await assert.rejects(request, (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.strictEqual(error.statusCode, 499);
        assert.strictEqual(error.error, 'Cancelled');
        assert.strictEqual(isCancellation(error), true);
        assert.strictEqual(isCancellation(new HttpError(408, 'Timeout', 'timed out')), false);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed without a Clerk JWT and never reaches fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be called');
    }) as typeof fetch;
    try {
      const adapter = new HttpAdapter({ baseUrl: 'http://localhost:8080' });
      await assert.rejects(adapter.getMe(), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.strictEqual(error.statusCode, 401);
        assert.strictEqual(error.error, 'AuthenticationRequired');
        return true;
      });
      assert.strictEqual(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds the Clerk bearer token to every mobile API operation', async () => {
    const originalFetch = globalThis.fetch;
    const observed: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observed.push({
        url: String(input),
        authorization: headers.get('Authorization'),
        accept: headers.get('Accept'),
      });
      return new Response(JSON.stringify({ statusCode: 400, error: 'BadRequest', message: 'fixture' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const id = '123e4567-e89b-12d3-a456-426614174000';
    const adapter = new HttpAdapter({
      baseUrl: 'http://localhost:8080',
      getToken: async () => 'clerk.jwt.fixture',
    });
    const operations = [
      () => adapter.getMe(),
      () => adapter.registerDevice({ push_token: 'ExponentPushToken[fixture]', platform: 'android' }),
      () => adapter.getDevices(),
      () => adapter.listConversations({ q: 'BTC', limit: 10 }),
      () => adapter.createConversation({ title: 'BTC demo task' }),
      () => adapter.createWsTicket(),
      () => adapter.getConversation(id),
      () => adapter.updateConversationStatus(id, 'ARCHIVED'),
      () => adapter.listRules(),
      () => adapter.getRule(id),
      () => adapter.updateRuleStatus(id, 'PAUSED'),
      () => adapter.deleteRule(id),
      () => adapter.getPendingInterrupts(),
      () => adapter.getInterrupt(id),
      () => adapter.listAlerts({ rule_id: id }),
      () => adapter.getAlert(id),
    ];
    try {
      for (const operation of operations) {
        await assert.rejects(operation(), HttpError);
      }
      assert.strictEqual(observed.length, operations.length);
      assert.ok(observed.every((request) => request.authorization === 'Bearer clerk.jwt.fixture'));
      assert.ok(observed.every((request) => request.accept === 'application/json'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('WebSocket Adapter & Realtime Protocol Verification', () => {
  it('validates outbound client message schemas', () => {
    const pingMsg = { type: 'PING' as const };
    const chatMsg = {
      type: 'CHAT_MESSAGE' as const,
      payload: { content: 'Monitor NVDA RSI above 70' },
    };
    const resolveMsg = {
      type: 'RESOLVE_INTERRUPT' as const,
      payload: {
        interruptId: '123e4567-e89b-12d3-a456-426614174010',
        resolution: 'APPROVED' as const,
        choiceId: 'approve',
      },
    };
    const clarificationResolveMsg = {
      type: 'RESOLVE_INTERRUPT' as const,
      payload: {
        interruptId: '123e4567-e89b-12d3-a456-426614174011',
        resolution: 'APPROVED' as const,
        choiceId: 'official',
      },
    };

    assert.ok(WsClientMessageSchema.safeParse(pingMsg).success);
    assert.ok(WsClientMessageSchema.safeParse(chatMsg).success);
    assert.ok(WsClientMessageSchema.safeParse(resolveMsg).success);
    assert.ok(WsClientMessageSchema.safeParse(clarificationResolveMsg).success);
    assert.equal(
      WsClientMessageSchema.safeParse({
        type: 'RESOLVE_INTERRUPT',
        payload: {
          interruptId: '123e4567-e89b-12d3-a456-426614174010',
          resolution: 'APPROVED',
        },
      }).success,
      false,
      'natural-language-only interrupt resolution must be rejected',
    );
  });

  it('validates inbound server message schemas', () => {
    const chunkEvent = {
      type: 'AGENT_CHAT_CHUNK' as const,
      payload: { chunk: 'Scanning order books...' },
    };
    assert.ok(WsServerMessageSchema.safeParse(chunkEvent).success);

    const doneEvent = {
      type: 'AGENT_CHAT_DONE' as const,
      payload: {
        messageId: '123e4567-e89b-12d3-a456-426614174020',
        content: 'Watcher configured successfully.',
        rule: null,
        subSentinels: [],
        interrupt: null,
      },
    };
    assert.ok(WsServerMessageSchema.safeParse(doneEvent).success);

    const telemetryEvent = {
      type: 'TELEMETRY_UPDATE' as const,
      payload: {
        id: '123e4567-e89b-12d3-a456-426614174030',
        rule_id: '123e4567-e89b-12d3-a456-426614174000',
        metric_name: 'RSI_14',
        value: 72.4,
        timestamp: 1720000000000,
        metadata: null,
      },
    };
    assert.ok(WsServerMessageSchema.safeParse(telemetryEvent).success);

    const interruptEvent = {
      type: 'INTERRUPT_REQUEST' as const,
      payload: {
        id: '123e4567-e89b-12d3-a456-426614174040',
        alert_id: null,
        rule_id: '123e4567-e89b-12d3-a456-426614174000',
        user_id: 'user_mock_001',
        action_type: 'CONFIRM_WATCHER',
        action_payload: JSON.stringify({ title: 'Confirm Sentinel' }),
        status: 'PENDING' as const,
        expires_at: 1720000900000,
        created_at: 1720000000000,
        resolved_at: null,
      },
    };
    assert.ok(WsServerMessageSchema.safeParse(interruptEvent).success);

    const clarificationEvent = {
      type: 'INTERRUPT_REQUEST' as const,
      payload: {
        id: '123e4567-e89b-12d3-a456-426614174041',
        alert_id: null,
        rule_id: null,
        conversation_id: '123e4567-e89b-12d3-a456-426614174001',
        user_id: 'user_mock_001',
        action_type: 'CLARIFICATION_REQUIRED',
        action_payload: JSON.stringify({
          kind: 'CLARIFICATION_REQUIRED',
          question: 'Which source should Sentinel monitor?',
          choices: [
            { id: 'official', label: 'Official source', description: 'Prefer primary sources.' },
            { id: 'community', label: 'Community sources' },
          ],
          resume_phase: 'SCOUTING',
        }),
        status: 'PENDING',
        expires_at: 1720000060000,
        created_at: 1720000000000,
        resolved_at: null,
        rule_title: null,
      },
    };
    assert.ok(WsServerMessageSchema.safeParse(clarificationEvent).success);
  });

  it('manages event subscriptions and unsubscriptions in WsAdapter', () => {
    const ws = new WsAdapter({ baseUrl: 'ws://localhost:8080' });
    let received = false;

    const unsubscribe = ws.on('AGENT_CHAT_CHUNK', (event) => {
      if (event.payload.chunk === 'test') received = true;
    });

    // Simulate inbound message routing
    (ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_CHUNK',
        payload: { chunk: 'test' },
      })
    );

    assert.strictEqual(received, true);

    received = false;
    unsubscribe();

    // After unsubscribe, listener should not fire
    (ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_CHUNK',
        payload: { chunk: 'test' },
      })
    );

    assert.strictEqual(received, false);
  });

  it('coalesces queued interrupt resolutions by interrupt id', () => {
    const ws = new WsAdapter({ baseUrl: 'ws://localhost:8080' });
    const conversationId = 'conversation-1';
    const interruptId = 'interrupt-1';
    const queue = (ws as any).queueOutgoingMessage.bind(ws);

    assert.equal(queue({
      conversationId,
      message: {
        type: 'RESOLVE_INTERRUPT',
        payload: { interruptId, resolution: 'APPROVED', choiceId: 'confirm' },
      },
    }), true);
    assert.equal(queue({
      conversationId,
      message: {
        type: 'RESOLVE_INTERRUPT',
        payload: { interruptId, resolution: 'APPROVED', choiceId: 'confirm' },
      },
    }), true);

    const queued = (ws as any).outgoingQueue as Array<{ message: { type: string } }>;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].message.type, 'RESOLVE_INTERRUPT');
    ws.disconnect();
  });

  it('refuses to construct an unauthenticated WebSocket when no ticket is issued', async () => {
    const ws = new WsAdapter({
      baseUrl: 'ws://localhost:8080',
      getTicket: async () => null,
    });
    let protocolError = '';
    ws.on('ERROR', (event) => {
      protocolError = event.payload.message;
    });

    await assert.rejects(ws.connect('123e4567-e89b-12d3-a456-426614174000'), /authentication ticket/i);
    assert.match(protocolError, /authentication ticket/i);
    assert.strictEqual(ws.getStatus(), 'DISCONNECTED');
    ws.disconnect();
  });
});

describe('Unified SentinelClient & Store Reactivity', () => {
  it('correctly updates Zustand state on incoming agent chunks and done events', () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();

    // Trigger chunk through ws
    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_CHUNK',
        payload: { chunk: 'Hello ' },
      })
    );
    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_CHUNK',
        payload: { chunk: 'World' },
      })
    );

    assert.strictEqual(useSentinelStore.getState().streamingMessage, 'Hello World');
    assert.strictEqual(useSentinelStore.getState().isGenerating, true);

    // Finalize turn
    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_DONE',
        payload: {
          messageId: '123e4567-e89b-12d3-a456-426614174099',
          content: 'Hello World',
          rule: null,
          subSentinels: [],
          interrupt: null,
        },
      })
    );

    assert.strictEqual(useSentinelStore.getState().streamingMessage, '');
    assert.strictEqual(useSentinelStore.getState().isGenerating, false);
    const msgs = useSentinelStore.getState().chatMessages;
    assert.ok(msgs.some((m) => m.content === 'Hello World'));

    const stagedRuleId = '123e4567-e89b-12d3-a456-426614174120';
    store.addRule({
      id: stagedRuleId,
      user_id: 'user_mock_001',
      conversation_id: '123e4567-e89b-12d3-a456-426614174121',
      title: 'Staged rule',
      natural_language_intent: 'A proposal that has not been approved',
      category: 'CRYPTO',
      combinator: 'SINGLE',
      trigger_mode: 'PERSISTENT',
      cooldown_minutes: 60,
      audio_tone: 'chime',
      status: 'PAUSED',
      created_at: 1720000000000,
      updated_at: 1720000000000,
    }, []);
    store.addPendingAction({
      id: '123e4567-e89b-12d3-a456-426614174122',
      rule_id: stagedRuleId,
      user_id: 'user_mock_001',
      action_type: 'CONFIRM_WATCHER',
      action_payload: '{}',
      status: 'PENDING',
      expires_at: 1720000900000,
      created_at: 1720000000000,
      conversation_id: '123e4567-e89b-12d3-a456-426614174121',
      rule_title: 'Staged rule',
    });
    (client.ws as any).handleInboundMessage(JSON.stringify({
      type: 'INTERRUPT_RESOLVED',
      payload: {
        interruptId: '123e4567-e89b-12d3-a456-426614174122',
        resolution: 'REJECTED',
        choiceId: 'reject',
        actionResult: 'Dismissed',
        resolvedAt: 1720000000001,
      },
    }));
    assert.equal(useSentinelStore.getState().rules.some((rule) => rule.id === stagedRuleId), false);

    client.destroy();
  });

  it('keeps the newest dashboard revalidation when an older request settles late', async () => {
    const client = new SentinelClient();
    let resolveFirstConversations: ((value: any) => void) | undefined;
    const firstConversations = new Promise<any>((resolve) => {
      resolveFirstConversations = resolve;
    });
    let conversationCalls = 0;
    (client.http as any).listConversations = async () => {
      conversationCalls += 1;
      if (conversationCalls === 1) return firstConversations;
      return {
        conversations: [{
          id: '123e4567-e89b-12d3-a456-426614174111',
          user_id: 'user_dashboard',
          title: 'Newest dashboard response',
          status: 'ACTIVE',
          phase: 'DISCOVERY',
          created_at: 1720000000000,
        }],
      };
    };
    (client.http as any).listRules = async () => ({ rules: [] });
    (client.http as any).getPendingInterrupts = async () => ({ interrupts: [] });
    (client.http as any).listAlerts = async () => ({ alerts: [] });

    const first = client.syncDashboard();
    await Promise.resolve();
    const second = client.syncDashboard();
    resolveFirstConversations?.({
      conversations: [{
        id: '123e4567-e89b-12d3-a456-426614174112',
        user_id: 'user_dashboard',
        title: 'Stale dashboard response',
        status: 'ACTIVE',
        phase: 'DISCOVERY',
        created_at: 1720000000000,
      }],
    });
    await Promise.all([first, second]);

    const state = useSentinelStore.getState();
    assert.strictEqual(state.conversations[0]?.title, 'Newest dashboard response');
    assert.strictEqual(state.dashboardStatus, 'READY');
    client.destroy();
  });

  it('dispatchPrompt optimistically updates chat state and creates a conversation when none is active', async () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();
    store.resetSession();

    let createdTitle = '';
    let connectedConvId = '';
    let sentMessage = '';

    (client.http as any).createConversation = async (payload: { title: string }) => {
      createdTitle = payload.title;
      return {
        conversation: {
          id: 'conv_created_999',
          user_id: 'user_001',
          title: payload.title,
          status: 'ACTIVE',
          phase: 'DISCOVERY',
          created_at: Date.now(),
        },
      };
    };

    (client.ws as any).connect = async (convId: string) => {
      connectedConvId = convId;
    };

    (client.ws as any).sendChatMessage = (content: string) => {
      sentMessage = content;
      return true;
    };

    const promptText = 'Monitor Ethereum gas prices under 15 gwei';
    const convId = await client.dispatchPrompt(promptText);

    assert.strictEqual(convId, 'conv_created_999');
    assert.strictEqual(createdTitle, promptText);
    assert.strictEqual(connectedConvId, 'conv_created_999');
    assert.strictEqual(sentMessage, promptText);

    const updatedState = useSentinelStore.getState();
    assert.strictEqual(updatedState.activeConversationId, 'conv_created_999');
    assert.strictEqual(updatedState.activeConversationTitle, promptText);
    assert.strictEqual(updatedState.isGenerating, true);
    assert.strictEqual(updatedState.chatMessages.length, 1);
    assert.strictEqual(updatedState.chatMessages[0].content, promptText);

    client.destroy();
  });

  it('dispatchPrompt with forceNew creates a fresh conversation even if one was active', async () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();
    store.resetSession();
    store.setActiveConversationId('conv_old_111');
    store.setActiveConversationTitle('Old conversation');
    store.setChatMessages([{
      id: 'old_msg_1',
      conversation_id: 'conv_old_111',
      role: 'user',
      content: 'Old message',
      created_at: 1000,
    }]);

    let createdTitle = '';
    let connectedConvId = '';
    (client.http as any).createConversation = async ({ title }: { title: string }) => {
      createdTitle = title;
      return {
        conversation: {
          id: 'conv_brand_new_222',
          user_id: 'user_mock_001',
          title,
          status: 'ACTIVE',
          phase: 'DISCOVERY',
          created_at: Date.now(),
        },
      };
    };
    (client.ws as any).connect = async (convId: string) => {
      connectedConvId = convId;
    };
    (client.ws as any).sendChatMessage = () => true;

    const newPrompt = 'Brand new Sentinel task from home';
    const convId = await client.dispatchPrompt(newPrompt, { forceNew: true });

    assert.strictEqual(convId, 'conv_brand_new_222');
    assert.strictEqual(createdTitle, newPrompt);
    assert.strictEqual(connectedConvId, 'conv_brand_new_222');

    const updatedState = useSentinelStore.getState();
    assert.strictEqual(updatedState.activeConversationId, 'conv_brand_new_222');
    assert.strictEqual(updatedState.chatMessages.length, 1);
    assert.strictEqual(updatedState.chatMessages[0].content, newPrompt);

    client.destroy();
  });

  it('tracks View Status requests and clears the pending state on the status response', () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();
    store.resetSession();
    store.setActiveConversationId('conv_status_001');

    let sentContent = '';
    (client.ws as any).getActiveConversationId = () => 'conv_status_001';
    (client.ws as any).sendChatMessage = (content: string) => {
      sentContent = content;
      return true;
    };

    assert.strictEqual(client.requestTaskStatus(), true);
    assert.strictEqual(sentContent, 'What is the current task status?');
    assert.strictEqual(useSentinelStore.getState().statusRequestInFlight, true);
    assert.ok(
      useSentinelStore.getState().chatMessages.some((message) => message.content === sentContent)
    );

    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'AGENT_CHAT_DONE',
        payload: {
          messageId: '123e4567-e89b-12d3-a456-426614174130',
          content: 'The task is currently running.',
          rule: null,
          subSentinels: [],
          interrupt: null,
        },
      })
    );

    assert.strictEqual(useSentinelStore.getState().statusRequestInFlight, false);
    assert.ok(
      useSentinelStore
        .getState()
        .chatMessages.some((message) => message.content === 'The task is currently running.')
    );
    client.destroy();
  });

  it('connectConversation rehydrates title and history, and disconnectConversation resets cleanly', async () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();
    store.resetSession();

    let wsConnectedConv = '';
    let wsDisconnected = false;

    (client.http as any).getConversation = async (convId: string) => ({
      conversation: {
        id: convId,
        user_id: 'user_001',
        title: 'Polymarket Election Sentry',
        status: 'ACTIVE',
        phase: 'DISCOVERY',
        created_at: 1720000000000,
      },
      messages: [
        {
          id: 'msg_1',
          conversation_id: convId,
          role: 'user',
          content: 'Track odds shift > 5%',
          created_at: 1720000000000,
        },
        {
          id: 'msg_2',
          conversation_id: convId,
          role: 'assistant',
          content: 'Monitoring Polymarket order book...',
          created_at: 1720000001000,
        },
      ],
    });

    (client.ws as any).connect = async (convId: string) => {
      wsConnectedConv = convId;
    };

    (client.ws as any).disconnect = () => {
      wsDisconnected = true;
    };

    // Test connecting
    await client.connectConversation('conv_poly_01', 'Polymarket Sentry Initial');

    const connectedState = useSentinelStore.getState();
    assert.strictEqual(connectedState.activeConversationId, 'conv_poly_01');
    assert.strictEqual(connectedState.activeConversationTitle, 'Polymarket Election Sentry');
    assert.strictEqual(connectedState.chatMessages.length, 2);
    assert.strictEqual(wsConnectedConv, 'conv_poly_01');

    // Test disconnecting
    client.disconnectConversation();

    const disconnectedState = useSentinelStore.getState();
    assert.strictEqual(disconnectedState.activeConversationId, null);
    assert.strictEqual(disconnectedState.activeConversationTitle, null);
    assert.strictEqual(disconnectedState.chatMessages.length, 0);
    assert.strictEqual(wsDisconnected, true);

    client.destroy();
  });

  it('resets isGenerating and clears streaming on INTERRUPT_REQUEST and ERROR events', () => {
    const client = new SentinelClient();
    const store = useSentinelStore.getState();

    // 1. Simulate active generation state
    store.setIsGenerating(true);
    assert.strictEqual(useSentinelStore.getState().isGenerating, true);

    // Simulate INTERRUPT_REQUEST arriving from backend
    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'INTERRUPT_REQUEST',
        payload: {
          id: '123e4567-e89b-12d3-a456-426614174040',
          alert_id: null,
          rule_id: '123e4567-e89b-12d3-a456-426614174000',
          user_id: 'user_mock_001',
          action_type: 'CONFIRM_WATCHER',
          action_payload: JSON.stringify({ title: 'Confirm Sentinel' }),
          status: 'PENDING',
          expires_at: 1720000900000,
          created_at: 1720000000000,
          resolved_at: null,
        },
      })
    );
    assert.strictEqual(useSentinelStore.getState().isGenerating, false);
    assert.strictEqual(useSentinelStore.getState().streamingMessage, '');

    // 2. Simulate generation restarting on next user message
    store.setIsGenerating(true);
    assert.strictEqual(useSentinelStore.getState().isGenerating, true);

    // Simulate ERROR arriving from backend
    (client.ws as any).handleInboundMessage(
      JSON.stringify({
        type: 'ERROR',
        payload: {
          message: 'Agent pipeline execution encountered a rate limit',
        },
      })
    );
    assert.strictEqual(useSentinelStore.getState().isGenerating, false);
    assert.strictEqual(useSentinelStore.getState().streamingMessage, '');

    client.destroy();
  });
});
