import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type {
  DocumentDetail,
  DocumentOperation,
  DocumentRelationTarget,
  PublicDocument,
} from '@mukuroji/contracts'
import {
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../audit/audit'
import {
  DOCUMENT_MAX_BACKLINK_COUNT,
  DOCUMENT_MAX_ITEM_BYTES,
  createDocumentSearchAccessReadContext,
  DynamoDbDocumentsClient,
  reduceDocumentOperations,
  renderDocumentExport,
  renderPublicDocumentExport,
  validateDocumentPayload,
} from './documents'

const ownerAccess = {
  memberKey: 'owner@example.com',
  workspaceRole: 'owner',
} as const

const ownerShareAccess = {
  ...ownerAccess,
  authorizationGuards: [{
    tableName: 'workspace-access-table',
    key: {
      workspaceId: 'workspace-1',
      recordKey: 'MEMBER#owner@example.com',
    },
    generationAttribute: 'version',
    expectedGeneration: 1,
    requiredAttributes: {
      entryType: 'workspace-member',
      status: 'active',
    },
  }],
} as const

test('preserves a DynamoDB transaction conflict as a storage failure', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  memory.beforeTransaction(() => {
    throw transactionCancellationError([
      'None',
      'TransactionConflict',
    ])
  })

  await expect(client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Transaction conflict',
    blocks: [],
  })).rejects.toMatchObject({
    status: 503,
    code: 'DocumentsStoreError',
  })
})

test('preserves mixed DynamoDB cancellation reasons as a storage failure', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  memory.beforeTransaction(() => {
    throw transactionCancellationError([
      'ConditionalCheckFailed',
      'ProvisionedThroughputExceeded',
    ])
  })

  await expect(client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Mixed cancellation',
    blocks: [],
  })).rejects.toMatchObject({
    status: 503,
    code: 'DocumentsStoreError',
  })
})

test('keeps a pure conditional transaction cancellation as a semantic conflict', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  memory.beforeTransaction(() => {
    throw transactionCancellationError([
      'None',
      'ConditionalCheckFailed',
    ])
  })

  await expect(client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Conditional conflict',
    blocks: [],
  })).rejects.toMatchObject({
    status: 409,
    code: 'DocumentCreateConflict',
  })
})

test('retries transaction conflicts in every bounded document mutation loop', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerShareAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Retryable transaction conflicts',
    blocks: [{
      id: 'block-1',
      type: 'paragraph',
      text: 'Before',
    }],
  })
  let injectedFailures = 0
  const failNextTransaction = (
    cancellationReasonCodes: readonly string[],
  ) => {
    memory.beforeTransaction(() => {
      injectedFailures += 1
      throw transactionCancellationError(
        cancellationReasonCodes,
      )
    })
  }

  failNextTransaction([
    'None',
    'TransactionConflict',
  ])
  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerShareAccess,
    input: {
      baseRevision: document.revision,
      clientId: 'editor-1',
      operations: [{
        operationId:
          'retryable-transaction-operation',
        type: 'update-block',
        blockId: 'block-1',
        block: {
          id: 'block-1',
          type: 'paragraph',
          text: 'After',
        },
      }],
    },
  })).resolves.toMatchObject({
    documentId: document.id,
    revision: 2,
  })

  failNextTransaction([
    'ConditionalCheckFailed',
    'TransactionConflict',
  ])
  await expect(client.updatePreference({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerShareAccess,
    favorite: true,
  })).resolves.toMatchObject({
    documentId: document.id,
    favorite: true,
  })

  failNextTransaction([
    'TransactionConflict',
    'None',
  ])
  await expect(client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    idempotencyKey:
      'retryable-transaction-share',
  })).resolves.toMatchObject({
    share: {
      documentId: document.id,
    },
  })
  expect(injectedFailures).toBe(3)
})

test('returns a storage failure after transaction conflict retries are exhausted', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Transaction conflict exhaustion',
    blocks: [{
      id: 'block-1',
      type: 'paragraph',
      text: 'Before',
    }],
  })
  let attempts = 0
  const rejectTransaction = () => {
    attempts += 1
    memory.beforeTransaction(
      rejectTransaction,
    )
    throw transactionCancellationError([
      'None',
      'TransactionConflict',
    ])
  }
  memory.beforeTransaction(
    rejectTransaction,
  )

  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    input: {
      baseRevision: document.revision,
      clientId: 'editor-1',
      operations: [{
        operationId:
          'transaction-conflict-exhaustion',
        type: 'update-block',
        blockId: 'block-1',
        block: {
          id: 'block-1',
          type: 'paragraph',
          text: 'After',
        },
      }],
    },
  })).rejects.toMatchObject({
    status: 503,
    code: 'DocumentsStoreError',
  })
  expect(attempts).toBe(6)
})

test('does not retry transaction conflicts mixed with non-retryable reasons', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Non-retryable transaction cancellation',
    blocks: [{
      id: 'block-1',
      type: 'paragraph',
      text: 'Before',
    }],
  })
  const reasonSets = [
    [
      'TransactionConflict',
      'ValidationError',
    ],
    [
      'TransactionConflict',
      'ProvisionedThroughputExceeded',
    ],
    [
      'TransactionConflict',
      'UnexpectedReason',
    ],
  ] as const

  for (
    const [index, cancellationReasonCodes] of
      reasonSets.entries()
  ) {
    let attempts = 0
    memory.beforeTransaction(() => {
      attempts += 1
      throw transactionCancellationError(
        cancellationReasonCodes,
      )
    })
    await expect(client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: document.id,
      access: ownerAccess,
      input: {
        baseRevision: document.revision,
        clientId: 'editor-1',
        operations: [{
          operationId:
            `non-retryable-cancellation-${index}`,
          type: 'update-block',
          blockId: 'block-1',
          block: {
            id: 'block-1',
            type: 'paragraph',
            text: 'After',
          },
        }],
      },
    })).rejects.toMatchObject({
      status: 503,
      code: 'DocumentsStoreError',
    })
    expect(attempts).toBe(1)
  }
})

test('merges stale-base operations on independent elements and rejects a same-element conflict atomically', () => {
  const document = createPage()
  const first = reduceDocumentOperations({
    document,
    elementRevisions: { 'block:block-a': 1, 'block:block-b': 1 },
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      type: 'update-block',
      operationId: 'operation-a',
      blockId: 'block-a',
      block: { id: 'block-a', type: 'paragraph', text: 'A2' },
    }],
  })
  const merged = reduceDocumentOperations({
    document: first.document,
    elementRevisions: first.elementRevisions,
    baseRevision: 1,
    nextRevision: 3,
    operations: [{
      type: 'update-block',
      operationId: 'operation-b',
      blockId: 'block-b',
      block: { id: 'block-b', type: 'paragraph', text: 'B2' },
    }],
  })

  expect(merged.document).toMatchObject({
    revision: 3,
    blocks: [
      { id: 'block-a', text: 'A2' },
      { id: 'block-b', text: 'B2' },
    ],
  })
  const beforeConflict = structuredClone(merged.document)
  expect(() => reduceDocumentOperations({
    document: merged.document,
    elementRevisions: merged.elementRevisions,
    baseRevision: 1,
    nextRevision: 4,
    operations: [
      {
        type: 'update-block',
        operationId: 'operation-conflict',
        blockId: 'block-a',
        block: { id: 'block-a', type: 'paragraph', text: 'stale' },
      },
      {
        type: 'update-block',
        operationId: 'operation-would-have-succeeded',
        blockId: 'block-b',
        block: { id: 'block-b', type: 'paragraph', text: 'not applied' },
      },
    ],
  })).toThrow(expect.objectContaining({
    code: 'DocumentOperationConflict',
    status: 409,
    details: {
      conflicts: [
        expect.objectContaining({
          operationId: 'operation-conflict',
          elementType: 'block',
          elementId: 'block-a',
          updatedRevision: 2,
          baseRevision: 1,
        }),
        expect.objectContaining({
          operationId: 'operation-would-have-succeeded',
          elementType: 'block',
          elementId: 'block-b',
          updatedRevision: 3,
          baseRevision: 1,
        }),
      ],
    },
  }))
  expect(merged.document).toEqual(beforeConflict)
})

test('conflicts stale block and object deletion with concurrent source relation updates', () => {
  const page = createPage({
    relations: [{
      id: 'block-relation',
      source: { kind: 'block', blockId: 'block-a' },
      target: { kind: 'goal', goalId: 'goal-1' },
      createdByUserId: 'owner@example.com',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
  })
  const pageRelationUpdated = reduceDocumentOperations({
    document: page,
    elementRevisions: {
      'block:block-a': 1,
      'block:block-b': 1,
      'relation:block-relation': 1,
    },
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      type: 'upsert-relation',
      operationId: 'update-block-relation',
      relation: {
        ...page.relations[0]!,
        target: { kind: 'goal', goalId: 'goal-2' },
      },
    }],
  })
  expect(() => reduceDocumentOperations({
    document: pageRelationUpdated.document,
    elementRevisions: pageRelationUpdated.elementRevisions,
    baseRevision: 1,
    nextRevision: 3,
    operations: [{
      type: 'delete-block',
      operationId: 'stale-delete-block',
      blockId: 'block-a',
    }],
  })).toThrow(expect.objectContaining({
    code: 'DocumentOperationConflict',
    details: {
      conflicts: [
        expect.objectContaining({
          operationId: 'stale-delete-block',
          elementType: 'relation',
          elementId: 'block-relation',
          updatedRevision: 2,
        }),
      ],
    },
  }))
  const pageDeleted = reduceDocumentOperations({
    document: pageRelationUpdated.document,
    elementRevisions: pageRelationUpdated.elementRevisions,
    baseRevision: 2,
    nextRevision: 3,
    operations: [{
      type: 'delete-block',
      operationId: 'delete-block',
      blockId: 'block-a',
    }],
  })
  expect(pageDeleted.document.relations).toEqual([])
  expect(pageDeleted.elementRevisions['relation:block-relation']).toBe(3)

  const whiteboard = createWhiteboard()
  whiteboard.relations = [{
    id: 'object-relation',
    source: { kind: 'whiteboard-object', objectId: 'object-1' },
    target: { kind: 'project', projectId: 'project-1' },
    createdByUserId: 'owner@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
  }]
  const objectRelationUpdated = reduceDocumentOperations({
    document: whiteboard,
    elementRevisions: {
      'object:object-1': 1,
      'relation:object-relation': 1,
    },
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      type: 'upsert-relation',
      operationId: 'update-object-relation',
      relation: {
        ...whiteboard.relations[0]!,
        target: { kind: 'project', projectId: 'project-2' },
      },
    }],
  })
  expect(() => reduceDocumentOperations({
    document: objectRelationUpdated.document,
    elementRevisions: objectRelationUpdated.elementRevisions,
    baseRevision: 1,
    nextRevision: 3,
    operations: [{
      type: 'delete-object',
      operationId: 'stale-delete-object',
      objectId: 'object-1',
    }],
  })).toThrow(expect.objectContaining({
    code: 'DocumentOperationConflict',
    details: {
      conflicts: [
        expect.objectContaining({
          operationId: 'stale-delete-object',
          elementType: 'relation',
          elementId: 'object-relation',
          updatedRevision: 2,
        }),
      ],
    },
  }))
  const objectDeleted = reduceDocumentOperations({
    document: objectRelationUpdated.document,
    elementRevisions: objectRelationUpdated.elementRevisions,
    baseRevision: 2,
    nextRevision: 3,
    operations: [{
      type: 'delete-object',
      operationId: 'delete-object',
      objectId: 'object-1',
    }],
  })
  expect(objectDeleted.document.relations).toEqual([])
  expect(objectDeleted.elementRevisions['relation:object-relation']).toBe(3)
})

test('stores operation receipts for idempotent retry and rejects operation ID reuse', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Operations',
    blocks: [
      { id: 'block-a', type: 'paragraph', text: 'A1' },
      { id: 'block-b', type: 'paragraph', text: 'B1' },
    ],
  })
  const firstInput = {
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: { id: 'block-a', type: 'paragraph', text: 'A2' },
      }] satisfies DocumentOperation[],
    },
  }
  const mixedInput = {
    ...firstInput,
    input: {
      ...firstInput.input,
      operations: [
        ...firstInput.input.operations,
        {
          type: 'update-block',
          operationId:
            'operation-pending',
          blockId: 'block-b',
          block: {
            id: 'block-b',
            type: 'paragraph',
            text: 'B pending',
          },
        },
      ] satisfies DocumentOperation[],
    },
  }

  const first = await client.applyOperations(firstInput)
  const preflightReplay =
    await client.prepareOperations(firstInput)
  const mixedPreflight =
    await client.prepareOperations(
      mixedInput,
    )
  const retry = await client.applyOperations(firstInput)
  const merged =
    await client.applyOperations(mixedInput)
  const mixedReplay =
    await client.prepareOperations(mixedInput)
  const lateRetry = await client.applyOperations(firstInput)

  expect(first.revision).toBe(2)
  expect(preflightReplay).toEqual({
    replay: first,
  })
  expect(mixedPreflight).toEqual({
    pendingInput: {
      ...firstInput.input,
      operations: [{
        type: 'update-block',
        operationId: 'operation-pending',
        blockId: 'block-b',
        block: {
          id: 'block-b',
          type: 'paragraph',
          text: 'B pending',
        },
      }],
    },
  })
  expect(retry.revision).toBe(2)
  expect(merged.revision).toBe(3)
  expect(mixedReplay).toEqual({
    replay: merged,
  })
  expect(lateRetry.revision).toBe(2)
  expect(memory.items().filter(({ entryType }) => entryType === 'document-version')).toHaveLength(3)
  expect(memory.items().filter(({ entryType }) => entryType === 'document-operation')).toHaveLength(2)
  await expect(client.applyOperations({
    ...firstInput,
    input: {
      ...firstInput.input,
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: { id: 'block-a', type: 'paragraph', text: 'different payload' },
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentOperationIdempotencyConflict',
    status: 409,
  })
  await expect(client.applyOperations({
    ...firstInput,
    input: {
      baseRevision: 1,
      clientId: 'editor-3',
      operations: [{
        type: 'update-block',
        operationId: 'operation-3',
        blockId: 'block-a',
        block: { id: 'block-a', type: 'paragraph', text: 'stale edit' },
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentOperationConflict',
    status: 409,
  })
})

test('reuses an operation ID after its retained receipt has logically expired', async () => {
  const memory = createMemoryDocumentClient()
  let now = new Date('2026-07-18T00:00:00.000Z')
  const client = createClient(memory, () => now)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Expired operation receipt',
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'A1',
    }],
  })

  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'reusable-operation',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'A2',
        },
      }],
    },
  })

  now = new Date('2026-08-18T00:00:00.000Z')
  const reused = await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 2,
      clientId: 'editor-2',
      operations: [{
        type: 'update-block',
        operationId: 'reusable-operation',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'A3',
        },
      }],
    },
  })

  expect(reused.revision).toBe(3)
  expect(
    memory.items().filter(
      ({ entryType }) =>
        entryType === 'document-operation',
    ),
  ).toEqual([
    expect.objectContaining({
      clientId: 'editor-2',
      operationId: 'reusable-operation',
      revision: 3,
      createdAt: now.toISOString(),
      expiresAtEpoch:
        Math.floor(now.getTime() / 1_000) +
        30 * 24 * 60 * 60,
    }),
  ])
})

test('rejects an operation receipt that expires after API preflight', async () => {
  const memory = createMemoryDocumentClient()
  let now = new Date(
    '2026-07-18T00:00:00.000Z',
  )
  const client = createClient(
    memory,
    () => now,
  )
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Receipt expiry boundary',
    blocks: [
      {
        id: 'block-a',
        type: 'paragraph',
        text: 'A1',
      },
      {
        id: 'block-b',
        type: 'paragraph',
        text: 'B1',
      },
    ],
  })
  const committedOperation:
    DocumentOperation = {
      type: 'update-block',
      operationId: 'committed-operation',
      blockId: 'block-a',
      block: {
        id: 'block-a',
        type: 'paragraph',
        text: 'A2',
      },
    }
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [
        committedOperation,
      ],
    },
  })
  const pendingOperation:
    DocumentOperation = {
      type: 'update-block',
      operationId: 'pending-operation',
      blockId: 'block-b',
      block: {
        id: 'block-b',
        type: 'paragraph',
        text: 'B2',
      },
    }
  const receipt = memory.items().find(
    (item) =>
      item.entryType ===
        'document-operation' &&
      item.operationId ===
        committedOperation.operationId,
  )
  const expiresAtEpoch =
    receipt?.expiresAtEpoch
  expect(
    typeof expiresAtEpoch,
  ).toBe('number')
  now = new Date(
    Number(expiresAtEpoch) * 1_000 - 1,
  )
  const input = {
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [
        committedOperation,
        pendingOperation,
      ],
    },
  }
  await expect(
    client.prepareOperations(input),
  ).resolves.toMatchObject({
    pendingInput: {
      operations: [
        pendingOperation,
      ],
    },
  })

  now = new Date(
    Number(expiresAtEpoch) * 1_000,
  )
  await expect(
    client.applyOperations({
      ...input,
      validatedPendingOperationIds: [
        pendingOperation.operationId,
      ],
    }),
  ).rejects.toMatchObject({
    code:
      'DocumentOperationPreflightChanged',
    status: 409,
  })
  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
  })).resolves.toMatchObject({
    revision: 2,
    blocks: [
      expect.objectContaining({
        id: 'block-a',
        text: 'A2',
      }),
      expect.objectContaining({
        id: 'block-b',
        text: 'B1',
      }),
    ],
  })
})

test('binds Goal validation revisions to create, update, version restore, and archive restore commits', async () => {
  {
    const memory =
      createMemoryDocumentClient()
    seedPlanningAuthorization(memory, 1)
    const client = createClient(memory)
    memory.beforeTransaction(() => {
      seedPlanningAuthorization(memory, 2)
    })

    await expect(client.create({
      workspaceId: 'workspace-1',
      access: ownerAccess,
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Guarded create',
      blocks: [],
      relations: [
        createGoalRelation('goal-create'),
      ],
      relationTargetAuthorizationGuards: [
        planningAuthorizationGuard(1),
      ],
    })).rejects.toMatchObject({
      code: 'DocumentAuthorizationChanged',
      status: 409,
    })
    expect(
      memory.items().filter(
        ({ entryType }) =>
          entryType === 'document',
      ),
    ).toEqual([])
  }

  {
    const memory =
      createMemoryDocumentClient()
    const client = createClient(memory)
    const created = await client.create({
      workspaceId: 'workspace-1',
      access: ownerAccess,
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Guarded update',
      blocks: [],
    })
    seedPlanningAuthorization(memory, 1)
    memory.beforeTransaction(() => {
      seedPlanningAuthorization(memory, 2)
    })

    await expect(client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      input: {
        baseRevision: 1,
        clientId: 'editor-1',
        operations: [{
          operationId:
            'guarded-goal-update',
          type: 'upsert-relation',
          relation:
            createGoalRelation(
              'goal-update',
            ),
        }],
      },
      relationTargetAuthorizationGuards: [
        planningAuthorizationGuard(1),
      ],
    })).rejects.toMatchObject({
      code: 'DocumentAuthorizationChanged',
      status: 409,
    })
    expect(await client.get({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
    })).toMatchObject({
      revision: 1,
      relations: [],
    })
    expect(
      memory.items().filter(
        ({ entryType }) =>
          entryType ===
            'document-operation',
      ),
    ).toEqual([])
  }

  {
    const memory =
      createMemoryDocumentClient()
    const client = createClient(memory)
    const created = await client.create({
      workspaceId: 'workspace-1',
      access: ownerAccess,
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Guarded version restore',
      blocks: [],
      relations: [
        createGoalRelation('goal-version'),
      ],
    })
    const removed = await client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      input: {
        baseRevision: 1,
        clientId: 'editor-1',
        operations: [{
          operationId:
            'remove-version-goal',
          type: 'delete-relation',
          relationId:
            'relation-goal-version',
        }],
      },
    })
    seedPlanningAuthorization(memory, 1)
    memory.beforeTransaction(() => {
      seedPlanningAuthorization(memory, 2)
    })

    await expect(client.restoreVersion({
      workspaceId: 'workspace-1',
      documentId: created.id,
      versionId: `${created.id}:1`,
      expectedRevision: removed.revision,
      access: ownerAccess,
      validateRelationTargets: async () => [
        planningAuthorizationGuard(1),
      ],
    })).rejects.toMatchObject({
      code: 'DocumentAuthorizationChanged',
      status: 409,
    })
    expect(await client.get({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
    })).toMatchObject({
      revision: 2,
      relations: [],
    })
  }

  {
    const memory =
      createMemoryDocumentClient()
    const client = createClient(memory)
    const created = await client.create({
      workspaceId: 'workspace-1',
      access: ownerAccess,
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Guarded archive restore',
      blocks: [],
      relations: [
        createGoalRelation('goal-archive'),
      ],
    })
    const archived = await client.archive({
      workspaceId: 'workspace-1',
      documentId: created.id,
      expectedRevision: 1,
      access: ownerAccess,
    })
    seedPlanningAuthorization(memory, 1)
    memory.beforeTransaction(() => {
      seedPlanningAuthorization(memory, 2)
    })

    await expect(client.restoreArchived({
      workspaceId: 'workspace-1',
      documentId: created.id,
      expectedRevision: archived.revision,
      access: ownerAccess,
      relationTargetAuthorizationGuards: [
        planningAuthorizationGuard(1),
      ],
    })).rejects.toMatchObject({
      code: 'DocumentAuthorizationChanged',
      status: 409,
    })
    expect(await client.get({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      includeArchived: true,
    })).toMatchObject({
      revision: 2,
      archivedAt:
        '2026-07-18T00:00:00.000Z',
    })
  }
})

test('compacts deleted element revisions while rejecting bases older than the conflict floor', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Compaction',
    blocks: [{ id: 'block-live', type: 'paragraph', text: 'live' }],
  })
  let revision = created.revision
  const firstInsert = {
    baseRevision: revision,
    clientId: 'compaction-editor',
    operations: [{
      block: {
        id: 'temporary-0',
        type: 'paragraph' as const,
        text: 'temporary',
      },
      index: 1,
      operationId: 'insert-temporary-0',
      type: 'insert-block' as const,
    }],
  }
  for (let index = 0; index < 70; index += 1) {
    const blockId = `temporary-${index}`
    const inserted = await client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      input:
        index === 0
          ? firstInsert
          : {
              baseRevision: revision,
              clientId: 'compaction-editor',
              operations: [{
                block: {
                  id: blockId,
                  type: 'paragraph',
                  text: 'temporary',
                },
                index: 1,
                operationId: `insert-${blockId}`,
                type: 'insert-block',
              }],
            },
    })
    revision = inserted.revision
    const deleted = await client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      input: {
        baseRevision: revision,
        clientId: 'compaction-editor',
        operations: [{
          blockId,
          operationId: `delete-${blockId}`,
          type: 'delete-block',
        }],
      },
    })
    revision = deleted.revision
  }

  const stored = memory.items().find(
    ({ entryType }) => entryType === 'document',
  )
  expect(
    Object.keys(
      stored?.elementRevisions as Record<string, number>,
    ).length,
  ).toBeLessThan(20)
  expect(stored?.operationConflictFloorRevision).toBeGreaterThan(1)
  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'stale-editor',
      operations: [{
        block: {
          id: 'temporary-0',
          type: 'paragraph',
          text: 'stale resurrection',
        },
        index: 1,
        operationId: 'stale-resurrection',
        type: 'insert-block',
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentOperationHistoryCompacted',
    status: 409,
  })
  const replayed = await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: firstInsert,
  })
  expect(replayed.revision).toBe(2)
})

test('creates an immutable version for every mutation and restores an old snapshot as a new revision', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Versions',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'original' }],
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: { id: 'block-a', type: 'paragraph', text: 'edited' },
      }],
    },
  })

  const restored = await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    versionId: `${created.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async () => undefined,
  })
  const versions = await client.listVersions({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
  })

  expect(restored).toMatchObject({
    revision: 3,
    blocks: [{ id: 'block-a', text: 'original' }],
  })
  expect(versions.versions.map(({ revision, reason }) => ({ revision, reason }))).toEqual([
    { revision: 3, reason: 'restore' },
    { revision: 2, reason: 'edit' },
    { revision: 1, reason: 'create' },
  ])
})

test('stores operation deltas with retention and periodically compacts them into restorable snapshots', async () => {
  const memory = createMemoryDocumentClient()
  let currentTime =
    new Date('2026-07-18T00:00:00.000Z')
  const client = createClient(
    memory,
    () => currentTime,
  )
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Compact versions',
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'original',
    }],
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'edited',
        },
      }],
    },
  })

  expect(
    memory.items().filter(
      ({ entryType }) =>
        entryType ===
          'document-version-snapshot',
    ),
  ).toHaveLength(1)
  expect(
    memory.items().filter(
      ({ entryType }) =>
        entryType === 'document-version-delta',
    ),
  ).toEqual([
    expect.objectContaining({
      baseRevision: 1,
      expiresAtEpoch:
        expect.any(Number),
      version: expect.objectContaining({
        revision: 2,
      }),
      operations: [
        expect.objectContaining({
          operationId: 'operation-1',
        }),
      ],
    }),
  ])
  expect(
    memory.items().find(
      ({ entryType }) =>
        entryType === 'document-operation',
    ),
  ).toEqual(expect.objectContaining({
    expiresAtEpoch: expect.any(Number),
  }))

  currentTime =
    new Date('2026-07-19T01:00:00.000Z')
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 2,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-2',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'edited later',
        },
      }],
    },
  })
  expect(
    memory.items()
      .filter(
        ({ entryType }) =>
          entryType ===
            'document-version-snapshot',
      )
      .map(
        ({ version }) =>
          (
            version as {
              revision: number
            }
          ).revision,
      )
      .sort(),
  ).toEqual([1, 3])

  const restored = await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    versionId: `${created.id}:2`,
    expectedRevision: 3,
    validateRelationTargets:
      async () => undefined,
  })
  expect(restored).toMatchObject({
    revision: 4,
    blocks: [{
      id: 'block-a',
      text: 'edited',
    }],
  })
})

test('reconstructs retained version deltas across paginated Query results', async () => {
  const memory =
    createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Paginated versions',
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'revision 1',
    }],
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'revision 2',
        },
      }],
    },
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 2,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-2',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'revision 3',
        },
      }],
    },
  })

  memory.setQueryPageSize(1)
  const restored =
    await client.restoreVersion({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      versionId: `${created.id}:3`,
      expectedRevision: 3,
      validateRelationTargets:
        async () => undefined,
    })

  expect(restored).toMatchObject({
    revision: 4,
    blocks: [{
      id: 'block-a',
      text: 'revision 3',
    }],
  })
})

test('revalidates relation and Whiteboard Work Item targets before restoring a snapshot', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const relationTarget = {
    kind: 'project' as const,
    projectId: 'project-1',
  }
  const workItemTarget = {
    kind: 'work-item' as const,
    workItemId: 'team/team-a/issue/work-item-1',
  }
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'whiteboard',
    scope: { type: 'workspace' },
    title: 'Restore targets',
    relations: [{
      id: 'relation-project',
      source: { kind: 'document' },
      target: relationTarget,
      createdByUserId: ownerAccess.memberKey,
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
    whiteboard: {
      objects: [{
        id: 'card-1',
        type: 'work-item',
        workItemId: workItemTarget.workItemId,
        bounds: {
          x: 0,
          y: 0,
          width: 200,
          height: 100,
        },
        zIndex: 1,
      }],
      connectors: [],
      frames: [],
    },
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [
        {
          type: 'delete-object',
          operationId: 'delete-card',
          objectId: 'card-1',
        },
        {
          type: 'delete-relation',
          operationId: 'delete-project-relation',
          relationId: 'relation-project',
        },
      ],
    },
  })
  await expect(client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    versionId: `${created.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async () => {
      throw new Error('target access denied')
    },
  })).rejects.toThrow('target access denied')
  expect(await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
  })).toMatchObject({
    revision: 2,
    relations: [],
    whiteboard: { objects: [] },
  })
  const validatedTargets: DocumentRelationTarget[] = []

  await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    versionId: `${created.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async (targets) => {
      validatedTargets.push(...targets)
    },
  })

  expect(validatedTargets).toEqual([
    relationTarget,
    workItemTarget,
  ])
})

test('records restore deletions as tombstones against stale element edits', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Restore conflict',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'original' }],
  })
  const relation = {
    id: 'relation-added',
    source: { kind: 'document' as const },
    target: { kind: 'goal' as const, goalId: 'goal-1' },
    createdByUserId: ownerAccess.memberKey,
    createdAt: '2026-07-18T00:00:00.000Z',
  }
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-a',
      operations: [{
        operationId: 'add-relation',
        relation,
        type: 'upsert-relation',
      }],
    },
  })
  await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    versionId: `${created.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async () => undefined,
  })

  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 2,
      clientId: 'editor-a',
      operations: [{
        operationId: 'stale-relation-retry',
        relation,
        type: 'upsert-relation',
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentOperationConflict',
    details: {
      conflicts: [
        expect.objectContaining({
          elementId: relation.id,
          elementType: 'relation',
          updatedRevision: 3,
        }),
      ],
    },
    status: 409,
  })
})

test('restores an explicitly managed child without requiring private parent access', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const bobAccess = {
    memberKey: 'bob@example.com',
    workspaceRole: 'member' as const,
  }
  const aliceAccess = {
    memberKey: 'alice@example.com',
    workspaceRole: 'member' as const,
  }
  const parent = await client.create({
    workspaceId: 'workspace-1',
    access: bobAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Bob private folder',
    permission: { mode: 'private', memberGrants: [] },
  })
  const child = await client.create({
    workspaceId: 'workspace-1',
    access: bobAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: parent.id,
    title: 'Alice managed child',
    permission: {
      mode: 'inherit',
      memberGrants: [{
        memberKey: aliceAccess.memberKey,
        role: 'manager',
      }],
    },
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'original' }],
  })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: aliceAccess,
    input: {
      baseRevision: 1,
      clientId: 'alice-editor',
      operations: [{
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'changed',
        },
        blockId: 'block-a',
        operationId: 'alice-change',
        type: 'update-block',
      }],
    },
  })

  const restoredVersion = await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: aliceAccess,
    versionId: `${child.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async () => undefined,
  })
  expect(restoredVersion.revision).toBe(3)
  const archived = await client.archive({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: aliceAccess,
    expectedRevision: 3,
  })
  const restoredArchive = await client.restoreArchived({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: aliceAccess,
    expectedRevision: archived.revision,
  })
  expect(restoredArchive.archivedAt).toBeUndefined()
  expect(restoredArchive.parentId).toBe(parent.id)
})

test('reuses deterministic cloned block IDs when template instantiation is retried', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const template = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'template',
    scope: { type: 'workspace' },
    title: 'Launch brief',
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: 'template-viewer@example.com',
        role: 'viewer',
      }],
    },
    blocks: [{
      id: 'source-heading',
      level: 1,
      text: 'Launch',
      type: 'heading',
    }],
  })
  const input = {
    workspaceId: 'workspace-1',
    templateId: template.id,
    access: ownerAccess,
    scope: { type: 'workspace' as const },
    permission: {
      mode: 'private' as const,
      memberGrants: [{
        memberKey:
          'page-viewer@example.com',
        role: 'viewer' as const,
      }],
    },
    idempotencyKey: 'instantiate-template-request-1',
  }

  const created = await client.instantiateTemplate(input)
  await client.update({
    workspaceId: 'workspace-1',
    documentId: template.id,
    access: ownerAccess,
    expectedRevision: 1,
    title: 'Changed launch brief',
  })
  const retried = await client.instantiateTemplate(input)

  expect(retried).toEqual(created)
  expect(created.kind).toBe('page')
  expect(created.permission).toEqual({
    mode: 'private',
    memberGrants: [
      {
        memberKey:
          'page-viewer@example.com',
        role: 'viewer',
      },
      {
        memberKey: ownerAccess.memberKey,
        role: 'manager',
      },
    ],
  })
  expect(
    created.kind === 'page' ? created.blocks[0]?.id : undefined,
  ).toMatch(/^block_[a-f0-9]{32}$/u)
  expect(
    memory.items().filter(
      ({ entryType }) => entryType === 'document',
    ),
  ).toHaveLength(2)
  await expect(
    client.instantiateTemplate({
      ...input,
      permission: {
        mode: 'inherit',
        memberGrants: [],
      },
    }),
  ).rejects.toMatchObject({
    code: 'DocumentCreateIdempotencyConflict',
    status: 409,
  })
})

test('does not reveal an idempotent create result after the actor loses private access', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const aliceAccess = {
    memberKey: 'alice@example.com',
    workspaceRole: 'member' as const,
  }
  const bobAccess = {
    memberKey: 'bob@example.com',
    workspaceRole: 'member' as const,
  }
  const input = {
    workspaceId: 'workspace-1',
    access: aliceAccess,
    kind: 'page' as const,
    scope: { type: 'workspace' as const },
    title: 'Private retry',
    blocks: [{ id: 'block-a', type: 'paragraph' as const, text: 'secret' }],
    permission: {
      mode: 'private' as const,
      memberGrants: [{
        memberKey: bobAccess.memberKey,
        role: 'manager' as const,
      }],
    },
    idempotencyKey: 'private-create-request-1',
  }
  const created = await client.create(input)
  await client.update({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: bobAccess,
    expectedRevision: 1,
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: bobAccess.memberKey,
        role: 'manager',
      }],
    },
  })

  await expect(client.create(input)).rejects.toMatchObject({
    code: 'DocumentViewDenied',
    status: 403,
  })
})

test('allows an editor to restore content without rolling back current ACL metadata', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Original title',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'original content' }],
  })
  const current = await client.update({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    expectedRevision: 1,
    title: 'Current title',
    permission: {
      mode: 'private',
      memberGrants: [{ memberKey: 'editor@example.com', role: 'editor' }],
    },
  })
  const currentPermission = structuredClone(current.permission)

  const restored = await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'editor@example.com',
      workspaceRole: 'member',
    },
    versionId: `${created.id}:1`,
    expectedRevision: 2,
    validateRelationTargets: async () => undefined,
  })

  expect(restored.title).toBe('Original title')
  expect(restored.permission).toEqual({
    mode: 'private',
    memberGrants: [],
  })
  expect(restored.capabilities.canEdit).toBeTrue()
  const storedDocument = memory.items().find(
    ({ entryType }) => entryType === 'document',
  )?.document as DocumentDetail
  expect(storedDocument.permission).toEqual(currentPermission)
  expect(storedDocument.permission).not.toEqual(created.permission)
})

test('redacts member grants after ACL evaluation while preserving manager visibility', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Private ACL',
    permission: {
      mode: 'private',
      memberGrants: [
        { memberKey: 'viewer@example.com', role: 'viewer' },
        { memberKey: 'guest@example.com', role: 'viewer' },
        { memberKey: 'editor@example.com', role: 'editor' },
        { memberKey: 'manager@example.com', role: 'manager' },
      ],
    },
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'private' }],
  })

  const viewer = await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'viewer@example.com',
      workspaceRole: 'member',
    },
  })
  const guest = await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'guest@example.com',
      workspaceRole: 'guest',
    },
  })
  const editor = await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'editor@example.com',
      workspaceRole: 'member',
    },
  })
  const manager = await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'manager@example.com',
      workspaceRole: 'member',
    },
  })

  expect(manager.capabilities.canManagePermissions).toBeTrue()
  expect(manager.permission).toEqual(created.permission)
  expect(viewer.capabilities).toMatchObject({
    canView: true,
    canEdit: false,
    canManagePermissions: false,
  })
  expect(guest.capabilities).toMatchObject({
    canView: true,
    canEdit: false,
    canComment: false,
    canManagePermissions: false,
  })
  expect(editor.capabilities).toMatchObject({
    canView: true,
    canEdit: true,
    canManagePermissions: false,
  })
  for (const document of [viewer, guest, editor]) {
    expect(document.permission).toEqual({
      mode: 'private',
      memberGrants: [],
    })
  }
})

test('counts only active children visible to the current viewer in detail and tree projections', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const root = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Root',
  })
  const visible = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: root.id,
    title: 'Visible child',
    blocks: [],
  })
  const hidden = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: root.id,
    title: 'Hidden child',
    permission: { mode: 'private', memberGrants: [] },
    blocks: [],
  })
  const viewerAccess = {
    memberKey: 'member@example.com',
    workspaceRole: 'member',
  } as const

  const detail = await client.get({
    workspaceId: 'workspace-1',
    documentId: root.id,
    access: viewerAccess,
  })
  const tree = await client.list({
    workspaceId: 'workspace-1',
    access: viewerAccess,
  })
  const managerDetail = await client.get({
    workspaceId: 'workspace-1',
    documentId: root.id,
    access: ownerAccess,
  })

  expect(detail).toMatchObject({ id: root.id, childCount: 1 })
  expect(tree.nodes.find(({ id }) => id === root.id)).toMatchObject({
    childCount: 1,
  })
  expect(tree.nodes.map(({ id }) => id)).toContain(visible.id)
  expect(tree.nodes.map(({ id }) => id)).not.toContain(hidden.id)
  expect(managerDetail).toMatchObject({ id: root.id, childCount: 2 })
})

test('rejects a parent update that would create a folder cycle', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const root = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Root',
  })
  const child = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    parentId: root.id,
    title: 'Child',
  })

  await expect(client.update({
    workspaceId: 'workspace-1',
    documentId: root.id,
    access: ownerAccess,
    expectedRevision: 1,
    parentId: child.id,
  })).rejects.toMatchObject({
    code: 'DocumentTreeCycle',
    status: 409,
  })
})

test('serializes reciprocal folder moves so concurrent validation cannot create a cycle', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const first = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'First',
  })
  const second = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Second',
  })

  const results = await Promise.allSettled([
    client.update({
      workspaceId: 'workspace-1',
      documentId: first.id,
      access: ownerAccess,
      expectedRevision: 1,
      parentId: second.id,
    }),
    client.update({
      workspaceId: 'workspace-1',
      documentId: second.id,
      access: ownerAccess,
      expectedRevision: 1,
      parentId: first.id,
    }),
  ])

  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  const latestFirst = await client.get({
    workspaceId: 'workspace-1',
    documentId: first.id,
    access: ownerAccess,
  })
  const latestSecond = await client.get({
    workspaceId: 'workspace-1',
    documentId: second.id,
    access: ownerAccess,
  })
  expect(
    latestFirst.parentId === second.id &&
      latestSecond.parentId === first.id,
  ).toBeFalse()
  expect(memory.items()).toContainEqual(expect.objectContaining({
    entryType: 'document-tree-revision',
    revision: 1,
  }))
})

test('serializes child creation against a concurrent parent scope change', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const access = {
    ...ownerAccess,
    projectRoles: { 'project-1': 'manager' as const },
  }
  const folder = await client.create({
    workspaceId: 'workspace-1',
    access,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Scope race',
  })

  const results = await Promise.allSettled([
    client.update({
      workspaceId: 'workspace-1',
      documentId: folder.id,
      access,
      expectedRevision: 1,
      scope: { type: 'project', projectId: 'project-1' },
    }),
    client.create({
      workspaceId: 'workspace-1',
      access,
      kind: 'page',
      scope: { type: 'workspace' },
      parentId: folder.id,
      title: 'Concurrent child',
      blocks: [],
    }),
  ])

  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  const currentRows = memory.items().filter(
    ({ entryType }) => entryType === 'document',
  )
  const storedFolder = currentRows.find(
    ({ documentId }) => documentId === folder.id,
  )?.document as DocumentDetail
  const storedChild = currentRows
    .map(({ document }) => document as DocumentDetail)
    .find(({ parentId }) => parentId === folder.id)
  if (storedChild !== undefined) {
    expect(storedChild.scope).toEqual(storedFolder.scope)
  }
})

test('requires destination scope manager access for scope and tree moves', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const projectManager = {
    memberKey: 'manager@example.com',
    workspaceRole: 'member',
    projectRoles: {
      'project-1': 'manager',
      'project-2': 'viewer',
    },
  } as const
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: projectManager,
    kind: 'page',
    scope: { type: 'project', projectId: 'project-1' },
    title: 'Project document',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })

  await expect(client.update({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: projectManager,
    expectedRevision: 1,
    scope: { type: 'workspace' },
  })).rejects.toMatchObject({
    code: 'DocumentDestinationScopeDenied',
    status: 403,
  })
  await expect(client.update({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: projectManager,
    expectedRevision: 1,
    scope: { type: 'project', projectId: 'project-2' },
  })).rejects.toMatchObject({
    code: 'DocumentDestinationScopeDenied',
    status: 403,
  })
})

test('hides an archived folder subtree from active and includeArchived detail reads until restore', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const folder = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Folder',
  })
  const child = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: folder.id,
    title: 'Child',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  const archived = await client.archive({
    workspaceId: 'workspace-1',
    documentId: folder.id,
    access: ownerAccess,
    expectedRevision: 1,
  })

  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerAccess,
  })).rejects.toMatchObject({ code: 'DocumentNotFound', status: 404 })
  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerAccess,
    includeArchived: true,
  })).rejects.toMatchObject({ code: 'DocumentNotFound', status: 404 })
  expect((await client.list({
    workspaceId: 'workspace-1',
    access: ownerAccess,
  })).nodes).toEqual([])

  await client.restoreArchived({
    workspaceId: 'workspace-1',
    documentId: folder.id,
    access: ownerAccess,
    expectedRevision: archived.revision,
  })
  expect(await client.get({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerAccess,
  })).toMatchObject({ id: child.id, title: 'Child' })
})

test('indexes Whiteboard work-item cards as transactional backlinks', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'whiteboard',
    scope: { type: 'workspace' },
    title: 'Work items',
    whiteboard: {
      objects: [{
        id: 'card-1',
        type: 'work-item',
        workItemId: 'team/team-a/issue/work-item-1',
        bounds: { x: 0, y: 0, width: 200, height: 100 },
        zIndex: 1,
      }],
      connectors: [],
      frames: [],
    },
  })
  expect(await client.listBacklinks({
    workspaceId: 'workspace-1',
    targetKind: 'work-item',
    targetId: 'team/team-a/issue/work-item-1',
    access: ownerAccess,
  })).toEqual({
    backlinks: [expect.objectContaining({
      documentId: created.id,
      relation: expect.objectContaining({
        source: { kind: 'whiteboard-object', objectId: 'card-1' },
        target: {
          kind: 'work-item',
          workItemId: 'team/team-a/issue/work-item-1',
        },
      }),
    })],
    nextCursor: undefined,
  })

  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-object',
        operationId: 'update-card',
        objectId: 'card-1',
        object: {
          id: 'card-1',
          type: 'work-item',
          workItemId: 'team/team-a/issue/work-item-2',
          bounds: { x: 0, y: 0, width: 200, height: 100 },
          zIndex: 1,
        },
      }],
    },
  })
  expect(await client.listBacklinks({
    workspaceId: 'workspace-1',
    targetKind: 'work-item',
    targetId: 'team/team-a/issue/work-item-1',
    access: ownerAccess,
  })).toEqual({
    backlinks: [],
    nextCursor: undefined,
  })
  expect(await client.listBacklinks({
    workspaceId: 'workspace-1',
    targetKind: 'work-item',
    targetId: 'team/team-a/issue/work-item-2',
    access: ownerAccess,
  })).toMatchObject({
    backlinks: [expect.objectContaining({
      documentId: created.id,
    })],
  })

  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 2,
      clientId: 'editor-1',
      operations: [{
        type: 'delete-object',
        operationId: 'delete-card',
        objectId: 'card-1',
      }],
    },
  })
  expect(await client.listBacklinks({
    workspaceId: 'workspace-1',
    targetKind: 'work-item',
    targetId: 'team/team-a/issue/work-item-2',
    access: ownerAccess,
  })).toEqual({
    backlinks: [],
    nextCursor: undefined,
  })
})

test('coalesces Work Item backlink counts, retains archived links, and tombstones only after unlink', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const workItemId =
    'team/team-a/issue/work-item-fenced'
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Fenced backlinks',
    blocks: [],
    relations: [
      createWorkItemRelation(
        'relation-a',
        workItemId,
      ),
      createWorkItemRelation(
        'relation-b',
        workItemId,
      ),
    ],
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 2,
    version: 1,
  })

  const archived = await client.archive({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    expectedRevision: created.revision,
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 2,
    version: 1,
  })
  const restored =
    await client.restoreArchived({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerAccess,
      expectedRevision: archived.revision,
    })
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: restored.revision,
      clientId: 'editor-1',
      operations: [
        {
          type: 'delete-relation',
          operationId: 'unlink-a',
          relationId: 'relation-a',
        },
        {
          type: 'delete-relation',
          operationId: 'unlink-b',
          relationId: 'relation-b',
        },
      ],
    },
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 0,
    version: 2,
  })

  const deletionFence =
    await client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      })
  await memory.client.send(
    new TransactWriteCommand({
      TransactItems: [
        deletionFence.transactWriteItem,
      ],
    }),
  )
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 0,
    version: 3,
    deletedAt:
      '2026-07-18T00:00:00.000Z',
  })

  await expect(client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Late backlink',
    blocks: [],
    relations: [
      createWorkItemRelation(
        'late-relation',
        workItemId,
      ),
    ],
  })).rejects.toMatchObject({
    status: 409,
    code: 'DocumentRelationTargetDeleted',
  })
})

test('requires a canonical Work Item ID when preparing a deletion fence', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)

  await expect(
    client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId: 'issue-1',
      }),
  ).rejects.toMatchObject({
    status: 400,
    code: 'InvalidDocumentRelationTarget',
  })
  expect(memory.readKeys()).toEqual([])
})

test('classifies a deletion tombstone that wins a create fence race for non-idempotent and idempotent creates', async () => {
  for (
    const idempotencyKey of [
      undefined,
      'idempotent-create-race',
    ]
  ) {
    const memory =
      createMemoryDocumentClient()
    const client = createClient(memory)
    const workItemId =
      `team/team-a/issue/create-race-${idempotencyKey ?? 'random'}`
    const deletionFence =
      await client
        .prepareWorkItemDeletionFenceTransactWrite({
          workspaceId: 'workspace-1',
          workItemId,
        })
    const tombstone =
      getPreparedFencePutItem(
        deletionFence,
      )
    memory.beforeTransaction(() => {
      memory.put(tombstone)
    })

    await expect(client.create({
      workspaceId: 'workspace-1',
      access: ownerAccess,
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Racing create',
      blocks: [],
      relations: [
        createWorkItemRelation(
          'racing-relation',
          workItemId,
        ),
      ],
      ...(idempotencyKey === undefined
        ? {}
        : { idempotencyKey }),
    })).rejects.toMatchObject({
      status: 409,
      code:
        'DocumentRelationTargetDeleted',
    })
    expect(
      memory.items().filter(
        ({ entryType }) =>
          entryType === 'document',
      ),
    ).toEqual([])
  }
})

test('classifies a deletion tombstone that wins an operation backlink fence race', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const workItemId =
    'team/team-a/issue/operation-race'
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Operation race',
    blocks: [],
  })
  const deletionFence =
    await client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      })
  const tombstone =
    getPreparedFencePutItem(
      deletionFence,
    )
  memory.beforeTransaction(() => {
    memory.put(tombstone)
  })

  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    input: {
      baseRevision: document.revision,
      clientId: 'editor-1',
      operations: [{
        type: 'upsert-relation',
        operationId: 'add-racing-relation',
        relation:
          createWorkItemRelation(
            'operation-racing-relation',
            workItemId,
          ),
      }],
    },
  })).rejects.toMatchObject({
    status: 409,
    code: 'DocumentRelationTargetDeleted',
  })
  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
  })).resolves.toMatchObject({
    revision: document.revision,
    relations: [],
  })
})

test('classifies a deletion tombstone that wins a version restore backlink fence race', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const workItemId =
    'team/team-a/issue/restore-race'
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Restore race',
    blocks: [],
    relations: [
      createWorkItemRelation(
        'restore-racing-relation',
        workItemId,
      ),
    ],
  })
  const unlinked =
    await client.applyOperations({
      workspaceId: 'workspace-1',
      documentId: document.id,
      access: ownerAccess,
      input: {
        baseRevision: document.revision,
        clientId: 'editor-1',
        operations: [{
          type: 'delete-relation',
          operationId:
            'unlink-before-restore',
          relationId:
            'restore-racing-relation',
        }],
      },
    })
  const deletionFence =
    await client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      })
  const tombstone =
    getPreparedFencePutItem(
      deletionFence,
    )
  memory.beforeTransaction(() => {
    memory.put(tombstone)
  })

  await expect(client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: document.id,
    versionId: '1',
    expectedRevision: unlinked.revision,
    access: ownerAccess,
    validateRelationTargets:
      async () => [],
  })).rejects.toMatchObject({
    status: 409,
    code: 'DocumentRelationTargetDeleted',
  })
  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
  })).resolves.toMatchObject({
    revision: unlinked.revision,
    relations: [],
  })
})

test('fails closed for legacy backlinks without a fence and bootstraps the exact count while unlinking', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const workItemId =
    'team/team-a/issue/legacy-backlink'
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Legacy backlink',
    blocks: [],
    relations: [
      createWorkItemRelation(
        'legacy-relation-a',
        workItemId,
      ),
      createWorkItemRelation(
        'legacy-relation-b',
        workItemId,
      ),
      createWorkItemRelation(
        'legacy-relation-c',
        workItemId,
      ),
    ],
  })
  const fence =
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    )
  expect(fence).toBeDefined()
  memory.remove(
    'workspace-1',
    String(fence?.recordKey),
  )
  memory.setQueryPageSize(1)

  await expect(
    client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      }),
  ).rejects.toMatchObject({
    status: 409,
    code: 'WorkItemDocumentBacklinkConflict',
    details: {
      activeBacklinkCount: 3,
    },
  })

  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: created.revision,
      clientId: 'editor-1',
      operations: [
        {
          type: 'delete-relation',
          operationId: 'unlink-legacy-a',
          relationId: 'legacy-relation-a',
        },
        {
          type: 'delete-relation',
          operationId: 'unlink-legacy-b',
          relationId: 'legacy-relation-b',
        },
        {
          type: 'delete-relation',
          operationId: 'unlink-legacy-c',
          relationId: 'legacy-relation-c',
        },
      ],
    },
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 0,
    version: 1,
  })
  await expect(
    client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      }),
  ).resolves.toHaveProperty(
    'transactWriteItem.Put',
  )
})

test('serializes concurrent legacy bootstrap puts and reports the losing deletion as a backlink conflict on retry', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const workItemId =
    'team/team-a/issue/concurrent-backlink'
  const staleDeletionFence =
    await client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      })

  await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Concurrent backlink',
    blocks: [],
    relations: [
      createWorkItemRelation(
        'concurrent-relation',
        workItemId,
      ),
    ],
  })
  await expect(
    memory.client.send(
      new TransactWriteCommand({
        TransactItems: [
          staleDeletionFence
            .transactWriteItem,
        ],
      }),
    ),
  ).rejects.toMatchObject({
    name: 'TransactionCanceledException',
  })
  await expect(
    client
      .prepareWorkItemDeletionFenceTransactWrite({
        workspaceId: 'workspace-1',
        workItemId,
      }),
  ).rejects.toMatchObject({
    status: 409,
    code: 'WorkItemDocumentBacklinkConflict',
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      workItemId,
    ),
  ).toMatchObject({
    activeBacklinkCount: 1,
    version: 1,
  })
})

test('keeps deepest-tree full backlink replacement within 100 actions and rejects the next relation before writing', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const authorizationGuards =
    Array.from(
      { length: 3 },
      (_value, index) => ({
        tableName:
          `authorization-table-${index}`,
        key: {
          workspaceId: 'workspace-1',
          recordKey: `AUTH#${index}`,
        },
        generationAttribute: 'version',
        expectedGeneration: 1,
        requiredAttributes: {
          entryType: 'authorization-row',
        },
      } as const),
    )
  for (
    const [index, guard] of
      authorizationGuards.entries()
  ) {
    memory.put({
      workspaceId: 'workspace-1',
      recordKey: `AUTH#${index}`,
      entryType: 'authorization-row',
      version: 1,
      guardTableName: guard.tableName,
    })
  }
  const deepestAccess = {
    ...ownerAccess,
    authorizationGuards,
  }
  let parentId: string | undefined
  for (
    let depth = 0;
    depth < 32;
    depth += 1
  ) {
    const folder = await client.create({
      workspaceId: 'workspace-1',
      access: deepestAccess,
      kind: 'folder',
      scope: { type: 'workspace' },
      ...(parentId === undefined
        ? {}
        : { parentId }),
      title: `Folder ${depth}`,
    })
    parentId = folder.id
  }
  const initialRelations = Array.from(
    {
      length:
        DOCUMENT_MAX_BACKLINK_COUNT,
    },
    (_value, index) =>
      createWorkItemRelation(
        `relation-${index}`,
        `team/team-a/issue/old-${index}`,
      ),
  )
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: deepestAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId,
    title: 'Maximum backlinks',
    blocks: [],
    relations: initialRelations,
  })
  let revision = document.revision
  for (
    let offset = 0;
    offset <
      DOCUMENT_MAX_BACKLINK_COUNT;
    offset += 4
  ) {
    const operations =
      initialRelations
        .slice(offset, offset + 4)
        .map(
          (
            relation,
            relationOffset,
          ) => ({
            type:
              'upsert-relation' as const,
            operationId:
              `replace-${offset + relationOffset}`,
            relation: {
              ...relation,
              target: {
                kind:
                  'work-item' as const,
                workItemId:
                  `team/team-a/issue/new-${offset + relationOffset}`,
              },
            },
          }),
        )
    const response =
      await client.applyOperations({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: deepestAccess,
        input: {
          baseRevision: revision,
          clientId: 'editor-1',
          operations,
        },
      })
    revision = response.revision
  }

  await client.restoreVersion({
    workspaceId: 'workspace-1',
    documentId: document.id,
    versionId: '1',
    expectedRevision: revision,
    access: deepestAccess,
    validateRelationTargets:
      async () => [],
  })
  expect(
    memory
      .transactionActionCounts()
      .at(-1),
  ).toBe(97)
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      'team/team-a/issue/old-0',
    ),
  ).toMatchObject({
    activeBacklinkCount: 1,
  })
  expect(
    findWorkItemBacklinkTargetFence(
      memory,
      'team/team-a/issue/new-0',
    ),
  ).toMatchObject({
    activeBacklinkCount: 0,
  })

  const transactionCount =
    memory
      .transactionActionCounts()
      .length
  await expect(client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Too many backlinks',
    blocks: [],
    relations: Array.from(
      {
        length:
          DOCUMENT_MAX_BACKLINK_COUNT +
          1,
      },
      (_value, index) =>
        createWorkItemRelation(
          `too-many-${index}`,
          `team/team-a/issue/too-many-${index}`,
        ),
    ),
  })).rejects.toMatchObject({
    status: 413,
    code:
      'DocumentBacklinkLimitExceeded',
  })
  expect(
    memory
      .transactionActionCounts()
      .length,
  ).toBe(transactionCount)
})

test('hashes public tokens at rest, carries allowExport, and checks expiry synchronously', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  let currentTime = new Date('2026-07-18T00:00:00.000Z')
  const client = createClient(memory, () => currentTime)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerShareAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Shared',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'public content' }],
  })
  const result = await client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    allowExport: true,
    idempotencyKey: 'public-share-request-1',
  })
  const retried = await client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    allowExport: true,
    idempotencyKey: 'public-share-request-1',
  })

  const storedJson = JSON.stringify(memory.items())
  const tokenDerivableWithoutServerSecret = createHash('sha256')
    .update(
      'mukuroji-public-share\0workspace-1\0public-share-request-1',
    )
    .digest('base64url')
  expect(storedJson).not.toContain(result.token)
  expect(result.token).not.toBe(tokenDerivableWithoutServerSecret)
  expect(retried).toEqual(result)
  expect(
    memory.items().filter(
      ({ entryType }) => entryType === 'document-share',
    ),
  ).toHaveLength(1)
  expect(memory.items()).toContainEqual(expect.objectContaining({
    entryType: 'document-share',
    tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    allowExport: true,
  }))
  expect(memory.items()).toContainEqual(expect.objectContaining({
    workspaceId: expect.stringMatching(/^PUBLIC#[a-f0-9]{64}$/u),
    recordKey: 'LINK',
  }))
  const resolved = await client.resolvePublicShare(result.token)
  expect(resolved.document.capabilities).toMatchObject({
    canView: true,
    canExport: true,
    canEdit: false,
  })
  expect(resolved.share.allowExport).toBeTrue()
  await expect(client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    allowExport: false,
    idempotencyKey: 'public-share-request-1',
  })).rejects.toMatchObject({
    code: 'DocumentShareIdempotencyConflict',
    status: 409,
  })

  currentTime = new Date('2026-07-19T00:00:00.000Z')
  await expect(client.resolvePublicShare(result.token)).rejects.toMatchObject({
    code: 'DocumentPublicShareNotFound',
    status: 404,
  })
})

test('lists and revokes public shares across paginated Query results', async () => {
  const memory =
    createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerShareAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Paginated shares',
  })
  const shares = await Promise.all([
    client.createPublicShare({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerShareAccess,
      expiresAt:
        '2026-07-19T00:00:00.000Z',
      idempotencyKey:
        'paginated-share-1',
    }),
    client.createPublicShare({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerShareAccess,
      expiresAt:
        '2026-07-19T00:00:00.000Z',
      idempotencyKey:
        'paginated-share-2',
    }),
    client.createPublicShare({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerShareAccess,
      expiresAt:
        '2026-07-19T00:00:00.000Z',
      idempotencyKey:
        'paginated-share-3',
    }),
  ])

  memory.setQueryPageSize(1)
  const listed =
    await client.listPublicShares({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerShareAccess,
    })
  expect(listed.map(({ id }) => id).sort())
    .toEqual(
      shares
        .map(({ share }) => share.id)
        .sort(),
    )
  const laterPageShare = listed.at(-1)
  expect(laterPageShare).toBeDefined()
  if (laterPageShare === undefined) {
    throw new Error(
      'Expected a share from a later Query page.',
    )
  }

  const revoked =
    await client.revokePublicShare({
      workspaceId: 'workspace-1',
      documentId: created.id,
      shareId: laterPageShare.id,
      access: ownerShareAccess,
    })
  expect(revoked).toMatchObject({
    id: laterPageShare.id,
    revokedAt: expect.any(String),
  })
  expect(
    await client.listPublicShares({
      workspaceId: 'workspace-1',
      documentId: created.id,
      access: ownerShareAccess,
    }),
  ).toContainEqual(
    expect.objectContaining({
      id: laterPageShare.id,
      revokedAt: expect.any(String),
    }),
  )
})

test('permanently invalidates descendant public links across ancestor archive and permits archived revocation', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  const client = createClient(memory)
  const folder = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Shared folder',
  })
  const child = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: folder.id,
    title: 'Shared child',
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'shared',
    }],
  })
  const retained = await client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    idempotencyKey: 'ancestor-archive-retained',
  })
  const revoked = await client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
    idempotencyKey: 'ancestor-archive-revoked',
  })

  const archived = await client.archive({
    workspaceId: 'workspace-1',
    documentId: folder.id,
    access: ownerAccess,
    expectedRevision: 1,
  })
  await expect(
    client.resolvePublicShare(retained.token),
  ).rejects.toMatchObject({
    code: 'DocumentPublicShareNotFound',
    status: 404,
  })
  expect(
    await client.listPublicShares({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: ownerShareAccess,
    }),
  ).toHaveLength(2)
  expect(
    await client.revokePublicShare({
      workspaceId: 'workspace-1',
      documentId: child.id,
      shareId: revoked.share.id,
      access: ownerShareAccess,
    }),
  ).toMatchObject({
    id: revoked.share.id,
    revokedAt: expect.any(String),
  })

  await client.restoreArchived({
    workspaceId: 'workspace-1',
    documentId: folder.id,
    access: ownerAccess,
    expectedRevision: archived.revision,
  })
  await expect(
    client.resolvePublicShare(retained.token),
  ).rejects.toMatchObject({
    code: 'DocumentPublicShareNotFound',
    status: 404,
  })
  const replacement =
    await client.createPublicShare({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: ownerShareAccess,
      expiresAt:
        '2026-07-19T00:00:00.000Z',
      idempotencyKey:
        'ancestor-archive-replacement',
    })
  expect(
    await client.resolvePublicShare(
      replacement.token,
    ),
  ).toMatchObject({
    document: { id: child.id },
  })
})

test('condition-checks authorization generations in the public share transaction', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Authorization race',
    blocks: [],
  })
  memory.beforeTransaction(() => {
    seedOwnerAuthorization(memory, 2)
  })

  await expect(client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerShareAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
  })).rejects.toMatchObject({
    code: 'DocumentAuthorizationChanged',
    status: 409,
  })
  expect(
    memory.items().filter(
      ({ entryType }) =>
        entryType === 'document-share' ||
        entryType ===
          'document-public-link',
    ),
  ).toEqual([])

  const refreshedAccess = {
    ...ownerAccess,
    authorizationGuards: [
      {
        ...ownerShareAccess
          .authorizationGuards[0],
        expectedGeneration: 2,
      },
      {
        tableName: 'planning-table',
        key: {
          directoryId: 'workspace-1',
          recordKey: 'META',
        },
        generationAttribute: 'revision',
        expectedGeneration: 0,
        allowMissingWhenExpectedZero: true,
      },
    ],
  } as const
  expect(await client.createPublicShare({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: refreshedAccess,
    expiresAt: '2026-07-19T00:00:00.000Z',
  })).toMatchObject({
    share: { documentId: created.id },
  })
})

test('stores text anchors and presence selections losslessly with a unified TTL attribute', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Collaboration',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'hello @alice' }],
  })
  const comment = await client.createComment({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    body: 'Please ask @alice',
    mentions: [{ userId: 'alice@example.com', offset: 11, length: 6 }],
    anchor: { type: 'text', blockId: 'block-a', start: 0, end: 5 },
  })
  await client.heartbeatPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    clientId: 'browser-tab-1',
    displayName: 'Owner',
    color: '#123456',
    selection: {
      type: 'text',
      blockId: 'block-a',
      anchorOffset: 1,
      focusOffset: 4,
    },
  })

  expect(comment).toMatchObject({
    mentions: [{ userId: 'alice@example.com', offset: 11, length: 6 }],
    anchor: { type: 'text', blockId: 'block-a', start: 0, end: 5 },
  })
  expect(await client.listPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
  })).toEqual([expect.objectContaining({
    selection: {
      type: 'text',
      blockId: 'block-a',
      anchorOffset: 1,
      focusOffset: 4,
    },
  })])
  const presenceRow = memory.items().find(({ entryType }) => entryType === 'document-presence')
  expect(presenceRow).toHaveProperty('expiresAtEpoch')
  expect(presenceRow).not.toHaveProperty('expiresAt')
})

test('stores document mention notification source events atomically with comments', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(
    memory,
    () => new Date('2026-07-18T00:00:00.000Z'),
    'audit-events-table',
  )
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Mention source',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: {
      id: ownerAccess.memberKey,
      kind: 'user',
      displayName: 'Owner',
    },
    idempotencyKey: 'comment-mention-1',
    request: {
      method: 'POST',
      path: `/api/documents/${document.id}/comments`,
      body: { body: 'Ask @Mina' },
    },
    source: { kind: 'api' },
    occurredAt: '2026-07-18T00:00:00.000Z',
  })

  const comment = await client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Ask @Mina and @Owner',
    mentions: [
      { userId: 'mina@example.com', offset: 4, length: 5 },
      { userId: ownerAccess.memberKey, offset: 14, length: 6 },
    ],
    commentId: 'comment-mention-1',
    auditContext,
  })

  const auditEvent = memory.items().find(
    ({ eventType }) => eventType === 'document.comment.created',
  )
  expect(comment.id).toBe('comment-mention-1')
  expect(auditEvent).toMatchObject({
    entity: { id: document.id, type: 'document' },
    metadata: {
      actorMemberKey: ownerAccess.memberKey,
      commentId: comment.id,
      deepLink:
        `/documents/${document.id}?context=comments&commentId=${comment.id}`,
      notificationCandidates: [{
        memberKey: 'mina@example.com',
        reason: 'mention',
      }],
      notificationTitle: 'Mention source',
    },
  })
})

test('stores at most one replaceable presence lease per Workspace member', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Presence ownership',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  await client.heartbeatPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    clientId: 'shared-client-id',
    displayName: 'Owner',
  })

  await client.heartbeatPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: {
      memberKey: 'other@example.com',
      workspaceRole: 'member',
    },
    clientId: 'shared-client-id',
    displayName: 'Other user',
  })
  await client.heartbeatPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    clientId: 'shared-client-id',
    displayName: 'Owner updated',
  })

  expect(memory.items().filter(
    ({ entryType }) => entryType === 'document-presence',
  )).toEqual(expect.arrayContaining([
    expect.objectContaining({
      userId: ownerAccess.memberKey,
      displayName: 'Owner updated',
    }),
    expect.objectContaining({
      userId: 'other@example.com',
      displayName: 'Other user',
    }),
  ]))
  expect(memory.items().filter(
    ({ entryType }) => entryType === 'document-presence',
  )).toHaveLength(2)
})

test('pages comments with a scope-bound opaque DynamoDB cursor', async () => {
  const memory = createMemoryDocumentClient()
  let timestamp = 0
  const client = createClient(
    memory,
    () => new Date(Date.UTC(2026, 6, 18, 0, 0, timestamp++)),
  )
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Comment pagination',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  for (const body of ['First', 'Second', 'Third']) {
    await client.createComment({
      workspaceId: 'workspace-1',
      documentId: document.id,
      access: ownerAccess,
      body,
    })
  }

  const firstPage = await client.listComments({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    limit: 2,
  })
  expect(firstPage.comments.map(({ body }) => body)).toEqual([
    'Third',
    'Second',
  ])
  expect(firstPage.nextCursor).toBeDefined()
  if (firstPage.nextCursor === undefined) {
    throw new Error('Expected a comment pagination cursor.')
  }

  const secondPage = await client.listComments({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    limit: 2,
    cursor: firstPage.nextCursor,
  })
  expect(secondPage).toEqual({
    comments: [expect.objectContaining({ body: 'First' })],
    nextCursor: undefined,
  })
  await expect(client.listComments({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    limit: 2,
    cursor: `${firstPage.nextCursor}!`,
  })).rejects.toMatchObject({
    code: 'InvalidDocumentCursor',
    status: 400,
  })
  const otherDocument = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Other comment scope',
    blocks: [{ id: 'block-b', type: 'paragraph', text: 'other' }],
  })
  await expect(client.listComments({
    workspaceId: 'workspace-1',
    documentId: otherDocument.id,
    access: ownerAccess,
    limit: 2,
    cursor: firstPage.nextCursor,
  })).rejects.toMatchObject({
    code: 'InvalidDocumentCursor',
    status: 400,
  })
  await expect(client.listComments({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    limit: 2,
    rootCommentId: 'another-thread',
    cursor: firstPage.nextCursor,
  })).rejects.toMatchObject({
    code: 'InvalidDocumentCursor',
    status: 400,
  })
  await expect(client.listComments({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    limit: 101,
  })).rejects.toMatchObject({
    code: 'InvalidDocumentPageLimit',
    status: 400,
  })
})

test('rejects replies to a resolved Document comment thread', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Resolved thread',
    blocks: [],
  })
  const root = await client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Root',
  })
  await client.resolveComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    commentId: root.id,
    access: ownerAccess,
    resolved: true,
  })

  await expect(client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Late reply',
    parentCommentId: root.id,
  })).rejects.toMatchObject({
    code: 'DocumentCommentThreadResolved',
    status: 409,
  })
})

test('condition-checks an unresolved root when reply creation races with resolve', async () => {
  const memory = createMemoryDocumentClient()
  let raceNextReply = false
  const proxyClient = {
    async send(command: { input: Record<string, unknown> }) {
      const transaction = command.input.TransactItems as
        | Array<Record<string, Record<string, unknown>>>
        | undefined
      const parentGuard = transaction
        ?.find(({ ConditionCheck }) =>
          ConditionCheck?.ConditionExpression ===
            'resolved = :unresolved AND updatedAt = :parentUpdatedAt'
        )
        ?.ConditionCheck
      if (raceNextReply && parentGuard !== undefined) {
        raceNextReply = false
        const key = parentGuard.Key as {
          workspaceId: string
          recordKey: string
        }
        const storedRoot = memory.items().find(
          ({ workspaceId, recordKey }) =>
            workspaceId === key.workspaceId &&
            recordKey === key.recordKey,
        )
        if (storedRoot === undefined) {
          throw new Error('Expected the stored root comment.')
        }
        memory.put({
          ...storedRoot,
          resolved: true,
          resolvedAt: '2026-07-18T00:01:00.000Z',
          resolvedByUserId: ownerAccess.memberKey,
          updatedAt: '2026-07-18T00:01:00.000Z',
        })
      }
      return memory.client.send(command as never)
    },
  } as unknown as DynamoDBDocumentClient
  const client = createClient({
    ...memory,
    client: proxyClient,
  })
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Resolve race',
    blocks: [],
  })
  const root = await client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Root',
  })

  raceNextReply = true
  await expect(client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Racing reply',
    parentCommentId: root.id,
  })).rejects.toMatchObject({
    code: 'DocumentCommentThreadResolved',
    status: 409,
  })
  expect(
    memory.items().filter(
      ({ entryType, parentCommentId }) =>
        entryType === 'document-comment' &&
        parentCommentId === root.id,
    ),
  ).toHaveLength(0)
})

test('reuses a deterministic comment receipt when a response-loss retry has a later timestamp', async () => {
  const memory = createMemoryDocumentClient()
  let currentTime = new Date('2026-07-18T00:00:00.000Z')
  const client = createClient(memory, () => currentTime)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Comment retry',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  const input = {
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Ask @alice',
    mentions: [{
      userId: 'alice@example.com',
      offset: 4,
      length: 6,
    }],
    anchor: {
      type: 'block' as const,
      blockId: 'block-a',
    },
    commentId: 'comment-request-1',
  }
  const created = await client.createComment(input)
  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'delete-block',
        operationId: 'delete-comment-anchor',
        blockId: 'block-a',
      }],
    },
  })
  currentTime = new Date('2026-07-18T00:01:00.000Z')
  const retried = await client.createComment(input)

  expect(retried).toEqual(created)
  expect(
    memory.items().filter(
      ({ entryType }) => entryType === 'document-comment',
    ),
  ).toHaveLength(1)
  expect(memory.items()).toContainEqual(expect.objectContaining({
    commentId: input.commentId,
    entryType: 'document-comment-receipt',
  }))
})

test('normalizes relation authorship and private manager grants at the store boundary', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Private relations',
    permission: { mode: 'private', memberGrants: [] },
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  expect(created.permission.memberGrants).toContainEqual({
    memberKey: ownerAccess.memberKey,
    role: 'manager',
  })

  await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'upsert-relation',
        operationId: 'relation-operation',
        relation: {
          id: 'relation-1',
          source: { kind: 'document' },
          target: { kind: 'project', projectId: 'project-1' },
          createdByUserId: 'spoofed@example.com',
          createdAt: '2000-01-01T00:00:00.000Z',
        },
      }],
    },
  })
  const document = await client.get({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
  })
  expect(document.relations[0]).toMatchObject({
    createdByUserId: ownerAccess.memberKey,
    createdAt: '2026-07-18T00:00:00.000Z',
  })
  const updated = await client.update({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    expectedRevision: 2,
    permission: {
      mode: 'private',
      memberGrants: [{ memberKey: 'editor@example.com', role: 'editor' }],
    },
  })
  expect(updated.permission.memberGrants).toContainEqual({
    memberKey: ownerAccess.memberKey,
    role: 'manager',
  })
})

test('returns preference persistence metadata and rejects malformed nested payloads as a 400', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Preference',
    blocks: [{ id: 'block-a', type: 'paragraph', text: 'content' }],
  })
  const preference = await client.updatePreference({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    favorite: true,
    openedAt: '2026-07-18T00:00:00.000Z',
  })
  expect(preference).toMatchObject({
    documentId: created.id,
    favorite: true,
    lastOpenedAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    document: { id: created.id, favorite: true },
  })

  expect(() => reduceDocumentOperations({
    document: createPage(),
    elementRevisions: { 'block:block-a': 1 },
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      type: 'update-block',
      operationId: 'malformed',
      blockId: 'block-a',
      block: undefined,
    } as unknown as DocumentOperation],
  })).toThrow(expect.objectContaining({
    code: 'InvalidDocumentPayload',
    status: 400,
  }))
  await expect(client.heartbeatPresence({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: ownerAccess,
    clientId: 'client-1',
    selection: {
      type: 'text',
      blockId: 'missing-block',
      anchorOffset: 0,
      focusOffset: 0,
    },
  })).rejects.toMatchObject({
    code: 'InvalidDocumentPayload',
    status: 400,
  })
})

test('merges concurrent favorite and recent preference writes without losing either field', async () => {
  const memory = createMemoryDocumentClient()
  let holdPreferenceReads = false
  let preferenceReadCount = 0
  let releasePreferenceReads: (() => void) | undefined
  const preferenceReadBarrier = new Promise<void>((resolve) => {
    releasePreferenceReads = resolve
  })
  const proxyClient = {
    async send(command: { input: Record<string, unknown> }) {
      const result = await memory.client.send(command as never)
      const key = command.input.Key as
        | { recordKey?: string }
        | undefined
      if (
        holdPreferenceReads &&
        key?.recordKey?.startsWith('PREFERENCE#')
      ) {
        preferenceReadCount += 1
        if (preferenceReadCount === 2) {
          holdPreferenceReads = false
          releasePreferenceReads?.()
        } else {
          await preferenceReadBarrier
        }
      }
      return result
    },
  } as unknown as DynamoDBDocumentClient
  const client = createClient({
    ...memory,
    client: proxyClient,
  })
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Concurrent preference',
    blocks: [],
  })
  await client.updatePreference({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    favorite: false,
    openedAt: '2026-07-17T00:00:00.000Z',
  })

  holdPreferenceReads = true
  await Promise.all([
    client.updatePreference({
      workspaceId: 'workspace-1',
      documentId: document.id,
      access: ownerAccess,
      favorite: true,
    }),
    client.updatePreference({
      workspaceId: 'workspace-1',
      documentId: document.id,
      access: ownerAccess,
      openedAt: '2026-07-18T00:00:00.000Z',
    }),
  ])

  const projected = await client.get({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
  })
  expect(projected).toMatchObject({
    favorite: true,
    lastOpenedAt: '2026-07-18T00:00:00.000Z',
  })
  expect(
    memory.items().filter(
      ({ entryType }) => entryType === 'document-recent',
    ),
  ).toEqual([
    expect.objectContaining({
      documentId: document.id,
      favorite: true,
      lastOpenedAt: '2026-07-18T00:00:00.000Z',
    }),
  ])
})

test('reads recent Documents from the newest-first index', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const documents = await Promise.all(
    ['Oldest', 'Newest', 'Middle'].map((title) =>
      client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title,
        blocks: [],
      })
    ),
  )
  const openedAt = [
    '2026-07-16T00:00:00.000Z',
    '2026-07-18T00:00:00.000Z',
    '2026-07-17T00:00:00.000Z',
  ]
  await Promise.all(
    documents.map((document, index) =>
      client.updatePreference({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        openedAt: openedAt[index],
      })
    ),
  )

  const recent = await client.listRecent({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    limit: 2,
  })

  expect(recent.map(({ title }) => title)).toEqual([
    'Newest',
    'Middle',
  ])
  expect(
    memory.items().filter(
      ({ entryType }) => entryType === 'document-recent',
    ),
  ).toHaveLength(3)
})

test('exports a private canonical document through a redacted viewer projection', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const viewerAccess = {
    memberKey: 'viewer@example.com',
    workspaceRole: 'member' as const,
  }
  const created = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Private export',
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: viewerAccess.memberKey,
        role: 'viewer',
      }],
    },
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'viewer content',
    }],
  })

  const rendered = await client.exportDocument({
    workspaceId: 'workspace-1',
    documentId: created.id,
    access: viewerAccess,
    format: 'json',
  })
  expect(
    JSON.parse(rendered.content),
  ).toMatchObject({
    id: created.id,
    permission: {
      mode: 'private',
      memberGrants: [],
    },
    blocks: [{
      id: 'block-a',
      text: 'viewer content',
    }],
  })
})

test('renders escaped Markdown/JSON/SVG and validates unsafe or oversized payloads', () => {
  const page = createPage({
    title: 'Export / document',
    blocks: [
      { id: 'block-a', type: 'paragraph', text: '<script>alert(1)</script>' },
      {
        id: 'block-b',
        type: 'table',
        columns: ['A|B'],
        rows: [{ id: 'row-1', cells: [{ id: 'cell-1', text: 'x|y' }] }],
      },
    ],
  })
  const markdown = renderDocumentExport(page, 'markdown')
  const json = renderDocumentExport(page, 'json')
  expect(markdown.fileName).toBe('Export - document.md')
  expect(markdown.content).toContain('\\<script\\>alert(1)\\</script\\>')
  expect(markdown.content).toContain('A\\|B')
  expect(JSON.parse(json.content)).toMatchObject({ id: page.id, revision: 1 })

  const fencedCode = renderDocumentExport(
    createPage({
      blocks: [{
        id: 'block-code',
        type: 'code',
        language: 'typescript',
        code:
          'const marker = "```"\n```\n<img src=x onerror=alert(1)>',
      }],
    }),
    'markdown',
  )
  expect(fencedCode.content).toContain(
    '````typescript\n',
  )
  expect(fencedCode.content).toContain(
    '\n````\n',
  )
  expect(() =>
    validateDocumentPayload(createPage({
      blocks: [{
        id: 'block-code',
        type: 'code',
        language:
          'typescript\n```\n<img src=x onerror=alert(1)>',
        code: 'unsafe info string',
      }],
    }))
  ).toThrow(expect.objectContaining({
    code: 'InvalidDocumentCodeLanguage',
  }))

  const legacyPublicPage: PublicDocument = {
    kind: 'page',
    title: 'Legacy public page',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [{
      id: 'block-code',
      type: 'code',
      language:
        'typescript\n```\n<img src=x onerror=alert(1)>',
      code: 'legacy ``` source',
    }],
  }
  const legacyPublicMarkdown =
    renderPublicDocumentExport(
      legacyPublicPage,
      'markdown',
    )
  expect(legacyPublicMarkdown.content).toContain(
    '````\nlegacy ``` source\n````',
  )
  expect(legacyPublicMarkdown.content).not.toContain(
    '<img src=x onerror=alert(1)>',
  )

  const whiteboard = createWhiteboard()
  const svg = renderDocumentExport(whiteboard, 'svg')
  expect(svg.content).toContain('&lt;unsafe&gt;')
  expect(svg.content).not.toContain('<unsafe>')
  whiteboard.whiteboard.objects.push({
    id: 'work-item-card-1',
    type: 'work-item',
    workItemId: 'team/team-a/issue/authenticated-work-item-id',
    bounds: { x: 140, y: 20, width: 100, height: 80 },
    zIndex: 2,
  })
  expect(renderDocumentExport(whiteboard, 'svg').content).toContain(
    'Work item: team/team-a/issue/authenticated-work-item-id',
  )

  expect(() => validateDocumentPayload(createPage({
    blocks: [{
      id: 'block-a',
      type: 'embed',
      url: 'javascript:alert(1)',
    }],
  }))).toThrow(expect.objectContaining({ code: 'InvalidDocumentUrl' }))

  const missingBounds = createWhiteboard()
  missingBounds.whiteboard.objects[0]!.bounds =
    {} as typeof missingBounds.whiteboard.objects[0]['bounds']
  expect(() =>
    validateDocumentPayload(missingBounds)
  ).toThrow(expect.objectContaining({
    code: 'InvalidWhiteboardBounds',
  }))

  const invalidChecklist = createPage({
    blocks: [{
      id: 'block-checklist',
      type: 'checklist',
      items: [{
        id: 'item-a',
        text: 'unchecked',
        checked:
          undefined as unknown as boolean,
      }],
    }],
  })
  expect(() =>
    validateDocumentPayload(invalidChecklist)
  ).toThrow(expect.objectContaining({
    code: 'InvalidDocumentBlock',
  }))

  const invalidDiagram = createPage({
    blocks: [{
      id: 'block-diagram',
      type: 'diagram',
      format:
        'html' as unknown as 'text',
      source: 'unsafe',
    }],
  })
  expect(() =>
    validateDocumentPayload(invalidDiagram)
  ).toThrow(expect.objectContaining({
    code: 'InvalidDocumentBlock',
  }))

  const invalidShape = createWhiteboard()
  invalidShape.whiteboard.objects = [{
    id: 'shape-a',
    type: 'shape',
    shape:
      'hexagon' as unknown as 'rectangle',
    bounds: {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    },
    zIndex: 1,
  }]
  expect(() =>
    validateDocumentPayload(invalidShape)
  ).toThrow(expect.objectContaining({
    code: 'InvalidWhiteboardObject',
  }))

  const invalidConnector = createWhiteboard()
  invalidConnector.whiteboard.connectors = [{
    id: 'connector-a',
    from: {
      objectId: 'object-1',
      anchor:
        'diagonal' as unknown as 'top',
    },
    to: { objectId: 'object-1' },
    lineStyle:
      'dotted' as unknown as 'solid',
  }]
  expect(() =>
    validateDocumentPayload(invalidConnector)
  ).toThrow(expect.objectContaining({
    code: 'InvalidWhiteboardConnector',
  }))
  invalidConnector.whiteboard.connectors[0]!.from =
    { objectId: 'object-1' }
  expect(() =>
    validateDocumentPayload(invalidConnector)
  ).toThrow(expect.objectContaining({
    code: 'InvalidWhiteboardConnector',
  }))

  const oversized = createPage({
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'x'.repeat(DOCUMENT_MAX_ITEM_BYTES),
    }],
  })
  expect(() => validateDocumentPayload(oversized)).toThrow(expect.objectContaining({
    code: expect.stringMatching(/DocumentPayloadTooLarge|InvalidDocumentText/u),
  }))
})

test('keeps compact search access current across mutations and fails closed for stale ACL or archived ancestors', async () => {
  const memory =
    createMemoryDocumentClient()
  let currentTime =
    new Date('2026-07-18T00:00:00.000Z')
  const client = createClient(
    memory,
    () => currentTime,
  )
  const viewerAccess = {
    memberKey: 'viewer@example.com',
    workspaceRole: 'member',
  } as const
  const folder = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Search access folder',
  })
  const child = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: folder.id,
    title: 'Search access child',
    blocks: [{
      id: 'block-a',
      type: 'paragraph',
      text: 'original',
    }],
  })
  const compactRow = memory.items().find(
    ({ entryType, documentId }) =>
      entryType ===
        'document-search-access' &&
      documentId === child.id,
  )
  expect(compactRow).toMatchObject({
    revision: 1,
    updatedAt: child.updatedAt,
    parentId: folder.id,
    permission: {
      mode: 'inherit',
    },
  })
  expect(
    compactRow !== undefined &&
      'document' in compactRow,
  ).toBeFalse()
  expect(
    compactRow !== undefined &&
      'blocks' in compactRow,
  ).toBeFalse()

  memory.clearReadKeys()
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision: child.revision,
      expectedUpdatedAt: child.updatedAt,
    }),
  ).resolves.toMatchObject({
    scope: { type: 'workspace' },
    revision: 1,
    body: 'original',
  })
  expect(
    memory
      .readKeys()
      .map(({ recordKey }) => recordKey),
  ).toEqual([
    expect.stringMatching(
      /^SEARCH_ACCESS#/u,
    ),
    expect.stringMatching(
      /^SEARCH_ACCESS#/u,
    ),
    expect.stringMatching(
      /^SEARCH_BODY#/u,
    ),
  ])

  currentTime =
    new Date('2026-07-18T01:00:00.000Z')
  const applied = await client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerAccess,
    input: {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        type: 'update-block',
        operationId: 'operation-1',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'edited',
        },
      }],
    },
  })
  expect(applied).toMatchObject({
    revision: 2,
    updatedAt:
      '2026-07-18T01:00:00.000Z',
  })

  currentTime =
    new Date('2026-07-18T02:00:00.000Z')
  const archivedFolder =
    await client.archive({
      workspaceId: 'workspace-1',
      documentId: folder.id,
      access: ownerAccess,
      expectedRevision: 1,
    })
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision: applied.revision,
      expectedUpdatedAt:
        applied.updatedAt,
    }),
  ).resolves.toBeUndefined()

  currentTime =
    new Date('2026-07-18T03:00:00.000Z')
  await client.restoreArchived({
    workspaceId: 'workspace-1',
    documentId: folder.id,
    access: ownerAccess,
    expectedRevision:
      archivedFolder.revision,
  })
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision: applied.revision,
      expectedUpdatedAt:
        applied.updatedAt,
    }),
  ).resolves.toMatchObject({
    revision: 2,
  })

  currentTime =
    new Date('2026-07-18T04:00:00.000Z')
  const restored =
    await client.restoreVersion({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: ownerAccess,
      versionId: `${child.id}:1`,
      expectedRevision: applied.revision,
      validateRelationTargets:
        async () => undefined,
    })
  expect(restored).toMatchObject({
    revision: 3,
    blocks: [{
      id: 'block-a',
      text: 'original',
    }],
  })
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision: applied.revision,
      expectedUpdatedAt:
        applied.updatedAt,
    }),
  ).resolves.toBeUndefined()

  currentTime =
    new Date('2026-07-18T05:00:00.000Z')
  const privateChild = await client.update({
    workspaceId: 'workspace-1',
    documentId: child.id,
    access: ownerAccess,
    expectedRevision: restored.revision,
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey:
          ownerAccess.memberKey,
        role: 'manager',
      }],
    },
  })
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision:
        restored.revision,
      expectedUpdatedAt:
        restored.updatedAt,
    }),
  ).resolves.toBeUndefined()
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: viewerAccess,
      expectedRevision:
        privateChild.revision,
      expectedUpdatedAt:
        privateChild.updatedAt,
    }),
  ).resolves.toBeUndefined()
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: child.id,
      access: ownerAccess,
      expectedRevision:
        privateChild.revision,
      expectedUpdatedAt:
        privateChild.updatedAt,
    }),
  ).resolves.toMatchObject({
    revision: 4,
    updatedAt:
      '2026-07-18T05:00:00.000Z',
  })
})

test('returns the compressed full search body while sharing ancestor ACL reads across candidates', async () => {
  const memory =
    createMemoryDocumentClient()
  const client = createClient(memory)
  const viewerAccess = {
    memberKey: 'viewer@example.com',
    workspaceRole: 'member',
  } as const
  const tailKeyword = 'tail-keyword'
  const bodyParts = [
    ...Array.from(
      { length: 6 },
      () => 'x'.repeat(50_000),
    ),
    `${'x'.repeat(44_000)} ${tailKeyword}`,
  ]
  const fullBody = bodyParts.join('\n')
  expect(
    Buffer.byteLength(fullBody, 'utf8'),
  ).toBeGreaterThan(330_000)
  const folder = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Shared search ancestor',
  })
  const first = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: folder.id,
    title: 'First search child',
    blocks: bodyParts.map(
      (text, index) => ({
        id: `block-first-${index}`,
        type: 'paragraph' as const,
        text,
      }),
    ),
  })
  const second = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    parentId: folder.id,
    title: 'Second search child',
    blocks: [{
      id: 'block-second',
      type: 'paragraph',
      text: 'Sibling body',
    }],
  })
  const bodyRow = memory.items().find(
    ({ entryType, documentId }) =>
      entryType ===
        'document-search-body' &&
      documentId === first.id,
  )
  expect(bodyRow).toMatchObject({
    revision: first.revision,
    updatedAt: first.updatedAt,
    bodyEncoding: 'gzip',
  })
  expect(bodyRow?.bodyGzip).toBeInstanceOf(
    Uint8Array,
  )
  expect(
    bodyRow !== undefined &&
      'body' in bodyRow,
  ).toBeFalse()

  const readContext =
    createDocumentSearchAccessReadContext()
  memory.clearReadKeys()
  const [firstAccess, secondAccess] =
    await Promise.all([
      client.resolveSearchAccess({
        workspaceId: 'workspace-1',
        documentId: first.id,
        access: viewerAccess,
        expectedRevision:
          first.revision,
        expectedUpdatedAt:
          first.updatedAt,
        readContext,
      }),
      client.resolveSearchAccess({
        workspaceId: 'workspace-1',
        documentId: second.id,
        access: viewerAccess,
        expectedRevision:
          second.revision,
        expectedUpdatedAt:
          second.updatedAt,
        readContext,
      }),
    ])

  expect(firstAccess?.body).toBe(fullBody)
  expect(firstAccess?.body).toContain(
    tailKeyword,
  )
  expect(secondAccess?.body).toBe(
    'Sibling body',
  )
  const recordKeys = memory
    .readKeys()
    .map(({ recordKey }) => recordKey)
  expect(
    recordKeys.filter((recordKey) =>
      recordKey?.startsWith(
        'SEARCH_ACCESS#',
      )
    ),
  ).toHaveLength(3)
  expect(
    recordKeys.filter((recordKey) =>
      recordKey?.startsWith(
        'SEARCH_BODY#',
      )
    ),
  ).toHaveLength(2)
  expect(
    recordKeys.some((recordKey) =>
      recordKey?.startsWith('DOCUMENT#')
    ),
  ).toBeFalse()
  if (bodyRow === undefined) {
    throw new Error(
      'Expected the full search body projection.',
    )
  }
  memory.put({
    ...bodyRow,
    bodyGzip: new Uint8Array([1, 2, 3]),
  })
  await expect(
    client.resolveSearchAccess({
      workspaceId: 'workspace-1',
      documentId: first.id,
      access: viewerAccess,
      expectedRevision:
        first.revision,
      expectedUpdatedAt:
        first.updatedAt,
      readContext:
        createDocumentSearchAccessReadContext(),
    }),
  ).resolves.toBeUndefined()
})

test('finds private Documents that would lose their only active non-guest manager', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const targetOnly = createPage({
    id: 'target-only',
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: 'target@example.com',
        role: 'manager',
      }, {
        memberKey: 'guest@example.com',
        role: 'manager',
      }],
    },
  })
  const transferred = createPage({
    id: 'transferred',
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: 'target@example.com',
        role: 'manager',
      }, {
        memberKey: 'replacement@example.com',
        role: 'manager',
      }],
    },
  })
  const inherited = createPage({
    id: 'inherited',
    permission: {
      mode: 'inherit',
      memberGrants: [{
        memberKey: 'target@example.com',
        role: 'manager',
      }],
    },
  })
  for (const document of [
    targetOnly,
    transferred,
    inherited,
  ]) {
    memory.put({
      workspaceId: 'workspace-1',
      recordKey:
        `SEARCH_ACCESS#${Buffer.from(
          document.id,
          'utf8',
        ).toString('base64url')}`,
      entryType:
        'document-search-access',
      documentId: document.id,
      revision: document.revision,
      scope: document.scope,
      permission: document.permission,
      updatedAt: document.updatedAt,
    })
  }
  memory.put({
    workspaceId: 'workspace-1',
    recordKey:
      'DOCUMENT_AUTHORIZATION_REVISION',
    entryType: 'document-authorization-revision',
    revision: 4,
    updatedAt: '2026-07-18T00:00:00.000Z',
  })

  await expect(
    client.getManagerLifecycleSnapshot(
      'workspace-1',
      'TARGET@example.com',
      [
        'target@example.com',
        'replacement@example.com',
      ],
    ),
  ).resolves.toEqual({
    authorizationRevision: 4,
    blockingDocumentId: 'target-only',
  })
})

test('conflicts a private ACL write with a concurrent Workspace member eligibility change', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Private lifecycle race',
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: 'target@example.com',
        role: 'manager',
      }],
    },
    blocks: [],
    expectedAuthorizationRevision: 0,
  })
  expect(
    await client.getAuthorizationRevision(
      'workspace-1',
    ),
  ).toBe(1)
  memory.beforeTransaction(() => {
    memory.put({
      workspaceId: 'workspace-1',
      recordKey:
        'DOCUMENT_AUTHORIZATION_REVISION',
      entryType:
        'document-authorization-revision',
      revision: 2,
      updatedAt: '2026-07-18T00:01:00.000Z',
    })
  })

  await expect(client.update({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    expectedRevision: document.revision,
    expectedAuthorizationRevision: 1,
    permission: {
      mode: 'private',
      memberGrants: [{
        memberKey: 'target@example.com',
        role: 'manager',
      }, {
        memberKey: 'viewer@example.com',
        role: 'viewer',
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentAuthorizationConflict',
    status: 409,
  })
  await expect(client.get({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
  })).resolves.toMatchObject({
    revision: 1,
    permission: {
      memberGrants: expect.not.arrayContaining([
        expect.objectContaining({
          memberKey: 'viewer@example.com',
        }),
      ]),
    },
  })
})

test('binds private ACL mutations to the active principal generation', async () => {
  const memory = createMemoryDocumentClient()
  const memberKey = {
    workspaceId: 'workspace-1',
    recordKey: 'MEMBER#owner',
  }
  memory.put({
    ...memberKey,
    entryType: 'workspace-member',
    status: 'active',
    version: 1,
  })
  const guardedAccess = {
    ...ownerAccess,
    authorizationGuards: [{
      tableName: 'WorkspaceAccessTable',
      key: memberKey,
      generationAttribute: 'version',
      expectedGeneration: 1,
      requiredAttributes: {
        entryType: 'workspace-member',
        status: 'active',
      },
    }],
  }
  const client = createClient(memory)
  memory.beforeTransaction(() => {
    memory.put({
      ...memberKey,
      entryType: 'workspace-member',
      status: 'deactivated',
      version: 2,
    })
  })

  await expect(client.create({
    workspaceId: 'workspace-1',
    access: guardedAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Stale principal create',
    permission: {
      mode: 'private',
      memberGrants: [],
    },
    blocks: [],
    expectedAuthorizationRevision: 0,
  })).rejects.toMatchObject({
    code: 'DocumentAuthorizationChanged',
    status: 409,
  })
  expect(
    memory.items().filter(
      ({ entryType }) =>
        entryType === 'document',
    ),
  ).toHaveLength(0)
})

test('deduplicates principal and relation authorization guards in inherited create transactions', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  seedPlanningAuthorization(memory, 1)
  let transaction:
    | Array<Record<string, Record<string, unknown>>>
    | undefined
  const proxyClient = {
    async send(command: { input: Record<string, unknown> }) {
      const actions = command.input.TransactItems as
        | Array<Record<string, Record<string, unknown>>>
        | undefined
      if (actions !== undefined) {
        transaction = structuredClone(actions)
      }
      return memory.client.send(command as never)
    },
  } as unknown as DynamoDBDocumentClient
  const client = createClient({
    ...memory,
    client: proxyClient,
  })
  const planningGuard =
    planningAuthorizationGuard(1)

  await client.create({
    workspaceId: 'workspace-1',
    access: {
      ...ownerAccess,
      authorizationGuards: [
        ...ownerShareAccess.authorizationGuards,
        planningGuard,
      ],
    },
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Merged authorization guards',
    blocks: [],
    relations: [
      createGoalRelation('deduplicated-guard'),
    ],
    relationTargetAuthorizationGuards: [
      planningGuard,
    ],
  })

  const conditionChecks =
    (transaction ?? [])
      .flatMap(({ ConditionCheck }) =>
        ConditionCheck === undefined
          ? []
          : [ConditionCheck]
      )
  expect(conditionChecks).toHaveLength(2)
  expect(
    conditionChecks.map(({ TableName }) => TableName),
  ).toEqual([
    'workspace-access-table',
    'planning-table',
  ])
})

test('rejects inherited create and content or lifecycle mutations when principal authorization expires', async () => {
  const expectAuthorizationRevocation =
    async (
      prepare: (
        client: DynamoDbDocumentsClient,
      ) => Promise<() => Promise<unknown>>,
    ) => {
      const memory =
        createMemoryDocumentClient()
      seedOwnerAuthorization(memory)
      const client = createClient(memory)
      const mutate = await prepare(client)
      memory.beforeTransaction(() => {
        seedOwnerAuthorization(memory, 2)
      })
      await expect(mutate()).rejects.toMatchObject({
        code: 'DocumentAuthorizationChanged',
        status: 409,
      })
    }

  await expectAuthorizationRevocation(
    async (client) => async () =>
      client.create({
        workspaceId: 'workspace-1',
        access: ownerShareAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Inherited guarded create',
        blocks: [],
      }),
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded edit',
        blocks: [],
      })
      return async () =>
        client.update({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          expectedRevision: document.revision,
          title: 'Revoked edit',
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded operations',
        blocks: [{
          id: 'block-1',
          type: 'paragraph',
          text: 'Before',
        }],
      })
      return async () =>
        client.applyOperations({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          input: {
            baseRevision: document.revision,
            clientId: 'editor-1',
            operations: [{
              operationId: 'revoked-edit',
              type: 'update-block',
              blockId: 'block-1',
              block: {
                id: 'block-1',
                type: 'paragraph',
                text: 'After',
              },
            }],
          },
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded version restore',
        blocks: [],
      })
      const updated = await client.update({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        expectedRevision: document.revision,
        title: 'Updated title',
      })
      return async () =>
        client.restoreVersion({
          workspaceId: 'workspace-1',
          documentId: document.id,
          versionId: `${document.id}:1`,
          expectedRevision: updated.revision,
          access: ownerShareAccess,
          validateRelationTargets:
            async () => [],
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded archive',
        blocks: [],
      })
      return async () =>
        client.archive({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          expectedRevision: document.revision,
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded archive restore',
        blocks: [],
      })
      const archived = await client.archive({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        expectedRevision: document.revision,
      })
      return async () =>
        client.restoreArchived({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          expectedRevision: archived.revision,
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const template = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'template',
        scope: { type: 'workspace' },
        title: 'Guarded template',
        blocks: [],
      })
      return async () =>
        client.instantiateTemplate({
          workspaceId: 'workspace-1',
          templateId: template.id,
          access: ownerShareAccess,
          scope: { type: 'workspace' },
        })
    },
  )
})

test('rejects comment mutations when principal authorization expires', async () => {
  const memory = createMemoryDocumentClient()
  seedOwnerAuthorization(memory)
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Guarded comments',
    blocks: [],
  })
  memory.beforeTransaction(() => {
    seedOwnerAuthorization(memory, 2)
  })
  await expect(client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerShareAccess,
    body: 'Revoked comment',
  })).rejects.toMatchObject({
    code: 'DocumentAuthorizationChanged',
    status: 409,
  })

  seedOwnerAuthorization(memory)
  const comment = await client.createComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    body: 'Existing comment',
  })
  memory.beforeTransaction(() => {
    seedOwnerAuthorization(memory, 2)
  })
  await expect(client.resolveComment({
    workspaceId: 'workspace-1',
    documentId: document.id,
    commentId: comment.id,
    access: ownerShareAccess,
    resolved: true,
  })).rejects.toMatchObject({
    code: 'DocumentAuthorizationChanged',
    status: 409,
  })
})

test('rejects preference and presence mutations when principal authorization expires', async () => {
  const expectAuthorizationRevocation =
    async (
      prepare: (
        client: DynamoDbDocumentsClient,
      ) => Promise<() => Promise<unknown>>,
    ) => {
      const memory =
        createMemoryDocumentClient()
      seedOwnerAuthorization(memory)
      const client = createClient(memory)
      const mutate = await prepare(client)
      memory.beforeTransaction(() => {
        seedOwnerAuthorization(memory, 2)
      })
      await expect(mutate()).rejects.toMatchObject({
        code: 'DocumentAuthorizationChanged',
        status: 409,
      })
    }

  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded preference',
        blocks: [],
      })
      return async () =>
        client.updatePreference({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          favorite: true,
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded presence',
        blocks: [],
      })
      return async () =>
        client.heartbeatPresence({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          clientId: 'client-1',
        })
    },
  )
  await expectAuthorizationRevocation(
    async (client) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Guarded presence leave',
        blocks: [],
      })
      await client.heartbeatPresence({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        clientId: 'client-1',
      })
      return async () =>
        client.leavePresence({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerShareAccess,
          clientId: 'client-1',
        })
    },
  )
})

test('binds ancestor ACL snapshots to document and related-item mutations', async () => {
  const expectAncestorAuthorizationRevocation =
    async (
      prepare: (
        client: DynamoDbDocumentsClient,
        parent: DocumentDetail,
      ) => Promise<() => Promise<unknown>>,
    ) => {
      const memory =
        createMemoryDocumentClient()
      const client = createClient(memory)
      const parent = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'folder',
        scope: { type: 'workspace' },
        title: 'Authorization parent',
      })
      const mutate = await prepare(
        client,
        parent,
      )
      memory.beforeTransaction(() => {
        mutateStoredDocument(
          memory,
          parent.id,
          (document) => {
            document.permission = {
              mode: 'private',
              memberGrants: [{
                memberKey:
                  'replacement@example.com',
                role: 'manager',
              }],
            }
          },
        )
      })
      await expect(mutate()).rejects.toMatchObject({
        code: 'DocumentAuthorizationChanged',
        status: 409,
      })
    }

  await expectAncestorAuthorizationRevocation(
    async (client, parent) => async () =>
      client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked child create',
        blocks: [],
      }),
  )
  await expectAncestorAuthorizationRevocation(
    async (client, parent) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked child edit',
        blocks: [],
      })
      return async () =>
        client.update({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerAccess,
          expectedRevision: document.revision,
          title: 'Must not commit',
        })
    },
  )
  await expectAncestorAuthorizationRevocation(
    async (client, parent) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked child comment',
        blocks: [],
      })
      return async () =>
        client.createComment({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerAccess,
          body: 'Must not commit',
        })
    },
  )
  await expectAncestorAuthorizationRevocation(
    async (client, parent) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked child preference',
        blocks: [],
      })
      return async () =>
        client.updatePreference({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerAccess,
          favorite: true,
        })
    },
  )
  await expectAncestorAuthorizationRevocation(
    async (client, parent) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked child presence',
        blocks: [],
      })
      return async () =>
        client.heartbeatPresence({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerAccess,
          clientId: 'revoked-client',
        })
    },
  )
  await expectAncestorAuthorizationRevocation(
    async (client, parent) => {
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Revoked presence leave',
        blocks: [],
      })
      await client.heartbeatPresence({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        clientId: 'revoked-client',
      })
      return async () =>
        client.leavePresence({
          workspaceId: 'workspace-1',
          documentId: document.id,
          access: ownerAccess,
          clientId: 'revoked-client',
        })
    },
  )
})

test('binds ancestor archive and topology snapshots to operation commits', async () => {
  const expectAncestorMutationConflict =
    async (
      mutateAncestor: (
        document: DocumentDetail,
      ) => void,
    ) => {
      const memory =
        createMemoryDocumentClient()
      const client = createClient(memory)
      const destination = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'folder',
        scope: { type: 'workspace' },
        title: 'Destination',
      })
      const parent = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'folder',
        scope: { type: 'workspace' },
        title: 'Mutable ancestor',
      })
      const document = await client.create({
        workspaceId: 'workspace-1',
        access: ownerAccess,
        kind: 'page',
        scope: { type: 'workspace' },
        parentId: parent.id,
        title: 'Guarded operations',
        blocks: [{
          id: 'block-1',
          type: 'paragraph',
          text: 'Before',
        }],
      })
      memory.beforeTransaction(() => {
        mutateStoredDocument(
          memory,
          parent.id,
          (ancestor) => {
            mutateAncestor(ancestor)
            if (
              ancestor.parentId ===
                '__destination__'
            ) {
              ancestor.parentId =
                destination.id
            }
          },
        )
      })
      await expect(client.applyOperations({
        workspaceId: 'workspace-1',
        documentId: document.id,
        access: ownerAccess,
        input: {
          baseRevision: document.revision,
          clientId: 'editor-1',
          operations: [{
            operationId:
              'ancestor-race-edit',
            type: 'update-block',
            blockId: 'block-1',
            block: {
              id: 'block-1',
              type: 'paragraph',
              text: 'After',
            },
          }],
        },
      })).rejects.toMatchObject({
        code: 'DocumentAuthorizationChanged',
        status: 409,
      })
    }

  await expectAncestorMutationConflict(
    (ancestor) => {
      ancestor.archivedAt =
        '2026-07-18T00:01:00.000Z'
    },
  )
  await expectAncestorMutationConflict(
    (ancestor) => {
      ancestor.parentId = '__destination__'
    },
  )
})

test('returns a concurrent-update conflict when operation retries are exhausted', async () => {
  const memory = createMemoryDocumentClient()
  const client = createClient(memory)
  const document = await client.create({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Retry exhaustion',
    blocks: [{
      id: 'block-1',
      type: 'paragraph',
      text: 'Before',
    }],
  })
  let attempts = 0
  const rejectTransaction = () => {
    attempts += 1
    memory.beforeTransaction(
      rejectTransaction,
    )
    throw conditionalError()
  }
  memory.beforeTransaction(
    rejectTransaction,
  )

  await expect(client.applyOperations({
    workspaceId: 'workspace-1',
    documentId: document.id,
    access: ownerAccess,
    input: {
      baseRevision: document.revision,
      clientId: 'editor-1',
      operations: [{
        operationId: 'retry-exhaustion',
        type: 'update-block',
        blockId: 'block-1',
        block: {
          id: 'block-1',
          type: 'paragraph',
          text: 'After',
        },
      }],
    },
  })).rejects.toMatchObject({
    code: 'DocumentConcurrentUpdate',
    status: 409,
  })
  expect(attempts).toBe(6)
})

function createPage(
  overrides: Partial<Extract<DocumentDetail, { kind: 'page' }>> = {},
): Extract<DocumentDetail, { kind: 'page' }> {
  return {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Document',
    position: 'a',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: false,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: false,
    },
    createdByUserId: 'owner@example.com',
    updatedByUserId: 'owner@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [
      { id: 'block-a', type: 'paragraph', text: 'A1' },
      { id: 'block-b', type: 'paragraph', text: 'B1' },
    ],
    ...structuredClone(overrides),
  }
}

function createWhiteboard(): Extract<DocumentDetail, { kind: 'whiteboard' }> {
  return {
    schemaVersion: 1,
    id: 'whiteboard-1',
    kind: 'whiteboard',
    scope: { type: 'workspace' },
    title: 'Whiteboard',
    position: 'a',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: false,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: false,
    },
    createdByUserId: 'owner@example.com',
    updatedByUserId: 'owner@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    whiteboard: {
      objects: [{
        id: 'object-1',
        type: 'note',
        text: '<unsafe>',
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        zIndex: 1,
      }],
      connectors: [],
      frames: [],
    },
  }
}

function createClient(
  memory: ReturnType<typeof createMemoryDocumentClient>,
  now = () => new Date('2026-07-18T00:00:00.000Z'),
  auditTableName?: string,
): DynamoDbDocumentsClient {
  let id = 0
  return new DynamoDbDocumentsClient({
    tableName: 'documents-table',
    documentClient: memory.client,
    autoCreateLocal: false,
    now,
    generateId: () => `generated-${++id}`,
    publicShareTokenSecret:
      'test-public-share-token-secret-with-at-least-32-bytes',
    auditTableName,
  })
}

function mutateStoredDocument(
  memory: ReturnType<
    typeof createMemoryDocumentClient
  >,
  documentId: string,
  mutate: (document: DocumentDetail) => void,
): void {
  const stored = memory.items().find(
    (item) =>
      item.entryType === 'document' &&
      item.documentId === documentId,
  )
  if (stored === undefined) {
    throw new Error(
      `Stored Document ${documentId} was not found.`,
    )
  }
  const document =
    structuredClone(
      stored.document,
    ) as DocumentDetail
  mutate(document)
  document.revision += 1
  document.updatedAt =
    '2026-07-18T00:01:00.000Z'
  memory.put({
    ...stored,
    revision:
      Number(stored.revision) + 1,
    document,
  })
}

function seedOwnerAuthorization(
  memory: ReturnType<
    typeof createMemoryDocumentClient
  >,
  version = 1,
): void {
  memory.put({
    workspaceId: 'workspace-1',
    recordKey: 'MEMBER#owner@example.com',
    entryType: 'workspace-member',
    status: 'active',
    version,
  })
}

function planningAuthorizationGuard(
  revision: number,
) {
  return {
    tableName: 'planning-table',
    key: {
      workspaceId: 'workspace-1',
      recordKey: 'META',
    },
    generationAttribute: 'revision',
    expectedGeneration: revision,
    requiredAttributes: {
      entryType: 'planning-meta',
      schemaVersion: 1,
    },
  } as const
}

function seedPlanningAuthorization(
  memory: ReturnType<
    typeof createMemoryDocumentClient
  >,
  revision: number,
): void {
  memory.put({
    workspaceId: 'workspace-1',
    recordKey: 'META',
    entryType: 'planning-meta',
    schemaVersion: 1,
    revision,
  })
}

function createGoalRelation(
  goalId: string,
): DocumentDetail['relations'][number] {
  return {
    id: `relation-${goalId}`,
    source: { kind: 'document' },
    target: { kind: 'goal', goalId },
    createdByUserId: 'owner@example.com',
    createdAt:
      '2026-07-18T00:00:00.000Z',
  }
}

function createWorkItemRelation(
  relationId: string,
  workItemId: string,
): DocumentDetail['relations'][number] {
  return {
    id: relationId,
    source: { kind: 'document' },
    target: {
      kind: 'work-item',
      workItemId,
    },
    createdByUserId: 'owner@example.com',
    createdAt:
      '2026-07-18T00:00:00.000Z',
  }
}

function findWorkItemBacklinkTargetFence(
  memory: ReturnType<
    typeof createMemoryDocumentClient
  >,
  workItemId: string,
): Record<string, unknown> | undefined {
  return memory.items().find(
    (item) =>
      item.entryType ===
        'document-backlink-target-fence' &&
      item.targetKind === 'work-item' &&
      item.targetId === workItemId,
  )
}

function getPreparedFencePutItem(
  prepared: Awaited<
    ReturnType<
      DynamoDbDocumentsClient[
        'prepareWorkItemDeletionFenceTransactWrite'
      ]
    >
  >,
): Record<string, unknown> {
  const item =
    prepared.transactWriteItem.Put?.Item
  if (item === undefined) {
    throw new Error(
      'Expected a prepared fence Put.',
    )
  }
  return item
}

function createMemoryDocumentClient() {
  const stored = new Map<string, Record<string, unknown>>()
  const transactionActionCounts: number[] = []
  const readKeys:
    Array<{
      workspaceId?: string
      recordKey?: string
    }> = []
  let queryPageSize =
    Number.POSITIVE_INFINITY
  let beforeNextTransaction:
    | (() => void)
    | undefined
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input
      const transaction = input.TransactItems as
        | Array<Record<string, Record<string, unknown>>>
        | undefined
      if (transaction !== undefined) {
        transactionActionCounts.push(
          transaction.length,
        )
        const beforeTransaction =
          beforeNextTransaction
        beforeNextTransaction = undefined
        beforeTransaction?.()
        const pending = new Map(
          [...stored].map(([key, item]) => [key, structuredClone(item)]),
        )
        for (const action of transaction) applyTransactionAction(pending, action)
        stored.clear()
        for (const [key, item] of pending) stored.set(key, item)
        return {}
      }
      const key = input.Key as { workspaceId?: string; recordKey?: string } | undefined
      if (key !== undefined) {
        const mapKey = memoryKey(key.workspaceId, key.recordKey)
        if (command.constructor.name === 'DeleteCommand') {
          if (!matchesCondition(stored.get(mapKey), input)) throw conditionalError()
          stored.delete(mapKey)
          return {}
        }
        readKeys.push(structuredClone(key))
        return { Item: structuredClone(stored.get(mapKey)) }
      }
      const item = input.Item as Record<string, unknown> | undefined
      if (item !== undefined) {
        const mapKey = memoryKey(item.workspaceId, item.recordKey)
        if (!matchesCondition(stored.get(mapKey), input)) throw conditionalError()
        stored.set(mapKey, structuredClone(item))
        return {}
      }
      if (typeof input.KeyConditionExpression === 'string') {
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        const workspaceId = values[':workspaceId']
        const start = (input.ExclusiveStartKey as { recordKey?: string } | undefined)?.recordKey
        let matches = [...stored.values()]
          .filter(
            (candidate) =>
              candidate.workspaceId ===
                workspaceId,
          )
        if (
          input.KeyConditionExpression.includes(
            'BETWEEN',
          )
        ) {
          const startKey = String(
            values[':startKey'],
          )
          const endKey = String(
            values[':endKey'],
          )
          matches = matches.filter(
            ({ recordKey }) =>
              String(recordKey) >= startKey &&
              String(recordKey) <= endKey,
          )
        } else {
          const prefix = String(
            values[':prefix'] ?? '',
          )
          matches = matches.filter(
            ({ recordKey }) =>
              String(recordKey).startsWith(
                prefix,
              ),
          )
        }
        matches = matches
          .sort((left, right) => String(left.recordKey).localeCompare(String(right.recordKey)))
        if (input.ScanIndexForward === false) matches.reverse()
        if (start !== undefined) {
          const startIndex = matches.findIndex(({ recordKey }) => recordKey === start)
          matches = startIndex < 0 ? matches : matches.slice(startIndex + 1)
        }
        const limit = Math.min(
          typeof input.Limit === 'number'
            ? input.Limit
            : matches.length,
          queryPageSize,
        )
        const page = matches.slice(0, limit)
        const hasNext = matches.length > page.length
        return {
          Items: structuredClone(page),
          ...(hasNext && page.at(-1) !== undefined
            ? {
                LastEvaluatedKey: {
                  workspaceId: page.at(-1)?.workspaceId,
                  recordKey: page.at(-1)?.recordKey,
                },
              }
            : {}),
        }
      }
      throw new Error(`Unsupported command: ${command.constructor.name}`)
    },
  } as unknown as DynamoDBDocumentClient
  return {
    client,
    items: () => [...stored.values()].map((item) => structuredClone(item)),
    transactionActionCounts: () =>
      [...transactionActionCounts],
    readKeys: () =>
      structuredClone(readKeys),
    clearReadKeys: () => {
      readKeys.length = 0
    },
    put: (item: Record<string, unknown>) => {
      stored.set(
        memoryKey(item.workspaceId, item.recordKey),
        structuredClone(item),
      )
    },
    remove: (
      workspaceId: string,
      recordKey: string,
    ) => {
      stored.delete(
        memoryKey(workspaceId, recordKey),
      )
    },
    setQueryPageSize: (pageSize: number) => {
      queryPageSize = pageSize
    },
    beforeTransaction: (
      callback: () => void,
    ) => {
      beforeNextTransaction = callback
    },
  }
}

function applyTransactionAction(
  items: Map<string, Record<string, unknown>>,
  action: Record<string, Record<string, unknown>>,
): void {
  const operation =
    action.Put ?? action.Delete ?? action.ConditionCheck
  if (operation === undefined) throw new Error('Unsupported transaction action.')
  const item = operation.Item as Record<string, unknown> | undefined
  const key = (operation.Key ?? item) as Record<string, unknown>
  const mapKey = memoryKey(
    key.workspaceId ?? key.directoryId,
    key.recordKey ?? key.eventId,
  )
  const current = items.get(mapKey)
  if (!matchesCondition(current, operation)) throw conditionalError()
  if (action.Put !== undefined && item !== undefined) items.set(mapKey, structuredClone(item))
  else if (action.Delete !== undefined) items.delete(mapKey)
}

function matchesCondition(
  current: Record<string, unknown> | undefined,
  operation: Record<string, unknown>,
): boolean {
  const condition = operation.ConditionExpression
  if (typeof condition !== 'string') return true
  if (condition === 'attribute_not_exists(workspaceId)') return current === undefined
  if (
    condition ===
    'attribute_not_exists(workspaceId) OR expiresAtEpoch <= :operationReceiptNowEpoch'
  ) {
    const values = operation.ExpressionAttributeValues as Record<string, unknown>
    return (
      current === undefined ||
      Number(current.expiresAtEpoch) <=
        Number(values[':operationReceiptNowEpoch'])
    )
  }
  if (condition === 'attribute_not_exists(preferenceRevision)') {
    return current?.preferenceRevision === undefined
  }
  if (
    condition ===
    'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)'
  ) {
    return current === undefined
  }
  if (condition === 'attribute_not_exists(revokedAt)') return current?.revokedAt === undefined
  if (condition === 'attribute_not_exists(userId) OR userId = :userId') {
    const values = operation.ExpressionAttributeValues as Record<string, unknown>
    return current?.userId === undefined || current.userId === values[':userId']
  }
  const values = operation.ExpressionAttributeValues as Record<string, unknown>
  if (condition === 'revision = :expectedRevision') {
    return current?.revision === values[':expectedRevision']
  }
  if (
    condition ===
    'revision = :expectedDocumentAuthorizationRevision'
  ) {
    return current?.revision ===
      values[':expectedDocumentAuthorizationRevision']
  }
  if (condition === 'updatedAt = :updatedAt') {
    return current?.updatedAt === values[':updatedAt']
  }
  if (condition === 'preferenceRevision = :expectedPreferenceRevision') {
    return (
      current?.preferenceRevision ===
        values[':expectedPreferenceRevision']
    )
  }
  if (
    condition ===
    'resolved = :unresolved AND updatedAt = :parentUpdatedAt'
  ) {
    return (
      current?.resolved === values[':unresolved'] &&
      current?.updatedAt === values[':parentUpdatedAt']
    )
  }
  if (condition === 'clientId = :clientId') {
    return current?.clientId === values[':clientId']
  }
  if (
    condition.includes(
      '#entryType = :entryType',
    ) &&
    condition.includes(
      'targetKind = :targetKind',
    ) &&
    condition.includes(
      'targetId = :targetId',
    ) &&
    condition.includes(
      '#version = :expectedVersion',
    )
  ) {
    const expectedCount =
      values[':expectedCount'] ??
      values[':zero']
    return (
      current?.entryType ===
        values[':entryType'] &&
      current?.schemaVersion ===
        values[':schemaVersion'] &&
      current?.targetKind ===
        values[':targetKind'] &&
      current?.targetId ===
        values[':targetId'] &&
      current?.activeBacklinkCount ===
        expectedCount &&
      current?.version ===
        values[':expectedVersion'] &&
      (
        !condition.includes(
          'attribute_not_exists(deletedAt)',
        ) ||
        current?.deletedAt === undefined
      )
    )
  }
  if (condition.includes('#authorization')) {
    const names =
      operation.ExpressionAttributeNames as
        | Record<string, string>
        | undefined
    const valueEntries =
      operation.ExpressionAttributeValues as
        | Record<string, unknown>
        | undefined
    if (names === undefined || valueEntries === undefined) {
      return false
    }
    if (
      condition.includes(
        'attribute_not_exists(#authorizationKey)',
      ) &&
      current === undefined
    ) {
      return true
    }
    return [
      ...condition.matchAll(
        /(#authorization\d+) = (:authorization\d+)/gu,
      ),
    ].every(([, name, value]) =>
      current?.[names[name!]] ===
        valueEntries[value!]
    )
  }
  throw new Error(`Unsupported condition: ${condition}`)
}

function memoryKey(workspaceId: unknown, recordKey: unknown): string {
  return `${String(workspaceId)}\0${String(recordKey)}`
}

function conditionalError(): Error {
  return transactionCancellationError([
    'ConditionalCheckFailed',
  ])
}

function transactionCancellationError(
  cancellationReasonCodes: readonly string[],
): Error {
  const error = new Error('transaction canceled')
  error.name = 'TransactionCanceledException'
  Object.assign(error, {
    CancellationReasons:
      cancellationReasonCodes.map((Code) => ({ Code })),
  })
  return error
}
