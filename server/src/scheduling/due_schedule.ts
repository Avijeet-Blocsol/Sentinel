/** Shared, deterministic schedule metadata for durable sub-sentinel polling. */

import { createHash } from 'node:crypto';
import type { SubSentinel } from '@sentinel/shared';

/**
 * A small, fixed shard count avoids a single hot DynamoDB partition while
 * keeping each scheduler tick's fan-out bounded and predictable.
 */
export const DUE_SCHEDULE_SHARD_COUNT = 16;

export type DueScheduleFields = Pick<SubSentinel, 'schedule_shard' | 'next_evaluation_at'>;

export function getDueScheduleShard(subSentinelId: string): string {
  const firstByte = createHash('sha256').update(subSentinelId).digest()[0] ?? 0;
  return `due-${firstByte % DUE_SCHEDULE_SHARD_COUNT}`;
}

/** Preserve the evaluator's existing exponential-backoff policy. */
export function getNextEvaluationAt(
  subSentinel: Pick<SubSentinel, 'ttl_seconds'>,
  healthStatus: SubSentinel['health_status'],
  errorCount: number,
  now = Date.now(),
): number {
  if (healthStatus === 'ERROR') {
    const exponent = Math.min(Math.max(errorCount || 1, 1), 10);
    return now + Math.min(86_400_000, (1 << exponent) * 60_000);
  }
  return now + subSentinel.ttl_seconds * 1000;
}

/** Build schedule fields for a newly persisted or backfilled sentinel. */
export function getInitialDueSchedule(
  subSentinel: SubSentinel,
  now = Date.now(),
): DueScheduleFields {
  const nextEvaluationAt = subSentinel.next_evaluation_at
    ?? (subSentinel.last_evaluated_at !== null && subSentinel.last_evaluated_at !== undefined
      ? getNextEvaluationAt(
          subSentinel,
          subSentinel.health_status,
          subSentinel.error_count,
          now,
        )
      : now);

  return {
    schedule_shard: subSentinel.schedule_shard || getDueScheduleShard(subSentinel.id),
    next_evaluation_at: nextEvaluationAt,
  };
}
