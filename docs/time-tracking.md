# Time tracking, timesheets, and budgets

Time tracking is scoped by Workspace and Team. A time entry references a canonical Work Item and may optionally reference a Project. Manual entries and timer-generated entries share the same lifecycle:

`draft → submitted → approved → locked`

Rejected entries return to `rejected` and can be edited and submitted again. A manager can also send an approved or locked entry back to `rejected` with a required reason (`return`); its history records the `returned` action with the reason, and `approvedAt` / `lockedAt` are cleared. Every create, edit, submit, approve, reject, and lock operation writes an immutable history record and a shared audit event in the same transaction. Budget changes also append a shared audit event in the same transaction. Estimates are not stored here: the canonical estimate is the Work Item's `schedule.plannedEffortMinutes` (see [Work Items](work-items.md#estimate-remaining-effort-and-progress)), and summaries and timesheets read it from the Work Items, including archived ones, so archiving finished work keeps its estimate next to its recorded time. Entry revisions are checked with optimistic concurrency, and timer stop atomically removes the running timer while creating the entry, its history, and its audit event.

## HTTP surface

- `POST /api/teams/:teamId/time-entries` creates a manual draft.
- `GET /api/teams/:teamId/time-entries` lists entries in the caller's Project allowlist.
- `PATCH /api/teams/:teamId/time-entries/:entryId` edits a draft or rejected entry.
- `POST /api/teams/:teamId/time-entries/:entryId/{submit,approve,reject,lock}` changes one lifecycle state.
- `POST /api/teams/:teamId/time-entries/:entryId/return` sends an approved or locked entry back to `rejected`; `reason` is required.
- `GET /api/teams/:teamId/time-periods` lists the Team's closed months; `POST /api/teams/:teamId/time-periods/:month/close` closes a `YYYY-MM` month in the body's `timeZone` (default `UTC`); `POST /api/teams/:teamId/time-periods/:month/reopen` reopens it with a required `reason`. See [Month close](#month-close).
- `POST /api/teams/:teamId/timesheet/{submit,approve,reject,lock}` applies a lifecycle operation to all eligible entries in a period. The operation is resumable: every eligible entry is attempted, and `failedEntryIds` plus `partialFailure` identify entries that need a later retry.
- `POST /api/teams/:teamId/timers` starts the caller's timer; `GET /api/time-tracking/timers/active` supports offline recovery; `POST /api/time-tracking/timers/:timerId/stop` creates a draft from the timer; `DELETE /api/time-tracking/timers/:timerId` discards an overlong or unwanted timer.
- `GET /api/teams/:teamId/timesheet` returns daily and Monday-based weekly rows using the requested IANA timezone.
- `GET /api/teams/:teamId/time-tracking/summary` groups actual minutes by day, week, user, Project, Work Item, or work category (`groupBy=category`).
- `GET /api/teams/:teamId/time-tracking/export` exports the same ACL-filtered summary as CSV.
- `PUT /api/teams/:teamId/time-budget` and `PUT /api/teams/:teamId/projects/:projectId/time-budget` store optimistic-concurrency-protected budgets.

All period endpoints require `from`, `to`, and accept `timeZone` plus `groupBy`. Date-only ranges are interpreted as local dates and converted to UTC before querying. Intervals crossing midnight are split at timezone-aware local boundaries, including daylight-saving transitions.

## Work categories and date-and-minutes entries

An entry may carry a `category`: `design`, `implementation`, `review`, `meeting`, `management`, `training`, or `leave`. Create and `PATCH` accept it, and `PATCH` with `category: null` removes it. Entries without one, including every entry saved before categories existed, are reported in the `uncategorized` group (label `Uncategorized`) of a `groupBy=category` summary or CSV export. The list is fixed for now; Workspace-defined categories are still open in #397.

Instead of `startAt` and `endAt`, a create request may send `date` (`YYYY-MM-DD`), `minutes` (a whole number from 1 to 1440), and optionally `timeZone` (IANA, default `UTC`). The server stores the entry from local midnight of that date for that many minutes and marks it `durationOnly: true`, so clients know its times of day carry no meaning. The minutes must end within the local date, so a 23-hour daylight-saving day accepts at most 1380. Sending both forms is rejected. Editing `startAt` or `endAt` later turns the entry back into a timed entry. Timers still record times of day.

Mutation endpoints accept an optional `Idempotency-Key`; when supplied, the shared durable receipt store binds it to the actor, operation, and request fingerprint, then replays the stored result for an equivalent retry. An in-progress duplicate receives a stable conflict response.

## Month close

A Team manager closes a calendar month so its time stops changing. The close stores the month and the IANA timezone that defines its first and last instant. While it exists, any create, edit, timer stop, or lifecycle transition whose entry interval overlaps the month fails with `409 TimePeriodClosed`; an edit is checked against both the stored and the new interval, so time cannot be moved into or out of a closed month. Locking an approved entry is still allowed, because that is how a closed month is finalized. The Web shows a 409 `TimePeriodClosed` as "this month has been closed" instead of a revision conflict. Closing a month twice fails with `TimePeriodAlreadyClosed`. A month must be between `1970-01` and `9998-12` (`InvalidMonth`).

Reopening requires a non-empty `reason` and removes the close. Both operations write a shared audit event (`time-period.closed` / `time-period.reopened`, entity `time-period`, `teamId:month`) in the same DynamoDB transaction, and the reopen reason is kept in the event metadata. Closes are stored in the time tracking table under the `TIME_CLOSE#<teamId>#<YYYY-MM>` sort key.

Only a caller who manages every Project of the Team (a system administrator or a direct enterprise Team grant with `teams.manage`) may close or reopen; a manager of only some Projects receives `TimePeriodCloseDenied`. Every member of the Team can list the closed months.

The entry write transaction also rechecks the close row of every month its intervals can touch in any timezone, so a close or reopen that lands between the check and the write cancels the write with `409 TimePeriodClosed`; the client reloads and retries. Member and role rate cards, the Workspace default currency, and per-period budgets from #398 are not implemented yet.

## Write access and manager scope

Workspace guests have read-only access: every non-`GET` time tracking route (entries, timers, timesheet actions, and budgets) rejects them with `WorkspaceRoleDenied`, whatever Project role they hold.

Managing time is decided per Project, not per Team. A caller who manages one Project of a Team can edit other members' entries, list their entries and history, run the week-wide approve / reject / lock actions, and read a Project budget only for the Projects they manage; approving, rejecting, or locking a single entry also requires managing its Project. Moving an entry while editing another member's time, or changing a rate, requires managing both the current and the new Project. The Project is the one stored on the entry, not the current Project of its Work Item. Other members' entries without a Project can be edited, listed, read in history, approved, rejected, or locked only by system administrators. The authorization is bound to the entry revision it read, so a request that expects a newer revision fails with `TimeEntryRevisionConflict`. A direct enterprise Team grant with `teams.manage` manages every Project of the Team.

## Confidential cost fields

Members can record billable status and duration but cannot set or read `hourlyRateMinor` or `actualCostMinor`. The API resolves the caller's Work Item Project assignment before persisting an entry and filters reports by the caller's Project allowlist. Confidential money fields are evaluated against the Projects the caller manages for each entry; only authorized managers receive them in entry, summary, and export responses. Mixed-currency reports expose currency-keyed totals rather than combining minor units.

Production time-entry persistence uses the existing analytics DynamoDB table with distinct `TIME_*` sort-key prefixes, while lifecycle audit events use the shared audit events table. The API role grants item-level transaction access to both tables, while existing Analytics rows remain unchanged. Money fields may exist in internal audit snapshots for redaction, but `amountMinor` is excluded from the audit diff and confidential entry cost fields are not copied into entry snapshots.

## Web screens

- **Work Item detail → 工数 section** (`time` in a Work Item Type's `detailSections`, included in the default type): shows the Work Item's canonical estimate next to the Team's actual minutes for the last year (from the `work-item` summary) and the remaining effort (the recorded remaining effort, otherwise the estimate minus actual), lets a member start / stop / discard their timer (restored from `GET /api/time-tracking/timers/active` after a reload or reconnect), and add, edit, and submit their own entries from the last 90 days. A timer older than the 7-day entry limit can only be discarded. The estimate and remaining effort are edited in the Work Item's schedule section, not here.
- **Team → 工数** (`/teams/:teamId/timesheet`): the member's Monday-based week as a Work Item × day table and per-day entries, with week-wide submit, rejection reasons from the entry history, and resubmission. `?week=YYYY-MM-DD` selects the week.
- **Team → 工数 → 週報** (`?view=weekly-report`, #348): drafts the member's weekly report for the selected week from facts the member can already read. Work Items come from `GET /api/work-items?teamId=…&involvement=mine` (owned or contributed, filtered by the server), time from the member's own entries in the week. Completed = `actualEndDate` in the week; started = `actualStartDate` in the week and not completed in it; overdue = open with a planned end before today (current week) or before the week's end (past weeks); next week = other open items in progress or planned to start or end by the end of next week; recorded time is totalled per Work Item. The member adds issues and a reflection and copies the report as Markdown in the 今週やったこと / 来週やること / 課題 layout. The notes are not saved and nothing is published; saved report definitions, publishing to Planning updates / Documents / Update Feed, history, AI summaries, Team and Project reports, and reminders are still open in #348.
- **Team → 工数 → 承認** (`?view=approvals`): Team managers see submitted entries grouped by member with approve / reject (reason required) and approved entries with lock, plus week-wide approve and lock that report `failedEntryIds` for a retry. Whether the viewer manages the Team is read from the Team timesheet's `costsRedacted` flag; other members see a permission notice. The screens never display confidential rates or costs.

The entry list endpoint returns at most 500 entries with no cursor, so the Web reads a busy period page by page, continuing from the start of the last entry and skipping repeats. If a page brings nothing new, or 20 pages are not enough, the screen says the list is partial and the approval queue turns off week-wide approve and lock so they cannot touch entries the manager has not seen. Entries that cross local midnight count on each day they cover in whole minutes, allocated like the server timesheet (floor per day, leftover minutes to the largest fractions), and an entry carried over from Sunday is listed on the next week's Monday. The Work Item panel's 90-day window moves forward at local midnight, and a failed Work Item or member lookup on the time tracking page is shown with a retry instead of an empty task list. Manual entry offers only tasks the server would accept, using the write scopes the Team task-view list returns (the same server-effective permissions, enterprise grants included): a task in a Project needs that Team-qualified Project scope, and a task without a Project needs the Team scope. When no task qualifies, Add manually is turned off and the page says why. The entry form has a separate end date, so editing an overnight entry keeps both days.

Two limits to keep in mind when rolling this out:

- A Work Item Type saved before this change keeps its stored `detailSections`, so the 工数 section stays hidden on that Type until an admin adds `time` in the Type settings. Only the default Type and new Types include it automatically. No data migration was done.
- Entries recorded on a Work Item with no Project are dropped by the server's Project allowlist, so they appear on nobody's timesheet, the member's own included. This is existing server behavior and is tracked in #453.

Members whose draft or rejected entries stay unsubmitted get a daily-checked Inbox reminder; the number of days is a Team and personal notification setting (see [Notifications](notifications.md#工数の督促)).

Every Web mutation sends an `Idempotency-Key`. A request that does not reach the API, an in-progress duplicate, or a 5xx keeps the same key so repeating the action after reconnecting cannot record it twice; a revision conflict reloads every time tracking query before the member retries. Project budgets, summary reports, and CSV export do not have screens yet.
