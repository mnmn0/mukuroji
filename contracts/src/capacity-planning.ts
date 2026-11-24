/** Capacity planning contract schema version. */
export const CAPACITY_PLANNING_SCHEMA_VERSION = 1 as const

/** Time bucket used by a workload snapshot. */
export type CapacityPlanningGranularity = 'day' | 'week' | 'month'

/** A day in a member's recurring working schedule. */
export type WorkingScheduleDay = {
  /** Whether the member is available on this weekday. */
  enabled: boolean
  /** Available minutes before holidays and time off are applied. */
  minutes: number
}

/** A complete Monday-first working schedule. */
export type WorkingSchedule = {
  /** Monday schedule. */
  monday: WorkingScheduleDay
  /** Tuesday schedule. */
  tuesday: WorkingScheduleDay
  /** Wednesday schedule. */
  wednesday: WorkingScheduleDay
  /** Thursday schedule. */
  thursday: WorkingScheduleDay
  /** Friday schedule. */
  friday: WorkingScheduleDay
  /** Saturday schedule. */
  saturday: WorkingScheduleDay
  /** Sunday schedule. */
  sunday: WorkingScheduleDay
}

/** A holiday that removes availability from a local calendar date. */
export type WorkloadHoliday = {
  /** Local calendar date in `YYYY-MM-DD` form. */
  date: string
  /** Optional human-readable holiday name. */
  label?: string
}

/** A member's planned absence. */
export type WorkloadTimeOff = {
  /** Stable time-off identifier. */
  id: string
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Optional daily absence in minutes; defaults to the scheduled minutes. */
  minutesPerDay?: number
  /** Optional explanation that may be hidden from non-managers. */
  reason?: string
  /**
   * Approval state. Only `approved` absences reduce available minutes; `planned` absences are
   * pending review and shown separately, and `rejected` or `canceled` absences are ignored.
   */
  status: WorkloadTimeOffStatus
  /**
   * When the absence was last submitted for approval. Rows saved before approval existed lack it;
   * a `planned` row without it is read as `approved` so their capacity does not change on deploy.
   */
  submittedAt?: string
  /** Member who last approved or rejected the absence. */
  reviewedBy?: string
  /** Timestamp of the last approval or rejection. */
  reviewedAt?: string
  /** Optimistic concurrency revision for this absence. */
  revision: number
}

/** Review state of a member's absence. */
export type WorkloadTimeOffStatus = 'planned' | 'approved' | 'rejected' | 'canceled'

/**
 * Where a member profile takes its working weekdays, days off, and time zone from.
 *
 * `workspace` inherits the Workspace calendar: the member works only on the Workspace working
 * weekdays, takes every Workspace day off (company and national holidays), and uses the Workspace
 * time zone; the profile keeps only the member's own hours, personal days off, and time off.
 * `custom` uses the profile's own time zone, schedule, and holidays alone.
 */
export type WorkloadCalendarSource = 'workspace' | 'custom'

/** Every calendar source, in the order the profile editor lists them. */
export const WORKLOAD_CALENDAR_SOURCES: readonly WorkloadCalendarSource[] = ['workspace', 'custom']

/**
 * Narrows an untrusted value to a calendar source.
 *
 * @param value - Untrusted candidate, such as a request body field or a stored record.
 * @returns Whether the value names a calendar source.
 */
export function isWorkloadCalendarSource(value: unknown): value is WorkloadCalendarSource {
  return WORKLOAD_CALENDAR_SOURCES.some((source) => source === value)
}

/** Working availability and skills for one Team member. */
export type WorkloadMemberProfile = {
  /** Contract schema version. */
  schemaVersion: typeof CAPACITY_PLANNING_SCHEMA_VERSION
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Workspace member identifier. */
  memberId: string
  /** Optional display name copied from the directory. */
  displayName?: string
  /** Optional primary role used by resource requests. */
  role?: string
  /** Skills used for request matching. */
  skills: string[]
  /**
   * Calendar the profile follows. Profiles saved before the Workspace calendar could be inherited
   * leave it out and read as `custom`.
   */
  calendarSource?: WorkloadCalendarSource
  /** IANA timezone used for schedule and time-off dates; ignored while inheriting the Workspace. */
  timeZone: string
  /**
   * Recurring local working schedule. While inheriting the Workspace, a weekday counts only when
   * the Workspace also works on it.
   */
  schedule: WorkingSchedule
  /** Local dates that are not available; personal days off on top of the Workspace's when inheriting. */
  holidays: WorkloadHoliday[]
  /** Planned absences. */
  timeOff: WorkloadTimeOff[]
  /** Optimistic concurrency revision. */
  revision: number
  /** Last update timestamp. */
  updatedAt: string
}

/** Lifecycle state of a resource request. */
export type ResourceRequestStatus = 'open' | 'partially-filled' | 'filled' | 'canceled'

/** A request for capacity from a project or delivery role. */
export type ResourceRequest = {
  /** Stable request identifier. */
  id: string
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Optional Project requesting the capacity. */
  projectId?: string
  /** Short request title. */
  title: string
  /** Optional role requested from the Team. */
  role?: string
  /** Skills required by the request. */
  skillIds: string[]
  /** Inclusive requested start date. */
  fromDate: string
  /** Inclusive requested end date. */
  toDate: string
  /** Total requested effort in minutes. */
  requestedMinutes: number
  /** Whether details are visible only to managers and assigned members. */
  confidential: boolean
  /** Current filling state. */
  status: ResourceRequestStatus
  /** Optimistic concurrency revision. */
  revision: number
  /** Creation timestamp. */
  createdAt: string
  /** Last update timestamp. */
  updatedAt: string
}

/** Lifecycle state of a resource assignment. */
export type ResourceAssignmentStatus = 'tentative' | 'confirmed' | 'canceled'

/** Capacity reserved for one member over a date range. */
export type ResourceAssignment = {
  /** Stable assignment identifier. */
  id: string
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Optional resource request fulfilled by this assignment. */
  requestId?: string
  /** Optional Project receiving the allocation. */
  projectId?: string
  /** Optional canonical Work Item receiving the planned effort. */
  workItemId?: string
  /** Optional Cycle associated with the planned Work Item. */
  cycleId?: string
  /** Optional recurring-work definition associated with the planned Work Item. */
  recurringWorkId?: string
  /** Assigned Workspace member. */
  memberId: string
  /** Optional role used for matching and display. */
  role?: string
  /** Skills represented by this assignment. */
  skillIds: string[]
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Capacity reserved by this assignment in minutes. */
  allocationMinutes: number
  /** Planned Work Item effort in minutes. */
  plannedEffortMinutes: number
  /** Whether the assignment is confidential. */
  confidential: boolean
  /** Assignment lifecycle state. */
  status: ResourceAssignmentStatus
  /** Optimistic concurrency revision. */
  revision: number
  /** Creation timestamp. */
  createdAt: string
  /** Last update timestamp. */
  updatedAt: string
}

/** Availability and demand for one local calendar bucket. */
export type WorkloadCell = {
  /** Inclusive bucket start date in the member's local calendar. */
  fromDate: string
  /** Inclusive bucket end date in the member's local calendar. */
  toDate: string
  /** Stable localized display label source date. */
  label: string
  /** Available minutes after schedule, holiday, and approved time-off rules. */
  capacityMinutes: number
  /** Time off still waiting for approval; it is not subtracted from `capacityMinutes`. */
  pendingTimeOffMinutes: number
  /** Minutes reserved by visible assignments. */
  allocatedMinutes: number
  /** Part of `allocatedMinutes` reserved by tentative (not yet confirmed) assignments. */
  tentativeAllocatedMinutes: number
  /** Planned Work Item effort in the bucket. */
  plannedEffortMinutes: number
  /** Actual submitted, approved, or locked time in the bucket. */
  actualMinutes: number
  /** Estimated effort still remaining after actual time. */
  remainingEffortMinutes: number
  /** Allocation divided by capacity, expressed as a percentage. */
  utilizationPercent: number
  /** Capacity minus allocation; negative values are overload. */
  varianceMinutes: number
  /** Under, balanced, over, or unavailable. */
  status: WorkloadCellStatus
  /**
   * The member's Workspace-wide capacity in the bucket: on each day, the smallest capacity any of
   * the member's Team profiles gives, so time off saved in one Team counts everywhere. Older
   * servers leave it out.
   */
  workspaceCapacityMinutes?: number
  /**
   * Minutes reserved for the member by every active assignment in every Team, including
   * assignments the viewer cannot see. Older servers leave it out.
   */
  workspaceAllocatedMinutes?: number
  /** Status of the Workspace-wide totals; `over` when all Teams together overload the member. */
  workspaceStatus?: WorkloadCellStatus
}

/** How a bucket's allocation compares with its capacity. */
export type WorkloadCellStatus = 'under' | 'balanced' | 'over' | 'unavailable'

/** Aggregated workload for one visible member. */
export type WorkloadMemberSummary = {
  /** Workspace member identifier. */
  memberId: string
  /** Optional display name. */
  displayName?: string
  /** Optional primary role used by resource matching. */
  role?: string
  /** Skills used by resource matching. */
  skills: string[]
  /** Calendar the stored profile follows; older servers leave it out, which reads as `custom`. */
  calendarSource?: WorkloadCalendarSource
  /** Time zone stored on the profile; the Workspace time zone applies while inheriting it. */
  timeZone: string
  /**
   * Time zone the cells are counted in: the Workspace time zone while inheriting it, otherwise
   * {@link timeZone}. Older servers leave it out.
   */
  effectiveTimeZone?: string
  /** Recurring local working schedule. */
  schedule: WorkingSchedule
  /** Local dates that are not available. */
  holidays: WorkloadHoliday[]
  /** Revision of the persisted availability profile used by mutations. */
  profileRevision: number
  /**
   * Planned, approved, and rejected absences that end on or after the snapshot start, ordered by
   * start date. The reason is omitted unless the viewer is the member or may see confidential rows.
   */
  timeOff: WorkloadTimeOff[]
  /** Daily, weekly, or monthly cells. */
  cells: WorkloadCell[]
  /** Total capacity across the selected range. */
  capacityMinutes: number
  /** Total visible allocation across the selected range. */
  allocatedMinutes: number
  /** Total planned effort across the selected range. */
  plannedEffortMinutes: number
  /** Total actual time across the selected range. */
  actualMinutes: number
  /** Total remaining effort across the selected range. */
  remainingEffortMinutes: number
  /** Whether any bucket is over capacity. */
  overloaded: boolean
  /** Whether any bucket is over capacity once every Team's assignments count. Older servers leave it out. */
  workspaceOverloaded?: boolean
}

/** A workload snapshot with all visibility filtering already applied. */
/**
 * A Work Item contributor share counted in a member's workload.
 *
 * Read from the Work Item, never stored by capacity planning: the share's planned effort is
 * reserved on the member over the Work Item's schedule. A share is left out when the member
 * already has a resource assignment for the same Work Item, so the same work is not counted twice.
 */
export type WorkloadContributorShare = {
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Contributor assignment ID within the Work Item. */
  assignmentId: string
  /** Contributing member. */
  memberId: string
  /** Project of the Work Item, when assigned. */
  projectId?: string
  /** Inclusive local start date: the schedule's start, or its due date. */
  fromDate: string
  /** Inclusive local end date: the schedule's end, or its due date. */
  toDate: string
  /** Planned effort of the share in minutes, also reserved as allocation. */
  plannedEffortMinutes: number
}

export type WorkloadSnapshot = {
  /** Contract schema version. */
  schemaVersion: typeof CAPACITY_PLANNING_SCHEMA_VERSION
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Inclusive selected range start. */
  fromDate: string
  /** Inclusive selected range end. */
  toDate: string
  /** Requested aggregation granularity. */
  granularity: CapacityPlanningGranularity
  /** Visible member rows. */
  members: WorkloadMemberSummary[]
  /** Visible resource requests. */
  requests: ResourceRequest[]
  /** Visible assignments. */
  assignments: ResourceAssignment[]
  /**
   * Work Item contributor shares counted in the member rows besides `assignments`; absent from
   * servers that predate contributor workload.
   */
  contributorShares?: WorkloadContributorShare[]
  /**
   * True when the cells leave out the Workspace-wide totals because another Team has too many
   * Work Items to read its contributor shares; absent otherwise.
   */
  workspaceTotalsUnavailable?: boolean
  /** Number of assignments hidden by confidential visibility. */
  redactedAssignmentCount: number
  /** Number of requests hidden by confidential visibility. */
  redactedRequestCount: number
  /** Team-level optimistic concurrency revision. */
  revision: number
  /** Snapshot creation timestamp. */
  generatedAt: string
  /** What the viewer may do with this snapshot, when the API knows the viewer. */
  viewer?: WorkloadSnapshotViewer
}

/** The caller of a workload snapshot and the review actions they may take. */
export type WorkloadSnapshotViewer = {
  /** The viewer's Workspace member identifier. */
  memberId: string
  /** Whether the viewer is a Team manager who may approve time off and confirm assignments. */
  canManage: boolean
}

/** Input for saving a member's working availability. */
export type SaveWorkloadMemberProfileInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Member identifier. */
  memberId: string
  /** Optional display name. */
  displayName?: string
  /** Optional primary role. */
  role?: string
  /** Skills used for matching. */
  skills: string[]
  /**
   * Calendar the profile follows. When omitted, as clients from before inheritance send it, the
   * profile keeps its current calendar, and a new profile keeps its own (`custom`).
   */
  calendarSource?: WorkloadCalendarSource
  /** IANA timezone. */
  timeZone: string
  /** Recurring schedule. */
  schedule: WorkingSchedule
  /** Holidays to replace on the profile. */
  holidays: WorkloadHoliday[]
  /** Expected profile revision, or zero for a new profile. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Input for creating or updating a planned absence. */
export type SaveWorkloadTimeOffInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Member whose availability changes. */
  memberId: string
  /** Time-off identifier, or a new identifier for creation. */
  id: string
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Optional daily absence in minutes. */
  minutesPerDay?: number
  /** Optional reason. */
  reason?: string
  /** Approval state. */
  status: WorkloadTimeOffStatus
  /** Expected profile revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Input for approving, rejecting, reopening, or canceling one absence without changing its dates. */
export type ReviewWorkloadTimeOffInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Member whose absence is reviewed. */
  memberId: string
  /** Time-off identifier. */
  timeOffId: string
  /** New review state. */
  status: WorkloadTimeOffStatus
  /** Expected revision of the absence itself. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the review. */
  actorMemberId: string
}

/** Input for creating a resource request. */
export type CreateResourceRequestInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional Project requesting capacity. */
  projectId?: string
  /** Request title. */
  title: string
  /** Optional requested role. */
  role?: string
  /** Required skills. */
  skillIds: string[]
  /** Inclusive requested start date. */
  fromDate: string
  /** Inclusive requested end date. */
  toDate: string
  /** Total requested effort. */
  requestedMinutes: number
  /** Confidential visibility flag. */
  confidential: boolean
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Input for changing or canceling an existing resource request. */
export type UpdateResourceRequestInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Request identifier. */
  requestId: string
  /** New request title. */
  title?: string
  /** New requested role; an empty string clears the role. */
  role?: string
  /** New required skills. */
  skillIds?: string[]
  /** New inclusive requested start date. */
  fromDate?: string
  /** New inclusive requested end date. */
  toDate?: string
  /** New total requested effort in minutes. */
  requestedMinutes?: number
  /** New confidential visibility flag. */
  confidential?: boolean
  /** Set to `canceled` to withdraw the request; fill states are derived from assignments. */
  status?: Extract<ResourceRequestStatus, 'canceled'>
  /** With `status: "canceled"`, also cancel every assignment that still fills the request. */
  cancelAssignments?: boolean
  /** Expected request revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Input for creating a resource assignment. */
export type CreateResourceAssignmentInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional request being fulfilled. */
  requestId?: string
  /** Optional Project receiving the capacity. */
  projectId?: string
  /** Optional Work Item receiving planned effort. */
  workItemId?: string
  /** Optional Cycle associated with the planned Work Item. */
  cycleId?: string
  /** Optional recurring-work definition associated with the planned Work Item. */
  recurringWorkId?: string
  /** Assigned member. */
  memberId: string
  /** Optional role. */
  role?: string
  /** Skills represented by the assignment. */
  skillIds: string[]
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
  /** Capacity reserved in minutes. */
  allocationMinutes: number
  /** Planned Work Item effort in minutes. */
  plannedEffortMinutes: number
  /** Confidential visibility flag. */
  confidential: boolean
  /** Assignment lifecycle state. */
  status: ResourceAssignmentStatus
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Input for moving or reassigning an existing assignment. */
export type UpdateResourceAssignmentInput = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Assignment identifier. */
  assignmentId: string
  /** New assigned member. */
  memberId?: string
  /** New inclusive local start date. */
  fromDate?: string
  /** New inclusive local end date. */
  toDate?: string
  /** New reserved capacity in minutes. */
  allocationMinutes?: number
  /** New planned effort in minutes. */
  plannedEffortMinutes?: number
  /** New lifecycle state. */
  status?: ResourceAssignmentStatus
  /** Expected assignment revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
  actorMemberId: string
}

/** Minutes one visible Team reserves for a member in a Workspace workload bucket. */
export type WorkspaceWorkloadTeamShare = {
  /** Team whose assignments reserve the minutes. */
  teamId: string
  /** Minutes reserved by the viewer-visible assignments of that Team. */
  allocatedMinutes: number
}

/** Minutes one visible Project (or Team-wide work) reserves for a member in a bucket. */
export type WorkspaceWorkloadProjectShare = {
  /** Team that owns the assignments. */
  teamId: string
  /** Project receiving the allocation; absent for Team-wide assignments without a Project. */
  projectId?: string
  /** Minutes reserved by the viewer-visible assignments of that Project. */
  allocatedMinutes: number
}

/** One member's Workspace-wide availability and demand for one bucket. */
export type WorkspaceWorkloadCell = {
  /** Inclusive bucket start date. */
  fromDate: string
  /** Inclusive bucket end date. */
  toDate: string
  /** Stable display label source date. */
  label: string
  /** Workspace-wide capacity: per day the smallest capacity of the member's Team profiles. */
  capacityMinutes: number
  /** Minutes reserved by every active assignment in every Team, visible to the viewer or not. */
  allocatedMinutes: number
  /** Allocation divided by capacity, expressed as a percentage. */
  utilizationPercent: number
  /** Capacity minus allocation; negative values are overload. */
  varianceMinutes: number
  /** Under, balanced, over, or unavailable. */
  status: WorkloadCellStatus
  /** Allocation per viewer-visible Team, largest first. */
  teams: WorkspaceWorkloadTeamShare[]
  /** Allocation per viewer-visible Project, largest first. */
  projects: WorkspaceWorkloadProjectShare[]
  /**
   * Allocation the viewer may not see in detail: confidential assignments, Projects the viewer
   * cannot read, and Teams the viewer cannot view. Counted in {@link allocatedMinutes} only.
   */
  hiddenAllocatedMinutes: number
}

/** One member's Workspace-wide workload row. */
export type WorkspaceWorkloadMember = {
  /** Workspace member identifier. */
  memberId: string
  /** Display name from one of the member's Team profiles. */
  displayName?: string
  /** Role from one of the member's Team profiles. */
  role?: string
  /** Viewer-visible Teams in which the member has a workload profile. */
  teamIds: string[]
  /** Buckets at the requested granularity. */
  cells: WorkspaceWorkloadCell[]
  /** Total Workspace-wide capacity across the range. */
  capacityMinutes: number
  /** Total allocation across every Team in the range. */
  allocatedMinutes: number
  /** Whether any bucket is over capacity. */
  overloaded: boolean
}

/** A Team included in a Workspace workload read. */
export type WorkspaceWorkloadTeam = {
  /** Team identifier. */
  teamId: string
  /** Team display name. */
  name: string
}

/** Workspace-wide workload of every member the viewer may see, across Teams. */
export type WorkspaceWorkloadSnapshot = {
  /** Contract schema version. */
  schemaVersion: typeof CAPACITY_PLANNING_SCHEMA_VERSION
  /** Workspace identifier. */
  workspaceId: string
  /** Inclusive selected range start. */
  fromDate: string
  /** Inclusive selected range end. */
  toDate: string
  /** Output granularity. */
  granularity: CapacityPlanningGranularity
  /** Teams the viewer may view, in directory order. */
  teams: WorkspaceWorkloadTeam[]
  /** Members visible in at least one of those Teams, overloaded first, then by name. */
  members: WorkspaceWorkloadMember[]
  /** Generation timestamp. */
  generatedAt: string
}
