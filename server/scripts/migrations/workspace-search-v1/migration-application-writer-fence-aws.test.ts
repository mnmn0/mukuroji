import {
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  encodeWorkspaceSearchWriterFenceRecord,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceObservation,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationApplicationWriterFencePort,
  type WorkspaceSearchMigrationApplicationWriterFenceAwsPort,
  workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex,
} from './migration-application-writer-fence-aws'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
} from './migration-pre-plan-authority-aws'

const runId = 'writer-fence-run'
const ownerId = 'writer-fence-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const initialOpenTime = '2026-07-29T01:00:40.000Z'
const closeTime = '2026-07-29T01:01:00.000Z'
const concurrentCloseTime = '2026-07-29T01:00:59.000Z'

describe('Workspace Search application writer fence AWS adapter', () => {
  test('initializes missing state and strongly reads the exact six-table open row', async () => {
    const fixture = createFenceFixture()
    const events: string[] = []
    const transport = new RecordingFenceTransport(events)
    const port = createPort(
      fixture,
      transport,
      createSequencedClock(events, [initialOpenTime]),
    )

    const initialized = requireOpen(
      requirePresent(await port.bootstrapOpen(fixture.authority)),
    )
    const reread = requireOpen(requirePresent(await port.read()))
    const command = requireTransaction(transport.transactions[0])
    const items = command.input.TransactItems
    if (items === undefined) {
      throw new Error('Expected bootstrap transaction items.')
    }
    const put = requirePut(
      items[
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
          .writerFence
      ],
    )

    expect(events).toEqual([
      'read',
      'prepare',
      'clock',
      'transact',
      'read',
      'read',
    ])
    expect(initialized).toEqual(reread)
    expect(initialized.mode).toBe('open')
    expect(initialized.writerEpoch).toBe(1)
    expect(initialized.controlRevision).toBe(1)
    expect(initialized.previousClosedRecordDigest).toBeNull()
    expect(initialized.binding.tableIds).toEqual(
      createExpectedTableIds(fixture.configuration),
    )
    expect(items).toHaveLength(4)
    for (let index = 0; index < 3; index += 1) {
      expect(items[index]?.ConditionCheck).toBeDefined()
      expect(items[index]?.Put).toBeUndefined()
    }
    expect(command.input.ClientRequestToken).toHaveLength(36)
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    )
    expect(
      transport.reads.every(({ input }) =>
        input.ConsistentRead === true
      ),
    ).toBe(true)
  })

  test('does not prepare an idempotent bootstrap read before the next close write', async () => {
    const fixture = createFenceFixture()
    const events: string[] = []
    const transport = new RecordingFenceTransport(events)
    const port = createPort(
      fixture,
      transport,
      createSequencedClock(events, [initialOpenTime, closeTime]),
    )
    const opened = requireOpen(
      requirePresent(await port.bootstrapOpen(fixture.authority)),
    )
    transport.clearHistory()
    events.length = 0

    const recovered = requireOpen(
      requirePresent(await port.bootstrapOpen(fixture.authority)),
    )

    expect(recovered).toEqual(opened)
    expect(events).toEqual(['read'])
    expect(transport.transactions).toHaveLength(0)

    const closed = requireClosed(
      requirePresent(await port.close(fixture.authority)),
    )
    expect(closed.writerEpoch).toBe(2)
    expect(events).toEqual([
      'read',
      'read',
      'prepare',
      'clock',
      'transact',
      'read',
    ])
  })

  test('closes with three exact authority checks and exact predecessor CAS', async () => {
    const fixture = createFenceFixture()
    const events: string[] = []
    const transport = new RecordingFenceTransport(events)
    const port = createPort(
      fixture,
      transport,
      createSequencedClock(events, [
        initialOpenTime,
        closeTime,
      ]),
    )
    await port.bootstrapOpen(fixture.authority)
    transport.clearHistory()
    events.length = 0

    const closed = requireClosed(
      requirePresent(await port.close(fixture.authority)),
    )
    const closeCommand = requireTransaction(
      transport.transactions[0],
    )
    const closeItems = closeCommand.input.TransactItems
    if (closeItems === undefined) {
      throw new Error('Expected close transaction items.')
    }

    expect(events).toEqual([
      'read',
      'prepare',
      'clock',
      'transact',
      'read',
    ])
    expect(closeItems).toHaveLength(4)
    for (let index = 0; index < 3; index += 1) {
      expect(closeItems[index]?.ConditionCheck).toBeDefined()
      expect(closeItems[index]?.Put).toBeUndefined()
    }
    const closePut = requirePut(
      closeItems[
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
          .writerFence
      ],
    )
    expect(closePut.ConditionExpression).toBe(
      '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
    )
    expect(
      closeItems[
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
          .lease
      ]?.ConditionCheck?.ExpressionAttributeValues?.[':minimumExpiry'],
    ).toEqual({
      N: String(Date.parse(closeTime) + 10_000),
    })
    expect(closed.writerEpoch).toBe(2)
    expect(closed.controlRevision).toBe(2)
    expect(closed.closedAt).toBe(closeTime)
    expect(closed.authority).toEqual({
      configurationHash: fixture.configurationHash,
      runId,
      ownerId,
      leaseFenceToken: fixture.authority.lease.fenceToken,
      maintenanceEvidenceReceiptDigest:
        fixture.authority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        fixture.authority.maintenanceEvidencePointerRevision,
    })
  })

  test('maps each close cancellation position to stable authority or predecessor failures', async () => {
    const cases: readonly {
      readonly index: number
      readonly code:
        | 'INVALID_MAINTENANCE_EVIDENCE'
        | 'INVALID_STATE'
        | 'LEASE_LOST'
    }[] = [
      { index: 0, code: 'LEASE_LOST' },
      { index: 1, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 2, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 3, code: 'INVALID_STATE' },
    ]

    for (const candidate of cases) {
      const fixture = createFenceFixture()
      const transport = new RecordingFenceTransport()
      const port = createPort(
        fixture,
        transport,
        createSequencedClock([], [initialOpenTime, closeTime]),
      )
      await port.bootstrapOpen(fixture.authority)
      transport.clearHistory()
      transport.nextTransactionError = createCancellation(
        candidate.index,
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
          .count,
      )

      const failure = await captureMigrationFailure(
        () => port.close(fixture.authority),
      )

      expect({
        index: candidate.index,
        code: failure.code,
      }).toEqual(candidate)
      expect(transport.transactions).toHaveLength(1)
      expect(transport.reads).toHaveLength(2)
    }
  })

  test('maps each bootstrap cancellation position using the same fixed four-item layout', async () => {
    const cases: readonly {
      readonly index: number
      readonly code:
        | 'INVALID_MAINTENANCE_EVIDENCE'
        | 'INVALID_STATE'
        | 'LEASE_LOST'
    }[] = [
      { index: 0, code: 'LEASE_LOST' },
      { index: 1, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 2, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 3, code: 'INVALID_STATE' },
    ]

    for (const candidate of cases) {
      const fixture = createFenceFixture()
      const transport = new RecordingFenceTransport()
      transport.nextTransactionError = createCancellation(
        candidate.index,
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
          .count,
      )
      const port = createPort(
        fixture,
        transport,
        createFixedClock(initialOpenTime),
      )

      const failure = await captureMigrationFailure(
        () => port.bootstrapOpen(fixture.authority),
      )

      expect({
        index: candidate.index,
        code: failure.code,
      }).toEqual(candidate)
      expect(transport.transactions).toHaveLength(1)
      expect(transport.reads).toHaveLength(2)
    }
  })

  test('classifies conflicts and throttling as transient and unresolved response loss as ambiguous', async () => {
    const cases: readonly {
      readonly error: Error
      readonly code:
        | 'AMBIGUOUS_OPERATION_UNRESOLVED'
        | 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }[] = [
      {
        error: new TransactionConflictException({
          $metadata: {},
          message: 'redacted fixture',
        }),
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
      {
        error: createNamedError('ThrottlingException'),
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
      {
        error: createNamedError('TimeoutError'),
        code: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
    ]

    for (const candidate of cases) {
      const fixture = createFenceFixture()
      const transport = new RecordingFenceTransport()
      const port = createPort(
        fixture,
        transport,
        createSequencedClock([], [initialOpenTime, closeTime]),
      )
      await port.bootstrapOpen(fixture.authority)
      transport.clearHistory()
      transport.nextTransactionError = candidate.error

      const failure = await captureMigrationFailure(
        () => port.close(fixture.authority),
      )

      expect(failure.code).toBe(candidate.code)
    }
  })

  test('never exposes raw writer-fence transport failures', async () => {
    const rawCanary = 'RAW-WRITER-FENCE-CANARY-DO-NOT-LEAK'
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createSequencedClock([], [initialOpenTime, closeTime]),
    )
    await port.bootstrapOpen(fixture.authority)
    transport.clearHistory()
    transport.nextTransactionError = new Error(rawCanary)

    const failure = await captureMigrationFailure(
      () => port.close(fixture.authority),
    )

    expect(failure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search application writer fence operation failed.',
    })
    expect(failure.message).not.toContain(rawCanary)
    expect(String(failure)).not.toContain(rawCanary)
  })

  test('recovers bootstrap response loss immediately or from a new adapter after reread loss', async () => {
    const cases: readonly ('direct' | 'restart')[] = [
      'direct',
      'restart',
    ]

    for (const candidate of cases) {
      const fixture = createFenceFixture()
      const transport = new RecordingFenceTransport()
      transport.commitBeforeTransactionError = true
      transport.nextTransactionError =
        createNamedError('TimeoutError')
      if (candidate === 'restart') {
        transport.nextReadErrorAfterTransaction =
          createNamedError('TimeoutError')
      }
      const firstPort = createPort(
        fixture,
        transport,
        createFixedClock(initialOpenTime),
      )

      if (candidate === 'direct') {
        const recovered = requireOpen(
          requirePresent(
            await firstPort.bootstrapOpen(fixture.authority),
          ),
        )
        expect(recovered.openedAt).toBe(initialOpenTime)
      } else {
        const firstFailure = await captureMigrationFailure(
          () => firstPort.bootstrapOpen(fixture.authority),
        )
        expect(firstFailure.code).toBe(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
        let retryClockCalls = 0
        const retryPort = createPort(fixture, transport, () => {
          retryClockCalls += 1
          return new Date('2026-07-29T02:00:00.000Z')
        })
        const recovered = requireOpen(
          requirePresent(
            await retryPort.bootstrapOpen(fixture.authority),
          ),
        )
        expect(recovered.openedAt).toBe(initialOpenTime)
        expect(retryClockCalls).toBe(0)
      }
      expect(transport.transactions).toHaveLength(1)
    }
  })

  test('recovers close response loss and a concurrent same-input close timestamp', async () => {
    const cases: readonly {
      readonly durableTime: string
      readonly transactionError: Error
    }[] = [
      {
        durableTime: closeTime,
        transactionError: createNamedError('TimeoutError'),
      },
      {
        durableTime: concurrentCloseTime,
        transactionError: createCancellation(
          workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
            .writerFence,
          workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
            .count,
        ),
      },
    ]

    for (const candidate of cases) {
      const fixture = createFenceFixture()
      const transport = new RecordingFenceTransport()
      const port = createPort(
        fixture,
        transport,
        createSequencedClock([], [initialOpenTime, closeTime]),
      )
      const open = requireOpen(
        requirePresent(await port.bootstrapOpen(fixture.authority)),
      )
      transport.clearHistory()
      transport.commitBeforeTransactionError = true
      transport.nextTransactionError = candidate.transactionError
      if (candidate.durableTime !== closeTime) {
        const concurrent = createWorkspaceSearchWriterFenceClosedSuccessor(
          open,
          {
            configurationHash: fixture.configurationHash,
            runId,
            ownerId,
            leaseFenceToken: fixture.authority.lease.fenceToken,
            maintenanceEvidenceReceiptDigest:
              fixture.authority.maintenanceEvidenceReceiptDigest,
            maintenanceEvidencePointerRevision:
              fixture.authority.maintenanceEvidencePointerRevision,
          },
          new Date(candidate.durableTime),
        )
        transport.nextCommittedItem =
          encodeWorkspaceSearchWriterFenceRecord(concurrent)
      }

      const closed = requireClosed(
        requirePresent(await port.close(fixture.authority)),
      )

      expect(closed.closedAt).toBe(candidate.durableTime)
      expect(transport.transactions).toHaveLength(1)
      expect(transport.reads).toHaveLength(2)
    }
  })

  test('recovers a durable close with its original timestamp after the first reconciliation read fails', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const firstPort = createPort(
      fixture,
      transport,
      createSequencedClock([], [initialOpenTime, closeTime]),
    )
    await firstPort.bootstrapOpen(fixture.authority)
    transport.clearHistory()
    transport.commitBeforeTransactionError = true
    transport.nextTransactionError = createNamedError('TimeoutError')
    transport.nextReadErrorAfterTransaction =
      createNamedError('TimeoutError')

    const firstFailure = await captureMigrationFailure(
      () => firstPort.close(fixture.authority),
    )
    expect(firstFailure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(transport.transactions).toHaveLength(1)

    let retryClockCalls = 0
    const retryPort = createPort(fixture, transport, () => {
      retryClockCalls += 1
      return new Date('2026-07-29T02:00:00.000Z')
    })
    const recovered = requireClosed(
      requirePresent(await retryPort.close(fixture.authority)),
    )

    expect(recovered.closedAt).toBe(closeTime)
    expect(transport.transactions).toHaveLength(1)
    expect(retryClockCalls).toBe(0)
  })

  test('never auto-opens a closed fence after authority expiry', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createSequencedClock([], [
        initialOpenTime,
        closeTime,
      ]),
    )
    await port.bootstrapOpen(fixture.authority)
    const closed = requireClosed(
      requirePresent(await port.close(fixture.authority)),
    )

    let futureClockCalls = 0
    const readOnlyPort = createPort(fixture, transport, () => {
      futureClockCalls += 1
      return new Date('2027-07-29T01:00:00.000Z')
    })
    const stillClosed = requirePresent(await readOnlyPort.read())
    expect(stillClosed.mode).toBe('closed')
    expect(stillClosed.recordDigest).toBe(closed.recordDigest)
    expect(futureClockCalls).toBe(0)
  })

  test('detaches close input before awaiting the first strong read', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createSequencedClock([], [initialOpenTime, closeTime]),
    )
    await port.bootstrapOpen(fixture.authority)
    transport.blockNextRead()
    const authority = structuredClone(fixture.authority)

    const closePromise = port.close(authority)
    Reflect.set(authority.lease, 'ownerId', 'mutated-owner')
    Reflect.set(
      authority,
      'maintenanceEvidenceReceiptDigest',
      digest('mutated-receipt'),
    )
    transport.releaseBlockedRead()
    const closed = requireClosed(
      requirePresent(await closePromise),
    )

    expect(closed.authority.ownerId).toBe(ownerId)
    expect(closed.authority.maintenanceEvidenceReceiptDigest).toBe(
      fixture.authority.maintenanceEvidenceReceiptDigest,
    )
  })

  test('rejects invalid inputs before read, clock, or transaction', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    let clockCalls = 0
    const port = createPort(fixture, transport, () => {
      clockCalls += 1
      return new Date(closeTime)
    })
    const invalidAuthority = structuredClone(fixture.authority)
    Reflect.set(invalidAuthority, 'configurationHash', digest('foreign'))

    const closeFailure = await captureMigrationFailure(
      () => port.close(invalidAuthority),
    )

    expect(closeFailure.code).toBe('CONFIGURATION_DRIFT')
    expect(transport.reads).toHaveLength(0)
    expect(transport.transactions).toHaveLength(0)
    expect(clockCalls).toBe(0)

  })

  test('fails closed for foreign table identity and malformed durable rows', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createFixedClock(initialOpenTime),
    )
    const foreignConfiguration =
      structuredClone(fixture.configuration)
    Reflect.set(
      foreignConfiguration.tables.documents,
      'tableId',
      'foreign-documents-table-id',
    )
    const foreignBinding = createBindingForConfiguration(
      foreignConfiguration,
    )
    const foreignClosed =
      createWorkspaceSearchWriterFenceClosedSuccessor(
        createInitialOpenForBinding(
          foreignBinding,
          initialOpenTime,
        ),
        {
          configurationHash:
            createWorkspaceSearchConfigurationHash(
              foreignConfiguration,
            ),
          runId,
          ownerId,
          leaseFenceToken: 7,
          maintenanceEvidenceReceiptDigest: digest('receipt'),
          maintenanceEvidencePointerRevision: 11,
        },
        new Date(closeTime),
      )
    transport.setItem(
      encodeWorkspaceSearchWriterFenceRecord(foreignClosed),
    )

    const foreignFailure = await captureMigrationFailure(
      () => port.read(),
    )
    expect(foreignFailure.code).toBe('INVALID_STATE')

    transport.setItem({
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: createBindingForConfiguration(
          fixture.configuration,
        ).recordKey,
      },
      canonicalBytes: { S: '{malformed' },
      recordDigest: { S: digest('wrong-bytes') },
    })
    const malformedFailure = await captureMigrationFailure(
      () => port.read(),
    )
    expect(malformedFailure.code).toBe('INVALID_STATE')
  })

  test('rejects a configuration hash or constructor configuration that does not own all table ids', () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const foreign = structuredClone(fixture.configuration)
    Reflect.set(
      foreign.tables['workspace-search'],
      'tableId',
      'foreign-workspace-search-table-id',
    )

    expect(() =>
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        foreign,
        fixture.configurationHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    ).toThrow(WorkspaceSearchMigrationFailure)

    try {
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        foreign,
        fixture.configurationHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceSearchMigrationFailure)) {
        throw error
      }
      expect(error.code).toBe('CONFIGURATION_HASH_MISMATCH')
    }
  })

  test('rejects a self-consistent configuration whose table slots own foreign roles', () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const swapped = structuredClone(fixture.configuration)
    const workItems = swapped.tables['work-items']
    Reflect.set(
      swapped.tables,
      'work-items',
      swapped.tables.documents,
    )
    Reflect.set(swapped.tables, 'documents', workItems)
    const swappedHash =
      createWorkspaceSearchConfigurationHash(swapped)

    expect(() =>
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        swapped,
        swappedHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    ).toThrow(WorkspaceSearchMigrationFailure)

    try {
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        swapped,
        swappedHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceSearchMigrationFailure)) {
        throw error
      }
      expect(error.code).toBe('INVALID_ARGUMENT')
    }
  })

  test('rejects a self-consistent configuration with duplicate physical table ids', () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const duplicate = structuredClone(fixture.configuration)
    Reflect.set(
      duplicate.tables.documents,
      'tableId',
      duplicate.tables.collaboration.tableId,
    )
    const duplicateHash =
      createWorkspaceSearchConfigurationHash(duplicate)

    expect(() =>
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        duplicate,
        duplicateHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    ).toThrow(WorkspaceSearchMigrationFailure)

    try {
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        duplicate,
        duplicateHash,
        transport,
        createFixedClock(initialOpenTime),
      )
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceSearchMigrationFailure)) {
        throw error
      }
      expect(error.code).toBe('INVALID_ARGUMENT')
    }
  })
})

/**
 * In-memory narrow transport for exact writer-fence commands.
 */
class RecordingFenceTransport
implements WorkspaceSearchMigrationPrePlanAuthorityAwsTransport {
  /** Optional shared lifecycle trace. */
  private readonly events: string[]

  /** Strong read commands received by the transport. */
  readonly reads: GetItemCommand[] = []

  /** Transaction commands received by the transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** One-shot transaction error. */
  nextTransactionError: unknown

  /** One-shot reconciliation read error armed after transaction failure. */
  nextReadErrorAfterTransaction: unknown

  /** Whether the candidate becomes durable before a transaction error. */
  commitBeforeTransactionError = false

  /** Optional exact item installed by the next committed transaction. */
  nextCommittedItem:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Current exact durable item. */
  private item:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Pending one-shot read gate. */
  private readGate: Promise<void> | undefined

  /** Resolver for the pending one-shot read gate. */
  private readGateResolver: (() => void) | undefined

  /** One-shot raw read error. */
  private nextReadError: unknown

  /**
   * Creates one recording transport.
   *
   * @param events - Optional shared lifecycle trace.
   */
  constructor(events: string[] = []) {
    this.events = events
  }

  /**
   * Strongly reads the current in-memory row.
   *
   * @param command - Adapter-owned exact GetItem command.
   * @returns Current item or absence.
   */
  readonly getPrePlanAuthority = async (
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> => {
    this.events.push('read')
    this.reads.push(command)
    if (this.readGate !== undefined) {
      const gate = this.readGate
      this.readGate = undefined
      await gate
    }
    if (this.nextReadError !== undefined) {
      const error = this.nextReadError
      this.nextReadError = undefined
      throw error
    }
    return this.item === undefined
      ? { $metadata: {} }
      : { $metadata: {}, Item: structuredClone(this.item) }
  }

  /**
   * Records final measured-session preparation.
   *
   * @returns Immediate completion.
   */
  readonly preparePrePlanAuthorityWrite = (): Promise<void> => {
    this.events.push('prepare')
    return Promise.resolve()
  }

  /**
   * Applies the final Put or raises the configured transaction error.
   *
   * @param command - Adapter-owned exact transition command.
   * @returns Empty successful response.
   */
  readonly transactWritePrePlanAuthority = async (
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> => {
    this.events.push('transact')
    this.transactions.push(command)
    const error = this.nextTransactionError
    const shouldCommit =
      error === undefined || this.commitBeforeTransactionError
    if (shouldCommit) {
      const items = command.input.TransactItems
      const last = items?.[items.length - 1]
      const put = requirePut(last)
      this.item = this.nextCommittedItem === undefined
        ? structuredClone(requirePutItem(put))
        : structuredClone(this.nextCommittedItem)
    }
    this.nextCommittedItem = undefined
    this.nextTransactionError = undefined
    if (error !== undefined) {
      this.nextReadError = this.nextReadErrorAfterTransaction
      this.nextReadErrorAfterTransaction = undefined
      throw error
    }
    return { $metadata: {} }
  }

  /**
   * Removes command history without changing durable state.
   */
  clearHistory(): void {
    this.reads.length = 0
    this.transactions.length = 0
  }

  /**
   * Replaces the current durable item with one raw fixture.
   *
   * @param item - Raw low-level item.
   */
  setItem(item: Readonly<Record<string, AttributeValue>>): void {
    this.item = structuredClone(item)
  }

  /**
   * Blocks the next strong read until explicitly released.
   */
  blockNextRead(): void {
    this.readGate = new Promise((resolve) => {
      this.readGateResolver = resolve
    })
  }

  /**
   * Releases a previously blocked read.
   */
  releaseBlockedRead(): void {
    const resolve = this.readGateResolver
    this.readGateResolver = undefined
    if (resolve === undefined) {
      throw new Error('Expected one blocked read.')
    }
    resolve()
  }
}

/**
 * Complete valid adapter fixture.
 */
type FenceFixture = {
  /** Complete measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Fresh current pre-plan authority. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * Creates one internally consistent fence fixture.
 *
 * @returns Complete measured adapter fixture.
 */
function createFenceFixture(): FenceFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const receipt = createMaintenanceReceipt()
  return {
    configuration,
    configurationHash,
    authority: {
      configurationHash,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      lease: {
        runId,
        ownerId,
        fenceToken: 7,
        heartbeatAt: '2026-07-29T01:00:15.000Z',
        expiresAt: '2026-07-29T01:01:15.000Z',
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(receipt),
      maintenanceEvidencePointerRevision: 11,
      maintenanceEvidenceReceipt: receipt,
      evaluatedAt: '2026-07-29T01:00:30.000Z',
    },
  }
}

/**
 * Creates one fresh immutable maintenance receipt.
 *
 * @returns Canonical receipt fixture.
 */
function createMaintenanceReceipt():
  WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/writer-fence.json',
    runtimeRevision: 7,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:00:30.000Z',
    oldestObservationAt: '2026-07-29T00:59:00.000Z',
    validUntil: '2026-07-29T01:04:00.001Z',
  }
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Stable measured configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state': createSupportingTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: configurationTime,
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one measured source table.
 *
 * @param role - Logical source role.
 * @returns Complete source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured supporting table.
 *
 * @param role - Target or migration-state role.
 * @returns Complete supporting identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    true,
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Logical table role.
 * @param key - Exact base key schema.
 * @param deletionProtection - Measured protection status.
 * @returns Complete table identity.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? digest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the source primary-key schema for one role.
 *
 * @param role - Logical source role.
 * @returns Ordered key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Creates the exact shared binding for one configuration.
 *
 * @param configuration - Complete measured configuration.
 * @returns Exact writer-fence binding.
 */
function createBindingForConfiguration(
  configuration: WorkspaceSearchMigrationConfiguration,
): ReturnType<typeof createWorkspaceSearchWriterFenceBinding> {
  const state = configuration.tables['migration-state']
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: state.tableName,
    stateTableId: state.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest({
        role: 'migration-state',
        tableName: state.tableName,
        tableArn: state.tableArn,
        tableId: state.tableId,
        creationTime: state.creationTime,
        account: state.account,
        region: state.region,
      }),
    tableIds: createExpectedTableIds(configuration),
  })
}

/**
 * Creates the exact six table ids for one configuration.
 *
 * @param configuration - Complete measured configuration.
 * @returns Role-indexed TableIds.
 */
function createExpectedTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): {
  readonly 'project-directory': string
  readonly 'work-items': string
  readonly collaboration: string
  readonly documents: string
  readonly 'workspace-search': string
  readonly 'migration-state': string
} {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates one initial open record for a shared binding.
 *
 * @param binding - Exact writer-fence binding.
 * @param openedAt - Canonical open time.
 * @returns Strict initial open row.
 */
function createInitialOpenForBinding(
  binding: ReturnType<typeof createWorkspaceSearchWriterFenceBinding>,
  openedAt: string,
): ReturnType<
  typeof createWorkspaceSearchWriterFenceInitialOpenRecord
> {
  return createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date(openedAt),
  )
}

/**
 * Creates one measured adapter.
 *
 * @param fixture - Complete valid fixture.
 * @param transport - Recording transport.
 * @param clock - Trusted clock.
 * @returns Durable operator port.
 */
function createPort(
  fixture: FenceFixture,
  transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
  clock: () => Date,
): WorkspaceSearchMigrationApplicationWriterFenceAwsPort {
  return createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
    fixture.configuration,
    fixture.configurationHash,
    transport,
    clock,
  )
}

/**
 * Creates one fixed trusted clock.
 *
 * @param timestamp - Canonical time returned on every call.
 * @returns Fixed clock.
 */
function createFixedClock(timestamp: string): () => Date {
  return () => new Date(timestamp)
}

/**
 * Creates one finite clock and records each sample.
 *
 * @param events - Shared lifecycle trace.
 * @param timestamps - Exact finite timestamp sequence.
 * @returns Trusted finite clock.
 */
function createSequencedClock(
  events: string[],
  timestamps: readonly string[],
): () => Date {
  let index = 0
  return () => {
    events.push('clock')
    const timestamp = timestamps[index]
    index += 1
    if (timestamp === undefined) {
      throw new Error('Clock fixture exhausted.')
    }
    return new Date(timestamp)
  }
}

/**
 * Creates one conditional transaction cancellation.
 *
 * @param index - Failed transaction position.
 * @param count - Total transaction item count.
 * @returns Raw DynamoDB cancellation fixture.
 */
function createCancellation(
  index: number,
  count: number,
): TransactionCanceledException {
  const reasons = Array.from(
    { length: count },
    () => ({ Code: 'None' }),
  )
  const reason = reasons[index]
  if (reason === undefined) {
    throw new Error('Cancellation fixture index is invalid.')
  }
  reason.Code = 'ConditionalCheckFailed'
  return new TransactionCanceledException({
    $metadata: {},
    CancellationReasons: reasons,
    message: 'redacted fixture',
  })
}

/**
 * Creates one raw Error with a stable name.
 *
 * @param name - Stable error name.
 * @returns Named raw error.
 */
function createNamedError(name: string): Error {
  const error = new Error('redacted fixture')
  error.name = name
  return error
}

/**
 * Captures one expected public migration failure.
 *
 * @param operation - Expected failing async operation.
 * @returns Public stable failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected migration failure.')
}

/**
 * Requires one present observation.
 *
 * @param observation - Candidate observation.
 * @returns Exact strict durable record.
 */
function requirePresent(
  observation: WorkspaceSearchWriterFenceObservation,
): Exclude<
  WorkspaceSearchWriterFenceObservation,
  { readonly status: 'missing' }
>['record'] {
  if (observation.status !== 'present') {
    throw new Error('Expected present writer fence.')
  }
  return observation.record
}

/**
 * Requires one strict open row.
 *
 * @param record - Candidate durable row.
 * @returns Exact open row.
 */
function requireOpen(
  record: ReturnType<typeof requirePresent>,
): Extract<ReturnType<typeof requirePresent>, { readonly mode: 'open' }> {
  if (record.mode !== 'open') {
    throw new Error('Expected open writer fence.')
  }
  return record
}

/**
 * Requires one strict closed row.
 *
 * @param record - Candidate durable row.
 * @returns Exact closed row.
 */
function requireClosed(
  record: ReturnType<typeof requirePresent>,
): WorkspaceSearchWriterFenceClosedRecord {
  if (record.mode !== 'closed') {
    throw new Error('Expected closed writer fence.')
  }
  return record
}

/**
 * Requires one recorded transaction.
 *
 * @param command - Candidate command.
 * @returns Exact transaction command.
 */
function requireTransaction(
  command: TransactWriteItemsCommand | undefined,
): TransactWriteItemsCommand {
  if (command === undefined) {
    throw new Error('Expected writer-fence transaction.')
  }
  return command
}

/**
 * Requires the Put action from one transition item.
 *
 * @param item - Candidate transaction item.
 * @returns Exact low-level Put.
 */
function requirePut(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['Put']> {
  if (item?.Put === undefined) {
    throw new Error('Expected writer-fence Put.')
  }
  return item.Put
}

/**
 * Requires the complete item from one Put.
 *
 * @param put - Exact low-level Put.
 * @returns Complete low-level item.
 */
function requirePutItem(
  put: NonNullable<TransactWriteItem['Put']>,
): Readonly<Record<string, AttributeValue>> {
  if (put.Item === undefined) {
    throw new Error('Expected writer-fence item.')
  }
  return put.Item
}

/**
 * Creates one deterministic fixture digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}
