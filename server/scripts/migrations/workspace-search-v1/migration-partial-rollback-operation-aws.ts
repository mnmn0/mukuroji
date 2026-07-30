import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  isThrottlingError,
  isTransientError,
} from '@smithy/core/retry'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedConditionCheck,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  readWorkspaceSearchWriterFenceClosedRecord,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationItemSnapshot,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
} from './migration-execution-boundary-aws'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck,
} from './migration-execution-run-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import {
  createWorkspaceSearchMigrationItemConditionMaterial,
  verifyWorkspaceSearchMigrationItemStrongRead,
  type WorkspaceSearchMigrationItemConditionMaterial,
} from './migration-item-condition-aws'
import {
  decodeWorkspaceSearchJournalRestorationMaterial,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRollbackReceiptV2RecordKey,
} from './migration-rollback-key'
import type {
  WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
  WorkspaceSearchMigrationPartialRollbackStartAwsPort,
} from './migration-partial-rollback-start-aws'
import type {
  WorkspaceSearchMigrationRollbackAuthorityClaim,
  WorkspaceSearchMigrationRollbackCommandInput,
  WorkspaceSearchMigrationRollbackOperationAuthorityReader,
  WorkspaceSearchMigrationRollbackOperationAwsClock,
} from './migration-rollback-operation-aws'
import {
  createWorkspaceSearchMigrationRollbackOperationTransitionV2,
  finishWorkspaceSearchMigrationRollbackV2,
  parseWorkspaceSearchMigrationRollbackOperationReceiptV2,
  serializeWorkspaceSearchMigrationRollbackOperationReceiptV2,
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2,
  type WorkspaceSearchMigrationRollbackOperationReceiptV2,
  type WorkspaceSearchMigrationRollbackPersistenceStateV2,
  type WorkspaceSearchMigrationRollbackStartRootV2,
  type WorkspaceSearchMigrationRolledBackRootV2,
} from './migration-rollback-persistence-v2'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck,
} from './migration-sealed-planning-authority-aws'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'
import type {
  WorkspaceSearchMigrationApplyReceiptAwsBinding,
  WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
} from './migration-apply-receipt-aws'

const partialRollbackOperationRecordVersion = 2
const rollbackReceiptRecordKind =
  'workspace-search-migration-rollback-operation-receipt-record'

/**
 * Fixed item positions for one atomic committed-prefix reverse operation.
 */
export const workspaceSearchMigrationPartialRollbackOperationTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two execution boundary condition. */
    executionBoundary: 4,
    /** Exact sealed planning-authority condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable execution admission condition. */
    executionRun: 6,
    /** Exact immutable version-two rollback-start root condition. */
    startRoot: 7,
    /** Exact-predecessor version-two rollback-state CAS Put. */
    rollbackState: 8,
    /** Exact immutable apply journal-sequence condition. */
    applySequence: 9,
    /** Exact immutable apply operation-marker condition. */
    applyMarker: 10,
    /** Exact post-apply target CAS and preimage restoration. */
    target: 11,
    /** Absent deterministic version-two rollback receipt Put. */
    rollbackReceipt: 12,
    /** Fixed reverse-operation item count. */
    count: 13,
  })

/**
 * Fixed item positions for one atomic committed-prefix rollback finish.
 */
export const workspaceSearchMigrationPartialRollbackFinishTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two execution boundary condition. */
    executionBoundary: 4,
    /** Exact sealed planning-authority condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable execution admission condition. */
    executionRun: 6,
    /** Exact immutable version-two rollback-start root condition. */
    startRoot: 7,
    /** Exact zero-head version-two rollback-state CAS Put. */
    rollbackState: 8,
    /** Absent deterministic version-two rolled-back root Put. */
    rolledBackRoot: 9,
    /** Fixed terminal transaction item count. */
    count: 10,
  })

/**
 * Lifecycle persistence capability shared with committed-prefix rollback start.
 */
export type WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding =
  Pick<
    WorkspaceSearchMigrationPartialRollbackStartAwsPort,
    | 'createRollbackStateTransitionPut'
    | 'createRolledBackRootAbsentPut'
    | 'createStartRootConditionCheck'
    | 'readBindingIdentity'
    | 'readRollbackLifecycle'
  >

/**
 * Narrow strongly consistent and transactional committed-prefix rollback transport.
 */
export interface WorkspaceSearchMigrationPartialRollbackOperationAwsTransport {
  /**
   * Strongly reads one receipt, apply row, or Workspace Search target.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getPartialRollbackOperationItem(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes all-six-table measured-incarnation guards before commit.
   */
  preparePartialRollbackOperationWrite(): Promise<void>

  /**
   * Sends one fixed-order reverse or terminal transaction.
   *
   * @param command - Adapter-owned fixed-order transaction.
   * @returns Raw low-level DynamoDB response.
   */
  transactWritePartialRollbackOperation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Static measured material and narrow capabilities for v2 rollback progress.
 */
export type CreateWorkspaceSearchMigrationPartialRollbackOperationAwsPortInput =
  {
    /** Complete independently measured migration configuration. */
    readonly configuration: WorkspaceSearchMigrationConfiguration
    /** Reviewed digest of the exact measured configuration. */
    readonly configurationHash: string
    /** Exact revision-two planning-admitted execution boundary. */
    readonly executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
    /** Exact immutable version-two sealed planning authority. */
    readonly sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2
    /** Exact closed application-writer fence row. */
    readonly closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord
    /** Exact immutable revision-one execution admission. */
    readonly executionRun: WorkspaceSearchMigrationExecutionRun
    /** Fresh current-authority reader. */
    readonly authorityPort:
      WorkspaceSearchMigrationRollbackOperationAuthorityReader
    /** Shared start/state/root lifecycle persistence capability. */
    readonly lifecycleBinding:
      WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding
    /** Exact-version immutable journal gateway. */
    readonly journalGateway:
      WorkspaceSearchMigrationJournalAwsGateway
    /** Run-bound immutable apply receipt read and guard capability. */
    readonly applyReceiptBinding:
      WorkspaceSearchMigrationApplyReceiptAwsBinding
    /** Narrow measured DynamoDB rollback transport. */
    readonly transport:
      WorkspaceSearchMigrationPartialRollbackOperationAwsTransport
    /** Adapter-owned trusted clock. */
    readonly clock: WorkspaceSearchMigrationRollbackOperationAwsClock
  }

/**
 * Durable standalone committed-prefix reverse and finish capability.
 */
export interface WorkspaceSearchMigrationPartialRollbackOperationAwsPort {
  /**
   * Strongly reads one immutable version-two reverse receipt.
   *
   * @param sequence - Exact positive forward journal sequence.
   * @returns Strict reverse receipt, or undefined when not committed.
   */
  readRollbackReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationRollbackOperationReceiptV2 | undefined>

  /**
   * Restores the adapter-selected next committed-prefix journal preimage.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable state, including later progress on retry.
   */
  commitRollbackOperation(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2>

  /**
   * Publishes the immutable v2 terminal root at the zero journal head.
   *
   * @param input - Exact zero-head revision and current authority claim.
   * @returns Exact immutable rolled-back root.
   */
  finishRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRolledBackRootV2>
}

/**
 * Detached immutable construction binding retained by the adapter.
 */
type PartialRollbackOperationBinding = {
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Exact measured Workspace Search target table. */
  readonly targetTable: MigrationTableIdentity
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact revision-two admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Stable rollback-chain key namespace digest. */
  readonly bindingDigest: string
}

/**
 * Captured dependency methods immune to later property replacement.
 */
type PreparedPartialRollbackOperationDependencies = {
  /** Fresh authority read. */
  readonly readAuthority:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader['readAuthority']
  /** Coherent start/state/root lifecycle read. */
  readonly readLifecycle:
    WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding[
      'readRollbackLifecycle'
    ]
  /** Exact immutable start-root transaction guard. */
  readonly createStartGuard:
    WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding[
      'createStartRootConditionCheck'
    ]
  /** Exact mutable state CAS transaction item. */
  readonly createStateTransition:
    WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding[
      'createRollbackStateTransitionPut'
    ]
  /** Absent immutable rolled-back-root Put. */
  readonly createRootPut:
    WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding[
      'createRolledBackRootAbsentPut'
    ]
  /** Exact-version immutable journal read. */
  readonly readJournal:
    WorkspaceSearchMigrationJournalAwsGateway['readJournalSegment']
  /** Creates one apply-sequence strong read. */
  readonly createApplySequenceRead:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createJournalSequenceStrongReadCommand'
    ]
  /** Parses one apply-sequence strong read. */
  readonly parseApplySequence:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'parseJournalSequenceStrongReadOutput'
    ]
  /** Creates one apply operation-marker strong read. */
  readonly createApplyMarkerRead:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createOperationMarkerStrongReadCommand'
    ]
  /** Parses one apply operation-marker strong read. */
  readonly parseApplyMarker:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'parseOperationMarkerStrongReadOutput'
    ]
  /** Correlates the apply sequence and marker rows. */
  readonly correlateApplyRows:
    WorkspaceSearchMigrationApplyReceiptAwsBinding['correlateRows']
  /** Creates the exact immutable apply-sequence guard. */
  readonly createApplySequenceGuard:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createJournalSequenceConditionCheck'
    ]
  /** Creates the exact immutable apply-marker guard. */
  readonly createApplyMarkerGuard:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createOperationMarkerConditionCheck'
    ]
  /** Strong DynamoDB read. */
  readonly get:
    WorkspaceSearchMigrationPartialRollbackOperationAwsTransport[
      'getPartialRollbackOperationItem'
    ]
  /** Measured-incarnation preparation. */
  readonly prepare:
    WorkspaceSearchMigrationPartialRollbackOperationAwsTransport[
      'preparePartialRollbackOperationWrite'
    ]
  /** Fixed transaction send. */
  readonly transact:
    WorkspaceSearchMigrationPartialRollbackOperationAwsTransport[
      'transactWritePartialRollbackOperation'
    ]
  /** Detached trusted clock. */
  readonly clock: () => Date
}

/**
 * Fully detached caller command before the first asynchronous boundary.
 */
type PreparedPartialRollbackOperationCommand = {
  /** Exact expected durable predecessor revision. */
  readonly expectedRevision: number
  /** Detached exact current authority claim. */
  readonly authority: WorkspaceSearchMigrationRollbackAuthorityClaim
}

/**
 * Transaction family used for stable cancellation classification.
 */
type PartialRollbackTransactionKind = 'finish' | 'operation'

/**
 * Creates one measured committed-prefix reverse and finish adapter.
 *
 * @param input - Measured bindings and narrow rollback capabilities.
 * @returns Atomic version-two rollback persistence capability.
 */
export function createAwsWorkspaceSearchMigrationPartialRollbackOperationPort(
  input: CreateWorkspaceSearchMigrationPartialRollbackOperationAwsPortInput,
): WorkspaceSearchMigrationPartialRollbackOperationAwsPort {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'applyReceiptBinding',
      'authorityPort',
      'clock',
      'closedWriterFenceRecord',
      'configuration',
      'configurationHash',
      'executionBoundary',
      'executionRun',
      'journalGateway',
      'lifecycleBinding',
      'sealedPlanningAuthority',
      'transport',
    ], 'INVALID_ARGUMENT')
    const binding = createPartialRollbackOperationBinding(
      readOwn(record, 'configuration', 'INVALID_ARGUMENT'),
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionBoundary', 'INVALID_ARGUMENT'),
      readOwn(record, 'sealedPlanningAuthority', 'INVALID_ARGUMENT'),
      readOwn(record, 'closedWriterFenceRecord', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
    )
    const dependencies =
      preparePartialRollbackOperationDependencies(
        binding,
        readOwn(record, 'authorityPort', 'INVALID_ARGUMENT'),
        readOwn(record, 'lifecycleBinding', 'INVALID_ARGUMENT'),
        readOwn(record, 'journalGateway', 'INVALID_ARGUMENT'),
        readOwn(record, 'applyReceiptBinding', 'INVALID_ARGUMENT'),
        readOwn(record, 'transport', 'INVALID_ARGUMENT'),
        readOwn(record, 'clock', 'INVALID_ARGUMENT'),
      )
    return new AwsWorkspaceSearchMigrationPartialRollbackOperationPort(
      binding,
      dependencies,
    )
  } catch (error: unknown) {
    throw createPartialRollbackOperationPublicFailure(
      readPartialRollbackOperationFailureCode(error, true),
    )
  }
}

/**
 * Concrete committed-prefix reverse and finish adapter.
 */
class AwsWorkspaceSearchMigrationPartialRollbackOperationPort
implements WorkspaceSearchMigrationPartialRollbackOperationAwsPort {
  /** Detached exact static rollback binding. */
  private readonly binding: PartialRollbackOperationBinding

  /** Captured narrow dependency methods. */
  private readonly dependencies:
    PreparedPartialRollbackOperationDependencies

  /**
   * Creates one adapter from validated material.
   *
   * @param binding - Exact static rollback binding.
   * @param dependencies - Captured narrow capabilities.
   */
  constructor(
    binding: PartialRollbackOperationBinding,
    dependencies: PreparedPartialRollbackOperationDependencies,
  ) {
    this.binding = binding
    this.dependencies = dependencies
  }

  /**
   * Strongly reads one immutable version-two reverse receipt.
   *
   * @param sequence - Positive forward sequence.
   * @returns Strict durable receipt or undefined.
   */
  async readRollbackReceipt(
    sequence: number,
  ): Promise<
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | undefined
  > {
    return runPartialRollbackOperationBoundary(async () => {
      const exactSequence = readPositiveSafeInteger(
        sequence,
        'INVALID_ARGUMENT',
      )
      const { receipt, lifecycle } =
        await this.readOperationSnapshot(exactSequence)
      if (lifecycle === undefined) {
        if (receipt !== undefined) {
          return failPartialRollbackOperation('INVALID_STATE')
        }
        return undefined
      }
      if (receipt === undefined) {
        if (
          exactSequence <=
            lifecycle.startRoot.originalJournalSequence &&
          lifecycle.state.nextSequence < exactSequence
        ) {
          return failPartialRollbackOperation('INVALID_STATE')
        }
        return undefined
      }
      requireReceiptBelongsToStart(
        lifecycle.startRoot,
        receipt,
      )
      requireStateAtOrAfterReceipt(
        lifecycle.startRoot,
        lifecycle.state,
        receipt,
      )
      return receipt
    })
  }

  /**
   * Atomically restores the next committed-prefix reverse sequence.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable rollback state.
   */
  async commitRollbackOperation(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2> {
    return runPartialRollbackOperationBoundary(async () => {
      const command = preparePartialRollbackOperationCommand(input)
      const initialLifecycle = await this.requireLifecycle()
      const startRoot = initialLifecycle.startRoot
      const sequence = deriveRollbackSequence(
        startRoot,
        command.expectedRevision,
      )
      const {
        receipt: existingReceipt,
        lifecycle: lifecycleValue,
      } = await this.readOperationSnapshot(sequence)
      const lifecycle = lifecycleValue ??
        failPartialRollbackOperation('INVALID_STATE')
      if (
        lifecycle.startRoot.startRootDigest !==
          startRoot.startRootDigest
      ) {
        return failPartialRollbackOperation('INVALID_STATE')
      }
      if (existingReceipt !== undefined) {
        return this.reconcileExistingReceipt(
          command,
          lifecycle,
          existingReceipt,
        )
      }
      requireNoTerminalRoot(lifecycle)
      const predecessorState = lifecycle.state
      requireExactRollbackPredecessor(
        startRoot,
        predecessorState,
        command,
        sequence,
      )

      const applySequence = await this.readApplySequence(sequence)
      const [applyMarkerOutput, journalSegment, authority] =
        await Promise.all([
          this.dependencies.get(
            this.dependencies.createApplyMarkerRead(
              applySequence.receipt.operationId,
            ),
          ),
          this.readJournal(applySequence.receipt.journal),
          this.resolveAuthority(command),
        ])
      const applyMarker =
        this.dependencies.parseApplyMarker(
          applySequence.receipt.operationId,
          applyMarkerOutput,
        )
      if (applyMarker === undefined) {
        return failPartialRollbackOperation('INVALID_STATE')
      }
      const correlated = this.dependencies.correlateApplyRows(
        applySequence,
        applyMarker,
      )
      requireAuthorityClaimMatchesAuthority(
        command.authority,
        authority,
      )
      const restoration =
        decodeWorkspaceSearchJournalRestorationMaterial(
          journalSegment,
        )
      requireJournalMatchesApplyReceipt(
        correlated.receipt,
        journalSegment,
        restoration,
      )
      const targetOutput = await this.dependencies.get(
        createStrongReadCommand(
          this.binding.targetTable,
          restoration.targetKey,
        ),
      )
      try {
        verifyWorkspaceSearchMigrationItemStrongRead(
          this.binding.targetTable,
          restoration.targetKey,
          restoration.after,
          targetOutput,
          'ROLLBACK_TARGET_DRIFT',
        )
      } catch (error: unknown) {
        const {
          receipt: winner,
          lifecycle: currentValue,
        } = await this.readOperationSnapshot(sequence)
        if (winner !== undefined) {
          const current = currentValue ??
            failPartialRollbackOperation('INVALID_STATE')
          return this.reconcileExistingReceipt(
            command,
            current,
            winner,
          )
        }
        throw error
      }
      const targetCondition =
        createWorkspaceSearchMigrationItemConditionMaterial(
          this.binding.targetTable,
          restoration.targetKey,
          restoration.after,
          targetSchemaKnownAttributeNames(
            this.binding.targetTable,
          ),
        )
      await this.dependencies.prepare()
      const commitAt = readClock(this.dependencies.clock)
      requireRollbackJournalRetention(
        correlated.receipt.journal.retainUntil,
        commitAt,
      )
      const transition =
        createWorkspaceSearchMigrationRollbackOperationTransitionV2({
          startRoot,
          predecessorState,
          currentAuthority: authority,
          applyReceipt: correlated.receipt,
          journalSegment,
          committedAt: commitAt.toISOString(),
        })
      const transaction =
        createPartialRollbackOperationTransactionCommand({
          binding: this.binding,
          dependencies: this.dependencies,
          currentAuthority: authority,
          commitAt,
          startRoot,
          predecessorState,
          applySequence,
          applySequenceGuard:
            this.dependencies.createApplySequenceGuard(
              applySequence,
            ),
          applyMarkerGuard:
            this.dependencies.createApplyMarkerGuard(applyMarker),
          targetCondition,
          restorationBefore: restoration.before,
          receipt: transition.receipt,
          successorState: transition.state,
        })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const publicCode = readPublicFailureCode(error)
        if (publicCode !== undefined) {
          return failPartialRollbackOperation(publicCode)
        }
        transactionError = error
      }
      return this.reconcileOperationAfterAttempt(
        command,
        startRoot,
        transition.receipt,
        transition.state,
        restoration.targetKey,
        restoration.before,
        transactionError,
      )
    })
  }

  /**
   * Atomically publishes the immutable version-two terminal root.
   *
   * @param input - Exact zero-head revision and current authority claim.
   * @returns Exact terminal immutable root.
   */
  async finishRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRolledBackRootV2> {
    return runPartialRollbackOperationBoundary(async () => {
      const command = preparePartialRollbackOperationCommand(input)
      const {
        receipt: observedTerminalReceipt,
        lifecycle: lifecycleValue,
      } = await this.readOperationSnapshot(1)
      const lifecycle = lifecycleValue ??
        failPartialRollbackOperation('INVALID_STATE')
      if (lifecycle.rolledBackRoot !== undefined) {
        requireRootMatchesFinishCommand(
          lifecycle.rolledBackRoot,
          command,
        )
        return lifecycle.rolledBackRoot
      }
      const { startRoot, state: predecessorState } = lifecycle
      requireFinishPredecessor(
        startRoot,
        predecessorState,
        command,
      )
      const authority = await this.resolveAuthority(command)
      requireAuthorityClaimMatchesAuthority(
        command.authority,
        authority,
      )
      const terminalReceipt = startRoot.originalJournalSequence === 0
        ? null
        : observedTerminalReceipt ??
          failPartialRollbackOperation('INVALID_STATE')
      if (
        startRoot.originalJournalSequence === 0 &&
        observedTerminalReceipt !== undefined
      ) {
        return failPartialRollbackOperation('INVALID_STATE')
      }
      if (terminalReceipt !== null) {
        requireReceiptBelongsToStart(startRoot, terminalReceipt)
        requireStateAtOrAfterReceipt(
          startRoot,
          predecessorState,
          terminalReceipt,
        )
      }
      await this.dependencies.prepare()
      const commitAt = readClock(this.dependencies.clock)
      const transition = finishWorkspaceSearchMigrationRollbackV2({
        startRoot,
        predecessorState,
        currentAuthority: authority,
        terminalReceipt,
        finishedAt: commitAt.toISOString(),
      })
      const transaction =
        createPartialRollbackFinishTransactionCommand({
          binding: this.binding,
          dependencies: this.dependencies,
          currentAuthority: authority,
          commitAt,
          startRoot,
          predecessorState,
          root: transition.root,
        })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const publicCode = readPublicFailureCode(error)
        if (publicCode !== undefined) {
          return failPartialRollbackOperation(publicCode)
        }
        transactionError = error
      }
      return this.reconcileFinishAfterAttempt(
        command,
        transition.root,
        transactionError,
      )
    })
  }

  /**
   * Resolves and validates fresh current authority.
   *
   * @param command - Detached caller command.
   * @returns Fresh strict authority bound to this run.
   */
  private async resolveAuthority(
    command: PreparedPartialRollbackOperationCommand,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const candidate = await this.dependencies.readAuthority(
      command.authority,
    )
    const detached =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        candidate,
      )
    if (
      detached.configurationHash !==
        this.binding.configurationHash ||
      detached.stateTableId !== this.binding.stateTable.tableId ||
      detached.lease.runId !== this.binding.executionRun.runId
    ) {
      return failPartialRollbackOperation('CONFIGURATION_DRIFT')
    }
    return detached
  }

  /**
   * Requires one coherent committed-prefix rollback lifecycle.
   *
   * @returns Exact current lifecycle snapshot.
   */
  private async requireLifecycle():
    Promise<WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot> {
    const lifecycle = await this.dependencies.readLifecycle()
    if (lifecycle === undefined) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    requireLifecycleBinding(this.binding, lifecycle)
    return lifecycle
  }

  /**
   * Reads one immutable reverse receipt row.
   *
   * @param sequence - Exact positive sequence.
   * @returns Strict receipt or undefined.
   */
  private async readReceipt(
    sequence: number,
  ): Promise<
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | undefined
  > {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
          this.binding.bindingDigest,
          sequence,
        ),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRollbackReceiptRecord(
          this.binding,
          sequence,
          item,
        )
  }

  /**
   * Reads receipt and lifecycle until two complete observations agree.
   *
   * @param sequence - Exact positive reverse sequence.
   * @returns Coherent receipt presence and lifecycle progress.
   */
  private async readOperationSnapshot(
    sequence: number,
  ): Promise<{
    /** Immutable receipt when the sequence has committed. */
    readonly receipt?:
      WorkspaceSearchMigrationRollbackOperationReceiptV2
    /** Exact coherent rollback lifecycle. */
    readonly lifecycle?:
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot
  }> {
    const snapshot =
      await readCoherentPartialRollbackOperationSnapshot(
      async () => {
        const [receipt, lifecycleValue] = await Promise.all([
          this.readReceipt(sequence),
          this.dependencies.readLifecycle(),
        ])
        if (lifecycleValue !== undefined) {
          requireLifecycleBinding(this.binding, lifecycleValue)
        }
        const lifecycle = lifecycleValue
        return { receipt, lifecycle }
      },
      (left, right) =>
        left.receipt?.receiptDigest ===
          right.receipt?.receiptDigest &&
        left.lifecycle?.startRoot.startRootDigest ===
          right.lifecycle?.startRoot.startRootDigest &&
        left.lifecycle?.state.stateDigest ===
          right.lifecycle?.state.stateDigest &&
        left.lifecycle?.rolledBackRoot?.rootDigest ===
          right.lifecycle?.rolledBackRoot?.rootDigest,
    )
    if (snapshot.lifecycle !== undefined) {
      requireTerminalReceiptCorrelation(
        snapshot.lifecycle,
        sequence,
        snapshot.receipt,
      )
    }
    return snapshot
  }

  /**
   * Reads one exact apply sequence projection.
   *
   * @param sequence - Exact positive sequence.
   * @returns Strict immutable apply projection.
   */
  private async readApplySequence(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationApplySequenceReceiptAwsProjection> {
    const output = await this.dependencies.get(
      this.dependencies.createApplySequenceRead(sequence),
    )
    const projection =
      this.dependencies.parseApplySequence(sequence, output)
    return projection ??
      failPartialRollbackOperation('INVALID_STATE')
  }

  /**
   * Reads one exact immutable journal version.
   *
   * @param reference - Apply receipt's exact immutable reference.
   * @returns Strict immutable journal segment.
   */
  private async readJournal(
    reference:
      Parameters<WorkspaceSearchMigrationJournalAwsGateway[
        'readJournalSegment'
      ]>[0],
  ): Promise<
    Awaited<ReturnType<
      WorkspaceSearchMigrationJournalAwsGateway['readJournalSegment']
    >>
  > {
    try {
      return await this.dependencies.readJournal(reference)
    } catch (error: unknown) {
      const code = readPublicFailureCode(error)
      if (code !== undefined) {
        return failPartialRollbackOperation(code)
      }
      return failPartialRollbackOperation('INVALID_JOURNAL')
    }
  }

  /**
   * Reconciles an already-observed immutable reverse receipt.
   *
   * @param command - Detached retry command.
   * @param lifecycle - Coherent current lifecycle snapshot.
   * @param receipt - Existing deterministic receipt.
   * @returns Current state at or after the receipt.
   */
  private reconcileExistingReceipt(
    command: PreparedPartialRollbackOperationCommand,
    lifecycle: WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
    receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
  ): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
    requireReceiptMatchesCommand(
      command,
      lifecycle.startRoot,
      receipt,
    )
    requireStateAtOrAfterReceipt(
      lifecycle.startRoot,
      lifecycle.state,
      receipt,
    )
    return lifecycle.state
  }

  /**
   * Reconciles a reverse transaction through receipt, state, and target reads.
   *
   * @param command - Detached attempted command.
   * @param startRoot - Exact immutable start root.
   * @param intendedReceipt - Exact intended immutable receipt.
   * @param intendedState - Exact intended successor state.
   * @param targetKey - Exact restored target key.
   * @param restoredSnapshot - Exact restored target snapshot.
   * @param transactionError - Raw transaction failure when present.
   * @returns Current state proving this reverse command committed.
   */
  private async reconcileOperationAfterAttempt(
    command: PreparedPartialRollbackOperationCommand,
    startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
    intendedReceipt:
      WorkspaceSearchMigrationRollbackOperationReceiptV2,
    intendedState:
      WorkspaceSearchMigrationRollbackPersistenceStateV2,
    targetKey: Readonly<Record<string, AttributeValue>>,
    restoredSnapshot: MigrationItemSnapshot,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2> {
    let receipt:
      WorkspaceSearchMigrationRollbackOperationReceiptV2 | undefined
    let lifecycle:
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot
    let targetOutput: GetItemCommandOutput
    try {
      const [snapshot, observedTargetOutput] = await Promise.all([
        this.readOperationSnapshot(intendedReceipt.sequence),
        this.dependencies.get(
          createStrongReadCommand(
            this.binding.targetTable,
            targetKey,
          ),
        ),
      ])
      receipt = snapshot.receipt
      lifecycle = snapshot.lifecycle ??
        failPartialRollbackOperation('INVALID_STATE')
      targetOutput = observedTargetOutput
    } catch (error: unknown) {
      return failPartialRollbackOperation(
        readPartialRollbackReconciliationFailureCode(error),
      )
    }
    if (receipt === undefined) {
      if (
        lifecycle.state.nextSequence <
          intendedReceipt.sequence
      ) {
        return failPartialRollbackOperation('INVALID_STATE')
      }
      return failPartialRollbackOperation(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyPartialRollbackTransactionError(
              transactionError,
              'operation',
            ),
      )
    }
    requireReceiptIsLogicalWinner(
      intendedReceipt,
      intendedState,
      receipt,
    )
    requireReceiptMatchesCommand(command, startRoot, receipt)
    requireStateAtOrAfterReceipt(
      startRoot,
      lifecycle.state,
      receipt,
    )
    if (
      lifecycle.state.revision === receipt.successorRevision
    ) {
      try {
        verifyWorkspaceSearchMigrationItemStrongRead(
          this.binding.targetTable,
          targetKey,
          restoredSnapshot,
          targetOutput,
          'ROLLBACK_TARGET_DRIFT',
        )
      } catch {
        const refreshed =
          await this.readOperationSnapshot(receipt.sequence)
        if (
          refreshed.receipt === undefined ||
          refreshed.lifecycle === undefined
        ) {
          return failPartialRollbackOperation('INVALID_STATE')
        }
        requireReceiptIsLogicalWinner(
          intendedReceipt,
          intendedState,
          refreshed.receipt,
        )
        requireReceiptMatchesCommand(
          command,
          startRoot,
          refreshed.receipt,
        )
        requireStateAtOrAfterReceipt(
          startRoot,
          refreshed.lifecycle.state,
          refreshed.receipt,
        )
        if (
          refreshed.lifecycle.state.revision >
            refreshed.receipt.successorRevision
        ) {
          return refreshed.lifecycle.state
        }
        let refreshedTargetOutput: GetItemCommandOutput
        try {
          refreshedTargetOutput = await this.dependencies.get(
            createStrongReadCommand(
              this.binding.targetTable,
              targetKey,
            ),
          )
        } catch (error: unknown) {
          return failPartialRollbackOperation(
            readPartialRollbackReconciliationFailureCode(error),
          )
        }
        try {
          verifyWorkspaceSearchMigrationItemStrongRead(
            this.binding.targetTable,
            targetKey,
            restoredSnapshot,
            refreshedTargetOutput,
            'ROLLBACK_TARGET_DRIFT',
          )
        } catch (error: unknown) {
          let latest:
            Awaited<ReturnType<
              AwsWorkspaceSearchMigrationPartialRollbackOperationPort[
                'readOperationSnapshot'
              ]
            >>
          try {
            latest =
              await this.readOperationSnapshot(receipt.sequence)
          } catch (snapshotError: unknown) {
            return failPartialRollbackOperation(
              readPartialRollbackReconciliationFailureCode(
                snapshotError,
              ),
            )
          }
          if (
            latest.receipt === undefined ||
            latest.lifecycle === undefined
          ) {
            return failPartialRollbackOperation('INVALID_STATE')
          }
          requireReceiptIsLogicalWinner(
            intendedReceipt,
            intendedState,
            latest.receipt,
          )
          requireReceiptMatchesCommand(
            command,
            startRoot,
            latest.receipt,
          )
          requireStateAtOrAfterReceipt(
            startRoot,
            latest.lifecycle.state,
            latest.receipt,
          )
          if (
            latest.lifecycle.state.revision >
              latest.receipt.successorRevision
          ) {
            return latest.lifecycle.state
          }
          throw error
        }
        return refreshed.lifecycle.state
      }
    } else {
      readOutputItem(targetOutput)
    }
    return lifecycle.state
  }

  /**
   * Reconciles terminal publication through the shared lifecycle snapshot.
   *
   * @param command - Detached attempted command.
   * @param intendedRoot - Exact intended terminal root.
   * @param transactionError - Raw transaction failure when present.
   * @returns Exact committed terminal root.
   */
  private async reconcileFinishAfterAttempt(
    command: PreparedPartialRollbackOperationCommand,
    intendedRoot: WorkspaceSearchMigrationRolledBackRootV2,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRolledBackRootV2> {
    let lifecycle:
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot
    try {
      lifecycle = await this.requireLifecycle()
    } catch (error: unknown) {
      return failPartialRollbackOperation(
        readPartialRollbackReconciliationFailureCode(error),
      )
    }
    const root = lifecycle.rolledBackRoot
    if (root === undefined) {
      return failPartialRollbackOperation(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyPartialRollbackTransactionError(
              transactionError,
              'finish',
            ),
      )
    }
    requireRootIsLogicalWinner(command, intendedRoot, root)
    if (lifecycle.state.stateDigest !== root.terminalStateDigest) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    return root
  }
}

/**
 * Complete material for one fixed thirteen-item reverse transaction.
 */
type CreatePartialRollbackOperationTransactionCommandInput = {
  /** Exact static rollback binding. */
  readonly binding: PartialRollbackOperationBinding
  /** Shared lifecycle item factories. */
  readonly dependencies:
    PreparedPartialRollbackOperationDependencies
  /** Fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final commit time. */
  readonly commitAt: Date
  /** Exact immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact durable predecessor rollback state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Exact immutable apply sequence projection. */
  readonly applySequence:
    WorkspaceSearchMigrationApplySequenceReceiptAwsProjection
  /** Exact immutable apply-sequence transaction guard. */
  readonly applySequenceGuard: TransactWriteItem
  /** Exact immutable apply-marker transaction guard. */
  readonly applyMarkerGuard: TransactWriteItem
  /** Exact post-apply target CAS material. */
  readonly targetCondition:
    WorkspaceSearchMigrationItemConditionMaterial
  /** Exact target preimage to restore. */
  readonly restorationBefore: MigrationItemSnapshot
  /** Immutable version-two rollback receipt committed atomically. */
  readonly receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2
  /** Exact durable successor rollback state. */
  readonly successorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
}

/**
 * Complete material for one fixed ten-item terminal transaction.
 */
type CreatePartialRollbackFinishTransactionCommandInput = {
  /** Exact static rollback binding. */
  readonly binding: PartialRollbackOperationBinding
  /** Shared lifecycle item factories. */
  readonly dependencies:
    PreparedPartialRollbackOperationDependencies
  /** Fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final commit time. */
  readonly commitAt: Date
  /** Exact immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact zero-head predecessor rollback state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Immutable version-two terminal root to publish. */
  readonly root: WorkspaceSearchMigrationRolledBackRootV2
}

/**
 * Complete known top-level Workspace Search document schema.
 */
const workspaceSearchTargetKnownAttributeNames = Object.freeze([
  'assigneeUserId',
  'body',
  'createdAt',
  'creatorUserId',
  'customFields',
  'dueDate',
  'entityId',
  'entityType',
  'entryType',
  'parentId',
  'projectId',
  'projectionDigest',
  'recordKey',
  'relationIds',
  'schemaVersion',
  'sourceRevision',
  'status',
  'subtitle',
  'teamId',
  'title',
  'updatedAt',
  'url',
  'workspaceId',
])

/**
 * Returns every controlled Workspace Search target attribute.
 *
 * @param table - Exact measured Workspace Search target table.
 * @returns Sorted unique controlled target attribute names.
 */
function targetSchemaKnownAttributeNames(
  table: MigrationTableIdentity,
): readonly string[] {
  return [...new Set([
    ...workspaceSearchTargetKnownAttributeNames,
    ...(table.ttl.attribute === undefined
      ? []
      : [table.ttl.attribute]),
  ])].sort(compareUtf8Ordinal)
}

/**
 * Complete controlled attribute set for immutable v2 rollback receipts.
 */
const rollbackReceiptRecordAttributeNames = Object.freeze([
  'commandDigest',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'originDigest',
  'receiptBytes',
  'receiptDigest',
  'recordKey',
  'recordVersion',
  'runId',
  'sequence',
  'startRootDigest',
  'stateTableId',
])

/**
 * Detaches and cross-validates all construction-time rollback authority.
 *
 * @param configurationValue - Candidate measured configuration.
 * @param configurationHashValue - Candidate reviewed digest.
 * @param executionBoundaryValue - Candidate revision-two boundary.
 * @param sealedPlanningAuthorityValue - Candidate sealed authority.
 * @param closedWriterFenceRecordValue - Candidate closed fence row.
 * @param executionRunValue - Candidate execution admission.
 * @returns Exact detached static rollback binding.
 */
function createPartialRollbackOperationBinding(
  configurationValue: unknown,
  configurationHashValue: unknown,
  executionBoundaryValue: unknown,
  sealedPlanningAuthorityValue: unknown,
  closedWriterFenceRecordValue: unknown,
  executionRunValue: unknown,
): PartialRollbackOperationBinding {
  const configuration =
    detachWorkspaceSearchMigrationPlanningConfiguration(
      configurationValue,
    )
  const configurationHash = readDigest(
    configurationHashValue,
    'INVALID_ARGUMENT',
  )
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failPartialRollbackOperation(
      'CONFIGURATION_HASH_MISMATCH',
    )
  }
  const executionBoundary =
    parseWorkspaceSearchMigrationExecutionBoundary(
      serializeWorkspaceSearchMigrationExecutionBoundary(
        requireExecutionBoundary(executionBoundaryValue),
      ),
    )
  if (executionBoundary.phase !== 'planning-admitted') {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  const sealedPlanningAuthority =
    parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        requireSealedPlanningAuthority(
          sealedPlanningAuthorityValue,
        ),
      ),
    )
  const closedWriterFenceRecord =
    readWorkspaceSearchWriterFenceClosedRecord(
      requireClosedWriterFenceRecord(
        closedWriterFenceRecordValue,
      ),
    )
  const executionRun =
    parseWorkspaceSearchMigrationExecutionRun(
      serializeWorkspaceSearchMigrationExecutionRun(
        requireExecutionRun(executionRunValue),
      ),
    )
  const stateTable = configuration.tables['migration-state']
  const targetTable = configuration.tables['workspace-search']
  const tableIds = createPartialRollbackTableIds(configuration)
  const writerFence = createWorkspaceSearchWriterFenceBinding({
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
    tableIds,
  })
  if (
    executionBoundary.configurationHash !== configurationHash ||
    sealedPlanningAuthority.configurationHash !==
      configurationHash ||
    executionRun.configurationHash !== configurationHash ||
    executionBoundary.runId !== sealedPlanningAuthority.runId ||
    executionBoundary.runId !== executionRun.runId ||
    executionRun.binding.executionBoundaryDigest !==
      executionBoundary.boundaryDigest ||
    executionRun.binding.closedWriterFenceRecordDigest !==
      closedWriterFenceRecord.recordDigest ||
    executionRun.binding.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthority.authorityDigest ||
    executionRun.binding.planDigest !==
      sealedPlanningAuthority.planDigest ||
    executionRun.binding.planOperationCount !==
      sealedPlanningAuthority.planOperationCount ||
    closedWriterFenceRecord.binding.recordKey !==
      writerFence.recordKey
  ) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      executionBoundary.tableIds[role] !== tableIds[role] ||
      sealedPlanningAuthority.tableIds[role] !== tableIds[role] ||
      executionRun.binding.tableIds[role] !== tableIds[role] ||
      closedWriterFenceRecord.binding.tableIds[role] !==
        tableIds[role]
    ) {
      return failPartialRollbackOperation(
        'CONFIGURATION_DRIFT',
      )
    }
  }
  createWorkspaceSearchWriterFenceClosedConditionCheck(
    closedWriterFenceRecord,
    writerFence,
  )
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
    {
      stateTable,
      configurationHash,
      boundary: executionBoundary,
    },
  )
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
    stateTable,
    configurationHash,
    authority: sealedPlanningAuthority,
  })
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
    stateTable,
    configurationHash,
    executionRun,
  })
  return {
    configurationHash,
    stateTable,
    targetTable,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    bindingDigest:
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: stateTable.tableId,
        configurationHash,
        runId: executionRun.runId,
        executionRunDigest: executionRun.executionRunDigest,
      }).bindingDigest,
  }
}

/**
 * Projects all six measured table identifiers.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed identifiers.
 */
function createPartialRollbackTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceTableIds {
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
 * Captures dependency methods without retaining mutable public properties.
 *
 * @param binding - Exact static rollback binding.
 * @param authorityPortValue - Candidate authority reader.
 * @param lifecycleBindingValue - Candidate lifecycle persistence capability.
 * @param journalGatewayValue - Candidate exact journal gateway.
 * @param applyReceiptBindingValue - Candidate apply-receipt capability.
 * @param transportValue - Candidate rollback transport.
 * @param clockValue - Candidate trusted clock.
 * @returns Captured narrow dependencies.
 */
function preparePartialRollbackOperationDependencies(
  binding: PartialRollbackOperationBinding,
  authorityPortValue: unknown,
  lifecycleBindingValue: unknown,
  journalGatewayValue: unknown,
  applyReceiptBindingValue: unknown,
  transportValue: unknown,
  clockValue: unknown,
): PreparedPartialRollbackOperationDependencies {
  const authorityPort =
    requireDependencyObject(authorityPortValue)
  const lifecycleBinding =
    requireDependencyObject(lifecycleBindingValue)
  const journalGateway =
    requireDependencyObject(journalGatewayValue)
  const applyReceiptBinding =
    requireDependencyObject(applyReceiptBindingValue)
  const transport = requireDependencyObject(transportValue)
  const readAuthority = readCallableMethod(
    authorityPort,
    'readAuthority',
  )
  const readLifecycleBindingIdentity = readCallableMethod(
    lifecycleBinding,
    'readBindingIdentity',
  )
  const readLifecycle = readCallableMethod(
    lifecycleBinding,
    'readRollbackLifecycle',
  )
  const createStartGuard = readCallableMethod(
    lifecycleBinding,
    'createStartRootConditionCheck',
  )
  const createStateTransition = readCallableMethod(
    lifecycleBinding,
    'createRollbackStateTransitionPut',
  )
  const createRootPut = readCallableMethod(
    lifecycleBinding,
    'createRolledBackRootAbsentPut',
  )
  const readJournal = readCallableMethod(
    journalGateway,
    'readJournalSegment',
  )
  const createApplySequenceRead = readCallableMethod(
    applyReceiptBinding,
    'createJournalSequenceStrongReadCommand',
  )
  const parseApplySequence = readCallableMethod(
    applyReceiptBinding,
    'parseJournalSequenceStrongReadOutput',
  )
  const createApplyMarkerRead = readCallableMethod(
    applyReceiptBinding,
    'createOperationMarkerStrongReadCommand',
  )
  const parseApplyMarker = readCallableMethod(
    applyReceiptBinding,
    'parseOperationMarkerStrongReadOutput',
  )
  const correlateApplyRows = readCallableMethod(
    applyReceiptBinding,
    'correlateRows',
  )
  const createApplySequenceGuard = readCallableMethod(
    applyReceiptBinding,
    'createJournalSequenceConditionCheck',
  )
  const createApplyMarkerGuard = readCallableMethod(
    applyReceiptBinding,
    'createOperationMarkerConditionCheck',
  )
  const readApplyBindingIdentity = readCallableMethod(
    applyReceiptBinding,
    'readBindingIdentity',
  )
  const get = readCallableMethod(
    transport,
    'getPartialRollbackOperationItem',
  )
  const prepare = readCallableMethod(
    transport,
    'preparePartialRollbackOperationWrite',
  )
  const transact = readCallableMethod(
    transport,
    'transactWritePartialRollbackOperation',
  )
  if (
    !isCallable<
      PreparedPartialRollbackOperationDependencies['readAuthority']
    >(readAuthority) ||
    !isCallable<
      WorkspaceSearchMigrationPartialRollbackLifecycleAwsBinding[
        'readBindingIdentity'
      ]
    >(readLifecycleBindingIdentity) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['readLifecycle']
    >(readLifecycle) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['createStartGuard']
    >(createStartGuard) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'createStateTransition'
      ]
    >(createStateTransition) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['createRootPut']
    >(createRootPut) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['readJournal']
    >(readJournal) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'createApplySequenceRead'
      ]
    >(createApplySequenceRead) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'parseApplySequence'
      ]
    >(parseApplySequence) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'createApplyMarkerRead'
      ]
    >(createApplyMarkerRead) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['parseApplyMarker']
    >(parseApplyMarker) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['correlateApplyRows']
    >(correlateApplyRows) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'createApplySequenceGuard'
      ]
    >(createApplySequenceGuard) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies[
        'createApplyMarkerGuard'
      ]
    >(createApplyMarkerGuard) ||
    !isCallable<
      WorkspaceSearchMigrationApplyReceiptAwsBinding[
        'readBindingIdentity'
      ]
    >(readApplyBindingIdentity) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['get']
    >(get) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['prepare']
    >(prepare) ||
    !isCallable<
      PreparedPartialRollbackOperationDependencies['transact']
    >(transact)
  ) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  requireLifecycleBindingIdentity(
    binding,
    Reflect.apply(
      readLifecycleBindingIdentity,
      lifecycleBinding,
      [],
    ),
  )
  requireApplyReceiptBindingIdentity(
    binding,
    Reflect.apply(
      readApplyBindingIdentity,
      applyReceiptBinding,
      [],
    ),
  )
  return {
    readAuthority: readAuthority.bind(authorityPort),
    readLifecycle: readLifecycle.bind(lifecycleBinding),
    createStartGuard: createStartGuard.bind(lifecycleBinding),
    createStateTransition:
      createStateTransition.bind(lifecycleBinding),
    createRootPut: createRootPut.bind(lifecycleBinding),
    readJournal: readJournal.bind(journalGateway),
    createApplySequenceRead:
      createApplySequenceRead.bind(applyReceiptBinding),
    parseApplySequence:
      parseApplySequence.bind(applyReceiptBinding),
    createApplyMarkerRead:
      createApplyMarkerRead.bind(applyReceiptBinding),
    parseApplyMarker:
      parseApplyMarker.bind(applyReceiptBinding),
    correlateApplyRows:
      correlateApplyRows.bind(applyReceiptBinding),
    createApplySequenceGuard:
      createApplySequenceGuard.bind(applyReceiptBinding),
    createApplyMarkerGuard:
      createApplyMarkerGuard.bind(applyReceiptBinding),
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
    clock: snapshotClock(clockValue),
  }
}

/**
 * Creates one complete immutable v2 reverse-receipt DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param receipt - Strict durable reverse receipt.
 * @returns Complete bounded low-level row.
 */
function createRollbackReceiptRecord(
  binding: PartialRollbackOperationBinding,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): Readonly<Record<string, AttributeValue>> {
  requireReceiptBinding(binding, receipt)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
        binding.bindingDigest,
        receipt.sequence,
      ),
    },
    recordVersion: {
      N: String(partialRollbackOperationRecordVersion),
    },
    kind: { S: rollbackReceiptRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
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
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one immutable v2 reverse-receipt DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param sequence - Exact expected positive sequence.
 * @param value - Untrusted low-level row.
 * @returns Strict detached reverse receipt.
 */
function parseRollbackReceiptRecord(
  binding: PartialRollbackOperationBinding,
  sequence: number,
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationReceiptV2 {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rollbackReceiptRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rollbackReceiptRecordKind,
    createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
      binding.bindingDigest,
      sequence,
    ),
  )
  const receipt =
    parseWorkspaceSearchMigrationRollbackOperationReceiptV2(
      readBinaryAttribute(item, 'receiptBytes'),
    )
  if (
    readPositiveSafeIntegerAttribute(item, 'sequence') !==
      sequence ||
    receipt.sequence !== sequence ||
    readDigestAttribute(item, 'originDigest') !==
      receipt.originDigest ||
    readDigestAttribute(item, 'startRootDigest') !==
      receipt.startRootDigest ||
    readDigestAttribute(item, 'commandDigest') !==
      receipt.commandDigest ||
    readDigestAttribute(item, 'receiptDigest') !==
      receipt.receiptDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireReceiptBinding(binding, receipt)
  requireAttributeMapsEqual(
    item,
    createRollbackReceiptRecord(binding, receipt),
  )
  return receipt
}

/**
 * Builds the fixed thirteen-item committed-prefix reverse transaction.
 *
 * @param input - Exact authority, predecessor, target, and successor material.
 * @returns Adapter-owned idempotent transaction command.
 */
function createPartialRollbackOperationTransactionCommand(
  input: CreatePartialRollbackOperationTransactionCommandInput,
): TransactWriteItemsCommand {
  if (
    input.receipt.predecessorStateDigest !==
      input.predecessorState.stateDigest ||
    input.receipt.successorStateDigest !==
      input.successorState.stateDigest ||
    input.receipt.sequence !== input.applySequence.receipt.sequence
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  const authorityChecks = createAuthorityChecks(
    input.binding,
    input.currentAuthority,
    input.commitAt,
  )
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      input.binding.closedWriterFenceRecord,
      input.binding.writerFence,
    ),
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: input.binding.stateTable,
        configurationHash: input.binding.configurationHash,
        boundary: input.binding.executionBoundary,
      },
    ),
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.binding.sealedPlanningAuthority,
    }),
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
    }),
    requireConditionCheck(
      input.dependencies.createStartGuard(input.startRoot),
    ),
    requirePut(
      input.dependencies.createStateTransition(
        input.predecessorState,
        input.successorState,
      ),
    ),
    requireConditionCheck(input.applySequenceGuard),
    requireConditionCheck(input.applyMarkerGuard),
    createRollbackTargetTransactionItem(
      input.binding.targetTable.tableName,
      input.restorationBefore,
      input.targetCondition,
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRollbackReceiptRecord(
        input.binding,
        input.receipt,
      ),
    ),
  ]
  requireTransactionCount(
    items,
    workspaceSearchMigrationPartialRollbackOperationTransactionIndex
      .count,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind:
        'workspace-search-migration-partial-rollback-operation-transaction',
      version: partialRollbackOperationRecordVersion,
      commandDigest: input.receipt.commandDigest,
      receiptDigest: input.receipt.receiptDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Builds the fixed ten-item committed-prefix rollback finish transaction.
 *
 * @param input - Exact authority, zero-head state, and immutable root.
 * @returns Adapter-owned idempotent terminal transaction.
 */
function createPartialRollbackFinishTransactionCommand(
  input: CreatePartialRollbackFinishTransactionCommandInput,
): TransactWriteItemsCommand {
  if (
    input.root.terminalState.predecessorDigest !==
      input.predecessorState.stateDigest ||
    input.root.terminalState.revision !==
      input.predecessorState.revision + 1
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  const authorityChecks = createAuthorityChecks(
    input.binding,
    input.currentAuthority,
    input.commitAt,
  )
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      input.binding.closedWriterFenceRecord,
      input.binding.writerFence,
    ),
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: input.binding.stateTable,
        configurationHash: input.binding.configurationHash,
        boundary: input.binding.executionBoundary,
      },
    ),
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.binding.sealedPlanningAuthority,
    }),
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
    }),
    requireConditionCheck(
      input.dependencies.createStartGuard(input.startRoot),
    ),
    requirePut(
      input.dependencies.createStateTransition(
        input.predecessorState,
        input.root.terminalState,
      ),
    ),
    requirePut(
      input.dependencies.createRootPut(input.root),
    ),
  ]
  requireTransactionCount(
    items,
    workspaceSearchMigrationPartialRollbackFinishTransactionIndex
      .count,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind:
        'workspace-search-migration-partial-rollback-finish-transaction',
      version: partialRollbackOperationRecordVersion,
      rootDigest: input.root.rootDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Creates the three fixed current-authority checks.
 *
 * @param binding - Exact static rollback binding.
 * @param authority - Fresh current authority.
 * @param commitAt - Adapter-owned final commit time.
 * @returns Lease, pointer, and receipt checks in fixed order.
 */
function createAuthorityChecks(
  binding: PartialRollbackOperationBinding,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  commitAt: Date,
): readonly [TransactWriteItem, TransactWriteItem, TransactWriteItem] {
  return createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks(
    {
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt,
    },
  )
}

/**
 * Creates one deterministic absent-row Put.
 *
 * @param tableName - Exact measured state table name.
 * @param item - Complete adapter-owned row.
 * @returns Absent-item conditional Put.
 */
function createAbsentPut(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  validateDynamoDbItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: cloneLowLevelMap(item, 'INVALID_STATE'),
      ConditionExpression:
        'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#migrationId': 'migrationId',
        '#recordKey': 'recordKey',
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates target restoration as a conditional Put or Delete.
 *
 * @param tableName - Exact measured Workspace Search table name.
 * @param before - Exact pre-apply target snapshot.
 * @param material - Exact post-apply CAS material.
 * @returns Fixed-position target restoration item.
 */
function createRollbackTargetTransactionItem(
  tableName: string,
  before: MigrationItemSnapshot,
  material: WorkspaceSearchMigrationItemConditionMaterial,
): TransactWriteItem {
  if (before.exists) {
    const item = cloneLowLevelMap(
      before.item,
      'INVALID_ARGUMENT',
    )
    validateDynamoDbItemSize(item)
    return {
      Put: {
        TableName: tableName,
        Item: item,
        ...createConditionFields(material),
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    }
  }
  return {
    Delete: {
      TableName: tableName,
      Key: cloneLowLevelMap(material.Key, 'INVALID_ARGUMENT'),
      ...createConditionFields(material),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Copies bounded CAS condition fields while preserving optional values.
 *
 * @param material - Exact target CAS material.
 * @returns Exact transaction condition operands.
 */
function createConditionFields(
  material: WorkspaceSearchMigrationItemConditionMaterial,
): {
  /** Exact condition expression. */
  readonly ConditionExpression: string
  /** Exact name substitutions. */
  readonly ExpressionAttributeNames:
    Readonly<Record<string, string>>
  /** Optional exact value substitutions. */
  readonly ExpressionAttributeValues?:
    Readonly<Record<string, AttributeValue>>
} {
  return material.ExpressionAttributeValues === undefined
    ? {
        ConditionExpression: material.ConditionExpression,
        ExpressionAttributeNames:
          material.ExpressionAttributeNames,
      }
    : {
        ConditionExpression: material.ConditionExpression,
        ExpressionAttributeNames:
          material.ExpressionAttributeNames,
        ExpressionAttributeValues:
          material.ExpressionAttributeValues,
      }
}

/**
 * Requires a capability-returned transaction item to be a ConditionCheck.
 *
 * @param value - Candidate transaction guard.
 * @returns Exact condition-only transaction item.
 */
function requireConditionCheck(
  value: TransactWriteItem,
): TransactWriteItem {
  if (
    !isOrdinaryObject(value) ||
    Object.keys(value).length !== 1 ||
    value.ConditionCheck === undefined
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return value
}

/**
 * Requires a capability-returned transaction item to be a Put.
 *
 * @param value - Candidate transaction mutation.
 * @returns Exact Put-only transaction item.
 */
function requirePut(
  value: TransactWriteItem,
): TransactWriteItem {
  if (
    !isOrdinaryObject(value) ||
    Object.keys(value).length !== 1 ||
    value.Put === undefined
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return value
}

/**
 * Requires one fixed transaction item count.
 *
 * @param items - Candidate fixed-order items.
 * @param expected - Exact expected count.
 */
function requireTransactionCount(
  items: readonly TransactWriteItem[],
  expected: number,
): void {
  if (items.length !== expected) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Creates one strongly consistent migration-state row read.
 *
 * @param binding - Exact static rollback binding.
 * @param recordKey - Exact deterministic record key.
 * @returns Adapter-owned strongly consistent read command.
 */
function createStrongStateReadCommand(
  binding: PartialRollbackOperationBinding,
  recordKey: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTable.tableName,
    ConsistentRead: true,
    Key: createStateKey(recordKey),
  })
}

/**
 * Creates one strongly consistent target item read.
 *
 * @param table - Exact measured target table.
 * @param key - Exact physical target key.
 * @returns Adapter-owned strongly consistent read command.
 */
function createStrongReadCommand(
  table: MigrationTableIdentity,
  key: Readonly<Record<string, AttributeValue>>,
): GetItemCommand {
  return new GetItemCommand({
    TableName: table.tableName,
    ConsistentRead: true,
    Key: cloneLowLevelMap(key, 'INVALID_ARGUMENT'),
  })
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
 * Detaches one caller command before any asynchronous boundary.
 *
 * @param input - Candidate operation command.
 * @returns Exact detached command.
 */
function preparePartialRollbackOperationCommand(
  input: WorkspaceSearchMigrationRollbackCommandInput,
): PreparedPartialRollbackOperationCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(
    record,
    ['authority', 'expectedRevision'],
    'INVALID_ARGUMENT',
  )
  return {
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    authority: readRollbackAuthorityClaim(
      readOwn(record, 'authority', 'INVALID_ARGUMENT'),
    ),
  }
}

/**
 * Detaches one exact current-authority claim.
 *
 * @param value - Candidate authority claim.
 * @returns Exact detached authority claim.
 */
function readRollbackAuthorityClaim(
  value: unknown,
): WorkspaceSearchMigrationRollbackAuthorityClaim {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
  ], 'INVALID_ARGUMENT')
  return {
    lease: readLeaseClaim(
      readOwn(record, 'lease', 'INVALID_ARGUMENT'),
    ),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(
        readOwn(
          record,
          'maintenanceEvidencePointerRevision',
          'INVALID_ARGUMENT',
        ),
        'INVALID_ARGUMENT',
      ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ),
  }
}

/**
 * Requires one exact active lease identity.
 *
 * @param value - Candidate lease claim.
 * @returns Detached exact claim.
 */
function readLeaseClaim(
  value: unknown,
): WorkspaceSearchMigrationLeaseClaim {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(
    record,
    ['fenceToken', 'ownerId', 'runId'],
    'INVALID_ARGUMENT',
  )
  return {
    runId: readIdentifier(
      readOwn(record, 'runId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    ownerId: readIdentifier(
      readOwn(record, 'ownerId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
  }
}

/**
 * Derives the next reverse sequence solely from start and expected revision.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param expectedRevision - Caller-selected durable predecessor revision.
 * @returns Exact positive forward sequence restored by this command.
 */
function deriveRollbackSequence(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  expectedRevision: number,
): number {
  const offset =
    expectedRevision - startRoot.initialState.revision
  const sequence =
    startRoot.originalJournalSequence - offset
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > startRoot.originalJournalSequence
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return sequence
}

/**
 * Requires a lifecycle snapshot to match the exact admitted static binding.
 *
 * @param binding - Exact static rollback binding.
 * @param lifecycle - Candidate shared lifecycle snapshot.
 */
function requireLifecycleBinding(
  binding: PartialRollbackOperationBinding,
  lifecycle: WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
): void {
  const { startRoot, state, rolledBackRoot } = lifecycle
  requireStartRootBinding(binding, startRoot)
  requireStateBinding(binding, state)
  requireStateDescendsFromStart(startRoot, state)
  if (state.status === 'rolling-back') {
    if (rolledBackRoot !== undefined) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    return
  }
  if (
    rolledBackRoot === undefined ||
    rolledBackRoot.startRootDigest !== startRoot.startRootDigest ||
    rolledBackRoot.originDigest !== startRoot.originDigest ||
    rolledBackRoot.rollbackStartedAt !== startRoot.startedAt ||
    rolledBackRoot.terminalStateDigest !== state.stateDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireRootBinding(binding, rolledBackRoot)
}

/**
 * Requires a lifecycle not to have published its terminal root.
 *
 * @param lifecycle - Exact coherent lifecycle snapshot.
 */
function requireNoTerminalRoot(
  lifecycle: WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
): void {
  if (
    lifecycle.rolledBackRoot !== undefined ||
    lifecycle.state.status !== 'rolling-back'
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires one mutable state to belong to and descend from a start root.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Candidate current rollback state.
 */
function requireStateDescendsFromStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
    startRoot.currentAuthority,
    state.currentAuthority,
  )
  requireStartAndStateBinding(startRoot, state)
  const revisionOffset =
    state.revision - startRoot.initialState.revision
  if (state.status === 'rolled-back') {
    if (
      state.startRootDigest !== startRoot.startRootDigest ||
      state.upperBoundSequence !==
        startRoot.originalJournalSequence ||
      state.restored !== state.upperBoundSequence ||
      state.nextSequence !== 0 ||
      state.revision !==
        startRoot.initialState.revision +
          state.upperBoundSequence + 1
    ) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    return
  }
  if (
    state.status !== 'rolling-back' ||
    state.startRootDigest !== startRoot.startRootDigest ||
    !Number.isSafeInteger(revisionOffset) ||
    revisionOffset < 0 ||
    state.upperBoundSequence !==
      startRoot.originalJournalSequence ||
    state.restored !== revisionOffset ||
    state.nextSequence !==
      state.upperBoundSequence - state.restored ||
    (
      revisionOffset === 0 &&
      state.stateDigest !==
        startRoot.initialState.stateDigest
    )
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires a state to be the exact caller-selected reverse predecessor.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Strongly read current state.
 * @param command - Detached caller command.
 * @param sequence - Adapter-derived reverse sequence.
 */
function requireExactRollbackPredecessor(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  command: PreparedPartialRollbackOperationCommand,
  sequence: number,
): void {
  requireStateDescendsFromStart(startRoot, state)
  if (
    state.status !== 'rolling-back' ||
    state.revision !== command.expectedRevision ||
    state.nextSequence !== sequence ||
    state.nextSequence < 1
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires one existing receipt to identify the exact retried command.
 *
 * @param command - Detached retry command.
 * @param startRoot - Exact immutable start root.
 * @param receipt - Candidate deterministic receipt.
 */
function requireReceiptMatchesCommand(
  command: PreparedPartialRollbackOperationCommand,
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  requireReceiptBelongsToStart(startRoot, receipt)
  const expectedSequence = deriveRollbackSequence(
    startRoot,
    command.expectedRevision,
  )
  if (
    receipt.sequence !== expectedSequence ||
    receipt.predecessorRevision !== command.expectedRevision ||
    receipt.successorRevision !== command.expectedRevision + 1 ||
    receipt.currentAuthority.ownerId !==
      command.authority.lease.ownerId ||
    receipt.currentAuthority.fenceToken !==
      command.authority.lease.fenceToken ||
    receipt.currentAuthority.maintenanceEvidencePointerRevision !==
      command.authority.maintenanceEvidencePointerRevision ||
    receipt.currentAuthority.maintenanceEvidenceReceiptDigest !==
      command.authority.maintenanceEvidenceReceiptDigest ||
    receipt.runId !== command.authority.lease.runId
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires a committed reverse-step winner to match a deterministic command.
 *
 * @param intendedReceipt - Locally constructed attempted receipt.
 * @param intendedState - Locally constructed attempted successor state.
 * @param committedReceipt - Strongly read committed receipt.
 */
function requireReceiptIsLogicalWinner(
  intendedReceipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
  intendedState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  committedReceipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  if (
    committedReceipt.commandDigest !== intendedReceipt.commandDigest ||
    committedReceipt.predecessorStateDigest !==
      intendedReceipt.predecessorStateDigest ||
    committedReceipt.applyReceiptDigest !==
      intendedReceipt.applyReceiptDigest ||
    committedReceipt.journalReferenceDigest !==
      intendedReceipt.journalReferenceDigest ||
    committedReceipt.previousJournalHeadDigest !==
      intendedReceipt.previousJournalHeadDigest ||
    committedReceipt.predecessorRevision !==
      intendedReceipt.predecessorRevision ||
    committedReceipt.successorRevision !== intendedState.revision ||
    committedReceipt.operationId !== intendedReceipt.operationId ||
    committedReceipt.sequence !== intendedReceipt.sequence
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires an immutable receipt to occupy its exact start-root sequence slot.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param receipt - Candidate immutable reverse receipt.
 */
function requireReceiptBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
    startRoot.currentAuthority,
    receipt.currentAuthority,
  )
  const expectedPredecessorRevision =
    startRoot.initialState.revision +
      startRoot.originalJournalSequence - receipt.sequence
  if (
    receipt.startRootDigest !== startRoot.startRootDigest ||
    receipt.originDigest !== startRoot.originDigest ||
    receipt.sequence < 1 ||
    receipt.sequence > startRoot.originalJournalSequence ||
    receipt.predecessorRevision !==
      expectedPredecessorRevision ||
    receipt.successorRevision !==
      expectedPredecessorRevision + 1
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires current state to be the receipt successor or a later descendant.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Strongly read current state.
 * @param receipt - Exact earlier immutable receipt.
 */
function requireStateAtOrAfterReceipt(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  requireStateDescendsFromStart(startRoot, state)
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
    receipt.currentAuthority,
    state.currentAuthority,
  )
  const restoredThroughReceipt =
    startRoot.originalJournalSequence - receipt.sequence + 1
  if (
    state.revision < receipt.successorRevision ||
    state.restored < restoredThroughReceipt ||
    state.nextSequence >= receipt.sequence ||
    (
      state.revision === receipt.successorRevision &&
      state.stateDigest !== receipt.successorStateDigest
    )
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Correlates the deterministic final receipt row with a terminal root.
 *
 * The terminal root is the authoritative immutable publication. Once it is
 * present, sequence one must be either absent for a zero-mutation rollback or
 * byte-for-byte identical to the receipt embedded by that root.
 *
 * @param lifecycle - Exact coherent terminal or in-progress lifecycle.
 * @param sequence - Deterministic receipt sequence being read.
 * @param receipt - Independently read receipt row when present.
 */
function requireTerminalReceiptCorrelation(
  lifecycle: WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
  sequence: number,
  receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | undefined,
): void {
  const root = lifecycle.rolledBackRoot
  if (root === undefined || sequence !== 1) return
  const terminalReceipt = root.terminalReceipt
  if (lifecycle.startRoot.originalJournalSequence === 0) {
    if (
      terminalReceipt !== null ||
      root.terminalReceiptDigest !== null ||
      receipt !== undefined
    ) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    return
  }
  if (
    terminalReceipt === null ||
    receipt === undefined ||
    root.terminalReceiptDigest !== terminalReceipt.receiptDigest ||
    receipt.receiptDigest !== terminalReceipt.receiptDigest ||
    Buffer.compare(
      Buffer.from(
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          receipt,
        ),
      ),
      Buffer.from(
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          terminalReceipt,
        ),
      ),
    ) !== 0
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires exact zero-head mutable state for terminal publication.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Strongly read current state.
 * @param command - Detached finish command.
 */
function requireFinishPredecessor(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  command: PreparedPartialRollbackOperationCommand,
): void {
  requireStateDescendsFromStart(startRoot, state)
  if (
    state.status !== 'rolling-back' ||
    state.revision !== command.expectedRevision ||
    state.nextSequence !== 0 ||
    state.restored !== state.upperBoundSequence
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires an existing terminal root to match an exact finish retry.
 *
 * @param root - Existing immutable terminal root.
 * @param command - Detached caller finish command.
 */
function requireRootMatchesFinishCommand(
  root: WorkspaceSearchMigrationRolledBackRootV2,
  command: PreparedPartialRollbackOperationCommand,
): void {
  if (
    root.terminalState.status !== 'rolled-back' ||
    root.terminalState.revision !==
      command.expectedRevision + 1 ||
    root.terminalState.nextSequence !== 0 ||
    root.finalAuthority.ownerId !==
      command.authority.lease.ownerId ||
    root.finalAuthority.fenceToken !==
      command.authority.lease.fenceToken ||
    root.finalAuthority.maintenanceEvidencePointerRevision !==
      command.authority.maintenanceEvidencePointerRevision ||
    root.finalAuthority.maintenanceEvidenceReceiptDigest !==
      command.authority.maintenanceEvidenceReceiptDigest ||
    root.runId !== command.authority.lease.runId
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires a committed finish winner to preserve time-independent root links.
 *
 * @param command - Detached caller finish command.
 * @param intended - Locally constructed attempted terminal root.
 * @param committed - Strongly read committed terminal root.
 */
function requireRootIsLogicalWinner(
  command: PreparedPartialRollbackOperationCommand,
  intended: WorkspaceSearchMigrationRolledBackRootV2,
  committed: WorkspaceSearchMigrationRolledBackRootV2,
): void {
  requireRootMatchesFinishCommand(committed, command)
  if (
    committed.startRootDigest !== intended.startRootDigest ||
    committed.originDigest !== intended.originDigest ||
    committed.rollbackStartedAt !== intended.rollbackStartedAt ||
    committed.terminalState.predecessorDigest !==
      intended.terminalState.predecessorDigest ||
    committed.terminalReceiptDigest !==
      intended.terminalReceiptDigest ||
    committed.terminalState.revision !==
      intended.terminalState.revision
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires one start and state to share every immutable chain binding.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Candidate rollback state.
 */
function requireStartAndStateBinding(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  if (
    state.runId !== startRoot.runId ||
    state.configurationHash !== startRoot.configurationHash ||
    state.executionRunDigest !==
      startRoot.executionRunDigest ||
    state.originDigest !== startRoot.originDigest ||
    state.sealedPlanningAuthorityDigest !==
      startRoot.sealedPlanningAuthorityDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireTableIdsEqual(startRoot.tableIds, state.tableIds)
}

/**
 * Requires a rollback start root to match the static admitted run.
 *
 * @param binding - Exact static rollback binding.
 * @param root - Candidate strict start root.
 */
function requireStartRootBinding(
  binding: PartialRollbackOperationBinding,
  root: WorkspaceSearchMigrationRollbackStartRootV2,
): void {
  if (
    root.runId !== binding.executionRun.runId ||
    root.configurationHash !== binding.configurationHash ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireTableIdsEqual(
    binding.executionRun.binding.tableIds,
    root.tableIds,
  )
}

/**
 * Requires a rollback state to match the static admitted run.
 *
 * @param binding - Exact static rollback binding.
 * @param state - Candidate strict rollback state.
 */
function requireStateBinding(
  binding: PartialRollbackOperationBinding,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  if (
    state.runId !== binding.executionRun.runId ||
    state.configurationHash !== binding.configurationHash ||
    state.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    state.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireTableIdsEqual(
    binding.executionRun.binding.tableIds,
    state.tableIds,
  )
}

/**
 * Requires a rollback receipt to match the static admitted run.
 *
 * @param binding - Exact static rollback binding.
 * @param receipt - Candidate strict reverse receipt.
 */
function requireReceiptBinding(
  binding: PartialRollbackOperationBinding,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  if (
    receipt.runId !== binding.executionRun.runId ||
    receipt.configurationHash !== binding.configurationHash ||
    receipt.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    receipt.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireTableIdsEqual(
    binding.executionRun.binding.tableIds,
    receipt.tableIds,
  )
}

/**
 * Requires a terminal root to match the static admitted run.
 *
 * @param binding - Exact static rollback binding.
 * @param root - Candidate strict terminal root.
 */
function requireRootBinding(
  binding: PartialRollbackOperationBinding,
  root: WorkspaceSearchMigrationRolledBackRootV2,
): void {
  if (
    root.runId !== binding.executionRun.runId ||
    root.configurationHash !== binding.configurationHash ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest ||
    root.terminalState.startRootDigest !== root.startRootDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  requireTableIdsEqual(
    binding.executionRun.binding.tableIds,
    root.tableIds,
  )
  requireStateBinding(binding, root.terminalState)
}

/**
 * Requires exact table-incarnation equality across rollback evidence.
 *
 * @param expected - Exact admitted table identifiers.
 * @param actual - Candidate rollback table identifiers.
 */
function requireTableIdsEqual(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): void {
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (expected[role] !== actual[role]) {
      return failPartialRollbackOperation(
        'CONFIGURATION_DRIFT',
      )
    }
  }
}

/**
 * Requires journal bytes to match the correlated immutable apply receipt.
 *
 * @param receipt - Exact correlated forward apply receipt.
 * @param segment - Exact-version immutable journal segment.
 * @param restoration - Strict decoded target material.
 */
function requireJournalMatchesApplyReceipt(
  receipt:
    WorkspaceSearchMigrationApplySequenceReceiptAwsProjection['receipt'],
  segment: Awaited<ReturnType<
    WorkspaceSearchMigrationJournalAwsGateway['readJournalSegment']
  >>,
  restoration: {
    /** Exact physical target key. */
    readonly targetKey: Readonly<Record<string, AttributeValue>>
    /** Exact target preimage. */
    readonly before: MigrationItemSnapshot
    /** Exact post-apply state. */
    readonly after: MigrationItemSnapshot
  },
): void {
  if (
    receipt.runId !== segment.runId ||
    receipt.configurationHash !== segment.configurationHash ||
    receipt.sequence !== segment.sequence ||
    receipt.operationId !== segment.operationId ||
    receipt.targetKeyDigest !== segment.targetKeyDigest ||
    receipt.beforeDigest !== restoration.before.digest ||
    receipt.afterDigest !== restoration.after.digest ||
    receipt.beforeDigest === receipt.afterDigest
  ) {
    return failPartialRollbackOperation('INVALID_JOURNAL')
  }
}

/**
 * Requires the selected journal version to remain commit-safe.
 *
 * @param retainUntil - Exact immutable object retention deadline.
 * @param commitAt - Adapter-owned final transaction time.
 */
function requireRollbackJournalRetention(
  retainUntil: string,
  commitAt: Date,
): void {
  if (
    !isCanonicalTimestamp(retainUntil) ||
    Date.parse(retainUntil) - commitAt.getTime() <=
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  ) {
    return failPartialRollbackOperation('INVALID_JOURNAL')
  }
}

/**
 * Requires resolved authority to match the exact caller claim.
 *
 * @param claim - Detached caller authority identity.
 * @param authority - Fresh durable authority.
 */
function requireAuthorityClaimMatchesAuthority(
  claim: WorkspaceSearchMigrationRollbackAuthorityClaim,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  if (
    authority.lease.runId !== claim.lease.runId ||
    authority.lease.ownerId !== claim.lease.ownerId ||
    authority.lease.fenceToken !== claim.lease.fenceToken
  ) {
    return failPartialRollbackOperation('LEASE_LOST')
  }
  if (
    authority.maintenanceEvidencePointerRevision !==
      claim.maintenanceEvidencePointerRevision ||
    authority.maintenanceEvidenceReceiptDigest !==
      claim.maintenanceEvidenceReceiptDigest
  ) {
    return failPartialRollbackOperation(
      'INVALID_MAINTENANCE_EVIDENCE',
    )
  }
}

/**
 * Requires a lifecycle capability to share the exact rollback namespace.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Candidate lifecycle capability identity.
 */
function requireLifecycleBindingIdentity(
  binding: PartialRollbackOperationBinding,
  value: unknown,
): void {
  requireCapabilityBindingIdentity(
    binding,
    value,
    binding.bindingDigest,
  )
}

/**
 * Requires an apply-receipt capability to share the admitted namespace.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Candidate capability identity.
 */
function requireApplyReceiptBindingIdentity(
  binding: PartialRollbackOperationBinding,
  value: unknown,
): void {
  requireCapabilityBindingIdentity(
    binding,
    value,
    createWorkspaceSearchMigrationApplyRunBindingDigest({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      executionRun: binding.executionRun,
    }),
  )
}

/**
 * Requires one capability identity to share the admitted run namespace.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Candidate capability identity.
 * @param expectedBindingDigest - Exact expected capability namespace.
 */
function requireCapabilityBindingIdentity(
  binding: PartialRollbackOperationBinding,
  value: unknown,
  expectedBindingDigest: string,
): void {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'bindingDigest',
    'configurationHash',
    'executionRunDigest',
    'runId',
    'stateTableId',
  ], 'INVALID_ARGUMENT')
  if (
    readIdentifier(
      readOwn(record, 'stateTableId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ) !== binding.stateTable.tableId ||
    readDigest(
      readOwn(
        record,
        'configurationHash',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ) !== binding.configurationHash ||
    readIdentifier(
      readOwn(record, 'runId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ) !== binding.executionRun.runId ||
    readDigest(
      readOwn(
        record,
        'executionRunDigest',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ) !== binding.executionRun.executionRunDigest ||
    readDigest(
      readOwn(record, 'bindingDigest', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ) !== expectedBindingDigest
  ) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
}

/**
 * Reads one fresh trusted adapter time.
 *
 * @param clock - Captured receiver-independent clock.
 * @returns Exact fresh valid Date.
 */
function readClock(clock: () => Date): Date {
  const value = clock()
  if (
    nodeUtilTypes.isProxy(value) ||
    !(value instanceof Date) ||
    Number.isNaN(value.getTime())
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return new Date(value.getTime())
}

/**
 * Captures a receiver-independent adapter clock.
 *
 * @param value - Candidate clock function.
 * @returns Safe detached clock wrapper.
 */
function snapshotClock(value: unknown): () => Date {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return () => {
    let output: unknown
    try {
      output = Reflect.apply(value, undefined, [])
    } catch {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    if (
      nodeUtilTypes.isProxy(output) ||
      !(output instanceof Date) ||
      Number.isNaN(output.getTime())
    ) {
      return failPartialRollbackOperation('INVALID_STATE')
    }
    return new Date(output.getTime())
  }
}

/**
 * Requires one non-Proxy dependency receiver.
 *
 * @param value - Candidate dependency object.
 * @returns Exact object receiver.
 */
function requireDependencyObject(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one data-method through a bounded prototype chain.
 *
 * @param receiver - Exact non-Proxy receiver.
 * @param key - Required method name.
 * @returns Exact callable data method.
 */
function readCallableMethod(
  receiver: object,
  key: string,
): unknown {
  let current: object | null = receiver
  let depth = 0
  while (current !== null && depth < 16) {
    if (nodeUtilTypes.isProxy(current)) {
      return failPartialRollbackOperation('INVALID_ARGUMENT')
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failPartialRollbackOperation('INVALID_ARGUMENT')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
    depth += 1
  }
  return failPartialRollbackOperation('INVALID_ARGUMENT')
}

/**
 * Narrows one dependency method.
 *
 * @param value - Candidate callable.
 * @returns Whether the value is a non-Proxy function.
 */
function isCallable<Callable extends (...input: never[]) => unknown>(
  value: unknown,
): value is Callable {
  return typeof value === 'function' &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows a planning execution boundary.
 *
 * @param value - Candidate boundary.
 * @returns Minimally narrowed boundary.
 */
function requireExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (!isExecutionBoundaryCandidate(value)) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows a sealed planning authority.
 *
 * @param value - Candidate sealed authority.
 * @returns Minimally narrowed sealed authority.
 */
function requireSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthorityCandidate(value)) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows an immutable execution admission.
 *
 * @param value - Candidate execution run.
 * @returns Minimally narrowed execution run.
 */
function requireExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRunCandidate(value)) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows one exact closed writer-fence row.
 *
 * @param value - Candidate closed row.
 * @returns Minimally narrowed closed row.
 */
function requireClosedWriterFenceRecord(
  value: unknown,
): WorkspaceSearchWriterFenceClosedRecord {
  if (!isClosedWriterFenceRecordCandidate(value)) {
    return failPartialRollbackOperation('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate execution boundary.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict boundary codec may inspect it.
 */
function isExecutionBoundaryCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate sealed planning authority.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict authority codec may inspect it.
 */
function isSealedPlanningAuthorityCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate immutable execution admission.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict execution-run codec may inspect it.
 */
function isExecutionRunCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate closed writer-fence row.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict writer-fence reader may inspect it.
 */
function isClosedWriterFenceRecordCandidate(
  value: unknown,
): value is WorkspaceSearchWriterFenceClosedRecord {
  return isOrdinaryObject(value)
}

/**
 * Narrows one non-Proxy non-array object.
 *
 * @param value - Candidate runtime value.
 * @returns Whether it is safe for an existing strict codec to inspect.
 */
function isOrdinaryObject(
  value: unknown,
): value is object {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Detaches one low-level DynamoDB attribute map.
 *
 * @param value - Candidate item or key.
 * @param code - Stable failure classification.
 * @returns Detached validated attribute map.
 */
function cloneLowLevelMap(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failPartialRollbackOperation(code)
  }
}

/**
 * Reads one optional low-level GetItem result safely.
 *
 * @param output - Raw low-level response.
 * @returns Raw item value or undefined.
 */
function readOutputItem(output: unknown): unknown {
  if (!isOrdinaryObject(output)) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  if (
    Reflect.ownKeys(output).some(
      (key) => typeof key === 'symbol',
    )
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  const descriptor =
    Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Requires one item to contain exactly its controlled attribute set.
 *
 * @param item - Candidate strict low-level item.
 * @param expectedKeys - Complete controlled field names.
 * @param code - Stable failure classification.
 */
function requireExactAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const actual = Object.keys(item).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failPartialRollbackOperation(code)
  }
}

/**
 * Requires exact byte-level equality of two low-level attribute maps.
 *
 * @param left - First strict attribute map.
 * @param right - Second strict attribute map.
 */
function requireAttributeMapsEqual(
  left: Readonly<Record<string, AttributeValue>>,
  right: Readonly<Record<string, AttributeValue>>,
): void {
  let leftDigest: string
  let rightDigest: string
  try {
    leftDigest = createMigrationDigest(
      encodeUnknownAttributeMap(left),
    )
    rightDigest = createMigrationDigest(
      encodeUnknownAttributeMap(right),
    )
  } catch {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  if (leftDigest !== rightDigest) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Requires common adapter-owned record binding fields.
 *
 * @param binding - Exact static rollback binding.
 * @param item - Strict low-level row.
 * @param kind - Exact record-kind discriminator.
 * @param recordKey - Exact deterministic record key.
 */
function requireCommonRecordBinding(
  binding: PartialRollbackOperationBinding,
  item: Readonly<Record<string, AttributeValue>>,
  kind: string,
  recordKey: string,
): void {
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !== recordKey ||
    readPositiveSafeIntegerAttribute(item, 'recordVersion') !==
      partialRollbackOperationRecordVersion ||
    readStringAttribute(item, 'kind') !== kind ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
}

/**
 * Reads one exact string AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(
    attribute,
    'INVALID_STATE',
  )
  requireExactKeys(record, ['S'], 'INVALID_STATE')
  const value = readOwn(record, 'S', 'INVALID_STATE')
  return typeof value === 'string'
    ? value
    : failPartialRollbackOperation('INVALID_STATE')
}

/**
 * Reads one exact lowercase digest AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact lowercase digest.
 */
function readDigestAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  return readDigest(
    readStringAttribute(item, name),
    'INVALID_STATE',
  )
}

/**
 * Reads one exact positive integer AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeIntegerAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(
    attribute,
    'INVALID_STATE',
  )
  requireExactKeys(record, ['N'], 'INVALID_STATE')
  const value = readOwn(record, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  return readPositiveSafeInteger(
    Number(value),
    'INVALID_STATE',
  )
}

/**
 * Reads one exact nonempty binary AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Detached bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(
    attribute,
    'INVALID_STATE',
  )
  requireExactKeys(record, ['B'], 'INVALID_STATE')
  const value = readOwn(record, 'B', 'INVALID_STATE')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failPartialRollbackOperation('INVALID_STATE')
  }
  const bytes = new Uint8Array(value)
  return bytes.byteLength > 0
    ? bytes
    : failPartialRollbackOperation('INVALID_STATE')
}

/**
 * Requires an ordinary exact-field record.
 *
 * @param value - Candidate runtime value.
 * @param code - Stable failure classification.
 * @returns Exact ordinary record.
 */
function requirePlainRecord(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failPartialRollbackOperation(code)
  }
  return value
}

/**
 * Narrows one ordinary non-Proxy string-keyed record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary record.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Requires an exact enumerable own data-property set.
 *
 * @param record - Candidate ordinary record.
 * @param expectedKeys - Complete accepted field names.
 * @param code - Stable failure classification.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const actual = Reflect.ownKeys(record)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.some((key) => typeof key === 'symbol') ||
    actual.length !== expected.length
  ) {
    return failPartialRollbackOperation(code)
  }
  const actualStrings =
    Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some(
      (key, index) => key !== expected[index],
    )
  ) {
    return failPartialRollbackOperation(code)
  }
  for (const key of expected) {
    readOwn(record, key, code)
  }
}

/**
 * Reads one enumerable own data property without invoking an accessor.
 *
 * @param value - Candidate object.
 * @param key - Required property name.
 * @param code - Stable failure classification.
 * @returns Exact stored value.
 */
function readOwn(
  value: object,
  key: PropertyKey,
  code: WorkspaceSearchMigrationFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failPartialRollbackOperation(code)
  }
  return descriptor.value
}

/**
 * Reads one bounded nonblank identifier.
 *
 * @param value - Candidate identifier.
 * @param code - Stable failure classification.
 * @returns Exact identifier.
 */
function readIdentifier(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim()
  ) {
    return failPartialRollbackOperation(code)
  }
  return value
}

/**
 * Reads one exact lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Stable failure classification.
 * @returns Exact digest.
 */
function readDigest(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  return isHexDigest(value)
    ? value
    : failPartialRollbackOperation(code)
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @param code - Stable failure classification.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failPartialRollbackOperation(code)
  }
  return value
}

/**
 * Compares text by its UTF-8 byte order.
 *
 * @param left - First text.
 * @param right - Second text.
 * @returns Negative, zero, or positive ordering.
 */
function compareUtf8Ordinal(
  left: string,
  right: string,
): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Classifies one failed fixed-order v2 rollback transaction.
 *
 * @param error - Raw transaction failure.
 * @param kind - Exact rollback transaction family.
 * @returns Stable secret-free failure code.
 */
function classifyPartialRollbackTransactionError(
  error: unknown,
  kind: PartialRollbackTransactionKind,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (nodeUtilTypes.isProxy(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (isResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      readErrorName(error) === 'TransactionConflictException'
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (
      error instanceof TransactionCanceledException ||
      readErrorName(error) === 'TransactionCanceledException'
    ) {
      const index = kind === 'operation'
        ? workspaceSearchMigrationPartialRollbackOperationTransactionIndex
        : workspaceSearchMigrationPartialRollbackFinishTransactionIndex
      if (
        readCancellationReasonCode(error, index.lease) ===
          'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readCancellationReasonCode(error, index.pointer) ===
          'ConditionalCheckFailed' ||
        readCancellationReasonCode(error, index.receipt) ===
          'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      if (
        kind === 'operation' &&
        readCancellationReasonCode(
          error,
          workspaceSearchMigrationPartialRollbackOperationTransactionIndex
            .target,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'ROLLBACK_TARGET_DRIFT'
      }
      for (
        let conditionIndex = 0;
        conditionIndex < index.count;
        conditionIndex += 1
      ) {
        if (
          readCancellationReasonCode(
            error,
            conditionIndex,
          ) === 'ConditionalCheckFailed'
        ) {
          return 'INVALID_STATE'
        }
      }
      return cancellationWasTransient(error, index.count)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (
      readErrorName(error) ===
        'TransactionInProgressException'
    ) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const input = createAwsClassificationInput(error)
    if (isThrottlingError(input)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return isTransientError(input)
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : 'INVALID_STATE'
  } catch {
    return 'AMBIGUOUS_OPERATION_UNRESOLVED'
  }
}

/**
 * Reads one fixed cancellation reason without invoking accessors.
 *
 * @param error - Raw transaction cancellation.
 * @param index - Zero-based fixed transaction index.
 * @returns Stable AWS reason code or undefined.
 */
function readCancellationReasonCode(
  error: unknown,
  index: number,
): string | undefined {
  try {
    if (
      typeof error !== 'object' ||
      error === null ||
      nodeUtilTypes.isProxy(error)
    ) {
      return undefined
    }
    const reasonsDescriptor =
      Object.getOwnPropertyDescriptor(error, 'CancellationReasons')
    if (
      reasonsDescriptor === undefined ||
      !Object.hasOwn(reasonsDescriptor, 'value') ||
      !Array.isArray(reasonsDescriptor.value)
    ) {
      return undefined
    }
    const reason: unknown = reasonsDescriptor.value[index]
    if (
      typeof reason !== 'object' ||
      reason === null ||
      nodeUtilTypes.isProxy(reason)
    ) {
      return undefined
    }
    const codeDescriptor =
      Object.getOwnPropertyDescriptor(reason, 'Code')
    const code = codeDescriptor !== undefined &&
        Object.hasOwn(codeDescriptor, 'value')
      ? codeDescriptor.value
      : undefined
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Detects an explicitly retry-safe transaction cancellation.
 *
 * @param error - Raw transaction cancellation.
 * @param count - Exact fixed transaction item count.
 * @returns Whether any reason is retry-safe infrastructure pressure.
 */
function cancellationWasTransient(
  error: unknown,
  count: number,
): boolean {
  for (let index = 0; index < count; index += 1) {
    const code = readCancellationReasonCode(error, index)
    if (
      code === 'TransactionConflict' ||
      code === 'ProvisionedThroughputExceeded' ||
      code === 'ThrottlingError'
    ) {
      return true
    }
  }
  return false
}

/**
 * Private structural input supplied to Smithy retry classifiers.
 */
type PartialRollbackAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Copies only secret-free structural retry-classifier fields.
 *
 * @param error - Raw SDK or Node.js Error.
 * @returns Sanitized structural classification input.
 */
function createAwsClassificationInput(
  error: Error,
): PartialRollbackAwsClassificationInput {
  const input: {
    name: string
    message: string
    $metadata?: {
      /** Optional HTTP response status. */
      httpStatusCode?: number
    }
    code?: string
  } = {
    name: readErrorName(error) ?? 'Error',
    message:
      'Workspace Search migration partial rollback operation failed.',
  }
  const code = readOwnStringIfData(error, 'code')
  if (code !== undefined) input.code = code
  const metadata = readOwnRecordIfData(error, '$metadata')
  if (metadata !== undefined) {
    const status = readOwnNumberIfData(
      metadata,
      'httpStatusCode',
    )
    if (status !== undefined) {
      input.$metadata = { httpStatusCode: status }
    }
  }
  return input
}

/**
 * Reads one own string data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns String value or undefined.
 */
function readOwnStringIfData(
  value: object,
  key: PropertyKey,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
}

/**
 * Reads one own finite number data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns Finite number or undefined.
 */
function readOwnNumberIfData(
  value: object,
  key: PropertyKey,
): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'number' &&
      Number.isFinite(descriptor.value)
    ? descriptor.value
    : undefined
}

/**
 * Reads one own ordinary-record data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns Ordinary record or undefined.
 */
function readOwnRecordIfData(
  value: object,
  key: PropertyKey,
): Readonly<Record<string, unknown>> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  const candidate = descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
  return typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      !nodeUtilTypes.isProxy(candidate) &&
      Object.getPrototypeOf(candidate) === Object.prototype
    ? candidate
    : undefined
}

/**
 * Reads a stable Error name without invoking caller accessors.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  try {
    if (
      typeof error !== 'object' ||
      error === null ||
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof Error)
    ) {
      return undefined
    }
    return readOwnStringIfData(error, 'name') ?? 'Error'
  } catch {
    return undefined
  }
}

/**
 * Detects a missing or replaced DynamoDB resource.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether it denotes resource absence.
 */
function isResourceNotFoundError(error: unknown): boolean {
  try {
    if (nodeUtilTypes.isProxy(error)) return false
    return error instanceof ResourceNotFoundException ||
      readErrorName(error) === 'ResourceNotFoundException'
  } catch {
    return false
  }
}

/**
 * Reads a trusted public managed-guard failure code.
 *
 * @param error - Candidate public transport failure.
 * @returns Stable code or undefined for a raw failure.
 */
function readPublicFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  try {
    if (
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof WorkspaceSearchMigrationFailure)
    ) {
      return undefined
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(error, 'code')
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return 'INVALID_STATE'
    }
    return isWorkspaceSearchMigrationFailureCode(descriptor.value)
      ? descriptor.value
      : 'INVALID_STATE'
  } catch {
    return undefined
  }
}

/**
 * Classifies a failed strong reconciliation read.
 *
 * @param error - Arbitrary reconciliation failure.
 * @returns Stable fail-closed reconciliation code.
 */
function readPartialRollbackReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (nodeUtilTypes.isProxy(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (error instanceof PartialRollbackOperationFailure) {
      return error.code
    }
    const publicCode = readPublicFailureCode(error)
    if (publicCode !== undefined) {
      return publicCode === 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
        : publicCode
    }
    return isResourceNotFoundError(error)
      ? 'CONFIGURATION_DRIFT'
      : 'AMBIGUOUS_OPERATION_UNRESOLVED'
  } catch {
    return 'AMBIGUOUS_OPERATION_UNRESOLVED'
  }
}

/**
 * Reads individually strong rows until two complete observations agree.
 *
 * @param readSnapshot - Reads one complete collection of related rows.
 * @param isSameSnapshot - Compares immutable digests and exact presence.
 * @returns The latest of two consecutive equal observations.
 */
async function readCoherentPartialRollbackOperationSnapshot<Value>(
  readSnapshot: () => Promise<Value>,
  isSameSnapshot: (left: Value, right: Value) => boolean,
): Promise<Value> {
  let previous = await readSnapshot()
  for (let index = 1; index < 3; index += 1) {
    const current = await readSnapshot()
    if (isSameSnapshot(previous, current)) return current
    previous = current
  }
  return failPartialRollbackOperation(
    'AMBIGUOUS_OPERATION_UNRESOLVED',
  )
}

/**
 * Runs one asynchronous public rollback operation behind a stable boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful operation result.
 */
async function runPartialRollbackOperationBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createPartialRollbackOperationPublicFailure(
      readPartialRollbackOperationFailureCode(error, false),
    )
  }
}

/**
 * Extracts one stable code from internal, public, or raw failures.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether malformed core input is an argument.
 * @returns Stable raw-value-free failure code.
 */
function readPartialRollbackOperationFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  const fallback = duringConstruction
    ? 'INVALID_ARGUMENT'
    : 'INVALID_STATE'
  try {
    if (nodeUtilTypes.isProxy(error)) return fallback
    const publicCode = readPublicFailureCode(error)
    if (publicCode !== undefined) return publicCode
    if (error instanceof PartialRollbackOperationFailure) {
      return error.code
    }
    if (isResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (error instanceof Error) {
      const classification = createAwsClassificationInput(error)
      if (isThrottlingError(classification)) {
        return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      }
      if (isTransientError(classification)) {
        return duringConstruction
          ? 'INVALID_ARGUMENT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED'
      }
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Private stable failure inside the partial rollback adapter boundary.
 */
class PartialRollbackOperationFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'PartialRollbackOperationFailure'
    this.code = code
  }
}

/**
 * Creates one generic public partial rollback persistence failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Raw-value-free public migration failure.
 */
function createPartialRollbackOperationPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration partial rollback operation failed.',
  )
}

/**
 * Raises one private stable partial rollback failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failPartialRollbackOperation(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new PartialRollbackOperationFailure(code)
}
