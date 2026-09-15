/**
 * Strands Sentinel - Resilient WebSocket Client Adapter
 * Manages bi-directional streaming, heartbeat keepalive, exponential backoff
 * reconnection, offline message buffering, and typed event dispatching.
 */

import {
  WsServerMessageSchema,
  type WsServerMessage,
  type WsClientMessage,
  type AgentChatChunkEvent,
  type AgentChatDoneEvent,
  type TelemetryUpdateEvent,
  type InterruptRequestEvent,
  type InterruptResolvedEvent,
  type InterruptRequiredEvent,
  type AlertTriggeredEvent,
  type WsErrorMessage,
} from '@sentinel/shared';
import { getWsBaseUrl, API_CONFIG } from './api_config';

export type WsConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export type WsEventMap = {
  AGENT_CHAT_CHUNK: AgentChatChunkEvent;
  AGENT_CHAT_DONE: AgentChatDoneEvent;
  TELEMETRY_UPDATE: TelemetryUpdateEvent;
  INTERRUPT_REQUEST: InterruptRequestEvent;
  INTERRUPT_RESOLVED: InterruptResolvedEvent;
  INTERRUPT_REQUIRED: InterruptRequiredEvent;
  ALERT_TRIGGERED: AlertTriggeredEvent;
  ERROR: WsErrorMessage;
};

export type WsEventListener<K extends keyof WsEventMap> = (event: WsEventMap[K]) => void;
export type WsStatusListener = (status: WsConnectionStatus) => void;

export interface WsAdapterOptions {
  baseUrl?: string;
  getTicket?: () => Promise<string | null>;
  heartbeatIntervalMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxQueuedMessages?: number;
}

export class WsAdapter {
  private baseUrl: string;
  private getTicket?: () => Promise<string | null>;
  private heartbeatIntervalMs: number;
  private maxReconnectAttempts: number;
  private reconnectBaseDelayMs: number;
  private reconnectMaxDelayMs: number;
  private maxQueuedMessages: number;

  private socket: WebSocket | null = null;
  private activeConversationId: string | null = null;
  private status: WsConnectionStatus = 'DISCONNECTED';
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private suspended = false;
  private connectionGeneration = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Event listeners keyed by event type
  private listeners: Map<string, Set<(event: any) => void>> = new Map();
  private statusListeners: Set<WsStatusListener> = new Set();

  // Outgoing queue for buffering messages when offline
  private outgoingQueue: Array<{ conversationId: string; message: WsClientMessage }> = [];

  constructor(options: WsAdapterOptions = {}) {
    this.baseUrl = options.baseUrl || getWsBaseUrl();
    this.getTicket = options.getTicket;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || API_CONFIG.heartbeatIntervalMs;
    this.maxReconnectAttempts = options.maxReconnectAttempts || API_CONFIG.maxReconnectAttempts;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs || API_CONFIG.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs || API_CONFIG.reconnectMaxDelayMs;
    this.maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? 100);
  }

  public clearTicketProvider(): void {
    this.getTicket = undefined;
  }

  public setTicketProvider(provider: () => Promise<string | null>): void {
    this.getTicket = provider;
  }

  public getStatus(): WsConnectionStatus {
    return this.status;
  }

  public getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  private setStatus(newStatus: WsConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const listener of this.statusListeners) {
        try {
          listener(newStatus);
        } catch (err) {
          console.error('[WsAdapter] Status listener threw error:', err);
        }
      }
    }
  }

  /**
   * Subscribes to a specific WebSocket event type.
   * Returns an unsubscribe function.
   */
  public on<K extends keyof WsEventMap>(
    eventType: K,
    listener: WsEventListener<K>
  ): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);

    return () => {
      const set = this.listeners.get(eventType);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(eventType);
      }
    };
  }

  /**
   * Subscribes to connection status changes.
   * Returns an unsubscribe function.
   */
  public onStatusChange(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Connects to the WebSocket conversation session.
   * If a previous socket is active on a different conversation, closes it first.
   */
  public async connect(conversationId: string): Promise<void> {
    if (!conversationId) {
      throw new Error('Cannot connect without a conversation id');
    }

    if (this.suspended) return;

    if (
      this.socket &&
      this.activeConversationId === conversationId &&
      (this.status === 'CONNECTED' || this.status === 'CONNECTING')
    ) {
      // Already connected or connecting to this conversation
      return;
    }

    const isExplicitReconnect = this.status === 'DISCONNECTED';
    const generation = ++this.connectionGeneration;
    this.cleanupSocket();
    this.activeConversationId = conversationId;
    this.intentionalDisconnect = false;
    if (isExplicitReconnect) this.reconnectAttempts = 0;
    this.setStatus('CONNECTING');

    try {
      if (!this.getTicket) {
        throw new Error('WebSocket ticket provider is not configured');
      }
      const ticket = await this.getTicket();
      // Token acquisition is asynchronous. Ignore an obsolete connection if
      // the user disconnected, switched conversations, or backgrounded the app.
      if (
        generation !== this.connectionGeneration ||
        this.suspended ||
        this.intentionalDisconnect ||
        this.activeConversationId !== conversationId
      ) {
        return;
      }
      if (!ticket?.trim()) {
        throw new Error('Server did not issue a WebSocket authentication ticket');
      }
      const endpoint = `${this.baseUrl}/ws/conversation/${encodeURIComponent(conversationId)}?ticket=${encodeURIComponent(ticket)}`;

      const ws = new WebSocket(endpoint);
      this.socket = ws;

      ws.onopen = () => {
        if (this.socket !== ws || generation !== this.connectionGeneration || this.suspended) return;
        this.reconnectAttempts = 0;
        this.setStatus('CONNECTED');
        this.startHeartbeat();
        this.flushOutgoingQueue();
      };

      ws.onmessage = (event: any) => {
        if (this.socket !== ws || generation !== this.connectionGeneration) return;
        this.handleInboundMessage(event.data);
      };

      ws.onerror = (event: any) => {
        if (this.socket !== ws || generation !== this.connectionGeneration) return;
        console.warn('[WsAdapter] Socket encountered error:', event?.message || event);
      };

      ws.onclose = (_event: any) => {
        if (this.socket !== ws || generation !== this.connectionGeneration) return;
        this.stopHeartbeat();
        this.socket = null;

        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        } else {
          this.setStatus('DISCONNECTED');
        }
      };
    } catch (err) {
      if (generation !== this.connectionGeneration || this.suspended || this.intentionalDisconnect) return;
      console.error('[WsAdapter] Failed to initiate connection:', err);
      this.outgoingQueue = this.outgoingQueue.filter((item) => item.conversationId !== conversationId);
      this.setStatus('DISCONNECTED');
      this.emit('ERROR', {
        type: 'ERROR',
        payload: {
          message: err instanceof Error ? err.message : 'Realtime authentication failed',
        },
      });
      if (this.reconnectAttempts > 0) this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Disconnects and cleans up socket connection.
   */
  public disconnect(): void {
    this.connectionGeneration += 1;
    this.intentionalDisconnect = true;
    this.suspended = false;
    this.cleanupSocket();
    this.activeConversationId = null;
    this.outgoingQueue = [];
    this.setStatus('DISCONNECTED');
  }

  /** Stop realtime work in the background without losing the active conversation. */
  public suspend(): void {
    if (this.suspended) return;
    this.connectionGeneration += 1;
    this.suspended = true;
    this.intentionalDisconnect = true;
    this.cleanupSocket();
    this.setStatus('DISCONNECTED');
  }

  /** Reconnect and flush queued work when the app returns to the foreground. */
  public async resume(): Promise<void> {
    if (!this.suspended) return;
    this.suspended = false;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    if (this.activeConversationId) {
      await this.connect(this.activeConversationId);
    }
  }

  /**
   * Sends a user chat message into the active conversation stream.
   * If currently disconnected, buffers message to queue.
   */
  public sendChatMessage(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;

    const message: WsClientMessage = {
      type: 'CHAT_MESSAGE',
      payload: { content: trimmed },
    };

    return this.activeConversationId
      ? this.sendOrQueue(message, this.activeConversationId)
      : false;
  }

  /**
   * Resolves a pending interrupt (approval or dismissal) over the active socket.
   */
  public resolveInterrupt(
    interruptId: string,
    resolution: 'APPROVED' | 'REJECTED'
  ): boolean {
    const message: WsClientMessage = {
      type: 'RESOLVE_INTERRUPT',
      payload: { interruptId, resolution },
    };

    return this.activeConversationId
      ? this.sendOrQueue(message, this.activeConversationId)
      : false;
  }

  /**
   * Sends keepalive heartbeat ping.
   */
  public sendPing(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'PING' }));
    }
  }

  // ==========================================
  // Private Socket Helpers
  // ==========================================

  private sendOrQueue(message: WsClientMessage, conversationId: string): boolean {
    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      this.activeConversationId === conversationId
    ) {
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch (sendErr) {
        console.warn('[WsAdapter] Socket send failed, buffering:', sendErr);
        return this.queueOutgoingMessage({ conversationId, message });
      }
    } else {
      // Buffer outgoing messages during reconnection
      const queued = this.queueOutgoingMessage({ conversationId, message });
      if (this.activeConversationId && this.status === 'DISCONNECTED') {
        void this.connect(this.activeConversationId).catch(() => undefined);
      }
      return queued;
    }
  }

  private queueOutgoingMessage(item: { conversationId: string; message: WsClientMessage }): boolean {
    if (this.outgoingQueue.length >= this.maxQueuedMessages) {
      console.warn('[WsAdapter] Outgoing queue is full; refusing to enqueue another message.');
      return false;
    }
    this.outgoingQueue.push(item);
    return true;
  }

  private flushOutgoingQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const queued = this.outgoingQueue;
    this.outgoingQueue = [];
    for (let index = 0; index < queued.length; index += 1) {
      const queuedItem = queued[index];
      if (queuedItem.conversationId !== this.activeConversationId) {
        this.outgoingQueue.push(queuedItem);
        continue;
      }

      try {
        this.socket.send(JSON.stringify(queuedItem.message));
      } catch (err) {
        console.error('[WsAdapter] Failed to flush queued message:', err);
        this.outgoingQueue.unshift(...queued.slice(index));
        break;
      }
    }
  }

  private handleInboundMessage(raw: any): void {
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      const parsed = JSON.parse(text);

      if (parsed.type === 'PONG') {
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
          this.pongTimeoutTimer = null;
        }
        return;
      }

      // Validate schema
      const parseResult = WsServerMessageSchema.safeParse(parsed);
      if (!parseResult.success) {
        console.warn('[WsAdapter] Dropping invalid WebSocket message:', parseResult.error);
        return;
      }
      const message = parseResult.data;

      // Dispatch to subscribed listeners
      this.emit(message.type as keyof WsEventMap, message as any);
    } catch (parseErr) {
      console.warn('[WsAdapter] Malformed WebSocket message received:', parseErr);
    }
  }

  private emit<K extends keyof WsEventMap>(eventType: K, event: WsEventMap[K]): void {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (listenerErr) {
        console.error(`[WsAdapter] Listener for ${eventType} threw error:`, listenerErr);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.sendPing();

        // Expect PONG within 10s or consider connection dead
        if (this.pongTimeoutTimer) clearTimeout(this.pongTimeoutTimer);
        this.pongTimeoutTimer = setTimeout(() => {
          console.warn('[WsAdapter] Heartbeat PONG timed out. Reconnecting...');
          if (this.socket) {
            this.socket.close();
          }
        }, 10000);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.suspended || !this.activeConversationId) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[WsAdapter] Max reconnection attempts reached.');
      this.setStatus('DISCONNECTED');
      this.emit('ERROR', {
        type: 'ERROR',
        payload: { message: 'Realtime connection could not be restored' },
      });
      return;
    }

    this.setStatus('RECONNECTING');
    this.reconnectAttempts++;

    // Exponential backoff with jitter: delay = min(maxDelay, baseDelay * 2^(attempts-1)) + jitter
    const exponential = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(1.5, this.reconnectAttempts - 1)
    );
    const jitter = Math.random() * 500;
    const delay = Math.floor(exponential + jitter);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalDisconnect && this.activeConversationId) {
        void this.connect(this.activeConversationId).catch(() => undefined);
      }
    }, delay);
  }

  private cleanupSocket(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}

export const wsAdapter = new WsAdapter();
