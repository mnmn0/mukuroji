import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationActionExecution,
  type AutomationExecution,
  type AutomationRule,
} from '@mukuroji/contracts'
import {
  createAutomationActionId,
  createAutomationExecutionId,
} from './execution-identifiers'
import type { AutomationEvent } from './rule-evaluation'

/**
 * Creates the canonical initial execution candidate for a matched rule event.
 *
 * @param rule - Immutable rule version being executed.
 * @param event - Durable trigger event.
 * @param now - Execution start time.
 * @returns A pending execution with deterministic action identifiers.
 */
export function createPendingAutomationExecution(
  rule: AutomationRule,
  event: AutomationEvent,
  now: Date,
): AutomationExecution {
  const id = createAutomationExecutionId(rule, event.eventId)
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    workspaceId: rule.workspaceId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    triggerEventId: event.eventId,
    status: 'pending',
    attempts: 0,
    actions: rule.actions.map((_action, actionIndex) => ({
      actionIndex,
      actionId: createAutomationActionId(id, actionIndex),
      status: 'pending',
      attempts: 0,
    } satisfies AutomationActionExecution)),
    startedAt: now.toISOString(),
    retryable: false,
  }
}
