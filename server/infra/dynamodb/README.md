# Due-time scheduler migration

The evaluator worker reads active work from the `idx_due_schedule` global
secondary index instead of scanning `sub_sentinels` on every scheduler tick.

For an existing DynamoDB table:

1. Add the `idx_due_schedule` GSI with `schedule_shard` (String, hash key) and
   `next_evaluation_at` (Number, range key). The accompanying
   `sub-sentinels-due-index.yaml` is the table definition for new stacks.
2. Wait until the index reports `ACTIVE`.
3. Deploy the server build containing this change, then run once with
   `DATABASE_PROVIDER=dynamodb`: `npm run backfill:due-schedule`.
4. Verify the server health check and then start/upgrade the SQS worker.

The backfill schedules only active, unexpired rules and removes scheduling
metadata from inactive ones. It is safe to rerun. Do not switch an existing
production worker to this release before steps 1–3: legacy records are
intentionally not scanned by the normal scheduler.
