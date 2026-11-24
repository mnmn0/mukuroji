import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  deriveWorkItemScheduleDueDate,
  type AutomationTemplate,
  type AutomationValue,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type WorkItemContributorAssignmentCreateInput,
  type WorkItemPriority,
} from '@mukuroji/contracts'
import type { TeamIssue } from '../api'

/** Work Item template a create draft can start from. */
export type WorkItemTemplate = Extract<AutomationTemplate, { kind: 'work-item' }>

/**
 * Editable values that the create panel starts from when a member duplicates a Work Item or
 * picks a Work Item template.
 *
 * History, comments, relations, approvals, and Agent Runs stay with the source Work Item.
 */
export type WorkItemDuplicateDraft = {
  /**
   * Work Item the draft was copied from, or `template:<id>:<version>` for a template draft; it
   * keys the panel so a new source resets the form.
   */
  sourceWorkItemId: string
  /** Template the draft starts from; absent for a duplicated Work Item. */
  sourceTemplate?: {
    /** Template ID. */
    id: string
    /** Template display name. */
    name: string
  }
  /** Title copied from the source. */
  title: string
  /** Description copied from the source. */
  description: string
  /**
   * Work Item Type copied from the source; legacy rows without one use the built-in type. Absent
   * when a template leaves the type to the form.
   */
  workItemTypeId?: string
  /** Project the source is assigned to; absent for a Team-owned Work Item. */
  assignedProjectId?: string
  /** Accountable owner copied from the source; empty when a template leaves it to the member. */
  assigneeUserId: string
  /** Priority copied from the source. */
  priority: WorkItemPriority
  /**
   * Local `YYYY-MM-DD` deadline or end date of the source; empty when it is unscheduled. Absent for
   * a template draft, which keeps the form's own date.
   */
  dueDate?: string
  /** Custom field values copied from the source. */
  customFieldValues: Readonly<Record<string, CustomFieldValue>>
  /** Contributor plan copied from the source, reset to `planned` as new assignments. */
  contributorAssignments: WorkItemContributorAssignmentCreateInput[]
  /** Acceptance criteria texts copied from the source; the new Work Item starts with them unmet. */
  acceptanceCriteria: string[]
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
    acceptanceCriteria: (issue.acceptanceCriteria ?? []).map((criterion) => criterion.text),
  }
}

/**
 * Lists the enabled Work Item templates a member can start a Work Item from in one Team.
 *
 * @param templates - Workspace templates of every kind.
 * @param teamId - Team the new Work Item belongs to.
 * @returns Enabled Work Item templates that are not bound to another Team, by name.
 */
export function listWorkItemTemplatesForTeam(
  templates: readonly AutomationTemplate[],
  teamId: string | undefined,
): WorkItemTemplate[] {
  return templates
    .filter((template): template is WorkItemTemplate =>
      template.kind === 'work-item' &&
      template.enabled &&
      typeof template.payload.title === 'string' &&
      (template.payload.teamId === undefined || template.payload.teamId === teamId))
    .sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
}

/**
 * Builds the create-panel draft for a Work Item template.
 *
 * The template's schedule is left out: its dates were fixed when the template was saved, so the
 * form keeps its own date.
 *
 * @param template - Selected Work Item template.
 * @returns Draft values for the create panel.
 */
export function createWorkItemTemplateDraft(template: WorkItemTemplate): WorkItemDuplicateDraft {
  const payload = template.payload
  return {
    sourceWorkItemId: `template:${template.id}:${template.version}`,
    sourceTemplate: { id: template.id, name: template.name },
    title: payload.title,
    description: typeof payload.description === 'string' ? payload.description : '',
    ...(typeof payload.workItemTypeId === 'string' ? { workItemTypeId: payload.workItemTypeId } : {}),
    ...(typeof payload.assignedProjectId === 'string' ? { assignedProjectId: payload.assignedProjectId } : {}),
    assigneeUserId: typeof payload.assigneeUserId === 'string' ? payload.assigneeUserId : '',
    priority: payload.priority === 'high' || payload.priority === 'low' ? payload.priority : 'medium',
    customFieldValues: readTemplateCustomFieldValues(payload.customFieldValues),
    contributorAssignments: [],
    acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.filter((text) => typeof text === 'string')
      : [],
  }
}

/**
 * Keeps the template custom field values that have a Work Item custom field value shape.
 *
 * @param values - Template custom field values, if any.
 * @returns Values keyed by field ID.
 */
function readTemplateCustomFieldValues(
  values: Readonly<Record<string, AutomationValue>> | undefined,
): Record<string, CustomFieldValue> {
  const result: Record<string, CustomFieldValue> = {}
  for (const [fieldId, value] of Object.entries(values ?? {})) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    ) {
      result[fieldId] = value
    }
  }
  return result
}

/**
 * Tells whether the draft's custom field values apply to the selected Work Item Type: a
 * duplicate's values belong to its own type, and a template without a type applies to any.
 *
 * @param draft - Create draft.
 * @param workItemTypeId - Work Item Type selected in the form.
 * @returns Whether the draft values should fill the form.
 */
export function draftCustomFieldValuesApply(draft: WorkItemDuplicateDraft, workItemTypeId: string): boolean {
  return draft.workItemTypeId === undefined || draft.workItemTypeId === workItemTypeId
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
