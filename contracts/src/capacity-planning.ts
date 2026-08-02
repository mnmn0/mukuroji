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
  /** Approval state used by capacity calculations. */
  status: 'planned' | 'approved' | 'canceled'
  /** Optimistic concurrency revision for this absence. */
  revision: number
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
  /** IANA timezone used for schedule and time-off dates. */
  timeZone: string
  /** Recurring local working schedule. */
  schedule: WorkingSchedule
  /** Local dates that are not available. */
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
  /** Available minutes after schedule, holiday, and time-off rules. */
  capacityMinutes: number
  /** Minutes reserved by visible assignments. */
  allocatedMinutes: number
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
  status: 'under' | 'balanced' | 'over' | 'unavailable'
}

/** Aggregated workload for one visible member. */
export type WorkloadMemberSummary = {
  /** Workspace member identifier. */
  memberId: string
  /** Optional display name. */
  displayName?: string
  /** Member's schedule timezone. */
  timeZone: string
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
}

/** A workload snapshot with all visibility filtering already applied. */
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
  /** Number of assignments hidden by confidential visibility. */
  redactedAssignmentCount: number
  /** Number of requests hidden by confidential visibility. */
  redactedRequestCount: number
  /** Team-level optimistic concurrency revision. */
  revision: number
  /** Snapshot creation timestamp. */
  generatedAt: string
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
  status: WorkloadTimeOff['status']
  /** Expected profile revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
  /** Actor performing the mutation. */
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
