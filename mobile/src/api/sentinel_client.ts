/**
 * Strands Sentinel - Unified Client Facade
 * Integrates HttpAdapter and WsAdapter with Zustand reactive state management.
 */

import {
  ChoiceInterruptPayloadSchema,
  isChoiceInterruptActionType,
  type ChatMessage,
} from '@sentinel/shared';
import { HttpAdapter, isCancellation, type TokenProvider } from './http_adapter';
import { WsAdapter, type WsConnectionStatus } from './ws_adapter';
import { useSentinelStore } from '../store/useSentinelStore';

export class SentinelClient {
  public readonly http: HttpAdapter;
  public readonly ws: WsAdapter;

  private unsubscribers: Array<() => void> = [];
  private conversationLoadGeneration = 0;
  private conversationLoadController: AbortController | null = null;
  private dashboardSyncGeneration = 0;
  private dashboardSyncController: AbortController | null = null;
  private resolvingInterruptId: string | null = null;
  private statusRequestInFlight = false;
  private connectedConversationIds = new Set<string>();
  private historyRevalidationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { getToken?: TokenProvider } = {}) {
    this.http = new HttpAdapter({ getToken: options.getToken });
    this.ws = new WsAdapter();
    this.ws.setTicketProvider(async () => {
      const response = await this.http.createWsTicket();
      return response.ticket;
    });

    this.bindWebSocketToStore();
  }

  /**
   * Sets or updates the Clerk JWT provider used by HTTP calls. WebSockets use
   * a short-lived ticket minted by an authenticated HTTP request.
   */
  public setTokenProvider(provider: TokenProvider): void {
    this.http.setTokenProvider(provider);
  }

  /**
   * Automatically synchronizes live WebSocket events with reactive Zustand state.
   */
  private bindWebSocketToStore(): void {
    // 1. Connection status sync
    this.unsubscribers.push(
      this.ws.onStatusChange((status: WsConnectionStatus) => {
        useSentinelStore.getState().setLiveConnected(status === 'CONNECTED');
        // A reconnect can miss one or more server events. Revalidate durable
        // dashboard state and the active transcript rather than assuming the
        // socket is an authoritative history source.
        if (status === 'CONNECTED') {
          void this.syncDashboard();
          const conversationId = this.ws.getActiveConversationId();
          if (conversationId) {
            if (this.connectedConversationIds.has(conversationId)) {
              void this.refreshActiveConversationHistory(conversationId);
              if (this.historyRevalidationTimer) clearTimeout(this.historyRevalidationTimer);
              this.historyRevalidationTimer = setTimeout(() => {
                void this.refreshActiveConversationHistory(conversationId);
              }, 750);
            } else {
              // Initial connects already load history before opening the socket.
              // Avoid replacing a freshly queued optimistic message with a
              // pre-send HTTP snapshot during the WebSocket onopen callback.
              this.connectedConversationIds.add(conversationId);
            }
          }
        }
      })
    );

    // 2. Real-time streaming chunks
    this.unsubscribers.push(
      this.ws.on('AGENT_CHAT_CHUNK', (event) => {
        useSentinelStore.getState().appendStreamingChunk(
          event.payload.chunk,
          event.payload.turnId,
          event.payload.sequence,
        );
      })
    );

    // 3. Agent response finalized
    this.unsubscribers.push(
      this.ws.on('AGENT_CHAT_DONE', (event) => {
        const { content, rule, subSentinels, interrupt } = event.payload;
        const store = useSentinelStore.getState();
        // Read-only status responses may arrive while a scouting turn is still
        // streaming. They intentionally have no turnId; append them as an
        // independent durable message without clearing the active stream.
        if (!event.payload.turnId && this.statusRequestInFlight) {
          store.addChatMessage({
            id: event.payload.messageId,
            conversation_id: store.activeConversationId || '',
            role: 'assistant',
            content,
            created_at: Date.now(),
          });
        } else {
          store.finishStreaming(content, event.payload.turnId, event.payload.messageId);
        }
        if (!event.payload.turnId) {
          this.statusRequestInFlight = false;
          store.setStatusRequestInFlight(false);
        }

        if (event.payload.phase && store.activeConversationId) {
          store.updateConversationPhase(store.activeConversationId, event.payload.phase);
        }

        if (rule) {
          store.addRule(rule, subSentinels);
        }

        if (interrupt) {
          store.addPendingAction(interrupt);
        }
      })
    );

    // 4. Probe & market telemetry updates
    this.unsubscribers.push(
      this.ws.on('TELEMETRY_UPDATE', (event) => {
        const store = useSentinelStore.getState();
        store.addTelemetryPoint(event.payload);
        if (event.payload.rule_id === store.activeConversationId) {
          try {
            const metadata = event.payload.metadata
              ? JSON.parse(event.payload.metadata) as { stage?: string }
              : null;
            if (metadata?.stage === 'WAITING_FOR_CHOICE' || metadata?.stage === 'FAILED') {
              store.setIsGenerating(false);
              store.clearStreaming();
            }
          } catch {
            // Telemetry metadata is optional and must not break the stream.
          }
        }
      })
    );

    const applySubSentinelEvaluation = (event: import('@sentinel/shared').SubSentinelEvaluatedEvent) => {
      const { subSentinelId, ruleId, isSatisfied, currentValue, timestamp } = event.payload;
      const store = useSentinelStore.getState();
      store.updateSubSentinel({
        id: subSentinelId,
        rule_id: ruleId,
        is_satisfied: isSatisfied ? 1 : 0,
        last_evaluated_at: timestamp,
        state_payload: JSON.stringify({
          currentValue,
          sourceTimestamp: timestamp,
        }),
      });
      // TELEMETRY_UPDATE is emitted alongside this event for chart history.
      // This event updates the live card state without duplicating chart points.
    };
    this.unsubscribers.push(this.ws.on('SUB_SENTINEL_EVALUATED', applySubSentinelEvaluation));
    this.unsubscribers.push(this.ws.on('SENTRY_EVALUATED', applySubSentinelEvaluation));

    // 5. HITL Interrupt requested
    this.unsubscribers.push(
      this.ws.on('INTERRUPT_REQUEST', (event) => {
        this.statusRequestInFlight = false;
        useSentinelStore.getState().setStatusRequestInFlight(false);
        useSentinelStore.getState().addPendingAction(event.payload);
        useSentinelStore.getState().setIsGenerating(false);
        useSentinelStore.getState().clearStreaming();
      })
    );

    // 6. Interrupt resolved
    this.unsubscribers.push(
      this.ws.on('INTERRUPT_RESOLVED', (event) => {
        const action = useSentinelStore
          .getState()
          .pendingActions.find((item) => item.id === event.payload.interruptId);
        this.resolvingInterruptId = null;
        const store = useSentinelStore.getState();
        store.resolveInterruptAction(event.payload.interruptId, event.payload.resolution as 'APPROVED' | 'REJECTED');
        const isChoiceInterrupt = Boolean(action && isChoiceInterruptActionType(action.action_type));
        if (isChoiceInterrupt && action?.conversation_id) {
          // The activity that led to the card belongs to the completed turn.
          // Remove it so the resumed draft reports its own current status.
          store.clearTelemetry(action.conversation_id);
        }
        if (event.payload.resolution === 'APPROVED' && isChoiceInterrupt && action?.conversation_id && event.payload.choiceId) {
          try {
            const parsed = JSON.parse(action.action_payload);
            const payload = ChoiceInterruptPayloadSchema.safeParse(parsed);
            const selectedChoice = payload.success
              ? payload.data.choices.find((choice) => choice.id === event.payload.choiceId)
              : undefined;
            const userContent = event.payload.responseText?.trim() || selectedChoice?.label;
            if (userContent && store.activeConversationId) {
              store.addChatMessage({
                id: `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                conversation_id: store.activeConversationId,
                role: 'user',
                content: userContent,
                created_at: Date.now(),
              });
            }
          } catch {
            // The durable server transcript remains authoritative if the card
            // payload cannot be decoded locally.
          }
        }
        // Selecting a clarification immediately resumes the agent turn after
        // the durable interrupt transaction completes.
        if (
          event.payload.resolution === 'APPROVED' &&
          (action?.action_type === 'CLARIFICATION_REQUIRED' || action?.action_type === 'QUERY_CONFIRMATION_REQUIRED')
        ) {
          store.clearStreaming();
          store.setIsGenerating(true);
        }
        // A rejected proposal is never an active monitor. Remove its staged
        // PAUSED rule immediately instead of waiting for the next dashboard
        // refresh to reconcile the card and rule lists.
        // Only a rejected pre-deployment proposal owns a staged PAUSED rule.
        // A rejected edit/clarification belongs to an already-active rule and
        // must never make that rule disappear from the dashboard.
        const rejectedStagedProposal = action?.action_type === 'CONFIRM_WATCHER' ||
          action?.action_type === 'MONITORING_MODE_REQUIRED';
        if (event.payload.resolution === 'REJECTED' && action?.rule_id && rejectedStagedProposal) {
          store.removeRule(action.rule_id);
        }
        // A second device may have completed the durable decision first. The
        // resolution event is intentionally minimal in that no-op case, so
        // revalidate to obtain the active or dismissed rule state.
        void this.syncDashboard();
      })
    );

    // 7. Alert notification triggered
    this.unsubscribers.push(
      this.ws.on('ALERT_TRIGGERED', (event) => {
        useSentinelStore.getState().addAlert(event.payload);
      })
    );

    // Protocol failures must not leave an interrupt card in an optimistic
    // resolving state forever. Rehydrate durable state after an error.
    this.unsubscribers.push(
      this.ws.on('ERROR', (event) => {
        this.statusRequestInFlight = false;
        useSentinelStore.getState().setStatusRequestInFlight(false);
        useSentinelStore.getState().setIsGenerating(false);
        useSentinelStore.getState().clearStreaming();
        if (this.resolvingInterruptId) {
          const action = useSentinelStore
            .getState()
            .pendingActions.find((item) => item.id === this.resolvingInterruptId);
          if (action) useSentinelStore.getState().restorePendingAction(action);
          this.resolvingInterruptId = null;
        }
        console.warn('[SentinelClient] WebSocket protocol error:', event.payload.message);
        void this.syncDashboard();
      })
    );

    this.unsubscribers.push(
      this.ws.on('INTERRUPT_REQUIRED', (event) => {
        this.statusRequestInFlight = false;
        useSentinelStore.getState().setStatusRequestInFlight(false);
        useSentinelStore.getState().setIsGenerating(false);
        useSentinelStore.getState().clearStreaming();
        const action = useSentinelStore
          .getState()
          .pendingActions.find((item) => item.id === event.payload.interruptId);
        if (action) useSentinelStore.getState().restorePendingAction(action);
        this.resolvingInterruptId = null;
      })
    );
  }

  /**
   * Connects the WebSocket adapter to an active agent conversation session.
   */
  public async connectConversation(conversationId: string, title?: string): Promise<void> {
    const generation = ++this.conversationLoadGeneration;
    this.conversationLoadController?.abort();
    // Do not allow events from the previous task to arrive while the next
    // conversation history is loading into the shared transcript store.
    this.ws.disconnect();
    this.statusRequestInFlight = false;
    useSentinelStore.getState().setStatusRequestInFlight(false);
    const controller = new AbortController();
    this.conversationLoadController = controller;
    useSentinelStore.getState().setActiveConversationId(conversationId);
    if (title !== undefined) {
      useSentinelStore.getState().setActiveConversationTitle(title);
    }
    useSentinelStore.getState().setChatMessages([]);
    useSentinelStore.getState().clearStreaming();

    try {
      const history = await this.http.getConversation(conversationId, { signal: controller.signal });
      if (generation !== this.conversationLoadGeneration) return;
      useSentinelStore.getState().setChatMessages(history.messages);
      if (history.conversation?.title) {
        useSentinelStore.getState().setActiveConversationTitle(history.conversation.title);
      }
      await this.ws.connect(conversationId);
    } catch (error) {
      if (generation !== this.conversationLoadGeneration || isCancellation(error)) return;
      this.ws.disconnect();
      useSentinelStore.getState().setActiveConversationId(null);
      useSentinelStore.getState().setActiveConversationTitle(null);
      useSentinelStore.getState().setChatMessages([]);
      useSentinelStore.getState().clearStreaming();
      throw error;
    } finally {
      if (this.conversationLoadController === controller) {
        this.conversationLoadController = null;
      }
    }
  }

  /**
   * Disconnects the active conversation WebSocket.
   */
  public disconnectConversation(): void {
    this.conversationLoadGeneration += 1;
    this.conversationLoadController?.abort();
    this.conversationLoadController = null;
    this.ws.disconnect();
    this.statusRequestInFlight = false;
    useSentinelStore.getState().setActiveConversationId(null);
    useSentinelStore.getState().setActiveConversationTitle(null);
    useSentinelStore.getState().setChatMessages([]);
    useSentinelStore.getState().clearStreaming();
    useSentinelStore.getState().setStatusRequestInFlight(false);
  }

  /**
   * Dispatches a prompt into the active conversation, or creates a new conversation
   * if none is currently active (or if options.forceNew is true). Optimistically updates the chat UI immediately.
   */
  public async dispatchPrompt(content: string, options?: { forceNew?: boolean }): Promise<string> {
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error('Cannot send empty prompt');

    if (options?.forceNew) {
      this.disconnectConversation();
    }

    const store = useSentinelStore.getState();
    let convId = store.activeConversationId;

    const hasActiveInterrupt = store.pendingActions.some(
      (action) => action.conversation_id === convId &&
        (!action.expires_at || action.expires_at > Date.now())
    );
    if (hasActiveInterrupt) {
      throw new Error('Chat input blocked while an interrupt confirmation is pending');
    }

    // 1. Optimistic message & generating state for instant UI response
    const optimisticMsg: ChatMessage = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversation_id: convId || 'pending',
      role: 'user',
      content: normalizedContent,
      created_at: Date.now(),
    };
    store.addChatMessage(optimisticMsg);
    store.setIsGenerating(true);

    try {
      // 2. Create conversation on server if needed
      if (!convId) {
        const title = normalizedContent.length > 48
          ? `${normalizedContent.slice(0, 48)}...`
          : normalizedContent;
        store.setActiveConversationTitle(title);
        const res = await this.http.createConversation({ title });
        if (!res?.conversation?.id) {
          throw new Error('Server failed to create conversation');
        }
        convId = res.conversation.id;
        store.addConversation(res.conversation);
        store.setActiveConversationId(convId);
        // Connect WebSocket
        await this.ws.connect(convId);
      }

      // 3. Dispatch over realtime transport
      const accepted = this.ws.sendChatMessage(normalizedContent);
      if (!accepted) {
        throw new Error('Realtime transport did not accept the message');
      }

      return convId;
    } catch (err) {
      // The server never accepted this turn. Do not leave an optimistic bubble
      // that will disappear on the next history refresh and look successful in
      // the meantime.
      useSentinelStore.getState().removeChatMessage(optimisticMsg.id);
      if (!convId) {
        useSentinelStore.getState().setActiveConversationTitle(null);
      }
      store.setIsGenerating(false);
      throw err;
    }
  }

  /**
   * Sends a chat prompt into the active conversation stream.
   */
  public sendMessage(content: string): void {
    const normalizedContent = content.trim();
    if (!normalizedContent) return;
    const activeId = this.ws.getActiveConversationId();
    // The server still enforces the interrupt blockade. It permits only
    // read-only task questions while a card is pending and returns a polite
    // action-required response for all other free-form input. Keeping this
    // transport open lets the UI's status action work consistently after a
    // reconnect without allowing text to resolve or bypass the card.
    const accepted = this.ws.sendChatMessage(normalizedContent);
    if (!accepted) {
      console.warn('[SentinelClient] Chat message was not accepted by the realtime transport');
      return;
    }
    if (activeId) {
      useSentinelStore.getState().addChatMessage({
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        conversation_id: activeId,
        role: 'user',
        content: normalizedContent,
        created_at: Date.now(),
      });
    }

  }

  /**
   * Submit the one read-only question allowed while an interrupt is pending.
   * The text is fixed by the client, so the hidden composer cannot be used to
   * smuggle task changes through the approval blockade.
   */
  public requestTaskStatus(): boolean {
    const store = useSentinelStore.getState();
    const activeId = this.ws.getActiveConversationId();
    if (!activeId || this.statusRequestInFlight) return false;
    const content = 'What is the current task status?';
    this.statusRequestInFlight = true;
    store.setStatusRequestInFlight(true);
    if (!this.ws.sendChatMessage(content)) {
      this.statusRequestInFlight = false;
      store.setStatusRequestInFlight(false);
      return false;
    }
    store.addChatMessage({
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      conversation_id: activeId,
      role: 'user',
      content,
      created_at: Date.now(),
    });
    return true;
  }

  /**
   * Resolves a pending interrupt action over WebSocket.
   */
  public resolveInterrupt(
    interruptId: string,
    resolution: 'APPROVED' | 'REJECTED',
    choiceId?: string,
    responseText?: string,
  ): boolean {
    const resolvedChoiceId = choiceId ?? (resolution === 'APPROVED' ? 'approve' : 'reject');
    const action = useSentinelStore.getState().pendingActions.find((item) => item.id === interruptId);
    const activeConversationId = this.ws.getActiveConversationId();
    if (!action || (action.conversation_id && action.conversation_id !== activeConversationId)) {
      console.warn('[SentinelClient] Refusing to resolve an interrupt outside the active conversation');
      return false;
    }
    if (useSentinelStore.getState().resolvingInterruptIds[interruptId]) return false;

    if (!this.ws.resolveInterrupt(interruptId, resolution, resolvedChoiceId, responseText)) {
      console.warn('[SentinelClient] Interrupt resolution was not accepted by the realtime transport');
      return false;
    }
    this.resolvingInterruptId = interruptId;
    useSentinelStore.getState().markInterruptResolving(interruptId);
    return true;
  }

  /** Update a deployed rule through the authenticated API. */
  public async updateRuleStatus(ruleId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    await this.http.updateRuleStatus(ruleId, status);
  }

  /**
   * Initial data synchronization for the dashboard.
   */
  public async syncDashboard(): Promise<void> {
    const generation = ++this.dashboardSyncGeneration;
    this.dashboardSyncController?.abort();
    const controller = new AbortController();
    // Preserve interrupts received over WebSocket while this HTTP snapshot is
    // in flight. An older empty response must not erase a newly-arrived card.
    const pendingActionIdsAtStart = new Set(
      useSentinelStore.getState().pendingActions.map((action) => action.id),
    );
    this.dashboardSyncController = controller;
    useSentinelStore.getState().setDashboardRefreshState('REFRESHING');

    try {
      const [conversationsRes, rulesRes, interruptsRes, alertsRes] = await Promise.allSettled([
        this.http.listConversations(undefined, { signal: controller.signal }),
        this.http.listRules(undefined, { signal: controller.signal }),
        this.http.getPendingInterrupts({ signal: controller.signal }),
        this.http.listAlerts({ limit: 30 }, { signal: controller.signal }),
      ]);
      if (generation !== this.dashboardSyncGeneration) return;

      const failures = [conversationsRes, rulesRes, interruptsRes, alertsRes]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
        .filter((error) => !isCancellation(error))
        .map((error) => error instanceof Error ? error.message : String(error));

      if (conversationsRes.status === 'fulfilled') {
        useSentinelStore.getState().setConversations(conversationsRes.value.conversations);
      }
      if (rulesRes.status === 'fulfilled') {
        useSentinelStore.getState().setRules(rulesRes.value.rules);
      }
      if (interruptsRes.status === 'fulfilled') {
        const currentPending = useSentinelStore.getState().pendingActions;
        const realtimeArrivals = currentPending.filter(
          (action) => !pendingActionIdsAtStart.has(action.id),
        );
        const merged = [
          ...interruptsRes.value.interrupts,
          ...realtimeArrivals.filter(
            (action) => !interruptsRes.value.interrupts.some((item) => item.id === action.id),
          ),
        ];
        useSentinelStore.getState().setPendingActions(merged);
      }
      if (alertsRes.status === 'fulfilled') {
        useSentinelStore.getState().setAlerts(alertsRes.value.alerts);
      }

      if (controller.signal.aborted) return;
      useSentinelStore.getState().setDashboardRefreshState(
        failures.length > 0 ? 'DEGRADED' : 'READY',
        failures,
      );
    } catch (syncErr) {
      if (generation !== this.dashboardSyncGeneration || isCancellation(syncErr)) return;
      const message = syncErr instanceof Error ? syncErr.message : String(syncErr);
      useSentinelStore.getState().setDashboardRefreshState('DEGRADED', [message]);
    } finally {
      if (this.dashboardSyncController === controller) {
        this.dashboardSyncController = null;
      }
    }
  }

  /** Release the socket while backgrounded; keep durable data in memory. */
  public suspendRealtime(): void {
    this.ws.suspend();
  }

  /** Revalidate first-class data whenever the app returns to the foreground. */
  public resumeRealtime(): void {
    void this.ws.resume().catch((error) => {
      console.warn('[SentinelClient] Realtime resume failed:', error);
    });
    void this.syncDashboard();
    const conversationId = this.ws.getActiveConversationId();
    if (conversationId) void this.refreshActiveConversationHistory(conversationId);
  }

  private async refreshActiveConversationHistory(conversationId: string): Promise<void> {
    if (conversationId !== this.ws.getActiveConversationId()) return;
    const generation = ++this.conversationLoadGeneration;
    this.conversationLoadController?.abort();
    const controller = new AbortController();
    this.conversationLoadController = controller;
    try {
      const history = await this.http.getConversation(conversationId, { signal: controller.signal });
      if (
        generation !== this.conversationLoadGeneration ||
        conversationId !== this.ws.getActiveConversationId()
      ) {
        return;
      }
      useSentinelStore.getState().setChatMessages(history.messages);
    } catch (error) {
      if (!isCancellation(error)) {
        console.warn('[SentinelClient] Active conversation revalidation failed:', error);
      }
    } finally {
      if (this.conversationLoadController === controller) {
        this.conversationLoadController = null;
      }
    }
  }

  public resetSession(clearAuth = false): void {
    this.conversationLoadGeneration += 1;
    this.dashboardSyncGeneration += 1;
    this.conversationLoadController?.abort();
    this.dashboardSyncController?.abort();
    this.conversationLoadController = null;
    this.dashboardSyncController = null;
    this.resolvingInterruptId = null;
    this.statusRequestInFlight = false;
    useSentinelStore.getState().setStatusRequestInFlight(false);
    this.connectedConversationIds.clear();
    if (this.historyRevalidationTimer) {
      clearTimeout(this.historyRevalidationTimer);
      this.historyRevalidationTimer = null;
    }
    this.ws.disconnect();
    if (clearAuth) {
      this.http.clearTokenProvider();
    }
    useSentinelStore.getState().resetSession();
  }

  /**
   * Cleans up all event bindings.
   */
  public destroy(): void {
    this.disconnectConversation();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}

export const sentinelClient = new SentinelClient();
