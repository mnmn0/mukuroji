import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  TenantAdministrationError,
  createDefaultTenantAdministrationSnapshot,
} from '../../domain/tenant-administration'
import type {
  TenantAdministrationAuditWriter,
} from '../../application/ports/tenant-administration-port'
import { DynamoDbTenantAdministrationClient } from './tenant-administration-client'

type CapturedCommand = {
  /** Command input inspected by the test transport. */
  input: Record<string, unknown>
  /** Runtime command constructor metadata. */
  constructor: {
    /** AWS SDK command class name. */
    name: string
  }
}

/** Installs a deterministic, network-free responder on a DocumentClient. */
function createDocumentClient(
  handler: (command: CapturedCommand) => unknown,
): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  Object.defineProperty(client, 'send', {
    configurable: true,
    value: async (command: CapturedCommand): Promise<unknown> => handler(command),
  })
  return client
}

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a DynamoDB record key without asserting an untrusted command shape. */
function readRecordKey(command: CapturedCommand): string | undefined {
  const key = command.input.Key
  return isRecord(key) && typeof key.recordKey === 'string'
    ? key.recordKey
    : undefined
}

/** Creates serialized aggregate records returned by the adapter test transport. */
function createAggregateItems(activeSeats: number) {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
    { dataResidency: 'us-east-1', encryptionKeyPolicy: 'aws-managed' },
    activeSeats,
  )
  return new Map<string, object>([
    ['PROFILE', snapshot.profile],
    ['ENTITLEMENT', snapshot.entitlement],
    ['USAGE', snapshot.usage],
    [`BILLING#${snapshot.usage.periodStart}`, snapshot.billingPeriods[0]],
    ['GOVERNANCE', snapshot.governance],
  ])
}

/** Creates one DynamoDB state item for a serialized aggregate value. */
function createStateItem(recordKey: string, value: object) {
  const revision = 'revision' in value && typeof value.revision === 'number'
    ? value.revision
    : 0
  return {
    workspaceId: 'workspace-1',
    recordKey,
    revision,
    payload: JSON.stringify(value),
  }
}

/** Creates a deterministic audit transaction contributor for adapter tests. */
function createAuditWriter(): TenantAdministrationAuditWriter {
  return {
    createTransactionItem(event) {
      return {
        Put: {
          TableName: 'AuditEventsTable',
          Item: {
            directoryId: event.workspaceId,
            eventId: event.idempotencyKey,
          },
          ConditionExpression: 'attribute_not_exists(eventId)',
        },
      }
    },
  }
}

describe('DynamoDbTenantAdministrationClient', () => {
  test('returns the data-plane governance controls with the tenant aggregate', async () => {
    const items = createAggregateItems(3)
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:00:00.000Z',
      undefined,
      { dataResidency: 'us-east-1', encryptionKeyPolicy: 'aws-managed' },
    )

    const snapshot = await client.getSnapshot('workspace-1')

    expect(snapshot.schemaVersion).toBe(2)
    expect(snapshot.usage.activeSeats).toBe(3)
    expect(snapshot.governanceEnforcement).toEqual({
      dataResidency: 'us-east-1',
      encryptionKeyPolicy: 'aws-managed',
    })
  })

  test('rejects residency and key settings that the deployment cannot enforce', async () => {
    const items = createAggregateItems(1)
    let transactionWrites = 0
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') transactionWrites += 1
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
      undefined,
      { dataResidency: 'us-east-1', encryptionKeyPolicy: 'aws-managed' },
    )

    await expect(client.updateGovernance('workspace-1', 'owner-1', {
      auditRetentionDays: 365,
      legalHold: false,
      dataResidency: 'eu-west-1',
      encryptionKeyPolicy: 'customer-managed',
      expectedRevision: 0,
    })).rejects.toMatchObject({
      code: 'TenantDataResidencyUnavailable',
      status: 409,
    })
    expect(transactionWrites).toBe(0)
  })

  test('prepares a conditional seat counter in the membership transaction', async () => {
    const items = createAggregateItems(4)
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
    )

    const transactionItems = await client.prepareSeatMutation({
      workspaceId: 'workspace-1',
      memberKey: 'member-5',
      direction: 'activate',
      occurredAt: '2026-08-02T00:01:00.000Z',
    })

    expect(transactionItems).toHaveLength(3)
    expect(transactionItems[0]).toMatchObject({
      ConditionCheck: {
        TableName: 'TenantAdministrationTable',
        Key: {
          workspaceId: 'workspace-1',
          recordKey: 'ENTITLEMENT',
        },
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 0 },
      },
    })
    expect(transactionItems[1]).toMatchObject({
      Put: {
        TableName: 'TenantAdministrationTable',
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 0 },
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'USAGE',
          revision: 1,
        },
      },
    })
    expect(transactionItems[2]).toMatchObject({
      Put: {
        TableName: 'TenantAdministrationTable',
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 0 },
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'BILLING#2026-08-01T00:00:00.000Z',
          revision: 1,
        },
      },
    })
  })

  test('serializes entitlement changes with current seat and usage state', async () => {
    const items = createAggregateItems(4)
    const transactions: Array<Record<string, unknown>> = []
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input)
          return {}
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
    )

    await client.updateEntitlement('workspace-1', 'system-admin-1', {
      plan: 'growth',
      features: ['documents', 'analytics'],
      seatLimit: 10,
      usageQuota: 50_000,
      gracePeriodDays: 14,
      expectedRevision: 0,
    })

    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          Put: {
            TableName: 'TenantAdministrationTable',
            Item: { recordKey: 'ENTITLEMENT', revision: 1 },
            ConditionExpression: 'revision = :expectedRevision',
          },
        },
        {
          ConditionCheck: {
            TableName: 'TenantAdministrationTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'USAGE' },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
      ],
    })
  })

  test('commits a digest-only usage receipt with entitlement and usage conditions', async () => {
    const items = createAggregateItems(1)
    const transactions: Array<Record<string, unknown>> = []
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input)
          return {}
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
    )

    const usage = await client.reserveUsage(
      'workspace-1',
      'documents',
      2,
      'usage-request-1',
    )

    expect(usage).toMatchObject({ periodUsage: 2, revision: 1 })
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            Key: { workspaceId: 'workspace-1', recordKey: 'ENTITLEMENT' },
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
        { Put: { Item: { recordKey: 'USAGE', revision: 1 } } },
        { Put: { Item: { recordKey: 'BILLING#2026-08-01T00:00:00.000Z' } } },
        {
          Put: {
            Item: {
              kind: 'usage-receipt',
              expiresAt: 1_788_652_860,
            },
            ConditionExpression:
              'attribute_not_exists(recordKey) OR expiresAt <= :currentEpochSeconds',
          },
        },
      ],
    })
    expect(JSON.stringify(transactions[0])).not.toContain('usage-request-1')
  })

  test('replays a matching usage receipt without incrementing usage twice', async () => {
    const items = createAggregateItems(1)
    const idempotencyKey = 'usage-request-replay'
    const receiptKey = `USAGE_RECEIPT#${createHash('sha256')
      .update('workspace-1')
      .update('\0')
      .update('documents')
      .update('\0')
      .update(idempotencyKey)
      .digest('hex')}`
    const usage = items.get('USAGE')
    if (!usage) throw new Error('Usage fixture is unavailable.')
    items.set('USAGE', {
      ...usage,
      periodUsage: 2,
      revision: 1,
      updatedAt: '2026-08-02T00:01:00.000Z',
    })
    items.set(receiptKey, {
      workspaceId: 'workspace-1',
      feature: 'documents',
      additionalUnits: 2,
      requestFingerprint: createHash('sha256')
        .update('documents')
        .update('\0')
        .update('2')
        .digest('hex'),
      usageRevision: 1,
      createdAt: '2026-08-02T00:01:00.000Z',
      expiresAt: 1_788_652_860,
    })
    let transactionWrites = 0
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') transactionWrites += 1
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:02:00.000Z',
    )

    const replayed = await client.reserveUsage(
      'workspace-1',
      'documents',
      2,
      idempotencyKey,
    )

    expect(replayed).toMatchObject({ periodUsage: 2, revision: 1 })
    expect(transactionWrites).toBe(0)
  })

  test('replays an export request from its digest-derived operation identifier', async () => {
    const items = createAggregateItems(1)
    let transactionWrites = 0
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        if (command.constructor.name === 'TransactWriteCommand') {
          transactionWrites += 1
          const transactionItems = command.input.TransactItems
          if (Array.isArray(transactionItems)) {
            const firstItem = transactionItems[0]
            const put = isRecord(firstItem) && isRecord(firstItem.Put)
              ? firstItem.Put
              : undefined
            const item = put && isRecord(put.Item) ? put.Item : undefined
            if (
              item &&
              typeof item.recordKey === 'string' &&
              typeof item.payload === 'string'
            ) {
              const payload: unknown = JSON.parse(item.payload)
              if (isRecord(payload)) items.set(item.recordKey, payload)
            }
          }
          return {}
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
    )

    const first = await client.requestExport(
      'workspace-1',
      'owner-1',
      { format: 'jsonl' },
      'export-request-1',
    )
    const replayed = await client.requestExport(
      'workspace-1',
      'owner-1',
      { format: 'jsonl' },
      'export-request-1',
    )

    expect(first.operationId).toMatch(/^operation-[a-f0-9]{64}$/u)
    expect(replayed).toEqual(first)
    expect(transactionWrites).toBe(1)
  })

  test('fails closed before assigning a seat above the current limit', async () => {
    const items = createAggregateItems(5)
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
    )

    await expect(client.prepareSeatMutation({
      workspaceId: 'workspace-1',
      memberKey: 'member-6',
      direction: 'activate',
      occurredAt: '2026-08-02T00:01:00.000Z',
    })).rejects.toBeInstanceOf(TenantAdministrationError)
    await expect(client.prepareSeatMutation({
      workspaceId: 'workspace-1',
      memberKey: 'member-6',
      direction: 'activate',
      occurredAt: '2026-08-02T00:01:00.000Z',
    })).rejects.toMatchObject({ code: 'TenantSeatLimitExceeded' })
  })

  test('blocks closure progress when legal hold becomes active after the request', async () => {
    const items = createAggregateItems(1)
    const governance = items.get('GOVERNANCE')
    if (!governance || !('legalHold' in governance)) {
      throw new Error('Governance fixture is unavailable.')
    }
    items.set('GOVERNANCE', { ...governance, legalHold: true, revision: 1 })
    items.set('OPERATION#closure-1', {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'requested',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      updatedBy: 'owner-1',
      completedSteps: [],
      revision: 0,
    })
    let transactionWrites = 0
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactionWrites += 1
          return {}
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
    )

    await expect(client.advanceOperation(
      'workspace-1',
      'executor:tenant-operation-stream',
      'closure-1',
      undefined,
    )).rejects.toMatchObject({
      code: 'TenantLegalHoldActive',
      status: 409,
    })
    expect(transactionWrites).toBe(0)
  })

  test('creates a durable retention job with a legal-hold policy change', async () => {
    const items = createAggregateItems(1)
    const transactions: Array<Record<string, unknown>> = []
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input)
          return {}
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
      createAuditWriter(),
      { dataResidency: 'us-east-1', encryptionKeyPolicy: 'aws-managed' },
      'AuditEventsTable',
    )

    await client.updateGovernance('workspace-1', 'owner-1', {
      auditRetentionDays: 365,
      legalHold: true,
      dataResidency: 'us-east-1',
      encryptionKeyPolicy: 'aws-managed',
      expectedRevision: 0,
    })

    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          Put: {
            TableName: 'TenantAdministrationTable',
            Item: { recordKey: 'GOVERNANCE', revision: 1 },
            ConditionExpression: 'revision = :expectedRevision',
          },
        },
        {
          Put: {
            TableName: 'TenantAdministrationTable',
            Item: {
              recordKey: 'RETENTION_JOB',
              kind: 'retention-job',
              status: 'pending',
            },
          },
        },
        { Put: { TableName: 'AuditEventsTable' } },
      ],
    })
  })

  test('removes audit TTLs and seals bounded legal-hold reconciliation', async () => {
    const transactions: Array<Record<string, unknown>> = []
    const job = {
      workspaceId: 'workspace-1',
      governanceRevision: 1,
      status: 'pending',
      retentionDays: 365,
      legalHold: true,
      processedEvents: 0,
      revision: 0,
      updatedAt: '2026-08-02T00:01:00.000Z',
      updatedBy: 'owner-1',
    }
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'GetCommand') {
          return { Item: createStateItem('RETENTION_JOB', job) }
        }
        if (command.constructor.name === 'QueryCommand') {
          return {
            Items: [{
              directoryId: 'workspace-1',
              eventId: 'event-1',
              occurredAt: '2026-08-01T00:00:00.000Z',
              expiresAt: 1_800_000_000,
            }],
          }
        }
        transactions.push(command.input)
        return {}
      }),
      () => '2026-08-02T00:02:00.000Z',
      createAuditWriter(),
      undefined,
      'AuditEventsTable',
    )

    const result = await client.reconcileAuditRetention('workspace-1')

    expect(result).toMatchObject({
      status: 'completed',
      processedEvents: 1,
      revision: 1,
    })
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          Update: {
            TableName: 'AuditEventsTable',
            Key: { directoryId: 'workspace-1', eventId: 'event-1' },
            UpdateExpression: 'REMOVE expiresAt',
          },
        },
        {
          Put: {
            TableName: 'TenantAdministrationTable',
            Item: {
              recordKey: 'RETENTION_JOB',
              status: 'completed',
              revision: 1,
            },
          },
        },
        { Put: { TableName: 'AuditEventsTable' } },
      ],
    })
  })
})
