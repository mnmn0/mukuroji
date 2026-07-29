import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceStateIdentity,
} from './workspace-search-writer-fence'
import type { WorkspaceSearchWriterFenceAwsTableNames } from './workspace-search-writer-fence-aws'
import {
  bindWorkspaceSearchWriterFenceDocumentClient,
  bindWorkspaceSearchWriterFenceRolloutPendingDocumentClient,
  throwIfWorkspaceSearchWriterFenceTerminalError,
  WorkspaceSearchWriterFenceRolloutPendingError,
  WorkspaceSearchWriterFenceTransactionOutcomeError,
} from './workspace-search-writer-fence-document-client'
import {
  createWorkspaceSearchWriterFenceGuardProvider,
  runWithWorkspaceSearchWriterFenceInvocation,
} from './workspace-search-writer-fence-invocation'
import {
  WorkspaceSearchWriterFenceBlockedError,
  WorkspaceSearchWriterFenceTransactionPreparationError,
} from './workspace-search-writer-fence-transaction'

/** Exact table names covered by the application writer fence. */
const tableNames: WorkspaceSearchWriterFenceAwsTableNames = Object.freeze({
  'project-directory': 'ProjectDirectory',
  'work-items': 'WorkItems',
  collaboration: 'Collaboration',
  documents: 'Documents',
  'workspace-search': 'WorkspaceSearch',
  'migration-state': 'WorkspaceSearchMigrationState',
})

/**
 * Creates deterministic open-row guard material for middleware tests.
 *
 * @returns Exact valid guard material.
 */
function createGuardFixture(): WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity = {
    role: 'migration-state',
    tableName: tableNames['migration-state'],
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState',
    tableId: 'migration-state-primary',
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
  }
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTableIdentity.tableName,
    stateTableId: stateTableIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': 'project-directory-primary',
      'work-items': 'work-items-primary',
      collaboration: 'collaboration-primary',
      documents: 'documents-primary',
      'workspace-search': 'workspace-search-primary',
      'migration-state': stateTableIdentity.tableId,
    },
  })
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  return createWorkspaceSearchWriterFenceGuardMaterial(
    parseWorkspaceSearchWriterFenceObservation(
      encodeWorkspaceSearchWriterFenceRecord(open),
      binding,
    ),
    binding,
    stateTableIdentity,
  )
}

/**
 * Creates a real DocumentClient while capturing only the installed middleware.
 *
 * @param additionalFencedMutationTableNames - Additional mutation tables to
 * include in the durable fence.
 * @returns Isolated middleware invocation harness.
 */
function createMiddlewareHarness(
  additionalFencedMutationTableNames: readonly string[] = [],
) {
  const lowLevelClient = new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  let registeredMiddleware: unknown
  const addSpy = spyOn(documentClient.middlewareStack, 'add')
  addSpy.mockImplementation((middleware: unknown) => {
    registeredMiddleware = middleware
  })

  let acquisitionCount = 0
  const source = {
    /**
     * Acquires the deterministic test guard.
     *
     * @returns Exact open-row material.
     */
    async acquire() {
      acquisitionCount += 1
      return createGuardFixture()
    },
  }
  const provider = createWorkspaceSearchWriterFenceGuardProvider(source)
  bindWorkspaceSearchWriterFenceDocumentClient(
    documentClient,
    provider,
    tableNames,
    additionalFencedMutationTableNames,
  )
  addSpy.mockRestore()

  if (typeof registeredMiddleware !== 'function') {
    throw new Error('Expected the writer-fence middleware to be registered.')
  }
  const middleware = registeredMiddleware

  const forwardedInputs: object[] = []

  /**
   * Executes the captured initialize middleware in a fresh logical invocation.
   *
   * @param input - Command input presented to the middleware.
   * @param terminalFailure - Optional downstream failure.
   * @param commandName - Smithy command name.
   * @returns Downstream handler result.
   */
  async function invoke(
    input: object,
    terminalFailure?: unknown,
    commandName = 'TransactWriteItemsCommand',
  ): Promise<unknown> {
    /**
     * Captures the exact input forwarded by the middleware.
     *
     * @param arguments_ - Initialize handler arguments.
     * @returns Minimal downstream Smithy result.
     */
    async function next(arguments_: { input: object }) {
      forwardedInputs.push(arguments_.input)
      if (terminalFailure !== undefined) throw terminalFailure
      return {
        output: {},
        response: {},
      }
    }

    const initialized: unknown = Reflect.apply(
      middleware,
      undefined,
      [next, { commandName }],
    )
    if (typeof initialized !== 'function') {
      throw new Error('Expected initialized writer-fence middleware.')
    }
    return await runWithWorkspaceSearchWriterFenceInvocation(
      async () => await Reflect.apply(initialized, undefined, [{ input }]),
    )
  }

  /**
   * Returns the number of source acquisitions made by the shared provider.
   *
   * @returns Acquisition count.
   */
  function getAcquisitionCount(): number {
    return acquisitionCount
  }

  /**
   * Releases the real SDK clients owned by this harness.
   */
  function destroy(): void {
    documentClient.destroy()
  }

  return {
    destroy,
    forwardedInputs,
    getAcquisitionCount,
    invoke,
  }
}

/**
 * Reads strict transaction items from one captured middleware input.
 *
 * @param input - Captured command input.
 * @returns Transaction items.
 */
function readTransactionItems(
  input: object,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const items = Reflect.get(input, 'TransactItems')
  if (!Array.isArray(items)) {
    throw new Error('Expected captured transaction items.')
  }
  return items
}

/**
 * Creates one covered application transaction.
 *
 * @returns One fenced-table mutation.
 */
function createCoveredTransactionInput(): TransactWriteCommandInput {
  return {
    TransactItems: [{
      Put: {
        TableName: tableNames.documents,
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'document/document-1',
        },
      },
    }],
  }
}

test('prepends exactly one guard to all covered mutations', async () => {
  const harness = createMiddlewareHarness()
  const input: TransactWriteCommandInput = {
    TransactItems: [
      {
        Put: {
          TableName: tableNames['project-directory'],
          Item: { pk: 'directory', sk: 'project/project-1' },
        },
      },
      {
        Update: {
          TableName: tableNames['work-items'],
          Key: { pk: 'team/team-1', sk: 'issue/issue-1' },
          UpdateExpression: 'SET #title = :title',
          ExpressionAttributeNames: { '#title': 'title' },
          ExpressionAttributeValues: { ':title': 'Updated' },
        },
      },
      {
        Delete: {
          TableName: tableNames.collaboration,
          Key: { pk: 'workspace/workspace-1', sk: 'presence/user-1' },
        },
      },
      {
        Put: {
          TableName: tableNames.documents,
          Item: { pk: 'workspace/workspace-1', sk: 'document/document-1' },
        },
      },
      {
        Update: {
          TableName: tableNames['workspace-search'],
          Key: {
            workspaceId: 'workspace-1',
            recordKey: 'search/work-item/issue-1',
          },
          UpdateExpression: 'SET #title = :title',
          ExpressionAttributeNames: { '#title': 'title' },
          ExpressionAttributeValues: { ':title': 'Indexed' },
        },
      },
    ],
  }

  try {
    await harness.invoke(input)

    expect(harness.getAcquisitionCount()).toBe(1)
    expect(harness.forwardedInputs).toHaveLength(1)
    const forwardedItems = readTransactionItems(
      harness.forwardedInputs[0] ?? {},
    )
    expect(forwardedItems).toHaveLength(6)
    expect(forwardedItems[0]).toMatchObject({
      ConditionCheck: {
        TableName: tableNames['migration-state'],
        Key: {
          migrationId: 'workspace-search-maintenance',
        },
      },
    })
    expect(forwardedItems.slice(1)).toEqual(readTransactionItems(input))
    expect(input.TransactItems).toHaveLength(5)
  } finally {
    harness.destroy()
  }
})

test('guards transactions that only mutate an additional rollback table', async () => {
  const harness = createMiddlewareHarness(['DeveloperPlatform'])
  const update = {
    Update: {
      TableName: 'DeveloperPlatform',
      Key: {
        workspaceId: 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3',
        recordKey: 'STATE',
      },
      UpdateExpression: 'SET #value.#state = :rollback',
      ExpressionAttributeNames: {
        '#value': 'value',
        '#state': 'state',
      },
      ExpressionAttributeValues: {
        ':rollback': 'rollback',
      },
    },
  }

  try {
    await harness.invoke({
      TransactItems: [update],
    } satisfies TransactWriteCommandInput)

    expect(harness.getAcquisitionCount()).toBe(1)
    expect(harness.forwardedInputs).toHaveLength(1)
    const forwardedItems = readTransactionItems(
      harness.forwardedInputs[0] ?? {},
    )
    expect(forwardedItems).toHaveLength(2)
    expect(forwardedItems[0]).toMatchObject({
      ConditionCheck: {
        TableName: tableNames['migration-state'],
        Key: {
          migrationId: 'workspace-search-maintenance',
        },
      },
    })
    expect(forwardedItems[1]).toEqual(update)
  } finally {
    harness.destroy()
  }
})

test('guards real DocumentClient sends using low-level Smithy command names', async () => {
  let acquisitionCount = 0
  let requestCount = 0
  let transactionBody: unknown
  const lowLevelClient = new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
    requestHandler: {
      async handle(request: unknown) {
        requestCount += 1
        if (typeof request !== 'object' || request === null) {
          throw new Error('Expected a serialized HTTP request.')
        }
        const body = Reflect.get(request, 'body')
        if (typeof body !== 'string') {
          throw new Error('Expected a serialized JSON request body.')
        }
        transactionBody = JSON.parse(body)
        return {
          response: {
            body: new TextEncoder().encode('{}'),
            headers: {},
            statusCode: 200,
          },
        }
      },
    },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      return createGuardFixture()
    },
  })
  bindWorkspaceSearchWriterFenceDocumentClient(
    documentClient,
    provider,
    tableNames,
  )

  try {
    await runWithWorkspaceSearchWriterFenceInvocation(
      async () => await documentClient.send(
        new TransactWriteCommand(createCoveredTransactionInput()),
      ),
    )

    expect(acquisitionCount).toBe(1)
    expect(requestCount).toBe(1)
    expect(transactionBody).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: tableNames['migration-state'],
          },
        },
        {
          Put: {
            TableName: tableNames.documents,
          },
        },
      ],
    })

    await expect(
      documentClient.send(new PutCommand({
        TableName: tableNames.documents,
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'document/document-2',
        },
      })),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchWriterFenceTransactionPreparationError,
    )
    expect(requestCount).toBe(1)
  } finally {
    documentClient.destroy()
  }
})

test('blocks fenced mutations during rollout-pending before network I/O', async () => {
  let requestCount = 0
  const lowLevelClient = new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
    requestHandler: {
      async handle() {
        requestCount += 1
        return {
          response: {
            body: new TextEncoder().encode('{}'),
            headers: {},
            statusCode: 200,
          },
        }
      },
    },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  bindWorkspaceSearchWriterFenceRolloutPendingDocumentClient(
    documentClient,
    tableNames,
  )

  try {
    await expect(
      documentClient.send(
        new TransactWriteCommand(createCoveredTransactionInput()),
      ),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchWriterFenceRolloutPendingError,
    )
    await expect(
      documentClient.send(new PutCommand({
        TableName: tableNames.documents,
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'document/document-2',
        },
      })),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING',
    })
    expect(requestCount).toBe(0)

    await documentClient.send(new PutCommand({
      TableName: 'AuditEvents',
      Item: {
        workspaceId: 'workspace-1',
        eventId: 'event-1',
      },
    }))
    expect(requestCount).toBe(1)
  } finally {
    documentClient.destroy()
  }
})

test('does not acquire for unrelated or ConditionCheck-only transactions', async () => {
  const harness = createMiddlewareHarness()
  const unrelatedInput: TransactWriteCommandInput = {
    TransactItems: [{
      Put: {
        TableName: 'AuditEvents',
        Item: { pk: 'audit', sk: 'event/event-1' },
      },
    }],
  }
  const conditionOnlyInput: TransactWriteCommandInput = {
    TransactItems: [{
      ConditionCheck: {
        TableName: tableNames.documents,
        Key: { pk: 'workspace/workspace-1', sk: 'document/document-1' },
        ConditionExpression: 'attribute_exists(pk)',
      },
    }],
  }

  try {
    await harness.invoke(unrelatedInput)
    await harness.invoke(conditionOnlyInput)

    expect(harness.getAcquisitionCount()).toBe(0)
    expect(harness.forwardedInputs).toEqual([
      unrelatedInput,
      conditionOnlyInput,
    ])
  } finally {
    harness.destroy()
  }
})

test('rejects covered direct, batch, and PartiQL writes before serialization', async () => {
  const harness = createMiddlewareHarness()
  const directPut = {
    TableName: tableNames.documents,
    Item: {
      workspaceId: 'workspace-1',
      recordKey: 'document/document-1',
    },
  }
  const batchWrite = {
    RequestItems: {
      [tableNames['work-items']]: [{
        DeleteRequest: {
          Key: {
            directoryTeamId: 'workspace-1#team#team-1',
            issueId: 'issue-1',
          },
        },
      }],
    },
  }
  const tableArn =
    'arn:aws:dynamodb:ap-northeast-1:123456789012:table/Documents'
  const directArnPut = {
    TableName: tableArn,
    Item: {
      workspaceId: 'workspace-1',
      recordKey: 'document/document-1',
    },
  }
  const batchArnWrite = {
    RequestItems: {
      [tableArn]: [{
        PutRequest: {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: 'document/document-1',
          },
        },
      }],
    },
  }
  const partiQlWrite = {
    Statement: 'DELETE FROM "Documents" WHERE workspaceId = ?',
    Parameters: ['workspace-1'],
  }
  const partiQlTransaction = {
    TransactStatements: [{
      Statement: 'UPDATE "WorkItems" SET title = ? WHERE issueId = ?',
      Parameters: ['updated', 'issue-1'],
    }],
  }
  const unsupportedCommands: readonly (readonly [string, object])[] = [
    ['PutItemCommand', directPut],
    ['PutItemCommand', directArnPut],
    ['BatchWriteItemCommand', batchWrite],
    ['BatchWriteItemCommand', batchArnWrite],
    ['ExecuteStatementCommand', partiQlWrite],
    ['ExecuteTransactionCommand', partiQlTransaction],
  ]

  try {
    for (const [commandName, input] of unsupportedCommands) {
      await expect(
        harness.invoke(input, undefined, commandName),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchWriterFenceTransactionPreparationError,
      )
    }
    expect(harness.getAcquisitionCount()).toBe(0)
    expect(harness.forwardedInputs).toHaveLength(0)
  } finally {
    harness.destroy()
  }
})

test('guards transaction mutations addressed through a table ARN', async () => {
  const harness = createMiddlewareHarness()
  const input = {
    TransactItems: [{
      Put: {
        TableName:
          'arn:aws:dynamodb:ap-northeast-1:123456789012:table/Documents',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'document/document-1',
        },
      },
    }],
  }

  try {
    await harness.invoke(input)

    expect(harness.getAcquisitionCount()).toBe(1)
    expect(
      readTransactionItems(harness.forwardedInputs[0] ?? {}),
    ).toHaveLength(2)
  } finally {
    harness.destroy()
  }
})

test('allows direct and batch writes that target only unrelated tables', async () => {
  const harness = createMiddlewareHarness()
  const directPut = {
    TableName: 'AuditEvents',
    Item: { pk: 'audit', sk: 'event/event-1' },
  }
  const batchWrite = {
    RequestItems: {
      EnterpriseIdentity: [{
        PutRequest: {
          Item: { pk: 'identity', sk: 'member/member-1' },
        },
      }],
    },
  }

  try {
    await harness.invoke(directPut, undefined, 'PutItemCommand')
    await harness.invoke(batchWrite, undefined, 'BatchWriteItemCommand')

    expect(harness.getAcquisitionCount()).toBe(0)
    expect(harness.forwardedInputs).toEqual([directPut, batchWrite])
  } finally {
    harness.destroy()
  }
})

test('fails closed when a covered transaction contains a non-strict item', async () => {
  const harness = createMiddlewareHarness()
  const coveredItemWithIgnoredMember = {
    TransactItems: [{
      Put: {
        TableName: tableNames.documents,
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'document/document-1',
        },
      },
      metadata: true,
    }],
  }
  const coveredItemWithMalformedPeer = {
    TransactItems: [
      ...readTransactionItems(createCoveredTransactionInput()),
      { metadata: true },
    ],
  }

  try {
    for (const input of [
      coveredItemWithIgnoredMember,
      coveredItemWithMalformedPeer,
    ]) {
      await expect(harness.invoke(input)).rejects.toBeInstanceOf(
        WorkspaceSearchWriterFenceTransactionPreparationError,
      )
    }
    expect(harness.getAcquisitionCount()).toBe(0)
    expect(harness.forwardedInputs).toHaveLength(0)
  } finally {
    harness.destroy()
  }
})

test('maps guard cancellation reason zero to the stable blocked error', async () => {
  const harness = createMiddlewareHarness()
  const cancellation = {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed' },
      { Code: 'None' },
    ],
  }

  try {
    await expect(
      harness.invoke(createCoveredTransactionInput(), cancellation),
    ).rejects.toBeInstanceOf(WorkspaceSearchWriterFenceBlockedError)
    await expect(
      harness.invoke(createCoveredTransactionInput(), cancellation),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SEARCH_WRITER_FENCE_BLOCKED',
    })
  } finally {
    harness.destroy()
  }
})

test('restores application-relative cancellation reason indices', async () => {
  const harness = createMiddlewareHarness()
  const applicationReasons = [
    { Code: 'ConditionalCheckFailed', Message: 'application conflict' },
    { Code: 'None' },
  ]
  const cancellation = {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'None' },
      ...applicationReasons,
    ],
  }

  try {
    await expect(
      harness.invoke({
        TransactItems: [
          ...readTransactionItems(createCoveredTransactionInput()),
          {
            Put: {
              TableName: 'AuditEvents',
              Item: { pk: 'audit', sk: 'event/event-1' },
            },
          },
        ],
      }, cancellation),
    ).rejects.toBe(cancellation)
    expect(cancellation.CancellationReasons).toEqual(applicationReasons)
  } finally {
    harness.destroy()
  }
})

test('fails closed for missing, truncated, or invalid cancellation reasons', async () => {
  const harness = createMiddlewareHarness()
  const failures: readonly object[] = [
    { name: 'TransactionCanceledException' },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [],
    },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }],
    },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'ProvisionedThroughputExceeded' },
        { Code: 'None' },
      ],
    },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        null,
        { Code: 'None' },
      ],
    },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'None' },
        null,
      ],
    },
    Object.freeze({
      name: 'TransactionCanceledException',
      CancellationReasons: Object.freeze([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]),
    }),
  ]

  try {
    for (const failure of failures) {
      await expect(
        harness.invoke(createCoveredTransactionInput(), failure),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchWriterFenceTransactionOutcomeError,
      )
    }
    await expect(harness.invoke({
      TransactItems: [
        ...readTransactionItems(createCoveredTransactionInput()),
        {
          Put: {
            TableName: 'AuditEvents',
            Item: { pk: 'audit', sk: 'event/event-1' },
          },
        },
      ],
    }, {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ],
    })).rejects.toBeInstanceOf(
      WorkspaceSearchWriterFenceTransactionOutcomeError,
    )
  } finally {
    harness.destroy()
  }
})

test('preserves downstream terminal failures by identity', async () => {
  const harness = createMiddlewareHarness()
  const terminalFailure = Object.assign(
    new Error('terminal writer-fence failure'),
    {
      code: 'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE',
    },
  )

  try {
    await expect(
      harness.invoke(createCoveredTransactionInput(), terminalFailure),
    ).rejects.toBe(terminalFailure)
    const terminalCodes: readonly string[] = [
      'INVALID_WORKSPACE_SEARCH_WRITER_FENCE',
      'INVALID_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION',
      'UNCLASSIFIED_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION',
      'WORKSPACE_SEARCH_WRITER_FENCE_BLOCKED',
      'WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SCOPE_REQUIRED',
      'WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SOURCE_MISMATCH',
      'WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING',
      'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE',
    ]
    for (const code of terminalCodes) {
      const failure = Object.assign(new Error(code), { code })
      expect(() =>
        throwIfWorkspaceSearchWriterFenceTerminalError(failure)
      ).toThrow(failure)
    }
    expect(() =>
      throwIfWorkspaceSearchWriterFenceTerminalError(
        new Error('unrelated failure'),
      )
    ).not.toThrow()
  } finally {
    harness.destroy()
  }
})

test('reserves one DynamoDB transaction slot and rejects one hundred actions', async () => {
  const harness = createMiddlewareHarness()
  /**
   * Creates the requested number of covered application actions.
   *
   * @param count - Application action count.
   * @returns Covered transaction items.
   */
  const createApplicationItems = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      Put: {
        TableName: tableNames['workspace-search'],
        Item: {
          workspaceId: 'workspace-1',
          recordKey: `search/work-item/${index}`,
        },
      },
    }))

  try {
    await harness.invoke({
      TransactItems: createApplicationItems(99),
    })
    expect(
      readTransactionItems(harness.forwardedInputs[0] ?? {}),
    ).toHaveLength(100)

    await expect(harness.invoke({
      TransactItems: createApplicationItems(100),
    })).rejects.toBeInstanceOf(
      WorkspaceSearchWriterFenceTransactionPreparationError,
    )
    expect(harness.forwardedInputs).toHaveLength(1)
  } finally {
    harness.destroy()
  }
})
