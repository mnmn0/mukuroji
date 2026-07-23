import { describe, expect, test } from 'bun:test'
import { createDynamoDbDeveloperPlatformAdapters } from './dynamodb/developer-platform-adapters'
import { createInMemoryDeveloperPlatformAdapters } from './in-memory/developer-platform-adapters'

const expectedCapabilityMethods = {
  apiKeys: [
    'authenticateApiKey',
    'createApiKey',
    'listApiKeys',
    'revokeApiKey',
    'rotateApiKey',
  ],
  oauthCredentials: [
    'authenticateOAuthToken',
    'createOAuthApp',
    'issueOAuthToken',
    'listOAuthApps',
    'revokeOAuthApp',
    'rotateOAuthClientSecret',
  ],
  webhookSubscriptions: [
    'createWebhookSubscription',
    'listActiveWebhookSubscriptionsPage',
    'listWebhookSubscriptions',
    'rotateWebhookSecret',
    'setWebhookSubscriptionStatus',
    'updateWebhookSubscription',
    'verifyWebhookSignature',
  ],
  webhookDeliveries: [
    'enqueueWebhookEvent',
    'getWebhookDelivery',
    'listWebhookDeliveries',
    'prepareWebhookDelivery',
    'recordWebhookDeliveryAttempt',
    'replayWebhookDelivery',
  ],
  connectors: [
    'assertConnectorReauthorizationState',
    'claimConnectorCredentialRefresh',
    'installConnector',
    'listConnectors',
    'readConnectorCredential',
    'readConnectorLifecycleSnapshot',
    'recoverConnector',
    'releaseConnectorCredentialRefresh',
    'updateConnectorStatus',
  ],
  externalLinks: [
    'createExternalWorkItemLink',
    'deleteExternalWorkItemLink',
    'listExternalWorkItemLinks',
    'pauseConnectorExternalLinksPage',
    'updateExternalWorkItemLink',
  ],
  imports: ['createImportJob', 'listImportJobs', 'updateImportJob'],
  idempotency: [
    'completeIdempotency',
    'releaseIdempotency',
    'reserveIdempotency',
  ],
  rateLimits: ['consumeRateLimit'],
}

describe('Developer Platform focused adapter contract', () => {
  for (const [adapterName, createAdapters] of [
    ['in-memory', createInMemoryDeveloperPlatformAdapters],
    ['dynamodb', createDynamoDbDeveloperPlatformAdapters],
  ] as const) {
    test(`${adapterName} adapters expose only their owned capability methods`, () => {
      const adapters = createAdapters()
      for (const [adapter, expectedMethods] of [
        [adapters.apiKeys, expectedCapabilityMethods.apiKeys],
        [adapters.oauthCredentials, expectedCapabilityMethods.oauthCredentials],
        [adapters.webhookSubscriptions, expectedCapabilityMethods.webhookSubscriptions],
        [adapters.webhookDeliveries, expectedCapabilityMethods.webhookDeliveries],
        [adapters.connectors, expectedCapabilityMethods.connectors],
        [adapters.externalLinks, expectedCapabilityMethods.externalLinks],
        [adapters.imports, expectedCapabilityMethods.imports],
        [adapters.idempotency, expectedCapabilityMethods.idempotency],
        [adapters.rateLimits, expectedCapabilityMethods.rateLimits],
      ] as const) {
        expect(
          Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))
            .filter((property) => property !== 'constructor')
            .sort(),
        ).toEqual(expectedMethods)
        expect(Object.keys(adapter)).toEqual([])
      }
    })
  }

  test('in-memory connector and external-link ports share one compatible backing store', async () => {
    const adapters = createInMemoryDeveloperPlatformAdapters({
      clock: () => new Date('2026-07-22T00:00:00.000Z'),
    })
    const connector = await adapters.connectors.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub',
        scopes: ['issues:read'],
        credential: 'connector-contract-secret',
      },
    })
    const link = await adapters.externalLinks.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: connector.id,
        resourceType: 'issue',
        externalId: 'issue-1',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/71',
        syncDirection: 'bidirectional',
      },
    })

    await expect(adapters.externalLinks.listExternalWorkItemLinks({
      workspaceId: 'workspace-1',
      installationId: connector.id,
    })).resolves.toEqual([link])
  })
})
