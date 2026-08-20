/** Automation module public application and domain surface. */
export {
  DynamoDbAutomationClient,
  DynamoDbAutomationRepository,
  type AutomationClient,
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
  createAutomationCommentId,
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
export { createAutomationScheduleShard } from './application/schedule-shard'
export {
  AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES,
  AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX,
  AUTOMATION_INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  createAutomationInboundWebhookSecretId,
  createAutomationInboundWebhookSecretVersionId,
  isAutomationInboundWebhookJsonContentType,
  parseAutomationInboundWebhookJson,
  readAutomationInboundWebhookBody,
  readAutomationInboundWebhookTimestamp,
  verifyAutomationInboundWebhookSignature,
} from './automation-inbound-webhook'
export {
  AUTOMATION_WEBHOOK_SECRET_PREFIX,
  createAutomationWebhookSecretId,
  createAutomationWebhookSignature,
  deliverAutomationWebhook,
  resolveAutomationWebhookAddress,
  sendAutomationWebhookRequest,
  type AutomationWebhookDeliveryDependencies,
  type AutomationWebhookLookup,
  type AutomationWebhookRequest,
  type AutomationWebhookResolvedAddress,
  type AutomationWebhookSecretResolver,
  type AutomationWebhookSender,
} from './automation-webhook'
export {
  type AutomationFeatureEntitlementPort,
} from './application/ports/feature-entitlement-port'
export {
  createAutomationEventProcessor,
  parseAutomationStreamRecord,
  processAutomationEventBatch,
  type AutomationEventPort,
  type AutomationEventProcessor,
  type AutomationWorkItemReader,
  type BatchResponse,
  type DynamoStreamEvent,
} from './adapter-in/events/automation-event'
export {
  processAutomationSchedule,
  processDueAutomationExecution,
  processInboundWebhookSecretCleanup,
  processRecurringWorkDefinition,
  processScheduledAutomationRule,
  resolveAutomationScheduleProcessingTime,
  type AutomationScheduleDependencies,
  type AutomationScheduleEvent,
  type AutomationSchedulePort,
} from './adapter-in/schedules/automation-schedule'
