import {
  GetCommand,
  PutCommand,
  QueryCommand,
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
  UpdateResourceRequestInput,
  WorkloadCell,
  WorkloadCellStatus,
  WorkloadContributorShare,
  WorkloadHoliday,
  WorkloadMemberProfile,
  WorkloadMemberSummary,
  WorkloadSnapshot,
  WorkloadTimeOff,
  WorkingSchedule,
  WorkItemScheduleCalendarPolicy,
  WorkspaceWorkloadCell,
  WorkspaceWorkloadMember,
  WorkspaceWorkloadProjectShare,
  WorkspaceWorkloadSnapshot,
  WorkspaceWorkloadTeam,
  WorkspaceWorkloadTeamShare,
  WorkspaceWeekStartDay,
} from '@mukuroji/contracts'
import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createWorkspaceWorkItemCalendarPolicy,
  isWorkloadCalendarSource,
  workspaceWeekContaining,
} from '@mukuroji/contracts'

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
  /** Project of the Work Item, when assigned. */
  projectId?: string
  /** Local dates over which contributor shares are placed; absent when unscheduled. */
  window?: { fromDate: string, toDate: string }
  /** Unfinished contributor shares of decided members with planned effort. */
  contributors?: Array<{
    /** Contributor assignment ID within the Work Item. */
    assignmentId: string
    /** Contributing member. */
    memberId: string
    /** Planned effort of the share in minutes. */
    plannedEffortMinutes: number
  }>
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
  /** Reads every Team state saved in the Workspace, for Workspace-wide totals. */
  listStates(workspaceId: string): Promise<TeamCapacityPlanningState[]>
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

/** One Team's stored capacity planning state, read for Workspace-wide totals. */
export type TeamCapacityPlanningState = {
  /** Team that owns the state. */
  teamId: string
  /** Stored state. */
  state: CapacityPlanningState
}

/** Visibility of one Team in a Workspace workload read, resolved by the HTTP adapter. */
export type WorkspaceWorkloadTeamVisibility = {
  /** Team identifier. */
  teamId: string
  /** Team display name. */
  name: string
  /** Member allowlist for the caller in this Team. Undefined means every member. */
  visibleMemberIds?: ReadonlySet<string>
  /** Project allowlist for the caller in this Team. Undefined means every Project. */
  visibleProjectIds?: ReadonlySet<string>
  /** Whether confidential assignments in this Team may be shown in detail. */
  canViewConfidential: boolean
}

/** Input for a Workspace workload read after HTTP authorization has been performed. */
export type WorkspaceWorkloadSnapshotInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Requested output granularity. */
  granularity: CapacityPlanningGranularity
  /** Member whose own confidential assignments stay visible. */
  viewerMemberId: string
  /** Teams the caller may view, with each Team's visibility; other Teams count only in totals. */
  teams: readonly WorkspaceWorkloadTeamVisibility[]
  /** Workspace calendar that inheriting profiles follow; the default calendar when omitted. */
  workspaceCalendar?: WorkItemScheduleCalendarPolicy
  /**
   * Teams that are not archived. Records of other Teams stay stored but count nowhere; every
   * stored Team counts when omitted.
   */
  activeTeamIds?: ReadonlySet<string>
  /** Day weekly buckets start on, from 0 (Sunday) to 6. Monday is used when omitted. */
  weekStartDay?: WorkspaceWeekStartDay
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
  /**
   * Workspace calendar that profiles inheriting it follow: its time zone, working weekdays, and
   * every day off. The default Workspace calendar is used when omitted.
   */
  workspaceCalendar?: WorkItemScheduleCalendarPolicy
  /**
   * Every Team state of the Workspace, this Team's included. When given, each cell also carries
   * the member's Workspace-wide capacity, allocation, and status.
   */
  workspaceTeamStates?: readonly TeamCapacityPlanningState[]
  /**
   * Teams that are not archived, for the Workspace-wide totals; every stored Team counts when
   * omitted. The Team being read always counts.
   */
  activeTeamIds?: ReadonlySet<string>
  /** Day weekly buckets start on, from 0 (Sunday) to 6. Monday is used when omitted. */
  weekStartDay?: WorkspaceWeekStartDay
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
  const storedProfiles = state.profiles.filter((profile) =>
    input.visibleMemberIds === undefined || input.visibleMemberIds.has(profile.memberId)
  )
  const workspaceCalendar = input.workspaceCalendar ??
    createWorkspaceWorkItemCalendarPolicy(DEFAULT_WORKSPACE_CALENDAR_SETTINGS)
  const profiles = storedProfiles.map((profile) => resolveEffectiveProfile(profile, workspaceCalendar))
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
  const contributorShares = listWorkloadContributorShares(
    estimates,
    state.assignments,
    (memberId) => profileByMemberId.has(memberId),
    isProjectVisible,
  )
  // Contributor shares count like assignments in the member rows, but stay out of `assignments`
  // because they belong to the Work Item and cannot be moved here.
  const countedAssignments = [
    ...visibleAssignments,
    ...contributorShares.map((share) => toContributorWorkloadAssignment(share, input, generatedAt)),
  ]
  const remainingEffortByAssignmentId = calculateRemainingEffortByAssignment(
    countedAssignments,
    actualByWorkItemId,
    estimateByWorkItemId,
    fromDate,
    toDate,
  )

  const members = profiles.map((profile, index) =>
    calculateMemberSummary(
      profile,
      storedProfiles[index] ?? profile,
      countedAssignments.filter((assignment) => assignment.memberId === profile.memberId),
      actualByMember.get(profile.memberId) ?? { byDate: new Map(), byWorkItemId: new Map() },
      fromDate,
      toDate,
      input.granularity,
      remainingEffortByAssignmentId,
      input.weekStartDay ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay,
    )
  )
  if (input.workspaceTeamStates) {
    const dates = listCalendarDates(fromDate, toDate)
    for (const member of members) {
      const daily = buildMemberWorkspaceDaily(member.memberId, input.workspaceTeamStates, workspaceCalendar, dates)
      if (daily) {
        applyWorkspaceTotals(member, daily, input.granularity, input.weekStartDay ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay)
      }
    }
  }

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
    contributorShares,
    redactedAssignmentCount,
    redactedRequestCount,
    revision: state.revision,
    generatedAt,
  }
}

/**
 * Lists the Work Item contributor shares counted in the visible members' workload.
 *
 * A share is counted for a counted member on a scheduled, visible Work Item. It is left out when that member has any resource assignment for the same Work Item that is not
 * canceled, confidential ones included, because the assignment already plans that member's part
 * and counting both would double the same work.
 *
 * @param estimates - Canonical Work Item estimates with their contributor shares.
 * @param assignments - Every stored resource assignment of the Team.
 * @param isMemberCounted - Whether a member's shares count, such as a visible member with a profile.
 * @param isProjectVisible - Project visibility of the reader.
 * @returns The counted shares, ordered by Work Item and assignment ID.
 */
function listWorkloadContributorShares(
  estimates: readonly WorkloadEstimate[],
  assignments: readonly ResourceAssignment[],
  isMemberCounted: (memberId: string) => boolean,
  isProjectVisible: (projectId: string | undefined) => boolean,
): WorkloadContributorShare[] {
  const plannedMembers = new Set(assignments.flatMap((assignment) =>
    assignment.workItemId === undefined || assignment.status === 'canceled'
      ? []
      : [`${assignment.workItemId}\0${assignment.memberId}`]))
  return estimates.flatMap((estimate) => {
    const window = estimate.window
    if (!window || !isProjectVisible(estimate.projectId)) return []
    return (estimate.contributors ?? []).flatMap((contributor) =>
      !isMemberCounted(contributor.memberId) ||
        plannedMembers.has(`${estimate.workItemId}\0${contributor.memberId}`)
        ? []
        : [{
            workItemId: estimate.workItemId,
            assignmentId: contributor.assignmentId,
            memberId: contributor.memberId,
            ...(estimate.projectId ? { projectId: estimate.projectId } : {}),
            fromDate: window.fromDate,
            toDate: window.toDate,
            plannedEffortMinutes: contributor.plannedEffortMinutes,
          }])
  }).sort((left, right) =>
    left.workItemId.localeCompare(right.workItemId) || left.assignmentId.localeCompare(right.assignmentId))
}

/**
 * Expresses a contributor share as a read-only assignment for the workload calculation.
 *
 * The share's planned effort is both its allocation and its planned effort, so a member's
 * contributor work shows up against their capacity like a resource assignment does.
 *
 * @param share - Contributor share counted in the workload.
 * @param input - Snapshot scope.
 * @param generatedAt - Snapshot time used for the timestamps.
 * @returns An assignment that is never stored or returned.
 */
function toContributorWorkloadAssignment(
  share: WorkloadContributorShare,
  input: Pick<WorkloadSnapshotInput, 'workspaceId' | 'teamId'>,
  generatedAt: string,
): ResourceAssignment {
  return {
    id: `contributor:${share.workItemId}:${share.assignmentId}`,
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    ...(share.projectId ? { projectId: share.projectId } : {}),
    workItemId: share.workItemId,
    memberId: share.memberId,
    skillIds: [],
    fromDate: share.fromDate,
    toDate: share.toDate,
    allocationMinutes: share.plannedEffortMinutes,
    plannedEffortMinutes: share.plannedEffortMinutes,
    confidential: false,
    status: 'confirmed',
    revision: 0,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
}

/**
 * Adds each Team's contributor shares to its state as read-only assignments for Workspace-wide totals.
 *
 * Workspace-wide totals count every member's work in every Team, so every scheduled share counts,
 * whatever the reader may see, unless the member has a resource assignment for the same Work Item.
 * The added assignments only feed the totals and the aggregated breakdowns and are never stored.
 *
 * @param teamStates - Team states the totals are built from.
 * @param estimatesByTeamId - Canonical Work Item estimates of each Team.
 * @param workspaceId - Workspace that owns the states.
 * @param generatedAt - Snapshot time used for the timestamps.
 * @returns The Team states with the contributor shares added to their assignments.
 */
function withContributorReservations(
  teamStates: readonly TeamCapacityPlanningState[],
  estimatesByTeamId: ReadonlyMap<string, readonly WorkloadEstimate[]>,
  workspaceId: string,
  generatedAt: string,
): TeamCapacityPlanningState[] {
  return teamStates.map(({ teamId, state }) => {
    const shares = listWorkloadContributorShares(
      estimatesByTeamId.get(teamId) ?? [],
      state.assignments,
      () => true,
      () => true,
    )
    if (shares.length === 0) return { teamId, state }
    return {
      teamId,
      state: {
        ...state,
        assignments: [
          ...state.assignments,
          ...shares.map((share) => toContributorWorkloadAssignment(share, { workspaceId, teamId }, generatedAt)),
        ],
      },
    }
  })
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

/**
 * Builds the smallest time-entry window needed for the visible workload range.
 *
 * The window covers the visible resource assignments and the scheduled contributor shares,
 * so time logged before the displayed range still reduces their remaining effort.
 *
 * @param state - Stored capacity planning state.
 * @param input - Snapshot scope and visibility.
 * @param range - Displayed date range.
 * @param estimates - Canonical Work Item estimates with their contributor shares.
 * @returns The ISO time-entry query bounds.
 */
function getTimeEntryQueryRange(
  state: CapacityPlanningState,
  input: WorkloadSnapshotInput,
  range: { fromDate: string; toDate: string },
  estimates: readonly WorkloadEstimate[],
): { from: string; to: string } {
  const profiles = state.profiles.filter((profile) =>
    input.visibleMemberIds === undefined || input.visibleMemberIds.has(profile.memberId)
  )
  const profileByMemberId = new Map(profiles.map((profile) => [profile.memberId, profile]))
  const isProjectVisible = (projectId: string | undefined): boolean =>
    input.visibleProjectIds === undefined || projectId === undefined || input.visibleProjectIds.has(projectId)
  const relevantAssignments: Array<{ fromDate: string; toDate: string }> = [
    ...state.assignments.filter((assignment) =>
      assignment.workItemId !== undefined && isAssignmentVisible(assignment, input, profileByMemberId, isProjectVisible)
    ),
    ...listWorkloadContributorShares(estimates, state.assignments, (memberId) => profileByMemberId.has(memberId), isProjectVisible),
  ]
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
    const [state, workspaceTeamStates] = await Promise.all([
      this.repository.getState(input.workspaceId, input.teamId),
      this.repository.listStates(input.workspaceId),
    ])
    const { entries, estimates } = await this.readWorkloadSources(state, input, range)
    const generatedAt = this.now().toISOString()
    const teamStates = replaceTeamState(
      filterActiveTeamStates(workspaceTeamStates, input.activeTeamIds),
      input.teamId,
      state,
    )
    // Another Team's estimates, such as one over the Work Item read limit, must not fail this
    // Team's view. Without them the Workspace totals would be too low, so they are left out.
    const teamEstimates = await this.readTeamEstimates(
      input.workspaceId,
      teamStates,
      { teamId: input.teamId, estimates },
    ).catch(() => undefined)
    return buildWorkloadSnapshot(
      state,
      entries,
      estimates,
      teamEstimates === undefined
        ? input
        : {
            ...input,
            workspaceTeamStates: withContributorReservations(teamStates, teamEstimates, input.workspaceId, generatedAt),
          },
      generatedAt,
    )
  }

  /**
   * Reads the Workspace-wide workload of the members the caller may see in the given Teams.
   *
   * @param input - Range, granularity, and the Teams the caller may view with their visibility.
   * @returns Members with Workspace-wide capacity, total allocation, and visible breakdowns.
   */
  async getWorkspaceSnapshot(input: WorkspaceWorkloadSnapshotInput): Promise<WorkspaceWorkloadSnapshot> {
    validateDateRange(input.fromDate, input.toDate)
    const teamStates = filterActiveTeamStates(await this.repository.listStates(input.workspaceId), input.activeTeamIds)
    const generatedAt = this.now().toISOString()
    // A Team whose estimates cannot be read fails the read instead of leaving its shares out.
    return buildWorkspaceWorkloadSnapshot(
      withContributorReservations(
        teamStates,
        await this.readTeamEstimates(input.workspaceId, teamStates),
        input.workspaceId,
        generatedAt,
      ),
      input,
      generatedAt,
    )
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
        // A client that leaves the field out, such as one from before inheritance, keeps the
        // profile's current calendar; a new profile then keeps its own.
        ...((input.calendarSource ?? current?.calendarSource) === 'workspace'
          ? { calendarSource: 'workspace' as const }
          : {}),
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
   * canceled request never keeps reserving capacity. Canceled requests are read-only.
   *
   * @param input - Changed request fields, an optional cancel status, and expected revisions.
   * @param access - Whether the actor may see confidential requests; hidden requests are reported as missing.
   * @returns The saved request.
   */
  async updateRequest(
    input: UpdateResourceRequestInput,
    access: {
      /** Whether the actor may read and change confidential requests. */
      canViewConfidential: boolean
    },
  ): Promise<ResourceRequest> {
    validateIdentifier(input.workspaceId, 'Workspace ID')
    validateIdentifier(input.teamId, 'Team ID')
    validateIdentifier(input.requestId, 'Request ID')
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
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
      if (input.status === 'canceled' && state.assignments.some((assignment) =>
        assignment.requestId === current.id && assignment.status !== 'canceled'
      )) {
        throw new CapacityPlanningError(
          409,
          'ResourceRequestHasActiveAssignments',
          'Cancel the assignments that fill this resource request before canceling it.',
        )
      }
      const role = input.role === undefined ? current.role : input.role.trim() || undefined
      const timestamp = this.now().toISOString()
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
      return clone(requireRequest(state, next.id))
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
      return assignment
    })
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

  /** Moves, reassigns, or resizes an assignment using optimistic concurrency. */
  async updateAssignment(input: UpdateResourceAssignmentInput): Promise<ResourceAssignment> {
    return await this.mutateState(input.workspaceId, input.teamId, input.expectedTeamRevision, (state) => {
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
    const { entries, estimates } = await this.readWorkloadSources(state, input, range)
    return buildWorkloadSnapshot(state, entries, estimates, input, this.now().toISOString())
  }

  /**
   * Reads the estimates and the time entries a workload snapshot needs.
   *
   * Estimates are read first because their contributor shares widen the time-entry window.
   *
   * @param state - Capacity planning state the snapshot is built from.
   * @param input - Snapshot scope and visibility.
   * @param range - Displayed date range.
   * @returns The time entries and estimates.
   */
  private async readWorkloadSources(
    state: CapacityPlanningState,
    input: WorkloadSnapshotInput,
    range: { fromDate: string; toDate: string },
  ): Promise<{ entries: Awaited<ReturnType<CapacityPlanningDataSource['listTimeEntries']>>, estimates: WorkloadEstimate[] }> {
    const estimates = await this.dataSource.listEstimates(input.workspaceId, input.teamId)
    const timeEntryRange = getTimeEntryQueryRange(state, input, range, estimates)
    const entries = await this.dataSource.listTimeEntries({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      from: timeEntryRange.from,
      to: timeEntryRange.to,
    })
    return { entries, estimates }
  }

  /**
   * Reads the canonical Work Item estimates of every Team whose contributor shares count in
   * Workspace-wide totals.
   *
   * @param workspaceId - Workspace that owns the Teams.
   * @param teamStates - Teams to read.
   * @param known - Estimates already read for one Team, reused instead of read again.
   * @returns The estimates of each Team.
   */
  private async readTeamEstimates(
    workspaceId: string,
    teamStates: readonly TeamCapacityPlanningState[],
    known?: { teamId: string; estimates: readonly WorkloadEstimate[] },
  ): Promise<Map<string, readonly WorkloadEstimate[]>> {
    const estimates = await Promise.all(teamStates.map(({ teamId }) =>
      known?.teamId === teamId ? known.estimates : this.dataSource.listEstimates(workspaceId, teamId)))
    return new Map(teamStates.map(({ teamId }, index) => [teamId, estimates[index] ?? []]))
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

  /** Reads isolated clones of every Team state in the Workspace. */
  async listStates(workspaceId: string): Promise<TeamCapacityPlanningState[]> {
    const prefix = stateKey(workspaceId, '')
    return [...this.states.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, state]) => ({ teamId: key.slice(prefix.length), state: clone(state) }))
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
    return readState(response.Item, workspaceId, teamId)
  }

  /** Reads every Team state of the Workspace partition, following pagination. */
  async listStates(workspaceId: string): Promise<TeamCapacityPlanningState[]> {
    const states: TeamCapacityPlanningState[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': TEAM_RECORD_PREFIX },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        const recordKey = item.recordKey
        if (typeof recordKey !== 'string' || !recordKey.startsWith(TEAM_RECORD_PREFIX)) continue
        const teamId = recordKey.slice(TEAM_RECORD_PREFIX.length)
        states.push({ teamId, state: readState(item, workspaceId, teamId) })
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return states
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

/**
 * Applies the Workspace calendar to a profile that inherits it.
 *
 * The result uses the Workspace time zone, keeps a weekday only when both the Workspace and the
 * member work on it, and adds every Workspace day off to the member's personal days off. A
 * profile with its own calendar comes back as a shallow copy with the same values. Either way the
 * result is a new object for each snapshot, so the holiday lookup cached on it never outlives the
 * snapshot or reflects holidays from an earlier one.
 *
 * @param profile - Stored profile.
 * @param workspaceCalendar - Workspace time zone, working weekdays, and days off.
 * @returns The profile the availability rules are applied to.
 */
function resolveEffectiveProfile(
  profile: WorkloadMemberProfile,
  workspaceCalendar: WorkItemScheduleCalendarPolicy,
): WorkloadMemberProfile {
  if (profile.calendarSource !== 'workspace') return { ...profile }
  const workingWeekdays = new Set<string>(workspaceCalendar.workingWeekdays)
  const schedule = clone(profile.schedule)
  for (const weekday of WORKING_SCHEDULE_WEEKDAYS) {
    if (!workingWeekdays.has(weekday)) schedule[weekday] = { enabled: false, minutes: 0 }
  }
  const holidays = new Map(profile.holidays.map((holiday) => [holiday.date, holiday]))
  for (const date of workspaceCalendar.holidays) {
    if (!holidays.has(date)) holidays.set(date, { date })
  }
  return {
    ...profile,
    timeZone: workspaceCalendar.timeZone,
    schedule,
    holidays: [...holidays.values()],
  }
}

/** Weekday keys of a working schedule, Monday first. */
const WORKING_SCHEDULE_WEEKDAYS: readonly (keyof WorkingSchedule)[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

/**
 * Calculates one member's daily and aggregated workload rows.
 *
 * @param profile - Profile the availability rules are applied to.
 * @param stored - Stored profile whose own calendar fields the summary returns for editing.
 */
function calculateMemberSummary(
  profile: WorkloadMemberProfile,
  stored: WorkloadMemberProfile,
  assignments: readonly ResourceAssignment[],
  actual: { byDate: ReadonlyMap<string, number>; byWorkItemId: ReadonlyMap<string, number> },
  fromDate: string,
  toDate: string,
  granularity: CapacityPlanningGranularity,
  remainingEffortByAssignmentId: ReadonlyMap<string, number>,
  weekStartDay: WorkspaceWeekStartDay,
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
  for (const assignment of assignments) {
    const assignmentDates = listCalendarDates(assignment.fromDate, assignment.toDate)
    if (!assignmentDates.some((date) => daily.has(date))) continue
    const distributionDates = chooseDistributionDates(profile, assignmentDates)
    distributeMinutes(daily, distributionDates, assignment.allocationMinutes, 'allocatedMinutes')
    distributeMinutes(daily, distributionDates, assignment.plannedEffortMinutes, 'plannedEffortMinutes')
    const remaining = assignment.workItemId
      ? remainingEffortByAssignmentId.get(assignment.id) ?? 0
      : assignment.plannedEffortMinutes
    distributeMinutes(daily, distributionDates, remaining, 'remainingEffortMinutes')
  }
  const cells = aggregateCells(daily, granularity, weekStartDay)
  return {
    memberId: profile.memberId,
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.role ? { role: profile.role } : {}),
    skills: [...profile.skills],
    calendarSource: stored.calendarSource ?? 'custom',
    timeZone: stored.timeZone,
    effectiveTimeZone: profile.timeZone,
    schedule: clone(stored.schedule),
    holidays: stored.holidays.map(({ date, label }) => ({ date, ...(label ? { label } : {}) })),
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
  weekStartDay: WorkspaceWeekStartDay,
): WorkloadCell[] {
  const groups = new Map<string, { fromDate: string; toDate: string; value: DailyWorkload }>()
  for (const [date, value] of daily) {
    const bucket = bucketFor(date, granularity, weekStartDay)
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
    const status = calculateCellStatus(group.value.capacityMinutes, group.value.allocatedMinutes)
    return {
      fromDate: group.fromDate,
      toDate: group.toDate,
      label: group.fromDate,
      capacityMinutes: group.value.capacityMinutes,
      allocatedMinutes: group.value.allocatedMinutes,
      plannedEffortMinutes: group.value.plannedEffortMinutes,
      actualMinutes: group.value.actualMinutes,
      remainingEffortMinutes: group.value.remainingEffortMinutes,
      utilizationPercent: calculateUtilizationPercent(group.value.capacityMinutes, group.value.allocatedMinutes),
      varianceMinutes,
      status,
    }
  })
}

/**
 * Classifies a bucket by comparing allocation with capacity.
 *
 * @param capacityMinutes - Available minutes in the bucket.
 * @param allocatedMinutes - Reserved minutes in the bucket.
 * @returns `unavailable` with no capacity and no demand, otherwise under, balanced, or over.
 */
function calculateCellStatus(capacityMinutes: number, allocatedMinutes: number): WorkloadCellStatus {
  if (capacityMinutes === 0) return allocatedMinutes > 0 ? 'over' : 'unavailable'
  const varianceMinutes = capacityMinutes - allocatedMinutes
  return varianceMinutes < 0 ? 'over' : varianceMinutes === 0 ? 'balanced' : 'under'
}

/**
 * Expresses allocation as a share of capacity.
 *
 * @param capacityMinutes - Available minutes in the bucket.
 * @param allocatedMinutes - Reserved minutes in the bucket.
 * @returns The rounded percentage; 100 when demand meets no capacity.
 */
function calculateUtilizationPercent(capacityMinutes: number, allocatedMinutes: number): number {
  if (capacityMinutes === 0) return allocatedMinutes > 0 ? 100 : 0
  return Math.round((allocatedMinutes / capacityMinutes) * 100)
}

/** Daily minutes one active assignment reserves for a member, inside the selected range. */
type WorkspaceAssignmentLoad = {
  /** Team that owns the assignment. */
  teamId: string
  /** Stored assignment. */
  assignment: ResourceAssignment
  /** Reserved minutes per selected local date. */
  minutesByDate: Map<string, number>
}

/** A member's Workspace-wide daily capacity and every Team's daily allocation. */
type MemberWorkspaceDaily = {
  /** Display name from the first Team profile that has one. */
  displayName?: string
  /** Role from the first Team profile that has one. */
  role?: string
  /** Smallest capacity of the member's Team profiles on each selected date. */
  capacityByDate: Map<string, number>
  /** Active assignments overlapping the range, with their daily minutes. */
  loads: WorkspaceAssignmentLoad[]
}

/**
 * Keeps the records of Teams that are not archived.
 *
 * An archived Team keeps its capacity record, but its profiles and allocations must no longer
 * lower or add to its former members' Workspace-wide numbers.
 *
 * @param teamStates - Every stored Team state of the Workspace.
 * @param activeTeamIds - Teams that are not archived, or undefined to keep every record.
 * @returns The records of active Teams.
 */
function filterActiveTeamStates(
  teamStates: readonly TeamCapacityPlanningState[],
  activeTeamIds: ReadonlySet<string> | undefined,
): TeamCapacityPlanningState[] {
  return activeTeamIds ? teamStates.filter((teamState) => activeTeamIds.has(teamState.teamId)) : [...teamStates]
}

/**
 * Computes one member's Workspace-wide daily capacity and allocation from every Team state.
 *
 * Capacity on a date is the smallest capacity any of the member's Team profiles gives, so time off
 * or a day off saved in one Team lowers the member's capacity everywhere. Each assignment is spread
 * the way its own Team's view spreads it: over the dates its Team profile makes available, or the
 * member's first profile when that Team has none.
 *
 * @param memberId - Member to compute.
 * @param teamStates - Every Team state of the Workspace.
 * @param workspaceCalendar - Workspace calendar applied to inheriting profiles.
 * @param dates - Selected local dates, in order.
 * @param metadataTeamIds - Teams whose profiles may supply the display name and role, in order;
 *   profiles of other Teams still count for capacity but never show their own labels.
 * @returns The daily values, or `undefined` when no Team has a profile for the member.
 */
function buildMemberWorkspaceDaily(
  memberId: string,
  teamStates: readonly TeamCapacityPlanningState[],
  workspaceCalendar: WorkItemScheduleCalendarPolicy,
  dates: readonly string[],
  metadataTeamIds: readonly string[] = [],
): MemberWorkspaceDaily | undefined {
  const profileByTeamId = new Map<string, WorkloadMemberProfile>()
  for (const { teamId, state } of teamStates) {
    const profile = state.profiles.find((candidate) => candidate.memberId === memberId)
    if (profile) profileByTeamId.set(teamId, resolveEffectiveProfile(profile, workspaceCalendar))
  }
  const profiles = [...profileByTeamId.values()]
  const firstProfile = profiles[0]
  if (!firstProfile) return undefined
  const capacityByDate = new Map(dates.map((date) => [
    date,
    Math.min(...profiles.map((profile) => calculateAvailableMinutes(profile, date))),
  ]))
  const firstDate = dates[0] ?? ''
  const lastDate = dates.at(-1) ?? ''
  const loads: WorkspaceAssignmentLoad[] = []
  for (const { teamId, state } of teamStates) {
    for (const assignment of state.assignments) {
      if (
        assignment.memberId !== memberId ||
        assignment.status === 'canceled' ||
        assignment.toDate < firstDate ||
        assignment.fromDate > lastDate
      ) continue
      const profile = profileByTeamId.get(teamId) ?? firstProfile
      const distributionDates = chooseDistributionDates(profile, listCalendarDates(assignment.fromDate, assignment.toDate))
      loads.push({
        teamId,
        assignment,
        minutesByDate: distributeMinutesOverDates(distributionDates, assignment.allocationMinutes, capacityByDate),
      })
    }
  }
  const labelProfiles = metadataTeamIds.flatMap((teamId) => {
    const profile = profileByTeamId.get(teamId)
    return profile ? [profile] : []
  })
  const displayName = labelProfiles.find((profile) => profile.displayName)?.displayName
  const role = labelProfiles.find((profile) => profile.role)?.role
  return {
    ...(displayName ? { displayName } : {}),
    ...(role ? { role } : {}),
    capacityByDate,
    loads,
  }
}

/**
 * Spreads minutes evenly over dates, keeping only the dates inside the selected range.
 *
 * @param dates - Dates the minutes are spread over.
 * @param minutes - Minutes to spread; remainder minutes go to the earliest dates.
 * @param selected - Selected dates; minutes on other dates are dropped.
 * @returns Minutes per selected date.
 */
function distributeMinutesOverDates(
  dates: readonly string[],
  minutes: number,
  selected: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = new Map<string, number>()
  if (dates.length === 0 || minutes === 0) return result
  const base = Math.floor(minutes / dates.length)
  let remainder = minutes % dates.length
  for (const date of dates) {
    const value = base + (remainder > 0 ? 1 : 0)
    remainder -= 1
    if (selected.has(date) && value > 0) result.set(date, value)
  }
  return result
}

/**
 * Adds a member's Workspace-wide capacity, allocation, and status to each Team view cell.
 *
 * @param member - Team view row, changed in place.
 * @param daily - The member's Workspace-wide daily values.
 * @param granularity - Granularity of the row's cells.
 * @param weekStartDay - Day weekly buckets start on.
 */
function applyWorkspaceTotals(
  member: WorkloadMemberSummary,
  daily: MemberWorkspaceDaily,
  granularity: CapacityPlanningGranularity,
  weekStartDay: WorkspaceWeekStartDay,
): void {
  const totals = new Map<string, { capacityMinutes: number; allocatedMinutes: number }>()
  for (const [date, capacityMinutes] of daily.capacityByDate) {
    const bucket = bucketFor(date, granularity, weekStartDay).fromDate
    const current = totals.get(bucket) ?? { capacityMinutes: 0, allocatedMinutes: 0 }
    current.capacityMinutes += capacityMinutes
    current.allocatedMinutes += sum(daily.loads, (load) => load.minutesByDate.get(date) ?? 0)
    totals.set(bucket, current)
  }
  for (const cell of member.cells) {
    const total = totals.get(cell.fromDate) ?? { capacityMinutes: 0, allocatedMinutes: 0 }
    cell.workspaceCapacityMinutes = total.capacityMinutes
    cell.workspaceAllocatedMinutes = total.allocatedMinutes
    cell.workspaceStatus = calculateCellStatus(total.capacityMinutes, total.allocatedMinutes)
  }
  member.workspaceOverloaded = member.cells.some((cell) => cell.workspaceStatus === 'over')
}

/**
 * Returns the Team states with one Team's state replaced by a fresher read.
 *
 * @param teamStates - Every Team state of the Workspace.
 * @param teamId - Team whose state was read separately.
 * @param state - The separately read state.
 * @returns The Team states, with that Team's state replaced or added.
 */
function replaceTeamState(
  teamStates: readonly TeamCapacityPlanningState[],
  teamId: string,
  state: CapacityPlanningState,
): TeamCapacityPlanningState[] {
  return [...teamStates.filter((candidate) => candidate.teamId !== teamId), { teamId, state }]
}

/** Running totals of one Workspace workload bucket. */
type WorkspaceBucketTotals = {
  /** Inclusive bucket start date. */
  fromDate: string
  /** Inclusive bucket end date. */
  toDate: string
  /** Workspace-wide capacity. */
  capacityMinutes: number
  /** Allocation of every Team. */
  allocatedMinutes: number
  /** Visible allocation per Team ID. */
  teams: Map<string, number>
  /** Visible allocation per Team and Project key. */
  projects: Map<string, WorkspaceWorkloadProjectShare>
}

/**
 * Builds the Workspace-wide workload of the members the caller may see.
 *
 * A member appears when a viewable Team has a profile for them and the Team's member allowlist
 * includes them. Totals count every active assignment of every Team; the Team and Project
 * breakdowns count only assignments of viewable Teams whose member allowlist includes the member
 * and that the Team's Project and confidential rules let the caller see, and the rest is reported
 * as hidden allocation.
 *
 * @param teamStates - Every Team state of the Workspace.
 * @param input - Range, granularity, viewer, and viewable Teams with their visibility.
 * @param generatedAt - Generation timestamp.
 * @returns The Workspace workload snapshot.
 */
export function buildWorkspaceWorkloadSnapshot(
  teamStates: readonly TeamCapacityPlanningState[],
  input: WorkspaceWorkloadSnapshotInput,
  generatedAt = new Date().toISOString(),
): WorkspaceWorkloadSnapshot {
  const { fromDate, toDate } = validateDateRange(input.fromDate, input.toDate)
  const dates = listCalendarDates(fromDate, toDate)
  const workspaceCalendar = input.workspaceCalendar ??
    createWorkspaceWorkItemCalendarPolicy(DEFAULT_WORKSPACE_CALENDAR_SETTINGS)
  const stateByTeamId = new Map(teamStates.map((teamState) => [teamState.teamId, teamState.state]))
  const visibilityByTeamId = new Map(input.teams.map((team) => [team.teamId, team]))
  const teamIdsByMemberId = new Map<string, string[]>()
  for (const team of input.teams) {
    for (const profile of stateByTeamId.get(team.teamId)?.profiles ?? []) {
      if (team.visibleMemberIds !== undefined && !team.visibleMemberIds.has(profile.memberId)) continue
      teamIdsByMemberId.set(profile.memberId, [...teamIdsByMemberId.get(profile.memberId) ?? [], team.teamId])
    }
  }
  const members: WorkspaceWorkloadMember[] = []
  for (const [memberId, teamIds] of teamIdsByMemberId) {
    const daily = buildMemberWorkspaceDaily(memberId, teamStates, workspaceCalendar, dates, teamIds)
    if (!daily) continue
    const cells = aggregateWorkspaceCells(
      daily,
      input.granularity,
      input.weekStartDay ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS.weekStartDay,
      (load) => {
      const team = visibilityByTeamId.get(load.teamId)
      if (!team) return false
      const { assignment } = load
      // The owning Team's member allowlist applies too, as it does in that Team's own view.
      if (team.visibleMemberIds !== undefined && !team.visibleMemberIds.has(memberId)) return false
      return (team.visibleProjectIds === undefined ||
        assignment.projectId === undefined ||
        team.visibleProjectIds.has(assignment.projectId)) &&
        (!assignment.confidential || team.canViewConfidential || assignment.memberId === input.viewerMemberId)
    })
    members.push({
      memberId,
      ...(daily.displayName ? { displayName: daily.displayName } : {}),
      ...(daily.role ? { role: daily.role } : {}),
      teamIds,
      cells,
      capacityMinutes: sum(cells, (cell) => cell.capacityMinutes),
      allocatedMinutes: sum(cells, (cell) => cell.allocatedMinutes),
      overloaded: cells.some((cell) => cell.status === 'over'),
    })
  }
  members.sort((left, right) =>
    Number(right.overloaded) - Number(left.overloaded) ||
    (left.displayName ?? left.memberId).localeCompare(right.displayName ?? right.memberId) ||
    left.memberId.localeCompare(right.memberId)
  )
  const teams: WorkspaceWorkloadTeam[] = input.teams.map((team) => ({ teamId: team.teamId, name: team.name }))
  return {
    schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    fromDate,
    toDate,
    granularity: input.granularity,
    teams,
    members,
    generatedAt,
  }
}

/**
 * Groups a member's Workspace-wide daily values into buckets with visible breakdowns.
 *
 * @param daily - The member's Workspace-wide daily values.
 * @param granularity - Output granularity.
 * @param weekStartDay - Day weekly buckets start on.
 * @param isVisible - Whether the caller may see one assignment in the breakdowns.
 * @returns Buckets in date order.
 */
function aggregateWorkspaceCells(
  daily: MemberWorkspaceDaily,
  granularity: CapacityPlanningGranularity,
  weekStartDay: WorkspaceWeekStartDay,
  isVisible: (load: WorkspaceAssignmentLoad) => boolean,
): WorkspaceWorkloadCell[] {
  const buckets = new Map<string, WorkspaceBucketTotals>()
  const bucketOf = (date: string): WorkspaceBucketTotals => {
    const range = bucketFor(date, granularity, weekStartDay)
    const current = buckets.get(range.fromDate)
    if (current) return current
    const created: WorkspaceBucketTotals = {
      fromDate: range.fromDate,
      toDate: range.toDate,
      capacityMinutes: 0,
      allocatedMinutes: 0,
      teams: new Map(),
      projects: new Map(),
    }
    buckets.set(range.fromDate, created)
    return created
  }
  for (const [date, capacityMinutes] of daily.capacityByDate) bucketOf(date).capacityMinutes += capacityMinutes
  for (const load of daily.loads) {
    const visible = isVisible(load)
    for (const [date, minutes] of load.minutesByDate) {
      const bucket = bucketOf(date)
      bucket.allocatedMinutes += minutes
      if (!visible) continue
      bucket.teams.set(load.teamId, (bucket.teams.get(load.teamId) ?? 0) + minutes)
      const projectKey = `${load.teamId}\0${load.assignment.projectId ?? ''}`
      const project = bucket.projects.get(projectKey) ?? {
        teamId: load.teamId,
        ...(load.assignment.projectId ? { projectId: load.assignment.projectId } : {}),
        allocatedMinutes: 0,
      }
      project.allocatedMinutes += minutes
      bucket.projects.set(projectKey, project)
    }
  }
  return [...buckets.values()].sort((left, right) => left.fromDate.localeCompare(right.fromDate)).map((bucket) => {
    const teams: WorkspaceWorkloadTeamShare[] = [...bucket.teams.entries()]
      .map(([teamId, allocatedMinutes]) => ({ teamId, allocatedMinutes }))
      .sort((left, right) => right.allocatedMinutes - left.allocatedMinutes || left.teamId.localeCompare(right.teamId))
    const projects = [...bucket.projects.values()]
      .sort((left, right) => right.allocatedMinutes - left.allocatedMinutes)
    return {
      fromDate: bucket.fromDate,
      toDate: bucket.toDate,
      label: bucket.fromDate,
      capacityMinutes: bucket.capacityMinutes,
      allocatedMinutes: bucket.allocatedMinutes,
      utilizationPercent: calculateUtilizationPercent(bucket.capacityMinutes, bucket.allocatedMinutes),
      varianceMinutes: bucket.capacityMinutes - bucket.allocatedMinutes,
      status: calculateCellStatus(bucket.capacityMinutes, bucket.allocatedMinutes),
      teams,
      projects,
      hiddenAllocatedMinutes: bucket.allocatedMinutes - sum(teams, (team) => team.allocatedMinutes),
    }
  })
}

/** Computes the member's available minutes for one local date. */
function calculateAvailableMinutes(profile: WorkloadMemberProfile, date: string): number {
  const schedule = profile.schedule[weekdayKey(date)]
  if (!schedule.enabled || schedule.minutes === 0) return 0
  if (readHolidayDates(profile).has(date)) return 0
  const absence = profile.timeOff
    .filter((timeOff) => timeOff.status !== 'canceled' && timeOff.fromDate <= date && timeOff.toDate >= date)
    .reduce((total, timeOff) => total + (timeOff.minutesPerDay ?? schedule.minutes), 0)
  return Math.max(0, schedule.minutes - absence)
}

/**
 * Holiday dates of each effective profile. Effective profiles are created anew for every snapshot
 * by {@link resolveEffectiveProfile}, so an entry lives only as long as that snapshot.
 */
const holidayDatesByProfile = new WeakMap<WorkloadMemberProfile, ReadonlySet<string>>()

/**
 * Reads a profile's holiday dates as a set, so inherited Workspace days off stay cheap to check.
 *
 * @param profile - Effective profile of the current snapshot; it is not changed afterwards.
 * @returns The holiday dates.
 */
function readHolidayDates(profile: WorkloadMemberProfile): ReadonlySet<string> {
  const cached = holidayDatesByProfile.get(profile)
  if (cached) return cached
  const dates = new Set(profile.holidays.map((holiday) => holiday.date))
  holidayDatesByProfile.set(profile, dates)
  return dates
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

/**
 * Returns the day, week, or month bucket containing one local date.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param granularity - Bucket size.
 * @param weekStartDay - Day a week bucket starts on.
 * @returns The first and last local dates of the bucket.
 */
function bucketFor(
  date: string,
  granularity: CapacityPlanningGranularity,
  weekStartDay: WorkspaceWeekStartDay,
): { fromDate: string; toDate: string } {
  if (granularity === 'day') return { fromDate: date, toDate: date }
  if (granularity === 'month') {
    const [year, month] = date.split('-').map(Number)
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return {
      fromDate: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`,
      toDate: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`,
    }
  }
  const week = workspaceWeekContaining(date, weekStartDay)
  return { fromDate: week.from, toDate: week.to }
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
    profiles,
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
    (value.calendarSource === undefined || isWorkloadCalendarSource(value.calendarSource)) &&
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
