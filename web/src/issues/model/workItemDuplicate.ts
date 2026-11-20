import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  deriveWorkItemScheduleDueDate,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type WorkItemContributorAssignmentCreateInput,
  type WorkItemPriority,
} from '@mukuroji/contracts'
import type { TeamIssue } from '../api'

/**
 * Editable values that the create panel starts from when a member duplicates a Work Item.
 *
 * History, comments, relations, approvals, and Agent Runs stay with the source Work Item.
 */
export type WorkItemDuplicateDraft = {
  /** Work Item the draft was copied from; it keys the panel so a new source resets the form. */
  sourceWorkItemId: string
  /** Title copied from the source. */
  title: string
  /** Description copied from the source. */
  description: string
  /** Work Item Type copied from the source; legacy rows without one use the built-in type. */
  workItemTypeId: string
  /** Project the source is assigned to; absent for a Team-owned Work Item. */
  assignedProjectId?: string
  /** Accountable owner copied from the source. */
  assigneeUserId: string
  /** Priority copied from the source. */
  priority: WorkItemPriority
  /** Local `YYYY-MM-DD` deadline or end date of the source; empty when it is unscheduled. */
  dueDate: string
  /** Custom field values copied from the source. */
  customFieldValues: Readonly<Record<string, CustomFieldValue>>
  /** Contributor plan copied from the source, reset to `planned` as new assignments. */
  contributorAssignments: WorkItemContributorAssignmentCreateInput[]
}

/**
 * Builds the create-panel draft for duplicating one Work Item.
 *
 * Contributor assignments keep the member, job role, and planned effort, but drop their IDs and
 * progress so the copy starts as a new plan.
 *
 * @param issue - Source Work Item.
 * @returns Draft values for the create panel.
 */
export function createWorkItemDuplicateDraft(issue: TeamIssue): WorkItemDuplicateDraft {
  return {
    sourceWorkItemId: issue.id,
    title: issue.title,
    description: issue.description ?? '',
    workItemTypeId: issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
    ...(issue.assignedProjectId ? { assignedProjectId: issue.assignedProjectId } : {}),
    assigneeUserId: issue.assigneeUserId,
    priority: issue.priority,
    dueDate: deriveWorkItemScheduleDueDate(issue.schedule),
    customFieldValues: { ...issue.customFieldValues },
    contributorAssignments: (issue.contributorAssignments ?? []).map((assignment) => ({
      ...(assignment.memberUserId ? { memberUserId: assignment.memberUserId } : {}),
      ...(assignment.jobRoleId ? { jobRoleId: assignment.jobRoleId } : {}),
      ...(assignment.plannedEffortMinutes !== undefined
        ? { plannedEffortMinutes: assignment.plannedEffortMinutes }
        : {}),
    })),
  }
}

/**
 * Keeps the duplicated custom field values that the selected Work Item Type still defines.
 *
 * Formula fields are computed by the server, so they are not copied.
 *
 * @param draft - Duplicate draft.
 * @param definitions - Fields of the selected Work Item Type.
 * @returns Values keyed by field ID.
 */
export function pickDuplicatedCustomFieldValues(
  draft: WorkItemDuplicateDraft,
  definitions: readonly CustomFieldDefinition[],
): Record<string, CustomFieldValue> {
  const values: Record<string, CustomFieldValue> = {}
  for (const definition of definitions) {
    const value = draft.customFieldValues[definition.id]
    if (value !== undefined && definition.type !== 'formula') values[definition.id] = value
  }
  return values
}
