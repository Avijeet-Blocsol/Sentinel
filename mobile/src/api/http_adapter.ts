/**
 * Strands Sentinel - HTTP Client Adapter
 * Type-safe HTTP client with Clerk JWT injection, timeout aborting,
 * and Zod runtime schema validation matching Fastify endpoints.
 */

import { z } from 'zod';
import {
  GetMeResponseSchema,
  type GetMeResponse,
  RegisterDeviceRequestSchema,
  type RegisterDeviceRequest,
  RegisterDeviceResponseSchema,
  type RegisterDeviceResponse,
  GetDevicesResponseSchema,
  type GetDevicesResponse,
  ListConversationsQuerySchema,
  type ListConversationsQuery,
  ListConversationsResponseSchema,
  type ListConversationsResponse,
  CreateConversationRequestSchema,
  type CreateConversationRequest,
  CreateConversationResponseSchema,
  type CreateConversationResponse,
  CreateWsTicketResponseSchema,
  type CreateWsTicketResponse,
  GetConversationResponseSchema,
  type GetConversationResponse,
  UpdateConversationStatusResponseSchema,
  type UpdateConversationStatusResponse,
  ListRulesQuerySchema,
  type ListRulesQuery,
  ListRulesResponseSchema,
  type ListRulesResponse,
  GetRuleResponseSchema,
  type GetRuleResponse,
  UpdateRuleStatusResponseSchema,
  type UpdateRuleStatusResponse,
  DeleteRuleResponseSchema,
  type DeleteRuleResponse,
  GetPendingInterruptsResponseSchema,
  type GetPendingInterruptsResponse,
  GetInterruptResponseSchema,
  type GetInterruptResponse,
  ListAlertsQuerySchema,
  type ListAlertsQuery,
  ListAlertsResponseSchema,
  type ListAlertsResponse,
  GetAlertResponseSchema,
  type GetAlertResponse,
  type ConversationPhase,
} from '@sentinel/shared';
import { getApiBaseUrl, API_CONFIG } from './api_config';

export class HttpError extends Error {
  public statusCode: number;
  public error: string;
  public issues?: any[];

  constructor(statusCode: number, error: string, message: string, issues?: any[]) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.error = error;
    this.issues = issues;
  }
}

export type TokenProvider = () => Promise<string | null>;

export interface HttpAdapterOptions {
  baseUrl?: string;
  getToken?: TokenProvider;
  timeoutMs?: number;
  onUnauthorized?: () => void;
}

/** Per-request lifecycle controls exposed to domain clients and hooks. */
export interface HttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HttpAdapter {
  private baseUrl: string;
  private getToken?: TokenProvider;
  private timeoutMs: number;
  private onUnauthorized?: () => void;

  constructor(options: HttpAdapterOptions = {}) {
    this.baseUrl = options.baseUrl || getApiBaseUrl();
    this.getToken = options.getToken;
    this.timeoutMs = options.timeoutMs || API_CONFIG.timeoutMs;
    this.onUnauthorized = options.onUnauthorized;
  }

  /**
   * Updates or sets the token provider dynamically (e.g. after Clerk loads).
   */
  public setTokenProvider(provider: TokenProvider): void {
    this.getToken = provider;
  }

  public clearTokenProvider(): void {
    this.getToken = undefined;
  }

  public setUnauthorizedHandler(handler?: () => void): void {
    this.onUnauthorized = handler;
  }

  /**
   * Core request executor with Bearer token injection, abort timeout, and schema parsing.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit & {
      schema?: { safeParse: (data: unknown) => { success: boolean; data?: any; error?: any } };
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const { schema, timeoutMs = this.timeoutMs, signal: callerSignal, ...fetchOptions } = options;
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const headers = new Headers(fetchOptions.headers || {});
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    if (!headers.has('Content-Type') && fetchOptions.body) {
      headers.set('Content-Type', 'application/json');
    }

    if (callerSignal?.aborted) {
      throw new HttpError(499, 'Cancelled', `Request to ${endpoint} was cancelled`);
    }

    // Every mobile API endpoint is private. Fail closed before making a network
    // request if Clerk cannot provide a session JWT; a Clerk user id is not a
    // bearer token and must never be used as one.
    if (!headers.has('Authorization')) {
      if (!this.getToken) {
        this.onUnauthorized?.();
        throw new HttpError(401, 'AuthenticationRequired', 'A Clerk session token is required');
      }

      let token: string | null;
      try {
        token = await this.getToken();
      } catch (tokenErr) {
        console.warn('[HttpAdapter] Failed to obtain Clerk session token:', tokenErr);
        this.onUnauthorized?.();
        throw new HttpError(401, 'AuthenticationRequired', 'Unable to obtain a Clerk session token');
      }

      if (!token?.trim()) {
        this.onUnauthorized?.();
        throw new HttpError(401, 'AuthenticationRequired', 'A Clerk session token is required');
      }
      headers.set('Authorization', `Bearer ${token.trim()}`);
    }

    // Token retrieval is asynchronous; the caller may have cancelled while
    // Clerk was refreshing the session token.
    if (callerSignal?.aborted) {
      throw new HttpError(499, 'Cancelled', `Request to ${endpoint} was cancelled`);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const data = isJson ? await response.json() : await response.text();
      if (!response.ok) {
        if (response.status === 401 && this.onUnauthorized) {
          this.onUnauthorized();
        }

        const errorObj = typeof data === 'object' && data !== null ? data : {};
        throw new HttpError(
          response.status,
          errorObj.error || response.statusText || 'Request Failed',
          errorObj.message || (typeof data === 'string' ? data : 'An unknown server error occurred'),
          errorObj.issues
        );
      }

      if (schema) {
        const parseResult = schema.safeParse(data);
        if (!parseResult.success) {
          console.warn(`[HttpAdapter] Schema validation mismatch on ${endpoint}:`, parseResult.error);
          throw new HttpError(502, 'ProtocolError', `Invalid response received from ${endpoint}`);
        }
        return parseResult.data;
      }

      return data as T;
    } catch (err: any) {
      if (callerSignal?.aborted) {
        throw new HttpError(499, 'Cancelled', `Request to ${endpoint} was cancelled`);
      }
      if (err?.name === 'AbortError') {
        throw new HttpError(408, 'Timeout', `Request to ${endpoint} timed out after ${timeoutMs}ms`);
      }
      if (err instanceof HttpError) {
        throw err;
      }
      throw new HttpError(0, 'NetworkError', err.message || 'Failed to execute HTTP request');
    } finally {
      clearTimeout(timeoutTimer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  // ==========================================
  // User & Device Endpoints
  // ==========================================

  /**
   * GET /api/users/me
   * Fetches the authenticated user profile details.
   */
  public async getMe(options?: HttpRequestOptions): Promise<GetMeResponse> {
    return this.request('/api/users/me', {
      method: 'GET',
      schema: GetMeResponseSchema,
      ...options,
    });
  }

  /**
   * POST /api/users/devices
   * Registers or updates a device push token.
   */
  public async registerDevice(data: RegisterDeviceRequest, options?: HttpRequestOptions): Promise<RegisterDeviceResponse> {
    const validated = RegisterDeviceRequestSchema.parse(data);
    return this.request('/api/users/devices', {
      method: 'POST',
      body: JSON.stringify(validated),
      schema: RegisterDeviceResponseSchema,
      ...options,
    });
  }

  /**
   * GET /api/users/devices
   * Lists all registered devices for the authenticated user.
   */
  public async getDevices(options?: HttpRequestOptions): Promise<GetDevicesResponse> {
    return this.request('/api/users/devices', {
      method: 'GET',
      schema: GetDevicesResponseSchema,
      ...options,
    });
  }

  // ==========================================
  // Conversation Endpoints
  // ==========================================

  /**
   * GET /api/conversations
   * Lists or searches conversations for the authenticated user.
   */
  public async listConversations(
    query?: ListConversationsQuery,
    options?: HttpRequestOptions,
  ): Promise<ListConversationsResponse> {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.status) params.set('status', query.status);
    if (query?.limit) params.set('limit', String(query.limit));

    const qs = params.toString();
    const endpoint = `/api/conversations${qs ? `?${qs}` : ''}`;

    return this.request(endpoint, {
      method: 'GET',
      schema: ListConversationsResponseSchema,
      ...options,
    });
  }

  /**
   * POST /api/conversations
   * Starts a new agent conversation session.
   */
  public async createConversation(
    data?: CreateConversationRequest,
    options?: HttpRequestOptions,
  ): Promise<CreateConversationResponse> {
    const body = data ? CreateConversationRequestSchema.parse(data) : {};
    return this.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
      schema: CreateConversationResponseSchema,
      ...options,
    });
  }

  /** Issues a short-lived opaque ticket used for the WebSocket upgrade. */
  public async createWsTicket(options?: HttpRequestOptions): Promise<CreateWsTicketResponse> {
    return this.request('/api/ws/ticket', {
      method: 'POST',
      schema: CreateWsTicketResponseSchema,
      ...options,
    });
  }

  /**
   * GET /api/conversations/:id
   * Retrieves conversation details with full historical chat messages.
   */
  public async getConversation(id: string, options?: HttpRequestOptions): Promise<GetConversationResponse> {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'GET',
      schema: GetConversationResponseSchema,
      ...options,
    });
  }

  /**
   * PATCH /api/conversations/:id/status
   * Archives or restores a conversation. SYNTHESIZED is server-owned.
   */
  public async updateConversationStatus(
    id: string,
    status: 'ACTIVE' | 'ARCHIVED',
    options?: HttpRequestOptions,
  ): Promise<UpdateConversationStatusResponse> {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
      schema: UpdateConversationStatusResponseSchema,
      ...options,
    });
  }

  // ==========================================
  // Rule Management Endpoints
  // ==========================================

  /**
   * GET /api/rules
   * Lists all rules belonging to the authenticated user with child sub-sentinels.
   */
  public async listRules(query?: ListRulesQuery, options?: HttpRequestOptions): Promise<ListRulesResponse> {
    const params = new URLSearchParams();
    if (query?.category) params.set('category', query.category);
    if (query?.status) params.set('status', query.status);

    const qs = params.toString();
    const endpoint = `/api/rules${qs ? `?${qs}` : ''}`;

    return this.request(endpoint, {
      method: 'GET',
      schema: ListRulesResponseSchema,
      ...options,
    });
  }

  /**
   * GET /api/rules/:id
   * Retrieves a specific rule and its child sub-sentinels.
   */
  public async getRule(id: string, options?: HttpRequestOptions): Promise<GetRuleResponse> {
    return this.request(`/api/rules/${encodeURIComponent(id)}`, {
      method: 'GET',
      schema: GetRuleResponseSchema,
      ...options,
    });
  }

  /**
   * PATCH /api/rules/:id/status
   * Pauses, resumes, or archives an active rule.
   */
  public async updateRuleStatus(
    id: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
    options?: HttpRequestOptions,
  ): Promise<UpdateRuleStatusResponse> {
    return this.request(`/api/rules/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
      schema: UpdateRuleStatusResponseSchema,
      ...options,
    });
  }

  /**
   * DELETE /api/rules/:id
   * Deletes a rule and cascades deletion to child sub-sentinels and alerts.
   */
  public async deleteRule(id: string, options?: HttpRequestOptions): Promise<DeleteRuleResponse> {
    return this.request(`/api/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      schema: DeleteRuleResponseSchema,
      ...options,
    });
  }

  // ==========================================
  // Interrupt (HITL) Endpoints
  // ==========================================

  /**
   * GET /api/interrupts/pending
   * Lists all pending interrupts requiring human confirmation.
   */
  public async getPendingInterrupts(options?: HttpRequestOptions): Promise<GetPendingInterruptsResponse> {
    return this.request('/api/interrupts/pending', {
      method: 'GET',
      schema: GetPendingInterruptsResponseSchema,
      ...options,
    });
  }

  /**
   * GET /api/interrupts/:id
   * Retrieves single interrupt action details.
   */
  public async getInterrupt(id: string, options?: HttpRequestOptions): Promise<GetInterruptResponse> {
    return this.request(`/api/interrupts/${encodeURIComponent(id)}`, {
      method: 'GET',
      schema: GetInterruptResponseSchema,
      ...options,
    });
  }

  // ==========================================
  // Alert Notification Endpoints
  // ==========================================

  /**
   * GET /api/alerts
   * Lists historical alert notifications for the authenticated user.
   */
  public async listAlerts(query?: ListAlertsQuery, options?: HttpRequestOptions): Promise<ListAlertsResponse> {
    const params = new URLSearchParams();
    if (query?.limit) params.set('limit', String(query.limit));
    if (query?.rule_id) params.set('rule_id', query.rule_id);

    const qs = params.toString();
    const endpoint = `/api/alerts${qs ? `?${qs}` : ''}`;

    return this.request(endpoint, {
      method: 'GET',
      schema: ListAlertsResponseSchema,
      ...options,
    });
  }

  /**
   * GET /api/alerts/:id
   * Retrieves single alert event details.
   */
  public async getAlert(id: string, options?: HttpRequestOptions): Promise<GetAlertResponse> {
    return this.request(`/api/alerts/${encodeURIComponent(id)}`, {
      method: 'GET',
      schema: GetAlertResponseSchema,
      ...options,
    });
  }
}

export const httpAdapter = new HttpAdapter();
