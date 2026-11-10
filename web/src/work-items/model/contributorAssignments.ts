import {
  WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT,
  WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES,
  type WorkItemContributionStatus,
  type WorkItemContributorAssignment,
  type WorkItemContributorAssignmentInput,
  type WorkItemJobRoleDefinition,
} from '@mukuroji/contracts'

/** Form field that carries an open contributor draft with the Work Item editor form. */
export const CONTRIBUTOR_DRAFT_FORM_FIELD = 'contributorAssignmentsDraft'

/** Contribution statuses in the order they are offered. */
export const contributionStatuses: readonly WorkItemContributionStatus[] = ['planned', 'in-progress', 'done']

/**
 * One editable contributor row.
 */
export type ContributorDraftRow = {
  /** Stable React key for the row. */
  key: string
  /** Identifier of the stored assignment this row edits; absent for a new row. */
  assignmentId?: string
  /** Selected member ID, or an empty string while undecided. */
  memberUserId: string
  /** Selected job role ID, or an empty string for none. */
  jobRoleId: string
  /** Planned effort as typed, in hours. */
  plannedEffortHours: string
  /** Selected contribution status. */
  status: WorkItemContributionStatus
}

/**
 * Reason a contributor draft cannot be saved.
 */
export type ContributorDraftError =
  | 'invalid-draft'
  | 'missing-member-or-role'
  | 'invalid-effort'
  | 'duplicate-member'
  | 'too-many'

/**
 * Result of converting draft rows into a request list.
 */
export type ContributorDraftParseResult =
  | {
    /** Request-ready contributor list. */
    assignments: WorkItemContributorAssignmentInput[]
  }
  | {
    /** Why the draft is invalid. */
    error: ContributorDraftError
    /** Row that caused the error, when a single row is at fault. */
    rowKey?: string
  }

/**
 * Converts stored assignments into editable rows.
 *
 * @param assignments - Contributors stored on the Work Item.
 * @returns One row per assignment, keyed by its stored identifier.
 */
export function toContributorDraftRows(
  assignments: readonly WorkItemContributorAssignment[] | undefined,
): ContributorDraftRow[] {
  return (assignments ?? []).map((assignment) => ({
    key: assignment.assignmentId,
    assignmentId: assignment.assignmentId,
    memberUserId: assignment.memberUserId ?? '',
    jobRoleId: assignment.jobRoleId ?? '',
    plannedEffortHours: assignment.plannedEffortMinutes === undefined
      ? ''
      : formatPlannedEffortHours(assignment.plannedEffortMinutes),
    status: assignment.status,
  }))
}

/**
 * Creates an empty row for a new contributor.
 *
 * @param key - Unique React key for the row.
 * @returns A planned row without a member or role.
 */
export function createEmptyContributorDraftRow(key: string): ContributorDraftRow {
  return { key, memberUserId: '', jobRoleId: '', plannedEffortHours: '', status: 'planned' }
}

/**
 * Converts draft rows into a complete replacement list for the API.
 *
 * @param rows - Rows being edited.
 * @returns The request list, or the first problem found.
 */
export function parseContributorDraftRows(rows: readonly ContributorDraftRow[]): ContributorDraftParseResult {
  if (rows.length > WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT) {
    return { error: 'too-many' }
  }
  const members = new Set<string>()
  const assignments: WorkItemContributorAssignmentInput[] = []
  for (const row of rows) {
    const memberUserId = row.memberUserId.trim()
    const jobRoleId = row.jobRoleId.trim()
    if (!memberUserId && !jobRoleId) {
      return { error: 'missing-member-or-role', rowKey: row.key }
    }
    if (memberUserId) {
      if (members.has(memberUserId)) {
        return { error: 'duplicate-member', rowKey: row.key }
      }
      members.add(memberUserId)
    }
    const plannedEffortMinutes = parsePlannedEffortHours(row.plannedEffortHours)
    if (plannedEffortMinutes === null) {
      return { error: 'invalid-effort', rowKey: row.key }
    }
    assignments.push({
      ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
      ...(memberUserId ? { memberUserId } : {}),
      ...(jobRoleId ? { jobRoleId } : {}),
      ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
      status: row.status,
    })
  }
  return { assignments }
}

/**
 * Parses planned effort typed in hours.
 *
 * @param value - Text typed by the user.
 * @returns Whole minutes, undefined when blank, or null when invalid.
 */
export function parsePlannedEffortHours(value: string): number | undefined | null {
  const text = value.trim()
  if (!text) return undefined
  if (!/^\d+(\.\d{1,2})?$/u.test(text)) return null
  const minutes = Math.round(Number(text) * 60)
  return minutes <= WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES ? minutes : null
}

/**
 * Formats planned minutes as hours for display and editing.
 *
 * @param minutes - Planned effort in minutes.
 * @returns Hours with at most two decimals.
 */
export function formatPlannedEffortHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100)
}

/**
 * Lists the job roles a row may select.
 *
 * Archived roles are offered only when the row already uses them, matching the
 * server rule that archived roles cannot be newly assigned.
 *
 * @param jobRoles - Job roles from the Work Item configuration.
 * @param currentJobRoleId - Role the stored assignment already uses, if any.
 * @returns Selectable roles in configuration order.
 */
export function listSelectableJobRoles(
  jobRoles: readonly WorkItemJobRoleDefinition[],
  currentJobRoleId: string | undefined,
): WorkItemJobRoleDefinition[] {
  return jobRoles.filter((jobRole) => !jobRole.archived || jobRole.id === currentJobRoleId)
}

/**
 * Sums the planned effort of all contributors.
 *
 * @param assignments - Contributors stored on the Work Item.
 * @returns Total planned minutes; assignments without effort count as zero.
 */
export function sumContributorPlannedEffort(
  assignments: readonly WorkItemContributorAssignment[] | undefined,
): number {
  return (assignments ?? []).reduce((total, assignment) => total + (assignment.plannedEffortMinutes ?? 0), 0)
}

/**
 * Serializes draft rows for the editor form's hidden field.
 *
 * @param rows - Rows being edited.
 * @returns JSON text of the rows.
 */
export function serializeContributorDraftRows(rows: readonly ContributorDraftRow[]): string {
  return JSON.stringify(rows)
}

/**
 * Reads an open contributor draft submitted with the Work Item editor form.
 *
 * @param formData - Submitted editor form data.
 * @returns The request list or a draft error, or undefined when no draft is open.
 */
export function readContributorDraftSubmission(formData: FormData): ContributorDraftParseResult | undefined {
  const value = formData.get(CONTRIBUTOR_DRAFT_FORM_FIELD)
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { error: 'invalid-draft' }
  }
  if (!Array.isArray(parsed) || !parsed.every(isContributorDraftRow)) {
    return { error: 'invalid-draft' }
  }
  return parseContributorDraftRows(parsed)
}

/**
 * Checks the shape of one serialized draft row.
 *
 * @param value - Parsed JSON entry.
 * @returns Whether the entry is a draft row.
 */
function isContributorDraftRow(value: unknown): value is ContributorDraftRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const assignmentId: unknown = Reflect.get(value, 'assignmentId')
  const status: unknown = Reflect.get(value, 'status')
  return typeof Reflect.get(value, 'key') === 'string' &&
    (assignmentId === undefined || typeof assignmentId === 'string') &&
    typeof Reflect.get(value, 'memberUserId') === 'string' &&
    typeof Reflect.get(value, 'jobRoleId') === 'string' &&
    typeof Reflect.get(value, 'plannedEffortHours') === 'string' &&
    contributionStatuses.some((candidate) => candidate === status)
}

/**
 * Labels a member option so members who share a display name stay distinguishable.
 *
 * @param member - Workspace member offered as a contributor.
 * @returns The name with the email, or the email alone.
 */
export function formatContributorMemberLabel(member: { readonly email: string; readonly name?: string }): string {
  return member.name ? `${member.name} (${member.email})` : member.email
}
