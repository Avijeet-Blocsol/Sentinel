/**
 * Strands Sentinel - React Hook for Client & Adapter Access
 * Wires Clerk authentication tokens into SentinelClient and provides
 * access to HTTP, WebSocket, and reactive monitoring state.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/expo';
import { AppState, type AppStateStatus } from 'react-native';
import { sentinelClient } from '../api/sentinel_client';
import { useSentinelStore } from '../store/useSentinelStore';
import { registerForPushNotificationsAsync } from '../services/push_notifications';


export function useSentinelBootstrap() {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const pushRegistrationAttempted = useRef(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // Wire Clerk token provider whenever auth state stabilizes
  useEffect(() => {
    if (!isLoaded) return;

    if (isSignedIn) {
      sentinelClient.setTokenProvider(async ({ forceRefresh } = {}) => {
        return getTokenRef.current(forceRefresh ? { skipCache: true } : undefined);
      });

      // Synchronize dashboard on sign in.
      void sentinelClient.syncDashboard();

      if (!pushRegistrationAttempted.current) {
        pushRegistrationAttempted.current = true;
        void registerForPushNotificationsAsync().then((device) => {
          if (device) {
            return sentinelClient.http.registerDevice(device);
          }
          return undefined;
        }).catch((error) => {
          console.warn('[useSentinel] Push registration failed:', error);
        });
      }
    } else {
      pushRegistrationAttempted.current = false;
      sentinelClient.resetSession(true);
    }
  }, [isLoaded, isSignedIn]);

  // Mobile operating systems may suspend or terminate an idle socket while an
  // app is backgrounded. Resume from durable HTTP state first, then reopen the
  // active stream, so alerts and completed responses are not lost.
  useEffect(() => {
    if (!isSignedIn) return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasBackgrounded = /inactive|background/.test(appState.current);
      const isBackgrounded = /inactive|background/.test(nextState);
      appState.current = nextState;

      if (isBackgrounded) {
        sentinelClient.suspendRealtime();
      } else if (nextState === 'active' && wasBackgrounded) {
        sentinelClient.resumeRealtime();
      }
    });
    return () => subscription.remove();
  }, [isSignedIn]);

}

/** Read-only React facade over the singleton domain client and Zustand state. */
export function useSentinel() {
  const dashboardStatus = useSentinelStore((s) => s.dashboardStatus);
  const lastDashboardRefreshAt = useSentinelStore((s) => s.lastDashboardRefreshAt);
  const dashboardErrors = useSentinelStore((s) => s.dashboardErrors);
  const isLiveConnected = useSentinelStore((s) => s.isLiveConnected);
  const activeConversationId = useSentinelStore((s) => s.activeConversationId);
  const activeConversationTitle = useSentinelStore((s) => s.activeConversationTitle);
  const streamingMessage = useSentinelStore((s) => s.streamingMessage);
  const isGenerating = useSentinelStore((s) => s.isGenerating);
  const statusRequestInFlight = useSentinelStore((s) => s.statusRequestInFlight);
  const setIsGenerating = useSentinelStore((s) => s.setIsGenerating);
  const chatMessages = useSentinelStore((s) => s.chatMessages);
  const conversations = useSentinelStore((s) => s.conversations);
  const rules = useSentinelStore((s) => s.rules);
  const subSentinels = useSentinelStore((s) => s.subSentinels);
  const alerts = useSentinelStore((s) => s.alerts);
  const pendingActions = useSentinelStore((s) => s.pendingActions);
  const telemetry = useSentinelStore((s) => s.telemetry);

  const sendMessage = useCallback((content: string) => {
    sentinelClient.sendMessage(content);
  }, []);

  const dispatchPrompt = useCallback((content: string, options?: { forceNew?: boolean }) => {
    return sentinelClient.dispatchPrompt(content, options);
  }, []);

  const resolveInterrupt = useCallback(
    (interruptId: string, resolution: 'APPROVED' | 'REJECTED', choiceId?: string, responseText?: string) => {
      return sentinelClient.resolveInterrupt(interruptId, resolution, choiceId, responseText);
    },
    []
  );

  const requestTaskStatus = useCallback(() => {
    return sentinelClient.requestTaskStatus();
  }, []);

  const connectConversation = useCallback((conversationId: string, title?: string) => {
    return sentinelClient.connectConversation(conversationId, title);
  }, []);

  const disconnectConversation = useCallback(() => {
    sentinelClient.disconnectConversation();
  }, []);

  const syncDashboard = useCallback(() => {
    return sentinelClient.syncDashboard();
  }, []);

  return {
    client: sentinelClient,
    http: sentinelClient.http,
    ws: sentinelClient.ws,
    dashboardStatus,
    lastDashboardRefreshAt,
    dashboardErrors,
    isLiveConnected,
    activeConversationId,
    activeConversationTitle,
    streamingMessage,
    isGenerating,
    statusRequestInFlight,
    setIsGenerating,
    chatMessages,
    conversations,
    rules,
    subSentinels,
    alerts,
    pendingActions,
    telemetry,
    sendMessage,
    dispatchPrompt,
    resolveInterrupt,
    requestTaskStatus,
    connectConversation,
    disconnectConversation,
    syncDashboard,
  };
}
