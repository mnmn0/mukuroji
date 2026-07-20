import { describe, expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ExternalWorkItemLink } from '@mukuroji/contracts'
import {
  createConnectorPollTargetLookupKey,
  createConnectorPollTargetRecordKey,
} from './connector-poll-projection'
import {
  DynamoDbConnectorSyncPersistence,
} from './connector-sync-persistence'
import type { StoredConnectorSyncConflict } from './connector-sync-runtime'

const NOW = '2026-07-18T00:00:00.000Z'

function createMemoryDocumentClient() {
  const items = new Map<string, Record<string, unknown>>()
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const itemKey = (
    tableName: unknown,
    value: {
      workspaceId?: unknown
      recordKey?: unknown
      directoryId?: unknown
      eventId?: unknown
    },
  ) => value.directoryId !== undefined || value.eventId !== undefined
    ? `${String(tableName)}\0${String(value.directoryId)}\0${String(value.eventId)}`
    : `${String(tableName)}\0${String(value.workspaceId)}\0${String(value.recordKey)}`
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = structuredClone(command.input)
      commands.push({ name, input })
      if (name === 'GetCommand') {
        const key = input.Key as { workspaceId: string; recordKey: string }
        return { Item: structuredClone(items.get(itemKey(input.TableName, key))) }
      }
      if (name === 'PutCommand') {
        const item = input.Item as Record<string, unknown>
        const key = itemKey(input.TableName, item)
        const current = items.get(key)
        const condition = input.ConditionExpression
        if (
          condition !== undefined &&
          condition !==
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' &&
          condition !== '#version = :expectedVersion' &&
          condition !==
            '#version = :expectedVersion AND #value.#resolutionOperationId = :operationId'
        ) throw new Error(`Unsupported PutCommand condition: ${String(condition)}`)
        if (
          condition ===
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' &&
          current
        ) throw conditionalFailure()
        if (
          condition === '#version = :expectedVersion' &&
          current?.version !== (
            input.ExpressionAttributeValues as Record<string, unknown>
          )[':expectedVersion']
        ) throw conditionalFailure()
        if (
          condition ===
            '#version = :expectedVersion AND #value.#resolutionOperationId = :operationId'
        ) {
          const values = input.ExpressionAttributeValues as Record<string, unknown>
          const currentValue = current?.value as Record<string, unknown> | undefined
          if (
            current?.version !== values[':expectedVersion'] ||
            currentValue?.resolutionOperationId !== values[':operationId']
          ) throw conditionalFailure()
        }
        items.set(key, structuredClone(item))
        return {}
      }
      if (name === 'TransactWriteCommand') {
        const writes = input.TransactItems as Array<{
          Put?: {
            TableName: string
            Item: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          ConditionCheck?: {
            TableName: string
            Key: { workspaceId: string; recordKey: string }
            ConditionExpression: string
            ExpressionAttributeValues: Record<string, unknown>
          }
          Update?: {
            TableName: string
            Key: { workspaceId: string; recordKey: string }
            UpdateExpression: string
            ConditionExpression: string
            ExpressionAttributeValues: Record<string, unknown>
          }
        }>
        if (writes.some(({ Put, ConditionCheck, Update }) => {
          if (Put) {
            const current = items.get(itemKey(Put.TableName, Put.Item))
            if (
              Put.ConditionExpression !== undefined &&
              Put.ConditionExpression !==
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' &&
              Put.ConditionExpression !== '#version = :expectedVersion' &&
              Put.ConditionExpression !==
                'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)'
            ) {
              throw new Error(
                `Unsupported transaction Put condition: ${Put.ConditionExpression}`,
              )
            }
            if (
              Put.ConditionExpression ===
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' &&
              current !== undefined
            ) return true
            if (
              Put.ConditionExpression ===
                'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)' &&
              current !== undefined
            ) return true
            if (
              Put.ConditionExpression === '#version = :expectedVersion' &&
              current?.version !== Put.ExpressionAttributeValues?.[':expectedVersion']
            ) return true
          }
          if (Update) {
            const current = items.get(itemKey(Update.TableName, Update.Key))
            const currentValue = current?.value as
              | Record<string, unknown>
              | undefined
            const values = Update.ExpressionAttributeValues
            if (values[':entryType'] !== 'connector-poll-target') {
              throw new Error(
                `Unsupported transaction Update: ${Update.UpdateExpression}`,
              )
            }
            const incrementing = Update.UpdateExpression.includes(
              'if_not_exists(pollableLinkCount, :zero) +',
            )
            const expectedCondition = incrementing
              ? 'attribute_not_exists(#entryType) OR ' +
                '(#entryType = :entryType AND #value.#installationId = :installationId AND ' +
                '#value.#resourceType = :resourceType AND pollableLinkCount >= :zero)'
              : '#entryType = :entryType AND #value.#installationId = :installationId AND ' +
                '#value.#resourceType = :resourceType AND pollableLinkCount >= :one'
            if (Update.ConditionExpression !== expectedCondition) {
              throw new Error(
                `Unsupported transaction Update condition: ${Update.ConditionExpression}`,
              )
            }
            const count = Number(current?.pollableLinkCount ?? 0)
            if (!current) return !incrementing
            if (
              current.entryType !== values[':entryType'] ||
              currentValue?.installationId !== values[':installationId'] ||
              currentValue?.resourceType !== values[':resourceType'] ||
              !Number.isSafeInteger(count) ||
              count < (incrementing ? 0 : 1)
            ) return true
          }
          if (!ConditionCheck) return false
          const current = items.get(itemKey(
            ConditionCheck.TableName,
            ConditionCheck.Key,
          ))
          if (
            ConditionCheck.ConditionExpression ===
              '#entryType = :entryType AND #version = :expectedStateRevision AND ' +
                '#value.#lastExternalVersion = :expectedExternalVersion'
          ) {
            const value = current?.value as Record<string, unknown> | undefined
            return current?.entryType !==
                ConditionCheck.ExpressionAttributeValues[':entryType'] ||
              current?.version !==
                ConditionCheck.ExpressionAttributeValues[':expectedStateRevision'] ||
              value?.lastExternalVersion !==
                ConditionCheck.ExpressionAttributeValues[':expectedExternalVersion']
          }
          if (ConditionCheck.ConditionExpression === '#version = :expectedVersion') {
            return current?.version !==
              ConditionCheck.ExpressionAttributeValues[':expectedVersion']
          }
          if (
            ConditionCheck.ConditionExpression !==
              '#value.#id = :installationId AND #value.#status <> :disconnected AND #value.#status <> :needsReauthorization'
          ) {
            throw new Error(
              `Unsupported transaction ConditionCheck: ${ConditionCheck.ConditionExpression}`,
            )
          }
          const value = current?.value as Record<string, unknown> | undefined
          const values = ConditionCheck.ExpressionAttributeValues
          if (!value) return true
          if (
            values[':installationId'] !== undefined &&
            value.id !== values[':installationId']
          ) return true
          return values[':disconnected'] !== undefined && (
            value.status === values[':disconnected'] ||
            value.status === values[':needsReauthorization']
          )
        })) throw transactionFailure()
        for (const { Put, Update } of writes) {
          if (Put) {
            items.set(itemKey(Put.TableName, Put.Item), structuredClone(Put.Item))
          }
          if (Update) {
            const key = itemKey(Update.TableName, Update.Key)
            const current = items.get(key)
            const values = Update.ExpressionAttributeValues
            const delta = Update.UpdateExpression.includes('pollableLinkCount -')
              ? -1
              : 1
            items.set(key, {
              ...(current ?? Update.Key),
              entryType: current?.entryType ?? values[':entryType'],
              value: current?.value ?? structuredClone(values[':value']),
              pollableLinkCount: Number(current?.pollableLinkCount ?? 0) + delta,
              lookupKey: values[':lookupKey'],
              lookupSortKey: values[':lookupSortKey'],
              version: Number(current?.version ?? 0) + 1,
            })
          }
        }
        return {}
      }
      if (name === 'QueryCommand') {
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        const matching = [...items.entries()]
          .filter(([key, item]) =>
            key.startsWith(`${String(input.TableName)}\0`) &&
            item.lookupKey === values[':lookupKey']
          )
          .map(([, item]) => structuredClone(item))
          .sort((left, right) =>
            String(left.lookupSortKey).localeCompare(String(right.lookupSortKey))
          )
        if (input.ScanIndexForward === false) matching.reverse()
        const start = input.ExclusiveStartKey as Record<string, unknown> | undefined
        const startIndex = start
          ? matching.findIndex((item) => item.recordKey === start.recordKey) + 1
          : 0
        const limit = Number(input.Limit ?? matching.length)
        const rows = matching.slice(startIndex, startIndex + limit)
        const last = rows.at(-1)
        return {
          Items: rows,
          ...(last && startIndex + rows.length < matching.length
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
      throw new Error(`Unsupported command: ${name}`)
    },
  } as unknown as DynamoDBDocumentClient
  return { documentClient, items, commands, itemKey }
}

function conditionalFailure() {
  const error = new Error('condition failed')
  error.name = 'ConditionalCheckFailedException'
  return error
}

function transactionFailure() {
  const error = new Error('transaction failed') as Error & {
    CancellationReasons?: Array<{ Code: string }>
  }
  error.name = 'TransactionCanceledException'
  error.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]
  return error
}

function createLink(): ExternalWorkItemLink {
  return {
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    externalId: 'issue-29',
    externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
    displayKey: '#29',
    syncDirection: 'bidirectional',
    syncStatus: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function seedLinkAndConnector(
  memory: ReturnType<typeof createMemoryDocumentClient>,
  link: ExternalWorkItemLink,
  connectorStatus = 'connected',
) {
  memory.items.set(
    memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }),
    {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
      entryType: 'external-link',
      value: structuredClone(link),
      version: 1,
    },
  )
  memory.items.set(
    memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `CONNECTOR#${link.installationId}`,
    }),
    {
      workspaceId: 'workspace-1',
      recordKey: `CONNECTOR#${link.installationId}`,
      entryType: 'connector-installation',
      value: {
        id: link.installationId,
        status: connectorStatus,
      },
      version: 1,
    },
  )
  if (
    link.syncStatus !== 'paused' &&
    link.syncStatus !== 'conflict' &&
    (link.syncDirection === 'inbound' || link.syncDirection === 'bidirectional')
  ) {
    const recordKey = createConnectorPollTargetRecordKey(
      link.installationId,
      link.resourceType,
    )
    memory.items.set(
      memory.itemKey('DeveloperPlatformTable', {
        workspaceId: 'workspace-1',
        recordKey,
      }),
      {
        workspaceId: 'workspace-1',
        recordKey,
        entryType: 'connector-poll-target',
        value: {
          installationId: link.installationId,
          resourceType: link.resourceType,
        },
        pollableLinkCount: 1,
        lookupKey: createConnectorPollTargetLookupKey(
          'workspace-1',
          link.installationId,
          link.resourceType,
        ),
        lookupSortKey:
          `workspace-1#${link.installationId}#${link.resourceType}`,
        version: 1,
      },
    )
  }
}

function getPollTarget(
  memory: ReturnType<typeof createMemoryDocumentClient>,
  link: ExternalWorkItemLink,
) {
  return memory.items.get(memory.itemKey('DeveloperPlatformTable', {
    workspaceId: 'workspace-1',
    recordKey: createConnectorPollTargetRecordKey(
      link.installationId,
      link.resourceType,
    ),
  }))
}

function createConflict(): StoredConnectorSyncConflict {
  return {
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    conflict: {
      id: 'conflict-1',
      externalLinkId: 'link-1',
      workItemId: 'work-item-1',
      localRevision: 3,
      externalRevision: 'external-4',
      fields: [{ field: 'title', localValue: 'Local', externalValue: 'Provider' }],
      status: 'open',
      detectedAt: NOW,
    },
    externalRecord: {
      externalId: 'issue-29',
      resourceType: 'issue',
      externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
      externalVersion: 'external-4',
      title: 'Provider',
      metadata: {},
    },
    localWorkItem: {
      id: 'work-item-1',
      teamId: 'team-1',
      revision: 3,
      title: 'Local',
    },
  }
}

function seedConflictRow(
  memory: ReturnType<typeof createMemoryDocumentClient>,
  conflictId: string,
  detectedAt: string,
) {
  const value = createConflict()
  value.conflict.id = conflictId
  value.conflict.detectedAt = detectedAt
  const row = {
    workspaceId: value.workspaceId,
    recordKey: `SYNCCONFLICT#${conflictId}`,
    entryType: 'connector-sync-conflict',
    value,
    version: 1,
    lookupKey: `CONNECTOR_SYNC_CONFLICT#${value.workspaceId}`,
    lookupSortKey: `${detectedAt}#${conflictId}`,
  }
  memory.items.set(
    memory.itemKey('DeveloperPlatformTable', row),
    structuredClone(row),
  )
}

describe('DynamoDbConnectorSyncPersistence', () => {
  test('commits link checkpoints with optimistic concurrency', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
    })
    const first = {
      workspaceId: 'workspace-1',
      link,
      workItemRevision: 3,
      externalRecord: createConflict().externalRecord,
      eventId: 'provider-event-1',
      syncedAt: NOW,
    }

    await expect(persistence.commitLinkState(first)).resolves.toBe(true)
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).toMatchObject({
      value: {
        syncStatus: 'synced',
        lastSyncedAt: NOW,
      },
      version: 2,
    })
    const firstCommitWrites = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }>
    expect(firstCommitWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'DeveloperPlatformTable',
          Item: expect.objectContaining({
            recordKey: `CONNECTORSYNC#${link.id}`,
          }),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'DeveloperPlatformTable',
          Item: expect.objectContaining({
            recordKey: `EXTERNALLINK#${link.id}`,
            value: expect.objectContaining({ syncStatus: 'synced' }),
          }),
        }),
      }),
    ]))
    expect(firstCommitWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ Update: expect.anything() }),
    ]))
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 1,
      version: 1,
    })
    await expect(persistence.commitLinkState(first)).resolves.toBe(false)
    await expect(persistence.commitLinkState({
      ...first,
      link: {
        ...link,
        syncStatus: 'synced',
        updatedAt: NOW,
        lastSyncedAt: NOW,
      },
      expectedStorageRevision: 1,
      workItemRevision: 4,
      eventId: 'provider-event-2',
    })).resolves.toBe(true)
    await expect(persistence.getLinkState('workspace-1', link.id)).resolves.toMatchObject({
      storageRevision: 2,
      workItemRevision: 4,
      lastExternalEventId: 'provider-event-2',
    })
  })

  test('atomically updates public link status and emits an external-link event', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
    })

    await persistence.setLinkStatus(
      'workspace-1',
      link.id,
      'synced',
      '2026-07-18T00:01:00.000Z',
    )
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).toMatchObject({
      value: {
        syncStatus: 'synced',
        lastSyncedAt: '2026-07-18T00:01:00.000Z',
      },
      version: 2,
    })
    const writes = memory.commands.find(
      ({ name }) => name === 'TransactWriteCommand',
    )?.input.TransactItems as Array<{
      Put?: { TableName?: string; Item?: Record<string, unknown> }
    }>
    expect(writes.find(({ Put }) =>
      Put?.TableName === 'AuditEventsTable'
    )?.Put).toMatchObject({
      TableName: 'AuditEventsTable',
      Item: {
        eventType: 'external-link.updated',
        outboxStatus: 'pending',
        metadata: { teamId: 'team-1', syncStatus: 'synced' },
      },
    })
    await persistence.setLinkStatus(
      'workspace-1',
      link.id,
      'paused',
      '2026-07-18T00:02:00.000Z',
    )
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).not.toHaveProperty('lookupKey')
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 0,
      version: 2,
    })
  })

  test('acknowledges only the exact pending poll generation', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    memory.items.set(
      memory.itemKey('DeveloperPlatformTable', {
        workspaceId: 'workspace-1',
        recordKey: `CONNECTORSYNC#${link.id}`,
      }),
      {
        workspaceId: 'workspace-1',
        recordKey: `CONNECTORSYNC#${link.id}`,
        entryType: 'connector-sync-state',
        value: {
          installationId: link.installationId,
          linkId: link.id,
          workItemRevision: 3,
          lastExternalVersion: 'external-4',
          storageRevision: 1,
        },
        version: 1,
      },
    )
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
    })

    await expect(persistence.acknowledgePendingLink(
      'workspace-1',
      link.id,
      '2026-07-18T00:00:01.000Z',
      'external-4',
      1,
      '2026-07-18T00:01:00.000Z',
    )).resolves.toBe(false)
    await expect(persistence.acknowledgePendingLink(
      'workspace-1',
      link.id,
      link.updatedAt,
      'external-stale',
      1,
      '2026-07-18T00:01:00.000Z',
    )).resolves.toBe(false)
    await expect(persistence.acknowledgePendingLink(
      'workspace-1',
      link.id,
      link.updatedAt,
      'external-4',
      2,
      '2026-07-18T00:01:00.000Z',
    )).resolves.toBe(false)
    await expect(persistence.acknowledgePendingLink(
      'workspace-1',
      link.id,
      link.updatedAt,
      'external-4',
      1,
      '2026-07-18T00:01:00.000Z',
    )).resolves.toBe(true)
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).toMatchObject({
      value: {
        syncStatus: 'synced',
        updatedAt: '2026-07-18T00:01:00.000Z',
        lastSyncedAt: '2026-07-18T00:01:00.000Z',
      },
      version: 2,
    })
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 1,
      version: 1,
    })
    await expect(persistence.acknowledgePendingLink(
      'workspace-1',
      link.id,
      link.updatedAt,
      'external-4',
      1,
      '2026-07-18T00:01:00.000Z',
    )).resolves.toBe(false)
  })

  test('does not commit or reactivate synchronization after pause or disconnect', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
    })
    const linkKey = memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    })
    const connectorKey = memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `CONNECTOR#${link.installationId}`,
    })

    const pausedLink = { ...link, syncStatus: 'paused' as const }
    memory.items.set(linkKey, {
      ...memory.items.get(linkKey)!,
      value: pausedLink,
      version: 2,
    })
    await expect(persistence.commitLinkState({
      workspaceId: 'workspace-1',
      link: pausedLink,
      workItemRevision: 3,
      externalRecord: createConflict().externalRecord,
      syncedAt: NOW,
    })).resolves.toBe(false)
    await expect(persistence.setLinkStatus(
      'workspace-1',
      link.id,
      'synced',
      '2026-07-18T00:01:00.000Z',
    )).rejects.toMatchObject({ code: 'ConnectorSyncPaused' })

    memory.items.set(linkKey, {
      ...memory.items.get(linkKey)!,
      value: link,
      version: 3,
    })
    memory.items.set(connectorKey, {
      ...memory.items.get(connectorKey)!,
      value: { id: link.installationId, status: 'disconnected' },
      version: 2,
    })
    await expect(persistence.commitLinkState({
      workspaceId: 'workspace-1',
      link,
      workItemRevision: 3,
      externalRecord: createConflict().externalRecord,
      syncedAt: NOW,
    })).resolves.toBe(false)
    await expect(persistence.setLinkStatus(
      'workspace-1',
      link.id,
      'synced',
      '2026-07-18T00:02:00.000Z',
    )).rejects.toMatchObject({ code: 'ConnectorSyncStateConflict' })
  })

  test('signs expiring workspace/index-bound cursors and accepts previous keys', async () => {
    const memory = createMemoryDocumentClient()
    seedConflictRow(memory, 'conflict-1', '2026-07-18T00:00:00.000Z')
    seedConflictRow(memory, 'conflict-2', '2026-07-18T00:01:00.000Z')
    let now = new Date('2026-07-18T00:02:00.000Z')
    const previousSecret =
      'connector-sync-previous-cursor-signing-secret-at-least-thirty-two-bytes'
    const currentSecret =
      'connector-sync-current-cursor-signing-secret-at-least-thirty-two-bytes'
    const previousPersistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
      clock: () => now,
      cursorSigningSecret: previousSecret,
      cursorTtlSeconds: 60,
    })
    const first = await previousPersistence.listConflicts('workspace-1', {
      limit: 1,
    })
    expect(first).toMatchObject({
      items: [{ id: 'conflict-2' }],
      hasMore: true,
    })
    expect(first.nextCursor).toStartWith('v1.')

    const rotatedPersistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
      clock: () => now,
      cursorSigningSecret: currentSecret,
      previousCursorSigningSecrets: [previousSecret],
      cursorTtlSeconds: 60,
    })
    await expect(rotatedPersistence.listConflicts('workspace-1', {
      cursor: first.nextCursor!,
      limit: 1,
    })).resolves.toMatchObject({
      items: [{ id: 'conflict-1' }],
      hasMore: false,
    })
    await expect(rotatedPersistence.listConflicts('workspace-other', {
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ConnectorSyncCursorInvalid' })

    const cursorSegments = first.nextCursor!.split('.')
    const signature = cursorSegments[2]!
    cursorSegments[2] = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`
    await expect(rotatedPersistence.listConflicts('workspace-1', {
      cursor: cursorSegments.join('.'),
      limit: 1,
    })).rejects.toMatchObject({ code: 'ConnectorSyncCursorInvalid' })

    const otherIndexPersistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      lookupIndexName: 'OtherLookupIndex',
      documentClient: memory.documentClient,
      clock: () => now,
      cursorSigningSecret: previousSecret,
    })
    await expect(otherIndexPersistence.listConflicts('workspace-1', {
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ConnectorSyncCursorInvalid' })

    now = new Date('2026-07-18T00:03:01.000Z')
    await expect(rotatedPersistence.listConflicts('workspace-1', {
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ConnectorSyncCursorInvalid' })
  })

  test('fails fast when production persistence configuration is incomplete', () => {
    expect(() => new DynamoDbConnectorSyncPersistence({
      auditTableName: 'AuditEventsTable',
      documentClient: createMemoryDocumentClient().documentClient,
      environment: { NODE_ENV: 'production' },
    })).toThrow('Developer platform table name is required in production.')
    expect(() => new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: createMemoryDocumentClient().documentClient,
      environment: { NODE_ENV: 'production' },
    })).toThrow('Developer platform lookup index name is required in production.')
    expect(() => new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      lookupIndexName: 'LookupKeyIndex',
      auditTableName: 'AuditEventsTable',
      documentClient: createMemoryDocumentClient().documentClient,
      environment: { NODE_ENV: 'production' },
    })).toThrow('Connector sync cursor signing secret is required in production.')
  })

  test('persists and resolves conflicts with tenant isolation and audit events', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
      clock: () => new Date('2026-07-18T00:01:30.000Z'),
    })
    const record = createConflict()

    await expect(persistence.createConflict(record)).resolves.toEqual(record.conflict)
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).not.toHaveProperty('lookupKey')
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 0,
      version: 2,
    })
    await expect(persistence.createConflict(record)).resolves.toEqual(record.conflict)
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 0,
      version: 2,
    })
    await expect(persistence.getConflict('workspace-other', record.conflict.id))
      .resolves.toBeUndefined()
    await expect(persistence.listConflicts('workspace-1', {
      status: 'open',
      limit: 20,
    })).resolves.toMatchObject({
      items: [{ id: 'conflict-1', status: 'open' }],
      hasMore: false,
    })
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      record.conflict.id,
      {
        operationId: 'resolution-operation-1',
        startedAt: '2026-07-18T00:01:00.000Z',
      },
    )).resolves.toBe('claimed')
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      record.conflict.id,
      {
        operationId: 'resolution-operation-1',
        startedAt: '2026-07-18T00:01:00.000Z',
      },
    )).resolves.toBe('same-operation')
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      record.conflict.id,
      {
        operationId: 'resolution-operation-2',
        startedAt: '2026-07-18T00:01:00.000Z',
      },
    )).resolves.toBe('busy')
    await expect(persistence.completeConflict(
      'workspace-1',
      record.conflict.id,
      {
        status: 'resolved',
        resolvedByUserId: 'user-1',
        resolvedAt: '2026-07-18T00:02:00.000Z',
        operationId: 'resolution-operation-1',
      },
    )).resolves.toMatchObject({
      id: 'conflict-1',
      status: 'resolved',
      resolvedByUserId: 'user-1',
    })
    await expect(persistence.completeConflict(
      'workspace-1',
      record.conflict.id,
      {
        status: 'resolved',
        resolvedByUserId: 'user-1',
        resolvedAt: '2026-07-18T00:02:00.000Z',
        operationId: 'resolution-operation-1',
      },
    )).resolves.toBeUndefined()
    expect(memory.items.get(memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    }))).toMatchObject({
      value: {
        syncStatus: 'synced',
        lastSyncedAt: '2026-07-18T00:02:00.000Z',
      },
      version: 3,
    })
    expect(getPollTarget(memory, link)).toMatchObject({
      pollableLinkCount: 1,
      version: 3,
    })

    const auditEvents = memory.commands
      .filter(({ name }) => name === 'TransactWriteCommand')
      .flatMap(({ input }) => input.TransactItems as Array<{
        Put?: { TableName?: string; Item?: Record<string, unknown> }
      }>)
      .filter(({ Put }) => Put?.TableName === 'AuditEventsTable')
      .map(({ Put }) => Put?.Item?.eventType)
    expect(auditEvents).toEqual([
      'sync-conflict.created',
      'external-link.updated',
      'sync-conflict.resolved',
      'external-link.updated',
    ])
  })

  test('does not create orphan conflicts for paused deleted or disconnected links', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
    })
    const linkKey = memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `EXTERNALLINK#${link.id}`,
    })
    const connectorKey = memory.itemKey('DeveloperPlatformTable', {
      workspaceId: 'workspace-1',
      recordKey: `CONNECTOR#${link.installationId}`,
    })

    memory.items.set(linkKey, {
      ...memory.items.get(linkKey)!,
      value: { ...link, syncStatus: 'paused' },
      version: 2,
    })
    await expect(persistence.createConflict(createConflict()))
      .rejects.toMatchObject({ code: 'ConnectorSyncStateConflict' })

    memory.items.set(linkKey, {
      ...memory.items.get(linkKey)!,
      value: link,
      version: 3,
    })
    memory.items.set(connectorKey, {
      ...memory.items.get(connectorKey)!,
      value: { id: link.installationId, status: 'disconnected' },
      version: 2,
    })
    await expect(persistence.createConflict(createConflict()))
      .rejects.toMatchObject({ code: 'ConnectorSyncStateConflict' })

    memory.items.delete(linkKey)
    await expect(persistence.createConflict(createConflict()))
      .rejects.toMatchObject({ code: 'ConnectorSyncStateConflict' })
    await expect(persistence.getConflict('workspace-1', 'conflict-1'))
      .resolves.toBeUndefined()
  })

  test('releases pre-side-effect claims and takes over expired resolution leases', async () => {
    const memory = createMemoryDocumentClient()
    const link = createLink()
    seedLinkAndConnector(memory, link)
    let now = new Date('2026-07-18T00:00:00.000Z')
    const persistence = new DynamoDbConnectorSyncPersistence({
      tableName: 'DeveloperPlatformTable',
      auditTableName: 'AuditEventsTable',
      documentClient: memory.documentClient,
      clock: () => now,
      resolutionLeaseSeconds: 60,
    })
    await persistence.createConflict(createConflict())

    await expect(persistence.claimConflictResolution(
      'workspace-1',
      'conflict-1',
      {
        operationId: 'resolution-operation-1',
        startedAt: now.toISOString(),
      },
    )).resolves.toBe('claimed')
    now = new Date('2026-07-18T00:00:30.000Z')
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      'conflict-1',
      {
        operationId: 'resolution-operation-2',
        startedAt: now.toISOString(),
      },
    )).resolves.toBe('busy')
    await expect(persistence.releaseConflictResolution(
      'workspace-1',
      'conflict-1',
      'resolution-operation-1',
    )).resolves.toBe(true)
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      'conflict-1',
      {
        operationId: 'resolution-operation-2',
        startedAt: now.toISOString(),
      },
    )).resolves.toBe('claimed')

    now = new Date('2026-07-18T00:01:31.000Z')
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      'conflict-1',
      {
        operationId: 'resolution-operation-2',
        startedAt: now.toISOString(),
      },
    )).resolves.toBe('claimed')
    now = new Date('2026-07-18T00:02:32.000Z')
    await expect(persistence.claimConflictResolution(
      'workspace-1',
      'conflict-1',
      {
        operationId: 'resolution-operation-3',
        startedAt: now.toISOString(),
      },
    )).resolves.toBe('claimed')
  })
})
