import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  CapacityPlanningGranularity,
  ResourceAssignment,
  ResourceRequest,
  ReviewWorkloadTimeOffInput,
  SaveWorkloadMemberProfileInput,
  SaveWorkloadTimeOffInput,
  CreateResourceAssignmentInput,
  CreateResourceRequestInput,
  UpdateResourceAssignmentInput,
  UpdateResourceRequestInput,
  WorkloadCell,
  WorkloadHoliday,
  WorkloadMemberProfile,
  WorkloadMemberSummary,
  WorkloadSnapshot,
  WorkloadSnapshotViewer,
  WorkloadTimeOff,
  WorkingSchedule,
} from '@mukuroji/contracts'
import { CAPACITY_PLANNING_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from '../audit'

const TEAM_RECORD_PREFIX = 'CAPACITY#TEAM#'
const MAX_RANGE_DAYS = 366
const MAX_PROFILES = 2_000
const MAX_REQUESTS = 10_000
const MAX_ASSIGNMENTS = 20_000
const MAX_SKILLS = 64
const MAX_STATE_BYTES = 350_000
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
/** Days after their end date that canceled, rejected, and empty request rows are kept. */
const CLOSED_ROW_RETENTION_DAYS = 30
/**
 * Most audit events one Team write may carry: DynamoDB transactions hold at most 100 items and
 * the Team state Put is one of them.
 */
const MAX_AUDIT_EVENTS_PER_WRITE = 99
/**
 * Most assignments a request cancellation audits one by one; with the request's own event they
 * stay within `MAX_AUDIT_EVENTS_PER_WRITE`. Larger cascades are recorded as one event.
 */
const MAX_ITEMIZED_CASCADE_EVENTS = MAX_AUDIT_EVENTS_PER_WRITE - 1
/** Days after their end date that any row is kept; longer than the widest snapshot range. */
const PAST_ROW_RETENTION_DAYS = 400
/** Audit entity type for Team workload changes. */
const WORKLOAD_AUDIT_ENTITY_TYPE = 'team-workload'

/** A time entry projection used by capacity calculations. */
export type WorkloadTimeEntry = {
  /** Workspace member who recorded the time. */
  memberId: string
  /** Optional Project identifier used for project-scoped visibility. */
  projectId?: string
  /** Canonical Work Item identifier; absent for indirect work such as meetings. */
  workItemId?: string
  /** Inclusive instant start. */
  startAt: string
  /** Exclusive instant end. */
  endAt: string
  /** Rounded duration in minutes. */
  durationMinutes: number
  /** Time-entry lifecycle status. */
  status: string
}

/**
 * The canonical estimate of one Work Item used by capacity calculations.
 *
 * The estimate is the Work Item's `schedule.plannedEffortMinutes`; assignment planned effort only
 * weights how a Work Item's remaining effort is shared between its assignments.
 */
export type WorkloadEstimate = {
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Canonical planned effort (estimate) in minutes, when set. */
  estimateMinutes?: number
  /** Recorded remaining effort, or 0 for a completed or canceled Work Item, when known. */
  remainingEffortMinutes?: number
}

/** Read-only source data needed to reconcile capacity with actual time. */
export type CapacityPlanningDataSource = {
  /** Lists time entries for the selected Team and broad time range. */
  listTimeEntries(input: {
    /** Workspace identifier. */
    workspaceId: string
    /** Team identifier. */
    teamId: string
    /** Inclusive instant lower bound. */
    from: string
    /** Exclusive instant upper bound. */
    to: string
  }): Promise<WorkloadTimeEntry[]>
  /** Lists the canonical Work Item estimates and remaining effort for the selected Team. */
  listEstimates(workspaceId: string, teamId: string): Promise<WorkloadEstimate[]>
}

/** Durable store for one Workspace/Team capacity planning state. */
export interface CapacityPlanningRepository {
  /** Reads the current Team state. */
  getState(workspaceId: string, teamId: string): Promise<CapacityPlanningState>
  /**
   * Saves the state using the previous Team revision as a CAS condition.
   *
   * @param audit - Audit events written atomically with the state, when the caller records them.
   */
  saveState(
    workspaceId: string,
    teamId: string,
    state: CapacityPlanningState,
    expectedRevision: number,
    audit?: CapacityPlanningAudit,
  ): Promise<void>
}

/** Audit events for one workload mutation and the request context that produced them. */
export type CapacityPlanningAudit = {
  /** Request-scoped actor, source, and idempotency context. */
  context: MutationAuditContext
  /** Events to write in the same transaction as the Team state. */
  events: MutationAuditEventInput[]
}

/** Options shared by workload mutations. */
export type CapacityPlanningMutationOptions = {
  /** Request audit context; when absent the mutation is saved without audit events. */
  auditContext?: MutationAuditContext
}

/** Storage shape kept private to the capacity-planning module. */
export type CapacityPlanningState = {
  /** Workspace/Team-wide optimistic concurrency revision. */
  revision: number
  /** Member availability profiles. */
  profiles: WorkloadMemberProfile[]
  /** Resource requests. */
  requests: ResourceRequest[]
  /** Resource assignments. */
  assignments: ResourceAssignment[]
  /** Last update timestamp. */
  updatedAt?: string
}

/** Input for a workload read after HTTP authorization has been performed. */
export type WorkloadSnapshotInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Requested output granularity. */
  granularity: CapacityPlanningGranularity
  /** Member whose private assignments remain visible. */
  viewerMemberId?: string
  /** Member allowlist for the caller. Undefined means the entire Team. */
  visibleMemberIds?: ReadonlySet<string>
  /** Project allowlist for the caller. Undefined means the entire Team. */
  visibleProjectIds?: ReadonlySet<string>
  /** Whether confidential assignments and requests may be returned. */
  canViewConfidential: boolean
  /** The viewer and their review rights, echoed on the snapshot for the client. */
  viewer?: WorkloadSnapshotViewer
}

/** Input for a what-if calculation that never persists. */
export type WorkloadWhatIfInput = WorkloadSnapshotInput & {
  /** Existing assignment to replace, or undefined to preview a new assignment. */
  assignmentId?: string
  /** Preview member. */
  memberId: string
  /** Preview start date. */
  assignmentFromDate: string
  /** Preview end date. */
  assignmentToDate: string
  /** Preview allocation minutes. */
  allocationMinutes: number
  /** Preview planned effort minutes. */
  plannedEffortMinutes: number
}

/** Stable capacity-planning validation and authorization error. */
export class CapacityPlanningError extends Error {
  /** HTTP status used by the transport adapter. */
  readonly status: number
  /** Stable client-facing error code. */
  readonly code: string

  /** Creates a capacity-planning error. */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CapacityPlanningError'
    this.status = status
    this.code = code
  }
}

/** Creates a standard Monday-Friday schedule with eight-hour weekdays. */
export function createDefaultWorkingSchedule(): WorkingSchedule {
  const weekday = { enabled: true, minutes: 480 }
  const weekend = { enabled: false, minutes: 0 }
  return {
    monday: { ...weekday },
    tuesday: { ...weekday },
    wednesday: { ...weekday },
    thursday: { ...weekday },
    friday: { ...weekday },
    saturday: { ...weekend },
    sunday: { ...weekend },
  }
}

/** Builds a visibility-filtered workload snapshot from deterministic source data. */
export function buildWorkloadSnapshot(
  state: CapacityPlanningState,
  entries: readonly WorkloadTimeEntry[],
  estimates: readonly WorkloadEstimate[],
  input: WorkloadSnapshotInput,
  generatedAt = new Date().toISOString(),
): WorkloadSnapshot {
  const { fromDate, toDate } = validateDateRange(input.fromDate, input.toDate)
  const profiles = state.profiles.filter((profile) =>
    input.visibleMemberIds === undefined || input.visibleMemberIds.has(profile.memberId)
  )
  const profileByMemberId = new Map(profiles.map((profile) => [profile.memberId, profile]))
  const isProjectVisible = (projectId: string | undefined): boolean =>
    input.visibleProjectIds === undefined || projectId === undefined || input.visibleProjectIds.has(projectId)
  const visibleAssignments = state.assignments.filter((assignment) =>
    isAssignmentVisible(assignment, input, profileByMemberId, isProjectVisible)
  )
  const visibleAssignmentRequestIds = new Set(
    visibleAssignments.flatMap((assignment) => assignment.requestId ? [assignment.requestId] : []),
  )
  const visibleRequests = state.requests.filter((request) =>
    isProjectVisible(request.projectId) &&
    (!request.confidential || input.canViewConfidential || visibleAssignmentRequestIds.has(request.id))
  )
  const redactedAssignmentCount = state.assignments.filter((assignment) =>
    assignment.status !== 'canceled' &&
    profileByMemberId.has(assignment.memberId) &&
    isProjectVisible(assignment.projectId) &&
    assignment.confidential &&
    !input.canViewConfidential &&
    assignment.memberId !== input.viewerMemberId
  ).length
  const redactedRequestCount = state.requests.filter((request) =>
    isProjectVisible(request.projectId) && request.confidential && !input.canViewConfidential
  ).length
  const actualByMember = createActualMinutesByMemberDate(
    profiles,
    entries.filter((entry) => isProjectVisible(entry.projectId)),
    fromDate,
    toDate,
  )
  const actualByWorkItemId = aggregateActualMinutesByWorkItem(actualByMember)
  const estimateByWorkItemId = new Map(estimates.map((estimate) => [estimate.workItemId, estimate]))
  const remainingEffortByAssignmentId = calculateRemainingEffortByAssignment(
    visibleAssignments,
    actualByWorkItemId,
    estimateByWorkItemId,
    fromDate,
    toDate,
  )

  const members = profiles.map((profile) =>
    calculateMemberSummary(
      profile,
      visibleAssignments.filter((assignment) => assignment.memberId === profile.memberId),
      actualByMember.get(profile.memberId) ?? { byDate: new Map(), byWorkItemId: new Map() },
      fromDate,
      toDate,
      input.granularity,
      remainingEffortByAssignmentId,
      input.canViewConfidential || profile.memberId === input.viewerMemberId,
    )
  )

  return {
    schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    fromDate,
    toDate,
    granularity: input.granularity,
    members,
    requests: visibleRequests.map(clone),
    assignments: visibleAssignments.map(clone),
    redactedAssignmentCount,
    redactedRequestCount,
    revision: state.revision,
    generatedAt,
    ...(input.viewer ? { viewer: { ...input.viewer } } : {}),
  }
}

/** Applies the member, Project, lifecycle, and confidential visibility rules to one assignment. */
function isAssignmentVisible(
  assignment: ResourceAssignment,
  input: WorkloadSnapshotInput,
  profileByMemberId: ReadonlyMap<string, WorkloadMemberProfile>,
  isProjectVisible: (projectId: string | undefined) => boolean,
): boolean {
  return assignment.status !== 'canceled' &&
    profileByMemberId.has(assignment.memberId) &&
    isProjectVisible(assignment.projectId) &&
    (!assignment.confidential || input.canViewConfidential || assignment.memberId === input.viewerMemberId)
}

/** Builds the smallest time-entry window needed for the visible workload range. */
function getTimeEntryQueryRange(
  state: CapacityPlanningState,
  input: WorkloadSnapshotInput,
  range: { fromDate: string; toDate: string },
): { from: string; to: string } {
  const profiles = state.profiles.filter((profile) =>
    input.visibleMemberIds === undefined || input.visibleMemberIds.has(profile.memberId)
  )
  const profileByMemberId = new Map(profiles.map((profile) => [profile.memberId, profile]))
  const isProjectVisible = (projectId: string | undefined): boolean =>
    input.visibleProjectIds === undefined || projectId === undefined || input.visibleProjectIds.has(projectId)
  const relevantAssignments = state.assignments.filter((assignment) =>
    assignment.workItemId !== undefined && isAssignmentVisible(assignment, input, profileByMemberId, isProjectVisible)
  )
  const fromDate = relevantAssignments.reduce(
    (earliest, assignment) => assignment.fromDate < earliest ? assignment.fromDate : earliest,
    range.fromDate,
  )
  const toDate = relevantAssignments.reduce(
    (latest, assignment) => assignment.toDate > latest ? assignment.toDate : latest,
    range.toDate,
  )
  return {
    from: `${addCalendarDays(fromDate, -1)}T00:00:00.000Z`,
    to: `${addCalendarDays(toDate, 2)}T00:00:00.000Z`,
  }
}

/** Application service for availability, allocation, and workload planning. */
export class CapacityPlanningService {
  /** Durable capacity planning state. */
  private readonly repository: CapacityPlanningRepository
  /** Time and estimate read port. */
  private readonly dataSource: CapacityPlanningDataSource
  /** Timestamp provider. */
  private readonly now: () => Date
  /** Identifier provider. */
  private readonly createId: () => string

  /** Creates the capacity-planning application service. */
  constructor(
    repository: CapacityPlanningRepository,
    dataSource: CapacityPlanningDataSource,
    options?: { now?: () => Date; createId?: () => string },
  ) {
    this.repository = repository
    this.dataSource = dataSource
    this.now = options?.now ?? (() => new Date())
    this.createId = options?.createId ?? (() => crypto.randomUUID())
  }

  /** Reads a capacity snapshot with member and confidential visibility already applied. */
  async getSnapshot(input: WorkloadSnapshotInput): Promise<WorkloadSnapshot> {
    const range = validateDateRange(input.fromDate, input.toDate)
    const state = await this.repository.getState(input.workspaceId, input.teamId)
    const timeEntryRange = getTimeEntryQueryRange(state, input, range)
    const [entries, estimates] = await Promise.all([
      this.dataSource.listTimeEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        from: timeEntryRange.from,
        to: timeEntryRange.to,
      }),
      this.dataSource.listEstimates(input.workspaceId, input.teamId),
    ])
    return buildWorkloadSnapshot(state, entries, estimates, input, this.now().toISOString())
  }

  /** Saves or replaces one member's recurring schedule and holidays. */
  async saveMemberProfile(input: SaveWorkloadMemberProfileInput, options: CapacityPlanningMutationOptions = {}): Promise<WorkloadMemberProfile> {
    validateIdentifier(input.workspaceId, 'Workspace ID')
    validateIdentifier(input.teamId, 'Team ID')
    validateIdentifier(input.memberId, 'Member ID')
    validateIdentifier(input.actorMemberId, 'Actor member ID')
    validateTimeZone(input.timeZone)
    validateSchedule(input.schedule)
    const skills = normalizeStringList(input.skills, 'Skills', MAX_SKILLS)
    const holidays = normalizeHolidays(input.holidays)
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
      const current = state.profiles.find((profile) => profile.memberId === input.memberId)
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'WorkloadProfileRevisionConflict', 'The workload profile was changed by another request.')
      }
      const timestamp = this.now().toISOString()
      const profile: WorkloadMemberProfile = {
        schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        memberId: input.memberId,
        ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
        ...(input.role?.trim() ? { role: input.role.trim() } : {}),
        skills,
        timeZone: input.timeZone,
        schedule: clone(input.schedule),
        holidays,
        timeOff: current?.timeOff.map(clone) ?? [],
        revision: input.expectedRevision + 1,
        updatedAt: timestamp,
      }
      replaceById(state.profiles, profile, 'memberId')
      return profile
    }, options)
  }

  /**
   * Saves or replaces one member's absence.
   *
   * Changing an absence's dates or minutes returns it to whatever status the caller sends, so a
   * member who edits an approved absence must have it approved again.
   *
   * @param input - Absence fields, status, and expected revisions.
   * @param options - Request audit context.
   * @returns The saved absence.
   */
  async saveTimeOff(input: SaveWorkloadTimeOffInput, options: CapacityPlanningMutationOptions = {}): Promise<WorkloadTimeOff> {
    validateIdentifier(input.memberId, 'Member ID')
    validateDateRange(input.fromDate, input.toDate)
    if (input.minutesPerDay !== undefined) validateNonNegativeInteger(input.minutesPerDay, 'Time-off minutes')
    const reason = input.reason?.trim()
    const nextTimeOff: WorkloadTimeOff = {
      id: validateIdentifier(input.id, 'Time-off ID'),
      fromDate: input.fromDate,
      toDate: input.toDate,
      ...(input.minutesPerDay === undefined ? {} : { minutesPerDay: input.minutesPerDay }),
      ...(reason ? { reason } : {}),
      status: input.status,
      revision: 1,
    }
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      const profile = requireProfile(state, input.memberId)
      if (profile.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'WorkloadProfileRevisionConflict', 'The workload profile was changed by another request.')
      }
      const timestamp = this.now().toISOString()
      const previous = profile.timeOff.find((timeOff) => timeOff.id === nextTimeOff.id)
      const saved: WorkloadTimeOff = {
        ...nextTimeOff,
        ...reviewFields(nextTimeOff.status, input.actorMemberId, timestamp),
        revision: (previous?.revision ?? 0) + 1,
      }
      profile.timeOff = [...profile.timeOff.filter((timeOff) => timeOff.id !== saved.id), saved]
      profile.revision += 1
      profile.updatedAt = timestamp
      events.push(createTimeOffAuditEvent(input, profile.memberId, previous, saved))
      return saved
    }, options)
  }

  /**
   * Approves, rejects, reopens, or cancels one absence without changing its dates.
   *
   * The transport adapter decides who may set each status; this method checks only the
   * absence's own revision so a review never overwrites a newer edit.
   *
   * @param input - Absence, new status, and expected revisions.
   * @param options - Request audit context.
   * @returns The reviewed absence.
   */
  async reviewTimeOff(input: ReviewWorkloadTimeOffInput, options: CapacityPlanningMutationOptions = {}): Promise<WorkloadTimeOff> {
    validateIdentifier(input.memberId, 'Member ID')
    validateIdentifier(input.timeOffId, 'Time-off ID')
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      const profile = requireProfile(state, input.memberId)
      const current = profile.timeOff.find((timeOff) => timeOff.id === input.timeOffId)
      if (!current) throw new CapacityPlanningError(404, 'WorkloadTimeOffNotFound', 'The time off was not found.')
      if (current.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'WorkloadTimeOffRevisionConflict', 'The time off was changed by another request.')
      }
      if (current.status === 'canceled') {
        throw new CapacityPlanningError(409, 'WorkloadTimeOffCanceled', 'A canceled time off cannot be reviewed.')
      }
      const timestamp = this.now().toISOString()
      const { reviewedAt: _reviewedAt, reviewedBy: _reviewedBy, submittedAt: _submittedAt, ...unreviewed } = current
      const saved: WorkloadTimeOff = {
        ...unreviewed,
        status: input.status,
        ...reviewFields(input.status, input.actorMemberId, timestamp),
        revision: current.revision + 1,
      }
      profile.timeOff = profile.timeOff.map((timeOff) => timeOff.id === saved.id ? saved : timeOff)
      profile.revision += 1
      profile.updatedAt = timestamp
      events.push(createTimeOffAuditEvent(input, profile.memberId, current, saved))
      return saved
    }, options)
  }

  /** Creates a resource request and records it in the audit log. */
  async createRequest(input: CreateResourceRequestInput, options: CapacityPlanningMutationOptions = {}): Promise<ResourceRequest> {
    validateRequestFields(input)
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      if (state.requests.length >= MAX_REQUESTS) {
        throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'The Team has reached its resource request limit.')
      }
      const timestamp = this.now().toISOString()
      const request: ResourceRequest = {
        id: this.createId(),
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        title: input.title.trim(),
        ...(input.role?.trim() ? { role: input.role.trim() } : {}),
        skillIds: normalizeStringList(input.skillIds, 'Request skills', MAX_SKILLS),
        fromDate: input.fromDate,
        toDate: input.toDate,
        requestedMinutes: input.requestedMinutes,
        confidential: input.confidential,
        status: 'open',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      state.requests.push(request)
      events.push(createRequestAuditEvent(input, undefined, request))
      return request
    }, options)
  }

  /** Reads one Team resource request for transport-layer authorization. */
  async getRequest(workspaceId: string, teamId: string, requestId: string): Promise<ResourceRequest> {
    validateIdentifier(workspaceId, 'Workspace ID')
    validateIdentifier(teamId, 'Team ID')
    validateIdentifier(requestId, 'Request ID')
    const state = await this.repository.getState(workspaceId, teamId)
    return clone(requireRequest(state, requestId))
  }

  /**
   * Changes or cancels a resource request using optimistic concurrency.
   *
   * A request can be canceled only after every assignment that fills it is canceled, so a
   * canceled request never keeps reserving capacity. With `cancelAssignments` the remaining
   * assignments are canceled in the same write. Canceled requests are read-only.
   *
   * @param input - Changed request fields, an optional cancel status, and expected revisions.
   * @param access - Whether the actor may see confidential requests, where hidden requests are
   *   reported as missing, and which assignments the caller authorized for a cascading cancel.
   * @param options - Request audit context.
   * @returns The saved request.
   */
  async updateRequest(
    input: UpdateResourceRequestInput,
    access: {
      /** Whether the actor may read and change confidential requests. */
      canViewConfidential: boolean
      /**
       * Assignments whose Project and member the caller verified for this actor. A cascading
       * cancel is refused when any active assignment of the request is missing from it.
       */
      authorizedAssignmentIds?: ReadonlySet<string>
    },
    options: CapacityPlanningMutationOptions = {},
  ): Promise<ResourceRequest> {
    validateIdentifier(input.workspaceId, 'Workspace ID')
    validateIdentifier(input.teamId, 'Team ID')
    validateIdentifier(input.requestId, 'Request ID')
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      const current = requireRequest(state, input.requestId)
      if (current.confidential && !access.canViewConfidential) {
        throw new CapacityPlanningError(404, 'ResourceRequestNotFound', 'The resource request was not found.')
      }
      if (current.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'ResourceRequestRevisionConflict', 'The resource request was changed by another request.')
      }
      if (current.status === 'canceled') {
        throw new CapacityPlanningError(409, 'ResourceRequestCanceled', 'A canceled resource request cannot be changed.')
      }
      const title = input.title === undefined ? current.title : input.title.trim()
      if (!title) throw new CapacityPlanningError(400, 'InvalidResourceRequest', 'A resource request title is required.')
      const fromDate = input.fromDate ?? current.fromDate
      const toDate = input.toDate ?? current.toDate
      validateDateRange(fromDate, toDate)
      const requestedMinutes = input.requestedMinutes ?? current.requestedMinutes
      validateNonNegativeInteger(requestedMinutes, 'Requested minutes')
      const timestamp = this.now().toISOString()
      const activeAssignments = state.assignments.filter((assignment) =>
        assignment.requestId === current.id && assignment.status !== 'canceled'
      )
      if (input.status === 'canceled' && input.cancelAssignments === true) {
        if (!access.canViewConfidential && activeAssignments.some((assignment) => assignment.confidential)) {
          throw new CapacityPlanningError(
            409,
            'ResourceRequestHasActiveAssignments',
            'Some assignments that fill this resource request are confidential. Ask a manager who can see them to cancel it.',
          )
        }
        if (activeAssignments.some((assignment) => access.authorizedAssignmentIds?.has(assignment.id) !== true)) {
          throw new CapacityPlanningError(
            409,
            'ResourceRequestAssignmentsChanged',
            'The assignments that fill this resource request changed. Reload and try again.',
          )
        }
        const canceledAssignments = activeAssignments.map((assignment): ResourceAssignment => ({
          ...assignment,
          status: 'canceled',
          revision: assignment.revision + 1,
          updatedAt: timestamp,
        }))
        for (const canceled of canceledAssignments) replaceById(state.assignments, canceled, 'id')
        if (canceledAssignments.length <= MAX_ITEMIZED_CASCADE_EVENTS) {
          activeAssignments.forEach((assignment, index) => {
            const canceled = canceledAssignments[index]
            if (canceled) events.push(createAssignmentAuditEvent(input, assignment, canceled))
          })
        } else {
          events.push(createCascadeCancelAuditEvent(input, current.id, canceledAssignments))
        }
      } else if (input.status === 'canceled' && activeAssignments.length > 0) {
        throw new CapacityPlanningError(
          409,
          'ResourceRequestHasActiveAssignments',
          'Cancel the assignments that fill this resource request before canceling it.',
        )
      }
      const role = input.role === undefined ? current.role : input.role.trim() || undefined
      const next: ResourceRequest = {
        ...current,
        title,
        skillIds: input.skillIds === undefined
          ? current.skillIds
          : normalizeStringList(input.skillIds, 'Request skills', MAX_SKILLS),
        fromDate,
        toDate,
        requestedMinutes,
        confidential: input.confidential ?? current.confidential,
        ...(input.status === 'canceled' ? { status: 'canceled' } : {}),
        revision: current.revision + 1,
        updatedAt: timestamp,
      }
      if (role) next.role = role
      else delete next.role
      replaceById(state.requests, next, 'id')
      refreshRequestStatuses(state, timestamp)
      const saved = clone(requireRequest(state, next.id))
      events.push(createRequestAuditEvent(input, current, saved))
      return saved
    }, options)
  }

  /** Creates an assignment for a profile, optionally fulfills a request, and notifies the member. */
  async createAssignment(input: CreateResourceAssignmentInput, options: CapacityPlanningMutationOptions = {}): Promise<ResourceAssignment> {
    validateAssignmentFields(input)
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      if (state.assignments.length >= MAX_ASSIGNMENTS) {
        throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'The Team has reached its resource assignment limit.')
      }
      requireProfile(state, input.memberId)
      const request = input.requestId ? requireRequest(state, input.requestId) : undefined
      if (request?.status === 'canceled' && input.status !== 'canceled') {
        throw new CapacityPlanningError(409, 'ResourceRequestCanceled', 'A canceled resource request cannot receive assignments.')
      }
      if (request?.projectId && input.projectId && request.projectId !== input.projectId) {
        throw new CapacityPlanningError(400, 'InvalidResourceAssignment', 'The assignment Project must match its resource request.')
      }
      const projectId = input.projectId ?? request?.projectId
      const timestamp = this.now().toISOString()
      const assignment: ResourceAssignment = {
        id: this.createId(),
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(input.workItemId ? { workItemId: input.workItemId } : {}),
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        ...(input.recurringWorkId ? { recurringWorkId: input.recurringWorkId } : {}),
        memberId: input.memberId,
        ...(input.role?.trim() ? { role: input.role.trim() } : {}),
        skillIds: normalizeStringList(input.skillIds, 'Assignment skills', MAX_SKILLS),
        fromDate: input.fromDate,
        toDate: input.toDate,
        allocationMinutes: input.allocationMinutes,
        plannedEffortMinutes: input.plannedEffortMinutes,
        confidential: input.confidential,
        status: input.status,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      state.assignments.push(assignment)
      refreshRequestStatuses(state, timestamp)
      events.push(createAssignmentAuditEvent(input, undefined, assignment))
      return assignment
    }, options)
  }

  /**
   * Lists the active assignments that fill a request, for transport-layer authorization of a
   * cascading cancel.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @param requestId - Request identifier.
   * @returns Assignments of the request that are not canceled.
   */
  async listActiveRequestAssignments(workspaceId: string, teamId: string, requestId: string): Promise<ResourceAssignment[]> {
    validateIdentifier(workspaceId, 'Workspace ID')
    validateIdentifier(teamId, 'Team ID')
    validateIdentifier(requestId, 'Request ID')
    const state = await this.repository.getState(workspaceId, teamId)
    return clone(state.assignments.filter((assignment) => assignment.requestId === requestId && assignment.status !== 'canceled'))
  }

  /** Reads one Team assignment for transport-layer authorization. */
  async getAssignment(workspaceId: string, teamId: string, assignmentId: string): Promise<ResourceAssignment> {
    validateIdentifier(workspaceId, 'Workspace ID')
    validateIdentifier(teamId, 'Team ID')
    validateIdentifier(assignmentId, 'Assignment ID')
    const state = await this.repository.getState(workspaceId, teamId)
    const assignment = state.assignments.find((candidate) => candidate.id === assignmentId)
    if (!assignment) throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
    return clone(assignment)
  }

  /** Moves, reassigns, resizes, confirms, or cancels an assignment using optimistic concurrency. */
  async updateAssignment(input: UpdateResourceAssignmentInput, options: CapacityPlanningMutationOptions = {}): Promise<ResourceAssignment> {
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state, events) => {
      const current = state.assignments.find((assignment) => assignment.id === input.assignmentId)
      if (!current) throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
      if (current.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'ResourceAssignmentRevisionConflict', 'The resource assignment was changed by another request.')
      }
      const status = input.status ?? current.status
      if (
        current.requestId &&
        status !== 'canceled' &&
        state.requests.some((request) => request.id === current.requestId && request.status === 'canceled')
      ) {
        throw new CapacityPlanningError(409, 'ResourceRequestCanceled', 'An assignment for a canceled resource request cannot be reactivated.')
      }
      const memberId = input.memberId ?? current.memberId
      requireProfile(state, memberId)
      const fromDate = input.fromDate ?? current.fromDate
      const toDate = input.toDate ?? current.toDate
      validateDateRange(fromDate, toDate)
      const allocationMinutes = input.allocationMinutes ?? current.allocationMinutes
      const plannedEffortMinutes = input.plannedEffortMinutes ?? current.plannedEffortMinutes
      validateNonNegativeInteger(allocationMinutes, 'Allocation minutes')
      validateNonNegativeInteger(plannedEffortMinutes, 'Planned effort minutes')
      const timestamp = this.now().toISOString()
      const next: ResourceAssignment = {
        ...current,
        memberId,
        fromDate,
        toDate,
        allocationMinutes,
        plannedEffortMinutes,
        ...(input.status ? { status: input.status } : {}),
        revision: current.revision + 1,
        updatedAt: timestamp,
      }
      replaceById(state.assignments, next, 'id')
      refreshRequestStatuses(state, timestamp)
      events.push(createAssignmentAuditEvent(input, current, next))
      return next
    }, options)
  }

  /** Calculates a proposed reschedule or reassignment without persisting it. */
  async whatIf(input: WorkloadWhatIfInput): Promise<WorkloadSnapshot> {
    validateAssignmentFields({
      ...input,
      requestId: undefined,
      skillIds: [],
      status: 'tentative',
      expectedTeamRevision: 0,
      actorMemberId: input.viewerMemberId ?? input.memberId,
    })
    const range = validateDateRange(input.fromDate, input.toDate)
    const state = await this.repository.getState(input.workspaceId, input.teamId)
    if (input.visibleMemberIds && !input.visibleMemberIds.has(input.memberId)) {
      throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
    }
    const profile = requireProfile(state, input.memberId)
    const current = input.assignmentId
      ? state.assignments.find((assignment) => assignment.id === input.assignmentId)
      : undefined
    if (input.assignmentId && !current) {
      throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
    }
    if (current) {
      const visibleProfiles = new Map(
        state.profiles
          .filter((candidate) => input.visibleMemberIds === undefined || input.visibleMemberIds.has(candidate.memberId))
          .map((candidate) => [candidate.memberId, candidate]),
      )
      const isProjectVisible = (projectId: string | undefined): boolean =>
        input.visibleProjectIds === undefined || projectId === undefined || input.visibleProjectIds.has(projectId)
      if (!isAssignmentVisible(current, input, visibleProfiles, isProjectVisible)) {
        throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
      }
    }
    const preview: ResourceAssignment = current
      ? {
          ...current,
          memberId: input.memberId,
          fromDate: input.assignmentFromDate,
          toDate: input.assignmentToDate,
          allocationMinutes: input.allocationMinutes,
          plannedEffortMinutes: input.plannedEffortMinutes,
        }
      : {
          id: 'what-if',
          workspaceId: input.workspaceId,
          teamId: input.teamId,
          memberId: profile.memberId,
          skillIds: [],
          fromDate: input.assignmentFromDate,
          toDate: input.assignmentToDate,
          allocationMinutes: input.allocationMinutes,
          plannedEffortMinutes: input.plannedEffortMinutes,
          confidential: false,
          status: 'tentative',
          revision: 1,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        }
    if (current) replaceById(state.assignments, preview, 'id')
    else state.assignments.push(preview)
    const timeEntryRange = getTimeEntryQueryRange(state, input, range)
    const [entries, estimates] = await Promise.all([
      this.dataSource.listTimeEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        from: timeEntryRange.from,
        to: timeEntryRange.to,
      }),
      this.dataSource.listEstimates(input.workspaceId, input.teamId),
    ])
    return buildWorkloadSnapshot(state, entries, estimates, input, this.now().toISOString())
  }

  /**
   * Applies one state mutation with a Team-wide optimistic concurrency check.
   *
   * Before saving, rows that ended long ago or were closed a while ago are pruned so the single
   * Team record stays small. Audit events pushed by the mutation are saved in the same write.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @param expectedRevision - Team revision the caller read.
   * @param mutate - Changes the state and pushes audit events.
   * @param options - Request audit context.
   * @returns The mutation result.
   */
  private async mutateState<T>(
    workspaceId: string,
    teamId: string,
    expectedRevision: number,
    mutate: (state: CapacityPlanningState, events: MutationAuditEventInput[]) => T,
    options: CapacityPlanningMutationOptions = {},
  ): Promise<T> {
    const current = await this.repository.getState(workspaceId, teamId)
    if (current.revision !== expectedRevision) {
      throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
    }
    const next = clone(current)
    const events: MutationAuditEventInput[] = []
    const result = mutate(next, events)
    if (events.length > MAX_AUDIT_EVENTS_PER_WRITE) {
      throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'This workload change touches too many rows to save at once.')
    }
    const now = this.now()
    pruneCapacityPlanningState(next, now.toISOString().slice(0, 10))
    // Pruning can drop an old assignment of a kept request, so its fulfillment is derived again.
    refreshRequestStatuses(next, now.toISOString())
    next.revision = current.revision + 1
    next.updatedAt = now.toISOString()
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_STATE_BYTES) {
      throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'The Team workload plan is too large to save.')
    }
    await this.repository.saveState(
      workspaceId,
      teamId,
      next,
      current.revision,
      options.auditContext && events.length > 0 ? { context: options.auditContext, events } : undefined,
    )
    return result
  }
}

/** In-memory repository used by server tests and local development. */
export class InMemoryCapacityPlanningRepository implements CapacityPlanningRepository {
  /** Stored Team states. */
  private readonly states = new Map<string, CapacityPlanningState>()
  /** Audit batches saved with each state, oldest first, for tests. */
  readonly auditLog: CapacityPlanningAudit[] = []

  /** Reads an isolated clone of the Team state. */
  async getState(workspaceId: string, teamId: string): Promise<CapacityPlanningState> {
    return clone(this.states.get(stateKey(workspaceId, teamId)) ?? emptyState())
  }

  /** Saves a Team state after checking the expected revision. */
  async saveState(
    workspaceId: string,
    teamId: string,
    state: CapacityPlanningState,
    expectedRevision: number,
    audit?: CapacityPlanningAudit,
  ): Promise<void> {
    const key = stateKey(workspaceId, teamId)
    const current = this.states.get(key)
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
    }
    this.states.set(key, clone(state))
    if (audit) this.auditLog.push(clone(audit))
  }
}

/** DynamoDB repository for durable capacity planning state. */
export class DynamoDbCapacityPlanningRepository implements CapacityPlanningRepository {
  /** DynamoDB table name. */
  private readonly tableName: string
  /** Configured DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient
  /** Audit event table written with each state change, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates a DynamoDB-backed capacity planning repository.
   *
   * @param tableName - Capacity planning table.
   * @param documentClient - Configured DocumentClient.
   * @param auditTableName - Audit event table written in the same transaction, when configured.
   */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient, auditTableName?: string) {
    this.tableName = validateIdentifier(tableName, 'Capacity planning table name')
    this.documentClient = documentClient
    this.auditTableName = auditTableName
  }

  /** Reads a Team state from the shared Workspace partition. */
  async getState(workspaceId: string, teamId: string): Promise<CapacityPlanningState> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: stateRecordKey(teamId) },
      ConsistentRead: true,
    }))
    if (!response.Item) return emptyState()
    return readState(response.Item, workspaceId, teamId)
  }

  /** Writes a Team state using a revision condition, with its audit events in one transaction. */
  async saveState(
    workspaceId: string,
    teamId: string,
    state: CapacityPlanningState,
    expectedRevision: number,
    audit?: CapacityPlanningAudit,
  ): Promise<void> {
    const put = {
      TableName: this.tableName,
      Item: {
        workspaceId,
        recordKey: stateRecordKey(teamId),
        ...state,
      },
      ...(expectedRevision === 0
        ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
        : {
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
          }),
    }
    const auditTableName = this.auditTableName
    const auditPuts = audit && auditTableName
      ? audit.events.flatMap((event, sequence) =>
          createMutationAuditEventPut(auditTableName, audit.context, { ...event, sequence }) ?? [])
      : []
    try {
      if (auditPuts.length === 0) {
        await this.documentClient.send(new PutCommand(put))
        return
      }
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{ Put: put }, ...auditPuts],
      }))
    } catch (error) {
      if (isConditionalFailure(error) || isStateConditionCanceled(error)) {
        throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
      }
      if (isAuditConditionCanceled(error)) {
        throw new CapacityPlanningError(409, 'CapacityPlanningDuplicateRequest', 'This workload change was already recorded. Reload and try again.')
      }
      throw error
    }
  }
}

/** Calculates one member's daily and aggregated workload rows. */
function calculateMemberSummary(
  profile: WorkloadMemberProfile,
  assignments: readonly ResourceAssignment[],
  actual: { byDate: ReadonlyMap<string, number>; byWorkItemId: ReadonlyMap<string, number> },
  fromDate: string,
  toDate: string,
  granularity: CapacityPlanningGranularity,
  remainingEffortByAssignmentId: ReadonlyMap<string, number>,
  canViewTimeOffReason: boolean,
): WorkloadMemberSummary {
  const dates = listCalendarDates(fromDate, toDate)
  const daily = new Map<string, DailyWorkload>()
  for (const date of dates) {
    const capacityMinutes = calculateAvailableMinutes(profile, date)
    daily.set(date, {
      capacityMinutes,
      pendingTimeOffMinutes: calculatePendingTimeOffMinutes(profile, date, capacityMinutes),
      allocatedMinutes: 0,
      tentativeAllocatedMinutes: 0,
      plannedEffortMinutes: 0,
      actualMinutes: actual.byDate.get(date) ?? 0,
      remainingEffortMinutes: 0,
    })
  }
  for (const assignment of assignments) {
    const assignmentDates = listCalendarDates(assignment.fromDate, assignment.toDate)
    if (!assignmentDates.some((date) => daily.has(date))) continue
    const distributionDates = chooseDistributionDates(profile, assignmentDates)
    distributeMinutes(daily, distributionDates, assignment.allocationMinutes, 'allocatedMinutes')
    if (assignment.status === 'tentative') {
      distributeMinutes(daily, distributionDates, assignment.allocationMinutes, 'tentativeAllocatedMinutes')
    }
    distributeMinutes(daily, distributionDates, assignment.plannedEffortMinutes, 'plannedEffortMinutes')
    const remaining = assignment.workItemId
      ? remainingEffortByAssignmentId.get(assignment.id) ?? 0
      : assignment.plannedEffortMinutes
    distributeMinutes(daily, distributionDates, remaining, 'remainingEffortMinutes')
  }
  const cells = aggregateCells(daily, granularity)
  return {
    memberId: profile.memberId,
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.role ? { role: profile.role } : {}),
    skills: [...profile.skills],
    timeZone: profile.timeZone,
    schedule: clone(profile.schedule),
    holidays: profile.holidays.map(({ date, label }) => ({ date, ...(label ? { label } : {}) })),
    profileRevision: profile.revision,
    timeOff: profile.timeOff
      .filter((timeOff) => timeOff.status !== 'canceled' && timeOff.toDate >= fromDate)
      .sort((left, right) => left.fromDate.localeCompare(right.fromDate) || left.id.localeCompare(right.id))
      .map(({ reason, ...timeOff }) => ({ ...timeOff, ...(reason && canViewTimeOffReason ? { reason } : {}) })),
    cells,
    capacityMinutes: sum(cells, (cell) => cell.capacityMinutes),
    allocatedMinutes: sum(cells, (cell) => cell.allocatedMinutes),
    plannedEffortMinutes: sum(cells, (cell) => cell.plannedEffortMinutes),
    actualMinutes: sum(cells, (cell) => cell.actualMinutes),
    remainingEffortMinutes: sum(cells, (cell) => cell.remainingEffortMinutes),
    overloaded: cells.some((cell) => cell.status === 'over'),
  }
}

/** Converts daily metrics into the requested day, week, or month buckets. */
function aggregateCells(
  daily: ReadonlyMap<string, DailyWorkload>,
  granularity: CapacityPlanningGranularity,
): WorkloadCell[] {
  const groups = new Map<string, { fromDate: string; toDate: string; value: DailyWorkload }>()
  for (const [date, value] of daily) {
    const bucket = bucketFor(date, granularity)
    const current = groups.get(bucket.fromDate)
    if (!current) {
      groups.set(bucket.fromDate, { fromDate: bucket.fromDate, toDate: bucket.toDate, value: { ...value } })
      continue
    }
    current.toDate = bucket.toDate
    current.value.capacityMinutes += value.capacityMinutes
    current.value.pendingTimeOffMinutes += value.pendingTimeOffMinutes
    current.value.allocatedMinutes += value.allocatedMinutes
    current.value.tentativeAllocatedMinutes += value.tentativeAllocatedMinutes
    current.value.plannedEffortMinutes += value.plannedEffortMinutes
    current.value.actualMinutes += value.actualMinutes
    current.value.remainingEffortMinutes += value.remainingEffortMinutes
  }
  return [...groups.values()].sort((left, right) => left.fromDate.localeCompare(right.fromDate)).map((group) => {
    const varianceMinutes = group.value.capacityMinutes - group.value.allocatedMinutes
    const status = group.value.capacityMinutes === 0
      ? group.value.allocatedMinutes > 0 ? 'over' : 'unavailable'
      : varianceMinutes < 0 ? 'over' : varianceMinutes === 0 ? 'balanced' : 'under'
    return {
      fromDate: group.fromDate,
      toDate: group.toDate,
      label: group.fromDate,
      capacityMinutes: group.value.capacityMinutes,
      pendingTimeOffMinutes: group.value.pendingTimeOffMinutes,
      allocatedMinutes: group.value.allocatedMinutes,
      tentativeAllocatedMinutes: group.value.tentativeAllocatedMinutes,
      plannedEffortMinutes: group.value.plannedEffortMinutes,
      actualMinutes: group.value.actualMinutes,
      remainingEffortMinutes: group.value.remainingEffortMinutes,
      utilizationPercent: group.value.capacityMinutes === 0
        ? group.value.allocatedMinutes > 0 ? 100 : 0
        : Math.round((group.value.allocatedMinutes / group.value.capacityMinutes) * 100),
      varianceMinutes,
      status,
    }
  })
}

/** Computes the member's available minutes for one local date; only approved time off counts. */
function calculateAvailableMinutes(profile: WorkloadMemberProfile, date: string): number {
  const schedule = profile.schedule[weekdayKey(date)]
  if (!schedule.enabled || schedule.minutes === 0) return 0
  if (profile.holidays.some((holiday) => holiday.date === date)) return 0
  return Math.max(0, schedule.minutes - sumTimeOffMinutes(profile, date, 'approved', schedule.minutes))
}

/**
 * Computes the time off still waiting for approval on one date, capped at the minutes that
 * approved time off leaves available.
 */
function calculatePendingTimeOffMinutes(profile: WorkloadMemberProfile, date: string, availableMinutes: number): number {
  if (availableMinutes === 0) return 0
  const scheduled = profile.schedule[weekdayKey(date)].minutes
  return Math.min(availableMinutes, sumTimeOffMinutes(profile, date, 'planned', scheduled))
}

/** Sums one status of time off covering a date, using the scheduled minutes for full days. */
function sumTimeOffMinutes(
  profile: WorkloadMemberProfile,
  date: string,
  status: WorkloadTimeOff['status'],
  scheduledMinutes: number,
): number {
  return profile.timeOff
    .filter((timeOff) => timeOff.status === status && timeOff.fromDate <= date && timeOff.toDate >= date)
    .reduce((total, timeOff) => total + (timeOff.minutesPerDay ?? scheduledMinutes), 0)
}

/** Chooses scheduled dates first so planned effort follows availability. */
function chooseDistributionDates(profile: WorkloadMemberProfile, dates: readonly string[]): string[] {
  const available = dates.filter((date) => calculateAvailableMinutes(profile, date) > 0)
  return available.length > 0 ? available : [...dates]
}

/** Distributes an integer number of minutes without losing remainder minutes. */
function distributeMinutes(
  daily: Map<string, DailyWorkload>,
  dates: readonly string[],
  minutes: number,
  field: keyof Pick<DailyWorkload, 'allocatedMinutes' | 'tentativeAllocatedMinutes' | 'plannedEffortMinutes' | 'remainingEffortMinutes'>,
): void {
  if (dates.length === 0 || minutes === 0) return
  const base = Math.floor(minutes / dates.length)
  let remainder = minutes % dates.length
  for (const date of dates) {
    const extraMinute = remainder > 0 ? 1 : 0
    remainder -= 1
    const value = daily.get(date)
    if (!value) continue
    value[field] += base + extraMinute
  }
}

/** Splits actual time entries at the member's local midnight boundaries. */
function createActualMinutesByMemberDate(
  profiles: readonly WorkloadMemberProfile[],
  entries: readonly WorkloadTimeEntry[],
  fromDate: string,
  toDate: string,
): Map<string, { byDate: Map<string, number>; byWorkItemId: Map<string, number> }> {
  const profilesByMemberId = new Map(profiles.map((profile) => [profile.memberId, profile]))
  const result = new Map<string, { byDate: Map<string, number>; byWorkItemId: Map<string, number> }>()
  const selectedDates = new Set(listCalendarDates(fromDate, toDate))
  const formatters = createDateTimeFormatterCache()
  for (const entry of entries) {
    if (!['submitted', 'approved', 'locked'].includes(entry.status)) continue
    const profile = profilesByMemberId.get(entry.memberId)
    if (!profile) continue
    const start = Date.parse(entry.startAt)
    const end = Date.parse(entry.endAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const memberActual = result.get(entry.memberId) ?? {
      byDate: new Map<string, number>(),
      byWorkItemId: new Map<string, number>(),
    }
    const firstDate = localDateAt(start, profile.timeZone, formatters)
    const lastDate = localDateAt(end - 1, profile.timeZone, formatters)
    const entryDates = listCalendarDates(firstDate, lastDate)
    const overlaps = entryDates.map((date) => {
      const dayStart = resolveLocalDateStart(date, profile.timeZone, formatters)
      const dayEnd = resolveLocalDateStart(addCalendarDays(date, 1), profile.timeZone, formatters)
      return Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart))
    })
    const totalOverlap = overlaps.reduce((total, overlap) => total + overlap, 0)
    const durationMinutes = Number.isSafeInteger(entry.durationMinutes)
      ? Math.max(0, entry.durationMinutes)
      : Math.max(0, Math.round(entry.durationMinutes))
    const allocatedMinutes = allocateRoundedDuration(durationMinutes, overlaps, totalOverlap)
    for (const [index, date] of entryDates.entries()) {
      const overlapMinutes = allocatedMinutes[index] ?? 0
      if (overlapMinutes > 0) {
        if (selectedDates.has(date)) {
          memberActual.byDate.set(date, (memberActual.byDate.get(date) ?? 0) + overlapMinutes)
        }
        if (entry.workItemId !== undefined) {
          memberActual.byWorkItemId.set(
            entry.workItemId,
            (memberActual.byWorkItemId.get(entry.workItemId) ?? 0) + overlapMinutes,
          )
        }
      }
    }
    result.set(entry.memberId, memberActual)
  }
  return result
}

/** Allocates a stored rounded entry duration across local date overlaps without losing minutes. */
function allocateRoundedDuration(
  durationMinutes: number,
  overlaps: readonly number[],
  totalOverlap: number,
): number[] {
  if (durationMinutes === 0 || totalOverlap === 0) return overlaps.map(() => 0)
  const allocations = overlaps.map((overlap) => Math.floor(durationMinutes * overlap / totalOverlap))
  let remainder = durationMinutes - allocations.reduce((total, value) => total + value, 0)
  for (const [index, overlap] of overlaps.entries()) {
    if (remainder === 0) break
    if (overlap > 0) {
      allocations[index] = (allocations[index] ?? 0) + 1
      remainder -= 1
    }
  }
  return allocations
}

/** Aggregates actual minutes by Work Item across visible members. */
function aggregateActualMinutesByWorkItem(
  actualByMember: ReadonlyMap<string, { byDate: ReadonlyMap<string, number>; byWorkItemId: ReadonlyMap<string, number> }>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const actual of actualByMember.values()) {
    for (const [workItemId, minutes] of actual.byWorkItemId) {
      result.set(workItemId, (result.get(workItemId) ?? 0) + minutes)
    }
  }
  return result
}

/**
 * Distributes each Work Item's remaining effort across its visible assignments.
 *
 * A Work Item's remaining effort comes from one source only, so the same work is never counted
 * twice: the recorded remaining effort, otherwise the canonical estimate minus actual time, and
 * only for a Work Item without an estimate, the assignments' planned effort minus actual time.
 */
function calculateRemainingEffortByAssignment(
  assignments: readonly ResourceAssignment[],
  actualByWorkItemId: ReadonlyMap<string, number>,
  estimateByWorkItemId: ReadonlyMap<string, WorkloadEstimate>,
  fromDate: string,
  toDate: string,
): Map<string, number> {
  const assignmentsByWorkItemId = new Map<string, ResourceAssignment[]>()
  for (const assignment of assignments) {
    if (!assignment.workItemId || assignment.toDate < fromDate || assignment.fromDate > toDate) continue
    const group = assignmentsByWorkItemId.get(assignment.workItemId) ?? []
    group.push(assignment)
    assignmentsByWorkItemId.set(assignment.workItemId, group)
  }

  const result = new Map<string, number>()
  for (const [workItemId, group] of assignmentsByWorkItemId) {
    const plannedTotal = sum(group, (assignment) => assignment.plannedEffortMinutes)
    const estimate = estimateByWorkItemId.get(workItemId)
    const actual = actualByWorkItemId.get(workItemId) ?? 0
    const remainingTotal = estimate?.remainingEffortMinutes !== undefined
      ? Math.max(0, estimate.remainingEffortMinutes)
      : Math.max(0, (estimate?.estimateMinutes ?? plannedTotal) - actual)
    const weights = group.map((assignment) => assignment.plannedEffortMinutes || assignment.allocationMinutes)
    const weightTotal = sum(weights, (weight) => weight)
    let remainder = remainingTotal
    for (const [index, assignment] of group.entries()) {
      const weight = weights[index] ?? 0
      const share = index === group.length - 1
        ? remainder
        : weightTotal > 0
          ? Math.floor(remainingTotal * weight / weightTotal)
          : Math.floor(remainingTotal / group.length)
      result.set(assignment.id, share)
      remainder -= share
    }
  }
  return result
}

/** Returns the Monday-first bucket containing one local date. */
function bucketFor(date: string, granularity: CapacityPlanningGranularity): { fromDate: string; toDate: string } {
  if (granularity === 'day') return { fromDate: date, toDate: date }
  if (granularity === 'month') {
    const [year, month] = date.split('-').map(Number)
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return {
      fromDate: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`,
      toDate: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`,
    }
  }
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const fromDate = addCalendarDays(date, mondayOffset)
  return { fromDate, toDate: addCalendarDays(fromDate, 6) }
}

/** Finds the UTC instant corresponding to local midnight, including DST changes. */
function resolveLocalDateStart(date: string, timeZone: string, cache: DateTimeFormatterCache): number {
  const cacheKey = `${timeZone}\0${date}`
  const cached = cache.midnight.get(cacheKey)
  if (cached !== undefined) return cached
  const guess = Date.parse(`${date}T00:00:00.000Z`)
  for (let offsetMinutes = -900; offsetMinutes <= 900; offsetMinutes += 15) {
    const candidate = guess - offsetMinutes * 60_000
    if (localDateAt(candidate, timeZone, cache) === date && localTimeAt(candidate, timeZone, cache) === '00:00') {
      cache.midnight.set(cacheKey, candidate)
      return candidate
    }
  }
  throw new CapacityPlanningError(400, 'InvalidTimeZoneBoundary', 'The local date boundary could not be resolved.')
}

/** Caches timezone formatters and resolved local-midnight instants for one snapshot. */
type DateTimeFormatterCache = {
  /** Date formatters keyed by timezone. */
  dates: Map<string, Intl.DateTimeFormat>
  /** Wall-clock time formatters keyed by timezone. */
  times: Map<string, Intl.DateTimeFormat>
  /** Resolved local-midnight instants keyed by timezone and date. */
  midnight: Map<string, number>
}

/** Creates empty per-snapshot date-time formatter caches. */
function createDateTimeFormatterCache(): DateTimeFormatterCache {
  return { dates: new Map(), times: new Map(), midnight: new Map() }
}

/** Reads a local calendar date from an instant. */
function localDateAt(timestamp: number, timeZone: string, cache: DateTimeFormatterCache): string {
  const formatter = cache.dates.get(timeZone) ?? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  cache.dates.set(timeZone, formatter)
  const parts = formatter.formatToParts(new Date(timestamp))
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`
}

/** Reads a local wall-clock time from an instant. */
function localTimeAt(timestamp: number, timeZone: string, cache: DateTimeFormatterCache): string {
  const formatter = cache.times.get(timeZone) ?? new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  cache.times.set(timeZone, formatter)
  const parts = formatter.formatToParts(new Date(timestamp))
  return `${parts.find((part) => part.type === 'hour')?.value}:${parts.find((part) => part.type === 'minute')?.value}`
}

/** Validates common request fields for resource requests. */
function validateRequestFields(input: CreateResourceRequestInput): void {
  validateIdentifier(input.workspaceId, 'Workspace ID')
  validateIdentifier(input.teamId, 'Team ID')
  if (!input.title.trim()) throw new CapacityPlanningError(400, 'InvalidResourceRequest', 'A resource request title is required.')
  validateDateRange(input.fromDate, input.toDate)
  validateNonNegativeInteger(input.requestedMinutes, 'Requested minutes')
}

/** Validates common fields for resource assignments and what-if previews. */
function validateAssignmentFields(input: CreateResourceAssignmentInput | (WorkloadWhatIfInput & { skillIds: string[]; status: ResourceAssignment['status']; expectedTeamRevision: number; actorMemberId: string })): void {
  validateIdentifier(input.workspaceId, 'Workspace ID')
  validateIdentifier(input.teamId, 'Team ID')
  validateIdentifier(input.memberId, 'Member ID')
  const fromDate = 'assignmentFromDate' in input ? input.assignmentFromDate : input.fromDate
  const toDate = 'assignmentToDate' in input ? input.assignmentToDate : input.toDate
  validateDateRange(fromDate, toDate)
  validateNonNegativeInteger(input.allocationMinutes, 'Allocation minutes')
  validateNonNegativeInteger(input.plannedEffortMinutes, 'Planned effort minutes')
}

/** Validates a complete date range and returns normalized values. */
function validateDateRange(fromDate: string, toDate: string): { fromDate: string; toDate: string } {
  validateDate(fromDate, 'Start date')
  validateDate(toDate, 'End date')
  if (fromDate > toDate) throw new CapacityPlanningError(400, 'InvalidDateRange', 'The end date must not precede the start date.')
  const days = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) throw new CapacityPlanningError(413, 'CapacityPlanningRangeTooLarge', `The selected range must not exceed ${MAX_RANGE_DAYS} days.`)
  return { fromDate, toDate }
}

/** Validates a Gregorian calendar date. */
function validateDate(value: string, label: string): void {
  const parsed = ISO_DATE_PATTERN.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new CapacityPlanningError(400, 'InvalidDate', `${label} must be a valid YYYY-MM-DD date.`)
  }
}

/** Validates an IANA timezone identifier. */
function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
  } catch {
    throw new CapacityPlanningError(400, 'InvalidTimeZone', 'The timezone must be a valid IANA timezone identifier.')
  }
}

/** Validates a recurring working schedule. */
function validateSchedule(schedule: WorkingSchedule): void {
  for (const day of Object.values(schedule)) {
    if (!Number.isSafeInteger(day.minutes) || day.minutes < 0 || day.minutes > 1_440) {
      throw new CapacityPlanningError(400, 'InvalidWorkingSchedule', 'Working minutes must be between 0 and 1440.')
    }
    if (!day.enabled && day.minutes !== 0) {
      throw new CapacityPlanningError(400, 'InvalidWorkingSchedule', 'Disabled weekdays must have zero working minutes.')
    }
  }
}

/** Normalizes a bounded string list. */
function normalizeStringList(values: readonly string[], label: string, limit: number): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  if (normalized.length > limit || normalized.some((value) => value.length > 128)) {
    throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', `${label} exceeds the supported limit.`)
  }
  return normalized
}

/** Normalizes and validates holiday dates. */
function normalizeHolidays(values: readonly WorkloadHoliday[]): WorkloadHoliday[] {
  const normalized = values.map((holiday) => {
    validateDate(holiday.date, 'Holiday date')
    return { date: holiday.date, ...(holiday.label?.trim() ? { label: holiday.label.trim() } : {}) }
  })
  return [...new Map(normalized.map((holiday) => [holiday.date, holiday])).values()].sort((left, right) => left.date.localeCompare(right.date))
}

/** Validates a non-negative integer field. */
function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CapacityPlanningError(400, 'InvalidCapacityValue', `${label} must be a non-negative integer.`)
}

/** Validates and returns a non-empty identifier. */
function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new CapacityPlanningError(400, 'InvalidIdentifier', `${label} is invalid.`)
  return normalized
}

/** Returns a profile or a stable not-found error. */
function requireProfile(state: CapacityPlanningState, memberId: string): WorkloadMemberProfile {
  const profile = state.profiles.find((candidate) => candidate.memberId === memberId)
  if (!profile) throw new CapacityPlanningError(404, 'WorkloadProfileNotFound', 'The member workload profile was not found.')
  return profile
}

/** Returns a request or a stable not-found error. */
function requireRequest(state: CapacityPlanningState, requestId: string): ResourceRequest {
  const request = state.requests.find((candidate) => candidate.id === requestId)
  if (!request) throw new CapacityPlanningError(404, 'ResourceRequestNotFound', 'The resource request was not found.')
  return request
}

/** Refreshes request status from the allocation committed against it. */
function refreshRequestStatuses(state: CapacityPlanningState, timestamp: string): void {
  for (const request of state.requests) {
    if (request.status === 'canceled') continue
    const assigned = state.assignments
      .filter((assignment) => assignment.requestId === request.id && assignment.status !== 'canceled')
      .reduce((total, assignment) => total + assignment.allocationMinutes, 0)
    const status = assigned === 0 ? 'open' : assigned >= request.requestedMinutes ? 'filled' : 'partially-filled'
    if (status !== request.status) {
      request.status = status
      request.updatedAt = timestamp
      request.revision += 1
    }
  }
}

/** Replaces a typed array item by its stable key. */
function replaceById<T extends object>(items: T[], value: T, key: keyof T): void {
  const index = items.findIndex((item) => item[key] === value[key])
  if (index === -1) items.push(value)
  else items[index] = value
}

/** Returns a Monday-first weekday property. */
function weekdayKey(date: string): keyof WorkingSchedule {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return (['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const)[day]
}

/** Lists inclusive calendar dates. */
function listCalendarDates(fromDate: string, toDate: string): string[] {
  const result: string[] = []
  for (let date = fromDate; date <= toDate; date = addCalendarDays(date, 1)) result.push(date)
  return result
}

/** Adds calendar days without applying timezone arithmetic. */
function addCalendarDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** Returns a safe sum across workload values. */
function sum<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0)
}

/** Mutable daily calculation values. */
type DailyWorkload = {
  /** Available minutes. */
  capacityMinutes: number
  /** Time off waiting for approval. */
  pendingTimeOffMinutes: number
  /** Allocated minutes. */
  allocatedMinutes: number
  /** Allocated minutes from tentative assignments. */
  tentativeAllocatedMinutes: number
  /** Planned effort minutes. */
  plannedEffortMinutes: number
  /** Actual minutes. */
  actualMinutes: number
  /** Remaining effort minutes. */
  remainingEffortMinutes: number
}

/**
 * Removes rows the heatmap and lists no longer need, so the single Team record stays small.
 *
 * Canceled and rejected rows, and canceled requests, go once they ended more than
 * `CLOSED_ROW_RETENTION_DAYS` ago; any row goes once it ended more than `PAST_ROW_RETENTION_DAYS`
 * ago. A request stays while a kept assignment still refers to it.
 *
 * @param state - State to prune in place.
 * @param today - Current UTC calendar date.
 */
export function pruneCapacityPlanningState(state: CapacityPlanningState, today: string): void {
  const closedBefore = addCalendarDays(today, -CLOSED_ROW_RETENTION_DAYS)
  const pastBefore = addCalendarDays(today, -PAST_ROW_RETENTION_DAYS)
  const keep = (row: { toDate: string; status: string }) =>
    row.toDate >= pastBefore && !((row.status === 'canceled' || row.status === 'rejected') && row.toDate < closedBefore)
  for (const profile of state.profiles) {
    if (profile.timeOff.every(keep)) continue
    profile.timeOff = profile.timeOff.filter(keep)
  }
  state.assignments = state.assignments.filter(keep)
  const referencedRequestIds = new Set(state.assignments.flatMap((assignment) => assignment.requestId ? [assignment.requestId] : []))
  state.requests = state.requests.filter((request) => referencedRequestIds.has(request.id) || keep(request))
}

/**
 * Returns the submission or reviewer fields for a status set by an actor: a `planned` absence
 * records when it was submitted, and an approval or rejection records who decided it.
 */
function reviewFields(
  status: WorkloadTimeOff['status'],
  actorMemberId: string,
  timestamp: string,
): Pick<WorkloadTimeOff, 'reviewedAt' | 'reviewedBy' | 'submittedAt'> {
  if (status === 'planned') return { submittedAt: timestamp }
  return status === 'approved' || status === 'rejected' ? { reviewedBy: actorMemberId, reviewedAt: timestamp } : {}
}

/**
 * Reads a stored absence saved before time-off approval existed as approved.
 *
 * Such rows are `planned` without `submittedAt`, and they used to reduce capacity. Reading them
 * as approved keeps capacity unchanged on deploy; the next write of the Team stores them that way.
 *
 * @param timeOff - Stored absence.
 * @returns The absence, upgraded when it predates approval.
 */
export function upgradeLegacyTimeOff(timeOff: WorkloadTimeOff): WorkloadTimeOff {
  return timeOff.status === 'planned' && timeOff.submittedAt === undefined ? { ...timeOff, status: 'approved' } : timeOff
}

/** Workspace, Team, and actor shared by every workload mutation input. */
type WorkloadAuditScope = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Member performing the mutation. */
  actorMemberId: string
}

/** Time-off fields recorded in audit changes; the free-text reason is redacted. */
const TIME_OFF_AUDIT_FIELDS = ['fromDate', 'toDate', 'minutesPerDay', 'status', 'reason'] as const
/** Request fields recorded in audit changes. */
const REQUEST_AUDIT_FIELDS = ['title', 'projectId', 'role', 'skillIds', 'fromDate', 'toDate', 'requestedMinutes', 'confidential', 'status'] as const
/** Assignment fields recorded in audit changes. */
const ASSIGNMENT_AUDIT_FIELDS = ['memberId', 'requestId', 'projectId', 'workItemId', 'fromDate', 'toDate', 'allocationMinutes', 'plannedEffortMinutes', 'confidential', 'status'] as const

/**
 * Builds the audit event for a time-off change and notifies the member when someone else made it.
 *
 * @param scope - Workspace, Team, and actor.
 * @param memberId - Member whose absence changed.
 * @param previous - Absence before the change, or undefined when it was created.
 * @param next - Absence after the change.
 * @returns The audit event input.
 */
function createTimeOffAuditEvent(
  scope: WorkloadAuditScope,
  memberId: string,
  previous: WorkloadTimeOff | undefined,
  next: WorkloadTimeOff,
): MutationAuditEventInput {
  const action = !previous
    ? next.status === 'planned' ? 'requested' : 'created'
    : previous.status === next.status
      ? 'updated'
      : next.status === 'planned' ? 'reopened' : next.status
  return createWorkloadAuditEvent(scope, {
    eventType: `workload.time-off.${action}`,
    action: `time_off_${action}`,
    target: { type: 'workload-time-off', id: next.id },
    changes: createAuditFieldChanges(
      previous ? { ...previous } : undefined,
      { ...next },
      TIME_OFF_AUDIT_FIELDS,
      ['reason'],
    ),
    summary: `Time off ${next.fromDate} – ${next.toDate} ${action}`,
    recipients: [{ memberKey: memberId, reason: 'time-off-review' }],
    metadata: { memberId, timeOffId: next.id, status: next.status },
  })
}

/**
 * Builds the audit event for a resource request change.
 *
 * @param scope - Workspace, Team, and actor.
 * @param previous - Request before the change, or undefined when it was created.
 * @param next - Request after the change.
 * @returns The audit event input.
 */
function createRequestAuditEvent(
  scope: WorkloadAuditScope,
  previous: ResourceRequest | undefined,
  next: ResourceRequest,
): MutationAuditEventInput {
  const action = !previous ? 'created' : next.status === 'canceled' && previous.status !== 'canceled' ? 'canceled' : 'updated'
  return createWorkloadAuditEvent(scope, {
    eventType: `workload.request.${action}`,
    action: `resource_request_${action}`,
    target: { type: 'resource-request', id: next.id },
    changes: createAuditFieldChanges(
      previous ? { ...previous } : undefined,
      { ...next },
      REQUEST_AUDIT_FIELDS,
      next.confidential || previous?.confidential ? ['title'] : [],
    ),
    summary: next.confidential ? `Confidential resource request ${action}` : `Resource request "${next.title}" ${action}`,
    recipients: [],
    metadata: { requestId: next.id, status: next.status, ...(next.projectId ? { projectId: next.projectId } : {}) },
  })
}

/**
 * Builds the audit event for an assignment change and notifies the assigned members.
 *
 * Both the previous and the new member are notified of a reassignment.
 *
 * @param scope - Workspace, Team, and actor.
 * @param previous - Assignment before the change, or undefined when it was created.
 * @param next - Assignment after the change.
 * @returns The audit event input.
 */
function createAssignmentAuditEvent(
  scope: WorkloadAuditScope,
  previous: ResourceAssignment | undefined,
  next: ResourceAssignment,
): MutationAuditEventInput {
  const action = !previous
    ? 'created'
    : previous.status !== next.status
      ? next.status === 'confirmed' ? 'confirmed' : next.status === 'canceled' ? 'canceled' : 'unconfirmed'
      : previous.memberId !== next.memberId ? 'reassigned' : 'updated'
  const memberIds = [...new Set([previous?.memberId, next.memberId].filter((memberId): memberId is string => Boolean(memberId)))]
  return createWorkloadAuditEvent(scope, {
    eventType: `workload.assignment.${action}`,
    action: `resource_assignment_${action}`,
    target: { type: 'resource-assignment', id: next.id },
    changes: createAuditFieldChanges(previous ? { ...previous } : undefined, { ...next }, ASSIGNMENT_AUDIT_FIELDS),
    summary: `Assignment ${next.fromDate} – ${next.toDate} ${action}`,
    recipients: memberIds.map((memberKey) => ({ memberKey, reason: 'workload-assignment' })),
    metadata: {
      assignmentId: next.id,
      status: next.status,
      ...(next.projectId ? { projectId: next.projectId } : {}),
      ...(next.workItemId ? { workItemId: next.workItemId } : {}),
    },
  })
}

/**
 * Records a request cancellation that canceled more assignments than one write can audit one by
 * one, as a single event that lists every canceled assignment and notifies each assigned member.
 *
 * @param scope - Workspace, Team, and actor.
 * @param requestId - Canceled request.
 * @param canceled - Assignments canceled with the request.
 * @returns The audit event input.
 */
function createCascadeCancelAuditEvent(
  scope: WorkloadAuditScope,
  requestId: string,
  canceled: readonly ResourceAssignment[],
): MutationAuditEventInput {
  const memberIds = [...new Set(canceled.map((assignment) => assignment.memberId))]
  return createWorkloadAuditEvent(scope, {
    eventType: 'workload.assignment.canceled',
    action: 'resource_assignment_canceled',
    target: { type: 'resource-request', id: requestId },
    changes: undefined,
    summary: `${canceled.length} assignments canceled with their request`,
    recipients: memberIds.map((memberKey) => ({ memberKey, reason: 'workload-assignment' })),
    metadata: {
      requestId,
      assignmentIds: canceled.map((assignment) => assignment.id),
      status: 'canceled',
    },
  })
}

/**
 * Builds a Team workload audit event whose recipients, other than the actor, get a notification.
 *
 * @param scope - Workspace, Team, and actor.
 * @param event - Event type, target, changes, summary, recipients, and extra metadata.
 * @returns The audit event input.
 */
function createWorkloadAuditEvent(
  scope: WorkloadAuditScope,
  event: {
    /** Event type, such as `workload.time-off.approved`. */
    eventType: string
    /** Short action identifier. */
    action: string
    /** Changed row. */
    target: { type: string; id: string }
    /** Field changes. */
    changes: MutationAuditEventInput['changes']
    /** Short summary shown in activity and notifications. */
    summary: string
    /** Members to notify, before the actor is removed. */
    recipients: Array<{ memberKey: string; reason: string }>
    /** Extra metadata. */
    metadata: Record<string, unknown>
  },
): MutationAuditEventInput {
  const notificationCandidates = event.recipients.filter((recipient) => recipient.memberKey !== scope.actorMemberId)
  return {
    directoryId: scope.workspaceId,
    eventType: event.eventType,
    entityType: WORKLOAD_AUDIT_ENTITY_TYPE,
    entityId: scope.teamId,
    target: event.target,
    action: event.action,
    ...(event.changes ? { changes: event.changes } : {}),
    summary: event.summary,
    metadata: {
      ...event.metadata,
      teamId: scope.teamId,
      actorMemberKey: scope.actorMemberId,
      deepLink: `/teams/${encodeURIComponent(scope.teamId)}/members`,
      notificationTitle: 'Team workload',
      ...(notificationCandidates.length > 0 ? { notificationCandidates } : {}),
    },
  }
}

/** Creates an empty state. */
function emptyState(): CapacityPlanningState {
  return { revision: 0, profiles: [], requests: [], assignments: [] }
}

/** Creates an isolated map key. */
function stateKey(workspaceId: string, teamId: string): string {
  return `${workspaceId}\0${teamId}`
}

/** Creates the DynamoDB sort key. */
function stateRecordKey(teamId: string): string {
  return `${TEAM_RECORD_PREFIX}${teamId}`
}

/** Reads a stored state after applying bounded shape validation. */
function readState(item: Record<string, unknown>, workspaceId: string, teamId: string): CapacityPlanningState {
  const revision = item.revision
  const profiles = item.profiles
  const requests = item.requests
  const assignments = item.assignments
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(profiles) ||
    !Array.isArray(requests) ||
    !Array.isArray(assignments) ||
    profiles.length > MAX_PROFILES ||
    requests.length > MAX_REQUESTS ||
    assignments.length > MAX_ASSIGNMENTS ||
    !profiles.every((value) => isStoredMemberProfileForScope(value, workspaceId, teamId)) ||
    !requests.every((value) => isStoredResourceRequestForScope(value, workspaceId, teamId)) ||
    !assignments.every((value) => isStoredResourceAssignmentForScope(value, workspaceId, teamId)) ||
    (item.updatedAt !== undefined && typeof item.updatedAt !== 'string')
  ) {
    throw new CapacityPlanningError(500, 'InvalidCapacityPlanningState', 'The stored capacity planning state is invalid.')
  }
  return {
    revision,
    profiles: profiles.map((profile) => ({ ...profile, timeOff: profile.timeOff.map(upgradeLegacyTimeOff) })),
    requests,
    assignments,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
  }
}

/** Narrows a stored profile and verifies its DynamoDB partition scope. */
function isStoredMemberProfileForScope(value: unknown, workspaceId: string, teamId: string): value is WorkloadMemberProfile {
  return isStoredMemberProfile(value) && value.workspaceId === workspaceId && value.teamId === teamId
}

/** Narrows a stored request and verifies its DynamoDB partition scope. */
function isStoredResourceRequestForScope(value: unknown, workspaceId: string, teamId: string): value is ResourceRequest {
  return isStoredResourceRequest(value) && value.workspaceId === workspaceId && value.teamId === teamId
}

/** Narrows a stored assignment and verifies its DynamoDB partition scope. */
function isStoredResourceAssignmentForScope(value: unknown, workspaceId: string, teamId: string): value is ResourceAssignment {
  return isStoredResourceAssignment(value) && value.workspaceId === workspaceId && value.teamId === teamId
}

/** Narrows one stored member profile after a DynamoDB read. */
function isStoredMemberProfile(value: unknown): value is WorkloadMemberProfile {
  if (!isRecord(value)) return false
  return value.schemaVersion === CAPACITY_PLANNING_SCHEMA_VERSION &&
    isString(value.workspaceId) &&
    isString(value.teamId) &&
    isString(value.memberId) &&
    isOptionalString(value.displayName) &&
    isOptionalString(value.role) &&
    isStringArray(value.skills) &&
    isValidTimeZone(value.timeZone) &&
    isWorkingSchedule(value.schedule) &&
    Array.isArray(value.holidays) &&
    value.holidays.every(isStoredHoliday) &&
    Array.isArray(value.timeOff) &&
    value.timeOff.every(isStoredTimeOff) &&
    isPositiveSafeInteger(value.revision) &&
    isString(value.updatedAt)
}

/** Narrows one stored resource request after a DynamoDB read. */
function isStoredResourceRequest(value: unknown): value is ResourceRequest {
  if (!isRecord(value)) return false
  return isString(value.id) &&
    isString(value.workspaceId) &&
    isString(value.teamId) &&
    isOptionalString(value.projectId) &&
    isString(value.title) &&
    isOptionalString(value.role) &&
    isStringArray(value.skillIds) &&
    isIsoDate(value.fromDate) &&
    isIsoDate(value.toDate) &&
    value.fromDate <= value.toDate &&
    isNonNegativeSafeInteger(value.requestedMinutes) &&
    typeof value.confidential === 'boolean' &&
    isResourceRequestStatus(value.status) &&
    isPositiveSafeInteger(value.revision) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
}

/** Narrows one stored resource assignment after a DynamoDB read. */
function isStoredResourceAssignment(value: unknown): value is ResourceAssignment {
  if (!isRecord(value)) return false
  return isString(value.id) &&
    isString(value.workspaceId) &&
    isString(value.teamId) &&
    isOptionalString(value.requestId) &&
    isOptionalString(value.projectId) &&
    isOptionalString(value.workItemId) &&
    isOptionalString(value.cycleId) &&
    isOptionalString(value.recurringWorkId) &&
    isString(value.memberId) &&
    isOptionalString(value.role) &&
    isStringArray(value.skillIds) &&
    isIsoDate(value.fromDate) &&
    isIsoDate(value.toDate) &&
    value.fromDate <= value.toDate &&
    isNonNegativeSafeInteger(value.allocationMinutes) &&
    isNonNegativeSafeInteger(value.plannedEffortMinutes) &&
    typeof value.confidential === 'boolean' &&
    isResourceAssignmentStatus(value.status) &&
    isPositiveSafeInteger(value.revision) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
}

/** Narrows one stored time-off record. */
function isStoredTimeOff(value: unknown): value is WorkloadTimeOff {
  if (!isRecord(value)) return false
  return isString(value.id) &&
    isIsoDate(value.fromDate) &&
    isIsoDate(value.toDate) &&
    value.fromDate <= value.toDate &&
    (value.minutesPerDay === undefined || isNonNegativeSafeInteger(value.minutesPerDay)) &&
    isOptionalString(value.reason) &&
    isTimeOffStatus(value.status) &&
    isOptionalString(value.submittedAt) &&
    isOptionalString(value.reviewedBy) &&
    isOptionalString(value.reviewedAt) &&
    isPositiveSafeInteger(value.revision)
}

/** Narrows one stored holiday record. */
function isStoredHoliday(value: unknown): value is WorkloadHoliday {
  if (!isRecord(value)) return false
  return isIsoDate(value.date) && isOptionalString(value.label)
}

/** Validates a stored recurring schedule without throwing. */
function isWorkingSchedule(value: unknown): value is WorkingSchedule {
  if (!isRecord(value)) return false
  const days: readonly (keyof WorkingSchedule)[] = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ]
  return days.every((day) => {
    const entry = value[day]
    return isRecord(entry) &&
      typeof entry.enabled === 'boolean' &&
      isNonNegativeSafeInteger(entry.minutes) &&
      entry.minutes <= 1_440 &&
      (entry.enabled || entry.minutes === 0)
  })
}

/** Narrows an unknown object to a string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks an optional string property. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

/** Checks a string value. */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Checks a bounded string array's runtime shape. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

/** Checks a positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Checks a non-negative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks a stored ISO calendar date. */
function isIsoDate(value: unknown): value is string {
  if (!isString(value) || !ISO_DATE_PATTERN.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

/** Checks a stored IANA timezone identifier. */
function isValidTimeZone(value: unknown): value is string {
  if (!isString(value)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

/** Checks a stored time-off lifecycle state. */
function isTimeOffStatus(value: unknown): value is WorkloadTimeOff['status'] {
  return value === 'planned' || value === 'approved' || value === 'rejected' || value === 'canceled'
}

/** Checks a stored resource request lifecycle state. */
function isResourceRequestStatus(value: unknown): value is ResourceRequest['status'] {
  return value === 'open' || value === 'partially-filled' || value === 'filled' || value === 'canceled'
}

/** Checks a stored resource assignment lifecycle state. */
function isResourceAssignmentStatus(value: unknown): value is ResourceAssignment['status'] {
  return value === 'tentative' || value === 'confirmed' || value === 'canceled'
}

/** Detects a DynamoDB conditional failure without importing service-specific exceptions. */
function isConditionalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ConditionalCheckFailedException'
}

/** Checks whether a transaction was canceled. */
function isTransactionCanceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'TransactionCanceledException'
}

/** Checks whether a canceled transaction failed on the Team state revision (its first item). */
function isStateConditionCanceled(error: unknown): boolean {
  if (!isTransactionCanceled(error) || !isRecord(error) || !Array.isArray(error.CancellationReasons)) return false
  const [stateReason] = error.CancellationReasons
  return isRecord(stateReason) && stateReason.Code === 'ConditionalCheckFailed'
}

/**
 * Checks whether a canceled transaction failed only because an audit event already exists, which
 * means the same idempotency key was replayed. Throttling, transaction conflicts, and other
 * cancellations stay infrastructure errors so they are logged and can be retried.
 */
function isAuditConditionCanceled(error: unknown): boolean {
  if (!isTransactionCanceled(error) || !isRecord(error) || !Array.isArray(error.CancellationReasons)) return false
  const [, ...auditReasons] = error.CancellationReasons
  const failedAudit = auditReasons.some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
  const onlyConditionsFailed = error.CancellationReasons.every((reason) =>
    isRecord(reason) && (reason.Code === undefined || reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed'))
  return failedAudit && onlyConditionsFailed
}

/** Clones a value at the repository boundary. */
function clone<T>(value: T): T {
  return structuredClone(value)
}
