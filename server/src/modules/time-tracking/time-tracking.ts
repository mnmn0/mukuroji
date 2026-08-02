import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  RunningTimer,
  TimeBudget,
  TimeEntry,
  TimeEntryHistory,
  TimeEntrySource,
  TimeEntryStatus,
  TimeEstimate,
  TimeSheet,
  TimeSummaryGroup,
  TimeTrackingGroupBy,
  TimeTrackingSummary,
} from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditEventTransactPut,
  createMutationAuditContext,
  type AuditTransactWriteItem,
} from '../audit'

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
}

const ENTRY_PREFIX = 'TIME_ENTRY#'
const HISTORY_PREFIX = 'TIME_HISTORY#'
const TIMER_PREFIX = 'TIME_TIMER#'
const ESTIMATE_PREFIX = 'TIME_ESTIMATE#'
const BUDGET_PREFIX = 'TIME_BUDGET#'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const ISO_INSTANT_PATTERN = /T.*(?:Z|[+-]\d{2}:\d{2})$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const MAX_DESCRIPTION_LENGTH = 4_000
const MAX_ENTRY_DURATION_MINUTES = 24 * 60 * 7
const MAX_LIST_LIMIT = 500
const TIME_ENTRY_AUDIT_FIELDS = [
  'status',
  'revision',
  'startAt',
  'endAt',
  'durationMinutes',
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
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Member recording the work. */
  userId: string
  /** Interval start. */
  startAt: string
  /** Interval end. */
  endAt: string
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
  /** Optional new start. */
  startAt?: string
  /** Optional new end. */
  endAt?: string
  /** Optional new Work Item. */
  workItemId?: string
  /** Optional new Project. */
  projectId?: string | null
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
  /** Requested transition. */
  action: 'submit' | 'approve' | 'reject' | 'lock'
  /** Optional rejection reason. */
  reason?: string
  /** Optional client key used to make audit writes idempotent across retries. */
  idempotencyKey?: string
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

/** An estimate update request. */
export type SaveTimeEstimateInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Planned effort in minutes. */
  estimateMinutes: number
  /** Expected estimate revision, or zero for a new estimate. */
  expectedRevision: number
  /** Actor changing the estimate. */
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
  /** Explicit budget scope selected by the caller. */
  budgetScope?: 'team' | 'project'
  /** Project ID used when budgetScope is project. */
  budgetScopeId?: string
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
  ): Promise<void>
  /** Saves an immutable lifecycle history record. */
  saveHistory(workspaceId: string, teamId: string, history: TimeEntryHistory): Promise<void>
  /** Lists immutable lifecycle history for an entry. */
  listHistory(workspaceId: string, teamId: string, entryId: string): Promise<TimeEntryHistory[]>
  /** Reads the active timer for one Workspace member. */
  getActiveTimer(workspaceId: string, userId: string): Promise<RunningTimer | undefined>
  /** Removes the active timer with an optimistic identity check. */
  cancelTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem): Promise<void>
  /** Creates an active timer and rejects a duplicate active timer. */
  createTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem): Promise<void>
  /** Stops a timer and persists its resulting entry atomically where supported. */
  finishTimer(
    timer: RunningTimer,
    entry: TimeEntry,
    history: TimeEntryHistory,
    auditPut?: AuditTransactWriteItem,
  ): Promise<void>
  /** Reads a Work Item estimate. */
  getEstimate(workspaceId: string, teamId: string, workItemId: string): Promise<TimeEstimate | undefined>
  /** Lists estimates in a Team. */
  listEstimates(workspaceId: string, teamId: string): Promise<TimeEstimate[]>
  /** Saves a Work Item estimate with optimistic concurrency and optional audit. */
  saveEstimate(estimate: TimeEstimate, expectedRevision: number, auditPut?: AuditTransactWriteItem): Promise<void>
  /** Reads a Team or Project budget. */
  getBudget(workspaceId: string, scopeType: 'team' | 'project', scopeId: string): Promise<TimeBudget | undefined>
  /** Saves a Team or Project budget with optimistic concurrency and optional audit. */
  saveBudget(budget: TimeBudget, expectedRevision: number, auditPut?: AuditTransactWriteItem): Promise<void>
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

  /** Creates a time tracking service. */
  constructor(
    repository: TimeTrackingRepository,
    options: {
      now?: () => Date
      createId?: () => string
      audit?: TimeTrackingAuditOptions
      idempotency?: TimeTrackingIdempotencyPort
    } = {},
  ) {
    this.repository = repository
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.audit = options.audit
    this.idempotency = options.idempotency
  }

  /** Creates a manual time entry in draft state. */
  async createEntry(input: CreateTimeEntryInput, canManageRates: boolean): Promise<TimeEntry> {
    return await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'time-entry.create',
      input,
      () => this.createEntryInternal(input, canManageRates),
      readStoredEntry,
    )
  }

  /** Persists a manual time entry without the public idempotency wrapper. */
  private async createEntryInternal(input: CreateTimeEntryInput, canManageRates: boolean): Promise<TimeEntry> {
    const normalized = normalizeCreateInput(input, canManageRates)
    const now = readNow(this.now)
    const entry: TimeEntry = {
      schemaVersion: 1,
      id: this.createId(),
      workspaceId: normalized.workspaceId,
      teamId: normalized.teamId,
      ...(normalized.projectId ? { projectId: normalized.projectId } : {}),
      workItemId: normalized.workItemId,
      userId: normalized.userId,
      startAt: normalized.startAt,
      endAt: normalized.endAt,
      durationMinutes: calculateDurationMinutes(normalized.startAt, normalized.endAt),
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
    await this.repository.saveEntryWithHistory(
      entry,
      history,
      undefined,
      this.createAuditPut(entry, history, undefined, input.idempotencyKey),
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
      () => this.updateEntryInternal(input),
      readStoredEntry,
    )
  }

  /** Persists an entry update without the public idempotency wrapper. */
  private async updateEntryInternal(input: UpdateTimeEntryInput): Promise<TimeEntry> {
    const current = await this.requireEntry(input.workspaceId, input.entryId, input.teamId)
    if (current.userId !== input.actorUserId && !input.canManageRates) {
      throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner or a manager may edit this entry.')
    }
    if (current.status !== 'draft' && current.status !== 'rejected') {
      throw new TimeTrackingError(409, 'TimeEntryNotEditable', 'Submitted, approved, and locked entries cannot be edited.')
    }
    if (current.revision !== input.expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEntryRevisionConflict', 'The time entry was changed by another request.')
    }
    const startAt = input.startAt === undefined
      ? current.startAt
      : validateInstant(input.startAt, 'Entry start')
    const endAt = input.endAt === undefined
      ? current.endAt
      : validateInstant(input.endAt, 'Entry end')
    validateInterval(startAt, endAt)
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
    const now = readNow(this.now).toISOString()
    const next: TimeEntry = {
      ...current,
      ...(input.projectId === null ? { projectId: undefined } : input.projectId === undefined ? {} : { projectId: readIdentifier(input.projectId, 'Project ID') }),
      workItemId: input.workItemId === undefined ? current.workItemId : readIdentifier(input.workItemId, 'Work Item ID'),
      startAt,
      endAt,
      durationMinutes: calculateDurationMinutes(startAt, endAt),
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
    await this.repository.saveEntryWithHistory(
      next,
      history,
      current.revision,
      this.createAuditPut(next, history, current, input.idempotencyKey),
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
      () => this.transitionEntryInternal(input),
      readStoredEntry,
    )
  }

  /** Applies an entry transition without the public idempotency wrapper. */
  private async transitionEntryInternal(input: TransitionTimeEntryInput): Promise<TimeEntry> {
    const current = await this.requireEntry(input.workspaceId, input.entryId, input.teamId)
    if (current.revision !== input.expectedRevision) {
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
      throw new TimeTrackingError(403, 'TimesheetApprovalDenied', 'Only a manager may approve, reject, or lock time.')
    }
    const transition = transitionFor(current.status, input.action)
    if (!transition) {
      throw new TimeTrackingError(409, 'InvalidTimeEntryTransition', `Cannot ${input.action} an entry in ${current.status} state.`)
    }
    const now = readNow(this.now).toISOString()
    const next: TimeEntry = {
      ...current,
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
      input.action === 'submit'
        ? 'submitted'
        : input.action === 'reject'
          ? 'rejected'
          : input.action === 'approve'
            ? 'approved'
            : input.action === 'lock'
              ? 'locked'
          : input.action,
      input.actorUserId,
      new Date(now),
      current.status,
      transition.toStatus,
      input.reason,
    )
    await this.repository.saveEntryWithHistory(
      next,
      history,
      current.revision,
      this.createAuditPut(next, history, current, input.idempotencyKey),
    )
    return next
  }

  /** Starts the member's one allowed running timer. */
  async startTimer(input: StartTimerInput): Promise<RunningTimer> {
    return await this.withIdempotency(
      input.workspaceId,
      input.userId,
      input.idempotencyKey,
      'timer.start',
      input,
      () => this.startTimerInternal(input),
      readStoredTimer,
    )
  }

  /** Starts a timer without the public idempotency wrapper. */
  private async startTimerInternal(input: StartTimerInput): Promise<RunningTimer> {
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
    await this.repository.createTimer(timer, this.createAuditEventPut({
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
    }))
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
      () => this.stopTimerInternal(input),
      readStoredEntry,
    )
  }

  /** Stops a timer without the public idempotency wrapper. */
  private async stopTimerInternal(input: StopTimerInput): Promise<TimeEntry> {
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
    await this.repository.finishTimer(
      timer,
      entry,
      history,
      this.createAuditPut(entry, history, undefined, input.idempotencyKey),
    )
    return entry
  }

  /** Cancels an active timer without creating a time entry. */
  async cancelTimer(input: CancelTimerInput): Promise<void> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const userId = readIdentifier(input.userId, 'User ID')
    const timerId = readIdentifier(input.timerId, 'Timer ID')
    const timer = await this.repository.getActiveTimer(workspaceId, userId)
    if (!timer || timer.id !== timerId) {
      throw new TimeTrackingError(404, 'RunningTimerNotFound', 'The running timer was not found or has already been stopped.')
    }
    await this.repository.cancelTimer(timer, this.createAuditEventPut({
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
      path: `/api/time-tracking/timers/${timer.id}`,
    }))
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

  /** Saves a Work Item estimate. */
  async saveEstimate(input: SaveTimeEstimateInput): Promise<TimeEstimate> {
    return await this.withIdempotency(
      input.workspaceId,
      input.updatedBy,
      input.idempotencyKey,
      'time-estimate.save',
      input,
      () => this.saveEstimateInternal(input),
      readStoredEstimate,
    )
  }

  /** Saves an estimate without the public idempotency wrapper. */
  private async saveEstimateInternal(input: SaveTimeEstimateInput): Promise<TimeEstimate> {
    const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const workItemId = readIdentifier(input.workItemId, 'Work Item ID')
    const estimateMinutes = requireInteger(input.estimateMinutes, 'Estimate minutes', 0, MAX_ENTRY_DURATION_MINUTES * 365)
    const expectedRevision = requireInteger(input.expectedRevision, 'Estimate revision', 0, Number.MAX_SAFE_INTEGER)
    const current = await this.repository.getEstimate(workspaceId, teamId, workItemId)
    if (current && current.revision !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEstimateRevisionConflict', 'The estimate was changed by another request.')
    }
    if (!current && expectedRevision !== 0) {
      throw new TimeTrackingError(409, 'TimeEstimateRevisionConflict', 'The estimate does not exist at the requested revision.')
    }
    const estimate: TimeEstimate = {
      schemaVersion: 1,
      workspaceId,
      teamId,
      workItemId,
      estimateMinutes,
      revision: expectedRevision + 1,
      updatedBy: readIdentifier(input.updatedBy, 'User ID'),
      updatedAt: readNow(this.now).toISOString(),
    }
    await this.repository.saveEstimate(
      estimate,
      expectedRevision,
      this.createAuditEventPut({
        workspaceId,
        teamId,
        actorUserId: estimate.updatedBy,
        eventType: 'time-estimate.updated',
        entityType: 'work-item',
        entityId: workItemId,
        action: 'updated',
        idempotencyKey: input.idempotencyKey ?? this.createId(),
        requestBody: { action: 'estimate.updated', workItemId, estimateMinutes },
        before: current ? toAuditEstimateSnapshot(current) : undefined,
        after: toAuditEstimateSnapshot(estimate),
        includeFields: ['teamId', 'workItemId', 'estimateMinutes', 'revision', 'updatedBy'],
        metadata: { teamId, workItemId },
        path: `/api/teams/${teamId}/work-items/${workItemId}/time-estimate`,
        occurredAt: estimate.updatedAt,
      }),
    )
    return estimate
  }

  /** Reads a Work Item estimate for an authorized report or detail view. */
  async getEstimate(workspaceId: string, teamId: string, workItemId: string): Promise<TimeEstimate | undefined> {
    return await this.repository.getEstimate(
      readIdentifier(workspaceId, 'Workspace ID'),
      readIdentifier(teamId, 'Team ID'),
      readIdentifier(workItemId, 'Work Item ID'),
    )
  }

  /** Saves a Team or Project budget. */
  async saveBudget(input: SaveTimeBudgetInput): Promise<TimeBudget> {
    return await this.withIdempotency(
      input.workspaceId,
      input.updatedBy,
      input.idempotencyKey,
      'time-budget.save',
      input,
      () => this.saveBudgetInternal(input),
      readStoredBudget,
    )
  }

  /** Saves a budget without the public idempotency wrapper. */
  private async saveBudgetInternal(input: SaveTimeBudgetInput): Promise<TimeBudget> {
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
    await this.repository.saveBudget(
      budget,
      expectedRevision,
      this.createAuditEventPut({
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
      }),
    )
    return budget
  }

  /** Builds an ACL-filtered aggregate report. */
  async createSummary(input: TimeTrackingReportInput): Promise<TimeTrackingSummary> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listAllEntries({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      from: period.from,
      to: period.to,
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
    })
    const estimates = await this.repository.listEstimates(input.workspaceId, input.teamId)
    const estimateByWorkItem = new Map(estimates.map((estimate) => [estimate.workItemId, estimate.estimateMinutes]))
    const groups = aggregateEntries(entries, input.groupBy, input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
    const budget = input.budgetScope === 'project' && input.budgetScopeId
      ? await this.repository.getBudget(input.workspaceId, 'project', input.budgetScopeId)
      : await this.repository.getBudget(input.workspaceId, 'team', input.teamId)
    const totalEstimateMinutes = [...new Set(entries.map((entry) => entry.workItemId))]
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
      ...(input.includeCosts && budget ? { budget } : {}),
      costsRedacted: !input.includeCosts,
    }
  }

  /** Builds daily and weekly timesheet rows with DST-aware local boundaries. */
  async createTimesheet(input: TimeTrackingReportInput): Promise<TimeSheet> {
    const period = normalizePeriod(input.from, input.to, input.timeZone)
    const entries = await this.listAllEntries({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      from: period.from,
      to: period.to,
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
    })
    const estimates = await this.repository.listEstimates(input.workspaceId, input.teamId)
    const estimateByWorkItem = new Map(estimates.map((estimate) => [estimate.workItemId, estimate.estimateMinutes]))
    const days = aggregateCalendarEntries(entries, 'day', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
    const weeks = aggregateCalendarEntries(entries, 'week', input.timeZone, period.from, period.to, estimateByWorkItem, input.includeCosts, input.managedProjectIds)
    return {
      from: period.from,
      to: period.to,
      timeZone: input.timeZone,
      days,
      weeks,
      costsRedacted: !input.includeCosts,
    }
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
    execute: () => Promise<T>,
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
    try {
      const result = await execute()
      await this.idempotency.completeIdempotency({ ...completionRequest, response: result })
      return result
    } catch (error) {
      await this.idempotency.releaseIdempotency(completionRequest).catch(() => undefined)
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
        teamId: entry.teamId,
        workItemId: entry.workItemId,
        status: entry.status,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
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

/** In-memory repository for isolated application tests and local development. */
export class InMemoryTimeTrackingRepository implements TimeTrackingRepository {
  /** Stored entries keyed by Workspace, Team, and ID. */
  private readonly entries = new Map<string, TimeEntry>()
  /** Stored history records keyed by Workspace, Team, and entry ID. */
  private readonly histories = new Map<string, TimeEntryHistory[]>()
  /** Active timers keyed by Workspace and member. */
  private readonly timers = new Map<string, RunningTimer>()
  /** Stored estimates keyed by Workspace, Team, and Work Item. */
  private readonly estimates = new Map<string, TimeEstimate>()
  /** Stored budgets keyed by Workspace, scope type, and scope ID. */
  private readonly budgets = new Map<string, TimeBudget>()

  /** Lists matching entries. */
  async listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const from = input.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY
    const to = input.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY
    if (Number.isNaN(from) || Number.isNaN(to)) throw new TimeTrackingError(400, 'InvalidTimeRange', 'Time range is invalid.')
    const matching = [...this.entries.values()]
      .filter((entry) => entry.workspaceId === input.workspaceId && entry.teamId === input.teamId)
      .filter((entry) => input.userId === undefined || entry.userId === input.userId)
      .filter((entry) => input.status === undefined || entry.status === input.status)
      .filter((entry) => input.projectIds === undefined || (entry.projectId !== undefined && input.projectIds.has(entry.projectId)))
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
  ) {
    await this.saveEntry(entry, expectedRevision)
    await this.saveHistory(entry.workspaceId, entry.teamId, history)
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
  async cancelTimer(timer: RunningTimer, _auditPut?: AuditTransactWriteItem) {
    const key = timerKey(timer.workspaceId, timer.userId)
    const current = this.timers.get(key)
    if (!current || current.id !== timer.id || current.revision !== timer.revision) {
      throw new TimeTrackingError(409, 'RunningTimerConflict', 'The running timer changed before it was cancelled.')
    }
    this.timers.delete(key)
  }

  /** Creates an active timer and rejects duplicates. */
  async createTimer(timer: RunningTimer, _auditPut?: AuditTransactWriteItem) {
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
  ) {
    const key = timerKey(timer.workspaceId, timer.userId)
    const current = this.timers.get(key)
    if (!current || current.id !== timer.id || current.revision !== timer.revision) {
      throw new TimeTrackingError(409, 'RunningTimerConflict', 'The running timer changed before it was stopped.')
    }
    this.timers.delete(key)
    await this.saveEntry(entry)
    await this.saveHistory(entry.workspaceId, entry.teamId, history)
  }

  /** Reads an estimate. */
  async getEstimate(workspaceId: string, teamId: string, workItemId: string) {
    const estimate = this.estimates.get(estimateKey(workspaceId, teamId, workItemId))
    return estimate ? clone(estimate) : undefined
  }

  /** Lists estimates. */
  async listEstimates(workspaceId: string, teamId: string) {
    return [...this.estimates.values()]
      .filter((estimate) => estimate.workspaceId === workspaceId && estimate.teamId === teamId)
      .map(clone)
  }

  /** Saves an estimate. */
  async saveEstimate(estimate: TimeEstimate, expectedRevision: number, _auditPut?: AuditTransactWriteItem) {
    const key = estimateKey(estimate.workspaceId, estimate.teamId, estimate.workItemId)
    const current = this.estimates.get(key)
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new TimeTrackingError(409, 'TimeEstimateRevisionConflict', 'The estimate was changed by another request.')
    }
    this.estimates.set(
      key,
      clone(estimate),
    )
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

  /** Lists Team entries by the shared Workspace partition. */
  async listEntries(input: ListTimeEntriesInput): Promise<TimeEntry[]> {
    const limit = input.limit ?? MAX_LIST_LIMIT
    const entries: TimeEntry[] = []
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey']
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': input.workspaceId,
          ':prefix': `${ENTRY_PREFIX}${input.teamId}#`,
        },
        ConsistentRead: true,
        Limit: limit,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        const entry = readStoredEntry(item)
        if (input.userId !== undefined && entry.userId !== input.userId) continue
        if (input.status !== undefined && entry.status !== input.status) continue
        if (input.projectIds !== undefined && (entry.projectId === undefined || !input.projectIds.has(entry.projectId))) continue
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
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
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
        ],
      }))
    } catch (error) {
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
  async cancelTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem) {
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
      if (auditPut) {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: [deletion, auditPut] }))
      } else {
        await this.documentClient.send(new DeleteCommand(deletion.Delete))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'RunningTimerConflict', 'The running timer changed before it was cancelled.')
    }
  }

  /** Creates an active timer with a conditional put. */
  async createTimer(timer: RunningTimer, auditPut?: AuditTransactWriteItem) {
    try {
      const put = {
        Put: {
          TableName: this.tableName,
          Item: { ...timer, recordKey: `${TIMER_PREFIX}${timer.userId}` },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      }
      if (auditPut) {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: [put, auditPut] }))
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
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
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
        ],
      }))
    } catch (error) {
      throw mapConditionalWriteError(error, 'RunningTimerConflict', 'The running timer changed before it was stopped.')
    }
  }

  /** Reads an estimate. */
  async getEstimate(workspaceId: string, teamId: string, workItemId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: `${ESTIMATE_PREFIX}${teamId}#${workItemId}` },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredEstimate(response.Item) : undefined
  }

  /** Lists Team estimates. */
  async listEstimates(workspaceId: string, teamId: string) {
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': workspaceId,
        ':prefix': `${ESTIMATE_PREFIX}${teamId}#`,
      },
      ConsistentRead: true,
    }))
    return (response.Items ?? []).map(readStoredEstimate)
  }

  /** Saves an estimate using a single-owner key. */
  async saveEstimate(estimate: TimeEstimate, expectedRevision: number, auditPut?: AuditTransactWriteItem) {
    const item = {
      ...estimate,
      recordKey: `${ESTIMATE_PREFIX}${estimate.teamId}#${estimate.workItemId}`,
    }
    const condition = expectedRevision === 0
      ? {
          ConditionExpression: 'attribute_not_exists(recordKey)',
        }
      : {
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
        }
    if (!auditPut) {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ...condition,
      }))
      return
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: item, ...condition } },
          auditPut,
        ],
      }))
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeEstimateRevisionConflict', 'The estimate was changed by another request.')
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
  async saveBudget(budget: TimeBudget, expectedRevision: number, auditPut?: AuditTransactWriteItem) {
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
      if (auditPut) {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: [put, auditPut] }))
      } else {
        await this.documentClient.send(new PutCommand(put.Put))
      }
    } catch (error) {
      throw mapConditionalWriteError(error, 'TimeBudgetRevisionConflict', 'The budget was changed by another request.')
    }
  }
}

/** Normalizes and validates a manual entry request. */
function normalizeCreateInput(input: CreateTimeEntryInput, canManageRates: boolean): CreateTimeEntryInput {
  const workspaceId = readIdentifier(input.workspaceId, 'Workspace ID')
  const teamId = readIdentifier(input.teamId, 'Team ID')
  const workItemId = readIdentifier(input.workItemId, 'Work Item ID')
  const userId = readIdentifier(input.userId, 'User ID')
  const startAt = validateInstant(input.startAt, 'Entry start')
  const endAt = validateInstant(input.endAt, 'Entry end')
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
    workItemId,
    userId,
    startAt,
    endAt,
    ...(input.description ? { description: normalizeDescription(input.description) } : {}),
    billable: input.billable,
    currency,
    ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
    source: input.source,
  }
}

/** Validates a lifecycle transition. */
function transitionFor(status: TimeEntryStatus, action: TransitionTimeEntryInput['action']): { toStatus: TimeEntryStatus } | undefined {
  if (action === 'submit' && (status === 'draft' || status === 'rejected')) return { toStatus: 'submitted' }
  if (action === 'approve' && status === 'submitted') return { toStatus: 'approved' }
  if (action === 'reject' && status === 'submitted') return { toStatus: 'rejected' }
  if (action === 'lock' && status === 'approved') return { toStatus: 'locked' }
  return undefined
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
        ? entry.workItemId
        : entry.projectId ?? 'unassigned'
    const group = grouped.get(key) ?? createMutableSummaryGroup(key)
    group.minutes += minutes
    group.billableMinutes += entry.billable ? minutes : 0
    group.entryIds.add(entry.id)
    if (!group.estimateWorkItemIds.has(entry.workItemId)) {
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
    const workItemActualMilliseconds = actualMillisecondsByWorkItem.get(entry.workItemId) ?? 0
    group.estimateMinutes += workItemActualMilliseconds > 0
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

/** Creates an empty aggregation row. */
function createMutableSummaryGroup(key: string): MutableSummaryGroup {
  return {
    key,
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
    label: group.key === 'unassigned' ? 'Unassigned' : group.key,
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

/** Returns whether a caller can see an entry's confidential costs. */
function canViewCosts(entry: TimeEntry, managedProjectIds?: ReadonlySet<string>): boolean {
  return managedProjectIds === undefined || (entry.projectId !== undefined && managedProjectIds.has(entry.projectId))
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
    ...(entry.description ? { description: entry.description } : {}),
    billable: entry.billable,
    currency: entry.currency,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    workItemId: entry.workItemId,
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

/** Removes non-audit fields before an estimate snapshot enters audit. */
function toAuditEstimateSnapshot(estimate: TimeEstimate): Record<string, unknown> {
  return {
    teamId: estimate.teamId,
    workItemId: estimate.workItemId,
    estimateMinutes: estimate.estimateMinutes,
    revision: estimate.revision,
    updatedBy: estimate.updatedBy,
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
  if (exact !== undefined) {
    localDateStartCache.set(cacheKey, exact)
    return exact
  }
  for (let minute = 0; minute < 180; minute += 1) {
    const candidate = [...candidates].map((value) => value + minute * 60_000).find((value) => localDateAt(value, timeZone) === date)
    if (candidate !== undefined) {
      localDateStartCache.set(cacheKey, candidate)
      return candidate
    }
  }
  throw new TimeTrackingError(400, 'InvalidTimeZoneBoundary', 'The local date boundary could not be resolved.')
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

/** Reads a stored time entry. */
function readStoredEntry(value: unknown): TimeEntry {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored time entry')
  return {
    schemaVersion: 1,
    id: readString(record.id, 'Stored time entry ID'),
    workspaceId: readString(record.workspaceId, 'Stored time entry Workspace ID'),
    teamId: readString(record.teamId, 'Stored time entry Team ID'),
    ...(readOptionalString(record.projectId) ? { projectId: readOptionalString(record.projectId) } : {}),
    workItemId: readString(record.workItemId, 'Stored time entry Work Item ID'),
    userId: readString(record.userId, 'Stored time entry User ID'),
    startAt: readString(record.startAt, 'Stored time entry start'),
    endAt: readString(record.endAt, 'Stored time entry end'),
    durationMinutes: readNumber(record.durationMinutes, 'Stored duration'),
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

/** Reads a stored estimate. */
function readStoredEstimate(value: unknown): TimeEstimate {
  const record = readRecord(value)
  readSchemaVersion(record, 'Stored estimate')
  return {
    schemaVersion: 1,
    workspaceId: readString(record.workspaceId, 'Stored estimate Workspace ID'),
    teamId: readString(record.teamId, 'Stored estimate Team ID'),
    workItemId: readString(record.workItemId, 'Stored estimate Work Item ID'),
    estimateMinutes: readNumber(record.estimateMinutes, 'Stored estimate'),
    revision: readOptionalNumber(record.revision) ?? 1,
    updatedBy: readString(record.updatedBy, 'Stored estimate actor'),
    updatedAt: readString(record.updatedAt, 'Stored estimate timestamp'),
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
  if (value === 'created' || value === 'updated' || value === 'submitted' || value === 'approved' || value === 'rejected' || value === 'locked') return value
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

/** Builds an estimate key. */
function estimateKey(workspaceId: string, teamId: string, workItemId: string): string {
  return `${workspaceId}\0${teamId}\0${workItemId}`
}

/** Builds a budget key. */
function budgetKey(workspaceId: string, scopeType: 'team' | 'project', scopeId: string): string {
  return `${workspaceId}\0${scopeType}\0${scopeId}`
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

/** Creates a stable request fingerprint while excluding the idempotency key itself. */
function createTimeTrackingRequestFingerprint(operation: string, input: object): string {
  const body = Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== 'idempotencyKey')
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
