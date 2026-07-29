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
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationTableRole,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  serializeWorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationAppliedRootConditionCheck,
} from './migration-applied-root-aws'
import {
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
} from './migration-execution-boundary-aws'
import {
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  completeWorkspaceSearchMigrationFullVerification,
  createEmptyWorkspaceSearchMigrationFullVerificationProgress,
  createWorkspaceSearchMigrationFullVerificationPlan,
  type WorkspaceSearchMigrationFullVerificationPlan,
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
} from './migration-full-verification'
import {
  decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot,
  createWorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  createWorkspaceSearchMigrationFullVerificationPageReceipt,
  createWorkspaceSearchMigrationFullVerificationPersistenceState,
  createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  createWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  parseWorkspaceSearchMigrationFullVerificationPageReceipt,
  parseWorkspaceSearchMigrationFullVerificationPersistenceState,
  parseWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  serializeWorkspaceSearchMigrationFullVerificationPageReceipt,
  serializeWorkspaceSearchMigrationFullVerificationPersistenceState,
  serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition,
  type WorkspaceSearchMigrationFullVerificationArtifactReference,
  type WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  type WorkspaceSearchMigrationFullVerificationPagePredecessor,
  type WorkspaceSearchMigrationFullVerificationPageReceipt,
  type WorkspaceSearchMigrationFullVerificationPersistenceState,
  type WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  type WorkspaceSearchMigrationFullVerificationPublicationAuthority,
  type WorkspaceSearchMigrationFullVerificationTableIds,
  type WorkspaceSearchMigrationFullVerificationVerifiedRoot,
} from './migration-full-verification-persistence'
import type {
  WorkspaceSearchMigrationPlanArtifactReplayResult,
} from './migration-plan-artifact'
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
  type WorkspaceSearchMigrationCheckpointLocation,
  type WorkspaceSearchMigrationLeaseClaim,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import {
  type WorkspaceSearchMigrationVerificationResultArtifact,
  type WorkspaceSearchMigrationVerificationResultArtifactReference,
  type WorkspaceSearchMigrationVerificationResultAwsGateway,
} from './migration-verification-result-aws'

const verificationRecordVersion = 1
const verificationStateRecordKind =
  'workspace-search-migration-full-verification-state-record'
const verificationReceiptRecordKind =
  'workspace-search-migration-full-verification-page-receipt-record'
const verifiedRootRecordKind =
  'workspace-search-migration-full-verification-verified-root-record'
const verificationStateRecordKeyPrefix = 'full-verification-state/v1'
const verificationReceiptRecordKeyPrefix =
  'full-verification-page-receipt/v1'
const verifiedRootRecordKeyPrefix = 'full-verification-verified-root/v1'
const pageTransactionItemCount = 9
const publicationTransactionItemCount = 9

const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

const verificationStateRecordAttributeNames = Object.freeze([
  'appliedRootDigest',
  'configurationHash',
  'kind',
  'lastCommandDigest',
  'migrationId',
  'planArtifactBindingDigest',
  'recordKey',
  'recordVersion',
  'revision',
  'runId',
  'sealedPlanningAuthorityDigest',
  'stateBytes',
  'stateDigest',
  'stateTableId',
  'verificationPlanDigest',
])

const verificationReceiptRecordAttributeNames = Object.freeze([
  'appliedRootDigest',
  'commandDigest',
  'configurationHash',
  'kind',
  'location',
  'migrationId',
  'planArtifactBindingDigest',
  'predecessorDigest',
  'predecessorRevision',
  'receiptBytes',
  'receiptDigest',
  'recordKey',
  'recordVersion',
  'runId',
  'sealedPlanningAuthorityDigest',
  'stateTableId',
  'successorRevision',
  'successorStateDigest',
  'verificationPlanDigest',
])

const verifiedRootRecordAttributeNames = Object.freeze([
  'appliedRootDigest',
  'configurationHash',
  'kind',
  'migrationId',
  'planArtifactBindingDigest',
  'recordKey',
  'recordVersion',
  'rootBytes',
  'runId',
  'sealedPlanningAuthorityDigest',
  'stateTableId',
  'terminalReceiptDigest',
  'terminalStateDigest',
  'verificationPlanDigest',
  'verificationResultDigest',
  'verifiedAt',
  'verifiedRootDigest',
])

/**
 * Fixed transaction and cancellation-reason positions for one verification page.
 */
export const workspaceSearchMigrationFullVerificationPageTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning authority condition. */
    sealedPlanningAuthority: 5,
    /** Exact complete immutable applied-root condition. */
    appliedRoot: 6,
    /** Absent or exact-predecessor verification-state Put. */
    verificationState: 7,
    /** Absent immutable page-receipt Put. */
    pageReceipt: 8,
    /** Fixed page transaction item count. */
    count: pageTransactionItemCount,
  })

/**
 * Fixed transaction and cancellation-reason positions for verified publication.
 */
export const workspaceSearchMigrationFullVerificationPublishTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning authority condition. */
    sealedPlanningAuthority: 5,
    /** Exact complete immutable applied-root condition. */
    appliedRoot: 6,
    /** Exact terminal verification-state condition. */
    terminalState: 7,
    /** Absent immutable verified-root Put. */
    verifiedRoot: 8,
    /** Fixed verified publication transaction item count. */
    count: publicationTransactionItemCount,
  })

/**
 * Trusted clock owned by the full-verification persistence adapter.
 *
 * @returns Current trusted adapter time.
 */
export type WorkspaceSearchMigrationFullVerificationAwsClock =
  () => Date

/**
 * Fresh current-authority reader used immediately before verification writes.
 */
export interface WorkspaceSearchMigrationFullVerificationAuthorityPort {
  /**
   * Resolves the current lease, pointer, and immutable receipt.
   *
   * @param lease - Exact caller lease identity.
   * @returns Fresh strongly resolved durable authority.
   */
  readAuthority(
    lease: WorkspaceSearchMigrationLeaseClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>
}

/**
 * Strong immutable applied-root reader bound by the composition layer.
 */
export interface WorkspaceSearchMigrationFullVerificationAppliedRootReader {
  /**
   * Strongly reads the one applied root for this admitted execution.
   *
   * @returns Strict immutable applied root, or undefined when absent.
   */
  readAppliedRoot():
    Promise<WorkspaceSearchMigrationAppliedRoot | undefined>
}

/**
 * Narrow exact-version complete-plan replay dependency.
 */
export interface WorkspaceSearchMigrationFullVerificationPlanReplayGateway {
  /**
   * Replays the complete plan from its exact immutable roots.
   *
   * @param input - Exact plan-seal and manifest-head references.
   * @returns Detached validated seal, head, and ordered operations.
   */
  replayPlanArtifact(
    input: {
      /** Exact immutable plan-seal version. */
      readonly planSealReference:
        WorkspaceSearchMigrationFullVerificationArtifactReference
      /** Exact immutable plan-manifest-head version. */
      readonly manifestHeadReference:
        WorkspaceSearchMigrationFullVerificationArtifactReference
    },
  ): Promise<WorkspaceSearchMigrationPlanArtifactReplayResult>
}

/**
 * Narrow exact-version complete apply-seal replay dependency.
 */
export interface WorkspaceSearchMigrationFullVerificationApplySealReader {
  /**
   * Replays one exact immutable complete apply seal.
   *
   * @param reference - Exact immutable complete-seal version.
   * @returns Detached strict complete apply seal.
   */
  readCompleteApplySeal(
    reference:
      WorkspaceSearchMigrationAppliedRoot['sealReference'],
  ): Promise<WorkspaceSearchMigrationCompleteApplySeal>
}

/**
 * One-page scanner that returns a pure-kernel successor progress value.
 */
export interface WorkspaceSearchMigrationFullVerificationPageScanner {
  /**
   * Scans exactly one bounded next page at the selected location.
   *
   * @param input - Exact plan, durable predecessor progress, and location.
   * @returns Complete pure successor progress after exactly one page.
   */
  scanVerificationPage(
    input: {
      /** Exact lazily replayed plan-derived verification expectation. */
      readonly plan: WorkspaceSearchMigrationFullVerificationPlan
      /** Complete durable predecessor progress. */
      readonly previousProgress:
        WorkspaceSearchMigrationFullVerificationProgress
      /** Source or target location advanced by this page. */
      readonly location:
        WorkspaceSearchMigrationCheckpointLocation
    },
  ): Promise<WorkspaceSearchMigrationFullVerificationProgress>
}

/**
 * Narrow strongly consistent and transactional DynamoDB transport.
 */
export interface WorkspaceSearchMigrationFullVerificationAwsTransport {
  /**
   * Strongly reads one adapter-owned state, receipt, or verified-root row.
   *
   * @param command - Adapter-owned strongly consistent point read.
   * @returns Raw low-level DynamoDB response.
   */
  getVerificationItem(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes all-six-table measured-incarnation preparation before commit.
   */
  prepareVerificationWrite(): Promise<void>

  /**
   * Sends one fixed-order verification transaction.
   *
   * @param command - Adapter-owned fixed-order transaction.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteVerification(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Static measured identity and narrow dependencies for one verification port.
 */
export type CreateWorkspaceSearchMigrationFullVerificationAwsPortInput = {
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
  /** Exact canonical closed application-writer fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh current-authority reader. */
  readonly authorityPort:
    WorkspaceSearchMigrationFullVerificationAuthorityPort
  /** Exact-version complete-plan replay gateway. */
  readonly planArtifactGateway:
    WorkspaceSearchMigrationFullVerificationPlanReplayGateway
  /** Exact-version complete apply-seal gateway. */
  readonly applySealGateway:
    WorkspaceSearchMigrationFullVerificationApplySealReader
  /** Exact-version immutable verification-result gateway. */
  readonly verificationResultGateway:
    WorkspaceSearchMigrationVerificationResultAwsGateway
  /** Strong immutable applied-root reader. */
  readonly appliedRootReader:
    WorkspaceSearchMigrationFullVerificationAppliedRootReader
  /** Strong one-page independent verification scanner. */
  readonly pageScanner:
    WorkspaceSearchMigrationFullVerificationPageScanner
  /** Narrow measured DynamoDB transport. */
  readonly transport:
    WorkspaceSearchMigrationFullVerificationAwsTransport
  /** Adapter-owned trusted clock. */
  readonly clock: WorkspaceSearchMigrationFullVerificationAwsClock
}

/**
 * Caller command for one independently scanned verification page.
 */
export type SaveWorkspaceSearchMigrationFullVerificationPageInput = {
  /** Exact current verification revision, zero before the first page. */
  readonly expectedRevision: number
  /** Exact active lease identity authorizing the transaction. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Source or target traversal advanced by this command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
}

/**
 * Caller command for immutable verified-root publication.
 */
export type PublishWorkspaceSearchMigrationFullVerificationInput = {
  /** Exact terminal verification-state revision. */
  readonly expectedRevision: number
  /** Exact active lease identity authorizing publication. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
}

/**
 * Atomic resumable verification and immutable publication capability.
 */
export interface WorkspaceSearchMigrationFullVerificationAwsPort {
  /**
   * Strongly reads the current resumable verification state.
   *
   * @returns Strict current state, or undefined before the first page.
   */
  readProgress():
    Promise<
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    >

  /**
   * Strongly reads the immutable authoritative verified root.
   *
   * @returns Strict verified root, or undefined before publication.
   */
  readVerifiedRoot():
    Promise<
      WorkspaceSearchMigrationFullVerificationVerifiedRoot | undefined
    >

  /**
   * Scans and atomically persists one exact verification page.
   *
   * @param input - Exact predecessor revision, lease, and location.
   * @returns Exact reconciled successor verification state.
   */
  saveVerificationPage(
    input: SaveWorkspaceSearchMigrationFullVerificationPageInput,
  ): Promise<WorkspaceSearchMigrationFullVerificationPersistenceState>

  /**
   * Publishes one immutable applied-root/result verified root.
   *
   * @param input - Exact terminal revision and active lease.
   * @returns Exact reconciled authoritative verified root.
   */
  publishVerified(
    input: PublishWorkspaceSearchMigrationFullVerificationInput,
  ): Promise<WorkspaceSearchMigrationFullVerificationVerifiedRoot>
}

/**
 * Detached static measured binding retained by the adapter.
 */
type FullVerificationBinding = {
  /** Complete detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact migration-state table identity. */
  readonly stateTable: MigrationTableIdentity
  /** All six exact physical table incarnations. */
  readonly tableIds:
    WorkspaceSearchMigrationFullVerificationTableIds
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact canonical closed writer-fence row. */
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
  /** Stable deterministic adapter row-addressing digest. */
  readonly recordBindingDigest: string
}

/**
 * Captured dependency methods immune to caller property replacement.
 */
type FullVerificationDependencies = {
  /** Fresh current-authority read. */
  readonly readAuthority: (lease: unknown) => Promise<unknown>
  /** Exact complete-plan artifact replay. */
  readonly replayPlan: (input: unknown) => Promise<unknown>
  /** Exact complete apply-seal replay. */
  readonly readApplySeal: (reference: unknown) => Promise<unknown>
  /** Immutable verification-result write. */
  readonly writeVerificationResult: (input: unknown) => Promise<unknown>
  /** Exact verification-result replay. */
  readonly replayVerificationResult:
    (reference: unknown) => Promise<unknown>
  /** Strong immutable applied-root read. */
  readonly readAppliedRoot: () => Promise<unknown>
  /** One-page strong verification scan. */
  readonly scanPage: (input: unknown) => Promise<unknown>
  /** Strong adapter-row read. */
  readonly get: (command: unknown) => Promise<unknown>
  /** Measured-incarnation preparation. */
  readonly prepare: () => Promise<void>
  /** Fixed-order transaction write. */
  readonly transact: (command: unknown) => Promise<unknown>
  /** Trusted clock returning a detached epoch millisecond. */
  readonly clock: () => number
}

/**
 * Lazily replayed exact plan and compact persistence binding.
 */
type PreparedVerificationPlan = {
  /** Exact detached complete plan replay. */
  readonly replay: WorkspaceSearchMigrationPlanArtifactReplayResult
  /** Plan-derived pure verification expectation. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
  /** Compact exact two-root plan-artifact binding. */
  readonly artifactBinding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
}

/**
 * Detached page command before the first asynchronous boundary.
 */
type PreparedPageCommand = {
  /** Exact predecessor revision. */
  readonly expectedRevision: number
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Exact location advanced by this command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
}

/**
 * Detached publication command before the first asynchronous boundary.
 */
type PreparedPublishCommand = {
  /** Exact terminal verification revision. */
  readonly expectedRevision: number
  /** Exact active lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
}

/**
 * Prepared exact verification transition material.
 */
type PreparedPageTransition = {
  /** Deterministic exact page command identity. */
  readonly identity:
    WorkspaceSearchMigrationFullVerificationPageCommandIdentity
  /** Exact predecessor root or state. */
  readonly predecessor:
    WorkspaceSearchMigrationFullVerificationPagePredecessor
  /** Exact successor state. */
  readonly state:
    WorkspaceSearchMigrationFullVerificationPersistenceState
  /** Exact immutable page receipt. */
  readonly receipt:
    WorkspaceSearchMigrationFullVerificationPageReceipt
  /** Complete predecessor durable state row, when one exists. */
  readonly predecessorRecord?:
    Readonly<Record<string, AttributeValue>>
}

/**
 * Strict state read retaining both semantic value and complete row.
 */
type DurableVerificationState = {
  /** Strict detached verification state. */
  readonly state:
    WorkspaceSearchMigrationFullVerificationPersistenceState
  /** Complete canonical low-level row. */
  readonly record: Readonly<Record<string, AttributeValue>>
}

/**
 * Strict receipt read retaining both semantic value and complete row.
 */
type DurableVerificationReceipt = {
  /** Strict detached immutable receipt. */
  readonly receipt:
    WorkspaceSearchMigrationFullVerificationPageReceipt
  /** Complete canonical low-level row. */
  readonly record: Readonly<Record<string, AttributeValue>>
}

/**
 * Strict root read retaining both semantic value and complete row.
 */
type DurableVerifiedRoot = {
  /** Strict detached immutable verified root. */
  readonly root:
    WorkspaceSearchMigrationFullVerificationVerifiedRoot
  /** Complete canonical low-level row. */
  readonly record: Readonly<Record<string, AttributeValue>>
}

/**
 * Private stable failure inside the full-verification AWS boundary.
 */
class FullVerificationAwsFailure extends Error {
  /** Secret-free operator-safe failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one raw-value-free private failure.
   *
   * @param code - Stable migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'FullVerificationAwsFailure'
    this.code = code
  }
}

/**
 * Constructs one measured resumable full-verification adapter.
 *
 * @param input - Measured immutable identity and narrow dependencies.
 * @returns Atomic verification state and verified publication capability.
 */
export function createAwsWorkspaceSearchMigrationFullVerificationPort(
  input: CreateWorkspaceSearchMigrationFullVerificationAwsPortInput,
): WorkspaceSearchMigrationFullVerificationAwsPort {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'appliedRootReader',
      'applySealGateway',
      'authorityPort',
      'clock',
      'closedWriterFenceRecord',
      'configuration',
      'configurationHash',
      'executionBoundary',
      'executionRun',
      'pageScanner',
      'planArtifactGateway',
      'sealedPlanningAuthority',
      'transport',
      'verificationResultGateway',
    ], 'INVALID_ARGUMENT')
    const binding = createFullVerificationBinding(
      readOwn(record, 'configuration', 'INVALID_ARGUMENT'),
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionBoundary', 'INVALID_ARGUMENT'),
      readOwn(record, 'sealedPlanningAuthority', 'INVALID_ARGUMENT'),
      readOwn(record, 'closedWriterFenceRecord', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
    )
    const dependencies = prepareDependencies(
      readOwn(record, 'authorityPort', 'INVALID_ARGUMENT'),
      readOwn(record, 'planArtifactGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'applySealGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'verificationResultGateway', 'INVALID_ARGUMENT'),
      readOwn(record, 'appliedRootReader', 'INVALID_ARGUMENT'),
      readOwn(record, 'pageScanner', 'INVALID_ARGUMENT'),
      readOwn(record, 'transport', 'INVALID_ARGUMENT'),
      readOwn(record, 'clock', 'INVALID_ARGUMENT'),
    )
    return new AwsWorkspaceSearchMigrationFullVerificationPort(
      binding,
      dependencies,
    )
  } catch (error: unknown) {
    throw createPublicFailure(readFailureCode(error, true))
  }
}

/**
 * Concrete resumable full-verification AWS adapter.
 */
class AwsWorkspaceSearchMigrationFullVerificationPort
implements WorkspaceSearchMigrationFullVerificationAwsPort {
  /** Detached exact static binding. */
  private readonly binding: FullVerificationBinding

  /** Captured narrow dependency methods. */
  private readonly dependencies: FullVerificationDependencies

  /** Single lazy exact plan replay shared by every method. */
  private planPromise?: Promise<PreparedVerificationPlan>

  /** Latest receipt-chain-validated state retained by this port instance. */
  private validatedState?:
    WorkspaceSearchMigrationFullVerificationPersistenceState

  /**
   * Creates one adapter from validated detached material.
   *
   * @param binding - Exact static verification binding.
   * @param dependencies - Captured dependency methods.
   */
  constructor(
    binding: FullVerificationBinding,
    dependencies: FullVerificationDependencies,
  ) {
    this.binding = binding
    this.dependencies = dependencies
  }

  /**
   * Strongly reads current verification progress.
   *
   * @returns Strict state or undefined.
   */
  async readProgress():
    Promise<
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
  > {
    return runVerificationBoundary(async () => {
      const [durable, preparedPlan, appliedRoot] =
        await Promise.all([
          this.readState(),
          this.getPreparedPlan(),
          this.requireAppliedRoot(),
        ])
      requireAppliedRootBinding(
        this.binding,
        preparedPlan,
        appliedRoot,
      )
      if (durable !== undefined) {
        await this.requireStateReceiptChain(
          durable.state,
          preparedPlan,
          appliedRoot,
          'authoritative-full',
        )
      }
      return durable?.state
    })
  }

  /**
   * Strongly reads the immutable verified root.
   *
   * @returns Strict root or undefined.
   */
  async readVerifiedRoot():
    Promise<
      WorkspaceSearchMigrationFullVerificationVerifiedRoot | undefined
  > {
    return runVerificationBoundary(async () => {
      const [durable, preparedPlan, appliedRoot, terminal] =
        await Promise.all([
          this.readRoot(),
          this.getPreparedPlan(),
          this.requireAppliedRoot(),
          this.readState(),
        ])
      requireAppliedRootBinding(
        this.binding,
        preparedPlan,
        appliedRoot,
      )
      if (durable === undefined) return undefined
      if (
        terminal === undefined ||
        terminal.state.stateDigest !==
          durable.root.terminalStateDigest
      ) {
        return failVerification('INVALID_STATE')
      }
      await this.requireStateReceiptChain(
        terminal.state,
        preparedPlan,
        appliedRoot,
        'authoritative-full',
      )
      const terminalReceipt = await this.requireTerminalReceipt(
        terminal.state,
      )
      const applySeal = readApplySealCandidate(
        await this.dependencies.readApplySeal(
          appliedRoot.sealReference,
        ),
      )
      requireExactApplySeal(appliedRoot, applySeal)
      const result =
        completeWorkspaceSearchMigrationFullVerification({
          plan: preparedPlan.plan,
          progress:
            decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
              terminal.state.progress,
            ),
          applySeal,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
        })
      await this.requireExistingRootResult(
        durable.root,
        preparedPlan,
        appliedRoot,
        terminal.state,
        terminalReceipt.receipt,
        result,
      )
      return durable.root
    })
  }

  /**
   * Scans and atomically persists one exact verification page.
   *
   * @param input - Exact predecessor revision, lease, and location.
   * @returns Exact reconciled successor state.
   */
  async saveVerificationPage(
    input: SaveWorkspaceSearchMigrationFullVerificationPageInput,
  ): Promise<WorkspaceSearchMigrationFullVerificationPersistenceState> {
    return runVerificationBoundary(async () => {
      const command = preparePageCommand(input)
      const [preparedPlan, appliedRoot, current] = await Promise.all([
        this.getPreparedPlan(),
        this.requireAppliedRoot(),
        this.readState(),
      ])
      requireAppliedRootBinding(
        this.binding,
        preparedPlan,
        appliedRoot,
      )
      if (current !== undefined) {
        await this.requireStateReceiptChain(
          current.state,
          preparedPlan,
          appliedRoot,
          'incremental-page-write',
        )
      }

      if (
        current !== undefined &&
        current.state.revision === command.expectedRevision + 1
      ) {
        return this.reconcilePriorPageRetry(
          command,
          preparedPlan,
          appliedRoot,
          current,
        )
      }
      requireExactPredecessorRevision(current, command.expectedRevision)

      const predecessorProgress = current === undefined
        ? createEmptyWorkspaceSearchMigrationFullVerificationProgress(
          preparedPlan.plan,
        )
        : decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
          current.state.progress,
        )
      const predecessorDigest = current === undefined
        ? appliedRoot.rootDigest
        : current.state.stateDigest
      const predecessor:
        WorkspaceSearchMigrationFullVerificationPagePredecessor =
          current === undefined
            ? {
                kind: 'applied-root',
                progress: predecessorProgress,
              }
            : {
                kind: 'verification-state',
                state: current.state,
              }
      const identity =
        createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
          planArtifactBinding: preparedPlan.artifactBinding,
          tableIds: this.binding.tableIds,
          appliedRootDigest: appliedRoot.rootDigest,
          location: command.location,
          expectedRevision: command.expectedRevision,
          predecessorDigest,
          predecessorProgress,
        })
      if (await this.readReceipt(identity.commandDigest) !== undefined) {
        return failVerification('INVALID_STATE')
      }
      const successorProgress = readProgressCandidate(
        await this.dependencies.scanPage({
          plan: preparedPlan.plan,
          previousProgress: predecessorProgress,
          location: command.location,
        }),
      )
      const state =
        createWorkspaceSearchMigrationFullVerificationPersistenceState({
          planArtifactBinding: preparedPlan.artifactBinding,
          tableIds: this.binding.tableIds,
          appliedRootDigest: appliedRoot.rootDigest,
          revision: command.expectedRevision + 1,
          predecessorKind: predecessor.kind,
          predecessorDigest,
          lastCommandDigest: identity.commandDigest,
          progress: successorProgress,
        })

      await this.dependencies.prepare()
      const authority = readAuthorityCandidate(
        await this.dependencies.readAuthority(command.lease),
      )
      requireAuthority(this.binding, command.lease, authority)
      const transactionAt = readClock(this.dependencies.clock)
      if (transactionAt < Date.parse(authority.evaluatedAt)) {
        return failVerification('INVALID_STATE')
      }
      const transactionTime = new Date(transactionAt)
      const receipt =
        createWorkspaceSearchMigrationFullVerificationPageReceipt({
          commandIdentity: identity,
          predecessor,
          successorState: state,
          committedAt: transactionTime.toISOString(),
        })
      const transition: PreparedPageTransition = {
        identity,
        predecessor,
        state,
        receipt,
        ...(current === undefined
          ? {}
          : { predecessorRecord: current.record }),
      }
      const transaction = createPageTransaction(
        this.binding,
        appliedRoot,
        authority,
        transactionTime,
        transition,
      )
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        preserveManagedAmbiguousFailure(error)
        const reconciled = await this.reconcileExactPage(transition)
        if (reconciled !== undefined) return reconciled
        throw new FullVerificationAwsFailure(
          classifyTransactionError(error, 'page'),
        )
      }
      const reconciled = await this.reconcileExactPage(transition)
      if (reconciled === undefined) {
        return failVerification('INVALID_STATE')
      }
      return reconciled
    })
  }

  /**
   * Publishes one immutable successful full-verification root.
   *
   * @param input - Exact terminal revision and active lease.
   * @returns Exact reconciled verified root.
   */
  async publishVerified(
    input: PublishWorkspaceSearchMigrationFullVerificationInput,
  ): Promise<WorkspaceSearchMigrationFullVerificationVerifiedRoot> {
    return runVerificationBoundary(async () => {
      const command = preparePublishCommand(input)
      const [preparedPlan, appliedRoot, terminal] = await Promise.all([
        this.getPreparedPlan(),
        this.requireAppliedRoot(),
        this.readState(),
      ])
      requireAppliedRootBinding(
        this.binding,
        preparedPlan,
        appliedRoot,
      )
      if (
        terminal === undefined ||
        terminal.state.revision !== command.expectedRevision
      ) {
        return failVerification('INVALID_STATE')
      }
      await this.requireStateReceiptChain(
        terminal.state,
        preparedPlan,
        appliedRoot,
        'authoritative-full',
      )
      const terminalReceipt = await this.requireTerminalReceipt(
        terminal.state,
      )
      const applySeal = readApplySealCandidate(
        await this.dependencies.readApplySeal(
          appliedRoot.sealReference,
        ),
      )
      requireExactApplySeal(appliedRoot, applySeal)
      const verificationResult =
        completeWorkspaceSearchMigrationFullVerification({
          plan: preparedPlan.plan,
          progress:
            decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
              terminal.state.progress,
            ),
          applySeal,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
        })

      const existing = await this.readRoot()
      if (existing !== undefined) {
        await this.requireExistingRootResult(
          existing.root,
          preparedPlan,
          appliedRoot,
          terminal.state,
          terminalReceipt.receipt,
          verificationResult,
        )
        return existing.root
      }

      const richReference = readResultReferenceCandidate(
        await this.dependencies.writeVerificationResult({
          verificationResult,
          retainUntil: appliedRoot.sealReference.retainUntil,
        }),
      )
      await this.requireExactResultArtifact(
        richReference,
        verificationResult,
        appliedRoot.rootDigest,
      )
      const authority = readAuthorityCandidate(
        await this.dependencies.readAuthority(command.lease),
      )
      requireAuthority(this.binding, command.lease, authority)
      await this.dependencies.prepare()
      const verifiedAtMilliseconds = readClock(this.dependencies.clock)
      if (verifiedAtMilliseconds < Date.parse(authority.evaluatedAt)) {
        return failVerification('INVALID_STATE')
      }
      const sharedRetainUntil =
        appliedRoot.sealReference.retainUntil
      if (
        richReference.retainUntil !== sharedRetainUntil ||
        appliedRoot.seal.planSealReference.retainUntil !==
          sharedRetainUntil ||
        preparedPlan.artifactBinding.planSealReference.retainUntil !==
          sharedRetainUntil ||
        preparedPlan.artifactBinding.planManifestHeadReference
          .retainUntil !== sharedRetainUntil ||
        Date.parse(sharedRetainUntil) - verifiedAtMilliseconds <
          WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
      ) {
        return failVerification('INVALID_STATE')
      }
      const verifiedAt = new Date(verifiedAtMilliseconds).toISOString()
      const publicationAuthority:
        WorkspaceSearchMigrationFullVerificationPublicationAuthority = {
          ownerId: authority.lease.ownerId,
          fenceToken: authority.lease.fenceToken,
          maintenanceEvidencePointerRevision:
            authority.maintenanceEvidencePointerRevision,
          maintenanceEvidenceReceiptDigest:
            authority.maintenanceEvidenceReceiptDigest,
          evaluatedAt: authority.evaluatedAt,
        }
      const root =
        createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
          planArtifactBinding: preparedPlan.artifactBinding,
          tableIds: this.binding.tableIds,
          appliedRootDigest: appliedRoot.rootDigest,
          verificationResult,
          verificationResultReference: richReference,
          terminalState: terminal.state,
          terminalReceipt: terminalReceipt.receipt,
          sealedPlanningAuthorityDigest:
            this.binding.sealedPlanningAuthority.authorityDigest,
          publicationAuthority,
          verifiedAt,
        })
      const transaction = createPublishTransaction(
        this.binding,
        appliedRoot,
        authority,
        new Date(verifiedAtMilliseconds),
        terminal,
        root,
      )
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        preserveManagedAmbiguousFailure(error)
        const reconciled = await this.reconcileExactPublication(
          root,
          richReference,
          verificationResult,
          appliedRoot.rootDigest,
        )
        if (reconciled !== undefined) return reconciled
        throw new FullVerificationAwsFailure(
          classifyTransactionError(error, 'publish'),
        )
      }
      const reconciled = await this.reconcileExactPublication(
        root,
        richReference,
        verificationResult,
        appliedRoot.rootDigest,
      )
      if (reconciled === undefined) {
        return failVerification('INVALID_STATE')
      }
      return reconciled
    })
  }

  /**
   * Returns the single lazy exact plan replay.
   *
   * @returns Prepared plan and compact artifact binding.
   */
  private getPreparedPlan(): Promise<PreparedVerificationPlan> {
    if (this.planPromise === undefined) {
      this.planPromise = this.loadPreparedPlan()
    }
    return this.planPromise
  }

  /**
   * Replays both exact plan roots and derives the pure plan once.
   *
   * @returns Prepared exact replay and verification expectation.
   */
  private async loadPreparedPlan(): Promise<PreparedVerificationPlan> {
    const authority = this.binding.sealedPlanningAuthority
    const replay = readPlanReplayCandidate(
      await this.dependencies.replayPlan({
        planSealReference: authority.planSealReference,
        manifestHeadReference: authority.planManifestHeadReference,
      }),
    )
    let plan: WorkspaceSearchMigrationFullVerificationPlan
    try {
      plan = createWorkspaceSearchMigrationFullVerificationPlan({
        planSeal: replay.planSeal,
        operations: replay.operations,
      })
    } catch {
      return failVerification('INVALID_STATE')
    }
    if (
      plan.runId !== authority.runId ||
      plan.configurationHash !== authority.configurationHash ||
      plan.planDigest !== authority.planDigest ||
      plan.planSealContentDigest !==
        authority.planSealReference.contentDigest ||
      plan.planOperationCount !== authority.planOperationCount ||
      plan.sourceOperationCount !== authority.sourceOperationCount ||
      plan.orphanOperationCount !== authority.orphanOperationCount
    ) {
      return failVerification('INVALID_STATE')
    }
    const artifactBinding =
      createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
        runId: authority.runId,
        configurationHash: authority.configurationHash,
        planDigest: authority.planDigest,
        verificationPlanDigest: plan.verificationPlanDigest,
        sealedPlanningAuthorityDigest: authority.authorityDigest,
        planSealReference:
          toPlanArtifactReference(authority.planSealReference),
        planManifestHeadReference:
          toPlanArtifactReference(
            authority.planManifestHeadReference,
          ),
      })
    return { replay, plan, artifactBinding }
  }

  /**
   * Reads and requires the immutable applied root.
   *
   * @returns Exact strict applied root.
   */
  private async requireAppliedRoot():
    Promise<WorkspaceSearchMigrationAppliedRoot> {
    const candidate = await this.dependencies.readAppliedRoot()
    const root = candidate === undefined
      ? undefined
      : readAppliedRootCandidate(candidate)
    if (root === undefined) {
      return failVerification('INVALID_STATE')
    }
    return root
  }

  /**
   * Strongly reads the deterministic current state row.
   *
   * @returns Strict durable state or undefined.
   */
  private async readState():
    Promise<DurableVerificationState | undefined> {
    const output = await this.dependencies.get(
      createStrongReadCommand(
        this.binding,
        createVerificationStateRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseVerificationStateRecord(this.binding, item)
  }

  /**
   * Strongly reads one deterministic page receipt.
   *
   * @param commandDigest - Exact page-command digest.
   * @returns Strict durable receipt or undefined.
   */
  private async readReceipt(
    commandDigest: string,
  ): Promise<DurableVerificationReceipt | undefined> {
    const output = await this.dependencies.get(
      createStrongReadCommand(
        this.binding,
        createVerificationReceiptRecordKey(
          this.binding,
          commandDigest,
        ),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseVerificationReceiptRecord(this.binding, item)
  }

  /**
   * Strongly reads the deterministic immutable verified root.
   *
   * @returns Strict durable root or undefined.
   */
  private async readRoot(): Promise<DurableVerifiedRoot | undefined> {
    const output = await this.dependencies.get(
      createStrongReadCommand(
        this.binding,
        createVerifiedRootRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseVerifiedRootRecord(this.binding, item)
  }

  /**
   * Reconciles an immediately retried already-committed page.
   *
   * @param command - Exact caller retry.
   * @param preparedPlan - Exact lazy plan.
   * @param appliedRoot - Exact immutable applied root.
   * @param current - Current successor state.
   * @returns Exact current state when its receipt proves this retry.
   */
  private async reconcilePriorPageRetry(
    command: PreparedPageCommand,
    preparedPlan: PreparedVerificationPlan,
    appliedRoot: WorkspaceSearchMigrationAppliedRoot,
    current: DurableVerificationState,
  ): Promise<WorkspaceSearchMigrationFullVerificationPersistenceState> {
    const receipt = await this.readReceipt(
      current.state.lastCommandDigest,
    )
    if (receipt === undefined) {
      return failVerification('INVALID_STATE')
    }
    const candidate = receipt.receipt
    if (
      candidate.location !== command.location ||
      candidate.predecessorRevision !== command.expectedRevision ||
      candidate.successorRevision !== current.state.revision ||
      candidate.successorStateDigest !== current.state.stateDigest ||
      candidate.appliedRootDigest !== appliedRoot.rootDigest ||
      candidate.planArtifactBindingDigest !==
        preparedPlan.artifactBinding.bindingDigest ||
      candidate.verificationPlanDigest !==
        preparedPlan.plan.verificationPlanDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    const identity =
      createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
        planArtifactBinding: preparedPlan.artifactBinding,
        tableIds: this.binding.tableIds,
        appliedRootDigest: appliedRoot.rootDigest,
        location: command.location,
        expectedRevision: command.expectedRevision,
        predecessorDigest: candidate.predecessorDigest,
        predecessorProgress:
          decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
            candidate.predecessorProgress,
          ),
      })
    if (
      identity.commandDigest !== candidate.commandDigest ||
      identity.commandDigest !== current.state.lastCommandDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    this.validatedState = current.state
    return current.state
  }

  /**
   * Strongly reconciles both state and receipt after a transaction response.
   *
   * @param transition - Exact expected transition.
   * @returns Exact state, or undefined only when both rows are absent.
   */
  private async reconcileExactPage(
    transition: PreparedPageTransition,
  ): Promise<
    WorkspaceSearchMigrationFullVerificationPersistenceState | undefined
  > {
    const [state, receipt] = await Promise.all([
      this.readState(),
      this.readReceipt(transition.identity.commandDigest),
    ])
    if (state === undefined && receipt === undefined) return undefined
    if (
      state === undefined ||
      receipt === undefined ||
      state.state.stateDigest !== transition.state.stateDigest ||
      receipt.receipt.receiptDigest !==
        transition.receipt.receiptDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    this.validatedState = state.state
    return state.state
  }

  /**
   * Reads and validates the receipt that created the terminal state.
   *
   * @param terminal - Exact terminal durable state.
   * @returns Exact terminal receipt and row.
   */
  private async requireTerminalReceipt(
    terminal:
      WorkspaceSearchMigrationFullVerificationPersistenceState,
  ): Promise<DurableVerificationReceipt> {
    const receipt = await this.readReceipt(terminal.lastCommandDigest)
    if (
      receipt === undefined ||
      receipt.receipt.successorRevision !== terminal.revision ||
      receipt.receipt.successorStateDigest !== terminal.stateDigest ||
      receipt.receipt.successorProgressDigest !==
        terminal.progressDigest ||
      receipt.receipt.commandDigest !== terminal.lastCommandDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    return receipt
  }

  /**
   * Validates every immutable receipt from the applied root to one state.
   *
   * The latest already-validated in-memory state is used as a safe incremental
   * predecessor; a fresh port walks the complete predecessor-command chain.
   *
   * @param terminal - Candidate current or terminal state.
   * @param preparedPlan - Exact lazy plan and compact artifact binding.
   * @param appliedRoot - Exact immutable applied root.
   * @param mode - Full authoritative reread or page-write-only cache mode.
   */
  private async requireStateReceiptChain(
    terminal:
      WorkspaceSearchMigrationFullVerificationPersistenceState,
    preparedPlan: PreparedVerificationPlan,
    appliedRoot: WorkspaceSearchMigrationAppliedRoot,
    mode: 'authoritative-full' | 'incremental-page-write',
  ): Promise<void> {
    if (
      mode === 'incremental-page-write' &&
      this.validatedState?.stateDigest === terminal.stateDigest
    ) {
      return
    }
    if (
      mode === 'incremental-page-write' &&
      this.validatedState !== undefined &&
      terminal.revision === this.validatedState.revision + 1 &&
      terminal.predecessorKind === 'verification-state' &&
      terminal.predecessorDigest === this.validatedState.stateDigest
    ) {
      const receipt = await this.requireTerminalReceipt(terminal)
      validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition(
        receipt.receipt,
        {
          kind: 'verification-state',
          state: this.validatedState,
        },
        terminal,
      )
      this.validatedState = terminal
      return
    }

    const reverseReceipts:
      WorkspaceSearchMigrationFullVerificationPageReceipt[] = []
    let commandDigest: string | null = terminal.lastCommandDigest
    let expectedSuccessorDigest = terminal.stateDigest
    let remaining = terminal.revision
    while (commandDigest !== null && remaining > 0) {
      const durable = await this.readReceipt(commandDigest)
      if (
        durable === undefined ||
        durable.receipt.successorStateDigest !==
          expectedSuccessorDigest ||
        durable.receipt.successorRevision !== remaining
      ) {
        return failVerification('INVALID_STATE')
      }
      reverseReceipts.push(durable.receipt)
      expectedSuccessorDigest = durable.receipt.predecessorDigest
      commandDigest = durable.receipt.predecessorCommandDigest
      remaining -= 1
    }
    if (
      remaining !== 0 ||
      commandDigest !== null ||
      expectedSuccessorDigest !== appliedRoot.rootDigest ||
      reverseReceipts.length !== terminal.revision
    ) {
      return failVerification('INVALID_STATE')
    }

    let predecessor:
      WorkspaceSearchMigrationFullVerificationPagePredecessor = {
        kind: 'applied-root',
        progress:
          createEmptyWorkspaceSearchMigrationFullVerificationProgress(
            preparedPlan.plan,
          ),
      }
    let reconstructed:
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    for (
      let index = reverseReceipts.length - 1;
      index >= 0;
      index -= 1
    ) {
      const receipt = reverseReceipts[index]
      if (receipt === undefined) {
        return failVerification('INVALID_STATE')
      }
      const predecessorProgress = predecessor.kind === 'applied-root'
        ? predecessor.progress
        : decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
          predecessor.state.progress,
        )
      const identity =
        createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
          planArtifactBinding: preparedPlan.artifactBinding,
          tableIds: this.binding.tableIds,
          appliedRootDigest: appliedRoot.rootDigest,
          location: receipt.location,
          expectedRevision: receipt.predecessorRevision,
          predecessorDigest: receipt.predecessorDigest,
          predecessorProgress,
        })
      if (identity.commandDigest !== receipt.commandDigest) {
        return failVerification('INVALID_STATE')
      }
      reconstructed =
        createWorkspaceSearchMigrationFullVerificationPersistenceState({
          planArtifactBinding: preparedPlan.artifactBinding,
          tableIds: this.binding.tableIds,
          appliedRootDigest: appliedRoot.rootDigest,
          revision: receipt.successorRevision,
          predecessorKind: receipt.predecessorKind,
          predecessorDigest: receipt.predecessorDigest,
          lastCommandDigest: receipt.commandDigest,
          progress:
            decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
              receipt.successorProgress,
            ),
        })
      validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition(
        receipt,
        predecessor,
        reconstructed,
      )
      predecessor = {
        kind: 'verification-state',
        state: reconstructed,
      }
    }
    if (
      reconstructed === undefined ||
      reconstructed.stateDigest !== terminal.stateDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    this.validatedState = terminal
  }

  /**
   * Reconciles a known expected root and exact result artifact.
   *
   * @param expectedRoot - Exact root expected from this publication.
   * @param reference - Exact rich result reference.
   * @param result - Exact semantic result.
   * @param appliedRootDigest - Exact immutable applied-root digest.
   * @returns Exact root, or undefined only when the root row is absent.
   */
  private async reconcileExactPublication(
    expectedRoot:
      WorkspaceSearchMigrationFullVerificationVerifiedRoot,
    reference:
      WorkspaceSearchMigrationVerificationResultArtifactReference,
    result: WorkspaceSearchMigrationFullVerificationResult,
    appliedRootDigest: string,
  ): Promise<
    WorkspaceSearchMigrationFullVerificationVerifiedRoot | undefined
  > {
    const root = await this.readRoot()
    if (root === undefined) return undefined
    if (
      root.root.verifiedRootDigest !== expectedRoot.verifiedRootDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    await this.requireExactResultArtifact(
      reference,
      result,
      appliedRootDigest,
    )
    return root.root
  }

  /**
   * Validates an already-published root and its exact immutable result.
   *
   * @param root - Existing strict verified root.
   * @param preparedPlan - Exact lazy plan binding.
   * @param appliedRoot - Exact immutable applied root.
   * @param terminalState - Exact current terminal state.
   * @param terminalReceipt - Exact terminal receipt.
   * @param result - Exact recomputed pure result.
   */
  private async requireExistingRootResult(
    root: WorkspaceSearchMigrationFullVerificationVerifiedRoot,
    preparedPlan: PreparedVerificationPlan,
    appliedRoot: WorkspaceSearchMigrationAppliedRoot,
    terminalState:
      WorkspaceSearchMigrationFullVerificationPersistenceState,
    terminalReceipt:
      WorkspaceSearchMigrationFullVerificationPageReceipt,
    result: WorkspaceSearchMigrationFullVerificationResult,
  ): Promise<void> {
    if (
      root.appliedRootDigest !== appliedRoot.rootDigest ||
      root.verificationResultDigest !== result.resultDigest ||
      root.terminalStateDigest !== terminalState.stateDigest ||
      root.terminalReceiptDigest !== terminalReceipt.receiptDigest ||
      root.terminalReceiptCommittedAt !== terminalReceipt.committedAt ||
      root.planArtifactBinding.bindingDigest !==
        preparedPlan.artifactBinding.bindingDigest ||
      root.sealedPlanningAuthorityDigest !==
        this.binding.sealedPlanningAuthority.authorityDigest
    ) {
      return failVerification('INVALID_STATE')
    }
    const reference = createRichResultReference(
      root.verificationResultReference,
      result,
      appliedRoot.rootDigest,
      this.binding,
    )
    await this.requireExactResultArtifact(
      reference,
      result,
      appliedRoot.rootDigest,
    )
  }

  /**
   * Replays and verifies one exact rich result artifact.
   *
   * @param reference - Exact rich immutable result reference.
   * @param result - Exact recomputed semantic result.
   * @param appliedRootDigest - Exact immutable applied root digest.
   */
  private async requireExactResultArtifact(
    reference:
      WorkspaceSearchMigrationVerificationResultArtifactReference,
    result: WorkspaceSearchMigrationFullVerificationResult,
    appliedRootDigest: string,
  ): Promise<void> {
    const artifact = readResultArtifactCandidate(
      await this.dependencies.replayVerificationResult(reference),
    )
    requireExactVerificationResultArtifact(
      artifact,
      reference,
      result,
      appliedRootDigest,
      this.binding,
    )
  }
}

/**
 * Creates and cross-checks the complete static verification binding.
 *
 * @param configurationValue - Candidate measured configuration.
 * @param configurationHashValue - Candidate reviewed configuration digest.
 * @param executionBoundaryValue - Candidate admitted boundary.
 * @param sealedAuthorityValue - Candidate sealed planning authority.
 * @param closedFenceValue - Candidate exact closed writer fence.
 * @param executionRunValue - Candidate immutable execution admission.
 * @returns Detached exact static binding.
 */
function createFullVerificationBinding(
  configurationValue: unknown,
  configurationHashValue: unknown,
  executionBoundaryValue: unknown,
  sealedAuthorityValue: unknown,
  closedFenceValue: unknown,
  executionRunValue: unknown,
): FullVerificationBinding {
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
    return failVerification('CONFIGURATION_HASH_MISMATCH')
  }
  const executionBoundary = detachExecutionBoundary(
    executionBoundaryValue,
  )
  const sealedPlanningAuthority = detachSealedAuthority(
    sealedAuthorityValue,
  )
  const closedWriterFenceRecord = detachClosedFence(
    closedFenceValue,
  )
  const executionRun = detachExecutionRun(executionRunValue)
  const stateTable = configuration.tables['migration-state']
  const tableIds = createTableIds(configuration)
  requireTableIds(tableIds, executionBoundary.tableIds)
  requireTableIds(tableIds, sealedPlanningAuthority.tableIds)
  requireTableIds(tableIds, executionRun.binding.tableIds)
  requireTableIds(tableIds, closedWriterFenceRecord.binding.tableIds)
  const writerFence = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        {
          role: 'migration-state',
          tableName: stateTable.tableName,
          tableArn: stateTable.tableArn,
          tableId: stateTable.tableId,
          creationTime: stateTable.creationTime,
          account: stateTable.account,
          region: stateTable.region,
        },
      ),
    tableIds,
  })
  if (
    executionBoundary.phase !== 'planning-admitted' ||
    executionBoundary.runId !== sealedPlanningAuthority.runId ||
    executionBoundary.runId !== executionRun.runId ||
    executionBoundary.runId !==
      closedWriterFenceRecord.authority.runId ||
    executionBoundary.configurationHash !== configurationHash ||
    sealedPlanningAuthority.configurationHash !== configurationHash ||
    executionRun.configurationHash !== configurationHash ||
    closedWriterFenceRecord.authority.configurationHash !==
      configurationHash ||
    executionBoundary.closedWriterFenceRecordDigest !==
      closedWriterFenceRecord.recordDigest ||
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
    digestValue(executionRun.binding.planSealReference) !==
      digestValue(sealedPlanningAuthority.planSealReference) ||
    digestValue(closedWriterFenceRecord.binding) !==
      digestValue(writerFence)
  ) {
    return failVerification('CONFIGURATION_DRIFT')
  }
  const recordBindingDigest = createMigrationDigest({
    kind: 'workspace-search-full-verification-run-binding',
    version: verificationRecordVersion,
    stateTableId: stateTable.tableId,
    configurationHash,
    runId: executionRun.runId,
    executionRunDigest: executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      sealedPlanningAuthority.authorityDigest,
  })
  return {
    configuration,
    configurationHash,
    stateTable,
    tableIds,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    recordBindingDigest,
  }
}

/**
 * Captures every dependency method as an own enumerable data property.
 *
 * @param authorityPort - Candidate current-authority port.
 * @param planGateway - Candidate exact plan gateway.
 * @param applySealGateway - Candidate exact apply-seal gateway.
 * @param resultGateway - Candidate exact result gateway.
 * @param appliedRootReader - Candidate applied-root reader.
 * @param pageScanner - Candidate one-page scanner.
 * @param transport - Candidate DynamoDB transport.
 * @param clock - Candidate trusted clock.
 * @returns Captured descriptor-safe dependency methods.
 */
function prepareDependencies(
  authorityPort: unknown,
  planGateway: unknown,
  applySealGateway: unknown,
  resultGateway: unknown,
  appliedRootReader: unknown,
  pageScanner: unknown,
  transport: unknown,
  clock: unknown,
): FullVerificationDependencies {
  return {
    readAuthority: captureOneArgumentMethod(
      authorityPort,
      'readAuthority',
    ),
    replayPlan: captureOneArgumentMethod(
      planGateway,
      'replayPlanArtifact',
    ),
    readApplySeal: captureOneArgumentMethod(
      applySealGateway,
      'readCompleteApplySeal',
    ),
    writeVerificationResult: captureOneArgumentMethod(
      resultGateway,
      'writeVerificationResultArtifact',
    ),
    replayVerificationResult: captureOneArgumentMethod(
      resultGateway,
      'replayVerificationResultArtifact',
    ),
    readAppliedRoot: captureZeroArgumentMethod(
      appliedRootReader,
      'readAppliedRoot',
    ),
    scanPage: captureOneArgumentMethod(
      pageScanner,
      'scanVerificationPage',
    ),
    get: captureOneArgumentMethod(
      transport,
      'getVerificationItem',
    ),
    prepare: captureVoidMethod(
      transport,
      'prepareVerificationWrite',
    ),
    transact: captureOneArgumentMethod(
      transport,
      'transactWriteVerification',
    ),
    clock: snapshotClock(clock),
  }
}

/**
 * Captures one descriptor-safe zero-argument asynchronous method.
 *
 * @param ownerValue - Candidate method owner.
 * @param name - Required own method name.
 * @returns Captured invocation closure.
 */
function captureZeroArgumentMethod(
  ownerValue: unknown,
  name: string,
): () => Promise<unknown> {
  const owner = requirePlainRecord(ownerValue, 'INVALID_ARGUMENT')
  const method = readOwn(owner, name, 'INVALID_ARGUMENT')
  if (typeof method !== 'function') {
    return failVerification('INVALID_ARGUMENT')
  }
  return async () => await Reflect.apply(method, owner, [])
}

/**
 * Captures one descriptor-safe zero-argument asynchronous void method.
 *
 * @param ownerValue - Candidate method owner.
 * @param name - Required own method name.
 * @returns Captured invocation closure.
 */
function captureVoidMethod(
  ownerValue: unknown,
  name: string,
): () => Promise<void> {
  const captured = captureZeroArgumentMethod(ownerValue, name)
  return async () => {
    await captured()
  }
}

/**
 * Captures one descriptor-safe one-argument asynchronous method.
 *
 * @param ownerValue - Candidate method owner.
 * @param name - Required own method name.
 * @returns Captured invocation closure.
 */
function captureOneArgumentMethod(
  ownerValue: unknown,
  name: string,
): (input: unknown) => Promise<unknown> {
  const owner = requirePlainRecord(ownerValue, 'INVALID_ARGUMENT')
  const method = readOwn(owner, name, 'INVALID_ARGUMENT')
  if (typeof method !== 'function') {
    return failVerification('INVALID_ARGUMENT')
  }
  return async (input) =>
    await Reflect.apply(method, owner, [input])
}

/**
 * Captures a trusted Date clock without retaining mutable owner state.
 *
 * @param value - Candidate zero-argument clock.
 * @returns Epoch-millisecond clock with strict Date validation.
 */
function snapshotClock(value: unknown): () => number {
  if (typeof value !== 'function') {
    return failVerification('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(value, undefined, [])
    if (
      nodeUtilTypes.isProxy(candidate) ||
      !nodeUtilTypes.isDate(candidate)
    ) {
      return failVerification('INVALID_STATE')
    }
    const milliseconds = candidate.getTime()
    if (!Number.isFinite(milliseconds)) {
      return failVerification('INVALID_STATE')
    }
    return milliseconds
  }
}

/**
 * Creates detached all-role table identifiers from measured configuration.
 *
 * @param configuration - Exact measured migration configuration.
 * @returns All six exact physical TableIds.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationFullVerificationTableIds {
  return {
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Requires two complete table-incarnation maps to match exactly.
 *
 * @param expected - Independently measured TableIds.
 * @param candidate - Candidate immutable authority TableIds.
 */
function requireTableIds(
  expected: WorkspaceSearchMigrationFullVerificationTableIds,
  candidate: WorkspaceSearchMigrationFullVerificationTableIds,
): void {
  for (const role of tableRoles) {
    if (candidate[role] !== expected[role]) {
      return failVerification('CONFIGURATION_DRIFT')
    }
  }
}

/**
 * Detaches one strict planning-admitted execution boundary.
 *
 * @param value - Candidate boundary.
 * @returns Strict detached boundary.
 */
function detachExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (!isExecutionBoundaryCandidate(value)) {
    return failVerification('INVALID_ARGUMENT')
  }
  const boundary = parseWorkspaceSearchMigrationExecutionBoundary(
    serializeWorkspaceSearchMigrationExecutionBoundary(value),
  )
  if (boundary.phase !== 'planning-admitted') {
    return failVerification('INVALID_ARGUMENT')
  }
  return boundary
}

/**
 * Narrows one candidate enough for the strict boundary codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the candidate is an ordinary boundary record.
 */
function isExecutionBoundaryCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return isPlainRecord(value)
}

/**
 * Detaches one strict sealed planning authority.
 *
 * @param value - Candidate authority.
 * @returns Strict detached version-two authority.
 */
function detachSealedAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedAuthorityCandidate(value)) {
    return failVerification('INVALID_ARGUMENT')
  }
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(value),
  )
}

/**
 * Narrows one candidate enough for the strict authority codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the candidate is an ordinary authority record.
 */
function isSealedAuthorityCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isPlainRecord(value)
}

/**
 * Detaches one strict immutable execution admission.
 *
 * @param value - Candidate execution run.
 * @returns Strict detached execution run.
 */
function detachExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRunCandidate(value)) {
    return failVerification('INVALID_ARGUMENT')
  }
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(value),
  )
}

/**
 * Narrows one candidate enough for the strict execution-run codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the candidate is an ordinary execution-run record.
 */
function isExecutionRunCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isPlainRecord(value)
}

/**
 * Detaches one strict closed writer-fence record.
 *
 * @param value - Candidate closed record.
 * @returns Strict detached closed record.
 */
function detachClosedFence(
  value: unknown,
): WorkspaceSearchWriterFenceClosedRecord {
  if (!isClosedFenceCandidate(value)) {
    return failVerification('INVALID_ARGUMENT')
  }
  return readWorkspaceSearchWriterFenceClosedRecord(value)
}

/**
 * Narrows one candidate enough for the strict writer-fence reader.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the candidate is an ordinary record.
 */
function isClosedFenceCandidate(
  value: unknown,
): value is WorkspaceSearchWriterFenceClosedRecord {
  return isPlainRecord(value)
}

/**
 * Detaches one verification-page caller command.
 *
 * @param value - Candidate command.
 * @returns Strict detached command.
 */
function preparePageCommand(
  value: SaveWorkspaceSearchMigrationFullVerificationPageInput,
): PreparedPageCommand {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'expectedRevision',
    'lease',
    'location',
  ], 'INVALID_ARGUMENT')
  return {
    expectedRevision: readNonNegativeSafeInteger(
      readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    lease: readLeaseClaim(
      readOwn(record, 'lease', 'INVALID_ARGUMENT'),
    ),
    location: readLocation(
      readOwn(record, 'location', 'INVALID_ARGUMENT'),
    ),
  }
}

/**
 * Detaches one verified-publication caller command.
 *
 * @param value - Candidate command.
 * @returns Strict detached command.
 */
function preparePublishCommand(
  value: PublishWorkspaceSearchMigrationFullVerificationInput,
): PreparedPublishCommand {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'expectedRevision',
    'lease',
  ], 'INVALID_ARGUMENT')
  return {
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    lease: readLeaseClaim(
      readOwn(record, 'lease', 'INVALID_ARGUMENT'),
    ),
  }
}

/**
 * Detaches one exact caller lease claim.
 *
 * @param value - Candidate lease claim.
 * @returns Strict detached lease identity.
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
 * Reads one exact source-or-target checkpoint location.
 *
 * @param value - Candidate location.
 * @returns Strict supported location.
 */
function readLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'target'
  ) {
    return value
  }
  return failVerification('INVALID_ARGUMENT')
}

/**
 * Requires the caller revision to name the exact current predecessor.
 *
 * @param current - Current durable verification state.
 * @param expectedRevision - Caller predecessor revision.
 */
function requireExactPredecessorRevision(
  current: DurableVerificationState | undefined,
  expectedRevision: number,
): void {
  if (
    (
      current === undefined &&
      expectedRevision !== 0
    ) ||
    (
      current !== undefined &&
      current.state.revision !== expectedRevision
    )
  ) {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Requires one applied root to remain exactly bound to this plan and admission.
 *
 * @param binding - Exact adapter static binding.
 * @param preparedPlan - Exact lazy plan replay.
 * @param root - Candidate immutable applied root.
 */
function requireAppliedRootBinding(
  binding: FullVerificationBinding,
  preparedPlan: PreparedVerificationPlan,
  root: WorkspaceSearchMigrationAppliedRoot,
): void {
  const authority = binding.sealedPlanningAuthority
  if (
    root.stateTableId !== binding.stateTable.tableId ||
    root.configurationHash !== binding.configurationHash ||
    root.runId !== binding.executionRun.runId ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.status !== 'applied' ||
    root.seal.runId !== binding.executionRun.runId ||
    root.seal.configurationHash !== binding.configurationHash ||
    root.seal.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.seal.sealedPlanningAuthorityDigest !==
      authority.authorityDigest ||
    root.seal.planDigest !== preparedPlan.plan.planDigest ||
    root.seal.planOperationCount !==
      preparedPlan.plan.planOperationCount ||
    root.seal.sourceOperationCount !==
      preparedPlan.plan.sourceOperationCount ||
    root.seal.orphanOperationCount !==
      preparedPlan.plan.orphanOperationCount ||
    digestValue(root.seal.planSealReference) !==
      digestValue(authority.planSealReference)
  ) {
    return failVerification('INVALID_STATE')
  }
  requireTableIds(binding.tableIds, root.seal.tableIds)
}

/**
 * Requires one fresh authority to match the exact caller and static run.
 *
 * @param binding - Exact static verification binding.
 * @param claim - Exact caller lease claim.
 * @param authority - Fresh candidate durable authority.
 */
function requireAuthority(
  binding: FullVerificationBinding,
  claim: WorkspaceSearchMigrationLeaseClaim,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  if (
    authority.configurationHash !== binding.configurationHash ||
    authority.stateTableId !== binding.stateTable.tableId ||
    authority.lease.runId !== binding.executionRun.runId ||
    authority.lease.runId !== claim.runId ||
    authority.lease.ownerId !== claim.ownerId ||
    authority.lease.fenceToken !== claim.fenceToken
  ) {
    return failVerification('LEASE_LOST')
  }
}

/**
 * Requires an exact apply-seal replay to equal the applied-root copy.
 *
 * @param root - Exact immutable applied root.
 * @param seal - Exact-version replayed apply seal.
 */
function requireExactApplySeal(
  root: WorkspaceSearchMigrationAppliedRoot,
  seal: WorkspaceSearchMigrationCompleteApplySeal,
): void {
  const expected =
    serializeWorkspaceSearchMigrationCompleteApplySeal(root.seal)
  const observed =
    serializeWorkspaceSearchMigrationCompleteApplySeal(seal)
  if (!bytesEqual(expected, observed)) {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Creates one fixed-order page transaction.
 *
 * @param binding - Exact static adapter binding.
 * @param appliedRoot - Exact immutable applied root.
 * @param authority - Fresh current authority.
 * @param commitAt - Trusted transaction time.
 * @param transition - Exact page transition material.
 * @returns Fixed nine-item DynamoDB transaction.
 */
function createPageTransaction(
  binding: FullVerificationBinding,
  appliedRoot: WorkspaceSearchMigrationAppliedRoot,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  commitAt: Date,
  transition: PreparedPageTransition,
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt,
    })
  const stateRecord = createVerificationStateRecord(
    binding,
    transition.state,
  )
  const receiptRecord = createVerificationReceiptRecord(
    binding,
    transition.receipt,
  )
  const items: readonly TransactWriteItem[] = [
    ...authorityChecks,
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      binding.closedWriterFenceRecord,
      binding.writerFence,
    ),
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: binding.stateTable,
        configurationHash: binding.configurationHash,
        boundary: binding.executionBoundary,
      },
    ),
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority: binding.sealedPlanningAuthority,
    }),
    createWorkspaceSearchMigrationAppliedRootConditionCheck({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      executionRun: binding.executionRun,
      root: appliedRoot,
    }),
    createVerificationStatePut(
      binding,
      stateRecord,
      transition.predecessorRecord,
    ),
    createAbsentPut(binding, receiptRecord),
  ]
  if (items.length !== pageTransactionItemCount) {
    return failVerification('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    TransactItems: [...items],
  })
}

/**
 * Creates one fixed-order immutable verified publication transaction.
 *
 * @param binding - Exact static adapter binding.
 * @param appliedRoot - Exact immutable applied root.
 * @param authority - Fresh current authority.
 * @param commitAt - Trusted transaction time.
 * @param terminal - Exact terminal state and complete row.
 * @param root - Exact immutable verified root.
 * @returns Fixed nine-item DynamoDB transaction.
 */
function createPublishTransaction(
  binding: FullVerificationBinding,
  appliedRoot: WorkspaceSearchMigrationAppliedRoot,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  commitAt: Date,
  terminal: DurableVerificationState,
  root: WorkspaceSearchMigrationFullVerificationVerifiedRoot,
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt,
    })
  const items: readonly TransactWriteItem[] = [
    ...authorityChecks,
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      binding.closedWriterFenceRecord,
      binding.writerFence,
    ),
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: binding.stateTable,
        configurationHash: binding.configurationHash,
        boundary: binding.executionBoundary,
      },
    ),
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority: binding.sealedPlanningAuthority,
    }),
    createWorkspaceSearchMigrationAppliedRootConditionCheck({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      executionRun: binding.executionRun,
      root: appliedRoot,
    }),
    createFullRecordConditionCheck(binding, terminal.record),
    createAbsentPut(
      binding,
      createVerifiedRootRecord(binding, root),
    ),
  ]
  if (items.length !== publicationTransactionItemCount) {
    return failVerification('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    TransactItems: [...items],
  })
}

/**
 * Creates the canonical mutable verification-state row.
 *
 * @param binding - Exact static adapter binding.
 * @param state - Exact strict verification state.
 * @returns Complete bounded low-level DynamoDB item.
 */
function createVerificationStateRecord(
  binding: FullVerificationBinding,
  state: WorkspaceSearchMigrationFullVerificationPersistenceState,
): Readonly<Record<string, AttributeValue>> {
  requireStateBinding(binding, state)
  const bytes =
    serializeWorkspaceSearchMigrationFullVerificationPersistenceState(
      state,
    )
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createVerificationStateRecordKey(binding),
    },
    kind: { S: verificationStateRecordKind },
    recordVersion: { N: String(verificationRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    planArtifactBindingDigest: {
      S: state.planArtifactBindingDigest,
    },
    sealedPlanningAuthorityDigest: {
      S: state.sealedPlanningAuthorityDigest,
    },
    appliedRootDigest: { S: state.appliedRootDigest },
    verificationPlanDigest: {
      S: state.verificationPlanDigest,
    },
    revision: { N: String(state.revision) },
    lastCommandDigest: { S: state.lastCommandDigest },
    stateDigest: { S: state.stateDigest },
    stateBytes: { B: bytes },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses and cross-checks one complete verification-state row.
 *
 * @param binding - Exact static adapter binding.
 * @param item - Complete untrusted low-level item.
 * @returns Strict detached state and complete canonical row.
 */
function parseVerificationStateRecord(
  binding: FullVerificationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): DurableVerificationState {
  requireExactAttributeKeys(
    item,
    verificationStateRecordAttributeNames,
  )
  requireRecordHeader(
    binding,
    item,
    verificationStateRecordKind,
    createVerificationStateRecordKey(binding),
  )
  const state =
    parseWorkspaceSearchMigrationFullVerificationPersistenceState(
      readBinaryAttribute(item, 'stateBytes'),
    )
  requireStateBinding(binding, state)
  if (
    readStringAttribute(item, 'planArtifactBindingDigest') !==
      state.planArtifactBindingDigest ||
    readStringAttribute(item, 'sealedPlanningAuthorityDigest') !==
      state.sealedPlanningAuthorityDigest ||
    readStringAttribute(item, 'appliedRootDigest') !==
      state.appliedRootDigest ||
    readStringAttribute(item, 'verificationPlanDigest') !==
      state.verificationPlanDigest ||
    readNumberAttribute(item, 'revision') !== state.revision ||
    readStringAttribute(item, 'lastCommandDigest') !==
      state.lastCommandDigest ||
    readStringAttribute(item, 'stateDigest') !== state.stateDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  const canonical = createVerificationStateRecord(binding, state)
  if (digestAttributeMap(canonical) !== digestAttributeMap(item)) {
    return failVerification('INVALID_STATE')
  }
  return { state, record: canonical }
}

/**
 * Creates the canonical immutable page-receipt row.
 *
 * @param binding - Exact static adapter binding.
 * @param receipt - Exact strict page receipt.
 * @returns Complete bounded low-level DynamoDB item.
 */
function createVerificationReceiptRecord(
  binding: FullVerificationBinding,
  receipt: WorkspaceSearchMigrationFullVerificationPageReceipt,
): Readonly<Record<string, AttributeValue>> {
  requireReceiptBinding(binding, receipt)
  const bytes =
    serializeWorkspaceSearchMigrationFullVerificationPageReceipt(
      receipt,
    )
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createVerificationReceiptRecordKey(
        binding,
        receipt.commandDigest,
      ),
    },
    kind: { S: verificationReceiptRecordKind },
    recordVersion: { N: String(verificationRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    planArtifactBindingDigest: {
      S: receipt.planArtifactBindingDigest,
    },
    sealedPlanningAuthorityDigest: {
      S: receipt.sealedPlanningAuthorityDigest,
    },
    appliedRootDigest: { S: receipt.appliedRootDigest },
    verificationPlanDigest: {
      S: receipt.verificationPlanDigest,
    },
    location: { S: receipt.location },
    commandDigest: { S: receipt.commandDigest },
    predecessorRevision: {
      N: String(receipt.predecessorRevision),
    },
    predecessorDigest: { S: receipt.predecessorDigest },
    successorRevision: {
      N: String(receipt.successorRevision),
    },
    successorStateDigest: {
      S: receipt.successorStateDigest,
    },
    receiptDigest: { S: receipt.receiptDigest },
    receiptBytes: { B: bytes },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses and cross-checks one complete page-receipt row.
 *
 * @param binding - Exact static adapter binding.
 * @param item - Complete untrusted low-level item.
 * @returns Strict detached receipt and complete canonical row.
 */
function parseVerificationReceiptRecord(
  binding: FullVerificationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): DurableVerificationReceipt {
  requireExactAttributeKeys(
    item,
    verificationReceiptRecordAttributeNames,
  )
  const receipt =
    parseWorkspaceSearchMigrationFullVerificationPageReceipt(
      readBinaryAttribute(item, 'receiptBytes'),
    )
  requireRecordHeader(
    binding,
    item,
    verificationReceiptRecordKind,
    createVerificationReceiptRecordKey(
      binding,
      receipt.commandDigest,
    ),
  )
  requireReceiptBinding(binding, receipt)
  if (
    readStringAttribute(item, 'planArtifactBindingDigest') !==
      receipt.planArtifactBindingDigest ||
    readStringAttribute(item, 'sealedPlanningAuthorityDigest') !==
      receipt.sealedPlanningAuthorityDigest ||
    readStringAttribute(item, 'appliedRootDigest') !==
      receipt.appliedRootDigest ||
    readStringAttribute(item, 'verificationPlanDigest') !==
      receipt.verificationPlanDigest ||
    readStringAttribute(item, 'location') !== receipt.location ||
    readStringAttribute(item, 'commandDigest') !==
      receipt.commandDigest ||
    readNumberAttribute(item, 'predecessorRevision') !==
      receipt.predecessorRevision ||
    readStringAttribute(item, 'predecessorDigest') !==
      receipt.predecessorDigest ||
    readNumberAttribute(item, 'successorRevision') !==
      receipt.successorRevision ||
    readStringAttribute(item, 'successorStateDigest') !==
      receipt.successorStateDigest ||
    readStringAttribute(item, 'receiptDigest') !==
      receipt.receiptDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  const canonical = createVerificationReceiptRecord(
    binding,
    receipt,
  )
  if (digestAttributeMap(canonical) !== digestAttributeMap(item)) {
    return failVerification('INVALID_STATE')
  }
  return { receipt, record: canonical }
}

/**
 * Creates the canonical immutable verified-root row.
 *
 * @param binding - Exact static adapter binding.
 * @param root - Exact strict verified root.
 * @returns Complete bounded low-level DynamoDB item.
 */
function createVerifiedRootRecord(
  binding: FullVerificationBinding,
  root: WorkspaceSearchMigrationFullVerificationVerifiedRoot,
): Readonly<Record<string, AttributeValue>> {
  requireRootBinding(binding, root)
  const bytes =
    serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot(root)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createVerifiedRootRecordKey(binding) },
    kind: { S: verifiedRootRecordKind },
    recordVersion: { N: String(verificationRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    planArtifactBindingDigest: {
      S: root.planArtifactBinding.bindingDigest,
    },
    sealedPlanningAuthorityDigest: {
      S: root.sealedPlanningAuthorityDigest,
    },
    appliedRootDigest: { S: root.appliedRootDigest },
    verificationPlanDigest: {
      S: root.verificationPlanDigest,
    },
    verificationResultDigest: {
      S: root.verificationResultDigest,
    },
    terminalStateDigest: { S: root.terminalStateDigest },
    terminalReceiptDigest: { S: root.terminalReceiptDigest },
    verifiedAt: { S: root.verifiedAt },
    verifiedRootDigest: { S: root.verifiedRootDigest },
    rootBytes: { B: bytes },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses and cross-checks one complete verified-root row.
 *
 * @param binding - Exact static adapter binding.
 * @param item - Complete untrusted low-level item.
 * @returns Strict detached verified root and complete canonical row.
 */
function parseVerifiedRootRecord(
  binding: FullVerificationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): DurableVerifiedRoot {
  requireExactAttributeKeys(item, verifiedRootRecordAttributeNames)
  requireRecordHeader(
    binding,
    item,
    verifiedRootRecordKind,
    createVerifiedRootRecordKey(binding),
  )
  const root =
    parseWorkspaceSearchMigrationFullVerificationVerifiedRoot(
      readBinaryAttribute(item, 'rootBytes'),
    )
  requireRootBinding(binding, root)
  if (
    readStringAttribute(item, 'planArtifactBindingDigest') !==
      root.planArtifactBinding.bindingDigest ||
    readStringAttribute(item, 'sealedPlanningAuthorityDigest') !==
      root.sealedPlanningAuthorityDigest ||
    readStringAttribute(item, 'appliedRootDigest') !==
      root.appliedRootDigest ||
    readStringAttribute(item, 'verificationPlanDigest') !==
      root.verificationPlanDigest ||
    readStringAttribute(item, 'verificationResultDigest') !==
      root.verificationResultDigest ||
    readStringAttribute(item, 'terminalStateDigest') !==
      root.terminalStateDigest ||
    readStringAttribute(item, 'terminalReceiptDigest') !==
      root.terminalReceiptDigest ||
    readStringAttribute(item, 'verifiedAt') !== root.verifiedAt ||
    readStringAttribute(item, 'verifiedRootDigest') !==
      root.verifiedRootDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  const canonical = createVerifiedRootRecord(binding, root)
  if (digestAttributeMap(canonical) !== digestAttributeMap(item)) {
    return failVerification('INVALID_STATE')
  }
  return { root, record: canonical }
}

/**
 * Requires one state to remain in the exact static run/table binding.
 *
 * @param binding - Exact static adapter binding.
 * @param state - Candidate strict verification state.
 */
function requireStateBinding(
  binding: FullVerificationBinding,
  state: WorkspaceSearchMigrationFullVerificationPersistenceState,
): void {
  if (
    state.runId !== binding.executionRun.runId ||
    state.configurationHash !== binding.configurationHash ||
    state.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  requireTableIds(binding.tableIds, state.tableIds)
}

/**
 * Requires one receipt to remain in the exact static run/table binding.
 *
 * @param binding - Exact static adapter binding.
 * @param receipt - Candidate strict immutable receipt.
 */
function requireReceiptBinding(
  binding: FullVerificationBinding,
  receipt: WorkspaceSearchMigrationFullVerificationPageReceipt,
): void {
  if (
    receipt.runId !== binding.executionRun.runId ||
    receipt.configurationHash !== binding.configurationHash ||
    receipt.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  requireTableIds(binding.tableIds, receipt.tableIds)
}

/**
 * Requires one verified root to remain in the exact static binding.
 *
 * @param binding - Exact static adapter binding.
 * @param root - Candidate strict immutable root.
 */
function requireRootBinding(
  binding: FullVerificationBinding,
  root: WorkspaceSearchMigrationFullVerificationVerifiedRoot,
): void {
  if (
    root.runId !== binding.executionRun.runId ||
    root.configurationHash !== binding.configurationHash ||
    root.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  requireTableIds(binding.tableIds, root.tableIds)
}

/**
 * Requires exact common controlled attributes on one adapter row.
 *
 * @param binding - Exact static adapter binding.
 * @param item - Candidate complete low-level item.
 * @param kind - Expected record discriminator.
 * @param recordKey - Expected deterministic sort key.
 */
function requireRecordHeader(
  binding: FullVerificationBinding,
  item: Readonly<Record<string, AttributeValue>>,
  kind: string,
  recordKey: string,
): void {
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !== recordKey ||
    readStringAttribute(item, 'kind') !== kind ||
    readNumberAttribute(item, 'recordVersion') !==
      verificationRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId
  ) {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Creates the deterministic mutable verification-state record key.
 *
 * @param binding - Exact static adapter binding.
 * @returns Content-independent run-scoped sort key.
 */
function createVerificationStateRecordKey(
  binding: FullVerificationBinding,
): string {
  return `${verificationStateRecordKeyPrefix}` +
    `/${binding.recordBindingDigest}`
}

/**
 * Creates one deterministic immutable page-receipt record key.
 *
 * @param binding - Exact static adapter binding.
 * @param commandDigest - Exact deterministic page-command digest.
 * @returns Command-addressed immutable sort key.
 */
function createVerificationReceiptRecordKey(
  binding: FullVerificationBinding,
  commandDigest: string,
): string {
  return `${verificationReceiptRecordKeyPrefix}` +
    `/${binding.recordBindingDigest}/${commandDigest}`
}

/**
 * Creates the deterministic immutable verified-root record key.
 *
 * @param binding - Exact static adapter binding.
 * @returns Run-scoped immutable verified-root sort key.
 */
function createVerifiedRootRecordKey(
  binding: FullVerificationBinding,
): string {
  return `${verifiedRootRecordKeyPrefix}` +
    `/${binding.recordBindingDigest}`
}

/**
 * Creates one strongly consistent adapter-row GetItem command.
 *
 * @param binding - Exact static adapter binding.
 * @param recordKey - Adapter-derived deterministic sort key.
 * @returns Strongly consistent point read.
 */
function createStrongReadCommand(
  binding: FullVerificationBinding,
  recordKey: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTable.tableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: { S: recordKey },
    },
  })
}

/**
 * Creates an absent-only immutable DynamoDB Put.
 *
 * @param binding - Exact static adapter binding.
 * @param item - Complete canonical item.
 * @returns Conditional absent-only transaction Put.
 */
function createAbsentPut(
  binding: FullVerificationBinding,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  return {
    Put: {
      TableName: binding.stateTable.tableName,
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
 * Creates an absent-first or exact-predecessor mutable-state Put.
 *
 * @param binding - Exact static adapter binding.
 * @param successor - Complete canonical successor item.
 * @param predecessor - Complete canonical predecessor, if one exists.
 * @returns Exact CAS transaction Put.
 */
function createVerificationStatePut(
  binding: FullVerificationBinding,
  successor: Readonly<Record<string, AttributeValue>>,
  predecessor?: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  if (predecessor === undefined) {
    return createAbsentPut(binding, successor)
  }
  const condition = createFullRecordCondition(predecessor)
  return {
    Put: {
      TableName: binding.stateTable.tableName,
      Item: successor,
      ...condition,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates an exact full-row DynamoDB ConditionCheck.
 *
 * @param binding - Exact static adapter binding.
 * @param record - Complete canonical row fixed by the condition.
 * @returns Exact controlled-attribute condition check.
 */
function createFullRecordConditionCheck(
  binding: FullVerificationBinding,
  record: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const migrationId = record.migrationId
  const recordKey = record.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    return failVerification('INVALID_STATE')
  }
  return {
    ConditionCheck: {
      TableName: binding.stateTable.tableName,
      Key: { migrationId, recordKey },
      ...createFullRecordCondition(record),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates equality clauses for every non-key controlled attribute.
 *
 * @param record - Complete canonical low-level row.
 * @returns DynamoDB equality expression material.
 */
function createFullRecordCondition(
  record: Readonly<Record<string, AttributeValue>>,
): {
  /** Exact conjunction over every controlled non-key field. */
  readonly ConditionExpression: string
  /** Generated field-name tokens. */
  readonly ExpressionAttributeNames: Readonly<Record<string, string>>
  /** Generated exact attribute-value tokens. */
  readonly ExpressionAttributeValues:
    Readonly<Record<string, AttributeValue>>
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  let index = 0
  for (const [name, value] of Object.entries(record)) {
    if (name === 'migrationId' || name === 'recordKey') continue
    const nameToken = `#field${index}`
    const valueToken = `:value${index}`
    names[nameToken] = name
    values[valueToken] = value
    clauses.push(`${nameToken} = ${valueToken}`)
    index += 1
  }
  if (clauses.length === 0) {
    return failVerification('INVALID_STATE')
  }
  return {
    ConditionExpression: clauses.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

/**
 * Converts one rich result reference without dropping exact-version fields.
 *
 * @param reference - Strict rich result artifact reference.
 * @returns Exact persistence artifact reference.
 */
function toPlanArtifactReference(
  reference: WorkspaceSearchMigrationFullVerificationArtifactReference,
): WorkspaceSearchMigrationFullVerificationArtifactReference {
  return {
    objectKey: reference.objectKey,
    versionId: reference.versionId,
    contentDigest: reference.contentDigest,
    byteLength: reference.byteLength,
    retainUntil: reference.retainUntil,
  }
}

/**
 * Reconstructs the rich gateway reference retained by a verified root.
 *
 * @param reference - Exact persisted immutable-object reference.
 * @param result - Exact recomputed semantic result.
 * @param appliedRootDigest - Exact immutable applied-root digest.
 * @param binding - Exact static adapter identity.
 * @returns Exact rich reference accepted by the result gateway.
 */
function createRichResultReference(
  reference:
    WorkspaceSearchMigrationVerificationResultArtifactReference,
  result: WorkspaceSearchMigrationFullVerificationResult,
  appliedRootDigest: string,
  binding: FullVerificationBinding,
): WorkspaceSearchMigrationVerificationResultArtifactReference {
  const artifact = createVerificationResultArtifactProjection(
    result,
    appliedRootDigest,
    binding,
  )
  const detached = readResultReferenceCandidate(reference)
  if (
    detached.runId !== binding.executionRun.runId ||
    detached.configurationHash !== binding.configurationHash ||
    detached.appliedRootDigest !== appliedRootDigest ||
    detached.verificationResultDigest !== result.resultDigest ||
    detached.envelopeDigest !== artifact.envelopeDigest
  ) {
    return failVerification('INVALID_STATE')
  }
  return detached
}

/**
 * Creates the expected semantic result envelope projection.
 *
 * @param result - Exact successful pure verification result.
 * @param appliedRootDigest - Exact immutable applied-root digest.
 * @param binding - Exact static adapter identity.
 * @returns Complete deterministic semantic envelope.
 */
function createVerificationResultArtifactProjection(
  result: WorkspaceSearchMigrationFullVerificationResult,
  appliedRootDigest: string,
  binding: FullVerificationBinding,
): WorkspaceSearchMigrationVerificationResultArtifact {
  const fields = {
    kind: 'workspace-search-migration-verification-result-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: result.migrationVersion,
    runId: binding.executionRun.runId,
    configurationHash: binding.configurationHash,
    appliedRootDigest,
    verificationResultDigest: result.resultDigest,
    verificationResult: result,
  } satisfies Omit<
    WorkspaceSearchMigrationVerificationResultArtifact,
    'envelopeDigest'
  >
  return {
    ...fields,
    envelopeDigest: createMigrationDigest(fields),
  }
}

/**
 * Requires an exact result envelope, reference, applied root, and semantic result.
 *
 * @param artifact - Strict replayed result artifact.
 * @param reference - Exact rich version reference used by the replay.
 * @param result - Exact recomputed semantic result.
 * @param appliedRootDigest - Exact immutable applied-root digest.
 * @param binding - Exact static adapter identity.
 */
function requireExactVerificationResultArtifact(
  artifact: WorkspaceSearchMigrationVerificationResultArtifact,
  reference:
    WorkspaceSearchMigrationVerificationResultArtifactReference,
  result: WorkspaceSearchMigrationFullVerificationResult,
  appliedRootDigest: string,
  binding: FullVerificationBinding,
): void {
  const expected = createVerificationResultArtifactProjection(
    result,
    appliedRootDigest,
    binding,
  )
  if (
    artifact.envelopeDigest !== expected.envelopeDigest ||
    artifact.verificationResultDigest !== result.resultDigest ||
    artifact.appliedRootDigest !== appliedRootDigest ||
    artifact.runId !== binding.executionRun.runId ||
    artifact.configurationHash !== binding.configurationHash ||
    reference.envelopeDigest !== expected.envelopeDigest ||
    reference.verificationResultDigest !== result.resultDigest ||
    reference.appliedRootDigest !== appliedRootDigest ||
    reference.runId !== binding.executionRun.runId ||
    reference.configurationHash !== binding.configurationHash ||
    digestValue(artifact.verificationResult) !== digestValue(result)
  ) {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Reads a strict rich result reference returned by the gateway.
 *
 * @param value - Candidate untrusted gateway result.
 * @returns Detached exact rich result reference.
 */
function readResultReferenceCandidate(
  value: unknown,
): WorkspaceSearchMigrationVerificationResultArtifactReference {
  const record = requirePlainRecord(value, 'INVALID_STATE')
  requireExactKeys(record, [
    'appliedRootDigest',
    'artifactVersion',
    'byteLength',
    'configurationHash',
    'contentDigest',
    'envelopeDigest',
    'kind',
    'objectKey',
    'retainUntil',
    'runId',
    'verificationResultDigest',
    'versionId',
  ], 'INVALID_STATE')
  const kind = readOwn(record, 'kind', 'INVALID_STATE')
  const artifactVersion = readOwn(
    record,
    'artifactVersion',
    'INVALID_STATE',
  )
  if (
    kind !==
      'workspace-search-migration-verification-result-artifact-reference' ||
    artifactVersion !== 1
  ) {
    return failVerification('INVALID_STATE')
  }
  return {
    kind,
    artifactVersion,
    runId: readIdentifier(
      readOwn(record, 'runId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    verificationResultDigest: readDigest(
      readOwn(record, 'verificationResultDigest', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    envelopeDigest: readDigest(
      readOwn(record, 'envelopeDigest', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    objectKey: readNonemptyText(
      readOwn(record, 'objectKey', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    versionId: readNonemptyText(
      readOwn(record, 'versionId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    contentDigest: readDigest(
      readOwn(record, 'contentDigest', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    retainUntil: readTimestamp(
      readOwn(record, 'retainUntil', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
  }
}

/**
 * Reads one strict verification-result artifact returned by exact replay.
 *
 * @param value - Candidate replay result.
 * @returns Strict-enough artifact for deterministic equality validation.
 */
function readResultArtifactCandidate(
  value: unknown,
): WorkspaceSearchMigrationVerificationResultArtifact {
  if (!isResultArtifactCandidate(value)) {
    return failVerification('INVALID_STATE')
  }
  return value
}

/**
 * Narrows one candidate result artifact to an ordinary record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether strict gateway output may be compared.
 */
function isResultArtifactCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationVerificationResultArtifact {
  return isPlainRecord(value)
}

/**
 * Reads one strict plan replay returned by the exact-version gateway.
 *
 * @param value - Candidate replay result.
 * @returns Strict-enough replay for the pure plan codec.
 */
function readPlanReplayCandidate(
  value: unknown,
): WorkspaceSearchMigrationPlanArtifactReplayResult {
  const record = requirePlainRecord(value, 'INVALID_STATE')
  requireExactKeys(record, [
    'manifestHead',
    'operations',
    'planSeal',
  ], 'INVALID_STATE')
  if (!isPlanReplayCandidate(record)) {
    return failVerification('INVALID_STATE')
  }
  return record
}

/**
 * Narrows a shape-checked replay record for strict downstream codecs.
 *
 * @param value - Candidate replay record.
 * @returns Whether plan fields have minimum container shapes.
 */
function isPlanReplayCandidate(
  value: Readonly<Record<string, unknown>>,
): value is WorkspaceSearchMigrationPlanArtifactReplayResult {
  return isPlainRecord(
    readOwn(value, 'planSeal', 'INVALID_STATE'),
  ) &&
    isPlainRecord(
      readOwn(value, 'manifestHead', 'INVALID_STATE'),
    ) &&
    Array.isArray(readOwn(value, 'operations', 'INVALID_STATE'))
}

/**
 * Reads one strict pure-kernel progress candidate.
 *
 * @param value - Candidate scanner output.
 * @returns Ordinary progress record for strict persistence validation.
 */
function readProgressCandidate(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationProgress {
  if (!isProgressCandidate(value)) {
    return failVerification('INVALID_STATE')
  }
  return value
}

/**
 * Narrows one progress candidate to an ordinary record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value may enter the strict progress codec.
 */
function isProgressCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationFullVerificationProgress {
  return isPlainRecord(value)
}

/**
 * Reads one strict applied root returned by the strong reader.
 *
 * @param value - Candidate strong-reader output.
 * @returns Detached strict immutable applied root.
 */
function readAppliedRootCandidate(
  value: unknown,
): WorkspaceSearchMigrationAppliedRoot {
  if (!isAppliedRootCandidate(value)) {
    return failVerification('INVALID_STATE')
  }
  return parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot(value),
  )
}

/**
 * Narrows one applied-root candidate for its strict canonical codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary record.
 */
function isAppliedRootCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationAppliedRoot {
  return isPlainRecord(value)
}

/**
 * Reads one strict complete apply seal returned by exact-version replay.
 *
 * @param value - Candidate gateway output.
 * @returns Detached strict complete apply seal.
 */
function readApplySealCandidate(
  value: unknown,
): WorkspaceSearchMigrationCompleteApplySeal {
  if (!isApplySealCandidate(value)) {
    return failVerification('INVALID_STATE')
  }
  const bytes =
    serializeWorkspaceSearchMigrationCompleteApplySeal(value)
  if (bytes.byteLength === 0) {
    return failVerification('INVALID_STATE')
  }
  return value
}

/**
 * Narrows one apply-seal candidate for its strict canonical codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary record.
 */
function isApplySealCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationCompleteApplySeal {
  return isPlainRecord(value)
}

/**
 * Detaches one fresh authority aggregate without retaining active behavior.
 *
 * @param value - Candidate authority-port output.
 * @returns Detached exact authority aggregate.
 */
function readAuthorityCandidate(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  const record = requirePlainRecord(value, 'INVALID_STATE')
  requireExactKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ], 'INVALID_STATE')
  return {
    configurationHash: readDigest(
      readOwn(record, 'configurationHash', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    stateTableId: readIdentifier(
      readOwn(record, 'stateTableId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    lease: readDurableLease(
      readOwn(record, 'lease', 'INVALID_STATE'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
        'INVALID_STATE',
      ),
      'INVALID_STATE',
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(
        record,
        'maintenanceEvidencePointerRevision',
        'INVALID_STATE',
      ),
      'INVALID_STATE',
    ),
    maintenanceEvidenceReceipt: readMaintenanceReceipt(
      readOwn(
        record,
        'maintenanceEvidenceReceipt',
        'INVALID_STATE',
      ),
    ),
    evaluatedAt: readTimestamp(
      readOwn(record, 'evaluatedAt', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
  }
}

/**
 * Detaches one complete durable migration lease.
 *
 * @param value - Candidate lease.
 * @returns Detached strict lease.
 */
function readDurableLease(value: unknown): WorkspaceSearchMigrationLease {
  const record = requirePlainRecord(value, 'INVALID_STATE')
  requireExactKeys(record, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ], 'INVALID_STATE')
  return {
    runId: readIdentifier(
      readOwn(record, 'runId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    ownerId: readIdentifier(
      readOwn(record, 'ownerId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    expiresAt: readTimestamp(
      readOwn(record, 'expiresAt', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    heartbeatAt: readTimestamp(
      readOwn(record, 'heartbeatAt', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
  }
}

/**
 * Detaches one complete durable maintenance receipt.
 *
 * @param value - Candidate receipt.
 * @returns Detached strict maintenance receipt.
 */
function readMaintenanceReceipt(
  value: unknown,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requirePlainRecord(value, 'INVALID_STATE')
  requireExactKeys(record, [
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'oldestObservationAt',
    'runId',
    'runtimeRevision',
    'validatedAt',
    'validUntil',
  ], 'INVALID_STATE')
  return {
    runId: readIdentifier(
      readOwn(record, 'runId', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    evidenceDigest: readDigest(
      readOwn(record, 'evidenceDigest', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    evidenceLocator: readNonemptyText(
      readOwn(record, 'evidenceLocator', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    runtimeRevision: readPositiveSafeInteger(
      readOwn(record, 'runtimeRevision', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    validatedAt: readTimestamp(
      readOwn(record, 'validatedAt', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    oldestObservationAt: readTimestamp(
      readOwn(record, 'oldestObservationAt', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
    validUntil: readTimestamp(
      readOwn(record, 'validUntil', 'INVALID_STATE'),
      'INVALID_STATE',
    ),
  }
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
    return failVerification('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failVerification('INVALID_STATE')
  }
  const item = cloneAttributeMap(descriptor.value)
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Losslessly detaches one low-level DynamoDB attribute map.
 *
 * @param value - Candidate low-level map.
 * @returns Detached validated attribute map.
 */
function cloneAttributeMap(
  value: unknown,
): Readonly<Record<string, AttributeValue>> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Requires one row to contain exactly its controlled attribute set.
 *
 * @param item - Candidate complete low-level item.
 * @param expectedKeys - Complete controlled key list.
 */
function requireExactAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(item).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failVerification('INVALID_STATE')
  }
}

/**
 * Reads one exact single-string DynamoDB attribute.
 *
 * @param item - Strict complete item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['S'], 'INVALID_STATE')
  const value = readOwn(attribute, 'S', 'INVALID_STATE')
  if (typeof value !== 'string') {
    return failVerification('INVALID_STATE')
  }
  return value
}

/**
 * Reads one exact nonnegative integer DynamoDB attribute.
 *
 * @param item - Strict complete item.
 * @param name - Required attribute name.
 * @returns Exact safe integer value.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['N'], 'INVALID_STATE')
  const value = readOwn(attribute, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return failVerification('INVALID_STATE')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return failVerification('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one exact nonempty binary DynamoDB attribute.
 *
 * @param item - Strict complete item.
 * @param name - Required attribute name.
 * @returns Detached binary bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['B'], 'INVALID_STATE')
  const value = readOwn(attribute, 'B', 'INVALID_STATE')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failVerification('INVALID_STATE')
  }
  const bytes = new Uint8Array(value)
  if (bytes.byteLength === 0) {
    return failVerification('INVALID_STATE')
  }
  return bytes
}

/**
 * Creates a stable digest of one exact low-level DynamoDB attribute map.
 *
 * @param item - Exact low-level map.
 * @returns Digest of its lossless JSON-safe encoding.
 */
function digestAttributeMap(
  item: Readonly<Record<string, AttributeValue>>,
): string {
  return createMigrationDigest(encodeUnknownAttributeMap(item))
}

/**
 * Classifies one transaction failure by its fixed cancellation positions.
 *
 * @param error - Raw DynamoDB transaction failure.
 * @param operation - Page persistence or verified publication.
 * @returns Stable raw-value-free migration failure code.
 */
function classifyTransactionError(
  error: unknown,
  operation: 'page' | 'publish',
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
      const index = operation === 'page'
        ? workspaceSearchMigrationFullVerificationPageTransactionIndex
        : workspaceSearchMigrationFullVerificationPublishTransactionIndex
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
      const lastIndex = operation === 'page'
        ? workspaceSearchMigrationFullVerificationPageTransactionIndex
          .pageReceipt
        : workspaceSearchMigrationFullVerificationPublishTransactionIndex
          .verifiedRoot
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= lastIndex;
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
    const classification = createAwsClassificationInput(error)
    if (isThrottlingError(classification)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return isTransientError(classification)
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : 'INVALID_STATE'
  } catch {
    return 'AMBIGUOUS_OPERATION_UNRESOLVED'
  }
}

/**
 * Preserves managed-session quarantine without attempting another AWS read.
 *
 * @param error - Candidate managed transport failure.
 */
function preserveManagedAmbiguousFailure(error: unknown): void {
  if (isProxyValue(error)) return
  let isManagedAmbiguousFailure = false
  try {
    isManagedAmbiguousFailure =
      error instanceof WorkspaceSearchMigrationFailure &&
      error.code === 'AMBIGUOUS_OPERATION_UNRESOLVED'
  } catch {
    return
  }
  if (isManagedAmbiguousFailure) {
    return failVerification('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
}

/**
 * Reads one fixed transaction cancellation reason without accessors.
 *
 * @param error - Raw transaction cancellation.
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
    const reasonsDescriptor = Object.getOwnPropertyDescriptor(
      error,
      'CancellationReasons',
    )
    if (
      reasonsDescriptor === undefined ||
      !Object.hasOwn(reasonsDescriptor, 'value') ||
      !Array.isArray(reasonsDescriptor.value)
    ) {
      return undefined
    }
    const reason: unknown = reasonsDescriptor.value[index]
    if (!isPlainRecord(reason)) return undefined
    const codeDescriptor = Object.getOwnPropertyDescriptor(
      reason,
      'Code',
    )
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
 * Detects explicitly retry-safe cancellation reasons.
 *
 * @param error - Raw transaction cancellation.
 * @param count - Exact fixed transaction item count.
 * @returns Whether any cancellation reason is retry-safe.
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
 * Minimal Smithy retry-classifier input copied without raw payload fields.
 */
type FullVerificationAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
    /** Optional HTTP metadata reduced to status only. */
    readonly $metadata?: {
      /** Optional HTTP response status. */
      readonly httpStatusCode?: number
    }
  }

/**
 * Creates a narrow input for Smithy's retry classifiers.
 *
 * @param error - Raw Error instance.
 * @returns Classifier input containing only safe standard fields.
 */
function createAwsClassificationInput(
  error: Error,
): FullVerificationAwsClassificationInput {
  const name = readErrorName(error)
  const code = readOwnStringIfData(error, 'code')
  const httpStatusCode = readHttpStatusCode(error)
  return {
    name,
    message: '',
    ...(code === undefined ? {} : { code }),
    ...(httpStatusCode === undefined
      ? {}
      : { $metadata: { httpStatusCode } }),
  }
}

/**
 * Reads one safe own string data property.
 *
 * @param value - Candidate object.
 * @param name - Property name.
 * @returns String data value or undefined.
 */
function readOwnStringIfData(
  value: object,
  name: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
}

/**
 * Reads one safe own HTTP status from Smithy metadata.
 *
 * @param error - Candidate Error instance.
 * @returns Finite HTTP status or undefined.
 */
function readHttpStatusCode(error: Error): number | undefined {
  const metadataDescriptor = Object.getOwnPropertyDescriptor(
    error,
    '$metadata',
  )
  if (
    metadataDescriptor === undefined ||
    !Object.hasOwn(metadataDescriptor, 'value') ||
    !isPlainRecord(metadataDescriptor.value)
  ) {
    return undefined
  }
  const statusDescriptor = Object.getOwnPropertyDescriptor(
    metadataDescriptor.value,
    'httpStatusCode',
  )
  const status = statusDescriptor !== undefined &&
      Object.hasOwn(statusDescriptor, 'value')
    ? statusDescriptor.value
    : undefined
  return typeof status === 'number' && Number.isFinite(status)
    ? status
    : undefined
}

/**
 * Reads one error name without invoking arbitrary accessors.
 *
 * @param error - Candidate raw error.
 * @returns Safe error name or empty string.
 */
function readErrorName(error: unknown): string {
  if (isProxyValue(error)) return ''
  try {
    if (!(error instanceof Error)) return ''
    return readOwnStringIfData(error, 'name') ?? 'Error'
  } catch {
    return ''
  }
}

/**
 * Detects a missing measured DynamoDB resource.
 *
 * @param error - Candidate raw error.
 * @returns Whether DynamoDB reported ResourceNotFoundException.
 */
function isResourceNotFoundError(error: unknown): boolean {
  if (isProxyValue(error)) return false
  try {
    return error instanceof ResourceNotFoundException ||
      readErrorName(error) === 'ResourceNotFoundException'
  } catch {
    return false
  }
}

/**
 * Runs one asynchronous public operation behind a stable safe boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful operation result.
 */
async function runVerificationBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createPublicFailure(readFailureCode(error, false))
  }
}

/**
 * Extracts one stable code from private, public, or raw failures.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether failure occurred in construction.
 * @returns Stable raw-value-free migration failure code.
 */
function readFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  const fallback = duringConstruction
    ? 'INVALID_ARGUMENT'
    : 'INVALID_STATE'
  if (isProxyValue(error)) return fallback
  try {
    if (error instanceof FullVerificationAwsFailure) {
      return error.code
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      if (isWorkspaceSearchMigrationFailureCode(code)) return code
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
 * Detects a Proxy without invoking its traps.
 *
 * @param value - Candidate caught value.
 * @returns Whether the value is a JavaScript Proxy.
 */
function isProxyValue(value: unknown): boolean {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && nodeUtilTypes.isProxy(value)
}

/**
 * Creates one generic public failure with no raw values.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Public migration failure.
 */
function createPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(code, code)
}

/**
 * Throws one private stable full-verification failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failVerification(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new FullVerificationAwsFailure(code)
}

/**
 * Requires one ordinary non-Proxy record.
 *
 * @param value - Candidate runtime value.
 * @param code - Stable failure classification.
 * @returns Ordinary descriptor-safe record.
 */
function requirePlainRecord(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failVerification(code)
  }
  return value
}

/**
 * Narrows one ordinary non-Proxy record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary record.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires an exact own enumerable data-property key set.
 *
 * @param record - Candidate ordinary record.
 * @param expectedKeys - Exact expected string keys.
 * @param code - Stable failure classification.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const ownKeys = Reflect.ownKeys(record)
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    return failVerification(code)
  }
  const actual = ownKeys.map(String).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failVerification(code)
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failVerification(code)
    }
  }
}

/**
 * Reads one required own enumerable data property.
 *
 * @param record - Candidate ordinary record.
 * @param name - Required property name.
 * @param code - Stable failure classification.
 * @returns Exact raw data-property value.
 */
function readOwn(
  record: Readonly<Record<string, unknown>>,
  name: string,
  code: WorkspaceSearchMigrationFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failVerification(code)
  }
  return descriptor.value
}

/**
 * Reads one bounded nonempty identifier.
 *
 * @param value - Candidate identifier.
 * @param code - Stable failure classification.
 * @returns Exact identifier.
 */
function readIdentifier(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  const text = readNonemptyText(value, code)
  if (text.length > 1_024) return failVerification(code)
  return text
}

/**
 * Reads one nonempty paired-surrogate-safe text value.
 *
 * @param value - Candidate string.
 * @param code - Stable failure classification.
 * @returns Exact nonempty text.
 */
function readNonemptyText(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192
  ) {
    return failVerification(code)
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
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value)
  ) {
    return failVerification(code)
  }
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
    value <= 0
  ) {
    return failVerification(code)
  }
  return value
}

/**
 * Reads one nonnegative safe integer below the successor overflow boundary.
 *
 * @param value - Candidate number.
 * @param code - Stable failure classification.
 * @returns Exact nonnegative safe integer.
 */
function readNonNegativeSafeInteger(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value === Number.MAX_SAFE_INTEGER
  ) {
    return failVerification(code)
  }
  return value
}

/**
 * Reads one exact canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @param code - Stable failure classification.
 * @returns Exact canonical timestamp.
 */
function readTimestamp(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (typeof value !== 'string') return failVerification(code)
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return failVerification(code)
  }
  return value
}

/**
 * Reads one trusted clock instant.
 *
 * @param clock - Captured trusted clock.
 * @returns Finite epoch milliseconds.
 */
function readClock(clock: () => number): number {
  const milliseconds = clock()
  if (!Number.isFinite(milliseconds)) {
    return failVerification('INVALID_STATE')
  }
  return milliseconds
}

/**
 * Computes a canonical semantic digest for equality checks.
 *
 * @param value - JSON-compatible strict semantic value.
 * @returns Canonical SHA-256 digest.
 */
function digestValue(value: unknown): string {
  return createMigrationDigest(value)
}

/**
 * Compares two detached byte arrays without coercion.
 *
 * @param left - First exact byte sequence.
 * @param right - Second exact byte sequence.
 * @returns Whether byte lengths and every byte match.
 */
function bytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Compares strings by UTF-8 byte ordinal for deterministic key checks.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive comparison result.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
