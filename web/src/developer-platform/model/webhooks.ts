import type {
  ApiScope,
  CreateWebhookSubscriptionInput,
  WebhookEventType,
  WebhookSubscriptionSecretOutput,
} from '@mukuroji/contracts'

/**
 * Event type supported by Developer Platform webhook subscriptions.
 */
export type DeveloperWebhookEventType = WebhookEventType

/**
 * Form value used to create a webhook subscription.
 */
export type CreateDeveloperWebhookInput =
  Omit<CreateWebhookSubscriptionInput, 'scopes'> & {
    /** Payload scopes granted to the subscription. */
    scopes: ApiScope[]
  }

/**
 * Webhook subscription metadata paired with its one-time signing secret.
 */
export type IssuedWebhookSigningSecret =
  WebhookSubscriptionSecretOutput
