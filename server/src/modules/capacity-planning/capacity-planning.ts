import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  CapacityPlanningGranularity,
  ResourceAssignment,
  ResourceRequest,
  SaveWorkloadMemberProfileInput,
  SaveWorkloadTimeOffInput,
  CreateResourceAssignmentInput,
  CreateResourceRequestInput,
  UpdateResourceAssignmentInput,
  WorkloadCell,
  WorkloadHoliday,
  WorkloadMemberProfile,
  WorkloadMemberSummary,
  WorkloadSnapshot,
  WorkloadTimeOff,
  WorkingSchedule,
} from '@mukuroji/contracts'
import { CAPACITY_PLANNING_SCHEMA_VERSION } from '@mukuroji/contracts'

const TEAM_RECORD_PREFIX = 'CAPACITY#TEAM#'
const MAX_RANGE_DAYS = 366
const MAX_PROFILES = 2_000
const MAX_REQUESTS = 10_000
const MAX_ASSIGNMENTS = 20_000
const MAX_SKILLS = 64
const MAX_STATE_BYTES = 350_000
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/** A time entry projection used by capacity calculations. */
export type WorkloadTimeEntry = {
  /** Workspace member who recorded the time. */
  memberId: string
  /** Optional Project identifier used for project-scoped visibility. */
  projectId?: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Inclusive instant start. */
  startAt: string
  /** Exclusive instant end. */
  endAt: string
  /** Rounded duration in minutes. */
  durationMinutes: number
  /** Time-entry lifecycle status. */
  status: string
}

/** A Work Item estimate projection used by capacity calculations. */
export type WorkloadEstimate = {
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Planned effort in minutes. */
  estimateMinutes: number
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
  /** Lists Work Item estimates for the selected Team. */
  listEstimates(workspaceId: string, teamId: string): Promise<WorkloadEstimate[]>
}

/** Durable store for one Workspace/Team capacity planning state. */
export interface CapacityPlanningRepository {
  /** Reads the current Team state. */
  getState(workspaceId: string, teamId: string): Promise<CapacityPlanningState>
  /** Saves the state using the previous Team revision as a CAS condition. */
  saveState(
    workspaceId: string,
    teamId: string,
    state: CapacityPlanningState,
    expectedRevision: number,
  ): Promise<void>
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
  const visibleAssignments = state.assignments.filter((assignment) => {
    if (assignment.status === 'canceled' || !profileByMemberId.has(assignment.memberId)) return false
    if (!isProjectVisible(assignment.projectId)) return false
    return !assignment.confidential || input.canViewConfidential || assignment.memberId === input.viewerMemberId
  })
  const visibleRequests = state.requests.filter((request) =>
    isProjectVisible(request.projectId) && (!request.confidential || input.canViewConfidential)
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
  const estimateByWorkItemId = new Map(
    estimates.map((estimate) => [estimate.workItemId, Math.max(0, estimate.estimateMinutes)]),
  )

  const members = profiles.map((profile) =>
    calculateMemberSummary(
      profile,
      visibleAssignments.filter((assignment) => assignment.memberId === profile.memberId),
      actualByMember.get(profile.memberId) ?? { byDate: new Map(), byWorkItemId: new Map() },
      estimateByWorkItemId,
      fromDate,
      toDate,
      input.granularity,
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
    const [entries, estimates] = await Promise.all([
      this.dataSource.listTimeEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        from: `${addCalendarDays(range.fromDate, -1)}T00:00:00.000Z`,
        to: `${addCalendarDays(range.toDate, 2)}T00:00:00.000Z`,
      }),
      this.dataSource.listEstimates(input.workspaceId, input.teamId),
    ])
    return buildWorkloadSnapshot(state, entries, estimates, input, this.now().toISOString())
  }

  /** Saves or replaces one member's recurring schedule and holidays. */
  async saveMemberProfile(input: SaveWorkloadMemberProfileInput): Promise<WorkloadMemberProfile> {
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
    })
  }

  /** Saves or replaces one member's planned absence. */
  async saveTimeOff(input: SaveWorkloadTimeOffInput): Promise<WorkloadTimeOff> {
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
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
      const profile = requireProfile(state, input.memberId)
      if (profile.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'WorkloadProfileRevisionConflict', 'The workload profile was changed by another request.')
      }
      const previous = profile.timeOff.find((timeOff) => timeOff.id === nextTimeOff.id)
      const saved: WorkloadTimeOff = { ...nextTimeOff, revision: (previous?.revision ?? 0) + 1 }
      profile.timeOff = [...profile.timeOff.filter((timeOff) => timeOff.id !== saved.id), saved]
      profile.revision += 1
      profile.updatedAt = this.now().toISOString()
      return saved
    })
  }

  /** Creates a resource request. */
  async createRequest(input: CreateResourceRequestInput): Promise<ResourceRequest> {
    validateRequestFields(input)
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
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
      return request
    })
  }

  /** Creates an assignment for a profile and optionally fulfills a request. */
  async createAssignment(input: CreateResourceAssignmentInput): Promise<ResourceAssignment> {
    validateAssignmentFields(input)
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
      if (state.assignments.length >= MAX_ASSIGNMENTS) {
        throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'The Team has reached its resource assignment limit.')
      }
      requireProfile(state, input.memberId)
      if (input.requestId) requireRequest(state, input.requestId)
      const timestamp = this.now().toISOString()
      const assignment: ResourceAssignment = {
        id: this.createId(),
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
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
      return assignment
    })
  }

  /** Moves, reassigns, or resizes an assignment using optimistic concurrency. */
  async updateAssignment(input: UpdateResourceAssignmentInput): Promise<ResourceAssignment> {
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
      const current = state.assignments.find((assignment) => assignment.id === input.assignmentId)
      if (!current) throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
      if (current.revision !== input.expectedRevision) {
        throw new CapacityPlanningError(409, 'ResourceAssignmentRevisionConflict', 'The resource assignment was changed by another request.')
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
      return next
    })
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
    const profile = requireProfile(state, input.memberId)
    const current = input.assignmentId
      ? state.assignments.find((assignment) => assignment.id === input.assignmentId)
      : undefined
    if (input.assignmentId && !current) {
      throw new CapacityPlanningError(404, 'ResourceAssignmentNotFound', 'The resource assignment was not found.')
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
    const [entries, estimates] = await Promise.all([
      this.dataSource.listTimeEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        from: `${addCalendarDays(range.fromDate, -1)}T00:00:00.000Z`,
        to: `${addCalendarDays(range.toDate, 2)}T00:00:00.000Z`,
      }),
      this.dataSource.listEstimates(input.workspaceId, input.teamId),
    ])
    return buildWorkloadSnapshot(state, entries, estimates, input, this.now().toISOString())
  }

  /** Applies one state mutation with a Team-wide optimistic concurrency check. */
  private async mutateState<T>(
    workspaceId: string,
    teamId: string,
    expectedRevision: number,
    mutate: (state: CapacityPlanningState) => T,
  ): Promise<T> {
    const current = await this.repository.getState(workspaceId, teamId)
    if (current.revision !== expectedRevision) {
      throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
    }
    const next = clone(current)
    const result = mutate(next)
    next.revision = current.revision + 1
    next.updatedAt = this.now().toISOString()
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_STATE_BYTES) {
      throw new CapacityPlanningError(413, 'CapacityPlanningLimitExceeded', 'The Team workload plan is too large to save.')
    }
    await this.repository.saveState(workspaceId, teamId, next, current.revision)
    return result
  }
}

/** In-memory repository used by server tests and local development. */
export class InMemoryCapacityPlanningRepository implements CapacityPlanningRepository {
  /** Stored Team states. */
  private readonly states = new Map<string, CapacityPlanningState>()

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
  ): Promise<void> {
    const key = stateKey(workspaceId, teamId)
    const current = this.states.get(key)
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
    }
    this.states.set(key, clone(state))
  }
}

/** DynamoDB repository for durable capacity planning state. */
export class DynamoDbCapacityPlanningRepository implements CapacityPlanningRepository {
  /** DynamoDB table name. */
  private readonly tableName: string
  /** Configured DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient

  /** Creates a DynamoDB-backed capacity planning repository. */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    this.tableName = validateIdentifier(tableName, 'Capacity planning table name')
    this.documentClient = documentClient
  }

  /** Reads a Team state from the shared Workspace partition. */
  async getState(workspaceId: string, teamId: string): Promise<CapacityPlanningState> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: stateRecordKey(teamId) },
      ConsistentRead: true,
    }))
    if (!response.Item) return emptyState()
    return readState(response.Item)
  }

  /** Writes a Team state using a revision condition. */
  async saveState(
    workspaceId: string,
    teamId: string,
    state: CapacityPlanningState,
    expectedRevision: number,
  ): Promise<void> {
    try {
      await this.documentClient.send(new PutCommand({
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
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
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
  estimateByWorkItemId: ReadonlyMap<string, number>,
  fromDate: string,
  toDate: string,
  granularity: CapacityPlanningGranularity,
): WorkloadMemberSummary {
  const dates = listCalendarDates(fromDate, toDate)
  const daily = new Map<string, DailyWorkload>()
  for (const date of dates) {
    daily.set(date, {
      capacityMinutes: calculateAvailableMinutes(profile, date),
      allocatedMinutes: 0,
      plannedEffortMinutes: 0,
      actualMinutes: actual.byDate.get(date) ?? 0,
      remainingEffortMinutes: 0,
    })
  }
  const remainingAssignedWorkItems = new Set<string>()
  for (const assignment of assignments) {
    const assignmentDates = dates.filter((date) => date >= assignment.fromDate && date <= assignment.toDate)
    if (assignmentDates.length === 0) continue
    const distributionDates = chooseDistributionDates(profile, assignmentDates)
    distributeMinutes(daily, distributionDates, assignment.allocationMinutes, 'allocatedMinutes')
    distributeMinutes(daily, distributionDates, assignment.plannedEffortMinutes, 'plannedEffortMinutes')
    const actualMinutes = assignment.workItemId
      ? actual.byWorkItemId.get(assignment.workItemId) ?? 0
      : 0
    const estimate = assignment.workItemId
      ? estimateByWorkItemId.get(assignment.workItemId) ?? assignment.plannedEffortMinutes
      : assignment.plannedEffortMinutes
    const remaining = assignment.workItemId && remainingAssignedWorkItems.has(assignment.workItemId)
      ? 0
      : Math.max(0, Math.max(estimate, assignment.plannedEffortMinutes) - actualMinutes)
    if (assignment.workItemId) remainingAssignedWorkItems.add(assignment.workItemId)
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
    current.value.allocatedMinutes += value.allocatedMinutes
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
      allocatedMinutes: group.value.allocatedMinutes,
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

/** Computes the member's available minutes for one local date. */
function calculateAvailableMinutes(profile: WorkloadMemberProfile, date: string): number {
  const schedule = profile.schedule[weekdayKey(date)]
  if (!schedule.enabled || schedule.minutes === 0) return 0
  if (profile.holidays.some((holiday) => holiday.date === date)) return 0
  const absence = profile.timeOff
    .filter((timeOff) => timeOff.status !== 'canceled' && timeOff.fromDate <= date && timeOff.toDate >= date)
    .reduce((total, timeOff) => total + (timeOff.minutesPerDay ?? schedule.minutes), 0)
  return Math.max(0, schedule.minutes - absence)
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
  field: keyof Pick<DailyWorkload, 'allocatedMinutes' | 'plannedEffortMinutes' | 'remainingEffortMinutes'>,
): void {
  if (dates.length === 0 || minutes === 0) return
  const base = Math.floor(minutes / dates.length)
  let remainder = minutes % dates.length
  for (const date of dates) {
    const value = daily.get(date)
    if (!value) continue
    value[field] += base + (remainder > 0 ? 1 : 0)
    remainder -= 1
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
    for (const date of listCalendarDates(fromDate, toDate)) {
      const dayStart = resolveLocalDateStart(date, profile.timeZone)
      const dayEnd = resolveLocalDateStart(addCalendarDays(date, 1), profile.timeZone)
      const overlapMinutes = Math.max(0, Math.round((Math.min(end, dayEnd) - Math.max(start, dayStart)) / 60_000))
      if (overlapMinutes > 0) {
        memberActual.byDate.set(date, (memberActual.byDate.get(date) ?? 0) + overlapMinutes)
        memberActual.byWorkItemId.set(
          entry.workItemId,
          (memberActual.byWorkItemId.get(entry.workItemId) ?? 0) + overlapMinutes,
        )
      }
    }
    result.set(entry.memberId, memberActual)
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
function resolveLocalDateStart(date: string, timeZone: string): number {
  const guess = Date.parse(`${date}T00:00:00.000Z`)
  for (let offsetMinutes = -900; offsetMinutes <= 900; offsetMinutes += 15) {
    const candidate = guess - offsetMinutes * 60_000
    if (localDateAt(candidate, timeZone) === date && localTimeAt(candidate, timeZone) === '00:00') return candidate
  }
  throw new CapacityPlanningError(400, 'InvalidTimeZoneBoundary', 'The local date boundary could not be resolved.')
}

/** Reads a local calendar date from an instant. */
function localDateAt(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp))
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`
}

/** Reads a local wall-clock time from an instant. */
function localTimeAt(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp))
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
  /** Allocated minutes. */
  allocatedMinutes: number
  /** Planned effort minutes. */
  plannedEffortMinutes: number
  /** Actual minutes. */
  actualMinutes: number
  /** Remaining effort minutes. */
  remainingEffortMinutes: number
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
function readState(item: Record<string, unknown>): CapacityPlanningState {
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
    !profiles.every(isStoredMemberProfile) ||
    !requests.every(isStoredResourceRequest) ||
    !assignments.every(isStoredResourceAssignment) ||
    (item.updatedAt !== undefined && typeof item.updatedAt !== 'string')
  ) {
    throw new CapacityPlanningError(500, 'InvalidCapacityPlanningState', 'The stored capacity planning state is invalid.')
  }
  return {
    revision,
    profiles,
    requests,
    assignments,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
  }
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
  return value === 'planned' || value === 'approved' || value === 'canceled'
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

/** Clones a value at the repository boundary. */
function clone<T>(value: T): T {
  return structuredClone(value)
}
