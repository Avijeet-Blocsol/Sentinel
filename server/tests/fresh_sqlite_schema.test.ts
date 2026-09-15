import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  getDatabase,
  sqliteExecutionRepository,
} from '../src/db/sqlite/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-fresh-schema-'));
const databasePath = path.join(directory, 'sentinel.db');

try {
  const db = getDatabase(databasePath);
  const columns = (table: string) => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  assert.equal(columns('agent_conversations').has('phase'), true);
  assert.equal(columns('rules').has('condition_tree'), true);
  assert.equal(columns('rules').has('last_triggered_at'), true);
  assert.equal(columns('sub_sentinels').has('next_evaluation_at'), true);
  assert.equal(columns('execution_leases').has('lease_owner'), true);

  const lease = sqliteExecutionRepository.claim({
    id: 'fresh-schema-execution',
    event_type: 'TICK',
    rule_id: null,
    lease_owner: 'schema-test',
    lease_expires_at: Date.now() + 60_000,
    now: Date.now(),
  });
  assert.equal(lease.claimed, true);
  console.log('PASS fresh SQLite schema declares lifecycle, condition, due-schedule, and execution-lease fields');
} finally {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
}
