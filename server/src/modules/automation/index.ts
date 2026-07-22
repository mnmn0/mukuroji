/** Automation module public application and domain surface. */
export {
  DynamoDbAutomationClient,
  DynamoDbAutomationRepository,
  type AutomationClient,
  type DynamoDbAutomationTransactionItem,
} from './adapter-out/dynamodb/automation-repository'
export { normalizeAutomationActionFailure } from './application/action-failure'
export { AutomationEngine } from './application/execution-service'
export { toAutomationInboundWebhookEndpoint } from './application/inbound-webhook-view'
export {
  AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS,
} from './application/template-application-policy'
export {
  applyBulkOperation,
  createBulkOperationToken,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from './application/bulk-operation-service'
export {
  type AutomationActionExecutionContext,
  type AutomationActionExecutor,
  type AutomationBulkOperationPort,
  type AutomationExecutionClaimToken,
  type AutomationExecutionDefinitionGuard,
  type AutomationExecutionDefinitionReader,
  type AutomationExecutionPage,
  type AutomationExecutionPort,
  type AutomationExecutionQuery,
  type AutomationExecutionReservation,
  type AutomationExecutionServicePort,
  type AutomationInboundWebhookDeliveryInput,
  type AutomationInboundWebhookDeliveryResult,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookPort,
  type AutomationInboundWebhookProvisioning,
  type AutomationInboundWebhookProvisioningOperation,
  type AutomationInboundWebhookSecretCleanup,
  type AutomationInboundWebhookSecretReference,
  type AutomationInboundWebhookSecretStore,
  type AutomationRecurringSchedulePort,
  type AutomationRepository,
  type AutomationRuleTemplatePort,
  type BulkItemApplyResult,
  type BulkItemPreviewResult,
  type BulkOperationAdapter,
} from './application/ports'
export {
  SecretsManagerAutomationInboundWebhookSecretStore,
} from './adapter-out/secrets-manager/inbound-webhook-secret-store'
export {
  AutomationError,
  type AutomationErrorCategory,
} from './domain/automation-error'
export { isAutomationValue } from './domain/automation-value'
export {
  validateApplyAutomationTemplateInput,
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
} from './domain/management-validation'
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
export { createAutomationScheduleShard } from './domain/schedule-shard'
