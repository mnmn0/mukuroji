/**
 * Maximum number of contributor assignments a single Work Item can hold.
 */
export const WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT = 20

/**
 * Upper bound for one contributor's planned effort, in minutes (1,000 hours).
 */
export const WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES = 60_000

/**
 * Maximum number of job roles a Work Item configuration can define.
 */
export const WORK_ITEM_JOB_ROLE_LIMIT = 100

/**
 * Job role that contributors can be planned against before a member is chosen.
 */
export type WorkItemJobRoleDefinition = {
  /** Stable identifier stored on contributor assignments; never derived from the name. */
  id: string
  /** Display name shown to Workspace members. */
  name: string
  /** Archived roles stay readable on existing assignments but cannot be newly assigned. */
  archived?: boolean
}

/**
 * Progress of one contributor's share of a Work Item.
 */
export type WorkItemContributionStatus = 'planned' | 'in-progress' | 'done'

/**
 * One contributor's share of a Work Item.
 *
 * Contributors carry out work; the Work Item's single accountable owner remains
 * `assigneeUserId`. An assignment names a member, a job role, or both: a role-only
 * assignment plans effort before the member is decided.
 */
export type WorkItemContributorAssignment = {
  /** Stable identifier of the assignment within its Work Item. */
  assignmentId: string
  /** Workspace user ID of the contributing member, when decided. */
  memberUserId?: string
  /** Stable job role ID from the Work Item configuration. */
  jobRoleId?: string
  /** Planned effort for this contribution in minutes. */
  plannedEffortMinutes?: number
  /** Progress of this contribution. */
  status: WorkItemContributionStatus
}

/**
 * Contributor assignment submitted by a client; the server assigns `assignmentId` when omitted.
 */
export type WorkItemContributorAssignmentInput = Omit<WorkItemContributorAssignment, 'assignmentId' | 'status'> & {
  /** Identifier of an existing assignment to keep; omit for a new assignment. */
  assignmentId?: string
  /** Progress of this contribution; the server uses `planned` when omitted. */
  status?: WorkItemContributionStatus
}
