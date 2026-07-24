import type { AutomationInboundWebhookEndpoint } from '@mukuroji/contracts'
import type { AutomationInboundWebhookEndpointRecord } from './ports'

/**
 * Removes server-only secret and provisioning metadata from an endpoint record.
 *
 * @param endpoint - Internal endpoint record.
 * @returns Public endpoint view.
 */
export function toAutomationInboundWebhookEndpoint(
  endpoint: AutomationInboundWebhookEndpointRecord,
): AutomationInboundWebhookEndpoint {
  const {
    secretId: _secretId,
    secretVersionId: _secretVersionId,
    provisioningOperationId: _provisioningOperationId,
    provisioningTargetStatus: _provisioningTargetStatus,
    ...publicEndpoint
  } = endpoint
  return publicEndpoint
}
