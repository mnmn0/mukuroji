import { describe, expect, test } from 'bun:test'
import {
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest,
} from './migration-describe-table-binding'
import {
  createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointRequestedBinding,
} from './migration-describe-table-rate-budget-aws'
import {
  type WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
} from './migration-describe-table-rate-budget'

const requestedAccount = '123456789012'
const requestedRegion = 'ap-northeast-1'
const scopeBindingDigest =
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
    requestedAccount,
    requestedRegion,
  )
const transportBindingDigest = 'c'.repeat(64)
const policyVersion = 'd'.repeat(64)

/** Exact valid reviewed policy fixture. */
const ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy =
  Object.freeze({
    policyVersion,
    maximumAttemptsPerWindow: 200,
    maximumAttemptsPerLifecycle: 200,
    checkpointPageAttemptCapacity: 182,
    windowMilliseconds: 60_000,
    minimumAttemptIntervalMilliseconds: 100,
    minimumPageIntervalMilliseconds: 1_000,
    maximumAdmissionWaitMilliseconds: 30_000,
    throttleBackoffInitialMilliseconds: 500,
    throttleBackoffMaximumMilliseconds: 5_000,
  })

/**
 * Deterministic fake retaining every low-level command for assertions.
 */
class FakeRateCheckpointTransport
  implements WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport {
  /** Captured strongly consistent reads. */
  readonly getCommands: GetItemCommand[] = []

  /** Captured one-Put transaction writes. */
  readonly transactWriteCommands: TransactWriteItemsCommand[] = []

  /** Configured raw GetItem response. */
  getOutput: GetItemCommandOutput = { $metadata: {} }

  /** Configured raw TransactWriteItems response. */
  transactWriteOutput: TransactWriteItemsCommandOutput = {
    $metadata: {},
  }

  /** Optional raw read failure. */
  getFailure: unknown | undefined

  /** Optional raw transaction failure. */
  transactWriteFailure: unknown | undefined

  /**
   * Captures and completes one strongly consistent read.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Configured raw output.
   */
  async getRateCheckpoint(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    if (this.getFailure !== undefined) throw this.getFailure
    return this.getOutput
  }

  /**
   * Captures and completes one transaction containing the conditional Put.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Configured raw output.
   */
  async transactWriteRateCheckpoint(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactWriteCommands.push(command)
    if (this.transactWriteFailure !== undefined) {
      throw this.transactWriteFailure
    }
    return this.transactWriteOutput
  }
}

describe('DescribeTable rate checkpoint AWS store', () => {
  test('atomically creates and strongly reloads one deterministic bound row', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    const checkpoint = createCheckpoint()

    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint,
    })).toBe('stored')
    expect(transport.getCommands).toHaveLength(0)
    expect(transport.transactWriteCommands).toHaveLength(1)

    const transaction = requireOnlyTransactionCommand(transport)
    expect(transaction.input.TransactItems).toHaveLength(1)
    const put = requireTransactionPut(transaction)
    expect(put.TableName).toBe('migration-state-table')
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND ' +
        'attribute_not_exists(#recordKey)',
    )
    const item = requirePutItem(put)
    expect(readStringAttribute(item, 'migrationId')).toBe(
      WORKSPACE_SEARCH_MIGRATION_ID,
    )
    const recordKey = readStringAttribute(item, 'recordKey')
    expect(recordKey).toMatch(
      /^describe-table-rate-budget\/v1\/[a-f0-9]{64}$/u,
    )
    expect(recordKey).not.toContain(scopeBindingDigest)
    expect(readStringAttribute(item, 'scopeBindingDigest')).toBe(
      scopeBindingDigest,
    )

    transport.getOutput = { $metadata: {}, Item: item }
    expect(await store.load(scopeBindingDigest)).toEqual(checkpoint)
    expect(transport.getCommands).toHaveLength(1)
    expect(transport.getCommands[0]?.input).toMatchObject({
      TableName: 'migration-state-table',
      ConsistentRead: true,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: { S: recordKey },
      },
    })
  })

  test('authenticates a legacy v1 row and upgrades it on the next CAS', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: createCheckpoint(),
    })).toBe('stored')
    const currentItem = requirePutItem(
      requireTransactionPut(requireOnlyTransactionCommand(transport)),
    )
    const legacyCheckpoint = Object.freeze({
      version: 1,
      scopeBindingDigest,
      transportBindingDigest,
      policy: ratePolicy,
      revision: 0,
      fenceToken: 1,
      writeNonce: 'a'.repeat(64),
      capturedAtEpochMilliseconds: 1_754_006_400_000,
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      reservedAttempts: 0,
      reservationKind: 'none',
      mandatoryCleanupRequired: false,
      attemptInFlight: false,
      attemptInFlightNonce: null,
      sequence: 1,
      throttleCount: 1,
      budgetStopCount: 2,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    })
    const stateTableLocationBindingDigest = createMigrationDigest({
      kind: 'workspace-search-migration-state-table-location-binding',
      version: 1,
      tableName: 'migration-state-table',
    })
    const checkpointJson = JSON.stringify(legacyCheckpoint)
    transport.getOutput = {
      $metadata: {},
      Item: {
        ...currentItem,
        checkpointJson: { S: checkpointJson },
        checkpointDigest: {
          S: createMigrationDigest({
            kind:
              'workspace-search-migration-describe-table-rate-checkpoint',
            version: 1,
            stateTableLocationBindingDigest,
            checkpoint: legacyCheckpoint,
          }),
        },
      },
    }

    expect(await store.load(scopeBindingDigest)).toEqual({
      version: 2,
      scopeBindingDigest,
      transportBindingDigest,
      policy: ratePolicy,
      revision: 0,
      fenceToken: 1,
      writeNonce: 'a'.repeat(64),
      capturedAtEpochMilliseconds: 1_754_006_400_000,
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      reservedAttempts: 0,
      reservationKind: 'none',
      mandatoryCleanupRequired: false,
      attemptInFlight: false,
      attemptInFlightNonce: null,
      sequence: 1,
      throttleCount: 1,
      awsServiceThrottleCount: 1,
      rehearsalInjectedThrottleCount: 0,
      budgetStopCount: 2,
      operationalBudgetStopCount: 1,
      awsServiceThrottleBudgetStopCount: 1,
      rehearsalInjectedBudgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    })

    const invalidLegacyCheckpoint = Object.freeze({
      ...legacyCheckpoint,
      budgetStopCount: 0,
    })
    transport.getOutput = {
      $metadata: {},
      Item: {
        ...currentItem,
        checkpointJson: { S: JSON.stringify(invalidLegacyCheckpoint) },
        checkpointDigest: {
          S: createMigrationDigest({
            kind:
              'workspace-search-migration-describe-table-rate-checkpoint',
            version: 1,
            stateTableLocationBindingDigest,
            checkpoint: invalidLegacyCheckpoint,
          }),
        },
      },
    }
    await expect(store.load(scopeBindingDigest)).rejects.toThrow(
      'Workspace Search migration DescribeTable rate checkpoint storage failed.',
    )
    transport.getOutput = {
      $metadata: {},
      Item: {
        ...currentItem,
        checkpointJson: { S: checkpointJson },
        checkpointDigest: {
          S: createMigrationDigest({
            kind:
              'workspace-search-migration-describe-table-rate-checkpoint',
            version: 1,
            stateTableLocationBindingDigest,
            checkpoint: legacyCheckpoint,
          }),
        },
      },
    }

    const successor = Object.freeze({
      ...createCheckpoint({
        revision: 1,
        fenceToken: 2,
        writeNonce: 'e'.repeat(64),
      }),
      attemptCount: 1,
      sequence: 1,
      throttleCount: 1,
      awsServiceThrottleCount: 1,
      budgetStopCount: 2,
      operationalBudgetStopCount: 1,
      awsServiceThrottleBudgetStopCount: 1,
      maximumInFlight: 1,
    })
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: 0,
      checkpoint: successor,
    })).toBe('stored')
    const upgradedItem = requirePutItem(
      requireTransactionPut(requireLastTransactionCommand(transport)),
    )
    expect(readStringAttribute(upgradedItem, 'checkpointJson')).toContain(
      '"rehearsalInjectedThrottleCount":0',
    )
  })

  test('updates only the exact validated predecessor revision, digest, and fence', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    const predecessor = createCheckpoint()
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: predecessor,
    })).toBe('stored')
    const predecessorItem = requirePutItem(
      requireTransactionPut(requireOnlyTransactionCommand(transport)),
    )
    transport.getOutput = { $metadata: {}, Item: predecessorItem }

    const successor = createCheckpoint({
      revision: 1,
      fenceToken: 2,
      writeNonce: 'e'.repeat(64),
    })
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: 0,
      checkpoint: successor,
    })).toBe('stored')
    expect(transport.getCommands).toHaveLength(1)
    expect(transport.transactWriteCommands).toHaveLength(2)

    const updateTransaction = transport.transactWriteCommands[1]
    if (updateTransaction === undefined) {
      throw new Error('Expected one update transaction.')
    }
    const update = requireTransactionPut(updateTransaction)
    expect(update.ConditionExpression).toContain(
      '#checkpointRevision = :expectedRevision',
    )
    expect(update.ConditionExpression).toContain(
      '#checkpointFenceToken <= :successorFenceToken',
    )
    expect(update.ConditionExpression).toContain(
      '#checkpointDigest = :expectedCheckpointDigest',
    )
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':expectedRevision': { N: '0' },
      ':successorFenceToken': { N: '2' },
      ':expectedCheckpointDigest': {
        S: readStringAttribute(predecessorItem, 'checkpointDigest'),
      },
    })
    expect(readNumberAttribute(requirePutItem(update), 'checkpointRevision'))
      .toBe(1)
  })

  test('returns conflict for a conditional create race and a lower-fence update', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    const conditionalFailure = new Error(
      'raw conflicting resource should not escape',
    )
    conditionalFailure.name = 'TransactionCanceledException'
    Object.defineProperty(conditionalFailure, 'CancellationReasons', {
      enumerable: true,
      value: [{ Code: 'ConditionalCheckFailed' }],
    })
    transport.transactWriteFailure = conditionalFailure

    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: createCheckpoint(),
    })).toBe('conflict')

    const unrelatedCancellation = new Error(
      'secret transaction cancellation detail',
    )
    unrelatedCancellation.name = 'TransactionCanceledException'
    Object.defineProperty(unrelatedCancellation, 'CancellationReasons', {
      enumerable: true,
      value: [{ Code: 'TransactionConflict' }],
    })
    transport.transactWriteFailure = unrelatedCancellation
    const unrelatedFailure = await captureFailure(async () =>
      await store.compareAndSwap({
        scopeBindingDigest,
        expectedRevision: null,
        checkpoint: createCheckpoint(),
      }))
    expect(unrelatedFailure).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
    })
    expect(String(unrelatedFailure)).not.toContain('secret transaction')

    transport.transactWriteFailure = undefined
    const current = createCheckpoint({ fenceToken: 5 })
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: current,
    })).toBe('stored')
    const currentItem = requirePutItem(
      requireTransactionPut(requireLastTransactionCommand(transport)),
    )
    transport.getOutput = { $metadata: {}, Item: currentItem }
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: 0,
      checkpoint: createCheckpoint({
        revision: 1,
        fenceToken: 4,
        writeNonce: 'f'.repeat(64),
      }),
    })).toBe('conflict')
  })

  test('fails closed when a loaded row has any uncontrolled attribute', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    expect(await store.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: createCheckpoint(),
    })).toBe('stored')
    transport.getOutput = {
      $metadata: {},
      Item: {
        ...requirePutItem(
          requireTransactionPut(
            requireOnlyTransactionCommand(transport),
          ),
        ),
        unexpectedOwner: { S: 'operator-secret' },
      },
    }

    const failure = await captureFailure(
      async () => await store.load(scopeBindingDigest),
    )
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    expect(failure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search migration DescribeTable rate checkpoint storage failed.',
    })
    expect(String(failure)).not.toContain('operator-secret')
  })

  test('redacts raw resource, run, owner, and cursor transport errors', async () => {
    const transport = new FakeRateCheckpointTransport()
    const store = createStore(transport)
    transport.getFailure = new Error(
      'table=secret-resource run=secret-run owner=secret-owner cursor=secret-cursor',
    )

    const failure = await captureFailure(
      async () => await store.load(scopeBindingDigest),
    )
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    expect(failure).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      message:
        'Workspace Search migration DescribeTable rate checkpoint storage failed.',
    })
    for (const secret of [
      'secret-resource',
      'secret-run',
      'secret-owner',
      'secret-cursor',
    ]) {
      expect(String(failure)).not.toContain(secret)
    }
  })

  test('strictly validates the pre-measurement requested binding and scope', async () => {
    const transport = new FakeRateCheckpointTransport()
    for (const binding of [
      createRequestedBinding({ account: '123' }),
      createRequestedBinding({ region: 'AP-NORTHEAST-1' }),
      createRequestedBinding({ tableName: 'x' }),
    ]) {
      const failure = captureSynchronousFailure(() =>
        createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore({
          binding,
          transport,
        }))
      expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    const bindingWithExtra = {
      ...createRequestedBinding(),
      tableId: 'must-not-be-required-before-DescribeTable',
    }
    expect(captureSynchronousFailure(() =>
      createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore({
        binding: bindingWithExtra,
        transport,
      }))).toMatchObject({ code: 'INVALID_ARGUMENT' })

    const store = createStore(transport)
    const otherScope = 'f'.repeat(64)
    expect(await captureFailure(
      async () => await store.load(otherScope),
    )).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(transport.getCommands).toHaveLength(0)
    expect(await captureFailure(async () =>
      await store.compareAndSwap({
        scopeBindingDigest: otherScope,
        expectedRevision: null,
        checkpoint: createCheckpoint({
          scopeBindingDigest: otherScope,
        }),
      }))).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(transport.transactWriteCommands).toHaveLength(0)
  })

  test('requires an explicit bootstrap CAS after checkpoint loss or table replacement', async () => {
    const replacementTransport = new FakeRateCheckpointTransport()
    const replacementStore = createStore(replacementTransport)

    expect(await replacementStore.load(scopeBindingDigest)).toBeUndefined()
    expect(replacementTransport.transactWriteCommands).toHaveLength(0)
    expect(await replacementStore.compareAndSwap({
      scopeBindingDigest,
      expectedRevision: null,
      checkpoint: createCheckpoint(),
    })).toBe('stored')
    expect(replacementTransport.transactWriteCommands).toHaveLength(1)
  })
})

/**
 * Creates one store bound to the canonical test table.
 *
 * @param transport - Deterministic fake transport.
 * @returns Production AWS checkpoint store.
 */
function createStore(
  transport: WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport,
) {
  return createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore({
    binding: createRequestedBinding(),
    transport,
  })
}

/** Optional overrides for the requested pre-measurement binding. */
type RequestedBindingOverrides = {
  /** Requested AWS account override. */
  readonly account?: string
  /** Requested AWS region override. */
  readonly region?: string
  /** Requested migration-state table override. */
  readonly tableName?: string
}

/**
 * Creates one requested state-table binding without measured table identity.
 *
 * @param overrides - Optional invalid values used by boundary tests.
 * @returns Requested pre-measurement binding fixture.
 */
function createRequestedBinding(
  overrides: RequestedBindingOverrides = {},
): WorkspaceSearchMigrationDescribeTableRateCheckpointRequestedBinding {
  return {
    account: overrides.account ?? requestedAccount,
    region: overrides.region ?? requestedRegion,
    tableName: overrides.tableName ?? 'migration-state-table',
  }
}

/** Optional overrides for the compact checkpoint fixture. */
type CheckpointOverrides = {
  /** CAS revision override. */
  readonly revision?: number
  /** Durable fence override. */
  readonly fenceToken?: number
  /** Unique write nonce override. */
  readonly writeNonce?: string
  /** Opaque account/region scope override. */
  readonly scopeBindingDigest?: string
}

/**
 * Creates one empty valid rate checkpoint.
 *
 * @param overrides - Optional revision, fence, and nonce overrides.
 * @returns Strict checkpoint fixture.
 */
function createCheckpoint(
  overrides: CheckpointOverrides = {},
): WorkspaceSearchMigrationDescribeTableRateCheckpoint {
  return Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
    scopeBindingDigest:
      overrides.scopeBindingDigest ?? scopeBindingDigest,
    transportBindingDigest,
    policy: ratePolicy,
    revision: overrides.revision ?? 0,
    fenceToken: overrides.fenceToken ?? 1,
    writeNonce: overrides.writeNonce ?? 'a'.repeat(64),
    capturedAtEpochMilliseconds: 1_754_006_400_000,
    attemptCount: 0,
    forfeitedAttemptCount: 0,
    reservedAttempts: 0,
    reservationKind: 'none',
    mandatoryCleanupRequired: false,
    attemptInFlight: false,
    attemptInFlightNonce: null,
    sequence: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 0,
  })
}

/**
 * Requires the fake to contain exactly one transaction command.
 *
 * @param transport - Fake transport under assertion.
 * @returns Its only command.
 */
function requireOnlyTransactionCommand(
  transport: FakeRateCheckpointTransport,
): TransactWriteItemsCommand {
  if (transport.transactWriteCommands.length !== 1) {
    throw new Error('Expected exactly one transaction command.')
  }
  const command = transport.transactWriteCommands[0]
  if (command === undefined) {
    throw new Error('Expected one transaction command.')
  }
  return command
}

/**
 * Requires the fake to contain at least one transaction command.
 *
 * @param transport - Fake transport under assertion.
 * @returns Its final command.
 */
function requireLastTransactionCommand(
  transport: FakeRateCheckpointTransport,
): TransactWriteItemsCommand {
  const command = transport.transactWriteCommands.at(-1)
  if (command === undefined) {
    throw new Error('Expected a transaction command.')
  }
  return command
}

/**
 * Requires a transaction to contain exactly one Put operation.
 *
 * @param command - Captured transaction command.
 * @returns Its only Put operation.
 */
function requireTransactionPut(
  command: TransactWriteItemsCommand,
): NonNullable<TransactWriteItem['Put']> {
  const items = command.input.TransactItems
  if (items === undefined || items.length !== 1) {
    throw new Error('Expected exactly one transaction item.')
  }
  const put = items[0]?.Put
  if (put === undefined) throw new Error('Expected one Put operation.')
  return put
}

/**
 * Requires one transaction Put to carry a complete Item.
 *
 * @param put - Captured transaction Put operation.
 * @returns Complete low-level item.
 */
function requirePutItem(
  put: NonNullable<TransactWriteItem['Put']>,
): Readonly<Record<string, AttributeValue>> {
  const item = put.Item
  if (item === undefined) throw new Error('Expected a PutItem item.')
  return item
}

/**
 * Reads one exact string attribute from a test item.
 *
 * @param item - Captured low-level item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = item[name]
  if (
    attribute === undefined ||
    !('S' in attribute) ||
    typeof attribute.S !== 'string'
  ) {
    throw new Error(`Expected string attribute ${name}.`)
  }
  return attribute.S
}

/**
 * Reads one exact integer attribute from a test item.
 *
 * @param item - Captured low-level item.
 * @param name - Required attribute name.
 * @returns Parsed integer value.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = item[name]
  if (
    attribute === undefined ||
    !('N' in attribute) ||
    typeof attribute.N !== 'string'
  ) {
    throw new Error(`Expected number attribute ${name}.`)
  }
  return Number(attribute.N)
}

/**
 * Captures one expected rejected operation without losing its error object.
 *
 * @param operation - Operation expected to reject.
 * @returns Exact caught failure.
 */
async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation()
  } catch (error: unknown) {
    return error
  }
  throw new Error('Expected operation to reject.')
}

/**
 * Captures one expected synchronous construction failure.
 *
 * @param operation - Factory operation expected to throw.
 * @returns Exact caught failure.
 */
function captureSynchronousFailure(
  operation: () => unknown,
): unknown {
  try {
    operation()
  } catch (error: unknown) {
    return error
  }
  throw new Error('Expected operation to throw.')
}
