import {
  WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT,
  WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES,
  type WorkItemContributionStatus,
  type WorkItemContributorAssignment,
  type WorkItemJobRoleDefinition,
} from '@mukuroji/contracts'

/** Fields a client may send for one contributor assignment. */
const CONTRIBUTOR_ASSIGNMENT_FIELDS = new Set([
  'assignmentId',
  'memberUserId',
  'jobRoleId',
  'plannedEffortMinutes',
  'status',
])

/** Shape of server-generated assignment identifiers. */
const ASSIGNMENT_ID_PATTERN = /^[0-9a-f]{32}$/u

/** Contribution statuses accepted on input and in storage. */
const CONTRIBUTION_STATUSES: readonly WorkItemContributionStatus[] = ['planned', 'in-progress', 'done']

/**
 * Rejected contributor assignment input.
 */
export class WorkItemContributorAssignmentError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'InvalidContributorAssignments'

  /**
   * Creates the error with a client-facing message.
   *
   * @param message - Explanation of the rejected input.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkItemContributorAssignmentError'
  }
}

/**
 * Context needed to validate a replacement contributor list.
 */
export type ContributorAssignmentNormalizationContext = {
  /** Job roles defined by the Work Item's resolved configuration. */
  readonly jobRoles: readonly WorkItemJobRoleDefinition[]
  /** Assignments currently stored on the Work Item; empty for a new Work Item. */
  readonly existing: readonly WorkItemContributorAssignment[]
  /** Creates an identifier for a new assignment. */
  readonly createAssignmentId: () => string
}

/**
 * Validates and normalizes a complete replacement list of contributor assignments.
 *
 * Existing assignments are matched by `assignmentId`, so clients cannot invent
 * identifiers. Archived job roles stay valid on assignments that already use them
 * but cannot be newly assigned. A member may appear at most once.
 *
 * @param value - Untrusted `contributorAssignments` request value.
 * @param context - Job roles, current assignments, and the identifier factory.
 * @returns Normalized assignments in request order.
 * @throws WorkItemContributorAssignmentError when the list is invalid.
 */
export function normalizeContributorAssignments(
  value: unknown,
  context: ContributorAssignmentNormalizationContext,
): WorkItemContributorAssignment[] {
  if (!Array.isArray(value)) {
    throw new WorkItemContributorAssignmentError('Contributor assignments must be an array.')
  }
  if (value.length > WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT) {
    throw new WorkItemContributorAssignmentError(
      `A Work Item can have at most ${WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT} contributor assignments.`,
    )
  }
  const existingById = new Map(context.existing.map((assignment) => [assignment.assignmentId, assignment]))
  const jobRolesById = new Map(context.jobRoles.map((jobRole) => [jobRole.id, jobRole]))
  const seenAssignmentIds = new Set<string>()
  const seenMembers = new Set<string>()

  return value.map((candidate): WorkItemContributorAssignment => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new WorkItemContributorAssignmentError('Each contributor assignment must be an object.')
    }
    const unknownField = Object.keys(candidate).find((key) => !CONTRIBUTOR_ASSIGNMENT_FIELDS.has(key))
    if (unknownField !== undefined) {
      throw new WorkItemContributorAssignmentError(`Unsupported contributor assignment field: ${unknownField}.`)
    }

    const requestedId: unknown = Reflect.get(candidate, 'assignmentId')
    const previous = requestedId === undefined ? undefined : readExistingAssignment(requestedId, existingById)
    const assignmentId = previous?.assignmentId ?? context.createAssignmentId()
    if (seenAssignmentIds.has(assignmentId)) {
      throw new WorkItemContributorAssignmentError('Each contributor assignment can appear only once.')
    }
    seenAssignmentIds.add(assignmentId)

    const memberUserId = readOptionalMemberUserId(Reflect.get(candidate, 'memberUserId'))
    const jobRoleId = readOptionalJobRoleId(Reflect.get(candidate, 'jobRoleId'), jobRolesById, previous)
    if (memberUserId === undefined && jobRoleId === undefined) {
      throw new WorkItemContributorAssignmentError('A contributor assignment needs a member, a job role, or both.')
    }
    if (memberUserId !== undefined) {
      if (seenMembers.has(memberUserId)) {
        throw new WorkItemContributorAssignmentError('A member can be a contributor only once per Work Item.')
      }
      seenMembers.add(memberUserId)
    }
    const plannedEffortMinutes = readOptionalPlannedEffort(Reflect.get(candidate, 'plannedEffortMinutes'))

    return {
      assignmentId,
      ...(memberUserId === undefined ? {} : { memberUserId }),
      ...(jobRoleId === undefined ? {} : { jobRoleId }),
      ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
      status: readContributionStatus(Reflect.get(candidate, 'status')),
    }
  })
}

/**
 * Lists members who become contributors through a replacement list.
 *
 * @param next - Normalized replacement assignments.
 * @param existing - Assignments stored before the change.
 * @returns Member IDs that were not contributors before, in list order.
 */
export function listAddedContributorMembers(
  next: readonly WorkItemContributorAssignment[],
  existing: readonly WorkItemContributorAssignment[],
): string[] {
  const previousMembers = new Set(existing.flatMap((assignment) =>
    assignment.memberUserId === undefined ? [] : [assignment.memberUserId]))
  return next.flatMap((assignment) =>
    assignment.memberUserId !== undefined && !previousMembers.has(assignment.memberUserId)
      ? [assignment.memberUserId]
      : [])
}

/**
 * Checks whether a stored value is a valid contributor assignment list.
 *
 * Stored rows are validated without the configuration, because job roles may have
 * been removed after the assignment was saved. Assignment IDs and member IDs must be
 * unique, as the request normalizer guarantees.
 *
 * @param value - Stored attribute value.
 * @returns Whether the value is a well-formed assignment list.
 */
export function isStoredContributorAssignmentList(value: unknown): value is WorkItemContributorAssignment[] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT || !value.every(isStoredContributorAssignment)) {
    return false
  }
  const assignmentIds = new Set(value.map((assignment) => assignment.assignmentId))
  const members = value.flatMap((assignment) =>
    assignment.memberUserId === undefined ? [] : [assignment.memberUserId.toLowerCase()])
  return assignmentIds.size === value.length && new Set(members).size === members.length
}

/**
 * Checks one stored contributor assignment.
 *
 * @param value - Stored list entry.
 * @returns Whether the entry is well formed.
 */
function isStoredContributorAssignment(value: unknown): value is WorkItemContributorAssignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const assignmentId: unknown = Reflect.get(value, 'assignmentId')
  const memberUserId: unknown = Reflect.get(value, 'memberUserId')
  const jobRoleId: unknown = Reflect.get(value, 'jobRoleId')
  const plannedEffortMinutes: unknown = Reflect.get(value, 'plannedEffortMinutes')
  const status: unknown = Reflect.get(value, 'status')
  return typeof assignmentId === 'string' &&
    ASSIGNMENT_ID_PATTERN.test(assignmentId) &&
    (memberUserId === undefined || (typeof memberUserId === 'string' && memberUserId.length > 0)) &&
    (jobRoleId === undefined || (typeof jobRoleId === 'string' && jobRoleId.length > 0)) &&
    (memberUserId !== undefined || jobRoleId !== undefined) &&
    (plannedEffortMinutes === undefined || isPlannedEffort(plannedEffortMinutes)) &&
    CONTRIBUTION_STATUSES.some((candidate) => candidate === status)
}

/**
 * Resolves a client-supplied assignment identifier against the stored assignments.
 *
 * @param value - Untrusted identifier.
 * @param existingById - Stored assignments by identifier.
 * @returns The stored assignment the identifier refers to.
 */
function readExistingAssignment(
  value: unknown,
  existingById: ReadonlyMap<string, WorkItemContributorAssignment>,
): WorkItemContributorAssignment {
  const existing = typeof value === 'string' ? existingById.get(value) : undefined
  if (!existing) {
    throw new WorkItemContributorAssignmentError('Contributor assignment ID does not match an existing assignment.')
  }
  return existing
}

/**
 * Reads an optional member identifier and normalizes it like Workspace user IDs.
 *
 * @param value - Untrusted member identifier.
 * @returns The trimmed lowercase identifier, or undefined when absent.
 */
function readOptionalMemberUserId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new WorkItemContributorAssignmentError('Contributor member ID is invalid.')
  }
  return value.trim().toLowerCase()
}

/**
 * Reads an optional job role identifier and checks it against the configuration.
 *
 * @param value - Untrusted job role identifier.
 * @param jobRolesById - Configured job roles.
 * @param previous - Stored assignment being kept, if any.
 * @returns The job role ID, or undefined when absent.
 */
function readOptionalJobRoleId(
  value: unknown,
  jobRolesById: ReadonlyMap<string, WorkItemJobRoleDefinition>,
  previous: WorkItemContributorAssignment | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkItemContributorAssignmentError('Contributor job role ID is invalid.')
  }
  const jobRoleId = value.trim()
  // A kept assignment may retain a role that was archived or removed after it was saved.
  if (previous?.jobRoleId === jobRoleId) return jobRoleId
  const jobRole = jobRolesById.get(jobRoleId)
  if (!jobRole) {
    throw new WorkItemContributorAssignmentError(`Job role "${jobRoleId}" is not defined for this Work Item.`)
  }
  if (jobRole.archived) {
    throw new WorkItemContributorAssignmentError(`Job role "${jobRoleId}" is archived.`)
  }
  return jobRoleId
}

/**
 * Reads optional planned effort in whole minutes.
 *
 * @param value - Untrusted planned effort.
 * @returns Planned minutes, or undefined when absent.
 */
function readOptionalPlannedEffort(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlannedEffort(value)) {
    throw new WorkItemContributorAssignmentError(
      `Planned effort must be whole minutes between 0 and ${WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES}.`,
    )
  }
  return value
}

/**
 * Checks a planned effort value.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a whole number of minutes within range.
 */
function isPlannedEffort(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES
}

/**
 * Reads the contribution status, defaulting new input to `planned`.
 *
 * @param value - Untrusted status.
 * @returns A supported contribution status.
 */
function readContributionStatus(value: unknown): WorkItemContributionStatus {
  if (value === undefined) return 'planned'
  const status = CONTRIBUTION_STATUSES.find((candidate) => candidate === value)
  if (!status) {
    throw new WorkItemContributorAssignmentError('Contribution status must be planned, in-progress, or done.')
  }
  return status
}
