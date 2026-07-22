/**
 * Compatibility surface for the Automation module.
 *
 * New code should import pure domain behavior, application ports, and concrete
 * adapters from their owned layers through the module index.
 */
export * from './adapter-out/dynamodb/automation-repository'
export { AutomationEngine } from './application/execution-service'
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
} from './domain/execution-identifiers'
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
export { createPendingAutomationExecution } from './domain/pending-execution'
