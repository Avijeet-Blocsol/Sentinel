/**
 * Strands Sentinel - Client Zustand State Store
 * Holds reactive state for active Sentinels, telemetry charts, live alerts,
 * active conversations, and streaming agent turns.
 */

import { create } from 'zustand';
import type {
  Rule,
  SubSentinel,
  SubSentry,
  AlertEvent,
  EnrichedInterruptAction,
  TelemetryPoint,
  ChatMessage,
  AgentConversation,
} from '@sentinel/shared';
import { playAlertTone } from '../services/soundService';

const MAX_CHAT_MESSAGES = 500;
const MAX_ALERTS = 100;
const MAX_COMPLETED_TURNS = 500;
let localMessageSequence = 0;

function makeLocalMessageId(prefix: string): string {
  localMessageSequence = (localMessageSequence + 1) % 1_000_000;
  return `${prefix}_${Date.now()}_${localMessageSequence}`;
}

interface SentinelStoreState {
  // Remote-data lifecycle. Cached dashboard data remains visible during a
  // refresh; errors describe only the most recent revalidation attempt.
  dashboardStatus: 'IDLE' | 'REFRESHING' | 'READY' | 'DEGRADED';
  lastDashboardRefreshAt: number | null;
  dashboardErrors: string[];

  // Conversational state
  conversations: AgentConversation[];
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  chatMessages: ChatMessage[];
  streamingMessage: string;
  isGenerating: boolean;
  streamingTurnId: string | null;
  lastStreamSequence: number;
  completedStreamTurns: Record<string, boolean>;

  // Sentinels, Rules & Telemetry
  rules: Rule[];
  subSentinels: Record<string, SubSentinel[]>; // ruleId -> SubSentinel[]
  subSentries: Record<string, SubSentinel[]>;  // Backward compatibility alias
  alerts: AlertEvent[];
  pendingActions: EnrichedInterruptAction[];
  resolvingInterruptIds: Record<string, boolean>;
  telemetry: Record<string, TelemetryPoint[]>; // ruleId -> TelemetryPoint[]
  isLiveConnected: boolean;

  // Actions - Conversations & Chat
  setDashboardRefreshState: (
    status: SentinelStoreState['dashboardStatus'],
    errors?: string[],
  ) => void;
  setConversations: (conversations: AgentConversation[]) => void;
  addConversation: (conversation: AgentConversation) => void;
  setActiveConversationId: (id: string | null) => void;
  setActiveConversationTitle: (title: string | null) => void;
  setIsGenerating: (isGenerating: boolean) => void;
  setChatMessages: (messages: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  removeChatMessage: (id: string) => void;
  appendStreamingChunk: (chunk: string, turnId?: string, sequence?: number) => void;
  finishStreaming: (finalMessage?: string, turnId?: string) => void;
  clearStreaming: () => void;

  // Actions - Sentinels & Telemetry
  setRules: (rules: Rule[]) => void;
  addRule: (rule: Rule, sentinels?: SubSentinel[]) => void;
  removeRule: (ruleId: string) => void;
  updateRuleStatus: (ruleId: string, status: Rule['status']) => void;
  updateSubSentinel: (sentinel: Partial<SubSentinel> & { id: string; rule_id: string }) => void;
  updateSubSentry: (sentinel: Partial<SubSentinel> & { id: string; rule_id: string }) => void;
  setAlerts: (alerts: AlertEvent[]) => void;
  addAlert: (alert: AlertEvent) => void;
  setPendingActions: (actions: EnrichedInterruptAction[]) => void;
  addPendingAction: (action: EnrichedInterruptAction) => void;
  markInterruptResolving: (id: string) => void;
  restorePendingAction: (action: EnrichedInterruptAction) => void;
  resolveInterruptAction: (id: string, status: 'APPROVED' | 'REJECTED') => void;
  addTelemetryPoint: (point: TelemetryPoint) => void;
  setLiveConnected: (connected: boolean) => void;
  resetSession: () => void;
}

export const useSentinelStore = create<SentinelStoreState>((set) => ({
  dashboardStatus: 'IDLE',
  lastDashboardRefreshAt: null,
  dashboardErrors: [],

  conversations: [],
  activeConversationId: null,
  activeConversationTitle: null,
  chatMessages: [],
  streamingMessage: '',
  isGenerating: false,
  streamingTurnId: null,
  lastStreamSequence: -1,
  completedStreamTurns: {},

  rules: [],
  subSentinels: {},
  subSentries: {},
  alerts: [],
  pendingActions: [],
  resolvingInterruptIds: {},
  telemetry: {},
  isLiveConnected: false,

  // Conversations
  setDashboardRefreshState: (dashboardStatus, dashboardErrors = []) =>
    set({
      dashboardStatus,
      dashboardErrors,
      ...(dashboardStatus === 'REFRESHING'
        ? {}
        : { lastDashboardRefreshAt: Date.now() }),
    }),

  setConversations: (conversations) => set({ conversations }),

  addConversation: (conversation) =>
    set((state) => ({
      conversations: [conversation, ...state.conversations.filter((c) => c.id !== conversation.id)],
    })),

  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),

  setActiveConversationTitle: (activeConversationTitle) => set({ activeConversationTitle }),

  setIsGenerating: (isGenerating) => set({ isGenerating }),

  setChatMessages: (chatMessages) => set({ chatMessages: chatMessages.slice(-MAX_CHAT_MESSAGES) }),

  addChatMessage: (msg) =>
    set((state) => ({
      chatMessages: [...state.chatMessages, msg].slice(-MAX_CHAT_MESSAGES),
    })),

  removeChatMessage: (id) =>
    set((state) => ({
      chatMessages: state.chatMessages.filter((message) => message.id !== id),
    })),

  appendStreamingChunk: (chunk, turnId, sequence) =>
    set((state) => {
      if (turnId && state.completedStreamTurns[turnId]) return state;

      const isNewTurn = Boolean(turnId && turnId !== state.streamingTurnId);
      if (sequence !== undefined && !isNewTurn && sequence <= state.lastStreamSequence) return state;

      return {
        streamingMessage: (isNewTurn ? '' : state.streamingMessage) + chunk,
        isGenerating: true,
        streamingTurnId: turnId ?? state.streamingTurnId,
        lastStreamSequence: sequence ?? (isNewTurn ? -1 : state.lastStreamSequence),
      };
    }),

  finishStreaming: (finalMessage, turnId) =>
    set((state) => {
      if (turnId && state.completedStreamTurns[turnId]) return state;
      const completedStreamTurns = turnId
        ? { ...state.completedStreamTurns, [turnId]: true }
        : state.completedStreamTurns;
      const completedTurnIds = Object.keys(completedStreamTurns);
      for (const oldTurnId of completedTurnIds.slice(0, -MAX_COMPLETED_TURNS)) {
        delete completedStreamTurns[oldTurnId];
      }
      const assistantMessage: ChatMessage | null = finalMessage
        ? {
            id: makeLocalMessageId('stream'),
            conversation_id: state.activeConversationId || '',
            role: 'assistant',
            content: finalMessage,
            created_at: Date.now(),
          }
        : null;
      return {
        streamingMessage: '',
        isGenerating: false,
        streamingTurnId: null,
        lastStreamSequence: -1,
        completedStreamTurns,
        chatMessages: assistantMessage
          ? [...state.chatMessages, assistantMessage].slice(-MAX_CHAT_MESSAGES)
          : state.chatMessages,
      };
    }),

  clearStreaming: () => set({ streamingMessage: '', isGenerating: false, streamingTurnId: null, lastStreamSequence: -1 }),

  // Rules & Sentinels
  setRules: (rules) => {
    const subMap: Record<string, SubSentinel[]> = {};
    for (const rule of rules) {
      if ((rule as any).sub_sentinels) {
        subMap[rule.id] = (rule as any).sub_sentinels;
      }
    }
    set({
      rules,
      subSentinels: subMap,
      subSentries: subMap,
    });
  },

  addRule: (rule, sentinels = []) =>
    set((state) => ({
      rules: [rule, ...state.rules.filter((r) => r.id !== rule.id)],
      subSentinels: {
        ...state.subSentinels,
        [rule.id]: sentinels,
      },
      subSentries: {
        ...state.subSentries,
        [rule.id]: sentinels,
      },
    })),

  removeRule: (ruleId) =>
    set((state) => {
      const nextSubs = { ...state.subSentinels };
      delete nextSubs[ruleId];
      return {
        rules: state.rules.filter((r) => r.id !== ruleId),
        subSentinels: nextSubs,
        subSentries: nextSubs,
      };
    }),

  updateRuleStatus: (ruleId, status) =>
    set((state) => ({
      rules: state.rules.map((r) => (r.id === ruleId ? { ...r, status, updated_at: Date.now() } : r)),
    })),

  updateSubSentinel: (updated) =>
    set((state) => {
      const existingList = state.subSentinels[updated.rule_id] || [];
      const newList = existingList.map((s) => (s.id === updated.id ? { ...s, ...updated } : s));
      return {
        subSentinels: {
          ...state.subSentinels,
          [updated.rule_id]: newList,
        },
        subSentries: {
          ...state.subSentries,
          [updated.rule_id]: newList,
        },
      };
    }),

  updateSubSentry: (updated) => {
    useSentinelStore.getState().updateSubSentinel(updated);
  },

  setAlerts: (alerts) => set({ alerts: alerts.slice(0, MAX_ALERTS) }),

  addAlert: (alert) => {
    // Play ambient ringtone automatically on alert
    playAlertTone(alert.audio_tone);

    set((state) => ({
      alerts: [alert, ...state.alerts.filter((a) => a.id !== alert.id)].slice(0, MAX_ALERTS),
    }));
  },

  setPendingActions: (pendingActions) => set({ pendingActions, resolvingInterruptIds: {} }),

  addPendingAction: (action) =>
    set((state) => ({
      pendingActions: [action, ...state.pendingActions.filter((a) => a.id !== action.id)],
      resolvingInterruptIds: { ...state.resolvingInterruptIds, [action.id]: false },
    })),

  markInterruptResolving: (id) =>
    set((state) => ({
      resolvingInterruptIds: { ...state.resolvingInterruptIds, [id]: true },
    })),

  restorePendingAction: (action) =>
    set((state) => ({
      pendingActions: [action, ...state.pendingActions.filter((a) => a.id !== action.id)],
      resolvingInterruptIds: { ...state.resolvingInterruptIds, [action.id]: false },
    })),

  resolveInterruptAction: (id, status) =>
    set((state) => ({
      pendingActions: state.pendingActions.filter((a) => a.id !== id),
      resolvingInterruptIds: Object.fromEntries(
        Object.entries(state.resolvingInterruptIds).filter(([key]) => key !== id)
      ),
    })),

  addTelemetryPoint: (point) =>
    set((state) => {
      const targetKey = point.rule_id;
      const existing = state.telemetry[targetKey] || [];
      const updated = [...existing, point].slice(-60); // Keep last 60 points for charts
      return {
        telemetry: {
          ...state.telemetry,
          [targetKey]: updated,
        },
      };
    }),

  setLiveConnected: (connected) => set({ isLiveConnected: connected }),

  resetSession: () =>
    set({
      dashboardStatus: 'IDLE',
      lastDashboardRefreshAt: null,
      dashboardErrors: [],
      conversations: [],
      activeConversationId: null,
      activeConversationTitle: null,
      chatMessages: [],
      streamingMessage: '',
      isGenerating: false,
      streamingTurnId: null,
      lastStreamSequence: -1,
      completedStreamTurns: {},
      rules: [],
      subSentinels: {},
      subSentries: {},
      alerts: [],
      pendingActions: [],
      resolvingInterruptIds: {},
      telemetry: {},
      isLiveConnected: false,
    }),
}));
