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

## Web screens

- **Work Item detail → 工数 section** (`time` in a Work Item Type's `detailSections`, included in the default type): shows the estimate next to the Team's actual minutes for the last year (from the `work-item` summary), lets a member start / stop / discard their timer (restored from `GET /api/time-tracking/timers/active` after a reload or reconnect), set the estimate, and add, edit, and submit their own entries from the last 90 days. A timer older than the 7-day entry limit can only be discarded.
- **Team → 工数** (`/teams/:teamId/timesheet`): the member's Monday-based week as a Work Item × day table and per-day entries, with week-wide submit, rejection reasons from the entry history, and resubmission. `?week=YYYY-MM-DD` selects the week.
- **Team → 工数 → 承認** (`?view=approvals`): Team managers see submitted entries grouped by member with approve / reject (reason required) and approved entries with lock, plus week-wide approve and lock that report `failedEntryIds` for a retry. Whether the viewer manages the Team is read from the Team timesheet's `costsRedacted` flag; other members see a permission notice. The screens never display confidential rates or costs.

The entry list endpoint returns at most 500 entries with no cursor, so the Web reads a busy period page by page, continuing from the start of the last entry and skipping repeats. If a page brings nothing new, or 20 pages are not enough, the screen says the list is partial and the approval queue turns off week-wide approve and lock so they cannot touch entries the manager has not seen. Entries that cross local midnight count on each day they cover in whole minutes, allocated like the server timesheet (floor per day, leftover minutes to the largest fractions), and an entry carried over from Sunday is listed on the next week's Monday. The Work Item panel's 90-day window moves forward at local midnight, and a failed Work Item or member lookup on the time tracking page is shown with a retry instead of an empty task list. Manual entry offers only tasks the server would accept, using the write scopes the Team task-view list returns (the same server-effective permissions, enterprise grants included): a task in a Project needs that Team-qualified Project scope, and a task without a Project needs the Team scope. When no task qualifies, Add manually is turned off and the page says why. The entry form has a separate end date, so editing an overnight entry keeps both days.

Every Web mutation sends an `Idempotency-Key`. A request that does not reach the API, an in-progress duplicate, or a 5xx keeps the same key so repeating the action after reconnecting cannot record it twice; a revision conflict reloads every time tracking query before the member retries. Project budgets, summary reports, and CSV export do not have screens yet.
