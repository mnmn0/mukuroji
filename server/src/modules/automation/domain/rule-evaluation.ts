import type {
  AutomationCondition,
  AutomationTrigger,
  AutomationValue,
} from '@mukuroji/contracts'

/** A field change carried by a durable Automation trigger event. */
export type AutomationEventChange = {
  /** Dot-separated field path. */
  field: string
  /** Value before the mutation. */
  before?: AutomationValue
  /** Value after the mutation. */
  after?: AutomationValue
}

/** Transport-neutral event consumed by the Automation domain. */
export type AutomationEvent = {
  /** Durable source event identifier. */
  eventId: string
  /** Stable event discriminator such as `work-item.updated`. */
  eventType: string
  /** Workspace that owns the event. */
  workspaceId: string
  /** ISO timestamp at which the event occurred. */
  occurredAt: string
  /** Field changes included in the event. */
  changes: AutomationEventChange[]
  /** Trigger-adapter metadata. */
  metadata?: Record<string, AutomationValue>
  /** Work Item snapshot available to conditions. */
  workItem?: Record<string, AutomationValue>
  /** Rule lineage used to prevent recursive execution. */
  automationRuleLineage?: string[]
}

/** Values available while evaluating an Automation condition tree. */
export type AutomationConditionContext = {
  /** Trigger event being evaluated. */
  event: AutomationEvent
  /** Current Work Item snapshot. */
  workItem?: Record<string, AutomationValue>
  /** Additional application-resolved variables. */
  variables?: Record<string, AutomationValue>
}

/**
 * Tests whether a trigger accepts a transport-neutral Automation event.
 *
 * @param trigger - Rule trigger definition.
 * @param event - Durable trigger event.
 * @returns Whether the event matches the trigger.
 */
export function matchesAutomationTrigger(
  trigger: AutomationTrigger,
  event: AutomationEvent,
): boolean {
  const metadata = event.metadata ?? {}
  switch (trigger.type) {
    case 'status': {
      const change = findChange(event, 'workflowStatusId')
      return Boolean(
        change &&
        (trigger.fromStatusId === undefined || change.before === trigger.fromStatusId) &&
        (trigger.toStatusId === undefined || change.after === trigger.toStatusId),
      )
    }
    case 'assignee': {
      const change = findChange(event, 'assigneeUserId')
      return Boolean(change && (
        trigger.assigneeMemberKey === undefined || change.after === trigger.assigneeMemberKey
      ))
    }
    case 'due': {
      const reason = event.eventType === 'work-item.due'
        ? 'due'
        : event.eventType === 'work-item.overdue'
          ? 'overdue'
          : findChange(event, 'dueDate') ? 'changed' : undefined
      return reason !== undefined && (trigger.reason === undefined || trigger.reason === reason)
    }
    case 'custom-field':
      return event.changes.some((change) =>
        change.field === `customFieldValues.${trigger.fieldId}` ||
        change.field === `customFields.${trigger.fieldId}`
      )
    case 'comment': {
      const commentKind = event.eventType === 'comment.created'
        ? 'comment'
        : event.eventType === 'comment.replied'
          ? 'reply'
          : undefined
      return commentKind !== undefined && (
        trigger.kind === undefined || trigger.kind === 'any' || trigger.kind === commentKind
      )
    }
    case 'form':
      return event.eventType === 'form.submitted' && metadata.formId === trigger.formId
    case 'webhook':
      return event.eventType === 'webhook.received' && metadata.webhookId === trigger.webhookId
    case 'schedule':
      return event.eventType === 'automation.schedule'
  }
}

/**
 * Evaluates a condition tree against event, Work Item, and variable values.
 *
 * @param condition - Condition tree to evaluate.
 * @param context - Values visible to the condition tree.
 * @returns Whether the condition is satisfied.
 */
export function evaluateAutomationCondition(
  condition: AutomationCondition,
  context: AutomationConditionContext,
): boolean {
  if (condition.type === 'all') {
    return condition.conditions.every((child) => evaluateAutomationCondition(child, context))
  }
  if (condition.type === 'any') {
    return condition.conditions.some((child) => evaluateAutomationCondition(child, context))
  }
  if (condition.type === 'not') {
    return !evaluateAutomationCondition(condition.condition, context)
  }
  const actual = readConditionPath(context, condition.field)
  if (
    actual === undefined &&
    condition.operator !== 'exists' &&
    condition.operator !== 'not-exists'
  ) {
    return false
  }
  switch (condition.operator) {
    case 'exists': return actual !== undefined && actual !== null
    case 'not-exists': return actual === undefined || actual === null
    case 'equals': return canonicalString(actual) === canonicalString(condition.value)
    case 'not-equals': return canonicalString(actual) !== canonicalString(condition.value)
    case 'contains': return containsValue(actual, condition.value)
    case 'greater-than': return compareValues(actual, condition.value) > 0
    case 'greater-than-or-equal': return compareValues(actual, condition.value) >= 0
    case 'less-than': return compareValues(actual, condition.value) < 0
    case 'less-than-or-equal': return compareValues(actual, condition.value) <= 0
  }
}

/** Finds a field change by its canonical path. */
function findChange(event: AutomationEvent, field: string): AutomationEventChange | undefined {
  return event.changes.find((change) => change.field === field)
}

/** Resolves a condition path without casting the typed context to untrusted data. */
function readConditionPath(context: AutomationConditionContext, path: string): unknown {
  const [owner, ...parts] = path.split('.')
  const root = owner === 'event'
    ? context.event
    : owner === 'workItem'
      ? context.workItem
      : owner === 'variables'
        ? context.variables
        : undefined
  return parts.reduce<unknown>((value, part) =>
    isRecord(value) ? value[part] : undefined, root)
}

/** Tests containment for the supported scalar and array values. */
function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
  if (Array.isArray(actual)) {
    return actual.some((value) => canonicalString(value) === canonicalString(expected))
  }
  return false
}

/** Compares supported number and string values. */
function compareValues(first: unknown, second: unknown): number {
  if (typeof first === 'number' && typeof second === 'number') return first - second
  if (typeof first === 'string' && typeof second === 'string') return first.localeCompare(second)
  return Number.NaN
}

/** Produces a deterministic representation for JSON-compatible values. */
function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalString(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
