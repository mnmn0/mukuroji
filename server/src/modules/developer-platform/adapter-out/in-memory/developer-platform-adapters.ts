import type { DeveloperPlatformPorts } from '../../application/developer-platform-ports'
import type { SecretProtector } from '../../application/ports'
import { ConnectorAdapter, ExternalLinkAdapter } from '../shared/connector-adapters'
import { ApiKeyAdapter, OAuthCredentialAdapter } from '../shared/credential-adapters'
import {
  InMemoryDeveloperPlatformStorage,
  LocalAesGcmSecretProtector,
} from '../shared/developer-platform-store'
import { ImportAdapter } from '../shared/import-adapter'
import {
  IdempotencyAdapter,
  RateLimitAdapter,
} from '../shared/request-control-adapters'
import {
  WebhookDeliveryAdapter,
  WebhookSubscriptionAdapter,
} from '../shared/webhook-adapters'
import type { DeveloperPlatformTransactionPort } from '../dynamodb/developer-platform-transaction-port'

/** In-memory Developer Platform adapter bundle used by tests and local runtime. */
export type InMemoryDeveloperPlatformAdapters = DeveloperPlatformPorts & {
  /** Empty transaction contribution port retained for composition parity. */
  transactions: DeveloperPlatformTransactionPort
}

/** Options used to create capability-focused in-memory adapters. */
export type InMemoryDeveloperPlatformAdapterOptions = {
  /** Secret protector used by credential, Webhook, and cursor persistence. */
  secretProtector?: SecretProtector
  /** Injectable clock used by deterministic tests. */
  clock?: () => Date
}

/**
 * Creates an isolated in-memory backing store and focused capability adapters.
 *
 * @param options - Optional encryption, clock, and migration dependencies.
 * @returns Independently injectable in-memory capability ports.
 */
export function createInMemoryDeveloperPlatformAdapters(
  options: InMemoryDeveloperPlatformAdapterOptions = {},
): InMemoryDeveloperPlatformAdapters {
  const source = new InMemoryDeveloperPlatformStorage(
    options.secretProtector ?? new LocalAesGcmSecretProtector(),
    options.clock,
  )
  return {
    apiKeys: new ApiKeyAdapter(source),
    oauthCredentials: new OAuthCredentialAdapter(source),
    webhookSubscriptions: new WebhookSubscriptionAdapter(source),
    webhookDeliveries: new WebhookDeliveryAdapter(source),
    connectors: new ConnectorAdapter(source),
    externalLinks: new ExternalLinkAdapter(source),
    imports: new ImportAdapter(source),
    idempotency: new IdempotencyAdapter(source),
    rateLimits: new RateLimitAdapter(source),
    transactions: {},
  }
}
