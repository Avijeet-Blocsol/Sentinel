/**
 * Strands Sentinel - WebSocket Security Guard Middleware
 * Provides frame size validation, heartbeat ping-pong, and zombie socket cleanup
 */

import type WebSocket from 'ws';

export interface WebSocketWithAlive extends WebSocket {
  isAlive?: boolean;
}

const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KB per frame

/**
 * Validates incoming WebSocket frame size and safely parses JSON
 */
export function parseAndValidateWsMessage<T = any>(
  raw: Buffer | string,
  maxSizeBytes: number = MAX_WS_PAYLOAD_BYTES
): { valid: true; data: T } | { valid: false; error: string } {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;

  if (byteLength > maxSizeBytes) {
    return {
      valid: false,
      error: `Frame size (${byteLength} bytes) exceeds limit (${maxSizeBytes} bytes)`,
    };
  }

  try {
    const parsed = JSON.parse(raw.toString());
    return { valid: true, data: parsed as T };
  } catch (err: any) {
    return { valid: false, error: 'Malformed JSON frame' };
  }
}

/**
 * Sets up ping/pong heartbeat to clean up broken / zombie connections
 * Frequently happens on mobile devices switching networks
 */
export function setupHeartbeat(
  socket: WebSocketWithAlive,
  intervalMs = 30000
): () => void {
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  const intervalId = setInterval(() => {
    if (socket.isAlive === false) {
      // Failed to respond to last ping — terminate socket
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    socket.ping();
  }, intervalMs);

  socket.on('close', () => {
    clearInterval(intervalId);
  });

  return () => clearInterval(intervalId);
}

/**
 * Helper to close socket with standard WS Policy Violation (1008)
 */
export function closeWithPolicyViolation(socket: WebSocket, reason: string): void {
  socket.close(1008, reason.substring(0, 120));
}
