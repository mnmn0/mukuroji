import { isRecord } from '../../shared/api/jsonValidation'

/** Work Item template fields the template form edits; every other payload field is kept as is. */
export type WorkItemTemplateFormValues = {
  /** Title of the Work Item to create. */
  title: string
  /** Description of the Work Item. */
  description: string
  /** Priority, or an empty string for none. */
  priority: '' | 'low' | 'medium' | 'high'
  /** Assignee member key, or an empty string for none. */
  assigneeUserId: string
  /** Work Item Type ID, or an empty string for the Team default. */
  workItemTypeId: string
  /** Initial Workflow status ID, or an empty string for the Workflow default. */
  workflowStatusId: string
  /** Project ID, or an empty string for none. */
  assignedProjectId: string
}

/** Text fields the form writes under the same payload key, removed when blank. */
const OPTIONAL_TEXT_FIELDS = [
  'description',
  'assigneeUserId',
  'workItemTypeId',
  'workflowStatusId',
  'assignedProjectId',
] as const satisfies readonly (keyof WorkItemTemplateFormValues)[]

/** Schedule a new template starts with: no dates, on the Team's shared work calendar. */
const DEFAULT_WORK_ITEM_TEMPLATE_SCHEDULE = {
  mode: 'unscheduled',
  calendarPolicy: {
    calendarSource: 'shared',
    timeZone: 'Asia/Tokyo',
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    holidays: [],
  },
}

/**
 * Creates the JSON a new Work Item template starts with.
 *
 * @returns Pretty-printed payload JSON with an empty title and no dates.
 */
export function createInitialWorkItemTemplateJson(): string {
  return JSON.stringify({ title: '', schedule: DEFAULT_WORK_ITEM_TEMPLATE_SCHEDULE }, null, 2)
}

/**
 * Reads the form fields from a template payload JSON.
 *
 * @param json - Payload JSON the editor holds.
 * @returns The form values, or undefined when the JSON is not an object.
 */
export function readWorkItemTemplateFormValues(json: string): WorkItemTemplateFormValues | undefined {
  const payload = parseObject(json)
  if (!payload) return undefined
  const priority = payload.priority
  return {
    title: readText(payload.title),
    description: readText(payload.description),
    priority: priority === 'low' || priority === 'medium' || priority === 'high' ? priority : '',
    assigneeUserId: readText(payload.assigneeUserId),
    workItemTypeId: readText(payload.workItemTypeId),
    workflowStatusId: readText(payload.workflowStatusId),
    assignedProjectId: readText(payload.assignedProjectId),
  }
}

/**
 * Writes one form field into a template payload JSON, keeping every other field.
 *
 * Blank optional fields are removed so the template falls back to the Team defaults, and a
 * payload without a schedule gets the undated default.
 *
 * @param json - Payload JSON the editor holds.
 * @param field - Form field that changed.
 * @param value - New field value.
 * @returns The updated pretty-printed JSON, or the input when it is not an object.
 */
export function applyWorkItemTemplateFormValue(
  json: string,
  field: keyof WorkItemTemplateFormValues,
  value: string,
): string {
  const payload = parseObject(json)
  if (!payload) return json
  const next: Record<string, unknown> = { ...payload }
  if (field === 'title') {
    next.title = value
  } else if (field === 'priority') {
    if (value === 'low' || value === 'medium' || value === 'high') next.priority = value
    else delete next.priority
  } else if (OPTIONAL_TEXT_FIELDS.some((candidate) => candidate === field)) {
    if (value.trim()) next[field] = value
    else delete next[field]
  }
  if (next.schedule === undefined) next.schedule = DEFAULT_WORK_ITEM_TEMPLATE_SCHEDULE
  return JSON.stringify(next, null, 2)
}

/**
 * Parses JSON that must hold an object.
 *
 * @param json - Candidate JSON.
 * @returns The object, or undefined when the JSON is invalid or not an object.
 */
function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads a string field.
 *
 * @param value - Candidate value.
 * @returns The string, or an empty string for anything else.
 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
