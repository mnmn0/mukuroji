import type {
  AutomationExecution,
  AutomationRule,
} from '@mukuroji/contracts'
import {
  AutomationEngine as FocusedAutomationEngine,
} from './application/execution-service'
import type {
  AutomationActionExecutor,
  AutomationExecutionClaimToken,
  AutomationExecutionDefinitionGuard,
  AutomationExecutionQuery,
  AutomationExecutionServicePort,
} from './application/ports'
import type { AutomationClient } from './adapter-out/dynamodb/automation-repository'
import { AutomationError } from './domain/automation-error'
import type { AutomationEvent } from './domain/rule-evaluation'

/**
 * Compatibility surface for the Automation module.
 *
 * New code should import pure domain behavior, application ports, and concrete
 * adapters from their owned layers through the module index.
 */
export * from './adapter-out/dynamodb/automation-repository'
export {
  applyBulkOperation,
  createBulkOperationToken,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from './application/bulk-operation-service'
export {
  AutomationError,
  type AutomationErrorCategory,
} from './domain/automation-error'
export { isAutomationValue } from './domain/automation-value'
export {
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
} from './application/execution-identifiers'
export {
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  selectCatchUpOccurrences,
  validateRecurringSchedule,
} from './domain/recurring-schedule'
export {
  evaluateAutomationCondition,
  matchesAutomationTrigger,
  type AutomationConditionContext,
  type AutomationEvent,
  type AutomationEventChange,
} from './domain/rule-evaluation'
export { validateCreateAutomationRuleInput } from './domain/rule-validation'
export { createPendingAutomationExecution } from './application/pending-execution'

/** Adapts the legacy all-capability client to the focused execution service port. */
class LegacyAutomationExecutionServiceAdapter
implements AutomationExecutionServicePort {
  /** Legacy all-capability Automation client. */
  private readonly client: AutomationClient

  /**
   * Creates a focused execution adapter over a legacy client.
   *
   * @param client - Legacy Automation persistence client.
   */
  constructor(client: AutomationClient) {
    this.client = client
  }

  /** Delegates due execution reads to the legacy client. */
  async listDueExecutions(scheduleShard: string, dueAt: string, limit?: number) {
    return await this.client.listDueExecutions(scheduleShard, dueAt, limit)
  }

  /** Converts a focused reservation into the legacy rule/event/time call. */
  async reserveExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ) {
    return await this.client.reserveExecution(
      rule,
      event,
      readLegacyAutomationExecutionStartTime(execution.startedAt),
    )
  }

  /** Delegates deterministic execution creation to the legacy client. */
  async createExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ) {
    return await this.client.createExecution(execution, event, definitionGuard)
  }

  /** Delegates execution reads to the legacy client. */
  async getExecution(workspaceId: string, executionId: string) {
    return await this.client.getExecution(workspaceId, executionId)
  }

  /** Delegates stored trigger event reads to the legacy client. */
  async getExecutionEvent(workspaceId: string, executionId: string) {
    return await this.client.getExecutionEvent(workspaceId, executionId)
  }

  /** Delegates fenced runner claims to the legacy client. */
  async claimExecution(
    execution: AutomationExecution,
    now: Date,
    leaseExpiresAt: string,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ) {
    return await this.client.claimExecution(
      execution,
      now,
      leaseExpiresAt,
      definitionGuard,
    )
  }

  /** Delegates fenced execution saves to the legacy client. */
  async saveExecution(
    execution: AutomationExecution,
    claimToken: AutomationExecutionClaimToken,
    now: Date,
  ) {
    return await this.client.saveExecution(execution, claimToken, now)
  }

  /** Delegates execution timeline queries to the legacy client. */
  async listExecutions(query: AutomationExecutionQuery) {
    return await this.client.listExecutions(query)
  }

  /** Delegates successful action receipt reads to the legacy client. */
  async hasActionReceipt(
    workspaceId: string,
    executionId: string,
    actionId: string,
  ) {
    return await this.client.hasActionReceipt(workspaceId, executionId, actionId)
  }

  /** Delegates successful action receipt writes to the legacy client. */
  async putActionReceipt(
    workspaceId: string,
    executionId: string,
    actionId: string,
  ) {
    return await this.client.putActionReceipt(workspaceId, executionId, actionId)
  }

  /** Delegates immutable rule version reads to the legacy client. */
  async getRuleVersion(workspaceId: string, ruleId: string, version: number) {
    return await this.client.getRuleVersion(workspaceId, ruleId, version)
  }

  /** Delegates current recurring definition reads to the legacy client. */
  async getRecurringWork(workspaceId: string, recurringWorkId: string) {
    return await this.client.getRecurringWork(workspaceId, recurringWorkId)
  }
}

/**
 * Reads the canonical execution start time used by the legacy reservation API.
 *
 * @param startedAt - Stored ISO execution start time.
 * @returns A valid Date for the legacy client call.
 */
function readLegacyAutomationExecutionStartTime(startedAt: string): Date {
  const value = new Date(startedAt)
  if (Number.isNaN(value.getTime())) {
    throw new AutomationError(
      'unavailable',
      'AutomationExecutionStartedAtInvalid',
      'Automation execution start time is invalid.',
    )
  }
  return value
}

/**
 * Backward-compatible Automation execution engine.
 *
 * @deprecated New code should import the focused `AutomationEngine` from the
 * Automation module index.
 */
export class AutomationEngine extends FocusedAutomationEngine {
  /**
   * Creates an execution engine over the legacy all-capability client.
   *
   * @param client - Legacy Automation persistence client.
   * @param actionExecutor - Side-effect executor for Automation actions.
   */
  constructor(
    client: AutomationClient,
    actionExecutor: AutomationActionExecutor,
  ) {
    super(
      new LegacyAutomationExecutionServiceAdapter(client),
      actionExecutor,
    )
  }
}
