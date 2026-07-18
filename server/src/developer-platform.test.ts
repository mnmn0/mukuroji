import { describe, expect, test } from 'bun:test'
import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type { ApiProblem, WebhookEventEnvelope } from '@mukuroji/contracts'
import {
  DeveloperPlatformError,
  DynamoDbDeveloperPlatformClient,
  EXTERNAL_LINK_INSTALLATION_LIMIT,
  EXTERNAL_LINK_WORK_ITEM_LIMIT,
  IDEMPOTENCY_MAX_RESPONSE_BYTES,
  InMemoryDeveloperPlatformClient,
  KmsEnvelopeSecretProtector,
  LocalAesGcmSecretProtector,
  WEBHOOK_DISABLED_SUBSCRIPTION_RETENTION_SECONDS,
  WEBHOOK_DELIVERY_RETENTION_SECONDS,
  WEBHOOK_SUBSCRIPTION_LIMIT,
  createWebhookSignature,
} from './developer-platform'

const START = new Date('2026-07-18T00:00:00.000Z')

function createClock() {
  let current = new Date(START)
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current = new Date(current.getTime() + seconds * 1_000)
    },
  }
}

function createClient() {
  const clock = createClock()
  const client = new InMemoryDeveloperPlatformClient(
    new LocalAesGcmSecretProtector(new Uint8Array(32).fill(7)),
    clock.now,
  )
  return { client, clock }
}

/** Lookup GSI の伝播遅延を再現する memory client です。 */
class LaggingLookupDeveloperPlatformClient extends InMemoryDeveloperPlatformClient {
  /** GSI propagation lag を再現し、authoritative rows だけを保持します。 */
  protected override async queryLookupIndex() {
    return { locators: [] }
  }
}

function createProblem(detail: string): ApiProblem {
  return {
    type: 'https://mukuroji.example/problems/provider',
    title: 'Provider error',
    status: 503,
    code: 'temporarily_unavailable',
    detail,
    requestId: 'request-provider',
    retryable: true,
  }
}

function createWebhookEvent(
  id: string,
  workspaceId = 'workspace-1',
): WebhookEventEnvelope {
  return {
    id,
    type: 'work-item.updated',
    apiVersion: '2026-07-01',
    occurredAt: START.toISOString(),
    workspaceId,
    data: {
      metadata: { teamId: 'team-1' },
      workItemId: 'work-item-1',
      revision: 2,
    },
  }
}

function readStoredRows(client: InMemoryDeveloperPlatformClient) {
  const records = (
    client as unknown as {
      records: Map<string, Record<string, unknown>>
    }
  ).records
  return [...records.values()]
}

function createMemoryDocumentClient() {
  const items = new Map<string, Record<string, unknown>>()
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      const input = command.input
      const commandName = command.constructor.name
      commands.push({ name: commandName, input: structuredClone(input) })
      if (commandName === 'GetCommand') {
        const key = input.Key as { workspaceId: string; recordKey: string }
        return { Item: structuredClone(items.get(`${key.workspaceId}\0${key.recordKey}`)) }
      }
      if (commandName === 'PutCommand') {
        const item = input.Item as Record<string, unknown>
        const mapKey = `${String(item.workspaceId)}\0${String(item.recordKey)}`
        const current = items.get(mapKey)
        const condition = input.ConditionExpression
        if (
          condition === 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' &&
          current
        ) {
          const error = new Error('condition failed')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        if (
          condition === '#version = :expectedVersion' &&
          current?.version !== (
            input.ExpressionAttributeValues as Record<string, unknown>
          )[':expectedVersion']
        ) {
          const error = new Error('condition failed')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        items.set(mapKey, structuredClone(item))
        return {}
      }
      if (commandName === 'QueryCommand') {
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        const all = [...items.values()]
        const matching = (input.IndexName
          ? all.filter((item) => item.lookupKey === values[':lookupKey'])
          : all.filter((item) =>
              item.workspaceId === values[':workspaceId'] &&
              String(item.recordKey).startsWith(String(values[':recordKeyPrefix']))
            )
        ).sort((left, right) => {
          const leftKey = String(
            input.IndexName ? left.lookupSortKey : left.recordKey,
          )
          const rightKey = String(
            input.IndexName ? right.lookupSortKey : right.recordKey,
          )
          const comparison = leftKey.localeCompare(rightKey)
          return input.ScanIndexForward === false ? -comparison : comparison
        })
        const exclusiveStartKey = input.ExclusiveStartKey as
          | Record<string, unknown>
          | undefined
        const remaining = exclusiveStartKey
          ? matching.filter((item) => {
              const comparison = String(
                input.IndexName ? item.lookupSortKey : item.recordKey,
              ).localeCompare(String(
                input.IndexName
                  ? exclusiveStartKey.lookupSortKey
                  : exclusiveStartKey.recordKey,
              ))
              return input.ScanIndexForward === false ? comparison < 0 : comparison > 0
            })
          : matching
        const limit = typeof input.Limit === 'number' ? input.Limit : remaining.length
        const selected = remaining.slice(0, limit)
        const last = selected.at(-1)
        return {
          Items: selected.map((item) => structuredClone(item)),
          ...(last && remaining.length > selected.length
            ? {
                LastEvaluatedKey: {
                  workspaceId: last.workspaceId,
                  recordKey: last.recordKey,
                  lookupKey: last.lookupKey,
                  lookupSortKey: last.lookupSortKey,
                },
              }
            : {}),
        }
      }
      if (commandName === 'DeleteCommand') {
        const key = input.Key as { workspaceId: string; recordKey: string }
        const mapKey = `${key.workspaceId}\0${key.recordKey}`
        const current = items.get(mapKey)
        const expectedVersion = (
          input.ExpressionAttributeValues as Record<string, unknown> | undefined
        )?.[':expectedVersion']
        if (expectedVersion !== undefined && current?.version !== expectedVersion) {
          const error = new Error('condition failed')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        items.delete(mapKey)
        return {}
      }
      if (commandName === 'TransactWriteCommand') {
        const transactItems = input.TransactItems as Array<{
          ConditionCheck?: {
            Key: { workspaceId: string; recordKey: string }
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Delete?: {
            Key: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Put?: {
            Item: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Update?: {
            TableName?: string
            Key: { workspaceId: string; recordKey: string }
            UpdateExpression: string
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
        }>
        if (transactItems.some(({ ConditionCheck, Delete, Put, Update }) => {
          if (ConditionCheck) {
            const current = items.get(
              `${ConditionCheck.Key.workspaceId}\0${ConditionCheck.Key.recordKey}`,
            )
            const currentValue = current?.value as Record<string, unknown> | undefined
            const expectedStatus =
              ConditionCheck.ExpressionAttributeValues?.[':expectedStatus'] ??
              ConditionCheck.ExpressionAttributeValues?.[':connected']
            return current?.version !==
                ConditionCheck.ExpressionAttributeValues?.[':expectedVersion'] ||
              (
                expectedStatus !== undefined &&
                currentValue?.status !== expectedStatus
              )
          }
          if (Delete) {
            const workspaceId = Delete.Key.workspaceId
            const recordKey = Delete.Key.recordKey
            if (
              typeof workspaceId !== 'string' ||
              typeof recordKey !== 'string' ||
              !Delete.ConditionExpression
            ) return false
            const current = items.get(`${workspaceId}\0${recordKey}`)
            const currentValue = current?.value as Record<string, unknown> | undefined
            const expectedTarget =
              Delete.ExpressionAttributeValues?.[':targetRecordKey']
            if (expectedTarget !== undefined) {
              const expectedEntryType =
                Delete.ExpressionAttributeValues?.[':claimEntryType'] ??
                Delete.ExpressionAttributeValues?.[':indexEntryType']
              return current?.entryType !==
                  expectedEntryType ||
                currentValue?.targetRecordKey !== expectedTarget
            }
            const expectedAuthVersion =
              Delete.ExpressionAttributeValues?.[':expectedAuthVersion']
            if (expectedAuthVersion !== undefined) {
              return current !== undefined &&
                (
                  current.version !== expectedAuthVersion ||
                  current.entryType !==
                    Delete.ExpressionAttributeValues?.[':authEntryType']
                )
            }
            const recordEntryType =
              Delete.ExpressionAttributeValues?.[':recordEntryType']
            if (recordEntryType !== undefined) {
              return current !== undefined && current.entryType !== recordEntryType
            }
            const expectedRecordVersion =
              Delete.ExpressionAttributeValues?.[':expectedRecordVersion']
            if (expectedRecordVersion !== undefined) {
              return current?.version !== expectedRecordVersion
            }
            const expectedVersion =
              Delete.ExpressionAttributeValues?.[':expectedVersion']
            if (expectedVersion !== undefined) {
              return current?.version !== expectedVersion ||
                current?.entryType !==
                  Delete.ExpressionAttributeValues?.[':linkEntryType'] ||
                currentValue?.syncStatus ===
                  Delete.ExpressionAttributeValues?.[':conflict']
            }
            return false
          }
          if (Update) {
            if (Update.TableName !== 'DeveloperPlatformTable') return false
            const current = items.get(
              `${Update.Key.workspaceId}\0${Update.Key.recordKey}`,
            )
            const currentValue = current?.value as Record<string, unknown> | undefined
            const values = Update.ExpressionAttributeValues ?? {}
            if (values[':entryType'] === 'work-item-link-fence') {
              if (!current) return false
              return current.entryType !== 'work-item-link-fence' ||
                currentValue?.teamId !== values[':teamId'] ||
                currentValue?.workItemId !== values[':workItemId'] ||
                currentValue?.deletedAt !== undefined ||
                (values[':limit'] !== undefined &&
                  Number(current.activeLinkCount ?? 0) >= Number(values[':limit'])) ||
                (Update.UpdateExpression.includes('activeLinkCount -') &&
                  Number(current.activeLinkCount ?? 0) < 1)
            }
            if (values[':entryType'] === 'webhook-subscription-quota') {
              const subscriptionCount = Number(current?.subscriptionCount ?? 0)
              if (Update.UpdateExpression.includes('subscriptionCount -')) {
                return current?.entryType !== 'webhook-subscription-quota' ||
                  currentValue?.limit !== values[':limit'] ||
                  subscriptionCount < Number(values[':one'])
              }
              return current !== undefined &&
                (
                  current.entryType !== 'webhook-subscription-quota' ||
                  currentValue?.limit !== values[':limit'] ||
                  subscriptionCount >= Number(values[':limit'])
                )
            }
            if (values[':entryType'] === 'webhook-subscription') {
              return current?.entryType !== 'webhook-subscription'
            }
            if (values[':entryType'] === 'connector-installation') {
              if (current?.entryType !== 'connector-installation') return true
              if (
                values[':connected'] !== undefined &&
                currentValue?.status !== values[':connected']
              ) return true
              const count = Number(current.externalLinkCount ?? 0)
              return values[':limit'] !== undefined
                ? count >= Number(values[':limit'])
                : count < Number(values[':one'])
            }
            if (values[':entryType'] === 'connector-poll-target') {
              if (!current) return values[':zero'] === undefined
              const count = Number(current.pollableLinkCount ?? 0)
              return current.entryType !== 'connector-poll-target' ||
                currentValue?.installationId !== values[':installationId'] ||
                currentValue?.resourceType !== values[':resourceType'] ||
                (
                  Update.UpdateExpression.includes('pollableLinkCount -') &&
                  count < Number(values[':one'])
                )
            }
            return true
          }
          if (!Put) return false
          const current = items.get(
            `${String(Put.Item.workspaceId)}\0${String(Put.Item.recordKey)}`,
          )
          if (
            Put.ConditionExpression ===
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
          ) return current !== undefined
          if (Put.ConditionExpression?.startsWith('#recordVersion =')) {
            return current?.version !==
                Put.ExpressionAttributeValues?.[':expectedRecordVersion'] ||
              (
                Put.ExpressionAttributeValues?.[':subscriptionEntryType'] !== undefined &&
                current?.entryType !==
                  Put.ExpressionAttributeValues?.[':subscriptionEntryType']
              )
          }
          if (Put.ConditionExpression?.startsWith('#authVersion =')) {
            return current?.version !==
                Put.ExpressionAttributeValues?.[':expectedAuthVersion'] ||
              current?.entryType !==
                Put.ExpressionAttributeValues?.[':authEntryType']
          }
          if (Put.ConditionExpression?.startsWith('#linkVersion =')) {
            return current?.version !==
              Put.ExpressionAttributeValues?.[':expectedLinkVersion']
          }
          if (Put.ConditionExpression?.startsWith('#version =')) {
            if (Put.ExpressionAttributeValues?.[':reservationDigest'] === undefined) {
              return current?.version !== Put.ExpressionAttributeValues?.[':expectedVersion']
            }
            const value = current?.value as Record<string, unknown> | undefined
            return current?.version !== Put.ExpressionAttributeValues?.[':expectedVersion'] ||
              current?.entryType !== 'idempotency' ||
              value?.state !== 'reserved' ||
              value?.reservationDigest !==
                Put.ExpressionAttributeValues?.[':reservationDigest'] ||
              value?.requestFingerprintDigest !==
                Put.ExpressionAttributeValues?.[':requestFingerprintDigest']
          }
          return false
        })) {
          const error = new Error('transaction condition failed') as Error & {
            CancellationReasons?: Array<{ Code: string }>
          }
          error.name = 'TransactionCanceledException'
          error.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]
          throw error
        }
        for (const { Delete, Put, Update } of transactItems) {
          if (
            Delete &&
            typeof Delete.Key.workspaceId === 'string' &&
            typeof Delete.Key.recordKey === 'string'
          ) {
            items.delete(`${Delete.Key.workspaceId}\0${Delete.Key.recordKey}`)
          }
          if (Put) {
            items.set(
              `${String(Put.Item.workspaceId)}\0${String(Put.Item.recordKey)}`,
              structuredClone(Put.Item),
            )
          }
          if (!Update) continue
          const mapKey = `${Update.Key.workspaceId}\0${Update.Key.recordKey}`
          const current = items.get(mapKey)
          const values = Update.ExpressionAttributeValues ?? {}
          if (values[':entryType'] === 'work-item-link-fence') {
            const delta = Update.UpdateExpression.includes('activeLinkCount -') ? -1 : 1
            items.set(mapKey, {
              ...(current ?? {
                workspaceId: Update.Key.workspaceId,
                recordKey: Update.Key.recordKey,
                entryType: values[':entryType'],
                value: structuredClone(values[':value']),
                version: 0,
              }),
              activeLinkCount: Number(current?.activeLinkCount ?? 0) + delta,
              version: Number(current?.version ?? 0) + 1,
            })
          } else if (values[':entryType'] === 'webhook-subscription-quota') {
            const delta = Update.UpdateExpression.includes('subscriptionCount -')
              ? -1
              : 1
            items.set(mapKey, {
              ...(current ?? {
                workspaceId: Update.Key.workspaceId,
                recordKey: Update.Key.recordKey,
                entryType: values[':entryType'],
                value: structuredClone(values[':value']),
                version: 0,
              }),
              subscriptionCount: Number(current?.subscriptionCount ?? 0) + delta,
              version: Number(current?.version ?? 0) + 1,
            })
          } else if (values[':entryType'] === 'webhook-subscription') {
            const currentValue = current?.value as Record<string, unknown>
            items.set(mapKey, {
              ...current,
              value: {
                ...currentValue,
                lastDeliveryAt: values[':attemptedAt'],
                updatedAt: values[':attemptedAt'],
                failureCount: Update.UpdateExpression.includes(
                  '#value.#failureCount = :zero',
                )
                  ? 0
                  : Number(currentValue.failureCount ?? 0) + 1,
              },
              version: Number(current?.version ?? 0) + 1,
            })
          } else if (values[':entryType'] === 'connector-installation') {
            const delta = Update.UpdateExpression.includes('externalLinkCount -')
              ? -1
              : 1
            items.set(mapKey, {
              ...current,
              externalLinkCount: Number(current?.externalLinkCount ?? 0) + delta,
              version: Number(current?.version ?? 0) + 1,
            })
          } else if (values[':entryType'] === 'connector-poll-target') {
            const delta = Update.UpdateExpression.includes('pollableLinkCount -')
              ? -1
              : 1
            items.set(mapKey, {
              ...(current ?? {
                workspaceId: Update.Key.workspaceId,
                recordKey: Update.Key.recordKey,
                entryType: values[':entryType'],
                value: structuredClone(values[':value']),
                version: 0,
              }),
              lookupKey: values[':lookupKey'],
              lookupSortKey: values[':lookupSortKey'],
              pollableLinkCount: Number(current?.pollableLinkCount ?? 0) + delta,
              version: Number(current?.version ?? 0) + 1,
            })
          }
        }
        return {}
      }
      throw new Error(`Unsupported command: ${commandName}`)
    },
  } as unknown as DynamoDBDocumentClient
  return { documentClient, items, commands }
}

describe('developer credential lifecycle', () => {
  test('stores API key digest only and enforces expiry, last-used, rotation, and revoke', async () => {
    const { client, clock } = createClient()
    const created = await client.createApiKey({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Automation',
        scopes: ['work-items:read', 'work-items:write'],
        expiresAt: new Date(START.getTime() + 3_600_000).toISOString(),
      },
    })

    expect(created.secret).toStartWith('mk_key_')
    expect(created.secret.length).toBeGreaterThan(48)
    expect(JSON.stringify(created.apiKey)).not.toContain(created.secret)
    expect(JSON.stringify(await client.listApiKeys('workspace-1'))).not.toContain(created.secret)

    const apiKeyRow = readStoredRows(client).find((row) => row.entryType === 'api-key')
    expect(apiKeyRow?.secretDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(apiKeyRow)).not.toContain(created.secret)

    const authenticated = await client.authenticateApiKey({
      credential: created.secret,
      requiredScopes: ['work-items:write'],
    })
    expect(authenticated).toMatchObject({
      kind: 'api-key',
      workspaceId: 'workspace-1',
      credentialId: created.apiKey.id,
      subjectUserId: 'user-1',
      scopes: ['work-items:read', 'work-items:write'],
    })
    expect((await client.listApiKeys('workspace-1'))[0]?.lastUsedAt).toBe(START.toISOString())

    const rotated = await client.rotateApiKey({
      workspaceId: 'workspace-1',
      apiKeyId: created.apiKey.id,
    })
    expect(rotated.secret).not.toBe(created.secret)
    await expect(client.authenticateApiKey({ credential: created.secret }))
      .rejects.toMatchObject({ status: 401, code: 'ApiKeyInvalid' })
    await expect(client.authenticateApiKey({ credential: rotated.secret }))
      .resolves.toMatchObject({ credentialId: created.apiKey.id })

    const revoked = await client.revokeApiKey({
      workspaceId: 'workspace-1',
      apiKeyId: created.apiKey.id,
    })
    expect(revoked.status).toBe('revoked')
    const revokedRow = readStoredRows(client)
      .find((row) => row.recordKey === apiKeyRow?.recordKey)
    expect(revokedRow).not.toHaveProperty('lookupKey')
    expect(revokedRow).not.toHaveProperty('secretDigest')
    await expect(client.authenticateApiKey({ credential: rotated.secret }))
      .rejects.toMatchObject({ status: 401 })

    const expiring = await client.createApiKey({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-2',
      input: {
        name: 'Short lived',
        scopes: ['work-items:read'],
        expiresAt: new Date(START.getTime() + 1_000).toISOString(),
      },
    })
    clock.advanceSeconds(2)
    await expect(client.authenticateApiKey({ credential: expiring.secret }))
      .rejects.toMatchObject({ status: 401, code: 'ApiKeyExpired' })
    expect(
      (await client.listApiKeys('workspace-1'))
        .find((apiKey) => apiKey.id === expiring.apiKey.id)?.status,
    ).toBe('expired')
    const expiredRow = readStoredRows(client)
      .find((row) => row.recordKey === `APIKEY#${expiring.apiKey.id}`)
    expect(expiredRow).not.toHaveProperty('lookupKey')
    expect(expiredRow).not.toHaveProperty('secretDigest')
  })

  test('issues digest-only OAuth client_credentials tokens with scoped auth and app revoke', async () => {
    const { client, clock } = createClient()
    await expect(client.createOAuthApp({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-oauth',
      input: {
        name: 'Unsupported OAuth grant',
        grantTypes: ['authorization_code'] as never[],
        scopes: ['work-items:read'],
      },
    })).rejects.toMatchObject({ status: 400, code: 'OAuthGrantTypesInvalid' })
    const created = await client.createOAuthApp({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-oauth',
      input: {
        name: 'CI app',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read', 'webhooks:read'],
      },
    })
    expect(created.clientSecret).toStartWith('mk_oauth_secret_')
    expect(JSON.stringify(await client.listOAuthApps('workspace-1')))
      .not.toContain(created.clientSecret)

    const token = await client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: created.clientSecret,
      scopes: ['work-items:read'],
      expiresInSeconds: 600,
    })
    expect(token.accessToken).toStartWith('mk_access_')
    const stored = JSON.stringify(readStoredRows(client))
    expect(stored).not.toContain(created.clientSecret)
    expect(stored).not.toContain(token.accessToken)

    await expect(client.authenticateOAuthToken({
      credential: token.accessToken,
      requiredScopes: ['work-items:read'],
    })).resolves.toMatchObject({
      kind: 'oauth-token',
      workspaceId: 'workspace-1',
      oauthAppId: created.oauthApp.id,
      subjectUserId: 'user-oauth',
      scopes: ['work-items:read'],
    })
    await expect(client.authenticateOAuthToken({
      credential: token.accessToken,
      requiredScopes: ['webhooks:read'],
    })).rejects.toMatchObject({ status: 403, code: 'ApiScopeInsufficient' })

    const expiringToken = await client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: created.clientSecret,
      scopes: ['work-items:read'],
      expiresInSeconds: 1,
    })
    clock.advanceSeconds(2)
    await expect(client.authenticateOAuthToken({ credential: expiringToken.accessToken }))
      .rejects.toMatchObject({ status: 401, code: 'OAuthTokenExpired' })

    const rotated = await client.rotateOAuthClientSecret({
      workspaceId: 'workspace-1',
      oauthAppId: created.oauthApp.id,
    })
    await expect(client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: created.clientSecret,
    })).rejects.toMatchObject({ status: 401, code: 'OAuthClientInvalid' })
    await expect(client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: rotated.clientSecret,
      scopes: ['webhooks:read'],
    })).resolves.toMatchObject({ scopes: ['webhooks:read'] })

    await client.revokeOAuthApp({
      workspaceId: 'workspace-1',
      oauthAppId: created.oauthApp.id,
    })
    const revokedAppRow = readStoredRows(client)
      .find((row) => row.recordKey === `OAUTHAPP#${created.oauthApp.id}`)
    expect(revokedAppRow).not.toHaveProperty('secretDigest')
    expect(
      readStoredRows(client).filter((row) => row.entryType === 'oauth-token'),
    ).toHaveLength(0)
    await expect(client.authenticateOAuthToken({ credential: token.accessToken }))
      .rejects.toMatchObject({ status: 401 })
  })

  test('expires OAuth apps, caps token lifetime, and removes inactive digests', async () => {
    const { client, clock } = createClient()
    const created = await client.createOAuthApp({
      workspaceId: 'workspace-expiring',
      createdByUserId: 'user-oauth',
      input: {
        name: 'Short-lived app',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
        expiresAt: new Date(START.getTime() + 2_000).toISOString(),
      },
    })
    expect(created.oauthApp.expiresAt).toBe(
      new Date(START.getTime() + 2_000).toISOString(),
    )
    if (!created.oauthApp.expiresAt) throw new Error('OAuth app expiry was not set.')
    const token = await client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: created.clientSecret,
      expiresInSeconds: 600,
    })
    expect(token.expiresIn).toBe(2)
    expect(token.expiresAt).toBe(created.oauthApp.expiresAt)

    clock.advanceSeconds(3)
    await expect(client.issueOAuthToken({
      clientId: created.oauthApp.clientId,
      clientSecret: created.clientSecret,
    })).rejects.toMatchObject({ status: 401, code: 'OAuthAppExpired' })
    const expiredApp = (await client.listOAuthApps('workspace-expiring'))[0]
    expect(expiredApp?.status).toBe('expired')
    const expiredAppRow = readStoredRows(client)
      .find((row) => row.recordKey === `OAUTHAPP#${created.oauthApp.id}`)
    expect(expiredAppRow).not.toHaveProperty('secretDigest')
    expect(
      readStoredRows(client).filter((row) => row.entryType === 'oauth-token'),
    ).toHaveLength(0)
    await expect(client.authenticateOAuthToken({ credential: token.accessToken }))
      .rejects.toMatchObject({ status: 401, code: 'OAuthTokenInvalid' })
  })
})

describe('DynamoDB developer platform persistence', () => {
  test('uses strongly consistent credential auth rows, ciphertext, and no raw secret', async () => {
    const clock = createClock()
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(5)),
      clock.now,
      'LookupKeyIndex',
    )
    const apiKey = await client.createApiKey({
      workspaceId: 'workspace-dynamo',
      createdByUserId: 'user-dynamo',
      input: { name: 'Dynamo key', scopes: ['work-items:read'] },
    })
    memory.commands.splice(0)
    await expect(client.authenticateApiKey({ credential: apiKey.secret }))
      .resolves.toMatchObject({ workspaceId: 'workspace-dynamo' })
    expect(memory.commands.some(({ name }) => name === 'QueryCommand')).toBe(false)
    expect(
      memory.commands
        .filter(({ name }) => name === 'GetCommand')
        .every(({ input }) => input.ConsistentRead === true),
    ).toBe(true)
    const storedApiKeyRow = [...memory.items.values()]
      .find((row) => row.entryType === 'api-key')
    const storedAuthRow = [...memory.items.values()]
      .find((row) =>
        row.entryType === 'credential-auth' &&
        (row.value as { kind?: string }).kind === 'api-key'
      )
    if (!storedApiKeyRow || !storedAuthRow) {
      throw new Error('API key domain/auth rows were not stored.')
    }
    const originalApiKeyRow = structuredClone(storedApiKeyRow)
    const originalAuthRow = structuredClone(storedAuthRow)
    expect(originalAuthRow).toMatchObject({
      workspaceId: expect.stringMatching(/^CREDENTIALAUTH#APIKEY#[a-f0-9]{64}$/),
      recordKey: 'CREDENTIAL',
      secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      value: {
        kind: 'api-key',
        targetWorkspaceId: 'workspace-dynamo',
        targetRecordKey: originalApiKeyRow.recordKey,
      },
    })
    const rotatedApiKey = await client.rotateApiKey({
      workspaceId: 'workspace-dynamo',
      apiKeyId: apiKey.apiKey.id,
    })
    expect(
      [...memory.items.values()].some((row) =>
        row.workspaceId === originalAuthRow.workspaceId &&
        row.recordKey === originalAuthRow.recordKey
      ),
    ).toBe(false)
    await expect(client.authenticateApiKey({ credential: apiKey.secret }))
      .rejects.toMatchObject({ status: 401, code: 'ApiKeyInvalid' })
    await expect(client.authenticateApiKey({ credential: rotatedApiKey.secret }))
      .resolves.toMatchObject({ workspaceId: 'workspace-dynamo' })
    const oauthApp = await client.createOAuthApp({
      workspaceId: 'workspace-dynamo',
      createdByUserId: 'user-dynamo',
      input: {
        name: 'Dynamo OAuth',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
      },
    })
    memory.commands.splice(0)
    const oauthToken = await client.issueOAuthToken({
      clientId: oauthApp.oauthApp.clientId,
      clientSecret: oauthApp.clientSecret,
      expiresInSeconds: 300,
    })
    expect(memory.commands.some(({ name }) => name === 'QueryCommand')).toBe(false)
    const tokenIssueTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const tokenIssueWrites = tokenIssueTransaction?.input.TransactItems as
      | Array<{ Put?: { Item?: { entryType?: string } } }>
      | undefined
    expect(
      tokenIssueWrites?.map((item) => item.Put?.Item?.entryType),
    ).toEqual(['oauth-app', 'oauth-token', 'credential-auth'])
    memory.commands.splice(0)
    await expect(client.authenticateOAuthToken({
      credential: oauthToken.accessToken,
    })).resolves.toMatchObject({
      workspaceId: 'workspace-dynamo',
      oauthAppId: oauthApp.oauthApp.id,
    })
    expect(memory.commands.some(({ name }) => name === 'QueryCommand')).toBe(false)
    memory.commands.splice(0)
    const rotatedOAuthApp = await client.rotateOAuthClientSecret({
      workspaceId: 'workspace-dynamo',
      oauthAppId: oauthApp.oauthApp.id,
    })
    const oauthRotationTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    expect(oauthRotationTransaction?.input.TransactItems).toHaveLength(2)
    const oauthRotationWrites = oauthRotationTransaction?.input.TransactItems as
      | Array<{
          Put?: { Item?: { entryType?: string }; ConditionExpression?: string }
        }>
      | undefined
    expect(
      oauthRotationWrites?.[1]?.Put,
    ).toMatchObject({
      Item: { entryType: 'credential-auth' },
      ConditionExpression:
        '#authVersion = :expectedAuthVersion AND #entryType = :authEntryType',
    })
    await expect(client.issueOAuthToken({
      clientId: oauthApp.oauthApp.clientId,
      clientSecret: oauthApp.clientSecret,
    })).rejects.toMatchObject({ status: 401, code: 'OAuthClientInvalid' })
    await expect(client.issueOAuthToken({
      clientId: oauthApp.oauthApp.clientId,
      clientSecret: rotatedOAuthApp.clientSecret,
      expiresInSeconds: 300,
    })).resolves.toMatchObject({ tokenType: 'Bearer' })
    const webhook = await client.createWebhookSubscription({
      workspaceId: 'workspace-dynamo',
      createdByUserId: 'user-dynamo',
      input: {
        name: 'Dynamo webhook',
        url: 'https://hooks.example.test/dynamo',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
      },
    })
    const delivery = (await client.enqueueWebhookEvent({
      workspaceId: 'workspace-dynamo',
      authorizedSubscriptionIds: [webhook.subscription.id],
      event: createWebhookEvent('event-dynamo', 'workspace-dynamo'),
    }))[0]!
    const deliveryRows = [...memory.items.values()]
      .filter((row) =>
        row.entryType === 'webhook-delivery' ||
        row.entryType === 'webhook-delivery-index'
      )
    expect(deliveryRows).toHaveLength(4)
    expect(new Set(deliveryRows.map((row) => row.expiresAt))).toEqual(new Set([
      Math.floor(START.getTime() / 1_000) + WEBHOOK_DELIVERY_RETENTION_SECONDS,
    ]))
    memory.commands.splice(0)
    await expect(client.listWebhookDeliveries({
      workspaceId: 'workspace-dynamo',
      subscriptionId: webhook.subscription.id,
      limit: 1,
    })).resolves.toMatchObject({ deliveries: [{ id: delivery.id }] })
    const deliveryListQuery = memory.commands.find(({ name }) => name === 'QueryCommand')
    expect(deliveryListQuery?.input).toMatchObject({
      IndexName: 'LookupKeyIndex',
      Limit: 1,
      ScanIndexForward: false,
    })
    const deliveryListGets = memory.commands.filter(({ name }) => name === 'GetCommand')
    expect(deliveryListGets.length).toBeGreaterThanOrEqual(2)
    expect(deliveryListGets.every(({ input }) => input.ConsistentRead === true)).toBe(true)
    await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-dynamo',
      deliveryId: delivery.id,
      status: 'failed',
      responseStatus: 500,
    })
    memory.commands.splice(0)
    await expect(client.replayWebhookDelivery({
      workspaceId: 'workspace-dynamo',
      deliveryId: delivery.id,
    })).resolves.toMatchObject({ replayOfDeliveryId: delivery.id, replayNumber: 1 })
    expect(memory.commands.some(({ name, input }) =>
      name === 'QueryCommand' &&
      input.IndexName === 'LookupKeyIndex' &&
      input.Limit === 1
    )).toBe(true)
    expect(memory.commands.some(({ name, input }) =>
      name === 'QueryCommand' && input.IndexName === undefined
    )).toBe(false)
    await client.installConnector({
      workspaceId: 'workspace-dynamo',
      installedByUserId: 'user-dynamo',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Dynamo connector',
        scopes: ['repo:read'],
        credential: 'dynamo-connector-secret',
      },
    })
    const idempotencyRequest = {
      workspaceId: 'workspace-dynamo',
      credentialId: 'management-user',
      idempotencyKey: 'create-secret',
      requestFingerprint: 'POST:/developer/api-keys:secret',
    }
    const reservation = await client.reserveIdempotency(idempotencyRequest)
    if (reservation.status !== 'reserved') {
      throw new Error('DynamoDB idempotency reservation was not created.')
    }
    await client.completeIdempotency({
      ...idempotencyRequest,
      reservationId: reservation.reservationId,
      response: { status: 201, body: { secret: apiKey.secret } },
    })
    await expect(client.reserveIdempotency(idempotencyRequest)).resolves.toEqual({
      status: 'replay',
      response: { status: 201, body: { secret: apiKey.secret } },
    })

    const atomicRequest = {
      workspaceId: 'workspace-dynamo',
      credentialId: 'management-user',
      idempotencyKey: 'atomic-create-secret',
      requestFingerprint: 'POST:/developer/api-keys:atomic-secret',
    }
    const atomicReservation = await client.reserveIdempotency(atomicRequest)
    if (atomicReservation.status !== 'reserved') {
      throw new Error('Atomic DynamoDB idempotency reservation was not created.')
    }
    memory.commands.splice(0)
    const atomicApiKey = await client.createApiKey({
      workspaceId: atomicRequest.workspaceId,
      createdByUserId: 'user-dynamo',
      input: { name: 'Atomic Dynamo key', scopes: ['work-items:read'] },
      idempotency: {
        credentialId: atomicRequest.credentialId,
        idempotencyKey: atomicRequest.idempotencyKey,
        requestFingerprint: atomicRequest.requestFingerprint,
        reservationId: atomicReservation.reservationId,
      },
    })
    const atomicTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const atomicWrites = atomicTransaction?.input.TransactItems as Array<{
      Put?: {
        Item: Record<string, unknown>
        ConditionExpression?: string
        ExpressionAttributeValues?: Record<string, unknown>
      }
    }> | undefined
    expect(atomicWrites).toHaveLength(3)
    expect(atomicWrites?.[0]?.Put).toMatchObject({
      Item: { entryType: 'api-key' },
      ConditionExpression:
        'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    })
    expect(atomicWrites?.[1]?.Put).toMatchObject({
      Item: { entryType: 'credential-auth' },
      ConditionExpression:
        'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    })
    expect(atomicWrites?.[2]?.Put).toMatchObject({
      Item: {
        entryType: 'idempotency',
        value: {
          state: 'completed',
          responseCiphertext: expect.stringMatching(/^v1\./),
        },
      },
      ExpressionAttributeValues: {
        ':entryType': 'idempotency',
        ':expectedVersion': 1,
        ':reserved': 'reserved',
      },
    })
    expect(atomicWrites?.[2]?.Put?.ConditionExpression).toContain(
      '#value.#reservationDigest = :reservationDigest',
    )
    expect(atomicWrites?.[2]?.Put?.ConditionExpression).toContain(
      '#value.#requestFingerprintDigest = :requestFingerprintDigest',
    )
    await expect(client.reserveIdempotency(atomicRequest)).resolves.toEqual({
      status: 'replay',
      response: { status: 201, body: atomicApiKey },
    })

    const rows = [...memory.items.values()]
    expect(rows.every((row) => typeof row.recordKey === 'string')).toBe(true)
    expect(rows.filter((row) => row.entryType !== 'credential-auth').every((row) =>
      row.workspaceId === 'workspace-dynamo'
    )).toBe(true)
    const apiKeyRow = rows.find((row) => row.entryType === 'api-key')
    expect(apiKeyRow).toMatchObject({
      secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(apiKeyRow).not.toHaveProperty('lookupKey')
    expect(apiKeyRow).not.toHaveProperty('expiresAt')
    const tokenRow = rows.find((row) => row.entryType === 'oauth-token')
    expect(tokenRow).toMatchObject({
      expiresAt: Math.floor(START.getTime() / 1_000) + 300,
      secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(rows.find((row) => row.entryType === 'webhook-subscription')?.secretCiphertext)
      .toMatch(/^v1\./)
    expect(rows.find((row) => row.entryType === 'connector-installation')?.secretCiphertext)
      .toMatch(/^v1\./)
    const idempotencyValue = rows.find((row) => row.entryType === 'idempotency')
      ?.value as { responseCiphertext?: string } | undefined
    expect(idempotencyValue?.responseCiphertext).toMatch(/^v1\./)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(apiKey.secret)
    expect(serialized).not.toContain(atomicApiKey.secret)
    expect(serialized).not.toContain(rotatedApiKey.secret)
    expect(serialized).not.toContain(oauthApp.clientSecret)
    expect(serialized).not.toContain(rotatedOAuthApp.clientSecret)
    expect(serialized).not.toContain(oauthToken.accessToken)
    expect(serialized).not.toContain(webhook.signingSecret)
    expect(serialized).not.toContain('dynamo-connector-secret')
  })

  test('prepares an atomic Work Item deletion fence with an empty-link condition', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(6)),
      () => START,
      'LookupKeyIndex',
    )

    await expect(client.prepareWorkItemDeletionFenceTransactWrite({
      workspaceId: 'workspace-dynamo',
      teamId: 'team-1',
      workItemId: 'work-item-1',
    })).resolves.toMatchObject({
      transactWriteItem: {
        Put: {
          TableName: 'DeveloperPlatformTable',
          Item: {
            workspaceId: 'workspace-dynamo',
            recordKey: expect.stringMatching(/^WORKITEMLINKS#[a-f0-9]{64}$/),
            entryType: 'work-item-link-fence',
            value: {
              teamId: 'team-1',
              workItemId: 'work-item-1',
              deletedAt: START.toISOString(),
            },
            activeLinkCount: 0,
            version: 1,
          },
          ConditionExpression: expect.stringContaining('activeLinkCount = :zero'),
          ExpressionAttributeValues: {
            ':entryType': 'work-item-link-fence',
            ':zero': 0,
            ':teamId': 'team-1',
            ':workItemId': 'work-item-1',
          },
        },
      },
    })
  })

  test('replays PATCH and DELETE after response loss from their domain transaction', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(6)),
      () => START,
      'LookupKeyIndex',
    )

    for (const mutation of [
      {
        name: 'PATCH',
        request: {
          workspaceId: 'workspace-dynamo',
          credentialId: 'public-api-key',
          idempotencyKey: 'update-work-item',
          requestFingerprint: 'PATCH:/v1/work-items/work-item-1',
        },
        response: {
          status: 200,
          body: {
            id: 'work-item-1',
            revision: 4,
            title: 'Updated after transaction',
          },
        },
        domainWrite: {
          Update: {
            TableName: 'WorkItems',
            Key: {
              directoryTeamId: 'workspace-dynamo#team-1',
              issueId: 'work-item-1',
            },
          },
        },
      },
      {
        name: 'DELETE',
        request: {
          workspaceId: 'workspace-dynamo',
          credentialId: 'public-api-key',
          idempotencyKey: 'delete-work-item',
          requestFingerprint: 'DELETE:/v1/work-items/work-item-1',
        },
        response: { status: 204, body: null },
        domainWrite: {
          Delete: {
            TableName: 'WorkItems',
            Key: {
              directoryTeamId: 'workspace-dynamo#team-1',
              issueId: 'work-item-1',
            },
          },
        },
      },
    ] as const) {
      const reserved = await client.reserveIdempotency(mutation.request)
      if (reserved.status !== 'reserved') {
        throw new Error(`${mutation.name} idempotency reservation was not created.`)
      }
      const completion = await client.prepareIdempotencyCompletionTransactWrite({
        ...mutation.request,
        reservationId: reserved.reservationId,
        response: mutation.response,
      })
      const completionPut = completion.transactWriteItem.Put
      const completionItem = completionPut?.Item as {
        entryType?: string
        value?: {
          state?: string
          responseCiphertext?: string
        }
      } | undefined
      expect(completionPut?.TableName).toBe('DeveloperPlatformTable')
      expect(completionItem?.entryType).toBe('idempotency')
      expect(completionItem?.value?.state).toBe('completed')
      expect(completionItem?.value?.responseCiphertext).toMatch(/^v1\./)
      expect(JSON.stringify(completionPut)).not.toContain(
        'Updated after transaction',
      )

      // Domain write と receipt を一度だけ commit し、handler response loss を再現します。
      await memory.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          mutation.domainWrite as unknown as
            NonNullable<TransactWriteCommandInput['TransactItems']>[number],
          completion.transactWriteItem,
        ],
      }))

      await expect(client.reserveIdempotency(mutation.request)).resolves.toEqual({
        status: 'replay',
        response: mutation.response,
      })
    }
  })

  test('atomically emits external-link and terminal import webhook outbox events', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(6)),
      () => START,
      'LookupKeyIndex',
      'AuditEventsTable',
    )
    const installation = await client.installConnector({
      workspaceId: 'workspace-events',
      installedByUserId: 'user-events',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Event GitHub',
        scopes: ['issues:read'],
        credential: 'event-connector-secret',
      },
    })

    memory.commands.splice(0)
    const link = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-events',
      input: {
        teamId: 'team-events',
        workItemId: 'work-item-events',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'issue-29',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })
    const linkTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const linkWrites = linkTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
      Update?: {
        TableName?: string
        ExpressionAttributeValues?: Record<string, unknown>
      }
    }> | undefined
    expect(linkWrites).toHaveLength(8)
    expect(linkWrites?.[0]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'connector-installation',
        ':limit': EXTERNAL_LINK_INSTALLATION_LIMIT,
        ':one': 1,
      },
    })
    expect(linkWrites?.[1]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'work-item-link-fence',
        ':limit': EXTERNAL_LINK_WORK_ITEM_LIMIT,
        ':one': 1,
      },
    })
    expect(linkWrites?.[4]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'connector-poll-target',
        ':one': 1,
      },
    })
    expect(linkWrites?.[5]?.Put?.Item).toMatchObject({
      entryType: 'external-link-index',
    })
    expect(linkWrites?.[6]?.Put?.Item).toMatchObject({
      entryType: 'external-link-index',
    })
    expect(linkWrites?.[7]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'external-link.created',
        outboxStatus: 'pending',
        entity: { type: 'external-link', id: link.id },
        metadata: {
          teamId: 'team-events',
          workItemId: 'work-item-events',
          externalLinkId: link.id,
        },
      },
    })

    const updateIdempotency = {
      workspaceId: 'workspace-events',
      credentialId: 'user:user-events',
      idempotencyKey: 'pause-external-link',
      requestFingerprint: 'PATCH:/developer/external-links',
    }
    const reservation = await client.reserveIdempotency(updateIdempotency)
    if (reservation.status !== 'reserved') {
      throw new Error('External link update reservation was not created.')
    }
    memory.commands.splice(0)
    const updatedLink = await client.updateExternalWorkItemLink({
      workspaceId: 'workspace-events',
      teamId: 'team-events',
      workItemId: 'work-item-events',
      linkId: link.id,
      updatedByUserId: 'user-events',
      input: { syncDirection: 'none' },
      idempotency: {
        credentialId: updateIdempotency.credentialId,
        idempotencyKey: updateIdempotency.idempotencyKey,
        requestFingerprint: updateIdempotency.requestFingerprint,
        reservationId: reservation.reservationId,
      },
    })
    expect(updatedLink).toMatchObject({
      syncDirection: 'none',
      syncStatus: 'paused',
    })
    const updateTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const updateWrites = updateTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
      Update?: {
        TableName?: string
        ExpressionAttributeValues?: Record<string, unknown>
      }
    }> | undefined
    expect(updateWrites).toHaveLength(5)
    expect(updateWrites?.[1]?.Put).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Item: {
        entryType: 'external-link',
        value: {
          id: link.id,
          syncDirection: 'none',
          syncStatus: 'paused',
        },
      },
    })
    expect(updateWrites?.[2]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'connector-poll-target',
        ':one': 1,
      },
    })
    expect(updateWrites?.[3]?.Put).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Item: {
        entryType: 'idempotency',
        value: {
          state: 'completed',
          responseCiphertext: expect.stringMatching(/^v1\./),
        },
      },
    })
    expect(updateWrites?.[4]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'external-link.updated',
        outboxStatus: 'pending',
        actor: { id: 'user-events', kind: 'user' },
        metadata: {
          teamId: 'team-events',
          externalLinkId: link.id,
          workItemId: 'work-item-events',
          installationId: installation.id,
          resourceType: 'issue',
          previousSyncDirection: 'bidirectional',
          syncDirection: 'none',
          previousSyncStatus: 'pending',
          syncStatus: 'paused',
        },
      },
    })
    expect(JSON.stringify(updateWrites)).not.toContain('event-connector-secret')
    await expect(client.reserveIdempotency(updateIdempotency)).resolves.toEqual({
      status: 'replay',
      response: { status: 200, body: updatedLink },
    })

    const syncStateKey = `workspace-events\0CONNECTORSYNC#${link.id}`
    memory.items.set(syncStateKey, {
      workspaceId: 'workspace-events',
      recordKey: `CONNECTORSYNC#${link.id}`,
      entryType: 'connector-sync-state',
      value: {
        installationId: installation.id,
        linkId: link.id,
        workItemRevision: 1,
        lastExternalVersion: 'external-v1',
        storageRevision: 1,
        updatedAt: START.toISOString(),
      },
      version: 1,
    })
    const deleteIdempotency = {
      workspaceId: 'workspace-events',
      credentialId: 'user:user-events',
      idempotencyKey: 'delete-external-link',
      requestFingerprint: 'DELETE:/developer/external-links',
    }
    const deleteReservation = await client.reserveIdempotency(deleteIdempotency)
    if (deleteReservation.status !== 'reserved') {
      throw new Error('External link deletion reservation was not created.')
    }
    memory.commands.splice(0)
    await client.deleteExternalWorkItemLink({
      workspaceId: 'workspace-events',
      teamId: 'team-events',
      workItemId: 'work-item-events',
      linkId: link.id,
      deletedByActorId: 'user-events',
      idempotency: {
        credentialId: deleteIdempotency.credentialId,
        idempotencyKey: deleteIdempotency.idempotencyKey,
        requestFingerprint: deleteIdempotency.requestFingerprint,
        reservationId: deleteReservation.reservationId,
      },
    })
    const deleteTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const deleteWrites = deleteTransaction?.input.TransactItems as Array<{
      Delete?: {
        TableName?: string
        Key?: Record<string, unknown>
        ConditionExpression?: string
      }
      Put?: { TableName?: string; Item?: Record<string, unknown> }
      Update?: {
        TableName?: string
        ExpressionAttributeValues?: Record<string, unknown>
      }
    }> | undefined
    expect(deleteWrites).toHaveLength(9)
    expect(deleteWrites?.[0]?.Delete).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Key: {
        workspaceId: 'workspace-events',
        recordKey: expect.stringMatching(/^EXTERNALCLAIM#/),
      },
      ConditionExpression:
        '#entryType = :claimEntryType AND #value.#targetRecordKey = :targetRecordKey',
    })
    expect(deleteWrites?.[1]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'work-item-link-fence',
        ':one': 1,
      },
    })
    expect(deleteWrites?.[2]?.Update).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      ExpressionAttributeValues: {
        ':entryType': 'connector-installation',
        ':one': 1,
      },
    })
    expect(deleteWrites?.[3]?.Delete).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Key: {
        workspaceId: 'workspace-events',
        recordKey: `EXTERNALLINKINDEX#WORKITEM#${link.id}`,
      },
    })
    expect(deleteWrites?.[4]?.Delete).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Key: {
        workspaceId: 'workspace-events',
        recordKey: expect.stringMatching(
          new RegExp(`^EXTERNALLINKINDEX#INSTALLATION#[a-f0-9]{64}#${link.id}$`),
        ),
      },
    })
    expect(deleteWrites?.[5]?.Delete).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Key: {
        workspaceId: 'workspace-events',
        recordKey: `EXTERNALLINK#${link.id}`,
      },
      ConditionExpression:
        '#version = :expectedVersion AND #entryType = :linkEntryType AND ' +
        '#value.#syncStatus <> :conflict',
    })
    expect(deleteWrites?.[6]?.Delete).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Key: {
        workspaceId: 'workspace-events',
        recordKey: `CONNECTORSYNC#${link.id}`,
      },
    })
    expect(deleteWrites?.[7]?.Put).toMatchObject({
      TableName: 'DeveloperPlatformTable',
      Item: {
        entryType: 'idempotency',
        value: {
          state: 'completed',
          responseCiphertext: expect.stringMatching(/^v1\./),
        },
      },
    })
    expect(deleteWrites?.[8]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'external-link.updated',
        action: 'deleted',
        outboxStatus: 'pending',
        actor: { id: 'user-events', kind: 'user' },
        metadata: {
          teamId: 'team-events',
          externalLinkId: link.id,
          workItemId: 'work-item-events',
          installationId: installation.id,
          lifecycle: 'deleted',
        },
      },
    })
    expect(memory.items.has(syncStateKey)).toBe(false)
    expect([...memory.items.values()].some((item) =>
      item.recordKey === `EXTERNALLINK#${link.id}` ||
      item.lookupSortKey === `workspace-events#${link.id}`
    )).toBe(false)
    expect([...memory.items.values()].some((item) =>
      String(item.recordKey).startsWith('EXTERNALCLAIM#')
    )).toBe(false)
    await expect(client.reserveIdempotency(deleteIdempotency)).resolves.toEqual({
      status: 'replay',
      response: { status: 204, body: null },
    })

    const job = await client.createImportJob({
      workspaceId: 'workspace-events',
      createdByUserId: 'user-events',
      input: {
        format: 'csv',
        teamId: 'team-events',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      },
    })
    await client.updateImportJob({
      workspaceId: 'workspace-events',
      jobId: job.id,
      status: 'running',
    })
    memory.commands.splice(0)
    await client.updateImportJob({
      workspaceId: 'workspace-events',
      jobId: job.id,
      status: 'completed',
      report: { totalRows: 1, validRows: 1, invalidRows: 0, errors: [] },
    })
    const importTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const importWrites = importTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }> | undefined
    expect(importWrites).toHaveLength(2)
    expect(importWrites?.[1]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'import.completed',
        outboxStatus: 'pending',
        metadata: {
          teamId: 'team-events',
          importJobId: job.id,
          totalRows: 1,
          validRows: 1,
          invalidRows: 0,
        },
      },
    })
    const transactionCount = memory.commands.filter(
      ({ name }) => name === 'TransactWriteCommand',
    ).length
    await expect(client.updateImportJob({
      workspaceId: 'workspace-events',
      jobId: job.id,
      status: 'completed',
      report: { totalRows: 1, validRows: 1, invalidRows: 0, errors: [] },
    })).resolves.toMatchObject({ status: 'completed' })
    expect(memory.commands.filter(
      ({ name }) => name === 'TransactWriteCommand',
    )).toHaveLength(transactionCount)
  })

  test('uses materialized filters and point reads instead of scanning all external links', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(6)),
      () => START,
      'LookupKeyIndex',
    )
    const installation = await client.installConnector({
      workspaceId: 'workspace-indexed-links',
      installedByUserId: 'user-indexed-links',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Indexed GitHub',
        scopes: ['issues:read'],
        credential: 'indexed-connector-secret',
      },
    })
    const link = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-indexed-links',
      input: {
        teamId: 'team-indexed-links',
        workItemId: 'work-item-indexed-links',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'issue-indexed-links',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })

    memory.commands.splice(0)
    await expect(client.listExternalWorkItemLinks({
      workspaceId: 'workspace-indexed-links',
      teamId: 'team-indexed-links',
      workItemId: 'work-item-indexed-links',
    })).resolves.toEqual([expect.objectContaining({ id: link.id })])
    const filterQueries = memory.commands.filter(({ name }) => name === 'QueryCommand')
    expect(filterQueries).toHaveLength(1)
    expect(filterQueries[0]?.input).toMatchObject({
      IndexName: 'LookupKeyIndex',
      KeyConditionExpression: 'lookupKey = :lookupKey',
    })

    memory.commands.splice(0)
    await expect(client.listExternalWorkItemLinks({
      workspaceId: 'workspace-indexed-links',
      linkId: link.id,
    })).resolves.toEqual([expect.objectContaining({ id: link.id })])
    expect(memory.commands.map(({ name }) => name)).toEqual(['GetCommand'])

    const resourceTypes = ['merge-request', 'commit', 'deploy'] as const
    const extraLinks = await Promise.all(resourceTypes.map((resourceType) =>
      client.createExternalWorkItemLink({
        workspaceId: 'workspace-indexed-links',
        input: {
          teamId: 'team-indexed-links',
          workItemId: `work-item-indexed-links-${resourceType}`,
          installationId: installation.id,
          resourceType,
          externalId: `${resourceType}-indexed-links`,
          externalUrl: `https://github.com/mnmn0/mukuroji/${resourceType}/indexed`,
          syncDirection: 'bidirectional',
        },
      })
    ))
    memory.commands.splice(0)
    const installationLinks = await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-indexed-links',
      installationId: installation.id,
    })
    expect(installationLinks.map(({ id }) => id).sort()).toEqual(
      [link, ...extraLinks].map(({ id }) => id).sort(),
    )
    expect(memory.commands.filter(({ name }) => name === 'QueryCommand'))
      .toHaveLength(4)
  })
})

describe('webhook subscription and delivery', () => {
  test('atomically enforces the Workspace subscription quota', async () => {
    const { client } = createClient()
    const storage = client as unknown as {
      records: Map<string, Record<string, unknown>>
    }
    storage.records.set('workspace-quota\0WEBHOOKSUBSCRIPTIONQUOTA', {
      workspaceId: 'workspace-quota',
      recordKey: 'WEBHOOKSUBSCRIPTIONQUOTA',
      entryType: 'webhook-subscription-quota',
      value: { limit: WEBHOOK_SUBSCRIPTION_LIMIT },
      subscriptionCount: WEBHOOK_SUBSCRIPTION_LIMIT - 1,
      version: WEBHOOK_SUBSCRIPTION_LIMIT - 1,
    })
    const create = (name: string) => client.createWebhookSubscription({
      workspaceId: 'workspace-quota',
      createdByUserId: 'user-quota',
      input: {
        name,
        url: 'https://hooks.example.test/quota',
        eventTypes: ['work-item.updated'],
        teamIds: ['team-quota'],
        scopes: ['work-items:read'],
      },
    })

    const results = await Promise.allSettled([create('Quota A'), create('Quota B')])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          status: 409,
          code: 'WebhookSubscriptionLimitExceeded',
        }),
      }),
    ])
    expect(await client.listWebhookSubscriptions('workspace-quota')).toHaveLength(1)
  })

  test('releases DynamoDB subscription quota exactly once after disablement', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(19)),
      () => START,
    )
    const quotaKey = 'workspace-dynamo-quota\0WEBHOOKSUBSCRIPTIONQUOTA'
    memory.items.set(quotaKey, {
      workspaceId: 'workspace-dynamo-quota',
      recordKey: 'WEBHOOKSUBSCRIPTIONQUOTA',
      entryType: 'webhook-subscription-quota',
      value: { limit: WEBHOOK_SUBSCRIPTION_LIMIT },
      subscriptionCount: WEBHOOK_SUBSCRIPTION_LIMIT - 1,
      version: WEBHOOK_SUBSCRIPTION_LIMIT - 1,
    })
    const create = (name: string) => client.createWebhookSubscription({
      workspaceId: 'workspace-dynamo-quota',
      createdByUserId: 'user-dynamo-quota',
      input: {
        name,
        url: `https://hooks.example.test/${name.toLowerCase()}`,
        eventTypes: ['work-item.updated'],
        teamIds: ['team-dynamo-quota'],
        scopes: ['work-items:read'],
      },
    })

    const original = await create('Original')
    await expect(create('Blocked')).rejects.toMatchObject({
      status: 409,
      code: 'WebhookSubscriptionLimitExceeded',
    })
    const disableMutation = {
      workspaceId: 'workspace-dynamo-quota',
      credentialId: 'user:user-dynamo-quota',
      idempotencyKey: 'disable-original-webhook',
      requestFingerprint: 'DELETE:/developer/webhook-subscriptions/original',
    }
    const reservation = await client.reserveIdempotency(disableMutation)
    if (reservation.status !== 'reserved') {
      throw new Error('Webhook disable idempotency reservation was not created.')
    }
    const disableResponse = { status: 204 as const, body: null }
    memory.commands.splice(0)
    await expect(client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-dynamo-quota',
      subscriptionId: original.subscription.id,
      status: 'disabled',
      idempotency: {
        ...disableMutation,
        reservationId: reservation.reservationId,
      },
      idempotencyResponse: disableResponse,
    })).resolves.toMatchObject({ status: 'disabled' })
    const disableTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const disableWrites = disableTransaction?.input.TransactItems as Array<{
      Put?: { Item?: Record<string, unknown> }
      Update?: { UpdateExpression?: string }
    }> | undefined
    expect(disableWrites).toHaveLength(3)
    expect(disableWrites?.[0]?.Put?.Item).toMatchObject({
      entryType: 'webhook-subscription',
      value: { status: 'disabled' },
    })
    expect(disableWrites?.[1]?.Update?.UpdateExpression)
      .toContain('subscriptionCount - :one')
    expect(disableWrites?.[2]?.Put?.Item).toMatchObject({
      entryType: 'idempotency',
      value: { state: 'completed' },
    })
    await expect(client.reserveIdempotency(disableMutation)).resolves.toEqual({
      status: 'replay',
      response: disableResponse,
    })
    expect(memory.items.get(quotaKey)?.subscriptionCount)
      .toBe(WEBHOOK_SUBSCRIPTION_LIMIT - 1)

    await expect(client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-dynamo-quota',
      subscriptionId: original.subscription.id,
      status: 'disabled',
    })).resolves.toMatchObject({ status: 'disabled' })
    expect(memory.items.get(quotaKey)?.subscriptionCount)
      .toBe(WEBHOOK_SUBSCRIPTION_LIMIT - 1)

    await expect(create('Replacement')).resolves.toMatchObject({
      subscription: { status: 'active' },
    })
    expect(memory.items.get(quotaKey)?.subscriptionCount)
      .toBe(WEBHOOK_SUBSCRIPTION_LIMIT)
  })

  test('rejects DynamoDB subscription quota underflow without disabling the record', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(20)),
      () => START,
    )
    const created = await client.createWebhookSubscription({
      workspaceId: 'workspace-quota-underflow',
      createdByUserId: 'user-quota-underflow',
      input: {
        name: 'Underflow guard',
        url: 'https://hooks.example.test/underflow-guard',
        eventTypes: ['work-item.updated'],
        teamIds: ['team-quota-underflow'],
        scopes: ['work-items:read'],
      },
    })
    const quotaKey = 'workspace-quota-underflow\0WEBHOOKSUBSCRIPTIONQUOTA'
    const quotaRecord = memory.items.get(quotaKey)
    memory.items.set(quotaKey, { ...quotaRecord, subscriptionCount: 0 })

    await expect(client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-quota-underflow',
      subscriptionId: created.subscription.id,
      status: 'disabled',
    })).rejects.toMatchObject({
      status: 409,
      code: 'DeveloperPlatformConcurrentMutation',
    })
    expect(memory.items.get(quotaKey)?.subscriptionCount).toBe(0)
    expect(memory.items.get(
      `workspace-quota-underflow\0WEBHOOK#${created.subscription.id}`,
    )?.value).toMatchObject({ status: 'active' })
  })

  test('requires payload scopes for every selected event category', async () => {
    const { client } = createClient()
    await expect(client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'External links without scope',
        url: 'https://hooks.example.test/external-links',
        teamIds: ['team-1'],
        eventTypes: ['external-link.created', 'sync-conflict.resolved'],
        scopes: ['work-items:read'],
      },
    })).rejects.toMatchObject({ status: 400, code: 'WebhookEventScopeInvalid' })
    await expect(client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Imports without scope',
        url: 'https://hooks.example.test/imports',
        teamIds: ['team-1'],
        eventTypes: ['import.failed'],
        scopes: ['integrations:read'],
      },
    })).rejects.toMatchObject({ status: 400, code: 'WebhookEventScopeInvalid' })
    await expect(client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'All event categories',
        url: 'https://hooks.example.test/all-events',
        teamIds: ['team-1'],
        eventTypes: [
          'work-item.updated',
          'external-link.updated',
          'sync-conflict.created',
          'import.completed',
        ],
        scopes: ['work-items:read', 'integrations:read', 'imports:read'],
      },
    })).resolves.toMatchObject({
      subscription: {
        scopes: ['imports:read', 'integrations:read', 'work-items:read'],
      },
    })
  })

  test('atomically audits connector lifecycle without credential or OAuth state metadata', async () => {
    const memory = createMemoryDocumentClient()
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      memory.documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(16)),
      () => START,
      'LookupKeyIndex',
      'AuditEventsTable',
    )
    const installation = await client.installConnector({
      workspaceId: 'workspace-connector-audit',
      installedByUserId: 'user-connector-audit',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Audited GitHub',
        scopes: ['repo'],
        credential: 'connector-install-secret',
      },
    })
    const oauthStateId = 'a'.repeat(32)
    const installTransaction = memory.commands.at(-1)
    const installWrites = installTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }>
    expect(installTransaction?.name).toBe('TransactWriteCommand')
    expect(installWrites).toHaveLength(2)
    expect(installWrites[1]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'connector.installed',
        entity: { type: 'connector-installation', id: installation.id },
        metadata: {
          provider: 'github',
          category: 'source-control',
          credentialConfigured: true,
        },
      },
    })
    expect(JSON.stringify(installWrites[1]?.Put?.Item))
      .not.toContain('connector-install-secret')

    memory.commands.splice(0)
    await client.updateConnectorStatus({
      workspaceId: 'workspace-connector-audit',
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: 'https://provider.test/oauth/authorize?state=signed-state',
      reauthorizationStateId: oauthStateId,
      updatedByUserId: 'user-connector-audit',
    })
    const reauthorizationTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const reauthorizationWrites =
      reauthorizationTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }>
    expect(reauthorizationWrites).toHaveLength(2)
    expect(reauthorizationWrites[1]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'connector.reauthorization.started',
        metadata: {
          provider: 'github',
          previousStatus: 'connected',
          status: 'needs-reauth',
          oauthStateRevision: 1,
        },
      },
    })
    expect(JSON.stringify(reauthorizationWrites[1]?.Put?.Item))
      .not.toContain(oauthStateId)
    expect(JSON.stringify(reauthorizationWrites[1]?.Put?.Item))
      .not.toContain('signed-state')
    const reauthorizationRecord = structuredClone(memory.items.get(
      `workspace-connector-audit\0CONNECTOR#${installation.id}`,
    ))
    expect(reauthorizationRecord).toMatchObject({
      connectorOAuthStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      connectorOAuthStateRevision: 1,
    })
    expect(JSON.stringify(reauthorizationRecord)).not.toContain(oauthStateId)

    const firstReauthorizationSnapshot =
      await client.readConnectorLifecycleSnapshot({
        workspaceId: 'workspace-connector-audit',
        installationId: installation.id,
      })
    memory.commands.splice(0)
    await expect(client.updateConnectorStatus({
      workspaceId: 'workspace-connector-audit',
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl:
        'https://provider.test/oauth/authorize?state=signed-state',
      reauthorizationStateId: oauthStateId,
      updatedByUserId: 'user-connector-audit',
      expectedLifecycleRevision:
        firstReauthorizationSnapshot.lifecycleRevision,
    })).resolves.toEqual(firstReauthorizationSnapshot.installation)
    expect(memory.commands.filter(
      ({ name }) => name === 'TransactWriteCommand',
    )).toHaveLength(0)

    memory.commands.splice(0)
    await client.recoverConnector({
      workspaceId: 'workspace-connector-audit',
      installationId: installation.id,
      credential: 'connector-reauthorized-secret',
      expectedReauthorizationStateId: oauthStateId,
      reason: 'reauthorization',
      updatedByUserId: 'user-connector-audit',
    })
    const replacementTransaction = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )
    const replacementWrites = replacementTransaction?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }>
    expect(replacementWrites).toHaveLength(2)
    expect(replacementWrites[1]?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'connector.credential.replaced',
        metadata: {
          reason: 'reauthorization',
          previousCredentialRevision: 1,
          credentialRevision: 2,
        },
      },
    })
    expect(JSON.stringify(replacementWrites[1]?.Put?.Item))
      .not.toContain('connector-reauthorized-secret')
    expect(JSON.stringify(replacementWrites[1]?.Put?.Item))
      .not.toContain(oauthStateId)
    const recoveredRecord = memory.items.get(
      `workspace-connector-audit\0CONNECTOR#${installation.id}`,
    )
    expect(recoveredRecord).not.toHaveProperty('connectorOAuthStateDigest')
    expect(recoveredRecord).toMatchObject({
      connectorOAuthStateRevision: 2,
      connectorCredentialRevision: 2,
    })
  })

  test('requires creator authorization and matching Team scope before enqueue', async () => {
    const { client } = createClient()
    const createSubscription = async (
      name: string,
      createdByUserId: string,
      teamIds: string[],
    ) => await client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId,
      input: {
        name,
        url: `https://hooks.example.test/${name.toLowerCase()}`,
        teamIds,
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    const allowed = await createSubscription('Allowed', 'user-allowed', ['team-1'])
    const unauthorized = await createSubscription(
      'Unauthorized',
      'user-no-longer-authorized',
      ['team-1'],
    )
    const wrongTeam = await createSubscription('WrongTeam', 'user-team-2', ['team-2'])
    expect(allowed.subscription).toMatchObject({
      createdByUserId: 'user-allowed',
      teamIds: ['team-1'],
    })

    await expect(client.enqueueWebhookEvent({
      workspaceId: 'workspace-1',
      authorizedSubscriptionIds: [
        allowed.subscription.id,
        wrongTeam.subscription.id,
      ],
      event: createWebhookEvent('event-authorized'),
    })).resolves.toEqual([
      expect.objectContaining({ subscriptionId: allowed.subscription.id }),
    ])
    expect(unauthorized.subscription.createdByUserId).toBe('user-no-longer-authorized')
    await expect(client.enqueueWebhookEvent({
      workspaceId: 'workspace-1',
      authorizedSubscriptionIds: [],
      event: createWebhookEvent('event-empty-allowlist'),
    })).resolves.toEqual([])
    await expect(client.enqueueWebhookEvent({
      workspaceId: 'workspace-1',
      authorizedSubscriptionIds: [allowed.subscription.id],
      event: {
        ...createWebhookEvent('event-missing-team'),
        data: { workItemId: 'work-item-1' },
      },
    })).rejects.toMatchObject({
      status: 400,
      code: 'WebhookEventTeamScopeMissing',
    })
  })

  test('encrypts one-time signing secret and binds tamper-evident cursor to tenant and filter', async () => {
    const { client } = createClient()
    const created = await client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Work Item changes',
        url: 'https://hooks.example.test/mukuroji',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    expect(created.signingSecret).toStartWith('mk_webhook_')
    expect(JSON.stringify(await client.listWebhookSubscriptions('workspace-1')))
      .not.toContain(created.signingSecret)
    const subscriptionRow = readStoredRows(client)
      .find((row) => row.entryType === 'webhook-subscription')
    expect(subscriptionRow?.secretCiphertext).toMatch(/^v1\./)
    expect(JSON.stringify(subscriptionRow)).not.toContain(created.signingSecret)
    await expect(client.updateWebhookSubscription({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      input: {
        eventTypes: ['import.failed'],
        scopes: ['work-items:read'],
      },
    })).rejects.toMatchObject({ status: 400, code: 'WebhookEventScopeInvalid' })
    const webhookUpdateRequest = {
      workspaceId: 'workspace-1',
      credentialId: 'management:user-1',
      idempotencyKey: 'update-webhook-metadata',
      requestFingerprint: 'PATCH:/developer/webhook-subscriptions',
    }
    const webhookUpdateReservation = await client.reserveIdempotency(
      webhookUpdateRequest,
    )
    if (webhookUpdateReservation.status !== 'reserved') {
      throw new Error('Webhook update reservation was not created.')
    }
    const updated = await client.updateWebhookSubscription({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      input: {
        name: 'Work Item delivery v2',
        url: 'https://hooks.example.test/mukuroji-v2',
        eventTypes: ['work-item.created', 'work-item.updated'],
        scopes: ['work-items:read'],
      },
      idempotency: {
        credentialId: webhookUpdateRequest.credentialId,
        idempotencyKey: webhookUpdateRequest.idempotencyKey,
        requestFingerprint: webhookUpdateRequest.requestFingerprint,
        reservationId: webhookUpdateReservation.reservationId,
      },
    })
    expect(updated).toMatchObject({
      name: 'Work Item delivery v2',
      url: 'https://hooks.example.test/mukuroji-v2',
      createdByUserId: 'user-1',
      teamIds: ['team-1'],
      status: 'active',
    })
    await expect(client.reserveIdempotency(webhookUpdateRequest)).resolves.toEqual({
      status: 'replay',
      response: { status: 200, body: updated },
    })
    const updatedRow = readStoredRows(client)
      .find((row) => row.entryType === 'webhook-subscription')
    expect(updatedRow?.secretCiphertext).toBe(subscriptionRow?.secretCiphertext)
    const rotated = await client.rotateWebhookSecret({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
    })
    expect(rotated.signingSecret).not.toBe(created.signingSecret)
    expect(JSON.stringify(await client.listWebhookSubscriptions('workspace-1')))
      .not.toContain(rotated.signingSecret)
    await expect(client.rotateWebhookSecret({
      workspaceId: 'workspace-2',
      subscriptionId: created.subscription.id,
    })).rejects.toMatchObject({ status: 404, code: 'WebhookSubscriptionNotFound' })

    for (const eventId of ['event-1', 'event-2', 'event-3']) {
      await client.enqueueWebhookEvent({
        workspaceId: 'workspace-1',
        authorizedSubscriptionIds: [created.subscription.id],
        event: createWebhookEvent(eventId),
      })
    }
    const firstPage = await client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      limit: 1,
    })
    expect(firstPage.deliveries).toHaveLength(1)
    expect(firstPage.nextCursor).toBeDefined()
    const secondPage = await client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.deliveries).toHaveLength(1)
    expect(secondPage.deliveries[0]?.id).not.toBe(firstPage.deliveries[0]?.id)

    await expect(client.listWebhookDeliveries({
      workspaceId: 'workspace-2',
      subscriptionId: created.subscription.id,
      limit: 1,
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ status: 400, code: 'WebhookCursorInvalid' })
    await expect(client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
      limit: 1,
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ status: 400, code: 'WebhookCursorInvalid' })
    await expect(client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      limit: 1,
      cursor: `${firstPage.nextCursor}x`,
    })).rejects.toMatchObject({ status: 400, code: 'WebhookCursorInvalid' })
  })

  test('rejects signatures and destroys the signing secret after irreversible disablement', async () => {
    const { client } = createClient()
    const created = await client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Disable signing',
        url: 'https://hooks.example.test/disable-signing',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    const timestamp = Math.floor(START.getTime() / 1_000)
    const payload = JSON.stringify(createWebhookEvent('event-disable-signing'))
    const signature = createWebhookSignature(created.signingSecret, timestamp, payload)

    await expect(client.verifyWebhookSignature({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      payload,
      timestamp,
      signature,
    })).resolves.toBe(true)
    await client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      status: 'paused',
    })
    await expect(client.listActiveWebhookSubscriptionsPage({
      workspaceId: 'workspace-1',
      limit: 50,
    })).resolves.toEqual({ subscriptions: [] })
    expect(readStoredRows(client)
      .find((row) => row.entryType === 'webhook-subscription'))
      .not.toHaveProperty('lookupKey')
    await client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      status: 'active',
    })
    await expect(client.listActiveWebhookSubscriptionsPage({
      workspaceId: 'workspace-1',
      limit: 50,
    })).resolves.toMatchObject({
      subscriptions: [
        expect.objectContaining({ id: created.subscription.id }),
      ],
    })
    await client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      status: 'disabled',
    })

    const disabledRow = readStoredRows(client)
      .find((row) => row.entryType === 'webhook-subscription')
    expect(disabledRow).not.toHaveProperty('secretCiphertext')
    expect(disabledRow).not.toHaveProperty('lookupKey')
    expect(disabledRow).not.toHaveProperty('lookupSortKey')
    expect(disabledRow?.expiresAt).toBe(
      Math.floor(START.getTime() / 1_000) +
        WEBHOOK_DISABLED_SUBSCRIPTION_RETENTION_SECONDS,
    )
    await expect(client.listActiveWebhookSubscriptionsPage({
      workspaceId: 'workspace-1',
      limit: 50,
    })).resolves.toEqual({ subscriptions: [] })
    await expect(client.verifyWebhookSignature({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      payload,
      timestamp,
      signature,
    })).resolves.toBe(false)
    await expect(client.rotateWebhookSecret({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
    })).rejects.toMatchObject({ status: 409, code: 'WebhookSubscriptionDisabled' })
    await expect(client.setWebhookSubscriptionStatus({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      status: 'active',
    })).rejects.toMatchObject({ status: 409, code: 'WebhookSubscriptionDisabled' })
  })

  test('enqueues deterministically, prepares signed payload, records retries, and replays', async () => {
    const { client, clock } = createClient()
    const created = await client.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Delivery',
        url: 'https://hooks.example.test/delivery',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    const request = {
      workspaceId: 'workspace-1',
      authorizedSubscriptionIds: [created.subscription.id],
      event: createWebhookEvent('event-stable'),
    }
    const first = await client.enqueueWebhookEvent(request)
    const duplicate = await client.enqueueWebhookEvent(request)
    expect(duplicate[0]?.id).toBe(first[0]?.id)
    expect(await client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
    })).toMatchObject({ deliveries: [{ id: first[0]?.id }] })
    await expect(client.getWebhookDelivery({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
    })).resolves.toMatchObject({ id: first[0]?.id })
    await expect(client.getWebhookDelivery({
      workspaceId: 'workspace-2',
      deliveryId: first[0]!.id,
    })).rejects.toMatchObject({ status: 404, code: 'WebhookDeliveryNotFound' })

    const prepared = await client.prepareWebhookDelivery({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
    })
    expect(prepared.signingSecret).toBe(created.signingSecret)
    expect(JSON.parse(prepared.payload)).toMatchObject({
      id: 'event-stable',
      workspaceId: 'workspace-1',
    })
    const timestamp = Math.floor(START.getTime() / 1_000)
    const signature = createWebhookSignature(
      prepared.signingSecret,
      timestamp,
      prepared.payload,
    )
    await expect(client.verifyWebhookSignature({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      payload: prepared.payload,
      timestamp,
      signature,
    })).resolves.toBe(true)
    await expect(client.verifyWebhookSignature({
      workspaceId: 'workspace-1',
      subscriptionId: created.subscription.id,
      payload: `${prepared.payload} `,
      timestamp,
      signature,
    })).resolves.toBe(false)

    const retrying = await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
      status: 'retrying',
      responseStatus: 503,
      nextAttemptAt: new Date(START.getTime() + 60_000).toISOString(),
      error: 'remote unavailable',
    })
    expect(retrying).toMatchObject({ status: 'retrying', attempts: 1, responseStatus: 503 })
    clock.advanceSeconds(60)
    const delivered = await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
      status: 'delivered',
      responseStatus: 204,
    })
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(delivered.deliveredAt).toBe(clock.now().toISOString())

    const replayed = await client.replayWebhookDelivery({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
    })
    expect(replayed).toMatchObject({
      status: 'pending',
      attempts: 0,
      replayOfDeliveryId: first[0]!.id,
      replayNumber: 1,
    })
    expect(replayed.id).not.toBe(first[0]!.id)
    expect(replayed.responseStatus).toBeUndefined()
    expect(replayed.deliveredAt).toBeUndefined()
    await expect(client.replayWebhookDelivery({
      workspaceId: 'workspace-1',
      deliveryId: first[0]!.id,
    })).resolves.toMatchObject({ id: replayed.id, replayNumber: 1 })
    const afterFirstReplay = await client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
    })
    expect(afterFirstReplay.deliveries).toHaveLength(2)
    expect(
      afterFirstReplay.deliveries.find((delivery) => delivery.id === first[0]!.id),
    ).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 204 })

    await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-1',
      deliveryId: replayed.id,
      status: 'failed',
      responseStatus: 500,
    })
    const concurrentReplays = await Promise.all([
      client.replayWebhookDelivery({
        workspaceId: 'workspace-1',
        deliveryId: first[0]!.id,
      }),
      client.replayWebhookDelivery({
        workspaceId: 'workspace-1',
        deliveryId: replayed.id,
      }),
    ])
    expect(concurrentReplays[0]).toMatchObject({
      replayOfDeliveryId: first[0]!.id,
      replayNumber: 2,
      status: 'pending',
    })
    expect(concurrentReplays[1]?.id).toBe(concurrentReplays[0]?.id)
    expect((await client.listWebhookDeliveries({
      workspaceId: 'workspace-1',
    })).deliveries).toHaveLength(3)
  })

  test('binds replay creation and terminal retries to the operation ID', async () => {
    const { client } = createClient()
    const subscription = await client.createWebhookSubscription({
      workspaceId: 'workspace-replay-operation',
      createdByUserId: 'user-replay-operation',
      input: {
        name: 'Operation replay',
        url: 'https://hooks.example.test/operation-replay',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    const original = (await client.enqueueWebhookEvent({
      workspaceId: 'workspace-replay-operation',
      authorizedSubscriptionIds: [subscription.subscription.id],
      event: createWebhookEvent(
        'event-replay-operation',
        'workspace-replay-operation',
      ),
    }))[0]!
    await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-replay-operation',
      deliveryId: original.id,
      status: 'failed',
      responseStatus: 500,
    })

    const first = await client.replayWebhookDelivery({
      workspaceId: 'workspace-replay-operation',
      deliveryId: original.id,
      operationId: 'a'.repeat(64),
    })
    expect(first).toMatchObject({
      replayOfDeliveryId: original.id,
      replayNumber: 1,
      status: 'pending',
    })
    const independent = await client.replayWebhookDelivery({
      workspaceId: 'workspace-replay-operation',
      deliveryId: original.id,
      operationId: 'b'.repeat(64),
    })
    expect(independent).toMatchObject({
      replayOfDeliveryId: original.id,
      replayNumber: 2,
      status: 'pending',
    })
    expect(independent.id).not.toBe(first.id)

    const failed = await client.recordWebhookDeliveryAttempt({
      workspaceId: 'workspace-replay-operation',
      deliveryId: first.id,
      status: 'failed',
      responseStatus: 502,
    })
    await expect(client.replayWebhookDelivery({
      workspaceId: 'workspace-replay-operation',
      deliveryId: original.id,
      operationId: 'a'.repeat(64),
    })).resolves.toEqual(failed)
    expect((await client.listWebhookDeliveries({
      workspaceId: 'workspace-replay-operation',
    })).deliveries).toHaveLength(3)
  })

  test('records different delivery attempts concurrently without subscription CAS loss', async () => {
    const { client } = createClient()
    const workspaceId = 'workspace-concurrent-deliveries'
    const created = await client.createWebhookSubscription({
      workspaceId,
      createdByUserId: 'user-concurrent-deliveries',
      input: {
        name: 'Concurrent deliveries',
        url: 'https://hooks.example.test/concurrent-deliveries',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
    })
    const first = (await client.enqueueWebhookEvent({
      workspaceId,
      authorizedSubscriptionIds: [created.subscription.id],
      event: createWebhookEvent('event-concurrent-delivery-1', workspaceId),
    }))[0]!
    const second = (await client.enqueueWebhookEvent({
      workspaceId,
      authorizedSubscriptionIds: [created.subscription.id],
      event: createWebhookEvent('event-concurrent-delivery-2', workspaceId),
    }))[0]!

    const [failed, delivered] = await Promise.all([
      client.recordWebhookDeliveryAttempt({
        workspaceId,
        deliveryId: first.id,
        status: 'failed',
        responseStatus: 500,
      }),
      client.recordWebhookDeliveryAttempt({
        workspaceId,
        deliveryId: second.id,
        status: 'delivered',
        responseStatus: 204,
      }),
    ])

    expect(failed).toMatchObject({ id: first.id, status: 'failed', attempts: 1 })
    expect(delivered).toMatchObject({
      id: second.id,
      status: 'delivered',
      attempts: 1,
    })
    expect(readStoredRows(client).find((record) =>
      record.recordKey === `WEBHOOK#${created.subscription.id}`
    )).toMatchObject({
      version: 3,
      value: { failureCount: 0, lastDeliveryAt: START.toISOString() },
    })
  })
})

describe('connectors, links, and imports', () => {
  test('encrypts connector credential and recovers needs-reauth installation', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub production',
        scopes: ['repo:read', 'issues:write'],
        externalAccountId: 'github-org-1',
        credential: 'github-token-original',
      },
    })
    expect(installation.status).toBe('connected')
    expect(JSON.stringify(await client.listConnectors('workspace-1')))
      .not.toContain('github-token-original')
    const connectorRow = readStoredRows(client)
      .find((row) => row.entryType === 'connector-installation')
    expect(connectorRow?.secretCiphertext).toMatch(/^v1\./)
    expect(JSON.stringify(connectorRow)).not.toContain('github-token-original')

    const needsReauth = await client.updateConnectorStatus({
      workspaceId: 'workspace-1',
      installationId: installation.id,
      status: 'needs-reauth',
      lastError: createProblem('grant expired'),
      reauthorizationUrl: 'https://github.example.test/oauth/authorize',
      reauthorizationStateId: 'b'.repeat(32),
    })
    expect(needsReauth).toMatchObject({
      status: 'needs-reauth',
      lastError: {
        detail: 'The provider request could not be completed and may be retried.',
      },
    })

    const recovered = await client.recoverConnector({
      workspaceId: 'workspace-1',
      installationId: installation.id,
      credential: 'github-token-recovered',
      expectedReauthorizationStateId: 'b'.repeat(32),
      reason: 'reauthorization',
    })
    expect(recovered.status).toBe('connected')
    expect(recovered.lastError).toBeUndefined()
    expect(recovered.reauthorizationUrl).toBeUndefined()
    await expect(client.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installation.id,
    })).resolves.toBe('github-token-recovered')

    const providerSecret = 'ghp_arbitraryUnknownCredentialValue123456789'
    const sanitizedFailure = await client.updateConnectorStatus({
      workspaceId: 'workspace-1',
      installationId: installation.id,
      status: 'degraded',
      lastError: {
        ...createProblem(`token=${providerSecret} upstream rejected authorization`),
        type: 'https://provider.invalid/problem',
        title: `Opaque upstream body ${providerSecret}`,
        instance: '/provider/internal',
        requestId: providerSecret,
        errors: [{
          pointer: '/credential',
          code: 'provider_secret',
          message: providerSecret,
        }],
      },
    })
    expect(sanitizedFailure.lastError).toEqual({
      type: 'https://docs.mukuroji.app/problems/temporarily_unavailable',
      title: 'Provider temporarily unavailable',
      status: 503,
      code: 'temporarily_unavailable',
      detail: 'The provider request could not be completed and may be retried.',
      requestId: 'provider-error',
      retryable: true,
    })
    expect(JSON.stringify(readStoredRows(client))).not.toContain(providerSecret)

    for (const status of ['degraded', 'conflict', 'disconnected'] as const) {
      await expect(client.updateConnectorStatus({
        workspaceId: 'workspace-1',
        installationId: installation.id,
        status,
        ...(status === 'degraded' ? { lastError: createProblem('provider degraded') } : {}),
      })).resolves.toMatchObject({ status })
    }
    const disconnectedRow = readStoredRows(client)
      .find((row) => row.recordKey === `CONNECTOR#${installation.id}`)
    expect(disconnectedRow).not.toHaveProperty('secretCiphertext')
    await expect(client.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installation.id,
    })).rejects.toMatchObject({ status: 409, code: 'ConnectorDisconnected' })
    await expect(client.recoverConnector({
      workspaceId: 'workspace-1',
      installationId: installation.id,
      credential: 'github-token-final',
    })).resolves.toMatchObject({ status: 'connected' })
  })

  test('compare-and-sets connector refresh credentials against the previous serialization', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-credential-cas',
      installedByUserId: 'user-credential-cas',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Credential CAS GitHub',
        scopes: ['repo'],
        credential: 'credential-before-refresh',
      },
    })
    const firstClaimId = 'credential-refresh-claim-a'
    const secondClaimId = 'credential-refresh-claim-b'
    await expect(client.claimConnectorCredentialRefresh({
      workspaceId: 'workspace-credential-cas',
      installationId: installation.id,
      expectedCredential: 'credential-before-refresh',
      claimId: firstClaimId,
    })).resolves.toBe('claimed')
    await expect(client.claimConnectorCredentialRefresh({
      workspaceId: 'workspace-credential-cas',
      installationId: installation.id,
      expectedCredential: 'credential-before-refresh',
      claimId: secondClaimId,
    })).resolves.toBe('busy')
    await expect(client.recoverConnector({
      workspaceId: 'workspace-credential-cas',
      installationId: installation.id,
      credential: 'credential-refresh-a',
      expectedCredential: 'credential-before-refresh',
      refreshClaimId: firstClaimId,
      reason: 'refresh',
    })).resolves.toMatchObject({ status: 'connected' })
    await expect(client.recoverConnector({
      workspaceId: 'workspace-credential-cas',
      installationId: installation.id,
      credential: 'credential-refresh-b',
      expectedCredential: 'credential-before-refresh',
      refreshClaimId: secondClaimId,
      reason: 'refresh',
    })).rejects.toMatchObject({
      status: 409,
      code: 'ConnectorCredentialChanged',
    })
    const storedCredential = await client.readConnectorCredential({
      workspaceId: 'workspace-credential-cas',
      installationId: installation.id,
    })
    expect(storedCredential).toBe('credential-refresh-a')
    const row = readStoredRows(client).find(
      (candidate) => candidate.recordKey === `CONNECTOR#${installation.id}`,
    )
    expect(row).toMatchObject({
      connectorCredentialRevision: 2,
      connectorOAuthStateRevision: 0,
    })
    expect(row?.connectorCredentialDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row).not.toHaveProperty('connectorCredentialRefreshClaimDigest')
    expect(row).not.toHaveProperty('connectorCredentialRefreshClaimedAt')
    expect(JSON.stringify(row)).not.toContain('credential-before-refresh')
    expect(JSON.stringify(row)).not.toContain('credential-refresh-a')
    expect(JSON.stringify(row)).not.toContain('credential-refresh-b')
  })

  test('reclaims expired refresh leases and releases only the current owner', async () => {
    let now = START
    const client = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(17)),
      () => now,
    )
    const installation = await client.installConnector({
      workspaceId: 'workspace-refresh-lease',
      installedByUserId: 'user-refresh-lease',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Refresh Lease GitHub',
        scopes: ['repo'],
        credential: 'credential-refresh-lease',
      },
    })
    const request = {
      workspaceId: 'workspace-refresh-lease',
      installationId: installation.id,
      expectedCredential: 'credential-refresh-lease',
      claimId: 'refresh-lease-operation',
    }
    await expect(client.claimConnectorCredentialRefresh(request))
      .resolves.toBe('claimed')
    await expect(client.claimConnectorCredentialRefresh(request))
      .resolves.toBe('same-operation')
    await expect(client.releaseConnectorCredentialRefresh({
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      claimId: 'another-refresh-operation',
    })).resolves.toBe(false)
    const takeoverRequest = {
      ...request,
      claimId: 'refresh-lease-takeover-operation',
    }
    now = new Date(START.getTime() + 61_000)
    await expect(client.claimConnectorCredentialRefresh(takeoverRequest))
      .resolves.toBe('claimed')
    await expect(client.releaseConnectorCredentialRefresh({
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      claimId: request.claimId,
    })).resolves.toBe(false)
    await expect(client.releaseConnectorCredentialRefresh({
      workspaceId: takeoverRequest.workspaceId,
      installationId: takeoverRequest.installationId,
      claimId: takeoverRequest.claimId,
    })).resolves.toBe(true)
  })

  test('retries refreshed credential storage after a status-only concurrent mutation', async () => {
    const protector =
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(18))
    const protect = protector.protect.bind(protector)
    let client!: InMemoryDeveloperPlatformClient
    let installationId = ''
    let raced = false
    protector.protect = async (plaintext, context) => {
      if (plaintext === 'credential-after-status-race' && !raced) {
        raced = true
        await client.updateConnectorStatus({
          workspaceId: 'workspace-refresh-status-race',
          installationId,
          status: 'degraded',
          lastError: createProblem('status-only race'),
        })
      }
      return protect(plaintext, context)
    }
    client = new InMemoryDeveloperPlatformClient(protector, () => START)
    const installation = await client.installConnector({
      workspaceId: 'workspace-refresh-status-race',
      installedByUserId: 'user-refresh-status-race',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Refresh Status Race',
        scopes: ['repo'],
        credential: 'credential-before-status-race',
      },
    })
    installationId = installation.id
    const refreshClaimId = 'credential-refresh-status-race-claim'
    await client.claimConnectorCredentialRefresh({
      workspaceId: 'workspace-refresh-status-race',
      installationId: installation.id,
      expectedCredential: 'credential-before-status-race',
      claimId: refreshClaimId,
    })

    await expect(client.recoverConnector({
      workspaceId: 'workspace-refresh-status-race',
      installationId: installation.id,
      credential: 'credential-after-status-race',
      expectedCredential: 'credential-before-status-race',
      refreshClaimId,
      reason: 'refresh',
    })).resolves.toMatchObject({ status: 'connected' })
    expect(raced).toBe(true)
    await expect(client.readConnectorCredential({
      workspaceId: 'workspace-refresh-status-race',
      installationId: installation.id,
    })).resolves.toBe('credential-after-status-race')
  })

  test('does not let an older refresh erase a newer reauthorization state', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-refresh-reauth-race',
      installedByUserId: 'user-refresh-reauth-race',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Refresh Reauth Race',
        scopes: ['repo'],
        credential: 'credential-before-reauth',
      },
    })
    const stateId = 'd'.repeat(32)
    const refreshClaimId = 'credential-refresh-reauth-race-claim'
    await client.claimConnectorCredentialRefresh({
      workspaceId: 'workspace-refresh-reauth-race',
      installationId: installation.id,
      expectedCredential: 'credential-before-reauth',
      claimId: refreshClaimId,
    })
    await client.updateConnectorStatus({
      workspaceId: 'workspace-refresh-reauth-race',
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: 'https://provider.test/oauth/authorize',
      reauthorizationStateId: stateId,
    })

    await expect(client.recoverConnector({
      workspaceId: 'workspace-refresh-reauth-race',
      installationId: installation.id,
      credential: 'credential-from-stale-refresh',
      expectedCredential: 'credential-before-reauth',
      refreshClaimId,
      reason: 'refresh',
    })).rejects.toMatchObject({
      status: 409,
      code: 'ConnectorReauthorizationStateRequired',
    })
    expect((await client.listConnectors('workspace-refresh-reauth-race'))[0])
      .toMatchObject({
        status: 'needs-reauth',
        reauthorizationUrl: 'https://provider.test/oauth/authorize',
      })
    await expect(client.readConnectorCredential({
      workspaceId: 'workspace-refresh-reauth-race',
      installationId: installation.id,
    })).resolves.toBe('credential-before-reauth')
  })

  test('disconnect preserves links while removing paused links from the global poll inventory', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-disconnect-links',
      installedByUserId: 'user-disconnect-links',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Disconnect GitHub',
        scopes: ['repo'],
        credential: 'disconnect-link-credential',
      },
    })
    const link = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-disconnect-links',
      input: {
        teamId: 'team-disconnect-links',
        workItemId: 'work-item-disconnect-links',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'issue-disconnect-links',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })
    const pollTargetRow = readStoredRows(client).find(
      (candidate) => candidate.entryType === 'connector-poll-target',
    )
    expect(pollTargetRow).toMatchObject({
      value: {
        installationId: installation.id,
        resourceType: 'issue',
      },
      pollableLinkCount: 1,
    })

    await client.updateConnectorStatus({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
      status: 'needs-reauth',
      lastError: createProblem('reauthorization needed'),
      reauthorizationUrl: 'https://provider.test/oauth/authorize',
      reauthorizationStateId: 'c'.repeat(32),
    })
    const disconnected = await client.updateConnectorStatus({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
      status: 'disconnected',
    })
    expect(disconnected).not.toHaveProperty('lastError')
    expect(disconnected).not.toHaveProperty('reauthorizationUrl')
    expect((await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
    }))[0]).toMatchObject({
      id: link.id,
      syncStatus: 'pending',
    })
    const snapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
    })
    await expect(client.pauseConnectorExternalLinksPage({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 25,
    })).resolves.toEqual({ paused: 1 })
    const links = await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-disconnect-links',
      installationId: installation.id,
    })
    expect(links).toEqual([
      expect.objectContaining({
        id: link.id,
        syncDirection: 'bidirectional',
        syncStatus: 'paused',
      }),
    ])
    expect(readStoredRows(client).find(
      (candidate) => candidate.entryType === 'connector-poll-target',
    )).toMatchObject({ pollableLinkCount: 0 })
  })

  test('disconnect strongly reconciles links before a lookup GSI is visible', async () => {
    const clock = createClock()
    const client = new LaggingLookupDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(4)),
      clock.now,
    )
    const workspaceId = 'workspace-disconnect-gsi-lag'
    const installation = await client.installConnector({
      workspaceId,
      installedByUserId: 'user-disconnect-gsi-lag',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Lagging GitHub',
        scopes: ['repo'],
        credential: 'disconnect-gsi-lag-credential',
      },
    })
    const link = await client.createExternalWorkItemLink({
      workspaceId,
      input: {
        teamId: 'team-disconnect-gsi-lag',
        workItemId: 'work-item-disconnect-gsi-lag',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'issue-disconnect-gsi-lag',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })

    await client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'disconnected',
    })
    const snapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })
    expect(snapshot.disconnectCleanupRevision).toBe(snapshot.lifecycleRevision)
    await expect(client.pauseConnectorExternalLinksPage({
      workspaceId,
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 25,
    })).resolves.toEqual({ paused: 1 })

    expect(readStoredRows(client).find((record) =>
      record.recordKey === `EXTERNALLINK#${link.id}`
    )).toMatchObject({
      value: { syncStatus: 'paused' },
    })
    expect(readStoredRows(client).find((record) =>
      record.entryType === 'connector-poll-target'
    )).toMatchObject({ pollableLinkCount: 0 })
  })

  test('pauses disconnected links through bounded durable continuation pages', async () => {
    const { client } = createClient()
    const workspaceId = 'workspace-disconnect-pages'
    const installation = await client.installConnector({
      workspaceId,
      installedByUserId: 'user-disconnect-pages',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Paged GitHub',
        scopes: ['repo'],
        credential: 'disconnect-pages-credential',
      },
    })
    for (const sequence of [1, 2, 3]) {
      await client.createExternalWorkItemLink({
        workspaceId,
        input: {
          teamId: 'team-disconnect-pages',
          workItemId: `work-item-disconnect-pages-${sequence}`,
          installationId: installation.id,
          resourceType: 'issue',
          externalId: `issue-disconnect-pages-${sequence}`,
          externalUrl: `https://provider.test/issues/${sequence}`,
          syncDirection: 'bidirectional',
        },
      })
    }
    await client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'disconnected',
    })
    const snapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })

    const first = await client.pauseConnectorExternalLinksPage({
      workspaceId,
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 1,
    })
    expect(first.paused).toBe(1)
    expect(typeof first.nextCursor).toBe('string')
    await expect(client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: 'https://provider.test/oauth/authorize',
      reauthorizationStateId: 'd'.repeat(32),
      updatedByUserId: 'user-disconnect-pages',
      expectedLifecycleRevision: snapshot.lifecycleRevision,
    })).rejects.toMatchObject({
      code: 'ConnectorDisconnectCleanupPending',
      status: 409,
    })
    if (!first.nextCursor) throw new Error('First disconnect cursor was not created.')
    const second = await client.pauseConnectorExternalLinksPage({
      workspaceId,
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.paused).toBe(1)
    expect(typeof second.nextCursor).toBe('string')
    if (!second.nextCursor) throw new Error('Second disconnect cursor was not created.')
    await expect(client.pauseConnectorExternalLinksPage({
      workspaceId,
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 1,
      cursor: second.nextCursor,
    })).resolves.toEqual({ paused: 1 })
    const completedSnapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })
    expect(completedSnapshot.lifecycleRevision).toBe(snapshot.lifecycleRevision)
    expect(completedSnapshot.disconnectCleanupRevision).toBeUndefined()
    await expect(client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: 'https://provider.test/oauth/authorize',
      reauthorizationStateId: 'd'.repeat(32),
      updatedByUserId: 'user-disconnect-pages',
      expectedLifecycleRevision: completedSnapshot.lifecycleRevision,
    })).resolves.toMatchObject({ status: 'needs-reauth' })
    expect(await client.listExternalWorkItemLinks({
      workspaceId,
      installationId: installation.id,
    })).toEqual([
      expect.objectContaining({ syncStatus: 'paused' }),
      expect.objectContaining({ syncStatus: 'paused' }),
      expect.objectContaining({ syncStatus: 'paused' }),
    ])
    expect(readStoredRows(client).find(
      (record) => record.entryType === 'connector-poll-target',
    )).toMatchObject({ pollableLinkCount: 0 })
  })

  test('keeps disconnect cleanup durable when link deletion advances the storage version', async () => {
    const { client } = createClient()
    const workspaceId = 'workspace-disconnect-version-drift'
    const installation = await client.installConnector({
      workspaceId,
      installedByUserId: 'user-disconnect-version-drift',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Version Drift GitHub',
        scopes: ['repo'],
        credential: 'disconnect-version-drift-credential',
      },
    })
    const links = []
    for (const sequence of [1, 2]) {
      links.push(await client.createExternalWorkItemLink({
        workspaceId,
        input: {
          teamId: 'team-disconnect-version-drift',
          workItemId: `work-item-disconnect-version-drift-${sequence}`,
          installationId: installation.id,
          resourceType: 'issue',
          externalId: `issue-disconnect-version-drift-${sequence}`,
          externalUrl: `https://provider.test/issues/${sequence}`,
          syncDirection: 'bidirectional',
        },
      }))
    }
    await client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'disconnected',
    })
    const disconnectSnapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })
    await client.deleteExternalWorkItemLink({
      workspaceId,
      teamId: links[0]!.teamId,
      workItemId: links[0]!.workItemId,
      linkId: links[0]!.id,
    })
    const driftedSnapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })
    expect(driftedSnapshot.lifecycleRevision).toBeGreaterThan(
      disconnectSnapshot.lifecycleRevision,
    )
    expect(driftedSnapshot.disconnectCleanupRevision).toBe(
      disconnectSnapshot.disconnectCleanupRevision,
    )

    await expect(client.pauseConnectorExternalLinksPage({
      workspaceId,
      installationId: installation.id,
      expectedLifecycleRevision: disconnectSnapshot.disconnectCleanupRevision!,
      limit: 25,
    })).resolves.toEqual({ paused: 1 })
    const completedSnapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId: installation.id,
    })
    expect(completedSnapshot.lifecycleRevision).toBe(
      driftedSnapshot.lifecycleRevision,
    )
    expect(completedSnapshot.disconnectCleanupRevision).toBeUndefined()
    await expect(client.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: 'https://provider.test/oauth/authorize',
      reauthorizationStateId: 'e'.repeat(32),
      updatedByUserId: 'user-disconnect-version-drift',
      expectedLifecycleRevision: completedSnapshot.lifecycleRevision,
    })).resolves.toMatchObject({ status: 'needs-reauth' })
  })

  test('atomically rejects external links at installation and Work Item caps', async () => {
    const { client } = createClient()
    const records = (
      client as unknown as {
        records: Map<string, Record<string, unknown>>
      }
    ).records
    const install = async (workspaceId: string) => client.installConnector({
      workspaceId,
      installedByUserId: 'user-link-cap',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Capped GitHub',
        scopes: ['repo'],
        credential: 'link-cap-credential',
      },
    })
    const cappedInstallation = await install('workspace-installation-link-cap')
    const installationRecord = records.get(
      `workspace-installation-link-cap\0CONNECTOR#${cappedInstallation.id}`,
    )!
    installationRecord.externalLinkCount = EXTERNAL_LINK_INSTALLATION_LIMIT
    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-installation-link-cap',
      input: {
        teamId: 'team-link-cap',
        workItemId: 'work-item-link-cap',
        installationId: cappedInstallation.id,
        resourceType: 'issue',
        externalId: 'issue-installation-link-cap',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })).rejects.toMatchObject({
      status: 413,
      code: 'ExternalWorkItemLinkLimitExceeded',
    })

    const workItemInstallation = await install('workspace-work-item-link-cap')
    const first = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-work-item-link-cap',
      input: {
        teamId: 'team-link-cap',
        workItemId: 'work-item-link-cap',
        installationId: workItemInstallation.id,
        resourceType: 'issue',
        externalId: 'issue-work-item-link-cap-1',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        syncDirection: 'bidirectional',
      },
    })
    const fence = [...records.values()].find((record) =>
      record.workspaceId === 'workspace-work-item-link-cap' &&
      record.entryType === 'work-item-link-fence'
    )!
    fence.activeLinkCount = EXTERNAL_LINK_WORK_ITEM_LIMIT
    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-work-item-link-cap',
      input: {
        teamId: first.teamId,
        workItemId: first.workItemId,
        installationId: workItemInstallation.id,
        resourceType: 'issue',
        externalId: 'issue-work-item-link-cap-2',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/30',
        syncDirection: 'bidirectional',
      },
    })).rejects.toMatchObject({
      status: 413,
      code: 'ExternalWorkItemLinkLimitExceeded',
    })
  })

  test('fences link create and PATCH commits that lose a disconnect race', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-link-disconnect-race',
      installedByUserId: 'user-link-disconnect-race',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Link Disconnect Race',
        scopes: ['repo'],
        credential: 'link-disconnect-race-credential',
      },
    })
    const storage = client as unknown as {
      saveExternalLinkWithClaim: (...args: unknown[]) => Promise<unknown>
      putExternalLinkWithConnectorGuard: (...args: unknown[]) => Promise<unknown>
    }
    const saveLink = storage.saveExternalLinkWithClaim.bind(client)
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    let markCreateReached!: () => void
    const createReached = new Promise<void>((resolve) => {
      markCreateReached = resolve
    })
    storage.saveExternalLinkWithClaim = async (...args) => {
      markCreateReached()
      await createGate
      return saveLink(...args)
    }
    const create = client.createExternalWorkItemLink({
      workspaceId: 'workspace-link-disconnect-race',
      input: {
        teamId: 'team-link-disconnect-race',
        workItemId: 'work-item-link-disconnect-race',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'create-race',
        externalUrl: 'https://provider.test/issues/create-race',
        syncDirection: 'bidirectional',
      },
    })
    const createOutcome = create.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await createReached
    await client.updateConnectorStatus({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
      status: 'disconnected',
    })
    releaseCreate()
    await expect(createOutcome).resolves.toMatchObject({
      error: { code: 'ConnectorNotConnected' },
    })
    expect(await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-link-disconnect-race',
    })).toEqual([])

    const resumed = await client.recoverConnector({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
      credential: 'link-disconnect-race-credential-2',
    })
    const link = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-link-disconnect-race',
      input: {
        teamId: 'team-link-disconnect-race',
        workItemId: 'work-item-link-disconnect-race',
        installationId: resumed.id,
        resourceType: 'issue',
        externalId: 'patch-race',
        externalUrl: 'https://provider.test/issues/patch-race',
        syncDirection: 'bidirectional',
      },
    })
    const putLink = storage.putExternalLinkWithConnectorGuard.bind(client)
    let releasePatch!: () => void
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve
    })
    let markPatchReached!: () => void
    const patchReached = new Promise<void>((resolve) => {
      markPatchReached = resolve
    })
    storage.putExternalLinkWithConnectorGuard = async (...args) => {
      markPatchReached()
      await patchGate
      return putLink(...args)
    }
    const patch = client.updateExternalWorkItemLink({
      workspaceId: 'workspace-link-disconnect-race',
      teamId: 'team-link-disconnect-race',
      workItemId: 'work-item-link-disconnect-race',
      linkId: link.id,
      updatedByUserId: 'user-link-disconnect-race',
      input: { syncDirection: 'outbound' },
    })
    const patchOutcome = patch.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await patchReached
    await client.updateConnectorStatus({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
      status: 'disconnected',
    })
    releasePatch()
    await expect(patchOutcome).resolves.toMatchObject({
      error: { code: 'ConnectorNotConnected' },
    })
    const snapshot = await client.readConnectorLifecycleSnapshot({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
    })
    await client.pauseConnectorExternalLinksPage({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
      expectedLifecycleRevision: snapshot.lifecycleRevision,
      limit: 25,
    })
    expect((await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-link-disconnect-race',
      installationId: installation.id,
    }))[0]).toMatchObject({
      id: link.id,
      syncDirection: 'bidirectional',
      syncStatus: 'paused',
    })
  })

  test('requires a connected source-control connector for external work item links', async () => {
    const { client } = createClient()
    const disconnected = await client.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Disconnected GitHub',
        scopes: ['issues:read'],
        credential: 'github-disconnected',
      },
    })
    await client.updateConnectorStatus({
      workspaceId: 'workspace-1',
      installationId: disconnected.id,
      status: 'disconnected',
    })
    const chat = await client.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'chat',
        provider: 'slack',
        name: 'Slack',
        scopes: ['channels:read'],
        credential: 'slack-connected',
      },
    })
    const input = {
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'issue' as const,
      externalId: 'issue-42',
      externalUrl: 'https://github.example.test/org/repo/issues/42',
      syncDirection: 'inbound' as const,
    }
    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: { ...input, installationId: disconnected.id },
    })).rejects.toMatchObject({ status: 409, code: 'ConnectorNotConnected' })
    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: { ...input, installationId: chat.id },
    })).rejects.toMatchObject({ status: 409, code: 'ConnectorCapabilityUnsupported' })
  })

  test('enforces external identity uniqueness while isolating Workspace claims', async () => {
    const { client, clock } = createClient()
    const firstInstallation = await client.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub',
        scopes: ['issues:read'],
        credential: 'credential-1',
      },
    })
    const linkInput: Omit<
      Parameters<
        InMemoryDeveloperPlatformClient['createExternalWorkItemLink']
      >[0]['input'],
      'teamId' | 'workItemId'
    > = {
      installationId: firstInstallation.id,
      resourceType: 'issue',
      externalId: 'issue-42',
      externalUrl: 'https://github.example.test/org/repo/issues/42',
      displayKey: '#42',
      syncDirection: 'bidirectional',
    }
    const createLink = (
      teamId: string,
      workItemId: string,
      overrides: Partial<typeof linkInput> = {},
    ) =>
      client.createExternalWorkItemLink({
        workspaceId: 'workspace-1',
        input: {
          teamId,
          workItemId,
          ...linkInput,
          ...overrides,
        },
      })
    const first = await createLink('team-1', 'work-item-1')
    const idempotent = await createLink('team-1', 'work-item-1')
    expect(idempotent.id).toBe(first.id)
    await expect(createLink('team-1', 'work-item-1', {
      externalUrl: 'https://github.example.test/org/repo/issues/42-renamed',
    })).rejects.toMatchObject({ status: 409, code: 'ExternalWorkItemLinkConflict' })
    await expect(createLink('team-1', 'work-item-1', {
      displayKey: 'ISSUE-42',
    })).rejects.toMatchObject({ status: 409, code: 'ExternalWorkItemLinkConflict' })
    await expect(createLink('team-1', 'work-item-1', {
      syncDirection: 'outbound',
    })).rejects.toMatchObject({ status: 409, code: 'ExternalWorkItemLinkConflict' })
    await expect(createLink('team-2', 'work-item-1'))
      .rejects.toMatchObject({ status: 409, code: 'ExternalWorkItemLinkConflict' })
    await expect(createLink('team-1', 'work-item-2'))
      .rejects.toMatchObject({ status: 409, code: 'ExternalWorkItemLinkConflict' })

    expect(await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
    })).toHaveLength(1)
    expect(await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-2',
    })).toEqual([])
    await expect(client.updateExternalWorkItemLink({
      workspaceId: 'workspace-2',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      linkId: first.id,
      updatedByUserId: 'user-2',
      input: { syncDirection: 'none' },
    })).rejects.toMatchObject({ status: 404, code: 'ExternalWorkItemLinkNotFound' })
    await expect(client.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: 'team-other',
      workItemId: 'work-item-1',
      linkId: first.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'none' },
    })).rejects.toMatchObject({ status: 404, code: 'ExternalWorkItemLinkNotFound' })
    clock.advanceSeconds(1)
    const paused = await client.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      linkId: first.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'none' },
    })
    expect(paused).toMatchObject({
      id: first.id,
      syncDirection: 'none',
      syncStatus: 'paused',
      updatedAt: new Date(START.getTime() + 1_000).toISOString(),
    })
    clock.advanceSeconds(1)
    await expect(client.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      linkId: first.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'outbound' },
    })).resolves.toMatchObject({
      syncDirection: 'outbound',
      syncStatus: 'pending',
      updatedAt: new Date(START.getTime() + 2_000).toISOString(),
    })

    const secondInstallation = await client.installConnector({
      workspaceId: 'workspace-2',
      installedByUserId: 'user-2',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub',
        scopes: ['issues:read'],
        credential: 'credential-2',
      },
    })
    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-2',
      input: {
        teamId: 'team-2',
        workItemId: 'work-item-2',
        installationId: secondInstallation.id,
        resourceType: 'issue',
        externalId: 'issue-42',
        externalUrl: 'https://github.example.test/org/repo/issues/42',
        syncDirection: 'inbound',
      },
    })).resolves.toMatchObject({ teamId: 'team-2', workItemId: 'work-item-2' })

    await expect(client.deleteExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: 'team-2',
      workItemId: 'work-item-1',
      linkId: first.id,
    })).rejects.toMatchObject({ status: 404, code: 'ExternalWorkItemLinkNotFound' })

    const records = (
      client as unknown as {
        records: Map<string, Record<string, unknown>>
      }
    ).records
    records.set(`workspace-1\0CONNECTORSYNC#${first.id}`, {
      workspaceId: 'workspace-1',
      recordKey: `CONNECTORSYNC#${first.id}`,
      entryType: 'connector-sync-state',
      value: {
        installationId: firstInstallation.id,
        linkId: first.id,
        workItemRevision: 2,
        lastExternalVersion: 'external-v2',
        storageRevision: 1,
        updatedAt: clock.now().toISOString(),
      },
      version: 1,
    })
    const deleteIdempotency = {
      workspaceId: 'workspace-1',
      credentialId: 'user:user-1',
      idempotencyKey: 'delete-link-after-response-loss',
      requestFingerprint: 'DELETE:/developer/external-links/link-1',
    }
    const deleteReservation = await client.reserveIdempotency(deleteIdempotency)
    if (deleteReservation.status !== 'reserved') {
      throw new Error('External link deletion reservation was not created.')
    }
    await client.deleteExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      linkId: first.id,
      deletedByActorId: 'user-1',
      idempotency: {
        credentialId: deleteIdempotency.credentialId,
        idempotencyKey: deleteIdempotency.idempotencyKey,
        requestFingerprint: deleteIdempotency.requestFingerprint,
        reservationId: deleteReservation.reservationId,
      },
    })
    expect(await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-1',
    })).toEqual([])
    expect([...records.values()].some((row) =>
      row.workspaceId === 'workspace-1' &&
      (
        row.recordKey === `CONNECTORSYNC#${first.id}` ||
        row.recordKey === `EXTERNALLINK#${first.id}` ||
        String(row.recordKey).startsWith('EXTERNALCLAIM#') ||
        row.lookupSortKey === `workspace-1#${first.id}`
      )
    )).toBe(false)
    await expect(client.reserveIdempotency(deleteIdempotency)).resolves.toEqual({
      status: 'replay',
      response: { status: 204, body: null },
    })
    await expect(createLink('team-1', 'work-item-after-delete')).resolves.toMatchObject({
      teamId: 'team-1',
      workItemId: 'work-item-after-delete',
    })
  })

  test('revalidates a same-owner link after a concurrent configuration update', async () => {
    const memory = createMemoryDocumentClient()
    let raceTargetKey: string | undefined
    let targetReads = 0
    let raceEnabled = false
    const documentClient = {
      async send(command: {
        input: Record<string, unknown>
        constructor: { name: string }
      }) {
        const key = command.input.Key as
          | { workspaceId?: unknown; recordKey?: unknown }
          | undefined
        if (
          raceEnabled &&
          command.constructor.name === 'GetCommand' &&
          key?.recordKey === raceTargetKey
        ) {
          targetReads += 1
          if (targetReads === 2) {
            const mapKey = `${String(key.workspaceId)}\0${String(key.recordKey)}`
            const current = memory.items.get(mapKey)
            if (!current) throw new Error('Concurrent external link row is missing.')
            memory.items.set(mapKey, {
              ...structuredClone(current),
              value: {
                ...(current.value as Record<string, unknown>),
                syncDirection: 'outbound',
                syncStatus: 'pending',
              },
              version: Number(current.version) + 1,
            })
          }
        }
        return await (
          memory.documentClient as unknown as {
            send(value: typeof command): Promise<unknown>
          }
        ).send(command)
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbDeveloperPlatformClient(
      'DeveloperPlatformTable',
      documentClient,
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(8)),
      () => new Date(START),
      'LookupKeyIndex',
    )
    const installation = await client.installConnector({
      workspaceId: 'workspace-link-race',
      installedByUserId: 'user-link-race',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub race',
        scopes: ['issues:read'],
        credential: 'credential-link-race',
      },
    })
    const input = {
      teamId: 'team-link-race',
      workItemId: 'work-item-link-race',
      installationId: installation.id,
      resourceType: 'issue' as const,
      externalId: 'issue-link-race',
      externalUrl: 'https://github.example.test/org/repo/issues/link-race',
      displayKey: 'RACE-1',
      syncDirection: 'bidirectional' as const,
    }
    const first = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-link-race',
      input,
    })
    raceTargetKey = `EXTERNALLINK#${first.id}`
    raceEnabled = true

    await expect(client.createExternalWorkItemLink({
      workspaceId: 'workspace-link-race',
      input,
    })).rejects.toMatchObject({
      status: 409,
      code: 'ExternalWorkItemLinkConflict',
    })
    expect(targetReads).toBe(2)
  })

  test('blocks unlink while an external Work Item link has an open sync conflict', async () => {
    const { client } = createClient()
    const installation = await client.installConnector({
      workspaceId: 'workspace-conflicted-link',
      installedByUserId: 'user-conflicted-link',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Conflicted GitHub',
        scopes: ['issues:read'],
        credential: 'conflicted-link-credential',
      },
    })
    const link = await client.createExternalWorkItemLink({
      workspaceId: 'workspace-conflicted-link',
      input: {
        teamId: 'team-conflicted-link',
        workItemId: 'work-item-conflicted-link',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'issue-conflicted-link',
        externalUrl: 'https://provider.test/issues/conflicted-link',
        syncDirection: 'bidirectional',
      },
    })
    const records = (
      client as unknown as {
        records: Map<string, Record<string, unknown>>
      }
    ).records
    const linkKey = `workspace-conflicted-link\0EXTERNALLINK#${link.id}`
    const linkRecord = records.get(linkKey)
    if (!linkRecord) throw new Error('External link test row is missing.')
    records.set(linkKey, {
      ...linkRecord,
      value: {
        ...(linkRecord.value as Record<string, unknown>),
        syncStatus: 'conflict',
      },
      version: Number(linkRecord.version) + 1,
    })
    records.set(`workspace-conflicted-link\0CONNECTORSYNC#${link.id}`, {
      workspaceId: 'workspace-conflicted-link',
      recordKey: `CONNECTORSYNC#${link.id}`,
      entryType: 'connector-sync-state',
      value: {
        installationId: installation.id,
        linkId: link.id,
        workItemRevision: 1,
        lastExternalVersion: 'external-v1',
        storageRevision: 1,
        updatedAt: START.toISOString(),
      },
      version: 1,
    })

    await expect(client.updateExternalWorkItemLink({
      workspaceId: 'workspace-conflicted-link',
      teamId: 'team-conflicted-link',
      workItemId: 'work-item-conflicted-link',
      linkId: link.id,
      updatedByUserId: 'user-conflicted-link',
      input: { syncDirection: 'none' },
    })).rejects.toMatchObject({
      status: 409,
      code: 'ExternalWorkItemLinkSyncConflict',
    })

    await expect(client.deleteExternalWorkItemLink({
      workspaceId: 'workspace-conflicted-link',
      teamId: 'team-conflicted-link',
      workItemId: 'work-item-conflicted-link',
      linkId: link.id,
      deletedByActorId: 'user-conflicted-link',
    })).rejects.toMatchObject({
      status: 409,
      code: 'ExternalWorkItemLinkSyncConflict',
    })
    expect(records.has(linkKey)).toBe(true)
    expect(records.has(
      `workspace-conflicted-link\0CONNECTORSYNC#${link.id}`,
    )).toBe(true)
    expect(await client.listExternalWorkItemLinks({
      workspaceId: 'workspace-conflicted-link',
    })).toHaveLength(1)
  })

  test('persists valid import job transitions and completion report', async () => {
    const { client } = createClient()
    const createRequest = {
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      jobId: 'import_deterministic_1',
      input: {
        format: 'csv' as const,
        teamId: 'team-1',
        assignedProjectId: 'project-1',
        mapping: [
          {
            sourceField: 'Title',
            targetField: 'title',
            transform: 'trim' as const,
            required: true,
          },
        ],
        dryRun: false,
      },
    }
    const created = await client.createImportJob(createRequest)
    expect(created).toMatchObject({
      status: 'queued',
      teamId: 'team-1',
      assignedProjectId: 'project-1',
    })
    await client.updateImportJob({
      workspaceId: 'workspace-1',
      jobId: created.id,
      status: 'validating',
    })
    await client.updateImportJob({
      workspaceId: 'workspace-1',
      jobId: created.id,
      status: 'running',
    })
    await expect(client.updateImportJob({
      workspaceId: 'workspace-1',
      jobId: created.id,
      status: 'completed',
      report: {
        totalRows: 300,
        validRows: 0,
        invalidRows: 300,
        errors: Array.from({ length: 300 }, (_, index) => ({
          row: index + 1,
          code: 'invalid_row',
          message: 'x'.repeat(500),
        })),
      },
    })).rejects.toMatchObject({ status: 413, code: 'ImportJobTooLarge' })
    const completed = await client.updateImportJob({
      workspaceId: 'workspace-1',
      jobId: created.id,
      status: 'completed',
      report: { totalRows: 2, validRows: 2, invalidRows: 0, errors: [] },
    })
    expect(completed).toMatchObject({
      status: 'completed',
      report: { totalRows: 2, validRows: 2, invalidRows: 0 },
    })
    expect(completed.startedAt).toBeDefined()
    expect(completed.completedAt).toBeDefined()
    await expect(client.createImportJob(createRequest)).resolves.toEqual(completed)
    await expect(client.createImportJob({
      ...createRequest,
      input: { ...createRequest.input, teamId: 'team-2' },
    })).rejects.toMatchObject({ status: 409, code: 'ImportJobIdConflict' })
    await expect(client.updateImportJob({
      workspaceId: 'workspace-1',
      jobId: created.id,
      status: 'running',
    })).rejects.toMatchObject({ status: 409, code: 'ImportJobTransitionInvalid' })
    expect(await client.listImportJobs('workspace-2')).toEqual([])
  })
})

describe('request safety primitives', () => {
  test('atomically receipts one-time secret creates and rotations before handler completion', async () => {
    const { client, clock } = createClient()
    const workspaceId = 'workspace-atomic-secret'
    const credentialId = 'user:manager-1'
    const reserveMutation = async (idempotencyKey: string, requestFingerprint: string) => {
      const request = {
        workspaceId,
        credentialId,
        idempotencyKey,
        requestFingerprint,
      }
      const reservation = await client.reserveIdempotency(request)
      if (reservation.status !== 'reserved') throw new Error('Reservation was not created.')
      return {
        request,
        token: {
          credentialId,
          idempotencyKey,
          requestFingerprint,
          reservationId: reservation.reservationId,
        },
      }
    }

    const apiKeyCreate = await reserveMutation('api-key-create', 'api-key-create-fingerprint')
    const apiKey = await client.createApiKey({
      workspaceId,
      createdByUserId: 'manager-1',
      input: { name: 'Atomic API key', scopes: ['work-items:read'] },
      idempotency: apiKeyCreate.token,
    })
    expect(await client.reserveIdempotency(apiKeyCreate.request)).toEqual({
      status: 'replay',
      response: { status: 201, body: apiKey },
    })
    expect(await client.listApiKeys(workspaceId)).toHaveLength(1)

    const oauthCreate = await reserveMutation('oauth-create', 'oauth-create-fingerprint')
    const oauth = await client.createOAuthApp({
      workspaceId,
      createdByUserId: 'manager-1',
      input: {
        name: 'Atomic OAuth app',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
      },
      idempotency: oauthCreate.token,
    })
    expect(await client.reserveIdempotency(oauthCreate.request)).toEqual({
      status: 'replay',
      response: { status: 201, body: oauth },
    })
    expect(await client.listOAuthApps(workspaceId)).toHaveLength(1)

    const webhookCreate = await reserveMutation(
      'webhook-create',
      'webhook-create-fingerprint',
    )
    const webhook = await client.createWebhookSubscription({
      workspaceId,
      createdByUserId: 'manager-1',
      input: {
        name: 'Atomic webhook',
        url: 'https://hooks.example.test/atomic',
        eventTypes: ['work-item.updated'],
        teamIds: ['team-1'],
      },
      idempotency: webhookCreate.token,
    })
    expect(await client.reserveIdempotency(webhookCreate.request)).toEqual({
      status: 'replay',
      response: { status: 201, body: webhook },
    })
    expect(await client.listWebhookSubscriptions(workspaceId)).toHaveLength(1)

    const apiKeyRotate = await reserveMutation('api-key-rotate', 'api-key-rotate-fingerprint')
    const rotatedApiKey = await client.rotateApiKey({
      workspaceId,
      apiKeyId: apiKey.apiKey.id,
      idempotency: apiKeyRotate.token,
    })
    expect(await client.reserveIdempotency(apiKeyRotate.request)).toEqual({
      status: 'replay',
      response: { status: 200, body: rotatedApiKey },
    })

    const oauthRotate = await reserveMutation('oauth-rotate', 'oauth-rotate-fingerprint')
    const rotatedOAuth = await client.rotateOAuthClientSecret({
      workspaceId,
      oauthAppId: oauth.oauthApp.id,
      idempotency: oauthRotate.token,
    })
    expect(await client.reserveIdempotency(oauthRotate.request)).toEqual({
      status: 'replay',
      response: { status: 200, body: rotatedOAuth },
    })

    const webhookRotate = await reserveMutation(
      'webhook-rotate',
      'webhook-rotate-fingerprint',
    )
    const rotatedWebhook = await client.rotateWebhookSecret({
      workspaceId,
      subscriptionId: webhook.subscription.id,
      idempotency: webhookRotate.token,
    })
    expect(await client.reserveIdempotency(webhookRotate.request)).toEqual({
      status: 'replay',
      response: { status: 200, body: rotatedWebhook },
    })

    clock.advanceSeconds(121)
    await expect(client.reserveIdempotency(webhookRotate.request)).resolves.toEqual({
      status: 'replay',
      response: { status: 200, body: rotatedWebhook },
    })
    const serializedRows = JSON.stringify(readStoredRows(client))
    for (const secret of [
      apiKey.secret,
      oauth.clientSecret,
      webhook.signingSecret,
      rotatedApiKey.secret,
      rotatedOAuth.clientSecret,
      rotatedWebhook.signingSecret,
    ]) expect(serializedRows).not.toContain(secret)
  })

  test('fences an expired reservation owner between KMS preparation and atomic commit', async () => {
    const clock = createClock()
    const delegate = new LocalAesGcmSecretProtector(new Uint8Array(32).fill(5))
    let takeover: (() => Promise<void>) | undefined
    const client = new InMemoryDeveloperPlatformClient({
      async protect(plaintext, context) {
        const ciphertext = await delegate.protect(plaintext, context)
        if (context.startsWith('mukuroji:idempotency-response:') && takeover) {
          const runTakeover = takeover
          takeover = undefined
          await runTakeover()
        }
        return ciphertext
      },
      async unprotect(ciphertext, context) {
        return delegate.unprotect(ciphertext, context)
      },
    }, clock.now)
    const request = {
      workspaceId: 'workspace-stale-owner',
      credentialId: 'user:manager-stale',
      idempotencyKey: 'stale-owner-create',
      requestFingerprint: 'stale-owner-create-fingerprint',
    }
    const first = await client.reserveIdempotency(request)
    if (first.status !== 'reserved') throw new Error('Initial reservation was not created.')
    let currentReservationId = ''
    takeover = async () => {
      clock.advanceSeconds(120)
      const current = await client.reserveIdempotency(request)
      if (current.status !== 'reserved') throw new Error('Reservation was not taken over.')
      currentReservationId = current.reservationId
    }
    await expect(client.createApiKey({
      workspaceId: request.workspaceId,
      createdByUserId: 'manager-stale',
      input: { name: 'Fenced key', scopes: ['work-items:read'] },
      idempotency: {
        credentialId: request.credentialId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.requestFingerprint,
        reservationId: first.reservationId,
      },
    })).rejects.toMatchObject({
      status: 409,
      code: 'DeveloperPlatformConcurrentMutation',
    })
    expect(await client.listApiKeys(request.workspaceId)).toEqual([])

    const created = await client.createApiKey({
      workspaceId: request.workspaceId,
      createdByUserId: 'manager-stale',
      input: { name: 'Fenced key', scopes: ['work-items:read'] },
      idempotency: {
        credentialId: request.credentialId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.requestFingerprint,
        reservationId: currentReservationId,
      },
    })
    expect(await client.listApiKeys(request.workspaceId)).toHaveLength(1)
    await expect(client.reserveIdempotency(request)).resolves.toEqual({
      status: 'replay',
      response: { status: 201, body: created },
    })
  })

  test('reserves, conflicts, completes, and replays idempotency responses', async () => {
    const { client, clock } = createClient()
    const issued = await client.createApiKey({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-management',
      input: {
        name: 'Idempotent secret',
        scopes: ['work-items:read'],
      },
    })
    const request = {
      workspaceId: 'workspace-1',
      credentialId: 'credential-1',
      idempotencyKey: 'create-work-item-1',
      requestFingerprint: 'POST:/api/v1/work-items:body-sha',
    }
    const reserved = await client.reserveIdempotency(request)
    expect(reserved.status).toBe('reserved')
    if (reserved.status !== 'reserved') throw new Error('Reservation was not created.')
    expect(JSON.stringify(readStoredRows(client))).not.toContain(reserved.reservationId)
    await expect(client.reserveIdempotency(request)).resolves.toEqual({
      status: 'in-progress',
    })
    await expect(client.reserveIdempotency({
      ...request,
      requestFingerprint: 'POST:/api/v1/work-items:different-body',
    })).rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })

    await client.completeIdempotency({
      ...request,
      reservationId: reserved.reservationId,
      response: {
        status: 201,
        body: { id: 'work-item-1', secret: issued.secret },
      },
    })
    const idempotencyRow = readStoredRows(client)
      .find((row) => row.entryType === 'idempotency')
    const idempotencyValue = idempotencyRow?.value as {
      responseCiphertext?: string
    } | undefined
    expect(idempotencyValue?.responseCiphertext).toMatch(/^v1\./)
    expect(JSON.stringify(idempotencyRow)).not.toContain(issued.secret)
    await expect(client.reserveIdempotency(request)).resolves.toEqual({
      status: 'replay',
      response: {
        status: 201,
        body: { id: 'work-item-1', secret: issued.secret },
      },
    })
    clock.advanceSeconds(121)
    await expect(client.reserveIdempotency(request)).resolves.toMatchObject({
      status: 'replay',
    })
    await expect(client.reserveIdempotency({
      ...request,
      workspaceId: 'workspace-2',
    })).resolves.toMatchObject({ status: 'reserved' })
  })

  test('allows takeover only after an unfinished idempotency reservation lease expires', async () => {
    const { client, clock } = createClient()
    const request = {
      workspaceId: 'workspace-lease',
      credentialId: 'credential-lease',
      idempotencyKey: 'retry-after-failure',
      requestFingerprint: 'POST:/api/v1/imports:stable-body',
    }
    const first = await client.reserveIdempotency(request)
    if (first.status !== 'reserved') throw new Error('Initial reservation was not created.')

    clock.advanceSeconds(119)
    await expect(client.reserveIdempotency(request)).resolves.toEqual({
      status: 'in-progress',
    })
    clock.advanceSeconds(1)
    const takeoverAttempts = await Promise.all([
      client.reserveIdempotency(request),
      client.reserveIdempotency(request),
    ])
    expect(takeoverAttempts.map((attempt) => attempt.status).sort()).toEqual([
      'in-progress',
      'reserved',
    ])
    const takeover = takeoverAttempts.find((attempt) => attempt.status === 'reserved')
    if (!takeover || takeover.status !== 'reserved') {
      throw new Error('Reservation was not taken over.')
    }
    expect(takeover.reservationId).not.toBe(first.reservationId)
    await expect(client.completeIdempotency({
      ...request,
      reservationId: first.reservationId,
      response: { status: 202, body: { stale: true } },
    })).rejects.toMatchObject({
      status: 403,
      code: 'IdempotencyReservationOwnerMismatch',
    })
    await client.completeIdempotency({
      ...request,
      reservationId: takeover.reservationId,
      response: { status: 202, body: { accepted: true } },
    })
    await expect(client.reserveIdempotency(request)).resolves.toEqual({
      status: 'replay',
      response: { status: 202, body: { accepted: true } },
    })
  })

  test('bounds encrypted idempotency rows and lets only the reservation owner release failure', async () => {
    const { client } = createClient()
    const request = {
      workspaceId: 'workspace-bounded',
      credentialId: 'credential-bounded',
      idempotencyKey: 'bounded-response',
      requestFingerprint: 'POST:/api/v1/imports:bounded',
    }
    const reservation = await client.reserveIdempotency(request)
    if (reservation.status !== 'reserved') throw new Error('Reservation was not created.')
    await expect(client.completeIdempotency({
      ...request,
      reservationId: reservation.reservationId,
      response: { body: 'x'.repeat(IDEMPOTENCY_MAX_RESPONSE_BYTES + 1) },
    })).rejects.toMatchObject({
      status: 413,
      code: 'IdempotencyResponseTooLarge',
    })
    const boundedRow = readStoredRows(client)
      .find((row) => row.entryType === 'idempotency')
    expect(JSON.stringify(boundedRow)).not.toContain('responseCiphertext')
    await expect(client.releaseIdempotency({
      ...request,
      reservationId: 'mk_reservation_wrong-owner',
    })).rejects.toMatchObject({
      status: 403,
      code: 'IdempotencyReservationOwnerMismatch',
    })
    await client.releaseIdempotency({
      ...request,
      reservationId: reservation.reservationId,
    })
    await expect(client.reserveIdempotency(request)).resolves.toMatchObject({
      status: 'reserved',
    })

    const expandingClient = new InMemoryDeveloperPlatformClient({
      async protect() {
        return `v1.${'x'.repeat(390 * 1024)}`
      },
      async unprotect() {
        throw new Error('not used')
      },
    })
    const expandingReservation = await expandingClient.reserveIdempotency(request)
    if (expandingReservation.status !== 'reserved') {
      throw new Error('Expanding reservation was not created.')
    }
    await expect(expandingClient.completeIdempotency({
      ...request,
      reservationId: expandingReservation.reservationId,
      response: { body: 'small' },
    })).rejects.toMatchObject({
      status: 413,
      code: 'IdempotencyResponseTooLarge',
    })
  })

  test('applies an atomic fixed window independently per credential and tenant', async () => {
    const { client, clock } = createClient()
    const request = {
      workspaceId: 'workspace-1',
      credentialId: 'credential-1',
      limit: 2,
      windowSeconds: 60,
    }
    await expect(client.consumeRateLimit(request)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    })
    await expect(client.consumeRateLimit(request)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    })
    await expect(client.consumeRateLimit(request)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    })
    await expect(client.consumeRateLimit({
      ...request,
      credentialId: 'credential-2',
    })).resolves.toMatchObject({ allowed: true, remaining: 1 })
    await expect(client.consumeRateLimit({
      ...request,
      workspaceId: 'workspace-2',
    })).resolves.toMatchObject({ allowed: true, remaining: 1 })

    clock.advanceSeconds(60)
    await expect(client.consumeRateLimit(request)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    })
  })

  test('AES-GCM protector detects context mismatch and ciphertext tampering', async () => {
    const protector = new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9))
    const ciphertext = await protector.protect('top-secret', 'workspace-1')
    expect(ciphertext).not.toContain('top-secret')
    await expect(protector.unprotect(ciphertext, 'workspace-1')).resolves.toBe('top-secret')
    await expect(protector.unprotect(ciphertext, 'workspace-2'))
      .rejects.toBeInstanceOf(DeveloperPlatformError)
    await expect(protector.unprotect(`${ciphertext}x`, 'workspace-1'))
      .rejects.toBeInstanceOf(DeveloperPlatformError)
  })

  test('KMS envelope protector separates purposes, binds context, and zeroes data keys', async () => {
    const generatedKeys: Uint8Array[] = []
    const decryptedKeys: Uint8Array[] = []
    const calls: Array<{
      operation: 'generate' | 'decrypt'
      keyId: string
      encryptionContext: Readonly<Record<string, string>>
    }> = []
    const protector = new KmsEnvelopeSecretProtector({
      async generateDataKey(request) {
        const plaintext = new Uint8Array(32).fill(11)
        generatedKeys.push(plaintext)
        calls.push({ operation: 'generate', ...request })
        return {
          plaintext,
          ciphertextBlob: new Uint8Array([1, 2, 3, calls.length]),
        }
      },
      async decrypt(request) {
        const plaintext = new Uint8Array(32).fill(11)
        decryptedKeys.push(plaintext)
        calls.push({
          operation: 'decrypt',
          keyId: request.keyId,
          encryptionContext: request.encryptionContext,
        })
        return { plaintext }
      },
    }, {
      webhook: 'arn:kms:webhook',
      connector: 'arn:kms:connector',
      platformState: 'arn:kms:state',
    })
    const webhookContext = 'mukuroji:webhook:workspace-1:webhook-1:v1'
    const ciphertext = await protector.protect('mk_webhook_top_secret', webhookContext)
    expect(ciphertext).toStartWith('kms-v1.webhook.')
    expect(ciphertext).not.toContain('mk_webhook_top_secret')
    expect(calls[0]).toMatchObject({
      operation: 'generate',
      keyId: 'arn:kms:webhook',
      encryptionContext: {
        'mukuroji:purpose': 'webhook',
        'mukuroji:service': 'developer-platform',
      },
    })
    expect([...generatedKeys[0]!].every((value) => value === 0)).toBe(true)
    await expect(protector.unprotect(ciphertext, webhookContext))
      .resolves.toBe('mk_webhook_top_secret')
    expect(calls[1]).toMatchObject({ operation: 'decrypt', keyId: 'arn:kms:webhook' })
    expect([...decryptedKeys[0]!].every((value) => value === 0)).toBe(true)
    await expect(protector.unprotect(
      ciphertext,
      'mukuroji:webhook:workspace-2:webhook-1:v1',
    )).rejects.toMatchObject({
      status: 400,
      code: 'ProtectedSecretInvalid',
    })
    try {
      await protector.unprotect(
        ciphertext,
        'mukuroji:webhook:workspace-2:webhook-1:v1',
      )
      throw new Error('Context mismatch unexpectedly decrypted.')
    } catch (error) {
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      expect(String(error)).not.toContain(ciphertext)
      expect(String(error)).not.toContain('mk_webhook_top_secret')
    }

    await protector.protect(
      'provider-token',
      'mukuroji:connector:workspace-1:connector-1:v1',
    )
    await protector.protect(
      '{"status":201}',
      'mukuroji:idempotency-response:v1\u0000workspace-1\u0000credential-1\u0000key',
    )
    expect(calls.filter(({ operation }) => operation === 'generate').map(({ keyId }) => keyId))
      .toEqual(['arn:kms:webhook', 'arn:kms:connector', 'arn:kms:state'])

    const webhookOnly = new KmsEnvelopeSecretProtector({
      async generateDataKey() {
        throw new Error('must not be called')
      },
      async decrypt() {
        throw new Error('must not be called')
      },
    }, { webhook: 'arn:kms:webhook' })
    await expect(webhookOnly.protect(
      'provider-token',
      'mukuroji:connector:workspace-1:connector-1:v1',
    )).rejects.toMatchObject({
      status: 500,
      code: 'SecretProtectorKmsKeyMissing',
    })
  })
})
