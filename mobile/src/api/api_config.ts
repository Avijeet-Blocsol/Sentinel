/**
 * Strands Sentinel - API & Network Environment Configuration
 * Determines HTTP base URL and WebSocket base URL depending on platform and environment.
 */

const DEFAULT_SERVER_PORT = 8080;

/**
 * Returns the default host based on runtime platform:
 * - Android Emulator routes host machine through 10.0.2.2
 * - iOS Simulator & Web routes host machine through localhost
 */
function getDefaultHost(): string {
  try {
    // Dynamic require so it is safe in Node test runners
    const { Platform } = require('react-native');
    if (Platform && Platform.OS === 'android') {
      return '10.0.2.2';
    }
  } catch {
    // Fallback in non-RN environments
  }
  return 'localhost';
}

/**
 * Returns the HTTP base URL for Sentinel Fastify server.
 * Priority:
 * 1. EXPO_PUBLIC_API_URL environment variable (if defined)
 * 2. Platform-aware default (http://10.0.2.2:8080 on Android, http://localhost:8080 elsewhere)
 */
export function getApiBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_URL) {
    const url = process.env.EXPO_PUBLIC_API_URL.replace(/\/+$/, '');
    if (process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
      throw new Error('EXPO_PUBLIC_API_URL must use HTTPS in production');
    }
    return url;
  }
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
    throw new Error('Missing EXPO_PUBLIC_API_URL in production mobile build');
  }
  return `http://${getDefaultHost()}:${DEFAULT_SERVER_PORT}`;
}

/**
 * Returns the WebSocket base URL for Sentinel Fastify server.
 * Priority:
 * 1. EXPO_PUBLIC_WS_URL environment variable (if defined)
 * 2. Derived from getApiBaseUrl() (replacing http->ws, https->wss)
 */
export function getWsBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_WS_URL) {
    const url = process.env.EXPO_PUBLIC_WS_URL.replace(/\/+$/, '');
    if (process.env.NODE_ENV === 'production' && !url.startsWith('wss://')) {
      throw new Error('EXPO_PUBLIC_WS_URL must use WSS in production');
    }
    return url;
  }
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
    throw new Error('Missing EXPO_PUBLIC_WS_URL in production mobile build');
  }
  const httpUrl = getApiBaseUrl();
  return httpUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}

export const API_CONFIG = {
  getApiBaseUrl,
  getWsBaseUrl,
  timeoutMs: 15000,
  heartbeatIntervalMs: 30000,
  maxReconnectAttempts: 10,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
};
