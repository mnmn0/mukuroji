# Time tracking, timesheets, and budgets

Time tracking is scoped by Workspace and Team. A time entry references a canonical Work Item and may optionally reference a Project. Manual entries and timer-generated entries share the same lifecycle:

`draft → submitted → approved → locked`

Rejected entries return to `rejected` and can be edited and submitted again. Every create, edit, submit, approve, reject, and lock operation writes an immutable history record and a shared audit event in the same transaction. Estimate and budget changes also append a shared audit event in the same transaction. Entry revisions are checked with optimistic concurrency, and timer stop atomically removes the running timer while creating the entry, its history, and its audit event.

## HTTP surface

- `POST /api/teams/:teamId/time-entries` creates a manual draft.
- `GET /api/teams/:teamId/time-entries` lists entries in the caller's Project allowlist.
- `PATCH /api/teams/:teamId/time-entries/:entryId` edits a draft or rejected entry.
- `POST /api/teams/:teamId/time-entries/:entryId/{submit,approve,reject,lock}` changes one lifecycle state.
- `POST /api/teams/:teamId/timesheet/{submit,approve,reject,lock}` applies a lifecycle operation to all eligible entries in a period. The operation is resumable: every eligible entry is attempted, and `failedEntryIds` plus `partialFailure` identify entries that need a later retry.
- `POST /api/teams/:teamId/timers` starts the caller's timer; `GET /api/time-tracking/timers/active` supports offline recovery; `POST /api/time-tracking/timers/:timerId/stop` creates a draft from the timer; `DELETE /api/time-tracking/timers/:timerId` discards an overlong or unwanted timer.
- `GET /api/teams/:teamId/timesheet` returns daily and Monday-based weekly rows using the requested IANA timezone.
- `GET /api/teams/:teamId/time-tracking/summary` groups actual minutes by day, week, user, Project, or Work Item.
- `GET /api/teams/:teamId/time-tracking/export` exports the same ACL-filtered summary as CSV.
- `PUT /api/teams/:teamId/work-items/:workItemId/time-estimate` stores a Work Item estimate in minutes with an expected revision.
- `GET /api/teams/:teamId/work-items/:workItemId/time-estimate` reads the estimate for an authorized Work Item.
- `PUT /api/teams/:teamId/time-budget` and `PUT /api/teams/:teamId/projects/:projectId/time-budget` store optimistic-concurrency-protected budgets.

All period endpoints require `from`, `to`, and accept `timeZone` plus `groupBy`. Date-only ranges are interpreted as local dates and converted to UTC before querying. Intervals crossing midnight are split at timezone-aware local boundaries, including daylight-saving transitions.

Mutation endpoints accept an optional `Idempotency-Key`; when supplied, the shared durable receipt store binds it to the actor, operation, and request fingerprint, then replays the stored result for an equivalent retry. An in-progress duplicate receives a stable conflict response.

## Confidential cost fields

Members can record billable status and duration but cannot set or read `hourlyRateMinor` or `actualCostMinor`. The API resolves the caller's Work Item Project assignment before persisting an entry and filters reports by the caller's Project allowlist. Confidential money fields are evaluated against the Projects the caller manages for each entry; only authorized managers receive them in entry, summary, and export responses. Mixed-currency reports expose currency-keyed totals rather than combining minor units.

Production time-entry persistence uses the existing analytics DynamoDB table with distinct `TIME_*` sort-key prefixes, while lifecycle audit events use the shared audit events table. The API role grants item-level transaction access to both tables, while existing Analytics rows remain unchanged. Money fields may exist in internal audit snapshots for redaction, but `amountMinor` is excluded from the audit diff and confidential entry cost fields are not copied into entry snapshots.
