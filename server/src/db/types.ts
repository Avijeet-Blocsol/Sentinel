/**
 * Strands Sentinel - Modular Database Repository Interfaces
 * Defines uniform contracts implemented by SQLite, DynamoDB, and other storage providers.
 */

import type {
  User,
  UserDevice,
  AgentConversation,
  ChatMessage,
  Rule,
  SubSentinel,
  SentinelHealthStatus,
  SeenEvent,
  TelemetryPoint,
  AlertEvent,
  InterruptAction,
  EnrichedInterruptAction,
} from '@sentinel/shared';

export interface ExecutionLeaseRecord {
  id: string;
  event_type: 'TICK' | 'EVALUATE_RULE' | 'WORKFLOW_RESUME';
  rule_id?: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  lease_owner: string;
  lease_expires_at: number;
  attempts: number;
  result_payload?: string | null;
  last_error?: string | null;
  created_at: number;
  updated_at: number;
}

export interface IExecutionRepository {
  claim(
    record: Omit<ExecutionLeaseRecord, 'status' | 'attempts' | 'created_at' | 'updated_at'> & { now: number }
  ): Promise<{ claimed: boolean; attempts: number }> | { claimed: boolean; attempts: number };
  complete(id: string, owner: string, payload: string, now?: number): Promise<void> | void;
  fail(id: string, owner: string, error: string, retryable: boolean, now?: number): Promise<void> | void;
}

export interface EnrichedAlertEvent extends AlertEvent {
  conversation_id?: string | null;
  rule_title?: string | null;
}

export interface IUserRepository {
  create(user: User): Promise<void> | void;
  getById(id: string): Promise<User | null> | (User | null);
  getByGoogleSub(googleSub: string): Promise<User | null> | (User | null);
  getByAppleSub(appleSub: string): Promise<User | null> | (User | null);
  getByGithubSub(githubSub: string): Promise<User | null> | (User | null);
  getByEmail(email: string): Promise<User | null> | (User | null);
}

export interface IUserDeviceRepository {
  registerDevice(device: UserDevice): Promise<void> | void;
  getByUserId(userId: string): Promise<UserDevice[]> | UserDevice[];
  removeById(id: string): Promise<void> | void;
}

export interface IConversationRepository {
  create(convo: AgentConversation): Promise<void> | void;
  getById(id: string): Promise<AgentConversation | null> | (AgentConversation | null);
  getByUserId(userId: string, limit?: number): Promise<AgentConversation[]> | AgentConversation[];
  updateStatus(id: string, status: AgentConversation['status']): Promise<void> | void;
  updatePhase(id: string, phase: AgentConversation['phase']): Promise<void> | void;
  search(
    userId: string,
    query: string,
    limit?: number
  ): Promise<Array<AgentConversation & { matched_snippet?: string | null }>> |
     Array<AgentConversation & { matched_snippet?: string | null }>;
}

export interface IChatMessageRepository {
  create(msg: ChatMessage): Promise<void> | void;
  getByConversationId(conversationId: string, limit?: number): Promise<ChatMessage[]> | ChatMessage[];
}

export interface IRuleRepository {
  create(rule: Rule): Promise<void> | void;
  getById(id: string): Promise<Rule | null> | (Rule | null);
  getByUserId(userId: string, limit?: number): Promise<Rule[]> | Rule[];
  getByConversationId(conversationId: string): Promise<Rule[]> | Rule[];
  getActiveRules(): Promise<Rule[]> | Rule[];
  updateStatus(id: string, status: Rule['status']): Promise<void> | void;
  claimCooldown(ruleId: string, now: number, cooldownMs: number): Promise<boolean> | boolean;
  releaseCooldown(ruleId: string, previousTriggeredAt?: number | null): Promise<void> | void;
  commitTrigger(input: TriggerCommitInput): Promise<boolean> | boolean;
  delete(id: string): Promise<void> | void;
}

export interface TriggerCommitInput {
  ruleId: string;
  triggeredAt: number;
  oneShot: boolean;
  alert: AlertEvent;
  interrupt?: InterruptAction;
}

export interface ISubSentinelRepository {
  create(sentinel: SubSentinel): Promise<void> | void;
  getByRuleId(ruleId: string): Promise<SubSentinel[]> | SubSentinel[];
  getDue(now?: number, limit?: number): Promise<SubSentinel[]> | SubSentinel[];
  claim(id: string, now?: number): Promise<boolean> | boolean;
  updateSatisfaction(
    id: string,
    isSatisfied: boolean,
    statePayload?: string,
    error?: string | null,
    healthStatus?: SentinelHealthStatus,
    nextEvaluationAt?: number,
  ): Promise<void> | void;
}

export interface ISeenEventRepository {
  isEventSeen(subSentinelId: string, eventHash: string): Promise<boolean> | boolean;
  recordSeenEvent(
    id: string,
    subSentinelId: string,
    source: string,
    eventHash: string
  ): Promise<void> | void;
}

export interface ITelemetryRepository {
  log(point: TelemetryPoint): Promise<void> | void;
  getByRuleId(ruleId: string, limit?: number): Promise<TelemetryPoint[]> | TelemetryPoint[];
}

export interface IAlertEventRepository {
  create(alert: AlertEvent): Promise<void> | void;
  getByUserId(userId: string, limit?: number, ruleId?: string): Promise<EnrichedAlertEvent[]> | EnrichedAlertEvent[];
  getById(id: string): Promise<EnrichedAlertEvent | null> | (EnrichedAlertEvent | null);
}

export interface IInterruptActionRepository {
  create(action: InterruptAction): Promise<void> | void;
  createClarification(input: {
    action: InterruptAction;
    conversationId: string;
    userId: string;
    expectedPhase: AgentConversation['phase'];
    now: number;
  }): Promise<boolean> | boolean;
  getPendingByUserId(userId: string): Promise<EnrichedInterruptAction[]> | EnrichedInterruptAction[];
  getLatestByConversationId(
    conversationId: string,
    actionType: string,
    status: InterruptAction['status'],
  ): Promise<EnrichedInterruptAction | null> | (EnrichedInterruptAction | null);
  getPending(): Promise<InterruptAction[]> | InterruptAction[];
  expirePending(now?: number): Promise<InterruptAction[]> | InterruptAction[];
  getById(id: string): Promise<EnrichedInterruptAction | null> | (EnrichedInterruptAction | null);
  updateActionPayload(id: string, actionPayload: string): Promise<boolean> | boolean;
  updateStatus(id: string, status: InterruptAction['status']): Promise<void> | void;
  resolveIfPending(id: string, status: InterruptAction['status'], now?: number): Promise<boolean> | boolean;
  resolveClarification(input: {
    interruptId: string;
    conversationId: string;
    userId: string;
    resolution: 'APPROVED' | 'REJECTED';
    resumePhase: AgentConversation['phase'];
    now: number;
  }): Promise<boolean> | boolean;
  /**
   * Repairs a pending choice gate left behind by an interrupted/older
   * workflow. This is intentionally conditional on the action identity and
   * ownership so a stale card cannot move another conversation forward.
   */
  restorePendingClarification(input: {
    interruptId: string;
    conversationId: string;
    userId: string;
    now: number;
  }): Promise<boolean> | boolean;
}

export interface DeploymentCommitInput {
  interruptId: string;
  conversationId: string;
  rule: Rule;
  subSentinels: SubSentinel[];
  baselineEvents: Array<Pick<SeenEvent, 'id' | 'sub_sentinel_id' | 'source' | 'event_hash'>>;
  now: number;
}

/**
 * The durable "visual card" boundary. A PAUSED rule is intentionally not
 * visible to the evaluator until both the confirmation interrupt and the
 * conversation phase have committed with it.
 */
export interface DeploymentProposalInput {
  conversationId: string;
  rule: Rule;
  interrupt: InterruptAction;
  now: number;
}

export interface MonitoringModeProposalInput {
  conversationId: string;
  rule: Rule;
  subSentinels: SubSentinel[];
  baselineEvents: Array<Pick<SeenEvent, 'id' | 'sub_sentinel_id' | 'source' | 'event_hash'>>;
  now: number;
}

export interface MonitoringModeDeploymentInput {
  conversationId: string;
  userId: string;
  ruleId: string;
  triggerMode: Rule['trigger_mode'];
  now: number;
}

export interface TaskEditCommitInput {
  interruptId: string;
  conversationId: string;
  userId: string;
  expectedRuleUpdatedAt: number;
  rule: Rule;
  subSentinels: SubSentinel[];
  deletedSubSentinelIds: string[];
  now: number;
}

/**
 * Commits each deployment lifecycle boundary as one durable operation.
 * SQLite implements this with a transaction and DynamoDB with TransactWrite.
 */
export interface IDeploymentRepository {
  stage(input: DeploymentProposalInput): Promise<boolean> | boolean;
  stageMonitoringMode(input: MonitoringModeProposalInput): Promise<boolean> | boolean;
  approve(input: DeploymentCommitInput): Promise<boolean> | boolean;
  deployMonitoringMode(input: MonitoringModeDeploymentInput): Promise<boolean> | boolean;
  applyTaskEdit(input: TaskEditCommitInput): Promise<boolean> | boolean;
  reject(input: Pick<DeploymentCommitInput, 'interruptId' | 'conversationId' | 'rule' | 'now'>): Promise<boolean> | boolean;
}

export interface DatabaseAdapter {
  userRepository: IUserRepository;
  userDeviceRepository: IUserDeviceRepository;
  conversationRepository: IConversationRepository;
  chatMessageRepository: IChatMessageRepository;
  ruleRepository: IRuleRepository;
  subSentinelRepository: ISubSentinelRepository;
  seenEventRepository: ISeenEventRepository;
  telemetryRepository: ITelemetryRepository;
  alertEventRepository: IAlertEventRepository;
  interruptActionRepository: IInterruptActionRepository;
  deploymentRepository: IDeploymentRepository;
  executionRepository: IExecutionRepository;
  healthCheck(): Promise<void> | void;
  close(): Promise<void> | void;
}
