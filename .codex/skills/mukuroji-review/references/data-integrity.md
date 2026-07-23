# Data-integrity and concurrency review

Focus on DynamoDB, events, projections, receipts, background processing, and any
operation that can be retried, resumed, or partially fail.

Check:

- Canonical IDs and partition/sort keys are derived by the server from scope and
  validated resource identity; client physical keys are never trusted.
- Strongly consistent reads are used where authorization, revision, relation, or
  transition decisions require them.
- Mutations use expected revision or equivalent conditional writes and revalidate
  mutable state inside the transaction.
- Canonical rows, projections, summaries, audit/outbox events, and receipts share
  the intended transaction boundary.
- Idempotency keys bind operation, scope, and input fingerprint; reuse with a
  different input conflicts; retry after a lost response finds the same receipt.
- Query pagination processes `LastEvaluatedKey`, preserves ordering, and does not
  hide truncation as success.
- Stream, schedule, webhook, import, and backfill handlers classify malformed input,
  retryable failure, partial batch failure, lease expiry, and duplicate delivery.
- Backfills support dry-run, bounded scope, checkpoint/resume, safe rerun, unknown
  row handling, and audit of the operator and target scope.

Treat data loss, duplicate mutation, orphaned projection, or authorization based on
stale state as at least P1; raise to P0 when recovery or tenant isolation is at risk.
