import { createHash } from 'node:crypto'
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
  type WorkspaceSearchWriterFenceInitialOpenRecordV1,
  type WorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceReleasedOpenRecordV2,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createWorkspaceSearchMigrationAppliedRoot,
  createWorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createAwsWorkspaceSearchMigrationApplicationWriterFencePort,
  type ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput,
  type WorkspaceSearchMigrationApplicationWriterFenceAwsPort,
  workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex,
  workspaceSearchMigrationApplicationWriterFenceReleaseTransactionIndex,
} from './migration-application-writer-fence-aws'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationExecutionStateV2,
} from './migration-execution-state'
import {
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
  type WorkspaceSearchMigrationVerificationBindingAggregate,
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
} from './migration-full-verification'
import {
  createWorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  createWorkspaceSearchMigrationFullVerificationPageReceipt,
  createWorkspaceSearchMigrationFullVerificationPersistenceState,
  createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  createWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  type WorkspaceSearchMigrationFullVerificationPageReceipt,
  type WorkspaceSearchMigrationFullVerificationPersistenceState,
  type WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  type WorkspaceSearchMigrationFullVerificationResultArtifactReference,
  type WorkspaceSearchMigrationFullVerificationVerifiedRoot,
} from './migration-full-verification-persistence'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationRollbackStartRoot,
  finishWorkspaceSearchMigrationRollback,
  type WorkspaceSearchMigrationRolledBackRoot,
} from './migration-rollback-persistence'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationCheckpointLocation,
  validateWorkspaceSearchMigrationRunState,
} from './migration-state-machine'

const runId = 'writer-fence-run'
const ownerId = 'writer-fence-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const initialOpenTime = '2026-07-29T01:00:40.000Z'
const closeTime = '2026-07-29T01:01:00.000Z'
const concurrentCloseTime = '2026-07-29T01:00:59.000Z'
const planningAdmittedAt = '2026-07-29T01:16:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const executionCreatedAt = '2026-07-29T01:19:00.000Z'
const releaseTime = '2026-07-29T01:30:00.000Z'
const retainUntil = '2027-07-29T00:00:00.000Z'

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

  test('releases a verified terminal graph with the fixed five-item transaction and exact successor', async () => {
    const fixture = createReleaseFixture()
    const events: string[] = []
    const transport = new RecordingFenceTransport(events)
    const port = createPort(
      fixture,
      transport,
      createSequencedClock(events, [
        initialOpenTime,
        closeTime,
        releaseTime,
      ]),
    )
    await port.bootstrapOpen(fixture.authority)
    await port.close(fixture.authority)
    transport.clearHistory()
    events.length = 0

    const released = requireReleasedOpen(
      requirePresent(await port.release(fixture.releaseInput)),
    )
    const command = requireTransaction(transport.transactions[0])
    const items = command.input.TransactItems
    if (items === undefined) {
      throw new Error('Expected release transaction items.')
    }

    expect(events).toEqual([
      'read',
      'prepare',
      'clock',
      'transact',
      'read',
    ])
    expect(items).toHaveLength(
      workspaceSearchMigrationApplicationWriterFenceReleaseTransactionIndex
        .count,
    )
    for (let index = 0; index < 4; index += 1) {
      expect(items[index]?.ConditionCheck).toBeDefined()
      expect(items[index]?.Put).toBeUndefined()
    }
    const writerFencePut = requirePut(
      items[
        workspaceSearchMigrationApplicationWriterFenceReleaseTransactionIndex
          .writerFence
      ],
    )
    expect(writerFencePut.ConditionExpression).toBe(
      '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
    )
    expect(released.version).toBe(2)
    expect(released.writerEpoch).toBe(3)
    expect(released.controlRevision).toBe(3)
    expect(released.previousClosedRecordDigest).toBe(
      fixture.closedWriterFenceRecord.recordDigest,
    )
    expect(released.release.terminal).toEqual({
      kind: 'verified',
      persistenceVersion: 1,
      rootDigest:
        fixture.verifiedRoot.verifiedRootDigest,
    })
    expect(
      Object.values(
        items[
          workspaceSearchMigrationApplicationWriterFenceReleaseTransactionIndex
            .terminalRoot
        ]?.ConditionCheck?.ExpressionAttributeValues ?? {},
      ),
    ).toContainEqual({ S: fixture.verifiedRoot.verifiedRootDigest })
  })

  test('recovers the exact verified release after transaction response loss', async () => {
    const fixture = createReleaseFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createSequencedClock([], [
        initialOpenTime,
        closeTime,
        releaseTime,
      ]),
    )
    await port.bootstrapOpen(fixture.authority)
    await port.close(fixture.authority)
    transport.clearHistory()
    transport.commitBeforeTransactionError = true
    transport.nextTransactionError = createNamedError('TimeoutError')

    const released = requireReleasedOpen(
      requirePresent(await port.release(fixture.releaseInput)),
    )

    expect(released.release.terminal.rootDigest).toBe(
      fixture.verifiedRoot.verifiedRootDigest,
    )
    expect(transport.transactions).toHaveLength(1)
    expect(transport.reads).toHaveLength(2)
  })

  test('recovers a durable verified release read-only after restart', async () => {
    const fixture = createReleaseFixture()
    const transport = new RecordingFenceTransport()
    const firstPort = createPort(
      fixture,
      transport,
      createSequencedClock([], [
        initialOpenTime,
        closeTime,
        releaseTime,
      ]),
    )
    await firstPort.bootstrapOpen(fixture.authority)
    await firstPort.close(fixture.authority)
    transport.clearHistory()
    transport.commitBeforeTransactionError = true
    transport.nextTransactionError = createNamedError('TimeoutError')
    transport.nextReadErrorAfterTransaction =
      createNamedError('TimeoutError')

    const firstFailure = await captureMigrationFailure(
      () => firstPort.release(fixture.releaseInput),
    )
    expect(firstFailure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(transport.transactions).toHaveLength(1)

    let retryClockCalls = 0
    const retryPort = createPort(fixture, transport, () => {
      retryClockCalls += 1
      return new Date('2026-07-29T02:00:00.000Z')
    })
    const recovered = requireReleasedOpen(
      requirePresent(await retryPort.release(fixture.releaseInput)),
    )

    expect(recovered.release.terminal.rootDigest).toBe(
      fixture.verifiedRoot.verifiedRootDigest,
    )
    expect(transport.transactions).toHaveLength(1)
    expect(retryClockCalls).toBe(0)
  })

  test('rejects foreign release graph identity before touching durable state', async () => {
    const fixture = createReleaseFixture()
    const cases: readonly {
      readonly label: string
      readonly mutate: (
        input: ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput,
      ) => void
    }[] = [
      {
        label: 'run',
        mutate: (input) => {
          Reflect.set(input.executionRun, 'runId', 'foreign-run')
        },
      },
      {
        label: 'configuration',
        mutate: (input) => {
          Reflect.set(
            input.executionBoundary,
            'configurationHash',
            digest('foreign-configuration'),
          )
        },
      },
    ]

    for (const candidate of cases) {
      const transport = new RecordingFenceTransport()
      const port = createPort(
        fixture,
        transport,
        createFixedClock(releaseTime),
      )
      const input = structuredClone(fixture.releaseInput)
      candidate.mutate(input)

      const failure = await captureMigrationFailure(
        () => port.release(input),
      )

      expect({ label: candidate.label, code: failure.code }).toEqual({
        label: candidate.label,
        code: 'INVALID_ARGUMENT',
      })
      expect(transport.reads).toHaveLength(0)
      expect(transport.transactions).toHaveLength(0)
    }
  })

  test('rejects a nonclosed predecessor and a different valid terminal root', async () => {
    const fixture = createReleaseFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createSequencedClock([], [
        initialOpenTime,
        closeTime,
        releaseTime,
      ]),
    )
    await port.bootstrapOpen(fixture.authority)

    const nonclosedFailure = await captureMigrationFailure(
      () => port.release(fixture.releaseInput),
    )
    expect(nonclosedFailure.code).toBe('INVALID_STATE')
    expect(transport.transactions).toHaveLength(1)

    await port.close(fixture.authority)
    await port.release(fixture.releaseInput)
    transport.clearHistory()
    const alternateRoot = createVerifiedRoot(
      fixture,
      'alternate-terminal-root',
    )
    const alternateInput = {
      ...fixture.releaseInput,
      terminal: {
        kind: 'verified',
        root: alternateRoot,
      },
    } satisfies ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput

    const rootFailure = await captureMigrationFailure(
      () => port.release(alternateInput),
    )

    expect(rootFailure.code).toBe('INVALID_STATE')
    expect(transport.reads).toHaveLength(1)
    expect(transport.transactions).toHaveLength(0)
  })

  test('classifies every release condition cancellation as invalid durable state', async () => {
    const count =
      workspaceSearchMigrationApplicationWriterFenceReleaseTransactionIndex
        .count
    for (let index = 0; index < count; index += 1) {
      const fixture = createReleaseFixture()
      const transport = new RecordingFenceTransport()
      const port = createPort(
        fixture,
        transport,
        createSequencedClock([], [
          initialOpenTime,
          closeTime,
          releaseTime,
        ]),
      )
      await port.bootstrapOpen(fixture.authority)
      await port.close(fixture.authority)
      transport.clearHistory()
      transport.nextTransactionError = createCancellation(index, count)

      const failure = await captureMigrationFailure(
        () => port.release(fixture.releaseInput),
      )

      expect({ index, code: failure.code }).toEqual({
        index,
        code: 'INVALID_STATE',
      })
      expect(transport.transactions).toHaveLength(1)
      expect(transport.reads).toHaveLength(2)
    }
  })

  test('linearizes concurrent identical releases to one durable successor across different clocks', async () => {
    const fixture = createReleaseFixture()
    const transport = new RecordingFenceTransport()
    const setupPort = createPort(
      fixture,
      transport,
      createSequencedClock([], [initialOpenTime, closeTime]),
    )
    await setupPort.bootstrapOpen(fixture.authority)
    await setupPort.close(fixture.authority)
    transport.clearHistory()
    transport.enforceWriterFenceCas = true
    transport.blockNextReadsUntil(2)
    const firstPort = createPort(
      fixture,
      transport,
      createFixedClock(releaseTime),
    )
    const secondPort = createPort(
      fixture,
      transport,
      createFixedClock('2026-07-29T01:30:01.000Z'),
    )

    const [first, second] = await Promise.all([
      firstPort.release(fixture.releaseInput),
      secondPort.release(fixture.releaseInput),
    ])
    const firstReleased = requireReleasedOpen(requirePresent(first))
    const secondReleased = requireReleasedOpen(requirePresent(second))

    expect(firstReleased.recordDigest).toBe(secondReleased.recordDigest)
    expect(firstReleased.release.terminal.rootDigest).toBe(
      fixture.verifiedRoot.verifiedRootDigest,
    )
    expect(transport.transactions).toHaveLength(2)
    expect(transport.committedTransactionCount).toBe(1)
    expect(transport.reads).toHaveLength(4)
  })

  test('permits only one terminal kind to win concurrent verified and rolled-back releases', async () => {
    const fixture = createReleaseFixture()
    const rolledBackRoot = createZeroMutationRolledBackRoot(fixture)
    const rolledBackInput = {
      ...fixture.releaseInput,
      terminal: {
        kind: 'rolled-back-v1',
        root: rolledBackRoot,
      },
    } satisfies ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput
    const transport = new RecordingFenceTransport()
    const setupPort = createPort(
      fixture,
      transport,
      createSequencedClock([], [initialOpenTime, closeTime]),
    )
    await setupPort.bootstrapOpen(fixture.authority)
    await setupPort.close(fixture.authority)
    transport.clearHistory()
    transport.enforceWriterFenceCas = true
    transport.blockNextReadsUntil(2)
    const verifiedPort = createPort(
      fixture,
      transport,
      createFixedClock(releaseTime),
    )
    const rolledBackPort = createPort(
      fixture,
      transport,
      createFixedClock('2026-07-29T01:30:01.000Z'),
    )

    const results = await Promise.allSettled([
      verifiedPort.release(fixture.releaseInput),
      rolledBackPort.release(rolledBackInput),
    ])
    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result) => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const winner = fulfilled[0]
    const loser = rejected[0]
    if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') {
      throw new Error('Expected one release winner and one loser.')
    }
    const durable = requireReleasedOpen(requirePresent(winner.value))
    const loserFailure = requireMigrationFailure(loser.reason)
    expect(loserFailure.code).toBe('INVALID_STATE')
    expect([
      fixture.verifiedRoot.verifiedRootDigest,
      rolledBackRoot.rootDigest,
    ]).toContain(durable.release.terminal.rootDigest)
    expect(transport.transactions).toHaveLength(2)
    expect(transport.committedTransactionCount).toBe(1)
    expect(transport.reads).toHaveLength(4)
  })

  test('rejects an unknown runtime terminal discriminant before reading durable state', async () => {
    const fixture = createReleaseFixture()
    const rolledBackRoot = createZeroMutationRolledBackRoot(fixture)
    const hostileInput = structuredClone(fixture.releaseInput)
    const hostileTerminal = { root: rolledBackRoot }
    Reflect.set(hostileTerminal, 'kind', 'applied')
    Reflect.set(hostileInput, 'terminal', hostileTerminal)
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createFixedClock(releaseTime),
    )

    const failure = await captureMigrationFailure(
      () => port.release(hostileInput),
    )

    expect(failure.code).toBe('INVALID_ARGUMENT')
    expect(transport.reads).toHaveLength(0)
    expect(transport.transactions).toHaveLength(0)
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

  test('classifies a pre-write strong-read failure as transient', async () => {
    const fixture = createFenceFixture()
    const transport = new RecordingFenceTransport()
    const port = createPort(
      fixture,
      transport,
      createFixedClock(initialOpenTime),
    )
    transport.armNextReadError(createNamedError('TimeoutError'))

    const failure = await captureMigrationFailure(() => port.read())

    expect(failure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(transport.reads).toHaveLength(1)
    expect(transport.transactions).toHaveLength(0)
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

  /** Whether concurrent transactions enforce the recorded predecessor CAS. */
  enforceWriterFenceCas = false

  /** Number of transactions that became durable since history was cleared. */
  committedTransactionCount = 0

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

  /** Multi-reader barrier used to force concurrent predecessor reads. */
  private readBarrier:
    | {
        readonly gate: Promise<void>
        readonly resolve: () => void
        remaining: number
      }
    | undefined

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
    const barrier = this.readBarrier
    if (barrier !== undefined) {
      barrier.remaining -= 1
      if (barrier.remaining === 0) {
        this.readBarrier = undefined
        barrier.resolve()
      }
      await barrier.gate
    }
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
    let error = this.nextTransactionError
    if (
      error === undefined &&
      this.enforceWriterFenceCas &&
      this.item !== undefined
    ) {
      const items = command.input.TransactItems
      const lastIndex = (items?.length ?? 0) - 1
      const last = items?.[lastIndex]
      if (!writerFencePutMatchesPredecessor(last, this.item)) {
        error = createCancellation(lastIndex, items?.length ?? 0)
      }
    }
    const shouldCommit =
      error === undefined || this.commitBeforeTransactionError
    if (shouldCommit) {
      const items = command.input.TransactItems
      const last = items?.[items.length - 1]
      const put = requirePut(last)
      this.item = this.nextCommittedItem === undefined
        ? structuredClone(requirePutItem(put))
        : structuredClone(this.nextCommittedItem)
      this.committedTransactionCount += 1
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
    this.committedTransactionCount = 0
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
   * Arms one raw error for the next strong read.
   *
   * @param error - Raw failure thrown by the next read.
   */
  armNextReadError(error: unknown): void {
    this.nextReadError = error
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
   * Blocks a fixed number of reads until every caller captured predecessor state.
   *
   * @param count - Exact positive number of concurrent reads.
   */
  blockNextReadsUntil(count: number): void {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('Expected a positive read-barrier count.')
    }
    let resolveBarrier: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveBarrier = resolve
    })
    if (resolveBarrier === undefined) {
      throw new Error('Expected a read-barrier resolver.')
    }
    this.readBarrier = {
      gate,
      resolve: resolveBarrier,
      remaining: count,
    }
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
 * Complete immutable execution graph used by release adapter tests.
 */
type ReleaseFixture = FenceFixture & {
  /** Exact closed writer-fence predecessor. */
  readonly closedWriterFenceRecord: WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: ReturnType<
    typeof createWorkspaceSearchMigrationExecutionRun
  >
  /** Exact authoritative successful verification root. */
  readonly verifiedRoot:
    WorkspaceSearchMigrationFullVerificationVerifiedRoot
  /** Complete verified release request. */
  readonly releaseInput:
    ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput
}

/**
 * Release fixture material needed before the verified root is created.
 */
type ReleaseGraphFixture = FenceFixture & {
  /** Exact closed writer-fence predecessor. */
  readonly closedWriterFenceRecord: WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: ReturnType<
    typeof createWorkspaceSearchMigrationExecutionRun
  >
}

/**
 * Creates one complete internally correlated verified release graph.
 *
 * @returns Exact measured adapter and immutable release material.
 */
function createReleaseFixture(): ReleaseFixture {
  const fence = createFenceFixture()
  const binding = createBindingForConfiguration(fence.configuration)
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date(initialOpenTime),
  )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      {
        configurationHash: fence.configurationHash,
        runId,
        ownerId,
        leaseFenceToken: fence.authority.lease.fenceToken,
        maintenanceEvidenceReceiptDigest:
          fence.authority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          fence.authority.maintenanceEvidencePointerRevision,
      },
      new Date(closeTime),
    )
  const closedBoundary =
    createWorkspaceSearchMigrationExecutionBoundary({
      runId,
      configurationHash: fence.configurationHash,
      tableIds: binding.tableIds,
      closedWriterFenceRecord,
    })
  const executionAuthority = createReleaseAuthority(
    fence.configuration,
    fence.configurationHash,
  )
  const boundaryFields = {
    kind: closedBoundary.kind,
    boundaryVersion: closedBoundary.boundaryVersion,
    migrationId: closedBoundary.migrationId,
    migrationVersion: closedBoundary.migrationVersion,
    runId: closedBoundary.runId,
    configurationHash: closedBoundary.configurationHash,
    tableIds: closedBoundary.tableIds,
    closedWriterFenceRecordDigest:
      closedBoundary.closedWriterFenceRecordDigest,
    closedAt: closedBoundary.closedAt,
    closeAuthority: closedBoundary.closeAuthority,
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: executionAuthority.lease.fenceToken,
      maintenanceEvidenceReceiptDigest:
        executionAuthority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        executionAuthority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceDigest:
        executionAuthority.maintenanceEvidenceReceipt.evidenceDigest,
      maintenanceEvidenceLocator:
        executionAuthority.maintenanceEvidenceReceipt.evidenceLocator,
      runtimeRevision:
        executionAuthority.maintenanceEvidenceReceipt.runtimeRevision,
      drainStartedAt: closeTime,
      drainCompletedAt: planningAdmittedAt,
      admittedAt: planningAdmittedAt,
    },
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    'boundaryDigest'
  >
  const executionBoundary =
    parseWorkspaceSearchMigrationExecutionBoundary(
      serializeWorkspaceSearchMigrationExecutionBoundary({
        ...boundaryFields,
        boundaryDigest: createMigrationDigest(boundaryFields),
      }),
    )
  if (executionBoundary.phase !== 'planning-admitted') {
    throw new Error('Expected planning-admitted release fixture.')
  }
  const planSeal = createReleasePlanSeal(fence.configurationHash)
  const sealedPlanningAuthority = createReleaseSealedAuthority(
    fence.configuration,
    fence.configurationHash,
    planSeal,
    executionAuthority,
  )
  createWorkspaceSearchMigrationRunState({
    runId,
    lease: executionAuthority.lease,
    ownerId,
    configurationHash: fence.configurationHash,
    configuration: fence.configuration,
    maintenanceEvidenceReceipt:
      executionAuthority.maintenanceEvidenceReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: sealedPlanningAuthority.planSealReference.objectKey,
      versionId: sealedPlanningAuthority.planSealReference.versionId,
      contentDigest:
        sealedPlanningAuthority.planSealReference.contentDigest,
    },
    createdAt: executionCreatedAt,
  })
  const executionRun = createWorkspaceSearchMigrationExecutionRun({
    executionBoundary,
    sealedPlanningAuthority,
    planSeal,
    configuration: fence.configuration,
    configurationHash: fence.configurationHash,
    currentAuthority: executionAuthority,
    createdAt: executionCreatedAt,
  })
  const graph: ReleaseGraphFixture = {
    ...fence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
  }
  const verifiedRoot = createVerifiedRoot(graph, 'verified-root')
  return {
    ...graph,
    verifiedRoot,
    releaseInput: {
      executionBoundary,
      sealedPlanningAuthority,
      executionRun,
      terminal: { kind: 'verified', root: verifiedRoot },
    },
  }
}

/**
 * Creates fresh post-close authority for execution admission.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @returns Exact fresh execution authority.
 */
function createReleaseAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId,
    evidenceDigest: digest('release-maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/release.json',
    runtimeRevision: 8,
    fenceToken: 8,
    validatedAt: '2026-07-29T01:17:30.000Z',
    oldestObservationAt: planningAdmittedAt,
    validUntil: '2026-07-29T01:21:00.001Z',
  }
  return {
    configurationHash,
    stateTableId: configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId,
      fenceToken: 8,
      heartbeatAt: '2026-07-29T01:18:30.000Z',
      expiresAt: '2026-07-29T01:19:30.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: 12,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: '2026-07-29T01:18:30.000Z',
  }
}

/**
 * Creates one strict empty release plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @returns Exact canonical empty-plan seal.
 */
function createReleasePlanSeal(
  configurationHash: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('release-dry-run'),
    planningSnapshotDigest: digest('release-planning-snapshot'),
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:17:00.000Z',
  }
}

/**
 * Creates one codec-validated empty-plan sealed authority.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param planSeal - Exact canonical plan seal.
 * @param authority - Fresh post-close authority.
 * @returns Exact immutable sealed authority.
 */
function createReleaseSealedAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  planSeal: WorkspaceSearchPlanSeal,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const empty = createEmptyWorkspaceSearchMigrationTraversal()
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds: createExpectedTableIds(configuration),
    planSealReference: createReleaseArtifactReference(
      'plan-seals',
      planSealDigest,
      planSealBytes.byteLength,
    ),
    planManifestHeadReference: createReleaseArtifactReference(
      'manifest-heads',
      digest('release-plan-manifest'),
      1,
    ),
    planningProvenanceManifestHeadReference: {
      objectKey:
        `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}/manifest-heads/${digest('release-provenance-manifest')}.artifact`,
      versionId: 'release-provenance-version',
      contentDigest: digest('release-provenance-manifest'),
      byteLength: 1,
      retainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    planOperationCount: 0,
    planningAuthorityProvenanceDigest:
      digest('release-planning-provenance'),
    historicalReceiptBindingDigest:
      digest('release-historical-receipts'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createReleaseEvidenceHead(
        'project-directory',
        empty.sources['project-directory'],
      ),
      createReleaseEvidenceHead(
        'work-items',
        empty.sources['work-items'],
      ),
      createReleaseEvidenceHead(
        'collaboration',
        empty.sources.collaboration,
      ),
      createReleaseEvidenceHead('documents', empty.sources.documents),
      createReleaseEvidenceHead('workspace-search', empty.target),
    ],
    currentAuthority: {
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
      maintenanceEvidencePointerRevision:
        authority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        authority.maintenanceEvidenceReceiptDigest,
    },
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2({
      ...fields,
      authorityDigest: createMigrationDigest(fields),
    }),
  )
}

/**
 * Creates one immutable artifact reference for a release fixture.
 *
 * @param family - Stable artifact family.
 * @param contentDigest - Exact immutable content digest.
 * @param byteLength - Exact immutable byte count.
 * @returns Exact rich immutable reference.
 */
function createReleaseArtifactReference(
  family: string,
  contentDigest: string,
  byteLength: number,
): WorkspaceSearchMigrationFullVerificationPlanArtifactBinding[
  'planSealReference'
] {
  return {
    objectKey:
      `workspace-search/v1/plan-artifacts/v1/${family}/${contentDigest}.artifact`,
    versionId: `${family}-version`,
    contentDigest,
    byteLength,
    retainUntil,
  }
}

/**
 * Creates one terminal empty planning evidence commitment.
 *
 * @param chain - Exact canonical evidence chain.
 * @param previous - Exact fresh checkpoint.
 * @returns Exact terminal evidence head.
 */
function createReleaseEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
  previous: MigrationSourceCheckpoint,
) {
  const terminal = advanceReleaseCheckpoint(previous)
  return {
    chain,
    progressDigest: digest(`release-progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`release-evidence:${chain}`),
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(terminal),
  }
}

/**
 * Creates one complete authoritative verification root for a release graph.
 *
 * @param fixture - Exact immutable execution graph.
 * @param rootLabel - Stable applied-root fixture identity.
 * @returns Exact strict verified root.
 */
function createVerifiedRoot(
  fixture: ReleaseGraphFixture,
  rootLabel: string,
): WorkspaceSearchMigrationFullVerificationVerifiedRoot {
  const sealed = fixture.sealedPlanningAuthority
  const binding =
    createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
      runId,
      configurationHash: fixture.configurationHash,
      planDigest: sealed.planDigest,
      verificationPlanDigest:
        digest(`release-verification-plan:${rootLabel}`),
      sealedPlanningAuthorityDigest: sealed.authorityDigest,
      planSealReference: sealed.planSealReference,
      planManifestHeadReference: sealed.planManifestHeadReference,
    })
  const tableIds = createExpectedTableIds(fixture.configuration)
  const appliedRootDigest = digest(`release-applied:${rootLabel}`)
  const progress: WorkspaceSearchMigrationFullVerificationProgress[] = [
    createReleaseVerificationInitialProgress(binding),
  ]
  const states:
    WorkspaceSearchMigrationFullVerificationPersistenceState[] = []
  const receipts:
    WorkspaceSearchMigrationFullVerificationPageReceipt[] = []
  const locations:
    readonly WorkspaceSearchMigrationCheckpointLocation[] = [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
    ]
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index]
    const predecessorProgress = progress[index]
    if (location === undefined || predecessorProgress === undefined) {
      throw new Error('Expected complete verification fixture page.')
    }
    const predecessorState = states[index - 1]
    const predecessorDigest =
      predecessorState?.stateDigest ?? appliedRootDigest
    const command =
      createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
        planArtifactBinding: binding,
        tableIds,
        appliedRootDigest,
        location,
        expectedRevision: predecessorState?.revision ?? 0,
        predecessorDigest,
        predecessorProgress,
      })
    const successorProgress = advanceReleaseVerificationProgress(
      predecessorProgress,
      location,
    )
    const successorState =
      createWorkspaceSearchMigrationFullVerificationPersistenceState({
        planArtifactBinding: binding,
        tableIds,
        appliedRootDigest,
        revision: (predecessorState?.revision ?? 0) + 1,
        predecessorKind:
          predecessorState === undefined
            ? 'applied-root'
            : 'verification-state',
        predecessorDigest,
        lastCommandDigest: command.commandDigest,
        progress: successorProgress,
      })
    const committedAt = new Date(
      Date.parse('2026-07-29T01:20:00.000Z') + index * 60_000,
    ).toISOString()
    const receipt = predecessorState === undefined
      ? createWorkspaceSearchMigrationFullVerificationPageReceipt({
          commandIdentity: command,
          predecessor: {
            kind: 'applied-root',
            progress: predecessorProgress,
          },
          successorState,
          committedAt,
        })
      : createWorkspaceSearchMigrationFullVerificationPageReceipt({
          commandIdentity: command,
          predecessor: {
            kind: 'verification-state',
            state: predecessorState,
          },
          successorState,
          committedAt,
        })
    states.push(successorState)
    receipts.push(receipt)
    progress.push(successorProgress)
  }
  const terminalState = states[states.length - 1]
  const terminalReceipt = receipts[receipts.length - 1]
  const terminalProgress = progress[progress.length - 1]
  if (
    terminalState === undefined ||
    terminalReceipt === undefined ||
    terminalProgress === undefined
  ) {
    throw new Error('Expected terminal verification fixture.')
  }
  const result = createReleaseVerificationResult(
    binding,
    terminalProgress,
  )
  return createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
    planArtifactBinding: binding,
    tableIds,
    appliedRootDigest,
    verificationResult: result,
    verificationResultReference:
      createReleaseVerificationResultReference(
        binding,
        appliedRootDigest,
        result.resultDigest,
      ),
    terminalState,
    terminalReceipt,
    sealedPlanningAuthorityDigest: sealed.authorityDigest,
    publicationAuthority: {
      ownerId,
      fenceToken: 8,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        digest('release-publication-receipt'),
      evaluatedAt: '2026-07-29T01:28:00.000Z',
    },
    verifiedAt: '2026-07-29T01:29:00.000Z',
  })
}

/**
 * Creates one strict zero-mutation complete rollback root.
 *
 * @param fixture - Exact immutable execution graph.
 * @returns Exact fully rolled-back version-one root.
 */
function createZeroMutationRolledBackRoot(
  fixture: ReleaseGraphFixture,
): WorkspaceSearchMigrationRolledBackRoot {
  const authority = createReleaseAuthority(
    fixture.configuration,
    fixture.configurationHash,
  )
  const terminalExecutionState = createReleaseTerminalApplyState(
    fixture.executionRun,
    authority,
  )
  const sealCreatedAt = '2026-07-29T01:19:06.000Z'
  const appliedAt = '2026-07-29T01:19:07.000Z'
  const seal = createWorkspaceSearchMigrationCompleteApplySeal({
    admission: fixture.executionRun,
    predecessor: terminalExecutionState,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    createdAt: sealCreatedAt,
  })
  const sealBytes = new TextEncoder().encode(
    serializeCanonicalJson(seal),
  )
  const sealContentDigest = digestBytes(sealBytes)
  const sealReference = {
    scope: 'complete-plan',
    objectKey:
      `workspace-search/v1/apply-seals/${sealContentDigest}.json`,
    versionId: 'release-rollback-seal-version',
    contentDigest: sealContentDigest,
    byteLength: sealBytes.byteLength,
    retainUntil,
  } satisfies Parameters<
    typeof createWorkspaceSearchMigrationAppliedRoot
  >[0]['sealReference']
  const appliedRoot = createWorkspaceSearchMigrationAppliedRoot({
    admission: fixture.executionRun,
    predecessor: terminalExecutionState,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    seal,
    sealReference,
    currentAuthority: authority,
    committedAt: appliedAt,
  })
  const applyingState = reconstructWorkspaceSearchMigrationRunState(
    fixture.executionRun,
    terminalExecutionState,
  )
  const appliedState = {
    ...applyingState,
    revision: applyingState.revision + 1,
    status: 'applied',
    applySeal: {
      scope: 'complete-plan',
      objectKey: appliedRoot.sealReference.objectKey,
      versionId: appliedRoot.sealReference.versionId,
      contentDigest: appliedRoot.sealReference.contentDigest,
    },
    updatedAt: appliedAt,
  } satisfies WorkspaceSearchMigrationRunState
  validateWorkspaceSearchMigrationRunState(appliedState)
  const startRoot = createWorkspaceSearchMigrationRollbackStartRoot({
    executionRun: fixture.executionRun,
    appliedRoot,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    predecessorRunState: appliedState,
    currentAuthority: authority,
    startedAt: '2026-07-29T01:19:10.000Z',
  })
  return finishWorkspaceSearchMigrationRollback({
    startRoot,
    predecessorState: startRoot.initialState,
    currentAuthority: authority,
    terminalReceipt: null,
    finishedAt: '2026-07-29T01:19:11.000Z',
  }).root
}

/**
 * Advances an empty execution admission across all five apply checkpoints.
 *
 * @param admission - Exact immutable execution admission.
 * @param authority - Exact active execution authority.
 * @returns Exact terminal traversal-capable execution state.
 */
function createReleaseTerminalApplyState(
  admission: ReturnType<typeof createWorkspaceSearchMigrationExecutionRun>,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationExecutionStateV2 {
  const locations:
    readonly WorkspaceSearchMigrationCheckpointLocation[] = [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
    ]
  let predecessor: WorkspaceSearchMigrationExecutionStateV2 | undefined
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index]
    if (location === undefined) {
      throw new Error('Expected one release apply location.')
    }
    const current = predecessor === undefined
      ? admission.runState
      : reconstructWorkspaceSearchMigrationRunState(
          admission,
          predecessor,
        )
    const checkpoint = location === 'target'
      ? current.apply.target
      : current.apply.sources[location]
    predecessor =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        ...(predecessor === undefined ? {} : { predecessor }),
        authority: {
          lease: authority.lease,
          ownerId,
          at: new Date(
            Date.parse('2026-07-29T01:19:01.000Z') + index * 1_000,
          ).toISOString(),
        },
        location,
        checkpoint: advanceReleaseCheckpoint(checkpoint),
      })
  }
  if (predecessor === undefined) {
    throw new Error('Expected terminal release execution state.')
  }
  return predecessor
}

/**
 * Creates fresh empty progress for a verified-root fixture.
 *
 * @param binding - Exact immutable plan binding.
 * @returns Exact initial verification progress.
 */
function createReleaseVerificationInitialProgress(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): WorkspaceSearchMigrationFullVerificationProgress {
  return {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    planDigest: binding.planDigest,
    verificationPlanDigest: binding.verificationPlanDigest,
    traversal: createEmptyWorkspaceSearchMigrationTraversal(),
    sourceBindings: {
      'project-directory':
        new MigrationDigestAccumulator().exportState(),
      'work-items': new MigrationDigestAccumulator().exportState(),
      collaboration: new MigrationDigestAccumulator().exportState(),
      documents: new MigrationDigestAccumulator().exportState(),
    },
    targetPresentBindings:
      new MigrationDigestAccumulator().exportState(),
  }
}

/**
 * Completes one selected empty-table verification checkpoint.
 *
 * @param progress - Exact predecessor progress.
 * @param location - Selected source or target location.
 * @returns Exact successor progress.
 */
function advanceReleaseVerificationProgress(
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  location: WorkspaceSearchMigrationCheckpointLocation,
): WorkspaceSearchMigrationFullVerificationProgress {
  if (location === 'target') {
    return {
      ...progress,
      traversal: {
        sources: progress.traversal.sources,
        target: advanceReleaseCheckpoint(progress.traversal.target),
      },
    }
  }
  const next = advanceReleaseCheckpoint(
    progress.traversal.sources[location],
  )
  return {
    ...progress,
    traversal: {
      sources: {
        'project-directory':
          location === 'project-directory'
            ? next
            : progress.traversal.sources['project-directory'],
        'work-items':
          location === 'work-items'
            ? next
            : progress.traversal.sources['work-items'],
        collaboration:
          location === 'collaboration'
            ? next
            : progress.traversal.sources.collaboration,
        documents:
          location === 'documents'
            ? next
            : progress.traversal.sources.documents,
      },
      target: progress.traversal.target,
    },
  }
}

/**
 * Completes one exact empty predecessor checkpoint.
 *
 * @param previous - Exact incomplete predecessor checkpoint.
 * @returns Exact one-page terminal checkpoint.
 */
function advanceReleaseCheckpoint(
  previous: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  if (previous.completed) {
    throw new Error('Expected incomplete release checkpoint.')
  }
  return {
    completed: true,
    aggregate: {
      ...structuredClone(previous.aggregate),
      pageCount: previous.aggregate.pageCount + 1,
    },
    keyDigestState: structuredClone(previous.keyDigestState),
    contentDigestState: structuredClone(
      previous.contentDigestState,
    ),
  }
}

/**
 * Creates one strict successful empty-table verification result.
 *
 * @param binding - Exact immutable plan binding.
 * @param progress - Exact terminal verification progress.
 * @returns Exact self-digested verification result.
 */
function createReleaseVerificationResult(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
): WorkspaceSearchMigrationFullVerificationResult {
  const aggregate = createReleaseEmptyBindingAggregate()
  const fields = {
    kind: 'workspace-search-migration-full-verification-result',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    planDigest: binding.planDigest,
    verificationPlanDigest: binding.verificationPlanDigest,
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    applySealDigest: digest('release-apply-seal'),
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthorityDigest,
    sourceCheckpointDigests: {
      'project-directory':
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.traversal.sources['project-directory'],
        ),
      'work-items':
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.traversal.sources['work-items'],
        ),
      collaboration:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.traversal.sources.collaboration,
        ),
      documents:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.traversal.sources.documents,
        ),
    },
    targetCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.target,
      ),
    verification: progress,
    expectedSourceBindings: {
      'project-directory': aggregate,
      'work-items': aggregate,
      collaboration: aggregate,
      documents: aggregate,
    },
    observedSourceBindings: {
      'project-directory': aggregate,
      'work-items': aggregate,
      collaboration: aggregate,
      documents: aggregate,
    },
    expectedTargetPresentBindings: aggregate,
    observedTargetPresentBindings: aggregate,
    status: 'pass',
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  return { ...fields, resultDigest: createMigrationDigest(fields) }
}

/**
 * Creates one exact empty verification binding aggregate.
 *
 * @returns Empty accumulator state and digest.
 */
function createReleaseEmptyBindingAggregate():
  WorkspaceSearchMigrationVerificationBindingAggregate {
  const accumulator = new MigrationDigestAccumulator()
  return {
    count: accumulator.size(),
    digestState: accumulator.exportState(),
    digest: accumulator.digest(),
  }
}

/**
 * Creates one immutable semantic verification-result reference.
 *
 * @param binding - Exact immutable plan binding.
 * @param appliedRootDigest - Exact verified applied root.
 * @param resultDigest - Exact semantic result digest.
 * @returns Exact rich immutable result reference.
 */
function createReleaseVerificationResultReference(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  appliedRootDigest: string,
  resultDigest: string,
): WorkspaceSearchMigrationFullVerificationResultArtifactReference {
  return {
    kind:
      'workspace-search-migration-verification-result-artifact-reference',
    artifactVersion: 1,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    appliedRootDigest,
    verificationResultDigest: resultDigest,
    envelopeDigest: digest(`release-envelope:${resultDigest}`),
    objectKey: `workspace-search/v1/results/${resultDigest}`,
    versionId: 'release-result-version',
    contentDigest: digest(`release-result-content:${resultDigest}`),
    byteLength: 1024,
    retainUntil,
  }
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
 * Requires one rejected value to be a public migration failure.
 *
 * @param value - Candidate rejection reason.
 * @returns Exact public migration failure.
 */
function requireMigrationFailure(
  value: unknown,
): WorkspaceSearchMigrationFailure {
  if (!(value instanceof WorkspaceSearchMigrationFailure)) {
    throw value
  }
  return value
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
): WorkspaceSearchWriterFenceInitialOpenRecordV1 {
  if (record.mode !== 'open' || record.version !== 1) {
    throw new Error('Expected open writer fence.')
  }
  return record
}

/**
 * Requires one strict version-two released-open row.
 *
 * @param record - Candidate durable row.
 * @returns Exact released-open successor.
 */
function requireReleasedOpen(
  record: ReturnType<typeof requirePresent>,
): WorkspaceSearchWriterFenceReleasedOpenRecordV2 {
  if (record.mode !== 'open' || record.version !== 2) {
    throw new Error('Expected released-open writer fence.')
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
 * Determines whether one transition Put still names the current predecessor.
 *
 * @param item - Candidate writer-fence transition item.
 * @param current - Exact current durable writer-fence item.
 * @returns Whether its canonical predecessor CAS still holds.
 */
function writerFencePutMatchesPredecessor(
  item: TransactWriteItem | undefined,
  current: Readonly<Record<string, AttributeValue>>,
): boolean {
  const values = item?.Put?.ExpressionAttributeValues
  const expectedBytes = values?.[':canonicalBytes']?.S
  const expectedDigest = values?.[':recordDigest']?.S
  return expectedBytes !== undefined &&
    expectedDigest !== undefined &&
    current.canonicalBytes?.S === expectedBytes &&
    current.recordDigest?.S === expectedDigest
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

/**
 * Digests exact immutable bytes without JSON reinterpretation.
 *
 * @param bytes - Exact artifact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
