import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  DEFAULT_TEAM_TIME_ENTRY_POLICY,
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  DEFAULT_WORKSPACE_TIME_ZONE,
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  readTeamTimeEntryPolicy,
  type TeamTimeEntryPolicy,
  type TeamTimeEntryPolicyRecord,
  type TimeEntryPolicyWarning,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  TIME_RATE_CARD_JOB_ROLE_LIMIT,
  TIME_RATE_CARD_MAX_HOURLY_RATE_MINOR,
  TIME_RATE_CARD_MEMBER_LIMIT,
  isKnownCurrencyCode,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  isActiveTimeEntryCategory,
  readTimeEntryCategoryKey,
  type WorkspaceTimeEntryCategorySettings,
  type WorkspaceWeekStartDay,
  workspaceWeekContaining,
  type RunningTimer,
  type TimeBudget,
  type TimeEntry,
  type TimeEntryCategory,
  type TimeEntryHistory,
  type TimeEntrySource,
  type TimeEntryStatus,
  type TimePeriodClose,
  type WorkspaceTimePeriodResult,
  type WorkspaceTimePeriodTeamResult,
  type WorkspaceTimePeriodTeamState,
  type TimeRateCard,
  type TimeRateCardJobRoleRate,
  type TimeRateCardMemberRate,
  type TimeSheet,
  type TimeSummaryGroup,
  type TimeTrackingGroupBy,
  type TimeTrackingSummary,
} from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditEventTransactPut,
  createMutationAuditContext,
  type AuditTransactWriteItem,
} from '../audit'

/** Transaction condition check on a caller authorization row, built by the HTTP composition. */
export type TimeTrackingAuthorizationConditionCheck = AuditTransactWriteItem

/** Decision returned by the shared idempotency receipt store. */
export type TimeTrackingIdempotencyDecision =
  | { status: 'reserved'; reservationId: string }
  | { status: 'in-progress' }
  | { status: 'replay'; response: unknown }

/** Minimal idempotency port used by time-tracking mutations. */
export interface TimeTrackingIdempotencyPort {
  /** Reserves a request key or returns a replayable response. */
  reserveIdempotency(request: {
    workspaceId: string
    credentialId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<TimeTrackingIdempotencyDecision>
  /** Stores the JSON-safe mutation response. */
  completeIdempotency(request: {
    workspaceId: string
    credentialId: string
    idempotencyKey: string
    requestFingerprint: string
    reservationId: string
    response: unknown
  }): Promise<void>
  /** Releases an incomplete reservation. */
  releaseIdempotency(request: {
    workspaceId: string
    credentialId: string
    idempotencyKey: string
    requestFingerprint: string
    reservationId: string
  }): Promise<void>
  /** Prepares a receipt completion item for the domain transaction. */
  prepareIdempotencyCompletion?(request: {
    workspaceId: string
    credentialId: string
    idempotencyKey: string
    requestFingerprint: string
    reservationId: string
    response: unknown
  }): Promise<AuditTransactWriteItem>
}

/** Callback used to attach an idempotency completion to a domain transaction. */
type TimeTrackingIdempotencyCompletion = (response: unknown) => Promise<AuditTransactWriteItem>

/** JSON-safe response used to persist a void timer-cancellation result. */
type CompletedTimeTrackingMutation = { completed: true }

const ENTRY_PREFIX = 'TIME_ENTRY#'
const HISTORY_PREFIX = 'TIME_HISTORY#'
const TIMER_PREFIX = 'TIME_TIMER#'
const BUDGET_PREFIX = 'TIME_BUDGET#'
/** Budgets per period one Team or Project may have (ADR 0077). */
const MAX_BUDGET_PERIODS = 40
const PERIOD_CLOSE_PREFIX = 'TIME_CLOSE#'
const ENTRY_POLICY_PREFIX = 'TIME_POLICY#'
const RATE_CARD_PREFIX = 'TIME_RATE_CARD#'
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u
const MIN_CLOSE_YEAR = 1970
const MAX_CLOSE_YEAR = 9998
// IANA offsets stay within UTC-12 and UTC+14, so a local month can only start or end this far
// from the UTC month boundary.
const MAX_TIME_ZONE_OFFSET_MILLISECONDS = 14 * 60 * 60_000
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const ISO_INSTANT_PATTERN = /T.*(?:Z|[+-]\d{2}:\d{2})$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const MAX_DESCRIPTION_LENGTH = 4_000
const MAX_ENTRY_DURATION_MINUTES = 24 * 60 * 7
const MAX_ENTRY_DURATION_MILLISECONDS = MAX_ENTRY_DURATION_MINUTES * 60_000
const MAX_DURATION_ONLY_MINUTES = 24 * 60
const MAX_LIST_LIMIT = 500
const TIME_ENTRY_DATE_INDEX_NAME = 'TimeEntryTeamDateIndex'
const TIME_ENTRY_AUDIT_FIELDS = [
  'status',
  'revision',
  'startAt',
  'endAt',
  'durationMinutes',
  'durationOnly',
  'category',
  'description',
  'billable',
  'currency',
  'projectId',
  'workItemId',
  'userId',
  'source',
] as const

/** A validated time entry creation request. */
export type CreateTimeEntryInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional Project identifier. */
  projectId?: string
  /** Canonical Work Item identifier; omitted for indirect work, which then requires a `category`. */
  workItemId?: string
  /** Member recording the work. */
  userId: string
  /** Interval start; required unless `duration` is set. */
  startAt?: string
  /** Interval end; required unless `duration` is set. */
  endAt?: string
  /** Date and minutes recorded without times of day; replaces `startAt` and `endAt`. */
  duration?: TimeEntryDurationInput
  /** Optional work category. */
  category?: TimeEntryCategory
  /** Optional explanation. */
  description?: string
  /** Chargeable flag. */
  billable: boolean
  /** Currency code. */
  currency: string
  /** Whether the route filled `currency` from the Workspace default; the default stays out of the request fingerprint. */
  currencyFromWorkspaceDefault?: boolean
  /** Optional confidential hourly rate. */
  hourlyRateMinor?: number
  /** Origin of the entry. */
  source: TimeEntrySource
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** Worked minutes on a local date, entered without start and end times. */
export type TimeEntryDurationInput = {
  /** Local work date as `YYYY-MM-DD`. */
  date: string
  /** Worked minutes; at most the length of the local date. */
  minutes: number
  /** IANA timezone that defines the local date. */
  timeZone: string
}

/** A create request after validation, with the interval resolved. */
type NormalizedCreateTimeEntryInput = Omit<CreateTimeEntryInput, 'startAt' | 'endAt' | 'duration' | 'idempotencyKey'> & {
  /** Resolved interval start. */
  startAt: string
  /** Resolved interval end. */
  endAt: string
  /** Whether the interval came from a date and minutes rather than times of day. */
  durationOnly: boolean
}

/** A time entry update request. */
export type UpdateTimeEntryInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier used to resolve the entry. */
  teamId: string
  /** Entry identifier. */
  entryId: string
  /** Actor performing the update. */
  actorUserId: string
  /** Whether the actor may change confidential fields. */
  canManageRates: boolean
  /** Expected entry revision. */
  expectedRevision: number
  /**
   * Revision that the caller's authorization checks read. When set, a request whose
   * expected revision differs is rejected as a conflict, so a concurrent change cannot
   * reuse an authorization decided on an older revision. Excluded from idempotency fingerprints.
   */
  authorizedRevision?: number
  /**
   * Optional new start. Sending the stored start and end again keeps a date-and-minutes entry
   * as one; a different interval makes it a timed entry.
   */
  startAt?: string
  /** Optional new end. */
  endAt?: string
  /** Optional new date and minutes, which keeps or makes the entry a date-and-minutes entry. */
  duration?: TimeEntryDurationInput
  /** Optional new Work Item; `null` turns the entry into indirect work, which requires a category. */
  workItemId?: string | null
  /** Optional new Project. */
  projectId?: string | null
  /** Optional new work category; `null` makes the entry uncategorized. */
  category?: TimeEntryCategory | null
  /** Optional new description. */
  description?: string | null
  /** Optional new chargeable flag. */
  billable?: boolean
  /** Optional new currency. */
  currency?: string
  /** Optional new hourly rate. */
  hourlyRateMinor?: number | null
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** An entry lifecycle transition request. */
export type TransitionTimeEntryInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier used to resolve the entry. */
  teamId: string
  /** Entry identifier. */
  entryId: string
  /** Actor performing the transition. */
  actorUserId: string
  /** Whether the actor may approve or lock. */
  canApprove: boolean
  /** Expected entry revision. */
  expectedRevision: number
  /**
   * Revision that the caller's authorization checks read. When set, a request whose
   * expected revision differs is rejected as a conflict, so a concurrent change cannot
   * reuse an authorization decided on an older revision. Excluded from idempotency fingerprints.
   */
  authorizedRevision?: number
  /** Requested transition; `return` sends an approved or locked entry back to `rejected`. */
  action: 'submit' | 'approve' | 'reject' | 'lock' | 'return'
  /** Rejection reason; required for `return`. */
  reason?: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** A request to delete a draft or rejected time entry. */
export type DeleteTimeEntryInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier used to resolve the entry. */
  teamId: string
  /** Entry identifier. */
  entryId: string
  /** Actor deleting the entry; only the entry owner may delete it. */
  actorUserId: string
  /** Expected entry revision. */
  expectedRevision: number
  /**
   * Revision that the caller's authorization checks read. When set, a request whose
   * expected revision differs is rejected as a conflict. Excluded from idempotency fingerprints.
   */
  authorizedRevision?: number
  /**
   * Read-only checks on the caller's authorization rows, committed with the delete so a member
   * whose access was removed after the route's check cannot delete. Excluded from idempotency
   * fingerprints.
   */
  authorizationConditionChecks?: readonly TimeTrackingAuthorizationConditionCheck[]
  /** Optional client key used to make the deletion and its audit idempotent across retries. */
  idempotencyKey?: string
}

/** JSON-safe result of deleting a time entry. */
export type DeletedTimeEntry = {
  /** Identifier of the deleted entry. */
  entryId: string
  /** Always `true`; marks the stored idempotency response. */
  deleted: true
}

/** A durable timer start request. */
export type StartTimerInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional Project identifier. */
  projectId?: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Timer owner. */
  userId: string
  /** Optional explanation. */
  description?: string
  /** Chargeable flag. */
  billable: boolean
  /** Timestamp at which the client believes the timer started. */
  startedAt?: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** A timer stop request. */
export type StopTimerInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Timer identifier. */
  timerId: string
  /** Timer owner. */
  userId: string
  /** End timestamp. */
  endedAt?: string
  /** Optional confidential hourly rate. */
  hourlyRateMinor?: number
  /** Currency for the generated entry. */
  currency: string
  /** Whether the route filled `currency` from the Workspace default; the default stays out of the request fingerprint. */
  currencyFromWorkspaceDefault?: boolean
  /** Whether the caller may set confidential fields. */
  canManageRates: boolean
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** Request used to discard a running timer without creating an entry. */
export type CancelTimerInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Active timer identifier. */
  timerId: string
  /** Timer owner. */
  userId: string
  /** Optional client key used to make cancellation idempotent. */
  idempotencyKey?: string
}

/**
 * Read port for Work Item estimates.
 *
 * The estimate's single source is the canonical Work Item (`schedule.plannedEffortMinutes`); time
 * tracking only reads it for reports.
 */
export type TimeTrackingEstimateSource = {
  /**
   * Lists the planned effort of a Team's Work Items that have one.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @returns Planned minutes keyed by Work Item ID.
   */
  listPlannedEffort(workspaceId: string, teamId: string): Promise<ReadonlyMap<string, number>>
}

/**
 * Read port for the work categories a Workspace offers.
 *
 * The categories are owned by the tenant profile; time tracking only checks new entries against
 * them and names report groups with them.
 */
export type TimeTrackingCategorySource = {
  /**
   * Reads the Workspace work categories.
   *
   * @param workspaceId - Workspace identifier.
   * @returns The stored categories, or the defaults when the Workspace has not saved any.
   */
  readCategories(workspaceId: string): Promise<WorkspaceTimeEntryCategorySettings>
  /**
   * Reads the Workspace time zone, which decides the local dates the daily total is counted on.
   *
   * @param workspaceId - Workspace identifier.
   * @returns IANA time zone, or the Workspace default when the Workspace has not chosen one.
   */
  readTimeZone?(workspaceId: string): Promise<string>
  /**
   * Reads the day the Workspace week starts on, which decides the weekly report and timesheet buckets.
   *
   * @param workspaceId - Workspace identifier.
   * @returns Week start day from 0 (Sunday) to 6, or Monday when the Workspace has not chosen one.
   */
  readWeekStartDay?(workspaceId: string): Promise<WorkspaceWeekStartDay>
}

/** A stored Team time entry policy. */
export type StoredTeamTimeEntryPolicy = TeamTimeEntryPolicy & {
  /** Record schema version. */
  schemaVersion: 1
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optimistic concurrency revision, starting at 1. */
  revision: number
  /** Member who saved the policy. */
  updatedBy: string
  /** Save timestamp. */
  updatedAt: string
}

/** A Team time entry policy update request. */
export type SaveTeamTimeEntryPolicyInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Requested policy. */
  policy: TeamTimeEntryPolicy
  /** Revision the caller read; 0 while the Team uses the defaults. */
  expectedRevision: number
  /** Manager saving the policy. */
  actorUserId: string
  /** Optional mutation replay key. */
  idempotencyKey?: string
}

/** A saved entry with the checks it broke in a Team that only warns about them. */
export type TimeEntryWithWarnings = {
  /** Saved entry. */
  entry: TimeEntry
  /** Broken checks; empty when none, and on an idempotent replay. */
  warnings: TimeEntryPolicyWarning[]
}

/** A request replacing a Team's whole rate card. */
export type SaveTimeRateCardInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team whose rate card is replaced. */
  teamId: string
  /** ISO 4217 currency of every rate. */
  currency: string
  /** Complete list of member rates, validated by the service. */
  memberRates: readonly unknown[]
  /** Complete list of job role rates, validated by the service. */
  jobRoleRates: readonly unknown[]
  /** Revision read before editing, or zero for the first save. */
  expectedRevision: number
  /** Actor changing the rate card. */
  updatedBy: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** A budget update request. */
export type SaveTimeBudgetInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team containing the budget scope, when the scope is a Project. */
  teamId?: string
  /** Budget scope. */
  scopeType: 'team' | 'project'
  /** Team or Project identifier. */
  scopeId: string
  /** Budget amount in minor currency units. */
  amountMinor: number
  /** ISO 4217 currency code. */
  currency: string
  /** Whether the route filled `currency` from the Workspace default; the default stays out of the request fingerprint. */
  currencyFromWorkspaceDefault?: boolean
  /** Inclusive local period start. */
  periodFrom?: string
  /** Inclusive local period end. */
  periodTo?: string
  /**
   * Whether this saves the scope's budget for exactly `periodFrom`–`periodTo` (ADR 0077) rather
   * than its default budget. Both dates are then required.
   */
  periodBudget?: boolean
  /** Expected budget revision, or zero for a new budget. */
  expectedRevision: number
  /**
   * Update time of the budget the caller read. A budget per period deleted and saved again starts
   * at revision 1 once more, so this tells the new budget apart from the one that was read.
   */
  expectedUpdatedAt?: string
  /** Actor changing the budget. */
  updatedBy: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
}

/** A request to delete one of a scope's budgets per period. */
export type DeleteTimeBudgetPeriodInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team that owns the scope. */
  teamId: string
  /** Budget scope. */
  scopeType: 'team' | 'project'
  /** Team or Project identifier. */
  scopeId: string
  /** Inclusive local period start of the budget. */
  periodFrom: string
  /** Inclusive local period end of the budget. */
  periodTo: string
  /** Revision of the budget the caller read. */
  expectedRevision: number
  /**
   * Save time of the budget the caller read. A budget deleted and saved again restarts at the
   * same revision, so this tells a stale delete from one of the new budget.
   */
  expectedUpdatedAt?: string
  /** Actor deleting the budget. */
  deletedBy: string
}

/** Inclusive local dates of one budget period. */
export type TimeBudgetPeriod = {
  /** Inclusive local period start. */
  from: string
  /** Inclusive local period end. */
  to: string
}

/** One month whose close state an entry write relied on. */
export type TimePeriodGuardMonth = {
  /** Month as `YYYY-MM`. */
  month: string
  /** Close timestamp that was read, or undefined when the month was open. */
  closedAt?: string
}

/**
 * Month close state that an entry write was validated against. The write is rejected when any
 * of these months is closed, reopened, or closed again before the write commits.
 */
export type TimePeriodGuard = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Months that the written intervals can touch in any timezone. */
  months: ReadonlyArray<TimePeriodGuardMonth>
}

/** A request to close one month of a Team's time entries. */
export type CloseTimePeriodInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Month to close as `YYYY-MM`. */
  month: string
  /** IANA timezone that defines the month boundaries. */
  timeZone: string
  /** Manager closing the month. */
  actorUserId: string
  /** Optional client key used to make the close idempotent. */
  idempotencyKey?: string
}

/** A request to reopen a closed month of a Team's time entries. */
export type ReopenTimePeriodInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Closed month as `YYYY-MM`. */
  month: string
  /** Manager reopening the month. */
  actorUserId: string
  /** Required explanation recorded in the audit event. */
  reason: string
  /** Optional client key used to make the reopen idempotent. */
  idempotencyKey?: string
}

/** A request to close one month for every listed Team of a Workspace. */
export type CloseWorkspaceTimePeriodInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Teams of the Workspace whose month is closed. */
  teamIds: readonly string[]
  /** Month to close as `YYYY-MM`. */
  month: string
  /** IANA timezone that defines the month boundaries for every Team. */
  timeZone: string
  /** Workspace administrator closing the month. */
  actorUserId: string
  /**
   * Read-only checks on the caller's authorization rows, committed with each Team's close so a
   * caller whose Workspace role changed during the loop stops closing the remaining Teams.
   */
  authorizationConditionChecks?: readonly TimeTrackingAuthorizationConditionCheck[]
  /** Correlation ID of the request, written to the log of each Team that fails. */
  correlationId?: string
}

/** A request to reopen one month for every listed Team of a Workspace. */
export type ReopenWorkspaceTimePeriodInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Teams of the Workspace whose month is reopened. */
  teamIds: readonly string[]
  /** Closed month as `YYYY-MM`. */
  month: string
  /** Workspace administrator reopening the month. */
  actorUserId: string
  /** Required explanation recorded in each Team's audit event. */
  reason: string
  /**
   * Read-only checks on the caller's authorization rows, committed with each Team's reopen so a
   * caller whose Workspace role changed during the loop stops reopening the remaining Teams.
   */
  authorizationConditionChecks?: readonly TimeTrackingAuthorizationConditionCheck[]
  /** Correlation ID of the request, written to the log of each Team that fails. */
  correlationId?: string
}

/** Configuration for appending time-tracking mutations to the shared audit table. */
export type TimeTrackingAuditOptions = {
  /** Shared audit events table name. */
  tableName: string
  /** Retention period used to calculate the audit event TTL. */
  retentionDays: number
}

/** Input used to create a shared audit event for a time-tracking mutation. */
type TimeTrackingAuditMutation = {
  /** Workspace containing the mutation. */
  workspaceId: string
  /** Team containing the mutation. */
  teamId: string
  /** User who performed the mutation. */
  actorUserId: string
  /** Shared audit event type. */
  eventType: string
  /** Entity type recorded by the audit event. */
  entityType: string
  /** Entity identifier recorded by the audit event. */
  entityId: string
  /** Action recorded by the audit event. */
  action: string
  /** Idempotency key for retries of the same mutation. */
  idempotencyKey: string
  /** Request body used to fingerprint the mutation. */
  requestBody: Readonly<Record<string, unknown>>
  /** State before the mutation, when one existed. */
  before?: Readonly<Record<string, unknown>>
  /** State after the mutation, when one exists. */
  after?: Readonly<Record<string, unknown>>
  /** Fields included in the before/after diff. */
  includeFields: readonly string[]
  /** Fields redacted from the before/after diff. */
  redactFields?: readonly string[]
  /** Additional searchable audit metadata. */
  metadata: Readonly<Record<string, unknown>>
  /** Resource path used in the audit request snapshot. */
  path: string
  /** Optional event timestamp. */
  occurredAt?: string
}

/** Query options for a Team's time entries. */
export type ListTimeEntriesInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional lower bound. */
  from?: string
  /** Optional upper bound. */
  to?: string
  /** Optional member filter. */
  userId?: string
  /** Optional lifecycle filter. */
  status?: TimeEntryStatus
  /** Project allowlist applied before returning or aggregating entries. */
  projectIds?: ReadonlySet<string>
  /** Whether entries without a Project pass the Project allowlist; they are dropped by default. */
  includeUnassigned?: boolean
  /** Maximum number of entries to return. */
  limit?: number
}

/** Query options for reports and timesheets. */
export type TimeTrackingReportInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Inclusive local date or instant lower bound. */
  from: string
  /** Inclusive local date or instant upper bound. */
  to: string
  /** IANA timezone used for calendar boundaries. */
  timeZone: string
  /** Report grouping. */
  groupBy: TimeTrackingGroupBy
  /** Whether money fields may be returned. */
  includeCosts: boolean
  /** Project allowlist applied before report aggregation. */
  projectIds?: ReadonlySet<string>
  /** Project IDs for which the caller may view confidential costs. */
  managedProjectIds?: ReadonlySet<string>
  /** Caller whose time management rights narrow the entries a report reads; omitted for unrestricted reports. */
  viewer?: TimeReportViewer
  /** Explicit budget scope selected by the caller. */
  budgetScope?: 'team' | 'project'
  /** Project ID used when budgetScope is project. */
  budgetScopeId?: string
}

/** Input of {@link TimeTrackingService.summarizeProjectBudgets}. */
export type ProjectBudgetConsumptionInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team that owns the Projects. */
  teamId: string
  /** Projects whose budgets and costs are read; the caller already checked cost visibility. */
  projectIds: readonly string[]
  /** IANA timezone that bounds the local budget periods. */
  timeZone: string
  /** Instant the cost is totalled up to. */
  now: Date
  /** Most entries the read may total before it fails closed. */
  entryLimit: number
}

/** Budget of one Project and the billable cost recorded against it. */
export type ProjectBudgetConsumption = {
  /** Stored budget. */
  budget: TimeBudget
  /** Billable cost in the budget currency within the period up to now, in minor units. */
  actualCostMinor: number
  /** Whether billable cost was recorded in another currency. */
  hasOtherCurrencyCost: boolean
}

/**
 * Caller of a report, used to decide whose entries the report may total.
 *
 * Members read only their own entries. Callers who manage time in the Team also read other
 * members' entries in the Projects they manage and entries without a Project. Work Item totals
 * set `includeAllMembers` to read every member's entries in the caller's visible Projects.
 */
export type TimeReportViewer = {
  /** Member key of the caller; their own entries are always readable. */
  userId: string
  /** Whether the caller manages time in the Team. */
  canManage: boolean
  /**
   * Whether every member's time in the caller's visible Projects and outside Projects may be
   * totalled, as for Work Item totals that anyone who can see the Work Item may compare with its
   * estimate.
   */
  includeAllMembers?: boolean
}

/** Repository used by the time tracking application service. */
export interface TimeTrackingRepository {
  /** Lists entries in one Workspace/Team partition. */
  listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]>
  /** Reads one entry by Workspace, Team, and ID. */
  getEntry(workspaceId: string, teamId: string, entryId: string): Promise<TimeEntry | undefined>
  /** Saves an entry with an optional optimistic concurrency condition. */
  saveEntry(entry: TimeEntry, expectedRevision?: number): Promise<void>
  /** Saves an entry and its immutable history in one operation. */
  saveEntryWithHistory(
    entry: TimeEntry,
    history: TimeEntryHistory,
    expectedRevision?: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ): Promise<void>
  /**
   * Deletes a draft or rejected entry when it is still at the expected revision, together with
   * its audit event and idempotency receipt where supported, and while every month in
   * `periodGuard` keeps the close state it was validated against and every
   * `authorizationChecks` row still holds. Its history records are kept.
   */
  deleteEntry(
    entry: TimeEntry,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
    authorizationChecks?: readonly TimeTrackingAuthorizationConditionCheck[],
  ): Promise<void>
  /** Saves an immutable lifecycle history record. */
  saveHistory(workspaceId: string, teamId: string, history: TimeEntryHistory): Promise<void>
  /** Lists immutable lifecycle history for an entry. */
  listHistory(workspaceId: string, teamId: string, entryId: string): Promise<TimeEntryHistory[]>
  /** Reads the active timer for one Workspace member. */
  getActiveTimer(workspaceId: string, userId: string): Promise<RunningTimer | undefined>
  /** Removes the active timer with an optimistic identity check. */
  cancelTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem, idempotencyPut?: AuditTransactWriteItem): Promise<void>
  /** Creates an active timer and rejects a duplicate active timer. */
  createTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem, idempotencyPut?: AuditTransactWriteItem): Promise<void>
  /** Stops a timer and persists its resulting entry atomically where supported. */
  finishTimer(
    timer: RunningTimer,
    entry: TimeEntry,
    history: TimeEntryHistory,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ): Promise<void>
  /**
   * Reads a Team or Project budget.
   *
   * Project IDs are unique only within their Team, so a Project budget is read by the Team and
   * Project pair.
   */
  getBudget(
    workspaceId: string,
    teamId: string,
    scopeType: 'team' | 'project',
    scopeId: string,
    period?: TimeBudgetPeriod,
  ): Promise<TimeBudget | undefined>
  /** Lists a scope's budgets per period in period order (ADR 0077). */
  listBudgetPeriods(workspaceId: string, teamId: string, scopeType: 'team' | 'project', scopeId: string): Promise<TimeBudget[]>
  /**
   * Saves a Team or Project budget with optimistic concurrency and optional audit. A budget with
   * `periodBudget` is stored as the scope's budget for its period. An update also requires the
   * stored budget to still have `expectedUpdatedAt`, when it is given.
   */
  saveBudget(
    budget: TimeBudget,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    expectedUpdatedAt?: string,
  ): Promise<void>
  /** Deletes one of a scope's budgets per period while it is still at the read revision. */
  deleteBudgetPeriod(budget: TimeBudget, auditPut?: AuditTransactWriteItem): Promise<void>
  /** Reads a Team's rate card. */
  getRateCard(workspaceId: string, teamId: string): Promise<TimeRateCard | undefined>
  /** Saves a Team's rate card with optimistic concurrency and optional audit. */
  saveRateCard(
    rateCard: TimeRateCard,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void>
  /** Lists the closed months of a Team in month order. */
  listPeriodCloses(workspaceId: string, teamId: string): Promise<TimePeriodClose[]>
  /** Stores a month close and rejects a month that is already closed. */
  createPeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    authorizationChecks?: readonly TimeTrackingAuthorizationConditionCheck[],
  ): Promise<void>
  /** Removes a month close only while it is the same close that was read. */
  deletePeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    authorizationChecks?: readonly TimeTrackingAuthorizationConditionCheck[],
  ): Promise<void>
  /** Reads a Team's time entry policy, or undefined while the Team uses the defaults. */
  getEntryPolicy(workspaceId: string, teamId: string): Promise<StoredTeamTimeEntryPolicy | undefined>
  /** Saves a Team's time entry policy with optimistic concurrency and optional audit. */
  saveEntryPolicy(
    policy: StoredTeamTimeEntryPolicy,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void>
}

/** Stable error raised by time tracking validation, authorization, or persistence. */
export class TimeTrackingError extends Error {
  /** HTTP status used by the transport adapter. */
  readonly status: number
  /** Stable client-facing error code. */
  readonly code: string

  /** Creates a time tracking error. */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TimeTrackingError'
    this.status = status
    this.code = code
  }
}

/** Application service for time entries, timers, timesheets, budgets, and reports. */
export class TimeTrackingService {
  /** Persistence port. */
  private readonly repository: TimeTrackingRepository
  /** Clock used for deterministic tests. */
  private readonly now: () => Date
  /** Identifier factory used for entries, timers, and history. */
  private readonly createId: () => string
  /** Shared audit event configuration. */
  private readonly audit?: TimeTrackingAuditOptions
  /** Durable receipt store used for mutation replay. */
  private readonly idempotency?: TimeTrackingIdempotencyPort
  /** Read port for canonical Work Item estimates. */
  private readonly estimates?: TimeTrackingEstimateSource
  /** Read port for Workspace work categories and time zone; the built-in ones when absent. */
  private readonly categories?: TimeTrackingCategorySource

  /** Creates a time tracking service. */
  constructor(
    repository: TimeTrackingRepository,
    options: {
      now?: () => Date
      createId?: () => string
      audit?: TimeTrackingAuditOptions
      idempotency?: TimeTrackingIdempotencyPort
      estimates?: TimeTrackingEstimateSource
      categories?: TimeTrackingCategorySource
    } = {},
  ) {
    this.repository = repository
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.audit = options.audit
    this.idempotency = options.idempotency
    this.estimates = options.estimates
    this.categories = options.categories
  }

  /**
   * Reads the Workspace work categories, or the built-in ones when no source is configured.
   *
   * @param workspaceId - Workspace identifier.
   * @returns Work category settings in effect.
   */
  private async readCategorySettings(workspaceId: string): Promise<WorkspaceTimeEntryCategorySettings> {
    return this.categories
      ? await this.categories.readCategories(workspaceId)
      : DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS
  }

  /**
   * Reads the day the Workspace week starts on, or Monday when no source is configured.
   *
   * @param workspaceId - Workspace identifier.
   * @returns Week start day weekly buckets begin on.
   */
  private async readWeekStartDay(workspaceId: string): Promise<WorkspaceWeekStartDay> {
    return await this.categories?.readWeekStartDay?.(workspaceId) ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay
  }

  /**
   * Requires that new work may be recorded under a category.
   *
   * @param workspaceId - Workspace identifier.
   * @param category - Requested category key.
   * @throws TimeTrackingError When the Workspace does not offer the category or has retired it.
   */
  private async requireActiveCategory(workspaceId: string, category: TimeEntryCategory): Promise<void> {
    const settings = await this.readCategorySettings(workspaceId)
    if (!isActiveTimeEntryCategory(settings, category)) {
      throw new TimeTrackingError(400, 'InvalidTimeEntryCategory', 'The Workspace does not offer this work category.')
    }
  }

  /** Creates a manual time entry in draft state. */
  async createEntry(input: CreateTimeEntryInput, canManageRates: boolean): Promise<TimeEntry> {
    return (await this.createEntryWithWarnings(input, canManageRates)).entry
  }

  /**
   * Creates a manual time entry in draft state and reports the Team checks it broke.
   *
   * @param input - Entry request.
   * @param canManageRates - Whether the caller may set an hourly rate.
   * @returns The entry and the warnings of checks the Team only warns about.
   * @throws TimeTrackingError When the entry breaks a check the Team rejects.
   */
  async createEntryWithWarnings(input: CreateTimeEntryInput, canManageRates: boolean): Promise<TimeEntryWithWarnings> {
    let warnings: TimeEntryPolicyWarning[] = []
    const entry = await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'time-entry.create',
      input,
      (completion) => this.createEntryInternal(input, canManageRates, completion, (found) => { warnings = found }),
      readStoredEntry,
    )
    return { entry, warnings }
  }

  /** Persists a manual time entry without the public idempotency wrapper. */
  private async createEntryInternal(
    input: CreateTimeEntryInput,
    canManageRates: boolean,
    completion?: TimeTrackingIdempotencyCompletion,
    onWarnings?: (warnings: TimeEntryPolicyWarning[]) => void,
  ): Promise<TimeEntry> {
    const requested = normalizeCreateInput(input, canManageRates)
    if (requested.category !== undefined) await this.requireActiveCategory(requested.workspaceId, requested.category)
    const periodGuard = await this.requireOpenPeriod(requested.workspaceId, requested.teamId, [requested])
    const normalized = { ...requested, ...await this.resolveEntryRate(requested) }
    const now = readNow(this.now)
    const entry: TimeEntry = {
      schemaVersion: 1,
      id: this.createId(),
      workspaceId: normalized.workspaceId,
      teamId: normalized.teamId,
      ...(normalized.projectId ? { projectId: normalized.projectId } : {}),
      ...(normalized.workItemId ? { workItemId: normalized.workItemId } : {}),
      userId: normalized.userId,
      startAt: normalized.startAt,
      endAt: normalized.endAt,
      durationMinutes: calculateDurationMinutes(normalized.startAt, normalized.endAt),
      ...(normalized.durationOnly ? { durationOnly: true } : {}),
      ...(normalized.category ? { category: normalized.category } : {}),
      ...(normalized.description ? { description: normalized.description } : {}),
      billable: normalized.billable,
      currency: normalized.currency,
      status: 'draft',
      source: normalized.source,
      revision: 1,
      ...(normalized.hourlyRateMinor === undefined
        ? {}
        : { hourlyRateMinor: normalized.hourlyRateMinor }),
      ...calculateCostFields(normalized.billable, normalized.hourlyRateMinor, normalized.startAt, normalized.endAt),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    onWarnings?.(await this.checkEntryPolicy(entry))
    const history = createHistory(this.createId, entry, 'created', normalized.userId, now)
    const auditPut = this.createAuditPut(entry, history, undefined, input.idempotencyKey)
    const idempotencyPut = completion ? await completion(entry) : undefined
    await this.repository.saveEntryWithHistory(
      entry,
      history,
      undefined,
      auditPut,
      idempotencyPut,
      periodGuard,
    )
    return entry
  }

  /** Updates a draft or rejected time entry with optimistic concurrency. */
  async updateEntry(input: UpdateTimeEntryInput): Promise<TimeEntry> {
    return (await this.updateEntryWithWarnings(input)).entry
  }

  /**
   * Updates a draft or rejected time entry and reports the Team checks its new time broke.
   * Only a change of the start or end is checked, so an entry that already broke a check can
   * still have its description or category corrected.
   *
   * @param input - Update request.
   * @returns The entry and the warnings of checks the Team only warns about.
   * @throws TimeTrackingError When the new time breaks a check the Team rejects.
   */
  async updateEntryWithWarnings(input: UpdateTimeEntryInput): Promise<TimeEntryWithWarnings> {
    let warnings: TimeEntryPolicyWarning[] = []
    const entry = await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-entry.update',
      input,
      (completion) => this.updateEntryInternal(input, completion, (found) => { warnings = found }),
      readStoredEntry,
    )
    return { entry, warnings }
  }

  /** Persists an entry update without the public idempotency wrapper. */
  private async updateEntryInternal(
    input: UpdateTimeEntryInput,
    completion?: TimeTrackingIdempotencyCompletion,
    onWarnings?: (warnings: TimeEntryPolicyWarning[]) => void,
  ): Promise<TimeEntry> {
    const current = await this.requireEntry(input.workspaceId, input.entryId, input.teamId)
    if (current.userId !== input.actorUserId && !input.canManageRates) {
      throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner or a manager may edit this entry.')
    }
    if (current.status !== 'draft' && current.status !== 'rejected') {
      throw new TimeTrackingError(409, 'TimeEntryNotEditable', 'Submitted, approved, and locked entries cannot be edited.')
    }
    if (current.revision !== input.expectedRevision || (input.authorizedRevision !== undefined && input.authorizedRevision !== input.expectedRevision)) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    const { startAt, endAt, durationOnly } = resolveUpdatedInterval(current, input)
    validateInterval(startAt, endAt)
    const workItemId = input.workItemId === undefined
      ? current.workItemId
      : input.workItemId === null
        ? undefined
        : readIdentifier(input.workItemId, 'Work Item ID')
    const category = input.category === undefined
      ? current.category
      : input.category === null
        ? undefined
        : readCategory(input.category)
    requireWorkItemOrCategory(workItemId, category)
    // An entry may keep a category the Workspace retired after it was recorded; only a change is checked.
    if (category !== undefined && category !== current.category) {
      await this.requireActiveCategory(current.workspaceId, category)
    }
    const currency = input.currency ?? current.currency
    validateCurrency(currency)
    const hourlyRateMinor = input.hourlyRateMinor === undefined
      ? current.hourlyRateMinor
      : input.hourlyRateMinor === null
        ? undefined
        : requireMoney(input.hourlyRateMinor, 'Hourly rate')
    if (input.hourlyRateMinor !== undefined && !input.canManageRates) {
      throw new TimeTrackingError(403, 'ConfidentialRateDenied', 'Only a manager may change hourly rates.')
    }
    // A rate, such as one taken from the rate card, is in the entry's currency, so only a manager
    // who may change the rate may change that currency.
    if (hourlyRateMinor !== undefined && currency !== current.currency && !input.canManageRates) {
      throw new TimeTrackingError(403, 'ConfidentialRateDenied', 'Only a manager may change the currency of an entry with an hourly rate.')
    }
    const periodGuard = await this.requireOpenPeriod(current.workspaceId, current.teamId, [current, { startAt, endAt }])
    const now = readNow(this.now).toISOString()
    const next: TimeEntry = {
      ...current,
      ...(input.projectId === null ? { projectId: undefined } : input.projectId === undefined ? {} : { projectId: readIdentifier(input.projectId, 'Project ID') }),
      workItemId,
      startAt,
      endAt,
      durationMinutes: calculateDurationMinutes(startAt, endAt),
      durationOnly: durationOnly ? true : undefined,
      category,
      ...(input.description === null ? { description: undefined } : input.description === undefined ? {} : { description: normalizeDescription(input.description) }),
      billable: input.billable ?? current.billable,
      currency,
      revision: current.revision + 1,
      hourlyRateMinor: undefined,
      actualCostMinor: undefined,
      ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
      ...calculateCostFields(input.billable ?? current.billable, hourlyRateMinor, startAt, endAt),
      updatedAt: now,
    }
    if (next.startAt !== current.startAt || next.endAt !== current.endAt) {
      onWarnings?.(await this.checkEntryPolicy(next))
    }
    const history = createHistory(this.createId, next, 'updated', input.actorUserId, new Date(now), current.status, current.status)
    const auditPut = this.createAuditPut(next, history, current, input.idempotencyKey)
    const idempotencyPut = completion ? await completion(next) : undefined
    await this.repository.saveEntryWithHistory(
      next,
      history,
      current.revision,
      auditPut,
      idempotencyPut,
      periodGuard,
    )
    return next
  }

  /** Applies a submit, approve, reject, or lock transition. */
  async transitionEntry(input: TransitionTimeEntryInput): Promise<TimeEntry> {
    return await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      `time-entry.transition:${input.action}`,
      input,
      (completion) => this.transitionEntryInternal(input, completion),
      readStoredEntry,
    )
  }

  /** Applies an entry transition without the public idempotency wrapper. */
  private async transitionEntryInternal(
    input: TransitionTimeEntryInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<TimeEntry> {
    const current = await this.requireEntry(input.workspaceId, input.entryId, input.teamId)
    if (current.revision !== input.expectedRevision || (input.authorizedRevision !== undefined && input.authorizedRevision !== input.expectedRevision)) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    const isOwner = current.userId === input.actorUserId
    if (input.action === 'submit' && !isOwner) {
      throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner may submit time.')
    }
    if (input.action === 'approve' && isOwner) {
      throw new TimeTrackingError(403, 'TimesheetSelfApprovalDenied', 'An entry owner may not approve their own time.')
    }
    if (input.action !== 'submit' && !input.canApprove) {
      throw new TimeTrackingError(403, 'TimesheetApprovalDenied', 'Only a manager may approve, reject, return, or lock time.')
    }
    const reason = input.reason === undefined ? undefined : readText(input.reason, 'Reason', MAX_DESCRIPTION_LENGTH)
    if (input.action === 'return' && reason === undefined) {
      throw new TimeTrackingError(400, 'ReturnReasonRequired', 'A reason is required to return an approved entry.')
    }
    const transition = transitionFor(current.status, input.action)
    if (!transition) {
      throw new TimeTrackingError(409, 'InvalidTimeEntryTransition', `Cannot ${input.action} an entry in ${current.status} state.`)
    }
    // Locking is how a closed month's approved entries are finalized, so only lock is allowed there.
    const periodGuard = input.action === 'lock'
      ? undefined
      : await this.requireOpenPeriod(current.workspaceId, current.teamId, [current])
    const now = readNow(this.now).toISOString()
    const { approvedAt: _approvedAt, lockedAt: _lockedAt, ...withoutApproval } = current
    const next: TimeEntry = {
      ...(input.action === 'return' ? withoutApproval : current),
      status: transition.toStatus,
      revision: current.revision + 1,
      updatedAt: now,
      ...(transition.toStatus === 'submitted' ? { submittedAt: now } : {}),
      ...(transition.toStatus === 'approved' ? { approvedAt: now } : {}),
      ...(transition.toStatus === 'rejected' ? { rejectedAt: now } : {}),
      ...(transition.toStatus === 'locked' ? { lockedAt: now } : {}),
    }
    const history = createHistory(
      this.createId,
      next,
      historyActionFor(input.action),
      input.actorUserId,
      new Date(now),
      current.status,
      transition.toStatus,
      reason,
    )
    const auditPut = this.createAuditPut(next, history, current, input.idempotencyKey)
    const idempotencyPut = completion ? await completion(next) : undefined
    await this.repository.saveEntryWithHistory(
      next,
      history,
      current.revision,
      auditPut,
      idempotencyPut,
      periodGuard,
    )
    return next
  }

  /**
   * Deletes the caller's own draft or rejected entry and records a `time-entry.deleted` audit event.
   *
   * Submitted, approved, and locked entries cannot be deleted, and nobody but the entry owner may
   * delete one; a manager rejects time instead. The entry's lifecycle history is kept.
   *
   * @param input - Entry, actor, and expected revision.
   * @returns The deleted entry's identifier.
   */
  async deleteEntry(input: DeleteTimeEntryInput): Promise<DeletedTimeEntry> {
    return await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-entry.delete',
      input,
      (completion) => this.deleteEntryInternal(input, completion),
      readDeletedTimeEntry,
    )
  }

  /**
   * Deletes an entry without the public idempotency wrapper.
   *
   * @param input - Entry, actor, and expected revision.
   * @param completion - Attaches the idempotency receipt to the delete transaction.
   * @returns The deleted entry's identifier.
   */
  private async deleteEntryInternal(
    input: DeleteTimeEntryInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<DeletedTimeEntry> {
    const current = await this.requireEntry(input.workspaceId, input.entryId, input.teamId)
    if (current.userId !== input.actorUserId) {
      throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner may delete this entry.')
    }
    if (!isDeletableStatus(current.status)) {
      throw new TimeTrackingError(409, 'TimeEntryNotDeletable', 'Only draft and rejected entries can be deleted.')
    }
    if (current.revision !== input.expectedRevision || (input.authorizedRevision !== undefined && input.authorizedRevision !== input.expectedRevision)) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    // Deleting removes time from its month, so a closed month keeps its entries.
    const periodGuard = await this.requireOpenPeriod(current.workspaceId, current.teamId, [current])
    const occurredAt = readNow(this.now).toISOString()
    const auditPut = this.createAuditEventPut({
      workspaceId: current.workspaceId,
      teamId: current.teamId,
      actorUserId: input.actorUserId,
      eventType: 'time-entry.deleted',
      entityType: 'time-entry',
      entityId: current.id,
      action: 'deleted',
      idempotencyKey: input.idempotencyKey ?? this.createId(),
      requestBody: { action: 'deleted', entryId: current.id, revision: current.revision },
      before: toAuditEntrySnapshot(current),
      includeFields: TIME_ENTRY_AUDIT_FIELDS,
      redactFields: ['hourlyRateMinor', 'actualCostMinor'],
      metadata: createEntryAuditMetadata(current),
      path: `/api/teams/${current.teamId}/time-entries/${current.id}`,
      occurredAt,
    })
    const result: DeletedTimeEntry = { entryId: current.id, deleted: true }
    const idempotencyPut = completion ? await completion(result) : undefined
    await this.repository.deleteEntry(
      current,
      current.revision,
      auditPut,
      idempotencyPut,
      periodGuard,
      input.authorizationConditionChecks,
    )
    return result
  }

  /** Starts the member's one allowed running timer. */
  async startTimer(input: StartTimerInput): Promise<RunningTimer> {
    return await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'timer.start',
      input,
      (completion) => this.startTimerInternal(input, completion),
      readStoredTimer,
    )
  }

  /** Starts a timer without the public idempotency wrapper. */
  private async startTimerInternal(
    input: StartTimerInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<RunningTimer> {
    const startedAt = input.startedAt === undefined
      ? readNow(this.now).toISOString()
      : validateInstant(input.startedAt, 'Timer start')
    const timer: RunningTimer = {
      schemaVersion: 1,
      id: this.createId(),
      workspaceId: readIdentifier(input.workspaceId, 'Workspace ID'),
      teamId: readIdentifier(input.teamId, 'Team ID'),
      ...(input.projectId ? { projectId: readIdentifier(input.projectId, 'Project ID') } : {}),
      workItemId: readIdentifier(input.workItemId, 'Work Item ID'),
      userId: readIdentifier(input.userId, 'User ID'),
      startedAt,
      ...(input.description ? { description: normalizeDescription(input.description) } : {}),
      billable: input.billable,
      revision: 1,
      updatedAt: readNow(this.now).toISOString(),
    }
    const auditPut = this.createAuditEventPut({
      workspaceId: timer.workspaceId,
      teamId: timer.teamId,
      actorUserId: timer.userId,
      eventType: 'timer.started',
      entityType: 'timer',
      entityId: timer.id,
      action: 'started',
      idempotencyKey: input.idempotencyKey ?? timer.id,
      requestBody: { action: 'timer.started', timerId: timer.id, workItemId: timer.workItemId },
      after: toAuditTimerSnapshot(timer),
      includeFields: ['teamId', 'workItemId', 'userId', 'startedAt', 'description', 'billable', 'revision'],
      metadata: { teamId: timer.teamId, workItemId: timer.workItemId, userId: timer.userId },
      path: `/api/teams/${timer.teamId}/timers`,
      occurredAt: timer.updatedAt,
    })
    const idempotencyPut = completion ? await completion(timer) : undefined
    await this.repository.createTimer(timer, auditPut, idempotencyPut)
    return timer
  }

  /** Returns the member's running timer, enabling offline recovery. */
  async getActiveTimer(workspaceId: string, userId: string): Promise<RunningTimer | undefined> {
    return await this.repository.getActiveTimer(
      readIdentifier(workspaceId, 'Workspace ID'),
      readIdentifier(userId, 'User ID'),
    )
  }

  /** Stops the member's timer and creates one draft time entry. */
  async stopTimer(input: StopTimerInput): Promise<TimeEntry> {
    return await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'timer.stop',
      input,
      (completion) => this.stopTimerInternal(input, completion),
      readStoredEntry,
    )
  }

  /** Stops a timer without the public idempotency wrapper. */
  private async stopTimerInternal(
    input: StopTimerInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<TimeEntry> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const userId = readIdentifier(input.userId, 'User ID')
    const timerId = readIdentifier(input.timerId, 'Timer ID')
    const timer = await this.repository.getActiveTimer(workspaceId, userId)
    if (!timer || timer.id !== timerId) {
      throw new TimeTrackingError(404, 'RunningTimerNotFound', 'The running timer was not found or has already been stopped.')
    }
    const endedAt = input.endedAt === undefined
      ? readNow(this.now).toISOString()
      : validateInstant(input.endedAt, 'Timer end')
    validateInterval(timer.startedAt, endedAt)
    const normalizedCurrency = validateCurrency(input.currency)
    const periodGuard = await this.requireOpenPeriod(timer.workspaceId, timer.teamId, [{ startAt: timer.startedAt, endAt: endedAt }])
    if (input.hourlyRateMinor !== undefined && !input.canManageRates) {
      throw new TimeTrackingError(403, 'ConfidentialRateDenied', 'Only a manager may set an hourly rate.')
    }
    const rate = await this.resolveEntryRate({
      workspaceId: timer.workspaceId,
      teamId: timer.teamId,
      userId: timer.userId,
      currency: normalizedCurrency,
      ...(input.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: requireMoney(input.hourlyRateMinor, 'Hourly rate') }),
    })
    const hourlyRateMinor = rate.hourlyRateMinor
    const now = readNow(this.now).toISOString()
    const entry: TimeEntry = {
      schemaVersion: 1,
      id: this.createId(),
      workspaceId: timer.workspaceId,
      teamId: timer.teamId,
      ...(timer.projectId ? { projectId: timer.projectId } : {}),
      workItemId: timer.workItemId,
      userId: timer.userId,
      startAt: timer.startedAt,
      endAt: endedAt,
      durationMinutes: calculateDurationMinutes(timer.startedAt, endedAt),
      ...(timer.description ? { description: timer.description } : {}),
      billable: timer.billable,
      currency: rate.currency,
      status: 'draft',
      source: 'timer',
      revision: 1,
      ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
      ...calculateCostFields(timer.billable, hourlyRateMinor, timer.startedAt, endedAt),
      createdAt: now,
      updatedAt: now,
    }
    const history = createHistory(this.createId, entry, 'created', userId, new Date(now))
    const auditPut = this.createAuditPut(entry, history, undefined, input.idempotencyKey)
    const idempotencyPut = completion ? await completion(entry) : undefined
    await this.repository.finishTimer(
      timer,
      entry,
      history,
      auditPut,
      idempotencyPut,
      periodGuard,
    )
    return entry
  }

  /** Cancels an active timer without creating a time entry. */
  async cancelTimer(input: CancelTimerInput): Promise<void> {
    await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'timer.cancel',
      input,
      (completion) => this.cancelTimerInternal(input, completion),
      readCompletedTimeTrackingMutation,
    )
  }

  /** Cancels a timer without the public idempotency wrapper. */
  private async cancelTimerInternal(
    input: CancelTimerInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<CompletedTimeTrackingMutation> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const userId = readIdentifier(input.userId, 'User ID')
    const timerId = readIdentifier(input.timerId, 'Timer ID')
    const timer = await this.repository.getActiveTimer(workspaceId, userId)
    if (!timer || timer.id !== timerId) {
      throw new TimeTrackingError(404, 'RunningTimerNotFound', 'The running timer was not found or has already been stopped.')
    }
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId: timer.teamId,
      actorUserId: userId,
      eventType: 'timer.cancelled',
      entityType: 'timer',
      entityId: timer.id,
      action: 'cancelled',
      idempotencyKey: input.idempotencyKey ?? timer.id,
      requestBody: { action: 'timer.cancelled', timerId: timer.id },
      before: toAuditTimerSnapshot(timer),
      includeFields: ['teamId', 'workItemId', 'userId', 'startedAt', 'description', 'billable', 'revision'],
      metadata: { teamId: timer.teamId, workItemId: timer.workItemId, userId },
      path: `/api/teams/${timer.teamId}/timers/${timer.id}`,
      occurredAt: readNow(this.now).toISOString(),
    })
    const result: CompletedTimeTrackingMutation = { completed: true }
    const idempotencyPut = completion ? await completion(result) : undefined
    await this.repository.cancelTimer(timer, auditPut, idempotencyPut)
    return result
  }

  /** Reads one time entry after verifying its Team partition through the repository. */
  async getEntry(workspaceId: string, teamId: string, entryId: string): Promise<TimeEntry> {
    return await this.requireEntry(workspaceId, entryId, teamId)
  }

  /** Lists entries with a bounded repository query. */
  async listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const from = input.from === undefined ? undefined : validateEntryBoundary(input.from, 'Entry range start')
    const to = input.to === undefined ? undefined : validateEntryBoundary(input.to, 'Entry range end')
    if (from && to && !(Date.parse(to) > Date.parse(from))) {
      throw new TimeTrackingError(400, 'InvalidTimeRange', 'Entry range must have a positive duration.')
    }
    return await this.repository.listEntries({
      ...input,
      workspaceId: readIdentifier(input.workspaceId, 'Workspace ID'),
      teamId: readIdentifier(input.teamId, 'Team ID'),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: input.limit === undefined ? MAX_LIST_LIMIT : requireInteger(input.limit, 'Entry limit', 1, MAX_LIST_LIMIT),
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
    })
  }

  /** Lists every matching entry for complete reports and bulk operations. */
  async listAllEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const from = input.from === undefined ? undefined : validateEntryBoundary(input.from, 'Entry range start')
    const to = input.to === undefined ? undefined : validateEntryBoundary(input.to, 'Entry range end')
    if (from && to && !(Date.parse(to) > Date.parse(from))) {
      throw new TimeTrackingError(400, 'InvalidTimeRange', 'Entry range must have a positive duration.')
    }
    return await this.repository.listEntries({
      ...input,
      workspaceId: readIdentifier(input.workspaceId, 'Workspace ID'),
      teamId: readIdentifier(input.teamId, 'Team ID'),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
    })
  }

  /** Returns immutable lifecycle history for an entry. */
  async listHistory(workspaceId: string, teamId: string, entryId: string): Promise<TimeEntryHistory[]> {
    await this.requireEntry(workspaceId, entryId, teamId)
    return await this.repository.listHistory(workspaceId, teamId, entryId)
  }

  /** Saves a Team or Project budget. */
  async saveBudget(input: SaveTimeBudgetInput): Promise<TimeBudget> {
    return await this.withIdempotency(
      input.workspaceId,
      input.updatedBy,
      input.idempotencyKey,
      'time-budget.save',
      input,
      (completion) => this.saveBudgetInternal(input, completion),
      readStoredBudget,
    )
  }

  /**
   * Reads the budget of a Team or of one Project of the Team.
   *
   * The caller has already decided that the reader may see the amount.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team that owns the scope.
   * @param scopeType - Budget scope.
   * @param scopeId - Team or Project identifier.
   * @returns The budget, or undefined when none is stored.
   */
  async getBudget(
    workspaceId: string,
    teamId: string,
    scopeType: 'team' | 'project',
    scopeId: string,
  ): Promise<TimeBudget | undefined> {
    return await this.repository.getBudget(
      readIdentifier(workspaceId, 'Workspace ID'),
      readIdentifier(teamId, 'Team ID'),
      scopeType,
      readIdentifier(scopeId, 'Budget scope ID'),
    )
  }

  /** Saves a budget without the public idempotency wrapper. */
  private async saveBudgetInternal(
    input: SaveTimeBudgetInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<TimeBudget> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const scopeId = readIdentifier(input.scopeId, 'Budget scope ID')
    const teamId = input.teamId
      ? readIdentifier(input.teamId, 'Team ID')
      : input.scopeType === 'team'
        ? scopeId
        : undefined
    if (input.scopeType === 'project' && !teamId) {
      throw new TimeTrackingError(400, 'TeamRequired', 'A Team is required for a Project budget.')
    }
    const resolvedTeamId = teamId ?? scopeId
    const amountMinor = requireMoney(input.amountMinor, 'Budget amount')
    const currency = validateCurrency(input.currency)
    const expectedRevision = requireInteger(input.expectedRevision, 'Budget revision', 0, Number.MAX_SAFE_INTEGER)
    validateOptionalDate(input.periodFrom, 'Budget period start')
    validateOptionalDate(input.periodTo, 'Budget period end')
    if (input.periodFrom && input.periodTo && input.periodFrom > input.periodTo) {
      throw new TimeTrackingError(400, 'InvalidBudgetPeriod', 'Budget period start must not be after its end.')
    }
    const period = input.periodBudget ? readBudgetPeriod(input.periodFrom, input.periodTo) : undefined
    if (period) {
      // Overlap is checked against the periods read now; two concurrent saves of overlapping
      // periods can both pass, which only adds a row the editor shows and the owner can delete.
      const others = (await this.repository.listBudgetPeriods(workspaceId, resolvedTeamId, input.scopeType, scopeId))
        .filter((budget) => budget.periodFrom !== period.from || budget.periodTo !== period.to)
      if (others.some((budget) => (budget.periodFrom ?? '') <= period.to && period.from <= (budget.periodTo ?? ''))) {
        throw new TimeTrackingError(409, 'TimeBudgetPeriodOverlap', 'The budget period overlaps another budget period of the same scope.')
      }
      if (expectedRevision === 0 && others.length >= MAX_BUDGET_PERIODS) {
        throw new TimeTrackingError(409, 'TimeBudgetPeriodLimit', `A scope can have at most ${MAX_BUDGET_PERIODS} budget periods.`)
      }
    }
    const current = await this.repository.getBudget(workspaceId, resolvedTeamId, input.scopeType, scopeId, period)
    if (current && (current.revision !== expectedRevision || (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt))) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
    if (!current && expectedRevision !== 0) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget does not exist at the requested revision.')
    }
    const budget: TimeBudget = {
      schemaVersion: 1,
      workspaceId,
      teamId: resolvedTeamId,
      scopeType: input.scopeType,
      scopeId,
      amountMinor,
      currency,
      ...(input.periodFrom ? { periodFrom: input.periodFrom } : {}),
      ...(input.periodTo ? { periodTo: input.periodTo } : {}),
      ...(period ? { periodBudget: true } : {}),
      revision: expectedRevision + 1,
      updatedAt: readNow(this.now).toISOString(),
    }
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId: resolvedTeamId,
      actorUserId: input.updatedBy,
      eventType: 'time-budget.updated',
      entityType: 'time-budget',
      entityId: budgetAuditEntityId(budget),
      action: 'updated',
      idempotencyKey: input.idempotencyKey ?? this.createId(),
      requestBody: {
        action: 'budget.updated',
        scopeType: input.scopeType,
        scopeId,
        ...(period ? { periodFrom: period.from, periodTo: period.to } : {}),
        revision: budget.revision,
      },
      before: current ? toAuditBudgetSnapshot(current) : undefined,
      after: toAuditBudgetSnapshot(budget),
      includeFields: ['scopeType', 'scopeId', 'amountMinor', 'currency', 'periodFrom', 'periodTo', 'periodBudget', 'revision'],
      redactFields: ['amountMinor'],
      metadata: {
        scopeType: input.scopeType,
        scopeId,
        ...(input.scopeType === 'team' ? { teamId: scopeId } : { projectId: scopeId }),
      },
      path: input.scopeType === 'team'
        ? `/api/teams/${scopeId}/time-budget`
        : `/api/teams/${resolvedTeamId}/projects/${scopeId}/time-budget`,
      occurredAt: budget.updatedAt,
    })
    const idempotencyPut = completion ? await completion(budget) : undefined
    // The write also requires the update time read here, so a budget deleted and saved again
    // meanwhile at the same revision is not overwritten.
    await this.repository.saveBudget(
      budget,
      expectedRevision,
      auditPut,
      idempotencyPut,
      current?.updatedAt,
    )
    return budget
  }

  /**
   * Deletes one of a scope's budgets per period, at the revision the caller read.
   *
   * @param input - Scope, period, revision, and deleting manager.
   * @throws TimeTrackingError 404 when the scope has no budget for the period, 409 on a stale revision.
   */
  async deleteBudgetPeriod(input: DeleteTimeBudgetPeriodInput): Promise<void> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const scopeId = readIdentifier(input.scopeId, 'Budget scope ID')
    const period = readBudgetPeriod(input.periodFrom, input.periodTo)
    const expectedRevision = requireInteger(input.expectedRevision, 'Budget revision', 1, Number.MAX_SAFE_INTEGER)
    const current = await this.repository.getBudget(workspaceId, teamId, input.scopeType, scopeId, period)
    if (!current) throw new TimeTrackingError(404, 'TimeBudgetNotFound', 'The scope has no budget for that period.')
    if (current.revision !== expectedRevision || (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt)) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
    const deletedAt = readNow(this.now).toISOString()
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId,
      actorUserId: input.deletedBy,
      eventType: 'time-budget.deleted',
      entityType: 'time-budget',
      entityId: budgetAuditEntityId(current),
      action: 'deleted',
      idempotencyKey: this.createId(),
      requestBody: {
        action: 'budget.deleted',
        scopeType: input.scopeType,
        scopeId,
        periodFrom: period.from,
        periodTo: period.to,
        revision: current.revision,
      },
      before: toAuditBudgetSnapshot(current),
      after: undefined,
      includeFields: ['scopeType', 'scopeId', 'amountMinor', 'currency', 'periodFrom', 'periodTo', 'periodBudget', 'revision'],
      redactFields: ['amountMinor'],
      metadata: {
        scopeType: input.scopeType,
        scopeId,
        ...(input.scopeType === 'team' ? { teamId: scopeId } : { projectId: scopeId }),
      },
      path: input.scopeType === 'team'
        ? `/api/teams/${scopeId}/time-budget/periods/${period.from}/${period.to}`
        : `/api/teams/${teamId}/projects/${scopeId}/time-budget/periods/${period.from}/${period.to}`,
      occurredAt: deletedAt,
    })
    await this.repository.deleteBudgetPeriod(current, auditPut)
  }

  /**
   * Reads a Team's rate card, or an empty card at revision `0` when none is saved.
   *
   * Callers must already have checked that the reader may see confidential rates.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @param defaultCurrency - Currency of the empty card returned for an unsaved Team.
   * @returns The stored or empty rate card.
   */
  async getRateCard(workspaceId: string, teamId: string, defaultCurrency: string): Promise<TimeRateCard> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedTeamId = readIdentifier(teamId, 'Team ID')
    return await this.repository.getRateCard(normalizedWorkspaceId, normalizedTeamId) ?? {
      schemaVersion: 1,
      workspaceId: normalizedWorkspaceId,
      teamId: normalizedTeamId,
      currency: validateCurrency(defaultCurrency),
      memberRates: [],
      jobRoleRates: [],
      revision: 0,
    }
  }

  /**
   * Replaces a Team's rate card.
   *
   * @param input - Whole card, expected revision, and actor.
   * @returns The stored card.
   * @throws TimeTrackingError with `InvalidTimeRateCard` for an invalid card and
   *   `TimeRateCardRevisionConflict` when the card changed after it was read.
   */
  async saveRateCard(input: SaveTimeRateCardInput): Promise<TimeRateCard> {
    return await this.withIdempotency(
      input.workspaceId,
      input.updatedBy,
      input.idempotencyKey,
      'time-rate-card.save',
      input,
      (completion) => this.saveRateCardInternal(input, completion),
      readStoredRateCard,
    )
  }

  /**
   * Saves a rate card without the public idempotency wrapper.
   *
   * @param input - Whole card, expected revision, and actor.
   * @param completion - Idempotency receipt completion committed with the card.
   * @returns The stored card.
   */
  private async saveRateCardInternal(
    input: SaveTimeRateCardInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<TimeRateCard> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const updatedBy = readIdentifier(input.updatedBy, 'Actor user ID')
    const currency = validateCurrency(input.currency)
    if (!isKnownCurrencyCode(currency)) {
      throw new TimeTrackingError(400, 'InvalidCurrency', 'Currency must be a known ISO 4217 code.')
    }
    const memberRates = normalizeMemberRates(input.memberRates)
    const jobRoleRates = normalizeJobRoleRates(input.jobRoleRates)
    const expectedRevision = requireInteger(input.expectedRevision, 'Rate card revision', 0, Number.MAX_SAFE_INTEGER)
    const current = await this.repository.getRateCard(workspaceId, teamId)
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeRateCardRevisionConflict', 'The rate card was changed by another request.')
    }
    const rateCard: TimeRateCard = {
      schemaVersion: 1,
      workspaceId,
      teamId,
      currency,
      memberRates,
      jobRoleRates,
      revision: expectedRevision + 1,
      updatedAt: readNow(this.now).toISOString(),
      updatedBy,
    }
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId,
      actorUserId: updatedBy,
      eventType: 'time-rate-card.updated',
      entityType: 'time-rate-card',
      entityId: teamId,
      action: 'updated',
      idempotencyKey: input.idempotencyKey ?? this.createId(),
      requestBody: { action: 'rate-card.updated', teamId, revision: rateCard.revision },
      before: current ? toAuditRateCardSnapshot(current) : undefined,
      after: toAuditRateCardSnapshot(rateCard),
      includeFields: ['currency', 'memberRates', 'jobRoleRates', 'revision'],
      // The rows hold confidential rates, so the audit diff only says that they changed.
      redactFields: ['memberRates', 'jobRoleRates'],
      metadata: { teamId, memberRateCount: memberRates.length, jobRoleRateCount: jobRoleRates.length },
      path: `/api/teams/${teamId}/time-rate-card`,
      occurredAt: rateCard.updatedAt,
    })
    const idempotencyPut = completion ? await completion(rateCard) : undefined
    await this.repository.saveRateCard(rateCard, expectedRevision, auditPut, idempotencyPut)
    return rateCard
  }

  /**
   * Fills the rate of a new entry from the Team rate card when the request names none.
   *
   * The member's own rate wins over the rate of the member's job role. An applied rate brings the
   * card's currency, so the stored cost and its currency always agree.
   *
   * @param request - Team, member, requested currency, and requested rate of the new entry.
   * @returns The rate and currency to store; the request's own when the card does not apply.
   */
  private async resolveEntryRate(request: {
    workspaceId: string
    teamId: string
    userId: string
    currency: string
    hourlyRateMinor?: number
  }): Promise<{ currency: string; hourlyRateMinor?: number }> {
    const requested = {
      currency: request.currency,
      ...(request.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: request.hourlyRateMinor }),
    }
    if (request.hourlyRateMinor !== undefined) return requested
    const rateCard = await this.repository.getRateCard(request.workspaceId, request.teamId)
    const hourlyRateMinor = rateCard ? findDefaultHourlyRate(rateCard, request.userId) : undefined
    return rateCard && hourlyRateMinor !== undefined
      ? { currency: rateCard.currency, hourlyRateMinor }
      : requested
  }

  /**
   * Lists the closed months of a Team.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @returns Closed months in month order.
   */
  async listClosedPeriods(workspaceId: string, teamId: string): Promise<TimePeriodClose[]> {
    return await this.repository.listPeriodCloses(
      readIdentifier(workspaceId, 'Workspace ID'),
      readIdentifier(teamId, 'Team ID'),
    )
  }

  /**
   * Closes one month of a Team's time entries and records an audit event.
   *
   * @param input - Month, timezone, and closing manager.
   * @returns The stored close.
   */
  async closePeriod(input: CloseTimePeriodInput): Promise<TimePeriodClose> {
    return await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-period.close',
      input,
      (completion) => this.closePeriodInternal(input, completion),
      readPeriodCloseValue,
    )
  }

  /** Closes a month without the public idempotency wrapper. */
  private async closePeriodInternal(
    input: CloseTimePeriodInput,
    completion?: TimeTrackingIdempotencyCompletion,
    authorizationChecks: readonly TimeTrackingAuthorizationConditionCheck[] = [],
  ): Promise<TimePeriodClose> {
    validateTimeZone(input.timeZone)
    const close: TimePeriodClose = {
      schemaVersion: 1,
      workspaceId: readIdentifier(input.workspaceId, 'Workspace ID'),
      teamId: readIdentifier(input.teamId, 'Team ID'),
      month: readMonth(input.month),
      timeZone: input.timeZone,
      closedBy: readIdentifier(input.actorUserId, 'Actor user ID'),
      closedAt: readNow(this.now).toISOString(),
    }
    // Resolve the boundaries now so a stored close can never break later overlap checks.
    monthBounds(close.month, close.timeZone)
    const auditPut = this.createPeriodAuditPut(close, 'closed', close.closedBy, input.idempotencyKey ?? this.createId(), close.closedAt)
    const idempotencyPut = completion ? await completion(close) : undefined
    await this.repository.createPeriodClose(close, auditPut, idempotencyPut, authorizationChecks)
    return close
  }

  /**
   * Reopens a closed month and records the reason in an audit event.
   *
   * @param input - Month, reason, and reopening manager.
   * @returns The close that was removed.
   */
  async reopenPeriod(input: ReopenTimePeriodInput): Promise<TimePeriodClose> {
    return await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-period.reopen',
      input,
      (completion) => this.reopenPeriodInternal(input, completion),
      readPeriodCloseValue,
    )
  }

  /** Reopens a month without the public idempotency wrapper. */
  private async reopenPeriodInternal(
    input: ReopenTimePeriodInput,
    completion?: TimeTrackingIdempotencyCompletion,
    authorizationChecks: readonly TimeTrackingAuthorizationConditionCheck[] = [],
  ): Promise<TimePeriodClose> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const month = readMonth(input.month)
    const actorUserId = readIdentifier(input.actorUserId, 'Actor user ID')
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new TimeTrackingError(400, 'ReopenReasonRequired', 'A reason is required to reopen a closed month.')
    }
    const reason = readText(input.reason, 'Reason', MAX_DESCRIPTION_LENGTH)
    const close = (await this.repository.listPeriodCloses(workspaceId, teamId)).find((candidate) => candidate.month === month)
    if (!close) throw new TimeTrackingError(404, 'TimePeriodNotClosed', `${month} is not closed.`)
    const auditPut = this.createPeriodAuditPut(
      close,
      'reopened',
      actorUserId,
      input.idempotencyKey ?? this.createId(),
      readNow(this.now).toISOString(),
      reason,
    )
    const idempotencyPut = completion ? await completion(close) : undefined
    await this.repository.deletePeriodClose(close, auditPut, idempotencyPut, authorizationChecks)
    return close
  }

  /**
   * Reads one month's close state for every listed Team of a Workspace.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamIds - Teams to read.
   * @param month - Month as `YYYY-MM`.
   * @returns Each Team with its close, in Team order.
   */
  async listWorkspacePeriodCloses(
    workspaceId: string,
    teamIds: readonly string[],
    month: string,
  ): Promise<WorkspaceTimePeriodTeamState[]> {
    const resolvedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const resolvedMonth = readMonth(month)
    return await Promise.all(readWorkspaceTeamIds(teamIds).map(async (teamId) => {
      const close = (await this.repository.listPeriodCloses(resolvedWorkspaceId, teamId))
        .find((candidate) => candidate.month === resolvedMonth)
      return close ? { teamId, close } : { teamId }
    }))
  }

  /**
   * Closes one month for every listed Team, recording each Team's close in its own audit event.
   *
   * A Team whose month is already closed keeps its close. A Team that fails is reported, and the
   * other Teams are still closed, so a retry closes only what is left.
   *
   * @param input - Teams, month, timezone, and closing administrator.
   * @returns The outcome for each Team.
   */
  async closeWorkspacePeriod(input: CloseWorkspaceTimePeriodInput): Promise<WorkspaceTimePeriodResult> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const month = readMonth(input.month)
    validateTimeZone(input.timeZone)
    monthBounds(month, input.timeZone)
    const actorUserId = readIdentifier(input.actorUserId, 'Actor user ID')
    const results: WorkspaceTimePeriodTeamResult[] = []
    for (const teamId of readWorkspaceTeamIds(input.teamIds)) {
      try {
        await this.closePeriodInternal(
          { workspaceId, teamId, month, timeZone: input.timeZone, actorUserId },
          undefined,
          input.authorizationConditionChecks,
        )
        results.push({ teamId, status: 'closed' })
      } catch (error) {
        if (error instanceof TimeTrackingError && error.code === 'TimePeriodAlreadyClosed') {
          results.push({ teamId, status: 'already-closed' })
        } else {
          logWorkspacePeriodFailure('close', { workspaceId, teamId, month, correlationId: input.correlationId }, error)
          results.push({ teamId, status: 'failed' })
        }
      }
    }
    return { month, results, partialFailure: results.some((result) => result.status === 'failed') }
  }

  /**
   * Reopens one month for every listed Team, recording the reason in each Team's audit event.
   *
   * @param input - Teams, month, reason, and reopening administrator.
   * @returns The outcome for each Team.
   */
  async reopenWorkspacePeriod(input: ReopenWorkspaceTimePeriodInput): Promise<WorkspaceTimePeriodResult> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const month = readMonth(input.month)
    const actorUserId = readIdentifier(input.actorUserId, 'Actor user ID')
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw new TimeTrackingError(400, 'ReopenReasonRequired', 'A reason is required to reopen a closed month.')
    }
    readText(input.reason, 'Reason', MAX_DESCRIPTION_LENGTH)
    const results: WorkspaceTimePeriodTeamResult[] = []
    for (const teamId of readWorkspaceTeamIds(input.teamIds)) {
      try {
        await this.reopenPeriodInternal(
          { workspaceId, teamId, month, actorUserId, reason: input.reason },
          undefined,
          input.authorizationConditionChecks,
        )
        results.push({ teamId, status: 'reopened' })
      } catch (error) {
        if (error instanceof TimeTrackingError && error.code === 'TimePeriodNotClosed') {
          results.push({ teamId, status: 'not-closed' })
        } else {
          logWorkspacePeriodFailure('reopen', { workspaceId, teamId, month, correlationId: input.correlationId }, error)
          results.push({ teamId, status: 'failed' })
        }
      }
    }
    return { month, results, partialFailure: results.some((result) => result.status === 'failed') }
  }

  /**
   * Rejects a change to time inside a closed month.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @param intervals - Intervals the change reads or writes.
   * @returns The close state the write must still match when it commits.
   * @throws TimeTrackingError with `TimePeriodClosed` when any interval overlaps a closed month.
   */
  private async requireOpenPeriod(
    workspaceId: string,
    teamId: string,
    intervals: ReadonlyArray<{ startAt: string; endAt: string }>,
  ): Promise<TimePeriodGuard> {
    const closes = await this.repository.listPeriodCloses(workspaceId, teamId)
    for (const close of closes) {
      const bounds = monthBounds(close.month, close.timeZone)
      const overlaps = intervals.some((interval) =>
        Date.parse(interval.endAt) > bounds.start && Date.parse(interval.startAt) < bounds.end)
      if (overlaps) {
        throw new TimeTrackingError(409, 'TimePeriodClosed', `Time in ${close.month} is closed. Ask a manager to reopen the month first.`)
      }
    }
    const closedAtByMonth = new Map(closes.map((close) => [close.month, close.closedAt]))
    return {
      workspaceId,
      teamId,
      months: candidateCloseMonths(intervals).map((month) => {
        const closedAt = closedAtByMonth.get(month)
        return closedAt === undefined ? { month } : { month, closedAt }
      }),
    }
  }

  /** Creates the shared audit event for a month close or reopen. */
  private createPeriodAuditPut(
    close: TimePeriodClose,
    action: 'closed' | 'reopened',
    actorUserId: string,
    idempotencyKey: string,
    occurredAt: string,
    reason?: string,
  ): AuditTransactWriteItem | undefined {
    const snapshot = { teamId: close.teamId, month: close.month, timeZone: close.timeZone, closedBy: close.closedBy, closedAt: close.closedAt }
    return this.createAuditEventPut({
      workspaceId: close.workspaceId,
      teamId: close.teamId,
      actorUserId,
      eventType: `time-period.${action}`,
      entityType: 'time-period',
      entityId: `${close.teamId}:${close.month}`,
      action,
      idempotencyKey,
      requestBody: { action: `time-period.${action}`, month: close.month, ...(reason ? { reason } : {}) },
      ...(action === 'closed' ? { after: snapshot } : { before: snapshot }),
      includeFields: ['teamId', 'month', 'timeZone', 'closedBy', 'closedAt'],
      metadata: { teamId: close.teamId, month: close.month, ...(reason ? { reason } : {}) },
      path: `/api/teams/${close.teamId}/time-periods/${close.month}/${action === 'closed' ? 'close' : 'reopen'}`,
      occurredAt,
    })
  }

  /**
   * Reads a Team's time entry policy.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @returns The saved policy, or the defaults at revision 0.
   */
  async getEntryPolicy(workspaceId: string, teamId: string): Promise<TeamTimeEntryPolicyRecord> {
    const stored = await this.repository.getEntryPolicy(
      readIdentifier(workspaceId, 'Workspace ID'),
      readIdentifier(teamId, 'Team ID'),
    )
    return stored ? toEntryPolicyRecord(stored) : { ...DEFAULT_TEAM_TIME_ENTRY_POLICY, teamId, revision: 0 }
  }

  /**
   * Saves a Team's time entry policy and records it in the audit log.
   *
   * @param input - Policy, expected revision, and the saving manager.
   * @returns The saved policy.
   * @throws TimeTrackingError When the policy is invalid or the revision changed.
   */
  async saveEntryPolicy(input: SaveTeamTimeEntryPolicyInput): Promise<TeamTimeEntryPolicyRecord> {
    return toEntryPolicyRecord(await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-entry-policy.save',
      input,
      (completion) => this.saveEntryPolicyInternal(input, completion),
      readStoredEntryPolicy,
    ))
  }

  /** Saves a Team time entry policy without the public idempotency wrapper. */
  private async saveEntryPolicyInternal(
    input: SaveTeamTimeEntryPolicyInput,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<StoredTeamTimeEntryPolicy> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const actorUserId = readIdentifier(input.actorUserId, 'Actor user ID')
    const policy = readTeamTimeEntryPolicy(input.policy)
    if (!policy) {
      throw new TimeTrackingError(400, 'InvalidTimeEntryPolicy', 'Check modes must be off, warn, or reject, and the daily limit 1 to 1440 minutes.')
    }
    const expectedRevision = requireInteger(input.expectedRevision, 'Policy revision', 0, Number.MAX_SAFE_INTEGER)
    const current = await this.repository.getEntryPolicy(workspaceId, teamId)
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEntryPolicyRevisionConflict', 'The time entry policy was changed by another request.')
    }
    const saved: StoredTeamTimeEntryPolicy = {
      schemaVersion: 1,
      workspaceId,
      teamId,
      ...policy,
      revision: expectedRevision + 1,
      updatedBy: actorUserId,
      updatedAt: readNow(this.now).toISOString(),
    }
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId,
      actorUserId,
      eventType: 'time-entry-policy.updated',
      entityType: 'time-entry-policy',
      entityId: teamId,
      action: 'updated',
      idempotencyKey: input.idempotencyKey ?? this.createId(),
      requestBody: { action: 'time-entry-policy.updated', teamId, ...policy, revision: saved.revision },
      before: current ? toAuditEntryPolicySnapshot(current) : toAuditEntryPolicySnapshot({ ...DEFAULT_TEAM_TIME_ENTRY_POLICY, revision: 0 }),
      after: toAuditEntryPolicySnapshot(saved),
      includeFields: ['overlap', 'dailyLimit', 'dailyLimitMinutes', 'revision'],
      metadata: { teamId },
      path: `/api/teams/${teamId}/time-entry-policy`,
      occurredAt: saved.updatedAt,
    })
    const idempotencyPut = completion ? await completion(saved) : undefined
    await this.repository.saveEntryPolicy(saved, expectedRevision, auditPut, idempotencyPut)
    return saved
  }

  /**
   * Applies the Team's overlap and daily total checks to an entry about to be saved.
   *
   * Entries are compared with the same member's other entries in the Team. Days are local days
   * in the Workspace time zone. An entry recorded as a date and minutes has no meaningful time of
   * day, so it counts toward daily totals but never overlaps. The check reads the date index,
   * which is eventually consistent, so two entries saved at the same moment may both pass.
   *
   * @param entry - Entry as it will be saved.
   * @returns Warnings for the checks the Team only warns about.
   * @throws TimeTrackingError When the entry breaks a check the Team rejects.
   */
  private async checkEntryPolicy(entry: TimeEntry): Promise<TimeEntryPolicyWarning[]> {
    const policy = (await this.repository.getEntryPolicy(entry.workspaceId, entry.teamId)) ?? DEFAULT_TEAM_TIME_ENTRY_POLICY
    if (policy.overlap === 'off' && policy.dailyLimit === 'off') return []
    const timeZone = await this.categories?.readTimeZone?.(entry.workspaceId) ?? DEFAULT_WORKSPACE_TIME_ZONE
    const start = Date.parse(entry.startAt)
    const end = Date.parse(entry.endAt)
    const firstDate = localDateAt(start, timeZone)
    const lastDate = localDateAt(Math.max(start, end - 1), timeZone)
    const rangeStart = resolveLocalDateStart(firstDate, timeZone)
    const rangeEnd = resolveLocalDateStart(addCalendarDays(lastDate, 1), timeZone)
    const others = (await this.repository.listEntries({
      workspaceId: entry.workspaceId,
      teamId: entry.teamId,
      userId: entry.userId,
      from: new Date(rangeStart).toISOString(),
      to: new Date(rangeEnd).toISOString(),
    })).filter((other) => other.id !== entry.id && other.userId === entry.userId)
    const warnings: TimeEntryPolicyWarning[] = []
    if (policy.overlap !== 'off' && entry.durationOnly !== true) {
      const overlapping = others
        .filter((other) => other.durationOnly !== true && Date.parse(other.startAt) < end && Date.parse(other.endAt) > start)
        .map((other) => other.id)
      if (overlapping.length > 0) {
        if (policy.overlap === 'reject') {
          throw new TimeTrackingError(409, 'TimeEntryOverlap', 'This time overlaps another entry of yours.')
        }
        warnings.push({ code: 'TimeEntryOverlap', entryIds: overlapping })
      }
    }
    if (policy.dailyLimit !== 'off') {
      for (let date = firstDate; date <= lastDate; date = addCalendarDays(date, 1)) {
        const minutes = [...others, entry].reduce((total, candidate) => total + entryMinutesOnDate(candidate, date, timeZone), 0)
        if (minutes <= policy.dailyLimitMinutes) continue
        if (policy.dailyLimit === 'reject') {
          throw new TimeTrackingError(409, 'TimeEntryDailyLimitExceeded', `Time on ${date} would exceed the Team's daily limit of ${policy.dailyLimitMinutes} minutes.`)
        }
        warnings.push({ code: 'TimeEntryDailyLimitExceeded', date, minutes, limitMinutes: policy.dailyLimitMinutes })
      }
    }
    return warnings
  }

  /** Builds an ACL-filtered aggregate report. */
  async createSummary(input: TimeTrackingReportInput): Promise<TimeTrackingSummary> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listReportEntries(input, period)
    const estimateByWorkItem = await this.listPlannedEffort(input.workspaceId, input.teamId)
    const categoryLabels = input.groupBy === 'category'
      ? readCategoryLabels(await this.readCategorySettings(input.workspaceId))
      : undefined
    const weekStartDay = input.groupBy === 'week' ? await this.readWeekStartDay(input.workspaceId) : undefined
    const groups = aggregateEntries(entries, input.groupBy, input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds, categoryLabels, weekStartDay)
    const includeBudget = input.includeCosts && (
      input.budgetScope !== 'project' ||
      input.managedProjectIds === undefined ||
      (input.budgetScopeId !== undefined && input.managedProjectIds.has(input.budgetScopeId))
    )
    const budgetScope: { scopeType: 'team' | 'project'; scopeId: string } = input.budgetScope === 'project' && input.budgetScopeId
      ? { scopeType: 'project', scopeId: input.budgetScopeId }
      : { scopeType: 'team', scopeId: input.teamId }
    const budgetPeriods = includeBudget
      ? await this.repository.listBudgetPeriods(input.workspaceId, input.teamId, budgetScope.scopeType, budgetScope.scopeId)
      : undefined
    // A budget for exactly the report period is the one to compare; otherwise the default budget.
    // Both are compared as instants in the report timezone, since a report may name its period either way.
    const periodBudget = budgetPeriods?.find((candidate) => {
      if (!candidate.periodFrom || !candidate.periodTo) return false
      const candidatePeriod = normalizePeriod(candidate.periodFrom, candidate.periodTo, input.timeZone)
      return candidatePeriod.from === period.from && candidatePeriod.to === period.to
    })
    const budget = !includeBudget
      ? undefined
      : periodBudget ?? await this.repository.getBudget(input.workspaceId, input.teamId, budgetScope.scopeType, budgetScope.scopeId)
    const totalEstimateMinutes = [...new Set(entries.flatMap((entry) => entry.workItemId === undefined ? [] : [entry.workItemId]))]
      .reduce((sum, workItemId) => sum + (estimateByWorkItem.get(workItemId) ?? 0), 0)
    const totalActualCostByCurrency = input.includeCosts
      ? sumCostsByCurrency(entries, period.from, period.to, input.managedProjectIds)
      : undefined
    return {
      from: period.from,
      to: period.to,
      timeZone: input.timeZone,
      groupBy: input.groupBy,
      groups,
      totalMinutes: entries.reduce((sum, entry) => sum + clippedEntryMinutes(entry, period.from, period.to), 0),
      totalBillableMinutes: entries.reduce((sum, entry) => sum + (entry.billable ? clippedEntryMinutes(entry, period.from, period.to) : 0), 0),
      totalEstimateMinutes,
      ...(totalActualCostByCurrency === undefined ? {} : { totalActualCostByCurrency }),
      ...(totalActualCostByCurrency !== undefined && Object.keys(totalActualCostByCurrency).length === 1
        ? { totalActualCostMinor: Object.values(totalActualCostByCurrency)[0] }
        : {}),
      ...(budget ? { budget } : {}),
      ...(budgetPeriods && budgetPeriods.length > 0 ? { budgetPeriods } : {}),
      costsRedacted: !input.includeCosts,
      canManageTeam: input.viewer?.canManage ?? true,
    }
  }

  /**
   * Reads the budget of each Project and totals the billable cost recorded against it within its
   * period up to now, with one bounded read of the Team's time entries.
   *
   * The caller decides which Projects' costs the reader may see; this method totals every
   * member's billable entries in the given Projects, as a Project budget report does for a
   * manager of those Projects.
   *
   * @param input - Team, Projects, calendar, clock, and entry read limit.
   * @returns Budget and cost of each Project that has a budget, keyed by Project ID.
   * @throws TimeTrackingError 413 when the budget periods hold more entries than the limit.
   */
  async summarizeProjectBudgets(input: ProjectBudgetConsumptionInput): Promise<Map<string, ProjectBudgetConsumption>> {
    validateTimeZone(input.timeZone)
    const budgets = new Map<string, TimeBudget>()
    for (const projectId of input.projectIds) {
      const budget = await this.repository.getBudget(input.workspaceId, input.teamId, 'project', projectId)
      if (budget) budgets.set(projectId, budget)
    }
    const result = new Map<string, ProjectBudgetConsumption>()
    if (budgets.size === 0) return result
    const nowInstant = input.now.toISOString()
    const today = localDateAt(input.now.getTime(), input.timeZone)
    const periods = new Map<string, { from?: string; to: string }>()
    for (const [projectId, budget] of budgets) {
      const from = budget.periodFrom === undefined
        ? undefined
        : new Date(resolveLocalDateStart(budget.periodFrom, input.timeZone)).toISOString()
      // A period still running ends now; only an ended period needs the day after its end, which
      // also keeps far-future end dates such as 9999-12-31 out of the date arithmetic.
      const periodEnd = budget.periodTo === undefined || budget.periodTo >= today
        ? nowInstant
        : new Date(resolveLocalDateStart(addCalendarDays(budget.periodTo, 1), input.timeZone)).toISOString()
      const to = periodEnd < nowInstant ? periodEnd : nowInstant
      periods.set(projectId, { ...(from === undefined ? {} : { from }), to })
    }
    // Projects that share a budget period are read together, and each read covers only its own
    // period, so entries outside a Project's period neither cost reads nor count toward the limit.
    const groups = new Map<string, { from?: string; to: string; projectIds: Set<string> }>()
    for (const [projectId, period] of periods) {
      if (period.from !== undefined && !(period.from < period.to)) continue
      const key = `${period.from ?? ''}|${period.to}`
      const group = groups.get(key) ?? { ...period, projectIds: new Set<string>() }
      group.projectIds.add(projectId)
      groups.set(key, group)
    }
    const entries: TimeEntry[] = []
    for (const group of groups.values()) {
      const remaining = input.entryLimit - entries.length
      const read = await this.listAllEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        ...(group.from === undefined ? {} : { from: group.from }),
        to: group.to,
        projectIds: group.projectIds,
        limit: remaining + 1,
      })
      if (read.length > remaining) {
        throw new TimeTrackingError(
          413,
          'PortfolioTooLarge',
          `This Team has more than ${input.entryLimit} time entries in its Project budget periods.`,
        )
      }
      entries.push(...read)
    }
    const totals = new Map<string, { actualCostMinor: number; hasOtherCurrencyCost: boolean }>()
    for (const projectId of budgets.keys()) totals.set(projectId, { actualCostMinor: 0, hasOtherCurrencyCost: false })
    for (const entry of entries) {
      if (entry.projectId === undefined) continue
      const budget = budgets.get(entry.projectId)
      const period = periods.get(entry.projectId)
      const total = totals.get(entry.projectId)
      if (!budget || !period || !total || (period.from !== undefined && !(period.from < period.to))) continue
      const cost = costForEntry(entry, clippedEntryMinutes(entry, period.from ?? new Date(0).toISOString(), period.to), true)
      if (cost === undefined) continue
      if (entry.currency !== budget.currency) {
        total.hasOtherCurrencyCost = true
        continue
      }
      total.actualCostMinor += cost
      if (!Number.isSafeInteger(total.actualCostMinor)) {
        throw new TimeTrackingError(
          422,
          'PortfolioCostOverflow',
          `The billable cost of Project "${entry.projectId}" is too large to total exactly.`,
        )
      }
    }
    for (const [projectId, budget] of budgets) {
      const total = totals.get(projectId) ?? { actualCostMinor: 0, hasOtherCurrencyCost: false }
      result.set(projectId, { budget, ...total })
    }
    return result
  }

  /** Builds daily and weekly timesheet rows with DST-aware local boundaries. */
  async createTimesheet(input: TimeTrackingReportInput): Promise<TimeSheet> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listReportEntries(input, period)
    const estimateByWorkItem = await this.listPlannedEffort(input.workspaceId, input.teamId)
    const days = aggregateCalendarEntries(entries, 'day', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
    const weekStartDay = await this.readWeekStartDay(input.workspaceId)
    const weeks = aggregateCalendarEntries(entries, 'week', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds, weekStartDay)
    return {
      from: period.from,
      to: period.to,
      timeZone: input.timeZone,
      days,
      weeks,
      costsRedacted: !input.includeCosts,
      canManageTeam: input.viewer?.canManage ?? true,
    }
  }

  /**
   * Reads the entries a report may total.
   *
   * With a viewer, entries without a Project are read too, and the result keeps the viewer's
   * own entries plus, for a Team time manager, other members' entries in managed Projects and
   * without a Project.
   *
   * @param input - Report query with the caller's Project allowlist and viewer.
   * @param period - Normalized report period.
   * @returns Entries visible to the viewer in the period.
   */
  private async listReportEntries(
    input: TimeTrackingReportInput,
    period: { from: string; to: string },
  ): Promise<TimeEntry[]> {
    const entries = await this.listAllEntries({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      from: period.from,
      to: period.to,
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
      ...(input.viewer ? { includeUnassigned: true } : {}),
    })
    const viewer = input.viewer
    if (!viewer || viewer.includeAllMembers) return entries
    return entries.filter((entry) =>
      entry.userId === viewer.userId ||
      (viewer.canManage && canManageEntryProject(entry, input.managedProjectIds))
    )
  }

  /**
   * Reads the canonical Work Item estimates of a Team for a report.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @returns Planned minutes keyed by Work Item ID; empty without an estimate source.
   */
  private async listPlannedEffort(workspaceId: string, teamId: string): Promise<ReadonlyMap<string, number>> {
    return this.estimates ? await this.estimates.listPlannedEffort(workspaceId, teamId) : new Map()
  }

  /** Creates a CSV export using the same ACL-filtered report data as JSON. */
  async createCsv(input: TimeTrackingReportInput): Promise<string> {
    const summary = await this.createSummary(input)
    const lines = [
      ['Group', 'Minutes', 'Billable minutes', 'Entries', 'Estimate minutes', 'Actual cost minor', 'Actual cost by currency'].map(csvCell).join(','),
      ...summary.groups.map((group) => [
        group.label,
        group.minutes,
        group.billableMinutes,
        group.entryCount,
        group.estimateMinutes ?? '',
        group.actualCostMinor ?? '',
        group.actualCostByCurrency ? JSON.stringify(group.actualCostByCurrency) : '',
      ].map(csvCell).join(',')),
    ]
    return `${lines.join('\n')}\n`
  }

  /** Reserves and completes a durable mutation receipt when a key is supplied. */
  private async withIdempotency<T>(
    workspaceId: string,
    actorUserId: string,
    idempotencyKey: string | undefined,
    operation: string,
    requestInput: object,
    execute: (completion?: TimeTrackingIdempotencyCompletion) => Promise<T>,
    decode: (value: unknown) => T,
  ): Promise<T> {
    if (!this.idempotency || idempotencyKey === undefined) return await execute()
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedActorUserId = readIdentifier(actorUserId, 'Actor user ID')
    const normalizedKey = readIdentifier(idempotencyKey, 'Idempotency key')
    const requestFingerprint = createTimeTrackingRequestFingerprint(operation, requestInput)
    const receiptRequest = {
      workspaceId: normalizedWorkspaceId,
      credentialId: `time-tracking:${normalizedActorUserId}`,
      idempotencyKey: normalizedKey,
      requestFingerprint,
    }
    const reservation = await this.idempotency.reserveIdempotency(receiptRequest)
    if (reservation.status === 'replay') return decode(reservation.response)
    if (reservation.status === 'in-progress') {
      throw new TimeTrackingError(409, 'TimeTrackingMutationInProgress', 'The same time tracking mutation is still in progress.')
    }
    const completionRequest = { ...receiptRequest, reservationId: reservation.reservationId }
    let mutationCommitted = false
    try {
      const completion = this.idempotency.prepareIdempotencyCompletion
        ? async (response: unknown): Promise<AuditTransactWriteItem> =>
          await this.idempotency!.prepareIdempotencyCompletion!({
            ...completionRequest,
            response,
          })
        : undefined
      const result = await execute(completion)
      mutationCommitted = true
      if (!completion) {
        await this.idempotency.completeIdempotency({ ...completionRequest, response: result })
      }
      return result
    } catch (error) {
      if (!mutationCommitted && canReleaseTimeTrackingIdempotencyReservation(error)) {
        await this.idempotency.releaseIdempotency(completionRequest).catch(() => undefined)
      }
      throw error
    }
  }

  /** Requires an entry and optionally checks its Team partition. */
  private async requireEntry(workspaceId: string, entryId: string, teamId?: string): Promise<TimeEntry> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedEntryId = readIdentifier(entryId, 'Time entry ID')
    if (teamId) {
      const entry = await this.repository.getEntry(normalizedWorkspaceId, readIdentifier(teamId, 'Team ID'), normalizedEntryId)
      if (!entry) throw new TimeTrackingError(404, 'TimeEntryNotFound', 'The time entry was not found.')
      return entry
    }
    throw new TimeTrackingError(400, 'TeamRequired', 'A Team is required to resolve a time entry.')
  }

  /** Creates the shared immutable audit event for one time-entry mutation. */
  private createAuditPut(
    entry: TimeEntry,
    history: TimeEntryHistory,
    before?: TimeEntry,
    idempotencyKey = history.id,
  ): AuditTransactWriteItem | undefined {
    return this.createAuditEventPut({
      workspaceId: entry.workspaceId,
      teamId: entry.teamId,
      actorUserId: history.actorUserId,
      eventType: `time-entry.${history.action}`,
      entityType: 'time-entry',
      entityId: entry.id,
      action: history.action,
      idempotencyKey,
      requestBody: { action: history.action, entryId: entry.id, revision: entry.revision },
      before: before ? toAuditEntrySnapshot(before) : undefined,
      after: toAuditEntrySnapshot(entry),
      includeFields: TIME_ENTRY_AUDIT_FIELDS,
      redactFields: ['hourlyRateMinor', 'actualCostMinor'],
      metadata: {
        ...createEntryAuditMetadata(entry),
        ...(history.reason ? { reason: history.reason } : {}),
      },
      path: `/api/teams/${entry.teamId}/time-entries/${entry.id}`,
      occurredAt: history.occurredAt,
    })
  }

  /** Creates a shared immutable audit event and transaction item. */
  private createAuditEventPut(
    input: TimeTrackingAuditMutation,
  ): AuditTransactWriteItem | undefined {
    if (!this.audit) return undefined
    const context = createMutationAuditContext({
      workspaceId: input.workspaceId,
      actor: { id: input.actorUserId, kind: 'user' },
      idempotencyKey: input.idempotencyKey,
      request: {
        method: 'TIME_TRACKING',
        path: input.path,
        body: input.requestBody,
      },
      source: { kind: 'api', route: 'time-tracking' },
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    const event = createAuditEvent({
      context,
      eventType: input.eventType,
      entity: { type: input.entityType, id: input.entityId },
      action: input.action,
      before: input.before,
      after: input.after,
      diff: {
        includeFields: input.includeFields,
        ...(input.redactFields ? { redactFields: input.redactFields } : {}),
      },
      summary: `Time tracking ${input.action}`,
      metadata: input.metadata,
      expiresAt: calculateAuditExpiresAt(context.occurredAt, this.audit.retentionDays),
    })
    return createAuditEventTransactPut(this.audit.tableName, event)
  }
}

/** Returns whether a failed mutation definitely did not commit its idempotency-bound state. */
function canReleaseTimeTrackingIdempotencyReservation(error: unknown): boolean {
  return error instanceof TimeTrackingError && error.status < 500
}

/** In-memory repository for isolated application tests and local development. */
export class InMemoryTimeTrackingRepository implements TimeTrackingRepository {
  /** Stored entries keyed by Workspace, Team, and ID. */
  private readonly entries = new Map<string, TimeEntry>()
  /** Stored history records keyed by Workspace, Team, and entry ID. */
  private readonly histories = new Map<string, TimeEntryHistory[]>()
  /** Active timers keyed by Workspace and member. */
  private readonly timers = new Map<string, RunningTimer>()
  /** Stored budgets keyed by Workspace, scope type, and scope ID. */
  private readonly budgets = new Map<string, TimeBudget>()
  /** Closed months keyed by Workspace, Team, and month. */
  private readonly periodCloses = new Map<string, TimePeriodClose>()
  /** Team time entry policies keyed by Workspace and Team. */
  private readonly entryPolicies = new Map<string, StoredTeamTimeEntryPolicy>()

  /** Reads a Team time entry policy. */
  async getEntryPolicy(workspaceId: string, teamId: string): Promise<StoredTeamTimeEntryPolicy | undefined> {
    const policy = this.entryPolicies.get(`${workspaceId}\0${teamId}`)
    return policy ? clone(policy) : undefined
  }

  /** Saves a Team time entry policy at the expected revision. */
  async saveEntryPolicy(
    policy: StoredTeamTimeEntryPolicy,
    expectedRevision: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    const key = `${policy.workspaceId}\0${policy.teamId}`
    if ((this.entryPolicies.get(key)?.revision ?? 0) !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEntryPolicyRevisionConflict', 'The time entry policy was changed by another request.')
    }
    this.entryPolicies.set(key, clone(policy))
  }

  /** Rate cards keyed by Workspace and Team. */
  private readonly rateCards = new Map<string, TimeRateCard>()

  /** Reads a Team's rate card. */
  async getRateCard(workspaceId: string, teamId: string): Promise<TimeRateCard | undefined> {
    const rateCard = this.rateCards.get(`${workspaceId}#${teamId}`)
    return rateCard ? clone(rateCard) : undefined
  }

  /** Saves a rate card when it is still at the expected revision. */
  async saveRateCard(
    rateCard: TimeRateCard,
    expectedRevision: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    const key = `${rateCard.workspaceId}#${rateCard.teamId}`
    if ((this.rateCards.get(key)?.revision ?? 0) !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeRateCardRevisionConflict', 'The rate card was changed by another request.')
    }
    this.rateCards.set(key, clone(rateCard))
  }

  /** Lists a Team's closed months. */
  async listPeriodCloses(workspaceId: string, teamId: string): Promise<TimePeriodClose[]> {
    return [...this.periodCloses.values()]
      .filter((close) => close.workspaceId === workspaceId && close.teamId === teamId)
      .sort((left, right) => left.month.localeCompare(right.month))
      .map(clone)
  }

  /** Stores a month close unless the month is already closed. */
  async createPeriodClose(
    close: TimePeriodClose,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    const key = periodCloseKey(close.workspaceId, close.teamId, close.month)
    if (this.periodCloses.has(key)) throw new TimeTrackingError(409, 'TimePeriodAlreadyClosed', `${close.month} is already closed.`)
    this.periodCloses.set(key, clone(close))
  }

  /** Removes a month close while it is unchanged. */
  async deletePeriodClose(
    close: TimePeriodClose,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    const key = periodCloseKey(close.workspaceId, close.teamId, close.month)
    if (this.periodCloses.get(key)?.closedAt !== close.closedAt) {
      throw new TimeTrackingError(409, 'TimePeriodCloseConflict', `${close.month} was changed by another request.`)
    }
    this.periodCloses.delete(key)
  }

  /**
   * Rejects a write whose month close state changed after it was validated.
   *
   * @param guard - Close state the write was validated against.
   * @throws TimeTrackingError with `TimePeriodClosed` when any guarded month changed.
   */
  private requirePeriodGuard(guard: TimePeriodGuard | undefined): void {
    if (!guard) return
    for (const month of guard.months) {
      const current = this.periodCloses.get(periodCloseKey(guard.workspaceId, guard.teamId, month.month))
      if (current?.closedAt !== month.closedAt) throw periodGuardError()
    }
  }

  /** Lists matching entries. */
  async listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const from = input.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY
    const to = input.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY
    if (Number.isNaN(from) || Number.isNaN(to)) throw new TimeTrackingError(400, 'InvalidTimeRange', 'Time range is invalid.')
    const matching = [...this.entries.values()]
      .filter((entry) => entry.workspaceId === input.workspaceId && entry.teamId === input.teamId)
      .filter((entry) => input.userId === undefined || entry.userId === input.userId)
      .filter((entry) => input.status === undefined || entry.status === input.status)
      .filter((entry) => matchesProjectAllowlist(entry, input))
      .filter((entry) => Date.parse(entry.endAt) > from && Date.parse(entry.startAt) < to)
      .sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id))
    return (input.limit === undefined ? matching : matching.slice(0, input.limit)).map(clone)
  }

  /** Reads an entry. */
  async getEntry(workspaceId: string, teamId: string, entryId: string) {
    const entry = this.entries.get(memoryEntryKey(workspaceId, teamId, entryId))
    return entry ? clone(entry) : undefined
  }

  /** Saves an entry with a revision condition. */
  async saveEntry(entry: TimeEntry, expectedRevision?: number) {
    const key = memoryEntryKey(entry.workspaceId, entry.teamId, entry.id)
    const current = this.entries.get(key)
    if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    this.entries.set(key, clone(entry))
  }

  /** Saves an entry and history in one in-memory operation. */
  async saveEntryWithHistory(
    entry: TimeEntry,
    history: TimeEntryHistory,
    expectedRevision?: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ) {
    this.requirePeriodGuard(periodGuard)
    await this.saveEntry(entry, expectedRevision)
    await this.saveHistory(entry.workspaceId, entry.teamId, history)
  }

  /** Deletes a draft or rejected entry at the expected revision. */
  async deleteEntry(
    entry: TimeEntry,
    expectedRevision: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
    _authorizationChecks?: readonly TimeTrackingAuthorizationConditionCheck[],
  ) {
    this.requirePeriodGuard(periodGuard)
    const key = memoryEntryKey(entry.workspaceId, entry.teamId, entry.id)
    const current = this.entries.get(key)
    if (!current || current.revision !== expectedRevision || !isDeletableStatus(current.status)) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    this.entries.delete(key)
  }

  /** Saves immutable history. */
  async saveHistory(workspaceId: string, teamId: string, history: TimeEntryHistory) {
    const key = historyKey(workspaceId, teamId, history.entryId)
    const records = this.histories.get(key) ?? []
    records.push(clone(history))
    this.histories.set(key, records)
  }

  /** Lists immutable history. */
  async listHistory(workspaceId: string, teamId: string, entryId: string) {
    return (this.histories.get(historyKey(workspaceId, teamId, entryId)) ?? []).map(clone)
  }

  /** Reads the active timer. */
  async getActiveTimer(workspaceId: string, userId: string) {
    const timer = this.timers.get(timerKey(workspaceId, userId))
    return timer ? clone(timer) : undefined
  }

  /** Removes an active timer after verifying its identity. */
  async cancelTimer(
    timer: RunningTimer,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ) {
    const key = timerKey(timer.workspaceId, timer.userId)
    const current = this.timers.get(key)
    if (!current || current.id !== timer.id || current.revision !== timer.revision) {
      throw new TimeTrackingError(409, 'RunningTimerConflict', 'The running timer changed before it was cancelled.')
    }
    this.timers.delete(key)
  }

  /** Creates an active timer and rejects duplicates. */
  async createTimer(
    timer: RunningTimer,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ) {
    const key = timerKey(timer.workspaceId, timer.userId)
    if (this.timers.has(key)) throw new TimeTrackingError(409, 'RunningTimerAlreadyExists', 'Only one running timer is allowed per member.')
    this.timers.set(key, clone(timer))
  }

  /** Atomically replaces an active timer with its entry in this in-memory transaction. */
  async finishTimer(
    timer: RunningTimer,
    entry: TimeEntry,
    history: TimeEntryHistory,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ) {
    const key = timerKey(timer.workspaceId, timer.userId)
    const current = this.timers.get(key)
    if (!current || current.id !== timer.id || current.revision !== timer.revision) {
      throw new TimeTrackingError(409, 'RunningTimerConflict', 'The running timer changed before it was stopped.')
    }
    this.requirePeriodGuard(periodGuard)
    this.timers.delete(key)
    await this.saveEntry(entry)
    await this.saveHistory(entry.workspaceId, entry.teamId, history)
  }

  /** Reads a budget. */
  async getBudget(workspaceId: string, teamId: string, scopeType: 'team' | 'project', scopeId: string, period?: TimeBudgetPeriod) {
    const budget = this.budgets.get(budgetKey(workspaceId, teamId, scopeType, scopeId, period))
    return budget ? clone(budget) : undefined
  }

  /** Lists a scope's budgets per period in period order. */
  async listBudgetPeriods(workspaceId: string, teamId: string, scopeType: 'team' | 'project', scopeId: string) {
    const prefix = budgetPeriodKeyPrefix(budgetKey(workspaceId, teamId, scopeType, scopeId))
    return [...this.budgets.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, budget]) => clone(budget))
  }

  /** Deletes a budget per period at its read revision. */
  async deleteBudgetPeriod(budget: TimeBudget, _auditPut?: AuditTransactWriteItem) {
    const key = budgetKey(budget.workspaceId, budget.teamId, budget.scopeType, budget.scopeId, budgetStoragePeriod(budget))
    const current = this.budgets.get(key)
    if (current?.revision !== budget.revision || current.updatedAt !== budget.updatedAt) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
    this.budgets.delete(key)
  }

  /** Saves a budget. */
  async saveBudget(
    budget: TimeBudget,
    expectedRevision: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
    expectedUpdatedAt?: string,
  ) {
    const key = budgetKey(budget.workspaceId, budget.teamId, budget.scopeType, budget.scopeId, budgetStoragePeriod(budget))
    const current = this.budgets.get(key)
    if ((current?.revision ?? 0) !== expectedRevision || (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt)) throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    this.budgets.set(key, clone(budget))
  }
}

/** DynamoDB repository for durable time tracking state. */
export class DynamoDbTimeTrackingRepository implements TimeTrackingRepository {
  /** DynamoDB table name. */
  private readonly tableName: string
  /** Configured DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient

  /** Creates a DynamoDB time tracking repository. */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    this.tableName = readIdentifier(tableName, 'Time tracking table name')
    this.documentClient = documentClient
  }

  /** Lists Team entries using the date index whenever a range is supplied. */
  async listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const limit = input.limit ?? MAX_LIST_LIMIT
    const entries: TimeEntry[] = []
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey']
    const from = input.from === undefined ? undefined : normalizeEntryBoundary(input.from)
    const to = input.to === undefined ? undefined : normalizeEntryBoundary(input.to)
    const hasDateRange = from !== undefined || to !== undefined
    do {
      // DynamoDB allows one sort-key condition, so a closed range uses BETWEEN; its inclusive
      // upper bound is trimmed by the `startAt >= to` check below.
      const keyConditionParts = hasDateRange
        ? [
            'teamId = :teamId',
            ...(from && to
              ? ['startAt BETWEEN :queryFrom AND :queryTo']
              : from
                ? ['startAt >= :queryFrom']
                : ['startAt < :queryTo']),
          ]
        : ['workspaceId = :workspaceId', 'begins_with(recordKey, :prefix)']
      const expressionAttributeValues = hasDateRange
        ? {
            ':teamId': input.teamId,
            ...(from ? { ':queryFrom': new Date(Date.parse(from) - MAX_ENTRY_DURATION_MILLISECONDS).toISOString() } : {}),
            ...(to ? { ':queryTo': to } : {}),
            ':workspaceId': input.workspaceId,
            ':prefix': `${ENTRY_PREFIX}${input.teamId}#`,
            ...(from ? { ':from': from } : {}),
          }
        : {
            ':workspaceId': input.workspaceId,
            ':prefix': `${ENTRY_PREFIX}${input.teamId}#`,
          }
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        ...(hasDateRange ? { IndexName: TIME_ENTRY_DATE_INDEX_NAME } : {}),
        KeyConditionExpression: keyConditionParts.join(' AND '),
        ExpressionAttributeValues: expressionAttributeValues,
        ...(hasDateRange
          ? {
              FilterExpression: [
                'workspaceId = :workspaceId',
                'begins_with(recordKey, :prefix)',
                ...(from ? ['endAt > :from'] : []),
              ].join(' AND '),
            }
          : { ConsistentRead: true }),
        Limit: limit,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        const entry = readStoredEntry(item)
        if (input.userId !== undefined && entry.userId !== input.userId) continue
        if (input.status !== undefined && entry.status !== input.status) continue
        if (!matchesProjectAllowlist(entry, input)) continue
        const from = input.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY
        const to = input.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY
        if (Date.parse(entry.endAt) <= from || Date.parse(entry.startAt) >= to) continue
        entries.push(entry)
        if (input.limit !== undefined && entries.length === limit) break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey && (input.limit === undefined || entries.length < limit))
    return entries.sort(
      (left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id),
    )
  }

  /** Reads an entry. */
  async getEntry(workspaceId: string, teamId: string, entryId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: entryKey(teamId, entryId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredEntry(response.Item) : undefined
  }

  /** Saves an entry with a conditional revision. */
  async saveEntry(entry: TimeEntry, expectedRevision?: number) {
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...entry, recordKey: entryKey(entry.teamId, entry.id) },
        ...(expectedRevision === undefined
          ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
          : {
              ConditionExpression: 'revision = :expectedRevision',
              ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
            }),
      }))
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
  }

  /** Saves an entry and history in one DynamoDB transaction. */
  async saveEntryWithHistory(
    entry: TimeEntry,
    history: TimeEntryHistory,
    expectedRevision?: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ) {
    const guardChecks = createPeriodGuardChecks(this.tableName, periodGuard)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...guardChecks,
          {
            Put: {
              TableName: this.tableName,
              Item: { ...entry, recordKey: entryKey(entry.teamId, entry.id) },
              ...(expectedRevision === undefined
                ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
                : {
                    ConditionExpression: 'revision = :expectedRevision',
                    ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
                  }),
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...history,
                workspaceId: entry.workspaceId,
                recordKey: `${HISTORY_PREFIX}${entry.teamId}#${history.entryId}#${history.occurredAt}#${history.id}`,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...(auditPut ? [auditPut] : []),
          ...(idempotencyPut ? [idempotencyPut] : []),
        ],
      }))
    } catch (error) {
      if (isPeriodGuardFailure(error, guardChecks.length)) throw periodGuardError()
      throw mapConditionalWriteError(error, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
  }

  /** Deletes a draft or rejected entry with its audit event in one DynamoDB transaction. */
  async deleteEntry(
    entry: TimeEntry,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
    authorizationChecks: readonly TimeTrackingAuthorizationConditionCheck[] = [],
  ) {
    const guardChecks = createPeriodGuardChecks(this.tableName, periodGuard)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...guardChecks,
          {
            Delete: {
              TableName: this.tableName,
              Key: { workspaceId: entry.workspaceId, recordKey: entryKey(entry.teamId, entry.id) },
              ConditionExpression: 'revision = :expectedRevision AND #status IN (:draft, :rejected)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':expectedRevision': expectedRevision,
                ':draft': 'draft',
                ':rejected': 'rejected',
              },
            },
          },
          ...authorizationChecks,
          ...(auditPut ? [auditPut] : []),
          ...(idempotencyPut ? [idempotencyPut] : []),
        ],
      }))
    } catch (error) {
      if (isPeriodGuardFailure(error, guardChecks.length)) throw periodGuardError()
      if (isAuthorizationCheckOnlyFailure(error, guardChecks.length + 1, authorizationChecks.length)) {
        throw new TimeTrackingError(
          409,
          'TimeEntryAuthorizationChanged',
          'Your access to this Team changed before the entry was deleted. Reload and try again.',
        )
      }
      throw mapConditionalWriteError(error, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
  }

  /** Saves immutable history. */
  async saveHistory(workspaceId: string, teamId: string, history: TimeEntryHistory) {
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        ...history,
        workspaceId,
        recordKey: `${HISTORY_PREFIX}${teamId}#${history.entryId}#${history.occurredAt}#${history.id}`,
      },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    }))
  }

  /** Lists immutable history. */
  async listHistory(workspaceId: string, teamId: string, entryId: string) {
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': workspaceId,
        ':prefix': `${HISTORY_PREFIX}${teamId}#${entryId}#`,
      },
      ConsistentRead: true,
      ScanIndexForward: true,
    }))
    return (response.Items ?? []).map(readStoredHistory)
  }

  /** Reads the active timer. */
  async getActiveTimer(workspaceId: string, userId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: `${TIMER_PREFIX}${userId}` },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredTimer(response.Item) : undefined
  }

  /** Removes an active timer with a conditional identity check. */
  async cancelTimer(
    timer: RunningTimer,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ) {
    try {
      const deletion = {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: timer.workspaceId, recordKey: `${TIMER_PREFIX}${timer.userId}` },
          ConditionExpression: 'id = :timerId AND revision = :timerRevision',
          ExpressionAttributeValues: {
            ':timerId': timer.id,
            ':timerRevision': timer.revision,
          },
        },
      }
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [deletion, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new DeleteCommand(deletion.Delete))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'RunningTimerConflict', 'The running timer changed before it was cancelled.')
    }
  }

  /** Creates an active timer with a conditional put. */
  async createTimer(
    timer: RunningTimer,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ) {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...timer, recordKey: `${TIMER_PREFIX}${timer.userId}` },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      }
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [put, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'RunningTimerAlreadyExists', 'Only one running timer is allowed per member.')
    }
  }

  /** Deletes the active timer and creates its entry/history in one transaction. */
  async finishTimer(
    timer: RunningTimer,
    entry: TimeEntry,
    history: TimeEntryHistory,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    periodGuard?: TimePeriodGuard,
  ) {
    const guardChecks = createPeriodGuardChecks(this.tableName, periodGuard)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...guardChecks,
          {
            Delete: {
              TableName: this.tableName,
              Key: { workspaceId: timer.workspaceId, recordKey: `${TIMER_PREFIX}${timer.userId}` },
              ConditionExpression: 'id = :timerId AND revision = :timerRevision',
              ExpressionAttributeValues: {
                ':timerId': timer.id,
                ':timerRevision': timer.revision,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { ...entry, recordKey: entryKey(entry.teamId, entry.id) },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...history,
                workspaceId: entry.workspaceId,
                recordKey: `${HISTORY_PREFIX}${entry.teamId}#${history.entryId}#${history.occurredAt}#${history.id}`,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...(auditPut ? [auditPut] : []),
          ...(idempotencyPut ? [idempotencyPut] : []),
        ],
      }))
    } catch (error) {
      if (isPeriodGuardFailure(error, guardChecks.length)) throw periodGuardError()
      throw mapConditionalWriteError(error, 'RunningTimerConflict', 'The running timer changed before it was stopped.')
    }
  }

  /** Reads a Team or Project budget, or its budget for one period. */
  async getBudget(workspaceId: string, teamId: string, scopeType: 'team' | 'project', scopeId: string, period?: TimeBudgetPeriod) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: budgetRecordKey(teamId, scopeType, scopeId, period) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredBudget(response.Item) : undefined
  }

  /** Lists a scope's budgets per period with one prefix query, in period order. */
  async listBudgetPeriods(workspaceId: string, teamId: string, scopeType: 'team' | 'project', scopeId: string) {
    const budgets: TimeBudget[] = []
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey']
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': budgetPeriodKeyPrefix(budgetRecordKey(teamId, scopeType, scopeId)),
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        const budget = readStoredBudget(item)
        // An ID that contains `#` could share the prefix of another scope, so the row must name this one.
        if (budget.periodBudget && budget.teamId === teamId && budget.scopeType === scopeType && budget.scopeId === scopeId) {
          budgets.push(budget)
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return budgets
  }

  /** Deletes a budget per period while it is at the read revision, with its audit event. */
  async deleteBudgetPeriod(budget: TimeBudget, auditPut?: AuditTransactWriteItem) {
    const deletion = {
      Delete: {
        TableName: this.tableName,
        Key: {
          workspaceId: budget.workspaceId,
          recordKey: budgetRecordKey(budget.teamId, budget.scopeType, budget.scopeId, budgetStoragePeriod(budget)),
        },
        // A budget saved again after a delete restarts at the same revision, so its save time is checked too.
        ConditionExpression: 'revision = :expectedRevision AND updatedAt = :expectedUpdatedAt',
        ExpressionAttributeValues: { ':expectedRevision': budget.revision, ':expectedUpdatedAt': budget.updatedAt },
      },
    }
    try {
      if (auditPut) {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: [deletion, auditPut] }))
      } else {
        await this.documentClient.send(new DeleteCommand(deletion.Delete))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
  }

  /** Saves a budget with optimistic concurrency. */
  async saveBudget(
    budget: TimeBudget,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    expectedUpdatedAt?: string,
  ) {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...budget, recordKey: budgetRecordKey(budget.teamId, budget.scopeType, budget.scopeId, budgetStoragePeriod(budget)) },
          ...(expectedRevision === 0
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : expectedUpdatedAt === undefined
              ? {
                  ConditionExpression: 'revision = :expectedRevision',
                  ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
                }
              : {
                  ConditionExpression: 'revision = :expectedRevision AND updatedAt = :expectedUpdatedAt',
                  ExpressionAttributeValues: { ':expectedRevision': expectedRevision, ':expectedUpdatedAt': expectedUpdatedAt },
                }),
        },
      }
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [put, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
  }

  /** Reads a Team time entry policy with a consistent read. */
  async getEntryPolicy(workspaceId: string, teamId: string): Promise<StoredTeamTimeEntryPolicy | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: `${ENTRY_POLICY_PREFIX}${teamId}` },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    const policy = readStoredEntryPolicy(response.Item)
    if (policy.workspaceId !== workspaceId || policy.teamId !== teamId) {
      throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time entry policy scope does not match the requested key.')
    }
    return policy
  }

  /** Saves a Team time entry policy with optimistic concurrency, its audit event, and receipt. */
  async saveEntryPolicy(
    policy: StoredTeamTimeEntryPolicy,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    const put = {
      Put: {
        TableName: this.tableName,
        Item: { ...policy, recordKey: `${ENTRY_POLICY_PREFIX}${policy.teamId}` },
        ...(expectedRevision === 0
          ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
          : {
              ConditionExpression: 'revision = :expectedRevision',
              ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
            }),
      },
    }
    try {
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [put, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeEntryPolicyRevisionConflict', 'The time entry policy was changed by another request.')
    }
  }

  /** Reads a Team's rate card with a consistent read. */
  async getRateCard(workspaceId: string, teamId: string): Promise<TimeRateCard | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: `${RATE_CARD_PREFIX}${teamId}` },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    const rateCard = readStoredRateCard(response.Item)
    if (rateCard.workspaceId !== workspaceId || rateCard.teamId !== teamId) {
      throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored rate card scope does not match the requested key.')
    }
    return rateCard
  }

  /** Saves a rate card with optimistic concurrency, its audit event, and its receipt. */
  async saveRateCard(
    rateCard: TimeRateCard,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...rateCard, recordKey: `${RATE_CARD_PREFIX}${rateCard.teamId}` },
          ...(expectedRevision === 0
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {
                ConditionExpression: 'revision = :expectedRevision',
                ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
              }),
        },
      }
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [put, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeRateCardRevisionConflict', 'The rate card was changed by another request.')
    }
  }

  /** Lists a Team's closed months with a consistent prefix query. */
  async listPeriodCloses(workspaceId: string, teamId: string): Promise<TimePeriodClose[]> {
    const closes: TimePeriodClose[] = []
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey']
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': `${PERIOD_CLOSE_PREFIX}${teamId}#`,
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      closes.push(...(response.Items ?? []).map((item) => readStoredPeriodClose(item, workspaceId, teamId)))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return closes
  }

  /** Stores a month close with a conditional put, in a transaction when audited or fenced. */
  async createPeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    authorizationChecks: readonly TimeTrackingAuthorizationConditionCheck[] = [],
  ): Promise<void> {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...close, recordKey: periodCloseRecordKey(close.teamId, close.month) },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      }
      if (auditPut || idempotencyPut || authorizationChecks.length > 0) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            put,
            ...authorizationChecks,
            ...(auditPut ? [auditPut] : []),
            ...(idempotencyPut ? [idempotencyPut] : []),
          ],
        }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      if (isAuthorizationCheckOnlyFailure(error, 1, authorizationChecks.length)) throw periodAuthorizationChangedError()
      throw mapConditionalWriteError(error, 'TimePeriodAlreadyClosed', `${close.month} is already closed.`)
    }
  }

  /** Deletes a month close only while its close timestamp is unchanged. */
  async deletePeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
    authorizationChecks: readonly TimeTrackingAuthorizationConditionCheck[] = [],
  ): Promise<void> {
    try {
      const deletion = {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: close.workspaceId, recordKey: periodCloseRecordKey(close.teamId, close.month) },
          ConditionExpression: 'closedAt = :closedAt',
          ExpressionAttributeValues: { ':closedAt': close.closedAt },
        },
      }
      if (auditPut || idempotencyPut || authorizationChecks.length > 0) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            deletion,
            ...authorizationChecks,
            ...(auditPut ? [auditPut] : []),
            ...(idempotencyPut ? [idempotencyPut] : []),
          ],
        }))
      } else {
        await this.documentClient.send(new DeleteCommand(deletion.Delete))
      }
    } catch (error) {
      if (isAuthorizationCheckOnlyFailure(error, 1, authorizationChecks.length)) throw periodAuthorizationChangedError()
      throw mapConditionalWriteError(error, 'TimePeriodCloseConflict', `${close.month} was changed by another request.`)
    }
  }
}

/** Normalizes and validates a manual entry request. */
function normalizeCreateInput(input: CreateTimeEntryInput, canManageRates: boolean): NormalizedCreateTimeEntryInput {
  const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
  const teamId = readIdentifier(input.teamId, 'Team ID')
  const workItemId = input.workItemId === undefined ? undefined : readIdentifier(input.workItemId, 'Work Item ID')
  const category = input.category === undefined ? undefined : readCategory(input.category)
  requireWorkItemOrCategory(workItemId, category)
  const userId = readIdentifier(input.userId, 'User ID')
  const { startAt, endAt } = resolveCreateInterval(input)
  validateInterval(startAt, endAt)
  const currency = validateCurrency(input.currency)
  const hourlyRateMinor = input.hourlyRateMinor === undefined ? undefined : requireMoney(input.hourlyRateMinor, 'Hourly rate')
  if (hourlyRateMinor !== undefined && !canManageRates) {
    throw new TimeTrackingError(403, 'ConfidentialRateDenied', 'Only a manager may set an hourly rate.')
  }
  return {
    workspaceId,
    teamId,
    ...(input.projectId ? { projectId: readIdentifier(input.projectId, 'Project ID') } : {}),
    ...(workItemId ? { workItemId } : {}),
    userId,
    startAt,
    endAt,
    durationOnly: input.duration !== undefined,
    ...(category ? { category } : {}),
    ...(input.description ? { description: normalizeDescription(input.description) } : {}),
    billable: input.billable,
    currency,
    ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
    source: input.source,
  }
}

/**
 * Resolves the interval of a create request from either its times or its date and minutes.
 *
 * A date-and-minutes entry starts at local midnight of the date and must end within that date.
 *
 * @param input - Create request carrying either `startAt` and `endAt`, or `duration`.
 * @returns Normalized interval start and end instants.
 */
function resolveCreateInterval(input: CreateTimeEntryInput): { startAt: string; endAt: string } {
  if (input.duration === undefined) {
    if (input.startAt === undefined || input.endAt === undefined) {
      throw new TimeTrackingError(400, 'InvalidRequest', 'Start and end times, or a date and minutes, are required.')
    }
    return { startAt: validateInstant(input.startAt, 'Entry start'), endAt: validateInstant(input.endAt, 'Entry end') }
  }
  if (input.startAt !== undefined || input.endAt !== undefined) {
    throw new TimeTrackingError(400, 'InvalidRequest', 'Send either start and end times, or a date and minutes, not both.')
  }
  return resolveDurationInterval(input.duration)
}

/**
 * Resolves the interval of a date-and-minutes entry, which starts at local midnight of the date
 * and must end within that date.
 *
 * @param duration - Local date, minutes, and timezone.
 * @returns Normalized interval start and end instants.
 */
function resolveDurationInterval(duration: TimeEntryDurationInput): { startAt: string; endAt: string } {
  const { date, minutes, timeZone } = duration
  if (!ISO_DATE_PATTERN.test(date) || !isValidCalendarDate(date)) {
    throw new TimeTrackingError(400, 'InvalidDate', 'Work date must be an ISO date.')
  }
  validateTimeZone(timeZone)
  requireInteger(minutes, 'Minutes', 1, MAX_DURATION_ONLY_MINUTES)
  const start = resolveLocalDateStart(date, timeZone)
  const end = start + minutes * 60_000
  if (end > resolveLocalDateStart(addCalendarDays(date, 1), timeZone)) {
    throw new TimeTrackingError(400, 'TimeEntryExceedsDay', 'Minutes may not exceed the length of the work date.')
  }
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }
}

/**
 * Validates the shape of a work category key; whether the Workspace offers it is checked separately.
 *
 * @param value - Category value from a request.
 * @returns The category key.
 */
function readCategory(value: unknown): TimeEntryCategory {
  const category = readTimeEntryCategoryKey(value)
  if (category === undefined) {
    throw new TimeTrackingError(400, 'InvalidTimeEntryCategory', 'Category must be a work category key.')
  }
  return category
}

/**
 * Resolves the interval of an update and whether the entry stays a date-and-minutes entry.
 *
 * A new date and minutes keep or make it one. New times keep it one only when they repeat the
 * stored interval, so a client that always sends the times does not turn it into a timed entry.
 *
 * @param current - Stored entry.
 * @param input - Update request.
 * @returns Interval and the date-and-minutes marker of the updated entry.
 */
function resolveUpdatedInterval(
  current: TimeEntry,
  input: UpdateTimeEntryInput,
): { startAt: string; endAt: string; durationOnly: boolean } {
  if (input.duration !== undefined) {
    if (input.startAt !== undefined || input.endAt !== undefined) {
      throw new TimeTrackingError(400, 'InvalidRequest', 'Send either start and end times, or a date and minutes, not both.')
    }
    return { ...resolveDurationInterval(input.duration), durationOnly: true }
  }
  const startAt = input.startAt === undefined ? current.startAt : validateInstant(input.startAt, 'Entry start')
  const endAt = input.endAt === undefined ? current.endAt : validateInstant(input.endAt, 'Entry end')
  const unchanged = Date.parse(startAt) === Date.parse(current.startAt) && Date.parse(endAt) === Date.parse(current.endAt)
  return { startAt, endAt, durationOnly: current.durationOnly === true && unchanged }
}

/**
 * Requires a Work Item or, for indirect work such as a meeting, a work category.
 *
 * @param workItemId - Work Item of the entry, if any.
 * @param category - Work category of the entry, if any.
 */
function requireWorkItemOrCategory(workItemId: string | undefined, category: TimeEntryCategory | undefined): void {
  if (workItemId === undefined && category === undefined) {
    throw new TimeTrackingError(400, 'TimeEntryCategoryRequired', 'An entry without a Work Item requires a work category.')
  }
}

/**
 * Returns whether an entry in this state may be deleted by its owner.
 *
 * @param status - Lifecycle state.
 * @returns `true` for draft and rejected entries.
 */
function isDeletableStatus(status: TimeEntryStatus): boolean {
  return status === 'draft' || status === 'rejected'
}

/**
 * Builds the searchable audit metadata of a time-entry mutation.
 *
 * @param entry - Entry the event is about.
 * @returns Team, status, and the Work Item and Project when the entry has them.
 */
function createEntryAuditMetadata(entry: TimeEntry): Record<string, unknown> {
  return {
    teamId: entry.teamId,
    ...(entry.workItemId ? { workItemId: entry.workItemId } : {}),
    status: entry.status,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
  }
}

/** Validates a lifecycle transition. */
function transitionFor(status: TimeEntryStatus, action: TransitionTimeEntryInput['action']): { toStatus: TimeEntryStatus } | undefined {
  if (action === 'submit' && (status === 'draft' || status === 'rejected')) return { toStatus: 'submitted' }
  if (action === 'approve' && status === 'submitted') return { toStatus: 'approved' }
  if (action === 'reject' && status === 'submitted') return { toStatus: 'rejected' }
  if (action === 'lock' && status === 'approved') return { toStatus: 'locked' }
  if (action === 'return' && (status === 'approved' || status === 'locked')) return { toStatus: 'rejected' }
  return undefined
}

/**
 * Names the history action recorded for a lifecycle transition.
 *
 * @param action - Requested transition.
 * @returns The history action in past tense.
 */
function historyActionFor(action: TransitionTimeEntryInput['action']): TimeEntryHistory['action'] {
  switch (action) {
    case 'submit': return 'submitted'
    case 'approve': return 'approved'
    case 'reject': return 'rejected'
    case 'lock': return 'locked'
    case 'return': return 'returned'
  }
}

/**
 * Creates the error for a month close or reopen whose caller lost the access it was checked with.
 *
 * @returns A 409 error that asks the caller to reload.
 */
function periodAuthorizationChangedError(): TimeTrackingError {
  return new TimeTrackingError(
    409,
    'TimePeriodAuthorizationChanged',
    'Your access changed before the month was closed or reopened. Reload and try again.',
  )
}

/**
 * Logs one Team that a Workspace-wide close or reopen could not change, with identifiers only.
 *
 * @param action - Close or reopen.
 * @param target - Workspace, failed Team, month, and the request's correlation ID.
 * @param error - Failure; only its stable code, or the error class name, is logged.
 */
function logWorkspacePeriodFailure(
  action: 'close' | 'reopen',
  target: { workspaceId: string; teamId: string; month: string; correlationId: string | undefined },
  error: unknown,
): void {
  console.error(JSON.stringify({
    event: 'workspace-time-period.team-failed',
    action,
    workspaceId: target.workspaceId,
    teamId: target.teamId,
    month: target.month,
    ...(target.correlationId ? { correlationId: target.correlationId } : {}),
    errorCode: error instanceof TimeTrackingError ? error.code : 'UnexpectedError',
  }))
}

/**
 * Validates and de-duplicates the Teams of a Workspace-wide month operation.
 *
 * @param teamIds - Team identifiers from the Workspace directory.
 * @returns Unique Team identifiers in sorted order.
 */
function readWorkspaceTeamIds(teamIds: readonly string[]): string[] {
  return [...new Set(teamIds.map((teamId) => readIdentifier(teamId, 'Team ID')))].sort()
}

/**
 * Validates a calendar month.
 *
 * @param value - Candidate month.
 * @returns The month as `YYYY-MM`.
 */
function readMonth(value: string): string {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new TimeTrackingError(400, 'InvalidMonth', 'Month must be YYYY-MM.')
  }
  // The month after must still be a four-digit year so its first instant can be resolved.
  const year = Number(value.slice(0, 4))
  if (year < MIN_CLOSE_YEAR || year > MAX_CLOSE_YEAR) {
    throw new TimeTrackingError(400, 'InvalidMonth', `Month must be between ${MIN_CLOSE_YEAR}-01 and ${MAX_CLOSE_YEAR}-12.`)
  }
  return value
}

/**
 * Returns the first instant of a local month and of the month after it.
 *
 * @param month - Month as `YYYY-MM`.
 * @param timeZone - IANA timezone that defines local midnight.
 * @returns Inclusive start and exclusive end in epoch milliseconds.
 */
function monthBounds(month: string, timeZone: string): { start: number; end: number } {
  const [year, monthNumber] = month.split('-').map(Number)
  const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, '0')}`
  return {
    start: resolveLocalDateStart(`${month}-01`, timeZone),
    end: resolveLocalDateStart(`${next}-01`, timeZone),
  }
}

/** Creates an immutable history record. */
function createHistory(
  createId: () => string,
  entry: TimeEntry,
  action: TimeEntryHistory['action'],
  actorUserId: string,
  occurredAt: Date,
  fromStatus?: TimeEntryStatus,
  toStatus?: TimeEntryStatus,
  reason?: string,
): TimeEntryHistory {
  return {
    id: createId(),
    entryId: entry.id,
    action,
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    actorUserId: readIdentifier(actorUserId, 'Actor user ID'),
    ...(reason ? { reason: normalizeDescription(reason) } : {}),
    occurredAt: occurredAt.toISOString(),
  }
}

/** Aggregates entries by the requested dimension. */
function aggregateEntries(
  entries: readonly TimeEntry[],
  groupBy: TimeTrackingGroupBy,
  timeZone: string,
  from: string,
  to: string,
  estimateByWorkItem: ReadonlyMap<string, number>,
  includeCosts: boolean,
  managedProjectIds?: ReadonlySet<string>,
  categoryLabels?: ReadonlyMap<string, string>,
  weekStartDay: WorkspaceWeekStartDay = DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay,
): TimeSummaryGroup[] {
  if (groupBy === 'day' || groupBy === 'week') {
    return aggregateCalendarEntries(entries, groupBy, timeZone, from, to, estimateByWorkItem, includeCosts, managedProjectIds, weekStartDay)
  }
  const grouped = new Map<string, MutableSummaryGroup>()
  for (const entry of entries) {
    const minutes = clippedEntryMinutes(entry, from, to)
    if (minutes === 0) continue
    const key = groupBy === 'user'
      ? entry.userId
      : groupBy === 'work-item'
        ? entry.workItemId ?? NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY
        : groupBy === 'category'
          ? entry.category ?? UNCATEGORIZED_TIME_ENTRY_GROUP_KEY
          : entry.projectId ?? 'unassigned'
    const group = grouped.get(key) ?? createMutableSummaryGroup(key, categoryLabels?.get(key) ?? readFallbackGroupLabel(groupBy, entry))
    group.minutes += minutes
    group.billableMinutes += entry.billable ? minutes : 0
    group.entryIds.add(entry.id)
    if (entry.workItemId !== undefined && !group.estimateWorkItemIds.has(entry.workItemId)) {
      group.estimateMinutes += estimateByWorkItem.get(entry.workItemId) ?? 0
      group.estimateWorkItemIds.add(entry.workItemId)
    }
    const cost = costForEntry(entry, minutes, includeCosts, managedProjectIds)
    if (cost !== undefined) addCost(group, entry.currency, cost)
    grouped.set(key, group)
  }
  return [...grouped.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => toSummaryGroup(group, includeCosts))
}

/**
 * Collects the names the Workspace gave its work categories, for report group labels.
 *
 * @param settings - Workspace work category settings.
 * @returns Names keyed by category; built-in categories without a name are left out and keep
 *   their key as the label.
 */
function readCategoryLabels(settings: WorkspaceTimeEntryCategorySettings): ReadonlyMap<string, string> {
  return new Map(settings.categories.flatMap((category) =>
    category.label === undefined ? [] : [[category.key, category.label] as const]))
}

/**
 * Returns the label of a report group whose key is a placeholder rather than an identifier.
 *
 * @param groupBy - Report grouping.
 * @param entry - Entry that opens the group.
 * @returns `Uncategorized` or `No Work Item` for those groups, otherwise `undefined`.
 */
function readFallbackGroupLabel(groupBy: TimeTrackingGroupBy, entry: TimeEntry): string | undefined {
  if (groupBy === 'category' && entry.category === undefined) return 'Uncategorized'
  if (groupBy === 'work-item' && entry.workItemId === undefined) return 'No Work Item'
  return undefined
}

/** Aggregates entries into local day buckets, or week buckets that begin on the Workspace week start day. */
function aggregateCalendarEntries(
  entries: readonly TimeEntry[],
  groupBy: 'day' | 'week',
  timeZone: string,
  from: string,
  to: string,
  estimateByWorkItem: ReadonlyMap<string, number>,
  includeCosts: boolean,
  managedProjectIds?: ReadonlySet<string>,
  weekStartDay: WorkspaceWeekStartDay = DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay,
): TimeSummaryGroup[] {
  const grouped = new Map<string, MutableSummaryGroup>()
  const segments = entries.flatMap((entry) => splitEntryByLocalDate(entry, timeZone, from, to)
    .map((segment) => ({ entry, segment })))
  const actualMillisecondsByWorkItem = new Map<string, number>()
  for (const { entry, segment } of segments) {
    if (entry.workItemId === undefined) continue
    const entryDurationMilliseconds = Date.parse(entry.endAt) - Date.parse(entry.startAt)
    const actualMilliseconds = entryDurationMilliseconds * segment.ratio
    actualMillisecondsByWorkItem.set(
      entry.workItemId,
      (actualMillisecondsByWorkItem.get(entry.workItemId) ?? 0) + actualMilliseconds,
    )
  }
  for (const { entry, segment } of segments) {
    const key = groupBy === 'day' ? segment.date : workspaceWeekContaining(segment.date, weekStartDay).from
    const group = grouped.get(key) ?? createMutableSummaryGroup(key)
    group.minutes += segment.minutes
    group.billableMinutes += entry.billable ? segment.minutes : 0
    group.entryIds.add(entry.id)
    const entryDurationMilliseconds = Date.parse(entry.endAt) - Date.parse(entry.startAt)
    const actualMilliseconds = entryDurationMilliseconds * segment.ratio
    const workItemActualMilliseconds = entry.workItemId === undefined ? 0 : actualMillisecondsByWorkItem.get(entry.workItemId) ?? 0
    group.estimateMinutes += entry.workItemId !== undefined && workItemActualMilliseconds > 0
      ? Math.round((estimateByWorkItem.get(entry.workItemId) ?? 0) * actualMilliseconds / workItemActualMilliseconds)
      : 0
    const cost = costForEntry(entry, segment.minutes, includeCosts, managedProjectIds)
    if (cost !== undefined) addCost(group, entry.currency, cost)
    grouped.set(key, group)
  }
  return [...grouped.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => toSummaryGroup(group, includeCosts))
}

/**
 * Splits a time entry at local midnight the way time reports do, so another report can count
 * an entry that crosses midnight on each day it covers.
 *
 * @param entry - Entry to split.
 * @param timeZone - IANA timezone that defines the days.
 * @returns One segment per local date with its whole minutes and its share of the entry.
 */
export function splitTimeEntryByLocalDate(entry: TimeEntry, timeZone: string): Array<{ date: string; minutes: number; ratio: number }> {
  return splitEntryByLocalDate(entry, timeZone, entry.startAt, entry.endAt)
}

/** Splits one interval at timezone-aware local midnight boundaries. */
function splitEntryByLocalDate(entry: TimeEntry, timeZone: string, from: string, to: string): Array<{ date: string; minutes: number; ratio: number }> {
  const start = Math.max(Date.parse(entry.startAt), Date.parse(from))
  const end = Math.min(Date.parse(entry.endAt), Date.parse(to))
  if (!(end > start)) return []
  const dates = new Set<string>()
  let cursor = localDateAt(start, timeZone)
  const lastDate = localDateAt(end - 1, timeZone)
  for (let index = 0; index < 370 && cursor <= lastDate; index += 1) {
    dates.add(cursor)
    cursor = addCalendarDays(cursor, 1)
  }
  const rawSegments: Array<{ date: string; rawMinutes: number; ratio: number }> = []
  for (const date of dates) {
    const dayStart = resolveLocalDateStart(date, timeZone)
    const dayEnd = resolveLocalDateStart(addCalendarDays(date, 1), timeZone)
    const segmentStart = Math.max(start, dayStart)
    const segmentEnd = Math.min(end, dayEnd)
    if (segmentEnd > segmentStart) {
      rawSegments.push({
        date,
        rawMinutes: (segmentEnd - segmentStart) / 60_000,
        ratio: (segmentEnd - segmentStart) / (end - start),
      })
    }
  }
  const totalMinutes = calculateDurationMinutes(new Date(start).toISOString(), new Date(end).toISOString())
  const allocated = rawSegments.map((segment) => ({
    ...segment,
    minutes: Math.floor(segment.rawMinutes),
  }))
  let remaining = totalMinutes - allocated.reduce((sum, segment) => sum + segment.minutes, 0)
  for (const segment of [...allocated].sort((left, right) =>
    (right.rawMinutes - Math.floor(right.rawMinutes)) - (left.rawMinutes - Math.floor(left.rawMinutes))
  )) {
    if (remaining <= 0) break
    segment.minutes += 1
    remaining -= 1
  }
  return allocated.map(({ date, minutes, ratio }) => ({ date, minutes, ratio }))
}

/** Mutable aggregation row used internally. */
type MutableSummaryGroup = {
  /** Group identifier exposed to summary consumers. */
  key: string
  /** Label that replaces the default key-based label, when set. */
  label?: string
  /** Total recorded minutes in the group. */
  minutes: number
  /** Total billable minutes in the group. */
  billableMinutes: number
  /** Entry identifiers contributing to the group. */
  entryIds: Set<string>
  /** Sum of unique Work Item estimates in the group. */
  estimateMinutes: number
  /** Work Items whose estimates have already been included. */
  estimateWorkItemIds: Set<string>
  /** Total actual costs grouped by currency. */
  actualCostByCurrency: Map<string, number>
}

/** Creates an empty aggregation row, optionally with a label other than the key. */
function createMutableSummaryGroup(key: string, label?: string): MutableSummaryGroup {
  return {
    key,
    ...(label === undefined ? {} : { label }),
    minutes: 0,
    billableMinutes: 0,
    entryIds: new Set<string>(),
    estimateMinutes: 0,
    estimateWorkItemIds: new Set<string>(),
    actualCostByCurrency: new Map<string, number>(),
  }
}

/** Converts an internal aggregation row to its public shape. */
function toSummaryGroup(group: MutableSummaryGroup, includeCosts: boolean): TimeSummaryGroup {
  return {
    key: group.key,
    label: group.label ?? (group.key === 'unassigned' ? 'Unassigned' : group.key),
    minutes: group.minutes,
    billableMinutes: group.billableMinutes,
    entryCount: group.entryIds.size,
    ...(group.estimateMinutes === 0 ? {} : { estimateMinutes: group.estimateMinutes }),
    ...(includeCosts ? costFields(group.actualCostByCurrency) : {}),
  }
}

/** Adds a cost to a currency-specific aggregation bucket. */
function addCost(group: MutableSummaryGroup, currency: string, amount: number): void {
  group.actualCostByCurrency.set(currency, (group.actualCostByCurrency.get(currency) ?? 0) + amount)
}

/** Builds public cost fields without combining incompatible currencies. */
function costFields(costs: ReadonlyMap<string, number>): {
  actualCostMinor?: number
  actualCostByCurrency: Readonly<Record<string, number>>
} {
  const actualCostByCurrency = Object.fromEntries([...costs.entries()].sort(([left], [right]) => left.localeCompare(right)))
  const currencies = Object.keys(actualCostByCurrency)
  return {
    actualCostByCurrency,
    ...(currencies.length === 1 ? { actualCostMinor: actualCostByCurrency[currencies[0]!] } : {}),
  }
}

/** Computes total costs by currency for a clipped report period. */
function sumCostsByCurrency(
  entries: readonly TimeEntry[],
  from: string,
  to: string,
  managedProjectIds: ReadonlySet<string> | undefined,
): Readonly<Record<string, number>> {
  const costs = new Map<string, number>()
  for (const entry of entries) {
    const minutes = clippedEntryMinutes(entry, from, to)
    const cost = costForEntry(entry, minutes, true, managedProjectIds)
    if (cost !== undefined) costs.set(entry.currency, (costs.get(entry.currency) ?? 0) + cost)
  }
  return costFields(costs).actualCostByCurrency
}

/**
 * Returns whether an entry passes a list query's Project allowlist.
 *
 * @param entry - Stored time entry.
 * @param input - Project allowlist and whether entries without a Project pass it.
 * @returns `true` when the entry's Project is allowed, or it has no Project and those are included.
 */
function matchesProjectAllowlist(
  entry: TimeEntry,
  input: Pick<ListTimeEntriesInput, 'projectIds' | 'includeUnassigned'>,
): boolean {
  if (input.projectIds === undefined) return true
  if (entry.projectId === undefined) return input.includeUnassigned === true
  return input.projectIds.has(entry.projectId)
}

/**
 * Returns whether a Team time manager manages the Project an entry is recorded on.
 *
 * Entries without a Project belong to the Team, so every Team time manager manages them.
 *
 * @param entry - Time entry.
 * @param managedProjectIds - Managed Project IDs, or `undefined` when every Project is managed.
 * @returns `true` when the entry has no Project or its Project is managed.
 */
function canManageEntryProject(entry: TimeEntry, managedProjectIds?: ReadonlySet<string>): boolean {
  return managedProjectIds === undefined || entry.projectId === undefined || managedProjectIds.has(entry.projectId)
}

/** Returns whether a caller can see an entry's confidential costs. */
function canViewCosts(entry: TimeEntry, managedProjectIds?: ReadonlySet<string>): boolean {
  return canManageEntryProject(entry, managedProjectIds)
}

/** Calculates a clipped entry cost when the caller is authorized to see it. */
function costForEntry(
  entry: TimeEntry,
  minutes: number,
  includeCosts: boolean,
  managedProjectIds?: ReadonlySet<string>,
): number | undefined {
  if (!includeCosts || !canViewCosts(entry, managedProjectIds) || !entry.billable || entry.hourlyRateMinor === undefined || minutes === 0) return undefined
  return Math.round((minutes / 60) * entry.hourlyRateMinor)
}

/** Returns rounded minutes contributed by an entry within report bounds. */
function clippedEntryMinutes(entry: TimeEntry, from: string, to: string): number {
  const start = Math.max(Date.parse(entry.startAt), Date.parse(from))
  const end = Math.min(Date.parse(entry.endAt), Date.parse(to))
  return end > start
    ? calculateDurationMinutes(new Date(start).toISOString(), new Date(end).toISOString())
    : 0
}

/** Removes confidential money fields before a time-entry snapshot enters audit. */
function toAuditEntrySnapshot(entry: TimeEntry): Record<string, unknown> {
  return {
    status: entry.status,
    revision: entry.revision,
    startAt: entry.startAt,
    endAt: entry.endAt,
    durationMinutes: entry.durationMinutes,
    ...(entry.durationOnly ? { durationOnly: true } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    billable: entry.billable,
    currency: entry.currency,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.workItemId ? { workItemId: entry.workItemId } : {}),
    userId: entry.userId,
    source: entry.source,
  }
}

/** Removes non-audit fields before a running timer snapshot enters audit. */
function toAuditTimerSnapshot(timer: RunningTimer): Record<string, unknown> {
  return {
    teamId: timer.teamId,
    workItemId: timer.workItemId,
    userId: timer.userId,
    startedAt: timer.startedAt,
    ...(timer.description ? { description: timer.description } : {}),
    billable: timer.billable,
    revision: timer.revision,
  }
}

/**
 * Builds the audit entity ID of a budget; a budget per period adds its dates.
 *
 * @param budget - Audited budget.
 * @returns The entity ID.
 */
function budgetAuditEntityId(budget: TimeBudget): string {
  const period = budgetStoragePeriod(budget)
  return period ? `${budget.scopeType}:${budget.scopeId}:${period.from}:${period.to}` : `${budget.scopeType}:${budget.scopeId}`
}

/**
 * Reads the dates of a budget per period, which must both be set and ordered.
 *
 * @param from - Inclusive local period start.
 * @param to - Inclusive local period end.
 * @returns The period.
 * @throws TimeTrackingError 400 when a date is missing, malformed, or after the other.
 */
function readBudgetPeriod(from: string | undefined, to: string | undefined): TimeBudgetPeriod {
  if (!from || !to) throw new TimeTrackingError(400, 'InvalidBudgetPeriod', 'A budget per period needs both period dates.')
  validateOptionalDate(from, 'Budget period start')
  validateOptionalDate(to, 'Budget period end')
  if (from > to) throw new TimeTrackingError(400, 'InvalidBudgetPeriod', 'Budget period start must not be after its end.')
  return { from, to }
}

/** Creates a budget snapshot with the amount available for field-level redaction. */
function toAuditBudgetSnapshot(budget: TimeBudget): Record<string, unknown> {
  return {
    scopeType: budget.scopeType,
    scopeId: budget.scopeId,
    amountMinor: budget.amountMinor,
    currency: budget.currency,
    ...(budget.periodFrom ? { periodFrom: budget.periodFrom } : {}),
    ...(budget.periodTo ? { periodTo: budget.periodTo } : {}),
    ...(budget.periodBudget ? { periodBudget: true } : {}),
    revision: budget.revision,
  }
}

/**
 * Creates a rate card snapshot whose rate rows are available for field-level redaction.
 *
 * @param rateCard - Card to describe.
 * @returns Audit snapshot.
 */
function toAuditRateCardSnapshot(rateCard: TimeRateCard): Record<string, unknown> {
  return {
    currency: rateCard.currency,
    memberRates: rateCard.memberRates,
    jobRoleRates: rateCard.jobRoleRates,
    revision: rateCard.revision,
  }
}

/**
 * Finds the default hourly rate of a member in a rate card.
 *
 * @param rateCard - Team rate card.
 * @param userId - Member recording the time.
 * @returns The member's own rate, else the rate of the member's job role, else `undefined`.
 */
function findDefaultHourlyRate(rateCard: TimeRateCard, userId: string): number | undefined {
  const memberRate = rateCard.memberRates.find((rate) => rate.userId === userId)
  if (!memberRate) return undefined
  if (memberRate.hourlyRateMinor !== undefined) return memberRate.hourlyRateMinor
  if (memberRate.jobRoleId === undefined) return undefined
  return rateCard.jobRoleRates.find((rate) => rate.jobRoleId === memberRate.jobRoleId)?.hourlyRateMinor
}

/**
 * Throws the stable error for an invalid rate card request.
 *
 * @param message - Client-facing reason.
 * @returns Never returns.
 * @throws TimeTrackingError with `InvalidTimeRateCard`.
 */
function invalidRateCard(message: string): never {
  throw new TimeTrackingError(400, 'InvalidTimeRateCard', message)
}

/**
 * Validates an hourly rate of a rate card.
 *
 * @param value - Untrusted rate.
 * @param label - Field name used in the error.
 * @returns The rate in minor units.
 */
function readRateCardHourlyRate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > TIME_RATE_CARD_MAX_HOURLY_RATE_MINOR) {
    invalidRateCard(`${label} must be a non-negative integer in minor currency units.`)
  }
  return value
}

/**
 * Validates a member or job role identifier of a rate card.
 *
 * @param value - Untrusted identifier.
 * @param label - Field name used in the error.
 * @returns The trimmed identifier.
 */
function readRateCardIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256) invalidRateCard(`${label} is invalid.`)
  return value.trim()
}

/**
 * Validates the member rows of a rate card.
 *
 * @param value - Untrusted rows.
 * @returns Rows sorted by member key, each naming a rate, a job role, or both.
 */
function normalizeMemberRates(value: unknown): TimeRateCardMemberRate[] {
  if (!Array.isArray(value) || value.length > TIME_RATE_CARD_MEMBER_LIMIT) {
    invalidRateCard(`Member rates must be an array with at most ${TIME_RATE_CARD_MEMBER_LIMIT} entries.`)
  }
  const seen = new Set<string>()
  return value.map((candidate: unknown): TimeRateCardMemberRate => {
    if (!isRecord(candidate)) invalidRateCard('Member rate must be an object.')
    const userId = readRateCardIdentifier(candidate.userId, 'Member rate user ID')
    if (seen.has(userId)) invalidRateCard(`Member "${userId}" is listed more than once.`)
    seen.add(userId)
    const hourlyRateMinor = candidate.hourlyRateMinor === undefined || candidate.hourlyRateMinor === null
      ? undefined
      : readRateCardHourlyRate(candidate.hourlyRateMinor, 'Member hourly rate')
    const jobRoleId = candidate.jobRoleId === undefined || candidate.jobRoleId === null
      ? undefined
      : readRateCardIdentifier(candidate.jobRoleId, 'Member job role ID')
    if (hourlyRateMinor === undefined && jobRoleId === undefined) {
      invalidRateCard(`Member "${userId}" needs an hourly rate or a job role.`)
    }
    return {
      userId,
      ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
      ...(jobRoleId === undefined ? {} : { jobRoleId }),
    }
  }).sort((left, right) => left.userId.localeCompare(right.userId))
}

/**
 * Validates the job role rows of a rate card.
 *
 * @param value - Untrusted rows.
 * @returns Rows sorted by job role ID.
 */
function normalizeJobRoleRates(value: unknown): TimeRateCardJobRoleRate[] {
  if (!Array.isArray(value) || value.length > TIME_RATE_CARD_JOB_ROLE_LIMIT) {
    invalidRateCard(`Job role rates must be an array with at most ${TIME_RATE_CARD_JOB_ROLE_LIMIT} entries.`)
  }
  const seen = new Set<string>()
  return value.map((candidate: unknown): TimeRateCardJobRoleRate => {
    if (!isRecord(candidate)) invalidRateCard('Job role rate must be an object.')
    const jobRoleId = readRateCardIdentifier(candidate.jobRoleId, 'Job role ID')
    if (seen.has(jobRoleId)) invalidRateCard(`Job role "${jobRoleId}" is listed more than once.`)
    seen.add(jobRoleId)
    return { jobRoleId, hourlyRateMinor: readRateCardHourlyRate(candidate.hourlyRateMinor, 'Job role hourly rate') }
  }).sort((left, right) => left.jobRoleId.localeCompare(right.jobRoleId))
}

/**
 * Reads a stored rate card, or an idempotent replay of one.
 *
 * @param value - Stored value.
 * @returns The validated rate card.
 * @throws TimeTrackingError with `InvalidStoredTimeTrackingRecord` for a malformed value.
 */
function readStoredRateCard(value: unknown): TimeRateCard {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored rate card')
  const currency = readString(record.currency, 'Stored rate card currency')
  if (!CURRENCY_PATTERN.test(currency)) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored rate card currency is invalid.')
  let memberRates: TimeRateCardMemberRate[]
  let jobRoleRates: TimeRateCardJobRoleRate[]
  try {
    memberRates = normalizeMemberRates(record.memberRates)
    jobRoleRates = normalizeJobRoleRates(record.jobRoleRates)
  } catch {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored rate card rates are invalid.')
  }
  const updatedAt = readOptionalString(record.updatedAt)
  const updatedBy = readOptionalString(record.updatedBy)
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored rate card Workspace ID'),
    teamId: readString(record.teamId, 'Stored rate card Team ID'),
    currency,
    memberRates,
    jobRoleRates,
    revision: readNumber(record.revision, 'Stored rate card revision'),
    ...(updatedAt ? { updatedAt } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  }
}

/** Computes chargeable cost fields. */
function calculateCostFields(
  billable: boolean,
  hourlyRateMinor: number | undefined,
  startAt: string,
  endAt: string,
): { actualCostMinor?: number } {
  if (!billable || hourlyRateMinor === undefined) return {}
  const minutes = calculateDurationMinutes(startAt, endAt)
  return { actualCostMinor: Math.round((minutes / 60) * hourlyRateMinor) }
}

/** Normalizes a local-date or instant period to UTC instants. */
function normalizePeriod(from: string, to: string, timeZone: string): { from: string; to: string } {
  validateTimeZone(timeZone)
  const fromInstant = ISO_DATE_PATTERN.test(from)
    ? resolveLocalDateStart(from, timeZone)
    : Date.parse(validateInstant(from, 'Period start'))
  const toInstant = ISO_DATE_PATTERN.test(to)
    ? resolveLocalDateStart(addCalendarDays(to, 1), timeZone)
    : Date.parse(validateInstant(to, 'Period end'))
  if (!(toInstant > fromInstant)) throw new TimeTrackingError(400, 'InvalidTimeRange', 'Report period must have a positive duration.')
  return { from: new Date(fromInstant).toISOString(), to: new Date(toInstant).toISOString() }
}

/** Returns the local date for an instant. */
const localDateFormatters = new Map<string, Intl.DateTimeFormat>()
const localTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const localDateStartCache = new Map<string, number>()
const LOCAL_DATE_START_CACHE_LIMIT = 4_096

/** Returns a cached formatter for local calendar dates. */
function getLocalDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = localDateFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  localDateFormatters.set(timeZone, formatter)
  return formatter
}

/** Returns a cached formatter for local clock times. */
function getLocalTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = localTimeFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  localTimeFormatters.set(timeZone, formatter)
  return formatter
}

/** Returns a cached formatter for timezone offset calculations. */
function getZonedDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedDateTimeFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  zonedDateTimeFormatters.set(timeZone, formatter)
  return formatter
}

/** Returns the local date for an instant. */
function localDateAt(timestamp: number, timeZone: string): string {
  const parts = getLocalDateFormatter(timeZone).formatToParts(new Date(timestamp))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

/** Resolves local midnight, including a safe DST-gap fallback. */
function resolveLocalDateStart(date: string, timeZone: string): number {
  const cacheKey = `${timeZone}\0${date}`
  const cached = localDateStartCache.get(cacheKey)
  if (cached !== undefined) return cached
  const approximate = Date.parse(`${date}T00:00:00.000Z`)
  const candidates = new Set<number>()
  for (const dayOffset of [-2, -1, 0, 1, 2]) {
    const candidate = approximate + dayOffset * 86_400_000
    const offset = zonedOffsetMinutes(candidate, timeZone)
    candidates.add(approximate - offset * 60_000)
  }
  const exact = [...candidates].find((candidate) => localDateAt(candidate, timeZone) === date && localTimeAt(candidate, timeZone) === '00:00')
  if (exact !== undefined) return cacheLocalDateStart(cacheKey, exact)
  for (let minute = 0; minute < 180; minute += 1) {
    const candidate = [...candidates].map((value) => value + minute * 60_000).find((value) => localDateAt(value, timeZone) === date)
    if (candidate !== undefined) return cacheLocalDateStart(cacheKey, candidate)
  }
  throw new TimeTrackingError(400, 'InvalidTimeZoneBoundary', 'The local date boundary could not be resolved.')
}

/** Stores a local date boundary while bounding process-wide cache growth. */
function cacheLocalDateStart(cacheKey: string, value: number): number {
  if (localDateStartCache.size >= LOCAL_DATE_START_CACHE_LIMIT && !localDateStartCache.has(cacheKey)) {
    localDateStartCache.clear()
  }
  localDateStartCache.set(cacheKey, value)
  return value
}

/** Returns a local 24-hour time. */
function localTimeAt(timestamp: number, timeZone: string): string {
  const parts = getLocalTimeFormatter(timeZone).formatToParts(new Date(timestamp))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('hour')}:${values.get('minute')}`
}

/** Reads the timezone offset in minutes at an instant. */
function zonedOffsetMinutes(timestamp: number, timeZone: string): number {
  const parts = getZonedDateTimeFormatter(timeZone).formatToParts(new Date(timestamp))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second')),
  )
  return Math.round((asUtc - timestamp) / 60_000)
}

/** Adds calendar days without interpreting them as instants. */
function addCalendarDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** Validates an interval and returns normalized instants. */
function validateInterval(startAt: string, endAt: string): void {
  const start = Date.parse(validateInstant(startAt, 'Interval start'))
  const end = Date.parse(validateInstant(endAt, 'Interval end'))
  if (!(end > start)) throw new TimeTrackingError(400, 'InvalidTimeInterval', 'End time must be after start time.')
  if (end - start > MAX_ENTRY_DURATION_MINUTES * 60_000) throw new TimeTrackingError(400, 'TimeEntryTooLong', 'A time entry may not exceed seven days.')
}

/** Calculates rounded duration in minutes. */
function calculateDurationMinutes(startAt: string, endAt: string): number {
  return Math.max(1, Math.ceil((Date.parse(endAt) - Date.parse(startAt)) / 60_000))
}

/** Validates an ISO instant. */
function validateInstant(value: string, label: string): string {
  const normalized = readText(value, label, 128)
  if (!ISO_INSTANT_PATTERN.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new TimeTrackingError(400, 'InvalidTimestamp', `${label} must be an ISO 8601 instant.`)
  }
  return new Date(normalized).toISOString()
}

/** Validates an optional local date. */
function validateOptionalDate(value: string | undefined, label: string): void {
  if (value === undefined) return
  if (!ISO_DATE_PATTERN.test(value) || !isValidCalendarDate(value)) {
    throw new TimeTrackingError(400, 'InvalidDate', `${label} must be an ISO date.`)
  }
}

/** Validates a calendar date without accepting JavaScript date normalization. */
function isValidCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Validates a list boundary that may be an ISO local date or instant. */
function validateEntryBoundary(value: string, label: string): string {
  if (ISO_DATE_PATTERN.test(value)) {
    validateOptionalDate(value, label)
    return value
  }
  return validateInstant(value, label)
}

/** Normalizes an entry query boundary to the instant representation used by the date index. */
function normalizeEntryBoundary(value: string): string {
  return ISO_DATE_PATTERN.test(value) ? `${value}T00:00:00.000Z` : new Date(value).toISOString()
}

/** Validates an IANA timezone identifier. */
function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new TimeTrackingError(400, 'InvalidTimeZone', 'The timezone must be a valid IANA timezone identifier.')
  }
}

/** Validates an ISO currency code. */
function validateCurrency(value: string): string {
  const currency = readText(value, 'Currency', 3).toUpperCase()
  if (!CURRENCY_PATTERN.test(currency)) throw new TimeTrackingError(400, 'InvalidCurrency', 'Currency must be a three-letter ISO 4217 code.')
  return currency
}

/** Validates a non-negative monetary amount. */
function requireMoney(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TimeTrackingError(400, 'InvalidMoney', `${label} must be a non-negative integer in minor currency units.`)
  return value
}

/** Validates a bounded integer. */
function requireInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TimeTrackingError(400, 'InvalidInteger', `${label} must be an integer between ${minimum} and ${maximum}.`)
  return value
}

/** Validates an identifier. */
function readIdentifier(value: string, label: string): string {
  return readText(value, label, 256)
}

/** Validates bounded text. */
function readText(value: string, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new TimeTrackingError(400, 'InvalidText', `${label} is invalid.`)
  return value.trim()
}

/** Normalizes an optional description. */
function normalizeDescription(value: string): string {
  return readText(value, 'Description', MAX_DESCRIPTION_LENGTH)
}

/** Reads a valid Date from a clock. */
function readNow(now: () => Date): Date {
  const value = now()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TimeTrackingError(500, 'InvalidClock', 'The time tracking clock returned an invalid timestamp.')
  return value
}

/** Converts a value into a bounded string-keyed record. */
function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time tracking data is invalid.')
  return value
}

/** Checks whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a stored time entry; an entry without both a Work Item and a category is invalid. */
function readStoredEntry(value: unknown): TimeEntry {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored time entry')
  if (record.workItemId === undefined && record.category === undefined) {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time entry has neither a Work Item nor a category.')
  }
  return {
    schemaVersion: 1,
    id: readString(record.id, 'Stored time entry ID'),
    workspaceId: readString(record.workspaceId, 'Stored time entry Workspace ID'),
    teamId: readString(record.teamId, 'Stored time entry Team ID'),
    ...(readOptionalString(record.projectId) ? { projectId: readOptionalString(record.projectId) } : {}),
    ...(record.workItemId === undefined ? {} : { workItemId: readString(record.workItemId, 'Stored time entry Work Item ID') }),
    userId: readString(record.userId, 'Stored time entry User ID'),
    startAt: readString(record.startAt, 'Stored time entry start'),
    endAt: readString(record.endAt, 'Stored time entry end'),
    durationMinutes: readNumber(record.durationMinutes, 'Stored duration'),
    ...(record.durationOnly === undefined ? {} : { durationOnly: readDurationOnlyFlag(record.durationOnly) }),
    ...(record.category === undefined ? {} : { category: readStoredCategory(record.category) }),
    ...(readOptionalString(record.description) ? { description: readOptionalString(record.description) } : {}),
    billable: readBoolean(record.billable, 'Stored billable flag'),
    currency: readString(record.currency, 'Stored currency'),
    status: readStatus(record.status),
    source: readSource(record.source),
    revision: readNumber(record.revision, 'Stored entry revision'),
    ...(readOptionalNumber(record.hourlyRateMinor) === undefined ? {} : { hourlyRateMinor: readOptionalNumber(record.hourlyRateMinor) }),
    ...(readOptionalNumber(record.actualCostMinor) === undefined ? {} : { actualCostMinor: readOptionalNumber(record.actualCostMinor) }),
    createdAt: readString(record.createdAt, 'Stored entry creation time'),
    updatedAt: readString(record.updatedAt, 'Stored entry update time'),
    ...(readOptionalString(record.submittedAt) ? { submittedAt: readOptionalString(record.submittedAt) } : {}),
    ...(readOptionalString(record.approvedAt) ? { approvedAt: readOptionalString(record.approvedAt) } : {}),
    ...(readOptionalString(record.rejectedAt) ? { rejectedAt: readOptionalString(record.rejectedAt) } : {}),
    ...(readOptionalString(record.lockedAt) ? { lockedAt: readOptionalString(record.lockedAt) } : {}),
  }
}

/**
 * Reads the stored duration-only marker, which is only ever written as `true`.
 *
 * @param value - Stored `durationOnly` attribute.
 * @returns `true` when the stored marker is valid.
 */
function readDurationOnlyFlag(value: unknown): true {
  if (value !== true) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored duration-only flag is invalid.')
  return true
}

/**
 * Reads a stored work category key, failing closed on values that are not a key.
 *
 * The key is not checked against the Workspace categories, which may have retired it since.
 *
 * @param value - Stored `category` attribute.
 * @returns The stored category.
 */
function readStoredCategory(value: unknown): TimeEntryCategory {
  const category = readTimeEntryCategoryKey(value)
  if (category === undefined) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time entry category is invalid.')
  return category
}

/** Reads a stored timer. */
function readStoredTimer(value: unknown): RunningTimer {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored timer')
  return {
    schemaVersion: 1,
    id: readString(record.id, 'Stored timer ID'),
    workspaceId: readString(record.workspaceId, 'Stored timer Workspace ID'),
    teamId: readString(record.teamId, 'Stored timer Team ID'),
    ...(readOptionalString(record.projectId) ? { projectId: readOptionalString(record.projectId) } : {}),
    workItemId: readString(record.workItemId, 'Stored timer Work Item ID'),
    userId: readString(record.userId, 'Stored timer User ID'),
    startedAt: readString(record.startedAt, 'Stored timer start'),
    ...(readOptionalString(record.description) ? { description: readOptionalString(record.description) } : {}),
    billable: readBoolean(record.billable, 'Stored timer billable flag'),
    revision: readNumber(record.revision, 'Stored timer revision'),
    updatedAt: readString(record.updatedAt, 'Stored timer update time'),
  }
}

/** Reads a stored history record. */
function readStoredHistory(value: unknown): TimeEntryHistory {
  const record = readRecord(value)
  return {
    id: readString(record.id, 'Stored history ID'),
    entryId: readString(record.entryId, 'Stored history entry ID'),
    action: readHistoryAction(record.action),
    ...(readOptionalStatus(record.fromStatus) ? { fromStatus: readOptionalStatus(record.fromStatus) } : {}),
    ...(readOptionalStatus(record.toStatus) ? { toStatus: readOptionalStatus(record.toStatus) } : {}),
    actorUserId: readString(record.actorUserId, 'Stored history actor'),
    ...(readOptionalString(record.reason) ? { reason: readOptionalString(record.reason) } : {}),
    occurredAt: readString(record.occurredAt, 'Stored history timestamp'),
  }
}

/** Reads a stored budget. */
/**
 * Reads a stored Team time entry policy, failing closed on an invalid mode or limit.
 *
 * @param value - Stored item.
 * @returns The stored policy.
 */
function readStoredEntryPolicy(value: unknown): StoredTeamTimeEntryPolicy {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored time entry policy')
  const policy = readTeamTimeEntryPolicy(record)
  if (!policy) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time entry policy is invalid.')
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored policy Workspace ID'),
    teamId: readString(record.teamId, 'Stored policy Team ID'),
    ...policy,
    revision: readNumber(record.revision, 'Stored policy revision'),
    updatedBy: readString(record.updatedBy, 'Stored policy author'),
    updatedAt: readString(record.updatedAt, 'Stored policy update time'),
  }
}

/**
 * Converts a stored policy to the API record.
 *
 * @param policy - Stored policy.
 * @returns The policy with its Team, revision, and save time.
 */
function toEntryPolicyRecord(policy: StoredTeamTimeEntryPolicy): TeamTimeEntryPolicyRecord {
  return {
    teamId: policy.teamId,
    overlap: policy.overlap,
    dailyLimit: policy.dailyLimit,
    dailyLimitMinutes: policy.dailyLimitMinutes,
    revision: policy.revision,
    updatedAt: policy.updatedAt,
  }
}

/**
 * Builds the audit snapshot of a policy.
 *
 * @param policy - Policy and its revision.
 * @returns Audited fields.
 */
function toAuditEntryPolicySnapshot(policy: TeamTimeEntryPolicy & { revision: number }): Record<string, unknown> {
  return {
    overlap: policy.overlap,
    dailyLimit: policy.dailyLimit,
    dailyLimitMinutes: policy.dailyLimitMinutes,
    revision: policy.revision,
  }
}

/**
 * Counts the minutes an entry adds to one local date, split the way reports split it, so a daily
 * total matches the time the report shows for that day, also for an entry that crosses midnight.
 *
 * @param entry - Entry to count.
 * @param date - Local date (`YYYY-MM-DD`).
 * @param timeZone - Time zone that defines the date.
 * @returns Whole minutes on that date, with a started minute of the entry counted as a whole one.
 */
function entryMinutesOnDate(entry: TimeEntry, date: string, timeZone: string): number {
  return splitEntryByLocalDate(entry, timeZone, entry.startAt, entry.endAt)
    .find((segment) => segment.date === date)?.minutes ?? 0
}

function readStoredBudget(value: unknown): TimeBudget {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored budget')
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored budget Workspace ID'),
    teamId: readString(record.teamId, 'Stored budget Team ID'),
    scopeType: readScopeType(record.scopeType),
    scopeId: readString(record.scopeId, 'Stored budget scope ID'),
    amountMinor: readNumber(record.amountMinor, 'Stored budget amount'),
    currency: readString(record.currency, 'Stored budget currency'),
    ...(readOptionalString(record.periodFrom) ? { periodFrom: readOptionalString(record.periodFrom) } : {}),
    ...(readOptionalString(record.periodTo) ? { periodTo: readOptionalString(record.periodTo) } : {}),
    ...readStoredBudgetPeriodFlag(record),
    revision: readNumber(record.revision, 'Stored budget revision'),
    updatedAt: readString(record.updatedAt, 'Stored budget timestamp'),
  }
}

/**
 * Reads the budget-per-period flag of a stored budget, rejecting a flagged row without its period.
 *
 * @param record - Stored budget record.
 * @returns The flag to spread into the budget.
 * @throws TimeTrackingError with `InvalidStoredTimeTrackingRecord` for a flag without both dates.
 */
function readStoredBudgetPeriodFlag(record: Record<string, unknown>): { periodBudget?: true } {
  if (record.periodBudget === undefined) return {}
  if (record.periodBudget !== true || !readOptionalString(record.periodFrom) || !readOptionalString(record.periodTo)) {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored budget period is invalid.')
  }
  return { periodBudget: true }
}

/**
 * Reads a month close value, such as an idempotent replay response.
 *
 * @param value - Stored month close value.
 * @returns The validated month close.
 * @throws TimeTrackingError with `InvalidStoredTimeTrackingRecord` for a malformed value.
 */
function readPeriodCloseValue(value: unknown): TimePeriodClose {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored month close')
  const month = readString(record.month, 'Stored month close month')
  if (!MONTH_PATTERN.test(month)) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored month close month is invalid.')
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored month close Workspace ID'),
    teamId: readString(record.teamId, 'Stored month close Team ID'),
    month,
    timeZone: readString(record.timeZone, 'Stored month close timezone'),
    closedBy: readString(record.closedBy, 'Stored month close actor'),
    closedAt: readString(record.closedAt, 'Stored month close timestamp'),
  }
}

/**
 * Reads a stored month close row and rejects a row whose key and payload disagree, because a
 * mismatched month would make the close check guard a different month than the key.
 *
 * @param value - Stored DynamoDB item.
 * @param workspaceId - Workspace whose partition was queried.
 * @param teamId - Team whose close prefix was queried.
 * @returns The validated month close.
 * @throws TimeTrackingError with `InvalidStoredTimeTrackingRecord` for a malformed or mismatched row.
 */
function readStoredPeriodClose(value: unknown, workspaceId: string, teamId: string): TimePeriodClose {
  const close = readPeriodCloseValue(value)
  const recordKey = readRecord(value).recordKey
  if (close.workspaceId !== workspaceId || close.teamId !== teamId || recordKey !== periodCloseRecordKey(teamId, close.month)) {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored month close does not match its key.')
  }
  return close
}

/** Validates the replay response for a void timer cancellation. */
function readCompletedTimeTrackingMutation(value: unknown): CompletedTimeTrackingMutation {
  if (!isRecord(value) || value.completed !== true) {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time tracking mutation response is invalid.')
  }
  return { completed: true }
}

/**
 * Validates the replay response of a time entry deletion.
 *
 * @param value - Stored idempotency response.
 * @returns The deleted entry's identifier.
 */
function readDeletedTimeEntry(value: unknown): DeletedTimeEntry {
  if (!isRecord(value) || value.deleted !== true || typeof value.entryId !== 'string') {
    throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored time entry deletion response is invalid.')
  }
  return { entryId: value.entryId, deleted: true }
}

/** Rejects missing and future persisted schema versions before parsing fields. */
function readSchemaVersion(record: Record<string, unknown>, label: string): void {
  if (record.schemaVersion !== 1) {
    throw new TimeTrackingError(500, 'UnsupportedStoredTimeTrackingSchema', `${label} schema version is unsupported.`)
  }
}

/** Reads a string from a stored record. */
function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', `${label} is invalid.`)
  return value
}

/** Reads an optional string from a stored record. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Reads a number from a stored record. */
function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', `${label} is invalid.`)
  return value
}

/** Reads an optional number from a stored record. */
function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reads a boolean from a stored record. */
function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', `${label} is invalid.`)
  return value
}

/** Reads a time entry status. */
function readStatus(value: unknown): TimeEntryStatus {
  if (value === 'draft' || value === 'submitted' || value === 'approved' || value === 'rejected' || value === 'locked') return value
  throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored entry status is invalid.')
}

/** Reads a time entry source. */
function readSource(value: unknown): TimeEntrySource {
  if (value === 'manual' || value === 'timer') return value
  throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored entry source is invalid.')
}

/** Reads a history action. */
function readHistoryAction(value: unknown): TimeEntryHistory['action'] {
  if (value === 'created' || value === 'updated' || value === 'submitted' || value === 'approved' || value === 'rejected' || value === 'locked' || value === 'returned') return value
  throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored history action is invalid.')
}

/** Reads an optional status. */
function readOptionalStatus(value: unknown): TimeEntryStatus | undefined {
  if (value === undefined) return undefined
  return readStatus(value)
}

/** Reads a stored scope type. */
function readScopeType(value: unknown): 'team' | 'project' {
  if (value === 'team' || value === 'project') return value
  throw new TimeTrackingError(500, 'InvalidStoredTimeTrackingRecord', 'Stored budget scope is invalid.')
}

/** Converts a conditional write error to a stable domain error. */
function mapConditionalWriteError(error: unknown, code: string, message: string): TimeTrackingError {
  const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined
  if (name === 'ConditionalCheckFailedException') return new TimeTrackingError(409, code, message)
  if (name === 'TransactionCanceledException' && isTransactionConditionFailure(error)) {
    return new TimeTrackingError(409, code, message)
  }
  if (name === 'TransactionCanceledException' && isRetryableTransactionCancellation(error)) {
    return new TimeTrackingError(503, 'TimeTrackingTransientFailure', 'The time tracking transaction was temporarily unavailable. Retry the request.')
  }
  throw error
}

/** Returns whether a transaction was cancelled by an item condition. */
function isTransactionConditionFailure(error: unknown): boolean {
  return readTransactionCancellationCodes(error).includes('ConditionalCheckFailed')
}

/** Returns whether a transaction cancellation represents a retryable outage. */
function isRetryableTransactionCancellation(error: unknown): boolean {
  return readTransactionCancellationCodes(error).some((code) =>
    code === 'TransactionConflict' ||
    code === 'ProvisionedThroughputExceeded' ||
    code === 'ThrottlingError'
  )
}

/** Reads sanitized cancellation reason codes from an AWS transaction error. */
function readTransactionCancellationCodes(error: unknown): string[] {
  if (!isRecord(error) || !Array.isArray(error.CancellationReasons)) return []
  return error.CancellationReasons.flatMap((reason) =>
    isRecord(reason) && typeof reason.Code === 'string' ? [reason.Code] : []
  )
}

/**
 * Builds a transaction condition that holds only while a time entry keeps the given revision, so
 * a write that relied on reading the entry is cancelled when the entry changes.
 *
 * @param tableName - Analytics table that stores time entries.
 * @param workspaceId - Canonical Workspace ID.
 * @param teamId - Team ID.
 * @param entryId - Time entry ID.
 * @param revision - Revision that was read.
 * @returns A `ConditionCheck` transaction item.
 */
export function createTimeEntryRevisionCondition(
  tableName: string,
  workspaceId: string,
  teamId: string,
  entryId: string,
  revision: number,
) {
  return {
    ConditionCheck: {
      TableName: readIdentifier(tableName, 'Time tracking table name'),
      Key: { workspaceId, recordKey: entryKey(teamId, entryId) },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':revision': revision },
    },
  }
}

/** Builds an entry key. */
function entryKey(teamId: string, entryId: string): string {
  return `${ENTRY_PREFIX}${teamId}#${entryId}`
}

/** Builds an in-memory key that includes the Workspace boundary. */
function memoryEntryKey(workspaceId: string, teamId: string, entryId: string): string {
  return `${workspaceId}\0${entryKey(teamId, entryId)}`
}

/** Builds a history lookup key. */
function historyKey(workspaceId: string, teamId: string, entryId: string): string {
  return `${workspaceId}\0${teamId}\0${entryId}`
}

/** Builds an active timer key. */
function timerKey(workspaceId: string, userId: string): string {
  return `${workspaceId}\0${userId}`
}

/** Builds the in-memory key of a budget from its Team-qualified scope. */
function budgetKey(
  workspaceId: string,
  teamId: string,
  scopeType: 'team' | 'project',
  scopeId: string,
  period?: TimeBudgetPeriod,
): string {
  return `${workspaceId}\0${budgetRecordKey(teamId, scopeType, scopeId, period)}`
}

/**
 * Builds the DynamoDB sort key of a budget.
 *
 * A Team budget is keyed by its Team. A Project budget is keyed by the Team and the Project,
 * because Project IDs are unique only within their Team.
 *
 * A budget per period adds `#PERIOD#<from>#<to>` to the scope's key (ADR 0077), so the scope's
 * periods are read with one prefix query.
 *
 * @param teamId - Team that owns the scope.
 * @param scopeType - Budget scope.
 * @param scopeId - Team or Project identifier.
 * @param period - Period of a budget per period; absent for the scope's default budget.
 * @returns The sort key.
 */
function budgetRecordKey(teamId: string, scopeType: 'team' | 'project', scopeId: string, period?: TimeBudgetPeriod): string {
  const scopeKey = scopeType === 'team'
    ? `${BUDGET_PREFIX}team#${scopeId}`
    : `${BUDGET_PREFIX}project#${teamId}#${scopeId}`
  return period ? `${budgetPeriodKeyPrefix(scopeKey)}${period.from}#${period.to}` : scopeKey
}

/**
 * Builds the key prefix of a scope's budgets per period.
 *
 * @param scopeKey - Sort key of the scope's default budget.
 * @returns The prefix every budget per period of the scope starts with.
 */
function budgetPeriodKeyPrefix(scopeKey: string): string {
  return `${scopeKey}#PERIOD#`
}

/**
 * Returns the period a budget per period is stored under.
 *
 * @param budget - Budget to key.
 * @returns The period, or undefined for a default budget.
 */
function budgetStoragePeriod(budget: TimeBudget): TimeBudgetPeriod | undefined {
  return budget.periodBudget && budget.periodFrom && budget.periodTo
    ? { from: budget.periodFrom, to: budget.periodTo }
    : undefined
}

/** Builds the DynamoDB sort key of a month close. */
function periodCloseRecordKey(teamId: string, month: string): string {
  return `${PERIOD_CLOSE_PREFIX}${teamId}#${month}`
}

/** Builds an in-memory month close key that includes the Workspace boundary. */
function periodCloseKey(workspaceId: string, teamId: string, month: string): string {
  return `${workspaceId}\0${periodCloseRecordKey(teamId, month)}`
}

/**
 * Lists the UTC months that a local month in any timezone could share with the intervals.
 *
 * @param intervals - Intervals a write reads or writes.
 * @returns Months as `YYYY-MM`, in order and without duplicates.
 */
function candidateCloseMonths(intervals: ReadonlyArray<{ startAt: string; endAt: string }>): string[] {
  const months = new Set<string>()
  for (const interval of intervals) {
    const first = new Date(Date.parse(interval.startAt) - MAX_TIME_ZONE_OFFSET_MILLISECONDS)
    const last = new Date(Date.parse(interval.endAt) + MAX_TIME_ZONE_OFFSET_MILLISECONDS)
    const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
    while (cursor.getTime() <= last.getTime()) {
      months.add(cursor.toISOString().slice(0, 7))
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  }
  return [...months].sort()
}

/**
 * Builds transaction checks that hold only while each guarded month keeps the close state read.
 *
 * @param tableName - Time tracking table name.
 * @param guard - Close state the write was validated against.
 * @returns One `ConditionCheck` per guarded month.
 */
function createPeriodGuardChecks(tableName: string, guard: TimePeriodGuard | undefined) {
  if (!guard) return []
  return guard.months.map((month) => ({
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId: guard.workspaceId, recordKey: periodCloseRecordKey(guard.teamId, month.month) },
      ...(month.closedAt === undefined
        ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
        : {
            ConditionExpression: 'closedAt = :closedAt',
            ExpressionAttributeValues: { ':closedAt': month.closedAt },
          }),
    },
  }))
}

/**
 * Returns whether a transaction was cancelled by one of its leading month close checks.
 *
 * @param error - Error thrown by the transaction.
 * @param guardCount - Number of month close checks at the start of the transaction.
 * @returns True when a month close check failed.
 */
function isPeriodGuardFailure(error: unknown, guardCount: number): boolean {
  if (guardCount === 0 || !isRecord(error) || error.name !== 'TransactionCanceledException') return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  return reasons.slice(0, guardCount).some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
}

/**
 * Returns whether a transaction was cancelled only by the caller authorization checks, and not by
 * an earlier item such as the entry's own revision condition.
 *
 * @param error - Error thrown by the transaction.
 * @param start - Index of the first authorization check.
 * @param count - Number of authorization checks.
 * @returns True when an authorization check failed and no item before them did.
 */
function isAuthorizationCheckOnlyFailure(error: unknown, start: number, count: number): boolean {
  if (count === 0 || !isRecord(error) || error.name !== 'TransactionCanceledException') return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  const failed = (reason: unknown) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
  return reasons.slice(start, start + count).some(failed) && !reasons.slice(0, start).some(failed)
}

/** Creates the error for a write whose month was closed or reopened after validation. */
function periodGuardError(): TimeTrackingError {
  return new TimeTrackingError(409, 'TimePeriodClosed', 'A month this entry touches was closed or reopened while saving. Reload and try again.')
}

/** Clones test repository values without exposing mutable state. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Escapes one CSV field. */
function csvCell(value: string | number): string {
  const raw = String(value)
  const text = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Input keys left out of request fingerprints: the key itself, and authorization
 * context the route derives from current state. A retry after a successful
 * mutation can derive different values (for example, after an entry moved into a
 * Project the caller manages) and must still replay the stored result.
 */
const IDEMPOTENCY_FINGERPRINT_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'canManageRates',
  'canApprove',
  'authorizedRevision',
  'authorizationConditionChecks',
])

/** Creates a stable request fingerprint while excluding the idempotency key itself. */
function createTimeTrackingRequestFingerprint(operation: string, input: object): string {
  // A currency the route filled from the Workspace default is not what the client sent, so a retry
  // after the default changes still replays the stored result.
  const defaultedCurrency = 'currencyFromWorkspaceDefault' in input && input.currencyFromWorkspaceDefault === true
  const body = Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !IDEMPOTENCY_FINGERPRINT_EXCLUDED_KEYS.has(key))
      .filter(([key]) => !(defaultedCurrency && key === 'currency'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sortRequestValue(value)]),
  )
  return JSON.stringify({ operation, body })
}

/** Recursively sorts object keys before they are included in a request fingerprint. */
function sortRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRequestValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortRequestValue(child)]),
  )
}
