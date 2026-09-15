/**
 * Non-secret production configuration contract.
 *
 * This intentionally validates only topology and safety prerequisites. Secret
 * validity remains the responsibility of the identity and AWS SDK clients.
 */

import { getInfrastructureMode } from './infrastructure_mode.js';

export type Environment = Record<string, string | undefined>;

export function getProductionConfigurationIssues(env: Environment = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];

  let infrastructureMode: 'local' | 'aws';
  try {
    infrastructureMode = getInfrastructureMode(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (infrastructureMode === 'local') return [];

  const issues: string[] = [];
  if ((env.DATABASE_PROVIDER || 'sqlite').toLowerCase() !== 'dynamodb') {
    issues.push('DATABASE_PROVIDER must be dynamodb');
  }
  if (!env.AWS_S3_SESSION_BUCKET) {
    issues.push('AWS_S3_SESSION_BUCKET is required for Strands session memory');
  }

  const targetArn = env.SENTINEL_SCHEDULER_TARGET_ARN;
  if (!targetArn || !targetArn.startsWith('arn:aws:sqs:')) {
    issues.push('SENTINEL_SCHEDULER_TARGET_ARN must be an Amazon SQS ARN');
  }
  if (!env.SENTINEL_SCHEDULER_ROLE_ARN) {
    issues.push('SENTINEL_SCHEDULER_ROLE_ARN is required');
  }
  if (!env.SENTINEL_SCHEDULER_DLQ_ARN || !env.SENTINEL_SCHEDULER_DLQ_ARN.startsWith('arn:aws:sqs:')) {
    issues.push('SENTINEL_SCHEDULER_DLQ_ARN must be an Amazon SQS ARN');
  } else if (env.SENTINEL_SCHEDULER_DLQ_ARN.endsWith('.fifo')) {
    issues.push('SENTINEL_SCHEDULER_DLQ_ARN must reference a standard SQS queue');
  }
  if (targetArn?.endsWith('.fifo') && !env.SENTINEL_SQS_MESSAGE_GROUP_ID) {
    issues.push('SENTINEL_SQS_MESSAGE_GROUP_ID is required for a FIFO scheduler target');
  }
  return issues;
}

export function assertProductionConfiguration(env: Environment = process.env): void {
  const issues = getProductionConfigurationIssues(env);
  if (issues.length > 0) {
    throw new Error(`Production configuration is incomplete: ${issues.join('; ')}`);
  }
}
