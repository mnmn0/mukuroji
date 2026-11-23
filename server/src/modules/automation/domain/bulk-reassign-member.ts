import {
  WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES,
  type AutomationValue,
  type BulkReassignMemberAction,
  type WorkItemContributorAssignment,
  type WorkItemContributorAssignmentInput,
} from '@mukuroji/contracts'
import { AutomationError } from './automation-error'

/** Owner and contributor fields of a Work Item that a member handover reads. */
export type BulkReassignMemberWorkItem = {
  /** Accountable owner. */
  assigneeUserId: string
  /** Stored contributor shares. */
  contributorAssignments?: readonly WorkItemContributorAssignment[]
}

/** Update fields produced by a member handover. */
export type BulkReassignMemberPatch = {
  /** New owner, present only when the owner moves. */
  assigneeUserId?: string
  /** Replacement contributor list, present only when a share moves. */
  contributorAssignments?: WorkItemContributorAssignmentInput[]
}

/**
 * Builds the owner and contributor changes that hand a member's open work to another member.
 *
 * The owner moves when it is the source member. Each contributor share of the source member that
 * is not `done` moves to the target member; when the target member already contributes, the
 * moved share is merged into theirs (planned effort added, capped at the contributor limit) so
 * the same person never holds two shares. A `done` share stays as the record of who did it.
 *
 * @param workItem - Current Work Item.
 * @param action - Normalized reassignment action.
 * @returns The update fields to apply.
 * @throws AutomationError when the source member holds nothing open on the Work Item.
 */
export function createBulkReassignMemberPatch(
  workItem: BulkReassignMemberWorkItem,
  action: Pick<BulkReassignMemberAction, 'fromMemberUserId' | 'toMemberUserId'>,
): BulkReassignMemberPatch {
  const from = action.fromMemberUserId
  const to = action.toMemberUserId
  const movesOwner = workItem.assigneeUserId.trim().toLowerCase() === from
  const current = workItem.contributorAssignments ?? []
  const moving = current.filter((assignment) => isOpenShareOf(assignment, from))
  if (!movesOwner && moving.length === 0) {
    throw new AutomationError(
      'conflict',
      'BulkReassignMemberNotInvolved',
      'The member no longer owns or contributes to this Work Item.',
    )
  }
  if (moving.length === 0) return { assigneeUserId: to }
  const target = current.find((assignment) => assignment.memberUserId === to)
  const contributorAssignments: WorkItemContributorAssignmentInput[] = []
  for (const assignment of current) {
    if (isOpenShareOf(assignment, from)) {
      if (target === undefined) contributorAssignments.push({ ...assignment, memberUserId: to })
      continue
    }
    if (target !== undefined && assignment.assignmentId === target.assignmentId) {
      const movedEffort = moving.reduce((total, share) => total + (share.plannedEffortMinutes ?? 0), 0)
      const plannedEffortMinutes = Math.min(
        (assignment.plannedEffortMinutes ?? 0) + movedEffort,
        WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES,
      )
      contributorAssignments.push({
        ...assignment,
        ...(assignment.plannedEffortMinutes === undefined && movedEffort === 0 ? {} : { plannedEffortMinutes }),
        // Taking over unfinished work reopens a share its holder had already finished.
        ...(assignment.status === 'done' ? { status: 'in-progress' } : {}),
      })
      continue
    }
    contributorAssignments.push({ ...assignment })
  }
  return {
    ...(movesOwner ? { assigneeUserId: to } : {}),
    contributorAssignments,
  }
}

/**
 * Tells whether a member handover has already taken effect on a Work Item.
 *
 * @param workItem - Current Work Item.
 * @param action - Normalized reassignment action.
 * @returns True when the source member neither owns the Work Item nor holds an open share.
 */
export function isBulkReassignMemberApplied(
  workItem: BulkReassignMemberWorkItem,
  action: Pick<BulkReassignMemberAction, 'fromMemberUserId'>,
): boolean {
  return workItem.assigneeUserId.trim().toLowerCase() !== action.fromMemberUserId &&
    !(workItem.contributorAssignments ?? []).some((assignment) =>
      isOpenShareOf(assignment, action.fromMemberUserId))
}

/**
 * Builds the Bulk undo payload that restores a Work Item's owner and contributors.
 *
 * @param workItem - Work Item before the handover.
 * @returns The owner and contributors as Automation values.
 */
export function createBulkReassignMemberUndoPayload(
  workItem: BulkReassignMemberWorkItem,
): Record<string, AutomationValue> {
  return {
    assigneeUserId: workItem.assigneeUserId,
    contributorAssignments: (workItem.contributorAssignments ?? []).map(toAutomationContributorAssignment),
  }
}

/**
 * Lists the shares a handover's undo brings back under an assignment ID the Work Item no longer has.
 *
 * A handover that merged a share into the target member's removed that share. Its undo restores
 * the share with its original assignment ID, so the restored share keeps what it was allowed to
 * hold (such as a job role archived since) instead of being validated as a new share. The caller
 * treats these shares as existing ones and checks their members as newly assigned.
 *
 * @param restoredShares - Contributors in the stored undo payload, already validated as a stored list.
 * @param workItem - Current Work Item.
 * @returns The restored shares whose assignment IDs are not on the Work Item now.
 */
export function listBulkReassignMemberRemovedShares(
  restoredShares: readonly WorkItemContributorAssignment[],
  workItem: Pick<BulkReassignMemberWorkItem, 'contributorAssignments'>,
): WorkItemContributorAssignment[] {
  const currentIds = new Set((workItem.contributorAssignments ?? []).map((assignment) => assignment.assignmentId))
  return restoredShares.filter((assignment) => !currentIds.has(assignment.assignmentId))
}

/**
 * Tells whether a handover's undo has already been applied to a Work Item.
 *
 * Contributors are compared by their values in order rather than by assignment ID, so a
 * restored share is recognized however the write stored it.
 *
 * @param workItem - Current Work Item.
 * @param payload - Stored Bulk undo payload.
 * @returns True when the owner and contributors match the payload.
 */
export function isBulkReassignMemberUndoApplied(
  workItem: BulkReassignMemberWorkItem,
  payload: Record<string, AutomationValue>,
): boolean {
  if (typeof payload.assigneeUserId === 'string' &&
    workItem.assigneeUserId.trim().toLowerCase() !== payload.assigneeUserId.trim().toLowerCase()) return false
  const expected = payload.contributorAssignments
  if (!Array.isArray(expected)) return true
  const current = workItem.contributorAssignments ?? []
  return expected.length === current.length && expected.every((assignment, index) => {
    const stored = current[index]
    if (!isAutomationRecord(assignment) || stored === undefined) return false
    return assignment.memberUserId === stored.memberUserId &&
      assignment.jobRoleId === stored.jobRoleId &&
      assignment.plannedEffortMinutes === stored.plannedEffortMinutes &&
      assignment.status === stored.status
  })
}

/**
 * Tells whether a contributor share is an unfinished share of a member.
 *
 * @param assignment - Contributor share.
 * @param memberUserId - Normalized member key.
 * @returns True when the share belongs to the member and is not `done`.
 */
function isOpenShareOf(assignment: WorkItemContributorAssignment, memberUserId: string): boolean {
  return assignment.memberUserId === memberUserId && assignment.status !== 'done'
}

/**
 * Converts a stored contributor assignment into an Automation value for a Bulk undo payload.
 *
 * @param assignment - Stored contributor assignment.
 * @returns The same fields as a plain Automation record.
 */
function toAutomationContributorAssignment(assignment: WorkItemContributorAssignment): Record<string, AutomationValue> {
  return {
    assignmentId: assignment.assignmentId,
    status: assignment.status,
    ...(assignment.memberUserId === undefined ? {} : { memberUserId: assignment.memberUserId }),
    ...(assignment.jobRoleId === undefined ? {} : { jobRoleId: assignment.jobRoleId }),
    ...(assignment.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: assignment.plannedEffortMinutes }),
  }
}

/**
 * Narrows an Automation value to a record.
 *
 * @param value - Automation value.
 * @returns True when the value is a plain object.
 */
function isAutomationRecord(value: AutomationValue): value is { [key: string]: AutomationValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
