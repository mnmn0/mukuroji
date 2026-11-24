import type {
  AutomationAction,
  AutomationCondition,
  AutomationRuleDryRunActionPlan,
  AutomationRuleDryRunFieldChange,
  AutomationRuleDryRunResult,
  AutomationValue,
  CreateAutomationRuleInput,
} from '@mukuroji/contracts'
import { evaluateAutomationCondition, type AutomationEvent } from './rule-evaluation'

/**
 * Evaluates a rule definition against one Work Item without running any action.
 *
 * A dry run has no trigger event, so it assumes the trigger fired and evaluates the conditions
 * against an empty event. Conditions that read `event.` fields are flagged, because their result
 * depends on the event that will actually start the rule.
 *
 * @param rule - Validated rule definition, saved or not.
 * @param workspaceId - Workspace that owns the Work Item.
 * @param workItem - Canonical Work Item snapshot, as the event consumer hydrates it.
 * @param now - Time the synthetic event occurs at.
 * @returns Whether the rule would run and what each action would do.
 */
export function dryRunAutomationRule(
  rule: CreateAutomationRuleInput,
  workspaceId: string,
  workItem: Record<string, AutomationValue>,
  now = new Date(),
): AutomationRuleDryRunResult {
  const event: AutomationEvent = {
    eventId: 'automation-dry-run',
    eventType: 'automation.dry-run',
    workspaceId,
    occurredAt: now.toISOString(),
    changes: [],
    workItem,
  }
  const conditions = (rule.conditions ?? []).map((condition, index) => ({
    index,
    matched: evaluateAutomationCondition(condition, { event, workItem, variables: {} }),
    readsEventFields: conditionReadsEventFields(condition),
  }))
  const matched = conditions.every((condition) => condition.matched)
  return {
    matched,
    triggerType: rule.trigger.type,
    conditions,
    actions: matched ? planAutomationActions(rule.actions, workItem) : [],
  }
}

/**
 * Plans actions in order, each against the Work Item as the earlier actions would leave it.
 *
 * @param actions - Actions in execution order.
 * @param workItem - Work Item snapshot before the first action.
 * @returns One plan per action.
 */
function planAutomationActions(
  actions: readonly AutomationAction[],
  workItem: Record<string, AutomationValue>,
): AutomationRuleDryRunActionPlan[] {
  let current = { ...workItem }
  return actions.map((action, index) => {
    const plan = planAutomationAction(action, index, current, workItem)
    for (const change of plan.changes ?? []) current = { ...current, [change.field]: change.after }
    return plan
  })
}

/**
 * Describes what one action would do to the Work Item.
 *
 * @param action - Action to describe.
 * @param index - Position of the action in the rule.
 * @param workItem - Current Work Item snapshot.
 * @param triggeredWorkItem - Work Item snapshot when the rule fired, which execution reads the
 * notified assignee from.
 * @returns The action plan.
 */
function planAutomationAction(
  action: AutomationAction,
  index: number,
  workItem: Record<string, AutomationValue>,
  triggeredWorkItem: Record<string, AutomationValue>,
): AutomationRuleDryRunActionPlan {
  switch (action.type) {
    case 'assign':
      return { index, type: action.type, changes: listChanges({ assigneeUserId: action.assigneeMemberKey }, workItem) }
    case 'move':
      return { index, type: action.type, changes: listChanges({ assignedProjectId: action.targetProjectId }, workItem) }
    case 'update':
      return { index, type: action.type, changes: listChanges(action.patch, workItem) }
    case 'notify':
      return { index, type: action.type, recipientMemberKeys: listNotificationRecipients(action, triggeredWorkItem) }
    case 'approval':
      return { index, type: action.type, recipientMemberKeys: [...action.reviewerMemberKeys] }
    case 'webhook':
      return { index, type: action.type, webhookHost: readUrlHost(action.url) }
    case 'create':
    case 'comment':
      return { index, type: action.type }
  }
}

/**
 * Lists who a notify action reaches, with the same rule as execution: its listed keys plus the
 * assignee the Work Item had when the rule fired, when the action asks for it. An earlier assign
 * action in the same rule does not change who is notified.
 *
 * @param action - Notify action.
 * @param workItem - Work Item the action would run for.
 * @returns Distinct recipient member keys.
 */
function listNotificationRecipients(
  action: Extract<AutomationAction, { type: 'notify' }>,
  workItem: Record<string, AutomationValue>,
): string[] {
  const assignee = action.notifyAssignee === true ? workItem.assigneeUserId : undefined
  return [...new Set([
    ...action.recipientMemberKeys,
    ...(typeof assignee === 'string' && assignee.trim() ? [assignee.trim()] : []),
  ])]
}

/**
 * Lists the fields a patch would change, leaving out fields that already hold the value.
 *
 * @param patch - Field values to write.
 * @param workItem - Current Work Item snapshot.
 * @returns Changed fields with their current and new values.
 */
function listChanges(
  patch: Record<string, AutomationValue>,
  workItem: Record<string, AutomationValue>,
): AutomationRuleDryRunFieldChange[] {
  return Object.entries(patch).flatMap(([field, after]) => {
    const before = workItem[field]
    if (canonicalValue(before ?? null) === canonicalValue(after)) return []
    return [before === undefined ? { field, after } : { field, before, after }]
  })
}

/**
 * Reports whether a condition tree reads fields of the trigger event.
 *
 * @param condition - Condition tree.
 * @returns Whether any field condition starts with `event.`.
 */
function conditionReadsEventFields(condition: AutomationCondition): boolean {
  switch (condition.type) {
    case 'field':
      return condition.field.startsWith('event.')
    case 'all':
    case 'any':
      return condition.conditions.some(conditionReadsEventFields)
    case 'not':
      return conditionReadsEventFields(condition.condition)
  }
}

/**
 * Reads the host of a validated HTTPS URL.
 *
 * @param url - Webhook URL.
 * @returns The host, or undefined when the URL cannot be parsed.
 */
function readUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Produces an order-independent representation of a JSON-compatible value.
 *
 * @param value - Value to represent.
 * @returns A string equal for equal values.
 */
function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([first], [second]) => first.localeCompare(second))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
