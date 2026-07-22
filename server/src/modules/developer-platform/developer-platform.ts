/**
 * Compatibility exports for tests and transitional consumers.
 *
 * Production application code should import focused ports or adapter factories directly.
 */
export * from './adapter-out/shared/developer-platform-store'
export {
  DynamoDbDeveloperPlatformStorage as DynamoDbDeveloperPlatformClient,
  InMemoryDeveloperPlatformStorage as InMemoryDeveloperPlatformClient,
} from './adapter-out/shared/developer-platform-store'
export { API_SCOPES } from './domain/credential-policy'
export { WEBHOOK_MAX_ATTEMPTS } from './domain/webhook-policy'
export { createWebhookSignature } from './domain/webhook-signature'
export { DeveloperPlatformError } from './errors'
export type {
  ApiKeyPort,
  ConnectorPort,
  ExternalLinkPort,
  IdempotencyPort,
  ImportPort,
  OAuthCredentialPort,
  RateLimitPort,
  WebhookDeliveryPort,
  WebhookSubscriptionPort,
} from './application/ports'
export type * from './application/ports'
export type { DeveloperPlatformPorts } from './application/developer-platform-ports'
