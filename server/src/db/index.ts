/**
 * Strands Sentinel - Database & Persistence Facade Layer
 * Unified access point selecting between SQLite (local development)
 * and Amazon DynamoDB + S3 (AWS production deployment).
 */

import { sqliteAdapter, getDatabase as getSqliteDatabase, closeDatabase as closeSqliteDatabase } from './sqlite/index.js';
import { dynamoDbAdapter } from './dynamodb/index.js';
import type { DatabaseAdapter } from './types.js';
import { getInfrastructureMode } from '../config/infrastructure_mode.js';

export * from '@sentinel/shared';
export * from './types.js';
export { getSessionStorage } from './s3/session_storage.js';

/**
 * Active database provider resolution: 'sqlite' | 'dynamodb'
 * Default: 'sqlite' (zero-config, high performance local embedded database)
 */
export const infrastructureMode = getInfrastructureMode();
export const activeProvider = (
  process.env.DATABASE_PROVIDER || (infrastructureMode === 'aws' ? 'dynamodb' : 'sqlite')
).toLowerCase();

if (activeProvider !== 'sqlite' && activeProvider !== 'dynamodb') {
  throw new Error('DATABASE_PROVIDER must be either sqlite or dynamodb');
}

if (infrastructureMode === 'local' && activeProvider !== 'sqlite') {
  throw new Error('Local infrastructure mode requires DATABASE_PROVIDER=sqlite');
}

if (process.env.NODE_ENV === 'production' && infrastructureMode !== 'aws') {
  throw new Error('Production requires SENTINEL_INFRASTRUCTURE_MODE=aws; refusing local infrastructure');
}

if (infrastructureMode === 'aws' && process.env.NODE_ENV === 'production' && activeProvider !== 'dynamodb') {
  throw new Error('Production requires DATABASE_PROVIDER=dynamodb; refusing to start with SQLite');
}

export const activeAdapter: DatabaseAdapter =
  activeProvider === 'dynamodb' ? dynamoDbAdapter : sqliteAdapter;

// Re-export repository instances for direct consumption across routes and services
export const userRepository = activeAdapter.userRepository;
export const userDeviceRepository = activeAdapter.userDeviceRepository;
export const conversationRepository = activeAdapter.conversationRepository;
export const chatMessageRepository = activeAdapter.chatMessageRepository;
export const ruleRepository = activeAdapter.ruleRepository;
export const subSentinelRepository = activeAdapter.subSentinelRepository;
export const subSentryRepository = activeAdapter.subSentinelRepository; // Backward-compatibility alias
export const seenEventRepository = activeAdapter.seenEventRepository;
export const telemetryRepository = activeAdapter.telemetryRepository;
export const alertEventRepository = activeAdapter.alertEventRepository;
export const interruptActionRepository = activeAdapter.interruptActionRepository;
export const deploymentRepository = activeAdapter.deploymentRepository;
export const executionRepository = activeAdapter.executionRepository;
export const checkDatabaseReadiness = () => activeAdapter.healthCheck();

export const getDatabase = getSqliteDatabase;
export const closeDatabase = () => activeAdapter.close();
