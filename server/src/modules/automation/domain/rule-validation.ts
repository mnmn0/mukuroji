import {
  APPROVAL_MAX_REVIEWERS,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRateLimit,
  type AutomationRetryPolicy,
  type AutomationTrigger,
  type AutomationValue,
  type CreateAutomationRuleInput,
} from '@mukuroji/contracts'
import {
  isAutomationWebhookSecretAlias,
  readAutomationWebhookEndpoint,
} from '../automation-webhook-policy'
import { AutomationError } from './automation-error'
import { isAutomationValue } from './automation-value'
import { validateRecurringSchedule } from './recurring-schedule'

const AUTOMATION_UPDATE_FIELDS = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'dueDate',
  'priority',
  'title',
  'workflowStatusId',
])

/** Field condition discriminator accepted by the Automation contract. */
type AutomationFieldOperator = Extract<
  AutomationCondition,
  { type: 'field' }
>['operator']

/**
 * Validates and normalizes an untrusted Automation rule definition.
 *
 * @param value - Untrusted rule input.
 * @returns A normalized create-rule input.
 */
export function validateCreateAutomationRuleInput(value: unknown): CreateAutomationRuleInput {
  const input = requireRecord(value, 'Automation rule')
  const name = requireBoundedText(input.name, 'Automation rule name', 160)
  if (typeof input.enabled !== 'boolean') {
    throw invalidInput('Automation rule enabled must be boolean.')
  }
  const trigger = validateAutomationTrigger(input.trigger)
  const conditions = input.conditions === undefined
    ? undefined
    : validateAutomationConditions(input.conditions)
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 32) {
    throw invalidInput('Automation rule must contain between 1 and 32 actions.')
  }
  const actions = input.actions.map(validateAutomationAction)
  const retryPolicy = input.retryPolicy === undefined
    ? undefined
    : validateAutomationRetryPolicy(input.retryPolicy)
  const rateLimit = input.rateLimit === undefined
    ? undefined
    : validateAutomationRateLimit(input.rateLimit)
  const allowReentry = input.allowReentry === undefined
    ? undefined
    : requireBoolean(input.allowReentry, 'Automation allowReentry')
  const maxChainDepth = input.maxChainDepth === undefined
    ? undefined
    : requireInteger(input.maxChainDepth, 'Automation maxChainDepth', 1, 64)
  return {
    name,
    enabled: input.enabled,
    trigger,
    ...(conditions ? { conditions } : {}),
    actions,
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(allowReentry === undefined ? {} : { allowReentry }),
    ...(maxChainDepth === undefined ? {} : { maxChainDepth }),
  }
}

/** Validates a trigger discriminator and its filters. */
function validateAutomationTrigger(value: unknown): AutomationTrigger {
  const trigger = requireRecord(value, 'Automation trigger')
  switch (trigger.type) {
    case 'status':
      return {
        type: 'status',
        ...(trigger.fromStatusId === undefined ? {} : {
          fromStatusId: requireBoundedText(trigger.fromStatusId, 'From status ID', 128),
        }),
        ...(trigger.toStatusId === undefined ? {} : {
          toStatusId: requireBoundedText(trigger.toStatusId, 'To status ID', 128),
        }),
      }
    case 'assignee':
      return {
        type: 'assignee',
        ...(trigger.assigneeMemberKey === undefined ? {} : {
          assigneeMemberKey: requireBoundedText(
            trigger.assigneeMemberKey,
            'Assignee member key',
            256,
          ),
        }),
      }
    case 'due':
      if (
        trigger.reason !== undefined &&
        trigger.reason !== 'changed' &&
        trigger.reason !== 'due' &&
        trigger.reason !== 'overdue'
      ) {
        throw invalidInput('Automation due trigger reason is invalid.')
      }
      return {
        type: 'due',
        ...(trigger.reason === undefined ? {} : { reason: trigger.reason }),
      }
    case 'custom-field':
      return {
        type: 'custom-field',
        fieldId: requireBoundedText(trigger.fieldId, 'Custom field ID', 128),
      }
    case 'comment':
      if (
        trigger.kind !== undefined &&
        trigger.kind !== 'comment' &&
        trigger.kind !== 'reply' &&
        trigger.kind !== 'any'
      ) {
        throw invalidInput('Automation comment trigger kind is invalid.')
      }
      return {
        type: 'comment',
        ...(trigger.kind === undefined ? {} : { kind: trigger.kind }),
      }
    case 'form':
      return {
        type: 'form',
        formId: requireBoundedText(trigger.formId, 'Form ID', 256),
      }
    case 'webhook':
      return {
        type: 'webhook',
        webhookId: requireBoundedText(trigger.webhookId, 'Webhook ID', 256),
      }
    case 'schedule':
      return {
        type: 'schedule',
        schedule: validateRecurringSchedule(trigger.schedule),
      }
    default:
      throw invalidInput('Automation trigger type is invalid.')
  }
}

/** Validates a top-level condition list. */
function validateAutomationConditions(value: unknown): AutomationCondition[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw invalidInput('Automation conditions must be an array with at most 32 entries.')
  }
  return value.map((condition) => validateAutomationCondition(condition, 0))
}

/** Validates one recursively nested condition. */
function validateAutomationCondition(value: unknown, depth: number): AutomationCondition {
  if (depth > 8) throw invalidInput('Automation condition nesting exceeds 8 levels.')
  const condition = requireRecord(value, 'Automation condition')
  if (condition.type === 'all' || condition.type === 'any') {
    if (
      !Array.isArray(condition.conditions) ||
      condition.conditions.length === 0 ||
      condition.conditions.length > 32
    ) {
      throw invalidInput('Automation condition group must contain between 1 and 32 children.')
    }
    return {
      type: condition.type,
      conditions: condition.conditions.map((child) =>
        validateAutomationCondition(child, depth + 1)
      ),
    }
  }
  if (condition.type === 'not') {
    return {
      type: 'not',
      condition: validateAutomationCondition(condition.condition, depth + 1),
    }
  }
  if (condition.type !== 'field') throw invalidInput('Automation condition type is invalid.')
  const field = requireBoundedText(condition.field, 'Automation condition field', 256)
  if (
    !field.startsWith('event.') &&
    !field.startsWith('workItem.') &&
    !field.startsWith('variables.')
  ) {
    throw invalidInput(
      'Automation condition field must start with event., workItem., or variables..',
    )
  }
  if (!isAutomationFieldOperator(condition.operator)) {
    throw invalidInput('Automation condition operator is invalid.')
  }
  const isExistenceOperator =
    condition.operator === 'exists' || condition.operator === 'not-exists'
  if (isExistenceOperator && condition.value !== undefined) {
    throw invalidInput('Automation existence conditions cannot define a comparison value.')
  }
  if (!isExistenceOperator && condition.value === undefined) {
    throw invalidInput('Automation comparison conditions require a value.')
  }
  if (condition.value !== undefined && !isAutomationValue(condition.value)) {
    throw invalidInput('Automation condition value is invalid.')
  }
  return {
    type: 'field',
    field,
    operator: condition.operator,
    ...(condition.value === undefined ? {} : { value: structuredClone(condition.value) }),
  }
}

/** Narrows an unknown value to a supported field operator. */
function isAutomationFieldOperator(value: unknown): value is AutomationFieldOperator {
  return value === 'equals' ||
    value === 'not-equals' ||
    value === 'contains' ||
    value === 'greater-than' ||
    value === 'greater-than-or-equal' ||
    value === 'less-than' ||
    value === 'less-than-or-equal' ||
    value === 'exists' ||
    value === 'not-exists'
}

/** Validates one Automation action. */
function validateAutomationAction(value: unknown): AutomationAction {
  const action = requireRecord(value, 'Automation action')
  switch (action.type) {
    case 'assign':
      return {
        type: 'assign',
        assigneeMemberKey: requireBoundedText(
          action.assigneeMemberKey,
          'Assignee member key',
          256,
        ),
      }
    case 'move':
      return {
        type: 'move',
        targetProjectId: action.targetProjectId === null
          ? null
          : requireBoundedText(action.targetProjectId, 'Target Project ID', 256),
      }
    case 'update': {
      const patch = requireAutomationRecord(action.patch, 'Automation update patch')
      const fields = Object.keys(patch)
      if (fields.length === 0) throw invalidInput('Automation update patch cannot be empty.')
      const unsupportedFields = fields.filter((field) => !AUTOMATION_UPDATE_FIELDS.has(field))
      if (unsupportedFields.length > 0) {
        throw invalidInput(
          `Automation update patch contains unsupported fields: ${unsupportedFields.join(', ')}.`,
        )
      }
      return { type: 'update', patch }
    }
    case 'create': {
      const templateId = action.templateId === undefined
        ? undefined
        : requireBoundedText(action.templateId, 'Automation template ID', 256)
      const values = action.values === undefined
        ? undefined
        : requireAutomationRecord(action.values, 'Automation create values')
      if (!templateId && !values) {
        throw invalidInput('Automation create action requires templateId or values.')
      }
      return {
        type: 'create',
        ...(templateId ? { templateId } : {}),
        ...(values ? { values } : {}),
      }
    }
    case 'comment':
      return {
        type: 'comment',
        body: requireBoundedText(action.body, 'Automation comment body', 20_000),
      }
    case 'notify': {
      const recipientMemberKeys = readUniqueTexts(
        action.recipientMemberKeys,
        'Notification recipients',
        100,
      )
      if (recipientMemberKeys.length === 0) {
        throw invalidInput('Automation notification requires recipients.')
      }
      return {
        type: 'notify',
        recipientMemberKeys,
        title: requireBoundedText(action.title, 'Notification title', 256),
        ...(action.body === undefined ? {} : {
          body: requireBoundedText(action.body, 'Notification body', 4_096),
        }),
      }
    }
    case 'approval': {
      const reviewerMemberKeys = readUniqueTexts(
        action.reviewerMemberKeys,
        'Approval reviewers',
        APPROVAL_MAX_REVIEWERS,
      )
      if (reviewerMemberKeys.length === 0) {
        throw invalidInput('Automation approval requires reviewers.')
      }
      return {
        type: 'approval',
        reviewerMemberKeys,
        dueInHours: requireInteger(action.dueInHours, 'Approval due hours', 1, 8_760),
        ...(action.completionStatusId === undefined ? {} : {
          completionStatusId: requireBoundedText(
            action.completionStatusId,
            'Completion status ID',
            128,
          ),
        }),
      }
    }
    case 'webhook': {
      const url = requireBoundedText(action.url, 'Webhook URL', 2_048)
      const endpoint = readAutomationWebhookEndpoint(url)
      if (!endpoint) {
        throw invalidInput(
          'Automation webhook URL must use public HTTPS without credentials or a custom port.',
        )
      }
      const secretReference = action.secretReference === undefined
        ? undefined
        : requireBoundedText(
            action.secretReference,
            'Webhook secret reference',
            128,
          )
      if (secretReference && !isAutomationWebhookSecretAlias(secretReference)) {
        throw invalidInput('Automation webhook secret reference must be a valid alias.')
      }
      const body = action.body === undefined
        ? undefined
        : requireAutomationRecord(action.body, 'Webhook body')
      return {
        type: 'webhook',
        url: endpoint.toString(),
        ...(secretReference ? { secretReference } : {}),
        ...(body ? { body } : {}),
      }
    }
    default:
      throw invalidInput('Automation action type is invalid.')
  }
}

/** Validates an Automation retry policy. */
function validateAutomationRetryPolicy(value: unknown): AutomationRetryPolicy {
  const policy = requireRecord(value, 'Automation retry policy')
  const initialDelayMs = requireInteger(
    policy.initialDelayMs,
    'Initial retry delay',
    0,
    86_400_000,
  )
  const maxDelayMs = requireInteger(
    policy.maxDelayMs,
    'Maximum retry delay',
    0,
    86_400_000,
  )
  if (maxDelayMs < initialDelayMs) {
    throw invalidInput('Maximum retry delay cannot be smaller than initial delay.')
  }
  if (
    typeof policy.backoffMultiplier !== 'number' ||
    !Number.isFinite(policy.backoffMultiplier) ||
    policy.backoffMultiplier < 1 ||
    policy.backoffMultiplier > 100
  ) {
    throw invalidInput('Automation retry backoff multiplier is invalid.')
  }
  return {
    maxAttempts: requireInteger(policy.maxAttempts, 'Maximum retry attempts', 1, 100),
    initialDelayMs,
    backoffMultiplier: policy.backoffMultiplier,
    maxDelayMs,
  }
}

/** Validates an Automation fixed-window rate limit. */
function validateAutomationRateLimit(value: unknown): AutomationRateLimit {
  const limit = requireRecord(value, 'Automation rate limit')
  return {
    maxExecutions: requireInteger(
      limit.maxExecutions,
      'Maximum executions',
      1,
      100_000,
    ),
    windowSeconds: requireInteger(
      limit.windowSeconds,
      'Rate-limit window',
      1,
      86_400,
    ),
  }
}

/** Reads a JSON-compatible object and clones its values. */
function requireAutomationRecord(
  value: unknown,
  label: string,
): Record<string, AutomationValue> {
  const record = requireRecord(value, label)
  if (!isAutomationValue(record)) throw invalidInput(`${label} is invalid.`)
  const result: Record<string, AutomationValue> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!isAutomationValue(entry)) throw invalidInput(`${label} is invalid.`)
    result[key] = structuredClone(entry)
  }
  return result
}

/** Reads an object from untrusted input. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput(`${label} must be an object.`)
  }
  return value
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads required bounded text from untrusted input. */
function requireBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) {
    throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  }
  return text
}

/** Reads a boolean from untrusted input. */
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

/** Reads a bounded integer from untrusted input. */
function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidInput(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    )
  }
  return value
}

/** Reads a bounded unique text list from untrusted input. */
function readUniqueTexts(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidInput(`${label} are invalid.`)
  }
  const values = value.map((entry) => requireBoundedText(entry, label, 256))
  if (new Set(values).size !== values.length) {
    throw invalidInput(`${label} must be unique.`)
  }
  return values
}

/** Creates the stable invalid-input error used by Automation adapters. */
function invalidInput(message: string): AutomationError {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}
