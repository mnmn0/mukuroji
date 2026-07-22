import type {
  ApiKeyPort,
  ConnectorPort,
  ExternalLinkPort,
  IdempotencyPort,
  ImportPort,
  OAuthCredentialPort,
  RateLimitPort,
  WebhookDeliveryPort,
  WebhookSubscriptionPort,
} from './ports'

/** Capability-focused Developer Platform ports supplied to application consumers. */
export type DeveloperPlatformPorts = {
  /** API key lifecycle and authentication port. */
  apiKeys: ApiKeyPort
  /** OAuth application and token credential port. */
  oauthCredentials: OAuthCredentialPort
  /** Webhook subscription lifecycle port. */
  webhookSubscriptions: WebhookSubscriptionPort
  /** Webhook delivery persistence and worker port. */
  webhookDeliveries: WebhookDeliveryPort
  /** Connector installation and credential lifecycle port. */
  connectors: ConnectorPort
  /** External Work Item link lifecycle port. */
  externalLinks: ExternalLinkPort
  /** Import job metadata port. */
  imports: ImportPort
  /** Idempotency reservation and replay port. */
  idempotency: IdempotencyPort
  /** Credential-scoped rate-limit port. */
  rateLimits: RateLimitPort
}
