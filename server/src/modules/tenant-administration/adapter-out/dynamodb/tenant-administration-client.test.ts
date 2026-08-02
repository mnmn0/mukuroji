import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type {
  TenantOperation,
  UpdateTenantEntitlementInput,
} from '@mukuroji/contracts'
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

/** Concrete DynamoDB transaction item used by adapter tests. */
type TestTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

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

/** Moves the tenant profile fixture into the durable closure lifecycle. */
function markTenantClosing(items: Map<string, object>): void {
  const profile = items.get('PROFILE')
  if (!profile) throw new Error('Tenant profile fixture is unavailable.')
  items.set('PROFILE', {
    ...profile,
    status: 'closing',
    revision: 1,
    updatedAt: '2026-08-02T00:01:00.000Z',
  })
}

/** Creates one deterministic digest-only operation evidence reference. */
function createEvidenceReference(seed: string): string {
  return `evidence:sha256:${createHash('sha256').update(seed).digest('hex')}`
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
function createAuditWriter(): TenantAdministrationAuditWriter<TestTransactionItem> {
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

  test('treats profiles written before lifecycle status as active', async () => {
    const items = createAggregateItems(1)
    const profile = items.get('PROFILE')
    if (!isRecord(profile)) throw new Error('Tenant profile fixture is unavailable.')
    const legacyProfile = { ...profile }
    delete legacyProfile.status
    items.set('PROFILE', legacyProfile)
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
    )

    const snapshot = await client.getSnapshot('workspace-1')

    expect(snapshot.profile.status).toBe('active')
  })

  test('fails closed when a serialized tenant payload crosses Workspace scope', async () => {
    const items = createAggregateItems(1)
    const profile = items.get('PROFILE')
    if (!profile) throw new Error('Tenant profile fixture is unavailable.')
    items.set('PROFILE', { ...profile, workspaceId: 'workspace-2' })
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
    )

    await expect(client.getSnapshot('workspace-1')).rejects.toMatchObject({
      code: 'TenantAdministrationCorrupt',
      status: 503,
    })
  })

  test('treats an existing malformed tenant row as corruption, not missing state', async () => {
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        const recordKey = readRecordKey(command)
        if (recordKey !== 'PROFILE') return {}
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey,
            revision: 0,
          },
        }
      }),
    )

    await expect(client.getSnapshot('workspace-1')).rejects.toMatchObject({
      code: 'TenantAdministrationCorrupt',
      status: 503,
    })
  })

  test('reconciles an authoritative Workspace owner without trusting the administrator', async () => {
    const items = createAggregateItems(1)
    const transactions: Array<Record<string, unknown>> = []
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
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
    )

    const snapshot = await client.ensureSnapshot(
      'workspace-1',
      'new-owner@example.com',
      1,
    )

    expect(snapshot.profile).toMatchObject({
      ownerMemberKey: 'new-owner@example.com',
      revision: 1,
      updatedAt: '2026-08-02T00:01:00.000Z',
    })
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          Put: {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'PROFILE',
              revision: 1,
            },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
        {
          ConditionCheck: {
            Key: { workspaceId: 'workspace-1', recordKey: 'GOVERNANCE' },
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
        {
          Put: {
            TableName: 'AuditEventsTable',
            Item: {
              directoryId: 'workspace-1',
              eventId: 'tenant-profile-owner:workspace-1:1',
            },
          },
        },
      ],
    })
  })

  test('returns a completed closure while administrator verification is pending', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    const closure = {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'completed',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:06:00.000Z',
      updatedBy: 'executor:tenant-operation-capability',
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
        'verify',
      ],
      lastEvidenceReference: createEvidenceReference('closure-completed'),
      revision: 7,
    }
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        if (recordKey === 'ACTIVE_OPERATION') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey,
              operationId: 'closure-1',
              kind: 'closure',
            },
          }
        }
        if (recordKey === 'OPERATION#closure-1') {
          return { Item: createStateItem(recordKey, closure) }
        }
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
    )

    const snapshot = await client.getSnapshot('workspace-1')

    expect(snapshot.activeOperation).toMatchObject({
      operationId: 'closure-1',
      status: 'completed',
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

    expect(transactionItems).toHaveLength(5)
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
    expect(transactionItems[3]).toMatchObject({
      ConditionCheck: {
        TableName: 'TenantAdministrationTable',
        Key: {
          workspaceId: 'workspace-1',
          recordKey: 'GOVERNANCE',
        },
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 0 },
      },
    })
    expect(transactionItems[4]).toMatchObject({
      ConditionCheck: {
        TableName: 'TenantAdministrationTable',
        Key: {
          workspaceId: 'workspace-1',
          recordKey: 'PROFILE',
        },
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 0 },
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
        {
          ConditionCheck: {
            TableName: 'TenantAdministrationTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'GOVERNANCE' },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
        {
          ConditionCheck: {
            TableName: 'TenantAdministrationTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'PROFILE' },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
      ],
    })
  })

  test('maps only all-conditional transaction cancellations to a revision conflict', async () => {
    const items = createAggregateItems(1)
    const createClient = (cancellationReasons: unknown[]) =>
      new DynamoDbTenantAdministrationClient(
        'TenantAdministrationTable',
        createDocumentClient((command) => {
          if (command.constructor.name === 'TransactWriteCommand') {
            throw {
              name: 'TransactionCanceledException',
              CancellationReasons: cancellationReasons,
            }
          }
          const recordKey = readRecordKey(command)
          if (!recordKey) return {}
          const value = items.get(recordKey)
          return value ? { Item: createStateItem(recordKey, value) } : {}
        }),
      )
    const input = {
      plan: 'growth',
      features: ['documents'],
      seatLimit: 10,
      usageQuota: 50_000,
      gracePeriodDays: 14,
      expectedRevision: 0,
    } satisfies UpdateTenantEntitlementInput

    await expect(createClient([
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ]).updateEntitlement('workspace-1', 'system-admin-1', input)).rejects.toMatchObject({
      code: 'TenantEntitlementRevisionConflict',
      status: 409,
    })
    await expect(createClient([
      { Code: 'ConditionalCheckFailed' },
      { Code: 'TransactionConflict' },
    ]).updateEntitlement('workspace-1', 'system-admin-1', input)).rejects.toMatchObject({
      code: 'TenantAdministrationUnavailable',
      status: 503,
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
        {
          ConditionCheck: {
            Key: { workspaceId: 'workspace-1', recordKey: 'GOVERNANCE' },
            ExpressionAttributeValues: { ':expectedRevision': 0 },
          },
        },
        {
          ConditionCheck: {
            Key: { workspaceId: 'workspace-1', recordKey: 'PROFILE' },
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

  test('rejects a scoped metering key reused with another request payload', async () => {
    const items = createAggregateItems(1)
    const scopeDigest = 'a'.repeat(64)
    const firstBinding = 'b'.repeat(64)
    const secondBinding = 'c'.repeat(64)
    const receiptKey = `USAGE_RECEIPT#${createHash('sha256')
      .update('workspace-1')
      .update('\0')
      .update('documents')
      .update('\0')
      .update(scopeDigest)
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
        .update('\0')
        .update(firstBinding)
        .digest('hex'),
      usageRevision: 1,
      createdAt: '2026-08-02T00:01:00.000Z',
      expiresAt: 1_900_000_000,
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
      () => '2026-08-02T00:02:00.000Z',
    )

    await expect(client.reserveUsage(
      'workspace-1',
      'documents',
      2,
      `tenant-meter:v1:${scopeDigest}:${secondBinding}`,
    )).rejects.toMatchObject({
      code: 'TenantUsageIdempotencyConflict',
      status: 409,
    })
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

  test('fails closed instead of masking a seat counter underflow', async () => {
    const items = createAggregateItems(0)
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
      memberKey: 'member-1',
      direction: 'deactivate',
      occurredAt: '2026-08-02T00:01:00.000Z',
    })).rejects.toMatchObject({
      code: 'TenantSeatCounterCorrupt',
      status: 503,
    })
  })

  test('blocks closure progress when legal hold becomes active after the request', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
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
    )).resolves.toMatchObject({
      status: 'requested',
      revision: 0,
    })
    expect(transactionWrites).toBe(0)
  })

  test('allows only legal-hold changes while a closure is active', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
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

    await expect(client.updateGovernance('workspace-1', 'owner-1', {
      auditRetentionDays: 365,
      legalHold: true,
      dataResidency: 'us-east-1',
      encryptionKeyPolicy: 'aws-managed',
      expectedRevision: 0,
    })).resolves.toMatchObject({ legalHold: true, revision: 1 })
    expect(transactions).toHaveLength(1)
    const legalHoldItems = transactions[0]?.TransactItems
    if (!Array.isArray(legalHoldItems)) {
      throw new Error('Expected a legal-hold transaction.')
    }
    expect(legalHoldItems.some((item: unknown) =>
      JSON.stringify(item).includes('OPERATION_EXECUTION_LEASE')
    )).toBe(true)

    await expect(client.updateGovernance('workspace-1', 'owner-1', {
      auditRetentionDays: 730,
      legalHold: true,
      dataResidency: 'us-east-1',
      encryptionKeyPolicy: 'aws-managed',
      expectedRevision: 0,
    })).rejects.toMatchObject({
      code: 'TenantGovernanceLockedDuringClosure',
      status: 409,
    })
  })

  test('fences resource pages and pause with one expiring execution lease', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    const operation: TenantOperation = {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'running',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:02:00.000Z',
      updatedBy: 'executor:tenant-member-anonymization',
      currentStep: 'delete-data',
      completedSteps: ['export', 'revoke-access', 'anonymize-members'],
      lastEvidenceReference: createEvidenceReference('anonymize-members'),
      revision: 4,
    }
    items.set('OPERATION#closure-1', {
      ...operation,
      completedSteps: [...operation.completedSteps],
    })
    const commands: CapturedCommand[] = []
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        commands.push(command)
        if (command.constructor.name === 'TransactWriteCommand') return {}
        if (command.constructor.name === 'DeleteCommand') return {}
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:02:00.000Z',
    )
    const expiresAt = Math.floor(Date.parse('2026-08-02T00:08:00.000Z') / 1_000)

    await expect(client.acquireOperationExecutionLease(
      operation,
      'lease-owner-1',
      expiresAt,
    )).resolves.toBe(true)
    await client.releaseOperationExecutionLease(
      'workspace-1',
      'closure-1',
      'lease-owner-1',
    )
    await expect(client.pauseOperation(
      'workspace-1',
      'owner-1',
      'closure-1',
    )).resolves.toMatchObject({ status: 'paused' })

    const transactions = commands
      .filter((command) => command.constructor.name === 'TransactWriteCommand')
      .map((command) => command.input)
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        { ConditionCheck: { Key: { recordKey: 'OPERATION#closure-1' } } },
        { ConditionCheck: { Key: { recordKey: 'GOVERNANCE' } } },
        {
          Put: {
            Item: {
              recordKey: 'OPERATION_EXECUTION_LEASE',
              leaseOwner: 'lease-owner-1',
              leaseExpiresAtEpochSeconds: expiresAt,
            },
          },
        },
      ],
    })
    const pauseItems = transactions[1]?.TransactItems
    if (!Array.isArray(pauseItems)) throw new Error('Expected a pause transaction.')
    expect(pauseItems.some((item: unknown) =>
      JSON.stringify(item).includes('OPERATION_EXECUTION_LEASE')
    )).toBe(true)
    expect(commands.find((command) => command.constructor.name === 'DeleteCommand'))
      .toMatchObject({
        input: {
          Key: { recordKey: 'OPERATION_EXECUTION_LEASE' },
          ConditionExpression:
            'operationId = :operationId AND leaseOwner = :leaseOwner',
        },
      })
  })

  test('atomically seals new access on closure request and replays the same request', async () => {
    const items = createAggregateItems(1)
    const transactions: Array<Record<string, unknown>> = []
    let activeOperationId: string | undefined
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input)
          return {}
        }
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        if (recordKey === 'ACTIVE_OPERATION' && activeOperationId) {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey,
              operationId: activeOperationId,
              kind: 'closure',
            },
          }
        }
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:01:00.000Z',
    )

    const requested = await client.requestClosure(
      'workspace-1',
      'owner-1',
      { confirmation: 'CLOSE' },
      'close-workspace-1',
    )

    expect(requested.status).toBe('requested')
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        { Put: { Item: { recordKey: `OPERATION#${requested.operationId}` } } },
        { Put: { Item: { recordKey: expect.stringMatching(/^OPERATION_HISTORY#/u) } } },
        {
          Put: {
            Item: {
              recordKey: 'ACTIVE_OPERATION',
              operationId: requested.operationId,
              kind: 'closure',
            },
          },
        },
        { ConditionCheck: { Key: { recordKey: 'GOVERNANCE' } } },
        { Put: { Item: { recordKey: 'PROFILE', revision: 1 } } },
      ],
    })
    expect(JSON.stringify(transactions[0])).toContain(
      '\\"status\\":\\"closing\\"',
    )

    markTenantClosing(items)
    items.set(`OPERATION#${requested.operationId}`, requested)
    activeOperationId = requested.operationId
    const replayed = await client.requestClosure(
      'workspace-1',
      'owner-1',
      { confirmation: 'CLOSE' },
      'close-workspace-1',
    )

    expect(replayed).toEqual(requested)
    expect(transactions).toHaveLength(1)
  })

  test('keeps a completed closure locked until its terminal verification', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    const completedSteps = [
      'export',
      'revoke-access',
      'anonymize-members',
      'delete-data',
      'delete-secrets',
    ]
    items.set('OPERATION#closure-1', {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'running',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:05:00.000Z',
      updatedBy: 'executor:tenant-operation-capability',
      currentStep: 'verify',
      completedSteps,
      lastEvidenceReference: createEvidenceReference('delete-secrets'),
      revision: 6,
    })
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
      () => '2026-08-02T00:06:00.000Z',
      undefined,
      undefined,
      undefined,
      'WorkspaceAccessTable',
      '1'.repeat(64),
    )

    const completed = await client.advanceOperation(
      'workspace-1',
      'executor:tenant-operation-capability',
      'closure-1',
      {
        step: 'verify',
        evidenceReference: `evidence:sha256:${'6'.padStart(64, '0')}`,
      },
    )

    expect(completed.status).toBe('completed')
    expect(JSON.stringify(transactions[0])).not.toContain('ACTIVE_OPERATION')

    items.set('OPERATION#closure-1', completed)
    const governance = items.get('GOVERNANCE')
    if (!governance) throw new Error('Governance fixture is unavailable.')
    items.set('GOVERNANCE', { ...governance, legalHold: true, revision: 1 })
    await expect(client.verifyClosure(
      'workspace-1',
      'owner-1',
      'closure-1',
    )).rejects.toMatchObject({
      code: 'TenantLegalHoldActive',
      status: 409,
    })
    expect(transactions).toHaveLength(1)
    items.set('GOVERNANCE', governance)
    const verified = await client.verifyClosure(
      'workspace-1',
      'owner-1',
      'closure-1',
    )

    expect(verified.status).toBe('verified')
    expect(transactions[1]).toMatchObject({
      TransactItems: [
        { Put: { Item: { recordKey: 'OPERATION#closure-1' } } },
        { Put: { Item: { recordKey: expect.stringMatching(/^OPERATION_HISTORY#/u) } } },
        { ConditionCheck: { Key: { recordKey: 'GOVERNANCE' } } },
        {
          Put: {
            Item: {
              recordKey: 'PROFILE',
              revision: 2,
            },
          },
        },
        {
          Delete: {
            Key: {
              workspaceId: 'workspace-1',
              recordKey: 'ACTIVE_OPERATION',
            },
            ConditionExpression: 'operationId = :operationId',
          },
        },
      ],
    })
    expect(JSON.stringify(transactions[1])).not.toContain('WorkspaceAccessTable')
    expect(verified.requestedBy)
      .toMatch(/^deleted\+[a-f0-9]{16}\.[a-f0-9]{24}@invalid\.example$/u)
    expect(verified.updatedBy).toBe(verified.requestedBy)
    expect(JSON.stringify(transactions[1])).toContain(
      '\\"status\\":\\"closed\\"',
    )
    expect(JSON.stringify(transactions[1])).toContain(
      '\\"closedByOperationId\\":\\"closure-1\\"',
    )

    items.set('OPERATION#closure-1', verified)
    await expect(client.verifyClosure(
      'workspace-1',
      'owner-1',
      'closure-1',
    )).resolves.toEqual(verified)
    expect(transactions).toHaveLength(2)
  })

  test('persists a verified residual repair as a valid cleanup-step prefix', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    items.set('OPERATION#closure-1', {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'running',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:06:00.000Z',
      updatedBy: 'executor:tenant-secret-deletion',
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
      ],
      lastEvidenceReference: createEvidenceReference('delete-secrets'),
      revision: 6,
    })
    const client = new DynamoDbTenantAdministrationClient(
      'TenantAdministrationTable',
      createDocumentClient((command) => {
        if (command.constructor.name === 'TransactWriteCommand') return {}
        if (command.constructor.name === 'QueryCommand') {
          return {
            Items: [{
              workspaceId: 'workspace-1',
              recordKey:
                'EVIDENCE#closure-1#delete-data#REVISION#0000000000000004',
              kind: 'operation-evidence',
              operationId: 'closure-1',
              operationRevision: 4,
              step: 'delete-data',
              evidenceDigest: createHash('sha256')
                .update('delete-data')
                .digest('hex'),
            }],
          }
        }
        const recordKey = readRecordKey(command)
        if (!recordKey) return {}
        const value = items.get(recordKey)
        return value ? { Item: createStateItem(recordKey, value) } : {}
      }),
      () => '2026-08-02T00:07:00.000Z',
    )

    const repaired = await client.repairOperation(
      'workspace-1',
      'executor:tenant-closure-verification',
      'closure-1',
      'delete-secrets',
    )

    expect(repaired).toMatchObject({
      status: 'running',
      currentStep: 'delete-secrets',
      completedSteps: ['export', 'revoke-access', 'anonymize-members', 'delete-data'],
      lastEvidenceReference: createEvidenceReference('delete-data'),
      revision: 7,
    })
    items.set('OPERATION#closure-1', repaired)
    await expect(client.getOperation('workspace-1', 'closure-1'))
      .resolves.toEqual(repaired)
  })

  test('reopens a closing tenant when a reversible capability fails safely', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    items.set('OPERATION#closure-1', {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'running',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:04:00.000Z',
      updatedBy: 'executor:tenant-operation-stream',
      currentStep: 'revoke-access',
      completedSteps: ['export'],
      lastEvidenceReference: createEvidenceReference('export'),
      revision: 2,
    })
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
      () => '2026-08-02T00:05:00.000Z',
    )

    const failed = await client.failOperation(
      'workspace-1',
      'executor:tenant-access-revocation',
      'closure-1',
      'ACCESS_REVOKE_FAILED',
    )

    expect(failed).toMatchObject({
      status: 'failed',
      failureCode: 'ACCESS_REVOKE_FAILED',
      updatedBy: 'executor:tenant-access-revocation',
    })
    expect(transactions[0]).toMatchObject({
      TransactItems: [
        { Put: { Item: { recordKey: 'OPERATION#closure-1' } } },
        { Put: { Item: { recordKey: expect.stringMatching(/^OPERATION_HISTORY#/u) } } },
        { ConditionCheck: { Key: { recordKey: 'GOVERNANCE' } } },
        { Put: { Item: { recordKey: 'PROFILE', revision: 2 } } },
        { Delete: { Key: { recordKey: 'ACTIVE_OPERATION' } } },
      ],
    })
    expect(JSON.stringify(transactions[0])).toContain(
      '\\"status\\":\\"active\\"',
    )
  })

  test('keeps a closing tenant sealed after an irreversible capability failure', async () => {
    const items = createAggregateItems(1)
    markTenantClosing(items)
    items.set('OPERATION#closure-1', {
      operationId: 'closure-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'running',
      requestedBy: 'owner-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:04:00.000Z',
      updatedBy: 'executor:tenant-member-anonymization',
      currentStep: 'delete-data',
      completedSteps: ['export', 'revoke-access', 'anonymize-members'],
      lastEvidenceReference: createEvidenceReference('anonymize-members'),
      revision: 4,
    })
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
      () => '2026-08-02T00:05:00.000Z',
    )

    await expect(client.failOperation(
      'workspace-1',
      'executor:tenant-data-deletion',
      'closure-1',
      'DATA_DELETE_FAILED',
    )).rejects.toMatchObject({
      code: 'TenantClosureRecoveryRequired',
      status: 409,
    })
    expect(transactions).toEqual([])
  })

  test('applies current legal hold to each newly inserted tenant audit event', async () => {
    const items = createAggregateItems(1)
    const governance = items.get('GOVERNANCE')
    if (!governance) throw new Error('Governance fixture is unavailable.')
    items.set('GOVERNANCE', { ...governance, legalHold: true, revision: 2 })
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
      undefined,
      undefined,
      undefined,
      'AuditEventsTable',
    )

    await client.reconcileAuditEventRetention(
      'workspace-1',
      'event-1',
      '2026-08-02T00:00:00.000Z',
    )

    expect(transactions[0]).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            Key: { workspaceId: 'workspace-1', recordKey: 'GOVERNANCE' },
            ExpressionAttributeValues: { ':expectedRevision': 2 },
          },
        },
        {
          Update: {
            TableName: 'AuditEventsTable',
            Key: { directoryId: 'workspace-1', eventId: 'event-1' },
            UpdateExpression: 'REMOVE expiresAt',
            ExpressionAttributeValues: {
              ':occurredAt': '2026-08-02T00:00:00.000Z',
            },
          },
        },
      ],
    })
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
        {
          ConditionCheck: {
            TableName: 'TenantAdministrationTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'PROFILE' },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 0 },
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
