import { createHash } from 'node:crypto'
import {
  TransactionCanceledException,
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedConditionCheck,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createWorkspaceSearchMigrationAppliedRootAbsentConditionCheck,
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import {
  createWorkspaceSearchMigrationApplyPredecessorAwsBinding,
} from './migration-apply-operation-aws'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAbsentMigrationItemDigest,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import {
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
} from './migration-committed-prefix-apply-seal'
import type {
  WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway,
} from './migration-committed-prefix-apply-seal-aws'
import {
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
} from './migration-execution-boundary-aws'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck,
} from './migration-execution-run-aws'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  createWorkspaceSearchMigrationExecutionState,
  serializeWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionStateV2,
} from './migration-execution-state'
import {
  createWorkspaceSearchMigrationFullVerificationConflictRecordKeys,
} from './migration-full-verification-key'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createAwsWorkspaceSearchMigrationPartialRollbackStartPort,
  type WorkspaceSearchMigrationPartialRollbackStartAwsTransport,
  workspaceSearchMigrationPartialRollbackStartTransactionIndex,
} from './migration-partial-rollback-start-aws'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRolledBackRootV2RecordKey,
  createWorkspaceSearchMigrationRollbackStateV2RecordKey,
} from './migration-rollback-key'
import {
  createWorkspaceSearchMigrationRollbackOperationTransitionV2,
  finishWorkspaceSearchMigrationRollbackV2,
  parseWorkspaceSearchMigrationRollbackStartRootV2,
  serializeWorkspaceSearchMigrationRolledBackRootV2,
  serializeWorkspaceSearchMigrationRollbackPersistenceStateV2,
  type WorkspaceSearchMigrationRolledBackRootV2,
  type WorkspaceSearchMigrationRollbackPersistenceStateV2,
} from './migration-rollback-persistence-v2'
import type {
  WorkspaceSearchMigrationRollbackAuthorityClaim,
  WorkspaceSearchMigrationRollbackOperationAuthorityReader,
} from './migration-rollback-operation-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck,
} from './migration-sealed-planning-authority-aws'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchPlanLeafDigest,
} from './migration-state-machine'

const runId = 'partial-rollback-start-aws-test'
const ownerId = 'partial-rollback-start-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const executionCreatedAt = '2026-07-29T01:19:30.000Z'
const authorityEvaluatedAt = '2026-07-29T01:20:59.000Z'
const sealCreatedAt = '2026-07-29T01:21:00.000Z'
const commitAt = '2026-07-29T01:21:01.000Z'
const rollbackAt = '2026-07-29T01:21:02.000Z'
const finishedAt = '2026-07-29T01:21:03.000Z'
const retainUntil = '2026-08-30T01:00:00.000Z'

/** Exact production insertion order for controlled start-root fields. */
const rollbackStartControlledFieldNames = Object.freeze([
  'recordVersion',
  'kind',
  'stateTableId',
  'configurationHash',
  'runId',
  'executionRunDigest',
  'originDigest',
  'predecessorRevision',
  'startRootDigest',
  'startRootBytes',
])

/** Exact production insertion order for controlled rollback-state fields. */
const rollbackStateControlledFieldNames = Object.freeze([
  'recordVersion',
  'kind',
  'stateTableId',
  'configurationHash',
  'runId',
  'executionRunDigest',
  'originDigest',
  'startRootDigest',
  'revision',
  'status',
  'stateDigest',
  'stateBytes',
])

/**
 * Correlated static and fresh material for one partial rollback start.
 */
type PartialRollbackStartFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh current rollback-start authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * In-memory DynamoDB and immutable-seal harness for one successful start.
 */
class PartialRollbackStartHarness {
  /** Exact static fixture used by the narrow capabilities. */
  private readonly fixture: PartialRollbackStartFixture

  /** Current low-level migration-state rows by deterministic record key. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Exact stored committed-prefix seal. */
  private storedSeal: WorkspaceSearchApplySeal | undefined

  /** Exact stored committed-prefix seal reference. */
  private storedReference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference | undefined

  /** Next adapter clock result. */
  private clockIndex = 0

  /** Ordered non-read events proving side-effect sequencing. */
  readonly events: string[] = []

  /** Exact attempted fixed-order transaction. */
  transaction: TransactWriteItemsCommand | undefined

  /** Optional strict authority returned instead of the fixture authority. */
  authorityOverride:
    WorkspaceSearchMigrationPrePlanAuthority | undefined

  /** Whether the authority reader mutates its received claim. */
  mutateAuthorityClaim = false

  /** Whether the seal writer mutates its received seal before storing it. */
  mutateSealInput = false

  /** Optional raw failure raised after transaction effects are stored. */
  transactionErrorAfterCommit: unknown

  /** Optional raw failure raised before transaction effects are stored. */
  transactionErrorBeforeCommit: unknown

  /** Optional complete row maps returned for consecutive lifecycle observations. */
  private lifecycleObservations:
    readonly ReadonlyMap<
      string,
      Readonly<Record<string, AttributeValue>>
    >[] | undefined

  /** Number of lifecycle observation row reads served so far. */
  private lifecycleObservationReadCount = 0

  /**
   * Creates one empty durable harness.
   *
   * @param fixture - Exact correlated static and authority material.
   */
  constructor(fixture: PartialRollbackStartFixture) {
    this.fixture = fixture
  }

  /** Fresh current-authority reader. */
  readonly authorityPort:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader = {
      readAuthority: async (
        claim: WorkspaceSearchMigrationRollbackAuthorityClaim,
      ): Promise<WorkspaceSearchMigrationPrePlanAuthority> => {
        this.events.push('authority')
        const expected = createAuthorityClaim(
          this.fixture.currentAuthority,
        )
        expect(claim).toEqual(expected)
        if (this.mutateAuthorityClaim) {
          Object.defineProperty(
            claim,
            'maintenanceEvidencePointerRevision',
            {
              value:
                expected.maintenanceEvidencePointerRevision + 100,
              enumerable: true,
            },
          )
        }
        return structuredClone(
          this.authorityOverride ??
            this.fixture.currentAuthority,
        )
      },
    }

  /** Exact-version immutable committed-prefix seal gateway. */
  readonly sealGateway:
    Pick<
      WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway,
      | 'readCommittedPrefixApplySeal'
      | 'writeCommittedPrefixApplySeal'
    > = {
      writeCommittedPrefixApplySeal: async ({ seal }) => {
        this.events.push('seal-write')
        if (this.mutateSealInput) {
          Object.defineProperty(seal, 'createdAt', {
            value: new Date(
              Date.parse(seal.createdAt) + 1_000,
            ).toISOString(),
            enumerable: true,
          })
        }
        const bytes =
          serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
            seal,
          )
        const contentDigest = createMigrationDigest(seal)
        const reference:
          WorkspaceSearchMigrationCommittedPrefixApplySealReference = {
            scope: 'committed-prefix',
            objectKey:
              `workspace-search/v1/runs/${runId}/prefix-seals/` +
              `${contentDigest}.artifact`,
            versionId: 'partial-seal-version-1',
            contentDigest,
            byteLength: bytes.byteLength,
            retainUntil,
          }
        this.storedSeal = structuredClone(seal)
        this.storedReference = reference
        return structuredClone(reference)
      },
      readCommittedPrefixApplySeal: async (reference) => {
        this.events.push('seal-read')
        const storedReference = this.storedReference
        if (storedReference === undefined) {
          throw new Error(
            'Expected one stored committed-prefix seal reference.',
          )
        }
        expect(reference).toEqual(storedReference)
        const seal = this.storedSeal
        if (seal === undefined) {
          throw new Error('Expected one stored committed-prefix seal.')
        }
        return structuredClone(seal)
      },
    }

  /** Narrow measured DynamoDB transport. */
  readonly transport:
    WorkspaceSearchMigrationPartialRollbackStartAwsTransport = {
      getPartialRollbackStartItem: async (
        command: GetItemCommand,
      ): Promise<GetItemCommandOutput> => {
        expect(command.input.ConsistentRead).toBe(true)
        const recordKey = readCommandRecordKey(command)
        const observations = this.lifecycleObservations
        const item = observations === undefined
          ? this.items.get(recordKey)
          : observations[
              Math.min(
                Math.floor(
                  this.lifecycleObservationReadCount / 3,
                ),
                observations.length - 1,
              )
            ]?.get(recordKey)
        if (observations !== undefined) {
          this.lifecycleObservationReadCount += 1
        }
        return item === undefined
          ? { $metadata: {} }
          : {
              $metadata: {},
              Item: structuredClone(item),
            }
      },
      preparePartialRollbackStartWrite: async (): Promise<void> => {
        this.events.push('prepare')
      },
      transactWritePartialRollbackStart: async (
        command: TransactWriteItemsCommand,
      ): Promise<TransactWriteItemsCommandOutput> => {
        this.events.push('transact')
        this.transaction = command
        if (this.transactionErrorBeforeCommit !== undefined) {
          throw this.transactionErrorBeforeCommit
        }
        for (const item of requireTransactionItems(command)) {
          const put = item.Put
          if (put?.Item !== undefined) {
            this.items.set(
              readRawItemRecordKey(put.Item),
              structuredClone(put.Item),
            )
          }
        }
        if (this.transactionErrorAfterCommit !== undefined) {
          throw this.transactionErrorAfterCommit
        }
        return { $metadata: {} }
      },
    }

  /**
   * Returns seal creation time followed by final transaction time.
   *
   * @returns Exact adapter-owned time.
   */
  readonly clock = (): Date => {
    const value = this.clockIndex === 0
      ? sealCreatedAt
      : commitAt
    this.events.push(
      this.clockIndex === 0 ? 'seal-clock' : 'commit-clock',
    )
    this.clockIndex += 1
    return new Date(value)
  }

  /**
   * Deletes every durable row whose sort key starts with one prefix.
   *
   * @param prefix - Exact record-key prefix selected by a test.
   */
  deleteRowsByPrefix(prefix: string): void {
    for (const recordKey of this.items.keys()) {
      if (recordKey.startsWith(prefix)) {
        this.items.delete(recordKey)
      }
    }
  }

  /**
   * Seeds one complete migration-state row as a durable predecessor.
   *
   * @param item - Exact low-level state-table row.
   */
  seedStateRecord(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    this.items.set(
      readRawItemRecordKey(item),
      structuredClone(item),
    )
  }

  /**
   * Returns a detached snapshot of every current migration-state row.
   *
   * @returns Exact cloned row map keyed by deterministic record key.
   */
  snapshotStateRecords(): ReadonlyMap<
    string,
    Readonly<Record<string, AttributeValue>>
  > {
    const snapshot =
      new Map<
        string,
        Readonly<Record<string, AttributeValue>>
      >()
    for (const [recordKey, item] of this.items) {
      snapshot.set(recordKey, structuredClone(item))
    }
    return snapshot
  }

  /**
   * Overrides consecutive lifecycle observations with exact row maps.
   *
   * @param observations - One complete three-row map per observation.
   */
  setLifecycleObservations(
    observations: readonly ReadonlyMap<
      string,
      Readonly<Record<string, AttributeValue>>
    >[],
  ): void {
    if (observations.length === 0) {
      throw new Error('Expected at least one lifecycle observation.')
    }
    this.lifecycleObservations = observations.map((observation) => {
      const snapshot =
        new Map<
          string,
          Readonly<Record<string, AttributeValue>>
        >()
      for (const [recordKey, item] of observation) {
        snapshot.set(recordKey, structuredClone(item))
      }
      return snapshot
    })
    this.lifecycleObservationReadCount = 0
  }

  /**
   * Replaces the committed exact-version seal with different valid bytes.
   */
  corruptStoredSeal(): void {
    const stored = this.storedSeal
    if (stored === undefined) {
      throw new Error('Expected one stored committed-prefix seal.')
    }
    this.storedSeal = {
      ...structuredClone(stored),
      createdAt: new Date(
        Date.parse(stored.createdAt) + 1_000,
      ).toISOString(),
    }
  }
}

test('commits an admission-only partial rollback start as fixed thirteen items', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  const claim = createAuthorityClaim(fixture.currentAuthority)

  const state = await port.beginRollback({
    expectedRevision: 1,
    authority: claim,
  })

  expect(state).toMatchObject({
    persistenceVersion: 2,
    status: 'rolling-back',
    revision: 2,
    predecessorKind: 'committed-prefix-origin',
    upperBoundSequence: 0,
    nextSequence: 0,
  })
  expect(harness.events).toEqual([
    'authority',
    'seal-clock',
    'seal-write',
    'prepare',
    'commit-clock',
    'transact',
    'seal-read',
  ])
  const transaction = requireValue(
    harness.transaction,
    'Expected the partial-start transaction.',
  )
  const items = requireTransactionItems(transaction)
  expect(items).toHaveLength(
    workspaceSearchMigrationPartialRollbackStartTransactionIndex
      .count,
  )
  expect(
    items.map((item) =>
      item.ConditionCheck === undefined ? 'Put' : 'ConditionCheck'
    ),
  ).toEqual([
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'ConditionCheck',
    'Put',
    'Put',
  ])
  requireExpectedTransactionGuards(fixture, items)
  expect(
    items[
      workspaceSearchMigrationPartialRollbackStartTransactionIndex
        .startRoot
    ]?.Put?.Item?.recordKey?.S,
  ).toMatch(/^rollback-start\/v1\/[0-9a-f]{64}$/u)
  expect(
    items[
      workspaceSearchMigrationPartialRollbackStartTransactionIndex
        .rollbackState
    ]?.Put?.Item?.recordKey?.S,
  ).toMatch(/^rollback-state\/v2\/[0-9a-f]{64}$/u)
  const startItem = requirePutItem(
    requireValue(
      items[
        workspaceSearchMigrationPartialRollbackStartTransactionIndex
          .startRoot
      ],
      'Expected the rollback-start Put.',
    ),
  )
  const startRootBytes = startItem.startRootBytes?.B
  if (!(startRootBytes instanceof Uint8Array)) {
    throw new Error('Expected canonical rollback-start bytes.')
  }
  const startRoot =
    parseWorkspaceSearchMigrationRollbackStartRootV2(
      startRootBytes,
    )
  expect(
    port.createStartRootConditionCheck(startRoot),
  ).toEqual(
    createExpectedFullRowConditionCheck(
      fixture.configuration.tables['migration-state'].tableName,
      startItem,
    ),
  )
  expect(
    await port.readRollbackState(),
  ).toEqual(state)
  expect(
    harness.events.filter((event) => event === 'seal-write'),
  ).toHaveLength(1)
  expect(
    harness.events.filter((event) => event === 'transact'),
  ).toHaveLength(1)
})

test('starts from a nonempty mutable v2 committed prefix', async () => {
  const fixture = createFixture(1)
  const predecessor =
    createMutableV2Predecessor(fixture).state
  const predecessorRecord =
    createMutableExecutionStateRecord(fixture, predecessor)
  const harness = new PartialRollbackStartHarness(fixture)
  harness.seedStateRecord(predecessorRecord)
  const port = createPort(fixture, harness)

  const state = await port.beginRollback({
    expectedRevision: predecessor.revision,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })

  expect(state).toMatchObject({
    persistenceVersion: 2,
    status: 'rolling-back',
    revision: predecessor.revision + 1,
    predecessorKind: 'committed-prefix-origin',
    upperBoundSequence: 1,
    nextSequence: 1,
    expectedHeadDigest: predecessor.journalHeadDigest,
  })
  const transaction = requireValue(
    harness.transaction,
    'Expected the nonempty partial-start transaction.',
  )
  const items = requireTransactionItems(transaction)
  const applyBinding =
    createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    })
  const projection = applyBinding.parseStrongReadOutputs(
    { $metadata: {}, Item: predecessorRecord },
    { $metadata: {} },
  )
  if (
    projection.predecessor.kind !==
      'mutable-execution-state'
  ) {
    throw new Error('Expected one mutable apply predecessor.')
  }
  expect(
    projection.predecessor.executionState.executionStateVersion,
  ).toBe(2)
  expect(
    items[
      workspaceSearchMigrationPartialRollbackStartTransactionIndex
        .applyPredecessor
    ],
  ).toEqual(
    applyBinding.createExecutionStateConditionCheck(
      projection.predecessor,
    ),
  )
  const startRootBytes = items[
    workspaceSearchMigrationPartialRollbackStartTransactionIndex
      .startRoot
  ]?.Put?.Item?.startRootBytes?.B
  if (!(startRootBytes instanceof Uint8Array)) {
    throw new Error('Expected canonical rollback-start bytes.')
  }
  const startRoot =
    parseWorkspaceSearchMigrationRollbackStartRootV2(
      startRootBytes,
    )
  expect(startRoot).toMatchObject({
    predecessorRevision: predecessor.revision,
    predecessorDigest: predecessor.executionStateDigest,
    predecessorRunStateDigest: predecessor.runStateDigest,
    originalJournalSequence: 1,
    originalJournalHeadDigest: predecessor.journalHeadDigest,
    origin: {
      planOperationCount: 1,
      minimumJournalRetainUntil:
        predecessor.minimumJournalRetainUntil,
      predecessor: {
        kind: 'mutable-execution-state',
        executionStateVersion: 2,
        revision: predecessor.revision,
        predecessorDigest: predecessor.executionStateDigest,
        predecessorRunStateDigest: predecessor.runStateDigest,
      },
      seal: {
        journalSequence: 1,
        journalHeadDigest: predecessor.journalHeadDigest,
      },
    },
    initialState: {
      upperBoundSequence: 1,
      nextSequence: 1,
      expectedHeadDigest: predecessor.journalHeadDigest,
    },
  })
  expect(startRoot.initialState).toEqual(state)
})

test('recovers response loss and retries without another seal or transaction', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  harness.transactionErrorAfterCommit =
    new Error('simulated response loss')
  const port = createPort(fixture, harness)
  const command = {
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  }

  const committed = await port.beginRollback(command)
  harness.transactionErrorAfterCommit = undefined
  const retried = await createPort(fixture, harness)
    .beginRollback(command)

  expect(retried).toEqual(committed)
  expect(
    harness.events.filter((event) => event === 'seal-write'),
  ).toHaveLength(1)
  expect(
    harness.events.filter((event) => event === 'transact'),
  ).toHaveLength(1)
})

test('reads and retries from an advanced rolling-back state', async () => {
  const fixture = createFixture(1)
  const predecessor = createMutableV2Predecessor(fixture)
  const harness = new PartialRollbackStartHarness(fixture)
  harness.seedStateRecord(
    createMutableExecutionStateRecord(
      fixture,
      predecessor.state,
    ),
  )
  const port = createPort(fixture, harness)
  const command = {
    expectedRevision: predecessor.state.revision,
    authority: createAuthorityClaim(fixture.currentAuthority),
  }
  await port.beginRollback(command)
  const initialRows = harness.snapshotStateRecords()
  const initialLifecycle =
    requireValue(
      await port.readRollbackLifecycle(),
      'Expected an initial rollback lifecycle.',
    )
  const advanced =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot: initialLifecycle.startRoot,
      predecessorState: initialLifecycle.state,
      currentAuthority: fixture.currentAuthority,
      applyReceipt: predecessor.receipt,
      journalSegment: predecessor.journalSegment,
      committedAt: rollbackAt,
    })
  const transitionPut =
    port.createRollbackStateTransitionPut(
      initialLifecycle.state,
      advanced.state,
    )
  const identity = port.readBindingIdentity()
  const stateRecordKey =
    createWorkspaceSearchMigrationRollbackStateV2RecordKey(
      identity.bindingDigest,
    )
  const initialStateItem = requireValue(
    initialRows.get(stateRecordKey),
    'Expected the initial rollback-state row.',
  )
  const expectedSuccessorItem =
    createExpectedRollbackStateRecord(
      fixture,
      identity.bindingDigest,
      advanced.state,
    )
  expect(transitionPut).toEqual(
    createExpectedExactPredecessorPut(
      fixture.configuration.tables['migration-state'].tableName,
      initialStateItem,
      expectedSuccessorItem,
    ),
  )
  harness.seedStateRecord(requirePutItem(transitionPut))
  const advancedRows = harness.snapshotStateRecords()
  harness.setLifecycleObservations([
    initialRows,
    advancedRows,
    advancedRows,
  ])

  const lifecycle = await port.readRollbackLifecycle()
  const retried = await port.beginRollback(command)

  expect(lifecycle).toEqual({
    startRoot: initialLifecycle.startRoot,
    state: advanced.state,
  })
  expect(retried).toEqual(advanced.state)
  expect(
    harness.events.filter((event) => event === 'seal-write'),
  ).toHaveLength(1)
  expect(
    harness.events.filter((event) => event === 'transact'),
  ).toHaveLength(1)
})

test('reads and retries from an exact terminal lifecycle', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  const command = {
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  }
  await port.beginRollback(command)
  const initialLifecycle =
    requireValue(
      await port.readRollbackLifecycle(),
      'Expected an initial rollback lifecycle.',
    )
  const terminal = finishWorkspaceSearchMigrationRollbackV2({
    startRoot: initialLifecycle.startRoot,
    predecessorState: initialLifecycle.state,
    currentAuthority: fixture.currentAuthority,
    terminalReceipt: null,
    finishedAt,
  })
  const terminalStatePut =
    port.createRollbackStateTransitionPut(
      initialLifecycle.state,
      terminal.state,
    )
  const terminalRootPut =
    port.createRolledBackRootAbsentPut(terminal.root)
  const identity = port.readBindingIdentity()
  const currentRows = harness.snapshotStateRecords()
  const predecessorItem = requireValue(
    currentRows.get(
      createWorkspaceSearchMigrationRollbackStateV2RecordKey(
        identity.bindingDigest,
      ),
    ),
    'Expected the terminal predecessor state row.',
  )
  expect(terminalStatePut).toEqual(
    createExpectedExactPredecessorPut(
      fixture.configuration.tables['migration-state'].tableName,
      predecessorItem,
      createExpectedRollbackStateRecord(
        fixture,
        identity.bindingDigest,
        terminal.state,
      ),
    ),
  )
  expect(terminalRootPut).toEqual(
    createExpectedAbsentPut(
      fixture.configuration.tables['migration-state'].tableName,
      createExpectedRolledBackRootRecord(
        fixture,
        identity.bindingDigest,
        terminal.root,
      ),
    ),
  )
  harness.seedStateRecord(
    requirePutItem(terminalStatePut),
  )
  harness.seedStateRecord(
    requirePutItem(terminalRootPut),
  )

  expect(await port.readRollbackLifecycle()).toEqual({
    startRoot: initialLifecycle.startRoot,
    state: terminal.state,
    rolledBackRoot: terminal.root,
  })
  expect(await port.readRollbackState()).toEqual(terminal.state)
  expect(await port.beginRollback(command)).toEqual(terminal.state)
  expect(
    harness.events.filter((event) => event === 'seal-write'),
  ).toHaveLength(1)
  expect(
    harness.events.filter((event) => event === 'transact'),
  ).toHaveLength(1)
})

test('classifies hostile transaction-factory input as invalid arguments', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  const lifecycle = requireValue(
    await port.readRollbackLifecycle(),
    'Expected a rollback lifecycle for hostile input tests.',
  )
  const terminal = finishWorkspaceSearchMigrationRollbackV2({
    startRoot: lifecycle.startRoot,
    predecessorState: lifecycle.state,
    currentAuthority: fixture.currentAuthority,
    terminalReceipt: null,
    finishedAt,
  })
  const hostileStartRoot = new Proxy(
    lifecycle.startRoot,
    {
      ownKeys: () => {
        throw new Error('tenant-secret-start-root')
      },
    },
  )
  const foreignPredecessor = structuredClone(lifecycle.state)
  Object.defineProperty(
    foreignPredecessor,
    'configurationHash',
    {
      value: digest('foreign-configuration'),
      enumerable: true,
    },
  )
  const hostileTerminalRoot = new Proxy(
    terminal.root,
    {
      getOwnPropertyDescriptor: () => {
        throw new Error('tenant-secret-terminal-root')
      },
    },
  )

  expectSynchronousFailureCode(
    () => port.createStartRootConditionCheck(hostileStartRoot),
    'INVALID_ARGUMENT',
  )
  expectSynchronousFailureCode(
    () =>
      port.createRollbackStateTransitionPut(
        foreignPredecessor,
        terminal.state,
      ),
    'INVALID_ARGUMENT',
  )
  expectSynchronousFailureCode(
    () =>
      port.createRollbackStateTransitionPut(
        terminal.state,
        terminal.state,
      ),
    'INVALID_ARGUMENT',
  )
  expectSynchronousFailureCode(
    () =>
      port.createRolledBackRootAbsentPut(
        hostileTerminalRoot,
      ),
    'INVALID_ARGUMENT',
  )
})

test('rejects torn and mismatched terminal lifecycle rows', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  const initialLifecycle =
    requireValue(
      await port.readRollbackLifecycle(),
      'Expected an initial rollback lifecycle.',
    )
  const initialRows = harness.snapshotStateRecords()
  const firstTerminal =
    finishWorkspaceSearchMigrationRollbackV2({
      startRoot: initialLifecycle.startRoot,
      predecessorState: initialLifecycle.state,
      currentAuthority: fixture.currentAuthority,
      terminalReceipt: null,
      finishedAt,
    })
  const secondTerminal =
    finishWorkspaceSearchMigrationRollbackV2({
      startRoot: initialLifecycle.startRoot,
      predecessorState: initialLifecycle.state,
      currentAuthority: fixture.currentAuthority,
      terminalReceipt: null,
      finishedAt: '2026-07-29T01:21:04.000Z',
    })
  const firstStateItem = requirePutItem(
    port.createRollbackStateTransitionPut(
      initialLifecycle.state,
      firstTerminal.state,
    ),
  )
  const firstRootItem = requirePutItem(
    port.createRolledBackRootAbsentPut(firstTerminal.root),
  )
  const secondRootItem = requirePutItem(
    port.createRolledBackRootAbsentPut(secondTerminal.root),
  )
  const identity = port.readBindingIdentity()
  expect(Object.isFrozen(identity)).toBe(true)
  expect(identity).toMatchObject({
    stateTableId:
      fixture.configuration.tables['migration-state'].tableId,
    configurationHash: fixture.configurationHash,
    runId,
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
  })
  const stateKey =
    createWorkspaceSearchMigrationRollbackStateV2RecordKey(
      identity.bindingDigest,
    )
  const rootKey =
    createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
      identity.bindingDigest,
    )
  const rollingWithRoot = new Map(initialRows)
  rollingWithRoot.set(rootKey, firstRootItem)
  const terminalWithoutRoot = new Map(initialRows)
  terminalWithoutRoot.set(stateKey, firstStateItem)
  const rootWithoutTerminal = new Map(initialRows)
  rootWithoutTerminal.delete(stateKey)
  rootWithoutTerminal.set(rootKey, firstRootItem)
  const mismatchedTerminalRoot = new Map(initialRows)
  mismatchedTerminalRoot.set(stateKey, firstStateItem)
  mismatchedTerminalRoot.set(rootKey, secondRootItem)

  for (const rows of [
    rollingWithRoot,
    terminalWithoutRoot,
    rootWithoutTerminal,
    mismatchedTerminalRoot,
  ]) {
    harness.setLifecycleObservations([rows, rows])
    await expectFailureCode(
      port.readRollbackLifecycle(),
      'INVALID_STATE',
    )
  }
})

test('fails after three non-coherent lifecycle observations', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  const present = harness.snapshotStateRecords()
  const absent =
    new Map<
      string,
      Readonly<Record<string, AttributeValue>>
    >()
  harness.setLifecycleObservations([
    present,
    absent,
    present,
  ])

  await expectFailureCode(
    port.readRollbackLifecycle(),
    'AMBIGUOUS_OPERATION_UNRESOLVED',
  )
})

test('isolates the caller claim from authority-reader mutation', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  harness.mutateAuthorityClaim = true
  const port = createPort(fixture, harness)
  const claim = createAuthorityClaim(fixture.currentAuthority)

  await expect(
    port.beginRollback({
      expectedRevision: 1,
      authority: claim,
    }),
  ).resolves.toMatchObject({
    persistenceVersion: 2,
    revision: 2,
  })
  expect(claim).toEqual(
    createAuthorityClaim(fixture.currentAuthority),
  )
})

test('rejects a fresh authority with different maintenance evidence', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  harness.authorityOverride = {
    ...fixture.currentAuthority,
    maintenanceEvidencePointerRevision:
      fixture.currentAuthority
        .maintenanceEvidencePointerRevision + 1,
  }
  const port = createPort(fixture, harness)

  await expectFailureCode(
    port.beginRollback({
      expectedRevision: 1,
      authority: createAuthorityClaim(fixture.currentAuthority),
    }),
    'INVALID_MAINTENANCE_EVIDENCE',
  )
  expect(harness.events).not.toContain('seal-write')
  expect(harness.events).not.toContain('transact')
})

test('rejects seal-writer mutation before transaction construction', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  harness.mutateSealInput = true
  const port = createPort(fixture, harness)

  await expectFailureCode(
    port.beginRollback({
      expectedRevision: 1,
      authority: createAuthorityClaim(fixture.currentAuthority),
    }),
    'INVALID_STATE',
  )
  expect(harness.events).not.toContain('transact')
})

test('fails closed when only the shared start row remains durable', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  const rollback =
    createWorkspaceSearchMigrationRollbackConflictRecordKeys({
      stateTableId:
        fixture.configuration.tables['migration-state'].tableId,
      configurationHash: fixture.configurationHash,
      runId: fixture.executionRun.runId,
      executionRunDigest:
        fixture.executionRun.executionRunDigest,
    })
  harness.deleteRowsByPrefix(
    createWorkspaceSearchMigrationRollbackStateV2RecordKey(
      rollback.bindingDigest,
    ),
  )

  await expectFailureCode(
    port.readRollbackState(),
    'INVALID_STATE',
  )
})

test('fails closed when only the v2 state row remains durable', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  harness.deleteRowsByPrefix('rollback-start/v1/')

  await expectFailureCode(
    port.readRollbackState(),
    'INVALID_STATE',
  )
})

test('rejects changed exact-version seal bytes after commit', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const port = createPort(fixture, harness)
  await port.beginRollback({
    expectedRevision: 1,
    authority: createAuthorityClaim(fixture.currentAuthority),
  })
  harness.corruptStoredSeal()

  await expectFailureCode(
    port.readRollbackState(),
    'INVALID_JOURNAL',
  )
})

test('rejects preexisting full verification before seal upload', async () => {
  const fixture = createFixture()
  const harness = new PartialRollbackStartHarness(fixture)
  const verification =
    createWorkspaceSearchMigrationFullVerificationConflictRecordKeys({
      stateTableId:
        fixture.configuration.tables['migration-state'].tableId,
      configurationHash: fixture.configurationHash,
      runId: fixture.executionRun.runId,
      executionRunDigest:
        fixture.executionRun.executionRunDigest,
      sealedPlanningAuthorityDigest:
        fixture.sealedPlanningAuthority.authorityDigest,
    })
  harness.seedStateRecord({
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: verification.state },
    kind: { S: 'existing-full-verification-state' },
  })
  const port = createPort(fixture, harness)

  await expectFailureCode(
    port.beginRollback({
      expectedRevision: 1,
      authority: createAuthorityClaim(fixture.currentAuthority),
    }),
    'INVALID_STATE',
  )
  expect(harness.events).not.toContain('seal-write')
  expect(harness.events).not.toContain('transact')
})

test('maps every fixed conditional cancellation position', async () => {
  const index =
    workspaceSearchMigrationPartialRollbackStartTransactionIndex
  for (
    let failedIndex = 0;
    failedIndex < index.count;
    failedIndex += 1
  ) {
    const fixture = createFixture()
    const harness = new PartialRollbackStartHarness(fixture)
    harness.transactionErrorBeforeCommit = createCancellation(
      failedIndex,
      index.count,
    )
    const expectedCode: WorkspaceSearchMigrationFailureCode =
      failedIndex === index.lease
        ? 'LEASE_LOST'
        : failedIndex === index.pointer ||
            failedIndex === index.receipt
          ? 'INVALID_MAINTENANCE_EVIDENCE'
          : 'INVALID_STATE'

    await expectFailureCode(
      createPort(fixture, harness).beginRollback({
        expectedRevision: 1,
        authority: createAuthorityClaim(fixture.currentAuthority),
      }),
      expectedCode,
    )
  }
}, 20_000)

/**
 * Creates one adapter bound to a fixture and its in-memory harness.
 *
 * @param fixture - Exact correlated static material.
 * @param harness - In-memory narrow dependencies.
 * @returns Direct partial rollback-start port.
 */
function createPort(
  fixture: PartialRollbackStartFixture,
  harness: PartialRollbackStartHarness,
) {
  return createAwsWorkspaceSearchMigrationPartialRollbackStartPort({
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    closedWriterFenceRecord: fixture.closedWriterFenceRecord,
    executionRun: fixture.executionRun,
    authorityPort: harness.authorityPort,
    committedPrefixSealGateway: harness.sealGateway,
    transport: harness.transport,
    clock: harness.clock,
  })
}

/**
 * Requires one async operation to fail with an exact migration code.
 *
 * @param operation - Candidate rejected operation.
 * @param expectedCode - Exact stable public failure code.
 */
async function expectFailureCode(
  operation: Promise<unknown>,
  expectedCode: WorkspaceSearchMigrationFailureCode,
): Promise<void> {
  try {
    await operation
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expectedCode })
    if (error instanceof Error) {
      expect(error.message).not.toContain('tenant-secret')
    }
    return
  }
  throw new Error(`Expected migration failure ${expectedCode}.`)
}

/**
 * Requires one synchronous operation to fail with an exact migration code.
 *
 * @param operation - Candidate throwing operation.
 * @param expectedCode - Exact stable public failure code.
 */
function expectSynchronousFailureCode(
  operation: () => unknown,
  expectedCode: WorkspaceSearchMigrationFailureCode,
): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expectedCode })
    if (error instanceof Error) {
      expect(error.message).not.toContain('tenant-secret')
    }
    return
  }
  throw new Error(`Expected migration failure ${expectedCode}.`)
}

/**
 * Creates one fixed-position conditional transaction cancellation.
 *
 * @param failedIndex - Exact failed item position.
 * @param count - Exact fixed transaction item count.
 * @returns Raw DynamoDB transaction cancellation.
 */
function createCancellation(
  failedIndex: number,
  count: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-cancellation',
    CancellationReasons: Array.from(
      { length: count },
      (_, index) => ({
        Code: index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
      }),
    ),
  })
}

/**
 * Requires every fixed guard to occupy its exact public position.
 *
 * @param fixture - Exact correlated static material.
 * @param items - Complete fixed transaction item list.
 */
function requireExpectedTransactionGuards(
  fixture: PartialRollbackStartFixture,
  items: readonly TransactWriteItem[],
): void {
  const index =
    workspaceSearchMigrationPartialRollbackStartTransactionIndex
  const authority =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      authority: fixture.currentAuthority,
      commitAt: new Date(commitAt),
    })
  expect(items[index.lease]).toEqual(authority[0])
  expect(items[index.pointer]).toEqual(authority[1])
  expect(items[index.receipt]).toEqual(authority[2])
  expect(items[index.writerFence]).toEqual(
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      fixture.closedWriterFenceRecord,
      fixture.writerFence,
    ),
  )
  expect(items[index.executionBoundary]).toEqual(
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        boundary: fixture.executionBoundary,
      },
    ),
  )
  expect(items[index.sealedPlanningAuthority]).toEqual(
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck(
      {
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        authority: fixture.sealedPlanningAuthority,
      },
    ),
  )
  expect(items[index.executionRun]).toEqual(
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    }),
  )
  const predecessor =
    createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    })
  expect(items[index.applyPredecessor]).toEqual(
    predecessor.createExecutionStateConditionCheck({
      kind: 'execution-run-admission',
    }),
  )
  expect(items[index.appliedRoot]).toEqual(
    createWorkspaceSearchMigrationAppliedRootAbsentConditionCheck({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    }),
  )
  const verification =
    createWorkspaceSearchMigrationFullVerificationConflictRecordKeys({
      stateTableId:
        fixture.configuration.tables['migration-state'].tableId,
      configurationHash: fixture.configurationHash,
      runId: fixture.executionRun.runId,
      executionRunDigest:
        fixture.executionRun.executionRunDigest,
      sealedPlanningAuthorityDigest:
        fixture.sealedPlanningAuthority.authorityDigest,
    })
  expect(
    items[index.verificationState]?.ConditionCheck?.Key?.recordKey?.S,
  ).toBe(verification.state)
  expect(
    items[index.verifiedRoot]?.ConditionCheck?.Key?.recordKey?.S,
  ).toBe(verification.root)
  const rollback =
    createWorkspaceSearchMigrationRollbackConflictRecordKeys({
      stateTableId:
        fixture.configuration.tables['migration-state'].tableId,
      configurationHash: fixture.configurationHash,
      runId: fixture.executionRun.runId,
      executionRunDigest:
        fixture.executionRun.executionRunDigest,
    })
  expect(
    items[index.startRoot]?.Put?.Item?.recordKey?.S,
  ).toBe(rollback.start)
  expect(
    items[index.rollbackState]?.Put?.Item?.recordKey?.S,
  ).toBe(
    createWorkspaceSearchMigrationRollbackStateV2RecordKey(
      rollback.bindingDigest,
    ),
  )
}

/**
 * Creates the exact expected full-row start-root ConditionCheck.
 *
 * @param tableName - Exact measured migration-state table name.
 * @param item - Complete expected controlled start-root row.
 * @returns Exact expected condition-only transaction item.
 */
function createExpectedFullRowConditionCheck(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: createExpectedItemKey(item),
      ...createExpectedFullRowConditionFields(
        item,
        rollbackStartControlledFieldNames,
      ),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates the exact expected full-row predecessor CAS Put.
 *
 * @param tableName - Exact measured migration-state table name.
 * @param predecessor - Complete expected controlled predecessor row.
 * @param successor - Complete expected controlled successor row.
 * @returns Exact expected successor Put with full predecessor conditions.
 */
function createExpectedExactPredecessorPut(
  tableName: string,
  predecessor: Readonly<Record<string, AttributeValue>>,
  successor: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  expect(createExpectedItemKey(predecessor)).toEqual(
    createExpectedItemKey(successor),
  )
  return {
    Put: {
      TableName: tableName,
      Item: successor,
      ...createExpectedFullRowConditionFields(
        predecessor,
        rollbackStateControlledFieldNames,
      ),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates expected equality fields for every controlled non-key attribute.
 *
 * @param item - Complete expected controlled predecessor row.
 * @param fieldNames - Exact controlled-field token order.
 * @returns Exact expected condition expression substitutions.
 */
function createExpectedFullRowConditionFields(
  item: Readonly<Record<string, AttributeValue>>,
  fieldNames: readonly string[],
): {
  /** Exact conjunction of every controlled non-key field. */
  readonly ConditionExpression: string
  /** Exact attribute-name substitutions. */
  readonly ExpressionAttributeNames:
    Readonly<Record<string, string>>
  /** Exact attribute-value substitutions. */
  readonly ExpressionAttributeValues:
    Readonly<Record<string, AttributeValue>>
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  let index = 0
  for (const name of fieldNames) {
    const value = requireValue(
      item[name],
      `Expected controlled field ${name}.`,
    )
    const nameToken = `#field${index}`
    const valueToken = `:value${index}`
    names[nameToken] = name
    values[valueToken] = value
    clauses.push(`${nameToken} = ${valueToken}`)
    index += 1
  }
  if (clauses.length === 0) {
    throw new Error('Expected controlled non-key fields.')
  }
  return {
    ConditionExpression: clauses.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

/**
 * Creates the exact expected absent-only Put.
 *
 * @param tableName - Exact measured migration-state table name.
 * @param item - Complete expected immutable row.
 * @returns Exact expected absent-row conditional Put.
 */
function createExpectedAbsentPut(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(#migrationId) AND ' +
        'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#migrationId': 'migrationId',
        '#recordKey': 'recordKey',
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates the exact expected v2 rollback-state envelope.
 *
 * @param fixture - Exact admitted lifecycle fixture.
 * @param bindingDigest - Stable rollback persistence namespace digest.
 * @param state - Exact current lifecycle state.
 * @returns Complete expected low-level state row.
 */
function createExpectedRollbackStateRecord(
  fixture: PartialRollbackStartFixture,
  bindingDigest: string,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createWorkspaceSearchMigrationRollbackStateV2RecordKey(
        bindingDigest,
      ),
    },
    recordVersion: { N: '2' },
    kind: {
      S: 'workspace-search-migration-rollback-state-record',
    },
    stateTableId: {
      S: fixture.configuration.tables['migration-state'].tableId,
    },
    configurationHash: { S: fixture.configurationHash },
    runId: { S: fixture.executionRun.runId },
    executionRunDigest: {
      S: fixture.executionRun.executionRunDigest,
    },
    originDigest: { S: state.originDigest },
    startRootDigest: { S: state.startRootDigest },
    revision: { N: String(state.revision) },
    status: { S: state.status },
    stateDigest: { S: state.stateDigest },
    stateBytes: {
      B: serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
        state,
      ),
    },
  }
}

/**
 * Creates the exact expected v2 rolled-back-root envelope.
 *
 * @param fixture - Exact admitted lifecycle fixture.
 * @param bindingDigest - Stable rollback persistence namespace digest.
 * @param root - Exact immutable terminal root.
 * @returns Complete expected low-level terminal-root row.
 */
function createExpectedRolledBackRootRecord(
  fixture: PartialRollbackStartFixture,
  bindingDigest: string,
  root: WorkspaceSearchMigrationRolledBackRootV2,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
        bindingDigest,
      ),
    },
    recordVersion: { N: '2' },
    kind: {
      S: 'workspace-search-migration-rolled-back-root-record',
    },
    stateTableId: {
      S: fixture.configuration.tables['migration-state'].tableId,
    },
    configurationHash: { S: fixture.configurationHash },
    runId: { S: fixture.executionRun.runId },
    executionRunDigest: {
      S: fixture.executionRun.executionRunDigest,
    },
    originDigest: { S: root.originDigest },
    startRootDigest: { S: root.startRootDigest },
    terminalStateDigest: { S: root.terminalStateDigest },
    rootDigest: { S: root.rootDigest },
    rootBytes: {
      B: serializeWorkspaceSearchMigrationRolledBackRootV2(root),
    },
  }
}

/**
 * Creates the exact expected migration-state compound key.
 *
 * @param item - Complete expected controlled row.
 * @returns Exact partition and sort key.
 */
function createExpectedItemKey(
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: requireValue(
      item.migrationId,
      'Expected a migrationId key attribute.',
    ),
    recordKey: requireValue(
      item.recordKey,
      'Expected a recordKey key attribute.',
    ),
  }
}

/**
 * Creates one fully correlated partial-start fixture.
 *
 * @param planOperationCount - Zero or one admitted plan operation.
 * @returns Exact measured roots and fresh current authority.
 */
function createFixture(
  planOperationCount: 0 | 1 = 0,
): PartialRollbackStartFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const writerFence = createWriterFenceBinding(configuration)
  const maintenanceReceipt = createMaintenanceReceipt()
  const maintenanceReceiptDigest =
    createMigrationDigest(maintenanceReceipt)
  const closeAuthority = {
    configurationHash,
    runId,
    ownerId,
    leaseFenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      digest('close-maintenance-receipt'),
    maintenanceEvidencePointerRevision: 11,
  }
  const open =
    createWorkspaceSearchWriterFenceInitialOpenRecord(
      writerFence,
      new Date(openedAt),
    )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      closeAuthority,
      new Date(closedAt),
    )
  const closedBoundary =
    createWorkspaceSearchMigrationExecutionBoundary({
      runId,
      configurationHash,
      tableIds: writerFence.tableIds,
      closedWriterFenceRecord,
    })
  const executionBoundary = createAdmittedBoundary(
    closedBoundary,
    maintenanceReceipt,
    maintenanceReceiptDigest,
  )
  const planSeal = createPlanSeal(
    configurationHash,
    planOperationCount,
  )
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    writerFence.tableIds,
    planSeal,
    maintenanceReceiptDigest,
  )
  const admissionAuthority = createCurrentAuthority(
    configuration,
    configurationHash,
    maintenanceReceipt,
    '2026-07-29T01:19:29.000Z',
  )
  const executionRun =
    createWorkspaceSearchMigrationExecutionRun({
      executionBoundary,
      sealedPlanningAuthority,
      planSeal,
      configuration,
      configurationHash,
      currentAuthority: admissionAuthority,
      createdAt: executionCreatedAt,
    })
  const currentAuthority = createCurrentAuthority(
    configuration,
    configurationHash,
    maintenanceReceipt,
    authorityEvaluatedAt,
  )
  return {
    configuration,
    configurationHash,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    currentAuthority,
  }
}

/**
 * Journal-bearing mutable predecessor and exact reverse evidence.
 */
type MutableV2PredecessorFixture = {
  /** Strict traversal-capable mutable execution-state predecessor. */
  readonly state: WorkspaceSearchMigrationExecutionStateV2
  /** Exact durable apply receipt for the sole mutation. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Exact immutable preimage segment for the sole mutation. */
  readonly journalSegment: WorkspaceSearchJournalSegment
}

/**
 * Creates a journal-bearing traversal-capable mutable predecessor.
 *
 * @param fixture - Exact admitted nonempty-plan fixture.
 * @returns Strict mutable predecessor and exact reverse evidence.
 */
function createMutableV2Predecessor(
  fixture: PartialRollbackStartFixture,
): MutableV2PredecessorFixture {
  const current = fixture.executionRun.runState
  const operationId = digest('partial-prefix-operation')
  const sourceDigest = digest('partial-prefix-source')
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey(
        'document',
        'document-1',
      ),
    },
  }
  const afterItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: 'document-1' },
    title: { S: 'Partial prefix document' },
  }
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const beforeDigest = createAbsentMigrationItemDigest()
  const afterDigest = createAttributeMapDigest(afterItem)
  const journalSegment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    sequence: 1,
    preparedFenceToken:
      current.maintenanceEvidenceReceipt.fenceToken,
    operationId,
    sourceDigest,
    previousHeadDigest: current.journalHeadDigest,
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest,
    before: {
      exists: false,
      digest: beforeDigest,
    },
    after: {
      exists: true,
      item: encodeAttributeMap(afterItem),
      digest: afterDigest,
    },
    createdAt: '2026-07-29T01:19:30.500Z',
  }
  const journalText =
    serializeWorkspaceSearchJournalSegment(journalSegment)
  const contentDigest = createHash('sha256')
    .update(journalText, 'utf8')
    .digest('hex')
  const versionId = 'partial-prefix-journal-version'
  const journalHeadDigest = createJournalHeadDigest({
    previousHeadDigest: current.journalHeadDigest,
    sequence: 1,
    operationId,
    contentDigest,
    versionId,
  })
  const marker: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: fixture.configurationHash,
    operationId,
    planSequence: 1,
    planOperationDigest: createSinglePlanOperationDigest(),
    sequence: 1,
    targetKeyDigest,
    sourceDigest,
    beforeDigest,
    afterDigest,
    fenceToken: current.maintenanceEvidenceReceipt.fenceToken,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(current.maintenanceEvidenceReceipt),
    journal: {
      objectKey:
        `workspace-search/v1/runs/${runId}/apply-journal-segments/` +
        `${contentDigest}.artifact`,
      versionId,
      contentDigest,
      byteLength:
        new TextEncoder().encode(journalText).byteLength,
      retainUntil,
      headDigest: journalHeadDigest,
    },
    committedAt: '2026-07-29T01:19:31.000Z',
  }
  const markerAccumulator = MigrationDigestAccumulator.fromState(
    current.applyMarkerDigestState,
  )
  markerAccumulator.add(createMigrationDigest(marker))
  const mutationState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      marker,
      nextRunState: {
        ...structuredClone(current),
        revision: current.revision + 1,
        appliedOperationCount:
          current.appliedOperationCount + 1,
        applyMarkerDigestState: markerAccumulator.exportState(),
        journalSequence: 1,
        journalHeadDigest,
        updatedAt: marker.committedAt,
      },
    })
  const previousCheckpoint =
    current.apply.sources['project-directory']
  return {
    state:
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission: fixture.executionRun,
        predecessor: mutationState,
        authority: {
          lease: structuredClone(fixture.currentAuthority.lease),
          ownerId: fixture.currentAuthority.lease.ownerId,
          at: authorityEvaluatedAt,
        },
        location: 'project-directory',
        checkpoint:
          createTerminalEmptyCheckpoint(previousCheckpoint),
      }),
    receipt: marker,
    journalSegment,
  }
}

/**
 * Creates the exact durable mutable execution-state row.
 *
 * @param fixture - Exact admitted partial-start binding.
 * @param state - Strict mutable execution-state predecessor.
 * @returns Complete low-level migration-state row.
 */
function createMutableExecutionStateRecord(
  fixture: PartialRollbackStartFixture,
  state: WorkspaceSearchMigrationExecutionStateV2,
): Readonly<Record<string, AttributeValue>> {
  const stateTable =
    fixture.configuration.tables['migration-state']
  const bindingDigest =
    createWorkspaceSearchMigrationApplyRunBindingDigest({
      stateTable,
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    })
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: `execution-state/v1/${bindingDigest}/state`,
    },
    kind: {
      S: 'workspace-search-migration-execution-state-record',
    },
    recordVersion: { N: '1' },
    stateTableId: { S: stateTable.tableId },
    configurationHash: { S: fixture.configurationHash },
    runId: { S: fixture.executionRun.runId },
    executionRunDigest: {
      S: fixture.executionRun.executionRunDigest,
    },
    revision: { N: String(state.revision) },
    status: { S: state.status },
    runStateDigest: { S: state.runStateDigest },
    executionStateDigest: { S: state.executionStateDigest },
    executionStateBytes: {
      B: serializeWorkspaceSearchMigrationExecutionState(state),
    },
  }
}

/**
 * Creates one terminal zero-row checkpoint successor.
 *
 * @param previous - Exact incomplete checkpoint.
 * @returns Complete terminal cumulative checkpoint.
 */
function createTerminalEmptyCheckpoint(
  previous: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
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
 * Returns the hypothetical single operation digest sealed by this fixture.
 *
 * @returns Stable exact planned-operation digest.
 */
function createSinglePlanOperationDigest(): string {
  return digest('partial-prefix-plan-operation')
}

/**
 * Creates the exact caller authority claim.
 *
 * @param authority - Exact fresh durable authority.
 * @returns Detached lease, receipt, and pointer claim.
 */
function createAuthorityClaim(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationRollbackAuthorityClaim {
  return {
    lease: {
      runId: authority.lease.runId,
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
    },
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
  }
}

/**
 * Creates the revision-two planning-admitted boundary.
 *
 * @param closed - Exact revision-one closed boundary.
 * @param receipt - Exact current maintenance receipt.
 * @param receiptDigest - Digest of the exact receipt.
 * @returns Exact planning-admitted successor.
 */
function createAdmittedBoundary(
  closed: ReturnType<
    typeof createWorkspaceSearchMigrationExecutionBoundary
  >,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  receiptDigest: string,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const fields = {
    kind: closed.kind,
    boundaryVersion: closed.boundaryVersion,
    migrationId: closed.migrationId,
    migrationVersion: closed.migrationVersion,
    runId: closed.runId,
    configurationHash: closed.configurationHash,
    tableIds: closed.tableIds,
    closedWriterFenceRecordDigest:
      closed.closedWriterFenceRecordDigest,
    closedAt: closed.closedAt,
    closeAuthority: closed.closeAuthority,
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: receiptDigest,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceDigest: receipt.evidenceDigest,
      maintenanceEvidenceLocator: receipt.evidenceLocator,
      runtimeRevision: receipt.runtimeRevision,
      drainStartedAt: closedAt,
      drainCompletedAt: '2026-07-29T01:15:00.000Z',
      admittedAt,
    },
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    'boundaryDigest'
  >
  return {
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one strict zero- or one-operation plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planOperationCount - Exact admitted operation count.
 * @returns Exact strict plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  planOperationCount: 0 | 1,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: planOperationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : createWorkspaceSearchPlanLeafDigest({
          planSequence: 1,
          operationDigest: createSinglePlanOperationDigest(),
        }),
    planOperationCount,
    sourceOperationCount: planOperationCount,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:17:00.000Z',
  }
}

/**
 * Creates one strict compact version-two planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six exact table incarnations.
 * @param planSeal - Exact strict plan seal.
 * @param receiptDigest - Current maintenance receipt digest.
 * @returns Detached strict sealed planning authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest = digest('plan-manifest')
  const provenanceManifestDigest = digest('provenance-manifest')
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        `workspace-search/v1/planning-provenance-artifacts/v1/` +
        `${runId}/${configurationHash}/manifest-heads/` +
        `${provenanceManifestDigest}.artifact`,
      versionId: 'provenance-manifest-version',
      contentDigest: provenanceManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest('planning-provenance'),
    historicalReceiptBindingDigest:
      digest('historical-receipt'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory'),
      createEvidenceHead('work-items'),
      createEvidenceHead('collaboration'),
      createEvidenceHead('documents'),
      createEvidenceHead('workspace-search'),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest: receiptDigest,
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
 * Creates one compact terminal planning evidence head.
 *
 * @param chain - Exact evidence-chain role.
 * @returns Exact terminal evidence commitment.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
) {
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest: digest(`checkpoint:${chain}`),
  }
}

/**
 * Creates one exact fresh pre-plan authority.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param receipt - Exact current maintenance receipt.
 * @param evaluatedAt - Adapter evaluation time.
 * @returns Exact fresh current authority.
 */
function createCurrentAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  evaluatedAt: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  const evaluatedEpoch = Date.parse(evaluatedAt)
  const heartbeatEpoch = evaluatedEpoch - 29_000
  return {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt:
        new Date(heartbeatEpoch).toISOString(),
      expiresAt:
        new Date(heartbeatEpoch + 60_000).toISOString(),
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: 12,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt,
  }
}

/**
 * Creates one fresh maintenance receipt bound to fence seven.
 *
 * @returns Exact maintenance evidence receipt.
 */
function createMaintenanceReceipt():
WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/current.json',
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:18:30.000Z',
    oldestObservationAt: '2026-07-29T01:18:00.000Z',
    validUntil: '2026-07-29T01:23:00.001Z',
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable exact measured configuration.
 */
function createConfiguration():
WorkspaceSearchMigrationConfiguration {
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
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state':
        createSupportingTable('migration-state'),
    },
    journal: {
      bucketName:
        'mukuroji-workspace-search-migration-journal',
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
 * Creates one independently reconstructed writer-fence binding.
 *
 * @param configuration - Exact measured migration configuration.
 * @returns Exact six-table writer-fence binding.
 */
function createWriterFenceBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceBinding {
  const stateTable = configuration.tables['migration-state']
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest({
        role: 'migration-state',
        tableName: stateTable.tableName,
        tableArn: stateTable.tableArn,
        tableId: stateTable.tableId,
        creationTime: stateTable.creationTime,
        account: stateTable.account,
        region: stateTable.region,
      }),
    tableIds: createTableIds(configuration),
  })
}

/**
 * Creates one measured source table identity.
 *
 * @param role - Exact source table role.
 * @returns Complete measured source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured target or state table identity.
 *
 * @param role - Exact supporting table role.
 * @returns Complete measured supporting identity.
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
 * @param role - Logical migration table role.
 * @param key - Exact ordered base-table key.
 * @param deletionProtection - Measured deletion-protection status.
 * @returns Complete immutable table identity.
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
    creationTime: configurationTime,
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
 * Returns the exact source primary-key descriptor.
 *
 * @param role - Exact source table role.
 * @returns Ordered physical key attributes.
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
 * Projects all six exact physical table identifiers.
 *
 * @param configuration - Complete measured configuration.
 * @returns Exact role-indexed table identifiers.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items':
      configuration.tables['work-items'].tableId,
    collaboration:
      configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Reads the exact record key from one strong-read command.
 *
 * @param command - Adapter-owned GetItem command.
 * @returns Exact DynamoDB sort-key string.
 */
function readCommandRecordKey(command: GetItemCommand): string {
  const value = command.input.Key?.recordKey
  if (typeof value?.S !== 'string') {
    throw new Error('Expected a string record key.')
  }
  return value.S
}

/**
 * Reads the exact record key from one low-level item.
 *
 * @param item - Complete low-level item.
 * @returns Exact DynamoDB sort-key string.
 */
function readRawItemRecordKey(
  item: Readonly<Record<string, AttributeValue>>,
): string {
  const value = item.recordKey
  if (typeof value?.S !== 'string') {
    throw new Error('Expected one item record key.')
  }
  return value.S
}

/**
 * Requires one fixed transaction item list.
 *
 * @param command - Adapter-owned transaction command.
 * @returns Complete transaction items.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand,
): readonly TransactWriteItem[] {
  const items = command.input.TransactItems
  if (items === undefined) {
    throw new Error('Expected transaction items.')
  }
  return items
}

/**
 * Requires one transaction item to contain a complete Put row.
 *
 * @param item - Candidate transaction item.
 * @returns Complete low-level Put item.
 */
function requirePutItem(
  item: TransactWriteItem,
): Readonly<Record<string, AttributeValue>> {
  const value = item.Put?.Item
  if (value === undefined) {
    throw new Error('Expected one transaction Put item.')
  }
  return value
}

/**
 * Requires one optional value to be present.
 *
 * @param value - Candidate optional value.
 * @param message - Stable test failure text.
 * @returns Present value.
 */
function requireValue<Value>(
  value: Value | undefined,
  message: string,
): Value {
  if (value === undefined) throw new Error(message)
  return value
}

/**
 * Computes one stable fixture digest from text.
 *
 * @param value - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes one SHA-256 digest from exact bytes.
 *
 * @param value - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
