import type {
  ApiScope,
  WebhookSubscription,
} from '@mukuroji/contracts'

/**
 * Event type supported by Developer Platform webhook subscriptions.
 */
export type DeveloperWebhookEventType =
  WebhookSubscription['eventTypes'][number]

/**
 * Form value used to create a webhook subscription.
 */
export type CreateDeveloperWebhookInput = {
  /** Human-readable subscription name. */
  name: string
  /** HTTPS delivery endpoint. */
  url: string
  /** Team identifiers whose events may be delivered. */
  teamIds: string[]
  /** Event types delivered to the endpoint. */
  eventTypes: DeveloperWebhookEventType[]
  /** Payload scopes granted to the subscription. */
  scopes: ApiScope[]
}

/**
 * Webhook subscription metadata paired with its one-time signing secret.
 */
export type IssuedWebhookSigningSecret = {
  /** Metadata for the issued webhook subscription. */
  subscription: WebhookSubscription
  /** Signing secret that is shown only once. */
  signingSecret: string
}
