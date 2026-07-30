import { createHash } from 'node:crypto'
import {
  GetItemCommand,
  TransactionCanceledException,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
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
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import type {
  WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  WorkspaceSearchMigrationApplyReceiptAwsBinding,
  WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
} from './migration-apply-receipt-aws'
import {
  createWorkspaceSearchMigrationCommittedPrefixApplySeal,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  WorkspaceSearchMigrationFailure,
  type EncodedMigrationItemSnapshot,
  type MigrationKeyAttribute,
  type MigrationItemSnapshot,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  createWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionStateV2,
} from './migration-execution-state'
import {
  createAbsentMigrationItemDigest,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import {
  createAwsWorkspaceSearchMigrationPartialRollbackOperationPort,
  type WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding,
  type WorkspaceSearchMigrationPartialRollbackOperationAwsTransport,
  workspaceSearchMigrationPartialRollbackFinishTransactionIndex,
  workspaceSearchMigrationPartialRollbackOperationTransactionIndex,
} from './migration-partial-rollback-operation-aws'
import type {
  WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
} from './migration-partial-rollback-start-aws'
import {
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRolledBackRootV2RecordKey,
  createWorkspaceSearchMigrationRollbackStateV2RecordKey,
  createWorkspaceSearchMigrationRollbackStartRecordKey,
} from './migration-rollback-key'
import type {
  WorkspaceSearchMigrationRollbackAuthorityClaim,
  WorkspaceSearchMigrationRollbackOperationAuthorityReader,
} from './migration-rollback-operation-aws'
import {
  createWorkspaceSearchMigrationRollbackOperationTransitionV2,
  createWorkspaceSearchMigrationRollbackStartRootV2,
  serializeWorkspaceSearchMigrationRollbackOperationReceiptV2,
  serializeWorkspaceSearchMigrationRollbackPersistenceStateV2,
  serializeWorkspaceSearchMigrationRolledBackRootV2,
  type WorkspaceSearchMigrationRollbackOperationReceiptV2,
  type WorkspaceSearchMigrationRollbackPersistenceStateV2,
  type WorkspaceSearchMigrationRollbackStartRootV2,
  type WorkspaceSearchMigrationRolledBackRootV2,
} from './migration-rollback-persistence-v2'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
} from './migration-state-machine'

const runId = 'partial-rollback-operation-aws-test'
const ownerId = 'partial-rollback-operation-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const executionCreatedAt = '2026-07-29T01:19:30.000Z'
const startAuthorityEvaluatedAt = '2026-07-29T01:20:59.000Z'
const rollbackStartedAt = '2026-07-29T01:21:01.000Z'
const operationAuthorityEvaluatedAt =
  '2026-07-29T01:21:02.000Z'
const operationCommittedAt = '2026-07-29T01:21:03.000Z'
const finishAuthorityEvaluatedAt =
  '2026-07-29T01:21:04.000Z'
const finishCommittedAt = '2026-07-29T01:21:05.000Z'
const retainUntil = '2026-08-30T01:00:00.000Z'

/**
 * Correlated static and authority material for one v2 rollback test.
 */
type PartialRollbackOperationFixture = {
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
  /** Fresh authority consumed by the rollback start. */
  readonly startAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Fresh authority consumed by one reverse operation. */
  readonly operationAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Fresh authority consumed by terminal publication. */
  readonly finishAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * One mutation-bearing rollback start and its exact reverse evidence.
 */
type MutationRollbackFixture = {
  /** Static admitted run and authority material. */
  readonly fixture: PartialRollbackOperationFixture
  /** Strict immutable v2 rollback start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact durable forward apply receipt. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact immutable journal segment. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Exact post-apply target row. */
  readonly afterItem: Readonly<Record<string, AttributeValue>>
}

/**
 * Two forward mutations and both deterministic reverse transitions.
 */
type SequentialMutationRollbackFixture = {
  /** Static admitted run and authority material. */
  readonly fixture: PartialRollbackOperationFixture
  /** Strict immutable v2 rollback start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Final forward apply receipt selected by the first reverse call. */
  readonly finalApplyReceipt: WorkspaceSearchOperationReceipt
  /** Final immutable journal selected by the first reverse call. */
  readonly finalJournalSegment: WorkspaceSearchJournalSegment
  /** Exact post-apply target row after both forward mutations. */
  readonly finalAfterItem:
    Readonly<Record<string, AttributeValue>>
  /** Exact target row after only the first forward mutation. */
  readonly firstAfterItem:
    Readonly<Record<string, AttributeValue>>
  /** First forward apply receipt retained for substitution tests. */
  readonly firstApplyReceipt: WorkspaceSearchOperationReceipt
  /** First immutable journal retained for substitution tests. */
  readonly firstJournalSegment: WorkspaceSearchJournalSegment
  /** Deterministic first reverse transition for forward sequence two. */
  readonly firstReverse: ReturnType<
    typeof createWorkspaceSearchMigrationRollbackOperationTransitionV2
  >
  /** Legitimate later reverse transition for forward sequence one. */
  readonly laterReverse: ReturnType<
    typeof createWorkspaceSearchMigrationRollbackOperationTransitionV2
  >
}

/**
 * One forward mutation's immutable apply and journal evidence.
 */
type ForwardMutationEvidenceFixture = {
  /** Exact durable forward apply receipt. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Exact immutable journal preimage segment. */
  readonly journalSegment: WorkspaceSearchJournalSegment
}

/**
 * Three forward target shapes prepared for strict reverse-order execution.
 */
type ThreeMutationRollbackFixture = {
  /** Static admitted run and authority material. */
  readonly fixture: PartialRollbackOperationFixture
  /** Strict immutable v2 rollback start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Forward evidence ordered by sequence one through three. */
  readonly evidence:
    readonly [
      ForwardMutationEvidenceFixture,
      ForwardMutationEvidenceFixture,
      ForwardMutationEvidenceFixture,
    ]
  /** Exact common target key. */
  readonly targetKey:
    Readonly<Record<string, AttributeValue>>
  /** Exact target value created by forward sequence one. */
  readonly firstItem:
    Readonly<Record<string, AttributeValue>>
  /** Exact target value installed by forward sequence two. */
  readonly secondItem:
    Readonly<Record<string, AttributeValue>>
}

/**
 * Input for one compact immutable forward mutation fixture.
 */
type CreateForwardMutationEvidenceInput = {
  /** Exact admitted static fixture. */
  readonly fixture: PartialRollbackOperationFixture
  /** Complete applying state immediately before this mutation. */
  readonly currentState: WorkspaceSearchMigrationRunState
  /** Positive contiguous apply and plan sequence. */
  readonly sequence: number
  /** Exact planned-operation digest at this sequence. */
  readonly planOperationDigest: string
  /** Exact common physical target key. */
  readonly targetKey:
    Readonly<Record<string, AttributeValue>>
  /** Exact pre-mutation target snapshot. */
  readonly before: MigrationItemSnapshot
  /** Exact post-mutation target snapshot. */
  readonly after: MigrationItemSnapshot
  /** Hash-chain head immediately before this mutation. */
  readonly previousHeadDigest: string
  /** Canonical immutable journal creation time. */
  readonly createdAt: string
  /** Canonical forward transaction commit time. */
  readonly committedAt: string
}

/**
 * One explicit AWS transaction cancellation reason at a fixed item index.
 */
type CancellationReasonFixture = {
  /** Zero-based fixed transaction item position. */
  readonly index: number
  /** Exact AWS cancellation reason code. */
  readonly code: string
}

/**
 * In-memory lifecycle and low-level transport for v2 rollback progress.
 */
class PartialRollbackOperationHarness {
  /** Exact static fixture used by narrow capabilities. */
  private readonly fixture: PartialRollbackOperationFixture

  /** Current coherent rollback lifecycle. */
  private lifecycle:
    WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot

  /** Current target item, or undefined for physical absence. */
  private targetItem:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Immutable receipt rows by deterministic record key. */
  private readonly receiptItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Successor state selected while the next transaction is built. */
  private pendingState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2 | undefined

  /** Terminal root selected while the next finish transaction is built. */
  private pendingRoot:
    WorkspaceSearchMigrationRolledBackRootV2 | undefined

  /** Fresh authority returned by the authority reader. */
  authority: WorkspaceSearchMigrationPrePlanAuthority

  /** Exact apply receipts indexed by mutating journal sequence. */
  private readonly applyReceiptsBySequence =
    new Map<number, WorkspaceSearchOperationReceipt>()

  /** Exact apply receipts indexed by stable operation identifier. */
  private readonly applyReceiptsByOperationId =
    new Map<string, WorkspaceSearchOperationReceipt>()

  /** Test-only substituted sequence projections by requested sequence. */
  private readonly applySequenceSubstitutions =
    new Map<number, WorkspaceSearchOperationReceipt>()

  /** Test-only substituted marker projections by requested operation ID. */
  private readonly applyMarkerSubstitutions =
    new Map<string, WorkspaceSearchOperationReceipt>()

  /** Exact journals indexed by their immutable reference digest. */
  private readonly journalSegmentsByReferenceDigest =
    new Map<string, WorkspaceSearchJournalSegment>()

  /** Adapter-owned clock result. */
  clockTime = operationCommittedAt

  /** Optional raw transaction failure before effects are applied. */
  transactionErrorBeforeCommit: unknown

  /** Optional raw transaction failure after effects are applied. */
  transactionErrorAfterCommit: unknown

  /** Winner transition installed immediately before the next target response. */
  private winnerOnTargetRead:
    {
      /** Exact winner successor state. */
      readonly state:
        WorkspaceSearchMigrationRollbackPersistenceStateV2
      /** Exact winner immutable reverse receipt. */
      readonly receipt:
        WorkspaceSearchMigrationRollbackOperationReceiptV2
    } | undefined

  /** Optional exact lifecycle observations returned before the durable current state. */
  private lifecycleObservations:
    WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot[] = []

  /** Optional receipt-row visibility returned by successive strong reads. */
  private receiptVisibilityObservations: boolean[] = []

  /** Total lifecycle reads, including scripted observations. */
  private lifecycleReadCount = 0

  /** Winner installed only after a local reverse transaction commits. */
  private winnerAfterTransactionTargetRead:
    {
      /** Exact later successor state. */
      readonly state:
        WorkspaceSearchMigrationRollbackPersistenceStateV2
      /** Exact later immutable reverse receipt. */
      readonly receipt:
        WorkspaceSearchMigrationRollbackOperationReceiptV2
      /** Lifecycle-read count required before the delayed target response. */
      lifecycleReadThreshold?: number
    } | undefined

  /** Ordered attempted fixed transactions. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** Count of exact journal reads. */
  journalReads = 0

  /**
   * Creates one in-memory rollback harness.
   *
   * @param fixture - Exact static fixture.
   * @param startRoot - Exact immutable rollback start.
   * @param targetItem - Current post-apply target item when present.
   * @param applyReceipt - Exact forward apply receipt when present.
   * @param journalSegment - Exact immutable journal when present.
   */
  constructor(
    fixture: PartialRollbackOperationFixture,
    startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
    targetItem:
      Readonly<Record<string, AttributeValue>> | undefined,
    applyReceipt?: WorkspaceSearchOperationReceipt,
    journalSegment?: WorkspaceSearchJournalSegment,
  ) {
    this.fixture = fixture
    this.lifecycle = {
      startRoot: structuredClone(startRoot),
      state: structuredClone(startRoot.initialState),
    }
    this.targetItem = targetItem === undefined
      ? undefined
      : structuredClone(targetItem)
    if (applyReceipt !== undefined && journalSegment !== undefined) {
      this.addApplyEvidence(applyReceipt, journalSegment)
    }
    this.authority = fixture.operationAuthority
  }

  /** Fresh current-authority reader. */
  readonly authorityPort:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader = {
      readAuthority: async (
        claim: WorkspaceSearchMigrationRollbackAuthorityClaim,
      ): Promise<WorkspaceSearchMigrationPrePlanAuthority> => {
        expect(claim).toEqual(createAuthorityClaim(this.authority))
        return structuredClone(this.authority)
      },
    }

  /** Shared lifecycle reader and exact transaction-item factory. */
  readonly lifecycleBinding:
    WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding = {
      readBindingIdentity: () => {
        const stateTable =
          this.fixture.configuration.tables['migration-state']
        const bindingDigest =
          createWorkspaceSearchMigrationRollbackConflictRecordKeys({
            stateTableId: stateTable.tableId,
            configurationHash: this.fixture.configurationHash,
            runId: this.fixture.executionRun.runId,
            executionRunDigest:
              this.fixture.executionRun.executionRunDigest,
          }).bindingDigest
        return Object.freeze({
          stateTableId: stateTable.tableId,
          configurationHash: this.fixture.configurationHash,
          runId: this.fixture.executionRun.runId,
          executionRunDigest:
            this.fixture.executionRun.executionRunDigest,
          bindingDigest,
        })
      },
      readRollbackLifecycle: async () => {
        this.lifecycleReadCount += 1
        const observation = this.lifecycleObservations.shift()
        return structuredClone(observation ?? this.lifecycle)
      },
      createStartRootConditionCheck: (startRoot) => {
        expect(startRoot).toEqual(this.lifecycle.startRoot)
        const identity = this.lifecycleBinding.readBindingIdentity()
        return {
          ConditionCheck: {
            TableName:
              this.fixture.configuration.tables['migration-state']
                .tableName,
            Key: createStateKey(
              createWorkspaceSearchMigrationRollbackStartRecordKey(
                identity.bindingDigest,
              ),
            ),
            ConditionExpression: '#digest = :digest',
            ExpressionAttributeNames: {
              '#digest': 'startRootDigest',
            },
            ExpressionAttributeValues: {
              ':digest': { S: startRoot.startRootDigest },
            },
          },
        }
      },
      createRollbackStateTransitionPut: (
        predecessor,
        successor,
      ) => {
        expect(predecessor).toEqual(this.lifecycle.state)
        this.pendingState = structuredClone(successor)
        const identity = this.lifecycleBinding.readBindingIdentity()
        return {
          Put: {
            TableName:
              this.fixture.configuration.tables['migration-state']
                .tableName,
            Item: {
              ...createStateKey(
                createWorkspaceSearchMigrationRollbackStateV2RecordKey(
                  identity.bindingDigest,
                ),
              ),
              stateDigest: { S: successor.stateDigest },
              stateBytes: {
                B: serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
                  successor,
                ),
              },
            },
            ConditionExpression: '#digest = :digest',
            ExpressionAttributeNames: {
              '#digest': 'stateDigest',
            },
            ExpressionAttributeValues: {
              ':digest': { S: predecessor.stateDigest },
            },
          },
        }
      },
      createRolledBackRootAbsentPut: (root) => {
        this.pendingRoot = structuredClone(root)
        const identity = this.lifecycleBinding.readBindingIdentity()
        return {
          Put: {
            TableName:
              this.fixture.configuration.tables['migration-state']
                .tableName,
            Item: {
              ...createStateKey(
                createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
                  identity.bindingDigest,
                ),
              ),
              rootDigest: { S: root.rootDigest },
              rootBytes: {
                B: serializeWorkspaceSearchMigrationRolledBackRootV2(
                  root,
                ),
              },
            },
            ConditionExpression:
              'attribute_not_exists(#recordKey)',
            ExpressionAttributeNames: {
              '#recordKey': 'recordKey',
            },
          },
        }
      },
    }

  /** Fake exact apply receipt read, correlation, and guard binding. */
  readonly applyReceiptBinding:
    WorkspaceSearchMigrationApplyReceiptAwsBinding = {
      readBindingIdentity: () => {
        const stateTable =
          this.fixture.configuration.tables['migration-state']
        return Object.freeze({
          stateTableId: stateTable.tableId,
          configurationHash: this.fixture.configurationHash,
          runId: this.fixture.executionRun.runId,
          executionRunDigest:
            this.fixture.executionRun.executionRunDigest,
          bindingDigest:
            createWorkspaceSearchMigrationApplyRunBindingDigest({
              stateTable,
              configurationHash: this.fixture.configurationHash,
              executionRun: this.fixture.executionRun,
            }),
        })
      },
      createJournalSequenceStrongReadCommand: (sequence) =>
        createFakeStrongRead(`apply-sequence/${sequence}`),
      parseJournalSequenceStrongReadOutput: (sequence) => {
        const receipt =
          this.applySequenceSubstitutions.get(sequence) ??
          this.applyReceiptsBySequence.get(sequence)
        if (receipt === undefined) return undefined
        return createApplySequenceProjection(receipt)
      },
      createOperationMarkerStrongReadCommand: (operationId) =>
        createFakeStrongRead(`apply-marker/${operationId}`),
      parseOperationMarkerStrongReadOutput: (operationId) => {
        const receipt =
          this.applyMarkerSubstitutions.get(operationId) ??
          this.applyReceiptsByOperationId.get(operationId)
        if (receipt === undefined) return undefined
        return createApplyMarkerProjection(receipt)
      },
      correlateRows: (sequence, marker) => {
        if (
          createMigrationDigest(marker.receipt) !==
            createMigrationDigest(sequence.receipt)
        ) {
          throw new WorkspaceSearchMigrationFailure(
            'INVALID_STATE',
            'Test apply rows do not identify one commit.',
          )
        }
        return structuredClone(sequence)
      },
      createJournalSequenceConditionCheck: (projection) =>
        createFakeConditionCheck(
          `apply-sequence/${projection.receipt.sequence}`,
        ),
      createOperationMarkerConditionCheck: (projection) =>
        createFakeConditionCheck(
          `apply-marker/${projection.receipt.operationId}`,
        ),
    }

  /** Fake exact-version immutable journal gateway. */
  readonly journalGateway:
    WorkspaceSearchMigrationJournalAwsGateway = {
      writeJournalSegment: async () => {
        throw new Error('Unexpected journal write.')
      },
      readJournalSegment: async (
        reference: WorkspaceSearchJournalReference,
      ): Promise<WorkspaceSearchJournalSegment> => {
        this.journalReads += 1
        const segment =
          this.journalSegmentsByReferenceDigest.get(
            createMigrationDigest(reference),
          )
        if (segment === undefined) {
          throw new Error('Missing journal fixture.')
        }
        return structuredClone(segment)
      },
    }

  /** In-memory low-level read and transaction transport. */
  readonly transport:
    WorkspaceSearchMigrationPartialRollbackOperationAwsTransport = {
      getPartialRollbackOperationItem: async (
        command: GetItemCommand,
      ): Promise<GetItemCommandOutput> => {
        expect(command.input.ConsistentRead).toBe(true)
        if (
          command.input.TableName ===
            this.fixture.configuration.tables['workspace-search']
              .tableName
        ) {
          const delayedWinner =
            this.winnerAfterTransactionTargetRead
          const lifecycleReadThreshold =
            delayedWinner?.lifecycleReadThreshold
          if (
            delayedWinner !== undefined &&
            lifecycleReadThreshold !== undefined
          ) {
            while (
              this.lifecycleReadCount < lifecycleReadThreshold
            ) {
              await Promise.resolve()
            }
            this.installWinner(
              delayedWinner.state,
              delayedWinner.receipt,
            )
            this.winnerAfterTransactionTargetRead = undefined
          }
          const winner = this.winnerOnTargetRead
          if (winner !== undefined) {
            this.installWinner(winner.state, winner.receipt)
            this.winnerOnTargetRead = undefined
          }
          return this.targetItem === undefined
            ? { $metadata: {} }
            : {
                $metadata: {},
                Item: structuredClone(this.targetItem),
              }
        }
        const recordKey = readCommandRecordKey(command)
        const visible =
          this.receiptVisibilityObservations.shift()
        const receipt = visible === false
          ? undefined
          : this.receiptItems.get(recordKey)
        return receipt === undefined
          ? { $metadata: {} }
          : {
              $metadata: {},
              Item: structuredClone(receipt),
            }
      },
      preparePartialRollbackOperationWrite:
        async (): Promise<void> => {},
      transactWritePartialRollbackOperation: async (
        command: TransactWriteItemsCommand,
      ): Promise<TransactWriteItemsCommandOutput> => {
        this.transactions.push(command)
        if (this.transactionErrorBeforeCommit !== undefined) {
          throw this.transactionErrorBeforeCommit
        }
        this.applyTransaction(command)
        if (this.transactionErrorAfterCommit !== undefined) {
          throw this.transactionErrorAfterCommit
        }
        return { $metadata: {} }
      },
    }

  /**
   * Returns the current adapter clock instant.
   *
   * @returns Fresh detached Date.
   */
  readonly clock = (): Date => new Date(this.clockTime)

  /**
   * Returns the current coherent lifecycle for assertions.
   *
   * @returns Detached current lifecycle.
   */
  readLifecycle():
    WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot {
    return structuredClone(this.lifecycle)
  }

  /**
   * Adds one immutable apply receipt and its exact journal version.
   *
   * @param receipt - Exact durable forward apply receipt.
   * @param journalSegment - Exact referenced immutable journal segment.
   */
  addApplyEvidence(
    receipt: WorkspaceSearchOperationReceipt,
    journalSegment: WorkspaceSearchJournalSegment,
  ): void {
    this.applyReceiptsBySequence.set(
      receipt.sequence,
      structuredClone(receipt),
    )
    this.applyReceiptsByOperationId.set(
      receipt.operationId,
      structuredClone(receipt),
    )
    this.journalSegmentsByReferenceDigest.set(
      createMigrationDigest(receipt.journal),
      structuredClone(journalSegment),
    )
  }

  /**
   * Substitutes one parsed apply sequence projection for an integrity test.
   *
   * @param requestedSequence - Sequence key requested by the adapter.
   * @param receipt - Different strict receipt returned by the fake parser.
   */
  substituteApplySequence(
    requestedSequence: number,
    receipt: WorkspaceSearchOperationReceipt,
  ): void {
    this.applySequenceSubstitutions.set(
      requestedSequence,
      structuredClone(receipt),
    )
  }

  /**
   * Substitutes one parsed apply marker projection for an integrity test.
   *
   * @param requestedOperationId - Marker key requested by the adapter.
   * @param receipt - Different strict receipt returned by the fake parser.
   */
  substituteApplyMarker(
    requestedOperationId: string,
    receipt: WorkspaceSearchOperationReceipt,
  ): void {
    this.applyMarkerSubstitutions.set(
      requestedOperationId,
      structuredClone(receipt),
    )
  }

  /**
   * Deletes one immutable receipt to simulate durable corruption.
   *
   * @param sequence - Exact receipt sequence to delete.
   */
  deleteReceipt(sequence: number): void {
    const identity = this.lifecycleBinding.readBindingIdentity()
    this.receiptItems.delete(
      `rollback-receipt/v2/${identity.bindingDigest}/${sequence}`,
    )
  }

  /**
   * Installs a logical transaction winner before the next target read returns.
   *
   * @param state - Exact committed successor state.
   * @param receipt - Exact committed immutable receipt.
   */
  winBeforeNextTargetRead(
    state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): void {
    this.winnerOnTargetRead = {
      state: structuredClone(state),
      receipt: structuredClone(receipt),
    }
  }

  /**
   * Installs one precomputed durable winner immediately.
   *
   * @param state - Exact committed successor state.
   * @param receipt - Exact committed immutable receipt.
   */
  installCommittedWinner(
    state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): void {
    this.installWinner(state, receipt)
  }

  /**
   * Replaces one deterministic receipt row with another strict receipt.
   *
   * @param receipt - Exact independently valid replacement receipt.
   */
  replaceReceipt(
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): void {
    const item = createRollbackReceiptRecord(
      this.fixture,
      receipt,
    )
    this.receiptItems.set(
      readRawItemRecordKey(item),
      item,
    )
  }

  /**
   * Schedules a legitimate later reverse transition during reconciliation.
   *
   * The target response is held until the concurrent receipt/lifecycle read
   * has stabilized the immediately committed successor.
   *
   * @param state - Exact later committed successor state.
   * @param receipt - Exact later immutable reverse receipt.
   */
  winAfterTransactionBeforeTargetResponse(
    state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): void {
    this.winnerAfterTransactionTargetRead = {
      state: structuredClone(state),
      receipt: structuredClone(receipt),
    }
  }

  /**
   * Queues exact lifecycle observations before normal current reads resume.
   *
   * @param observations - Ordered detached lifecycle snapshots.
   */
  setLifecycleObservations(
    observations:
      readonly WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot[],
  ): void {
    this.lifecycleObservations = observations.map((value) =>
      structuredClone(value)
    )
  }

  /**
   * Queues receipt visibility for successive strong receipt reads.
   *
   * @param observations - True for visible and false for temporarily absent.
   */
  setReceiptVisibilityObservations(
    observations: readonly boolean[],
  ): void {
    this.receiptVisibilityObservations = [...observations]
  }

  /**
   * Applies a precomputed winner without recording a local transaction.
   *
   * @param state - Exact committed successor state.
   * @param receipt - Exact committed immutable receipt.
   */
  private installWinner(
    state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): void {
    this.targetItem = undefined
    this.lifecycle = {
      startRoot: structuredClone(this.lifecycle.startRoot),
      state: structuredClone(state),
    }
    const item = createRollbackReceiptRecord(
      this.fixture,
      receipt,
    )
    this.receiptItems.set(
      readRawItemRecordKey(item),
      item,
    )
  }

  /**
   * Applies the transaction's target, state, receipt, and root effects.
   *
   * @param command - Exact fixed-order transaction.
   */
  private applyTransaction(
    command: TransactWriteItemsCommand,
  ): void {
    const items = requireTransactionItems(command)
    if (
      items.length ===
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .count
    ) {
      const target = items[
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .target
      ]
      if (target?.Delete !== undefined) {
        this.targetItem = undefined
      } else if (target?.Put?.Item !== undefined) {
        this.targetItem = structuredClone(target.Put.Item)
      } else {
        throw new Error('Expected one target restoration.')
      }
      const receiptItem = requirePutItem(
        requireValue(
          items[
            workspaceSearchMigrationPartialRollbackOperationTransactionIndex
              .rollbackReceipt
          ],
          'Expected rollback receipt transaction item.',
        ),
      )
      this.receiptItems.set(
        readRawItemRecordKey(receiptItem),
        structuredClone(receiptItem),
      )
      const delayedWinner =
        this.winnerAfterTransactionTargetRead
      if (delayedWinner !== undefined) {
        delayedWinner.lifecycleReadThreshold =
          this.lifecycleReadCount + 2
      }
    }
    const pendingState = this.pendingState
    if (pendingState === undefined) {
      throw new Error('Expected one pending rollback state.')
    }
    this.lifecycle = this.pendingRoot === undefined
      ? {
          startRoot: structuredClone(this.lifecycle.startRoot),
          state: structuredClone(pendingState),
        }
      : {
          startRoot: structuredClone(this.lifecycle.startRoot),
          state: structuredClone(pendingState),
          rolledBackRoot: structuredClone(this.pendingRoot),
        }
    this.pendingState = undefined
    this.pendingRoot = undefined
  }
}

/**
 * Creates one v2 rollback operation port from the shared harness.
 *
 * @param fixture - Exact static fixture.
 * @param harness - Narrow in-memory dependencies.
 * @returns Ready reverse and finish port.
 */
function createPort(
  fixture: PartialRollbackOperationFixture,
  harness: PartialRollbackOperationHarness,
) {
  return createAwsWorkspaceSearchMigrationPartialRollbackOperationPort({
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    closedWriterFenceRecord: fixture.closedWriterFenceRecord,
    executionRun: fixture.executionRun,
    authorityPort: harness.authorityPort,
    lifecycleBinding: harness.lifecycleBinding,
    journalGateway: harness.journalGateway,
    applyReceiptBinding: harness.applyReceiptBinding,
    transport: harness.transport,
    clock: harness.clock,
  })
}

/**
 * Creates one immutable v2 rollback start with no committed mutations.
 *
 * @param fixture - Exact admitted zero-operation fixture.
 * @returns Strict immutable rollback start.
 */
function createZeroMutationStartRoot(
  fixture: PartialRollbackOperationFixture,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.executionRun,
      predecessor: { kind: 'execution-run-admission' },
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      createdAt: rollbackStartedAt,
    })
  const reference = createSealReference(seal)
  return createWorkspaceSearchMigrationRollbackStartRootV2({
    admission: fixture.executionRun,
    predecessor: { kind: 'execution-run-admission' },
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    seal,
    sealReference: reference,
    currentAuthority: fixture.startAuthority,
    startedAt: rollbackStartedAt,
  })
}

/**
 * Creates one mutation-bearing rollback start and exact reverse evidence.
 *
 * @returns Strict admitted fixture, start root, receipt, journal, and target.
 */
function createMutationRollbackFixture(): MutationRollbackFixture {
  const fixture = createFixture(1)
  const predecessor = createMutableV2Predecessor(fixture)
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor.state,
      },
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      createdAt: rollbackStartedAt,
    })
  const startRoot =
    createWorkspaceSearchMigrationRollbackStartRootV2({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor.state,
      },
      sealedPlanningAuthority:
        fixture.sealedPlanningAuthority,
      seal,
      sealReference: createSealReference(seal),
      currentAuthority: fixture.startAuthority,
      startedAt: rollbackStartedAt,
    })
  return {
    fixture,
    startRoot,
    applyReceipt: predecessor.receipt,
    journalSegment: predecessor.journalSegment,
    afterItem: predecessor.afterItem,
  }
}

/**
 * Creates two same-target mutations and both legitimate reverse transitions.
 *
 * @returns Exact two-mutation rollback fixture for reconciliation races.
 */
function createSequentialMutationRollbackFixture():
  SequentialMutationRollbackFixture {
  const fixture = createFixture(2)
  const current = fixture.executionRun.runState
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey(
        'document',
        'document-1',
      ),
    },
  }
  const firstAfterItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: 'document-1' },
    title: { S: 'First committed prefix document' },
  }
  const finalAfterItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: 'document-1' },
    title: { S: 'Second committed prefix document' },
  }
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const absentDigest = createAbsentMigrationItemDigest()
  const firstAfterDigest =
    createAttributeMapDigest(firstAfterItem)
  const finalAfterDigest =
    createAttributeMapDigest(finalAfterItem)
  const firstOperationId = digest('partial-operation-first')
  const firstSourceDigest =
    digest('partial-operation-first-source')
  const firstJournalSegment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    sequence: 1,
    preparedFenceToken:
      current.maintenanceEvidenceReceipt.fenceToken,
    operationId: firstOperationId,
    sourceDigest: firstSourceDigest,
    previousHeadDigest: current.journalHeadDigest,
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest,
    before: {
      exists: false,
      digest: absentDigest,
    },
    after: {
      exists: true,
      item: encodeAttributeMap(firstAfterItem),
      digest: firstAfterDigest,
    },
    createdAt: '2026-07-29T01:19:30.500Z',
  }
  const firstJournalText =
    serializeWorkspaceSearchJournalSegment(firstJournalSegment)
  const firstContentDigest = createHash('sha256')
    .update(firstJournalText, 'utf8')
    .digest('hex')
  const firstVersionId =
    'partial-operation-first-journal-version'
  const firstJournalHeadDigest = createJournalHeadDigest({
    previousHeadDigest: current.journalHeadDigest,
    sequence: 1,
    operationId: firstOperationId,
    contentDigest: firstContentDigest,
    versionId: firstVersionId,
  })
  const firstApplyReceipt: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: fixture.configurationHash,
    operationId: firstOperationId,
    planSequence: 1,
    planOperationDigest: createSinglePlanOperationDigest(),
    sequence: 1,
    targetKeyDigest,
    sourceDigest: firstSourceDigest,
    beforeDigest: absentDigest,
    afterDigest: firstAfterDigest,
    fenceToken: current.maintenanceEvidenceReceipt.fenceToken,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(current.maintenanceEvidenceReceipt),
    journal: {
      objectKey:
        `workspace-search/v1/runs/${runId}/apply-journal-segments/` +
        `${firstContentDigest}.artifact`,
      versionId: firstVersionId,
      contentDigest: firstContentDigest,
      byteLength:
        new TextEncoder().encode(firstJournalText).byteLength,
      retainUntil,
      headDigest: firstJournalHeadDigest,
    },
    committedAt: '2026-07-29T01:19:31.000Z',
  }
  const firstMarkerAccumulator =
    MigrationDigestAccumulator.fromState(
      current.applyMarkerDigestState,
    )
  firstMarkerAccumulator.add(
    createMigrationDigest(firstApplyReceipt),
  )
  const firstRunState = {
    ...structuredClone(current),
    revision: current.revision + 1,
    appliedOperationCount: current.appliedOperationCount + 1,
    applyMarkerDigestState:
      firstMarkerAccumulator.exportState(),
    journalSequence: 1,
    journalHeadDigest: firstJournalHeadDigest,
    updatedAt: firstApplyReceipt.committedAt,
  }
  const firstExecutionState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      marker: firstApplyReceipt,
      nextRunState: firstRunState,
    })

  const secondOperationId = digest('partial-operation-second')
  const secondSourceDigest =
    digest('partial-operation-second-source')
  const secondJournalSegment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    sequence: 2,
    preparedFenceToken:
      current.maintenanceEvidenceReceipt.fenceToken,
    operationId: secondOperationId,
    sourceDigest: secondSourceDigest,
    previousHeadDigest: firstJournalHeadDigest,
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest,
    before: {
      exists: true,
      item: encodeAttributeMap(firstAfterItem),
      digest: firstAfterDigest,
    },
    after: {
      exists: true,
      item: encodeAttributeMap(finalAfterItem),
      digest: finalAfterDigest,
    },
    createdAt: '2026-07-29T01:19:31.500Z',
  }
  const secondJournalText =
    serializeWorkspaceSearchJournalSegment(secondJournalSegment)
  const secondContentDigest = createHash('sha256')
    .update(secondJournalText, 'utf8')
    .digest('hex')
  const secondVersionId =
    'partial-operation-second-journal-version'
  const secondJournalHeadDigest = createJournalHeadDigest({
    previousHeadDigest: firstJournalHeadDigest,
    sequence: 2,
    operationId: secondOperationId,
    contentDigest: secondContentDigest,
    versionId: secondVersionId,
  })
  const secondApplyReceipt: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: fixture.configurationHash,
    operationId: secondOperationId,
    planSequence: 2,
    planOperationDigest: createSecondPlanOperationDigest(),
    sequence: 2,
    targetKeyDigest,
    sourceDigest: secondSourceDigest,
    beforeDigest: firstAfterDigest,
    afterDigest: finalAfterDigest,
    fenceToken: current.maintenanceEvidenceReceipt.fenceToken,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(current.maintenanceEvidenceReceipt),
    journal: {
      objectKey:
        `workspace-search/v1/runs/${runId}/apply-journal-segments/` +
        `${secondContentDigest}.artifact`,
      versionId: secondVersionId,
      contentDigest: secondContentDigest,
      byteLength:
        new TextEncoder().encode(secondJournalText).byteLength,
      retainUntil,
      headDigest: secondJournalHeadDigest,
    },
    committedAt: '2026-07-29T01:19:32.000Z',
  }
  const secondMarkerAccumulator =
    MigrationDigestAccumulator.fromState(
      firstRunState.applyMarkerDigestState,
    )
  secondMarkerAccumulator.add(
    createMigrationDigest(secondApplyReceipt),
  )
  const secondRunState = {
    ...structuredClone(firstRunState),
    revision: firstRunState.revision + 1,
    appliedOperationCount:
      firstRunState.appliedOperationCount + 1,
    applyMarkerDigestState:
      secondMarkerAccumulator.exportState(),
    journalSequence: 2,
    journalHeadDigest: secondJournalHeadDigest,
    updatedAt: secondApplyReceipt.committedAt,
  }
  const secondExecutionState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      predecessor: firstExecutionState,
      marker: secondApplyReceipt,
      nextRunState: secondRunState,
    })
  const previousCheckpoint =
    current.apply.sources['project-directory']
  const predecessor =
    createWorkspaceSearchMigrationCheckpointExecutionState({
      admission: fixture.executionRun,
      predecessor: secondExecutionState,
      authority: {
        lease: structuredClone(fixture.startAuthority.lease),
        ownerId: fixture.startAuthority.lease.ownerId,
        at: startAuthorityEvaluatedAt,
      },
      location: 'project-directory',
      checkpoint:
        createTerminalEmptyCheckpoint(previousCheckpoint),
    })
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor,
      },
      sealedPlanningAuthority:
        fixture.sealedPlanningAuthority,
      createdAt: rollbackStartedAt,
    })
  const startRoot =
    createWorkspaceSearchMigrationRollbackStartRootV2({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor,
      },
      sealedPlanningAuthority:
        fixture.sealedPlanningAuthority,
      seal,
      sealReference: createSealReference(seal),
      currentAuthority: fixture.startAuthority,
      startedAt: rollbackStartedAt,
    })
  const firstReverse =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot,
      predecessorState: startRoot.initialState,
      currentAuthority: fixture.operationAuthority,
      applyReceipt: secondApplyReceipt,
      journalSegment: secondJournalSegment,
      committedAt: operationCommittedAt,
    })
  const laterReverse =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot,
      predecessorState: firstReverse.state,
      currentAuthority: fixture.operationAuthority,
      applyReceipt: firstApplyReceipt,
      journalSegment: firstJournalSegment,
      committedAt: '2026-07-29T01:21:03.500Z',
    })
  return {
    fixture,
    startRoot,
    finalApplyReceipt: secondApplyReceipt,
    finalJournalSegment: secondJournalSegment,
    finalAfterItem,
    firstAfterItem,
    firstApplyReceipt,
    firstJournalSegment,
    firstReverse,
    laterReverse,
  }
}

/**
 * Creates a create/replace/delete forward chain for three reverse shapes.
 *
 * @returns Exact three-mutation start root and immutable evidence.
 */
function createThreeMutationRollbackFixture():
  ThreeMutationRollbackFixture {
  const fixture = createFixture(3)
  const initialState = fixture.executionRun.runState
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey(
        'document',
        'document-1',
      ),
    },
  }
  const firstItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: 'document-1' },
    title: { S: 'Created value' },
  }
  const secondItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: 'document-1' },
    title: { S: 'Replaced value' },
  }
  const absent: MigrationItemSnapshot = {
    exists: false,
    digest: createAbsentMigrationItemDigest(),
  }
  const firstPresent: MigrationItemSnapshot = {
    exists: true,
    item: firstItem,
    digest: createAttributeMapDigest(firstItem),
  }
  const secondPresent: MigrationItemSnapshot = {
    exists: true,
    item: secondItem,
    digest: createAttributeMapDigest(secondItem),
  }
  const firstEvidence = createForwardMutationEvidence({
    fixture,
    currentState: initialState,
    sequence: 1,
    planOperationDigest: createSinglePlanOperationDigest(),
    targetKey,
    before: absent,
    after: firstPresent,
    previousHeadDigest: initialState.journalHeadDigest,
    createdAt: '2026-07-29T01:19:30.500Z',
    committedAt: '2026-07-29T01:19:31.000Z',
  })
  const firstRunState =
    createForwardMutationRunState(
      initialState,
      firstEvidence.receipt,
    )
  const firstExecutionState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      marker: firstEvidence.receipt,
      nextRunState: firstRunState,
    })
  const secondEvidence = createForwardMutationEvidence({
    fixture,
    currentState: firstRunState,
    sequence: 2,
    planOperationDigest:
      createSecondPlanOperationDigest(),
    targetKey,
    before: firstPresent,
    after: secondPresent,
    previousHeadDigest:
      firstEvidence.receipt.journal.headDigest,
    createdAt: '2026-07-29T01:19:31.500Z',
    committedAt: '2026-07-29T01:19:32.000Z',
  })
  const secondRunState =
    createForwardMutationRunState(
      firstRunState,
      secondEvidence.receipt,
    )
  const secondExecutionState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      predecessor: firstExecutionState,
      marker: secondEvidence.receipt,
      nextRunState: secondRunState,
    })
  const thirdEvidence = createForwardMutationEvidence({
    fixture,
    currentState: secondRunState,
    sequence: 3,
    planOperationDigest: createThirdPlanOperationDigest(),
    targetKey,
    before: secondPresent,
    after: absent,
    previousHeadDigest:
      secondEvidence.receipt.journal.headDigest,
    createdAt: '2026-07-29T01:19:32.500Z',
    committedAt: '2026-07-29T01:19:33.000Z',
  })
  const thirdRunState =
    createForwardMutationRunState(
      secondRunState,
      thirdEvidence.receipt,
    )
  const thirdExecutionState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      predecessor: secondExecutionState,
      marker: thirdEvidence.receipt,
      nextRunState: thirdRunState,
    })
  const previousCheckpoint =
    initialState.apply.sources['project-directory']
  const predecessor =
    createWorkspaceSearchMigrationCheckpointExecutionState({
      admission: fixture.executionRun,
      predecessor: thirdExecutionState,
      authority: {
        lease: structuredClone(fixture.startAuthority.lease),
        ownerId: fixture.startAuthority.lease.ownerId,
        at: startAuthorityEvaluatedAt,
      },
      location: 'project-directory',
      checkpoint:
        createTerminalEmptyCheckpoint(previousCheckpoint),
    })
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor,
      },
      sealedPlanningAuthority:
        fixture.sealedPlanningAuthority,
      createdAt: rollbackStartedAt,
    })
  const startRoot =
    createWorkspaceSearchMigrationRollbackStartRootV2({
      admission: fixture.executionRun,
      predecessor: {
        kind: 'mutable-execution-state',
        executionState: predecessor,
      },
      sealedPlanningAuthority:
        fixture.sealedPlanningAuthority,
      seal,
      sealReference: createSealReference(seal),
      currentAuthority: fixture.startAuthority,
      startedAt: rollbackStartedAt,
    })
  return {
    fixture,
    startRoot,
    evidence: [
      firstEvidence,
      secondEvidence,
      thirdEvidence,
    ],
    targetKey,
    firstItem,
    secondItem,
  }
}

/**
 * Creates one immutable forward receipt and exact preimage journal.
 *
 * @param input - Complete mutation position, snapshots, and chain head.
 * @returns Exact durable apply and journal evidence.
 */
function createForwardMutationEvidence(
  input: CreateForwardMutationEvidenceInput,
): ForwardMutationEvidenceFixture {
  const operationId =
    digest(`three-shape-operation-${input.sequence}`)
  const sourceDigest =
    digest(`three-shape-source-${input.sequence}`)
  const targetKeyDigest =
    createAttributeMapDigest(input.targetKey)
  const journalSegment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: input.fixture.configurationHash,
    sequence: input.sequence,
    preparedFenceToken:
      input.currentState.maintenanceEvidenceReceipt.fenceToken,
    operationId,
    sourceDigest,
    previousHeadDigest: input.previousHeadDigest,
    targetKey: encodeAttributeMap(input.targetKey),
    targetKeyDigest,
    before: encodeFixtureSnapshot(input.before),
    after: encodeFixtureSnapshot(input.after),
    createdAt: input.createdAt,
  }
  const journalText =
    serializeWorkspaceSearchJournalSegment(journalSegment)
  const contentDigest = createHash('sha256')
    .update(journalText, 'utf8')
    .digest('hex')
  const versionId =
    `three-shape-journal-version-${input.sequence}`
  const journalHeadDigest = createJournalHeadDigest({
    previousHeadDigest: input.previousHeadDigest,
    sequence: input.sequence,
    operationId,
    contentDigest,
    versionId,
  })
  const receipt: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: input.fixture.configurationHash,
    operationId,
    planSequence: input.sequence,
    planOperationDigest: input.planOperationDigest,
    sequence: input.sequence,
    targetKeyDigest,
    sourceDigest,
    beforeDigest: input.before.digest,
    afterDigest: input.after.digest,
    fenceToken:
      input.currentState.maintenanceEvidenceReceipt.fenceToken,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        input.currentState.maintenanceEvidenceReceipt,
      ),
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
    committedAt: input.committedAt,
  }
  return { receipt, journalSegment }
}

/**
 * Reduces one applying run state by one exact forward mutation marker.
 *
 * @param current - Complete applying predecessor.
 * @param receipt - Exact contiguous mutation marker.
 * @returns Complete expected applying successor.
 */
function createForwardMutationRunState(
  current: WorkspaceSearchMigrationRunState,
  receipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationRunState {
  const markerAccumulator = MigrationDigestAccumulator.fromState(
    current.applyMarkerDigestState,
  )
  markerAccumulator.add(createMigrationDigest(receipt))
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    appliedOperationCount: current.appliedOperationCount + 1,
    applyMarkerDigestState: markerAccumulator.exportState(),
    journalSequence: receipt.sequence,
    journalHeadDigest: receipt.journal.headDigest,
    updatedAt: receipt.committedAt,
  }
}

/**
 * Encodes one native target snapshot for immutable journal storage.
 *
 * @param snapshot - Exact native present or absent target state.
 * @returns Lossless JSON-safe target snapshot.
 */
function encodeFixtureSnapshot(
  snapshot: MigrationItemSnapshot,
): EncodedMigrationItemSnapshot {
  return snapshot.exists
    ? {
        exists: true,
        item: encodeAttributeMap(snapshot.item),
        digest: snapshot.digest,
      }
    : {
        exists: false,
        digest: snapshot.digest,
      }
}

/**
 * Creates one exact rich immutable seal reference.
 *
 * @param seal - Exact canonical committed-prefix seal.
 * @returns Exact retained content-addressed reference.
 */
function createSealReference(
  seal: ReturnType<
    typeof createWorkspaceSearchMigrationCommittedPrefixApplySeal
  >,
): WorkspaceSearchMigrationCommittedPrefixApplySealReference {
  const bytes =
    serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(seal)
  const contentDigest = createMigrationDigest(seal)
  return {
    scope: 'committed-prefix',
    objectKey:
      `workspace-search/v1/runs/${runId}/prefix-seals/` +
      `${contentDigest}.artifact`,
    versionId: 'partial-operation-seal-version',
    contentDigest,
    byteLength: bytes.byteLength,
    retainUntil,
  }
}

/**
 * Creates one fully correlated static rollback fixture.
 *
 * @param planOperationCount - Zero through three admitted plan operations.
 * @returns Exact measured roots and three monotonic authorities.
 */
function createFixture(
  planOperationCount: 0 | 1 | 2 | 3,
): PartialRollbackOperationFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const writerFence = createWriterFenceBinding(configuration)
  const maintenanceReceipt = createMaintenanceReceipt()
  const maintenanceReceiptDigest =
    createMigrationDigest(maintenanceReceipt)
  const open =
    createWorkspaceSearchWriterFenceInitialOpenRecord(
      writerFence,
      new Date(openedAt),
    )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      {
        configurationHash,
        runId,
        ownerId,
        leaseFenceToken: 7,
        maintenanceEvidenceReceiptDigest:
          digest('close-maintenance-receipt'),
        maintenanceEvidencePointerRevision: 11,
      },
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
  return {
    configuration,
    configurationHash,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    startAuthority: createCurrentAuthority(
      configuration,
      configurationHash,
      maintenanceReceipt,
      startAuthorityEvaluatedAt,
    ),
    operationAuthority: createCurrentAuthority(
      configuration,
      configurationHash,
      maintenanceReceipt,
      operationAuthorityEvaluatedAt,
    ),
    finishAuthority: createCurrentAuthority(
      configuration,
      configurationHash,
      maintenanceReceipt,
      finishAuthorityEvaluatedAt,
    ),
  }
}

/**
 * Journal-bearing mutable execution predecessor and reverse evidence.
 */
type MutableV2PredecessorFixture = {
  /** Strict traversal-capable mutable execution-state predecessor. */
  readonly state: WorkspaceSearchMigrationExecutionStateV2
  /** Exact durable apply receipt for the sole mutation. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Exact immutable preimage segment for the sole mutation. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Exact post-apply target row. */
  readonly afterItem: Readonly<Record<string, AttributeValue>>
}

/**
 * Creates one journal-bearing traversal-capable mutable predecessor.
 *
 * @param fixture - Exact admitted nonempty-plan fixture.
 * @returns Strict mutable predecessor and exact reverse evidence.
 */
function createMutableV2Predecessor(
  fixture: PartialRollbackOperationFixture,
): MutableV2PredecessorFixture {
  const current = fixture.executionRun.runState
  const operationId = digest('partial-operation')
  const sourceDigest = digest('partial-operation-source')
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
    title: { S: 'Committed prefix document' },
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
  const versionId = 'partial-operation-journal-version'
  const journalHeadDigest = createJournalHeadDigest({
    previousHeadDigest: current.journalHeadDigest,
    sequence: 1,
    operationId,
    contentDigest,
    versionId,
  })
  const receipt: WorkspaceSearchOperationReceipt = {
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
  markerAccumulator.add(createMigrationDigest(receipt))
  const mutationState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.executionRun,
      marker: receipt,
      nextRunState: {
        ...structuredClone(current),
        revision: current.revision + 1,
        appliedOperationCount:
          current.appliedOperationCount + 1,
        applyMarkerDigestState: markerAccumulator.exportState(),
        journalSequence: 1,
        journalHeadDigest,
        updatedAt: receipt.committedAt,
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
          lease: structuredClone(fixture.startAuthority.lease),
          ownerId: fixture.startAuthority.lease.ownerId,
          at: startAuthorityEvaluatedAt,
        },
        location: 'project-directory',
        checkpoint:
          createTerminalEmptyCheckpoint(previousCheckpoint),
      }),
    receipt,
    journalSegment,
    afterItem,
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
  return digest('partial-operation-plan-operation')
}

/**
 * Returns the hypothetical second operation digest sealed by this fixture.
 *
 * @returns Stable exact second planned-operation digest.
 */
function createSecondPlanOperationDigest(): string {
  return digest('partial-operation-second-plan-operation')
}

/**
 * Returns the hypothetical third operation digest sealed by this fixture.
 *
 * @returns Stable exact third planned-operation digest.
 */
function createThirdPlanOperationDigest(): string {
  return digest('partial-operation-third-plan-operation')
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
 * Creates one strict zero- through three-operation plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planOperationCount - Exact admitted operation count.
 * @returns Exact strict plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  planOperationCount: 0 | 1 | 2 | 3,
): WorkspaceSearchPlanSeal {
  const firstLeaf = createWorkspaceSearchPlanLeafDigest({
    planSequence: 1,
    operationDigest: createSinglePlanOperationDigest(),
  })
  const secondLeaf = createWorkspaceSearchPlanLeafDigest({
    planSequence: 2,
    operationDigest: createSecondPlanOperationDigest(),
  })
  const thirdLeaf = createWorkspaceSearchPlanLeafDigest({
    planSequence: 3,
    operationDigest: createThirdPlanOperationDigest(),
  })
  const twoLeafRoot =
    createWorkspaceSearchPlanNodeDigest(
      firstLeaf,
      secondLeaf,
    )
  const threeLeafRoot =
    createWorkspaceSearchPlanNodeDigest(
      twoLeafRoot,
      createWorkspaceSearchPlanNodeDigest(
        thirdLeaf,
        thirdLeaf,
      ),
    )
  const planDigest = planOperationCount === 0
    ? createEmptyWorkspaceSearchPlanDigest()
    : planOperationCount === 1
      ? firstLeaf
      : planOperationCount === 2
        ? twoLeafRoot
        : threeLeafRoot
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest,
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
        `workspace-search/v1/plan-artifacts/v1/plan-seals/` +
        `${planSealDigest}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `workspace-search/v1/plan-artifacts/v1/manifest-heads/` +
        `${planManifestDigest}.artifact`,
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
 * Creates one fake immutable apply sequence projection.
 *
 * @param receipt - Exact forward receipt.
 * @returns Strict structural sequence projection.
 */
function createApplySequenceProjection(
  receipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection {
  return {
    receipt: structuredClone(receipt),
    predecessorRevision: 1,
    successorRevision: 2,
    successorExecutionStateDigest:
      digest('successor-execution-state'),
    markerDigest: createMigrationDigest(receipt),
  }
}

/**
 * Creates one fake immutable apply marker projection.
 *
 * @param receipt - Exact forward receipt.
 * @returns Strict structural operation-marker projection.
 */
function createApplyMarkerProjection(
  receipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection {
  return {
    receipt: structuredClone(receipt),
    predecessorRevision: 1,
    successorRevision: 2,
    successorExecutionStateDigest:
      digest('successor-execution-state'),
    markerDigest: createMigrationDigest(receipt),
  }
}

/**
 * Creates the production v2 receipt envelope for a precomputed winner.
 *
 * @param fixture - Exact static rollback fixture.
 * @param receipt - Exact immutable reverse receipt.
 * @returns Complete low-level migration-state row.
 */
function createRollbackReceiptRecord(
  fixture: PartialRollbackOperationFixture,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): Readonly<Record<string, AttributeValue>> {
  const stateTable =
    fixture.configuration.tables['migration-state']
  const bindingDigest =
    createWorkspaceSearchMigrationRollbackConflictRecordKeys({
      stateTableId: stateTable.tableId,
      configurationHash: fixture.configurationHash,
      runId: fixture.executionRun.runId,
      executionRunDigest:
        fixture.executionRun.executionRunDigest,
    }).bindingDigest
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: `rollback-receipt/v2/${bindingDigest}/${receipt.sequence}`,
    },
    recordVersion: { N: '2' },
    kind: {
      S: 'workspace-search-migration-rollback-operation-receipt-record',
    },
    stateTableId: { S: stateTable.tableId },
    configurationHash: { S: fixture.configurationHash },
    runId: { S: fixture.executionRun.runId },
    executionRunDigest: {
      S: fixture.executionRun.executionRunDigest,
    },
    originDigest: { S: receipt.originDigest },
    startRootDigest: { S: receipt.startRootDigest },
    sequence: { N: String(receipt.sequence) },
    commandDigest: { S: receipt.commandDigest },
    receiptDigest: { S: receipt.receiptDigest },
    receiptBytes: {
      B: serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
        receipt,
      ),
    },
  }
}

/**
 * Creates one strongly consistent fake apply-owned read.
 *
 * @param recordKey - Stable fake row key.
 * @returns Adapter-shaped strong read command.
 */
function createFakeStrongRead(recordKey: string): GetItemCommand {
  return new GetItemCommand({
    TableName: 'table-migration-state',
    ConsistentRead: true,
    Key: createStateKey(recordKey),
  })
}

/**
 * Creates one fake apply-owned full-row condition.
 *
 * @param recordKey - Stable fake row key.
 * @returns Exact condition-only transaction item.
 */
function createFakeConditionCheck(
  recordKey: string,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: 'table-migration-state',
      Key: createStateKey(recordKey),
      ConditionExpression: 'attribute_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#recordKey': 'recordKey',
      },
    },
  }
}

/**
 * Creates a migration-state compound key.
 *
 * @param recordKey - Exact deterministic sort-key value.
 * @returns Detached low-level key.
 */
function createStateKey(
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
  }
}

/**
 * Creates one transaction cancellation with one selected reason.
 *
 * @param index - Fixed transaction item index.
 * @param code - AWS cancellation reason code.
 * @param count - Exact fixed transaction item count.
 * @returns Raw SDK transaction cancellation.
 */
function createCancellation(
  index: number,
  code: string,
  count: number,
): TransactionCanceledException {
  return createCancellationWithReasons(
    [{ index, code }],
    count,
  )
}

/**
 * Creates one transaction cancellation with multiple explicit reasons.
 *
 * @param reasons - Indexed cancellation reasons to install.
 * @param count - Exact fixed transaction item count.
 * @returns Raw SDK transaction cancellation.
 */
function createCancellationWithReasons(
  reasons: readonly CancellationReasonFixture[],
  count: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'test cancellation',
    $metadata: {},
    CancellationReasons: Array.from(
      { length: count },
      (_, reasonIndex) => {
        const selected = reasons.find(
          ({ index }) => index === reasonIndex,
        )
        return { Code: selected?.code ?? 'None' }
      },
    ),
  })
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
 * Reads one public migration failure code.
 *
 * @param error - Candidate rejected value.
 * @returns Stable migration failure code.
 */
function readFailureCode(
  error: unknown,
): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !Object.hasOwn(error, 'code')
  ) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
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

test('commits one reverse step as fixed thirteen items and recovers response loss', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  harness.transactionErrorAfterCommit =
    new Error('simulated reverse response loss')
  const initialPort = createPort(mutation.fixture, harness)
  const command = {
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  }

  const state =
    await initialPort.commitRollbackOperation(command)

  expect(state).toMatchObject({
    status: 'rolling-back',
    nextSequence: 0,
    restored: 1,
    revision:
      mutation.startRoot.initialState.revision + 1,
  })
  expect(harness.transactions).toHaveLength(1)
  const transaction = requireValue(
    harness.transactions[0],
    'Expected one reverse transaction.',
  )
  const items = requireTransactionItems(transaction)
  expect(items).toHaveLength(
    workspaceSearchMigrationPartialRollbackOperationTransactionIndex
      .count,
  )
  expect(
    items.map((item) =>
      item.ConditionCheck !== undefined
        ? 'ConditionCheck'
        : item.Delete !== undefined
          ? 'Delete'
          : 'Put'
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
    'Put',
    'ConditionCheck',
    'ConditionCheck',
    'Delete',
    'Put',
  ])
  expect(
    items[
      workspaceSearchMigrationPartialRollbackOperationTransactionIndex
        .rollbackReceipt
    ]?.Put?.Item?.recordKey?.S,
  ).toMatch(/^rollback-receipt\/v2\/[0-9a-f]{64}\/1$/u)
  const receipt = await initialPort.readRollbackReceipt(1)
  expect(receipt?.successorStateDigest).toBe(state.stateDigest)

  harness.transactionErrorAfterCommit = undefined
  const restartedPort = createPort(mutation.fixture, harness)
  expect(restartedPort).not.toBe(initialPort)
  const retried =
    await restartedPort.commitRollbackOperation(command)
  expect(retried).toEqual(state)
  expect(harness.transactions).toHaveLength(1)
  expect(harness.journalReads).toBe(1)

  harness.authority = mutation.fixture.finishAuthority
  harness.clockTime = finishCommittedAt
  const root = await restartedPort.finishRollback({
    expectedRevision: state.revision,
    authority:
      createAuthorityClaim(mutation.fixture.finishAuthority),
  })
  expect(root.terminalReceipt?.receiptDigest).toBe(
    receipt?.receiptDigest,
  )
  expect(root.terminalState.status).toBe('rolled-back')
  expect(harness.transactions).toHaveLength(2)
  expect(
    await restartedPort.commitRollbackOperation(command),
  ).toEqual(root.terminalState)
})

test('accepts a later same-target rollback during response reconciliation', async () => {
  const sequential = createSequentialMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    sequential.fixture,
    sequential.startRoot,
    sequential.finalAfterItem,
    sequential.finalApplyReceipt,
    sequential.finalJournalSegment,
  )
  harness.transactionErrorAfterCommit =
    new Error('simulated reverse response loss')
  harness.winAfterTransactionBeforeTargetResponse(
    sequential.laterReverse.state,
    sequential.laterReverse.receipt,
  )
  const port = createPort(sequential.fixture, harness)

  const state = await port.commitRollbackOperation({
    expectedRevision:
      sequential.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(
        sequential.fixture.operationAuthority,
      ),
  })

  expect(state).toEqual(sequential.laterReverse.state)
  expect(harness.transactions).toHaveLength(1)
  expect(
    (await port.readRollbackReceipt(2))?.receiptDigest,
  ).toBe(sequential.firstReverse.receipt.receiptDigest)
  expect(
    (await port.readRollbackReceipt(1))?.receiptDigest,
  ).toBe(sequential.laterReverse.receipt.receiptDigest)
})

test('restores create, replace, and delete shapes in strict reverse order', async () => {
  const mutation = createThreeMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    undefined,
  )
  for (const evidence of mutation.evidence) {
    harness.addApplyEvidence(
      evidence.receipt,
      evidence.journalSegment,
    )
  }
  const port = createPort(mutation.fixture, harness)
  const commitTimes = [
    operationCommittedAt,
    '2026-07-29T01:21:03.250Z',
    '2026-07-29T01:21:03.500Z',
  ]
  const expectedSequences = [3, 2, 1]

  for (
    let index = 0;
    index < expectedSequences.length;
    index += 1
  ) {
    const predecessor = harness.readLifecycle().state
    const commitTime = requireValue(
      commitTimes[index],
      'Expected one reverse commit time.',
    )
    harness.clockTime = commitTime
    const state = await port.commitRollbackOperation({
      expectedRevision: predecessor.revision,
      authority:
        createAuthorityClaim(mutation.fixture.operationAuthority),
    })
    const sequence = requireValue(
      expectedSequences[index],
      'Expected one reverse sequence.',
    )
    expect(state).toMatchObject({
      nextSequence: sequence - 1,
      restored: index + 1,
    })
    const transaction = requireValue(
      harness.transactions[index],
      'Expected one reverse transaction.',
    )
    const items = requireTransactionItems(transaction)
    expect(
      items[
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .applySequence
      ]?.ConditionCheck?.Key?.recordKey?.S,
    ).toBe(`apply-sequence/${sequence}`)
    const target = requireValue(
      items[
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .target
      ],
      'Expected one target restoration.',
    )
    if (index === 0) {
      expect(target.Put?.Item).toEqual(mutation.secondItem)
      expect(target.Delete).toBeUndefined()
    } else if (index === 1) {
      expect(target.Put?.Item).toEqual(mutation.firstItem)
      expect(target.Delete).toBeUndefined()
    } else {
      expect(target.Put).toBeUndefined()
      expect(target.Delete?.Key).toEqual(mutation.targetKey)
    }
  }

  expect(harness.readLifecycle().state).toMatchObject({
    nextSequence: 0,
    restored: 3,
  })
  expect(harness.transactions).toHaveLength(3)
})

test('re-reads the deterministic receipt when a winner commits before target read', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const winner =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot: mutation.startRoot,
      predecessorState: mutation.startRoot.initialState,
      currentAuthority: mutation.fixture.operationAuthority,
      applyReceipt: mutation.applyReceipt,
      journalSegment: mutation.journalSegment,
      committedAt: operationCommittedAt,
    })
  harness.winBeforeNextTargetRead(winner.state, winner.receipt)
  const port = createPort(mutation.fixture, harness)

  const state = await port.commitRollbackOperation({
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  })

  expect(state).toEqual(winner.state)
  expect(harness.transactions).toHaveLength(0)
  expect(
    (await port.readRollbackReceipt(1))?.receiptDigest,
  ).toBe(winner.receipt.receiptDigest)
})

test('stabilizes a receipt-present and stale-lifecycle torn read', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const initial = harness.readLifecycle()
  const winner =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot: mutation.startRoot,
      predecessorState: mutation.startRoot.initialState,
      currentAuthority: mutation.fixture.operationAuthority,
      applyReceipt: mutation.applyReceipt,
      journalSegment: mutation.journalSegment,
      committedAt: operationCommittedAt,
    })
  harness.installCommittedWinner(winner.state, winner.receipt)
  const current = harness.readLifecycle()
  harness.setLifecycleObservations([
    initial,
    initial,
    current,
    current,
  ])
  const port = createPort(mutation.fixture, harness)

  const state = await port.commitRollbackOperation({
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  })

  expect(state).toEqual(winner.state)
  expect(harness.transactions).toHaveLength(0)
})

test('rejects a crossed rollback state when its deterministic receipt is absent', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const port = createPort(mutation.fixture, harness)
  await port.commitRollbackOperation({
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  })
  harness.deleteReceipt(1)

  await expectRejectedCode(
    () => port.readRollbackReceipt(1),
    'INVALID_STATE',
  )
})

test('rejects a terminal receipt row that contradicts the terminal root', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const port = createPort(mutation.fixture, harness)
  const reverseCommand = {
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  }
  const state = await port.commitRollbackOperation(reverseCommand)
  harness.authority = mutation.fixture.finishAuthority
  harness.clockTime = finishCommittedAt
  await port.finishRollback({
    expectedRevision: state.revision,
    authority:
      createAuthorityClaim(mutation.fixture.finishAuthority),
  })
  const substituted =
    createWorkspaceSearchMigrationRollbackOperationTransitionV2({
      startRoot: mutation.startRoot,
      predecessorState: mutation.startRoot.initialState,
      currentAuthority: mutation.fixture.operationAuthority,
      applyReceipt: mutation.applyReceipt,
      journalSegment: mutation.journalSegment,
      committedAt: '2026-07-29T01:21:02.500Z',
    })
  harness.replaceReceipt(substituted.receipt)

  await expectRejectedCode(
    () => port.readRollbackReceipt(1),
    'INVALID_STATE',
  )
  await expectRejectedCode(
    () => port.commitRollbackOperation(reverseCommand),
    'INVALID_STATE',
  )
})

test('stabilizes a torn terminal lifecycle before correlating its receipt', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const port = createPort(mutation.fixture, harness)
  const state = await port.commitRollbackOperation({
    expectedRevision: mutation.startRoot.initialState.revision,
    authority:
      createAuthorityClaim(mutation.fixture.operationAuthority),
  })
  harness.authority = mutation.fixture.finishAuthority
  harness.clockTime = finishCommittedAt
  const root = await port.finishRollback({
    expectedRevision: state.revision,
    authority:
      createAuthorityClaim(mutation.fixture.finishAuthority),
  })
  harness.setReceiptVisibilityObservations([
    false,
    true,
    true,
  ])

  const receipt = await port.readRollbackReceipt(1)

  expect(root.terminalReceipt).not.toBeNull()
  expect(receipt).toEqual(root.terminalReceipt ?? undefined)
})

test('publishes fixed ten-item terminal root and retries after response loss', async () => {
  const fixture = createFixture(0)
  const startRoot = createZeroMutationStartRoot(fixture)
  const harness = new PartialRollbackOperationHarness(
    fixture,
    startRoot,
    undefined,
  )
  harness.authority = fixture.finishAuthority
  harness.clockTime = finishCommittedAt
  harness.transactionErrorAfterCommit =
    new Error('simulated finish response loss')
  const port = createPort(fixture, harness)
  const command = {
    expectedRevision: startRoot.initialState.revision,
    authority: createAuthorityClaim(fixture.finishAuthority),
  }

  const root = await port.finishRollback(command)

  expect(root).toMatchObject({
    startRootDigest: startRoot.startRootDigest,
    terminalReceipt: null,
    terminalState: {
      status: 'rolled-back',
      nextSequence: 0,
      revision: startRoot.initialState.revision + 1,
    },
  })
  expect(harness.transactions).toHaveLength(1)
  const items = requireTransactionItems(
    requireValue(
      harness.transactions[0],
      'Expected one finish transaction.',
    ),
  )
  expect(items).toHaveLength(
    workspaceSearchMigrationPartialRollbackFinishTransactionIndex
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
    'Put',
    'Put',
  ])
  expect(
    items[
      workspaceSearchMigrationPartialRollbackFinishTransactionIndex
        .rolledBackRoot
    ]?.Put?.Item?.recordKey?.S,
  ).toMatch(/^rolled-back-root\/v2\/[0-9a-f]{64}$/u)

  harness.transactionErrorAfterCommit = undefined
  expect(await port.finishRollback(command)).toEqual(root)
  expect(await port.readRollbackReceipt(1)).toBeUndefined()
  expect(harness.transactions).toHaveLength(1)
})

test('rejects a stale reverse revision before journal or transaction work', async () => {
  const mutation = createMutationRollbackFixture()
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    mutation.afterItem,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const port = createPort(mutation.fixture, harness)

  await expectRejectedCode(
    () =>
      port.commitRollbackOperation({
        expectedRevision:
          mutation.startRoot.initialState.revision + 1,
        authority:
          createAuthorityClaim(
            mutation.fixture.operationAuthority,
          ),
      }),
    'INVALID_STATE',
  )
  expect(harness.journalReads).toBe(0)
  expect(harness.transactions).toHaveLength(0)
})

test('rejects target drift before constructing a reverse transaction', async () => {
  const mutation = createMutationRollbackFixture()
  const driftedTarget = {
    ...structuredClone(mutation.afterItem),
    title: { S: 'concurrent writer changed this row' },
  }
  const harness = new PartialRollbackOperationHarness(
    mutation.fixture,
    mutation.startRoot,
    driftedTarget,
    mutation.applyReceipt,
    mutation.journalSegment,
  )
  const port = createPort(mutation.fixture, harness)

  await expectRejectedCode(
    () =>
      port.commitRollbackOperation({
        expectedRevision:
          mutation.startRoot.initialState.revision,
        authority:
          createAuthorityClaim(
            mutation.fixture.operationAuthority,
          ),
      }),
    'ROLLBACK_TARGET_DRIFT',
  )
  expect(harness.transactions).toHaveLength(0)
})

test('rejects a mismatched exact journal version and expired retention', async () => {
  const mismatch = createMutationRollbackFixture()
  const mismatchedJournal = {
    ...structuredClone(mismatch.journalSegment),
    operationId: digest('different-journal-operation'),
  }
  const mismatchHarness = new PartialRollbackOperationHarness(
    mismatch.fixture,
    mismatch.startRoot,
    mismatch.afterItem,
    mismatch.applyReceipt,
    mismatchedJournal,
  )
  await expectRejectedCode(
    () =>
      createPort(mismatch.fixture, mismatchHarness)
        .commitRollbackOperation({
          expectedRevision:
            mismatch.startRoot.initialState.revision,
          authority:
            createAuthorityClaim(
              mismatch.fixture.operationAuthority,
            ),
        }),
    'INVALID_JOURNAL',
  )
  expect(mismatchHarness.transactions).toHaveLength(0)

  const expired = createMutationRollbackFixture()
  const expiredReceipt = {
    ...structuredClone(expired.applyReceipt),
    journal: {
      ...structuredClone(expired.applyReceipt.journal),
      retainUntil: operationCommittedAt,
    },
  }
  const expiredHarness = new PartialRollbackOperationHarness(
    expired.fixture,
    expired.startRoot,
    expired.afterItem,
    expiredReceipt,
    expired.journalSegment,
  )
  await expectRejectedCode(
    () =>
      createPort(expired.fixture, expiredHarness)
        .commitRollbackOperation({
          expectedRevision:
            expired.startRoot.initialState.revision,
          authority:
            createAuthorityClaim(
              expired.fixture.operationAuthority,
            ),
        }),
    'INVALID_JOURNAL',
  )
  expect(expiredHarness.transactions).toHaveLength(0)
})

test('rejects substituted apply sequence and marker projections', async () => {
  const sequenceSubstitution =
    createSequentialMutationRollbackFixture()
  const sequenceHarness = new PartialRollbackOperationHarness(
    sequenceSubstitution.fixture,
    sequenceSubstitution.startRoot,
    sequenceSubstitution.firstAfterItem,
    sequenceSubstitution.finalApplyReceipt,
    sequenceSubstitution.finalJournalSegment,
  )
  sequenceHarness.addApplyEvidence(
    sequenceSubstitution.firstApplyReceipt,
    sequenceSubstitution.firstJournalSegment,
  )
  sequenceHarness.substituteApplySequence(
    2,
    sequenceSubstitution.firstApplyReceipt,
  )
  await expectRejectedCode(
    () =>
      createPort(
        sequenceSubstitution.fixture,
        sequenceHarness,
      ).commitRollbackOperation({
        expectedRevision:
          sequenceSubstitution.startRoot.initialState.revision,
        authority:
          createAuthorityClaim(
            sequenceSubstitution.fixture.operationAuthority,
          ),
      }),
    'INVALID_STATE',
  )
  expect(sequenceHarness.transactions).toHaveLength(0)

  const markerSubstitution =
    createSequentialMutationRollbackFixture()
  const markerHarness = new PartialRollbackOperationHarness(
    markerSubstitution.fixture,
    markerSubstitution.startRoot,
    markerSubstitution.finalAfterItem,
    markerSubstitution.finalApplyReceipt,
    markerSubstitution.finalJournalSegment,
  )
  markerHarness.substituteApplyMarker(
    markerSubstitution.finalApplyReceipt.operationId,
    markerSubstitution.firstApplyReceipt,
  )
  await expectRejectedCode(
    () =>
      createPort(
        markerSubstitution.fixture,
        markerHarness,
      ).commitRollbackOperation({
        expectedRevision:
          markerSubstitution.startRoot.initialState.revision,
        authority:
          createAuthorityClaim(
            markerSubstitution.fixture.operationAuthority,
          ),
      }),
    'INVALID_STATE',
  )
  expect(markerHarness.journalReads).toBe(1)
  expect(markerHarness.transactions).toHaveLength(0)
})

test('rejects a lifecycle capability from another rollback namespace', () => {
  const fixture = createFixture(0)
  const startRoot = createZeroMutationStartRoot(fixture)
  const harness = new PartialRollbackOperationHarness(
    fixture,
    startRoot,
    undefined,
  )
  const identity = harness.lifecycleBinding.readBindingIdentity()
  const mismatchedLifecycle = {
    ...harness.lifecycleBinding,
    readBindingIdentity: () => ({
      ...identity,
      bindingDigest: digest('different-rollback-namespace'),
    }),
  }

  let error: unknown
  try {
    createAwsWorkspaceSearchMigrationPartialRollbackOperationPort({
      configuration: fixture.configuration,
      configurationHash: fixture.configurationHash,
      executionBoundary: fixture.executionBoundary,
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      closedWriterFenceRecord: fixture.closedWriterFenceRecord,
      executionRun: fixture.executionRun,
      authorityPort: harness.authorityPort,
      lifecycleBinding: mismatchedLifecycle,
      journalGateway: harness.journalGateway,
      applyReceiptBinding: harness.applyReceiptBinding,
      transport: harness.transport,
      clock: harness.clock,
    })
  } catch (caught: unknown) {
    error = caught
  }
  expect(readFailureCode(error)).toBe('INVALID_ARGUMENT')
})

test('prioritizes reverse integrity cancellations over transient pressure', async () => {
  const cases = [
    {
      integrityIndex:
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .lease,
      transientIndex:
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .applySequence,
      expectedCode: 'LEASE_LOST',
    },
    {
      integrityIndex:
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .target,
      transientIndex:
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .applyMarker,
      expectedCode: 'ROLLBACK_TARGET_DRIFT',
    },
  ]
  for (const scenario of cases) {
    const mutation = createMutationRollbackFixture()
    const harness = new PartialRollbackOperationHarness(
      mutation.fixture,
      mutation.startRoot,
      mutation.afterItem,
      mutation.applyReceipt,
      mutation.journalSegment,
    )
    harness.transactionErrorBeforeCommit =
      createCancellationWithReasons(
        [
          {
            index: scenario.integrityIndex,
            code: 'ConditionalCheckFailed',
          },
          {
            index: scenario.transientIndex,
            code: 'ProvisionedThroughputExceeded',
          },
        ],
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .count,
      )
    await expectRejectedCode(
      () =>
        createPort(
          mutation.fixture,
          harness,
        ).commitRollbackOperation({
          expectedRevision:
            mutation.startRoot.initialState.revision,
          authority:
            createAuthorityClaim(
              mutation.fixture.operationAuthority,
            ),
        }),
      scenario.expectedCode,
    )
  }
})

test('classifies every fixed reverse cancellation position', async () => {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationPartialRollbackOperationTransactionIndex
        .count;
    index += 1
  ) {
    const mutation = createMutationRollbackFixture()
    const harness = new PartialRollbackOperationHarness(
      mutation.fixture,
      mutation.startRoot,
      mutation.afterItem,
      mutation.applyReceipt,
      mutation.journalSegment,
    )
    harness.transactionErrorBeforeCommit = createCancellation(
      index,
      'ConditionalCheckFailed',
      workspaceSearchMigrationPartialRollbackOperationTransactionIndex
        .count,
    )
    const port = createPort(mutation.fixture, harness)
    const expected = index ===
        workspaceSearchMigrationPartialRollbackOperationTransactionIndex
          .lease
      ? 'LEASE_LOST'
      : index ===
          workspaceSearchMigrationPartialRollbackOperationTransactionIndex
            .pointer ||
          index ===
          workspaceSearchMigrationPartialRollbackOperationTransactionIndex
            .receipt
        ? 'INVALID_MAINTENANCE_EVIDENCE'
        : index ===
          workspaceSearchMigrationPartialRollbackOperationTransactionIndex
            .target
          ? 'ROLLBACK_TARGET_DRIFT'
          : 'INVALID_STATE'
    await expectRejectedCode(
      () =>
        port.commitRollbackOperation({
          expectedRevision:
            mutation.startRoot.initialState.revision,
          authority:
            createAuthorityClaim(
              mutation.fixture.operationAuthority,
            ),
        }),
      expected,
    )
  }
})

test('classifies every fixed finish cancellation position', async () => {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationPartialRollbackFinishTransactionIndex
        .count;
    index += 1
  ) {
    const fixture = createFixture(0)
    const startRoot = createZeroMutationStartRoot(fixture)
    const harness = new PartialRollbackOperationHarness(
      fixture,
      startRoot,
      undefined,
    )
    harness.authority = fixture.finishAuthority
    harness.clockTime = finishCommittedAt
    harness.transactionErrorBeforeCommit = createCancellation(
      index,
      'ConditionalCheckFailed',
      workspaceSearchMigrationPartialRollbackFinishTransactionIndex
        .count,
    )
    const port = createPort(fixture, harness)
    const expected = index ===
        workspaceSearchMigrationPartialRollbackFinishTransactionIndex
          .lease
      ? 'LEASE_LOST'
      : index ===
          workspaceSearchMigrationPartialRollbackFinishTransactionIndex
            .pointer ||
          index ===
          workspaceSearchMigrationPartialRollbackFinishTransactionIndex
            .receipt
        ? 'INVALID_MAINTENANCE_EVIDENCE'
        : 'INVALID_STATE'
    await expectRejectedCode(
      () =>
        port.finishRollback({
          expectedRevision: startRoot.initialState.revision,
          authority: createAuthorityClaim(
            fixture.finishAuthority,
          ),
        }),
      expected,
    )
  }
})

/**
 * Requires one asynchronous operation to reject with an exact public code.
 *
 * @param operation - Operation expected to reject.
 * @param expectedCode - Exact stable public failure code.
 */
async function expectRejectedCode(
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let error: unknown
  try {
    await operation()
  } catch (caught: unknown) {
    error = caught
  }
  expect(readFailureCode(error)).toBe(expectedCode)
}
