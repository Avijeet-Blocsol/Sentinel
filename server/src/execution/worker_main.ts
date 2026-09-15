import 'dotenv/config';

import { SentinelSqsWorker } from './sqs_worker.js';
import { globalEvaluatorEngine } from '../services/evaluators/engine.js';
import { configureEvaluatorNotifications } from '../services/runtime_notifications.js';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';

if (!usesAwsInfrastructure()) {
  throw new Error('The SQS worker is disabled in local infrastructure mode');
}

const queueUrl = process.env.SENTINEL_EXECUTION_QUEUE_URL;
if (!queueUrl) {
  throw new Error('SENTINEL_EXECUTION_QUEUE_URL is required for the evaluator worker');
}
const deadLetterQueueUrl = process.env.SENTINEL_EXECUTION_DLQ_URL;
if (process.env.NODE_ENV === 'production' && !deadLetterQueueUrl) {
  throw new Error('Production evaluator workers require SENTINEL_EXECUTION_DLQ_URL');
}

const worker = new SentinelSqsWorker({
  queueUrl,
  concurrency: Number(process.env.SENTINEL_SQS_CONCURRENCY || 5),
  visibilityTimeoutSeconds: Number(process.env.SENTINEL_SQS_VISIBILITY_TIMEOUT_SECONDS || 300),
  maxReceiveCount: Number(process.env.SENTINEL_SQS_MAX_RECEIVE_COUNT || 8),
  deadLetterQueueUrl,
});
// The worker has no socket registry, but shares the same durable-event and
// push policy as the API process.
configureEvaluatorNotifications(globalEvaluatorEngine);
const controller = new AbortController();

const shutdown = () => controller.abort();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`Sentinel SQS evaluator worker started for ${queueUrl}`);
await worker.run(controller.signal);
