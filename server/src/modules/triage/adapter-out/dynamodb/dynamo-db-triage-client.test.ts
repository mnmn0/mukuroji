import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, spyOn, test } from 'bun:test'
import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageConfiguration,
  type TriageEntry,
  type UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'
import { createTriageCapabilities } from '../../domain/triage-entry'
import { createTriageInputFingerprint } from '../../triage'
import {
  createTriageEntryTransactionItems,
} from './triage-transactions'
import {
  DynamoDbTriageClient,
  type TriageAdmissionValidator,
} from './dynamo-db-triage-client'

/** Stable client adapter test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a metadata-only entry containing fields that must not reach a receipt response. */
function createEntry(): TriageEntry {
  const permission = {
    visibility: 'metadata-only',
    canReply: false,
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: 'triage-1',
    workspaceId: 'workspace-1',
    source: { kind: 'email', sourceId: 'message-1' },
    sourcePreview: {
      title: 'Support request',
      body: 'sensitive body',
      permalink: 'https://mail.example.com/message/1',
      attachmentCount: 0,
      commentCount: 1,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: 'Requester',
      email: 'requester@example.com',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      guest: false,
    },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'accepted',
    routing: {
      reason: 'Support route.',
      candidates: [{ teamId: 'support', reason: 'Rule match.', permitted: true }],
    },
    teamId: 'support',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    canonicalWorkItem: { teamId: 'support', workItemId: 'work-item-1' },
    capabilities: createTriageCapabilities({ state: 'accepted', permission }),
    events: [],
    revision: 2,
    createdAt: NOW,
    updatedAt: '2026-08-09T00:05:00.000Z',
  }
}

/** Optional dependencies for a DynamoDB client test harness. */
type HarnessOptions = {
  /** Live validator invoked by source admission. */
  validateAdmission?: TriageAdmissionValidator
}

/** Creates a real DocumentClient whose send method follows a deterministic response list.
 *
 * @param responses Ordered DocumentClient results or errors.
 * @param options Optional admission dependencies.
 * @returns A client, captured commands, and cleanup hook.
 */
function createHarness(responses: unknown[], options: HarnessOptions = {}) {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  let callIndex = 0
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sendSpy = spyOn(documentClient, 'send')
  sendSpy.mockImplementation(async (command) => {
    const constructorValue = Reflect.get(command, 'constructor')
    const input = Reflect.get(command, 'input')
    if (typeof constructorValue !== 'function' || typeof constructorValue.name !== 'string' ||
      typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new TypeError('Expected an AWS DocumentClient command.')
    }
    commands.push({
      name: constructorValue.name,
      input: Object.fromEntries(Object.entries(input)),
    })
    const response = responses[callIndex]
    callIndex += 1
    if (response instanceof Error) throw response
    return response ?? {}
  })
  return {
    client: new DynamoDbTriageClient({
      tableName: 'RequestIntakeTable',
      documentClient,
      cursorSecret: 'test-cursor-secret',
      now: () => new Date(NOW),
      id: () => 'triage-manual-1',
      ...(options.validateAdmission
        ? { validateAdmission: options.validateAdmission }
        : {}),
    }),
    calls: () => callIndex,
    commands,
    restore: () => sendSpy.mockRestore(),
  }
}

/** Creates the persisted Team configuration observed by one admission attempt. */
function createManualRotationConfiguration(
  revision: number,
  nextIndex: number,
): TriageConfiguration {
  return {
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    teamId: 'support',
    rules: [{
      id: 'manual-support',
      name: 'Manual support',
      enabled: true,
      order: 1,
      sourceKinds: ['manual-handoff'],
      keywords: [],
      teamId: 'support',
      projectId: 'configured-project',
      owner: { type: 'rotation', rotationId: 'support-rotation' },
    }],
    rotations: [{
      id: 'support-rotation',
      name: 'Support rotation',
      memberUserIds: ['one@example.com', 'two@example.com'],
      nextIndex,
    }],
    slaPolicies: [{
      id: 'manual-sla',
      name: 'Manual response',
      sourceKinds: ['manual-handoff'],
      responseMinutes: 60,
      escalationMinutes: 30,
      escalationOwnerUserId: 'lead@example.com',
    }],
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    retentionDays: 30,
    revision,
    updatedAt: '2026-08-08T00:00:00.000Z',
  }
}

/** Creates one focused settings replacement fixture. */
function createConfigurationInput(
  expectedRevision: number,
  retentionDays = 30,
): UpdateTriageConfigurationInput {
  return {
    expectedRevision,
    rules: [],
    rotations: [],
    slaPolicies: [],
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    retentionDays,
  }
}

/** Creates the exact persisted settings snapshot produced by a focused replacement. */
function createConfigurationSnapshot(
  revision: number,
  retentionDays = 30,
): TriageConfiguration {
  return {
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    teamId: 'support',
    rules: [],
    rotations: [],
    slaPolicies: [],
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    retentionDays,
    revision,
    updatedAt: NOW,
  }
}

/** Returns the Put item with a matching persisted discriminator. */
function findTransactionPutItem(
  transactionItems: unknown,
  entryType: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(transactionItems)) return undefined
  for (const transactionItem of transactionItems) {
    if (!transactionItem || typeof transactionItem !== 'object') continue
    const put = Reflect.get(transactionItem, 'Put')
    if (!put || typeof put !== 'object') continue
    const item = Reflect.get(put, 'Item')
    if (item && typeof item === 'object' && Reflect.get(item, 'entryType') === entryType) {
      return Object.fromEntries(Object.entries(item))
    }
  }
  return undefined
}

describe('DynamoDbTriageClient action receipt lookup', () => {
  test('returns the current permission-safe entry without storing a historical source copy', async () => {
    const entry = createEntry()
    const fingerprint = createTriageInputFingerprint({ action: 'accept', entryId: entry.id })
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const harness = createHarness([
      {
        Item: {
          entryType: 'triage-operation-receipt',
          workspaceId: 'workspace-1',
          entryId: 'triage-1',
          inputFingerprint: fingerprint,
          resultRevision: 2,
        },
      },
      { Item: storedEntry },
    ])

    try {
      const receipt = await harness.client.getActionReceipt('workspace-1', 'triage-1', {
        key: 'accept-1',
        fingerprint,
      })

      expect(receipt).toMatchObject({
        replayed: true,
        entry: {
          id: 'triage-1',
          sourcePreview: { title: 'Support request', body: '' },
          requester: { displayName: 'Requester', guest: false },
        },
      })
      expect(receipt?.entry.sourcePreview.permalink).toBeUndefined()
      expect(JSON.stringify(receipt)).not.toContain('requester@example.com')
      expect(harness.calls()).toBe(2)
    } finally {
      harness.restore()
  }
})

  test('rejects an idempotency key reused with another semantic input', async () => {
    const originalFingerprint = createTriageInputFingerprint({ action: 'accept' })
    const harness = createHarness([{
      Item: {
        entryType: 'triage-operation-receipt',
        workspaceId: 'workspace-1',
        entryId: 'triage-1',
        inputFingerprint: originalFingerprint,
        resultRevision: 2,
      },
    }])

    try {
      await expect(harness.client.getActionReceipt('workspace-1', 'triage-1', {
        key: 'accept-1',
        fingerprint: createTriageInputFingerprint({ action: 'decline' }),
      })).rejects.toMatchObject({ code: 'TriageIdempotencyConflict', status: 409 })
      expect(harness.calls()).toBe(1)
    } finally {
      harness.restore()
    }
  })
})

describe('DynamoDbTriageClient transaction failure classification', () => {
  test('bubbles non-conditional transaction cancellations instead of returning a revision conflict', async () => {
    const entry = createEntry()
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const throughputFailure = Object.assign(new Error('Transaction capacity exceeded.'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }],
    })
    const harness = createHarness([{}, { Item: storedEntry }, throughputFailure])

    try {
      const fingerprint = createTriageInputFingerprint({ activityId: 'activity-1' })
      await expect(harness.client.recordSourceActivity(
        'workspace-1',
        'support',
        'triage-1',
        {
          activityId: 'activity-1',
          occurredAt: '2026-08-09T00:10:00.000Z',
          summary: 'Requester replied.',
          actorId: 'source:email',
        },
        { key: 'activity-1', fingerprint },
      )).rejects.toBe(throughputFailure)
      expect(harness.calls()).toBe(3)
    } finally {
      harness.restore()
    }
  })

  test('maps a cancellation caused only by a conditional check to a revision conflict', async () => {
    const entry = createEntry()
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const conflict = Object.assign(new Error('Entry revision changed.'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
    const harness = createHarness([{}, { Item: storedEntry }, conflict, {}])

    try {
      const fingerprint = createTriageInputFingerprint({ activityId: 'activity-1' })
      await expect(harness.client.recordSourceActivity(
        'workspace-1',
        'support',
        'triage-1',
        {
          activityId: 'activity-1',
          occurredAt: '2026-08-09T00:10:00.000Z',
          summary: 'Requester replied.',
          actorId: 'source:email',
        },
        { key: 'activity-1', fingerprint },
      )).rejects.toMatchObject({ code: 'TriageRevisionConflict', status: 409 })
      expect(harness.calls()).toBe(4)
    } finally {
      harness.restore()
    }
  })
})

describe('DynamoDbTriageClient configuration receipts', () => {
  test('commits and replays an initial revision-zero replacement', async () => {
    const input = createConfigurationInput(0)
    const fingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input,
    })
    const next = createConfigurationSnapshot(1)
    const receiptItem = {
      entryType: 'triage-configuration-receipt',
      workspaceId: 'workspace-1',
      teamId: 'support',
      inputFingerprint: fingerprint,
      configuration: next,
      expiresAt: 1_800_000_000,
    }
    const harness = createHarness([
      {},
      {},
      {},
      { Item: receiptItem },
    ])

    try {
      const idempotency = { key: 'settings-initial', fingerprint }
      const created = await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        idempotency,
      )
      const replayed = await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        idempotency,
      )

      expect(created).toEqual(next)
      expect(replayed).toEqual(next)
      expect(harness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
      expect(harness.commands[2]?.input.TransactItems).toEqual([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              entryType: 'triage-configuration',
              configuration: next,
            }),
            ConditionExpression:
              'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              entryType: 'triage-configuration-receipt',
              inputFingerprint: fingerprint,
              configuration: next,
              expiresAt: expect.any(Number),
            }),
            ConditionExpression:
              'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          }),
        }),
      ])
    } finally {
      harness.restore()
    }
  })

  test('replays the exact snapshot of an existing-revision replacement', async () => {
    const input = createConfigurationInput(7, 60)
    const current = createConfigurationSnapshot(7, 30)
    current.updatedAt = '2026-08-08T00:00:00.000Z'
    const next = createConfigurationSnapshot(8, 60)
    const fingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input,
    })
    const receiptItem = {
      entryType: 'triage-configuration-receipt',
      workspaceId: 'workspace-1',
      teamId: 'support',
      inputFingerprint: fingerprint,
      configuration: next,
      expiresAt: 1_800_000_000,
    }
    const harness = createHarness([
      {},
      {
        Item: {
          entryType: 'triage-configuration',
          configuration: current,
          revision: current.revision,
        },
      },
      {},
      { Item: receiptItem },
    ])

    try {
      const idempotency = { key: 'settings-existing', fingerprint }
      const updated = await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        idempotency,
      )
      const replayed = await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        idempotency,
      )

      expect(updated).toEqual(next)
      expect(replayed).toEqual(next)
      expect(harness.commands[2]?.input.TransactItems).toEqual([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({ configuration: next, revision: 8 }),
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': 7 },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              entryType: 'triage-configuration-receipt',
              configuration: next,
            }),
          }),
        }),
      ])
    } finally {
      harness.restore()
    }
  })

  test('rejects one settings key reused with different input', async () => {
    const originalInput = createConfigurationInput(0, 30)
    const originalFingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input: originalInput,
    })
    const harness = createHarness([{
      Item: {
        entryType: 'triage-configuration-receipt',
        workspaceId: 'workspace-1',
        teamId: 'support',
        inputFingerprint: originalFingerprint,
        configuration: createConfigurationSnapshot(1, 30),
        expiresAt: 1_800_000_000,
      },
    }])
    const changedInput = createConfigurationInput(0, 60)

    try {
      await expect(harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        changedInput,
        {
          key: 'settings-reused',
          fingerprint: createTriageInputFingerprint({
            workspaceId: 'workspace-1',
            teamId: 'support',
            input: changedInput,
          }),
        },
      )).rejects.toMatchObject({ code: 'TriageIdempotencyConflict', status: 409 })
      expect(harness.calls()).toBe(1)
    } finally {
      harness.restore()
    }
  })
})

describe('DynamoDbTriageClient queue indexes', () => {
  test('fails closed for malformed or cross-scope persisted Team settings', async () => {
    const malformed = createConfigurationSnapshot(4)
    malformed.rules = [{
      id: 'broken-rule',
      name: 'Broken rule',
      enabled: true,
      order: 0,
      sourceKinds: ['form'],
      keywords: [],
      teamId: 'support',
      owner: { type: 'rotation', rotationId: 'missing-rotation' },
    }]
    const crossScope = createConfigurationSnapshot(4)
    crossScope.workspaceId = 'workspace-other'

    for (const configuration of [malformed, crossScope]) {
      const harness = createHarness([{
        Item: {
          entryType: 'triage-configuration',
          configuration,
          revision: configuration.revision,
        },
      }])
      try {
        await expect(
          harness.client.getConfiguration('workspace-1', 'support'),
        ).rejects.toMatchObject({ code: 'InvalidTriageConfiguration', status: 500 })
      } finally {
        harness.restore()
      }
    }
  })

  test('rejects a bulk operation disabled by the current Team configuration', async () => {
    const configuration = createConfigurationSnapshot(4)
    configuration.allowedBulkActions = []
    const harness = createHarness([{
      Item: {
        entryType: 'triage-configuration',
        configuration,
        revision: configuration.revision,
      },
    }])

    try {
      await expect(harness.client.applyBulkAction(
        'workspace-1',
        'support',
        { id: 'member@example.com' },
        {
          targets: [{ entryId: 'triage-1', expectedRevision: 1 }],
          operation: { action: 'decline', reason: 'Out of scope.' },
        },
        'bulk-disabled',
      )).rejects.toMatchObject({ code: 'TriageBulkActionDisabled', status: 409 })
      expect(harness.calls()).toBe(1)
    } finally {
      harness.restore()
    }
  })

  test('queries the local-compatible Team index and strongly reads canonical entry rows', async () => {
    const entry = createEntry()
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const harness = createHarness([
      {},
      { Items: [{ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' }] },
      { Item: storedEntry },
    ])

    try {
      const page = await harness.client.listEntries('workspace-1', 'support', { limit: 10 })

      expect(page.entries).toHaveLength(1)
      expect(page.allowedBulkActions).toEqual(['assign', 'decline', 'snooze'])
      expect(page.entries[0]).toMatchObject({ id: 'triage-1', teamId: 'support' })
      expect(harness.commands).toEqual([
        expect.objectContaining({
          name: 'GetCommand',
          input: expect.objectContaining({
            ConsistentRead: true,
            Key: {
              scopeKey: 'WORKSPACE#workspace-1',
              recordKey: 'TRIAGE_CONFIG#TEAM#support',
            },
          }),
        }),
        expect.objectContaining({
          name: 'QueryCommand',
          input: expect.objectContaining({
            IndexName: 'triage-team-activity-index',
            KeyConditionExpression: 'triageTeamKey = :partitionKey',
            ExpressionAttributeValues: {
              ':partitionKey': 'WORKSPACE#workspace-1#TEAM#support',
            },
          }),
        }),
        expect.objectContaining({
          name: 'GetCommand',
          input: expect.objectContaining({
            ConsistentRead: true,
            Key: { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' },
          }),
        }),
      ])
    } finally {
      harness.restore()
    }
  })

  test('falls back from an unavailable owner index but not from unrelated validation failures', async () => {
    const missingIndex = new Error('The table does not have the specified index.')
    missingIndex.name = 'ValidationException'
    const fallbackHarness = createHarness([{}, missingIndex, { Items: [] }])

    try {
      await expect(fallbackHarness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        limit: 10,
      })).resolves.toMatchObject({ entries: [] })
      expect(fallbackHarness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'QueryCommand',
        'QueryCommand',
      ])
    } finally {
      fallbackHarness.restore()
    }

    const validationFailure = new Error('Invalid KeyConditionExpression.')
    validationFailure.name = 'ValidationException'
    const failingHarness = createHarness([{}, validationFailure])

    try {
      await expect(failingHarness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        limit: 10,
      })).rejects.toBe(validationFailure)
      expect(failingHarness.calls()).toBe(2)
    } finally {
      failingHarness.restore()
    }
  })

  test('fails closed when a queue row exists with an invalid entry payload', async () => {
    const harness = createHarness([
      {},
      { Items: [{ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' }] },
      { Item: { entryType: 'triage-entry', entry: {} } },
    ])

    try {
      await expect(
        harness.client.listEntries('workspace-1', 'support', { limit: 10 }),
      ).rejects.toMatchObject({ code: 'InvalidTriageEntry', status: 500 })
      expect(harness.calls()).toBe(3)
    } finally {
      harness.restore()
    }
  })

  test('fails closed when a queue row embeds an entry for another physical key', async () => {
    const entry = createEntry()
    entry.id = 'triage-other'
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const harness = createHarness([
      {},
      { Items: [{ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' }] },
      { Item: storedEntry },
    ])

    try {
      await expect(
        harness.client.listEntries('workspace-1', 'support', { limit: 10 }),
      ).rejects.toMatchObject({ code: 'InvalidTriageEntry', status: 500 })
      expect(harness.calls()).toBe(3)
    } finally {
      harness.restore()
    }
  })
})

describe('DynamoDbTriageClient source admission', () => {
  test('strongly reads configuration and reserves the rotation cursor as a transaction item', async () => {
    const entry = createEntry()
    entry.state = 'pending'
    entry.source = {
      kind: 'form',
      sourceId: 'submission-1',
      formId: 'form-1',
      submissionId: 'submission-1',
    }
    entry.ownerUserId = 'legacy-form-owner@example.com'
    entry.capabilities = createTriageCapabilities(entry)
    const harness = createHarness([{
      Item: {
        entryType: 'triage-configuration',
        revision: 4,
        configuration: {
          schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
          workspaceId: 'workspace-1',
          teamId: 'support',
          rules: [{
            id: 'form-support',
            name: 'Form support',
            enabled: true,
            order: 1,
            sourceKinds: ['form'],
            keywords: [],
            teamId: 'support',
            owner: { type: 'rotation', rotationId: 'support-rotation' },
          }],
          rotations: [{
            id: 'support-rotation',
            name: 'Support rotation',
            memberUserIds: ['one@example.com', 'two@example.com'],
            nextIndex: 0,
          }],
          slaPolicies: [],
          allowedBulkActions: ['assign', 'decline', 'snooze'],
          retentionDays: 30,
          revision: 4,
          updatedAt: '2026-08-08T00:00:00.000Z',
        },
      },
    }])

    try {
      const contribution = await harness.client.prepareEntryAdmission(entry)

      expect(contribution.entry.ownerUserId).toBe('one@example.com')
      expect(contribution.retryableConflictItemIndex).toBe(0)
      expect(contribution.transactItems).toEqual([expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'RequestIntakeTable',
          ConditionExpression:
            '#revision = :expectedRevision AND ' +
            '#configuration.#rotations[0].#nextIndex = :expectedNextIndex',
          ExpressionAttributeValues: {
            ':expectedRevision': 4,
            ':expectedNextIndex': 0,
          },
          Item: expect.objectContaining({
            entryType: 'triage-configuration',
            revision: 5,
            configuration: expect.objectContaining({
              revision: 5,
              rotations: [expect.objectContaining({ nextIndex: 1 })],
            }),
          }),
        }),
      })])
      expect(harness.commands[0]).toEqual(expect.objectContaining({
        name: 'GetCommand',
        input: expect.objectContaining({
          ConsistentRead: true,
          Key: {
            scopeKey: 'WORKSPACE#workspace-1',
            recordKey: 'TRIAGE_CONFIG#TEAM#support',
          },
        }),
      }))
    } finally {
      harness.restore()
    }
  })

  test('guards a fixed-owner configuration revision and validates the final references', async () => {
    const configuration: TriageConfiguration = {
      ...createManualRotationConfiguration(4, 0),
      rules: [{
        id: 'form-support',
        name: 'Form support',
        enabled: true,
        order: 1,
        sourceKinds: ['form'],
        keywords: [],
        teamId: 'support',
        projectId: 'configured-project',
        owner: { type: 'fixed', ownerUserId: 'fixed@example.com' },
      }],
      rotations: [],
      slaPolicies: [],
    }
    const validated: Array<{ entry: TriageEntry; configuration: TriageConfiguration }> = []
    const harness = createHarness([{
      Item: {
        entryType: 'triage-configuration',
        configuration,
        revision: configuration.revision,
      },
    }], {
      validateAdmission: async (entry, currentConfiguration) => {
        validated.push({ entry, configuration: currentConfiguration })
      },
    })
    const entry = createEntry()
    entry.state = 'pending'
    entry.source = {
      kind: 'form',
      sourceId: 'submission-fixed',
      formId: 'form-1',
      submissionId: 'submission-fixed',
    }
    entry.capabilities = createTriageCapabilities(entry)

    try {
      const contribution = await harness.client.prepareEntryAdmission(entry)

      expect(contribution.entry).toMatchObject({
        projectId: 'configured-project',
        ownerUserId: 'fixed@example.com',
      })
      expect(contribution.retryableConflictItemIndex).toBe(0)
      expect(contribution.transactItems).toEqual([{
        ConditionCheck: {
          TableName: 'RequestIntakeTable',
          Key: {
            scopeKey: 'WORKSPACE#workspace-1',
            recordKey: 'TRIAGE_CONFIG#TEAM#support',
          },
          ConditionExpression: '#configuration.#revision = :expectedRevision',
          ExpressionAttributeNames: {
            '#configuration': 'configuration',
            '#revision': 'revision',
          },
          ExpressionAttributeValues: { ':expectedRevision': 4 },
        },
      }])
      expect(validated).toHaveLength(1)
      expect(validated[0]).toMatchObject({
        entry: { ownerUserId: 'fixed@example.com' },
        configuration: { revision: 4 },
      })
    } finally {
      harness.restore()
    }
  })

  test('guards an unpersisted revision-zero default with row non-existence', async () => {
    const harness = createHarness([{}])
    const entry = createEntry()
    entry.state = 'pending'
    entry.source = {
      kind: 'form',
      sourceId: 'submission-default',
      formId: 'form-1',
      submissionId: 'submission-default',
    }
    entry.capabilities = createTriageCapabilities(entry)

    try {
      const contribution = await harness.client.prepareEntryAdmission(entry)

      expect(contribution.retryableConflictItemIndex).toBe(0)
      expect(contribution.transactItems).toEqual([{
        ConditionCheck: {
          TableName: 'RequestIntakeTable',
          Key: {
            scopeKey: 'WORKSPACE#workspace-1',
            recordKey: 'TRIAGE_CONFIG#TEAM#support',
          },
          ConditionExpression:
            'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      }])
    } finally {
      harness.restore()
    }
  })

  test('re-evaluates a manual handoff after a rotation race and commits the current policy', async () => {
    const rotationRace = Object.assign(new Error('rotation cursor changed'), {
      name: 'TransactionCanceledException',
      CancellationReasons: Array.from({ length: 5 }, (_value, index) => ({
        Code: index === 4 ? 'ConditionalCheckFailed' : 'None',
      })),
    })
    const harness = createHarness([
      {},
      {
        Item: {
          entryType: 'triage-configuration',
          configuration: createManualRotationConfiguration(4, 0),
          revision: 4,
        },
      },
      rotationRace,
      {
        Item: {
          entryType: 'triage-configuration',
          configuration: createManualRotationConfiguration(5, 1),
          revision: 5,
        },
      },
      {},
    ])

    try {
      const fingerprint = createTriageInputFingerprint({ sourceId: 'handoff-1' })
      const receipt = await harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'handoff-1',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          projectId: 'configured-project',
          routingReason: 'Stale caller-derived routing.',
          ownerUserId: 'stale-owner@example.com',
          slaPolicyId: 'stale-sla',
          slaDueAt: '2026-08-09T00:10:00.000Z',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        },
        { key: 'manual-1', fingerprint },
      )

      expect(receipt).toMatchObject({
        replayed: false,
        entry: {
          id: 'triage-manual-1',
          projectId: 'configured-project',
          ownerUserId: 'two@example.com',
          routing: { candidates: [{ ruleId: 'manual-support' }] },
          sla: {
            policyId: 'manual-sla',
            dueAt: '2026-08-09T01:00:00.000Z',
            escalationDueAt: '2026-08-09T01:30:00.000Z',
          },
          retention: { expiresAt: '2026-09-08T00:00:00.000Z' },
        },
      })
      expect(harness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
        'TransactWriteCommand',
      ])
      for (const commandIndex of [1, 3]) {
        expect(harness.commands[commandIndex]?.input).toMatchObject({
          ConsistentRead: true,
          Key: {
            scopeKey: 'WORKSPACE#workspace-1',
            recordKey: 'TRIAGE_CONFIG#TEAM#support',
          },
        })
      }
      const firstItems = harness.commands[2]?.input.TransactItems
      const committedItems = harness.commands[4]?.input.TransactItems
      expect(findTransactionPutItem(firstItems, 'triage-entry')).toMatchObject({
        entry: { ownerUserId: 'one@example.com' },
      })
      expect(findTransactionPutItem(firstItems, 'triage-configuration')).toMatchObject({
        revision: 5,
        configuration: { rotations: [{ nextIndex: 1 }] },
      })
      expect(findTransactionPutItem(committedItems, 'triage-entry')).toMatchObject({
        entry: { ownerUserId: 'two@example.com' },
      })
      expect(findTransactionPutItem(committedItems, 'triage-configuration')).toMatchObject({
        revision: 6,
        configuration: { rotations: [{ nextIndex: 0 }] },
      })
    } finally {
      harness.restore()
    }
  })

  test('replays an existing manual source after a response is lost', async () => {
    const fingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input: {
        sourceId: 'manual-response-loss-1',
        title: 'Manual support request',
        body: 'Please investigate this request.',
        requesterDisplayName: 'Internal operator',
      },
    })
    const entry = createEntry()
    entry.id = 'triage-manual-1'
    entry.source = { kind: 'manual-handoff', sourceId: 'manual-response-loss-1' }
    entry.state = 'pending'
    entry.revision = 1
    entry.capabilities = createTriageCapabilities(entry)
    delete entry.canonicalWorkItem
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: fingerprint,
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored manual entry fixture.')
    const harness = createHarness([
      {
        Item: {
          entryType: 'triage-source-claim',
          workspaceId: 'workspace-1',
          entryId: entry.id,
          inputFingerprint: fingerprint,
        },
      },
      { Item: storedEntry },
    ])

    try {
      const receipt = await harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'manual-response-loss-1',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          routingReason: 'A deadline changed after the original commit.',
          slaPolicyId: 'manual-sla',
          slaDueAt: '2026-08-09T01:00:01.000Z',
          retentionExpiresAt: '2026-09-08T00:00:01.000Z',
        },
        { key: 'manual-response-loss', fingerprint },
      )

      expect(receipt).toMatchObject({
        replayed: true,
        entry: { id: 'triage-manual-1' },
      })
      expect(harness.commands.map(({ name }) => name)).toEqual(['GetCommand', 'GetCommand'])
    } finally {
      harness.restore()
    }
  })
})
