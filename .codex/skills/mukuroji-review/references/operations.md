# Operations and recovery review

Check whether the changed behavior can be operated, diagnosed, rolled out, and
recovered safely in production.

Check:

- Structured logs, correlation IDs, metrics, traces, health/readiness, and audit
  context identify the affected request, event, user, and tenant without leaking
  secrets or unnecessary PII.
- Alerts have actionable thresholds, ownership, runbook, and escalation context;
  retries do not create silent failure or alert storms.
- Feature flags, canary, kill switch, backward-compatible deployment, and rollback
  behavior match the change's risk.
- Schema migration and backfill are online-safe, bounded, idempotent, checkpointed,
  resumable, observable, and reversible or explicitly non-reversible with recovery
  evidence.
- Backup, PITR, restore verification, retention, and disaster-recovery behavior are
  tested for the affected data and dependencies.
- Load, soak, queue saturation, timeout, rate limit, cold start, and partial outage
  behavior are considered when the change affects scale or asynchronous work.

Report missing recovery or diagnosis only when the changed path makes the gap
material to the selected intent source or production safety.
