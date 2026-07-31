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
  type WorkspaceSearchMigrationRunState,
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
  createWorkspaceSearchMigrationAppliedRootConditionCheck,
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationAppliedRoot,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationItemConditionMaterial,
  verifyWorkspaceSearchMigrationItemStrongRead,
  type WorkspaceSearchMigrationItemConditionMaterial,
} from './migration-item-condition-aws'
import {
  decodeWorkspaceSearchJournalRestorationMaterial,
} from './migration-journal'
import {
  type WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationFullVerificationConflictRecordKeys,
} from './migration-full-verification-key'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRollbackStartRecordKey,
} from './migration-rollback-key'
import {
  createWorkspaceSearchMigrationRollbackStartSentinelAbsentAwsConditionCheck,
} from './migration-rollback-key-aws'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
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
import {
  type WorkspaceSearchMigrationApplyReceiptAwsBinding,
  type WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
} from './migration-apply-receipt-aws'
import {
  createWorkspaceSearchMigrationRollbackOperationTransition,
  createWorkspaceSearchMigrationRollbackStartRoot,
  finishWorkspaceSearchMigrationRollback,
  parseWorkspaceSearchMigrationRollbackOperationReceipt,
  parseWorkspaceSearchMigrationRollbackPersistenceState,
  parseWorkspaceSearchMigrationRollbackStartRoot,
  parseWorkspaceSearchMigrationRolledBackRoot,
  serializeWorkspaceSearchMigrationRollbackOperationReceipt,
  serializeWorkspaceSearchMigrationRollbackPersistenceState,
  serializeWorkspaceSearchMigrationRollbackStartRoot,
  serializeWorkspaceSearchMigrationRolledBackRoot,
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessor,
  type WorkspaceSearchMigrationRollbackOperationReceipt,
  type WorkspaceSearchMigrationRollbackPersistenceState,
  type WorkspaceSearchMigrationRollbackStartRoot,
  type WorkspaceSearchMigrationRolledBackRoot,
} from './migration-rollback-persistence'

const rollbackRecordVersion = 1
const rollbackStartRecordKind =
  'workspace-search-migration-rollback-start-root-record'
const rollbackStateRecordKind =
  'workspace-search-migration-rollback-state-record'
const rollbackReceiptRecordKind =
  'workspace-search-migration-rollback-operation-receipt-record'
const rolledBackRootRecordKind =
  'workspace-search-migration-rolled-back-root-record'
const rollbackStateRecordKeyPrefix = 'rollback-state/v1'
const rollbackReceiptRecordKeyPrefix = 'rollback-receipt/v1'
const rolledBackRootRecordKeyPrefix = 'rolled-back-root/v1'

/**
 * Fixed item positions for one atomic rollback-start transaction.
 */
export const workspaceSearchMigrationRollbackStartTransactionIndex =
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
    /** Exact immutable applied-root condition. */
    appliedRoot: 7,
    /** Absent deterministic full-verification mutable state. */
    verificationState: 8,
    /** Absent deterministic full-verification terminal root. */
    verifiedRoot: 9,
    /** Absent deterministic rollback-start root Put. */
    startRoot: 10,
    /** Absent mutable rollback-state Put. */
    rollbackState: 11,
    /** Fixed rollback-start item count. */
    count: 12,
  })

/**
 * Fixed item positions for one atomic reverse rollback operation.
 */
export const workspaceSearchMigrationRollbackOperationTransactionIndex =
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
    /** Exact immutable rollback-start root condition. */
    startRoot: 7,
    /** Exact-predecessor rollback-state CAS Put. */
    rollbackState: 8,
    /** Exact immutable apply journal-sequence condition. */
    applySequence: 9,
    /** Exact immutable apply operation-marker condition. */
    applyMarker: 10,
    /** Exact post-apply target CAS and preimage restoration. */
    target: 11,
    /** Absent deterministic rollback receipt Put. */
    rollbackReceipt: 12,
    /** Fixed reverse-operation item count. */
    count: 13,
  })

/**
 * Fixed item positions for one atomic rollback-finish transaction.
 */
export const workspaceSearchMigrationRollbackFinishTransactionIndex =
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
    /** Exact immutable rollback-start root condition. */
    startRoot: 7,
    /** Exact terminal rollback-state condition. */
    rollbackState: 8,
    /** Absent deterministic rolled-back root Put. */
    rolledBackRoot: 9,
    /** Fixed rollback-finish item count. */
    count: 10,
  })

/**
 * Exact admitted-run material needed to address the rollback-start sentinel.
 */
export type WorkspaceSearchMigrationRollbackStartSentinelAwsBindingInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
}

/**
 * Validates external identity and creates the shared rollback-start guard.
 *
 * Full verification and rollback start condition-check each other's
 * deterministic root namespace, so neither phase can start concurrently under
 * the same still-valid lease owner. The exact condition material is owned by
 * the shared rollback-key AWS factory.
 *
 * @param input - Exact migration-state table, configuration, and admission.
 * @returns Absent deterministic rollback-start ConditionCheck.
 */
export function createWorkspaceSearchMigrationRollbackStartSentinelAbsentConditionCheck(
  input: WorkspaceSearchMigrationRollbackStartSentinelAwsBindingInput,
): TransactWriteItem {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'configurationHash',
      'executionRun',
      'stateTable',
    ], 'INVALID_ARGUMENT')
    const stateTable = requireTableIdentity(
      readOwn(record, 'stateTable', 'INVALID_ARGUMENT'),
    )
    const configurationHash = readDigest(
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    )
    const executionRun =
      parseWorkspaceSearchMigrationExecutionRun(
        serializeWorkspaceSearchMigrationExecutionRun(
          requireExecutionRun(
            readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
          ),
        ),
      )
    if (
      executionRun.configurationHash !== configurationHash ||
      executionRun.binding.tableIds['migration-state'] !==
        stateTable.tableId
    ) {
      return failRollback('INVALID_ARGUMENT')
    }
    return createWorkspaceSearchMigrationRollbackStartSentinelAbsentAwsConditionCheck(
      {
        stateTableName: stateTable.tableName,
        stateTableId: stateTable.tableId,
        configurationHash,
        runId: executionRun.runId,
        executionRunDigest:
          executionRun.executionRunDigest,
      },
    )
  } catch (error: unknown) {
    throw createRollbackPublicFailure(
      readRollbackFailureCode(error, true),
    )
  }
}

/**
 * Adapter-owned source of rollback transaction time.
 *
 * @returns Current trusted adapter time.
 */
export type WorkspaceSearchMigrationRollbackOperationAwsClock = () => Date

/**
 * Exact current authority claim supplied for one rollback write.
 */
export type WorkspaceSearchMigrationRollbackAuthorityClaim = {
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Digest of the current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Exact current maintenance pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
}

/**
 * Narrow current-authority reader used before every rollback write.
 */
export interface WorkspaceSearchMigrationRollbackOperationAuthorityReader {
  /**
   * Resolves the exact current lease, pointer, and immutable receipt.
   *
   * @param claim - Exact caller lease, current pointer, and receipt claim.
   * @returns Fresh strongly resolved durable authority.
   */
  readAuthority(
    claim: WorkspaceSearchMigrationRollbackAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>
}

/**
 * Narrow immutable applied-root reader bound by the composition layer.
 */
export interface WorkspaceSearchMigrationRollbackAppliedRootReader {
  /**
   * Strongly reads the complete applied root for this execution.
   *
   * @returns Strict immutable applied root, or undefined when absent.
   */
  readAppliedRoot():
    Promise<WorkspaceSearchMigrationAppliedRoot | undefined>
}

/**
 * Narrow reconstructed apply-state reader bound by the composition layer.
 */
export interface WorkspaceSearchMigrationRollbackApplyRunStateReader {
  /**
   * Strongly reads the exact run state represented by the applied root.
   *
   * @returns Strict complete applied run state.
   */
  readRunState(): Promise<WorkspaceSearchMigrationRunState>
}

/**
 * Narrow strongly consistent and transactional rollback transport.
 */
export interface WorkspaceSearchMigrationRollbackOperationAwsTransport {
  /**
   * Strongly reads one adapter-owned state, receipt, apply row, or target.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getRollbackItem(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes all-six-table measured-incarnation guards before commit.
   */
  prepareRollbackWrite(): Promise<void>

  /**
   * Sends one fixed-order rollback transaction.
   *
   * @param command - Adapter-owned fixed-order transaction.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteRollback(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Caller input for one adapter-owned rollback transition.
 */
export type WorkspaceSearchMigrationRollbackCommandInput = {
  /** Exact durable predecessor revision expected by the caller. */
  readonly expectedRevision: number
  /** Exact current lease, pointer, and receipt authorizing the transition. */
  readonly authority: WorkspaceSearchMigrationRollbackAuthorityClaim
}

/**
 * Exact immutable complete-rollback root material fixed by a later transaction.
 */
export type CreateWorkspaceSearchMigrationRolledBackRootConditionCheckInput = {
  /** Independently measured migration-state table identity. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Immutable execution admission owning the rollback chain. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact immutable complete-rollback terminal root. */
  readonly root: WorkspaceSearchMigrationRolledBackRoot
}

/**
 * Static measured material and narrow capabilities for one rollback adapter.
 */
export type CreateWorkspaceSearchMigrationRollbackOperationAwsPortInput = {
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
  /** Exact closed application-writer fence record. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh narrow current-authority reader. */
  readonly authorityPort:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader
  /** Strong complete-applied-root reader. */
  readonly appliedRootReader:
    WorkspaceSearchMigrationRollbackAppliedRootReader
  /** Strong applied run-state reconstruction reader. */
  readonly applyRunStateReader:
    WorkspaceSearchMigrationRollbackApplyRunStateReader
  /** Exact-version immutable journal gateway. */
  readonly journalGateway:
    WorkspaceSearchMigrationJournalAwsGateway
  /** Run-bound apply receipt read and guard capability. */
  readonly applyReceiptBinding:
    WorkspaceSearchMigrationApplyReceiptAwsBinding
  /** Narrow measured DynamoDB rollback transport. */
  readonly transport:
    WorkspaceSearchMigrationRollbackOperationAwsTransport
  /** Adapter-owned trusted clock. */
  readonly clock: WorkspaceSearchMigrationRollbackOperationAwsClock
}

/**
 * Durable standalone complete-apply rollback capability.
 */
export interface WorkspaceSearchMigrationRollbackOperationAwsPort {
  /**
   * Strongly reads the resumable mutable rollback state.
   *
   * @returns Strict durable state, or undefined before rollback starts.
   */
  readRollbackState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceState | undefined>

  /**
   * Strongly reads one immutable reverse-operation receipt.
   *
   * @param sequence - Exact positive forward journal sequence.
   * @returns Strict reverse receipt, or undefined when not committed.
   */
  readRollbackReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationRollbackOperationReceipt | undefined>

  /**
   * Strongly reads the immutable terminal rollback root.
   *
   * @returns Strict terminal root, or undefined before finish.
   */
  readRolledBackRoot():
    Promise<WorkspaceSearchMigrationRolledBackRoot | undefined>

  /**
   * Atomically enters rollback from the complete applied root.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable rolling-back state, including later progress on retry.
   */
  beginRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState>

  /**
   * Restores the adapter-selected next journal preimage atomically.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable rollback state, including later progress on retry.
   */
  commitRollbackOperation(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState>

  /**
   * Publishes the immutable terminal root at the zero journal head.
   *
   * @param input - Exact zero-head revision and current authority claim.
   * @returns Exact immutable rolled-back root.
   */
  finishRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRolledBackRoot>
}

/**
 * Detached immutable construction binding retained by the adapter.
 */
type RollbackOperationBinding = {
  /** Complete detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Exact measured Workspace Search target table. */
  readonly targetTable: MigrationTableIdentity
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact closed writer-fence record. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact revision-two admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Stable key namespace digest. */
  readonly bindingDigest: string
}

/**
 * Narrow immutable terminal-row binding shared by publication and conditions.
 */
type RolledBackRootRecordBinding = {
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Immutable execution admission owning the rollback chain. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Stable rollback key namespace digest. */
  readonly bindingDigest: string
}

/**
 * Strict detached input prepared for a terminal-root condition.
 */
type PreparedRolledBackRootConditionCheckInput = {
  /** Narrow canonical durable-row binding. */
  readonly binding: RolledBackRootRecordBinding
  /** Strict detached immutable terminal root. */
  readonly root: WorkspaceSearchMigrationRolledBackRoot
}

/**
 * Captured dependency methods immune to later property replacement.
 */
type PreparedRollbackDependencies = {
  /**
   * Resolves fresh current authority.
   *
   * @param claim - Detached exact current-authority claim.
   * @returns Fresh strict authority.
   */
  readonly readAuthority: (
    claim: {
      /** Exact lease identity. */
      readonly lease: WorkspaceSearchMigrationLeaseClaim
      /** Exact immutable maintenance receipt digest. */
      readonly maintenanceEvidenceReceiptDigest: string
      /** Exact maintenance pointer revision. */
      readonly maintenanceEvidencePointerRevision: number
    },
  ) => Promise<WorkspaceSearchMigrationPrePlanAuthority>
  /** Strong complete-applied-root reader. */
  readonly readAppliedRoot:
    WorkspaceSearchMigrationRollbackAppliedRootReader['readAppliedRoot']
  /** Strong applied run-state reconstruction reader. */
  readonly readApplyRunState:
    WorkspaceSearchMigrationRollbackApplyRunStateReader['readRunState']
  /** Exact-version immutable journal reader. */
  readonly readJournal:
    WorkspaceSearchMigrationJournalAwsGateway['readJournalSegment']
  /** Creates one apply-sequence row strong read. */
  readonly createApplySequenceRead:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createJournalSequenceStrongReadCommand'
    ]
  /** Parses one apply-sequence row strong read. */
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
  /** Creates the exact immutable apply-sequence transaction guard. */
  readonly createApplySequenceGuard:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createJournalSequenceConditionCheck'
    ]
  /** Creates the exact immutable apply-marker transaction guard. */
  readonly createApplyMarkerGuard:
    WorkspaceSearchMigrationApplyReceiptAwsBinding[
      'createOperationMarkerConditionCheck'
    ]
  /**
   * Strongly reads one adapter-owned or target item.
   *
   * @param command - Exact strong-read command.
   * @returns Raw low-level output.
   */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /** Completes measured-incarnation preparation. */
  readonly prepare: () => Promise<void>
  /**
   * Sends one exact rollback transaction.
   *
   * @param command - Fixed-order transaction.
   * @returns Raw low-level output.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
  /** Returns one fresh detached trusted time. */
  readonly clock: () => Date
}

/**
 * Fully detached caller command before the first asynchronous boundary.
 */
type PreparedRollbackCommand = {
  /** Exact expected durable predecessor revision. */
  readonly expectedRevision: number
  /** Detached exact current authority claim. */
  readonly authority:
    WorkspaceSearchMigrationRollbackAuthorityClaim
}

/**
 * Creates one measured standalone rollback adapter.
 *
 * @param input - Measured bindings and narrow rollback capabilities.
 * @returns Atomic rollback persistence capability.
 */
export function createAwsWorkspaceSearchMigrationRollbackOperationPort(
  input: CreateWorkspaceSearchMigrationRollbackOperationAwsPortInput,
): WorkspaceSearchMigrationRollbackOperationAwsPort {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'appliedRootReader',
      'applyReceiptBinding',
      'applyRunStateReader',
      'authorityPort',
      'clock',
      'closedWriterFenceRecord',
      'configuration',
      'configurationHash',
      'executionBoundary',
      'executionRun',
      'journalGateway',
      'sealedPlanningAuthority',
      'transport',
    ], 'INVALID_ARGUMENT')
    const binding = createRollbackOperationBinding(
      readOwn(record, 'configuration', 'INVALID_ARGUMENT'),
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionBoundary', 'INVALID_ARGUMENT'),
      readOwn(record, 'sealedPlanningAuthority', 'INVALID_ARGUMENT'),
      readOwn(record, 'closedWriterFenceRecord', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
    )
    const dependencies = prepareRollbackDependencies(
      binding,
      readOwn(record, 'authorityPort', 'INVALID_ARGUMENT'),
      readOwn(record, 'appliedRootReader', 'INVALID_ARGUMENT'),
      readOwn(record, 'applyRunStateReader', 'INVALID_ARGUMENT'),
      readOwn(record, 'journalGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'applyReceiptBinding', 'INVALID_ARGUMENT'),
      readOwn(record, 'transport', 'INVALID_ARGUMENT'),
      readOwn(record, 'clock', 'INVALID_ARGUMENT'),
    )
    return new AwsWorkspaceSearchMigrationRollbackOperationPort(
      binding,
      dependencies,
    )
  } catch (error: unknown) {
    throw createRollbackPublicFailure(
      readRollbackFailureCode(error, true),
    )
  }
}

/**
 * Creates an exact full-row condition for one immutable v1 rolled-back root.
 *
 * The admission and root are synchronously detached through their canonical
 * codecs. Every non-key durable attribute, including the canonical root bytes,
 * is compared by the returned condition.
 *
 * @param input - Measured state table, admission, configuration, and root.
 * @returns Exact immutable complete-rollback-root ConditionCheck.
 */
export function createWorkspaceSearchMigrationRolledBackRootConditionCheck(
  input: CreateWorkspaceSearchMigrationRolledBackRootConditionCheckInput,
): TransactWriteItem {
  try {
    const prepared = prepareRolledBackRootConditionCheckInput(input)
    return createFullRowConditionCheck(
      prepared.binding.stateTable.tableName,
      createRolledBackRootRecord(prepared.binding, prepared.root),
    )
  } catch (error: unknown) {
    throw createRollbackPublicFailure(
      readRollbackFailureCode(error, true),
    )
  }
}

/**
 * Concrete complete-applied-root reverse rollback adapter.
 */
class AwsWorkspaceSearchMigrationRollbackOperationPort
implements WorkspaceSearchMigrationRollbackOperationAwsPort {
  /** Detached exact static rollback binding. */
  private readonly binding: RollbackOperationBinding

  /** Captured narrow dependency methods. */
  private readonly dependencies: PreparedRollbackDependencies

  /**
   * Creates one adapter from validated material.
   *
   * @param binding - Exact static rollback binding.
   * @param dependencies - Captured narrow capabilities.
   */
  constructor(
    binding: RollbackOperationBinding,
    dependencies: PreparedRollbackDependencies,
  ) {
    this.binding = binding
    this.dependencies = dependencies
  }

  /**
   * Strongly reads the mutable rollback state.
   *
   * @returns Strict durable state or undefined.
   */
  async readRollbackState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceState | undefined> {
    return runRollbackBoundary(async () => {
      const { startRoot, state, root } =
        await readCoherentRollbackSnapshot(
          async () => {
            const [candidateStart, candidateState, candidateRoot] =
              await Promise.all([
                this.readStart(),
                this.readState(),
                this.readRoot(),
              ])
            return {
              startRoot: candidateStart,
              state: candidateState,
              root: candidateRoot,
            }
          },
          (left, right) =>
            left.startRoot?.startRootDigest ===
              right.startRoot?.startRootDigest &&
            left.state?.stateDigest === right.state?.stateDigest &&
            left.root?.rootDigest === right.root?.rootDigest,
        )
      if (
        startRoot === undefined &&
        state === undefined &&
        root === undefined
      ) {
        return undefined
      }
      if (startRoot === undefined || state === undefined) {
        return failRollback('INVALID_STATE')
      }
      requireStateDescendsFromStart(startRoot, state)
      requireRootAtomicity(startRoot, state, root)
      return state
    })
  }

  /**
   * Strongly reads one immutable reverse receipt.
   *
   * @param sequence - Positive forward sequence.
   * @returns Strict durable receipt or undefined.
   */
  async readRollbackReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationRollbackOperationReceipt | undefined> {
    return runRollbackBoundary(async () => {
      const exactSequence = readPositiveSafeInteger(
        sequence,
        'INVALID_ARGUMENT',
      )
      const { startRoot, state, receipt, root } =
        await readCoherentRollbackSnapshot(
          async () => {
            const [
              candidateStart,
              candidateState,
              candidateReceipt,
              candidateRoot,
            ] = await Promise.all([
              this.readStart(),
              this.readState(),
              this.readReceipt(exactSequence),
              this.readRoot(),
            ])
            return {
              startRoot: candidateStart,
              state: candidateState,
              receipt: candidateReceipt,
              root: candidateRoot,
            }
          },
          (left, right) =>
            left.startRoot?.startRootDigest ===
              right.startRoot?.startRootDigest &&
            left.state?.stateDigest === right.state?.stateDigest &&
            left.receipt?.receiptDigest ===
              right.receipt?.receiptDigest &&
            left.root?.rootDigest === right.root?.rootDigest,
        )
      if (startRoot === undefined && state === undefined) {
        if (receipt !== undefined || root !== undefined) {
          return failRollback('INVALID_STATE')
        }
        return undefined
      }
      if (startRoot === undefined || state === undefined) {
        return failRollback('INVALID_STATE')
      }
      requireStateDescendsFromStart(startRoot, state)
      requireRootAtomicity(startRoot, state, root)
      if (receipt === undefined) {
        if (
          exactSequence <= startRoot.originalJournalSequence &&
          state.nextSequence < exactSequence
        ) {
          return failRollback('INVALID_STATE')
        }
        return undefined
      }
      requireReceiptBelongsToStart(startRoot, receipt)
      requireStateAtOrAfterReceipt(startRoot, state, receipt)
      return receipt
    })
  }

  /**
   * Strongly reads the immutable terminal root.
   *
   * @returns Strict terminal root or undefined.
   */
  async readRolledBackRoot():
    Promise<WorkspaceSearchMigrationRolledBackRoot | undefined> {
    return runRollbackBoundary(async () => {
      const { startRoot, state, root } =
        await readCoherentRollbackSnapshot(
          async () => {
            const [candidateStart, candidateState, candidateRoot] =
              await Promise.all([
                this.readStart(),
                this.readState(),
                this.readRoot(),
              ])
            return {
              startRoot: candidateStart,
              state: candidateState,
              root: candidateRoot,
            }
          },
          (left, right) =>
            left.startRoot?.startRootDigest ===
              right.startRoot?.startRootDigest &&
            left.state?.stateDigest === right.state?.stateDigest &&
            left.root?.rootDigest === right.root?.rootDigest,
        )
      if (root === undefined) {
        if (startRoot === undefined && state === undefined) {
          return undefined
        }
        if (startRoot === undefined || state === undefined) {
          return failRollback('INVALID_STATE')
        }
        requireStateDescendsFromStart(startRoot, state)
        if (state.status === 'rolled-back') {
          return failRollback('INVALID_STATE')
        }
        return undefined
      }
      if (startRoot === undefined || state === undefined) {
        return failRollback('INVALID_STATE')
      }
      requireStateDescendsFromStart(startRoot, state)
      requireRootAtomicity(startRoot, state, root)
      return root
    })
  }

  /**
   * Atomically starts complete-root rollback.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable rollback state.
   */
  async beginRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    return runRollbackBoundary(async () => {
      const command = prepareRollbackCommand(input)
      const {
        startRoot: existingStart,
        state: existingState,
        root: existingRoot,
      } = await readCoherentRollbackSnapshot(
        async () => {
          const [candidateStart, candidateState, candidateRoot] =
            await Promise.all([
              this.readStart(),
              this.readState(),
              this.readRoot(),
            ])
          return {
            startRoot: candidateStart,
            state: candidateState,
            root: candidateRoot,
          }
        },
        (left, right) =>
          left.startRoot?.startRootDigest ===
            right.startRoot?.startRootDigest &&
          left.state?.stateDigest === right.state?.stateDigest &&
          left.root?.rootDigest === right.root?.rootDigest,
      )
      if (existingStart !== undefined) {
        if (
          existingState === undefined
        ) {
          return failRollback('INVALID_STATE')
        }
        requireStartMatchesBeginCommand(existingStart, command)
        requireStateDescendsFromStart(
          existingStart,
          existingState,
        )
        requireRootAtomicity(
          existingStart,
          existingState,
          existingRoot,
        )
        return existingState
      }
      if (
        existingState !== undefined ||
        existingRoot !== undefined
      ) {
        return failRollback('INVALID_STATE')
      }
      if (await this.hasFullVerificationConflict()) {
        return failRollback('INVALID_STATE')
      }
      const [appliedRoot, predecessorRunState, authority] =
        await Promise.all([
          this.dependencies.readAppliedRoot(),
          this.dependencies.readApplyRunState(),
          this.resolveAuthority(command),
        ])
      if (appliedRoot === undefined) {
        return failRollback('INVALID_STATE')
      }
      const detachedAppliedRoot =
        parseWorkspaceSearchMigrationAppliedRoot(
          serializeWorkspaceSearchMigrationAppliedRoot(appliedRoot),
        )
      requireLeaseClaimMatchesAuthority(
        command.authority.lease,
        authority,
      )
      await this.dependencies.prepare()
      const commitAt = readClock(this.dependencies.clock)
      requireRollbackStartRetention(detachedAppliedRoot, commitAt)
      const startRoot =
        createWorkspaceSearchMigrationRollbackStartRoot({
          executionRun: this.binding.executionRun,
          appliedRoot: detachedAppliedRoot,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
          predecessorRunState,
          currentAuthority: authority,
          startedAt: commitAt.toISOString(),
        })
      if (
        startRoot.predecessorRevision !== command.expectedRevision
      ) {
        return failRollback('INVALID_STATE')
      }
      const transaction = createRollbackStartTransactionCommand({
        binding: this.binding,
        currentAuthority: authority,
        commitAt,
        appliedRoot: detachedAppliedRoot,
        startRoot,
      })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const publicCode = readPublicFailureCode(error)
        if (publicCode !== undefined) return failRollback(publicCode)
        transactionError = error
      }
      return this.reconcileBeginAfterAttempt(
        command,
        startRoot,
        transactionError,
      )
    })
  }

  /**
   * Atomically restores the adapter-selected next reverse sequence.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Current durable rollback state.
   */
  async commitRollbackOperation(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    return runRollbackBoundary(async () => {
      const command = prepareRollbackCommand(input)
      const startRoot = await this.requireStart()
      const sequence = deriveRollbackSequence(
        startRoot,
        command.expectedRevision,
      )
      const {
        receipt: existingReceipt,
        state: observedState,
        root: observedRoot,
      } = await readCoherentRollbackSnapshot(
        async () => {
          const [candidateReceipt, candidateState, candidateRoot] =
            await Promise.all([
              this.readReceipt(sequence),
              this.readState(),
              this.readRoot(),
            ])
          return {
            receipt: candidateReceipt,
            state: candidateState,
            root: candidateRoot,
          }
        },
        (left, right) =>
          left.receipt?.receiptDigest ===
            right.receipt?.receiptDigest &&
          left.state?.stateDigest === right.state?.stateDigest &&
          left.root?.rootDigest === right.root?.rootDigest,
      )
      if (existingReceipt !== undefined) {
        return this.reconcileExistingReceipt(
          command,
          startRoot,
          existingReceipt,
        )
      }
      const predecessorState =
        observedState ?? failRollback('INVALID_STATE')
      requireRootAtomicity(startRoot, predecessorState, observedRoot)
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
        return failRollback('INVALID_STATE')
      }
      const correlated = this.dependencies.correlateApplyRows(
        applySequence,
        applyMarker,
      )
      requireLeaseClaimMatchesAuthority(
        command.authority.lease,
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
      verifyWorkspaceSearchMigrationItemStrongRead(
        this.binding.targetTable,
        restoration.targetKey,
        restoration.after,
        targetOutput,
        'ROLLBACK_TARGET_DRIFT',
      )
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
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState,
          currentAuthority: authority,
          applyReceipt: correlated.receipt,
          journalSegment,
          committedAt: commitAt.toISOString(),
        })
      const transaction =
        createRollbackOperationTransactionCommand({
          binding: this.binding,
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
        if (publicCode !== undefined) return failRollback(publicCode)
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
   * Atomically publishes the terminal rolled-back root.
   *
   * @param input - Exact zero-head revision and current authority claim.
   * @returns Exact terminal immutable root.
   */
  async finishRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRolledBackRoot> {
    return runRollbackBoundary(async () => {
      const command = prepareRollbackCommand(input)
      const {
        root: existingRoot,
        startRoot: existingStart,
        state: existingState,
      } = await readCoherentRollbackSnapshot(
        async () => {
          const [candidateRoot, candidateStart, candidateState] =
            await Promise.all([
              this.readRoot(),
              this.readStart(),
              this.readState(),
            ])
          return {
            root: candidateRoot,
            startRoot: candidateStart,
            state: candidateState,
          }
        },
        (left, right) =>
          left.root?.rootDigest === right.root?.rootDigest &&
          left.startRoot?.startRootDigest ===
            right.startRoot?.startRootDigest &&
          left.state?.stateDigest === right.state?.stateDigest,
      )
      if (existingRoot !== undefined) {
        if (
          existingStart === undefined ||
          existingState === undefined ||
          existingRoot.startRootDigest !==
            existingStart.startRootDigest
        ) {
          return failRollback('INVALID_STATE')
        }
        requireStateDescendsFromStart(existingStart, existingState)
        requireRootAtomicity(
          existingStart,
          existingState,
          existingRoot,
        )
        requireRootMatchesFinishCommand(existingRoot, command)
        return existingRoot
      }
      const [startRoot, predecessorState, authority] =
        await Promise.all([
          this.requireStart(),
          this.requireState(),
          this.resolveAuthority(command),
        ])
      requireFinishPredecessor(
        startRoot,
        predecessorState,
        command,
      )
      requireLeaseClaimMatchesAuthority(
        command.authority.lease,
        authority,
      )
      const terminalReceipt =
        startRoot.originalJournalSequence === 0
          ? null
          : await this.requireReceipt(1)
      await this.dependencies.prepare()
      const commitAt = readClock(this.dependencies.clock)
      const transition = finishWorkspaceSearchMigrationRollback({
        startRoot,
        predecessorState,
        currentAuthority: authority,
        terminalReceipt,
        finishedAt: commitAt.toISOString(),
      })
      const transaction =
        createRollbackFinishTransactionCommand({
          binding: this.binding,
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
        if (publicCode !== undefined) return failRollback(publicCode)
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
    command: PreparedRollbackCommand,
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
      return failRollback('CONFIGURATION_DRIFT')
    }
    return detached
  }

  /**
   * Reads the immutable rollback-start row.
   *
   * @returns Strict start root or undefined.
   */
  private async readStart():
    Promise<WorkspaceSearchMigrationRollbackStartRoot | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRollbackStartRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRollbackStartRecord(this.binding, item)
  }

  /**
   * Requires the immutable rollback-start row.
   *
   * @returns Strict start root.
   */
  private async requireStart():
    Promise<WorkspaceSearchMigrationRollbackStartRoot> {
    const start = await this.readStart()
    return start ?? failRollback('INVALID_STATE')
  }

  /**
   * Reads the mutable rollback state row.
   *
   * @returns Strict rollback state or undefined.
   */
  private async readState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceState | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRollbackStateRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRollbackStateRecord(this.binding, item)
  }

  /**
   * Requires the mutable rollback state row.
   *
   * @returns Strict rollback state.
   */
  private async requireState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    const state = await this.readState()
    return state ?? failRollback('INVALID_STATE')
  }

  /**
   * Reads one immutable reverse receipt row.
   *
   * @param sequence - Exact positive sequence.
   * @returns Strict receipt or undefined.
   */
  private async readReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationRollbackOperationReceipt | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRollbackReceiptRecordKey(
          this.binding,
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
   * Requires one immutable reverse receipt row.
   *
   * @param sequence - Exact positive sequence.
   * @returns Strict reverse receipt.
   */
  private async requireReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchMigrationRollbackOperationReceipt> {
    const receipt = await this.readReceipt(sequence)
    return receipt ?? failRollback('INVALID_STATE')
  }

  /**
   * Reads the immutable rolled-back root row.
   *
   * @returns Strict root or undefined.
   */
  private async readRoot():
    Promise<WorkspaceSearchMigrationRolledBackRoot | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRolledBackRootRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRolledBackRootRecord(this.binding, item)
  }

  /**
   * Strongly detects either deterministic full-verification progress row.
   *
   * @returns Whether verification already won the phase-start race.
   */
  private async hasFullVerificationConflict(): Promise<boolean> {
    const keys = createFullVerificationConflictRecordKeys(
      this.binding,
    )
    const [stateOutput, rootOutput] = await Promise.all([
      this.dependencies.get(
        createStrongStateReadCommand(this.binding, keys.state),
      ),
      this.dependencies.get(
        createStrongStateReadCommand(this.binding, keys.root),
      ),
    ])
    return readOutputItem(stateOutput) !== undefined ||
      readOutputItem(rootOutput) !== undefined
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
    return projection ?? failRollback('INVALID_STATE')
  }

  /**
   * Reads one exact journal version behind a stable boundary.
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
      if (code !== undefined) return failRollback(code)
      return failRollback('INVALID_JOURNAL')
    }
  }

  /**
   * Reconciles a begin attempt through deterministic start and state rows.
   *
   * @param command - Detached attempted command.
   * @param intendedStart - Exact intended immutable start root.
   * @param transactionError - Raw transaction failure when present.
   * @returns Current state proving this start committed.
   */
  private async reconcileBeginAfterAttempt(
    command: PreparedRollbackCommand,
    intendedStart: WorkspaceSearchMigrationRollbackStartRoot,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    let start: WorkspaceSearchMigrationRollbackStartRoot | undefined
    let state: WorkspaceSearchMigrationRollbackPersistenceState | undefined
    let root: WorkspaceSearchMigrationRolledBackRoot | undefined
    try {
      const snapshot = await readCoherentRollbackSnapshot(
        async () => {
          const [candidateStart, candidateState, candidateRoot] =
            await Promise.all([
              this.readStart(),
              this.readState(),
              this.readRoot(),
            ])
          return {
            start: candidateStart,
            state: candidateState,
            root: candidateRoot,
          }
        },
        (left, right) =>
          left.start?.startRootDigest ===
            right.start?.startRootDigest &&
          left.state?.stateDigest === right.state?.stateDigest &&
          left.root?.rootDigest === right.root?.rootDigest,
      )
      start = snapshot.start
      state = snapshot.state
      root = snapshot.root
    } catch (error: unknown) {
      return failRollback(
        readRollbackReconciliationFailureCode(error),
      )
    }
    if (start === undefined || state === undefined) {
      return failRollback(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyRollbackTransactionError(
              transactionError,
              'begin',
            ),
      )
    }
    requireStartIsLogicalWinner(command, intendedStart, start)
    requireStateDescendsFromStart(start, state)
    requireRootAtomicity(start, state, root)
    return state
  }

  /**
   * Reconciles an already-observed immutable reverse receipt.
   *
   * @param command - Detached retry command.
   * @param startRoot - Exact immutable start root.
   * @param receipt - Existing deterministic receipt.
   * @returns Current state at or after the receipt.
   */
  private async reconcileExistingReceipt(
    command: PreparedRollbackCommand,
    startRoot: WorkspaceSearchMigrationRollbackStartRoot,
    receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    requireReceiptMatchesCommand(command, startRoot, receipt)
    const { state, root } =
      await readCoherentRollbackSnapshot(
        async () => {
          const [candidateState, candidateRoot] =
            await Promise.all([
              this.requireState(),
              this.readRoot(),
            ])
          return {
            state: candidateState,
            root: candidateRoot,
          }
        },
        (left, right) =>
          left.state.stateDigest === right.state.stateDigest &&
          left.root?.rootDigest === right.root?.rootDigest,
      )
    requireStateAtOrAfterReceipt(startRoot, state, receipt)
    requireRootAtomicity(startRoot, state, root)
    return state
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
    command: PreparedRollbackCommand,
    startRoot: WorkspaceSearchMigrationRollbackStartRoot,
    intendedReceipt:
      WorkspaceSearchMigrationRollbackOperationReceipt,
    intendedState:
      WorkspaceSearchMigrationRollbackPersistenceState,
    targetKey: Readonly<Record<string, AttributeValue>>,
    restoredSnapshot: MigrationItemSnapshot,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceState> {
    let receipt:
      WorkspaceSearchMigrationRollbackOperationReceipt | undefined
    let state:
      WorkspaceSearchMigrationRollbackPersistenceState | undefined
    let targetOutput: GetItemCommandOutput
    let root: WorkspaceSearchMigrationRolledBackRoot | undefined
    try {
      const snapshot = await readCoherentRollbackSnapshot(
        async () => {
          const [
            candidateReceipt,
            candidateState,
            candidateTargetOutput,
            candidateRoot,
          ] = await Promise.all([
            this.readReceipt(intendedReceipt.sequence),
            this.readState(),
            this.dependencies.get(
              createStrongReadCommand(
                this.binding.targetTable,
                targetKey,
              ),
            ),
            this.readRoot(),
          ])
          return {
            receipt: candidateReceipt,
            state: candidateState,
            targetOutput: candidateTargetOutput,
            root: candidateRoot,
          }
        },
        (left, right) =>
          left.receipt?.receiptDigest ===
            right.receipt?.receiptDigest &&
          left.state?.stateDigest === right.state?.stateDigest &&
          readOutputItemDigest(left.targetOutput) ===
            readOutputItemDigest(right.targetOutput) &&
          left.root?.rootDigest === right.root?.rootDigest,
      )
      receipt = snapshot.receipt
      state = snapshot.state
      targetOutput = snapshot.targetOutput
      root = snapshot.root
    } catch (error: unknown) {
      return failRollback(
        readRollbackReconciliationFailureCode(error),
      )
    }
    if (receipt === undefined || state === undefined) {
      return failRollback(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyRollbackTransactionError(
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
    requireStateAtOrAfterReceipt(startRoot, state, receipt)
    requireRootAtomicity(startRoot, state, root)
    if (state.revision === receipt.successorRevision) {
      verifyWorkspaceSearchMigrationItemStrongRead(
        this.binding.targetTable,
        targetKey,
        restoredSnapshot,
        targetOutput,
        'ROLLBACK_TARGET_DRIFT',
      )
    } else {
      readOutputItem(targetOutput)
    }
    return state
  }

  /**
   * Reconciles terminal publication through the deterministic root row.
   *
   * @param command - Detached attempted command.
   * @param intendedRoot - Exact intended terminal root.
   * @param transactionError - Raw transaction failure when present.
   * @returns Exact committed root.
   */
  private async reconcileFinishAfterAttempt(
    command: PreparedRollbackCommand,
    intendedRoot: WorkspaceSearchMigrationRolledBackRoot,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRolledBackRoot> {
    let root: WorkspaceSearchMigrationRolledBackRoot | undefined
    let state:
      WorkspaceSearchMigrationRollbackPersistenceState | undefined
    try {
      const snapshot = await readCoherentRollbackSnapshot(
        async () => {
          const [candidateRoot, candidateState] =
            await Promise.all([
              this.readRoot(),
              this.readState(),
            ])
          return {
            root: candidateRoot,
            state: candidateState,
          }
        },
        (left, right) =>
          left.root?.rootDigest === right.root?.rootDigest &&
          left.state?.stateDigest === right.state?.stateDigest,
      )
      root = snapshot.root
      state = snapshot.state
    } catch (error: unknown) {
      return failRollback(
        readRollbackReconciliationFailureCode(error),
      )
    }
    if (root === undefined || state === undefined) {
      return failRollback(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyRollbackTransactionError(
              transactionError,
              'finish',
            ),
      )
    }
    requireRootIsLogicalWinner(command, intendedRoot, root)
    if (state.stateDigest !== root.terminalStateDigest) {
      return failRollback('INVALID_STATE')
    }
    requireRootMatchesFinishCommand(root, command)
    return root
  }
}

/**
 * Complete material for one fixed twelve-item rollback-start transaction.
 */
type CreateRollbackStartTransactionCommandInput = {
  /** Exact static rollback binding. */
  readonly binding: RollbackOperationBinding
  /** Fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final commit time. */
  readonly commitAt: Date
  /** Exact complete applied root consumed by start. */
  readonly appliedRoot: WorkspaceSearchMigrationAppliedRoot
  /** Immutable start root and initial state. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
}

/**
 * Complete material for one fixed thirteen-item reverse transaction.
 */
type CreateRollbackOperationTransactionCommandInput = {
  /** Exact static rollback binding. */
  readonly binding: RollbackOperationBinding
  /** Fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final commit time. */
  readonly commitAt: Date
  /** Exact immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Exact durable predecessor rollback state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
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
  /** Immutable rollback receipt committed atomically. */
  readonly receipt:
    WorkspaceSearchMigrationRollbackOperationReceipt
  /** Exact durable successor rollback state. */
  readonly successorState:
    WorkspaceSearchMigrationRollbackPersistenceState
}

/**
 * Complete material for one fixed ten-item terminal transaction.
 */
type CreateRollbackFinishTransactionCommandInput = {
  /** Exact static rollback binding. */
  readonly binding: RollbackOperationBinding
  /** Fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final commit time. */
  readonly commitAt: Date
  /** Exact immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Exact zero-head predecessor rollback state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Immutable terminal root to publish. */
  readonly root: WorkspaceSearchMigrationRolledBackRoot
}

/**
 * Transaction family used for stable cancellation classification.
 */
type RollbackTransactionKind = 'begin' | 'finish' | 'operation'

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
 * DynamoDB cannot condition-check an unknown top-level attribute set. The
 * application writer fence and immediate strong read cover unknown names,
 * while this list covers the repository schema and the independently measured
 * TTL attribute.
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
 * Complete controlled attribute set for an immutable rollback-start row.
 */
const rollbackStartRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'recordKey',
  'recordVersion',
  'runId',
  'startRootBytes',
  'startRootDigest',
  'stateTableId',
])

/**
 * Complete controlled attribute set for the mutable rollback-state row.
 */
const rollbackStateRecordAttributeNames = Object.freeze([
  'appliedRootDigest',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'recordKey',
  'recordVersion',
  'revision',
  'runId',
  'startRootDigest',
  'stateBytes',
  'stateDigest',
  'stateTableId',
])

/**
 * Complete controlled attribute set for immutable rollback receipts.
 */
const rollbackReceiptRecordAttributeNames = Object.freeze([
  'commandDigest',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
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
 * Complete controlled attribute set for the immutable terminal root.
 */
const rolledBackRootRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'recordKey',
  'recordVersion',
  'rootBytes',
  'rootDigest',
  'runId',
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
function createRollbackOperationBinding(
  configurationValue: unknown,
  configurationHashValue: unknown,
  executionBoundaryValue: unknown,
  sealedPlanningAuthorityValue: unknown,
  closedWriterFenceRecordValue: unknown,
  executionRunValue: unknown,
): RollbackOperationBinding {
  const configuration =
    detachWorkspaceSearchMigrationPlanningConfiguration(
      requireConfiguration(configurationValue),
    )
  const configurationHash = readDigest(
    configurationHashValue,
    'INVALID_ARGUMENT',
  )
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failRollback('CONFIGURATION_HASH_MISMATCH')
  }
  const executionBoundary =
    parseWorkspaceSearchMigrationExecutionBoundary(
      serializeWorkspaceSearchMigrationExecutionBoundary(
        requireExecutionBoundary(executionBoundaryValue),
      ),
    )
  if (executionBoundary.phase !== 'planning-admitted') {
    return failRollback('INVALID_ARGUMENT')
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
  const tableIds = createRollbackTableIds(configuration)
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
    return failRollback('INVALID_ARGUMENT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      executionBoundary.tableIds[role] !== tableIds[role] ||
      sealedPlanningAuthority.tableIds[role] !== tableIds[role] ||
      executionRun.binding.tableIds[role] !== tableIds[role] ||
      closedWriterFenceRecord.binding.tableIds[role] !==
        tableIds[role]
    ) {
      return failRollback('CONFIGURATION_DRIFT')
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
    configuration,
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
function createRollbackTableIds(
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
 * @param appliedRootReaderValue - Candidate applied-root reader.
 * @param applyRunStateReaderValue - Candidate applied-state reader.
 * @param journalGatewayValue - Candidate exact journal gateway.
 * @param applyReceiptBindingValue - Candidate apply-receipt capability.
 * @param transportValue - Candidate rollback transport.
 * @param clockValue - Candidate trusted clock.
 * @returns Captured narrow dependencies.
 */
function prepareRollbackDependencies(
  binding: RollbackOperationBinding,
  authorityPortValue: unknown,
  appliedRootReaderValue: unknown,
  applyRunStateReaderValue: unknown,
  journalGatewayValue: unknown,
  applyReceiptBindingValue: unknown,
  transportValue: unknown,
  clockValue: unknown,
): PreparedRollbackDependencies {
  const authorityPort =
    requireDependencyObject(authorityPortValue)
  const appliedRootReader =
    requireDependencyObject(appliedRootReaderValue)
  const applyRunStateReader =
    requireDependencyObject(applyRunStateReaderValue)
  const journalGateway =
    requireDependencyObject(journalGatewayValue)
  const applyReceiptBinding =
    requireDependencyObject(applyReceiptBindingValue)
  const transport = requireDependencyObject(transportValue)
  const readAuthority = readCallableMethod(
    authorityPort,
    'readAuthority',
  )
  const readAppliedRoot = readCallableMethod(
    appliedRootReader,
    'readAppliedRoot',
  )
  const readApplyRunState = readCallableMethod(
    applyRunStateReader,
    'readRunState',
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
    'getRollbackItem',
  )
  const prepare = readCallableMethod(
    transport,
    'prepareRollbackWrite',
  )
  const transact = readCallableMethod(
    transport,
    'transactWriteRollback',
  )
  if (
    !isCallable<
      WorkspaceSearchMigrationApplyReceiptAwsBinding[
        'readBindingIdentity'
      ]
    >(readApplyBindingIdentity) ||
    !isCallable<PreparedRollbackDependencies['readAuthority']>(
      readAuthority,
    ) ||
    !isCallable<PreparedRollbackDependencies['readAppliedRoot']>(
      readAppliedRoot,
    ) ||
    !isCallable<PreparedRollbackDependencies['readApplyRunState']>(
      readApplyRunState,
    ) ||
    !isCallable<PreparedRollbackDependencies['readJournal']>(
      readJournal,
    ) ||
    !isCallable<PreparedRollbackDependencies['createApplySequenceRead']>(
      createApplySequenceRead,
    ) ||
    !isCallable<PreparedRollbackDependencies['parseApplySequence']>(
      parseApplySequence,
    ) ||
    !isCallable<PreparedRollbackDependencies['createApplyMarkerRead']>(
      createApplyMarkerRead,
    ) ||
    !isCallable<PreparedRollbackDependencies['parseApplyMarker']>(
      parseApplyMarker,
    ) ||
    !isCallable<PreparedRollbackDependencies['correlateApplyRows']>(
      correlateApplyRows,
    ) ||
    !isCallable<PreparedRollbackDependencies['createApplySequenceGuard']>(
      createApplySequenceGuard,
    ) ||
    !isCallable<PreparedRollbackDependencies['createApplyMarkerGuard']>(
      createApplyMarkerGuard,
    ) ||
    !isCallable<PreparedRollbackDependencies['get']>(get) ||
    !isCallable<PreparedRollbackDependencies['prepare']>(prepare) ||
    !isCallable<PreparedRollbackDependencies['transact']>(transact)
  ) {
    return failRollback('INVALID_ARGUMENT')
  }
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
    readAppliedRoot: readAppliedRoot.bind(appliedRootReader),
    readApplyRunState:
      readApplyRunState.bind(applyRunStateReader),
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
 * Creates the complete immutable rollback-start DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param root - Strict immutable start root.
 * @returns Complete bounded low-level row.
 */
function createRollbackStartRecord(
  binding: RollbackOperationBinding,
  root: WorkspaceSearchMigrationRollbackStartRoot,
): Readonly<Record<string, AttributeValue>> {
  requireStartRootBinding(binding, root)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createRollbackStartRecordKey(binding),
    },
    recordVersion: { N: String(rollbackRecordVersion) },
    kind: { S: rollbackStartRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    startRootDigest: { S: root.startRootDigest },
    startRootBytes: {
      B: serializeWorkspaceSearchMigrationRollbackStartRoot(root),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Parses one complete immutable rollback-start DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached start root.
 */
function parseRollbackStartRecord(
  binding: RollbackOperationBinding,
  value: unknown,
): WorkspaceSearchMigrationRollbackStartRoot {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rollbackStartRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rollbackStartRecordKind,
    createRollbackStartRecordKey(binding),
  )
  const root =
    parseWorkspaceSearchMigrationRollbackStartRoot(
      readBinaryAttribute(item, 'startRootBytes'),
    )
  if (
    readDigestAttribute(item, 'startRootDigest') !==
      root.startRootDigest
  ) {
    return failRollback('INVALID_STATE')
  }
  requireStartRootBinding(binding, root)
  requireAttributeMapsEqual(
    item,
    createRollbackStartRecord(binding, root),
  )
  return root
}

/**
 * Creates the complete mutable rollback-state DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param state - Strict durable rollback state.
 * @returns Complete bounded low-level row.
 */
function createRollbackStateRecord(
  binding: RollbackOperationBinding,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): Readonly<Record<string, AttributeValue>> {
  requireStateBinding(binding, state)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createRollbackStateRecordKey(binding),
    },
    recordVersion: { N: String(rollbackRecordVersion) },
    kind: { S: rollbackStateRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    appliedRootDigest: { S: state.appliedRootDigest },
    startRootDigest: { S: state.startRootDigest },
    revision: { N: String(state.revision) },
    stateDigest: { S: state.stateDigest },
    stateBytes: {
      B: serializeWorkspaceSearchMigrationRollbackPersistenceState(
        state,
      ),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Parses one complete mutable rollback-state DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached rollback state.
 */
function parseRollbackStateRecord(
  binding: RollbackOperationBinding,
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rollbackStateRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rollbackStateRecordKind,
    createRollbackStateRecordKey(binding),
  )
  const state =
    parseWorkspaceSearchMigrationRollbackPersistenceState(
      readBinaryAttribute(item, 'stateBytes'),
    )
  if (
    readPositiveSafeIntegerAttribute(item, 'revision') !==
      state.revision ||
    readDigestAttribute(item, 'stateDigest') !==
      state.stateDigest ||
    readDigestAttribute(item, 'appliedRootDigest') !==
      state.appliedRootDigest ||
    readDigestAttribute(item, 'startRootDigest') !==
      state.startRootDigest
  ) {
    return failRollback('INVALID_STATE')
  }
  requireStateBinding(binding, state)
  requireAttributeMapsEqual(
    item,
    createRollbackStateRecord(binding, state),
  )
  return state
}

/**
 * Creates one complete immutable reverse-receipt DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param receipt - Strict durable reverse receipt.
 * @returns Complete bounded low-level row.
 */
function createRollbackReceiptRecord(
  binding: RollbackOperationBinding,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): Readonly<Record<string, AttributeValue>> {
  requireReceiptBinding(binding, receipt)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createRollbackReceiptRecordKey(
        binding,
        receipt.sequence,
      ),
    },
    recordVersion: { N: String(rollbackRecordVersion) },
    kind: { S: rollbackReceiptRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    startRootDigest: { S: receipt.startRootDigest },
    sequence: { N: String(receipt.sequence) },
    commandDigest: { S: receipt.commandDigest },
    receiptDigest: { S: receipt.receiptDigest },
    receiptBytes: {
      B: serializeWorkspaceSearchMigrationRollbackOperationReceipt(
        receipt,
      ),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Parses one complete immutable reverse-receipt DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param sequence - Exact expected positive sequence.
 * @param value - Untrusted low-level row.
 * @returns Strict detached reverse receipt.
 */
function parseRollbackReceiptRecord(
  binding: RollbackOperationBinding,
  sequence: number,
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationReceipt {
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
    createRollbackReceiptRecordKey(binding, sequence),
  )
  const receipt =
    parseWorkspaceSearchMigrationRollbackOperationReceipt(
      readBinaryAttribute(item, 'receiptBytes'),
    )
  if (
    readPositiveSafeIntegerAttribute(item, 'sequence') !==
      sequence ||
    receipt.sequence !== sequence ||
    readDigestAttribute(item, 'startRootDigest') !==
      receipt.startRootDigest ||
    readDigestAttribute(item, 'commandDigest') !==
      receipt.commandDigest ||
    readDigestAttribute(item, 'receiptDigest') !==
      receipt.receiptDigest
  ) {
    return failRollback('INVALID_STATE')
  }
  requireReceiptBinding(binding, receipt)
  requireAttributeMapsEqual(
    item,
    createRollbackReceiptRecord(binding, receipt),
  )
  return receipt
}

/**
 * Synchronously detaches and correlates one v1 terminal-root condition input.
 *
 * @param input - Candidate measured table, admission, and terminal root.
 * @returns Strict narrow durable-row binding and immutable root.
 */
function prepareRolledBackRootConditionCheckInput(
  input: unknown,
): PreparedRolledBackRootConditionCheckInput {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'root',
    'stateTable',
  ], 'INVALID_ARGUMENT')
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const stateTable = detachRolledBackRootStateTable(
    readOwn(record, 'stateTable', 'INVALID_ARGUMENT'),
  )
  const executionRun = detachRolledBackRootExecutionRun(
    readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
  )
  const root = detachRolledBackRoot(
    readOwn(record, 'root', 'INVALID_ARGUMENT'),
  )
  // Intentionally discard the condition: its strict builder validates admission.
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
    stateTable,
    configurationHash,
    executionRun,
  })
  const binding: RolledBackRootRecordBinding = {
    stateTable,
    configurationHash,
    executionRun,
    bindingDigest:
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: stateTable.tableId,
        configurationHash,
        runId: executionRun.runId,
        executionRunDigest: executionRun.executionRunDigest,
      }).bindingDigest,
  }
  requireRolledBackRootRecordBinding(binding, root, 'INVALID_ARGUMENT')
  return { binding, root }
}

/**
 * Detaches one migration-state identity used for terminal-root addressing.
 *
 * @param value - Candidate measured migration-state table.
 * @returns Detached minimally narrowed table identity.
 */
function detachRolledBackRootStateTable(
  value: unknown,
): MigrationTableIdentity {
  const candidate = requireTableIdentity(value)
  let detached: unknown
  try {
    detached = structuredClone(candidate)
  } catch {
    return failRollback('INVALID_ARGUMENT')
  }
  return requireTableIdentity(detached)
}

/**
 * Detaches one immutable execution admission through its canonical codec.
 *
 * @param value - Candidate immutable admission.
 * @returns Strict detached admission.
 */
function detachRolledBackRootExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  const candidate = requireExecutionRun(value)
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(candidate),
  )
}

/**
 * Detaches one immutable v1 terminal root through its canonical codec.
 *
 * @param value - Candidate terminal root.
 * @returns Strict detached rolled-back root.
 */
function detachRolledBackRoot(
  value: unknown,
): WorkspaceSearchMigrationRolledBackRoot {
  if (!isRolledBackRootCandidate(value)) {
    return failRollback('INVALID_ARGUMENT')
  }
  return parseWorkspaceSearchMigrationRolledBackRoot(
    serializeWorkspaceSearchMigrationRolledBackRoot(value),
  )
}

/**
 * Minimally narrows a v1 terminal root for its strict codec.
 *
 * @param value - Candidate runtime root.
 * @returns Whether the strict rolled-back-root codec may inspect it.
 */
function isRolledBackRootCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationRolledBackRoot {
  return isOrdinaryObject(value)
}

/**
 * Creates the complete immutable terminal-root DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param root - Strict terminal rollback root.
 * @returns Complete bounded low-level row.
 */
function createRolledBackRootRecord(
  binding: RolledBackRootRecordBinding,
  root: WorkspaceSearchMigrationRolledBackRoot,
): Readonly<Record<string, AttributeValue>> {
  requireRolledBackRootRecordBinding(binding, root, 'INVALID_STATE')
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createRolledBackRootRecordKey(binding),
    },
    recordVersion: { N: String(rollbackRecordVersion) },
    kind: { S: rolledBackRootRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    startRootDigest: { S: root.startRootDigest },
    rootDigest: { S: root.rootDigest },
    rootBytes: {
      B: serializeWorkspaceSearchMigrationRolledBackRoot(root),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Parses one complete immutable terminal-root DynamoDB row.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached terminal root.
 */
function parseRolledBackRootRecord(
  binding: RollbackOperationBinding,
  value: unknown,
): WorkspaceSearchMigrationRolledBackRoot {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rolledBackRootRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rolledBackRootRecordKind,
    createRolledBackRootRecordKey(binding),
  )
  const root = parseWorkspaceSearchMigrationRolledBackRoot(
    readBinaryAttribute(item, 'rootBytes'),
  )
  if (
    readDigestAttribute(item, 'startRootDigest') !==
      root.startRootDigest ||
    readDigestAttribute(item, 'rootDigest') !== root.rootDigest
  ) {
    return failRollback('INVALID_STATE')
  }
  requireRolledBackRootBinding(binding, root)
  requireAttributeMapsEqual(
    item,
    createRolledBackRootRecord(binding, root),
  )
  return root
}

/**
 * Creates one strongly consistent migration-state row read.
 *
 * @param binding - Exact static rollback binding.
 * @param recordKey - Exact deterministic record key.
 * @returns Adapter-owned strong-read command.
 */
function createStrongStateReadCommand(
  binding: RollbackOperationBinding,
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
 * @returns Adapter-owned strong-read command.
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
 * Creates the immutable rollback-start record key.
 *
 * @param binding - Exact static rollback binding.
 * @returns Stable deterministic key.
 */
function createRollbackStartRecordKey(
  binding: RollbackOperationBinding,
): string {
  return createWorkspaceSearchMigrationRollbackStartRecordKey(
    binding.bindingDigest,
  )
}

/**
 * Creates the mutable rollback-state record key.
 *
 * @param binding - Exact static rollback binding.
 * @returns Stable deterministic key.
 */
function createRollbackStateRecordKey(
  binding: RollbackOperationBinding,
): string {
  return `${rollbackStateRecordKeyPrefix}/${binding.bindingDigest}`
}

/**
 * Creates one immutable reverse-receipt record key.
 *
 * @param binding - Exact static rollback binding.
 * @param sequence - Exact positive forward sequence.
 * @returns Stable deterministic key.
 */
function createRollbackReceiptRecordKey(
  binding: RollbackOperationBinding,
  sequence: number,
): string {
  return `${rollbackReceiptRecordKeyPrefix}/${binding.bindingDigest}/${readPositiveSafeInteger(sequence, 'INVALID_ARGUMENT')}`
}

/**
 * Creates the immutable terminal-root record key.
 *
 * @param binding - Exact static rollback binding.
 * @returns Stable deterministic key.
 */
function createRolledBackRootRecordKey(
  binding: Pick<RolledBackRootRecordBinding, 'bindingDigest'>,
): string {
  return `${rolledBackRootRecordKeyPrefix}/${binding.bindingDigest}`
}

/**
 * Builds the fixed twelve-item rollback-start transaction.
 *
 * @param input - Exact authority, complete applied root, and start material.
 * @returns Adapter-owned idempotent transaction command.
 */
function createRollbackStartTransactionCommand(
  input: CreateRollbackStartTransactionCommandInput,
): TransactWriteItemsCommand {
  const authorityChecks = createAuthorityChecks(
    input.binding,
    input.currentAuthority,
    input.commitAt,
  )
  const verificationKeys =
    createFullVerificationConflictRecordKeys(input.binding)
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
    createWorkspaceSearchMigrationAppliedRootConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
      root: input.appliedRoot,
    }),
    createAbsentConditionCheck(
      input.binding.stateTable.tableName,
      createStateKey(verificationKeys.state),
    ),
    createAbsentConditionCheck(
      input.binding.stateTable.tableName,
      createStateKey(verificationKeys.root),
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRollbackStartRecord(input.binding, input.startRoot),
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRollbackStateRecord(
        input.binding,
        input.startRoot.initialState,
      ),
    ),
  ]
  requireTransactionCount(
    items,
    workspaceSearchMigrationRollbackStartTransactionIndex.count,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind: 'workspace-search-migration-rollback-start-transaction',
      version: rollbackRecordVersion,
      startRootDigest: input.startRoot.startRootDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Builds the fixed thirteen-item reverse journal transaction.
 *
 * @param input - Exact authority, predecessor, target, and successor material.
 * @returns Adapter-owned idempotent transaction command.
 */
function createRollbackOperationTransactionCommand(
  input: CreateRollbackOperationTransactionCommandInput,
): TransactWriteItemsCommand {
  if (
    input.receipt.predecessorStateDigest !==
      input.predecessorState.stateDigest ||
    input.receipt.successorStateDigest !==
      input.successorState.stateDigest ||
    input.receipt.sequence !== input.applySequence.receipt.sequence
  ) {
    return failRollback('INVALID_STATE')
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
    createFullRowConditionCheck(
      input.binding.stateTable.tableName,
      createRollbackStartRecord(
        input.binding,
        input.startRoot,
      ),
    ),
    createExactPredecessorPut(
      input.binding.stateTable.tableName,
      createRollbackStateRecord(
        input.binding,
        input.predecessorState,
      ),
      createRollbackStateRecord(
        input.binding,
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
    workspaceSearchMigrationRollbackOperationTransactionIndex.count,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind: 'workspace-search-migration-rollback-operation-transaction',
      version: rollbackRecordVersion,
      commandDigest: input.receipt.commandDigest,
      receiptDigest: input.receipt.receiptDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Builds the fixed ten-item terminal root transaction.
 *
 * @param input - Exact authority, zero-head state, and immutable root.
 * @returns Adapter-owned idempotent terminal transaction.
 */
function createRollbackFinishTransactionCommand(
  input: CreateRollbackFinishTransactionCommandInput,
): TransactWriteItemsCommand {
  if (
    input.root.terminalState.predecessorDigest !==
      input.predecessorState.stateDigest ||
    input.root.terminalState.revision !==
      input.predecessorState.revision + 1
  ) {
    return failRollback('INVALID_STATE')
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
    createFullRowConditionCheck(
      input.binding.stateTable.tableName,
      createRollbackStartRecord(
        input.binding,
        input.startRoot,
      ),
    ),
    createExactPredecessorPut(
      input.binding.stateTable.tableName,
      createRollbackStateRecord(
        input.binding,
        input.predecessorState,
      ),
      createRollbackStateRecord(
        input.binding,
        input.root.terminalState,
      ),
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRolledBackRootRecord(input.binding, input.root),
    ),
  ]
  requireTransactionCount(
    items,
    workspaceSearchMigrationRollbackFinishTransactionIndex.count,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind: 'workspace-search-migration-rollback-finish-transaction',
      version: rollbackRecordVersion,
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
  binding: RollbackOperationBinding,
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
 * Creates the two full-verification rows conflicting with rollback start.
 *
 * @param binding - Exact static rollback binding.
 * @returns Deterministic mutable-state and terminal-root keys.
 */
function createFullVerificationConflictRecordKeys(
  binding: RollbackOperationBinding,
): {
  /** Deterministic mutable verification-state key. */
  readonly state: string
  /** Deterministic immutable verified-root key. */
  readonly root: string
} {
  return createWorkspaceSearchMigrationFullVerificationConflictRecordKeys({
    stateTableId: binding.stateTable.tableId,
    configurationHash: binding.configurationHash,
    runId: binding.executionRun.runId,
    executionRunDigest:
      binding.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthority.authorityDigest,
  })
}

/**
 * Creates one deterministic absent-row condition.
 *
 * @param tableName - Exact measured state table name.
 * @param key - Exact compound migration-state key.
 * @returns Absent-item ConditionCheck.
 */
function createAbsentConditionCheck(
  tableName: string,
  key: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: cloneLowLevelMap(key, 'INVALID_ARGUMENT'),
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
 * Creates one complete controlled-row equality ConditionCheck.
 *
 * @param tableName - Exact measured state table name.
 * @param item - Complete strict predecessor row.
 * @returns Full-controlled-row ConditionCheck.
 */
function createFullRowConditionCheck(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const fields = createFullRowConditionFields(item)
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: readItemKey(item),
      ...fields,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates one exact-predecessor mutable-state CAS Put.
 *
 * @param tableName - Exact measured state table name.
 * @param predecessor - Complete strict predecessor row.
 * @param successor - Complete strict successor row.
 * @returns Full-row CAS Put.
 */
function createExactPredecessorPut(
  tableName: string,
  predecessor: Readonly<Record<string, AttributeValue>>,
  successor: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const predecessorKey = readItemKey(predecessor)
  const successorKey = readItemKey(successor)
  requireAttributeMapsEqual(predecessorKey, successorKey)
  validateDynamoDbItemSize(successor)
  return {
    Put: {
      TableName: tableName,
      Item: cloneLowLevelMap(successor, 'INVALID_STATE'),
      ...createFullRowConditionFields(predecessor),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates complete non-key equality expressions for one controlled row.
 *
 * @param item - Complete strict adapter-owned row.
 * @returns Exact condition expression operands.
 */
function createFullRowConditionFields(
  item: Readonly<Record<string, AttributeValue>>,
): {
  /** Exact conjunction of every controlled non-key field. */
  readonly ConditionExpression: string
  /** Attribute-name substitutions. */
  readonly ExpressionAttributeNames:
    Readonly<Record<string, string>>
  /** Attribute-value substitutions. */
  readonly ExpressionAttributeValues:
    Readonly<Record<string, AttributeValue>>
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  let index = 0
  for (const [name, value] of Object.entries(item)) {
    if (name === 'migrationId' || name === 'recordKey') continue
    const nameToken = `#field${index}`
    const valueToken = `:value${index}`
    names[nameToken] = name
    values[valueToken] = value
    clauses.push(`${nameToken} = ${valueToken}`)
    index += 1
  }
  if (clauses.length === 0) {
    return failRollback('INVALID_STATE')
  }
  return {
    ConditionExpression: clauses.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues:
      cloneLowLevelMap(values, 'INVALID_STATE'),
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
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRollback('INVALID_STATE')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 1 ||
    keys[0] !== 'ConditionCheck' ||
    value.ConditionCheck === undefined
  ) {
    return failRollback('INVALID_STATE')
  }
  return value
}

/**
 * Reads the compound key from a complete migration-state row.
 *
 * @param item - Complete adapter-owned row.
 * @returns Detached exact compound key.
 */
function readItemKey(
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  const migrationId = item.migrationId
  const recordKey = item.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    return failRollback('INVALID_STATE')
  }
  return cloneLowLevelMap(
    { migrationId, recordKey },
    'INVALID_STATE',
  )
}

/**
 * Requires a transaction array to have its fixed public count.
 *
 * @param items - Candidate fixed-order transaction items.
 * @param expected - Exact public fixed count.
 */
function requireTransactionCount(
  items: readonly TransactWriteItem[],
  expected: number,
): void {
  if (items.length !== expected) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Detaches one caller command before any asynchronous boundary.
 *
 * @param input - Candidate public rollback command.
 * @returns Exact detached revision and current authority claim.
 */
function prepareRollbackCommand(
  input: WorkspaceSearchMigrationRollbackCommandInput,
): PreparedRollbackCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'authority',
    'expectedRevision',
  ], 'INVALID_ARGUMENT')
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
 * Detaches one exact current lease, pointer, and receipt claim.
 *
 * @param value - Candidate current rollback authority claim.
 * @returns Strict detached claim suitable for a strong authority read.
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
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(
        record,
        'maintenanceEvidencePointerRevision',
        'INVALID_ARGUMENT',
      ),
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
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
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
    return failRollback('INVALID_STATE')
  }
  return sequence
}

/**
 * Requires an immutable start row to identify the caller's exact begin.
 *
 * @param startRoot - Existing strict immutable start root.
 * @param command - Detached caller begin command.
 */
function requireStartMatchesBeginCommand(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  command: PreparedRollbackCommand,
): void {
  if (
    startRoot.predecessorRevision !== command.expectedRevision ||
    startRoot.currentAuthority.ownerId !==
      command.authority.lease.ownerId ||
    startRoot.currentAuthority.fenceToken !==
      command.authority.lease.fenceToken ||
    startRoot.runId !== command.authority.lease.runId
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires a committed begin winner to preserve every time-independent input.
 *
 * Concurrent attempts can choose different trusted transaction timestamps.
 * Their immutable roots therefore have different digests even though only one
 * is the logical winner for the same predecessor and lease claim.
 *
 * @param command - Detached caller begin command.
 * @param intended - Locally constructed attempted root.
 * @param committed - Strongly read committed root.
 */
function requireStartIsLogicalWinner(
  command: PreparedRollbackCommand,
  intended: WorkspaceSearchMigrationRollbackStartRoot,
  committed: WorkspaceSearchMigrationRollbackStartRoot,
): void {
  requireStartMatchesBeginCommand(committed, command)
  if (
    committed.appliedRootDigest !== intended.appliedRootDigest ||
    committed.predecessorRunStateDigest !==
      intended.predecessorRunStateDigest ||
    committed.originalJournalSequence !==
      intended.originalJournalSequence ||
    committed.originalJournalHeadDigest !==
      intended.originalJournalHeadDigest ||
    committed.executionRunDigest !== intended.executionRunDigest ||
    committed.sealedPlanningAuthorityDigest !==
      intended.sealedPlanningAuthorityDigest
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires one mutable state to belong to and descend from a start root.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Candidate current rollback state.
 */
function requireStateDescendsFromStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): void {
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessor(
    startRoot.currentAuthority,
    state.currentAuthority,
  )
  requireStartAndStateBinding(startRoot, state)
  const revisionOffset =
    state.revision - startRoot.initialState.revision
  if (state.status === 'rolled-back') {
    return requireTerminalStateDescendsFromStart(
      startRoot,
      state,
    )
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
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires one terminal state to be the exact finished descendant of a start.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param state - Candidate terminal rolled-back state.
 */
function requireTerminalStateDescendsFromStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): void {
  requireStartAndStateBinding(startRoot, state)
  if (
    state.status !== 'rolled-back' ||
    state.startRootDigest !== startRoot.startRootDigest ||
    state.upperBoundSequence !==
      startRoot.originalJournalSequence ||
    state.restored !== state.upperBoundSequence ||
    state.nextSequence !== 0 ||
    state.revision !==
      startRoot.initialState.revision +
        state.upperBoundSequence + 1
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires mutable state and terminal root to preserve atomic publication.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param state - Strongly read mutable rollback state.
 * @param root - Strongly read terminal root when present.
 */
function requireRootAtomicity(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
  root: WorkspaceSearchMigrationRolledBackRoot | undefined,
): void {
  if (state.status === 'rolling-back') {
    if (root !== undefined) {
      return failRollback('INVALID_STATE')
    }
    return
  }
  requireTerminalStateDescendsFromStart(startRoot, state)
  if (
    root === undefined ||
    root.startRootDigest !== startRoot.startRootDigest ||
    root.rollbackStartedAt !== startRoot.startedAt ||
    root.terminalStateDigest !== state.stateDigest
  ) {
    return failRollback('INVALID_STATE')
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
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
  command: PreparedRollbackCommand,
  sequence: number,
): void {
  requireStateDescendsFromStart(startRoot, state)
  if (
    state.status !== 'rolling-back' ||
    state.revision !== command.expectedRevision ||
    state.nextSequence !== sequence ||
    state.nextSequence < 1
  ) {
    return failRollback('INVALID_STATE')
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
  command: PreparedRollbackCommand,
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): void {
  requireReceiptBelongsToStart(startRoot, receipt)
  const expectedSequence = deriveRollbackSequence(
    startRoot,
    command.expectedRevision,
  )
  if (
    receipt.startRootDigest !== startRoot.startRootDigest ||
    receipt.sequence !== expectedSequence ||
    receipt.predecessorRevision !== command.expectedRevision ||
    receipt.successorRevision !== command.expectedRevision + 1 ||
    receipt.rollbackReceipt.fenceToken !==
      command.authority.lease.fenceToken
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires a committed reverse-step winner to match the deterministic command.
 *
 * The durable receipt and successor state include the winning transaction
 * timestamp and fresh authority, so their complete digests may differ from a
 * concurrent losing attempt. The deterministic command and predecessor/apply
 * links must remain exact.
 *
 * @param intendedReceipt - Locally constructed attempted receipt.
 * @param intendedState - Locally constructed attempted successor state.
 * @param committedReceipt - Strongly read committed receipt.
 */
function requireReceiptIsLogicalWinner(
  intendedReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt,
  intendedState:
    WorkspaceSearchMigrationRollbackPersistenceState,
  committedReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt,
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
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires an immutable receipt to occupy its exact start-root sequence slot.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param receipt - Candidate immutable reverse receipt.
 */
function requireReceiptBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): void {
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessor(
    startRoot.currentAuthority,
    receipt.currentAuthority,
  )
  const expectedPredecessorRevision =
    startRoot.initialState.revision +
      startRoot.originalJournalSequence - receipt.sequence
  if (
    receipt.startRootDigest !== startRoot.startRootDigest ||
    receipt.sequence < 1 ||
    receipt.sequence > startRoot.originalJournalSequence ||
    receipt.predecessorRevision !==
      expectedPredecessorRevision ||
    receipt.successorRevision !==
      expectedPredecessorRevision + 1
  ) {
    return failRollback('INVALID_STATE')
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
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): void {
  requireStateDescendsFromStart(startRoot, state)
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessor(
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
    return failRollback('INVALID_STATE')
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
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
  command: PreparedRollbackCommand,
): void {
  requireStateDescendsFromStart(startRoot, state)
  if (
    state.status !== 'rolling-back' ||
    state.revision !== command.expectedRevision ||
    state.nextSequence !== 0 ||
    state.restored !== state.upperBoundSequence
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires an existing terminal root to match an exact finish retry.
 *
 * @param root - Existing immutable terminal root.
 * @param command - Detached caller finish command.
 */
function requireRootMatchesFinishCommand(
  root: WorkspaceSearchMigrationRolledBackRoot,
  command: PreparedRollbackCommand,
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
    root.runId !== command.authority.lease.runId
  ) {
    return failRollback('INVALID_STATE')
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
  command: PreparedRollbackCommand,
  intended: WorkspaceSearchMigrationRolledBackRoot,
  committed: WorkspaceSearchMigrationRolledBackRoot,
): void {
  requireRootMatchesFinishCommand(committed, command)
  if (
    committed.startRootDigest !== intended.startRootDigest ||
    committed.rollbackStartedAt !== intended.rollbackStartedAt ||
    committed.terminalState.predecessorDigest !==
      intended.terminalState.predecessorDigest ||
    committed.terminalReceiptDigest !==
      intended.terminalReceiptDigest ||
    committed.terminalState.revision !==
      intended.terminalState.revision
  ) {
    return failRollback('INVALID_STATE')
  }
}

/**
 * Requires one start and state to share every immutable chain binding.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Candidate rollback state.
 */
function requireStartAndStateBinding(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): void {
  if (
    state.runId !== startRoot.runId ||
    state.configurationHash !== startRoot.configurationHash ||
    state.executionRunDigest !==
      startRoot.executionRunDigest ||
    state.appliedRootDigest !== startRoot.appliedRootDigest ||
    state.sealedPlanningAuthorityDigest !==
      startRoot.sealedPlanningAuthorityDigest
  ) {
    return failRollback('INVALID_STATE')
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
  binding: RollbackOperationBinding,
  root: WorkspaceSearchMigrationRollbackStartRoot,
): void {
  if (
    root.runId !== binding.executionRun.runId ||
    root.configurationHash !== binding.configurationHash ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failRollback('INVALID_STATE')
  }
  requireTableIdsEqual(
    binding.executionRun.binding.tableIds,
    root.tableIds,
  )
  requireStateDescendsFromStart(root, root.initialState)
}

/**
 * Requires a rollback state to match the static admitted run.
 *
 * @param binding - Exact static rollback binding.
 * @param state - Candidate strict rollback state.
 */
function requireStateBinding(
  binding: RollbackOperationBinding,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): void {
  if (
    state.runId !== binding.executionRun.runId ||
    state.configurationHash !== binding.configurationHash ||
    state.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    state.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failRollback('INVALID_STATE')
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
  binding: RollbackOperationBinding,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): void {
  if (
    receipt.runId !== binding.executionRun.runId ||
    receipt.configurationHash !== binding.configurationHash ||
    receipt.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    receipt.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failRollback('INVALID_STATE')
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
function requireRolledBackRootBinding(
  binding: RollbackOperationBinding,
  root: WorkspaceSearchMigrationRolledBackRoot,
): void {
  requireRolledBackRootRecordBinding(binding, root, 'INVALID_STATE')
  requireStateBinding(binding, root.terminalState)
}

/**
 * Requires one terminal root to match its immutable durable-row namespace.
 *
 * @param binding - Narrow measured root-row binding.
 * @param root - Candidate strict terminal root.
 * @param code - Stable failure classification for the calling boundary.
 */
function requireRolledBackRootRecordBinding(
  binding: RolledBackRootRecordBinding,
  root: WorkspaceSearchMigrationRolledBackRoot,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    root.runId !== binding.executionRun.runId ||
    root.configurationHash !== binding.configurationHash ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.executionRun.binding.sealedPlanningAuthorityDigest ||
    root.terminalState.startRootDigest !== root.startRootDigest ||
    root.tableIds['migration-state'] !== binding.stateTable.tableId
  ) {
    return failRollback(code)
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      binding.executionRun.binding.tableIds[role] !==
        root.tableIds[role]
    ) {
      return failRollback(code)
    }
  }
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
      return failRollback('CONFIGURATION_DRIFT')
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
    return failRollback('INVALID_JOURNAL')
  }
}

/**
 * Requires the complete applied journal chain to remain commit-safe.
 *
 * @param root - Exact complete applied root.
 * @param commitAt - Adapter-owned final transaction time.
 */
function requireRollbackStartRetention(
  root: WorkspaceSearchMigrationAppliedRoot,
  commitAt: Date,
): void {
  if (root.seal.journalSequence === 0) {
    if (root.minimumJournalRetainUntil !== undefined) {
      requireRetentionHeadroom(
        root.minimumJournalRetainUntil,
        commitAt,
        'INVALID_JOURNAL',
      )
    }
    return
  }
  if (root.minimumJournalRetainUntil === undefined) {
    return failRollback('INVALID_JOURNAL')
  }
  requireRetentionHeadroom(
    root.minimumJournalRetainUntil,
    commitAt,
    'INVALID_JOURNAL',
  )
}

/**
 * Requires the exact selected journal version to remain commit-safe.
 *
 * @param retainUntil - Exact immutable object retention deadline.
 * @param commitAt - Adapter-owned final transaction time.
 */
function requireRollbackJournalRetention(
  retainUntil: string,
  commitAt: Date,
): void {
  requireRetentionHeadroom(
    retainUntil,
    commitAt,
    'INVALID_JOURNAL',
  )
}

/**
 * Requires one canonical deadline to retain the minimum commit window.
 *
 * @param retainUntil - Canonical immutable retention deadline.
 * @param commitAt - Adapter-owned final transaction time.
 * @param code - Stable raw-value-free failure classification.
 */
function requireRetentionHeadroom(
  retainUntil: string,
  commitAt: Date,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    !isCanonicalTimestamp(retainUntil) ||
    Date.parse(retainUntil) - commitAt.getTime() <=
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  ) {
    return failRollback(code)
  }
}

/**
 * Requires resolved authority to match the exact caller lease claim.
 *
 * @param claim - Detached caller lease identity.
 * @param authority - Fresh durable authority.
 */
function requireLeaseClaimMatchesAuthority(
  claim: WorkspaceSearchMigrationLeaseClaim,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  if (
    authority.lease.runId !== claim.runId ||
    authority.lease.ownerId !== claim.ownerId ||
    authority.lease.fenceToken !== claim.fenceToken
  ) {
    return failRollback('LEASE_LOST')
  }
}

/**
 * Requires an apply-receipt capability to share the exact admitted namespace.
 *
 * @param binding - Exact static rollback binding.
 * @param value - Candidate fresh capability identity.
 */
function requireApplyReceiptBindingIdentity(
  binding: RollbackOperationBinding,
  value: unknown,
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
    ) !== createWorkspaceSearchMigrationApplyRunBindingDigest({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      executionRun: binding.executionRun,
    })
  ) {
    return failRollback('INVALID_ARGUMENT')
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
  requireExactKeys(record, [
    'fenceToken',
    'ownerId',
    'runId',
  ], 'INVALID_ARGUMENT')
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
 * Reads one fresh trusted adapter time.
 *
 * @param clock - Captured trusted clock.
 * @returns Fresh detached valid Date.
 */
function readClock(clock: () => Date): Date {
  return clock()
}

/**
 * Captures one Date-returning clock behind a strict runtime check.
 *
 * @param value - Candidate trusted clock.
 * @returns Captured detached clock.
 */
function snapshotClock(value: unknown): () => Date {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRollback('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(
      value,
      undefined,
      [],
    )
    if (
      nodeUtilTypes.isProxy(candidate) ||
      !(candidate instanceof Date)
    ) {
      return failRollback('INVALID_STATE')
    }
    let milliseconds: number
    try {
      milliseconds = Date.prototype.getTime.call(candidate)
    } catch {
      return failRollback('INVALID_STATE')
    }
    if (!Number.isSafeInteger(milliseconds)) {
      return failRollback('INVALID_STATE')
    }
    return new Date(milliseconds)
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
    return failRollback('INVALID_ARGUMENT')
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
      return failRollback('INVALID_ARGUMENT')
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failRollback('INVALID_ARGUMENT')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
    depth += 1
  }
  return failRollback('INVALID_ARGUMENT')
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
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows a configuration before strict detachment.
 *
 * @param value - Candidate measured configuration.
 * @returns Minimally narrowed configuration.
 */
function requireConfiguration(
  value: unknown,
): WorkspaceSearchMigrationConfiguration {
  if (!isConfigurationCandidate(value)) {
    return failRollback('INVALID_ARGUMENT')
  }
  return value
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
    return failRollback('INVALID_ARGUMENT')
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
    return failRollback('INVALID_ARGUMENT')
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
    return failRollback('INVALID_ARGUMENT')
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
    return failRollback('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate measured configuration.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict configuration detacher may inspect it.
 */
function isConfigurationCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationConfiguration {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate execution boundary.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the strict boundary codec may inspect it.
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
 * @returns Whether the strict sealed-authority codec may inspect it.
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
 * @returns Whether the strict execution-run codec may inspect it.
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
 * @returns Whether the strict writer-fence reader may inspect it.
 */
function isClosedWriterFenceRecordCandidate(
  value: unknown,
): value is WorkspaceSearchWriterFenceClosedRecord {
  return isOrdinaryObject(value)
}

/**
 * Structurally narrows a migration-state table before an existing strict guard.
 *
 * @param value - Candidate measured table identity.
 * @returns Minimally narrowed table identity.
 */
function requireTableIdentity(
  value: unknown,
): MigrationTableIdentity {
  if (!isMigrationStateTableIdentityCandidate(value)) {
    return failRollback('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Detects the safe discriminator fields needed by a strict table consumer.
 *
 * @param value - Candidate runtime value.
 * @returns Whether it can be passed to an existing strict binding factory.
 */
function isMigrationStateTableIdentityCandidate(
  value: unknown,
): value is MigrationTableIdentity {
  if (!isOrdinaryObject(value)) return false
  return readOwnStringIfData(value, 'role') ===
      'migration-state' &&
    readOwnStringIfData(value, 'tableName') !== undefined &&
    readOwnStringIfData(value, 'tableId') !== undefined
}

/**
 * Narrows one non-Proxy non-array object.
 *
 * @param value - Candidate runtime value.
 * @returns Whether it is safe for a strict codec to inspect.
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
 * Losslessly detaches one low-level DynamoDB attribute map.
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
    return failRollback(code)
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
    return failRollback('INVALID_STATE')
  }
  if (
    Reflect.ownKeys(output).some(
      (key) => typeof key === 'symbol',
    )
  ) {
    return failRollback('INVALID_STATE')
  }
  const descriptor =
    Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failRollback('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Creates one stable digest for an optional low-level GetItem result.
 *
 * @param output - Raw low-level GetItem response.
 * @returns Exact item digest, or null when the item is absent.
 */
function readOutputItemDigest(output: unknown): string | null {
  const value = readOutputItem(output)
  if (value === undefined) return null
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  try {
    return createMigrationDigest(encodeUnknownAttributeMap(item))
  } catch {
    return failRollback('INVALID_STATE')
  }
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
    return failRollback(code)
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
    return failRollback('INVALID_STATE')
  }
  if (leftDigest !== rightDigest) {
    return failRollback('INVALID_STATE')
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
  binding: RollbackOperationBinding,
  item: Readonly<Record<string, AttributeValue>>,
  kind: string,
  recordKey: string,
): void {
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !== recordKey ||
    readPositiveSafeIntegerAttribute(item, 'recordVersion') !==
      rollbackRecordVersion ||
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
    return failRollback('INVALID_STATE')
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
    : failRollback('INVALID_STATE')
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
    return failRollback('INVALID_STATE')
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
    return failRollback('INVALID_STATE')
  }
  const bytes = new Uint8Array(value)
  return bytes.byteLength > 0
    ? bytes
    : failRollback('INVALID_STATE')
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
    return failRollback(code)
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
    return failRollback(code)
  }
  const actualStrings = Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some((key, index) => key !== expected[index])
  ) {
    return failRollback(code)
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
    return failRollback(code)
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
    return failRollback(code)
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
    : failRollback(code)
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
    return failRollback(code)
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
 * Classifies one failed fixed-order rollback transaction.
 *
 * @param error - Raw transaction failure.
 * @param kind - Exact rollback transaction family.
 * @returns Stable secret-free failure code.
 */
function classifyRollbackTransactionError(
  error: unknown,
  kind: RollbackTransactionKind,
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
      const index = kind === 'begin'
        ? workspaceSearchMigrationRollbackStartTransactionIndex
        : kind === 'operation'
        ? workspaceSearchMigrationRollbackOperationTransactionIndex
        : workspaceSearchMigrationRollbackFinishTransactionIndex
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
          workspaceSearchMigrationRollbackOperationTransactionIndex.target,
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
    if (readErrorName(error) === 'TransactionInProgressException') {
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
type RollbackAwsClassificationInput =
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
): RollbackAwsClassificationInput {
  const input: {
    name: string
    message: string
    $metadata?: {
      httpStatusCode?: number
    }
    code?: string
  } = {
    name: readErrorName(error) ?? 'Error',
    message:
      'Workspace Search migration rollback operation failed.',
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
function readRollbackReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (nodeUtilTypes.isProxy(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (error instanceof RollbackOperationFailure) {
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
 * DynamoDB strongly consistent point reads do not form a cross-item snapshot.
 * A transaction can therefore commit between the individual reads. Three
 * bounded observations allow one torn first observation followed by two equal
 * post-transaction observations without converting healthy atomic progress
 * into apparent corruption.
 *
 * @param readSnapshot - Reads one complete collection of related rows.
 * @param isSameSnapshot - Compares only immutable digests and exact item bytes.
 * @returns The latest of two consecutive equal observations.
 */
async function readCoherentRollbackSnapshot<Value>(
  readSnapshot: () => Promise<Value>,
  isSameSnapshot: (left: Value, right: Value) => boolean,
): Promise<Value> {
  let previous = await readSnapshot()
  for (let index = 1; index < 3; index += 1) {
    const current = await readSnapshot()
    if (isSameSnapshot(previous, current)) return current
    previous = current
  }
  return failRollback('AMBIGUOUS_OPERATION_UNRESOLVED')
}

/**
 * Runs one asynchronous public rollback operation behind a stable boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful operation result.
 */
async function runRollbackBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createRollbackPublicFailure(
      readRollbackFailureCode(error, false),
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
function readRollbackFailureCode(
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
    if (error instanceof RollbackOperationFailure) {
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
 * Private stable failure inside the rollback adapter boundary.
 */
class RollbackOperationFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'RollbackOperationFailure'
    this.code = code
  }
}

/**
 * Creates one generic public rollback persistence failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Raw-value-free public migration failure.
 */
function createRollbackPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration rollback operation failed.',
  )
}

/**
 * Raises one private stable rollback failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failRollback(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new RollbackOperationFailure(code)
}
