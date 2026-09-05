/**
 * ==========================================================
 * STRANDS SENTINEL - SCHEMA ARTIFACT GENERATOR
 * ==========================================================
 * Automatically generates:
 * 1. server/src/db/schema.sql (SQLite DDL Schema)
 * 2. shared/json/*.schema.json (Standard Draft 2020-12 JSON Schemas)
 * 3. server/src/schemas/json/*.schema.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SCHEMAS, getJsonSchema } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '../../');
const SHARED_JSON_DIR = path.resolve(ROOT_DIR, 'shared/json');
const SERVER_SQL_PATH = path.resolve(ROOT_DIR, 'server/src/db/schema.sql');
const SERVER_JSON_DIR = path.resolve(ROOT_DIR, 'server/src/schemas/json');

// Ensure directories exist
for (const dir of [SHARED_JSON_DIR, SERVER_JSON_DIR, path.dirname(SERVER_SQL_PATH)]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

console.log('⚡ Starting Sentinel Schema Artifact Generation...\n');

// 1. Generate SQLite DDL (schema.sql)
const SQL_DDL = `-- ==========================================================
-- Strands Sentinel Database Schema (Auto-generated from @sentinel/shared)
-- Run 'npm run generate:schemas' to update
-- ==========================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Identity & Profile
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE,
    apple_sub TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2. Push Notification Device Registry
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    push_token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    last_active_at INTEGER NOT NULL
);

-- 3. Conversational Agent Sessions
CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED', 'SYNTHESIZED')),
    created_at INTEGER NOT NULL
);

-- 4. Chat Messages inside an Agent Session
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_calls TEXT, -- JSON array of tool calls/results
    created_at INTEGER NOT NULL
);

-- 5. Rules: Top-level user-defined monitoring intent
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES agent_conversations(id) ON DELETE SET NULL,
    natural_language_intent TEXT NOT NULL,
    combinator TEXT NOT NULL CHECK (combinator IN ('AND', 'OR', 'SINGLE')),
    trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('ONE_SHOT', 'PERSISTENT')),
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    audio_tone TEXT NOT NULL CHECK (audio_tone IN ('cash_register', 'siren', 'chime')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'DISMISSED', 'PAUSED', 'ARCHIVED')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 6. Sub-Sentries: Isolated atomic observer conditions
CREATE TABLE IF NOT EXISTS sub_sentries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    sentry_type TEXT NOT NULL CHECK (sentry_type IN (
        'FINANCIAL_TECHNICAL',
        'ECOMMERCE_INVENTORY',
        'WEB_OBSERVER',
        'STREAM_INTELLIGENCE'
    )),
    target_source TEXT NOT NULL,
    operator TEXT NOT NULL CHECK (operator IN (
        'GREATER_THAN',
        'LESS_THAN',
        'CROSSES_ABOVE',
        'CROSSES_BELOW',
        'EQUALS',
        'KEYWORD_MATCH',
        'STATE_FLIP',
        'HASH_DELTA'
    )),
    threshold TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 300,
    last_evaluated_at INTEGER,
    last_triggered_at INTEGER,
    is_satisfied INTEGER NOT NULL DEFAULT 0 CHECK (is_satisfied IN (0, 1)),
    satisfied_at INTEGER,
    state_payload TEXT,
    health_status TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (health_status IN ('HEALTHY', 'DEGRADED', 'ERROR')),
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- 7. Seen Events: Deduplication table for streaming sources
CREATE TABLE IF NOT EXISTS seen_events (
    id TEXT PRIMARY KEY,
    sentry_id TEXT NOT NULL REFERENCES sub_sentries(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    seen_at INTEGER NOT NULL
);

-- 8. Telemetry Points: Time-series numeric metric points for mobile charts
CREATE TABLE IF NOT EXISTS telemetry_points (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    sentry_id TEXT REFERENCES sub_sentries(id) ON DELETE CASCADE,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata TEXT
);

-- 9. Alert Events: Historical record of fired triggers
CREATE TABLE IF NOT EXISTS alert_events (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    audio_tone TEXT NOT NULL CHECK (audio_tone IN ('cash_register', 'siren', 'chime')),
    snapshot_data TEXT,
    created_at INTEGER NOT NULL
);

-- 10. Interrupt Actions: Human-in-the-loop interactive confirmation cards
CREATE TABLE IF NOT EXISTS interrupt_actions (
    id TEXT PRIMARY KEY,
    alert_id TEXT REFERENCES alert_events(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    action_payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON agent_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_rules_user_id ON rules(user_id);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_sub_sentries_rule_id ON sub_sentries(rule_id);
CREATE INDEX IF NOT EXISTS idx_sub_sentries_type ON sub_sentries(sentry_type);
CREATE INDEX IF NOT EXISTS idx_seen_events_sentry_id ON seen_events(sentry_id);
CREATE INDEX IF NOT EXISTS idx_seen_events_hash ON seen_events(event_hash);
CREATE INDEX IF NOT EXISTS idx_telemetry_rule_id ON telemetry_points(rule_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_points(timestamp);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule_id ON alert_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_user_id ON alert_events(user_id);
CREATE INDEX IF NOT EXISTS idx_interrupt_alert_id ON interrupt_actions(alert_id);
CREATE INDEX IF NOT EXISTS idx_interrupt_status ON interrupt_actions(status);
`;

fs.writeFileSync(SERVER_SQL_PATH, SQL_DDL, 'utf8');
console.log(`✓ Generated SQLite DDL: ${path.relative(ROOT_DIR, SERVER_SQL_PATH)}`);

// 2. Generate JSON Schemas (Draft 2020-12)
const fileMap: Record<keyof typeof ALL_SCHEMAS, string> = {
  User: 'user.schema.json',
  UserDevice: 'user_device.schema.json',
  AgentConversation: 'agent_conversation.schema.json',
  ChatMessage: 'chat_message.schema.json',
  Rule: 'rule.schema.json',
  SubSentry: 'sub_sentry.schema.json',
  SeenEvent: 'seen_event.schema.json',
  TelemetryPoint: 'telemetry_point.schema.json',
  AlertEvent: 'alert_event.schema.json',
  InterruptAction: 'interrupt_action.schema.json',
  FinancialThreshold: 'financial_threshold.schema.json',
  EcommerceThreshold: 'ecommerce_threshold.schema.json',
  WebObserverThreshold: 'web_observer_threshold.schema.json',
  StreamIntelligenceThreshold: 'stream_intelligence_threshold.schema.json',
  InterruptActionPayload: 'interrupt_action_payload.schema.json',
};

let jsonCount = 0;
for (const [key, filename] of Object.entries(fileMap)) {
  const jsonSchema = getJsonSchema(key as keyof typeof ALL_SCHEMAS);
  const formatted = JSON.stringify(jsonSchema, null, 2);

  // Write to shared/json
  fs.writeFileSync(path.join(SHARED_JSON_DIR, filename), formatted, 'utf8');
  // Mirror to server/src/schemas/json
  fs.writeFileSync(path.join(SERVER_JSON_DIR, filename), formatted, 'utf8');
  jsonCount++;
}

console.log(`✓ Generated ${jsonCount} standalone JSON schema files in shared/json/ and server/src/schemas/json/\n`);
console.log('🎉 Schema synchronization complete! All SQL and JSON artifacts are up to date.');
