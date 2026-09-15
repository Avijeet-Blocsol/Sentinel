import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;
const consumedTicketIds = new Map<string, number>();

function getTicketSecret(): string {
  const secret = process.env.WS_TICKET_SECRET || process.env.ENGINE_API_SECRET || process.env.SENTINEL_SERVICE_SECRET ||
    (process.env.NODE_ENV === 'production' ? '' : 'local-development-ws-ticket-secret');
  if (!secret) {
    throw new Error('WS_TICKET_SECRET or an engine service secret is required');
  }
  return secret;
}

function encode(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', getTicketSecret()).update(payload).digest('base64url');
}

export function issueWsTicket(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): {
  ticket: string;
  expiresAt: number;
} {
  const now = Date.now();
  const expiresAt = now + Math.min(Math.max(Math.floor(ttlSeconds), 1), MAX_TTL_SECONDS) * 1000;
  const payload = encode(JSON.stringify({
    sub: userId,
    exp: expiresAt,
    jti: randomUUID(),
  }));
  return {
    ticket: `${payload}.${sign(payload)}`,
    expiresAt,
  };
}

export function verifyWsTicket(ticket: string): { userId: string; expiresAt: number; jti: string } | null {
  try {
    const parts = ticket.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;

    const expected = sign(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
      jti?: unknown;
    };
    if (typeof decoded.sub !== 'string' || !decoded.sub || typeof decoded.exp !== 'number' ||
        typeof decoded.jti !== 'string' || !decoded.jti) return null;
    if (decoded.exp <= Date.now()) return null;

    return { userId: decoded.sub, expiresAt: decoded.exp, jti: decoded.jti };
  } catch {
    return null;
  }
}

/** Tickets are deliberately single-use within an API process. */
export function consumeWsTicket(ticket: string): { userId: string; expiresAt: number } | null {
  const claims = verifyWsTicket(ticket);
  if (!claims) return null;

  const now = Date.now();
  for (const [jti, expiresAt] of consumedTicketIds) {
    if (expiresAt <= now) consumedTicketIds.delete(jti);
  }
  if (consumedTicketIds.has(claims.jti)) return null;
  consumedTicketIds.set(claims.jti, claims.expiresAt);
  return claims;
}
