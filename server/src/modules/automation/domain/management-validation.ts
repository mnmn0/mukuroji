import {
  type ApplyAutomationTemplateInput,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationValue,
  type CreateAutomationInboundWebhookEndpointInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type UpdateAutomationInboundWebhookEndpointInput,
} from '@mukuroji/contracts'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionValidationError,
} from '../../../domain/workflow-definition'
import { AutomationError } from './automation-error'
import { isAutomationValue } from './automation-value'
import { validateRecurringSchedule } from './recurring-schedule'

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
        'customFieldValues',
        'description',
        'dueDate',
        'priority',
        'teamId',
        'title',
        'workflowStatusId',
      ], 'Work Item template payload')
      const title = requireBoundedText(payload.title, 'Work Item template title', 500)
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
      const description = readOptionalTemplateString(
        payload.description,
        'Work Item template description',
      )
      const dueDate = readOptionalTemplateString(
        payload.dueDate,
        'Work Item template due date',
      )
      const teamId = readOptionalTemplateString(
        payload.teamId,
        'Work Item template Team ID',
      )
      const workflowStatusId = readOptionalTemplateString(
        payload.workflowStatusId,
        'Work Item template Workflow status ID',
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
          ...(customFieldValues === undefined ? {} : { customFieldValues }),
          ...(description === undefined ? {} : { description }),
          ...(dueDate === undefined ? {} : { dueDate }),
          ...(payload.priority === undefined ? {} : { priority: payload.priority }),
          ...(teamId === undefined ? {} : { teamId }),
          ...(workflowStatusId === undefined ? {} : { workflowStatusId }),
        },
      }
    }
    case 'project': {
      assertOnlyKeys(payload, ['name', 'nameEn', 'nameJa', 'tone'], 'Project template payload')
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
      }
      const tone = payload.tone ?? 'blue'
      if (tone !== 'blue' && tone !== 'purple' && tone !== 'green' && tone !== 'yellow') {
        throw invalidInput('Project template tone is invalid.')
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          ...(rawName ? { name: rawName } : {}),
          ...(rawNameJa ? { nameJa: rawNameJa } : {}),
          ...(rawNameEn ? { nameEn: rawNameEn } : {}),
          tone,
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
    assertOnlyKeys(target, ['kind', 'teamId'], 'Project template application target')
    return {
      target: {
        kind: 'project',
        teamId: requireBoundedText(target.teamId, 'Project template Team ID', 256),
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
  assertOnlyKeys(input, ['name'], 'Inbound webhook endpoint')
  return { name: requireBoundedText(input.name, 'Inbound webhook endpoint name', 160) }
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
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw invalidInput(`${label} must be between 1 and ${maximum} characters.`)
  }
  return value.trim()
}

/** Reads an optional template string while preserving meaningful empty values. */
function readOptionalTemplateString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string.`)
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
