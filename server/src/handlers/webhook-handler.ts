import {
  createProductionWebhookDeliveryHandler,
} from '../app/composition/webhook'
import type {
  WebhookSqsEvent,
} from '../modules/developer-platform/adapter-in/events/webhook-processing'

let productionDeliveryHandler:
  | ReturnType<typeof createProductionWebhookDeliveryHandler>
  | undefined

/** Webhook projection/delivery SQS batch を処理します。 */
export async function deliveryHandler(event: WebhookSqsEvent) {
  productionDeliveryHandler ??= createProductionWebhookDeliveryHandler()
  return await productionDeliveryHandler(event)
}

export * from '../modules/developer-platform/adapter-in/events/webhook-processing'
