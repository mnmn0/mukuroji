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
  createWorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  createWorkspaceSearchMigrationApplyCheckpointReceipt,
  createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey,
  createWorkspaceSearchMigrationApplyCheckpointSnapshot,
  decodeWorkspaceSearchMigrationApplyCheckpointSnapshot,
  parseWorkspaceSearchMigrationApplyCheckpointReceipt,
  serializeWorkspaceSearchMigrationApplyCheckpointReceipt,
  type WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  type WorkspaceSearchMigrationApplyCheckpointReceipt,
} from './migration-apply-checkpoint-receipt'
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
  createAttributeMapDigest,
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
  type MigrationSourceCheckpoint,
  type MigrationItemSnapshot,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  parseWorkspaceSearchPlannedOperation,
  serializeWorkspaceSearchPlannedOperation,
} from './migration-artifacts'
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
  createWorkspaceSearchMigrationExecutionRunAdmissionRecord,
} from './migration-execution-run-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  createWorkspaceSearchMigrationExecutionState,
  parseWorkspaceSearchMigrationExecutionState,
  parseWorkspaceSearchMigrationOperationMarker,
  reconstructWorkspaceSearchMigrationRunState,
  serializeWorkspaceSearchMigrationExecutionState,
  serializeWorkspaceSearchMigrationOperationMarker,
  type WorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionStateV2,
} from './migration-execution-state'
import {
  createWorkspaceSearchMigrationAppliedRoot,
  createWorkspaceSearchMigrationCompleteApplySeal,
  parseWorkspaceSearchMigrationAppliedRoot,
  readWorkspaceSearchMigrationCompleteApplySealReference,
  requireWorkspaceSearchMigrationAppliedRootBinding,
  serializeWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationAppliedRoot,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationItemConditionMaterial,
  verifyWorkspaceSearchMigrationItemStrongRead,
  type WorkspaceSearchMigrationItemConditionMaterial,
} from './migration-item-condition-aws'
import {
  createAbsentMigrationItemDigest,
} from './migration-journal'
import {
  type WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import {
  type WorkspaceSearchMigrationApplySealAwsGateway,
} from './migration-apply-seal-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
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
  createWorkspaceSearchApplyJournalSegment,
  createWorkspaceSearchApplyOperationRecordedEvent,
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchPlannedOperationForApply,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  type WorkspaceSearchApplyOperationCommandEvent,
  type WorkspaceSearchMigrationCheckpointCommandInput,
  type WorkspaceSearchMigrationCheckpointLocation,
  type WorkspaceSearchMigrationCommandInput,
  type WorkspaceSearchMigrationAuthority,
  type WorkspaceSearchMigrationLeaseClaim,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'

const applyRecordVersion = 1
const executionStateRecordKind =
  'workspace-search-migration-execution-state-record'
const operationMarkerRecordKind =
  'workspace-search-migration-apply-operation-marker'
const journalSequenceRecordKind =
  'workspace-search-migration-apply-journal-sequence'
const checkpointReceiptRecordKind =
  'workspace-search-migration-apply-checkpoint-receipt'
const appliedRootRecordKind =
  'workspace-search-migration-applied-root-record'
const executionStateRecordKeyPrefix = 'execution-state/v1'
const operationMarkerRecordKeyPrefix = 'apply-operation/v1'
const journalSequenceRecordKeyPrefix = 'apply-journal-sequence/v1'
const appliedRootRecordKeyPrefix = 'apply-seal/v1'
const transactionTimeoutMilliseconds = 5_000
const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const mutationTransactionItemCount = 12
const noOpTransactionItemCount = 11
const checkpointTransactionItemCount = 9
const applySealTransactionItemCount = 9

/**
 * Fixed transaction and cancellation-reason positions for one apply operation.
 */
export const workspaceSearchMigrationApplyOperationTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning-admitted boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning-authority root condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable revision-one execution admission condition. */
    executionRun: 6,
    /** Absent or exact-predecessor mutable execution-state Put. */
    executionState: 7,
    /** Exact source item condition. */
    source: 8,
    /** Exact target condition and Put, Delete, or no-op check. */
    target: 9,
    /** Absent operation-id marker Put. */
    operationMarker: 10,
    /** Absent mutation-only journal-sequence index Put. */
    journalSequence: 11,
    /** Fixed no-op transaction item count. */
    noOpCount: noOpTransactionItemCount,
    /** Fixed mutating transaction item count. */
    mutationCount: mutationTransactionItemCount,
  })

/**
 * Fixed transaction and cancellation-reason positions for one apply checkpoint.
 */
export const workspaceSearchMigrationApplyCheckpointTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning-admitted boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning-authority root condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable revision-one execution admission condition. */
    executionRun: 6,
    /** Absent or exact-predecessor mutable execution-state Put. */
    executionState: 7,
    /** Absent immutable checkpoint receipt Put. */
    checkpointReceipt: 8,
    /** Fixed checkpoint transaction item count. */
    count: checkpointTransactionItemCount,
  })

/**
 * Fixed transaction and cancellation-reason positions for complete apply seal.
 */
export const workspaceSearchMigrationApplySealTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning-admitted boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning-authority root condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable revision-one execution admission condition. */
    executionRun: 6,
    /** Exact terminal mutable execution-state predecessor condition. */
    executionState: 7,
    /** Absent deterministic immutable applied-root Put. */
    appliedRoot: 8,
    /** Fixed complete apply-seal transaction item count. */
    count: applySealTransactionItemCount,
  })

/**
 * Adapter-owned source of trusted apply preparation and commit time.
 *
 * @returns Current trusted adapter time.
 */
export type WorkspaceSearchMigrationApplyOperationAwsClock = () => Date

/**
 * Narrow current-authority reader used before every apply transaction.
 */
export interface WorkspaceSearchMigrationApplyOperationAuthorityPort {
  /**
   * Resolves the exact current lease, pointer, and immutable receipt.
   *
   * @param claim - Exact caller lease and current receipt claim.
   * @returns Fresh strongly resolved durable authority.
   */
  readAuthority(
    claim: {
      /** Exact active lease identity. */
      readonly lease: WorkspaceSearchMigrationLeaseClaim
      /** Digest of the current immutable maintenance receipt. */
      readonly maintenanceEvidenceReceiptDigest: string
      /** Exact current maintenance pointer revision. */
      readonly maintenanceEvidencePointerRevision: number
    },
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>
}

/**
 * Narrow strongly consistent and transactional transport for apply progress.
 */
export interface WorkspaceSearchMigrationApplyOperationAwsTransport {
  /**
   * Strongly reads one adapter-owned state, marker, source, or target item.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getApplyItem(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes all-six-table measured-incarnation guards before commit.
   */
  prepareApplyWrite(): Promise<void>

  /**
   * Sends one fixed-order operation or checkpoint transaction.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteApply(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Adapter-owned strongly consistent one-page checkpoint scanner.
 */
export interface WorkspaceSearchMigrationApplyCheckpointScanner {
  /**
   * Scans and reduces exactly one next source or target page.
   *
   * @param input - Exact measured location and durable predecessor checkpoint.
   * @returns Complete cumulative checkpoint after exactly one bounded page.
   */
  scanApplyCheckpointPage(
    input: {
      /** Source or target table selected by the durable command. */
      readonly location: WorkspaceSearchMigrationCheckpointLocation
      /** Exact checkpoint read from the current durable run state. */
      readonly previousCheckpoint: MigrationSourceCheckpoint
    },
  ): Promise<MigrationSourceCheckpoint>
}

/**
 * Static measured material and narrow dependencies for one apply adapter.
 */
export type CreateWorkspaceSearchMigrationApplyOperationAwsPortInput = {
  /** Complete independently measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority version-two root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact canonical closed writer-fence row fixed by the boundary. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact immutable revision-one execution admission row. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh-authority reader bound to the measured migration-state table. */
  readonly authorityPort:
    WorkspaceSearchMigrationApplyOperationAuthorityPort
  /** Run-scoped immutable exact-version journal gateway. */
  readonly journalGateway:
    WorkspaceSearchMigrationJournalAwsGateway
  /** Run-scoped immutable exact-version complete apply-seal gateway. */
  readonly applySealGateway:
    WorkspaceSearchMigrationApplySealAwsGateway
  /** Strongly consistent measured source and target checkpoint scanner. */
  readonly checkpointScanner:
    WorkspaceSearchMigrationApplyCheckpointScanner
  /** Narrow measured DynamoDB transport. */
  readonly transport:
    WorkspaceSearchMigrationApplyOperationAwsTransport
  /** Adapter-owned trusted clock. */
  readonly clock: WorkspaceSearchMigrationApplyOperationAwsClock
}

/**
 * Caller command for adapter-owned complete apply sealing.
 */
export type WorkspaceSearchMigrationApplySealCommandInput = {
  /** Exact terminal applying-state revision expected by the caller. */
  readonly expectedRevision: number
  /** Exact active lease identity authorizing the transition. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
}

/**
 * Atomic apply-operation and checkpoint persistence capability.
 */
export interface WorkspaceSearchMigrationApplyOperationAwsPort {
  /**
   * Strongly reads and reconstructs the current admitted execution state.
   *
   * @returns Exact immutable admission or mutable successor run state.
   */
  readRunState(): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Strongly reads one immutable operation-id marker.
   *
   * @param operationId - Stable planned operation identifier.
   * @returns Exact marker or undefined when it has not committed.
   */
  readOperationMarker(
    operationId: string,
  ): Promise<WorkspaceSearchOperationMarker | undefined>

  /**
   * Strongly reads one mutation receipt by journal sequence.
   *
   * @param sequence - Positive committed mutation sequence.
   * @returns Exact receipt or undefined when it has not committed.
   */
  readApplyReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchOperationReceipt | undefined>

  /**
   * Uploads a mutation preimage and atomically commits one strict next plan item.
   *
   * Caller-supplied journal evidence is rejected because this adapter owns the
   * immutable upload, rich reference, trusted clock, and final transaction.
   *
   * @param input - Expected revision, lease claim, and next sealed-plan entry.
   * @returns Exact reconciled durable run state.
   */
  commitApplyOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchApplyOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Strongly scans and atomically persists one next apply checkpoint page.
   *
   * @param input - Exact revision, lease claim, and source or target location.
   * @returns Exact reconciled durable run state.
   */
  saveApplyCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Uploads the adapter-owned complete seal and atomically publishes applied.
   *
   * @param input - Exact terminal predecessor revision and active lease.
   * @returns Exact reconciled durable applied run state.
   */
  sealApply(
    input: WorkspaceSearchMigrationApplySealCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState>
}

/**
 * Detached construction-time binding retained by the adapter.
 */
type ApplyOperationBinding = {
  /** Complete detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed exact configuration digest. */
  readonly configurationHash: string
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Exact measured Workspace Search target table. */
  readonly targetTable: MigrationTableIdentity
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact canonical closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact deterministic durable admission-row key. */
  readonly executionRunKey:
    Readonly<Record<string, AttributeValue>>
  /** Exact complete immutable durable admission row. */
  readonly executionRunRecord:
    Readonly<Record<string, AttributeValue>>
  /** Stable digest used by every deterministic apply-state key. */
  readonly bindingDigest: string
}

/**
 * Captured dependency methods immune to later caller property replacement.
 */
type PreparedApplyDependencies = {
  /**
   * Resolves one fresh authority claim.
   *
   * @param claim - Detached exact authority claim.
   * @returns Fresh durable authority.
   */
  readonly readAuthority: (
    claim: {
      /** Exact active lease identity. */
      readonly lease: WorkspaceSearchMigrationLeaseClaim
      /** Current immutable receipt digest. */
      readonly maintenanceEvidenceReceiptDigest: string
      /** Current pointer revision. */
      readonly maintenanceEvidencePointerRevision: number
    },
  ) => Promise<WorkspaceSearchMigrationPrePlanAuthority>
  /**
   * Writes one immutable journal segment.
   *
   * @param segment - Exact mutation preimage segment.
   * @returns Rich exact-version journal reference.
   */
  readonly writeJournal: WorkspaceSearchMigrationJournalAwsGateway[
    'writeJournalSegment'
  ]
  /**
   * Reads one exact immutable journal version.
   *
   * @param reference - Rich exact-version journal reference.
   * @returns Strict detached preimage segment.
   */
  readonly readJournal: WorkspaceSearchMigrationJournalAwsGateway[
    'readJournalSegment'
  ]
  /**
   * Writes one immutable complete-plan apply seal.
   *
   * @param seal - Exact adapter-owned complete seal document.
   * @returns Rich exact-version complete-seal reference.
   */
  readonly writeApplySeal: WorkspaceSearchMigrationApplySealAwsGateway[
    'writeCompleteApplySeal'
  ]
  /**
   * Reads one exact immutable complete-plan apply seal version.
   *
   * @param reference - Rich exact-version complete-seal reference.
   * @returns Strict detached complete seal document.
   */
  readonly readApplySeal: WorkspaceSearchMigrationApplySealAwsGateway[
    'readCompleteApplySeal'
  ]
  /**
   * Strongly scans and reduces one next apply checkpoint page.
   *
   * @param input - Exact location and durable predecessor checkpoint.
   * @returns Complete cumulative checkpoint after one bounded page.
   */
  readonly scanCheckpoint:
    WorkspaceSearchMigrationApplyCheckpointScanner[
      'scanApplyCheckpointPage'
    ]
  /**
   * Strongly reads one adapter-owned DynamoDB item.
   *
   * @param command - Exact GetItem command.
   * @returns Raw low-level response.
   */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /** Completes measured-incarnation preparation. */
  readonly prepare: () => Promise<void>
  /**
   * Sends one exact apply transaction.
   *
   * @param command - Fixed-order transaction command.
   * @returns Raw low-level response.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
  /** Returns one trusted epoch millisecond. */
  readonly clock: () => number
}

/**
 * Fully detached caller command before the first asynchronous boundary.
 */
type PreparedApplyCommand = {
  /** Exact expected durable revision. */
  readonly expectedRevision: number
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Strict detached next plan operation. */
  readonly plannedOperation: WorkspaceSearchPlannedOperation
}

/**
 * Fully detached checkpoint command before the first asynchronous boundary.
 */
type PreparedApplyCheckpointCommand = {
  /** Exact expected durable revision. */
  readonly expectedRevision: number
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Source or target traversal selected by the command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Deterministic command identity used by the immutable receipt. */
  readonly identity: WorkspaceSearchMigrationApplyCheckpointCommandIdentity
}

/**
 * Fully detached complete apply-seal command before the first await.
 */
type PreparedApplySealCommand = {
  /** Exact expected terminal applying-state revision. */
  readonly expectedRevision: number
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
}

/**
 * Current effective state and its optional mutable durable envelope.
 */
type EffectiveApplyState = {
  /** Complete reconstructed state-machine value. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Immutable applied phase root, when the complete seal committed. */
  readonly appliedRoot?: WorkspaceSearchMigrationAppliedRoot
  /** Mutable envelope, absent only before the first operation. */
  readonly executionState?: WorkspaceSearchMigrationExecutionState
  /** Exact mutable durable record, absent only before the first operation. */
  readonly executionStateRecord?: Readonly<Record<string, AttributeValue>>
}

/**
 * Strongly read exact terminal v2 state required by root publication.
 */
type TerminalEffectiveApplyState = {
  /** Complete reconstructed terminal applying state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Exact terminal traversal-capable mutable envelope. */
  readonly executionState: WorkspaceSearchMigrationExecutionStateV2
  /** Complete durable terminal execution-state record. */
  readonly executionStateRecord:
    Readonly<Record<string, AttributeValue>>
}

/**
 * Strict durable operation-marker row projection.
 */
type DurableApplyMarker = {
  /** Exact strict no-op or mutation marker. */
  readonly marker: WorkspaceSearchOperationMarker
  /** Revision condition-checked by the transaction. */
  readonly predecessorRevision: number
  /** Revision produced by the transaction. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the exact marker bytes. */
  readonly markerDigest: string
}

/**
 * Constructs one measured atomic apply adapter.
 *
 * @param input - Measured identities, immutable authority, and narrow ports.
 * @returns Atomic apply operation and checkpoint persistence capability.
 */
export function createAwsWorkspaceSearchMigrationApplyOperationPort(
  input: CreateWorkspaceSearchMigrationApplyOperationAwsPortInput,
): WorkspaceSearchMigrationApplyOperationAwsPort {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'applySealGateway',
      'authorityPort',
      'checkpointScanner',
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
    const binding = createApplyOperationBinding(
      readOwn(record, 'configuration', 'INVALID_ARGUMENT'),
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionBoundary', 'INVALID_ARGUMENT'),
      readOwn(record, 'sealedPlanningAuthority', 'INVALID_ARGUMENT'),
      readOwn(record, 'closedWriterFenceRecord', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
    )
    const dependencies = prepareApplyDependencies(
      readOwn(record, 'authorityPort', 'INVALID_ARGUMENT'),
      readOwn(record, 'journalGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'applySealGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'checkpointScanner', 'INVALID_ARGUMENT'),
      readOwn(record, 'transport', 'INVALID_ARGUMENT'),
      readOwn(record, 'clock', 'INVALID_ARGUMENT'),
    )
    return new AwsWorkspaceSearchMigrationApplyOperationPort(
      binding,
      dependencies,
    )
  } catch (error: unknown) {
    throw createApplyPublicFailure(
      readApplyFailureCode(error, true),
    )
  }
}

/**
 * Concrete atomic apply operation and checkpoint adapter.
 */
class AwsWorkspaceSearchMigrationApplyOperationPort
implements WorkspaceSearchMigrationApplyOperationAwsPort {
  /** Detached exact static apply binding. */
  private readonly binding: ApplyOperationBinding

  /** Captured narrow dependency methods. */
  private readonly dependencies: PreparedApplyDependencies

  /**
   * Creates one adapter from already validated material.
   *
   * @param binding - Exact static authority and table binding.
   * @param dependencies - Captured narrow dependency methods.
   */
  constructor(
    binding: ApplyOperationBinding,
    dependencies: PreparedApplyDependencies,
  ) {
    this.binding = binding
    this.dependencies = dependencies
  }

  /**
   * Strongly reads and reconstructs current execution state.
   *
   * @returns Exact current run state.
   */
  async readRunState(): Promise<WorkspaceSearchMigrationRunState> {
    return runApplyBoundary(async () =>
      (await this.readEffectiveState()).runState
    )
  }

  /**
   * Strongly reads one operation-id marker.
   *
   * @param operationId - Stable planned operation identifier.
   * @returns Exact marker or undefined.
   */
  async readOperationMarker(
    operationId: string,
  ): Promise<WorkspaceSearchOperationMarker | undefined> {
    return runApplyBoundary(async () => {
      const exactOperationId = readDigest(operationId, 'INVALID_ARGUMENT')
      return (await this.readMarker(exactOperationId))?.marker
    })
  }

  /**
   * Strongly reads one mutation journal-sequence receipt.
   *
   * @param sequence - Positive mutation sequence.
   * @returns Exact mutation receipt or undefined.
   */
  async readApplyReceipt(
    sequence: number,
  ): Promise<WorkspaceSearchOperationReceipt | undefined> {
    return runApplyBoundary(async () => {
      const exactSequence = readPositiveSafeInteger(
        sequence,
        'INVALID_ARGUMENT',
      )
      const durable = await this.readSequence(exactSequence)
      if (durable === undefined) return undefined
      if (durable.marker.kind !== 'workspace-search-operation-applied') {
        return failApply('INVALID_STATE')
      }
      const operationMarker = await this.readMarker(
        durable.marker.operationId,
      )
      if (
        operationMarker === undefined ||
        operationMarker.markerDigest !== durable.markerDigest ||
        operationMarker.predecessorRevision !==
          durable.predecessorRevision ||
        operationMarker.successorRevision !==
          durable.successorRevision ||
        operationMarker.successorExecutionStateDigest !==
          durable.successorExecutionStateDigest
      ) {
        return failApply('INVALID_STATE')
      }
      return durable.marker
    })
  }

  /**
   * Uploads and atomically commits one strict next plan operation.
   *
   * @param input - Expected revision, lease claim, and adapter request.
   * @returns Exact reconciled durable run state.
   */
  async commitApplyOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchApplyOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState> {
    return runApplyBoundary(async () => {
      const command = prepareApplyCommand(input, this.binding)
      const existing = await this.readMarker(
        command.plannedOperation.operation.operationId,
      )
      if (existing !== undefined) {
        return this.reconcileCommittedOperation(command, existing)
      }
      const [authority, current] = await Promise.all([
        this.resolveAuthority(command),
        this.readEffectiveState(),
      ])
      if (
        current.runState.revision !== command.expectedRevision
      ) {
        return failApply('INVALID_STATE')
      }
      validateWorkspaceSearchPlannedOperationForApply(
        current.runState,
        command.plannedOperation,
      )
      requireLeaseClaimMatchesAuthority(command.lease, authority)
      if (
        command.plannedOperation.operation.before.digest !==
          command.plannedOperation.operation.after.digest &&
        await this.readSequence(
          current.runState.journalSequence + 1,
        ) !== undefined
      ) {
        return failApply('INVALID_STATE')
      }

      const preflightAt = readClock(this.dependencies.clock)
      requireProgressRetention(
        this.binding,
        current.executionState,
        preflightAt,
      )
      const operation = command.plannedOperation.operation
      const sourceSnapshot = createSourceSnapshot(operation)
      const sourceTable =
        this.binding.configuration.tables[
          operation.sourceCondition.source
        ]
      const sourceCondition =
        createWorkspaceSearchMigrationItemConditionMaterial(
          sourceTable,
          operation.sourceCondition.key,
          sourceSnapshot,
          sourceSchemaKnownAttributeNames(
            operation.sourceCondition.source,
            sourceTable,
          ),
        )
      const targetCondition =
        createWorkspaceSearchMigrationItemConditionMaterial(
          this.binding.targetTable,
          operation.targetKey,
          operation.before,
          targetSchemaKnownAttributeNames(this.binding.targetTable),
        )
      requireValidAfterSnapshot(
        this.binding.targetTable,
        operation,
      )
      const [sourceOutput, targetOutput] = await Promise.all([
        this.dependencies.get(
          createStrongReadCommand(
            sourceTable,
            operation.sourceCondition.key,
          ),
        ),
        this.dependencies.get(
          createStrongReadCommand(
            this.binding.targetTable,
            operation.targetKey,
          ),
        ),
      ])
      verifyWorkspaceSearchMigrationItemStrongRead(
        sourceTable,
        operation.sourceCondition.key,
        sourceSnapshot,
        sourceOutput,
        'SOURCE_DRIFT',
      )
      verifyWorkspaceSearchMigrationItemStrongRead(
        this.binding.targetTable,
        operation.targetKey,
        operation.before,
        targetOutput,
        'TARGET_DRIFT',
      )

      let journal:
        WorkspaceSearchApplyOperationCommandEvent['journal']
      if (operation.before.digest !== operation.after.digest) {
        const preparedAt = readClock(this.dependencies.clock)
        if (preparedAt < preflightAt) {
          return failApply('INVALID_STATE')
        }
        const segment = createWorkspaceSearchApplyJournalSegment({
          state: current.runState,
          plannedOperation: command.plannedOperation,
          preparedFenceToken: authority.lease.fenceToken,
          createdAt: new Date(preparedAt).toISOString(),
        })
        let referenceValue: unknown
        try {
          referenceValue = await this.dependencies.writeJournal(segment)
        } catch (error: unknown) {
          if (error instanceof WorkspaceSearchMigrationFailure) {
            const code: unknown = error.code
            if (
              isWorkspaceSearchMigrationFailureCode(code) &&
              code !== 'INVALID_STATE'
            ) {
              return failApply(code)
            }
          }
          return failApply('JOURNAL_WRITE_FAILED')
        }
        journal = {
          segment,
          reference: readJournalReference(referenceValue),
        }
      }

      await this.dependencies.prepare()
      const commitAtMilliseconds = readClock(this.dependencies.clock)
      if (commitAtMilliseconds < preflightAt) {
        return failApply('INVALID_STATE')
      }
      const commitAt = new Date(commitAtMilliseconds)
      requireCommitRetention(
        this.binding,
        current.executionState,
        journal?.reference.retainUntil,
        commitAtMilliseconds,
      )
      const transitionAuthority: WorkspaceSearchMigrationAuthority = {
        lease: authority.lease,
        ownerId: authority.lease.ownerId,
        at: commitAt.toISOString(),
      }
      const event = createWorkspaceSearchApplyOperationRecordedEvent(
        current.runState,
        transitionAuthority,
        {
          kind: 'apply-operation-requested',
          plannedOperation: command.plannedOperation,
          ...(journal === undefined ? {} : { journal }),
        },
      )
      const nextRunState = reduceWorkspaceSearchMigrationRunState({
        current: current.runState,
        expectedRevision: command.expectedRevision,
        authority: transitionAuthority,
        event,
      })
      const nextExecutionState =
        createWorkspaceSearchMigrationExecutionState({
          admission: this.binding.executionRun,
          ...(current.executionState === undefined
            ? {}
            : { predecessor: current.executionState }),
          nextRunState,
          marker: event.marker,
        })
      const transaction = createApplyTransactionCommand({
        binding: this.binding,
        currentAuthority: authority,
        commitAt,
        operation,
        sourceCondition,
        targetCondition,
        predecessorState: current.executionState,
        predecessorStateRecord: current.executionStateRecord,
        successorState: nextExecutionState,
        marker: event.marker,
      })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const managedGuardCode = readPublicFailureCode(error)
        if (managedGuardCode !== undefined) {
          return failApply(managedGuardCode)
        }
        transactionError = error
      }
      return this.reconcileAfterAttempt(
        command,
        transactionError,
      )
    })
  }

  /**
   * Strongly scans and atomically persists one next apply checkpoint page.
   *
   * @param input - Exact revision, lease claim, and source or target location.
   * @returns Exact reconciled durable run state.
   */
  async saveApplyCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState> {
    return runApplyBoundary(async () => {
      const command = prepareApplyCheckpointCommand(
        input,
        this.binding,
      )
      const existing = await this.readCheckpointReceipt(
        command.identity,
      )
      if (existing !== undefined) {
        return this.reconcileCheckpointReceipt(command, existing)
      }

      const [initialAuthority, initial] = await Promise.all([
        this.resolveAuthority(command),
        this.readEffectiveState(),
      ])
      requireCheckpointCommandState(command, initial.runState)
      requireLeaseClaimMatchesAuthority(
        command.lease,
        initialAuthority,
      )
      const previousCheckpoint = readApplyCheckpoint(
        initial.runState,
        command.location,
      )
      if (previousCheckpoint.completed) {
        return initial.runState
      }
      const preflightAt = readClock(this.dependencies.clock)
      requireProgressRetention(
        this.binding,
        initial.executionState,
        preflightAt,
      )
      const checkpoint = await this.dependencies.scanCheckpoint({
        location: command.location,
        previousCheckpoint: structuredClone(previousCheckpoint),
      })

      const [authority, current] = await Promise.all([
        this.resolveAuthority(command),
        this.readEffectiveState(),
      ])
      requireCheckpointCommandState(command, current.runState)
      requireSameEffectiveState(initial, current)
      requireLeaseClaimMatchesAuthority(command.lease, authority)

      await this.dependencies.prepare()
      const commitAtMilliseconds = readClock(this.dependencies.clock)
      if (commitAtMilliseconds < preflightAt) {
        return failApply('INVALID_STATE')
      }
      requireCommitRetention(
        this.binding,
        current.executionState,
        undefined,
        commitAtMilliseconds,
      )
      const transitionAuthority: WorkspaceSearchMigrationAuthority = {
        lease: authority.lease,
        ownerId: authority.lease.ownerId,
        at: new Date(commitAtMilliseconds).toISOString(),
      }
      const successorState =
        createWorkspaceSearchMigrationCheckpointExecutionState({
          admission: this.binding.executionRun,
          ...(current.executionState === undefined
            ? {}
            : { predecessor: current.executionState }),
          authority: transitionAuthority,
          location: command.location,
          checkpoint,
        })
      const successorRunState =
        reconstructWorkspaceSearchMigrationRunState(
          this.binding.executionRun,
          successorState,
        )
      const successorCheckpoint = readApplyCheckpoint(
        successorRunState,
        command.location,
      )
      const receipt =
        createWorkspaceSearchMigrationApplyCheckpointReceipt({
          commandIdentity: command.identity,
          predecessorKind: current.executionState === undefined
            ? 'execution-run-admission'
            : 'mutable-execution-state',
          predecessorExecutionStateDigest:
            current.executionState?.executionStateDigest ??
              this.binding.executionRun.executionRunDigest,
          successorRevision: successorState.revision,
          successorExecutionStateDigest:
            successorState.executionStateDigest,
          successorRunStateDigest:
            successorState.runStateDigest,
          checkpoint: successorCheckpoint,
          committedAt: transitionAuthority.at,
        })
      const transaction = createApplyCheckpointTransactionCommand({
        binding: this.binding,
        currentAuthority: authority,
        commitAt: new Date(commitAtMilliseconds),
        predecessorState: current.executionState,
        predecessorStateRecord: current.executionStateRecord,
        successorState,
        receipt,
      })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const managedGuardCode = readPublicFailureCode(error)
        if (managedGuardCode !== undefined) {
          return failApply(managedGuardCode)
        }
        transactionError = error
      }
      return this.reconcileCheckpointAfterAttempt(
        command,
        transactionError,
      )
    })
  }

  /**
   * Uploads the complete production seal and publishes one immutable root.
   *
   * @param input - Exact terminal predecessor revision and active lease.
   * @returns Exact reconciled durable applied state.
   */
  async sealApply(
    input: WorkspaceSearchMigrationApplySealCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState> {
    return runApplyBoundary(async () => {
      const command = prepareApplySealCommand(input, this.binding)
      const initial = await this.readEffectiveState()
      if (initial.appliedRoot !== undefined) {
        return recoverAppliedRootForCommand(
          command,
          initial.appliedRoot,
          initial.runState,
          undefined,
        )
      }
      const initialTerminal = requireTerminalEffectiveState(
        command,
        initial,
      )
      const initialAuthority = await this.resolveAuthority(command)
      requireLeaseClaimMatchesAuthority(
        command.lease,
        initialAuthority,
      )
      const preflightAt = readClock(this.dependencies.clock)
      requireProgressRetention(
        this.binding,
        initialTerminal.executionState,
        preflightAt,
      )
      const seal =
        createWorkspaceSearchMigrationCompleteApplySeal({
          admission: this.binding.executionRun,
          predecessor: initialTerminal.executionState,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
          createdAt: new Date(preflightAt).toISOString(),
        })
      const sealReference =
        readWorkspaceSearchMigrationCompleteApplySealReference(
          await this.dependencies.writeApplySeal(seal),
        )

      const [authority, current] = await Promise.all([
        this.resolveAuthority(command),
        this.readEffectiveState(),
      ])
      if (current.appliedRoot !== undefined) {
        requireAppliedRootPredecessor(
          current.appliedRoot,
          initialTerminal.executionState,
        )
        return recoverAppliedRootForCommand(
          command,
          current.appliedRoot,
          current.runState,
          undefined,
        )
      }
      const currentTerminal = requireTerminalEffectiveState(
        command,
        current,
      )
      requireSameEffectiveState(initial, current)
      requireLeaseClaimMatchesAuthority(command.lease, authority)

      await this.dependencies.prepare()
      const commitAtMilliseconds = readClock(this.dependencies.clock)
      if (commitAtMilliseconds < preflightAt) {
        return failApply('INVALID_STATE')
      }
      requireCommitRetention(
        this.binding,
        currentTerminal.executionState,
        undefined,
        commitAtMilliseconds,
      )
      const commitAt =
        new Date(commitAtMilliseconds).toISOString()
      const root = createWorkspaceSearchMigrationAppliedRoot({
        admission: this.binding.executionRun,
        predecessor: currentTerminal.executionState,
        sealedPlanningAuthority:
          this.binding.sealedPlanningAuthority,
        seal,
        sealReference,
        currentAuthority: authority,
        committedAt: commitAt,
      })
      const transaction = createApplySealTransactionCommand({
        binding: this.binding,
        currentAuthority: authority,
        commitAt: new Date(commitAtMilliseconds),
        predecessorState: currentTerminal.executionState,
        predecessorStateRecord:
          currentTerminal.executionStateRecord,
        root,
      })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const managedGuardCode = readPublicFailureCode(error)
        if (managedGuardCode !== undefined) {
          return failApply(managedGuardCode)
        }
        transactionError = error
      }
      return this.reconcileApplySealAfterAttempt(
        command,
        root,
        transactionError,
      )
    })
  }

  /**
   * Resolves and detaches one fresh current authority.
   *
   * @param command - Detached exact caller command.
   * @returns Exact fresh current authority.
   */
  private async resolveAuthority(
    command:
      | PreparedApplyCheckpointCommand
      | PreparedApplyCommand
      | PreparedApplySealCommand,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const admissionAuthority =
      this.binding.executionRun.binding.currentAuthority
    const candidate = await this.dependencies.readAuthority({
      lease: command.lease,
      maintenanceEvidenceReceiptDigest:
        admissionAuthority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        admissionAuthority.maintenanceEvidencePointerRevision,
    })
    const detached =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        candidate,
      )
    if (
      detached.configurationHash !== this.binding.configurationHash ||
      detached.stateTableId !== this.binding.stateTable.tableId ||
      detached.lease.runId !== this.binding.executionRun.runId
    ) {
      return failApply('CONFIGURATION_DRIFT')
    }
    return detached
  }

  /**
   * Reads the mutable row or reconstructs revision one from admission.
   *
   * @returns Exact effective state and optional mutable envelope.
   */
  private async readEffectiveState(): Promise<EffectiveApplyState> {
    const [admissionOutput, appliedRootOutput] = await Promise.all([
      this.dependencies.get(
        new GetItemCommand({
          TableName: this.binding.stateTable.tableName,
          ConsistentRead: true,
          Key: this.binding.executionRunKey,
        }),
      ),
      this.dependencies.get(
        new GetItemCommand({
          TableName: this.binding.stateTable.tableName,
          ConsistentRead: true,
          Key: createAppliedRootKey(this.binding),
        }),
      ),
    ])
    requireExecutionRunAdmissionStrongRead(
      this.binding,
      admissionOutput,
    )
    const stateOutput = await this.dependencies.get(
      new GetItemCommand({
        TableName: this.binding.stateTable.tableName,
        ConsistentRead: true,
        Key: createStateKey(this.binding),
      }),
    )
    const record = readOutputItem(stateOutput)
    const appliedRootRecord = readOutputItem(appliedRootOutput)
    if (appliedRootRecord !== undefined) {
      if (record === undefined) return failApply('INVALID_STATE')
      const executionState =
        parseExecutionStateRecord(this.binding, record)
      if (executionState.executionStateVersion !== 2) {
        return failApply('INVALID_STATE')
      }
      const root = parseAppliedRootRecord(
        this.binding,
        appliedRootRecord,
      )
      const storedSeal =
        await this.dependencies.readApplySeal(root.sealReference)
      if (
        Buffer.compare(
          Buffer.from(
            serializeWorkspaceSearchMigrationCompleteApplySeal(
              storedSeal,
            ),
          ),
          Buffer.from(
            serializeWorkspaceSearchMigrationCompleteApplySeal(
              root.seal,
            ),
          ),
        ) !== 0
      ) {
        return failApply('INVALID_STATE')
      }
      const runState =
        requireWorkspaceSearchMigrationAppliedRootBinding({
          admission: this.binding.executionRun,
          predecessor: executionState,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
          seal: storedSeal,
          sealReference: root.sealReference,
          root,
        })
      await this.dependencies.prepare()
      return {
        runState,
        appliedRoot: root,
        executionState,
        executionStateRecord: record,
      }
    }
    if (record === undefined) {
      return { runState: this.binding.executionRun.runState }
    }
    const executionState =
      parseExecutionStateRecord(this.binding, record)
    return {
      runState: reconstructWorkspaceSearchMigrationRunState(
        this.binding.executionRun,
        executionState,
      ),
      executionState,
      executionStateRecord: record,
    }
  }

  /**
   * Reads and parses one deterministic operation marker.
   *
   * @param operationId - Stable operation identifier.
   * @returns Exact durable marker row or undefined.
   */
  private async readMarker(
    operationId: string,
  ): Promise<DurableApplyMarker | undefined> {
    const output = await this.dependencies.get(
      new GetItemCommand({
        TableName: this.binding.stateTable.tableName,
        ConsistentRead: true,
        Key: createMarkerKey(this.binding, operationId),
      }),
    )
    const record = readOutputItem(output)
    return record === undefined
      ? undefined
      : parseMarkerRecord(
          this.binding,
          operationId,
          record,
        )
  }

  /**
   * Reads and parses one deterministic journal-sequence index.
   *
   * @param sequence - Positive mutation sequence.
   * @returns Exact durable mutation marker or undefined.
   */
  private async readSequence(
    sequence: number,
  ): Promise<DurableApplyMarker | undefined> {
    const output = await this.dependencies.get(
      new GetItemCommand({
        TableName: this.binding.stateTable.tableName,
        ConsistentRead: true,
        Key: createSequenceKey(this.binding, sequence),
      }),
    )
    const record = readOutputItem(output)
    return record === undefined
      ? undefined
      : parseSequenceRecord(
          this.binding,
          sequence,
          record,
        )
  }

  /**
   * Strongly reads one deterministic immutable checkpoint receipt.
   *
   * @param identity - Exact command identity expected at the receipt key.
   * @returns Exact strict receipt or undefined when it has not committed.
   */
  private async readCheckpointReceipt(
    identity: WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  ): Promise<WorkspaceSearchMigrationApplyCheckpointReceipt | undefined> {
    const output = await this.dependencies.get(
      new GetItemCommand({
        TableName: this.binding.stateTable.tableName,
        ConsistentRead: true,
        Key: createCheckpointReceiptKey(identity),
      }),
    )
    const record = readOutputItem(output)
    return record === undefined
      ? undefined
      : parseCheckpointReceiptRecord(
          this.binding,
          identity,
          record,
        )
  }

  /**
   * Reconciles a marker observed before a duplicate request sends any write.
   *
   * @param command - Detached exact retry command.
   * @param marker - Existing durable marker row.
   * @returns Exact current durable state.
   */
  private async reconcileCommittedOperation(
    command: PreparedApplyCommand,
    marker: DurableApplyMarker,
  ): Promise<WorkspaceSearchMigrationRunState> {
    return this.reconcileMarkerAndState(command, marker)
  }

  /**
   * Reconciles one apply-seal attempt through its immutable deterministic root.
   *
   * @param command - Detached exact attempted seal command.
   * @param intended - Exact root intended by this attempt.
   * @param transactionError - Raw transaction failure, when one occurred.
   * @returns Exact durable applied state proving a valid publication.
   */
  private async reconcileApplySealAfterAttempt(
    command: PreparedApplySealCommand,
    intended: WorkspaceSearchMigrationAppliedRoot,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRunState> {
    let effective: EffectiveApplyState
    try {
      effective = await this.readEffectiveState()
    } catch (error: unknown) {
      return failApply(readReconciliationFailureCode(error))
    }
    if (effective.appliedRoot === undefined) {
      return failApply(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyApplySealTransactionError(transactionError),
      )
    }
    return recoverAppliedRootForCommand(
      command,
      effective.appliedRoot,
      effective.runState,
      intended,
    )
  }

  /**
   * Reconciles every transaction attempt through marker, sequence, state, and
   * target strong reads.
   *
   * @param command - Detached exact attempted command.
   * @param transactionError - Raw transaction failure, if one occurred.
   * @returns Exact durable state proving the operation committed.
   */
  private async reconcileAfterAttempt(
    command: PreparedApplyCommand,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRunState> {
    let marker: DurableApplyMarker | undefined
    try {
      marker = await this.readMarker(
        command.plannedOperation.operation.operationId,
      )
    } catch (error: unknown) {
      return failApply(
        readReconciliationFailureCode(error),
      )
    }
    if (marker === undefined) {
      if (
        command.plannedOperation.operation.before.digest !==
          command.plannedOperation.operation.after.digest
      ) {
        try {
          const effective = await this.readEffectiveState()
          if (
            effective.runState.revision >
              command.expectedRevision
          ) {
            return failApply('INVALID_STATE')
          }
          const sequence = await this.readSequence(
            effective.runState.journalSequence + 1,
          )
          if (sequence !== undefined) {
            return failApply('INVALID_STATE')
          }
        } catch (error: unknown) {
          return failApply(
            readReconciliationFailureCode(error),
          )
        }
      }
      return failApply(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyTransactionError(transactionError),
      )
    }
    try {
      return await this.reconcileMarkerAndState(command, marker)
    } catch (error: unknown) {
      return failApply(readReconciliationFailureCode(error))
    }
  }

  /**
   * Reconciles one checkpoint transaction through its immutable receipt.
   *
   * @param command - Detached exact attempted command.
   * @param transactionError - Raw transaction failure, when one occurred.
   * @returns Exact durable state proving the checkpoint committed.
   */
  private async reconcileCheckpointAfterAttempt(
    command: PreparedApplyCheckpointCommand,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRunState> {
    let receipt: WorkspaceSearchMigrationApplyCheckpointReceipt | undefined
    try {
      receipt = await this.readCheckpointReceipt(command.identity)
    } catch (error: unknown) {
      return failApply(readReconciliationFailureCode(error))
    }
    if (receipt === undefined) {
      try {
        const effective = await this.readEffectiveState()
        if (effective.runState.revision > command.expectedRevision) {
          return failApply('INVALID_STATE')
        }
      } catch (error: unknown) {
        return failApply(readReconciliationFailureCode(error))
      }
      return failApply(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyCheckpointTransactionError(transactionError),
      )
    }
    try {
      return await this.reconcileCheckpointReceipt(
        command,
        receipt,
      )
    } catch (error: unknown) {
      return failApply(readReconciliationFailureCode(error))
    }
  }

  /**
   * Cross-checks one immutable checkpoint receipt against current state.
   *
   * @param command - Detached attempted or retried checkpoint command.
   * @param receipt - Exact immutable receipt read at its deterministic key.
   * @returns Current durable state at or after the committed checkpoint.
   */
  private async reconcileCheckpointReceipt(
    command: PreparedApplyCheckpointCommand,
    receipt: WorkspaceSearchMigrationApplyCheckpointReceipt,
  ): Promise<WorkspaceSearchMigrationRunState> {
    requireCheckpointReceiptMatchesCommand(command, receipt)
    const effective = await this.readEffectiveState()
    if (effective.runState.revision < receipt.successorRevision) {
      return failApply('INVALID_STATE')
    }
    const receiptCheckpoint =
      decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        receipt.checkpoint,
      )
    const currentCheckpoint = readApplyCheckpoint(
      effective.runState,
      command.location,
    )
    if (effective.runState.revision === receipt.successorRevision) {
      if (
        effective.executionState?.executionStateDigest !==
          receipt.successorExecutionStateDigest ||
        effective.executionState.runStateDigest !==
          receipt.successorRunStateDigest ||
        createMigrationDigest(
          createWorkspaceSearchMigrationApplyCheckpointSnapshot(
            currentCheckpoint,
          ),
        ) !== receipt.checkpointDigest
      ) {
        return failApply('INVALID_STATE')
      }
    } else {
      requireCheckpointDescendant(
        currentCheckpoint,
        receiptCheckpoint,
      )
    }
    return effective.runState
  }

  /**
   * Cross-checks one immutable marker against sequence, state, and target.
   *
   * @param command - Detached exact attempted or retried command.
   * @param durableMarker - Exact immutable operation marker row.
   * @returns Current durable state after the committed marker.
   */
  private async reconcileMarkerAndState(
    command: PreparedApplyCommand,
    durableMarker: DurableApplyMarker,
  ): Promise<WorkspaceSearchMigrationRunState> {
    requireMarkerMatchesCommand(command, durableMarker)
    const marker = durableMarker.marker
    const sequencePromise = marker.kind ===
        'workspace-search-operation-applied'
      ? this.readSequence(marker.sequence)
      : Promise.resolve(undefined)
    const journalPromise = marker.kind ===
        'workspace-search-operation-applied'
      ? this.readReconciliationJournal(marker)
      : Promise.resolve(undefined)
    const [
      effective,
      sequence,
      targetOutput,
      journalSegment,
    ] = await Promise.all([
      this.readEffectiveState(),
      sequencePromise,
      this.dependencies.get(
        createStrongReadCommand(
          this.binding.targetTable,
          command.plannedOperation.operation.targetKey,
        ),
      ),
      journalPromise,
    ])
    if (
      effective.runState.revision <
        durableMarker.successorRevision ||
      effective.runState.appliedOperationCount <
        marker.planSequence
    ) {
      return failApply('INVALID_STATE')
    }
    if (
      effective.runState.revision ===
        durableMarker.successorRevision
    ) {
      if (
        effective.executionState?.executionStateDigest !==
          durableMarker.successorExecutionStateDigest
      ) {
        return failApply('INVALID_STATE')
      }
      verifyWorkspaceSearchMigrationItemStrongRead(
        this.binding.targetTable,
        command.plannedOperation.operation.targetKey,
        command.plannedOperation.operation.after,
        targetOutput,
        'TARGET_DRIFT',
      )
    } else {
      readOutputItem(targetOutput)
    }
    if (marker.kind === 'workspace-search-operation-applied') {
      if (
        sequence === undefined ||
        journalSegment === undefined ||
        sequence.markerDigest !== durableMarker.markerDigest ||
        sequence.predecessorRevision !==
          durableMarker.predecessorRevision ||
        sequence.successorRevision !==
          durableMarker.successorRevision ||
        sequence.successorExecutionStateDigest !==
          durableMarker.successorExecutionStateDigest ||
        createMigrationDigest(sequence.marker) !==
          durableMarker.markerDigest
      ) {
        return failApply('INVALID_STATE')
      }
      requireJournalSegmentMatchesMarker(
        command.plannedOperation,
        marker,
        journalSegment,
      )
      if (
        effective.runState.journalSequence < marker.sequence ||
        (
          effective.runState.revision ===
            durableMarker.successorRevision &&
          effective.runState.journalHeadDigest !==
            marker.journal.headDigest
        )
      ) {
        return failApply('INVALID_STATE')
      }
    } else if (sequence !== undefined) {
      return failApply('INVALID_STATE')
    }
    return effective.runState
  }

  /**
   * Reads one exact journal version with a stable invalid-journal boundary.
   *
   * @param marker - Exact mutating operation receipt.
   * @returns Strict immutable journal segment.
   */
  private async readReconciliationJournal(
    marker: WorkspaceSearchOperationReceipt,
  ): Promise<WorkspaceSearchJournalSegment> {
    try {
      return await this.dependencies.readJournal(marker.journal)
    } catch (error: unknown) {
      const code = readPublicFailureCode(error)
      if (code !== undefined) return failApply(code)
      return failApply('INVALID_JOURNAL')
    }
  }
}

/**
 * Detaches and cross-validates all construction-time apply authority.
 *
 * @param configurationValue - Candidate measured configuration.
 * @param configurationHashValue - Candidate reviewed configuration digest.
 * @param executionBoundaryValue - Candidate planning-admitted boundary.
 * @param sealedPlanningAuthorityValue - Candidate immutable sealed root.
 * @param closedWriterFenceRecordValue - Candidate exact closed fence.
 * @param executionRunValue - Candidate immutable execution admission.
 * @returns Complete exact static apply binding.
 */
function createApplyOperationBinding(
  configurationValue: unknown,
  configurationHashValue: unknown,
  executionBoundaryValue: unknown,
  sealedPlanningAuthorityValue: unknown,
  closedWriterFenceRecordValue: unknown,
  executionRunValue: unknown,
): ApplyOperationBinding {
  const configuration =
    detachWorkspaceSearchMigrationPlanningConfiguration(
      requireConfiguration(
        configurationValue,
      ),
    )
  const configurationHash = readDigest(
    configurationHashValue,
    'INVALID_ARGUMENT',
  )
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failApply('CONFIGURATION_HASH_MISMATCH')
  }
  const executionBoundary =
    parseWorkspaceSearchMigrationExecutionBoundary(
      serializeWorkspaceSearchMigrationExecutionBoundary(
        requireExecutionBoundary(executionBoundaryValue),
      ),
    )
  if (executionBoundary.phase !== 'planning-admitted') {
    return failApply('INVALID_ARGUMENT')
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
  const tableIds = createApplyTableIds(configuration)
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
    sealedPlanningAuthority.configurationHash !== configurationHash ||
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
    return failApply('INVALID_ARGUMENT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      executionBoundary.tableIds[role] !== tableIds[role] ||
      sealedPlanningAuthority.tableIds[role] !== tableIds[role] ||
      executionRun.binding.tableIds[role] !== tableIds[role] ||
      closedWriterFenceRecord.binding.tableIds[role] !==
        tableIds[role]
    ) {
      return failApply('CONFIGURATION_DRIFT')
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
  const executionRunCondition =
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable,
      configurationHash,
      executionRun,
    })
  const executionRunKey = readConditionCheckKey(
    executionRunCondition,
    stateTable.tableName,
  )
  const executionRunRecord =
    createWorkspaceSearchMigrationExecutionRunAdmissionRecord({
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
    executionRunKey,
    executionRunRecord,
    bindingDigest: createMigrationDigest({
      kind: 'workspace-search-apply-run-binding',
      version: applyRecordVersion,
      stateTableId: stateTable.tableId,
      configurationHash,
      runId: executionRun.runId,
      executionRunDigest: executionRun.executionRunDigest,
    }),
  }
}

/**
 * Projects all six measured physical table identifiers.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed table identifiers.
 */
function createApplyTableIds(
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
 * Captures every dependency method without retaining mutable public objects.
 *
 * @param authorityPortValue - Candidate fresh-authority reader.
 * @param journalGatewayValue - Candidate immutable journal gateway.
 * @param applySealGatewayValue - Candidate immutable apply-seal gateway.
 * @param checkpointScannerValue - Candidate measured checkpoint scanner.
 * @param transportValue - Candidate narrow DynamoDB transport.
 * @param clockValue - Candidate adapter clock.
 * @returns Captured dependency methods.
 */
function prepareApplyDependencies(
  authorityPortValue: unknown,
  journalGatewayValue: unknown,
  applySealGatewayValue: unknown,
  checkpointScannerValue: unknown,
  transportValue: unknown,
  clockValue: unknown,
): PreparedApplyDependencies {
  const authorityPort = requireDependencyObject(
    authorityPortValue,
  )
  const journalGateway = requireDependencyObject(
    journalGatewayValue,
  )
  const applySealGateway = requireDependencyObject(
    applySealGatewayValue,
  )
  const checkpointScanner = requireDependencyObject(
    checkpointScannerValue,
  )
  const transport = requireDependencyObject(
    transportValue,
  )
  const readAuthority = readCallableMethod(
    authorityPort,
    'readAuthority',
  )
  const writeJournal = readCallableMethod(
    journalGateway,
    'writeJournalSegment',
  )
  const readJournal = readCallableMethod(
    journalGateway,
    'readJournalSegment',
  )
  const writeApplySeal = readCallableMethod(
    applySealGateway,
    'writeCompleteApplySeal',
  )
  const readApplySeal = readCallableMethod(
    applySealGateway,
    'readCompleteApplySeal',
  )
  const scanCheckpoint = readCallableMethod(
    checkpointScanner,
    'scanApplyCheckpointPage',
  )
  const get = readCallableMethod(
    transport,
    'getApplyItem',
  )
  const prepare = readCallableMethod(
    transport,
    'prepareApplyWrite',
  )
  const transact = readCallableMethod(
    transport,
    'transactWriteApply',
  )
  if (
    !isAuthorityReader(readAuthority) ||
    !isJournalWriter(writeJournal) ||
    !isJournalReader(readJournal) ||
    !isApplySealWriter(writeApplySeal) ||
    !isApplySealReader(readApplySeal) ||
    !isCheckpointScanner(scanCheckpoint) ||
    !isApplyItemReader(get) ||
    !isApplyPreparer(prepare) ||
    !isApplyTransactor(transact) ||
    typeof clockValue !== 'function' ||
    nodeUtilTypes.isProxy(clockValue)
  ) {
    return failApply('INVALID_ARGUMENT')
  }
  return {
    readAuthority: readAuthority.bind(authorityPort),
    writeJournal: writeJournal.bind(journalGateway),
    readJournal: readJournal.bind(journalGateway),
    writeApplySeal: writeApplySeal.bind(applySealGateway),
    readApplySeal: readApplySeal.bind(applySealGateway),
    scanCheckpoint: scanCheckpoint.bind(checkpointScanner),
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
    clock: snapshotClock(clockValue),
  }
}

/**
 * Requires one non-Proxy object used only as a method receiver.
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
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one data-method descriptor without invoking getters.
 *
 * Class methods may be inherited from a bounded prototype chain. Accessor
 * methods are rejected at every level.
 *
 * @param receiver - Exact non-Proxy method receiver.
 * @param key - Required method name.
 * @returns Exact callable method.
 */
function readCallableMethod(
  receiver: object,
  key: string,
): unknown {
  let current: object | null = receiver
  let depth = 0
  while (current !== null && depth < 16) {
    if (nodeUtilTypes.isProxy(current)) {
      return failApply('INVALID_ARGUMENT')
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failApply('INVALID_ARGUMENT')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
    depth += 1
  }
  return failApply('INVALID_ARGUMENT')
}

/**
 * Narrows one authority reader method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed authority boundary.
 */
function isAuthorityReader(
  value: unknown,
): value is WorkspaceSearchMigrationApplyOperationAuthorityPort[
  'readAuthority'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one immutable journal writer method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed journal boundary.
 */
function isJournalWriter(
  value: unknown,
): value is WorkspaceSearchMigrationJournalAwsGateway[
  'writeJournalSegment'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one immutable journal reader method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed journal boundary.
 */
function isJournalReader(
  value: unknown,
): value is WorkspaceSearchMigrationJournalAwsGateway[
  'readJournalSegment'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one immutable complete apply-seal writer method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed seal boundary.
 */
function isApplySealWriter(
  value: unknown,
): value is WorkspaceSearchMigrationApplySealAwsGateway[
  'writeCompleteApplySeal'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one immutable complete apply-seal reader method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed seal boundary.
 */
function isApplySealReader(
  value: unknown,
): value is WorkspaceSearchMigrationApplySealAwsGateway[
  'readCompleteApplySeal'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one measured apply checkpoint scanner method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the checkpoint boundary.
 */
function isCheckpointScanner(
  value: unknown,
): value is WorkspaceSearchMigrationApplyCheckpointScanner[
  'scanApplyCheckpointPage'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one strongly consistent apply item reader.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed transport boundary.
 */
function isApplyItemReader(
  value: unknown,
): value is WorkspaceSearchMigrationApplyOperationAwsTransport[
  'getApplyItem'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one apply transport preparation method.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed transport boundary.
 */
function isApplyPreparer(
  value: unknown,
): value is WorkspaceSearchMigrationApplyOperationAwsTransport[
  'prepareApplyWrite'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Narrows one apply transaction sender.
 *
 * @param value - Candidate callable.
 * @returns Whether it may be invoked through the typed transport boundary.
 */
function isApplyTransactor(
  value: unknown,
): value is WorkspaceSearchMigrationApplyOperationAwsTransport[
  'transactWriteApply'
] {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Converts a trusted Date-returning clock into an epoch-millisecond closure.
 *
 * @param value - Candidate adapter clock.
 * @returns Captured epoch-millisecond clock.
 */
function snapshotClock(value: unknown): () => number {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failApply('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(value, undefined, [])
    if (
      !(candidate instanceof Date) ||
      nodeUtilTypes.isProxy(candidate)
    ) {
      return failApply('INVALID_STATE')
    }
    let milliseconds: number
    try {
      milliseconds = Date.prototype.getTime.call(candidate)
    } catch {
      return failApply('INVALID_STATE')
    }
    if (!Number.isSafeInteger(milliseconds)) {
      return failApply('INVALID_STATE')
    }
    return milliseconds
  }
}

/**
 * Detaches one caller apply request before the first await.
 *
 * @param input - Candidate command.
 * @param binding - Exact adapter binding.
 * @returns Strict detached command.
 */
function prepareApplyCommand(
  input: WorkspaceSearchMigrationCommandInput<
    WorkspaceSearchApplyOperationCommandEvent
  >,
  binding: ApplyOperationBinding,
): PreparedApplyCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(
    record,
    ['event', 'expectedRevision', 'lease'],
    'INVALID_ARGUMENT',
  )
  const expectedRevision = readPositiveSafeInteger(
    readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const lease = readLeaseClaim(
    readOwn(record, 'lease', 'INVALID_ARGUMENT'),
  )
  const event = requirePlainRecord(
    readOwn(record, 'event', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  requireExactKeys(
    event,
    ['kind', 'plannedOperation'],
    'INVALID_ARGUMENT',
  )
  if (
    readOwn(event, 'kind', 'INVALID_ARGUMENT') !==
      'apply-operation-requested'
  ) {
    return failApply('INVALID_ARGUMENT')
  }
  const plannedValue = readOwn(
    event,
    'plannedOperation',
    'INVALID_ARGUMENT',
  )
  const plannedOperation = parseWorkspaceSearchPlannedOperation(
    serializeWorkspaceSearchPlannedOperation(
      requirePlannedOperation(plannedValue),
    ),
  )
  if (
    plannedOperation.runId !== binding.executionRun.runId ||
    plannedOperation.configurationHash !==
      binding.configurationHash ||
    plannedOperation.planDigest !==
      binding.executionRun.binding.planDigest ||
    lease.runId !== binding.executionRun.runId
  ) {
    return failApply('INVALID_ARGUMENT')
  }
  return {
    expectedRevision,
    lease,
    plannedOperation,
  }
}

/**
 * Detaches one caller checkpoint request before the first await.
 *
 * @param input - Candidate checkpoint command.
 * @param binding - Exact admitted apply binding.
 * @returns Strict detached checkpoint command and deterministic identity.
 */
function prepareApplyCheckpointCommand(
  input: WorkspaceSearchMigrationCheckpointCommandInput,
  binding: ApplyOperationBinding,
): PreparedApplyCheckpointCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(
    record,
    ['expectedRevision', 'lease', 'location'],
    'INVALID_ARGUMENT',
  )
  const expectedRevision = readPositiveSafeInteger(
    readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const lease = readLeaseClaim(
    readOwn(record, 'lease', 'INVALID_ARGUMENT'),
  )
  const location = readCheckpointLocation(
    readOwn(record, 'location', 'INVALID_ARGUMENT'),
  )
  if (lease.runId !== binding.executionRun.runId) {
    return failApply('INVALID_ARGUMENT')
  }
  const identity =
    createWorkspaceSearchMigrationApplyCheckpointCommandIdentity({
      stateTableId: binding.stateTable.tableId,
      configurationHash: binding.configurationHash,
      runId: binding.executionRun.runId,
      executionRunDigest:
        binding.executionRun.executionRunDigest,
      location,
      expectedRevision,
    })
  return {
    expectedRevision,
    lease,
    location,
    identity,
  }
}

/**
 * Detaches one caller complete apply-seal request before the first await.
 *
 * @param input - Candidate seal command.
 * @param binding - Exact admitted apply binding.
 * @returns Strict detached terminal predecessor command.
 */
function prepareApplySealCommand(
  input: WorkspaceSearchMigrationApplySealCommandInput,
  binding: ApplyOperationBinding,
): PreparedApplySealCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(
    record,
    ['expectedRevision', 'lease'],
    'INVALID_ARGUMENT',
  )
  const expectedRevision = readPositiveSafeInteger(
    readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const lease = readLeaseClaim(
    readOwn(record, 'lease', 'INVALID_ARGUMENT'),
  )
  if (lease.runId !== binding.executionRun.runId) {
    return failApply('INVALID_ARGUMENT')
  }
  return { expectedRevision, lease }
}

/**
 * Reads one strict source or target checkpoint location.
 *
 * @param value - Candidate location.
 * @returns Exact fixed-allowlist location.
 */
function readCheckpointLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'target'
  ) {
    return value
  }
  return failApply('INVALID_ARGUMENT')
}

/**
 * Reads one exact active lease identity.
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
 * Requires the resolved authority to match the exact caller lease claim.
 *
 * @param claim - Detached caller claim.
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
    return failApply('LEASE_LOST')
  }
}

/**
 * Requires one durable state to be the exact checkpoint predecessor.
 *
 * @param command - Exact checkpoint command.
 * @param state - Strongly reconstructed current run state.
 */
function requireCheckpointCommandState(
  command: PreparedApplyCheckpointCommand,
  state: WorkspaceSearchMigrationRunState,
): void {
  if (
    state.revision !== command.expectedRevision ||
    state.status !== 'applying' ||
    state.appliedOperationCount !== state.planOperationCount
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Requires an exact terminal v2 predecessor for complete apply sealing.
 *
 * @param command - Detached complete seal command.
 * @param effective - Strongly read current effective state.
 * @returns Exact terminal mutable state and complete durable row.
 */
function requireTerminalEffectiveState(
  command: PreparedApplySealCommand,
  effective: EffectiveApplyState,
): TerminalEffectiveApplyState {
  const executionState = effective.executionState
  const executionStateRecord = effective.executionStateRecord
  if (
    effective.appliedRoot !== undefined ||
    effective.runState.revision !== command.expectedRevision ||
    executionState?.executionStateVersion !== 2 ||
    executionStateRecord === undefined
  ) {
    return failApply('INVALID_STATE')
  }
  requireCompleteApplyState(effective.runState, executionState)
  return {
    runState: effective.runState,
    executionState,
    executionStateRecord,
  }
}

/**
 * Accepts one durable root only for the exact retried terminal predecessor.
 *
 * Concurrent attempts may choose different trusted timestamps or immutable S3
 * versions. The deterministic-key winner is accepted only when its
 * predecessor identity is the same as this command and, after a send, the
 * exact predecessor identity of the attempted root.
 *
 * @param command - Detached exact caller retry.
 * @param durable - Strict fully cross-validated durable root.
 * @param runState - Applied successor reconstructed from the durable root.
 * @param intended - Exact attempted root, when a transaction was sent.
 * @returns Exact reconstructed durable applied state.
 */
function recoverAppliedRootForCommand(
  command: PreparedApplySealCommand,
  durable: WorkspaceSearchMigrationAppliedRoot,
  runState: WorkspaceSearchMigrationRunState,
  intended: WorkspaceSearchMigrationAppliedRoot | undefined,
): WorkspaceSearchMigrationRunState {
  if (
    durable.predecessorRevision !== command.expectedRevision ||
    durable.runId !== command.lease.runId ||
    durable.authority.ownerId !== command.lease.ownerId ||
    durable.authority.fenceToken !== command.lease.fenceToken ||
    durable.status !== 'applied' ||
    durable.successorRevision !== command.expectedRevision + 1 ||
    runState.status !== 'applied' ||
    runState.revision !== durable.successorRevision ||
    createMigrationDigest(runState) !==
      durable.successorRunStateDigest
  ) {
    return failApply('INVALID_STATE')
  }
  if (
    intended !== undefined &&
    (
      durable.predecessorRevision !==
        intended.predecessorRevision ||
      durable.predecessorExecutionStateDigest !==
        intended.predecessorExecutionStateDigest ||
      durable.predecessorRunStateDigest !==
        intended.predecessorRunStateDigest
    )
  ) {
    return failApply('INVALID_STATE')
  }
  return runState
}

/**
 * Requires a concurrent durable root to use one exact terminal predecessor.
 *
 * @param root - Strict durable concurrent winner.
 * @param predecessor - Exact terminal state observed before seal upload.
 */
function requireAppliedRootPredecessor(
  root: WorkspaceSearchMigrationAppliedRoot,
  predecessor: WorkspaceSearchMigrationExecutionStateV2,
): void {
  if (
    root.predecessorRevision !== predecessor.revision ||
    root.predecessorExecutionStateDigest !==
      predecessor.executionStateDigest ||
    root.predecessorRunStateDigest !== predecessor.runStateDigest
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Selects one exact durable apply checkpoint from a run state.
 *
 * @param state - Strongly reconstructed current run state.
 * @param location - Source or target traversal location.
 * @returns Exact selected cumulative checkpoint.
 */
function readApplyCheckpoint(
  state: WorkspaceSearchMigrationRunState,
  location: WorkspaceSearchMigrationCheckpointLocation,
): MigrationSourceCheckpoint {
  return location === 'target'
    ? state.apply.target
    : state.apply.sources[location]
}

/**
 * Requires a post-scan reread to retain the exact predecessor envelope.
 *
 * @param before - Effective state read before the bounded Scan.
 * @param after - Effective state strongly reread after the bounded Scan.
 */
function requireSameEffectiveState(
  before: EffectiveApplyState,
  after: EffectiveApplyState,
): void {
  const beforeDigest =
    before.executionState?.executionStateDigest
  const afterDigest =
    after.executionState?.executionStateDigest
  if (
    before.runState.revision !== after.runState.revision ||
    beforeDigest !== afterDigest ||
    (before.executionState === undefined) !==
      (after.executionState === undefined)
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Requires one immutable receipt to identify the exact retried command.
 *
 * @param command - Exact detached checkpoint command.
 * @param receipt - Strict durable checkpoint receipt.
 */
function requireCheckpointReceiptMatchesCommand(
  command: PreparedApplyCheckpointCommand,
  receipt: WorkspaceSearchMigrationApplyCheckpointReceipt,
): void {
  if (
    receipt.commandDigest !== command.identity.commandDigest ||
    receipt.location !== command.location ||
    receipt.predecessorRevision !== command.expectedRevision ||
    receipt.successorRevision !== command.expectedRevision + 1
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Requires current checkpoint progress to descend monotonically from a receipt.
 *
 * Later checkpoint transactions may advance this or another location. Version
 * two execution-state revision arithmetic proves that every later revision is
 * exactly one additional durable page transition.
 *
 * @param current - Checkpoint reconstructed from the latest mutable state.
 * @param committed - Exact checkpoint captured by the earlier receipt.
 */
function requireCheckpointDescendant(
  current: MigrationSourceCheckpoint,
  committed: MigrationSourceCheckpoint,
): void {
  const currentSnapshot =
    createWorkspaceSearchMigrationApplyCheckpointSnapshot(current)
  const committedSnapshot =
    createWorkspaceSearchMigrationApplyCheckpointSnapshot(committed)
  if (
    current.aggregate.pageCount ===
      committed.aggregate.pageCount
  ) {
    if (
      createMigrationDigest(currentSnapshot) !==
        createMigrationDigest(committedSnapshot)
    ) {
      return failApply('INVALID_STATE')
    }
    return
  }
  if (
    committed.completed ||
    current.aggregate.pageCount <
      committed.aggregate.pageCount ||
    current.aggregate.scanned < committed.aggregate.scanned ||
    current.aggregate.mapped < committed.aggregate.mapped ||
    current.aggregate.ignored < committed.aggregate.ignored ||
    current.aggregate.invalid < committed.aggregate.invalid ||
    current.aggregate.projected < committed.aggregate.projected ||
    current.aggregate.deleted < committed.aggregate.deleted ||
    current.keyDigestState.count <
      committed.keyDigestState.count ||
    current.contentDigestState.count <
      committed.contentDigestState.count
  ) {
    return failApply('INVALID_STATE')
  }
  if (
    current.keyDigestState.count ===
      committed.keyDigestState.count &&
    (
      current.keyDigestState.sumHex !==
        committed.keyDigestState.sumHex ||
      current.keyDigestState.xorHex !==
        committed.keyDigestState.xorHex
    )
  ) {
    return failApply('INVALID_STATE')
  }
  if (
    current.contentDigestState.count ===
      committed.contentDigestState.count &&
    (
      current.contentDigestState.sumHex !==
        committed.contentDigestState.sumHex ||
      current.contentDigestState.xorHex !==
        committed.contentDigestState.xorHex
    )
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Complete material for one fixed-order apply transaction.
 */
type CreateApplyTransactionCommandInput = {
  /** Exact static apply binding. */
  readonly binding: ApplyOperationBinding
  /** Fresh current lease, pointer, and receipt authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final transaction time. */
  readonly commitAt: Date
  /** Exact planned source and target transition. */
  readonly operation: WorkspaceSearchMigrationOperation
  /** Exact source CAS condition. */
  readonly sourceCondition:
    WorkspaceSearchMigrationItemConditionMaterial
  /** Exact target CAS condition. */
  readonly targetCondition:
    WorkspaceSearchMigrationItemConditionMaterial
  /** Previous mutable envelope, absent for the first operation. */
  readonly predecessorState?: WorkspaceSearchMigrationExecutionState
  /** Previous complete durable row, absent for the first operation. */
  readonly predecessorStateRecord?:
    Readonly<Record<string, AttributeValue>>
  /** Exact successor mutable envelope. */
  readonly successorState: WorkspaceSearchMigrationExecutionState
  /** Exact immutable marker written by the transaction. */
  readonly marker: WorkspaceSearchOperationMarker
}

/**
 * Common mutable execution-state CAS material for apply progress.
 */
type ExecutionStateTransitionMaterial = {
  /** Exact static apply binding. */
  readonly binding: ApplyOperationBinding
  /** Previous mutable envelope, absent at the admission root. */
  readonly predecessorState?: WorkspaceSearchMigrationExecutionState
  /** Previous complete durable row, absent at the admission root. */
  readonly predecessorStateRecord?:
    Readonly<Record<string, AttributeValue>>
  /** Exact successor mutable envelope. */
  readonly successorState: WorkspaceSearchMigrationExecutionState
}

/**
 * Complete material for one fixed-order checkpoint transaction.
 */
type CreateApplyCheckpointTransactionCommandInput =
  ExecutionStateTransitionMaterial & {
    /** Fresh current lease, pointer, and receipt authority. */
    readonly currentAuthority:
      WorkspaceSearchMigrationPrePlanAuthority
    /** Adapter-owned final transaction time. */
    readonly commitAt: Date
    /** Exact immutable checkpoint receipt committed with the state. */
    readonly receipt:
      WorkspaceSearchMigrationApplyCheckpointReceipt
  }

/**
 * Complete material for one fixed-order immutable apply-seal transaction.
 */
type CreateApplySealTransactionCommandInput = {
  /** Exact static admitted apply binding. */
  readonly binding: ApplyOperationBinding
  /** Fresh current lease, pointer, and receipt authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned final transaction time. */
  readonly commitAt: Date
  /** Exact terminal traversal-capable mutable predecessor. */
  readonly predecessorState:
    WorkspaceSearchMigrationExecutionStateV2
  /** Complete exact durable terminal predecessor row. */
  readonly predecessorStateRecord:
    Readonly<Record<string, AttributeValue>>
  /** Immutable applied root published by the transaction. */
  readonly root: WorkspaceSearchMigrationAppliedRoot
}

/**
 * Builds one fixed-order eleven- or twelve-item apply transaction.
 *
 * @param input - Exact authority, CAS, predecessor, successor, and marker.
 * @returns Adapter-owned idempotent transaction command.
 */
function createApplyTransactionCommand(
  input: CreateApplyTransactionCommandInput,
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.currentAuthority,
      commitAt: input.commitAt,
    })
  const writerFence =
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      input.binding.closedWriterFenceRecord,
      input.binding.writerFence,
    )
  const executionBoundary =
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: input.binding.stateTable,
        configurationHash: input.binding.configurationHash,
        boundary: input.binding.executionBoundary,
      },
    )
  const sealedPlanningAuthority =
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.binding.sealedPlanningAuthority,
    })
  const executionRun =
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
    })
  const executionState = createExecutionStatePut(input)
  const source = createConditionCheck(
    input.binding.configuration.tables[
      input.operation.sourceCondition.source
    ].tableName,
    input.sourceCondition,
  )
  const target = createTargetTransactionItem(
    input.binding.targetTable.tableName,
    input.operation,
    input.targetCondition,
  )
  const operationMarker = createMarkerPut(input)
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    writerFence,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    executionState,
    source,
    target,
    operationMarker,
  ]
  if (input.marker.kind === 'workspace-search-operation-applied') {
    items.push(createSequencePut(input, input.marker))
  }
  const expectedCount = input.marker.kind ===
      'workspace-search-operation-applied'
    ? mutationTransactionItemCount
    : noOpTransactionItemCount
  if (items.length !== expectedCount) {
    return failApply('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createApplyTransactionToken(
      input.successorState,
      input.marker,
    ),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Builds one fixed-order nine-item apply-checkpoint transaction.
 *
 * @param input - Exact authority, predecessor, successor, and receipt.
 * @returns Adapter-owned idempotent checkpoint transaction command.
 */
function createApplyCheckpointTransactionCommand(
  input: CreateApplyCheckpointTransactionCommandInput,
): TransactWriteItemsCommand {
  requireCheckpointTransactionBinding(input)
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.currentAuthority,
      commitAt: input.commitAt,
    })
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
    createExecutionStatePut(input),
    createCheckpointReceiptPut(input),
  ]
  if (items.length !== checkpointTransactionItemCount) {
    return failApply('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind: 'workspace-search-apply-checkpoint-transaction',
      version: applyRecordVersion,
      executionStateDigest:
        input.successorState.executionStateDigest,
      receiptDigest: input.receipt.receiptDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Builds one fixed-order nine-item immutable applied-root transaction.
 *
 * @param input - Exact authority, terminal predecessor, and applied root.
 * @returns Adapter-owned idempotent complete apply-seal transaction.
 */
function createApplySealTransactionCommand(
  input: CreateApplySealTransactionCommandInput,
): TransactWriteItemsCommand {
  requireAppliedRootRecordBinding(input.binding, input.root)
  if (
    input.root.predecessorRevision !==
      input.predecessorState.revision ||
    input.root.predecessorExecutionStateDigest !==
      input.predecessorState.executionStateDigest ||
    input.root.predecessorRunStateDigest !==
      input.predecessorState.runStateDigest ||
    input.root.committedAt !== input.commitAt.toISOString()
  ) {
    return failApply('INVALID_STATE')
  }
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.currentAuthority,
      commitAt: input.commitAt,
    })
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
    createTerminalExecutionStateConditionCheck(
      input.binding,
      input.predecessorState,
      input.predecessorStateRecord,
    ),
    createAppliedRootPut(input.binding, input.root),
  ]
  if (items.length !== applySealTransactionItemCount) {
    return failApply('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind: 'workspace-search-apply-seal-transaction',
      version: applyRecordVersion,
      rootDigest: input.root.rootDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Cross-checks receipt links against the exact CAS predecessor and successor.
 *
 * @param input - Exact checkpoint transaction material.
 */
function requireCheckpointTransactionBinding(
  input: CreateApplyCheckpointTransactionCommandInput,
): void {
  const predecessorRevision =
    input.predecessorState?.revision ??
      input.binding.executionRun.revision
  const predecessorDigest =
    input.predecessorState?.executionStateDigest ??
      input.binding.executionRun.executionRunDigest
  const predecessorKind =
    input.predecessorState === undefined
      ? 'execution-run-admission'
      : 'mutable-execution-state'
  const identity = requireCheckpointReceiptBinding(
    input.binding,
    input.receipt,
  )
  const successorRunState =
    reconstructWorkspaceSearchMigrationRunState(
      input.binding.executionRun,
      input.successorState,
    )
  const successorCheckpoint = readApplyCheckpoint(
    successorRunState,
    input.receipt.location,
  )
  if (
    input.receipt.predecessorRevision !==
      predecessorRevision ||
    input.receipt.predecessorKind !== predecessorKind ||
    input.receipt.predecessorExecutionStateDigest !==
      predecessorDigest ||
    input.receipt.successorRevision !==
      input.successorState.revision ||
    input.receipt.successorExecutionStateDigest !==
      input.successorState.executionStateDigest ||
    input.receipt.successorRunStateDigest !==
      input.successorState.runStateDigest ||
    input.receipt.committedAt !==
      input.successorState.updatedAt ||
    input.receipt.checkpointDigest !== createMigrationDigest(
      createWorkspaceSearchMigrationApplyCheckpointSnapshot(
        successorCheckpoint,
      ),
    ) ||
    identity.expectedRevision !== predecessorRevision
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Creates the exact mutable execution-state Put and predecessor CAS.
 *
 * @param input - Exact apply transaction material.
 * @returns One absent-or-exact predecessor state Put.
 */
function createExecutionStatePut(
  input: ExecutionStateTransitionMaterial,
): TransactWriteItem {
  const key = createStateKey(input.binding)
  const predecessorSnapshot = createStatePredecessorSnapshot(
    input.predecessorState,
    input.predecessorStateRecord,
  )
  const condition =
    createWorkspaceSearchMigrationItemConditionMaterial(
      input.binding.stateTable,
      key,
      predecessorSnapshot,
      executionStateRecordAttributeNames,
    )
  return {
    Put: {
      TableName: input.binding.stateTable.tableName,
      Item: createExecutionStateRecord(
        input.binding,
        input.successorState,
      ),
      ...createConditionFields(condition),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates one exact terminal v2 execution-state predecessor condition.
 *
 * @param binding - Exact admitted apply binding.
 * @param predecessor - Exact terminal mutable execution-state envelope.
 * @param record - Complete strongly read durable predecessor row.
 * @returns One exact full-record DynamoDB condition check.
 */
function createTerminalExecutionStateConditionCheck(
  binding: ApplyOperationBinding,
  predecessor: WorkspaceSearchMigrationExecutionState,
  record: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const runState = reconstructWorkspaceSearchMigrationRunState(
    binding.executionRun,
    predecessor,
  )
  requireCompleteApplyState(runState, predecessor)
  const snapshot = createStatePredecessorSnapshot(
    predecessor,
    record,
  )
  return createConditionCheck(
    binding.stateTable.tableName,
    createWorkspaceSearchMigrationItemConditionMaterial(
      binding.stateTable,
      createStateKey(binding),
      snapshot,
      executionStateRecordAttributeNames,
    ),
  )
}

/**
 * Requires a mutable v2 predecessor to represent all complete clean apply work.
 *
 * @param state - Reconstructed candidate applying state.
 * @param executionState - Candidate mutable predecessor envelope.
 */
function requireCompleteApplyState(
  state: WorkspaceSearchMigrationRunState,
  executionState: WorkspaceSearchMigrationExecutionState,
): void {
  const checkpoints: readonly MigrationSourceCheckpoint[] = [
    state.apply.sources['project-directory'],
    state.apply.sources['work-items'],
    state.apply.sources.collaboration,
    state.apply.sources.documents,
    state.apply.target,
  ]
  if (
    executionState.executionStateVersion !== 2 ||
    state.status !== 'applying' ||
    state.appliedOperationCount !== state.planOperationCount ||
    checkpoints.some((checkpoint) =>
      !checkpoint.completed ||
      checkpoint.cursor !== undefined ||
      checkpoint.aggregate.invalid !== 0
    )
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Creates the exact predecessor snapshot for mutable-state CAS.
 *
 * @param predecessor - Previous strict envelope, when present.
 * @param record - Previous complete durable row, when present.
 * @returns Exact present or absent row snapshot.
 */
function createStatePredecessorSnapshot(
  predecessor: WorkspaceSearchMigrationExecutionState | undefined,
  record: Readonly<Record<string, AttributeValue>> | undefined,
): MigrationItemSnapshot {
  if (predecessor === undefined && record === undefined) {
    return {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    }
  }
  if (predecessor === undefined || record === undefined) {
    return failApply('INVALID_STATE')
  }
  const parsed = parseWorkspaceSearchMigrationExecutionState(
    serializeWorkspaceSearchMigrationExecutionState(predecessor),
  )
  if (
    readStringAttribute(record, 'executionStateDigest') !==
      parsed.executionStateDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return {
    exists: true,
    item: cloneAttributeMap(record, 'INVALID_STATE'),
    digest: createAttributeMapDigest(record),
  }
}

/**
 * Creates one source or no-op target ConditionCheck.
 *
 * @param tableName - Exact measured table name.
 * @param material - Exact condition material.
 * @returns One DynamoDB ConditionCheck.
 */
function createConditionCheck(
  tableName: string,
  material: WorkspaceSearchMigrationItemConditionMaterial,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      ...createConditionFields(material),
      Key: material.Key,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates the target no-op check, conditional Put, or conditional Delete.
 *
 * @param tableName - Exact measured target table name.
 * @param operation - Exact planned target transition.
 * @param material - Exact preimage CAS material.
 * @returns One fixed-position target transaction item.
 */
function createTargetTransactionItem(
  tableName: string,
  operation: WorkspaceSearchMigrationOperation,
  material: WorkspaceSearchMigrationItemConditionMaterial,
): TransactWriteItem {
  if (operation.before.digest === operation.after.digest) {
    return createConditionCheck(tableName, material)
  }
  if (operation.after.exists) {
    return {
      Put: {
        TableName: tableName,
        Item: cloneAttributeMap(
          operation.after.item,
          'INVALID_ARGUMENT',
        ),
        ...createConditionFields(material),
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    }
  }
  return {
    Delete: {
      TableName: tableName,
      Key: material.Key,
      ...createConditionFields(material),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Copies exact condition fields while preserving optional operands.
 *
 * @param material - Exact bounded item condition material.
 * @returns Fields accepted by DynamoDB transaction operations.
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
 * Creates one deterministic immutable checkpoint-receipt absent Put.
 *
 * @param input - Exact checkpoint transaction material.
 * @returns One absent receipt Put at the fixed final position.
 */
function createCheckpointReceiptPut(
  input: CreateApplyCheckpointTransactionCommandInput,
): TransactWriteItem {
  return {
    Put: {
      TableName: input.binding.stateTable.tableName,
      Item: createCheckpointReceiptRecord(
        input.binding,
        input.receipt,
      ),
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
 * Creates one deterministic immutable applied-root absent Put.
 *
 * @param binding - Exact static admitted apply binding.
 * @param root - Exact immutable applied phase root.
 * @returns One absent root Put at the fixed final transaction position.
 */
function createAppliedRootPut(
  binding: ApplyOperationBinding,
  root: WorkspaceSearchMigrationAppliedRoot,
): TransactWriteItem {
  return {
    Put: {
      TableName: binding.stateTable.tableName,
      Item: createAppliedRootRecord(binding, root),
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
 * Creates one immutable operation-id marker absent Put.
 *
 * @param input - Exact apply transaction material.
 * @returns One deterministic absent marker Put.
 */
function createMarkerPut(
  input: CreateApplyTransactionCommandInput,
): TransactWriteItem {
  return {
    Put: {
      TableName: input.binding.stateTable.tableName,
      Item: createMarkerRecord(
        input.binding,
        input.predecessorState,
        input.successorState,
        input.marker,
      ),
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
 * Creates one mutation-only immutable sequence-index absent Put.
 *
 * @param input - Exact apply transaction material.
 * @param marker - Exact mutating marker.
 * @returns One deterministic absent sequence Put.
 */
function createSequencePut(
  input: CreateApplyTransactionCommandInput,
  marker: WorkspaceSearchOperationReceipt,
): TransactWriteItem {
  return {
    Put: {
      TableName: input.binding.stateTable.tableName,
      Item: createSequenceRecord(
        input.binding,
        input.predecessorState,
        input.successorState,
        marker,
      ),
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
 * Creates one deterministic bounded transaction idempotency token.
 *
 * @param successor - Exact successor execution state.
 * @param marker - Exact immutable marker.
 * @returns At-most-36-character DynamoDB client request token.
 */
function createApplyTransactionToken(
  successor: WorkspaceSearchMigrationExecutionState,
  marker: WorkspaceSearchOperationMarker,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-apply-operation-transaction',
    version: applyRecordVersion,
    executionStateDigest: successor.executionStateDigest,
    markerDigest: createMigrationDigest(marker),
  }).slice(0, 36)
}

/**
 * Creates a strongly consistent point read for one measured base table.
 *
 * @param table - Exact measured table.
 * @param key - Exact low-level physical key.
 * @returns Adapter-owned GetItem command.
 */
function createStrongReadCommand(
  table: MigrationTableIdentity,
  key: Readonly<Record<string, AttributeValue>>,
): GetItemCommand {
  return new GetItemCommand({
    TableName: table.tableName,
    ConsistentRead: true,
    Key: cloneAttributeMap(key, 'INVALID_ARGUMENT'),
  })
}

/**
 * Complete controlled field set for mutable execution-state rows.
 */
const executionStateRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'executionStateBytes',
  'executionStateDigest',
  'kind',
  'migrationId',
  'recordKey',
  'recordVersion',
  'revision',
  'runId',
  'runStateDigest',
  'stateTableId',
  'status',
])

/**
 * Complete controlled field set for immutable applied-root rows.
 */
const appliedRootRecordAttributeNames = Object.freeze([
  'committedAt',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'predecessorExecutionStateDigest',
  'predecessorRevision',
  'predecessorRunStateDigest',
  'recordKey',
  'recordVersion',
  'rootBytes',
  'rootDigest',
  'runId',
  'sealContentDigest',
  'stateTableId',
  'status',
  'successorRevision',
  'successorRunStateDigest',
])

/**
 * Extracts the deterministic key from a trusted admission condition helper.
 *
 * @param item - Exact exported execution-admission condition check.
 * @param tableName - Expected measured migration-state table name.
 * @returns Detached exact admission primary key.
 */
function readConditionCheckKey(
  item: TransactWriteItem,
  tableName: string,
): Readonly<Record<string, AttributeValue>> {
  const condition = item.ConditionCheck
  if (
    condition === undefined ||
    condition.TableName !== tableName ||
    condition.Key === undefined
  ) {
    return failApply('INVALID_STATE')
  }
  return cloneAttributeMap(condition.Key, 'INVALID_STATE')
}

/**
 * Requires a strong read to return the exact immutable admission row.
 *
 * @param binding - Exact static apply binding.
 * @param output - Raw strongly consistent admission read output.
 */
function requireExecutionRunAdmissionStrongRead(
  binding: ApplyOperationBinding,
  output: unknown,
): void {
  const item = readOutputItem(output)
  if (item === undefined) return failApply('INVALID_STATE')
  requireExactAttributeKeys(
    item,
    Object.keys(binding.executionRunRecord),
    'INVALID_STATE',
  )
  if (
    createAttributeMapDigest(item) !==
      createAttributeMapDigest(binding.executionRunRecord) ||
    createMigrationDigest(encodeUnknownAttributeMap(item)) !==
      createMigrationDigest(
        encodeUnknownAttributeMap(
          binding.executionRunRecord,
        ),
      )
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Creates one complete strict mutable execution-state record.
 *
 * @param binding - Exact static apply binding.
 * @param state - Exact successor mutable envelope.
 * @returns Complete low-level DynamoDB record.
 */
function createExecutionStateRecord(
  binding: ApplyOperationBinding,
  state: WorkspaceSearchMigrationExecutionState,
): Readonly<Record<string, AttributeValue>> {
  const bytes =
    serializeWorkspaceSearchMigrationExecutionState(state)
  const strict =
    parseWorkspaceSearchMigrationExecutionState(bytes)
  requireExecutionStateBinding(binding, strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createExecutionStateRecordKey(binding),
    },
    kind: { S: executionStateRecordKind },
    recordVersion: { N: String(applyRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    revision: { N: String(strict.revision) },
    status: { S: strict.status },
    runStateDigest: { S: strict.runStateDigest },
    executionStateDigest: {
      S: strict.executionStateDigest,
    },
    executionStateBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one complete mutable execution-state record.
 *
 * @param binding - Exact static apply binding.
 * @param item - Raw low-level DynamoDB record.
 * @returns Exact mutable execution-state envelope.
 */
function parseExecutionStateRecord(
  binding: ApplyOperationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationExecutionState {
  requireExactAttributeKeys(
    item,
    executionStateRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createExecutionStateRecordKey(binding) ||
    readStringAttribute(item, 'kind') !==
      executionStateRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      applyRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest
  ) {
    return failApply('INVALID_STATE')
  }
  const state = parseWorkspaceSearchMigrationExecutionState(
    readBinaryAttribute(item, 'executionStateBytes'),
  )
  requireExecutionStateBinding(binding, state)
  if (
    readNumberAttribute(item, 'revision') !== state.revision ||
    readStringAttribute(item, 'status') !== state.status ||
    readStringAttribute(item, 'runStateDigest') !==
      state.runStateDigest ||
    readStringAttribute(item, 'executionStateDigest') !==
      state.executionStateDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return state
}

/**
 * Requires one mutable envelope to remain rooted in exact admission.
 *
 * @param binding - Exact static apply binding.
 * @param state - Candidate strict mutable state.
 */
function requireExecutionStateBinding(
  binding: ApplyOperationBinding,
  state: WorkspaceSearchMigrationExecutionState,
): void {
  if (
    state.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    state.runId !== binding.executionRun.runId ||
    state.configurationHash !== binding.configurationHash ||
    state.revision <= binding.executionRun.revision
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Creates one complete strict immutable applied-root record.
 *
 * @param binding - Exact static admitted apply binding.
 * @param root - Exact immutable applied phase root.
 * @returns Complete low-level DynamoDB record.
 */
function createAppliedRootRecord(
  binding: ApplyOperationBinding,
  root: WorkspaceSearchMigrationAppliedRoot,
): Readonly<Record<string, AttributeValue>> {
  const bytes = serializeWorkspaceSearchMigrationAppliedRoot(root)
  const strict = parseWorkspaceSearchMigrationAppliedRoot(bytes)
  requireAppliedRootRecordBinding(binding, strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createAppliedRootRecordKey(binding) },
    kind: { S: appliedRootRecordKind },
    recordVersion: { N: String(applyRecordVersion) },
    stateTableId: { S: strict.stateTableId },
    configurationHash: { S: strict.configurationHash },
    runId: { S: strict.runId },
    executionRunDigest: { S: strict.executionRunDigest },
    predecessorRevision: {
      N: String(strict.predecessorRevision),
    },
    predecessorExecutionStateDigest: {
      S: strict.predecessorExecutionStateDigest,
    },
    predecessorRunStateDigest: {
      S: strict.predecessorRunStateDigest,
    },
    successorRevision: {
      N: String(strict.successorRevision),
    },
    status: { S: strict.status },
    successorRunStateDigest: {
      S: strict.successorRunStateDigest,
    },
    sealContentDigest: {
      S: strict.sealReference.contentDigest,
    },
    committedAt: { S: strict.committedAt },
    rootDigest: { S: strict.rootDigest },
    rootBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one complete immutable applied-root record.
 *
 * @param binding - Exact static admitted apply binding.
 * @param item - Raw low-level DynamoDB record.
 * @returns Exact immutable applied phase root.
 */
function parseAppliedRootRecord(
  binding: ApplyOperationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationAppliedRoot {
  requireExactAttributeKeys(
    item,
    appliedRootRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createAppliedRootRecordKey(binding) ||
    readStringAttribute(item, 'kind') !==
      appliedRootRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      applyRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest
  ) {
    return failApply('INVALID_STATE')
  }
  const root = parseWorkspaceSearchMigrationAppliedRoot(
    readBinaryAttribute(item, 'rootBytes'),
  )
  requireAppliedRootRecordBinding(binding, root)
  if (
    readNumberAttribute(item, 'predecessorRevision') !==
      root.predecessorRevision ||
    readStringAttribute(
      item,
      'predecessorExecutionStateDigest',
    ) !== root.predecessorExecutionStateDigest ||
    readStringAttribute(item, 'predecessorRunStateDigest') !==
      root.predecessorRunStateDigest ||
    readNumberAttribute(item, 'successorRevision') !==
      root.successorRevision ||
    readStringAttribute(item, 'status') !== root.status ||
    readStringAttribute(item, 'successorRunStateDigest') !==
      root.successorRunStateDigest ||
    readStringAttribute(item, 'sealContentDigest') !==
      root.sealReference.contentDigest ||
    readStringAttribute(item, 'committedAt') !==
      root.committedAt ||
    readStringAttribute(item, 'rootDigest') !== root.rootDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return root
}

/**
 * Requires one applied root to stay in this admitted run and table.
 *
 * @param binding - Exact static admitted apply binding.
 * @param root - Candidate strict applied root.
 */
function requireAppliedRootRecordBinding(
  binding: ApplyOperationBinding,
  root: WorkspaceSearchMigrationAppliedRoot,
): void {
  if (
    root.stateTableId !== binding.stateTable.tableId ||
    root.configurationHash !== binding.configurationHash ||
    root.runId !== binding.executionRun.runId ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Complete controlled field set for immutable checkpoint-receipt rows.
 */
const checkpointReceiptRecordAttributeNames = Object.freeze([
  'checkpointDigest',
  'commandDigest',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'location',
  'migrationId',
  'phase',
  'predecessorExecutionStateDigest',
  'predecessorRevision',
  'receiptBytes',
  'receiptDigest',
  'recordKey',
  'recordVersion',
  'runId',
  'stateTableId',
  'successorExecutionStateDigest',
  'successorRevision',
  'successorRunStateDigest',
])

/**
 * Creates one complete immutable checkpoint-receipt row.
 *
 * @param binding - Exact admitted apply binding.
 * @param receipt - Strict immutable checkpoint receipt.
 * @returns Complete bounded low-level DynamoDB record.
 */
function createCheckpointReceiptRecord(
  binding: ApplyOperationBinding,
  receipt: WorkspaceSearchMigrationApplyCheckpointReceipt,
): Readonly<Record<string, AttributeValue>> {
  const bytes =
    serializeWorkspaceSearchMigrationApplyCheckpointReceipt(receipt)
  const strict =
    parseWorkspaceSearchMigrationApplyCheckpointReceipt(bytes)
  const identity = requireCheckpointReceiptBinding(binding, strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        identity,
      ),
    },
    kind: { S: checkpointReceiptRecordKind },
    recordVersion: { N: String(applyRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    phase: { S: strict.phase },
    location: { S: strict.location },
    commandDigest: { S: strict.commandDigest },
    predecessorRevision: {
      N: String(strict.predecessorRevision),
    },
    predecessorExecutionStateDigest: {
      S: strict.predecessorExecutionStateDigest,
    },
    successorRevision: {
      N: String(strict.successorRevision),
    },
    successorExecutionStateDigest: {
      S: strict.successorExecutionStateDigest,
    },
    successorRunStateDigest: {
      S: strict.successorRunStateDigest,
    },
    checkpointDigest: { S: strict.checkpointDigest },
    receiptDigest: { S: strict.receiptDigest },
    receiptBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one complete immutable checkpoint-receipt row.
 *
 * @param binding - Exact admitted apply binding.
 * @param identity - Deterministic command identity expected at this key.
 * @param item - Raw low-level DynamoDB record.
 * @returns Exact detached strict checkpoint receipt.
 */
function parseCheckpointReceiptRecord(
  binding: ApplyOperationBinding,
  identity: WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationApplyCheckpointReceipt {
  requireExactAttributeKeys(
    item,
    checkpointReceiptRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        identity,
      ) ||
    readStringAttribute(item, 'kind') !==
      checkpointReceiptRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      applyRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest ||
    readStringAttribute(item, 'phase') !== 'apply' ||
    readStringAttribute(item, 'location') !==
      identity.location ||
    readStringAttribute(item, 'commandDigest') !==
      identity.commandDigest
  ) {
    return failApply('INVALID_STATE')
  }
  const receipt =
    parseWorkspaceSearchMigrationApplyCheckpointReceipt(
      readBinaryAttribute(item, 'receiptBytes'),
    )
  const receiptIdentity =
    requireCheckpointReceiptBinding(binding, receipt)
  if (
    receiptIdentity.commandDigest !== identity.commandDigest ||
    readNumberAttribute(item, 'predecessorRevision') !==
      receipt.predecessorRevision ||
    readStringAttribute(
      item,
      'predecessorExecutionStateDigest',
    ) !== receipt.predecessorExecutionStateDigest ||
    readNumberAttribute(item, 'successorRevision') !==
      receipt.successorRevision ||
    readStringAttribute(
      item,
      'successorExecutionStateDigest',
    ) !== receipt.successorExecutionStateDigest ||
    readStringAttribute(item, 'successorRunStateDigest') !==
      receipt.successorRunStateDigest ||
    readStringAttribute(item, 'checkpointDigest') !==
      receipt.checkpointDigest ||
    readStringAttribute(item, 'receiptDigest') !==
      receipt.receiptDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return receipt
}

/**
 * Reconstructs and verifies the exact command identity bound by a receipt.
 *
 * @param binding - Exact admitted apply binding.
 * @param receipt - Strict immutable checkpoint receipt.
 * @returns Exact deterministic receipt command identity.
 */
function requireCheckpointReceiptBinding(
  binding: ApplyOperationBinding,
  receipt: WorkspaceSearchMigrationApplyCheckpointReceipt,
): WorkspaceSearchMigrationApplyCheckpointCommandIdentity {
  const identity =
    createWorkspaceSearchMigrationApplyCheckpointCommandIdentity({
      stateTableId: receipt.stateTableId,
      configurationHash: receipt.configurationHash,
      runId: receipt.runId,
      executionRunDigest: receipt.executionRunDigest,
      location: receipt.location,
      expectedRevision: receipt.predecessorRevision,
    })
  if (
    receipt.stateTableId !== binding.stateTable.tableId ||
    receipt.configurationHash !== binding.configurationHash ||
    receipt.runId !== binding.executionRun.runId ||
    receipt.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    receipt.phase !== 'apply' ||
    receipt.commandDigest !== identity.commandDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return identity
}

/**
 * Creates one complete immutable operation marker record.
 *
 * @param binding - Exact static apply binding.
 * @param predecessor - Optional previous mutable state.
 * @param successor - Exact successor mutable state.
 * @param marker - Exact operation marker.
 * @returns Complete low-level DynamoDB marker record.
 */
function createMarkerRecord(
  binding: ApplyOperationBinding,
  predecessor: WorkspaceSearchMigrationExecutionState | undefined,
  successor: WorkspaceSearchMigrationExecutionState,
  marker: WorkspaceSearchOperationMarker,
): Readonly<Record<string, AttributeValue>> {
  const markerBytes =
    serializeWorkspaceSearchMigrationOperationMarker(marker)
  const strict = parseWorkspaceSearchMigrationOperationMarker(
    markerBytes,
  )
  requireMarkerBinding(binding, strict)
  const markerDigest = createMigrationDigest(strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createOperationMarkerRecordKey(
        binding,
        strict.operationId,
      ),
    },
    kind: { S: operationMarkerRecordKind },
    recordVersion: { N: String(applyRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    operationId: { S: strict.operationId },
    planSequence: { N: String(strict.planSequence) },
    planOperationDigest: {
      S: strict.planOperationDigest,
    },
    predecessorRevision: {
      N: String(
        predecessor?.revision ??
          binding.executionRun.revision,
      ),
    },
    successorRevision: { N: String(successor.revision) },
    successorExecutionStateDigest: {
      S: successor.executionStateDigest,
    },
    markerDigest: { S: markerDigest },
    markerBytes: { B: markerBytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one complete immutable mutation sequence-index record.
 *
 * @param binding - Exact static apply binding.
 * @param predecessor - Optional previous mutable state.
 * @param successor - Exact successor mutable state.
 * @param marker - Exact mutating marker.
 * @returns Complete low-level DynamoDB sequence record.
 */
function createSequenceRecord(
  binding: ApplyOperationBinding,
  predecessor: WorkspaceSearchMigrationExecutionState | undefined,
  successor: WorkspaceSearchMigrationExecutionState,
  marker: WorkspaceSearchOperationReceipt,
): Readonly<Record<string, AttributeValue>> {
  const markerBytes =
    serializeWorkspaceSearchMigrationOperationMarker(marker)
  const strict = parseWorkspaceSearchMigrationOperationMarker(
    markerBytes,
  )
  if (strict.kind !== 'workspace-search-operation-applied') {
    return failApply('INVALID_STATE')
  }
  requireMarkerBinding(binding, strict)
  const markerDigest = createMigrationDigest(strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createJournalSequenceRecordKey(
        binding,
        strict.sequence,
      ),
    },
    kind: { S: journalSequenceRecordKind },
    recordVersion: { N: String(applyRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    sequence: { N: String(strict.sequence) },
    operationId: { S: strict.operationId },
    operationMarkerRecordKey: {
      S: createOperationMarkerRecordKey(
        binding,
        strict.operationId,
      ),
    },
    planSequence: { N: String(strict.planSequence) },
    planOperationDigest: {
      S: strict.planOperationDigest,
    },
    predecessorRevision: {
      N: String(
        predecessor?.revision ??
          binding.executionRun.revision,
      ),
    },
    successorRevision: { N: String(successor.revision) },
    successorExecutionStateDigest: {
      S: successor.executionStateDigest,
    },
    markerDigest: { S: markerDigest },
    markerBytes: { B: markerBytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Complete immutable operation-marker row field set.
 */
const markerRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'markerBytes',
  'markerDigest',
  'migrationId',
  'operationId',
  'planOperationDigest',
  'planSequence',
  'predecessorRevision',
  'recordKey',
  'recordVersion',
  'runId',
  'stateTableId',
  'successorExecutionStateDigest',
  'successorRevision',
])

/**
 * Complete immutable journal-sequence row field set.
 */
const sequenceRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'markerBytes',
  'markerDigest',
  'migrationId',
  'operationId',
  'operationMarkerRecordKey',
  'planOperationDigest',
  'planSequence',
  'predecessorRevision',
  'recordKey',
  'recordVersion',
  'runId',
  'sequence',
  'stateTableId',
  'successorExecutionStateDigest',
  'successorRevision',
])

/**
 * Strictly parses one complete immutable operation marker row.
 *
 * @param binding - Exact static apply binding.
 * @param operationId - Expected deterministic operation identifier.
 * @param item - Raw low-level DynamoDB item.
 * @returns Exact durable marker projection.
 */
function parseMarkerRecord(
  binding: ApplyOperationBinding,
  operationId: string,
  item: Readonly<Record<string, AttributeValue>>,
): DurableApplyMarker {
  requireExactAttributeKeys(
    item,
    markerRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createOperationMarkerRecordKey(binding, operationId) ||
    readStringAttribute(item, 'kind') !==
      operationMarkerRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      applyRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest ||
    readStringAttribute(item, 'operationId') !== operationId
  ) {
    return failApply('INVALID_STATE')
  }
  const marker = parseWorkspaceSearchMigrationOperationMarker(
    readBinaryAttribute(item, 'markerBytes'),
  )
  requireMarkerBinding(binding, marker)
  const durable = createDurableMarkerProjection(item, marker)
  if (
    marker.operationId !== operationId ||
    readNumberAttribute(item, 'planSequence') !==
      marker.planSequence ||
    readStringAttribute(item, 'planOperationDigest') !==
      marker.planOperationDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return durable
}

/**
 * Strictly parses one complete immutable mutation sequence row.
 *
 * @param binding - Exact static apply binding.
 * @param sequence - Expected positive mutation sequence.
 * @param item - Raw low-level DynamoDB item.
 * @returns Exact durable mutating marker projection.
 */
function parseSequenceRecord(
  binding: ApplyOperationBinding,
  sequence: number,
  item: Readonly<Record<string, AttributeValue>>,
): DurableApplyMarker {
  requireExactAttributeKeys(
    item,
    sequenceRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createJournalSequenceRecordKey(binding, sequence) ||
    readStringAttribute(item, 'kind') !==
      journalSequenceRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      applyRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest ||
    readNumberAttribute(item, 'sequence') !== sequence
  ) {
    return failApply('INVALID_STATE')
  }
  const marker = parseWorkspaceSearchMigrationOperationMarker(
    readBinaryAttribute(item, 'markerBytes'),
  )
  if (
    marker.kind !== 'workspace-search-operation-applied' ||
    marker.sequence !== sequence
  ) {
    return failApply('INVALID_STATE')
  }
  requireMarkerBinding(binding, marker)
  if (
    readStringAttribute(item, 'operationId') !==
      marker.operationId ||
    readStringAttribute(item, 'operationMarkerRecordKey') !==
      createOperationMarkerRecordKey(
        binding,
        marker.operationId,
      ) ||
    readNumberAttribute(item, 'planSequence') !==
      marker.planSequence ||
    readStringAttribute(item, 'planOperationDigest') !==
      marker.planOperationDigest
  ) {
    return failApply('INVALID_STATE')
  }
  return createDurableMarkerProjection(item, marker)
}

/**
 * Cross-checks common durable marker projection fields.
 *
 * @param item - Strict marker or sequence record.
 * @param marker - Strict marker parsed from exact bytes.
 * @returns Exact durable marker projection.
 */
function createDurableMarkerProjection(
  item: Readonly<Record<string, AttributeValue>>,
  marker: WorkspaceSearchOperationMarker,
): DurableApplyMarker {
  const predecessorRevision = readPositiveSafeInteger(
    readNumberAttribute(item, 'predecessorRevision'),
    'INVALID_STATE',
  )
  const successorRevision = readPositiveSafeInteger(
    readNumberAttribute(item, 'successorRevision'),
    'INVALID_STATE',
  )
  const successorExecutionStateDigest = readDigest(
    readStringAttribute(item, 'successorExecutionStateDigest'),
    'INVALID_STATE',
  )
  const markerDigest = readDigest(
    readStringAttribute(item, 'markerDigest'),
    'INVALID_STATE',
  )
  if (
    successorRevision !== predecessorRevision + 1 ||
    markerDigest !== createMigrationDigest(marker)
  ) {
    return failApply('INVALID_STATE')
  }
  return {
    marker,
    predecessorRevision,
    successorRevision,
    successorExecutionStateDigest,
    markerDigest,
  }
}

/**
 * Requires one marker to remain bound to the exact admitted run.
 *
 * @param binding - Exact static apply binding.
 * @param marker - Candidate strict marker.
 */
function requireMarkerBinding(
  binding: ApplyOperationBinding,
  marker: WorkspaceSearchOperationMarker,
): void {
  if (
    marker.runId !== binding.executionRun.runId ||
    marker.configurationHash !== binding.configurationHash ||
    marker.planSequence > binding.executionRun.binding.planOperationCount
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Creates the deterministic mutable-state primary key.
 *
 * @param binding - Exact static apply binding.
 * @returns Low-level state-table primary key.
 */
function createStateKey(
  binding: ApplyOperationBinding,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createExecutionStateRecordKey(binding) },
  }
}

/**
 * Creates the deterministic immutable applied-root primary key.
 *
 * @param binding - Exact static apply binding.
 * @returns Low-level migration-state table primary key.
 */
function createAppliedRootKey(
  binding: ApplyOperationBinding,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createAppliedRootRecordKey(binding) },
  }
}

/**
 * Creates the deterministic immutable checkpoint-receipt primary key.
 *
 * @param identity - Exact content-addressed checkpoint command identity.
 * @returns Low-level migration-state table primary key.
 */
function createCheckpointReceiptKey(
  identity: WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        identity,
      ),
    },
  }
}

/**
 * Creates the deterministic operation-marker primary key.
 *
 * @param binding - Exact static apply binding.
 * @param operationId - Stable operation identifier.
 * @returns Low-level state-table primary key.
 */
function createMarkerKey(
  binding: ApplyOperationBinding,
  operationId: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createOperationMarkerRecordKey(binding, operationId),
    },
  }
}

/**
 * Creates the deterministic journal-sequence primary key.
 *
 * @param binding - Exact static apply binding.
 * @param sequence - Positive mutation sequence.
 * @returns Low-level state-table primary key.
 */
function createSequenceKey(
  binding: ApplyOperationBinding,
  sequence: number,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createJournalSequenceRecordKey(binding, sequence),
    },
  }
}

/**
 * Creates the deterministic mutable-state sort key.
 *
 * @param binding - Exact static apply binding.
 * @returns Bounded mutable-state record key.
 */
function createExecutionStateRecordKey(
  binding: ApplyOperationBinding,
): string {
  return `${executionStateRecordKeyPrefix}/${binding.bindingDigest}/state`
}

/**
 * Creates the content-independent complete-plan applied-root sort key.
 *
 * @param binding - Exact static apply binding.
 * @returns Bounded admitted-run root key.
 */
function createAppliedRootRecordKey(
  binding: ApplyOperationBinding,
): string {
  return `${appliedRootRecordKeyPrefix}/${binding.bindingDigest}/complete-plan`
}

/**
 * Creates one content-independent operation marker sort key.
 *
 * @param binding - Exact static apply binding.
 * @param operationId - Stable operation identifier.
 * @returns Bounded digest-addressed marker key.
 */
function createOperationMarkerRecordKey(
  binding: ApplyOperationBinding,
  operationId: string,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-apply-operation-key',
    version: applyRecordVersion,
    bindingDigest: binding.bindingDigest,
    operationId,
  })
  return `${operationMarkerRecordKeyPrefix}/${digest}/marker`
}

/**
 * Creates one deterministic mutation sequence sort key.
 *
 * @param binding - Exact static apply binding.
 * @param sequence - Positive mutation sequence.
 * @returns Bounded digest-addressed sequence key.
 */
function createJournalSequenceRecordKey(
  binding: ApplyOperationBinding,
  sequence: number,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-apply-journal-sequence-key',
    version: applyRecordVersion,
    bindingDigest: binding.bindingDigest,
    sequence,
  })
  return `${journalSequenceRecordKeyPrefix}/${digest}/receipt`
}

/**
 * Creates the exact planned source present-or-absent snapshot.
 *
 * @param operation - Exact planned migration operation.
 * @returns Exact source snapshot for strong read and transaction CAS.
 */
function createSourceSnapshot(
  operation: WorkspaceSearchMigrationOperation,
): MigrationItemSnapshot {
  const source = operation.sourceCondition
  if (!source.exists) {
    return {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    }
  }
  return {
    exists: true,
    item: cloneAttributeMap(source.item, 'INVALID_ARGUMENT'),
    digest: source.itemDigest,
  }
}

/**
 * Validates the intended target snapshot and true no-op representation.
 *
 * @param targetTable - Exact measured Workspace Search target table.
 * @param operation - Exact planned target transition.
 */
function requireValidAfterSnapshot(
  targetTable: MigrationTableIdentity,
  operation: WorkspaceSearchMigrationOperation,
): void {
  createWorkspaceSearchMigrationItemConditionMaterial(
    targetTable,
    operation.targetKey,
    operation.after,
    targetSchemaKnownAttributeNames(targetTable),
  )
  if (
    operation.before.digest === operation.after.digest &&
    !migrationSnapshotsExactlyEqual(
      operation.before,
      operation.after,
    )
  ) {
    return failApply('INVALID_ARGUMENT')
  }
}

/**
 * Compares two native DynamoDB snapshots by canonical full content.
 *
 * @param left - First exact snapshot.
 * @param right - Second exact snapshot.
 * @returns Whether existence, digest, and every value are identical.
 */
function migrationSnapshotsExactlyEqual(
  left: MigrationItemSnapshot,
  right: MigrationItemSnapshot,
): boolean {
  if (
    left.exists !== right.exists ||
    left.digest !== right.digest
  ) {
    return false
  }
  if (!left.exists || !right.exists) return true
  return createMigrationDigest(encodeUnknownAttributeMap(left.item)) ===
    createMigrationDigest(encodeUnknownAttributeMap(right.item))
}

/**
 * Returns all controlled source attributes for transaction-time absence guards.
 *
 * DynamoDB cannot reject an arbitrary unknown top-level attribute. These names
 * cover the repository's known schemas and measured TTL attribute. The closed
 * writer fence and immediate strong read remain required for unknown names.
 *
 * @param source - Exact logical source table.
 * @param table - Exact measured source table.
 * @returns Sorted unique known top-level attribute names.
 */
function sourceSchemaKnownAttributeNames(
  source: WorkspaceSearchMigrationSourceName,
  table: MigrationTableIdentity,
): readonly string[] {
  const common = table.ttl.attribute === undefined
    ? []
    : [table.ttl.attribute]
  if (source === 'project-directory') {
    return uniqueSortedAttributeNames([
      ...common,
      'archivedAt',
      'createdAt',
      'directoryId',
      'entryKey',
      'entryType',
      'expanded',
      'nameEn',
      'nameJa',
      'projectId',
      'projectSortOrder',
      'teamId',
      'teamSortOrder',
      'tone',
      'updatedAt',
      'webhookAuthorizationKey',
      'webhookAuthorizationSortKey',
    ])
  }
  if (source === 'work-items') {
    return uniqueSortedAttributeNames([
      ...common,
      'archivedAt',
      'archivedBy',
      'assignedProjectId',
      'assignee',
      'assigneeKey',
      'assigneeUserId',
      'createdAt',
      'creatorMemberKey',
      'customFields',
      'customFieldValues',
      'deletedAt',
      'description',
      'directoryId',
      'directoryProjectId',
      'directoryTeamId',
      'dueDate',
      'importRequestDigest',
      'issueId',
      'migrationSource',
      'migrationSourceKey',
      'priority',
      'projectId',
      'relationIds',
      'revision',
      'schemaVersion',
      'sortOrder',
      'source',
      'sourceRequestId',
      'status',
      'statusCategory',
      'teamId',
      'title',
      'titleKey',
      'updatedAt',
      'workflowSchemaVersion',
      'workflowStatusId',
      'workItemId',
    ])
  }
  if (source === 'collaboration') {
    return uniqueSortedAttributeNames([
      ...common,
      'authorMemberKey',
      'bodyMarkdown',
      'createdAt',
      'deletedAt',
      'editedAt',
      'entityKey',
      'entryType',
      'expiresAt',
      'id',
      'mentionMemberKeys',
      'parentCommentId',
      'reactions',
      'recordKey',
      'resolvedAt',
      'resolvedByMemberKey',
      'rootCommentId',
      'updatedAt',
      'version',
    ])
  }
  return uniqueSortedAttributeNames([
    ...common,
    'createIdempotencyKeyHash',
    'createRequestFingerprint',
    'document',
    'documentId',
    'elementRevisions',
    'entryType',
    'expiresAtEpoch',
    'lastVersionSnapshotAt',
    'lastVersionSnapshotRevision',
    'operationConflictFloorRevision',
    'publicShareEpoch',
    'recordKey',
    'revision',
    'workspaceId',
  ])
}

/**
 * Returns all controlled Workspace Search target attributes.
 *
 * @param table - Exact measured target table.
 * @returns Sorted unique known target attribute names.
 */
function targetSchemaKnownAttributeNames(
  table: MigrationTableIdentity,
): readonly string[] {
  return uniqueSortedAttributeNames([
    ...(table.ttl.attribute === undefined
      ? []
      : [table.ttl.attribute]),
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
}

/**
 * Deduplicates and UTF-8-ordinal-sorts a controlled attribute-name list.
 *
 * @param names - Candidate known attribute names.
 * @returns Stable sorted unique names.
 */
function uniqueSortedAttributeNames(
  names: readonly string[],
): readonly string[] {
  return [...new Set(names)].sort(compareUtf8Ordinal)
}

/**
 * Compares strings by their UTF-8 byte sequence.
 *
 * @param left - First text.
 * @param right - Second text.
 * @returns Negative, zero, or positive ordering result.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Requires retained plan and prior journal evidence before any new progress.
 *
 * @param binding - Exact static apply binding.
 * @param predecessor - Optional mutable predecessor.
 * @param at - Adapter-owned preflight epoch milliseconds.
 */
function requireProgressRetention(
  binding: ApplyOperationBinding,
  predecessor: WorkspaceSearchMigrationExecutionState | undefined,
  at: number,
): void {
  requireRetentionHeadroom(
    binding.sealedPlanningAuthority.planSealReference.retainUntil,
    at,
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    'INVALID_STATE',
  )
  if (predecessor?.minimumJournalRetainUntil !== undefined) {
    requireRetentionHeadroom(
      predecessor.minimumJournalRetainUntil,
      at,
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
      'INVALID_JOURNAL',
    )
  }
}

/**
 * Requires all evidence to survive the bounded transaction after final clock.
 *
 * @param binding - Exact static apply binding.
 * @param predecessor - Optional mutable predecessor.
 * @param journalRetainUntil - Fresh mutation journal deadline, when any.
 * @param commitAt - Adapter-owned final commit epoch milliseconds.
 */
function requireCommitRetention(
  binding: ApplyOperationBinding,
  predecessor: WorkspaceSearchMigrationExecutionState | undefined,
  journalRetainUntil: string | undefined,
  commitAt: number,
): void {
  requireProgressRetention(binding, predecessor, commitAt)
  if (journalRetainUntil === undefined) return
  const minimumFreshJournalHeadroom =
    binding.configuration.journal.defaultRetentionDays *
      retentionDayMilliseconds +
    transactionTimeoutMilliseconds
  if (
    !Number.isSafeInteger(minimumFreshJournalHeadroom) ||
    minimumFreshJournalHeadroom <= transactionTimeoutMilliseconds
  ) {
    return failApply('INVALID_STATE')
  }
  requireRetentionHeadroom(
    journalRetainUntil,
    commitAt,
    minimumFreshJournalHeadroom,
    'INVALID_JOURNAL',
  )
}

/**
 * Requires one canonical deadline to retain exact minimum headroom.
 *
 * @param retainUntil - Canonical retention deadline.
 * @param at - Current epoch milliseconds.
 * @param minimumHeadroom - Required remaining milliseconds.
 * @param code - Stable failure classification.
 */
function requireRetentionHeadroom(
  retainUntil: string,
  at: number,
  minimumHeadroom: number,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    !isCanonicalTimestamp(retainUntil) ||
    Date.parse(retainUntil) - at < minimumHeadroom
  ) {
    return failApply(code)
  }
}

/**
 * Strictly snapshots one rich immutable journal reference.
 *
 * @param value - Candidate gateway result.
 * @returns Detached exact reference.
 */
function readJournalReference(
  value: unknown,
): WorkspaceSearchOperationReceipt['journal'] {
  const record = requirePlainRecord(value, 'INVALID_JOURNAL')
  requireExactKeys(
    record,
    [
      'byteLength',
      'contentDigest',
      'headDigest',
      'objectKey',
      'retainUntil',
      'versionId',
    ],
    'INVALID_JOURNAL',
  )
  const objectKey = readIdentifier(
    readOwn(record, 'objectKey', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  const versionId = readIdentifier(
    readOwn(record, 'versionId', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  const contentDigest = readDigest(
    readOwn(record, 'contentDigest', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  const byteLength = readPositiveSafeInteger(
    readOwn(record, 'byteLength', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  const retainUntil = readTimestamp(
    readOwn(record, 'retainUntil', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  const headDigest = readDigest(
    readOwn(record, 'headDigest', 'INVALID_JOURNAL'),
    'INVALID_JOURNAL',
  )
  return {
    objectKey,
    versionId,
    contentDigest,
    byteLength,
    retainUntil,
    headDigest,
  }
}

/**
 * Requires one durable marker to prove the exact retried command.
 *
 * @param command - Exact detached retry command.
 * @param durable - Exact durable operation marker row.
 */
function requireMarkerMatchesCommand(
  command: PreparedApplyCommand,
  durable: DurableApplyMarker,
): void {
  const planned = command.plannedOperation
  const operation = planned.operation
  const marker = durable.marker
  const expectedSourceDigest = operation.sourceCondition.exists
    ? operation.sourceCondition.itemDigest
    : undefined
  if (
    durable.predecessorRevision !== command.expectedRevision ||
    durable.successorRevision !== command.expectedRevision + 1 ||
    marker.runId !== planned.runId ||
    marker.configurationHash !== planned.configurationHash ||
    marker.operationId !== operation.operationId ||
    marker.planSequence !== planned.planSequence ||
    marker.planOperationDigest !== planned.operationDigest ||
    marker.targetKeyDigest !== operation.targetKeyDigest ||
    marker.sourceDigest !== expectedSourceDigest ||
    marker.afterDigest !== operation.after.digest
  ) {
    return failApply('INVALID_STATE')
  }
  if (operation.before.digest === operation.after.digest) {
    if (
      marker.kind !==
        'workspace-search-operation-already-current'
    ) {
      return failApply('INVALID_STATE')
    }
    return
  }
  if (
    marker.kind !== 'workspace-search-operation-applied' ||
    marker.beforeDigest !== operation.before.digest
  ) {
    return failApply('INVALID_STATE')
  }
}

/**
 * Cross-checks an exact-version journal replay with its marker and plan entry.
 *
 * @param planned - Exact immutable planned operation.
 * @param marker - Exact durable mutating marker.
 * @param segment - Exact immutable journal segment replay.
 */
function requireJournalSegmentMatchesMarker(
  planned: WorkspaceSearchPlannedOperation,
  marker: WorkspaceSearchOperationReceipt,
  segment: WorkspaceSearchJournalSegment,
): void {
  const operation = planned.operation
  const sourceDigest = operation.sourceCondition.exists
    ? operation.sourceCondition.itemDigest
    : undefined
  if (
    segment.runId !== planned.runId ||
    segment.configurationHash !== planned.configurationHash ||
    segment.sequence !== marker.sequence ||
    segment.operationId !== operation.operationId ||
    segment.sourceDigest !== sourceDigest ||
    segment.targetKeyDigest !== operation.targetKeyDigest ||
    segment.before.digest !== operation.before.digest ||
    segment.after.digest !== operation.after.digest ||
    segment.preparedFenceToken > marker.fenceToken ||
    Date.parse(segment.createdAt) > Date.parse(marker.committedAt)
  ) {
    return failApply('INVALID_JOURNAL')
  }
}

/**
 * Reads one trusted clock sample.
 *
 * @param clock - Captured epoch-millisecond clock.
 * @returns Exact safe epoch milliseconds.
 */
function readClock(clock: () => number): number {
  const milliseconds = clock()
  if (!Number.isSafeInteger(milliseconds)) {
    return failApply('INVALID_STATE')
  }
  try {
    if (
      new Date(milliseconds).toISOString() ===
        'Invalid Date'
    ) {
      return failApply('INVALID_STATE')
    }
  } catch {
    return failApply('INVALID_STATE')
  }
  return milliseconds
}

/**
 * Reads one optional low-level GetItem result without invoking accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Detached exact item or undefined.
 */
function readOutputItem(
  output: unknown,
): Readonly<Record<string, AttributeValue>> | undefined {
  const record = requirePlainRecord(output, 'INVALID_STATE')
  if (
    Reflect.ownKeys(record).some((key) => typeof key === 'symbol')
  ) {
    return failApply('INVALID_STATE')
  }
  const descriptor =
    Object.getOwnPropertyDescriptor(record, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failApply('INVALID_STATE')
  }
  const item = cloneAttributeMap(
    descriptor.value,
    'INVALID_STATE',
  )
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Losslessly detaches one low-level DynamoDB attribute map.
 *
 * @param value - Candidate item or key.
 * @param code - Stable failure classification.
 * @returns Detached validated attribute map.
 */
function cloneAttributeMap(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failApply(code)
  }
}

/**
 * Requires one item to contain exactly the controlled attribute set.
 *
 * @param item - Candidate low-level item.
 * @param expectedKeys - Complete expected attribute names.
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
    return failApply(code)
  }
}

/**
 * Reads one exact single-string DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['S'], 'INVALID_STATE')
  const value = readOwn(record, 'S', 'INVALID_STATE')
  if (typeof value !== 'string') {
    return failApply('INVALID_STATE')
  }
  return value
}

/**
 * Reads one exact nonnegative integer DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact safe integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['N'], 'INVALID_STATE')
  const value = readOwn(record, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return failApply('INVALID_STATE')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return failApply('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one exact nonempty binary DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Detached exact bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['B'], 'INVALID_STATE')
  const value = readOwn(record, 'B', 'INVALID_STATE')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failApply('INVALID_STATE')
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength === 0) {
    return failApply('INVALID_STATE')
  }
  return copy
}

/**
 * Requires one ordinary non-Proxy record.
 *
 * @param value - Candidate record.
 * @param code - Stable failure classification.
 * @returns Exact ordinary record.
 */
function requirePlainRecord(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failApply(code)
  }
  return value
}

/**
 * Narrows one ordinary non-Proxy record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary string-keyed record.
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
 * Requires an exact enumerable own field set.
 *
 * @param record - Candidate ordinary record.
 * @param expectedKeys - Complete accepted field set.
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
    return failApply(code)
  }
  const actualStrings = Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some((key, index) => key !== expected[index])
  ) {
    return failApply(code)
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
 * @returns Exact stored property value.
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
    return failApply(code)
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
    return failApply(code)
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Stable failure classification.
 * @returns Exact lowercase digest.
 */
function readDigest(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (!isHexDigest(value)) return failApply(code)
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @param code - Stable failure classification.
 * @returns Exact canonical timestamp.
 */
function readTimestamp(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (!isCanonicalTimestamp(value)) return failApply(code)
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
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
    return failApply(code)
  }
  return value
}

/**
 * Structurally narrows a configuration before its strict canonical detacher.
 *
 * @param value - Candidate measured configuration.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requireConfiguration(
  value: unknown,
): WorkspaceSearchMigrationConfiguration {
  if (!isConfiguration(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate migration configuration.
 *
 * @param value - Candidate value.
 * @returns Whether it can be passed to the strict canonical detacher.
 */
function isConfiguration(
  value: unknown,
): value is WorkspaceSearchMigrationConfiguration {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows a planning-admitted boundary before strict serialization.
 *
 * @param value - Candidate boundary.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requireExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (!isExecutionBoundary(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate planning-admitted boundary.
 *
 * @param value - Candidate value.
 * @returns Whether it can be passed to the strict canonical codec.
 */
function isExecutionBoundary(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows a sealed root before strict serialization.
 *
 * @param value - Candidate sealed authority.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requireSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthority(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate sealed planning authority.
 *
 * @param value - Candidate value.
 * @returns Whether it can be passed to the strict canonical codec.
 */
function isSealedPlanningAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows an immutable execution admission.
 *
 * @param value - Candidate admission.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requireExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRun(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate execution admission.
 *
 * @param value - Candidate value.
 * @returns Whether it can be passed to the strict canonical codec.
 */
function isExecutionRun(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows one closed writer-fence row.
 *
 * @param value - Candidate closed writer-fence record.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requireClosedWriterFenceRecord(
  value: unknown,
): WorkspaceSearchWriterFenceClosedRecord {
  if (!isClosedWriterFenceRecord(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows one candidate closed writer-fence record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the strict writer-fence reader may consume it.
 */
function isClosedWriterFenceRecord(
  value: unknown,
): value is WorkspaceSearchWriterFenceClosedRecord {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows one planned operation before strict serialization.
 *
 * @param value - Candidate planned operation.
 * @returns Typed value after a minimal ordinary-record check.
 */
function requirePlannedOperation(
  value: unknown,
): WorkspaceSearchPlannedOperation {
  if (!isPlannedOperation(value)) {
    return failApply('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate planned operation.
 *
 * @param value - Candidate value.
 * @returns Whether it can be passed to the strict canonical codec.
 */
function isPlannedOperation(
  value: unknown,
): value is WorkspaceSearchPlannedOperation {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Classifies one checkpoint transaction failure after an absent receipt reread.
 *
 * @param error - Raw transaction error.
 * @returns Stable retry, authority, drift, or ambiguous code.
 */
function classifyCheckpointTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
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
      const index =
        workspaceSearchMigrationApplyCheckpointTransactionIndex
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
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= index.checkpointReceipt;
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
      return cancellationWasTransient(error)
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
 * Classifies one complete apply-seal transaction after an absent root reread.
 *
 * @param error - Raw transaction error.
 * @returns Stable retry, authority, drift, or ambiguous code.
 */
function classifyApplySealTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
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
      const index =
        workspaceSearchMigrationApplySealTransactionIndex
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
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= index.appliedRoot;
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
      return cancellationWasTransient(error)
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
 * Classifies one transaction failure after a strong absent marker reread.
 *
 * @param error - Raw transaction error.
 * @returns Stable retry, authority, drift, or ambiguous code.
 */
function classifyTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
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
      const index =
        workspaceSearchMigrationApplyOperationTransactionIndex
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
        readCancellationReasonCode(error, index.source) ===
          'ConditionalCheckFailed'
      ) {
        return 'SOURCE_DRIFT'
      }
      if (
        readCancellationReasonCode(error, index.target) ===
          'ConditionalCheckFailed'
      ) {
        return 'TARGET_DRIFT'
      }
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= index.executionState;
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
      if (
        readCancellationReasonCode(
          error,
          index.operationMarker,
        ) === 'ConditionalCheckFailed' ||
        readCancellationReasonCode(
          error,
          index.journalSequence,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'INVALID_STATE'
      }
      return cancellationWasTransient(error)
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
 * Reads one fixed transaction cancellation reason without trusting accessors.
 *
 * @param error - Raw DynamoDB cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable reason code or undefined.
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
 * Detects any explicitly retry-safe transaction cancellation reason.
 *
 * @param error - Raw DynamoDB cancellation.
 * @returns Whether infrastructure rejected the transaction retry-safely.
 */
function cancellationWasTransient(error: unknown): boolean {
  for (
    let index = 0;
    index < mutationTransactionItemCount;
    index += 1
  ) {
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
 * Private structural input supplied to Smithy's retry classifiers.
 */
type ApplyAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Copies only structural retry-classifier fields from one Error.
 *
 * @param error - Raw SDK or Node.js error.
 * @returns Secret-free structural classification input.
 */
function createAwsClassificationInput(
  error: Error,
): ApplyAwsClassificationInput {
  const input: {
    name: string
    message: string
    $metadata?: {
      httpStatusCode?: number
    }
    code?: string
  } = {
    name: readErrorName(error) ?? 'Error',
    message: 'Workspace Search migration apply operation failed.',
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
 * Reads one own string data property if safely available.
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
 * Reads one own finite number data property if safely available.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns Number value or undefined.
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
 * Reads one own ordinary-record data property if safely available.
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
  if (!(error instanceof Error) || nodeUtilTypes.isProxy(error)) {
    return undefined
  }
  return readOwnStringIfData(error, 'name') ?? 'Error'
}

/**
 * Detects a missing or replaced DynamoDB resource.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether it denotes resource absence.
 */
function isResourceNotFoundError(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    readErrorName(error) === 'ResourceNotFoundException'
}

/**
 * Reads a trusted public managed-guard failure code.
 *
 * Public transport failures bypass automatic reconciliation because managed
 * wrappers use `AMBIGUOUS_OPERATION_UNRESOLVED` to quarantine post-send
 * incarnation drift.
 *
 * @param error - Candidate public transport failure.
 * @returns Stable code or undefined for a raw transaction failure.
 */
function readPublicFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  if (
    !(error instanceof WorkspaceSearchMigrationFailure) ||
    nodeUtilTypes.isProxy(error)
  ) {
    return undefined
  }
  const codeDescriptor =
    Object.getOwnPropertyDescriptor(error, 'code')
  if (
    codeDescriptor === undefined ||
    !Object.hasOwn(codeDescriptor, 'value')
  ) {
    return 'INVALID_STATE'
  }
  return isWorkspaceSearchMigrationFailureCode(
      codeDescriptor.value
    )
    ? codeDescriptor.value
    : 'INVALID_STATE'
}

/**
 * Classifies a failed reconciliation read or strict parse.
 *
 * @param error - Arbitrary reconciliation failure.
 * @returns Stable fail-closed reconciliation code.
 */
function readReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  if (error instanceof ApplyOperationFailure) {
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
}

/**
 * Runs one asynchronous public apply operation behind a stable boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful operation result.
 */
async function runApplyBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createApplyPublicFailure(
      readApplyFailureCode(error, false),
    )
  }
}

/**
 * Extracts one stable code from internal, public, codec, or raw failures.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether invalid core material is an argument.
 * @returns Stable raw-value-free failure code.
 */
function readApplyFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  const publicCode = readPublicFailureCode(error)
  if (publicCode !== undefined) return publicCode
  if (error instanceof ApplyOperationFailure) return error.code
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
  return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
}

/**
 * Private stable failure used inside the apply persistence boundary.
 */
class ApplyOperationFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'ApplyOperationFailure'
    this.code = code
  }
}

/**
 * Creates one generic public apply persistence failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Raw-value-free public migration error.
 */
function createApplyPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration apply operation failed.',
  )
}

/**
 * Raises one private stable apply failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failApply(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new ApplyOperationFailure(code)
}
