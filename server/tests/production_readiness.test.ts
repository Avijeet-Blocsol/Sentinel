import assert from 'node:assert/strict';
import {
  assertProductionConfiguration,
  getProductionConfigurationIssues,
} from '../src/config/production_readiness.js';

const validProduction = {
  NODE_ENV: 'production',
  SENTINEL_INFRASTRUCTURE_MODE: 'aws',
  DATABASE_PROVIDER: 'dynamodb',
  AWS_S3_SESSION_BUCKET: 'sentinel-session-memory',
  SENTINEL_SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:123456789012:sentinel-execution',
  SENTINEL_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
  SENTINEL_SCHEDULER_DLQ_ARN: 'arn:aws:sqs:us-east-1:123456789012:sentinel-scheduler-dlq',
};

assert.deepEqual(getProductionConfigurationIssues(validProduction), []);
assert.doesNotThrow(() => assertProductionConfiguration(validProduction));

const localProductionDemo = {
  NODE_ENV: 'production',
  SENTINEL_INFRASTRUCTURE_MODE: 'local',
  DATABASE_PROVIDER: 'sqlite',
};
assert.deepEqual(getProductionConfigurationIssues(localProductionDemo), []);
assert.doesNotThrow(() => assertProductionConfiguration(localProductionDemo));

const fifoWithoutGroup = {
  ...validProduction,
  SENTINEL_SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:123456789012:sentinel-execution.fifo',
};
assert.match(
  getProductionConfigurationIssues(fifoWithoutGroup).join('\n'),
  /SENTINEL_SQS_MESSAGE_GROUP_ID/,
);

const missingMemory = { ...validProduction, AWS_S3_SESSION_BUCKET: '' };
assert.throws(() => assertProductionConfiguration(missingMemory), /AWS_S3_SESSION_BUCKET/);

console.log('PASS production readiness rejects missing durable memory and scheduler safeguards');
