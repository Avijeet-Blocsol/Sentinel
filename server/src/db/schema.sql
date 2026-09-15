-- ==========================================================
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
    github_sub TEXT UNIQUE,
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
    phase TEXT NOT NULL DEFAULT 'DISCOVERY' CHECK (phase IN ('DISCOVERY', 'AWAITING_QUERY_CONFIRMATION', 'SCOUTING', 'INTERRUPT_PENDING', 'DEPLOYED')),
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
    title TEXT NOT NULL,
    natural_language_intent TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'FINANCIAL' CHECK (category IN (
        'FINANCIAL',
        'CRYPTO',
        'PREDICTION_MARKET',
        'WEB_INTEL',
        'SOCIAL_STREAM',
        'ECOMMERCE'
    )),
    combinator TEXT NOT NULL CHECK (combinator IN ('AND', 'OR', 'SINGLE')),
    condition_tree TEXT,
    trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('ONE_SHOT', 'PERSISTENT')),
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    audio_tone TEXT NOT NULL CHECK (audio_tone IN ('cash_register', 'siren', 'chime')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'DISMISSED', 'PAUSED', 'ARCHIVED')),
    expires_at INTEGER,
    last_triggered_at INTEGER,
    action_template TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 6. Sub-Sentinels: Isolated atomic observer conditions
CREATE TABLE IF NOT EXISTS sub_sentinels (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    sentinel_type TEXT NOT NULL CHECK (sentinel_type IN (
        'STOCK',
        'CRYPTO',
        'PREDICTION_MARKET',
        'WEB_OBSERVER',
        'TELEGRAM_CHANNEL',
        'RSS_FEED',
        'FINANCIAL_TECHNICAL',
        'ECOMMERCE_INVENTORY',
        'STREAM_INTELLIGENCE'
    )),
    target_source TEXT NOT NULL,
    operator TEXT NOT NULL CHECK (operator IN (
        'GREATER_THAN',
        'LESS_THAN',
        'CROSSES_ABOVE',
        'CROSSES_BELOW',
        'TOUCHES',
        'CLOSES_ABOVE',
        'CLOSES_BELOW',
        'EQUALS',
        'KEYWORD_MATCH',
        'STATE_FLIP',
        'HASH_DELTA',
        'SEMANTIC_MATCH',
        'PERCENT_CHANGE'
    )),
    threshold TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 300,
    last_evaluated_at INTEGER,
    schedule_shard TEXT,
    next_evaluation_at INTEGER,
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
    sub_sentinel_id TEXT NOT NULL REFERENCES sub_sentinels(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    seen_at INTEGER NOT NULL
);

-- 8. Telemetry Points: Time-series numeric metric points for mobile charts
CREATE TABLE IF NOT EXISTS telemetry_points (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    sub_sentinel_id TEXT REFERENCES sub_sentinels(id) ON DELETE CASCADE,
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

-- 11. Execution Leases: idempotency and distributed worker ownership
CREATE TABLE IF NOT EXISTS execution_leases (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('TICK', 'EVALUATE_RULE')),
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

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_users_github_sub ON users(github_sub);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON agent_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_rules_user_id ON rules(user_id);
CREATE INDEX IF NOT EXISTS idx_rules_category ON rules(category);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_sub_sentinels_rule_id ON sub_sentinels(rule_id);
CREATE INDEX IF NOT EXISTS idx_sub_sentinels_type ON sub_sentinels(sentinel_type);
CREATE INDEX IF NOT EXISTS idx_sub_sentinels_due ON sub_sentinels(next_evaluation_at, schedule_shard);
CREATE INDEX IF NOT EXISTS idx_seen_events_sub_sentinel_id ON seen_events(sub_sentinel_id);
CREATE INDEX IF NOT EXISTS idx_seen_events_hash ON seen_events(event_hash);
CREATE INDEX IF NOT EXISTS idx_telemetry_rule_id ON telemetry_points(rule_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_points(timestamp);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule_id ON alert_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_user_id ON alert_events(user_id);
CREATE INDEX IF NOT EXISTS idx_interrupt_alert_id ON interrupt_actions(alert_id);
CREATE INDEX IF NOT EXISTS idx_interrupt_status ON interrupt_actions(status);
CREATE INDEX IF NOT EXISTS idx_execution_leases_status ON execution_leases(status);
