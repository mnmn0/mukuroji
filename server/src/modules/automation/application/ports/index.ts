export {
  type AutomationBulkOperationPort,
  type BulkItemApplyResult,
  type BulkItemPreviewResult,
  type BulkOperationAdapter,
} from './bulk-operation-port'
export {
  type AutomationActionExecutionContext,
  type AutomationActionExecutor,
  type AutomationExecutionClaimToken,
  type AutomationExecutionDefinitionGuard,
  type AutomationExecutionDefinitionReader,
  type AutomationExecutionPage,
  type AutomationExecutionPort,
  type AutomationExecutionQuery,
  type AutomationExecutionReservation,
  type AutomationExecutionServicePort,
  type AutomationExecutionVariables,
} from './execution-port'
export { type AutomationFeatureEntitlementPort } from './feature-entitlement-port'
export {
  type AutomationInboundWebhookDeliveryInput,
  type AutomationInboundWebhookDeliveryResult,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookPort,
  type AutomationInboundWebhookProvisioning,
  type AutomationInboundWebhookProvisioningOperation,
  type AutomationInboundWebhookSecretCleanup,
} from './inbound-webhook-port'
export {
  type AutomationInboundWebhookSecretReference,
  type AutomationInboundWebhookSecretStore,
} from './inbound-webhook-secret-store'
export { type AutomationRecurringSchedulePort } from './recurring-schedule-port'
export { type AutomationRuleTemplatePort } from './rule-template-port'

import type { AutomationBulkOperationPort } from './bulk-operation-port'
import type { AutomationExecutionPort } from './execution-port'
import type { AutomationInboundWebhookPort } from './inbound-webhook-port'
import type { AutomationRecurringSchedulePort } from './recurring-schedule-port'
import type { AutomationRuleTemplatePort } from './rule-template-port'

/**
 * Composition-root view of a repository that implements every Automation capability.
 *
 * Application and inbound adapters should depend on the focused capability interfaces
 * above instead of this assembly type.
 */
export type AutomationRepository<
  TCompletionMutation = unknown,
  TAuditMutation = unknown,
> =
  AutomationRuleTemplatePort<TCompletionMutation> &
  AutomationInboundWebhookPort<TAuditMutation> &
  AutomationRecurringSchedulePort &
  AutomationExecutionPort &
  AutomationBulkOperationPort
