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
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  isActiveTimeEntryCategory,
  readTimeEntryCategoryKey,
  type WorkspaceTimeEntryCategorySettings,
  type RunningTimer,
  type TimeBudget,
  type TimeEntry,
  type TimeEntryCategory,
  type TimeEntryHistory,
  type TimeEntrySource,
  type TimeEntryStatus,
  type TimePeriodClose,
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
const PERIOD_CLOSE_PREFIX = 'TIME_CLOSE#'
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
  /** Inclusive local period start. */
  periodFrom?: string
  /** Inclusive local period end. */
  periodTo?: string
  /** Expected budget revision, or zero for a new budget. */
  expectedRevision: number
  /** Actor changing the budget. */
  updatedBy: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
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
  /** Reads a Team or Project budget. */
  getBudget(workspaceId: string, scopeType: 'team' | 'project', scopeId: string): Promise<TimeBudget | undefined>
  /** Saves a Team or Project budget with optimistic concurrency and optional audit. */
  saveBudget(budget: TimeBudget, expectedRevision: number, auditPut?: AuditTransactWriteItem, idempotencyPut?: AuditTransactWriteItem): Promise<void>
  /** Lists the closed months of a Team in month order. */
  listPeriodCloses(workspaceId: string, teamId: string): Promise<TimePeriodClose[]>
  /** Stores a month close and rejects a month that is already closed. */
  createPeriodClose(close: TimePeriodClose, auditPut?: AuditTransactWriteItem, idempotencyPut?: AuditTransactWriteItem): Promise<void>
  /** Removes a month close only while it is the same close that was read. */
  deletePeriodClose(close: TimePeriodClose, auditPut?: AuditTransactWriteItem, idempotencyPut?: AuditTransactWriteItem): Promise<void>
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
  /** Read port for Workspace work categories; the built-in categories when absent. */
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
    return await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'time-entry.create',
      input,
      (completion) => this.createEntryInternal(input, canManageRates, completion),
      readStoredEntry,
    )
  }

  /** Persists a manual time entry without the public idempotency wrapper. */
  private async createEntryInternal(
    input: CreateTimeEntryInput,
    canManageRates: boolean,
    completion?: TimeTrackingIdempotencyCompletion,
  ): Promise<TimeEntry> {
    const normalized = normalizeCreateInput(input, canManageRates)
    if (normalized.category !== undefined) await this.requireActiveCategory(normalized.workspaceId, normalized.category)
    const periodGuard = await this.requireOpenPeriod(normalized.workspaceId, normalized.teamId, [normalized])
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
    return await this.withIdempotency(
      input.workspaceId,
      input.actorUserId,
      input.idempotencyKey,
      'time-entry.update',
      input,
      (completion) => this.updateEntryInternal(input, completion),
      readStoredEntry,
    )
  }

  /** Persists an entry update without the public idempotency wrapper. */
  private async updateEntryInternal(
    input: UpdateTimeEntryInput,
    completion?: TimeTrackingIdempotencyCompletion,
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
    const hourlyRateMinor = input.hourlyRateMinor === undefined
      ? undefined
      : requireMoney(input.hourlyRateMinor, 'Hourly rate')
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
      currency: normalizedCurrency,
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
    const current = await this.repository.getBudget(workspaceId, input.scopeType, scopeId)
    if (current && current.revision !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
    if (!current && expectedRevision !== 0) {
      throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget does not exist at the requested revision.')
    }
    const budget: TimeBudget = {
      schemaVersion: 1,
      workspaceId,
      scopeType: input.scopeType,
      scopeId,
      amountMinor,
      currency,
      ...(input.periodFrom ? { periodFrom: input.periodFrom } : {}),
      ...(input.periodTo ? { periodTo: input.periodTo } : {}),
      revision: expectedRevision + 1,
      updatedAt: readNow(this.now).toISOString(),
    }
    const auditPut = this.createAuditEventPut({
      workspaceId,
      teamId: resolvedTeamId,
      actorUserId: input.updatedBy,
      eventType: 'time-budget.updated',
      entityType: 'time-budget',
      entityId: `${input.scopeType}:${scopeId}`,
      action: 'updated',
      idempotencyKey: input.idempotencyKey ?? this.createId(),
      requestBody: {
        action: 'budget.updated',
        scopeType: input.scopeType,
        scopeId,
        revision: budget.revision,
      },
      before: current ? toAuditBudgetSnapshot(current) : undefined,
      after: toAuditBudgetSnapshot(budget),
      includeFields: ['scopeType', 'scopeId', 'amountMinor', 'currency', 'periodFrom', 'periodTo', 'revision'],
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
    await this.repository.saveBudget(
      budget,
      expectedRevision,
      auditPut,
      idempotencyPut,
    )
    return budget
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
    await this.repository.createPeriodClose(close, auditPut, idempotencyPut)
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
    await this.repository.deletePeriodClose(close, auditPut, idempotencyPut)
    return close
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

  /** Builds an ACL-filtered aggregate report. */
  async createSummary(input: TimeTrackingReportInput): Promise<TimeTrackingSummary> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listReportEntries(input, period)
    const estimateByWorkItem = await this.listPlannedEffort(input.workspaceId, input.teamId)
    const categoryLabels = input.groupBy === 'category'
      ? readCategoryLabels(await this.readCategorySettings(input.workspaceId))
      : undefined
    const groups = aggregateEntries(entries, input.groupBy, input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds, categoryLabels)
    const includeBudget = input.includeCosts && (
      input.budgetScope !== 'project' ||
      input.managedProjectIds === undefined ||
      (input.budgetScopeId !== undefined && input.managedProjectIds.has(input.budgetScopeId))
    )
    const budget = !includeBudget
      ? undefined
      : input.budgetScope === 'project' && input.budgetScopeId
        ? await this.repository.getBudget(input.workspaceId, 'project', input.budgetScopeId)
        : await this.repository.getBudget(input.workspaceId, 'team', input.teamId)
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
      costsRedacted: !input.includeCosts,
      canManageTeam: input.viewer?.canManage ?? true,
    }
  }

  /** Builds daily and weekly timesheet rows with DST-aware local boundaries. */
  async createTimesheet(input: TimeTrackingReportInput): Promise<TimeSheet> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listReportEntries(input, period)
    const estimateByWorkItem = await this.listPlannedEffort(input.workspaceId, input.teamId)
    const days = aggregateCalendarEntries(entries, 'day', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
    const weeks = aggregateCalendarEntries(entries, 'week', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
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
  async getBudget(workspaceId: string, scopeType: 'team' | 'project', scopeId: string) {
    const budget = this.budgets.get(budgetKey(workspaceId, scopeType, scopeId))
    return budget ? clone(budget) : undefined
  }

  /** Saves a budget. */
  async saveBudget(
    budget: TimeBudget,
    expectedRevision: number,
    _auditPut?: AuditTransactWriteItem,
    _idempotencyPut?: AuditTransactWriteItem,
  ) {
    const key = budgetKey(budget.workspaceId, budget.scopeType, budget.scopeId)
    const current = this.budgets.get(key)
    if ((current?.revision ?? 0) !== expectedRevision) throw new TimeTrackingError(409, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
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

  /** Reads a Team or Project budget. */
  async getBudget(workspaceId: string, scopeType: 'team' | 'project', scopeId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: `${BUDGET_PREFIX}${scopeType}#${scopeId}` },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredBudget(response.Item) : undefined
  }

  /** Saves a budget with optimistic concurrency. */
  async saveBudget(
    budget: TimeBudget,
    expectedRevision: number,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ) {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...budget, recordKey: `${BUDGET_PREFIX}${budget.scopeType}#${budget.scopeId}` },
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
      throw mapConditionalWriteError(error, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
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

  /** Stores a month close with a conditional put, in a transaction when audited. */
  async createPeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
  ): Promise<void> {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...close, recordKey: periodCloseRecordKey(close.teamId, close.month) },
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
      throw mapConditionalWriteError(error, 'TimePeriodAlreadyClosed', `${close.month} is already closed.`)
    }
  }

  /** Deletes a month close only while its close timestamp is unchanged. */
  async deletePeriodClose(
    close: TimePeriodClose,
    auditPut?: AuditTransactWriteItem,
    idempotencyPut?: AuditTransactWriteItem,
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
      if (auditPut || idempotencyPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [deletion, ...(auditPut ? [auditPut] : []), ...(idempotencyPut ? [idempotencyPut] : [])],
        }))
      } else {
        await this.documentClient.send(new DeleteCommand(deletion.Delete))
      }
    } catch (error) {
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
): TimeSummaryGroup[] {
  if (groupBy === 'day' || groupBy === 'week') {
    return aggregateCalendarEntries(entries, groupBy, timeZone, from, to, estimateByWorkItem, includeCosts, managedProjectIds)
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

/** Aggregates entries into local day or Monday-based week buckets. */
function aggregateCalendarEntries(
  entries: readonly TimeEntry[],
  groupBy: 'day' | 'week',
  timeZone: string,
  from: string,
  to: string,
  estimateByWorkItem: ReadonlyMap<string, number>,
  includeCosts: boolean,
  managedProjectIds?: ReadonlySet<string>,
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
    const key = groupBy === 'day' ? segment.date : mondayOfWeek(segment.date)
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

/** Creates a budget snapshot with the amount available for field-level redaction. */
function toAuditBudgetSnapshot(budget: TimeBudget): Record<string, unknown> {
  return {
    scopeType: budget.scopeType,
    scopeId: budget.scopeId,
    amountMinor: budget.amountMinor,
    currency: budget.currency,
    ...(budget.periodFrom ? { periodFrom: budget.periodFrom } : {}),
    ...(budget.periodTo ? { periodTo: budget.periodTo } : {}),
    revision: budget.revision,
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

/** Returns the Monday date for a local date. */
function mondayOfWeek(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  const weekday = value.getUTCDay()
  value.setUTCDate(value.getUTCDate() - (weekday === 0 ? 6 : weekday - 1))
  return value.toISOString().slice(0, 10)
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
function readStoredBudget(value: unknown): TimeBudget {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored budget')
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored budget Workspace ID'),
    scopeType: readScopeType(record.scopeType),
    scopeId: readString(record.scopeId, 'Stored budget scope ID'),
    amountMinor: readNumber(record.amountMinor, 'Stored budget amount'),
    currency: readString(record.currency, 'Stored budget currency'),
    ...(readOptionalString(record.periodFrom) ? { periodFrom: readOptionalString(record.periodFrom) } : {}),
    ...(readOptionalString(record.periodTo) ? { periodTo: readOptionalString(record.periodTo) } : {}),
    revision: readNumber(record.revision, 'Stored budget revision'),
    updatedAt: readString(record.updatedAt, 'Stored budget timestamp'),
  }
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

/** Builds a budget key. */
function budgetKey(workspaceId: string, scopeType: 'team' | 'project', scopeId: string): string {
  return `${workspaceId}\0${scopeType}\0${scopeId}`
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
  const body = Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !IDEMPOTENCY_FINGERPRINT_EXCLUDED_KEYS.has(key))
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
