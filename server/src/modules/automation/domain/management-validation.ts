import {
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
  type ApplyAutomationTemplateInput,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationProjectTemplateWorkItem,
  type AutomationValue,
  type CreateAutomationInboundWebhookEndpointInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type UpdateAutomationInboundWebhookEndpointInput,
  type WorkItemContributionStatus,
  type WorkItemContributorAssignmentCreateInput,
  WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT,
  WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES,
  WORK_ITEM_TITLE_MAX_LENGTH,
} from '@mukuroji/contracts'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionValidationError,
} from '../../work-item-workflow'
import { AutomationError } from './automation-error'
import { isAutomationValue } from './automation-value'
import { validateRecurringSchedule } from './recurring-schedule'
import { normalizeAutomationWorkItemSchedule } from './work-item-schedule-validation'

/** Longest routing Team ID; matches the Triage identifier boundary and canonical Team IDs. */
const TRIAGE_ROUTING_TEAM_ID_MAX_LENGTH = 200

/**
 * Validates and normalizes an untrusted Automation template definition.
 *
 * @param value - Untrusted template input.
 * @returns Normalized template creation input.
 */
export function validateCreateAutomationTemplateInput(
  value: unknown,
): CreateAutomationTemplateInput {
  const input = requireRecord(value, 'Automation template')
  assertOnlyKeys(input, ['enabled', 'kind', 'name', 'payload'], 'Automation template')
  if (input.kind !== 'work-item' && input.kind !== 'project' && input.kind !== 'workflow') {
    throw invalidInput('Automation template kind is invalid.')
  }
  const name = requireBoundedText(input.name, 'Automation template name', 160)
  const enabled = requireBoolean(input.enabled, 'Automation template enabled')
  const payload = requireRecord(input.payload, 'Automation template payload')
  switch (input.kind) {
    case 'work-item': {
      assertOnlyKeys(payload, [
        'assignedProjectId',
        'assigneeUserId',
        'contributorAssignments',
        'customFieldValues',
        'description',
        'priority',
        'schedule',
        'teamId',
        'title',
        'workItemTypeId',
        'workflowStatusId',
      ], 'Work Item template payload')
      const title = requireBoundedText(payload.title, 'Work Item template title', WORK_ITEM_TITLE_MAX_LENGTH * 2)
      // Work Item titles are bounded in code points, so a valid template always creates a Work Item.
      if ([...title].length > WORK_ITEM_TITLE_MAX_LENGTH) {
        throw invalidInput(`Work Item template title must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`)
      }
      const assignedProjectId = payload.assignedProjectId
      if (
        assignedProjectId !== undefined &&
        assignedProjectId !== null &&
        typeof assignedProjectId !== 'string'
      ) {
        throw invalidInput('Work Item template assigned Project ID must be a string or null.')
      }
      const assigneeUserId = readOptionalTemplateString(
        payload.assigneeUserId,
        'Work Item template assignee user ID',
      )
      const contributorAssignments = payload.contributorAssignments === undefined
        ? undefined
        : validateTemplateContributorAssignments(payload.contributorAssignments)
      const description = readOptionalTemplateString(
        payload.description,
        'Work Item template description',
      )
      const schedule = normalizeAutomationWorkItemSchedule(
        payload.schedule,
        'Work Item template schedule',
      )
      const teamId = readOptionalTemplateString(
        payload.teamId,
        'Work Item template Team ID',
      )
      const workflowStatusId = readOptionalTemplateString(
        payload.workflowStatusId,
        'Work Item template Workflow status ID',
      )
      const workItemTypeId = readOptionalTemplateString(
        payload.workItemTypeId,
        'Work Item template Work Item Type ID',
      )
      const customFieldValues = payload.customFieldValues === undefined
        ? undefined
        : validateAutomationValueRecord(
          payload.customFieldValues,
          'Work Item template custom field values',
        )
      if (
        payload.priority !== undefined &&
        payload.priority !== 'low' &&
        payload.priority !== 'medium' &&
        payload.priority !== 'high'
      ) {
        throw invalidInput('Work Item template priority is invalid.')
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          title,
          ...(assignedProjectId === undefined ? {} : { assignedProjectId }),
          ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
          ...(contributorAssignments === undefined || contributorAssignments.length === 0
            ? {}
            : { contributorAssignments }),
          ...(customFieldValues === undefined ? {} : { customFieldValues }),
          ...(description === undefined ? {} : { description }),
          ...(payload.priority === undefined ? {} : { priority: payload.priority }),
          schedule,
          ...(teamId === undefined ? {} : { teamId }),
          ...(workItemTypeId === undefined ? {} : { workItemTypeId }),
          ...(workflowStatusId === undefined ? {} : { workflowStatusId }),
        },
      }
    }
    case 'project': {
      assertOnlyKeys(
        payload,
        ['name', 'nameEn', 'nameJa', 'tone', 'workItems'],
        'Project template payload',
      )
      const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
      const rawNameJa = typeof payload.nameJa === 'string' ? payload.nameJa.trim() : ''
      const rawNameEn = typeof payload.nameEn === 'string' ? payload.nameEn.trim() : ''
      const primaryName = rawNameJa || rawName || rawNameEn
      if (!primaryName) throw invalidInput('Project template name is required.')
      for (const [label, candidate] of [
        ['Project template name', rawName],
        ['Project template Japanese name', rawNameJa],
        ['Project template English name', rawNameEn],
      ] as const) {
        if (candidate.length > 160) throw invalidInput(`${label} must be 160 characters or fewer.`)
        // Matches the Team and Project name rule, so a saved template can always be applied.
        if (/\p{Cc}/u.test(candidate)) throw invalidInput(`${label} must not contain control characters.`)
      }
      const tone = payload.tone ?? 'blue'
      if (tone !== 'blue' && tone !== 'purple' && tone !== 'green' && tone !== 'yellow') {
        throw invalidInput('Project template tone is invalid.')
      }
      const workItems = payload.workItems === undefined
        ? undefined
        : validateProjectTemplateWorkItems(payload.workItems)
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          ...(rawName ? { name: rawName } : {}),
          ...(rawNameJa ? { nameJa: rawNameJa } : {}),
          ...(rawNameEn ? { nameEn: rawNameEn } : {}),
          tone,
          ...(workItems && workItems.length > 0 ? { workItems } : {}),
        },
      }
    }
    case 'workflow': {
      assertOnlyKeys(
        payload,
        ['id', 'initialStatusId', 'name', 'statuses', 'transitions'],
        'Workflow template payload',
      )
      if (Array.isArray(payload.statuses)) {
        for (const status of payload.statuses) {
          assertOnlyKeys(
            requireRecord(status, 'Workflow template status'),
            ['category', 'color', 'id', 'name', 'sortOrder'],
            'Workflow template status',
          )
        }
      }
      if (Array.isArray(payload.transitions)) {
        for (const transition of payload.transitions) {
          assertOnlyKeys(
            requireRecord(transition, 'Workflow template transition'),
            ['fromStatusId', 'toStatusId'],
            'Workflow template transition',
          )
        }
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: validateAutomationWorkflowTemplate(payload),
      }
    }
  }
}

/**
 * Validates a Project template WBS and returns a normalized copy.
 *
 * @param value - Untrusted top-level Work Item list.
 * @returns Work Items with trimmed titles and only supported fields.
 */
function validateProjectTemplateWorkItems(value: unknown): AutomationProjectTemplateWorkItem[] {
  const counter = { count: 0 }
  return readProjectTemplateWorkItemLevel(value, 1, counter)
}

/**
 * Validates one sibling list of a Project template WBS.
 *
 * @param value - Untrusted sibling list.
 * @param depth - One-based WBS level of the siblings.
 * @param counter - Running Work Item count across the whole template.
 * @returns Normalized siblings in input order.
 */
function readProjectTemplateWorkItemLevel(
  value: unknown,
  depth: number,
  counter: { count: number },
): AutomationProjectTemplateWorkItem[] {
  if (!Array.isArray(value)) throw invalidInput('Project template Work Items must be an array.')
  if (depth > AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT) {
    throw invalidInput(
      `Project template Work Items can be nested at most ${AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT} levels deep.`,
    )
  }
  return value.map((candidate) => {
    counter.count += 1
    if (counter.count > AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT) {
      throw invalidInput(
        `Project template can hold at most ${AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT} Work Items.`,
      )
    }
    const item = requireRecord(candidate, 'Project template Work Item')
    assertOnlyKeys(
      item,
      ['children', 'durationWorkingDays', 'startOffsetWorkingDays', 'title'],
      'Project template Work Item',
    )
    const title = requireBoundedText(item.title, 'Project template Work Item title', WORK_ITEM_TITLE_MAX_LENGTH * 2)
    if ([...title].length > WORK_ITEM_TITLE_MAX_LENGTH) {
      throw invalidInput(
        `Project template Work Item title must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`,
      )
    }
    // The template editor shows the WBS one Work Item per line, so a line break would split it.
    if (/[\r\n\u2028\u2029]/u.test(title)) {
      throw invalidInput('Project template Work Item title must not contain line breaks.')
    }
    const startOffsetWorkingDays = requireInteger(
      item.startOffsetWorkingDays,
      'Project template Work Item start offset',
      0,
      AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
    )
    const durationWorkingDays = requireInteger(
      item.durationWorkingDays,
      'Project template Work Item duration',
      1,
      AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
    )
    const children = item.children === undefined
      ? []
      : readProjectTemplateWorkItemLevel(item.children, depth + 1, counter)
    return {
      title,
      startOffsetWorkingDays,
      durationWorkingDays,
      ...(children.length > 0 ? { children } : {}),
    }
  })
}

/** Maps pure workflow validation failures to the stable Automation error contract. */
function validateAutomationWorkflowTemplate(value: unknown) {
  try {
    return validateWorkflowDefinition(value)
  } catch (error) {
    if (error instanceof WorkflowDefinitionValidationError) {
      throw new AutomationError(
        'invalid-input',
        error.code,
        error.message,
      )
    }
    throw error
  }
}

/**
 * Validates an untrusted Automation template application target.
 *
 * @param value - Untrusted application input.
 * @returns Normalized application input.
 */
export function validateApplyAutomationTemplateInput(
  value: unknown,
): ApplyAutomationTemplateInput {
  const input = requireRecord(value, 'Template application')
  assertOnlyKeys(input, ['target'], 'Template application')
  const target = requireRecord(input.target, 'Template application target')
  if (target.kind === 'project') {
    assertOnlyKeys(target, ['kind', 'startDate', 'teamId'], 'Project template application target')
    const startDate = target.startDate === undefined
      ? undefined
      : requireCalendarDate(target.startDate, 'Project template start date')
    return {
      target: {
        kind: 'project',
        teamId: requireBoundedText(target.teamId, 'Project template Team ID', 256),
        ...(startDate === undefined ? {} : { startDate }),
      },
    }
  }
  if (target.kind === 'workflow') {
    assertOnlyKeys(
      target,
      ['expectedRevision', 'kind', 'scopeId', 'scopeType'],
      'Workflow template application target',
    )
    if (target.scopeType !== 'workspace' && target.scopeType !== 'team') {
      throw invalidInput('Workflow template scope type is invalid.')
    }
    return {
      target: {
        kind: 'workflow',
        scopeType: target.scopeType,
        scopeId: requireBoundedText(target.scopeId, 'Workflow template scope ID', 256),
        expectedRevision: requireInteger(
          target.expectedRevision,
          'Workflow template expected revision',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      },
    }
  }
  throw invalidInput('Template application target kind is invalid.')
}

/**
 * Validates an untrusted inbound webhook endpoint creation request.
 *
 * @param value - Untrusted endpoint input.
 * @returns Normalized endpoint creation input.
 */
export function validateCreateAutomationInboundWebhookEndpointInput(
  value: unknown,
): CreateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint')
  assertOnlyKeys(input, ['name', 'purpose', 'triageRouting'], 'Inbound webhook endpoint')
  const name = requireBoundedText(input.name, 'Inbound webhook endpoint name', 160)
  const purpose = input.purpose === undefined ? 'automation' : input.purpose
  if (purpose !== 'automation' && purpose !== 'triage') {
    throw new AutomationError('invalid-input', 'AutomationInboundWebhookPurposeInvalid', 'Inbound webhook purpose must be automation or triage.')
  }
  if (purpose === 'automation') {
    if (input.triageRouting !== undefined) {
      throw new AutomationError('invalid-input', 'AutomationInboundWebhookRoutingInvalid', 'Only Triage endpoints take Triage routing.')
    }
    // Automation stays the implicit default so existing create fingerprints are unchanged.
    return { name }
  }
  const routing = requireRecord(input.triageRouting, 'Inbound webhook Triage routing')
  assertOnlyKeys(routing, ['teamId'], 'Inbound webhook Triage routing')
  return { name, purpose, triageRouting: { teamId: requireBoundedText(routing.teamId, 'Triage routing Team ID', TRIAGE_ROUTING_TEAM_ID_MAX_LENGTH) } }
}

/**
 * Validates an untrusted inbound webhook endpoint update request.
 *
 * @param value - Untrusted endpoint update input.
 * @returns Normalized endpoint update input.
 */
export function validateUpdateAutomationInboundWebhookEndpointInput(
  value: unknown,
): UpdateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint update')
  assertOnlyKeys(input, ['expectedRevision', 'name'], 'Inbound webhook endpoint update')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    name: requireBoundedText(input.name, 'Inbound webhook endpoint name', 160),
  }
}

/**
 * Validates an untrusted inbound webhook lifecycle request.
 *
 * @param value - Untrusted lifecycle input.
 * @returns Normalized lifecycle input.
 */
export function validateAutomationInboundWebhookLifecycleInput(
  value: unknown,
): AutomationInboundWebhookLifecycleInput {
  const input = requireRecord(value, 'Inbound webhook endpoint lifecycle')
  assertOnlyKeys(input, ['expectedRevision'], 'Inbound webhook endpoint lifecycle')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

/**
 * Validates and normalizes an untrusted recurring Work definition.
 *
 * @param value - Untrusted recurring input.
 * @returns Normalized recurring Work creation input.
 */
export function validateCreateRecurringWorkInput(value: unknown): CreateRecurringWorkInput {
  const input = requireRecord(value, 'Recurring Work')
  return {
    name: requireBoundedText(input.name, 'Recurring Work name', 160),
    teamId: requireBoundedText(input.teamId, 'Recurring Work Team ID', 256),
    enabled: requireBoolean(input.enabled, 'Recurring Work enabled'),
    templateId: requireBoundedText(input.templateId, 'Recurring Work template ID', 256),
    schedule: validateRecurringSchedule(input.schedule),
  }
}

/** Creates a stable invalid-input error. */
function invalidInput(message: string) {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}

/** Narrows an unknown value to a record or throws a validation error. */
/**
 * Validates the contributors a Work Item template starts its Work Items with.
 *
 * Only the shape is checked here. Job roles and members are checked against the Team's current
 * configuration and membership when a Work Item is created from the template, as for any create.
 *
 * @param value - Untrusted contributor list.
 * @returns The normalized contributor list.
 * @throws AutomationError when the list or an entry is malformed.
 */
function validateTemplateContributorAssignments(value: unknown): WorkItemContributorAssignmentCreateInput[] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT) {
    throw invalidInput(
      `Work Item template contributors must be a list of at most ${WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT} entries.`,
    )
  }
  return value.map((entry) => {
    const record = requireRecord(entry, 'Work Item template contributor')
    assertOnlyKeys(record, ['jobRoleId', 'memberUserId', 'plannedEffortMinutes', 'status'], 'Work Item template contributor')
    const memberUserId = record.memberUserId === undefined
      ? undefined
      : requireBoundedText(record.memberUserId, 'Work Item template contributor member', 256).toLowerCase()
    const jobRoleId = record.jobRoleId === undefined
      ? undefined
      : requireBoundedText(record.jobRoleId, 'Work Item template contributor job role', 128)
    if (memberUserId === undefined && jobRoleId === undefined) {
      throw invalidInput('Work Item template contributor needs a member or a job role.')
    }
    const plannedEffortMinutes = record.plannedEffortMinutes
    if (
      plannedEffortMinutes !== undefined &&
      (typeof plannedEffortMinutes !== 'number' || !Number.isSafeInteger(plannedEffortMinutes) ||
        plannedEffortMinutes < 0 || plannedEffortMinutes > WORK_ITEM_CONTRIBUTOR_PLANNED_EFFORT_MAX_MINUTES)
    ) {
      throw invalidInput('Work Item template contributor planned effort is invalid.')
    }
    const status = record.status
    if (status !== undefined && !isContributionStatus(status)) {
      throw invalidInput('Work Item template contributor status is invalid.')
    }
    return {
      ...(memberUserId === undefined ? {} : { memberUserId }),
      ...(jobRoleId === undefined ? {} : { jobRoleId }),
      ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
      ...(status === undefined ? {} : { status }),
    }
  })
}

/**
 * Narrows a value to a contributor progress state.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is `planned`, `in-progress`, or `done`.
 */
function isContributionStatus(value: unknown): value is WorkItemContributionStatus {
  return value === 'planned' || value === 'in-progress' || value === 'done'
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object.`)
  return value
}

/** Rejects properties outside a request's explicit allowlist. */
function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const allowed = new Set(keys)
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
  if (unsupported.length > 0) {
    throw invalidInput(`${label} contains unsupported fields: ${unsupported.join(', ')}.`)
  }
}

/** Reads a trimmed non-empty string within a maximum length. */
function requireBoundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) {
    throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  }
  return text
}

/** Reads an optional template string while preserving meaningful empty values. */
function readOptionalTemplateString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string.`)
  return value
}

/**
 * Reads a real calendar date in `YYYY-MM-DD` form between 1970 and 2999, which leaves room for
 * the longest template WBS to stay within the supported schedule range.
 *
 * @param value - Untrusted date value.
 * @param label - Field name used in the error message.
 * @returns The validated date string.
 */
function requireCalendarDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalidInput(`${label} must be a YYYY-MM-DD date.`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    value < '1970-01-01' ||
    value > '2999-12-31'
  ) {
    throw invalidInput(`${label} must be a real calendar date between 1970 and 2999.`)
  }
  return value
}

/** Reads a required boolean. */
function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

/** Reads a safe integer within inclusive bounds. */
function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

/** Validates and clones an Automation value record without type assertions. */
function validateAutomationValueRecord(value: unknown, label: string): Record<string, AutomationValue> {
  if (!isRecord(value) || !isAutomationValue(value)) {
    throw invalidInput(`${label} must be an object.`)
  }
  const result: Record<string, AutomationValue> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!isAutomationValue(candidate)) throw invalidInput(`${label} contains an invalid value.`)
    result[key] = structuredClone(candidate)
  }
  return result
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
