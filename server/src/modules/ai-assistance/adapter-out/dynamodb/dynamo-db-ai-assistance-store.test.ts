import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, spyOn, test } from 'bun:test'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistancePolicy,
  type AiAssistancePreference,
} from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
} from '../../../audit'
import type { AuditEventV1 } from '../../../audit'
import type {
  AiAssistanceAuthorizationCondition,
  AiAssistanceGenerationAttemptAuditEnvelope,
  AiAssistanceGenerationCommitFence,
  FailAiAssistanceGenerationReservationInput,
  FinalizeAiAssistanceGenerationAttemptInput,
  ReserveAiAssistanceGenerationInput,
  StartAiAssistanceGenerationAttemptInput,
  StoredAiAssistanceFeedback,
  StoredAiAssistanceGeneration,
} from '../../application/ports/ai-assistance-ports'
import {
  createAiAssistanceIdempotencyRecordKey,
  DynamoDbAiAssistanceStore,
} from './dynamo-db-ai-assistance-store'

const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)

/** Creates one valid generation reservation input with overridable lease identity. */
function createReservation(
  overrides: Partial<ReserveAiAssistanceGenerationInput> = {},
): ReserveAiAssistanceGenerationInput {
  return {
    workspaceId: 'workspace-1',
    memberId: 'member-1',
    idempotencyKey: 'client-secret-key',
    inputFingerprint: FINGERPRINT,
    generationId: 'generation-2',
    requestedAt: '2026-08-25T00:01:00.000Z',
    leaseExpiresAt: '2026-08-25T00:01:30.000Z',
    expiresAt: '2026-09-24T00:01:00.000Z',
    budget: {
      windowStartedAt: '2026-08-25T00:01:00.000Z',
      windowExpiresAt: '2026-08-25T00:02:00.000Z',
      reservedTokens: 1_000,
      workspaceGenerationLimit: 10,
      memberGenerationLimit: 2,
      workspaceTokenLimit: 10_000,
      memberTokenLimit: 2_000,
    },
    ...overrides,
  }
}

/** Creates a deterministic SDK harness that captures document commands. */
function createHarness(
  responses: unknown[],
  auditTableName?: string,
  enterpriseIdentityTableName?: string,
) {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  let responseIndex = 0
  const sendSpy = spyOn(documentClient, 'send')
  sendSpy.mockImplementation(async (command) => {
    const constructorValue = Reflect.get(command, 'constructor')
    const input = Reflect.get(command, 'input')
    if (
      typeof constructorValue !== 'function' ||
      typeof constructorValue.name !== 'string' ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    ) throw new TypeError('Expected an AWS DocumentClient command.')
    commands.push({
      name: constructorValue.name,
      input: Object.fromEntries(Object.entries(input)),
    })
    const response = responses[responseIndex]
    responseIndex += 1
    if (response instanceof Error) throw response
    return response ?? {}
  })
  return {
    store: new DynamoDbAiAssistanceStore(
      documentClient,
      'WorkspaceSearchTable',
      auditTableName,
      'mukuroji-workspace-access-local',
      enterpriseIdentityTableName,
    ),
    commands,
    restore: () => sendSpy.mockRestore(),
  }
}

/** Creates a policy transition event suitable for the atomic policy-write test.
 *
 * @returns An immutable AI policy audit event.
 */
function createPolicyAuditEvent(): AuditEventV1 {
  const occurredAt = '2026-08-25T00:01:00.000Z'
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'member-1@example.com', kind: 'user' },
    idempotencyKey: 'ai-assistance-policy:workspace-1:1',
    request: {
      method: 'PUT',
      path: '/api/ai-assistance/policy',
      body: { expectedRevision: 0, revision: 1 },
    },
    source: { kind: 'api', method: 'PUT', route: '/api/ai-assistance/policy' },
    occurredAt,
  })
  return createAuditEvent({
    context,
    eventType: 'ai-assistance.policy.updated',
    entity: { type: 'workspace', id: 'workspace-1' },
    before: { revision: 0 },
    after: { revision: 1 },
    expiresAt: calculateAuditExpiresAt(occurredAt, 30),
  })
}

/** Creates the modeled DynamoDB error returned by a failed condition. */
function conditionalFailure(): Error {
  const error = new Error('conditional failure')
  error.name = 'ConditionalCheckFailedException'
  return error
}

/** Creates a modeled DynamoDB transaction cancellation with ordered reason codes. */
function transactionCancellation(
  reasonCodes: readonly (string | undefined)[],
): Error {
  const error = new Error('transaction cancelled')
  error.name = 'TransactionCanceledException'
  Object.assign(error, {
    CancellationReasons: reasonCodes.map((code) =>
      code === undefined ? {} : { Code: code }),
  })
  return error
}

/** Reads a captured object-valued command field without a type assertion. */
function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a command record.')
  }
  return Object.fromEntries(Object.entries(value))
}

/** Creates one persisted pending receipt for a given generation lease. */
function createPendingReceipt(generationId: string, leaseExpiresAt: number) {
  return {
    workspaceId: 'workspace-1',
    recordKey: createAiAssistanceIdempotencyRecordKey(
      'member-1',
      'client-secret-key',
    ),
    recordType: 'ai-assistance-generation-idempotency',
    memberId: 'member-1',
    inputFingerprint: FINGERPRINT,
    generationId,
    status: 'pending',
    leaseExpiresAt,
    expiresAt: 1_777_161_660,
  }
}

/** Creates the redacted request, context, and citation evidence retained on an attempt. */
function createAttemptAudit(
  overrides: Partial<AiAssistanceGenerationAttemptAuditEnvelope> = {},
): AiAssistanceGenerationAttemptAuditEnvelope {
  return {
    request: {
      task: 'summary',
      locale: 'ja',
      sources: [{
        type: 'work-item',
        teamId: 'team-1',
        workItemId: 'work-item-1',
        expectedRevision: 2,
      }],
      focus: 'Safe focus',
    },
    auditedInput: 'Permission-filtered source context.',
    citations: [{
      id: 'S1',
      sourceType: 'work-item',
      label: 'Work Item',
      href: '/teams/team-1/work-items/work-item-1',
      excerpt: 'Permission-filtered excerpt.',
      capturedRevision: 2,
    }],
    ...overrides,
  }
}

/** Creates the safe provider-attempt start envelope used by receipt tests. */
function createAttemptStart(
  audit: AiAssistanceGenerationAttemptAuditEnvelope = createAttemptAudit(),
): StartAiAssistanceGenerationAttemptInput {
  return {
    workspaceId: 'workspace-1',
    memberId: 'member-1',
    idempotencyKey: 'client-secret-key',
    inputFingerprint: FINGERPRINT,
    generationId: 'generation-2',
    task: 'summary',
    modelId: 'model-1',
    promptVersion: 'ai-assistance-v1',
    traceId: 'trace-1',
    startedAt: '2026-08-25T00:01:01.000Z',
    audit,
  }
}

/** Creates a valid terminal success attempt stored on a completed receipt. */
function createSucceededAttempt() {
  return {
    task: 'summary',
    modelId: 'model-1',
    promptVersion: 'ai-assistance-v1',
    traceId: 'trace-1',
    startedAt: '2026-08-25T00:01:01.000Z',
    audit: createAttemptAudit(),
    status: 'succeeded',
    providerOutcome: 'succeeded',
    endedAt: '2026-08-25T00:01:01.030Z',
    latencyMs: 30,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 30,
      costUnavailableReason: 'pricing-not-configured',
    },
  }
}

/** Creates a started attempt that is waiting for terminal receipt reconciliation. */
function createStartedAttempt() {
  return {
    task: 'summary',
    modelId: 'model-1',
    promptVersion: 'ai-assistance-v1',
    traceId: 'trace-1',
    startedAt: '2026-08-25T00:01:01.000Z',
    audit: createAttemptAudit(),
    status: 'started',
  }
}

/** Creates the enabled policy used by natural replay tests. */
function createPolicy(updatedAt: string): AiAssistancePolicy {
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    enabled: true,
    allowedModelIds: ['model-1'],
    defaultModelId: 'model-1',
    enabledTasks: ['summary'],
    retentionDays: 30,
    revision: 1,
    updatedAt,
  }
}

/** Creates the actor-bound policy mutation identity used by audited replay tests. */
function createPolicyMutationFingerprint(policy: AiAssistancePolicy): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: 'workspace-1',
    memberId: 'member-1@example.com',
    actorUserId: 'member-1@example.com',
    expectedRevision: 0,
    policy: {
      schemaVersion: policy.schemaVersion,
      enabled: policy.enabled,
      allowedModelIds: policy.allowedModelIds,
      defaultModelId: policy.defaultModelId,
      enabledTasks: policy.enabledTasks,
      retentionDays: policy.retentionDays,
      revision: policy.revision,
    },
  })).digest('hex')
}

/** Creates one valid durable generation record with overridable audited context. */
function createGenerationRecord(auditedInput: string): StoredAiAssistanceGeneration {
  return {
    workspaceId: 'workspace-1',
    memberId: 'member-1',
    generation: {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      id: 'generation-1',
      task: 'summary',
      revision: 1,
      content: {
        availability: 'available',
        draft: {
          kind: 'summary',
          overview: {
            id: 'overview-1',
            text: 'Safe summary.',
            confidence: 'high',
            citationIds: ['S1'],
          },
          decisions: [],
          actions: [],
          risks: [],
        },
        citations: [{
          id: 'S1',
          sourceType: 'work-item',
          label: 'Work Item',
          href: '/teams/team-1/work-items/work-item-1',
          capturedRevision: 2,
        }],
        uncertainty: { level: 'low', reason: 'Evidence is complete.' },
      },
      details: {
        provider: 'bedrock',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        usage: { latencyMs: 1, costUnavailableReason: 'pricing-not-configured' },
      },
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-24T00:00:00.000Z',
    },
    request: {
      task: 'summary',
      locale: 'ja',
      sources: [{
        type: 'work-item',
        teamId: 'team-1',
        workItemId: 'work-item-1',
        expectedRevision: 2,
      }],
    },
    authorizationToken: 'authorization-snapshot-1',
    auditedInput,
  }
}

/** Creates the DynamoDB-shaped generation item used by reconciliation tests. */
function createPersistedGenerationItem(
  record: StoredAiAssistanceGeneration,
): Record<string, unknown> {
  return {
    workspaceId: record.workspaceId,
    recordKey: `AI_GENERATION#${record.generation.id}`,
    recordType: 'ai-assistance-generation',
    memberId: record.memberId,
    generation: record.generation,
    request: record.request,
    authorizationToken: record.authorizationToken,
    auditedInput: record.auditedInput,
    expiresAt: Math.floor(Date.parse(record.generation.expiresAt) / 1_000),
  }
}

/** Creates a generation record whose identity matches the reservation fixtures. */
function createCommittedGenerationRecord(): StoredAiAssistanceGeneration {
  const record = createGenerationRecord('Permission-filtered source context.')
  return {
    ...record,
    generation: {
      ...record.generation,
      id: 'generation-2',
    },
  }
}

/** Creates the successful provider completion committed with a generation row. */
function createSuccessfulCompletion(): FinalizeAiAssistanceGenerationAttemptInput {
  return {
    workspaceId: 'workspace-1',
    memberId: 'member-1',
    idempotencyKey: 'client-secret-key',
    inputFingerprint: FINGERPRINT,
    generationId: 'generation-2',
    outcome: 'succeeded',
    providerOutcome: 'succeeded',
    endedAt: '2026-08-25T00:01:01.030Z',
    latencyMs: 30,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 30,
      costUnavailableReason: 'pricing-not-configured',
    },
  }
}

/** Creates the revision fence used by atomic generation commit tests. */
function createGenerationCommitFence(): AiAssistanceGenerationCommitFence {
  return {
    policyRevision: 3,
    preferenceRevision: 2,
    authorizationToken: 'authorization-snapshot-1',
  }
}

/** Creates a terminal receipt written by expired-attempt recovery. */
function createExpiredFailedReceipt() {
  return {
    ...createPendingReceipt(
      'generation-2',
      Date.parse('2026-08-25T00:01:30.000Z'),
    ),
    status: 'failed',
    failedAt: '2026-08-25T00:01:31.000Z',
    failureCategory: 'upstream',
    failureCode: 'AiAssistanceAttemptFailed',
    attempt: {
      ...createStartedAttempt(),
      status: 'failed',
      endedAt: '2026-08-25T00:01:31.000Z',
      usageUnavailableReason: 'attempt-outcome-indeterminate',
      providerOutcome: 'indeterminate',
      failureCategory: 'upstream',
      failureCode: 'AiAssistanceAttemptFailed',
    },
  }
}

describe('DynamoDbAiAssistanceStore', () => {
  test('supports the full canonical Workspace member-key length for AI records', async () => {
    const memberId = 'm'.repeat(320)
    const harness = createHarness([{}])
    try {
      await expect(harness.store.reserveGeneration(
        createReservation({ memberId }),
      )).resolves.toEqual({ status: 'reserved', generationId: 'generation-2' })
      const transactionItems = harness.commands[0]?.input.TransactItems
      expect(Array.isArray(transactionItems)).toBeTrue()
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      const receipt = readRecord(readRecord(transactionItems[0]).Put)
      expect(readRecord(receipt.Item).memberId).toBe(memberId)
      const memberBudget = readRecord(readRecord(transactionItems[2]).Update)
      expect(readRecord(memberBudget.Key).recordKey).toContain(
        encodeURIComponent(memberId),
      )
    } finally {
      harness.restore()
    }
  })

  test('maps policy, preference, and generation read failures to persistence errors', async () => {
    const readers = [
      (store: DynamoDbAiAssistanceStore) => store.getPolicy('workspace-1'),
      (store: DynamoDbAiAssistanceStore) => store.getPreference('workspace-1', 'member-1'),
      (store: DynamoDbAiAssistanceStore) => store.getGeneration('workspace-1', 'generation-1'),
    ]
    for (const read of readers) {
      const harness = createHarness([new Error('DynamoDB unavailable')])
      try {
        await expect(read(harness.store)).rejects.toMatchObject({
          category: 'upstream',
          code: 'AiAssistancePersistenceError',
        })
      } finally {
        harness.restore()
      }
    }
  })

  test('rejects an oversized UTF-8 generation row before sending a DynamoDB command', async () => {
    const harness = createHarness([])
    try {
      await expect(harness.store.createGeneration(
        createGenerationRecord('😀'.repeat(100_000)),
      )).rejects.toMatchObject({
        category: 'upstream',
        code: 'AiAssistancePersistenceError',
      })
      expect(harness.commands).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  test('rejects an oversized exact attempt receipt before its DynamoDB update', async () => {
    const pendingReceipt = createPendingReceipt(
      'generation-2',
      Date.parse('2026-08-25T00:01:30.000Z'),
    )
    const citations: AiAssistanceGenerationAttemptAuditEnvelope['citations'] = Array.from(
      { length: 100 },
      (_, index) => ({
        id: `S${index}`,
        sourceType: 'work-item',
        label: 'L'.repeat(500),
        href: `/${'h'.repeat(1_990)}${index}`,
        excerpt: '😀'.repeat(1_000),
        capturedRevision: 2,
      }),
    )
    const harness = createHarness([{ Item: pendingReceipt }])
    try {
      await expect(harness.store.startGenerationAttempt(createAttemptStart(
        createAttemptAudit({
          auditedInput: 'C'.repeat(100_000),
          citations,
        }),
      ))).rejects.toMatchObject({
        category: 'upstream',
        code: 'AiAssistancePersistenceError',
      })
      expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('reconciles an ambiguous generation write before reporting persistence failure', async () => {
    const record = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([
      new Error('connection closed after PutItem committed'),
      { Item: createPersistedGenerationItem(record) },
    ])
    try {
      await expect(harness.store.createGeneration(record)).resolves.toEqual(record)
      expect(harness.commands.map((command) => command.name)).toEqual([
        'PutCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('fences generation persistence against policy and preference revisions', async () => {
    const record = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([{}])
    try {
      await expect(harness.store.createGeneration(record, {
        policyRevision: 3,
        preferenceRevision: 2,
        authorizationToken: record.authorizationToken,
      })).resolves.toEqual(record)
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
      const items = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(items)) throw new TypeError('Expected transaction items.')
      expect(items).toHaveLength(3)
      expect(readRecord(readRecord(items[1]).ConditionCheck).ConditionExpression)
        .toBe('#value.#revision = :expectedRevision')
      expect(readRecord(readRecord(items[2]).ConditionCheck).ConditionExpression)
        .toBe('#value.#revision = :expectedRevision')
    } finally {
      harness.restore()
    }
  })

  test('fences generation persistence against source-of-truth revisions', async () => {
    const record = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([{}])
    try {
      await expect(harness.store.createGeneration(record, {
        policyRevision: 3,
        preferenceRevision: 2,
        authorizationToken: record.authorizationToken,
        authorizationConditions: [{
          kind: 'source',
          tableName: 'RequestIntakeTable',
          key: { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' },
          expectedAttributes: { entryType: 'triage-entry', revision: 2 },
          expectedAbsentAttributes: ['archivedAt'],
        }],
      })).resolves.toEqual(record)
      const transactionItems = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(transactionItems)) throw new TypeError('Expected transaction items.')
      expect(transactionItems).toHaveLength(4)
      const sourceCheck = readRecord(readRecord(transactionItems[3]).ConditionCheck)
      expect(sourceCheck.TableName).toBe('RequestIntakeTable')
      expect(sourceCheck.Key).toEqual({
        scopeKey: 'WORKSPACE#workspace-1',
        recordKey: 'TRIAGE#triage-1',
      })
      expect(sourceCheck.ConditionExpression).toContain('#authorization0 = :authorization0')
      expect(sourceCheck.ConditionExpression).toContain('#authorization1 = :authorization1')
      expect(sourceCheck.ConditionExpression).toContain('attribute_not_exists(#authorizationAbsent0)')
    } finally {
      harness.restore()
    }
  })

  test('rejects generation persistence when a governance fence changes', async () => {
    const record = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([
      transactionCancellation(['None', 'ConditionalCheckFailed', 'None']),
    ])
    try {
      await expect(harness.store.createGeneration(record, {
        policyRevision: 3,
        preferenceRevision: 2,
        authorizationToken: record.authorizationToken,
      })).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('rejects generation persistence when the source authorization fence does not match', async () => {
    const record = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([{}])
    try {
      await expect(harness.store.createGeneration(record, {
        policyRevision: 3,
        preferenceRevision: 2,
        authorizationToken: 'different-authorization-snapshot',
      })).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  test('atomically commits a generation and its terminal provider receipt', async () => {
    const record = createCommittedGenerationRecord()
    const harness = createHarness([{}])
    try {
      await expect(harness.store.commitGeneration(
        record,
        createSuccessfulCompletion(),
        createGenerationCommitFence(),
      )).resolves.toEqual(record)

      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
      const transactionItems = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      expect(transactionItems).toHaveLength(4)
      const generationPut = readRecord(readRecord(transactionItems[0]).Put)
      expect(readRecord(generationPut.Item)).toMatchObject({
        recordType: 'ai-assistance-generation',
        memberId: 'member-1',
      })
      const receiptUpdate = readRecord(readRecord(transactionItems[1]).Update)
      expect(receiptUpdate.ConditionExpression).toContain(
        '#attempt.#attemptStatus = :started',
      )
      expect(receiptUpdate.UpdateExpression).toContain(
        '#attempt.#providerOutcome = :providerOutcome',
      )
      expect(readRecord(receiptUpdate.ExpressionAttributeValues)).toMatchObject({
        ':receiptStatus': 'completed',
        ':attemptStatus': 'succeeded',
        ':providerOutcome': 'succeeded',
      })
    } finally {
      harness.restore()
    }
  })

  test('rejects a generation transaction that would exceed one hundred items', async () => {
    const record = createCommittedGenerationRecord()
    const harness = createHarness([])
    try {
      await expect(harness.store.commitGeneration(
        record,
        createSuccessfulCompletion(),
        {
          ...createGenerationCommitFence(),
          authorizationConditions: Array.from(
            { length: 97 },
            (_, index): AiAssistanceAuthorizationCondition => ({
              kind: 'source',
              tableName: 'SourceTable',
              key: { workspaceId: 'workspace-1', recordKey: `SOURCE#${index}` },
              expectedAttributes: { revision: index },
            }),
          ),
        },
      )).rejects.toMatchObject({ code: 'InvalidAiAssistanceRecord' })
      expect(harness.commands).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  test('reconciles response loss after the atomic generation commit', async () => {
    const record = createCommittedGenerationRecord()
    const completedReceipt = {
      ...createPendingReceipt(
        'generation-2',
        Date.parse('2026-08-25T00:01:30.000Z'),
      ),
      status: 'completed',
      attempt: createSucceededAttempt(),
    }
    const harness = createHarness([
      new Error('connection closed after transaction committed'),
      { Item: completedReceipt },
      { Item: createPersistedGenerationItem(record) },
    ])
    try {
      await expect(harness.store.commitGeneration(
        record,
        createSuccessfulCompletion(),
        createGenerationCommitFence(),
      )).resolves.toEqual(record)
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'GetCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('does not create an orphan generation when expired recovery wins the receipt race', async () => {
    const record = createCommittedGenerationRecord()
    const harness = createHarness([
      transactionCancellation([
        undefined,
        'ConditionalCheckFailed',
        undefined,
        undefined,
      ]),
      { Item: createExpiredFailedReceipt() },
      {},
    ])
    try {
      await expect(harness.store.commitGeneration(
        record,
        createSuccessfulCompletion(),
        createGenerationCommitFence(),
      )).rejects.toMatchObject({
        category: 'upstream',
        code: 'AiAssistanceAttemptFailed',
        idempotencyReplayed: true,
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'GetCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('atomically reserves one idempotency receipt and both fixed-window budgets', async () => {
    const harness = createHarness([{}])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .resolves.toEqual({ status: 'reserved', generationId: 'generation-2' })

      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
      const transactionItems = harness.commands[0]?.input.TransactItems
      expect(Array.isArray(transactionItems)).toBeTrue()
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      expect(transactionItems).toHaveLength(3)
      const receipt = readRecord(readRecord(transactionItems[0]).Put)
      const receiptItem = readRecord(receipt.Item)
      expect(receiptItem.recordKey).not.toContain('client-secret-key')
      expect(receiptItem.expiresAt).toBeNumber()
      for (const item of transactionItems.slice(1)) {
        const update = readRecord(readRecord(item).Update)
        expect(update.ConditionExpression).toContain(
          'attribute_not_exists(#workspaceId) AND attribute_not_exists(#recordKey)',
        )
        expect(update.ConditionExpression).toContain(
          'attribute_type(#generationCount, :numberType)',
        )
        expect(update.ConditionExpression).toContain(
          '#generationCount <= :maximumPreviousGenerationCount',
        )
        expect(update.ConditionExpression).toContain(
          '#reservedTokens <= :maximumPreviousReservedTokens',
        )
      }
    } finally {
      harness.restore()
    }
  })

  test('reads a completed receipt without charging a new generation budget', async () => {
    const receipt = {
      ...createPendingReceipt('generation-1', 1),
      status: 'completed',
      attempt: createSucceededAttempt(),
    }
    const harness = createHarness([{ Item: receipt }])
    try {
      await expect(harness.store.readGenerationReservation({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
      })).resolves.toEqual({
        status: 'replay',
        generationId: 'generation-1',
        expiresAt: '2026-04-26T00:01:00.000Z',
      })
      expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('reads a started pending receipt so the service can repair a durable generation', async () => {
    const receipt = {
      ...createPendingReceipt('generation-1', 1),
      attempt: createStartedAttempt(),
    }
    const harness = createHarness([{ Item: receipt }])
    try {
      await expect(harness.store.readGenerationReservation({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
      })).resolves.toEqual({
        status: 'pending',
        generationId: 'generation-1',
        leaseExpiresAt: '1970-01-01T00:00:00.001Z',
        expiresAt: '2026-04-26T00:01:00.000Z',
      })
      expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('keeps a started receipt pending before its recovery lease expires', async () => {
    const pendingReceipt = {
      ...createPendingReceipt(
        'generation-2',
        Date.parse('2026-08-25T00:01:30.000Z'),
      ),
      attempt: createStartedAttempt(),
    }
    const harness = createHarness([
      conditionalFailure(),
      { Item: pendingReceipt },
    ])
    try {
      await expect(harness.store.expireGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        failedAt: '2026-08-25T00:01:29.999Z',
      })).resolves.toEqual({
        status: 'pending',
        generationId: 'generation-2',
        leaseExpiresAt: '2026-08-25T00:01:30.000Z',
        expiresAt: '2026-04-26T00:01:00.000Z',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'UpdateCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('marks provider dispatch through an exact idempotent receipt CAS', async () => {
    const markedReceipt = {
      ...createPendingReceipt(
        'generation-2',
        Date.parse('2026-08-25T00:01:30.000Z'),
      ),
      attempt: {
        ...createStartedAttempt(),
        providerStartedAt: '2026-08-25T00:01:02.000Z',
      },
    }
    const harness = createHarness([
      new Error('connection closed after provider marker committed'),
      { Item: markedReceipt },
      conditionalFailure(),
      { Item: markedReceipt },
    ])
    const input = {
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      idempotencyKey: 'client-secret-key',
      inputFingerprint: FINGERPRINT,
      generationId: 'generation-2',
      attemptStartedAt: '2026-08-25T00:01:01.000Z',
      providerStartedAt: '2026-08-25T00:01:02.000Z',
    }
    try {
      await expect(harness.store.markGenerationProviderStarted(input))
        .resolves.toBeUndefined()
      await expect(harness.store.markGenerationProviderStarted(input))
        .resolves.toBeUndefined()

      expect(harness.commands.map((command) => command.name)).toEqual([
        'UpdateCommand',
        'GetCommand',
        'UpdateCommand',
        'GetCommand',
      ])
      expect(harness.commands[0]?.input.UpdateExpression).toBe(
        'SET #attempt.#providerStartedAt = :providerStartedAt',
      )
      expect(harness.commands[0]?.input.ConditionExpression).toContain(
        'attribute_not_exists(#attempt.#providerStartedAt)',
      )
      expect(harness.commands[0]?.input.ExpressionAttributeValues).toMatchObject({
        ':attemptStartedAt': input.attemptStartedAt,
        ':providerStartedAt': input.providerStartedAt,
      })
    } finally {
      harness.restore()
    }
  })

  test('rejects a provider dispatch timestamp before its admission marker', async () => {
    const harness = createHarness([])
    try {
      await expect(harness.store.markGenerationProviderStarted({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        attemptStartedAt: '2026-08-25T00:01:01.000Z',
        providerStartedAt: '2026-08-25T00:01:00.999Z',
      })).rejects.toMatchObject({ code: 'InvalidAiAssistanceRecord' })
      expect(harness.commands).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  test('terminalizes an expired attempt once across competing recovery calls', async () => {
    const harness = createHarness([
      {},
      conditionalFailure(),
      { Item: createExpiredFailedReceipt() },
    ])
    const input = {
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      idempotencyKey: 'client-secret-key',
      inputFingerprint: FINGERPRINT,
      generationId: 'generation-2',
      failedAt: '2026-08-25T00:01:31.000Z',
    }
    try {
      await expect(harness.store.expireGenerationAttempt(input)).resolves.toMatchObject({
        status: 'failed',
        generationId: 'generation-2',
        failureCategory: 'upstream',
        failureCode: 'AiAssistanceAttemptFailed',
      })
      await expect(harness.store.expireGenerationAttempt(input)).resolves.toMatchObject({
        status: 'failed',
        generationId: 'generation-2',
        failureCategory: 'upstream',
        failureCode: 'AiAssistanceAttemptFailed',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'UpdateCommand',
        'UpdateCommand',
        'GetCommand',
      ])
      expect(harness.commands[0]?.input.ConditionExpression).toContain(
        '#attempt.#attemptStatus = :started AND #leaseExpiresAt <= :failedAtEpoch',
      )
      expect(harness.commands[0]?.input.UpdateExpression).toContain(
        '#attempt.#providerOutcome = :providerOutcome',
      )
      expect(harness.commands[0]?.input.UpdateExpression).not.toContain(
        '#attempt.#latencyMs',
      )
      expect(harness.commands[0]?.input.ExpressionAttributeValues).toMatchObject({
        ':providerOutcome': 'indeterminate',
        ':usageUnavailableReason': 'attempt-outcome-indeterminate',
      })
    } finally {
      harness.restore()
    }
  })

  test('reconciles response loss after expired-attempt recovery', async () => {
    const harness = createHarness([
      new Error('connection closed after expired recovery committed'),
      { Item: createExpiredFailedReceipt() },
    ])
    try {
      await expect(harness.store.expireGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        failedAt: '2026-08-25T00:01:31.000Z',
      })).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'AiAssistanceAttemptFailed',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'UpdateCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('leaves an unstarted pending receipt available for expired-lease takeover', async () => {
    const receipt = createPendingReceipt('generation-1', 1)
    const harness = createHarness([{ Item: receipt }])
    try {
      await expect(harness.store.readGenerationReservation({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
      })).resolves.toBeUndefined()
      expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('records and finalizes only safe provider attempt metadata on the receipt', async () => {
    const rawAudit = createAttemptAudit({
      request: {
        task: 'summary',
        locale: 'ja',
        sources: [{
          type: 'work-item',
          teamId: 'team-1',
          workItemId: 'work-item-1',
          expectedRevision: 2,
        }],
        focus: 'owner@example.com token=operator-secret',
      },
      auditedInput: 'source@example.com password=context-secret',
      citations: [{
        id: 'S1',
        sourceType: 'work-item',
        label: 'Owner owner@example.com',
        href: '/teams/team-1/work-items/work-item-1',
        excerpt: 'Bearer raw.provider.secret',
        capturedRevision: 2,
      }],
    })
    const pendingReceipt = createPendingReceipt(
      'generation-2',
      Date.parse('2026-08-25T00:01:30.000Z'),
    )
    const harness = createHarness([{ Item: pendingReceipt }, {}, {}])
    try {
      await harness.store.startGenerationAttempt(createAttemptStart(rawAudit))
      await harness.store.finalizeGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        outcome: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'timeout',
        failureCode: 'AiAssistanceProviderTimeout',
      })

      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'UpdateCommand',
        'UpdateCommand',
      ])
      const startedValues = readRecord(
        harness.commands[1]?.input.ExpressionAttributeValues,
      )
      expect(startedValues).toEqual(expect.objectContaining({
        ':attempt': {
          task: 'summary',
          modelId: 'model-1',
          promptVersion: 'ai-assistance-v1',
          traceId: 'trace-1',
          startedAt: '2026-08-25T00:01:01.000Z',
          audit: {
            request: expect.objectContaining({
              focus: '[REDACTED_EMAIL] token=[REDACTED_SECRET]',
            }),
            auditedInput: '[REDACTED_EMAIL] password=[REDACTED_SECRET]',
            citations: [expect.objectContaining({
              label: 'Owner [REDACTED_EMAIL]',
              excerpt: 'Bearer [REDACTED_TOKEN]',
            })],
          },
          status: 'started',
        },
      }))
      expect(JSON.stringify(startedValues)).not.toContain('client-secret-key')
      expect(JSON.stringify(startedValues)).not.toContain('operator-secret')
      expect(JSON.stringify(startedValues)).not.toContain('context-secret')
      expect(JSON.stringify(startedValues)).not.toContain('raw.provider.secret')
      expect(readRecord(startedValues[':attempt'])).not.toHaveProperty('expiresAt')
      expect(startedValues[':expiresAt']).toBe(pendingReceipt.expiresAt)
      const finalizedValues = readRecord(
        harness.commands[2]?.input.ExpressionAttributeValues,
      )
      expect(finalizedValues).toEqual(expect.objectContaining({
        ':receiptStatus': 'failed',
        ':attemptStatus': 'failed',
        ':usageUnavailableReason': 'provider-did-not-report',
        ':failureCategory': 'timeout',
        ':failureCode': 'AiAssistanceProviderTimeout',
      }))
      expect(harness.commands[2]?.input.UpdateExpression).toContain(
        '#attempt.#failureCode = :failureCode',
      )
      expect(harness.commands[1]?.input.ConditionExpression).toContain(
        '#expiresAt = :expiresAt',
      )
    } finally {
      harness.restore()
    }
  })

  test('rejects provider outcomes that contradict the stable failure code', async () => {
    const harness = createHarness([])
    try {
      await expect(harness.store.finalizeGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        outcome: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'rate-limit',
        failureCode: 'AiAssistanceProviderRateLimited',
      })).rejects.toMatchObject({ code: 'InvalidAiAssistanceRecord' })
      expect(harness.commands).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  test('accepts a bounded model-refusal outcome with retained usage', async () => {
    const harness = createHarness([{}])
    try {
      await expect(harness.store.finalizeGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        outcome: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usage: {
          inputTokens: 42,
          outputTokens: 0,
          latencyMs: 12_000,
          costUnavailableReason: 'pricing-not-configured',
        },
        providerOutcome: 'refused',
        failureCategory: 'upstream',
        failureCode: 'AiAssistanceModelRefused',
      })).resolves.toBeUndefined()

      expect(readRecord(
        harness.commands[0]?.input.ExpressionAttributeValues,
      )).toEqual(expect.objectContaining({
        ':providerOutcome': 'refused',
        ':failureCode': 'AiAssistanceModelRefused',
      }))
    } finally {
      harness.restore()
    }
  })

  test('accepts response-loss replays of identical attempt start and finalization writes', async () => {
    const startedReceipt = {
      ...createPendingReceipt('generation-2', 1_777_161_690_000),
      attempt: {
        task: 'summary',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        startedAt: '2026-08-25T00:01:01.000Z',
        audit: createAttemptAudit(),
        status: 'started',
      },
    }
    const failedReceipt = {
      ...startedReceipt,
      status: 'failed',
      failedAt: '2026-08-25T00:01:13.000Z',
      failureCategory: 'timeout',
      failureCode: 'AiAssistanceProviderTimeout',
      attempt: {
        ...startedReceipt.attempt,
        status: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'timeout',
        failureCode: 'AiAssistanceProviderTimeout',
      },
    }
    const harness = createHarness([
      { Item: startedReceipt },
      conditionalFailure(),
      { Item: failedReceipt },
    ])
    try {
      await harness.store.startGenerationAttempt(createAttemptStart())
      await expect(harness.store.finalizeGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        outcome: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'timeout',
        failureCode: 'AiAssistanceProviderTimeout',
      })).resolves.toBeUndefined()
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'UpdateCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('rejects a response-loss start replay with a different audit envelope', async () => {
    const receipt = {
      ...createPendingReceipt(
        'generation-2',
        Date.parse('2026-08-25T00:01:30.000Z'),
      ),
      attempt: {
        task: 'summary',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        startedAt: '2026-08-25T00:01:01.000Z',
        audit: createAttemptAudit(),
        status: 'started',
      },
    }
    const harness = createHarness([{ Item: receipt }])
    try {
      await expect(harness.store.startGenerationAttempt(createAttemptStart(
        createAttemptAudit({ auditedInput: 'Different permission-filtered context.' }),
      ))).rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
      expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand'])
    } finally {
      harness.restore()
    }
  })

  test('reconciles a non-conditional attempt-start transport error', async () => {
    const startedReceipt = {
      ...createPendingReceipt('generation-2', 1_777_161_690_000),
      attempt: {
        task: 'summary',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        startedAt: '2026-08-25T00:01:01.000Z',
        audit: createAttemptAudit(),
        status: 'started',
      },
    }
    const harness = createHarness([
      { Item: createPendingReceipt('generation-2', 1_777_161_690_000) },
      new Error('connection closed after UpdateItem committed'),
      { Item: startedReceipt },
    ])
    try {
      await expect(harness.store.startGenerationAttempt(createAttemptStart()))
        .resolves.toBeUndefined()
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'UpdateCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('retries terminal attempt finalization after an ambiguous transport error', async () => {
    const pendingReceipt = createPendingReceipt(
      'generation-2',
      Date.parse('2026-08-25T00:01:30.000Z'),
    )
    const startedReceipt = {
      ...pendingReceipt,
      attempt: {
        task: 'summary',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        startedAt: '2026-08-25T00:01:01.000Z',
        audit: createAttemptAudit(),
        status: 'started',
      },
    }
    const harness = createHarness([
      { Item: pendingReceipt },
      {},
      new Error('connection closed after terminal UpdateItem started'),
      { Item: startedReceipt },
      {},
    ])
    try {
      await harness.store.startGenerationAttempt(createAttemptStart())
      await expect(harness.store.finalizeGenerationAttempt({
        workspaceId: 'workspace-1',
        memberId: 'member-1',
        idempotencyKey: 'client-secret-key',
        inputFingerprint: FINGERPRINT,
        generationId: 'generation-2',
        outcome: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'timeout',
        failureCode: 'AiAssistanceProviderTimeout',
      })).resolves.toBeUndefined()
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'UpdateCommand',
        'UpdateCommand',
        'GetCommand',
        'UpdateCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('durably and idempotently finalizes a pre-provider failure receipt', async () => {
    const failure = {
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      idempotencyKey: 'client-secret-key',
      inputFingerprint: FINGERPRINT,
      generationId: 'generation-2',
      failedAt: '2026-08-25T00:01:01.000Z',
      failureCategory: 'validation',
      failureCode: 'InvalidAiAssistanceRequest',
    } satisfies FailAiAssistanceGenerationReservationInput
    const failedReceipt = {
      ...createPendingReceipt('generation-2', 1_777_161_690_000),
      status: 'failed',
      failedAt: failure.failedAt,
      failureCategory: failure.failureCategory,
      failureCode: failure.failureCode,
    }
    const harness = createHarness([
      {},
      conditionalFailure(),
      { Item: failedReceipt },
    ])
    try {
      await harness.store.failGenerationReservation(failure)
      await expect(harness.store.failGenerationReservation(failure))
        .resolves.toBeUndefined()
      expect(harness.commands.map((command) => command.name)).toEqual([
        'UpdateCommand',
        'UpdateCommand',
        'GetCommand',
      ])
      expect(JSON.stringify(harness.commands)).not.toContain('client-secret-key')
    } finally {
      harness.restore()
    }
  })

  test('replays a terminal failed receipt without taking over or charging budget again', async () => {
    const receipt = {
      ...createPendingReceipt('generation-2', 1),
      status: 'failed',
      failedAt: '2026-08-25T00:01:13.000Z',
      failureCategory: 'timeout',
      failureCode: 'AiAssistanceProviderTimeout',
      attempt: {
        task: 'summary',
        modelId: 'model-1',
        promptVersion: 'ai-assistance-v1',
        traceId: 'trace-1',
        startedAt: '2026-08-25T00:01:01.000Z',
        audit: createAttemptAudit(),
        status: 'failed',
        endedAt: '2026-08-25T00:01:13.000Z',
        latencyMs: 12_000,
        usageUnavailableReason: 'provider-did-not-report',
        providerOutcome: 'timeout',
        failureCategory: 'timeout',
        failureCode: 'AiAssistanceProviderTimeout',
      },
    }
    const harness = createHarness([
      transactionCancellation([
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
      ]),
      conditionalFailure(),
      { Item: receipt },
    ])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .resolves.toEqual({
          status: 'failed',
          generationId: 'generation-2',
          expiresAt: '2026-04-26T00:01:00.000Z',
          failureCategory: 'timeout',
          failureCode: 'AiAssistanceProviderTimeout',
        })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'UpdateCommand',
        'GetCommand',
      ])
      expect(harness.commands[1]?.input.ConditionExpression).toContain(
        'attribute_not_exists(#attempt)',
      )
    } finally {
      harness.restore()
    }
  })

  test('atomically takes over one expired lease and leaves the next retry pending', async () => {
    const receiptAfterTakeover = createPendingReceipt(
      'generation-2',
      Date.parse('2026-08-25T00:01:30.000Z'),
    )
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      {},
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      conditionalFailure(),
      { Item: receiptAfterTakeover },
    ])
    try {
      const takeover = await harness.store.reserveGeneration(createReservation())
      const concurrent = await harness.store.reserveGeneration(createReservation({
        generationId: 'generation-3',
        requestedAt: '2026-08-25T00:01:01.000Z',
        leaseExpiresAt: '2026-08-25T00:01:31.000Z',
      }))

      expect(takeover).toEqual({ status: 'reserved', generationId: 'generation-2' })
      expect(concurrent).toEqual({
        status: 'pending',
        generationId: 'generation-2',
        leaseExpiresAt: '2026-08-25T00:01:30.000Z',
        expiresAt: '2026-04-26T00:01:00.000Z',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'UpdateCommand',
        'TransactWriteCommand',
        'UpdateCommand',
        'GetCommand',
      ])
      expect(harness.commands[1]?.input.ConditionExpression).toContain(
        '#leaseExpiresAt <= :requestedAt',
      )
    } finally {
      harness.restore()
    }
  })

  test('rejects a key reused with a different input fingerprint', async () => {
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      conditionalFailure(),
      { Item: { ...createPendingReceipt('generation-1', 1), inputFingerprint: OTHER_FINGERPRINT } },
    ])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
    } finally {
      harness.restore()
    }
  })

  test('returns a stable rate limit when either atomic budget condition fails', async () => {
    for (const reasonCodes of [
      [undefined, 'ConditionalCheckFailed', undefined],
      [undefined, undefined, 'ConditionalCheckFailed'],
    ]) {
      const harness = createHarness([transactionCancellation(reasonCodes)])
      try {
        await expect(harness.store.reserveGeneration(createReservation()))
          .rejects.toMatchObject({
            category: 'rate-limit',
            code: 'AiAssistanceRateLimitExceeded',
          })
        expect(harness.commands).toHaveLength(1)
      } finally {
        harness.restore()
      }
    }
  })

  test('prioritizes an existing idempotency replay over exhausted current budgets', async () => {
    const receipt = {
      ...createPendingReceipt('generation-1', 1),
      status: 'completed',
      attempt: createSucceededAttempt(),
    }
    const harness = createHarness([
      transactionCancellation([
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
      ]),
      conditionalFailure(),
      { Item: receipt },
    ])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .resolves.toEqual({
          status: 'replay',
          generationId: 'generation-1',
          expiresAt: '2026-04-26T00:01:00.000Z',
        })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'UpdateCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('fails closed when a completed receipt has no succeeded attempt audit', async () => {
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      conditionalFailure(),
      { Item: { ...createPendingReceipt('generation-1', 1), status: 'completed' } },
    ])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .rejects.toMatchObject({ code: 'InvalidAiAssistanceRecord' })
    } finally {
      harness.restore()
    }
  })

  test('fails closed when a transaction cancellation has no attributable reason', async () => {
    const harness = createHarness([
      transactionCancellation(['TransactionConflict', undefined, undefined]),
    ])
    try {
      await expect(harness.store.reserveGeneration(createReservation()))
        .rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
    } finally {
      harness.restore()
    }
  })

  test('accepts a feedback response-loss replay and rejects changed input', async () => {
    const feedback: StoredAiAssistanceFeedback = {
      workspaceId: 'workspace-1',
      feedbackId: 'feedback-1',
      generationId: 'generation-1',
      memberId: 'member-1',
      feedback: { rating: 'helpful', comment: 'Safe' },
      inputFingerprint: FINGERPRINT,
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-24T00:00:00.000Z',
    }
    const persisted = {
      ...feedback,
      recordKey: 'AI_FEEDBACK#generation-1#feedback-1',
      recordType: 'ai-assistance-feedback',
      expiresAt: 1_777_161_600,
    }
    const replayHarness = createHarness([
      conditionalFailure(),
      { Item: persisted },
    ])
    try {
      await expect(replayHarness.store.putFeedback(feedback)).resolves.toEqual({
        replayed: true,
      })
    } finally {
      replayHarness.restore()
    }

    const conflictHarness = createHarness([
      conditionalFailure(),
      { Item: { ...persisted, inputFingerprint: OTHER_FINGERPRINT } },
    ])
    try {
      await expect(conflictHarness.store.putFeedback(feedback))
        .rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
    } finally {
      conflictHarness.restore()
    }
  })

  test('fences feedback retention against a concurrent policy change', async () => {
    const feedback: StoredAiAssistanceFeedback = {
      workspaceId: 'workspace-1',
      feedbackId: 'feedback-1',
      generationId: 'generation-1',
      memberId: 'member-1',
      feedback: { rating: 'helpful' },
      inputFingerprint: FINGERPRINT,
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-24T00:00:00.000Z',
    }
    const harness = createHarness([
      transactionCancellation(['None', 'None', 'ConditionalCheckFailed']),
    ])
    try {
      await expect(harness.store.putFeedback(feedback, {
        policyRevision: 1,
        effectiveExpiresAt: feedback.expiresAt,
        commitAt: feedback.createdAt,
      })).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('fences feedback writes against the current actor authorization', async () => {
    const feedback: StoredAiAssistanceFeedback = {
      workspaceId: 'workspace-1',
      feedbackId: 'feedback-authorization',
      generationId: 'generation-1',
      memberId: 'member-1',
      feedback: { rating: 'helpful' },
      inputFingerprint: FINGERPRINT,
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-24T00:00:00.000Z',
    }
    const harness = createHarness([
      transactionCancellation(['None', 'None', 'None', 'ConditionalCheckFailed']),
    ])
    try {
      await expect(harness.store.putFeedback(feedback, {
        policyRevision: 1,
        effectiveExpiresAt: feedback.expiresAt,
        commitAt: feedback.createdAt,
        authorizationConditions: [{
          kind: 'workspace-member',
          tableName: 'WorkspaceAccessTable',
          key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#member-1' },
          expectedAttributes: {
            entryType: 'workspace-member',
            status: 'active',
            memberKey: 'member-1',
            role: 'member',
            version: 3,
          },
        }],
      })).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      const transactionItems = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(transactionItems)) throw new TypeError('Expected transaction items.')
      expect(transactionItems).toHaveLength(4)
      const authorizationCheck = readRecord(readRecord(transactionItems[3]).ConditionCheck)
      expect(authorizationCheck.TableName).toBe('WorkspaceAccessTable')
      expect(authorizationCheck.Key).toEqual({
        workspaceId: 'workspace-1',
        recordKey: 'MEMBER#member-1',
      })
      expect(authorizationCheck.ConditionExpression).toContain(
        '#authorization0 = :authorization0',
      )
    } finally {
      harness.restore()
    }
  })

  test('rejects feedback whose generation expires at the commit boundary', async () => {
    const feedback: StoredAiAssistanceFeedback = {
      workspaceId: 'workspace-1',
      feedbackId: 'feedback-expired',
      generationId: 'generation-1',
      memberId: 'member-1',
      feedback: { rating: 'helpful' },
      inputFingerprint: FINGERPRINT,
      createdAt: '2026-09-23T23:59:59.999Z',
      expiresAt: '2026-09-24T00:00:00.000Z',
    }
    const harness = createHarness([
      transactionCancellation(['None', 'ConditionalCheckFailed', 'None']),
    ])
    try {
      await expect(harness.store.putFeedback(feedback, {
        policyRevision: 1,
        effectiveExpiresAt: feedback.expiresAt,
        commitAt: feedback.createdAt,
      })).rejects.toMatchObject({
        category: 'not-found',
        code: 'AiAssistanceGenerationNotFound',
      })
      const transaction = harness.commands[0]
      expect(transaction?.name).toBe('TransactWriteCommand')
      expect(JSON.stringify(transaction?.input)).toContain(
        '#generation.#expiresAt > :commitAt',
      )
    } finally {
      harness.restore()
    }
  })

  test('replays an identical decision after a concurrent conditional write', async () => {
    const current = createGenerationRecord('Permission-filtered source context.')
    const decided: StoredAiAssistanceGeneration = {
      ...current,
      generation: {
        ...current.generation,
        revision: 2,
        decision: {
          outcome: 'approved',
          decidedAt: '2026-08-25T00:02:00.000Z',
        },
      },
    }
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      conditionalFailure(),
      { Item: createPersistedGenerationItem(decided) },
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
      )).resolves.toEqual({ record: decided, replayed: true })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'PutCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('fences a decision against a concurrent retention policy change', async () => {
    const current = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      transactionCancellation(['None', 'ConditionalCheckFailed', 'None']),
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
        {
          policyRevision: 3,
          preferenceRevision: 0,
          effectiveExpiresAt: '2026-09-24T00:00:00.000Z',
          commitAt: '2026-08-25T00:02:00.000Z',
          authorizationToken: 'authorization-snapshot-1',
        },
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'TransactWriteCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('fences a decision against a concurrent member preference change', async () => {
    const current = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      transactionCancellation(['None', 'None', 'ConditionalCheckFailed']),
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
        {
          policyRevision: 3,
          preferenceRevision: 2,
          effectiveExpiresAt: '2026-09-24T00:00:00.000Z',
          commitAt: '2026-08-25T00:02:00.000Z',
          authorizationToken: 'authorization-snapshot-1',
        },
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'TransactWriteCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('rejects a decision whose generation expires at the commit boundary', async () => {
    const base = createGenerationRecord('Permission-filtered source context.')
    const current = {
      ...base,
      generation: {
        ...base.generation,
        expiresAt: '2026-08-25T00:02:00.000Z',
      },
    }
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      transactionCancellation(['ConditionalCheckFailed', 'None', 'None']),
      { Item: createPersistedGenerationItem(current) },
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
        {
          policyRevision: 3,
          preferenceRevision: 2,
          effectiveExpiresAt: '2026-08-25T00:03:00.000Z',
          commitAt: '2026-08-25T00:02:00.000Z',
          authorizationToken: current.authorizationToken,
        },
      )).rejects.toMatchObject({
        category: 'not-found',
        code: 'AiAssistanceGenerationNotFound',
      })
      expect(JSON.stringify(harness.commands[1]?.input)).toContain(
        '#generation.#expiresAt > :commitAt',
      )
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('maps a generation condition cancellation to a revision conflict', async () => {
    const current = createGenerationRecord('Permission-filtered source context.')
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      transactionCancellation(['ConditionalCheckFailed', 'None', 'None']),
      { Item: createPersistedGenerationItem(current) },
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
        {
          policyRevision: 3,
          preferenceRevision: 2,
          effectiveExpiresAt: '2026-09-24T00:00:00.000Z',
          commitAt: '2026-08-25T00:02:00.000Z',
          authorizationToken: 'authorization-snapshot-1',
        },
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceRevisionConflict',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('maps a source authorization condition cancellation to an authorization conflict', async () => {
    const current = createGenerationRecord('Permission-filtered source context.')
    const changed = {
      ...createPersistedGenerationItem({
        ...current,
        authorizationToken: 'authorization-snapshot-2',
      }),
    }
    const harness = createHarness([
      { Item: createPersistedGenerationItem(current) },
      transactionCancellation(['ConditionalCheckFailed', 'None', 'None']),
      { Item: changed },
    ])
    try {
      await expect(harness.store.decideGeneration(
        'workspace-1',
        'generation-1',
        { outcome: 'approved', expectedRevision: 1 },
        '2026-08-25T00:02:00.000Z',
        {
          policyRevision: 3,
          preferenceRevision: 2,
          effectiveExpiresAt: '2026-09-24T00:00:00.000Z',
          commitAt: '2026-08-25T00:02:00.000Z',
          authorizationToken: current.authorizationToken,
        },
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'GetCommand',
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('returns the durable policy on a semantically identical CAS replay', async () => {
    const current = createPolicy('2026-08-25T00:00:01.000Z')
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([
      conditionalFailure(),
      {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'AI_POLICY#WORKSPACE',
          recordType: 'ai-assistance-policy',
          policy: current,
        },
      },
    ])
    try {
      await expect(harness.store.putPolicy('workspace-1', desired, 0))
        .resolves.toEqual(current)
    } finally {
      harness.restore()
    }
  })

  test('writes policy, membership fence, and audit event in one transaction', async () => {
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([{}], 'AuditTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'member-1@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 4,
          workspaceRole: 'admin',
        },
        createPolicyAuditEvent(),
      )).resolves.toEqual(desired)
      const transactionItems = harness.commands[0]?.input.TransactItems
      expect(Array.isArray(transactionItems)).toBeTrue()
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      expect(transactionItems).toHaveLength(3)
      expect(readRecord(readRecord(transactionItems[0]).Put).TableName)
        .toBe('WorkspaceSearchTable')
      expect(readRecord(readRecord(transactionItems[1]).ConditionCheck).TableName)
        .toBe('mukuroji-workspace-access-local')
      expect(readRecord(readRecord(transactionItems[2]).Put).TableName)
        .toBe('AuditTable')
    } finally {
      harness.restore()
    }
  })

  test('writes policy for a service account using the Enterprise fence', async () => {
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([{}], 'AuditTable', 'EnterpriseIdentityTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'automation-project-1',
        desired,
        0,
        {
          workspaceMemberVersion: 1,
          workspaceRole: 'member',
          principalKind: 'service-account',
          enterpriseControlRevision: 4,
        },
        createPolicyAuditEvent(),
      )).resolves.toEqual(desired)
      const transactionItems = harness.commands[0]?.input.TransactItems
      expect(Array.isArray(transactionItems)).toBeTrue()
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      expect(transactionItems).toHaveLength(3)
      expect(readRecord(readRecord(transactionItems[1]).ConditionCheck).TableName)
        .toBe('EnterpriseIdentityTable')
      expect(readRecord(readRecord(transactionItems[1]).ConditionCheck).Key)
        .toEqual({ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'CONTROL' })
    } finally {
      harness.restore()
    }
  })

  test('retains the Workspace membership fence for break-glass policy writes', async () => {
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([{}], 'AuditTable', 'EnterpriseIdentityTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'break-glass@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 7,
          workspaceRole: 'admin',
          principalKind: 'break-glass',
          enterpriseControlRevision: 4,
        },
        createPolicyAuditEvent(),
      )).resolves.toEqual(desired)
      const transactionItems = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(transactionItems)) {
        throw new TypeError('Expected transaction items.')
      }
      expect(transactionItems).toHaveLength(4)
      expect(readRecord(readRecord(transactionItems[1]).ConditionCheck).TableName)
        .toBe('mukuroji-workspace-access-local')
      expect(readRecord(readRecord(transactionItems[2]).ConditionCheck).TableName)
        .toBe('EnterpriseIdentityTable')
    } finally {
      harness.restore()
    }
  })

  test('maps a transaction membership fence failure to an authorization conflict', async () => {
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([
      transactionCancellation([undefined, 'ConditionalCheckFailed', undefined]),
    ], 'AuditTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'member-1@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 4,
          workspaceRole: 'admin',
        },
        createPolicyAuditEvent(),
      )).rejects.toMatchObject({
        category: 'authorization',
        code: 'AiAssistanceAuthorizationChanged',
      })
      expect(harness.commands).toHaveLength(1)
    } finally {
      harness.restore()
    }
  })

  test('maps a transaction policy CAS failure to a revision conflict', async () => {
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      {},
    ], 'AuditTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'member-1@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 4,
          workspaceRole: 'admin',
        },
        createPolicyAuditEvent(),
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceRevisionConflict',
      })
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('returns the durable policy when an atomic policy transaction response is lost', async () => {
    const current = createPolicy('2026-08-25T00:00:01.000Z')
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'AI_POLICY#WORKSPACE',
          recordType: 'ai-assistance-policy',
          policy: current,
          mutationFingerprint: createPolicyMutationFingerprint(desired),
        },
      },
    ], 'AuditTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'member-1@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 4,
          workspaceRole: 'admin',
        },
        createPolicyAuditEvent(),
      )).resolves.toEqual(current)
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
        'GetCommand',
      ])
    } finally {
      harness.restore()
    }
  })

  test('does not replay an audited policy mutation for a different member', async () => {
    const current = createPolicy('2026-08-25T00:00:01.000Z')
    const desired = createPolicy('2026-08-25T00:00:02.000Z')
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', undefined, undefined]),
      {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'AI_POLICY#WORKSPACE',
          recordType: 'ai-assistance-policy',
          policy: current,
          mutationFingerprint: createPolicyMutationFingerprint(desired),
        },
      },
    ], 'AuditTable')
    try {
      await expect(harness.store.putPolicyWithAudit(
        'workspace-1',
        'member-2@example.com',
        desired,
        0,
        {
          workspaceMemberVersion: 4,
          workspaceRole: 'admin',
        },
        createPolicyAuditEvent(),
      )).rejects.toMatchObject({
        category: 'conflict',
        code: 'AiAssistanceRevisionConflict',
      })
    } finally {
      harness.restore()
    }
  })

  test('returns the durable preference on a semantically identical CAS replay', async () => {
    const current: AiAssistancePreference = {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      enabled: false,
      revision: 1,
      updatedAt: '2026-08-25T00:00:01.000Z',
    }
    const desired: AiAssistancePreference = {
      ...current,
      updatedAt: '2026-08-25T00:00:02.000Z',
    }
    const recordKey = 'AI_PREF#MEMBER#member-1'
    const harness = createHarness([
      conditionalFailure(),
      {
        Item: {
          workspaceId: 'workspace-1',
          recordKey,
          recordType: 'ai-assistance-preference',
          memberId: 'member-1',
          preference: current,
        },
      },
    ])
    try {
      await expect(harness.store.putPreference('workspace-1', 'member-1', desired, 0))
        .resolves.toEqual(current)
    } finally {
      harness.restore()
    }
  })

  test('commits a preference together with the current member authorization fence', async () => {
    const preference: AiAssistancePreference = {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      enabled: false,
      revision: 1,
      updatedAt: '2026-08-25T00:00:02.000Z',
    }
    const authorizationConditions = [{
      kind: 'workspace-member' as const,
      tableName: 'WorkspaceAccessTable',
      key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#member-1' },
      expectedAttributes: {
        entryType: 'workspace-member',
        status: 'active',
        memberKey: 'member-1',
        role: 'member',
        version: 2,
      },
    }]
    const harness = createHarness([{}])
    try {
      await expect(harness.store.putPreference(
        'workspace-1',
        'member-1',
        preference,
        0,
        authorizationConditions,
      )).resolves.toEqual(preference)
      expect(harness.commands.map((command) => command.name)).toEqual([
        'TransactWriteCommand',
      ])
      const transactionItems = harness.commands[0]?.input.TransactItems
      if (!Array.isArray(transactionItems)) throw new TypeError('Expected transaction items.')
      expect(transactionItems).toHaveLength(2)
      expect(readRecord(readRecord(transactionItems[1]).ConditionCheck).TableName)
        .toBe('WorkspaceAccessTable')
    } finally {
      harness.restore()
    }
  })

  test('keeps preference CAS replay semantics when the authorization fence is present', async () => {
    const current: AiAssistancePreference = {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      enabled: false,
      revision: 1,
      updatedAt: '2026-08-25T00:00:01.000Z',
    }
    const desired: AiAssistancePreference = {
      ...current,
      updatedAt: '2026-08-25T00:00:02.000Z',
    }
    const authorizationConditions = [{
      kind: 'workspace-member' as const,
      tableName: 'WorkspaceAccessTable',
      key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#member-1' },
      expectedAttributes: {
        entryType: 'workspace-member',
        status: 'active',
        memberKey: 'member-1',
        role: 'member',
        version: 2,
      },
    }]
    const harness = createHarness([
      transactionCancellation(['ConditionalCheckFailed', 'None']),
      {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'AI_PREF#MEMBER#member-1',
          recordType: 'ai-assistance-preference',
          memberId: 'member-1',
          preference: current,
        },
      },
    ])
    try {
      await expect(harness.store.putPreference(
        'workspace-1',
        'member-1',
        desired,
        0,
        authorizationConditions,
      )).resolves.toEqual(current)
    } finally {
      harness.restore()
    }
  })
})
