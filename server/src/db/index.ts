/**
 * Strands Sentinel - Database Client & Repository Layer
 * Powered by Node.js native SQLite (node:sqlite)
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  User,
  UserDevice,
  AgentConversation,
  ChatMessage,
  Rule,
  SubSentry,
  SeenEvent,
  TelemetryPoint,
  AlertEvent,
  InterruptAction,
} from '@sentinel/shared';

export * from '@sentinel/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Singleton & Initialization ---

let instance: DatabaseSync | null = null;

export function getDatabase(dbPath?: string): DatabaseSync {
  if (instance) return instance;

  const resolvedPath = dbPath || process.env.DATABASE_PATH || path.resolve(__dirname, '../../data/sentinel.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new DatabaseSync(resolvedPath);

  // Apply performance & integrity pragmas
  instance.exec('PRAGMA journal_mode = WAL;');
  instance.exec('PRAGMA foreign_keys = ON;');

  // Apply schema DDL
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    instance.exec(schemaSql);
  }

  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// --- 1. User Repository ---

export const userRepository = {
  create(user: User): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.google_sub ?? null,
      user.apple_sub ?? null,
      user.email,
      user.name,
      user.avatar_url ?? null,
      user.created_at,
      user.updated_at
    );
  },

  getById(id: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return (stmt.get(id) as unknown as User) || null;
  },

  getByGoogleSub(googleSub: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE google_sub = ?');
    return (stmt.get(googleSub) as unknown as User) || null;
  },

  getByEmail(email: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return (stmt.get(email) as unknown as User) || null;
  },
};

// --- 2. User Device Repository ---

export const userDeviceRepository = {
  registerDevice(device: UserDevice): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO user_devices (id, user_id, push_token, platform, last_active_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(push_token) DO UPDATE SET
        user_id = excluded.user_id,
        platform = excluded.platform,
        last_active_at = excluded.last_active_at
    `);
    stmt.run(device.id, device.user_id, device.push_token, device.platform, device.last_active_at);
  },

  getByUserId(userId: string): UserDevice[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM user_devices WHERE user_id = ?');
    return stmt.all(userId) as unknown as UserDevice[];
  },
};

// --- 3. Agent Conversation Repository ---

export const conversationRepository = {
  create(convo: AgentConversation): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO agent_conversations (id, user_id, title, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(convo.id, convo.user_id, convo.title, convo.status, convo.created_at);
  },

  getById(id: string): AgentConversation | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM agent_conversations WHERE id = ?');
    return (stmt.get(id) as unknown as AgentConversation) || null;
  },

  getByUserId(userId: string): AgentConversation[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM agent_conversations WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId) as unknown as AgentConversation[];
  },

  updateStatus(id: string, status: AgentConversation['status']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE agent_conversations SET status = ? WHERE id = ?');
    stmt.run(status, id);
  },
};

// --- 4. Chat Message Repository ---

export const chatMessageRepository = {
  create(msg: ChatMessage): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, msg.conversation_id, msg.role, msg.content, msg.tool_calls ?? null, msg.created_at);
  },

  getByConversationId(conversationId: string): ChatMessage[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC');
    return stmt.all(conversationId) as unknown as ChatMessage[];
  },
};

// --- 5. Rule Repository ---

export const ruleRepository = {
  create(rule: Rule): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO rules (
        id, user_id, conversation_id, natural_language_intent, combinator,
        trigger_mode, cooldown_minutes, audio_tone, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rule.id,
      rule.user_id,
      rule.conversation_id ?? null,
      rule.natural_language_intent,
      rule.combinator,
      rule.trigger_mode,
      rule.cooldown_minutes,
      rule.audio_tone,
      rule.status,
      rule.created_at,
      rule.updated_at
    );
  },

  getById(id: string): Rule | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE id = ?');
    return (stmt.get(id) as unknown as Rule) || null;
  },

  getByUserId(userId: string): Rule[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId) as unknown as Rule[];
  },

  getActiveRules(): Rule[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE status = ? ORDER BY created_at DESC');
    return stmt.all('ACTIVE') as unknown as Rule[];
  },

  updateStatus(id: string, status: Rule['status']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE rules SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, Date.now(), id);
  },

  delete(id: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM rules WHERE id = ?');
    stmt.run(id);
  },
};

// --- 6. Sub-Sentry Repository ---

export const subSentryRepository = {
  create(sentry: SubSentry): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO sub_sentries (
        id, rule_id, sentry_type, target_source, operator, threshold, ttl_seconds,
        last_evaluated_at, last_triggered_at, is_satisfied, satisfied_at,
        state_payload, health_status, error_count, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sentry.id,
      sentry.rule_id,
      sentry.sentry_type,
      sentry.target_source,
      sentry.operator,
      sentry.threshold,
      sentry.ttl_seconds,
      sentry.last_evaluated_at ?? null,
      sentry.last_triggered_at ?? null,
      sentry.is_satisfied,
      sentry.satisfied_at ?? null,
      sentry.state_payload ?? null,
      sentry.health_status,
      sentry.error_count,
      sentry.last_error ?? null
    );
  },

  getByRuleId(ruleId: string): SubSentry[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM sub_sentries WHERE rule_id = ?');
    return stmt.all(ruleId) as unknown as SubSentry[];
  },

  updateSatisfaction(
    id: string,
    isSatisfied: boolean,
    statePayload?: string,
    error?: string | null
  ): void {
    const db = getDatabase();
    const now = Date.now();
    const satisfiedInt = isSatisfied ? 1 : 0;

    if (error) {
      const stmt = db.prepare(`
        UPDATE sub_sentries
        SET last_evaluated_at = ?,
            error_count = error_count + 1,
            health_status = 'ERROR',
            last_error = ?
        WHERE id = ?
      `);
      stmt.run(now, error, id);
    } else {
      const stmt = db.prepare(`
        UPDATE sub_sentries
        SET last_evaluated_at = ?,
            last_triggered_at = CASE WHEN ? = 1 THEN ? ELSE last_triggered_at END,
            satisfied_at = CASE WHEN ? = 1 AND is_satisfied = 0 THEN ? ELSE satisfied_at END,
            is_satisfied = ?,
            state_payload = coalesce(?, state_payload),
            health_status = 'HEALTHY',
            last_error = NULL
        WHERE id = ?
      `);
      stmt.run(now, satisfiedInt, now, satisfiedInt, now, satisfiedInt, statePayload ?? null, id);
    }
  },
};

// --- 7. Seen Event Repository ---

export const seenEventRepository = {
  isEventSeen(sentryId: string, eventHash: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('SELECT 1 FROM seen_events WHERE sentry_id = ? AND event_hash = ?');
    return Boolean(stmt.get(sentryId, eventHash));
  },

  recordSeenEvent(id: string, sentryId: string, source: string, eventHash: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO seen_events (id, sentry_id, source, event_hash, seen_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, sentryId, source, eventHash, Date.now());
  },
};

// --- 8. Telemetry Point Repository ---

export const telemetryRepository = {
  log(point: TelemetryPoint): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO telemetry_points (id, rule_id, sentry_id, metric_name, value, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      point.id,
      point.rule_id,
      point.sentry_id ?? null,
      point.metric_name,
      point.value,
      point.timestamp,
      point.metadata ?? null
    );
  },

  getByRuleId(ruleId: string, limit = 100): TelemetryPoint[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM telemetry_points
      WHERE rule_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(ruleId, limit) as unknown as TelemetryPoint[];
  },
};

// --- 9. Alert Event Repository ---

export const alertEventRepository = {
  create(alert: AlertEvent): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO alert_events (id, rule_id, user_id, title, summary, audio_tone, snapshot_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      alert.id,
      alert.rule_id,
      alert.user_id,
      alert.title,
      alert.summary,
      alert.audio_tone,
      alert.snapshot_data ?? null,
      alert.created_at
    );
  },

  getByUserId(userId: string, limit = 50): AlertEvent[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM alert_events
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as unknown as AlertEvent[];
  },
};

// --- 10. Interrupt Action Repository ---

export const interruptActionRepository = {
  create(action: InterruptAction): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO interrupt_actions (
        id, alert_id, rule_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      action.id,
      action.alert_id ?? null,
      action.rule_id,
      action.user_id,
      action.action_type,
      action.action_payload,
      action.status,
      action.expires_at ?? null,
      action.created_at,
      action.resolved_at ?? null
    );
  },

  getPending(): InterruptAction[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM interrupt_actions WHERE status = ? ORDER BY created_at ASC');
    return stmt.all('PENDING') as unknown as InterruptAction[];
  },

  getById(id: string): InterruptAction | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM interrupt_actions WHERE id = ?');
    return (stmt.get(id) as unknown as InterruptAction) || null;
  },

  updateStatus(id: string, status: InterruptAction['status']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE interrupt_actions SET status = ?, resolved_at = ? WHERE id = ?');
    stmt.run(status, Date.now(), id);
  },
};
