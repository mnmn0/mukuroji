import type { DeveloperPlatformPorts } from '../../application/developer-platform-ports'
import { ConnectorAdapter, ExternalLinkAdapter } from '../shared/connector-adapters'
import { ApiKeyAdapter, OAuthCredentialAdapter } from '../shared/credential-adapters'
import { DynamoDbDeveloperPlatformStorage } from '../shared/developer-platform-store'
import { ImportAdapter } from '../shared/import-adapter'
import {
  IdempotencyAdapter,
  RateLimitAdapter,
} from '../shared/request-control-adapters'
import {
  WebhookDeliveryAdapter,
  WebhookSubscriptionAdapter,
} from '../shared/webhook-adapters'
import {
  projectDeveloperPlatformTransactionPort,
  type DeveloperPlatformTransactionPort,
} from './developer-platform-transaction-port'

/** Production Developer Platform adapter bundle. */
export type DynamoDbDeveloperPlatformAdapters = DeveloperPlatformPorts & {
  /** DynamoDB-specific transaction contributions used by Work Item persistence. */
  transactions: DeveloperPlatformTransactionPort
}

/**
 * Creates one DynamoDB backing store and focused capability adapters.
 *
 * @returns Independently injectable production ports sharing one compatible table schema.
 */
export function createDynamoDbDeveloperPlatformAdapters(): DynamoDbDeveloperPlatformAdapters {
  const source = new DynamoDbDeveloperPlatformStorage()
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
    transactions: projectDeveloperPlatformTransactionPort(source),
  }
}
