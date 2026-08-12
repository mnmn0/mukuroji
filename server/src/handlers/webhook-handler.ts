import {
  createProductionWebhookDeliveryHandler,
} from '../app/composition/webhook'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import type {
  WebhookSqsEvent,
} from '../modules/developer-platform/adapter-in/events/webhook-processing'

let productionDeliveryHandler:
  | ReturnType<typeof createProductionWebhookDeliveryHandler>
  | undefined

/**
 * Processes one admitted Webhook delivery SQS batch.
 *
 * @param event - Durable Webhook delivery queue batch.
 * @returns Partial-batch failures for retryable deliveries.
 */
async function processWebhookDelivery(event: WebhookSqsEvent) {
  productionDeliveryHandler ??= createProductionWebhookDeliveryHandler()
  return await productionDeliveryHandler(event)
}

/**
 * Runtime-control guarded Webhook delivery SQS entrypoint.
 *
 * @param event - Durable Webhook delivery queue batch.
 * @returns Partial-batch failures for retryable deliveries.
 */
export const deliveryHandler = createRuntimeControlGuardedHandler(
  'webhook-delivery',
  processWebhookDelivery,
)

export * from '../modules/developer-platform/adapter-in/events/webhook-processing'
