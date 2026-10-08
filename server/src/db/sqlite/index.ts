/**
 * Strands Sentinel - SQLite Database Adapter
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
  SubSentinel,
  SeenEvent,
  TelemetryPoint,
  AlertEvent,
  InterruptAction,
  EnrichedInterruptAction,
} from '@sentinel/shared';
import { isChoiceInterruptActionType } from '@sentinel/shared';
import type {
  DatabaseAdapter,
  DeploymentCommitInput,
  DeploymentProposalInput,
  MonitoringModeDeploymentInput,
  MonitoringModeProposalInput,
  TaskEditCommitInput,
  EnrichedAlertEvent,
  ExecutionLeaseRecord,
  TriggerCommitInput,
} from '../types.js';
import { getInitialDueSchedule } from '../../scheduling/due_schedule.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let instance: DatabaseSync | null = null;

export function getDatabase(dbPath?: string): DatabaseSync {
  if (instance) return instance;

  const resolvedPath =
    dbPath ||
    process.env.DATABASE_PATH ||
    path.resolve(__dirname, '../../../data/sentinel.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new DatabaseSync(resolvedPath);

  // Apply performance & integrity pragmas
  instance.exec('PRAGMA journal_mode = WAL;');
  instance.exec('PRAGMA foreign_keys = ON;');
  instance.exec('PRAGMA busy_timeout = 5000;');

  // Apply schema DDL if available
  const schemaPath = path.resolve(__dirname, '../schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    instance.exec(schemaSql);
  }

  // Safe migrations: inspect the catalog before altering tables so genuine
  // permission/syntax failures are not silently treated as "already exists".
  const hasColumn = (table: string, column: string): boolean => {
    const rows = instance!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
  };
  if (!hasColumn('rules', 'condition_tree')) instance.exec('ALTER TABLE rules ADD COLUMN condition_tree TEXT;');
  if (!hasColumn('agent_conversations', 'phase')) {
    instance.exec("ALTER TABLE agent_conversations ADD COLUMN phase TEXT NOT NULL DEFAULT 'DISCOVERY';");
  }
  const conversationTable = instance.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_conversations'",
  ).get() as { sql?: string } | undefined;
  if (conversationTable?.sql && (!conversationTable.sql.includes('AWAITING_TRIGGER_MODE') || !conversationTable.sql.includes('CLARIFICATION_PENDING'))) {
    // Older local databases have a CHECK constraint that predates the
    // lifecycle-selection phase. SQLite cannot alter a CHECK in place, so
    // rebuild only this small parent table while preserving all rows.
    instance.exec('PRAGMA foreign_keys = OFF;');
    instance.exec('BEGIN IMMEDIATE;');
    try {
      instance.exec(`
        CREATE TABLE agent_conversations_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED', 'SYNTHESIZED')),
          phase TEXT NOT NULL DEFAULT 'DISCOVERY' CHECK (phase IN ('DISCOVERY', 'AWAITING_QUERY_CONFIRMATION', 'SCOUTING', 'AWAITING_TRIGGER_MODE', 'CLARIFICATION_PENDING', 'INTERRUPT_PENDING', 'DEPLOYED')),
          created_at INTEGER NOT NULL
        );
        INSERT INTO agent_conversations_new (id, user_id, title, status, phase, created_at)
          SELECT id, user_id, title, status, phase, created_at FROM agent_conversations;
        DROP TABLE agent_conversations;
        ALTER TABLE agent_conversations_new RENAME TO agent_conversations;
      `);
      instance.exec('COMMIT;');
    } catch (error) {
      try { instance.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      instance.exec('PRAGMA foreign_keys = ON;');
    }
  }
  const interruptTable = instance.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'interrupt_actions'",
  ).get() as { sql?: string } | undefined;
  if (interruptTable?.sql && (!interruptTable.sql.includes('conversation_id') || interruptTable.sql.includes('rule_id TEXT NOT NULL'))) {
    // Add the nullable column first when the legacy table has no conversation
    // routing metadata, allowing the rebuild below to preserve it uniformly.
    if (!hasColumn('interrupt_actions', 'conversation_id')) {
      instance.exec('ALTER TABLE interrupt_actions ADD COLUMN conversation_id TEXT;');
    }
    instance.exec('PRAGMA foreign_keys = OFF;');
    instance.exec('BEGIN IMMEDIATE;');
    try {
      instance.exec(`
        CREATE TABLE interrupt_actions_new (
          id TEXT PRIMARY KEY,
          alert_id TEXT REFERENCES alert_events(id) ON DELETE CASCADE,
          rule_id TEXT REFERENCES rules(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES agent_conversations(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action_type TEXT NOT NULL,
          action_payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        INSERT INTO interrupt_actions_new (
          id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
        )
          SELECT id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
          FROM interrupt_actions;
        DROP TABLE interrupt_actions;
        ALTER TABLE interrupt_actions_new RENAME TO interrupt_actions;
      `);
      instance.exec('COMMIT;');
    } catch (error) {
      try { instance.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      instance.exec('PRAGMA foreign_keys = ON;');
    }
  }
  const executionTable = instance.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_leases'",
  ).get() as { sql?: string } | undefined;
  if (executionTable?.sql && !executionTable.sql.includes('WORKFLOW_RESUME')) {
    // Extend the durable lease table for idempotent workflow resumes while
    // preserving leases created by older local databases.
    instance.exec('PRAGMA foreign_keys = OFF;');
    instance.exec('BEGIN IMMEDIATE;');
    try {
      instance.exec(`
        CREATE TABLE execution_leases_new (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK (event_type IN ('TICK', 'EVALUATE_RULE', 'WORKFLOW_RESUME')),
          rule_id TEXT REFERENCES rules(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
          lease_owner TEXT NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          result_payload TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO execution_leases_new (
          id, event_type, rule_id, status, lease_owner, lease_expires_at, attempts, result_payload, last_error, created_at, updated_at
        )
          SELECT id, event_type, rule_id, status, lease_owner, lease_expires_at, attempts, result_payload, last_error, created_at, updated_at
          FROM execution_leases;
        DROP TABLE execution_leases;
        ALTER TABLE execution_leases_new RENAME TO execution_leases;
      `);
      instance.exec('COMMIT;');
    } catch (error) {
      try { instance.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      instance.exec('PRAGMA foreign_keys = ON;');
    }
  }
  if (!hasColumn('rules', 'last_triggered_at')) instance.exec('ALTER TABLE rules ADD COLUMN last_triggered_at INTEGER;');
  if (!hasColumn('sub_sentinels', 'schedule_shard')) instance.exec('ALTER TABLE sub_sentinels ADD COLUMN schedule_shard TEXT;');
  if (!hasColumn('sub_sentinels', 'next_evaluation_at')) instance.exec('ALTER TABLE sub_sentinels ADD COLUMN next_evaluation_at INTEGER;');
  // Table rebuilds used for SQLite CHECK-constraint migrations drop indexes
  // attached to the old table. Recreate the routing indexes idempotently.
  instance.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON agent_conversations(user_id);');
  instance.exec('CREATE INDEX IF NOT EXISTS idx_interrupt_alert_id ON interrupt_actions(alert_id);');
  instance.exec('CREATE INDEX IF NOT EXISTS idx_interrupt_status ON interrupt_actions(status);');
  instance.exec('CREATE INDEX IF NOT EXISTS idx_execution_leases_status ON execution_leases(status);');
  instance.exec('CREATE INDEX IF NOT EXISTS idx_sub_sentinels_due ON sub_sentinels(next_evaluation_at, schedule_shard);');
  // Existing development databases may contain duplicate reads from the
  // pre-unique deduplication path. Keep the earliest row before enforcing the
  // invariant for future concurrent writers.
  instance.exec(`
    DELETE FROM seen_events
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM seen_events GROUP BY sub_sentinel_id, event_hash
    );
  `);
  instance.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_events_sub_hash_unique ON seen_events(sub_sentinel_id, event_hash);');

  return instance;
}

export const sqliteUserRepository = {
  create(user: User): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO users (id, google_sub, apple_sub, github_sub, email, name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.google_sub ?? null,
      user.apple_sub ?? null,
      user.github_sub ?? null,
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

  getByAppleSub(appleSub: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE apple_sub = ?');
    return (stmt.get(appleSub) as unknown as User) || null;
  },

  getByGithubSub(githubSub: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE github_sub = ?');
    return (stmt.get(githubSub) as unknown as User) || null;
  },

  getByEmail(email: string): User | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return (stmt.get(email) as unknown as User) || null;
  },
};

export const sqliteUserDeviceRepository = {
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

  removeById(id: string): void {
    getDatabase().prepare('DELETE FROM user_devices WHERE id = ?').run(id);
  },
};

export const sqliteConversationRepository = {
  create(convo: AgentConversation): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO agent_conversations (id, user_id, title, status, phase, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(convo.id, convo.user_id, convo.title, convo.status, convo.phase ?? 'DISCOVERY', convo.created_at);
  },

  getById(id: string): AgentConversation | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM agent_conversations WHERE id = ?');
    return (stmt.get(id) as unknown as AgentConversation) || null;
  },

  getByUserId(userId: string, limit = 50): AgentConversation[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM agent_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
    return stmt.all(userId, Math.min(Math.max(limit, 1), 100)) as unknown as AgentConversation[];
  },

  updateStatus(id: string, status: AgentConversation['status']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE agent_conversations SET status = ? WHERE id = ?');
    stmt.run(status, id);
  },

  updatePhase(id: string, phase: AgentConversation['phase']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE agent_conversations SET phase = ? WHERE id = ?');
    stmt.run(phase, id);
  },

  search(
    userId: string,
    query: string,
    limit = 50
  ): Array<AgentConversation & { matched_snippet?: string | null }> {
    const db = getDatabase();
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return this.getByUserId(userId);
    }
    const pattern = `%${cleanQuery}%`;
    const stmt = db.prepare(`
      SELECT DISTINCT
        c.id,
        c.user_id,
        c.title,
        c.status,
        c.phase,
        c.created_at,
        (
          SELECT m.content
          FROM chat_messages m
          WHERE m.conversation_id = c.id
            AND m.content LIKE ?
          LIMIT 1
        ) AS raw_snippet
      FROM agent_conversations c
      LEFT JOIN chat_messages m ON m.conversation_id = c.id
      WHERE c.user_id = ?
        AND (
          c.title LIKE ?
          OR m.content LIKE ?
        )
      ORDER BY c.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(pattern, userId, pattern, pattern, limit) as unknown as Array<
      AgentConversation & { raw_snippet?: string | null }
    >;

    return rows.map((row) => {
      const { raw_snippet, ...convo } = row;
      let matched_snippet: string | null = null;
      if (raw_snippet) {
        const lower = raw_snippet.toLowerCase();
        const lowerQ = cleanQuery.toLowerCase();
        const idx = lower.indexOf(lowerQ);
        if (idx !== -1) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(raw_snippet.length, idx + cleanQuery.length + 50);
          matched_snippet =
            (start > 0 ? '...' : '') +
            raw_snippet.slice(start, end).trim() +
            (end < raw_snippet.length ? '...' : '');
        } else {
          matched_snippet =
            raw_snippet.slice(0, 80) + (raw_snippet.length > 80 ? '...' : '');
        }
      }
      return {
        ...convo,
        matched_snippet,
      };
    });
  },
};

export const sqliteChatMessageRepository = {
  create(msg: ChatMessage): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, msg.conversation_id, msg.role, msg.content, msg.tool_calls ?? null, msg.created_at);
  },

  getByConversationId(conversationId: string, limit = 500): ChatMessage[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?');
    return stmt.all(conversationId, Math.min(Math.max(limit, 1), 1000)) as unknown as ChatMessage[];
  },
};

export const sqliteRuleRepository = {
  create(rule: Rule): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO rules (
        id, user_id, conversation_id, title, natural_language_intent, category, combinator, condition_tree,
        trigger_mode, cooldown_minutes, audio_tone, status, expires_at, last_triggered_at, action_template, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rule.id,
      rule.user_id,
      rule.conversation_id ?? null,
      rule.title,
      rule.natural_language_intent,
      rule.category ?? 'FINANCIAL',
      rule.combinator ?? 'SINGLE',
      rule.condition_tree ?? null,
      rule.trigger_mode ?? 'PERSISTENT',
      rule.cooldown_minutes ?? 60,
      rule.audio_tone ?? 'chime',
      rule.status ?? 'ACTIVE',
      rule.expires_at ?? null,
      rule.last_triggered_at ?? null,
      rule.action_template ?? null,
      rule.created_at ?? Date.now(),
      rule.updated_at ?? Date.now()
    );
  },

  getById(id: string): Rule | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE id = ?');
    return (stmt.get(id) as unknown as Rule) || null;
  },

  getByUserId(userId: string, limit = 100): Rule[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
    return stmt.all(userId, Math.min(Math.max(limit, 1), 100)) as unknown as Rule[];
  },

  getByConversationId(conversationId: string): Rule[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM rules WHERE conversation_id = ? ORDER BY created_at DESC');
    return stmt.all(conversationId) as unknown as Rule[];
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

  claimCooldown(ruleId: string, now: number, cooldownMs: number): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE rules
      SET last_triggered_at = ?, updated_at = ?
      WHERE id = ?
        AND (last_triggered_at IS NULL OR (? - last_triggered_at) >= ?)
    `);
    const info = stmt.run(now, now, ruleId, now, cooldownMs) as { changes: number };
    return info.changes > 0;
  },

  releaseCooldown(ruleId: string, previousTriggeredAt: number | null = null): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE rules SET last_triggered_at = ?, updated_at = ? WHERE id = ?');
    stmt.run(previousTriggeredAt ?? null, Date.now(), ruleId);
  },

  commitTrigger(input: TriggerCommitInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const status = input.oneShot ? 'TRIGGERED' : 'ACTIVE';
      const updated = db.prepare(`
        UPDATE rules
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE' AND last_triggered_at = ?
      `).run(status, input.triggeredAt, input.ruleId, input.triggeredAt) as { changes: number };
      if (updated.changes === 0) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.prepare(`
        INSERT INTO alert_events (id, rule_id, user_id, title, summary, audio_tone, snapshot_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.alert.id,
        input.alert.rule_id,
        input.alert.user_id,
        input.alert.title,
        input.alert.summary,
        input.alert.audio_tone,
        input.alert.snapshot_data ?? null,
        input.alert.created_at,
      );

      if (input.interrupt) {
        db.prepare(`
          INSERT INTO interrupt_actions (
            id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.interrupt.id,
          input.interrupt.alert_id ?? null,
          input.interrupt.rule_id ?? null,
          input.interrupt.conversation_id ?? null,
          input.interrupt.user_id,
          input.interrupt.action_type,
          input.interrupt.action_payload,
          input.interrupt.status,
          input.interrupt.expires_at ?? null,
          input.interrupt.created_at,
          input.interrupt.resolved_at ?? null,
        );
      }

      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  delete(id: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM rules WHERE id = ?');
    stmt.run(id);
  },
};

export const sqliteSubSentinelRepository = {
  create(sentinel: SubSentinel): void {
    const db = getDatabase();
    const schedule = getInitialDueSchedule(sentinel);
    const stmt = db.prepare(`
      INSERT INTO sub_sentinels (
        id, rule_id, sentinel_type, target_source, operator, threshold, ttl_seconds,
        last_evaluated_at, schedule_shard, next_evaluation_at, last_triggered_at, is_satisfied, satisfied_at,
        state_payload, health_status, error_count, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sentinel.id,
      sentinel.rule_id,
      sentinel.sentinel_type ?? (sentinel as any).sentry_type,
      sentinel.target_source,
      sentinel.operator,
      sentinel.threshold,
      sentinel.ttl_seconds,
      sentinel.last_evaluated_at ?? null,
      schedule.schedule_shard ?? null,
      schedule.next_evaluation_at ?? null,
      sentinel.last_triggered_at ?? null,
      sentinel.is_satisfied,
      sentinel.satisfied_at ?? null,
      sentinel.state_payload ?? null,
      sentinel.health_status,
      sentinel.error_count,
      sentinel.last_error ?? null
    );
  },

  getByRuleId(ruleId: string): SubSentinel[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM sub_sentinels WHERE rule_id = ?');
    return stmt.all(ruleId) as unknown as SubSentinel[];
  },

  getDue(now = Date.now(), limit = 100): SubSentinel[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT s.* FROM sub_sentinels s
      JOIN rules r ON r.id = s.rule_id
      WHERE r.status = 'ACTIVE'
        AND (r.expires_at IS NULL OR r.expires_at > ?)
        AND (s.next_evaluation_at IS NULL OR s.next_evaluation_at <= ?)
      ORDER BY (s.next_evaluation_at IS NOT NULL), s.next_evaluation_at ASC
      LIMIT ?
    `);
    return stmt.all(now, now, limit) as unknown as SubSentinel[];
  },

  claim(id: string, now = Date.now()): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE sub_sentinels
      SET last_evaluated_at = ?, next_evaluation_at = ?
      WHERE id = ?
        AND (next_evaluation_at IS NULL OR next_evaluation_at <= ?)
    `);
    const info = stmt.run(now, now + 60_000, id, now) as { changes: number };
    return info.changes > 0;
  },

  updateSatisfaction(
    id: string,
    isSatisfied: boolean,
    statePayload?: string,
    error?: string | null,
    healthStatus: 'HEALTHY' | 'DEGRADED' | 'ERROR' = 'ERROR',
    nextEvaluationAt?: number,
  ): void {
    const db = getDatabase();
    const now = Date.now();
    const satisfiedInt = isSatisfied ? 1 : 0;

    if (error) {
      const stmt = db.prepare(`
        UPDATE sub_sentinels
        SET last_evaluated_at = ?,
            next_evaluation_at = ?,
            error_count = error_count + 1,
            health_status = ?,
            last_error = ?,
            is_satisfied = 0
        WHERE id = ?
      `);
      stmt.run(now, nextEvaluationAt ?? now, healthStatus, error, id);
    } else {
      const stmt = db.prepare(`
        UPDATE sub_sentinels
        SET last_evaluated_at = ?,
            next_evaluation_at = ?,
            last_triggered_at = CASE WHEN ? = 1 THEN ? ELSE last_triggered_at END,
            satisfied_at = CASE WHEN ? = 1 AND is_satisfied = 0 THEN ? ELSE satisfied_at END,
            is_satisfied = ?,
            state_payload = coalesce(?, state_payload),
            health_status = 'HEALTHY',
            error_count = 0,
            last_error = NULL
        WHERE id = ?
      `);
      stmt.run(now, nextEvaluationAt ?? now, satisfiedInt, now, satisfiedInt, now, satisfiedInt, statePayload ?? null, id);
    }
  },
};

export const sqliteSeenEventRepository = {
  isEventSeen(subSentinelId: string, eventHash: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('SELECT 1 FROM seen_events WHERE sub_sentinel_id = ? AND event_hash = ?');
    return Boolean(stmt.get(subSentinelId, eventHash));
  },

  recordSeenEvent(id: string, subSentinelId: string, source: string, eventHash: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO seen_events (id, sub_sentinel_id, source, event_hash, seen_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, subSentinelId, source, eventHash, Date.now());
  },
};

export const sqliteTelemetryRepository = {
  log(point: TelemetryPoint): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO telemetry_points (id, rule_id, sub_sentinel_id, metric_name, value, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      point.id,
      point.rule_id,
      point.sub_sentinel_id ?? (point as any).sentry_id ?? null,
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

export const sqliteAlertEventRepository = {
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

  getByUserId(userId: string, limit = 50, ruleId?: string): EnrichedAlertEvent[] {
    const db = getDatabase();
    if (ruleId) {
      const stmt = db.prepare(`
        SELECT a.*, r.conversation_id, r.title AS rule_title
        FROM alert_events a
        LEFT JOIN rules r ON r.id = a.rule_id
        WHERE a.user_id = ? AND a.rule_id = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, ruleId, limit) as unknown as EnrichedAlertEvent[];
    } else {
      const stmt = db.prepare(`
        SELECT a.*, r.conversation_id, r.title AS rule_title
        FROM alert_events a
        LEFT JOIN rules r ON r.id = a.rule_id
        WHERE a.user_id = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, limit) as unknown as EnrichedAlertEvent[];
    }
  },

  getById(id: string): EnrichedAlertEvent | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT a.*, r.conversation_id, r.title AS rule_title
      FROM alert_events a
      LEFT JOIN rules r ON r.id = a.rule_id
      WHERE a.id = ?
    `);
    return (stmt.get(id) as unknown as EnrichedAlertEvent) || null;
  },
};

export const sqliteInterruptActionRepository = {
  create(action: InterruptAction): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO interrupt_actions (
        id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      action.id,
      action.alert_id ?? null,
      action.rule_id ?? null,
      action.conversation_id ?? null,
      action.user_id,
      action.action_type,
      action.action_payload,
      action.status,
      action.expires_at ?? null,
      action.created_at,
      action.resolved_at ?? null
    );
  },

  getPendingByUserId(userId: string): EnrichedInterruptAction[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT
        i.id, i.alert_id, i.rule_id, i.user_id, i.action_type, i.action_payload,
        i.status, i.expires_at, i.created_at, i.resolved_at,
        COALESCE(i.conversation_id, r.conversation_id) AS conversation_id,
        r.title AS rule_title
      FROM interrupt_actions i
      LEFT JOIN rules r ON r.id = i.rule_id
      WHERE i.user_id = ? AND i.status = 'PENDING'
        AND (i.expires_at IS NULL OR i.expires_at > ?)
      ORDER BY i.created_at ASC
    `);
    return stmt.all(userId, Date.now()) as unknown as EnrichedInterruptAction[];
  },

  getLatestByConversationId(
    conversationId: string,
    actionType: string,
    status: InterruptAction['status'],
  ): EnrichedInterruptAction | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT
        i.id, i.alert_id, i.rule_id, i.user_id, i.action_type, i.action_payload,
        i.status, i.expires_at, i.created_at, i.resolved_at,
        COALESCE(i.conversation_id, r.conversation_id) AS conversation_id,
        r.title AS rule_title
      FROM interrupt_actions i
      LEFT JOIN rules r ON r.id = i.rule_id
      WHERE i.conversation_id = ? AND i.action_type = ? AND i.status = ?
      ORDER BY COALESCE(i.resolved_at, i.created_at) DESC
      LIMIT 1
    `);
    return (stmt.get(conversationId, actionType, status) as unknown as EnrichedInterruptAction) || null;
  },

  getPending(): InterruptAction[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM interrupt_actions
      WHERE status = 'PENDING' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC
    `);
    return stmt.all(Date.now()) as unknown as InterruptAction[];
  },

  expirePending(now = Date.now()): InterruptAction[] {
    const db = getDatabase();
    const expired = db.prepare(`
      SELECT * FROM interrupt_actions
      WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY created_at ASC
    `).all(now) as unknown as InterruptAction[];
    if (expired.length > 0) {
      db.prepare(`
        UPDATE interrupt_actions
        SET status = 'EXPIRED', resolved_at = ?
        WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(now, now);
    }
    return expired;
  },

  getById(id: string): EnrichedInterruptAction | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT
        i.id, i.alert_id, i.rule_id, i.user_id, i.action_type, i.action_payload,
        i.status, i.expires_at, i.created_at, i.resolved_at,
        COALESCE(i.conversation_id, r.conversation_id) AS conversation_id,
        r.title AS rule_title
      FROM interrupt_actions i
      LEFT JOIN rules r ON r.id = i.rule_id
      WHERE i.id = ?
    `);
    return (stmt.get(id) as unknown as EnrichedInterruptAction) || null;
  },

  updateActionPayload(id: string, actionPayload: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE interrupt_actions
      SET action_payload = ?
      WHERE id = ? AND status = 'PENDING'
        AND (expires_at IS NULL OR expires_at > ?)
    `);
    const info = stmt.run(actionPayload, id, Date.now()) as { changes: number };
    return info.changes > 0;
  },

  updateStatus(id: string, status: InterruptAction['status']): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE interrupt_actions SET status = ?, resolved_at = ? WHERE id = ?');
    stmt.run(status, Date.now(), id);
  },

  resolveIfPending(id: string, status: InterruptAction['status'], now = Date.now()): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE interrupt_actions
      SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'PENDING'
        AND (expires_at IS NULL OR expires_at > ?)
    `);
    const info = stmt.run(status, now, id, now) as { changes: number };
    return info.changes > 0;
  },

  createClarification(input: {
    action: InterruptAction;
    conversationId: string;
    userId: string;
    expectedPhase: AgentConversation['phase'];
    now: number;
  }): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const conversation = db.prepare(
        'SELECT user_id, phase FROM agent_conversations WHERE id = ?',
      ).get(input.conversationId) as { user_id: string; phase: AgentConversation['phase'] } | undefined;
      if (
        !conversation ||
        conversation.user_id !== input.userId ||
        conversation.phase !== input.expectedPhase ||
        !isChoiceInterruptActionType(input.action.action_type) ||
        input.action.user_id !== input.userId ||
        input.action.conversation_id !== input.conversationId ||
        input.action.status !== 'PENDING'
      ) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.prepare(`
        INSERT INTO interrupt_actions (
          id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL)
      `).run(
        input.action.id,
        input.action.alert_id ?? null,
        input.action.rule_id ?? null,
        input.conversationId,
        input.userId,
        input.action.action_type,
        input.action.action_payload,
        input.action.expires_at ?? null,
        input.now,
      );

      const updated = db.prepare(`
        UPDATE agent_conversations
        SET phase = 'CLARIFICATION_PENDING'
        WHERE id = ? AND user_id = ? AND phase = ?
      `).run(input.conversationId, input.userId, input.expectedPhase) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  restorePendingClarification(input: {
    interruptId: string;
    conversationId: string;
    userId: string;
    now: number;
  }): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const action = db.prepare(`
        SELECT status, user_id, conversation_id, expires_at, action_type
        FROM interrupt_actions
        WHERE id = ?
      `).get(input.interruptId) as {
        status?: InterruptAction['status'];
        user_id?: string;
        conversation_id?: string | null;
        expires_at?: number | null;
        action_type?: string;
      } | undefined;
      const conversation = db.prepare(`
        SELECT user_id, phase
        FROM agent_conversations
        WHERE id = ?
      `).get(input.conversationId) as {
        user_id?: string;
        phase?: AgentConversation['phase'];
      } | undefined;

      if (
        !action || action.status !== 'PENDING' ||
        action.user_id !== input.userId || action.conversation_id !== input.conversationId ||
        !isChoiceInterruptActionType(action.action_type || '') ||
        (action.expires_at !== null && action.expires_at !== undefined && action.expires_at <= input.now) ||
        !conversation || conversation.user_id !== input.userId
      ) {
        db.exec('ROLLBACK;');
        return false;
      }

      if (conversation.phase === 'CLARIFICATION_PENDING') {
        db.exec('COMMIT;');
        return true;
      }

      const repairable = new Set<AgentConversation['phase']>([
        'DISCOVERY',
        'AWAITING_QUERY_CONFIRMATION',
        'SCOUTING',
        'AWAITING_TRIGGER_MODE',
        'INTERRUPT_PENDING',
      ]);
      if (!conversation.phase || !repairable.has(conversation.phase)) {
        db.exec('ROLLBACK;');
        return false;
      }

      const updated = db.prepare(`
        UPDATE agent_conversations
        SET phase = 'CLARIFICATION_PENDING'
        WHERE id = ? AND user_id = ? AND phase = ?
      `).run(input.conversationId, input.userId, conversation.phase) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  resolveClarification(input: {
    interruptId: string;
    conversationId: string;
    userId: string;
    resolution: 'APPROVED' | 'REJECTED';
    resumePhase: AgentConversation['phase'];
    now: number;
  }): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const updated = db.prepare(`
        UPDATE interrupt_actions
        SET status = ?, resolved_at = ?
        WHERE id = ? AND conversation_id = ? AND user_id = ? AND status = 'PENDING'
          AND (expires_at IS NULL OR expires_at > ?)
      `).run(
        input.resolution,
        input.now,
        input.interruptId,
        input.conversationId,
        input.userId,
        input.now,
      ) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      const conversationUpdated = db.prepare(`
        UPDATE agent_conversations
        SET phase = ?
        WHERE id = ? AND user_id = ? AND phase = 'CLARIFICATION_PENDING'
      `).run(input.resumePhase, input.conversationId, input.userId) as { changes: number };
      if (conversationUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },
};

export const sqliteDeploymentRepository = {
  stage(input: DeploymentProposalInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const conversation = db.prepare('SELECT user_id FROM agent_conversations WHERE id = ?').get(input.conversationId) as
        | { user_id: string }
        | undefined;
      if (
        !conversation ||
        input.rule.conversation_id !== input.conversationId ||
        input.interrupt.rule_id !== input.rule.id ||
        conversation.user_id !== input.rule.user_id ||
        input.interrupt.user_id !== input.rule.user_id ||
        input.interrupt.status !== 'PENDING'
      ) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.prepare(`
        INSERT INTO rules (
          id, user_id, conversation_id, title, natural_language_intent, category, combinator, condition_tree,
          trigger_mode, cooldown_minutes, audio_tone, status, expires_at, last_triggered_at, action_template, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.rule.id,
        input.rule.user_id,
        input.rule.conversation_id ?? null,
        input.rule.title,
        input.rule.natural_language_intent,
        input.rule.category ?? 'FINANCIAL',
        input.rule.combinator ?? 'SINGLE',
        input.rule.condition_tree ?? null,
        input.rule.trigger_mode ?? 'PERSISTENT',
        input.rule.cooldown_minutes ?? 60,
        input.rule.audio_tone ?? 'chime',
        'PAUSED',
        input.rule.expires_at ?? null,
        input.rule.last_triggered_at ?? null,
        input.rule.action_template ?? null,
        input.rule.created_at ?? input.now,
        input.rule.updated_at ?? input.now,
      );

      db.prepare(`
        INSERT INTO interrupt_actions (
          id, alert_id, rule_id, conversation_id, user_id, action_type, action_payload, status, expires_at, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
      `).run(
        input.interrupt.id,
        input.interrupt.alert_id ?? null,
        input.interrupt.rule_id ?? null,
        input.interrupt.conversation_id ?? input.conversationId,
        input.interrupt.user_id,
        input.interrupt.action_type,
        input.interrupt.action_payload,
        input.interrupt.expires_at ?? null,
        input.interrupt.created_at ?? input.now,
        null,
      );

      const updated = db.prepare(`
        UPDATE agent_conversations
        SET phase = 'INTERRUPT_PENDING'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.rule.user_id) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  stageMonitoringMode(input: MonitoringModeProposalInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const conversation = db.prepare('SELECT user_id, phase FROM agent_conversations WHERE id = ?').get(input.conversationId) as
        | { user_id: string; phase: AgentConversation['phase'] }
        | undefined;
      if (
        !conversation ||
        input.rule.conversation_id !== input.conversationId ||
        input.rule.status !== 'PAUSED' ||
        conversation.user_id !== input.rule.user_id ||
        (conversation.phase !== 'SCOUTING' && conversation.phase !== 'AWAITING_TRIGGER_MODE') ||
        db.prepare('SELECT 1 FROM rules WHERE id = ?').get(input.rule.id)
      ) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.prepare(`
        INSERT INTO rules (
          id, user_id, conversation_id, title, natural_language_intent, category, combinator, condition_tree,
          trigger_mode, cooldown_minutes, audio_tone, status, expires_at, last_triggered_at, action_template, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAUSED', ?, ?, ?, ?, ?)
      `).run(
        input.rule.id,
        input.rule.user_id,
        input.rule.conversation_id ?? null,
        input.rule.title,
        input.rule.natural_language_intent,
        input.rule.category ?? 'FINANCIAL',
        input.rule.combinator ?? 'SINGLE',
        input.rule.condition_tree ?? null,
        input.rule.trigger_mode ?? 'PERSISTENT',
        input.rule.cooldown_minutes ?? 60,
        input.rule.audio_tone ?? 'chime',
        input.rule.expires_at ?? null,
        input.rule.last_triggered_at ?? null,
        input.rule.action_template ?? null,
        input.rule.created_at ?? input.now,
        input.now,
      );

      const upsertSub = db.prepare(`
        INSERT INTO sub_sentinels (
          id, rule_id, sentinel_type, target_source, operator, threshold, ttl_seconds,
          last_evaluated_at, last_triggered_at, is_satisfied, satisfied_at, state_payload,
          health_status, error_count, last_error, schedule_shard, next_evaluation_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rule_id = excluded.rule_id, sentinel_type = excluded.sentinel_type,
          target_source = excluded.target_source, operator = excluded.operator,
          threshold = excluded.threshold, ttl_seconds = excluded.ttl_seconds,
          schedule_shard = excluded.schedule_shard,
          next_evaluation_at = excluded.next_evaluation_at
      `);
      for (const sub of input.subSentinels) {
        const dueSchedule = getInitialDueSchedule(sub, input.now);
        upsertSub.run(
          sub.id, sub.rule_id, sub.sentinel_type, sub.target_source, sub.operator, sub.threshold,
          sub.ttl_seconds, sub.last_evaluated_at ?? null, sub.last_triggered_at ?? null,
          sub.is_satisfied ?? 0, sub.satisfied_at ?? null, sub.state_payload ?? null,
          sub.health_status ?? 'HEALTHY', sub.error_count ?? 0, sub.last_error ?? null,
          dueSchedule.schedule_shard ?? null, dueSchedule.next_evaluation_at ?? null,
        );
      }

      const insertSeen = db.prepare(`
        INSERT OR IGNORE INTO seen_events (id, sub_sentinel_id, source, event_hash, seen_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const event of input.baselineEvents) {
        insertSeen.run(event.id, event.sub_sentinel_id, event.source, event.event_hash, input.now);
      }

      const updated = db.prepare(`
        UPDATE agent_conversations
        SET phase = 'AWAITING_TRIGGER_MODE'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.rule.user_id) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  approve(input: DeploymentCommitInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const action = db.prepare('SELECT status, expires_at FROM interrupt_actions WHERE id = ?').get(input.interruptId) as
        | { status: InterruptAction['status']; expires_at?: number | null }
        | undefined;
      if (!action || action.status !== 'PENDING') {
        db.exec('ROLLBACK;');
        return false;
      }
      if (action.status === 'PENDING' && action.expires_at !== null && action.expires_at !== undefined && action.expires_at <= input.now) {
        db.prepare("UPDATE interrupt_actions SET status = 'EXPIRED', resolved_at = ? WHERE id = ? AND status = 'PENDING'").run(input.now, input.interruptId);
        db.exec('COMMIT;');
        return false;
      }

      const ruleUpdated = db.prepare(`
        UPDATE rules SET status = 'ACTIVE', updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'PAUSED'
      `).run(input.now, input.rule.id, input.rule.user_id) as { changes: number };
      if (ruleUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      const upsertSub = db.prepare(`
        INSERT INTO sub_sentinels (
          id, rule_id, sentinel_type, target_source, operator, threshold, ttl_seconds,
          last_evaluated_at, last_triggered_at, is_satisfied, satisfied_at, state_payload,
          health_status, error_count, last_error, schedule_shard, next_evaluation_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rule_id = excluded.rule_id, sentinel_type = excluded.sentinel_type,
          target_source = excluded.target_source, operator = excluded.operator,
          threshold = excluded.threshold, ttl_seconds = excluded.ttl_seconds,
          schedule_shard = excluded.schedule_shard,
          next_evaluation_at = excluded.next_evaluation_at
      `);
      for (const sub of input.subSentinels) {
        const dueSchedule = getInitialDueSchedule(sub, input.now);
        upsertSub.run(
          sub.id, sub.rule_id, sub.sentinel_type, sub.target_source, sub.operator, sub.threshold,
          sub.ttl_seconds, sub.last_evaluated_at ?? null, sub.last_triggered_at ?? null,
          sub.is_satisfied ?? 0, sub.satisfied_at ?? null, sub.state_payload ?? null,
          sub.health_status ?? 'HEALTHY', sub.error_count ?? 0, sub.last_error ?? null,
          dueSchedule.schedule_shard ?? null, dueSchedule.next_evaluation_at ?? null
        );
      }

      const insertSeen = db.prepare(`
        INSERT OR IGNORE INTO seen_events (id, sub_sentinel_id, source, event_hash, seen_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const event of input.baselineEvents) {
        insertSeen.run(event.id, event.sub_sentinel_id, event.source, event.event_hash, input.now);
      }

      const conversationUpdated = db.prepare(`
        UPDATE agent_conversations
        SET status = 'SYNTHESIZED', phase = 'DEPLOYED'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.rule.user_id) as { changes: number };
      if (conversationUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      const resolved = db.prepare(`
        UPDATE interrupt_actions SET status = 'APPROVED', resolved_at = ?
        WHERE id = ? AND status = 'PENDING' AND (expires_at IS NULL OR expires_at > ?)
      `).run(input.now, input.interruptId, input.now) as { changes: number };
      if (resolved.changes === 0) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  deployMonitoringMode(input: MonitoringModeDeploymentInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const updated = db.prepare(`
        UPDATE rules
        SET trigger_mode = ?, status = 'ACTIVE', updated_at = ?
        WHERE id = ? AND user_id = ? AND conversation_id = ? AND status = 'PAUSED'
      `).run(
        input.triggerMode,
        input.now,
        input.ruleId,
        input.userId,
        input.conversationId,
      ) as { changes: number };
      if (updated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      const conversationUpdated = db.prepare(`
        UPDATE agent_conversations
        SET status = 'SYNTHESIZED', phase = 'DEPLOYED'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.userId) as { changes: number };
      if (conversationUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  /** Atomically applies a confirmed edit to an active deployed task. */
  applyTaskEdit(input: TaskEditCommitInput): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const action = db.prepare(`
        SELECT status, expires_at, user_id, conversation_id, rule_id
        FROM interrupt_actions WHERE id = ?
      `).get(input.interruptId) as {
        status: InterruptAction['status'];
        expires_at?: number | null;
        user_id?: string;
        conversation_id?: string | null;
        rule_id?: string | null;
      } | undefined;
      if (
        !action || action.status !== 'PENDING' || action.user_id !== input.userId ||
        action.conversation_id !== input.conversationId || action.rule_id !== input.rule.id
      ) {
        db.exec('ROLLBACK;');
        return false;
      }
      if (action.expires_at !== null && action.expires_at !== undefined && action.expires_at <= input.now) {
        db.prepare("UPDATE interrupt_actions SET status = 'EXPIRED', resolved_at = ? WHERE id = ? AND status = 'PENDING'").run(input.now, input.interruptId);
        db.exec('COMMIT;');
        return false;
      }

      const currentRule = db.prepare(`
        SELECT updated_at, user_id, conversation_id, status
        FROM rules WHERE id = ?
      `).get(input.rule.id) as {
        updated_at?: number;
        user_id?: string;
        conversation_id?: string | null;
        status?: Rule['status'];
      } | undefined;
      if (
        !currentRule || currentRule.updated_at !== input.expectedRuleUpdatedAt ||
        currentRule.user_id !== input.userId || currentRule.conversation_id !== input.conversationId ||
        (currentRule.status !== 'ACTIVE' && currentRule.status !== 'TRIGGERED')
      ) {
        db.exec('ROLLBACK;');
        return false;
      }

      const conversation = db.prepare(`
        SELECT user_id, phase FROM agent_conversations WHERE id = ?
      `).get(input.conversationId) as { user_id?: string; phase?: string } | undefined;
      if (!conversation || conversation.user_id !== input.userId ||
          (conversation.phase !== 'DEPLOYED' && conversation.phase !== 'CLARIFICATION_PENDING')) {
        db.exec('ROLLBACK;');
        return false;
      }

      const ruleUpdated = db.prepare(`
        UPDATE rules SET
          title = ?, natural_language_intent = ?, category = ?, combinator = ?, condition_tree = ?,
          trigger_mode = ?, cooldown_minutes = ?, audio_tone = ?, status = ?, expires_at = ?,
          last_triggered_at = ?, action_template = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND conversation_id = ? AND updated_at = ?
      `).run(
        input.rule.title,
        input.rule.natural_language_intent,
        input.rule.category,
        input.rule.combinator,
        input.rule.condition_tree ?? null,
        input.rule.trigger_mode,
        input.rule.cooldown_minutes,
        input.rule.audio_tone,
        input.rule.status,
        input.rule.expires_at ?? null,
        input.rule.last_triggered_at ?? null,
        input.rule.action_template ?? null,
        input.rule.updated_at,
        input.rule.id,
        input.userId,
        input.conversationId,
        input.expectedRuleUpdatedAt,
      ) as { changes: number };
      if (ruleUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      for (const subSentinelId of input.deletedSubSentinelIds) {
        const deleted = db.prepare('DELETE FROM sub_sentinels WHERE id = ? AND rule_id = ?').run(subSentinelId, input.rule.id) as { changes: number };
        if (deleted.changes !== 1) {
          db.exec('ROLLBACK;');
          return false;
        }
      }

      const upsertSub = db.prepare(`
        INSERT INTO sub_sentinels (
          id, rule_id, sentinel_type, target_source, operator, threshold, ttl_seconds,
          last_evaluated_at, last_triggered_at, is_satisfied, satisfied_at, state_payload,
          health_status, error_count, last_error, schedule_shard, next_evaluation_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rule_id = excluded.rule_id, sentinel_type = excluded.sentinel_type,
          target_source = excluded.target_source, operator = excluded.operator,
          threshold = excluded.threshold, ttl_seconds = excluded.ttl_seconds,
          last_evaluated_at = excluded.last_evaluated_at, last_triggered_at = excluded.last_triggered_at,
          is_satisfied = excluded.is_satisfied, satisfied_at = excluded.satisfied_at,
          state_payload = excluded.state_payload, health_status = excluded.health_status,
          error_count = excluded.error_count, last_error = excluded.last_error,
          schedule_shard = excluded.schedule_shard, next_evaluation_at = excluded.next_evaluation_at
      `);
      for (const sub of input.subSentinels) {
        const dueSchedule = getInitialDueSchedule(sub, input.now);
        upsertSub.run(
          sub.id, sub.rule_id, sub.sentinel_type, sub.target_source, sub.operator, sub.threshold,
          sub.ttl_seconds, sub.last_evaluated_at ?? null, sub.last_triggered_at ?? null,
          sub.is_satisfied ?? 0, sub.satisfied_at ?? null, sub.state_payload ?? null,
          sub.health_status ?? 'HEALTHY', sub.error_count ?? 0, sub.last_error ?? null,
          dueSchedule.schedule_shard ?? null, dueSchedule.next_evaluation_at ?? null,
        );
      }

      const conversationUpdated = db.prepare(`
        UPDATE agent_conversations SET status = 'SYNTHESIZED', phase = 'DEPLOYED'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.userId) as { changes: number };
      if (conversationUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      const resolved = db.prepare(`
        UPDATE interrupt_actions SET status = 'APPROVED', resolved_at = ?
        WHERE id = ? AND status = 'PENDING' AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)
      `).run(input.now, input.interruptId, input.userId, input.now) as { changes: number };
      if (resolved.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }

      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  reject(input: Pick<DeploymentCommitInput, 'interruptId' | 'conversationId' | 'rule' | 'now'>): boolean {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const action = db.prepare('SELECT status, expires_at FROM interrupt_actions WHERE id = ?').get(input.interruptId) as
        | { status: InterruptAction['status']; expires_at?: number | null }
        | undefined;
      if (!action || action.status !== 'PENDING') {
        db.exec('ROLLBACK;');
        return false;
      }
      if (action.status === 'PENDING' && action.expires_at !== null && action.expires_at !== undefined && action.expires_at <= input.now) {
        db.prepare("UPDATE interrupt_actions SET status = 'EXPIRED', resolved_at = ? WHERE id = ? AND status = 'PENDING'").run(input.now, input.interruptId);
        db.exec('COMMIT;');
        return false;
      }

      const ruleUpdated = db.prepare(`
        UPDATE rules SET status = 'DISMISSED', updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'PAUSED'
      `).run(input.now, input.rule.id, input.rule.user_id) as { changes: number };
      if (ruleUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      const conversationUpdated = db.prepare(`
        UPDATE agent_conversations SET phase = 'DISCOVERY'
        WHERE id = ? AND user_id = ?
      `).run(input.conversationId, input.rule.user_id) as { changes: number };
      if (conversationUpdated.changes !== 1) {
        db.exec('ROLLBACK;');
        return false;
      }
      const resolved = db.prepare(`
        UPDATE interrupt_actions SET status = 'REJECTED', resolved_at = ?
        WHERE id = ? AND status = 'PENDING' AND (expires_at IS NULL OR expires_at > ?)
      `).run(input.now, input.interruptId, input.now) as { changes: number };
      if (resolved.changes === 0) {
        db.exec('ROLLBACK;');
        return false;
      }
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },
};

export const sqliteExecutionRepository = {
  claim(record: Omit<ExecutionLeaseRecord, 'status' | 'attempts' | 'created_at' | 'updated_at'> & { now: number }): { claimed: boolean; attempts: number } {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = db.prepare('SELECT * FROM execution_leases WHERE id = ?').get(record.id) as ExecutionLeaseRecord | undefined;
      if (existing?.status === 'SUCCEEDED') {
        db.exec('COMMIT;');
        return { claimed: false, attempts: existing.attempts };
      }
      if (existing && existing.lease_expires_at > record.now && existing.lease_owner !== record.lease_owner) {
        db.exec('COMMIT;');
        return { claimed: false, attempts: existing.attempts };
      }
      const attempts = (existing?.attempts || 0) + 1;
      const stmt = db.prepare(`
        INSERT INTO execution_leases
          (id, event_type, rule_id, status, lease_owner, lease_expires_at, attempts, created_at, updated_at)
        VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = 'RUNNING', lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at, attempts = excluded.attempts,
          updated_at = excluded.updated_at, last_error = NULL
      `);
      stmt.run(record.id, record.event_type, record.rule_id ?? null, record.lease_owner,
        record.lease_expires_at, attempts, existing?.created_at || record.now, record.now);
      db.exec('COMMIT;');
      return { claimed: true, attempts };
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  },

  complete(id: string, owner: string, payload: string, now = Date.now()): void {
    getDatabase().prepare(`
      UPDATE execution_leases
      SET status = 'SUCCEEDED', result_payload = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
      WHERE id = ? AND lease_owner = ?
    `).run(payload, now, now, id, owner);
  },

  fail(id: string, owner: string, error: string, retryable: boolean, now = Date.now()): void {
    getDatabase().prepare(`
      UPDATE execution_leases
      SET status = ?, last_error = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ?
    `).run(retryable ? 'RUNNING' : 'FAILED', error, retryable ? now : 0, now, id, owner);
  },
};

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export const sqliteAdapter: DatabaseAdapter = {
  userRepository: sqliteUserRepository,
  userDeviceRepository: sqliteUserDeviceRepository,
  conversationRepository: sqliteConversationRepository,
  chatMessageRepository: sqliteChatMessageRepository,
  ruleRepository: sqliteRuleRepository,
  subSentinelRepository: sqliteSubSentinelRepository,
  seenEventRepository: sqliteSeenEventRepository,
  telemetryRepository: sqliteTelemetryRepository,
  alertEventRepository: sqliteAlertEventRepository,
  interruptActionRepository: sqliteInterruptActionRepository,
  deploymentRepository: sqliteDeploymentRepository,
  executionRepository: sqliteExecutionRepository,
  healthCheck: () => {
    getDatabase();
  },
  close: closeDatabase,
};
