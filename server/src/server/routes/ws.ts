/**
 * Strands Sentinel - Realtime WebSocket Agentic Flow Routes
 * Handles bi-directional streaming, probe telemetry, interrupt resolution,
 * interrupt blockade enforcement, pre-flight verification, and reconnection rehydration.
 */

import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  type Rule,
  type SubSentinel,
  type AlertEvent,
  type EnrichedInterruptAction,
  type User,
  WsClientMessageSchema,
} from '@sentinel/shared';
import {
  conversationRepository,
  chatMessageRepository,
  ruleRepository,
  subSentinelRepository,
  interruptActionRepository,
  alertEventRepository,
  telemetryRepository,
} from '../../db/index.js';
import { getSessionStorage } from '../../db/s3/session_storage.js';
import { SentinelAgent } from '../../agent/sentinel_agent.js';
import {
  classifyUserInput,
  isInterruptResolutionText,
  generateSteeringResponse,
  generateLockedScopeResponse,
  generateTaskStatusSummary,
  isQueryConfirmationText,
  isQueryRejectionText,
  isTaskStatusInquiry,
  type ConversationPhase,
  type ConversationStateContext,
} from '../../agent/state_machine.js';
import { SessionManager } from '@strands-agents/sdk';
import { globalEvaluatorEngine } from '../../services/evaluators/engine.js';
import { requireConversationOwnership } from '../../middlewares/index.js';
import { setupHeartbeat, type WebSocketWithAlive } from '../../middlewares/websocket-guard.js';
import { configureEvaluatorNotifications } from '../../services/runtime_notifications.js';
import {
  extractSynthesizedRule,
  resolveDeploymentProposal,
  stageDeploymentProposal,
  type DeploymentResolution,
} from '../../services/deployment_workflow.js';

// Global registry of active sockets keyed by conversationId and userId
const activeConversationSockets = new Map<string, Set<WebSocket>>();
const activeUserSockets = new Map<string, Set<WebSocket>>();
const deliveredAlertIds = new Map<string, Set<string>>();
const deliveredInterruptIds = new Map<string, Set<string>>();
const durableEventCursors = new Map<string, number>();
const DURABLE_EVENT_OVERLAP_MS = 10_000;

// Per-conversation message processing mutex to prevent race conditions
const conversationLocks = new Map<string, Promise<void>>();

// Per-conversation SentinelAgent cache to avoid re-instantiating on every message
const agentCache = new Map<string, SentinelAgent>();

/**
 * Serialize message processing per conversation.
 * Queues messages so only one handler runs at a time per conversationId.
 */
function withConversationLock(conversationId: string, fn: () => Promise<void>): Promise<void> {
  const prev = conversationLocks.get(conversationId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // always chain, even if prev rejects
  conversationLocks.set(conversationId, next);
  // Cleanup map entry after the chain settles to prevent unbounded growth
  void next.finally(() => {
    if (conversationLocks.get(conversationId) === next) {
      conversationLocks.delete(conversationId);
    }
  }).catch(() => undefined);
  return next;
}

function registerSocket(userId: string, conversationId: string, socket: WebSocket) {
  if (!activeConversationSockets.has(conversationId)) {
    activeConversationSockets.set(conversationId, new Set());
  }
  activeConversationSockets.get(conversationId)!.add(socket);

  if (!activeUserSockets.has(userId)) {
    activeUserSockets.set(userId, new Set());
    // Overlap the first poll window so events created during the upgrade or
    // immediately before it are replayed and deduplicated instead of missed.
    durableEventCursors.set(userId, Date.now() - DURABLE_EVENT_OVERLAP_MS);
  }
  activeUserSockets.get(userId)!.add(socket);
}

function unregisterSocket(userId: string, conversationId: string, socket: WebSocket) {
  const convSet = activeConversationSockets.get(conversationId);
  if (convSet) {
    convSet.delete(socket);
    if (convSet.size === 0) {
      activeConversationSockets.delete(conversationId);
      agentCache.delete(conversationId);
    }
  }

  const userSet = activeUserSockets.get(userId);
  if (userSet) {
    userSet.delete(socket);
    if (userSet.size === 0) {
      activeUserSockets.delete(userId);
      deliveredAlertIds.delete(userId);
      deliveredInterruptIds.delete(userId);
      durableEventCursors.delete(userId);
    }
  }
}

function broadcastToUser(userId: string, message: unknown): void {
  const userSockets = activeUserSockets.get(userId);
  if (!userSockets) return;

  const serialized = JSON.stringify(message);
  for (const socket of userSockets) {
    if (socket.readyState === socket.OPEN) socket.send(serialized);
  }
}

function broadcastAlert(alert: AlertEvent): void {
  const seen = deliveredAlertIds.get(alert.user_id) ?? new Set<string>();
  if (seen.has(alert.id)) return;
  seen.add(alert.id);
  while (seen.size > 500) seen.delete(seen.values().next().value as string);
  deliveredAlertIds.set(alert.user_id, seen);
  broadcastToUser(alert.user_id, { type: 'ALERT_TRIGGERED', payload: alert });
}

function broadcastInterrupt(interrupt: EnrichedInterruptAction): void {
  const seen = deliveredInterruptIds.get(interrupt.user_id) ?? new Set<string>();
  if (seen.has(interrupt.id)) return;
  seen.add(interrupt.id);
  while (seen.size > 500) seen.delete(seen.values().next().value as string);
  deliveredInterruptIds.set(interrupt.user_id, seen);
  broadcastToUser(interrupt.user_id, { type: 'INTERRUPT_REQUEST', payload: interrupt });
}

/** Keep WebSocket rendering separate from the durable deployment workflow. */
function emitDeploymentResolution(
  socket: WebSocket,
  interrupt: EnrichedInterruptAction,
  resolution: 'APPROVED' | 'REJECTED',
  result: DeploymentResolution,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'INTERRUPT_RESOLVED',
    payload: {
      interruptId: interrupt.id,
      resolution,
      actionResult: result.message,
      resolvedAt: result.resolvedAt,
    },
  }));
  if (result.messageId) {
    socket.send(JSON.stringify({
      type: 'AGENT_CHAT_DONE',
      payload: {
        messageId: result.messageId,
        content: result.message,
        rule: result.rule,
        subSentinels: result.subSentinels,
      },
    }));
  }
}

/**
 * The evaluator worker is a separate process from the API/WebSocket server.
 * Rehydrate newly persisted durable events for currently connected users so
 * worker-originated alerts do not disappear merely because the worker has no
 * access to this process's socket registry.
 */
async function pollDurableEvents(): Promise<void> {
  for (const userId of activeUserSockets.keys()) {
    try {
        const since = (durableEventCursors.get(userId) ?? Date.now()) - DURABLE_EVENT_OVERLAP_MS;
      const pollStartedAt = Date.now();
      const [alerts, interrupts] = await Promise.all([
        alertEventRepository.getByUserId(userId, 100),
        interruptActionRepository.getPendingByUserId(userId),
      ]);

      for (const alert of alerts) {
        if (alert.created_at > since) broadcastAlert(alert);
      }
      for (const interrupt of interrupts) {
        if (interrupt.created_at > since) broadcastInterrupt(interrupt);
      }
      durableEventCursors.set(userId, pollStartedAt);
    } catch (error) {
      console.warn('[WebSocket] Durable event rehydration failed:', error);
    }
  }
}

/**
 * Expire stale HITL cards and release their conversation lock. This runs in
 * the API process as a safety net; the repository operation is idempotent so
 * multiple API instances can execute it concurrently.
 */
async function reconcileExpiredInterrupts(): Promise<void> {
  const expired = await interruptActionRepository.expirePending(Date.now());
  for (const action of expired) {
    const enriched = await interruptActionRepository.getById(action.id);
    if (enriched?.rule_id) {
      const rule = await ruleRepository.getById(enriched.rule_id);
      if (rule?.status === 'PAUSED') {
        await ruleRepository.updateStatus(rule.id, 'DISMISSED');
      }
      if (enriched.conversation_id) {
        const conversation = await conversationRepository.getById(enriched.conversation_id);
        if (conversation?.phase === 'INTERRUPT_PENDING') {
          await conversationRepository.updatePhase(enriched.conversation_id, 'DISCOVERY');
        }
      }
    }
  }
}

const durableEventPollTimer = setInterval(() => {
  void pollDurableEvents();
}, 5000);
durableEventPollTimer.unref?.();

const interruptExpiryTimer = setInterval(() => {
  void reconcileExpiredInterrupts().catch((error) => {
    console.warn('[WebSocket] Interrupt expiry reconciliation failed:', error);
  });
}, 60_000);
interruptExpiryTimer.unref?.();

// API processes additionally fan durable evaluator events out to open sockets.
// The shared bridge owns enrichment and best-effort push delivery for both the
// API and separate SQS worker process.
configureEvaluatorNotifications(globalEvaluatorEngine, {
  publishAlert: broadcastAlert,
  publishInterrupt: broadcastInterrupt,
});

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /ws/conversation/:id
   * WebSocket connection for real-time conversation and agentic monitoring.
   */
  fastify.get(
    '/:id',
    { websocket: true, preHandler: requireConversationOwnership },
    (connection, req) => {
      // @fastify/websocket v11 passes the WebSocket directly; retain the
      // fallback for older adapters used by local harnesses.
      const socket = ((connection as any).socket ?? connection) as WebSocket;
      const { id: conversationId } = req.params as { id: string };
      const user = req.user;

      // 1. Register socket into active tracking
      registerSocket(user.id, conversationId, socket);

      // 2. Reconnection Rehydration:
      // Immediately notify client of any PENDING interrupts for this user/conversation
      (async () => {
        try {
          await reconcileExpiredInterrupts();
          const pending = await interruptActionRepository.getPendingByUserId(user.id);
          for (const item of pending) {
            if (item.conversation_id === conversationId) {
              if (socket.readyState === socket.OPEN) {
                const seen = deliveredInterruptIds.get(user.id) ?? new Set<string>();
                seen.add(item.id);
                while (seen.size > 500) seen.delete(seen.values().next().value as string);
                deliveredInterruptIds.set(user.id, seen);
                socket.send(
                  JSON.stringify({
                    type: 'INTERRUPT_REQUEST',
                    payload: item,
                  })
                );
              }
            }
          }

        } catch (rehydrateErr) {
          req.log.warn({ err: rehydrateErr }, 'Failed to rehydrate pending interrupts');
        }
      })();

      // Heartbeat ping/pong with zombie-socket cleanup.
      const stopHeartbeat = setupHeartbeat(socket as WebSocketWithAlive);

      // Handle inbound WebSocket messages
      socket.on('message', async (raw: WebSocket.RawData) => {
        try {
            const parseResult = WsClientMessageSchema.safeParse(JSON.parse(raw.toString()));
            if (!parseResult.success) {
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({
                  type: 'ERROR',
                  payload: { message: 'Invalid WebSocket message', error: parseResult.error.message },
                }));
              }
              return;
            }

            const validatedMessage = parseResult.data;
            const { type } = validatedMessage;

            if (type === 'PING') {
              socket.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
              return;
            }

            const payload: any = (validatedMessage as any).payload;

            // Reconnaissance can stream through the Strands SDK for up to two
            // minutes. Do not put read-only status requests or locked-scope
            // steering behind that long-running turn: they neither mutate the
            // task nor need model/tool access. Pending-interrupt messages stay
            // on the serialized path below, where the approval blockade is
            // deliberately enforced.
            if (type === 'CHAT_MESSAGE') {
              const userContent = payload?.content?.trim();
              if (userContent) {
                const conversation = await conversationRepository.getById(conversationId);
                if (conversation?.phase === 'SCOUTING') {
                  const rules = await ruleRepository.getByConversationId(conversationId);
                  const activeRule = rules[0] ?? null;
                  const subSentinels = activeRule
                    ? await subSentinelRepository.getByRuleId(activeRule.id)
                    : [];
                  const content = isTaskStatusInquiry(userContent)
                    ? generateTaskStatusSummary({ phase: 'SCOUTING', activeRule, subSentinels })
                    : generateLockedScopeResponse('SCOUTING');
                  if (isTaskStatusInquiry(userContent)) {
                    await chatMessageRepository.create({
                      id: randomUUID(),
                      conversation_id: conversationId,
                      role: 'user',
                      content: userContent,
                      created_at: Date.now(),
                    });
                  }
                  const messageId = randomUUID();
                  await chatMessageRepository.create({
                    id: messageId,
                    conversation_id: conversationId,
                    role: 'assistant',
                    content,
                    created_at: Date.now(),
                  });
                  if (socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify({
                      type: 'AGENT_CHAT_DONE',
                      payload: { messageId, content, rule: activeRule, subSentinels },
                    }));
                  }
                  return;
                }
              }
            }

          // Serialize all non-PING messages per conversation to prevent race conditions
          await withConversationLock(conversationId, async () => {

          await reconcileExpiredInterrupts();

          // Case A: User sends a chat message into the conversation
          if (type === 'CHAT_MESSAGE') {
            const userContent = payload?.content?.trim();
            if (!userContent) return;

            // 1. CHECK INTERRUPT BLOCKADE:
            // If an interrupt is currently PENDING, verify if user input resolves it.
            // If not, BLOCK arbitrary text messages until the interrupt is resolved!
            const pendingList = await interruptActionRepository.getPendingByUserId(user.id);
            const activeInterrupt = pendingList.find(
              (i) => i.conversation_id === conversationId
            );

            if (activeInterrupt) {
              // A status question is an allowed read-only query even while a
              // card is pending. It does not alter the proposal or bypass the
              // approval gate; all other non-resolution text remains blocked.
              if (isTaskStatusInquiry(userContent)) {
                await chatMessageRepository.create({
                  id: randomUUID(),
                  conversation_id: conversationId,
                  role: 'user',
                  content: userContent,
                  created_at: Date.now(),
                });
                const pendingRule = await ruleRepository.getById(activeInterrupt.rule_id);
                const pendingSubs = pendingRule
                  ? await subSentinelRepository.getByRuleId(pendingRule.id)
                  : [];
                const summary = generateTaskStatusSummary({
                  phase: 'INTERRUPT_PENDING',
                  activeRule: pendingRule,
                  subSentinels: pendingSubs,
                  pendingInterrupt: activeInterrupt,
                });
                const assistantMsgId = randomUUID();
                await chatMessageRepository.create({
                  id: assistantMsgId,
                  conversation_id: conversationId,
                  role: 'assistant',
                  content: summary,
                  created_at: Date.now(),
                });
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: { messageId: assistantMsgId, content: summary, rule: pendingRule, subSentinels: pendingSubs },
                  }));
                }
                return;
              }

              const nlpRes = isInterruptResolutionText(userContent);
              if (nlpRes.isResolution && nlpRes.resolution) {
                await chatMessageRepository.create({
                  id: randomUUID(),
                  conversation_id: conversationId,
                  role: 'user',
                  content: userContent,
                  created_at: Date.now(),
                });
                const result = await resolveDeploymentProposal({
                  interrupt: activeInterrupt,
                  resolution: nlpRes.resolution,
                  conversationId,
                  userId: user.id,
                });
                agentCache.delete(conversationId);
                emitDeploymentResolution(socket, activeInterrupt, nlpRes.resolution, result);
                return;
              }

              // Non-resolution text received during pending interrupt -> BLOCKADE
              const blockMsg =
                `⚠️ **Action Required**: Sentinel is currently awaiting your confirmation.\n\n` +
                `Please tap **Confirm & Deploy** or **Dismiss** on the card above (or reply with "confirm" / "cancel") before sending new instructions.`;

              const assistantMsgId = randomUUID();
              await chatMessageRepository.create({
                id: assistantMsgId,
                conversation_id: conversationId,
                role: 'assistant',
                content: blockMsg,
                created_at: Date.now(),
              });

              if (socket.readyState === socket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: 'INTERRUPT_REQUIRED',
                    payload: {
                      interruptId: activeInterrupt.id,
                      message: blockMsg,
                    },
                  })
                );

                socket.send(
                  JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: {
                      messageId: assistantMsgId,
                      content: blockMsg,
                      rule: null,
                      subSentinels: [],
                    },
                  })
                );
              }
              return;
            }

            // 2. Inspect conversation state and classify input
            const existingRules = await ruleRepository.getByConversationId(conversationId);
            const activeRule = existingRules.length > 0 ? existingRules[0] : null;
            const subSentinels = activeRule
              ? await subSentinelRepository.getByRuleId(activeRule.id)
              : [];
            const recentMessages = await chatMessageRepository.getByConversationId(conversationId);
            const recentAlerts = activeRule
              ? await alertEventRepository.getByUserId(user.id, 5, activeRule.id)
              : [];
            const recentTelemetry = activeRule
              ? await telemetryRepository.getByRuleId(activeRule.id, 10)
              : [];

            const convo = await conversationRepository.getById(conversationId);
            let phase: ConversationPhase = (convo?.phase as ConversationPhase) || 'DISCOVERY';

            if (activeRule && activeRule.status === 'ACTIVE') {
              phase = 'DEPLOYED';
              if (convo && convo.phase !== 'DEPLOYED') {
                await conversationRepository.updatePhase(conversationId, 'DEPLOYED');
              }
            }

            const context: ConversationStateContext = {
              phase,
              activeRule,
              subSentinels,
              recentMessages,
              lastTelemetrySummary: JSON.stringify({
                recentAlerts: recentAlerts.map((a) => ({ id: a.id, title: a.title, createdAt: a.created_at })),
                recentTelemetry: recentTelemetry.map((t) => ({ metric: t.metric_name, value: t.value, timestamp: t.timestamp })),
              }),
            };

            const inputCategory = classifyUserInput(userContent, context);
            const isQueryConfirmation = phase === 'AWAITING_QUERY_CONFIRMATION' &&
              isQueryConfirmationText(userContent);
            const isQueryRejection = phase === 'AWAITING_QUERY_CONFIRMATION' &&
              isQueryRejectionText(userContent);

            // Store task/status messages for the durable transcript, but keep
            // off-topic and locked messages out of the model-facing history.
            const shouldPersistUserMessage =
              inputCategory === 'SENTINEL_INTENT' ||
              inputCategory === 'TASK_STATUS_INQUIRY' ||
              isQueryConfirmation ||
              isQueryRejection ||
              (phase === 'AWAITING_QUERY_CONFIRMATION' && inputCategory !== 'OFF_TOPIC_BS');
            if (shouldPersistUserMessage) {
              await chatMessageRepository.create({
                id: randomUUID(),
                conversation_id: conversationId,
                role: 'user',
                content: userContent,
                created_at: Date.now(),
              });
            }

            // The phase machine, not the model, owns tool access.  Before the
            // user confirms, use a no-tool drafting turn.  Once scouting starts
            // every non-status message is deterministic steering/blockade text.
            let isDraftTurn = false;
            let agentInput = userContent;

            // Subcase 1: Task Status Inquiry -> summarize execution stack immediately
            if (inputCategory === 'TASK_STATUS_INQUIRY') {
              const summary = generateTaskStatusSummary(context);
              const assistantMsgId = randomUUID();
              await chatMessageRepository.create({
                id: assistantMsgId,
                conversation_id: conversationId,
                role: 'assistant',
                content: summary,
                created_at: Date.now(),
              });

              if (socket.readyState === socket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: {
                      messageId: assistantMsgId,
                      content: summary,
                      rule: activeRule ?? null,
                      subSentinels,
                    },
                  })
                );
              }
              return;
            }

            if (phase === 'SCOUTING' || phase === 'INTERRUPT_PENDING' || phase === 'DEPLOYED') {
              const lockedMsg = generateLockedScopeResponse(phase);

              const assistantMsgId = randomUUID();
              await chatMessageRepository.create({
                id: assistantMsgId,
                conversation_id: conversationId,
                role: 'assistant',
                content: lockedMsg,
                created_at: Date.now(),
              });

              if (socket.readyState === socket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: {
                      messageId: assistantMsgId,
                      content: lockedMsg,
                      rule: activeRule ?? null,
                      subSentinels,
                    },
                  })
                );
              }
              return;
            }

            // Discovery and confirmation phases never send off-topic content
            // into the main agent.  This handles a genuine conversation that
            // later turns into random BS without spending an agent turn.
            if (
              inputCategory === 'OFF_TOPIC_BS' &&
              !isQueryConfirmation &&
              !isQueryRejection
            ) {
              const steerMsg = generateSteeringResponse(context);
              const assistantMsgId = randomUUID();
              await chatMessageRepository.create({
                id: assistantMsgId,
                conversation_id: conversationId,
                role: 'assistant',
                content: steerMsg,
                created_at: Date.now(),
              });

              if (socket.readyState === socket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: {
                      messageId: assistantMsgId,
                      content: steerMsg,
                      rule: activeRule ?? null,
                      subSentinels,
                    },
                  })
                );
              }
              return;
            }

            if (phase === 'DISCOVERY') {
              if (inputCategory !== 'SENTINEL_INTENT') {
                const steerMsg = generateSteeringResponse(context);
                const assistantMsgId = randomUUID();
                await chatMessageRepository.create({
                  id: assistantMsgId,
                  conversation_id: conversationId,
                  role: 'assistant',
                  content: steerMsg,
                  created_at: Date.now(),
                });
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: { messageId: assistantMsgId, content: steerMsg, rule: null, subSentinels: [] },
                  }));
                }
                return;
              }
              isDraftTurn = true;
              phase = 'AWAITING_QUERY_CONFIRMATION';
              await conversationRepository.updatePhase(conversationId, phase);
            } else if (phase === 'AWAITING_QUERY_CONFIRMATION') {
              if (isQueryConfirmation) {
                phase = 'SCOUTING';
                agentInput = 'The user confirmed the proposed Sentinel task. Proceed with reconnaissance, invoke the required pre-flight verification, and prepare the verified configuration card.';
                await conversationRepository.updatePhase(conversationId, phase);
              } else if (isQueryRejection) {
                phase = 'DISCOVERY';
                await conversationRepository.updatePhase(conversationId, phase);
                agentCache.delete(conversationId);
                const cancellationMessage =
                  'The proposed task has been cancelled. Tell me what you would like the new Sentinel to monitor.';
                const assistantMsgId = randomUUID();
                await chatMessageRepository.create({
                  id: assistantMsgId,
                  conversation_id: conversationId,
                  role: 'assistant',
                  content: cancellationMessage,
                  created_at: Date.now(),
                });
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: { messageId: assistantMsgId, content: cancellationMessage, rule: null, subSentinels: [] },
                  }));
                }
                return;
              } else if (inputCategory === 'OFF_TOPIC_BS') {
                const steerMsg = generateSteeringResponse(context);
                const assistantMsgId = randomUUID();
                await chatMessageRepository.create({
                  id: assistantMsgId,
                  conversation_id: conversationId,
                  role: 'assistant',
                  content: steerMsg,
                  created_at: Date.now(),
                });
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'AGENT_CHAT_DONE',
                    payload: { messageId: assistantMsgId, content: steerMsg, rule: null, subSentinels: [] },
                  }));
                }
                return;
              } else {
                // Any non-confirmation text before scouting is treated as an
                // intent revision/clarification and receives a no-tool draft.
                isDraftTurn = true;
              }
            }

            // 3. Run SentinelAgent via Strands Agents SDK (reusing cached agent per conversation)
            let sentinelAgent = isDraftTurn ? undefined : agentCache.get(conversationId);
            if (!sentinelAgent) {
              const sessionManager = new SessionManager({
                storage: getSessionStorage(),
                sessionId: conversationId,
              });
              sentinelAgent = new SentinelAgent({ sessionManager, enableTools: !isDraftTurn });
              if (!isDraftTurn) agentCache.set(conversationId, sentinelAgent);
            }

            let fullAssistantResponse = '';
            let agentStreamFailed = false;
            const invokedTools = new Set<string>();
            let preflightOutput: Record<string, unknown> | undefined;
            const turnId = randomUUID();
            let streamSequence = 0;
            const streamController = new AbortController();
            const streamTimeout = setTimeout(() => streamController.abort(new Error('SCOUTING_TIMEOUT')), 120_000);
            const cancelStream = () => streamController.abort(new Error('CLIENT_DISCONNECTED'));
            socket.once('close', cancelStream);
            socket.once('error', cancelStream);

            try {
              for await (const event of sentinelAgent.agent.stream(agentInput, { cancelSignal: streamController.signal })) {
                if (socket.readyState !== socket.OPEN) break;

                const eventAny = event as any;
                if (eventAny.toolName) invokedTools.add(String(eventAny.toolName));
                if (eventAny.toolUse?.name) invokedTools.add(String(eventAny.toolUse.name));
                if (eventAny.type === 'afterToolCallEvent' && eventAny.toolUse?.name === 'pre_flight_dry_run') {
                  const content = eventAny.result?.content;
                  const textContent = Array.isArray(content)
                    ? content.map((item: any) => typeof item?.text === 'string' ? item.text : '').join('')
                    : '';
                  try {
                    const parsed = JSON.parse(textContent);
                    if (parsed && typeof parsed === 'object') preflightOutput = parsed;
                  } catch {
                    // The model still receives the tool result; only baseline
                    // enrichment is skipped when the SDK result is non-JSON.
                  }
                }
                if (
                  event.type === 'modelStreamUpdateEvent' ||
                  eventAny.delta?.text ||
                  eventAny.text
                ) {
                  const chunk = eventAny.delta?.text || eventAny.text || '';
                  if (chunk) {
                    fullAssistantResponse += chunk;
                    socket.send(
                      JSON.stringify({
                        type: 'AGENT_CHAT_CHUNK',
                        payload: { chunk, turnId, sequence: streamSequence++ },
                      })
                    );
                  }
                } else if (
                  event.type === 'beforeToolCallEvent' ||
                  event.type === 'toolStreamUpdateEvent'
                ) {
                  // If tools are being invoked, transition phase to SCOUTING if not already
                  if ((phase as string) === 'DISCOVERY' || (phase as string) === 'AWAITING_QUERY_CONFIRMATION') {
                    phase = 'SCOUTING';
                    await conversationRepository.updatePhase(conversationId, 'SCOUTING');
                  }

                  socket.send(
                    JSON.stringify({
                      type: 'TELEMETRY_UPDATE',
                      payload: {
                        id: randomUUID(),
                        rule_id: conversationId,
                        metric_name: eventAny.toolName || 'RECONNAISSANCE_PROBE',
                        value: 1,
                        timestamp: Date.now(),
                        metadata: JSON.stringify(eventAny.arguments || {}),
                      },
                    })
                  );
                }
              }
            } catch (agentErr: any) {
              agentStreamFailed = true;
              req.log.error({ err: agentErr }, 'Agent stream execution error');
              fullAssistantResponse += `\n[Agent Fault Recovery]: Handled gracefully (${agentErr.message || 'Stream timeout'}).`;
            } finally {
              clearTimeout(streamTimeout);
              socket.removeListener('close', cancelStream);
              socket.removeListener('error', cancelStream);
            }

            // 5. Check for rule synthesis.  A scouting turn is not allowed to
            // synthesize a deployable rule unless pre-flight was actually
            // invoked by the Strands tool executor.
            let rule: Rule | undefined;
            let synthesizedSubs: SubSentinel[] | undefined;
            let baselineValue: string | undefined;
            let extractedSeeds: string[] | undefined;
            let createdInterrupt: EnrichedInterruptAction | null = null;

            const preflightInvoked = invokedTools.has('pre_flight_dry_run');
            if (isDraftTurn && !agentStreamFailed) {
              // Drafting is only the pre-scout confirmation step. Never parse
              // model JSON or create an interrupt here, even if a no-tool
              // model happens to emit a deployable-looking bundle.
              fullAssistantResponse =
                `${fullAssistantResponse.trim()}\n\n` +
                `Please review this proposed monitor. Reply **Confirm** to launch live reconnaissance, or tell me what you want to change.`;
            } else if (!agentStreamFailed && !preflightInvoked) {
              await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
              phase = 'DISCOVERY';
              agentCache.delete(conversationId);
              fullAssistantResponse =
                'I could not complete the required live pre-flight verification, so I have not created a deployment card. The task was safely reset and can be retried.';
            } else if (!agentStreamFailed && preflightInvoked && preflightOutput?.passed !== true) {
              await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
              phase = 'DISCOVERY';
              agentCache.delete(conversationId);
              fullAssistantResponse =
                'The live pre-flight verification did not pass, so I have not created a deployment card. The task was safely reset and can be retried.';
            } else if (!agentStreamFailed && preflightInvoked) {
              const extracted = extractSynthesizedRule(
                fullAssistantResponse,
                user.id,
                conversationId
              );
              rule = extracted.rule;
              synthesizedSubs = extracted.subSentinels;
              baselineValue = extracted.baselineValue;
              extractedSeeds = extracted.baselineSeeds;
              if (!rule) {
                await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
                phase = 'DISCOVERY';
                agentCache.delete(conversationId);
                fullAssistantResponse =
                  'Reconnaissance completed, but the proposed configuration failed strict schema validation. No task was deployed; please retry with the same intent.';
              }
              if ((!extractedSeeds || extractedSeeds.length === 0) && Array.isArray(preflightOutput?.baselineSeeds)) {
                extractedSeeds = preflightOutput.baselineSeeds.map(String);
              }
              if (!baselineValue && typeof preflightOutput?.baselineValue === 'string') {
                baselineValue = preflightOutput.baselineValue;
              }
            }

            if (agentStreamFailed) {
              await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
              phase = 'DISCOVERY';
              agentCache.delete(conversationId);
              fullAssistantResponse =
                'Reconnaissance was interrupted before verification completed. No task was deployed; the conversation was reset safely and can be retried.';
            }

            if (rule) {
              // Step 6: Visual Card via context.interrupt
              // Do NOT deploy immediately. The repository atomically persists
              // the PAUSED rule, PENDING confirmation card, and phase change.
              // The evaluator cannot observe a partial proposal.
              const proposalRule: Rule = { ...rule, status: 'PAUSED' };
              createdInterrupt = await stageDeploymentProposal({
                rule: proposalRule,
                subSentinels: synthesizedSubs ?? [],
                baselineValue,
                baselineSeeds: extractedSeeds,
              });
              rule = proposalRule;

              // Push the Visual Card Interrupt to WebSocket
              if (socket.readyState === socket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: 'INTERRUPT_REQUEST',
                    payload: createdInterrupt,
                  })
                );
              }
            }

            // 6. Persist assistant message
            const assistantMsgId = randomUUID();
            await chatMessageRepository.create({
              id: assistantMsgId,
              conversation_id: conversationId,
              role: 'assistant',
              content: fullAssistantResponse || 'Sentinel standing by.',
              created_at: Date.now(),
            });

            // 7. Emit AGENT_CHAT_DONE
            if (socket.readyState === socket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: 'AGENT_CHAT_DONE',
                      payload: {
                        messageId: assistantMsgId,
                        content: fullAssistantResponse,
                        turnId,
                    rule: rule ?? null,
                    subSentinels: synthesizedSubs ?? [],
                    interrupt: createdInterrupt ?? null,
                  },
                })
              );
            }
          }

          // Case B: User resolves an interrupt directly over WebSocket (e.g. tapping card)
          if (type === 'RESOLVE_INTERRUPT') {
            const { interruptId, resolution } = payload || {};
            if (!interruptId || !['APPROVED', 'REJECTED'].includes(resolution)) {
              socket.send(
                JSON.stringify({
                  type: 'ERROR',
                  payload: { message: 'Invalid interrupt resolution payload' },
                })
              );
              return;
            }

            const interrupt = await interruptActionRepository.getById(interruptId);
            if (!interrupt) {
              socket.send(
                JSON.stringify({
                  type: 'ERROR',
                  payload: { message: 'Interrupt action not found' },
                })
              );
              return;
            }

            const result = await resolveDeploymentProposal({
              interrupt,
              resolution,
              conversationId,
              userId: user.id,
            });
            agentCache.delete(conversationId);
            emitDeploymentResolution(socket, interrupt, resolution, result);
          }

          }); // end withConversationLock
        } catch (msgErr: any) {
          req.log.warn({ err: msgErr }, 'Malformed WebSocket message received');
          if (socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'ERROR',
                payload: {
                  message: 'Failed to process incoming message',
                  error: msgErr?.message || String(msgErr),
                },
              })
            );
          }
        }
      });

      // Handle socket closure and cleanup
      socket.on('close', () => {
        stopHeartbeat();
        unregisterSocket(user.id, conversationId, socket);
      });

      socket.on('error', (err: Error) => {
        req.log.error({ err }, 'WebSocket socket error');
        stopHeartbeat();
        unregisterSocket(user.id, conversationId, socket);
      });
    }
  );
};
