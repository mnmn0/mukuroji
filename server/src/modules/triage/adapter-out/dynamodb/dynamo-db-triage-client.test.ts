import { createCipheriv, createHash } from 'node:crypto'
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
import { createMutationAuditContext } from '../../../audit'
import { createTriageCapabilities, TriageError } from '../../domain/triage-entry'
import {
  createTriageActionAuditIdempotencyKey,
  createTriageInputFingerprint,
  type TriageIdempotency,
} from '../../triage'
import {
  createTriageEntryTransactionItems,
} from './triage-transactions'
import {
  DynamoDbTriageClient,
  type TriageConfigurationReferenceValidator,
  type TriageAdmissionValidator,
} from './dynamo-db-triage-client'

/** Stable client adapter test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a semantic test context for one target-specific Triage action.
 *
 * @param entryId Target Entry selected by the client.
 * @param idempotency Target receipt identity selected by the client.
 * @returns Immutable non-fabricated test source context.
 */
function createTestAuditContext(entryId: string, idempotency: TriageIdempotency) {
  return createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'member@example.com', kind: 'user' },
    idempotencyKey: createTriageActionAuditIdempotencyKey(entryId, idempotency),
    occurredAt: NOW,
    request: {
      method: 'TEST',
      path: 'triage-client-test/apply-action',
    },
    source: {
      kind: 'system',
      route: 'triage-client-test',
    },
  })
}

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
  /** Commit-time settings reference guards. */
  validateConfigurationReferences?: TriageConfigurationReferenceValidator
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
      ...(options.validateConfigurationReferences
        ? { validateConfigurationReferences: options.validateConfigurationReferences }
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

/** Returns the configuration snapshot carried by a settings or admission transaction. */
function findTransactionConfiguration(
  transactionItems: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(transactionItems)) return undefined
  for (const transactionItem of transactionItems) {
    if (!transactionItem || typeof transactionItem !== 'object') continue
    const put = Reflect.get(transactionItem, 'Put')
    if (put && typeof put === 'object') {
      const item = Reflect.get(put, 'Item')
      if (item && typeof item === 'object' && Reflect.get(item, 'entryType') === 'triage-configuration') {
        return Object.fromEntries(Object.entries(item))
      }
    }
    const update = Reflect.get(transactionItem, 'Update')
    if (update && typeof update === 'object') {
      const values = Reflect.get(update, 'ExpressionAttributeValues')
      if (values && typeof values === 'object') {
        const configuration = Reflect.get(values, ':configuration')
        if (configuration && typeof configuration === 'object') {
          return {
            configuration,
            revision: Reflect.get(values, ':revision'),
          }
        }
        if (Reflect.get(values, ':nextRotationCursors') !== undefined) {
          return { revision: Reflect.get(values, ':expectedRevision') }
        }
      }
    }
  }
  return undefined
}

/** Input used to reproduce an encrypted queue cursor issued by an earlier client instance. */
type PreviouslyIssuedQueueCursorInput = {
  /** Workspace bound into the cursor scope. */
  workspaceId: string
  /** Team bound into the cursor scope. */
  teamId: string
  /** Owner filter bound into the cursor scope. */
  ownerUserId: string
  /** Queue index selected for the original pagination chain. */
  indexKind: 'team' | 'owner'
  /** DynamoDB continuation key stored by the original cursor. */
  key: Record<string, unknown>
}

/** Reproduces the encrypted queue cursor format for compatibility tests.
 *
 * @param input Scope, index, and DynamoDB key issued by an earlier client version.
 * @returns An opaque cursor signed with the test harness secret.
 */
function createPreviouslyIssuedQueueCursor(input: PreviouslyIssuedQueueCursorInput): string {
  const scope = createTriageInputFingerprint({
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    indexKind: input.indexKind,
    state: undefined,
    sourceKind: undefined,
    ownerUserId: input.ownerUserId,
  })
  const index = input.indexKind === 'owner'
    ? 'triage-owner-activity-index'
    : 'triage-team-activity-index'
  const plaintext = Buffer.from(JSON.stringify({ scope, index, key: input.key }), 'utf8')
  const key = createHash('sha256').update('test-cursor-secret').digest()
  const iv = createHash('sha256').update(plaintext).digest().subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
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
      const receipt = await harness.client.getActionReceipt('workspace-1', 'support', 'triage-1', {
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
      await expect(harness.client.getActionReceipt('workspace-1', 'support', 'triage-1', {
        key: 'accept-1',
        fingerprint: createTriageInputFingerprint({ action: 'decline' }),
      })).rejects.toMatchObject({ code: 'TriageIdempotencyConflict', status: 409 })
      expect(harness.calls()).toBe(1)
    } finally {
      harness.restore()
    }
  })

  test('does not replay an action receipt through a different Team route', async () => {
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
          entryId: entry.id,
          inputFingerprint: fingerprint,
          resultRevision: entry.revision,
        },
      },
      { Item: storedEntry },
    ])

    try {
      await expect(harness.client.getActionReceipt('workspace-1', 'other-team', entry.id, {
        key: 'accept-1',
        fingerprint,
      })).resolves.toBeUndefined()
      expect(harness.calls()).toBe(2)
    } finally {
      harness.restore()
    }
  })
})

describe('DynamoDbTriageClient transaction failure classification', () => {
  test('fences bulk target actions against the preflighted configuration revision', async () => {
    const entry = createEntry()
    entry.state = 'pending'
    entry.revision = 1
    entry.capabilities = createTriageCapabilities(entry)
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored entry fixture.')
    const harness = createHarness([{}, { Item: storedEntry }, {}])

    try {
      const idempotency = {
        key: 'bulk-target-1',
        fingerprint: createTriageInputFingerprint({ action: 'decline', entryId: entry.id }),
      }
      await harness.client.applyAction(
        'workspace-1',
        'support',
        entry.id,
        { id: 'member@example.com' },
        { action: 'decline', expectedRevision: 1, reason: 'Handled elsewhere.' },
        idempotency,
        createTestAuditContext(entry.id, idempotency),
        4,
      )

      const transactionInput = harness.commands[2]?.input
      if (!transactionInput || !Array.isArray(transactionInput.TransactItems)) {
        throw new TypeError('Expected a captured triage transaction.')
      }
      expect(transactionInput.TransactItems[0]).toMatchObject({
        ConditionCheck: {
          ConditionExpression:
            '(attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)) OR ' +
            '#configuration.#revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': 4 },
        },
      })
    } finally {
      harness.restore()
    }
  })

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
          Update: expect.objectContaining({
            UpdateExpression: expect.stringContaining('#configuration = :configuration'),
            ConditionExpression:
              'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            ExpressionAttributeValues: expect.objectContaining({
              ':configuration': next,
              ':rotationCursors': {},
            }),
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

  test('joins caller and live settings reference guards to the configuration transaction', async () => {
    const input = createConfigurationInput(0)
    const fingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input,
    })
    const referenceGuard = {
      ConditionCheck: {
        TableName: 'DirectoryTable',
        Key: { directoryId: 'workspace-1', entryKey: 'team#support' },
        ConditionExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active' },
      },
    }
    const authorizationGuard = {
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#manager@example.com' },
        ConditionExpression: '#role = :manager',
      },
    }
    const harness = createHarness([{}, {}, {}], {
      validateConfigurationReferences: (async () => ({
        transactItems: [referenceGuard],
      })) satisfies TriageConfigurationReferenceValidator,
    })

    try {
      await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        { key: 'settings-guarded', fingerprint },
        [authorizationGuard],
      )
      const transactItems = harness.commands[2]?.input.TransactItems
      expect(Array.isArray(transactItems) ? transactItems.slice(0, 2) : undefined).toEqual([
        authorizationGuard,
        referenceGuard,
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
          Update: expect.objectContaining({
            UpdateExpression: expect.not.stringContaining('#rotationCursors = :rotationCursors'),
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: expect.objectContaining({
              ':configuration': next,
              ':revision': 8,
              ':expectedRevision': 7,
            }),
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

  test('fences rotation cursor changes while replacing rotation settings', async () => {
    const current = createManualRotationConfiguration(4, 1)
    const input = createConfigurationInput(4)
    input.rotations = [{
      ...current.rotations[0]!,
      name: 'Renamed support rotation',
      nextIndex: 0,
    }]
    const fingerprint = createTriageInputFingerprint({
      workspaceId: 'workspace-1',
      teamId: 'support',
      input,
    })
    const harness = createHarness([
      {},
      {
        Item: {
          entryType: 'triage-configuration',
          configuration: current,
          revision: current.revision,
          rotationCursors: { 'support-rotation': 1 },
        },
      },
      {},
    ])

    try {
      await harness.client.updateConfiguration(
        'workspace-1',
        'support',
        { id: 'manager@example.com' },
        input,
        { key: 'settings-rotation-change', fingerprint },
      )

      expect(harness.commands[2]?.input.TransactItems).toEqual([
        expect.objectContaining({
          Update: expect.objectContaining({
            ConditionExpression:
              'revision = :expectedRevision AND ' +
              '(attribute_not_exists(#rotationCursors) OR ' +
              '#rotationCursors = :expectedRotationCursors)',
            ExpressionAttributeNames: expect.objectContaining({
              '#rotationCursors': 'rotationCursors',
            }),
            ExpressionAttributeValues: expect.objectContaining({
              ':expectedRevision': 4,
              ':expectedRotationCursors': { 'support-rotation': 1 },
              ':rotationCursors': { 'support-rotation': 0 },
            }),
          }),
        }),
        expect.anything(),
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

  test('rejects duplicate rotation and SLA policy IDs before settings persistence', async () => {
    const duplicateRotationInput: UpdateTriageConfigurationInput = {
      ...createConfigurationInput(0),
      rotations: [{
        id: 'rotation-1',
        name: 'Primary',
        memberUserIds: ['one@example.com'],
        nextIndex: 0,
      }, {
        id: 'rotation-1',
        name: 'Secondary',
        memberUserIds: ['two@example.com'],
        nextIndex: 0,
      }],
    }
    const duplicateSlaInput: UpdateTriageConfigurationInput = {
      ...createConfigurationInput(0),
      slaPolicies: [{
        id: 'sla-1',
        name: 'Form response',
        sourceKinds: ['form'],
        responseMinutes: 60,
      }, {
        id: 'sla-1',
        name: 'Email response',
        sourceKinds: ['email'],
        responseMinutes: 30,
      }],
    }
    const duplicateMemberInput: UpdateTriageConfigurationInput = {
      ...createConfigurationInput(0),
      rotations: [{
        id: 'rotation-members',
        name: 'Members',
        memberUserIds: ['One@example.com', 'one@example.com'],
        nextIndex: 0,
      }],
    }
    const harness = createHarness([])

    try {
      for (const [key, input] of [
        ['duplicate-rotation', duplicateRotationInput],
        ['duplicate-sla', duplicateSlaInput],
        ['duplicate-member', duplicateMemberInput],
      ] as const) {
        await expect(harness.client.updateConfiguration(
          'workspace-1',
          'support',
          { id: 'manager@example.com' },
          input,
          {
            key,
            fingerprint: createTriageInputFingerprint({ input }),
          },
        )).rejects.toMatchObject({ code: 'InvalidTriageConfiguration', status: 400 })
      }
      expect(harness.calls()).toBe(0)
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
    const duplicateRotations = createConfigurationSnapshot(4)
    duplicateRotations.rotations = [{
      id: 'rotation-1',
      name: 'Primary',
      memberUserIds: ['one@example.com'],
      nextIndex: 0,
    }, {
      id: 'rotation-1',
      name: 'Secondary',
      memberUserIds: ['two@example.com'],
      nextIndex: 0,
    }]
    const duplicateSlaPolicies = createConfigurationSnapshot(4)
    duplicateSlaPolicies.slaPolicies = [{
      id: 'sla-1',
      name: 'Form response',
      sourceKinds: ['form'],
      responseMinutes: 60,
    }, {
      id: 'sla-1',
      name: 'Email response',
      sourceKinds: ['email'],
      responseMinutes: 30,
    }]

    for (const configuration of [
      malformed,
      crossScope,
      duplicateRotations,
      duplicateSlaPolicies,
    ]) {
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
        createTestAuditContext,
      )).rejects.toMatchObject({ code: 'TriageBulkActionDisabled', status: 409 })
      expect(harness.calls()).toBe(1)
    } finally {
      harness.restore()
    }
  })

  test('re-reads an ambiguous bulk target receipt before returning a failed result', async () => {
    const entry = createEntry()
    entry.state = 'pending'
    entry.revision = 1
    entry.capabilities = createTriageCapabilities(entry)
    const storedEntry = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedEntry) throw new TypeError('Expected a stored triage entry fixture.')
    const responseLoss = new Error('The transaction response was lost.')
    const configuration = createConfigurationSnapshot(4)
    const harness = createHarness([
      { Item: { entryType: 'triage-configuration', configuration, revision: configuration.revision } },
      {},
      { Item: storedEntry },
      responseLoss,
      {},
    ])

    try {
      await expect(harness.client.applyBulkAction(
        'workspace-1',
        'support',
        { id: 'member@example.com' },
        {
          targets: [{ entryId: entry.id, expectedRevision: entry.revision }],
          operation: { action: 'decline', reason: 'No longer actionable.' },
        },
        'bulk-response-loss',
        createTestAuditContext,
      )).rejects.toMatchObject({
        code: 'TriageBulkActionResultUnavailable',
        status: 503,
      })
      expect(harness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('preflights every bulk audit context before reading or mutating a target', async () => {
    const configuration = createConfigurationSnapshot(4)
    const harness = createHarness([{
      Item: {
        entryType: 'triage-configuration',
        configuration,
        revision: configuration.revision,
      },
    }])
    let auditContextCount = 0

    /** Creates one valid context before rejecting the second target context. */
    function createPartiallyInvalidAuditContext(
      entryId: string,
      idempotency: TriageIdempotency,
    ) {
      auditContextCount += 1
      if (auditContextCount === 2) {
        throw new TriageError(
          400,
          'InvalidTriageInput',
          'The bulk audit context is invalid.',
        )
      }
      return createTestAuditContext(entryId, idempotency)
    }

    try {
      await expect(harness.client.applyBulkAction(
        'workspace-1',
        'support',
        { id: 'member@example.com' },
        {
          targets: [
            { entryId: 'triage-1', expectedRevision: 1 },
            { entryId: 'triage-2', expectedRevision: 1 },
          ],
          operation: { action: 'assign', ownerUserId: null },
        },
        'bulk-audit-preflight',
        createPartiallyInvalidAuditContext,
      )).rejects.toMatchObject({ code: 'InvalidTriageInput', status: 400 })
      expect(auditContextCount).toBe(2)
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

  test('applies search and SLA filters before returning each paginated queue page', async () => {
    const matchingEntry = createEntry()
    matchingEntry.id = 'triage-search-match'
    matchingEntry.source.sourceId = 'message-search-match'
    matchingEntry.sourcePreview.title = 'Billing escalation'
    matchingEntry.state = 'pending'
    matchingEntry.sla = {
      policyId: 'support-sla',
      dueAt: '2026-08-09T01:00:00.000Z',
    }
    const nonMatchingEntry = createEntry()
    nonMatchingEntry.id = 'triage-search-other'
    nonMatchingEntry.source.sourceId = 'message-search-other'
    nonMatchingEntry.sourcePreview.title = 'General question'
    nonMatchingEntry.state = 'pending'
    nonMatchingEntry.sla = {
      policyId: 'support-sla',
      dueAt: '2026-08-09T12:00:00.000Z',
    }
    const matchingRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: matchingEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: matchingEntry.source.sourceId }),
    })[0]?.Put?.Item
    const nonMatchingRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: nonMatchingEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: nonMatchingEntry.source.sourceId }),
    })[0]?.Put?.Item
    if (!matchingRow || !nonMatchingRow) throw new TypeError('Expected stored entry fixtures.')
    const harness = createHarness([
      {},
      {
        Items: [
          { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-search-other' },
          { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-search-match' },
        ],
      },
      { Item: nonMatchingRow },
      { Item: matchingRow },
    ])

    try {
      const page = await harness.client.listEntries('workspace-1', 'support', {
        limit: 10,
        query: 'billing',
        sla: 'due-soon',
      })

      expect(page.entries.map(({ id }) => id)).toEqual(['triage-search-match'])
    } finally {
      harness.restore()
    }
  })

  test('scopes routing metadata search to the caller-visible Project set', async () => {
    const entry = createEntry()
    entry.permission = {
      visibility: 'full',
      canReply: true,
      guestVisible: false,
      checkedAt: NOW,
    }
    entry.routing = {
      reason: 'Visible route.',
      candidates: [
        { teamId: 'support', projectId: 'hidden-project', reason: 'Confidential route.', permitted: true },
        { teamId: 'support', projectId: 'visible-project', reason: 'Visible route.', permitted: true },
      ],
    }
    entry.capabilities = createTriageCapabilities(entry)
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
      const page = await harness.client.listEntries('workspace-1', 'support', {
        limit: 10,
        query: 'confidential',
        visibleProjectIds: ['visible-project'],
      })

      expect(page.entries).toEqual([])
    } finally {
      harness.restore()
    }
  })

  test('fills a restricted Project queue page before returning visible entries', async () => {
    const hiddenEntry = createEntry()
    hiddenEntry.id = 'triage-hidden-project'
    hiddenEntry.source.sourceId = 'message-hidden-project'
    hiddenEntry.projectId = 'hidden-project'
    const visibleEntry = createEntry()
    visibleEntry.id = 'triage-visible-project'
    visibleEntry.source.sourceId = 'message-visible-project'
    visibleEntry.projectId = 'visible-project'
    const hiddenRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: hiddenEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: hiddenEntry.source.sourceId }),
    })[0]?.Put?.Item
    const visibleRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: visibleEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: visibleEntry.source.sourceId }),
    })[0]?.Put?.Item
    if (!hiddenRow || !visibleRow) throw new TypeError('Expected stored Project-scoped entries.')
    const harness = createHarness([
      {},
      {
        Items: [
          { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-hidden-project' },
          { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-visible-project' },
        ],
      },
      { Item: hiddenRow },
      { Item: visibleRow },
    ])

    try {
      const page = await harness.client.listEntries('workspace-1', 'support', {
        limit: 1,
        visibleProjectIds: ['visible-project'],
      })

      expect(page.entries.map(({ id }) => id)).toEqual(['triage-visible-project'])
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

  test('accepts existing queue cursors and rejects cursor scope changes before reading DynamoDB', async () => {
    const continuationKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE#triage-1',
      triageTeamKey: 'WORKSPACE#workspace-1#TEAM#support',
      triageActivitySort: `${NOW}#triage-1`,
    }
    const cursor = createPreviouslyIssuedQueueCursor({
      workspaceId: 'workspace-1',
      teamId: 'support',
      ownerUserId: 'owner@example.com',
      indexKind: 'team',
      key: continuationKey,
    })
    const harness = createHarness([{}, { Items: [] }])

    try {
      await expect(harness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        cursor,
        limit: 10,
      })).resolves.toMatchObject({ entries: [] })
      expect(harness.commands[1]).toEqual(expect.objectContaining({
        name: 'QueryCommand',
        input: expect.objectContaining({
          IndexName: 'triage-team-activity-index',
          ExclusiveStartKey: continuationKey,
        }),
      }))

      await expect(harness.client.listEntries('workspace-1', 'billing', {
        ownerUserId: 'owner@example.com',
        cursor,
      })).rejects.toMatchObject({ code: 'InvalidTriageCursor', status: 400 })
      await expect(harness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'another-owner@example.com',
        cursor,
      })).rejects.toMatchObject({ code: 'InvalidTriageCursor', status: 400 })

      const cursorParts = cursor.split('.')
      if (cursorParts.length !== 4) throw new TypeError('Expected an encrypted cursor fixture.')
      const tamperedPayload = Buffer.from(JSON.stringify({
        scope: 'tampered-scope',
        index: 'triage-team-activity-index',
        key: continuationKey,
      })).toString('base64url')
      await expect(harness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        cursor: `${cursorParts[0]}.${cursorParts[1]}.${tamperedPayload}.${cursorParts[3]}`,
      })).rejects.toMatchObject({ code: 'InvalidTriageCursor', status: 400 })
      expect(harness.calls()).toBe(2)
    } finally {
      harness.restore()
    }
  })

  test('continues a filtered Team fallback cursor across instances when the owner GSI becomes active', async () => {
    const otherOwnerEntry = createEntry()
    otherOwnerEntry.id = 'triage-other-owner'
    otherOwnerEntry.source.sourceId = 'message-other-owner'
    otherOwnerEntry.ownerUserId = 'another-owner@example.com'
    const matchingEntry = createEntry()
    matchingEntry.id = 'triage-matching-owner'
    matchingEntry.source.sourceId = 'message-matching-owner'
    matchingEntry.ownerUserId = 'Owner@Example.com'
    const otherOwnerRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: otherOwnerEntry,
      inputFingerprint: createTriageInputFingerprint({
        sourceId: otherOwnerEntry.source.sourceId,
      }),
    })[0]?.Put?.Item
    const matchingRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: matchingEntry,
      inputFingerprint: createTriageInputFingerprint({
        sourceId: matchingEntry.source.sourceId,
      }),
    })[0]?.Put?.Item
    if (!otherOwnerRow || !matchingRow) throw new TypeError('Expected stored entry fixtures.')
    const firstPageKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE#triage-other-owner',
      triageTeamKey: 'WORKSPACE#workspace-1#TEAM#support',
      triageActivitySort: `${NOW}#triage-other-owner`,
    }
    const secondPageKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE#triage-matching-owner',
      triageTeamKey: 'WORKSPACE#workspace-1#TEAM#support',
      triageActivitySort: `${NOW}#triage-matching-owner`,
    }
    const missingIndex = new Error('The table does not have the specified index.')
    missingIndex.name = 'ValidationException'
    const rolloutHarness = createHarness([
      {},
      missingIndex,
      {
        Items: [{
          scopeKey: 'WORKSPACE#workspace-1',
          recordKey: 'TRIAGE#triage-other-owner',
        }],
        LastEvaluatedKey: firstPageKey,
      },
      { Item: otherOwnerRow },
      {
        Items: [{
          scopeKey: 'WORKSPACE#workspace-1',
          recordKey: 'TRIAGE#triage-matching-owner',
        }],
        LastEvaluatedKey: secondPageKey,
      },
      { Item: matchingRow },
    ])

    let cursor: string
    try {
      const page = await rolloutHarness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        limit: 1,
      })
      expect(page.entries.map(({ id }) => id)).toEqual(['triage-matching-owner'])
      if (!page.nextCursor) throw new TypeError('Expected a Team fallback cursor.')
      cursor = page.nextCursor
      expect(rolloutHarness.commands.filter(({ name }) => name === 'QueryCommand').map(
        ({ input }) => input.IndexName,
      )).toEqual([
        'triage-owner-activity-index',
        'triage-team-activity-index',
        'triage-team-activity-index',
      ])
      expect(rolloutHarness.commands[4]?.input).toEqual(expect.objectContaining({
        ExclusiveStartKey: firstPageKey,
      }))
    } finally {
      rolloutHarness.restore()
    }

    const nextInstanceHarness = createHarness([{}, { Items: [] }, {}, { Items: [] }])
    try {
      await expect(nextInstanceHarness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        cursor,
        limit: 1,
      })).resolves.toMatchObject({ entries: [] })
      await expect(nextInstanceHarness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        limit: 1,
      })).resolves.toMatchObject({ entries: [] })
      const queries = nextInstanceHarness.commands.filter(({ name }) => name === 'QueryCommand')
      expect(queries).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            IndexName: 'triage-team-activity-index',
            ExclusiveStartKey: secondPageKey,
          }),
        }),
        expect.objectContaining({
          input: expect.objectContaining({ IndexName: 'triage-owner-activity-index' }),
        }),
      ])
    } finally {
      nextInstanceHarness.restore()
    }
  })

  test('lets an owner cursor override a stale unavailable-index observation', async () => {
    const ownerContinuationKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE#triage-owner-page',
      triageOwnerKey: 'WORKSPACE#workspace-1#TEAM#support#OWNER#owner@example.com',
      triageActivitySort: `${NOW}#triage-owner-page`,
    }
    const cursor = createPreviouslyIssuedQueueCursor({
      workspaceId: 'workspace-1',
      teamId: 'support',
      ownerUserId: 'owner@example.com',
      indexKind: 'owner',
      key: ownerContinuationKey,
    })
    const missingIndex = new Error('The table does not have the specified index.')
    missingIndex.name = 'ValidationException'
    const harness = createHarness([{}, missingIndex, { Items: [] }, {}, { Items: [] }])

    try {
      await harness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
      })
      await expect(harness.client.listEntries('workspace-1', 'support', {
        ownerUserId: 'owner@example.com',
        cursor,
      })).resolves.toMatchObject({ entries: [] })
      const queries = harness.commands.filter(({ name }) => name === 'QueryCommand')
      expect(queries.map(({ input }) => input.IndexName)).toEqual([
        'triage-owner-activity-index',
        'triage-team-activity-index',
        'triage-owner-activity-index',
      ])
      expect(queries[2]?.input).toEqual(expect.objectContaining({
        ExclusiveStartKey: ownerContinuationKey,
      }))
    } finally {
      harness.restore()
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
      expect(contribution.retryableConflictItemIndexes).toEqual([0])
      expect(contribution.transactItems).toEqual([expect.objectContaining({
        Update: expect.objectContaining({
          TableName: 'RequestIntakeTable',
          ConditionExpression:
            '#revision = :expectedRevision AND ' +
            '(attribute_not_exists(#rotationCursors) OR ' +
            '#rotationCursors = :expectedRotationCursors)',
          ExpressionAttributeValues: {
            ':expectedRevision': 4,
            ':expectedRotationCursors': { 'support-rotation': 0 },
            ':nextRotationCursors': { 'support-rotation': 1 },
          },
          UpdateExpression: 'SET #rotationCursors = :nextRotationCursors',
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
        return {
          transactItems: [{
            ConditionCheck: {
              TableName: 'WorkspaceAccessTable',
              Key: {
                workspaceId: entry.workspaceId,
                recordKey: `MEMBER#${entry.ownerUserId}`,
              },
              ConditionExpression: '#status = :active AND #version = :version',
            },
          }],
        }
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
      expect(contribution.retryableConflictItemIndexes).toEqual([0, 1])
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
      }, {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'workspace-1',
            recordKey: 'MEMBER#fixed@example.com',
          },
          ConditionExpression: '#status = :active AND #version = :version',
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

      expect(contribution.retryableConflictItemIndexes).toEqual([0])
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
      CancellationReasons: Array.from({ length: 6 }, (_value, index) => ({
        Code: index === 5 ? 'ConditionalCheckFailed' : 'None',
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
      expect(findTransactionConfiguration(firstItems)).toMatchObject({
        revision: 4,
      })
      expect(findTransactionPutItem(committedItems, 'triage-entry')).toMatchObject({
        entry: { ownerUserId: 'two@example.com' },
      })
      expect(findTransactionConfiguration(committedItems)).toMatchObject({
        revision: 5,
      })
    } finally {
      harness.restore()
    }
  })

  test('rejects a manual handoff prepared against an older configuration revision', async () => {
    const harness = createHarness([
      {},
      {
        Item: {
          entryType: 'triage-configuration',
          configuration: createConfigurationSnapshot(5),
          revision: 5,
        },
      },
    ])

    try {
      await expect(harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'handoff-stale-configuration',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          projectId: 'stale-project',
          routingReason: 'Matched a rule that was removed.',
          ownerUserId: 'stale-owner@example.com',
          preparedConfigurationRevision: 4,
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        },
        {
          key: 'manual-stale-configuration',
          fingerprint: createTriageInputFingerprint({ sourceId: 'handoff-stale-configuration' }),
        },
      )).rejects.toMatchObject({
        code: 'TriageConfigurationConflict',
        status: 409,
      })
      expect(harness.commands.map(({ name }) => name)).toEqual(['GetCommand', 'GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('rejects a manual handoff when its Project is archived before commit', async () => {
    let validationAttempts = 0
    const projectArchiveRace = Object.assign(new Error('Project archived'), {
      name: 'TransactionCanceledException',
      CancellationReasons: Array.from({ length: 8 }, (_value, index) => ({
        Code: index === 7 ? 'ConditionalCheckFailed' : 'None',
      })),
    })
    const configuration = createManualRotationConfiguration(4, 0)
    const harness = createHarness([
      {},
      { Item: { entryType: 'triage-configuration', configuration, revision: 4 } },
      projectArchiveRace,
      { Item: { entryType: 'triage-configuration', configuration, revision: 4 } },
    ], {
      validateAdmission: async () => {
        validationAttempts += 1
        if (validationAttempts > 1) {
          throw new TriageError(
            409,
            'TriageAdmissionProjectUnavailable',
            'The configured Triage Project is not active in the target Team.',
          )
        }
        return {
          transactItems: [{
            ConditionCheck: {
              TableName: 'ProjectDirectoryTable',
              Key: { directoryId: 'workspace-1', entryKey: 'TEAM#support' },
              ConditionExpression: '#entryType = :team AND attribute_not_exists(#archivedAt)',
            },
          }, {
            ConditionCheck: {
              TableName: 'ProjectDirectoryTable',
              Key: { directoryId: 'workspace-1', entryKey: 'PROJECT#configured-project' },
              ConditionExpression: '#entryType = :project AND attribute_not_exists(#archivedAt)',
            },
          }],
        }
      },
    })

    try {
      await expect(harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'handoff-project-race',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          projectId: 'configured-project',
          routingReason: 'Manual handoff.',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        },
        {
          key: 'manual-project-race',
          fingerprint: createTriageInputFingerprint({ sourceId: 'handoff-project-race' }),
        },
      )).rejects.toMatchObject({
        code: 'TriageAdmissionProjectUnavailable',
        status: 409,
      })
      expect(validationAttempts).toBe(2)
      expect(harness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
      expect(harness.commands[2]?.input.TransactItems).toHaveLength(8)
    } finally {
      harness.restore()
    }
  })

  test('rejects a manual handoff when its owner is deactivated before commit', async () => {
    let validationAttempts = 0
    const memberDeactivationRace = Object.assign(new Error('Member deactivated'), {
      name: 'TransactionCanceledException',
      CancellationReasons: Array.from({ length: 8 }, (_value, index) => ({
        Code: index === 7 ? 'ConditionalCheckFailed' : 'None',
      })),
    })
    const configuration = createManualRotationConfiguration(4, 0)
    const harness = createHarness([
      {},
      { Item: { entryType: 'triage-configuration', configuration, revision: 4 } },
      memberDeactivationRace,
      { Item: { entryType: 'triage-configuration', configuration, revision: 4 } },
    ], {
      validateAdmission: async () => {
        validationAttempts += 1
        if (validationAttempts > 1) {
          throw new TriageError(
            409,
            'TriageAdmissionOwnerUnavailable',
            'A configured Triage owner is not an active Workspace member.',
          )
        }
        return {
          transactItems: [{
            ConditionCheck: {
              TableName: 'ProjectDirectoryTable',
              Key: { directoryId: 'workspace-1', entryKey: 'TEAM#support' },
              ConditionExpression: '#entryType = :team AND attribute_not_exists(#archivedAt)',
            },
          }, {
            ConditionCheck: {
              TableName: 'WorkspaceAccessTable',
              Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#one@example.com' },
              ConditionExpression: '#status = :active AND #version = :version',
            },
          }],
        }
      },
    })

    try {
      await expect(harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'handoff-member-race',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          projectId: 'configured-project',
          routingReason: 'Manual handoff.',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        },
        {
          key: 'manual-member-race',
          fingerprint: createTriageInputFingerprint({ sourceId: 'handoff-member-race' }),
        },
      )).rejects.toMatchObject({
        code: 'TriageAdmissionOwnerUnavailable',
        status: 409,
      })
      expect(validationAttempts).toBe(2)
      expect(harness.commands.map(({ name }) => name)).toEqual([
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
      expect(harness.commands[2]?.input.TransactItems).toHaveLength(8)
    } finally {
      harness.restore()
    }
  })

  test('joins caller authorization guards to the manual handoff transaction', async () => {
    const fingerprint = createTriageInputFingerprint({ sourceId: 'manual-auth-1' })
    const authorizationGuard = {
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#operator@example.com' },
        ConditionExpression: '#status = :active',
      },
    }
    const harness = createHarness([{}, {}, {}])

    try {
      await harness.client.createManualHandoff(
        'workspace-1',
        'support',
        { id: 'operator@example.com' },
        {
          sourceId: 'manual-auth-1',
          title: 'Manual support request',
          body: 'Please investigate this request.',
          requesterDisplayName: 'Internal operator',
          routingReason: 'Operator handoff.',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        },
        { key: 'manual-auth', fingerprint },
        [authorizationGuard],
      )

      const transactItems = harness.commands[2]?.input.TransactItems
      expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toEqual(authorizationGuard)
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

  test('fails closed when a reverse source association row is malformed', async () => {
    const harness = createHarness([{
      Items: [{
        entryType: 'triage-work-item-source',
        scopeKey: 'WORKSPACE#workspace-1',
        recordKey: 'TRIAGE_SOURCE#support#work-item-1#triage-1',
        teamId: 'support',
        workItemId: 'work-item-1',
      }],
    }])

    try {
      await expect(harness.client.listWorkItemSources(
        'workspace-1',
        'support',
        'work-item-1',
      )).rejects.toMatchObject({
        code: 'TriagePersistenceCorrupt',
        status: 503,
      })
    } finally {
      harness.restore()
    }
  })

  test('fills reverse source pages before applying Project visibility', async () => {
    const hiddenEntry = createEntry()
    hiddenEntry.id = 'triage-hidden-source'
    hiddenEntry.projectId = 'hidden-project'
    const visibleEntry = createEntry()
    visibleEntry.id = 'triage-visible-source'
    visibleEntry.projectId = 'visible-project'
    const hiddenRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: hiddenEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: hiddenEntry.source.sourceId }),
    })[0]?.Put?.Item
    const visibleRow = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: visibleEntry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: visibleEntry.source.sourceId }),
    })[0]?.Put?.Item
    if (!hiddenRow || !visibleRow) throw new TypeError('Expected stored source entries.')
    const hiddenAssociationKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE_SOURCE#support#work-item-1#triage-hidden-source',
    }
    const visibleAssociationKey = {
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE_SOURCE#support#work-item-1#triage-visible-source',
    }
    const harness = createHarness([
      {
        Items: [{
          entryType: 'triage-work-item-source',
          ...hiddenAssociationKey,
          entryId: hiddenEntry.id,
          teamId: 'support',
          workItemId: 'work-item-1',
        }],
        LastEvaluatedKey: hiddenAssociationKey,
      },
      { Item: hiddenRow },
      {
        Items: [{
          entryType: 'triage-work-item-source',
          ...visibleAssociationKey,
          entryId: visibleEntry.id,
          teamId: 'support',
          workItemId: 'work-item-1',
        }],
      },
      { Item: visibleRow },
    ])

    try {
      const page = await harness.client.listWorkItemSources(
        'workspace-1',
        'support',
        'work-item-1',
        1,
        undefined,
        ['visible-project'],
      )

      expect(page.entries.map(({ id }) => id)).toEqual(['triage-visible-source'])
      const queries = harness.commands.filter(({ name }) => name === 'QueryCommand')
      expect(queries).toHaveLength(2)
      expect(queries[0]?.input.Limit).toBe(1)
      expect(queries[1]?.input).toEqual(expect.objectContaining({
        ExclusiveStartKey: hiddenAssociationKey,
        Limit: 1,
      }))
      expect(page.nextCursor).toBeUndefined()
    } finally {
      harness.restore()
    }
  })
})
