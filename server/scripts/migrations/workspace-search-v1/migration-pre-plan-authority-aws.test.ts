import { describe, expect, test } from 'bun:test'
import {
  type AttributeValue,
  GetItemCommand,
  type GetItemCommandOutput,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
  type WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
  maintenanceRuntimeControlSurfaces,
} from './maintenance-evidence'

/** Durable discriminator used by the global lease row. */
const leaseKind = 'workspace-search-pre-plan-global-lease'

/** Durable discriminator used by a current maintenance pointer. */
const pointerKind = 'workspace-search-pre-plan-maintenance-pointer'

/** Durable discriminator used by an immutable maintenance receipt. */
const receiptKind = 'workspace-search-pre-plan-maintenance-receipt'

/** Canonical starting point shared by deterministic authority tests. */
const initialTime = '2026-07-25T04:00:00.000Z'

/** One transaction failure injected before or after its atomic write. */
type TransactionFault = {
  /** Whether the fake installs every write before throwing. */
  readonly timing: 'after-commit' | 'before-commit'
  /** Arbitrary raw error that must not cross the adapter boundary. */
  readonly error: unknown
  /** Optional mutation run after a committed write but before response loss. */
  readonly afterCommit?: () => void | Promise<void>
}

/** One condition-checked write prepared against a shared transaction snapshot. */
type PlannedWrite = {
  /** Deterministic record key replaced by the write. */
  readonly recordKey: string
  /** Detached complete low-level item installed atomically. */
  readonly item: Readonly<Record<string, AttributeValue>>
}

/**
 * Mutable adapter-owned clock that always returns a detached Date instance.
 */
class MutableAuthorityClock {
  /** Current finite epoch millisecond supplied to the adapter. */
  private epochMilliseconds: number

  /**
   * Creates a clock at one canonical UTC instant.
   *
   * @param at - Initial canonical timestamp.
   */
  constructor(at: string) {
    this.epochMilliseconds = requireEpochMilliseconds(at)
  }

  /**
   * Returns a detached current clock value.
   *
   * @returns Fresh Date at the configured instant.
   */
  read(): Date {
    return new Date(this.epochMilliseconds)
  }

  /**
   * Moves the test clock to one canonical UTC instant.
   *
   * @param at - Next canonical timestamp.
   */
  set(at: string): void {
    this.epochMilliseconds = requireEpochMilliseconds(at)
  }
}

/**
 * Condition-aware in-memory implementation of the narrow authority transport.
 */
class InMemoryPrePlanAuthorityAwsTransport
  implements WorkspaceSearchMigrationPrePlanAuthorityAwsTransport {
  /** Every strongly consistent point-read command in call order. */
  readonly getCommands: GetItemCommand[] = []

  /** Every attempted transaction command in call order. */
  readonly transactionCommands: TransactWriteItemsCommand[] = []

  /** One marker for every completed pre-write preparation call. */
  readonly prepareCalls: true[] = []

  /** Exact physical table name accepted by the fake. */
  private readonly tableName: string

  /** Durable low-level rows keyed by adapter-generated record key. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** One-shot arbitrary raw GetItem failure. */
  private getFailure: { readonly error: unknown } | undefined

  /** One-shot raw transaction failure with explicit commit timing. */
  private transactionFault: TransactionFault | undefined

  /** One-shot concurrent action immediately before condition evaluation. */
  private beforeTransaction:
    (() => void | Promise<void>) | undefined

  /** One-shot action completed inside the next pre-write preparation. */
  private prepareAction:
    (() => void | Promise<void>) | undefined

  /**
   * Creates a fake scoped to one migration-state table.
   *
   * @param tableName - Exact expected state-table name.
   */
  constructor(tableName: string) {
    this.tableName = tableName
  }

  /**
   * Injects one raw failure into the next point read.
   *
   * @param error - Arbitrary raw value thrown by GetItem.
   */
  failNextGet(error: unknown): void {
    this.getFailure = { error }
  }

  /**
   * Injects one raw failure into the next transaction.
   *
   * @param fault - Commit timing, raw error, and optional post-commit race.
   */
  failNextTransaction(fault: TransactionFault): void {
    this.transactionFault = fault
  }

  /**
   * Schedules concurrent work immediately before the next condition snapshot.
   *
   * @param action - One-shot concurrent operation.
   */
  beforeNextTransaction(
    action: () => void | Promise<void>,
  ): void {
    this.beforeTransaction = action
  }

  /**
   * Schedules one action inside the next state-incarnation preparation.
   *
   * @param action - Work that must finish before the adapter samples commit time.
   */
  beforeNextPrepare(
    action: () => void | Promise<void>,
  ): void {
    this.prepareAction = action
  }

  /**
   * Clears command history without changing durable rows or injected faults.
   */
  clearHistory(): void {
    this.getCommands.length = 0
    this.transactionCommands.length = 0
    this.prepareCalls.length = 0
  }

  /**
   * Returns every detached durable row.
   *
   * @returns Current low-level authority rows.
   */
  readStoredItems():
    readonly Readonly<Record<string, AttributeValue>>[] {
    return [...this.items.values()].map((item) =>
      structuredClone(item)
    )
  }

  /**
   * Returns one detached row selected by its durable discriminator.
   *
   * @param kind - Exact durable row kind.
   * @returns Matching row or undefined.
   */
  readStoredItemByKind(
    kind: string,
  ): Readonly<Record<string, AttributeValue>> | undefined {
    for (const item of this.items.values()) {
      if (readStringAttribute(item, 'kind') === kind) {
        return structuredClone(item)
      }
    }
    return undefined
  }

  /**
   * Replaces an existing row with an exact test-owned low-level item.
   *
   * @param item - Complete row carrying the existing record key.
   */
  replaceStoredItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const recordKey = readStringAttribute(item, 'recordKey')
    if (!this.items.has(recordKey)) {
      throw new Error('Expected one existing authority row.')
    }
    this.items.set(recordKey, structuredClone(item))
  }

  /**
   * Deletes every row with one durable discriminator.
   *
   * @param kind - Exact durable row kind.
   * @returns Number of rows removed.
   */
  deleteStoredItemsByKind(kind: string): number {
    let deleted = 0
    for (const [recordKey, item] of this.items) {
      if (readStringAttribute(item, 'kind') !== kind) continue
      this.items.delete(recordKey)
      deleted += 1
    }
    return deleted
  }

  /**
   * Strongly reads one exact deterministic authority row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Detached stored item when present.
   */
  async getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    requireExpectedTable(command.input.TableName, this.tableName)
    if (command.input.ConsistentRead !== true) {
      throw new Error('Authority reads must be strongly consistent.')
    }
    const recordKey = readCommandRecordKey(command)
    const failure = this.getFailure
    this.getFailure = undefined
    if (failure !== undefined) throw failure.error
    const item = this.items.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined
        ? {}
        : { Item: structuredClone(item) }),
    }
  }

  /**
   * Completes one test-controlled state-incarnation guard.
   */
  async preparePrePlanAuthorityWrite(): Promise<void> {
    const action = this.prepareAction
    this.prepareAction = undefined
    await action?.()
    this.prepareCalls.push(true)
  }

  /**
   * Evaluates every condition against one snapshot before installing writes.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Empty successful low-level response.
   */
  async transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactionCommands.push(command)
    const fault = this.transactionFault
    this.transactionFault = undefined
    if (fault?.timing === 'before-commit') throw fault.error

    const concurrentAction = this.beforeTransaction
    this.beforeTransaction = undefined
    await concurrentAction?.()

    this.applyTransaction(command)
    if (fault?.timing === 'after-commit') {
      await fault.afterCommit?.()
      throw fault.error
    }
    return { $metadata: {} }
  }

  /**
   * Applies supported ConditionCheck and Put entries as one atomic unit.
   *
   * @param command - Exact authority transaction.
   */
  private applyTransaction(command: TransactWriteItemsCommand): void {
    const entries = requireTransactionItems(command)
    const failures: boolean[] = []
    const writes: PlannedWrite[] = []

    for (const entry of entries) {
      if (entry.ConditionCheck !== undefined) {
        const check = entry.ConditionCheck
        requireExpectedTable(check.TableName, this.tableName)
        const recordKey = readKeyRecordKey(check.Key)
        failures.push(!conditionMatches(
          this.items.get(recordKey),
          check.ConditionExpression,
          check.ExpressionAttributeNames,
          check.ExpressionAttributeValues,
        ))
        continue
      }
      if (entry.Put !== undefined) {
        const put = entry.Put
        requireExpectedTable(put.TableName, this.tableName)
        const item = requireAttributeMap(put.Item)
        const recordKey = readStringAttribute(item, 'recordKey')
        failures.push(!conditionMatches(
          this.items.get(recordKey),
          put.ConditionExpression,
          put.ExpressionAttributeNames,
          put.ExpressionAttributeValues,
        ))
        writes.push({
          recordKey,
          item: structuredClone(item),
        })
        continue
      }
      throw new Error('Unsupported authority transaction entry.')
    }

    if (failures.some(Boolean)) {
      throw createConditionalTransactionFailure(failures)
    }
    for (const write of writes) {
      this.items.set(write.recordKey, write.item)
    }
  }
}

describe('AWS Workspace Search pre-plan authority adapter', () => {
  test('rejects oversized evidence before copying it or reading durable state', async () => {
    const context = createAuthorityContext()
    const failure = await captureMigrationFailure(
      () => context.port.renewMaintenanceEvidence({
        lease: {
          runId: 'run-oversized-evidence',
          ownerId: 'owner-oversized-evidence',
          fenceToken: 1,
        },
        expectedPointer: null,
        evidenceBytes:
          new Uint8Array(MAINTENANCE_EVIDENCE_MAX_BYTES + 1),
      }),
    )

    expectMigrationFailure(
      failure,
      'INVALID_MAINTENANCE_EVIDENCE',
    )
    expect(context.transport.getCommands).toHaveLength(0)
    expect(context.transport.prepareCalls).toHaveLength(0)
    expect(context.transport.transactionCommands).toHaveLength(0)
  })

  test('uses one global lease across configurations and permits only expired takeover', async () => {
    const stateTable = createStateTableIdentity()
    const transport =
      new InMemoryPrePlanAuthorityAwsTransport(stateTable.tableName)
    const clock = new MutableAuthorityClock(initialTime)
    const configurationA = createMigrationDigest('configuration-a')
    const configurationB = createMigrationDigest('configuration-b')
    const portA = createAuthorityPort(
      stateTable,
      configurationA,
      transport,
      clock,
    )
    const portB = createAuthorityPort(
      stateTable,
      configurationB,
      transport,
      clock,
    )

    const leaseA = await portA.acquireLease({
      runId: 'run-a',
      ownerId: 'owner-a',
    })
    expect(leaseA).toEqual({
      runId: 'run-a',
      ownerId: 'owner-a',
      fenceToken: 1,
      heartbeatAt: initialTime,
      expiresAt: '2026-07-25T04:01:00.000Z',
    })
    const activeConflict = await captureMigrationFailure(
      () => portB.acquireLease({
        runId: 'run-b',
        ownerId: 'owner-b',
      }),
    )
    expectMigrationFailure(activeConflict, 'LEASE_CONFLICT')
    expect(transport.transactionCommands).toHaveLength(1)

    clock.set(leaseA.expiresAt)
    const leaseB = await portB.acquireLease({
      runId: 'run-b',
      ownerId: 'owner-b',
    })
    expect(leaseB).toMatchObject({
      runId: 'run-b',
      ownerId: 'owner-b',
      fenceToken: 2,
      heartbeatAt: leaseA.expiresAt,
    })
    const durableLease =
      requireStoredItem(transport.readStoredItemByKind(leaseKind))
    expect(readStringAttribute(durableLease, 'configurationHash'))
      .toBe(configurationB)
    const leaseKeys = transport.getCommands.map(readCommandRecordKey)
    expect(new Set(leaseKeys).size).toBe(1)
    expect(leaseKeys[0]).not.toContain(configurationA)
    expect(leaseKeys[0]).not.toContain(configurationB)
  })

  test('allows only one concurrent first acquirer to install fence one', async () => {
    const context = createAuthorityContext()
    const competitor = createAuthorityPort(
      context.stateTable,
      context.configurationHash,
      context.transport,
      context.clock,
    )
    let winningLease: WorkspaceSearchMigrationLease | undefined
    context.transport.beforeNextTransaction(async () => {
      winningLease = await competitor.acquireLease({
        runId: 'run-concurrent-winner',
        ownerId: 'owner-concurrent-winner',
      })
    })

    const losingFailure = await captureMigrationFailure(
      () => context.port.acquireLease({
        runId: 'run-concurrent-loser',
        ownerId: 'owner-concurrent-loser',
      }),
    )
    expectMigrationFailure(losingFailure, 'LEASE_CONFLICT')
    expect(winningLease).toMatchObject({
      runId: 'run-concurrent-winner',
      ownerId: 'owner-concurrent-winner',
      fenceToken: 1,
    })
    expect(context.transport.transactionCommands).toHaveLength(2)
    expect(context.transport.readStoredItems()).toHaveLength(1)
  })

  test('fails closed instead of overflowing the global fence token', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-fence-overflow',
      ownerId: 'owner-fence-overflow',
    })
    const original =
      requireStoredItem(context.transport.readStoredItemByKind(leaseKind))
    const maximumFenceLease: WorkspaceSearchMigrationLease = {
      ...lease,
      fenceToken: Number.MAX_SAFE_INTEGER,
    }
    context.transport.replaceStoredItem({
      ...original,
      fenceToken: { N: String(Number.MAX_SAFE_INTEGER) },
      recordDigest: {
        S: createMigrationDigest({
          kind: leaseKind,
          version: 1,
          stateIncarnationDigest:
            readStringAttribute(original, 'stateIncarnationDigest'),
          stateTableId:
            readStringAttribute(original, 'stateTableId'),
          configurationHash:
            readStringAttribute(original, 'configurationHash'),
          lease: maximumFenceLease,
        }),
      },
    })
    context.transport.clearHistory()
    context.clock.set(lease.expiresAt)

    const failure = await captureMigrationFailure(
      () => context.port.acquireLease({
        runId: 'run-after-overflow',
        ownerId: 'owner-after-overflow',
      }),
    )
    expectMigrationFailure(failure, 'INVALID_STATE')
    expect(context.transport.transactionCommands).toHaveLength(0)
    expect(readNumberAttribute(
      requireStoredItem(
        context.transport.readStoredItemByKind(leaseKind),
      ),
      'fenceToken',
    )).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('heartbeats the exact fenced owner and recovers an exact committed response loss', async () => {
    const context = createAuthorityContext()
    const acquired = await context.port.acquireLease({
      runId: 'run-heartbeat',
      ownerId: 'owner-heartbeat',
    })

    context.clock.set('2026-07-25T04:00:20.000Z')
    const firstHeartbeat = await context.port.heartbeatLease({
      lease: createLeaseClaim(acquired),
    })
    expect(firstHeartbeat).toEqual({
      ...acquired,
      heartbeatAt: '2026-07-25T04:00:20.000Z',
      expiresAt: '2026-07-25T04:01:20.000Z',
    })
    const heartbeatPut = requireTransactionItems(
      context.transport.transactionCommands[1],
    )[0]?.Put
    expect(heartbeatPut?.ConditionExpression).toContain(
      '#recordDigest = :recordDigest',
    )
    expect(heartbeatPut?.ConditionExpression).toContain(
      '#expiresEpochMilliseconds > :clock',
    )

    context.clock.set('2026-07-25T04:00:30.000Z')
    context.transport.failNextTransaction({
      timing: 'after-commit',
      error: createTimeoutError('HEARTBEAT-RESPONSE-CANARY'),
    })
    const recovered = await context.port.heartbeatLease({
      lease: createLeaseClaim(firstHeartbeat),
    })
    expect(recovered).toEqual({
      ...firstHeartbeat,
      heartbeatAt: '2026-07-25T04:00:30.000Z',
      expiresAt: '2026-07-25T04:01:30.000Z',
    })

    const staleFailure = await captureMigrationFailure(
      () => context.port.heartbeatLease({
        lease: {
          ...createLeaseClaim(recovered),
          ownerId: 'stale-owner',
        },
      }),
    )
    expectMigrationFailure(staleFailure, 'LEASE_LOST')
    expect(staleFailure.message)
      .not.toContain('HEARTBEAT-RESPONSE-CANARY')
  })

  test('samples receipt commit time only after pre-write preparation completes', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-prepared-clock',
      ownerId: 'owner-prepared-clock',
    })
    context.transport.clearHistory()
    const validationAt = '2026-07-25T04:00:05.000Z'
    const commitAt = '2026-07-25T04:00:06.000Z'
    context.clock.set(validationAt)
    context.transport.beforeNextPrepare(() => {
      context.clock.set(commitAt)
    })

    const authority = await context.port.renewMaintenanceEvidence({
      lease: createLeaseClaim(lease),
      expectedPointer: null,
      evidenceBytes: createMaintenanceEvidenceBytes(validationAt),
    })
    expect(context.transport.prepareCalls).toHaveLength(1)
    expect(authority.maintenanceEvidenceReceipt.validatedAt)
      .toBe(validationAt)
    expect(authority.evaluatedAt).toBe(commitAt)
    const conditionValues = requireAttributeMap(
      requireTransactionItems(
        context.transport.transactionCommands[0],
      )[0]?.ConditionCheck?.ExpressionAttributeValues,
    )
    expect(
      readNumberAttribute(conditionValues, ':minimumExpiry') - 10_000,
    ).toBe(Date.parse(commitAt))
  })

  test('atomically renews receipts, advances the pointer, and retains history', async () => {
    const context = createAuthorityContext()
    const acquired = await context.port.acquireLease({
      runId: 'run-receipt',
      ownerId: 'owner-receipt',
    })
    context.transport.clearHistory()

    const firstAuthority =
      await context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(acquired),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(
          initialTime,
          'change:OPS-2026',
        ),
      })
    expect(firstAuthority).toMatchObject({
      configurationHash: context.configurationHash,
      stateTableId: context.stateTable.tableId,
      lease: acquired,
      evaluatedAt: initialTime,
    })
    const receiptTransaction = requireTransactionItems(
      context.transport.transactionCommands[0],
    )
    expect(receiptTransaction).toHaveLength(3)
    expect(receiptTransaction[0]?.ConditionCheck).toBeDefined()
    expect(receiptTransaction[1]?.Put).toBeDefined()
    expect(receiptTransaction[2]?.Put).toBeDefined()
    expect(
      receiptTransaction[0]?.ConditionCheck?.ConditionExpression,
    ).toContain('#expiresEpochMilliseconds > :minimumExpiry')
    expect(context.transport.readStoredItems()).toHaveLength(3)

    context.clock.set('2026-07-25T04:00:01.000Z')
    const heartbeated = await context.port.heartbeatLease({
      lease: createLeaseClaim(acquired),
    })
    const historicalAfterHeartbeat =
      await context.port.readMaintenanceEvidenceReceipt(
        acquired.runId,
        firstAuthority.maintenanceEvidenceReceiptDigest,
      )
    expect(historicalAfterHeartbeat)
      .toEqual(firstAuthority.maintenanceEvidenceReceipt)

    context.clock.set('2026-07-25T04:00:02.000Z')
    const secondAuthority =
      await context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(heartbeated),
        expectedPointer: createPointerClaim(firstAuthority),
        evidenceBytes: createMaintenanceEvidenceBytes(
          '2026-07-25T04:00:02.000Z',
          'change:OPS-2027',
        ),
      })
    expect(secondAuthority.maintenanceEvidenceReceiptDigest)
      .not.toBe(firstAuthority.maintenanceEvidenceReceiptDigest)
    const pointer =
      requireStoredItem(context.transport.readStoredItemByKind(pointerKind))
    expect(readNumberAttribute(pointer, 'revision')).toBe(2)
    expect(readStringAttribute(pointer, 'receiptDigest'))
      .toBe(secondAuthority.maintenanceEvidenceReceiptDigest)
    expect(
      context.transport.readStoredItems().filter((item) =>
        readStringAttribute(item, 'kind') === receiptKind
      ),
    ).toHaveLength(2)
    expect(
      await context.port.readMaintenanceEvidenceReceipt(
        acquired.runId,
        firstAuthority.maintenanceEvidenceReceiptDigest,
      ),
    ).toEqual(firstAuthority.maintenanceEvidenceReceipt)
  })

  test('rejects a stale expected pointer without overwriting the current receipt', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-stale-pointer',
      ownerId: 'owner-stale-pointer',
    })
    const firstAuthority =
      await context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(lease),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(
          initialTime,
          'change:OPS-2026',
        ),
      })
    context.clock.set('2026-07-25T04:00:01.000Z')
    const secondAuthority =
      await context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(lease),
        expectedPointer: createPointerClaim(firstAuthority),
        evidenceBytes: createMaintenanceEvidenceBytes(
          '2026-07-25T04:00:01.000Z',
          'change:OPS-2027',
        ),
      })
    const durableBefore = context.transport.readStoredItems()
    context.transport.clearHistory()
    context.clock.set('2026-07-25T04:00:02.000Z')

    const failure = await captureMigrationFailure(
      () => context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(lease),
        expectedPointer: createPointerClaim(firstAuthority),
        evidenceBytes: createMaintenanceEvidenceBytes(
          '2026-07-25T04:00:02.000Z',
          'change:OPS-2028',
        ),
      }),
    )
    expectMigrationFailure(failure, 'INVALID_MAINTENANCE_EVIDENCE')
    expect(context.transport.transactionCommands).toHaveLength(0)
    expect(context.transport.readStoredItems()).toEqual(durableBefore)
    const currentPointer =
      requireStoredItem(context.transport.readStoredItemByKind(pointerKind))
    expect(readNumberAttribute(currentPointer, 'revision'))
      .toBe(secondAuthority.maintenanceEvidencePointerRevision)
    expect(readStringAttribute(currentPointer, 'receiptDigest'))
      .toBe(secondAuthority.maintenanceEvidenceReceiptDigest)
  })

  test('does not partially persist receipt rows when the lease changes before commit', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-atomic',
      ownerId: 'owner-atomic',
    })
    const competitor = createAuthorityPort(
      context.stateTable,
      context.configurationHash,
      context.transport,
      context.clock,
    )
    context.transport.beforeNextTransaction(async () => {
      context.clock.set(lease.expiresAt)
      await competitor.acquireLease({
        runId: 'run-successor',
        ownerId: 'owner-successor',
      })
    })

    const failure = await captureMigrationFailure(
      () => context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(lease),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(initialTime),
      }),
    )
    expectMigrationFailure(failure, 'LEASE_LOST')
    expect(context.transport.readStoredItems()).toHaveLength(1)
    expect(
      context.transport.readStoredItemByKind(pointerKind),
    ).toBeUndefined()
    expect(
      context.transport.readStoredItemByKind(receiptKind),
    ).toBeUndefined()
    expect(readNumberAttribute(
      requireStoredItem(
        context.transport.readStoredItemByKind(leaseKind),
      ),
      'fenceToken',
    )).toBe(2)
  })

  test('resolves current authority through five strongly consistent point reads', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-strong-read',
      ownerId: 'owner-strong-read',
    })
    const authority = await context.port.renewMaintenanceEvidence({
      lease: createLeaseClaim(lease),
      expectedPointer: null,
      evidenceBytes: createMaintenanceEvidenceBytes(initialTime),
    })
    context.transport.clearHistory()

    const resolved = await context.port.readAuthority({
      lease: createLeaseClaim(lease),
      maintenanceEvidenceReceiptDigest:
        authority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        authority.maintenanceEvidencePointerRevision,
    })
    expect(resolved).toEqual(authority)
    expect(context.transport.getCommands).toHaveLength(5)
    for (const command of context.transport.getCommands) {
      expect(command.input.TableName).toBe(context.stateTable.tableName)
      expect(command.input.ConsistentRead).toBe(true)
    }
    const keys = context.transport.getCommands.map(readCommandRecordKey)
    expect(keys[0]).toBe(keys[3])
    expect(keys[1]).toBe(keys[4])
    expect(new Set(keys).size).toBe(3)
  })

  test('requires strictly more than ten seconds of lease commit headroom', async () => {
    const passing = createAuthorityContext()
    const passingLease = await passing.port.acquireLease({
      runId: 'run-boundary-pass',
      ownerId: 'owner-boundary-pass',
    })
    const passingAt = '2026-07-25T04:00:49.999Z'
    passing.clock.set(passingAt)
    const authority = await passing.port.renewMaintenanceEvidence({
      lease: createLeaseClaim(passingLease),
      expectedPointer: null,
      evidenceBytes: createMaintenanceEvidenceBytes(passingAt),
    })
    expect(
      Date.parse(authority.lease.expiresAt) -
        Date.parse(authority.evaluatedAt),
    ).toBe(10_001)

    const failing = createAuthorityContext()
    const failingLease = await failing.port.acquireLease({
      runId: 'run-boundary-fail',
      ownerId: 'owner-boundary-fail',
    })
    failing.transport.clearHistory()
    const failingAt = '2026-07-25T04:00:50.000Z'
    failing.clock.set(failingAt)
    const failure = await captureMigrationFailure(
      () => failing.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(failingLease),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(failingAt),
      }),
    )
    expectMigrationFailure(failure, 'LEASE_LOST')
    expect(failing.transport.transactionCommands).toHaveLength(0)
    expect(failing.transport.readStoredItems()).toHaveLength(1)
  })

  test('recovers exact lease and receipt commits after response loss', async () => {
    const context = createAuthorityContext()
    context.transport.failNextTransaction({
      timing: 'after-commit',
      error: createTimeoutError('ACQUIRE-RESPONSE-CANARY'),
    })
    const lease = await context.port.acquireLease({
      runId: 'run-response-loss',
      ownerId: 'owner-response-loss',
    })
    expect(lease.fenceToken).toBe(1)
    expect(context.transport.readStoredItems()).toHaveLength(1)

    context.transport.failNextTransaction({
      timing: 'after-commit',
      error: createTimeoutError('RECEIPT-RESPONSE-CANARY'),
    })
    const authority = await context.port.renewMaintenanceEvidence({
      lease: createLeaseClaim(lease),
      expectedPointer: null,
      evidenceBytes: createMaintenanceEvidenceBytes(initialTime),
    })
    expect(authority.lease).toEqual(lease)
    expect(context.transport.readStoredItems()).toHaveLength(3)
    expect(authority.maintenanceEvidenceReceiptDigest)
      .toBe(readStringAttribute(
        requireStoredItem(
          context.transport.readStoredItemByKind(pointerKind),
        ),
        'receiptDigest',
      ))
  })

  test('fails closed when response-loss reconciliation observes a mixed receipt state', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-mixed',
      ownerId: 'owner-mixed',
    })
    const rawCanary = 'MIXED-RESPONSE-CANARY'
    context.transport.failNextTransaction({
      timing: 'after-commit',
      error: createTimeoutError(rawCanary),
      afterCommit: () => {
        expect(
          context.transport.deleteStoredItemsByKind(pointerKind),
        ).toBe(1)
      },
    })

    const failure = await captureMigrationFailure(
      () => context.port.renewMaintenanceEvidence({
        lease: createLeaseClaim(lease),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(initialTime),
      }),
    )
    expectMigrationFailure(
      failure,
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expect(failure.message).not.toContain(rawCanary)
    expect(context.transport.readStoredItems()).toHaveLength(2)
    expect(
      context.transport.readStoredItemByKind(pointerKind),
    ).toBeUndefined()
    expect(
      context.transport.readStoredItemByKind(receiptKind),
    ).toBeDefined()
  })

  test('strictly parses every durable row and redacts malformed state and raw failures', async () => {
    const context = createAuthorityContext()
    const lease = await context.port.acquireLease({
      runId: 'run-corruption',
      ownerId: 'owner-corruption',
    })
    const authority = await context.port.renewMaintenanceEvidence({
      lease: createLeaseClaim(lease),
      expectedPointer: null,
      evidenceBytes: createMaintenanceEvidenceBytes(initialTime),
    })
    const canary = 'STRICT-PARSE-RAW-CANARY'

    const originalLease =
      requireStoredItem(context.transport.readStoredItemByKind(leaseKind))
    context.transport.replaceStoredItem({
      ...originalLease,
      unexpectedAttribute: { S: canary },
    })
    const leaseFailure = await captureMigrationFailure(
      () => context.port.heartbeatLease({
        lease: createLeaseClaim(lease),
      }),
    )
    expectMigrationFailure(leaseFailure, 'INVALID_STATE')
    expect(leaseFailure.message).not.toContain(canary)
    context.transport.replaceStoredItem(originalLease)

    const originalPointer =
      requireStoredItem(context.transport.readStoredItemByKind(pointerKind))
    context.transport.replaceStoredItem({
      ...originalPointer,
      unexpectedAttribute: { S: canary },
    })
    const pointerFailure = await captureMigrationFailure(
      () => context.port.readAuthority({
        lease: createLeaseClaim(lease),
        maintenanceEvidenceReceiptDigest:
          authority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          authority.maintenanceEvidencePointerRevision,
      }),
    )
    expectMigrationFailure(pointerFailure, 'INVALID_STATE')
    expect(pointerFailure.message).not.toContain(canary)
    context.transport.replaceStoredItem(originalPointer)

    const originalReceipt =
      requireStoredItem(context.transport.readStoredItemByKind(receiptKind))
    context.transport.replaceStoredItem({
      ...originalReceipt,
      recordDigest: { S: createMigrationDigest('corrupt-receipt') },
    })
    const receiptFailure = await captureMigrationFailure(
      () => context.port.readMaintenanceEvidenceReceipt(
        lease.runId,
        authority.maintenanceEvidenceReceiptDigest,
      ),
    )
    expectMigrationFailure(receiptFailure, 'INVALID_STATE')
    context.transport.replaceStoredItem(originalReceipt)

    const rawReadContext = createAuthorityContext()
    rawReadContext.transport.failNextGet(new Error(canary))
    const rawReadFailure = await captureMigrationFailure(
      () => rawReadContext.port.acquireLease({
        runId: 'run-raw-read',
        ownerId: 'owner-raw-read',
      }),
    )
    expectMigrationFailure(rawReadFailure, 'INVALID_STATE')
    expect(rawReadFailure.message).not.toContain(canary)

    const rawWriteContext = createAuthorityContext()
    rawWriteContext.transport.failNextTransaction({
      timing: 'before-commit',
      error: createTimeoutError(canary),
    })
    const rawWriteFailure = await captureMigrationFailure(
      () => rawWriteContext.port.acquireLease({
        runId: 'run-raw-write',
        ownerId: 'owner-raw-write',
      }),
    )
    expect(rawWriteContext.transport.getCommands).toHaveLength(2)
    expect(rawWriteContext.transport.getCommands[1]?.input)
      .toEqual(rawWriteContext.transport.getCommands[0]?.input)
    expectMigrationFailure(
      rawWriteFailure,
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expect(rawWriteFailure.message).not.toContain(canary)
    expect(rawWriteContext.transport.readStoredItems()).toHaveLength(0)
  })
})

/**
 * Creates one complete migration-state table identity.
 *
 * @returns Stable measured table fixture.
 */
function createStateTableIdentity(): MigrationTableIdentity {
  return {
    role: 'migration-state',
    tableName: 'table-migration-state',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-migration-state',
    tableId: 'table-id-migration-state',
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: [
      { name: 'migrationId', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest('migration-state-key'),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Creates one adapter with explicit shared dependencies.
 *
 * @param stateTable - Exact migration-state identity.
 * @param configurationHash - Reviewed configuration digest.
 * @param transport - Shared condition-aware transport.
 * @param clock - Shared mutable adapter clock.
 * @returns Configured authority port.
 */
function createAuthorityPort(
  stateTable: MigrationTableIdentity,
  configurationHash: string,
  transport: InMemoryPrePlanAuthorityAwsTransport,
  clock: MutableAuthorityClock,
): WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  return createAwsWorkspaceSearchMigrationPrePlanAuthorityPort({
    stateTable,
    configurationHash,
    transport,
    clock: () => clock.read(),
  })
}

/**
 * Creates isolated default dependencies for one adapter test.
 *
 * @returns State table, binding, fake transport, clock, and authority port.
 */
function createAuthorityContext() {
  const stateTable = createStateTableIdentity()
  const configurationHash =
    createMigrationDigest('default-configuration')
  const transport =
    new InMemoryPrePlanAuthorityAwsTransport(stateTable.tableName)
  const clock = new MutableAuthorityClock(initialTime)
  return {
    stateTable,
    configurationHash,
    transport,
    clock,
    port: createAuthorityPort(
      stateTable,
      configurationHash,
      transport,
      clock,
    ),
  }
}

/**
 * Creates one exact fenced lease claim.
 *
 * @param lease - Durable lease whose identity is claimed.
 * @returns Detached run, owner, and fence.
 */
function createLeaseClaim(
  lease: WorkspaceSearchMigrationLease,
): WorkspaceSearchMigrationLeaseClaim {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
  }
}

/**
 * Creates the exact optimistic pointer claim returned by current authority.
 *
 * @param authority - Current resolved authority.
 * @returns Exact fence, revision, and immutable receipt digest.
 */
function createPointerClaim(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationPrePlanMaintenancePointerClaim {
  return {
    fenceToken: authority.lease.fenceToken,
    revision: authority.maintenanceEvidencePointerRevision,
    receiptDigest: authority.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Creates valid fresh maintenance-evidence bytes relative to one clock.
 *
 * @param at - Adapter validation time.
 * @param locator - Secret-free change-record locator.
 * @returns Strict UTF-8 JSON evidence bytes.
 */
function createMaintenanceEvidenceBytes(
  at: string,
  locator = 'change:OPS-2026',
): Uint8Array {
  const now = requireEpochMilliseconds(at)
  const drainCompletedAt = new Date(now - 60_000).toISOString()
  const drainStartedAt =
    new Date(now - 60_000 - 15 * 60_000).toISOString()
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    locator,
    runtimeMode: 'disabled',
    runtimeRevision: 42,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 42,
      observedAt: drainCompletedAt,
    })),
  }))
}

/**
 * Captures one public fixed-code migration failure.
 *
 * @param operation - Asynchronous adapter operation expected to fail.
 * @returns Exact public failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected a Workspace Search migration failure.')
}

/**
 * Requires one exact stable public failure code and fixed message.
 *
 * @param failure - Captured public migration failure.
 * @param code - Expected stable code.
 */
function expectMigrationFailure(
  failure: WorkspaceSearchMigrationFailure,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  expect(failure).toMatchObject({
    code,
    message:
      `Workspace Search pre-plan authority stopped safely (${code}).`,
  })
}

/**
 * Creates a raw timeout error with one redaction canary.
 *
 * @param canary - Raw message that must never escape.
 * @returns Timeout-shaped raw error.
 */
function createTimeoutError(canary: string): Error {
  const error = new Error(canary)
  error.name = 'TimeoutError'
  return error
}

/**
 * Requires one supported transaction item list.
 *
 * @param command - Candidate transaction command.
 * @returns Nonempty adapter-generated transaction entries.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand | undefined,
): readonly TransactWriteItem[] {
  const entries = command?.input.TransactItems
  if (entries === undefined || entries.length === 0) {
    throw new Error('Expected one authority transaction.')
  }
  return entries
}

/**
 * Requires one complete low-level attribute map.
 *
 * @param item - Candidate map from a Put entry.
 * @returns Complete low-level item.
 */
function requireAttributeMap(
  item: Record<string, AttributeValue> | undefined,
): Readonly<Record<string, AttributeValue>> {
  if (item === undefined) {
    throw new Error('Expected one complete low-level item.')
  }
  return item
}

/**
 * Requires one stored row for a test assertion.
 *
 * @param item - Candidate stored item.
 * @returns Complete stored item.
 */
function requireStoredItem(
  item: Readonly<Record<string, AttributeValue>> | undefined,
): Readonly<Record<string, AttributeValue>> {
  if (item === undefined) throw new Error('Expected one stored item.')
  return item
}

/**
 * Reads the deterministic record key from one strongly consistent command.
 *
 * @param command - Adapter-owned GetItem command.
 * @returns Exact record key.
 */
function readCommandRecordKey(command: GetItemCommand): string {
  return readKeyRecordKey(command.input.Key)
}

/**
 * Reads and validates a complete DynamoDB key map.
 *
 * @param key - Candidate low-level key.
 * @returns Exact record key after validating the migration partition key.
 */
function readKeyRecordKey(
  key: Record<string, AttributeValue> | undefined,
): string {
  if (key === undefined) throw new Error('Expected one DynamoDB key.')
  if (
    readStringAttribute(key, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID
  ) {
    throw new Error('Unexpected migration partition key.')
  }
  return readStringAttribute(key, 'recordKey')
}

/**
 * Reads one exact string AttributeValue.
 *
 * @param item - Low-level DynamoDB item.
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
    attribute.S === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact string attribute ${name}.`)
  }
  return attribute.S
}

/**
 * Reads one exact safe integer AttributeValue.
 *
 * @param item - Low-level DynamoDB item.
 * @param name - Required numeric attribute name.
 * @returns Parsed safe integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.N === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact number attribute ${name}.`)
  }
  const value = Number(attribute.N)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected safe integer attribute ${name}.`)
  }
  return value
}

/**
 * Requires one exact expected physical table name.
 *
 * @param actual - Candidate command table name.
 * @param expected - Fixture-owned state table name.
 */
function requireExpectedTable(
  actual: string | undefined,
  expected: string,
): void {
  if (actual !== expected) {
    throw new Error('Unexpected migration-state table.')
  }
}

/**
 * Evaluates the constrained condition grammar emitted by the adapter.
 *
 * @param current - Existing row in the transaction snapshot.
 * @param expression - Adapter-generated condition expression.
 * @param names - Exact attribute aliases.
 * @param values - Exact condition operands.
 * @returns Whether every AND clause is true.
 */
function conditionMatches(
  current: Readonly<Record<string, AttributeValue>> | undefined,
  expression: string | undefined,
  names: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, AttributeValue>> | undefined,
): boolean {
  if (expression === undefined) {
    throw new Error('Every authority write must carry a condition.')
  }
  const attributeNames = names ?? {}
  const attributeValues = values ?? {}
  for (const clause of expression.split(' AND ')) {
    const absentMatch =
      /^attribute_not_exists\((#[A-Za-z0-9_]+)\)$/u.exec(clause)
    if (absentMatch !== null) {
      const alias = absentMatch[1]
      if (alias === undefined) {
        throw new Error('Malformed attribute-not-exists condition.')
      }
      const name = attributeNames[alias]
      if (name === undefined) {
        throw new Error('Missing attribute-name alias.')
      }
      if (current?.[name] !== undefined) return false
      continue
    }

    const comparison =
      /^(#[A-Za-z0-9_]+) (=|<=|>=|<|>) (:[A-Za-z0-9_]+)$/u
        .exec(clause)
    if (comparison === null) {
      throw new Error(`Unsupported condition clause: ${clause}`)
    }
    const alias = comparison[1]
    const operator = comparison[2]
    const valueAlias = comparison[3]
    if (
      alias === undefined ||
      operator === undefined ||
      valueAlias === undefined
    ) {
      throw new Error('Malformed comparison condition.')
    }
    const name = attributeNames[alias]
    const expected = attributeValues[valueAlias]
    if (name === undefined || expected === undefined) {
      throw new Error('Missing comparison alias or operand.')
    }
    const actual = current?.[name]
    if (
      actual === undefined ||
      !attributeComparisonMatches(actual, operator, expected)
    ) {
      return false
    }
  }
  return true
}

/**
 * Compares two low-level values using the adapter's supported operators.
 *
 * @param actual - Existing attribute value.
 * @param operator - Exact DynamoDB comparison operator.
 * @param expected - Condition operand.
 * @returns Whether the comparison succeeds.
 */
function attributeComparisonMatches(
  actual: AttributeValue,
  operator: string,
  expected: AttributeValue,
): boolean {
  if (operator === '=') return Bun.deepEquals(actual, expected)
  if (actual.N === undefined || expected.N === undefined) {
    throw new Error('Ordered authority conditions require numeric values.')
  }
  const actualNumber = Number(actual.N)
  const expectedNumber = Number(expected.N)
  if (
    !Number.isFinite(actualNumber) ||
    !Number.isFinite(expectedNumber)
  ) {
    throw new Error('Invalid numeric authority condition.')
  }
  if (operator === '<') return actualNumber < expectedNumber
  if (operator === '<=') return actualNumber <= expectedNumber
  if (operator === '>') return actualNumber > expectedNumber
  if (operator === '>=') return actualNumber >= expectedNumber
  throw new Error(`Unsupported comparison operator: ${operator}`)
}

/**
 * Creates an SDK cancellation with one reason per transaction entry.
 *
 * @param failures - Whether each corresponding condition failed.
 * @returns Real low-level transaction cancellation.
 */
function createConditionalTransactionFailure(
  failures: readonly boolean[],
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'Condition-aware authority transaction was canceled.',
    CancellationReasons: failures.map((failed) => ({
      Code: failed ? 'ConditionalCheckFailed' : 'None',
    })),
  })
}

/**
 * Parses one canonical timestamp for clock fixtures.
 *
 * @param at - Candidate timestamp.
 * @returns Finite nonnegative epoch milliseconds.
 */
function requireEpochMilliseconds(at: string): number {
  const value = Date.parse(at)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected one valid test timestamp.')
  }
  return value
}
