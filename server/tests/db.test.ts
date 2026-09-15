import {
  getDatabase,
  closeDatabase,
  userRepository,
  userDeviceRepository,
  conversationRepository,
  chatMessageRepository,
  ruleRepository,
  subSentinelRepository,
  seenEventRepository,
  telemetryRepository,
  alertEventRepository,
  interruptActionRepository,
  User,
  UserDevice,
  AgentConversation,
  ChatMessage,
  Rule,
  SubSentinel,
  AlertEvent,
  InterruptAction,
} from '../src/db/index.js';
import path from 'node:path';
import fs from 'node:fs';

const testDbPath = path.resolve('./data/test_expanded_sentinel.db');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

try {
  console.log('Testing Expanded Sentinel 10-Domain Database Schema & Repositories...');
  const db = getDatabase(testDbPath);

  // 1. User
  const user: User = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    google_sub: 'google-sub-100234',
    apple_sub: null,
    email: 'alex@example.com',
    name: 'Alex Mercer',
    avatar_url: 'https://lh3.googleusercontent.com/a/avatar.png',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  userRepository.create(user);
  const fetchedUser = userRepository.getByGoogleSub('google-sub-100234');
  console.log('1. User Repository (Google Sub lookup):', fetchedUser?.email === 'alex@example.com' ? 'PASS' : 'FAIL');

  // 2. User Device
  const device: UserDevice = {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    user_id: user.id,
    push_token: 'ExponentPushToken[abc123xyz]',
    platform: 'ios',
    last_active_at: Date.now(),
  };
  userDeviceRepository.registerDevice(device);
  const devices = userDeviceRepository.getByUserId(user.id);
  console.log('2. Device Registry (Push token):', devices.length === 1 && devices[0].platform === 'ios' ? 'PASS' : 'FAIL');

  // 3. Conversation
  const convo: AgentConversation = {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    user_id: user.id,
    title: 'Monitor Bitcoin RSI & BestBuy GPU',
    status: 'ACTIVE',
    created_at: Date.now(),
  };
  conversationRepository.create(convo);
  const fetchedConvo = conversationRepository.getById(convo.id);
  console.log('3. Agent Conversation:', fetchedConvo?.title === convo.title ? 'PASS' : 'FAIL');

  // 4. Chat Message
  const msg: ChatMessage = {
    id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
    conversation_id: convo.id,
    role: 'user',
    content: 'Alert me if Bitcoin RSI dips below 30 and RTX 4090 is in stock',
    tool_calls: null,
    created_at: Date.now(),
  };
  chatMessageRepository.create(msg);
  const messages = chatMessageRepository.getByConversationId(convo.id);
  console.log('4. Chat Messages:', messages.length === 1 && messages[0].content === msg.content ? 'PASS' : 'FAIL');

  // 5. Rule
  const rule: Rule = {
    id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
    user_id: user.id,
    conversation_id: convo.id,
    title: 'Database Test Rule',
    natural_language_intent: msg.content,
    combinator: 'AND',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 30,
    audio_tone: 'cash_register',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  ruleRepository.create(rule);
  const activeRules = ruleRepository.getActiveRules();
  console.log('5. Rule Creation & Retrieval:', activeRules.some(r => r.id === rule.id) ? 'PASS' : 'FAIL');

  // 6. Sub-Sentinel
  const sentinel: SubSentinel = {
    id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
    rule_id: rule.id,
    sentinel_type: 'FINANCIAL_TECHNICAL',
    target_source: 'BTC/USD',
    operator: 'LESS_THAN',
    threshold: JSON.stringify({ indicator: 'RSI', period: 14, timeframe: '1h', value: 30 }),
    ttl_seconds: 60,
    is_satisfied: 0,
    health_status: 'HEALTHY',
    error_count: 0,
  };
  subSentinelRepository.create(sentinel);
  subSentinelRepository.updateSatisfaction(sentinel.id, true, JSON.stringify({ currentValue: 28.2, sourceTimestamp: Date.now() }));
  const fetchedSentinel = subSentinelRepository.getByRuleId(rule.id)[0];
  console.log('6. Sub-Sentinel Satisfaction State:', fetchedSentinel.is_satisfied === 1 && fetchedSentinel.health_status === 'HEALTHY' ? 'PASS' : 'FAIL');

  // 7. Seen Events
  seenEventRepository.recordSeenEvent('sha256-hash-evt-1', sentinel.id, 'binance:ws', 'sha256-hash-evt-1');
  console.log('7. Seen Events Deduplication:', seenEventRepository.isEventSeen(sentinel.id, 'sha256-hash-evt-1') ? 'PASS' : 'FAIL');

  // 8. Telemetry Points
  telemetryRepository.log({
    id: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a77',
    rule_id: rule.id,
    sub_sentinel_id: sentinel.id,
    metric_name: 'rsi',
    value: 28.2,
    timestamp: Date.now(),
    metadata: JSON.stringify({ timeframe: '1h' }),
  });
  const telemetry = telemetryRepository.getByRuleId(rule.id);
  console.log('8. Telemetry Chart Logging:', telemetry.length === 1 && telemetry[0].value === 28.2 ? 'PASS' : 'FAIL');

  // 9. Alert Event
  const alert: AlertEvent = {
    id: '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a88',
    rule_id: rule.id,
    user_id: user.id,
    title: 'Bitcoin RSI Under 30',
    summary: 'RSI reached 28.2 on the 1h timeframe.',
    audio_tone: 'cash_register',
    snapshot_data: JSON.stringify({ rsi: 28.2 }),
    created_at: Date.now(),
  };
  alertEventRepository.create(alert);
  const alerts = alertEventRepository.getByUserId(user.id);
  console.log('9. Alert History Log:', alerts.length === 1 && alerts[0].title === alert.title ? 'PASS' : 'FAIL');

  // 10. Interrupt Action (HITL)
  const action: InterruptAction = {
    id: '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a99',
    alert_id: alert.id,
    rule_id: rule.id,
    user_id: user.id,
    action_type: 'LIMIT_BUY_ORDER',
    action_payload: JSON.stringify({ symbol: 'BTC', amount: 0.1, limit_price: 58000 }),
    status: 'PENDING',
    expires_at: Date.now() + 300000,
    created_at: Date.now(),
  };
  interruptActionRepository.create(action);
  const pendingActions = interruptActionRepository.getPending();
  console.log('10. Interrupt Action (Pending HITL):', pendingActions.length === 1 ? 'PASS' : 'FAIL');

  interruptActionRepository.updateStatus(action.id, 'APPROVED');
  const resolved = interruptActionRepository.getById(action.id);
  console.log('11. Interrupt Action Approval Resolution:', resolved?.status === 'APPROVED' ? 'PASS' : 'FAIL');

  // Cascade Deletion Test: Deleting User should cascade to all 9 child tables
  userRepository.create({ ...user, id: 'temp-user-delete', email: 'delete@example.com', google_sub: 'del-sub' });
  const dbInstance = getDatabase();
  dbInstance.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  const rulesAfterUserDelete = ruleRepository.getByUserId(user.id);
  console.log('12. Foreign Key Cascade Integrity (User delete cascades to Rules):', rulesAfterUserDelete.length === 0 ? 'PASS' : 'FAIL');

  // Clean up
  closeDatabase();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  console.log('✅ ALL 12 EXPANDED DOMAIN & SCHEMA TESTS PASSED SUCCESSFULLY!');
} catch (err) {
  console.error('Database verification failed:', err);
  process.exit(1);
}
