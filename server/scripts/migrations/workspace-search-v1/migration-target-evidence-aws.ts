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
  decodeAttributeMap,
  encodeAttributeMap,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type DynamoAttributeMap,
  type MigrationDigestState,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationPlanningMaterialReadLimits,
  WorkspaceSearchMigrationPlanningTargetChainMaterial,
  WorkspaceSearchMigrationPlanningTargetPageMaterial,
} from './migration-planning-material'
import type {
  WorkspaceSearchMigrationTargetScanReadInput,
} from './migration-target-scan-aws'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'
import {
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePage,
  createWorkspaceSearchMigrationTargetEvidencePageDigest,
  createWorkspaceSearchMigrationTargetEvidenceProgressDigest,
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  parseWorkspaceSearchMigrationTargetEvidencePage,
  replayWorkspaceSearchMigrationTargetEvidencePages,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceIdentity,
  type WorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
  type WorkspaceSearchMigrationTargetEvidenceReplayResult,
} from './migration-target-evidence'
import type {
  WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
  WorkspaceSearchMigrationPlanningTargetArtifactReference,
} from './migration-target-artifact'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityClock,
  workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex,
} from './migration-pre-plan-authority-aws'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
} from './migration-source-scan-context'
import {
  prepareWorkspaceSearchMigrationTargetScanContext,
  type WorkspaceSearchMigrationTargetScanAggregate,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import {
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
  validateWorkspaceSearchMigrationLease,
} from './migration-state-machine'

const targetEvidenceHeadKind =
  'workspace-search-migration-target-evidence-head'
const targetEvidencePageRecordKind =
  'workspace-search-migration-target-evidence-page-record'
const targetEvidenceAwsRecordVersion = 1
const planningTargetEvidenceChainVersion = 1
const targetEvidenceRecordKeyPrefix = 'target-evidence/v1'
/** Maximum replayable pages, bounding evidence to 1,000,000 target rows. */
export const WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT =
  10_000
/** Maximum number of strong page reads issued in one ordered prefetch wave. */
const targetEvidencePageReadConcurrency = 25

/**
 * Narrow DynamoDB transport used to read and atomically commit target evidence.
 */
export interface WorkspaceSearchMigrationTargetEvidenceAwsTransport {
  /**
   * Reads one exact evidence record with strong consistency.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getTargetEvidence(command: GetItemCommand): Promise<GetItemCommandOutput>

  /**
   * Revalidates the measured target and state incarnations after artifact
   * upload and immediately before the commit clock is sampled.
   *
   * Implementations must raise `TARGET_DRIFT` for target replacement or
   * deletion and `CONFIGURATION_DRIFT` for migration-state drift.
   */
  prepareTargetEvidenceWrite(): Promise<void>

  /**
   * Atomically writes one immutable page and its successor head.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteTargetEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Planning-only gateway that keeps raw Scan items inside the managed session.
 */
export interface WorkspaceSearchMigrationPlanningTargetArtifactGateway {
  /**
   * Captures one exact page, reduces it, and stores every lossless segment.
   *
   * @param input - Exact predecessor, identity, authority, and measured scan context.
   * @returns Digest evidence plus ordered immutable S3-version references.
   */
  captureAndStorePlanningPage(
    input: WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput,
  ): Promise<WorkspaceSearchMigrationPlanningTargetArtifactCaptureResult>

  /**
   * Reads and verifies every exact immutable segment for one committed page.
   *
   * @param input - Expected page identity, authority, and exact S3 references.
   * @returns Detached raw items without the restricted DynamoDB cursor.
   */
  readVerifiedPlanningPage(
    input: WorkspaceSearchMigrationPlanningTargetArtifactReadInput,
  ): Promise<WorkspaceSearchMigrationTargetScanPage>
}

/** Planning context required to capture and persist one raw target page. */
export type WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput =
  WorkspaceSearchMigrationTargetScanReadInput & {
    /** Operator-selected run owning the planning chain. */
    readonly runId: string
    /** One-based successor page sequence. */
    readonly pageSequence: number
    /** Digest of the exact predecessor evidence page. */
    readonly previousEvidenceDigest: string
    /** Digest of the exact predecessor checkpoint. */
    readonly previousCheckpointDigest: string
    /** Exact authority embedded in the artifact and planning evidence page. */
    readonly planningAuthority:
      WorkspaceSearchMigrationPlanningTargetArtifactAuthority
  }

/** Result of one same-page planning capture, reduction, and immutable upload. */
export type WorkspaceSearchMigrationPlanningTargetArtifactCaptureResult = {
  /** Digest-only reduction of the exact captured raw page. */
  readonly pageResult: WorkspaceSearchMigrationTargetScanPageResult
  /** Ordered exact immutable S3 versions for every raw page segment. */
  readonly targetArtifacts:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
}

/** Exact context required to read one already committed planning artifact page. */
export type WorkspaceSearchMigrationPlanningTargetArtifactReadInput =
  Omit<
    WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput,
    'previousCheckpoint'
  > & {
    /** Ordered exact immutable S3 versions bound into planning evidence v1. */
    readonly targetArtifacts:
      readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
  }

/**
 * Dependencies for one target-evidence AWS adapter.
 */
export type CreateWorkspaceSearchMigrationTargetEvidenceAwsPortInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Managed planning-only raw-page capture and immutable artifact gateway. */
  readonly planningArtifactGateway:
    WorkspaceSearchMigrationPlanningTargetArtifactGateway
  /** Narrow strongly-consistent read and transactional-write transport. */
  readonly transport: WorkspaceSearchMigrationTargetEvidenceAwsTransport
  /** Adapter-owned trusted clock sampled immediately before each write. */
  readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock
}

/**
 * Exact terminal planning head fixed by a later sealed-plan transaction.
 */
export type CreateWorkspaceSearchMigrationTargetTerminalHeadConditionCheckInput = {
  /** Exact measured migration-state table containing the durable head. */
  readonly stateTable: MigrationTableIdentity
  /** Exact completed planning-v1 target progress to condition-check. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
}

/**
 * Identity and configuration required to address one durable scan head.
 */
export type WorkspaceSearchMigrationTargetEvidenceAwsRequest = {
  /** Operator-selected run identifier separating independent evidence scans. */
  readonly runId: string
  /** Pre-plan workflow that owns this evidence chain. */
  readonly purpose: 'planning'
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
}

/**
 * Planning commit request authorized by one exact durable lease and receipt.
 */
export type WorkspaceSearchMigrationPlanningTargetEvidenceAwsCommitRequest =
  Omit<WorkspaceSearchMigrationTargetEvidenceAwsRequest, 'purpose'> & {
    /** Authority-bearing planning chain. */
    readonly purpose: 'planning'
    /** Exact pre-plan authority atomically revalidated by the commit. */
    readonly authority: WorkspaceSearchMigrationPrePlanAuthority
  }

/**
 * Exact request accepted by a target-evidence mutation.
 */
export type WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest =
  WorkspaceSearchMigrationPlanningTargetEvidenceAwsCommitRequest

/**
 * Durable target-evidence operations exposed to the migration workflow.
 */
export interface WorkspaceSearchMigrationTargetEvidenceAwsPort {
  /**
   * Reads the current durable progress or its canonical initial state.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Validated current progress.
   */
  readProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress>

  /**
   * Strongly reads and replays every immutable page at one captured head.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Globally validated row evidence and exact captured head.
   */
  readCommittedEvidence(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceReplayResult>

  /**
   * Reads exact planning-v1 artifacts at a caller-fixed durable progress.
   *
   * This operation deliberately does not reread the mutable durable head.
   * It is an internal managed-composition raw-material primitive; its result
   * cannot be used directly as production-gate or sealed-plan evidence.
   *
   * @param input - Exact planning evidence-chain identity and configuration.
   * @param expectedProgress - Detached progress captured before this read.
   * @param limits - Remaining row and canonical-item-byte budget.
   * @returns Verified bounded raw material for the fixed target chain.
   */
  readPlanningMaterialAtProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
    expectedProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
    limits: WorkspaceSearchMigrationPlanningMaterialReadLimits,
  ): Promise<WorkspaceSearchMigrationPlanningTargetChainMaterial>

  /**
   * Commits exactly one next target page, or returns completed progress.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Atomically committed successor progress.
   */
  commitNextPage(
    input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress>
}

/**
 * Validated request snapshot used across one adapter operation.
 */
type PreparedTargetEvidenceAwsRequest = {
  /** Exact detached evidence identity. */
  readonly identity: WorkspaceSearchMigrationTargetEvidenceIdentity
  /** Canonical initial progress for an absent head. */
  readonly initialProgress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Exact measured configuration supplied to the managed artifact gateway. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Exact reviewed configuration digest. */
  readonly configurationHash: string
  /** Detached durable authority required only by planning commits. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority | null
  /** Compact canonical authority embedded in planning page bytes. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority | null
}

/**
 * Result of reading the durable target-evidence head.
 */
type TargetEvidenceHeadRead =
  | {
      /** Indicates that no durable head exists yet. */
      readonly exists: false
    }
  | {
      /** Indicates that a validated durable head exists. */
      readonly exists: true
      /** Exact validated durable progress. */
      readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
      /** Payload schema version of the latest immutable page. */
      readonly latestEvidenceVersion: 1
      /** CAS-bound schema version for the complete chain. */
      readonly chainEvidenceVersion: 1
    }

/** Strictly parsed progress and required chain discriminator. */
type ParsedTargetEvidenceHeadItem = {
  /** Exact validated durable progress. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** CAS-bound complete-chain schema version. */
  readonly chainEvidenceVersion: 1
}

/**
 * Validated immutable page record used during response-loss reconciliation.
 */
type TargetEvidencePageRead = {
  /** Parsed strict page evidence. */
  readonly page: WorkspaceSearchMigrationTargetEvidencePage
  /** Exact serialized page bytes stored in DynamoDB. */
  readonly payload: Uint8Array
  /** Durable page revision. */
  readonly revision: number
  /** Digest of the strict page evidence. */
  readonly pageDigest: string
}

/**
 * Adapter-owned canonical commit clock captured after write preparation.
 */
type TargetEvidenceCommitClock = {
  /** Canonical UTC commit time. */
  readonly at: string
  /** Exact finite epoch milliseconds. */
  readonly epochMilliseconds: number
}

/**
 * Failure codes deliberately emitted by the private AWS adapter.
 */
type TargetEvidenceAwsFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_DRIFT'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_TARGET_ARTIFACT'
  | 'INVALID_STATE'
  | 'LEASE_LOST'
  | 'TARGET_DRIFT'
  | 'TABLE_SCHEMA_MISMATCH'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type TargetEvidenceAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Privately branded fixed-code failure for the target-evidence boundary.
 */
class TargetEvidenceAwsFailure extends Error {
  /** Stable operator-safe code chosen by trusted adapter logic. */
  readonly code: TargetEvidenceAwsFailureCode

  /**
   * Creates one fixed-code target-evidence failure.
   *
   * @param code - Stable operator-safe failure code.
   */
  constructor(code: TargetEvidenceAwsFailureCode) {
    super(code)
    this.name = 'TargetEvidenceAwsFailure'
    this.code = code
  }
}

/**
 * DynamoDB adapter committing digest-only row evidence and exact checkpoints.
 */
class AwsWorkspaceSearchMigrationTargetEvidencePort
  implements WorkspaceSearchMigrationTargetEvidenceAwsPort {
  /** Exact measured migration-state table incarnation. */
  private readonly stateTable: MigrationTableIdentity

  /** Planning-only lossless target artifact gateway. */
  private readonly planningArtifactGateway:
    WorkspaceSearchMigrationPlanningTargetArtifactGateway

  /** Narrow DynamoDB command transport. */
  private readonly transport: WorkspaceSearchMigrationTargetEvidenceAwsTransport

  /** Adapter-owned trusted clock sampled after write preparation. */
  private readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock

  /**
   * Creates an adapter bound to one exact state table and transport.
   *
   * @param input - Validated adapter dependencies.
   */
  constructor(
    input: CreateWorkspaceSearchMigrationTargetEvidenceAwsPortInput,
  ) {
    this.stateTable = structuredClone(input.stateTable)
    this.planningArtifactGateway = input.planningArtifactGateway
    this.transport = input.transport
    this.clock = input.clock
  }

  /**
   * Reads the current durable progress with strong consistency.
   *
   * @param input - Exact evidence-chain identity and configuration.
   * @returns Current durable or canonical initial progress.
   */
  async readProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    return runTargetEvidenceAwsBoundary(async () => {
      const request = prepareTargetEvidenceAwsRequest(
        input,
        this.stateTable,
        'read',
      )
      const current = await this.readHead(request)
      return current.exists
        ? current.progress
        : request.initialProgress
    })
  }

  /**
   * Strongly reads every immutable page and verifies the captured durable head.
   *
   * @param input - Exact evidence-chain identity and configuration.
   * @returns Replayed row evidence at one captured head revision.
   */
  async readCommittedEvidence(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceReplayResult> {
    return runTargetEvidenceAwsBoundary(async () => {
      const request = prepareTargetEvidenceAwsRequest(
        input,
        this.stateTable,
        'read',
      )
      const head = await this.readHead(request)
      const expectedProgress = head.exists
        ? head.progress
        : request.initialProgress
      return this.readAndReplayEvidenceAtProgress(
        request,
        expectedProgress,
      )
    })
  }

  /**
   * Reads bounded planning-v1 raw material at one caller-fixed progress.
   *
   * This internal managed-composition primitive does not by itself establish
   * production-gate or sealed-plan authority.
   *
   * @param input - Exact planning evidence-chain identity and configuration.
   * @param expectedProgress - Exact progress captured before this read.
   * @param limits - Remaining material budget for this chain.
   * @returns Verified raw target material without rereading the durable head.
   */
  async readPlanningMaterialAtProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
    expectedProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
    limits: WorkspaceSearchMigrationPlanningMaterialReadLimits,
  ): Promise<WorkspaceSearchMigrationPlanningTargetChainMaterial> {
    return runTargetEvidenceAwsBoundary(async () => {
      const request = prepareTargetEvidenceAwsRequest(
        input,
        this.stateTable,
        'read',
      )
      const progress = snapshotPlanningTargetExpectedProgress(
        expectedProgress,
        request.identity,
      )
      const readLimits = snapshotPlanningTargetMaterialReadLimits(limits)
      if (
        progress.checkpoint.aggregate.scanned >
          readLimits.maxRows
      ) {
        return failTargetEvidenceAws('INVALID_ARGUMENT')
      }
      const pages = await this.readEvidencePages(
        request,
        progress.pageSequence,
      )
      const replay = replayWorkspaceSearchMigrationTargetEvidencePages(
        request.identity,
        pages,
      )
      if (!targetEvidenceProgressEquals(replay.progress, progress)) {
        return failTargetEvidenceAws('INVALID_STATE')
      }
      const material = await this.readPlanningTargetMaterials(
        request,
        pages,
        readLimits,
      )
      return {
        progress: replay.progress,
        materials: material.materials,
        rowCount: material.rowCount,
        canonicalItemBytes: material.canonicalItemBytes,
      }
    })
  }

  /**
   * Scans and atomically commits exactly one next target page.
   *
   * @param input - Exact evidence-chain identity and configuration.
   * @returns Committed successor or already-completed progress.
   */
  async commitNextPage(
    input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    return runTargetEvidenceAwsBoundary(async () => {
      const request = prepareTargetEvidenceAwsRequest(
        input,
        this.stateTable,
        'commit',
      )
      const predecessorRead = await this.readHead(request)
      const predecessor = predecessorRead.exists
        ? predecessorRead.progress
        : request.initialProgress
      if (
        predecessorRead.exists &&
        (
          predecessorRead.latestEvidenceVersion !==
            planningTargetEvidenceChainVersion ||
          predecessorRead.chainEvidenceVersion !==
            planningTargetEvidenceChainVersion
        )
      ) {
        return failTargetEvidenceAws('INVALID_STATE')
      }
      if (predecessor.checkpoint.completed) return predecessor
      if (
        predecessor.pageSequence >=
          WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT
      ) {
        return failTargetEvidenceAws('INVALID_STATE')
      }

      const planningAuthority = request.planningAuthority
      if (planningAuthority === null) {
        return failTargetEvidenceAws('INVALID_STATE')
      }
      const captured =
        await this.planningArtifactGateway.captureAndStorePlanningPage({
          configuration: request.configuration,
          configurationHash: request.configurationHash,
          previousCheckpoint: predecessor.checkpoint,
          runId: request.identity.runId,
          pageSequence: predecessor.pageSequence + 1,
          previousEvidenceDigest: predecessor.evidenceDigest,
          previousCheckpointDigest:
            createWorkspaceSearchMigrationTargetCheckpointDigest(
              predecessor.checkpoint,
            ),
          planningAuthority,
        })
      const page = createWorkspaceSearchMigrationTargetEvidencePage({
        identity: request.identity,
        previousProgress: predecessor,
        pageResult: captured.pageResult,
        planningAuthority,
        targetArtifacts: captured.targetArtifacts,
      })
      const successor =
        advanceWorkspaceSearchMigrationTargetEvidenceProgress(
          predecessor,
          page,
        )
      requireTargetEvidencePageCountWithinLimit(successor.pageSequence)
      if (successor.checkpoint.cursor !== undefined) {
        const cursor = cloneWorkspaceSearchMigrationExactTableKey(
          successor.checkpoint.cursor,
          request.configuration.tables['workspace-search'],
        )
        if (!cursor.ok) return failTargetEvidenceAws(cursor.code)
      }
      if (successor.checkpoint.completed) {
        const committedPages = await this.readEvidencePages(
          request,
          predecessor.pageSequence,
        )
        await this.verifyPlanningArtifactPages(
          request,
          committedPages,
        )
        const replay = replayWorkspaceSearchMigrationTargetEvidencePages(
          request.identity,
          [...committedPages, page],
        )
        if (!targetEvidenceProgressEquals(replay.progress, successor)) {
          return failTargetEvidenceAws('INVALID_STATE')
        }
      }
      const pageRecordKey = createTargetEvidencePageRecordKey(
        request.identity,
        successor.pageSequence,
      )
      const pageItem = createTargetEvidencePageItem(
        request.identity,
        pageRecordKey,
        successor.pageSequence,
        page,
      )
      const successorHeadItem = createTargetEvidenceHeadItem(
        request.identity,
        createTargetEvidenceHeadRecordKey(request.identity),
        successor,
        page.evidenceVersion,
      )
      await this.prepareWrite()
      const authority = request.authority
      if (authority === null) {
        return failTargetEvidenceAws('INVALID_STATE')
      }
      const commitClock = readTargetEvidenceCommitClock(this.clock)
      const authorityConditionChecks =
        createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
          stateTable: this.stateTable,
          configurationHash: request.configurationHash,
          authority,
          commitAt: new Date(commitClock.epochMilliseconds),
        })
      const transaction = createTargetEvidenceCommitCommand({
        stateTableName: this.stateTable.tableName,
        predecessorRead,
        predecessor,
        pageRecordKey,
        pageItem,
        successor,
        successorHeadItem,
        authorityConditionChecks,
        commitClock,
      })

      try {
        await this.transport.transactWriteTargetEvidence(transaction)
      } catch (error: unknown) {
        return this.reconcileTransaction(
          request,
          predecessorRead,
          predecessor,
          pageRecordKey,
          page,
          successor,
          error,
        )
      }
      return successor
    })
  }

  /**
   * Runs the final target/state write preparation with drift classification.
   */
  private async prepareWrite(): Promise<void> {
    try {
      await this.transport.prepareTargetEvidenceWrite()
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return failTargetEvidenceAws('CONFIGURATION_DRIFT')
      }
      throw error
    }
  }

  /**
   * Reads one migration-state row while preserving its table role in errors.
   *
   * @param command - Exact strongly consistent state-table GetItem command.
   * @returns Raw low-level response for strict row parsing.
   */
  private async getStateEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    try {
      return await this.transport.getTargetEvidence(command)
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return failTargetEvidenceAws('CONFIGURATION_DRIFT')
      }
      throw error
    }
  }

  /**
   * Reads and validates one durable head through a strongly consistent GetItem.
   *
   * @param request - Prepared exact evidence-chain request.
   * @returns Absent marker or validated current progress.
   */
  private async readHead(
    request: PreparedTargetEvidenceAwsRequest,
  ): Promise<TargetEvidenceHeadRead> {
    const recordKey = createTargetEvidenceHeadRecordKey(request.identity)
    const output = await this.getStateEvidence(
      createStrongTargetEvidenceGetCommand(
        this.stateTable.tableName,
        recordKey,
      ),
    )
    if (output.Item === undefined) return { exists: false }
    const parsedHead = parseTargetEvidenceHeadItem(
      output.Item,
      recordKey,
      request,
    )
    const progress = parsedHead.progress
    if (progress.pageSequence === 0) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
    requireTargetEvidencePageCountWithinLimit(progress.pageSequence)
    const latestRecordKey = createTargetEvidencePageRecordKey(
      request.identity,
      progress.pageSequence,
    )
    const latestPage = await this.readPage(request, latestRecordKey)
    if (
      latestPage === undefined ||
      latestPage.revision !== progress.pageSequence ||
      latestPage.pageDigest !== progress.evidenceDigest ||
      parsedHead.chainEvidenceVersion !==
        latestPage.page.evidenceVersion ||
      createWorkspaceSearchMigrationTargetCheckpointDigest(
        latestPage.page.checkpoint,
      ) !==
        createWorkspaceSearchMigrationTargetCheckpointDigest(
          progress.checkpoint,
        )
    ) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
    return {
      exists: true,
      progress,
      latestEvidenceVersion: latestPage.page.evidenceVersion,
      chainEvidenceVersion: parsedHead.chainEvidenceVersion,
    }
  }

  /**
   * Reads and validates one immutable page through a strongly consistent GetItem.
   *
   * @param request - Prepared exact evidence-chain request.
   * @param recordKey - Deterministic page record key.
   * @returns Validated page record or undefined when absent.
   */
  private async readPage(
    request: PreparedTargetEvidenceAwsRequest,
    recordKey: string,
  ): Promise<TargetEvidencePageRead | undefined> {
    const output = await this.getStateEvidence(
      createStrongTargetEvidenceGetCommand(
        this.stateTable.tableName,
        recordKey,
      ),
    )
    if (output.Item === undefined) return undefined
    return parseTargetEvidencePageItem(
      output.Item,
      recordKey,
      request.identity,
    )
  }

  /**
   * Strongly reads a bounded immutable page prefix in sequence order.
   *
   * @param request - Prepared exact evidence-chain request.
   * @param pageCount - Captured number of committed pages to read.
   * @returns Strict ordered page documents.
   */
  private async readEvidencePages(
    request: PreparedTargetEvidenceAwsRequest,
    pageCount: number,
  ): Promise<WorkspaceSearchMigrationTargetEvidencePage[]> {
    requireTargetEvidencePageCountWithinLimit(pageCount)
    const pages: WorkspaceSearchMigrationTargetEvidencePage[] = []
    for (
      let batchStart = 1;
      batchStart <= pageCount;
      batchStart += targetEvidencePageReadConcurrency
    ) {
      const batchEnd = Math.min(
        pageCount,
        batchStart + targetEvidencePageReadConcurrency - 1,
      )
      const pageReads: Promise<TargetEvidencePageRead | undefined>[] = []
      for (
        let sequence = batchStart;
        sequence <= batchEnd;
        sequence += 1
      ) {
        const recordKey = createTargetEvidencePageRecordKey(
          request.identity,
          sequence,
        )
        pageReads.push(this.readPage(request, recordKey))
      }
      const pageBatch = await Promise.all(pageReads)
      for (let offset = 0; offset < pageBatch.length; offset += 1) {
        const sequence = batchStart + offset
        const page = pageBatch[offset]
        if (page === undefined || page.revision !== sequence) {
          return failTargetEvidenceAws('INVALID_STATE')
        }
        pages.push(page.page)
      }
    }
    return pages
  }

  /**
   * Reads and fully replays the immutable chain at one captured progress head.
   *
   * @param request - Prepared exact evidence-chain request.
   * @param expectedProgress - Exact captured head the replay must reconstruct.
   * @returns Globally validated replay output.
   */
  private async readAndReplayEvidenceAtProgress(
    request: PreparedTargetEvidenceAwsRequest,
    expectedProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceReplayResult> {
    const pages = await this.readEvidencePages(
      request,
      expectedProgress.pageSequence,
    )
    await this.verifyPlanningArtifactPages(request, pages)
    const replay = replayWorkspaceSearchMigrationTargetEvidencePages(
      request.identity,
      pages,
    )
    if (!targetEvidenceProgressEquals(
      replay.progress,
      expectedProgress,
    )) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
    return replay
  }

  /**
   * Reads and bounds every exact planning-v1 artifact page in chain order.
   *
   * @param request - Exact measured planning-chain request.
   * @param pages - Ordered durable target evidence pages.
   * @param limits - Detached remaining row and canonical-byte budget.
   * @returns Verified page materials and their exact retained size.
   */
  private async readPlanningTargetMaterials(
    request: PreparedTargetEvidenceAwsRequest,
    pages: readonly WorkspaceSearchMigrationTargetEvidencePage[],
    limits: WorkspaceSearchMigrationPlanningMaterialReadLimits,
  ): Promise<{
      /** Verified target materials in evidence-chain order. */
      readonly materials:
        readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[]
      /** Exact raw rows retained by the returned materials. */
      readonly rowCount: number
      /** Exact canonical UTF-8 item bytes retained by the materials. */
      readonly canonicalItemBytes: number
    }> {
    const materials: WorkspaceSearchMigrationPlanningTargetPageMaterial[] = []
    let progress = request.initialProgress
    let rowCount = 0
    let canonicalItemBytes = 0
    for (const page of pages) {
      const evidenceRowCount =
        page.targetRows.length + page.invalidRows.length
      if (evidenceRowCount > limits.maxRows - rowCount) {
        return failTargetEvidenceAws('INVALID_ARGUMENT')
      }
      const items = await this.verifyPlanningArtifactPage(
        request,
        progress,
        page,
      )
      if (items.length !== evidenceRowCount) {
        return failTargetEvidenceAws('INVALID_TARGET_ARTIFACT')
      }
      let pageCanonicalItemBytes = 0
      for (const item of items) {
        const itemBytes = Buffer.byteLength(
          serializeCanonicalAttributeMap(item),
          'utf8',
        )
        if (
          itemBytes >
            limits.maxCanonicalItemBytes -
              canonicalItemBytes -
              pageCanonicalItemBytes
        ) {
          return failTargetEvidenceAws('INVALID_ARGUMENT')
        }
        pageCanonicalItemBytes += itemBytes
      }
      materials.push({ page, items })
      rowCount += items.length
      canonicalItemBytes += pageCanonicalItemBytes
      progress =
        advanceWorkspaceSearchMigrationTargetEvidenceProgress(
          progress,
          page,
        )
    }
    return {
      materials,
      rowCount,
      canonicalItemBytes,
    }
  }

  /**
   * Verifies every artifact-bearing planning page against its exact transition.
   *
   * @param request - Exact measured chain request.
   * @param pages - Ordered validated durable evidence pages.
   */
  private async verifyPlanningArtifactPages(
    request: PreparedTargetEvidenceAwsRequest,
    pages: readonly WorkspaceSearchMigrationTargetEvidencePage[],
  ): Promise<void> {
    let progress = request.initialProgress
    for (const page of pages) {
      await this.verifyPlanningArtifactPage(request, progress, page)
      progress =
        advanceWorkspaceSearchMigrationTargetEvidenceProgress(
          progress,
          page,
        )
    }
  }

  /**
   * Re-reduces one exact immutable raw page and compares its full v1 evidence.
   *
   * @param request - Exact measured chain request.
   * @param predecessor - Exact predecessor progress.
   * @param page - Artifact-bearing planning v1 page.
   * @returns Verified detached raw items for the exact committed page.
   */
  private async verifyPlanningArtifactPage(
    request: PreparedTargetEvidenceAwsRequest,
    predecessor: WorkspaceSearchMigrationTargetEvidenceProgress,
    page: WorkspaceSearchMigrationTargetEvidencePage,
  ): Promise<readonly DynamoAttributeMap[]> {
    const rawPage =
      await this.planningArtifactGateway.readVerifiedPlanningPage({
        configuration: request.configuration,
        configurationHash: request.configurationHash,
        runId: page.runId,
        pageSequence: page.pageSequence,
        previousEvidenceDigest: page.previousEvidenceDigest,
        previousCheckpointDigest: page.previousCheckpointDigest,
        planningAuthority: page.planningAuthority,
        targetArtifacts: page.targetArtifacts,
      })
    if (rawPage.lastEvaluatedKey !== undefined) {
      return failTargetEvidenceAws('INVALID_TARGET_ARTIFACT')
    }
    const cursor = page.checkpoint.cursor
    if (
      page.checkpoint.completed
        ? cursor !== undefined
        : cursor === undefined
    ) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
    const reconstructedPage: WorkspaceSearchMigrationTargetScanPage =
      cursor === undefined
        ? { items: rawPage.items }
        : {
            items: rawPage.items,
            lastEvaluatedKey: cursor,
          }
    const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
      configuration: request.configuration,
      configurationHash: request.configurationHash,
      previousCheckpoint: predecessor.checkpoint,
      page: reconstructedPage,
    })
    const reconstructedEvidence =
      createWorkspaceSearchMigrationTargetEvidencePage({
        identity: request.identity,
        previousProgress: predecessor,
        pageResult,
        planningAuthority: page.planningAuthority,
        targetArtifacts: page.targetArtifacts,
      })
    if (
      !uint8ArraysEqual(
        serializeWorkspaceSearchMigrationTargetEvidencePage(
          reconstructedEvidence,
        ),
        serializeWorkspaceSearchMigrationTargetEvidencePage(page),
      )
    ) {
      return failTargetEvidenceAws('INVALID_TARGET_ARTIFACT')
    }
    return rawPage.items
  }

  /**
   * Resolves a failed transaction by strongly rereading both atomic records.
   *
   * @param request - Prepared exact evidence-chain request.
   * @param predecessorRead - Exact head state observed before the scan.
   * @param predecessor - Logical predecessor progress.
   * @param pageRecordKey - Deterministic immutable page key.
   * @param page - Exact intended page evidence.
   * @param successor - Exact intended successor progress.
   * @param transactionError - Raw transaction error retained only for classification.
   * @returns Exact successor only when both durable records prove success.
   */
  private async reconcileTransaction(
    request: PreparedTargetEvidenceAwsRequest,
    predecessorRead: TargetEvidenceHeadRead,
    predecessor: WorkspaceSearchMigrationTargetEvidenceProgress,
    pageRecordKey: string,
    page: WorkspaceSearchMigrationTargetEvidencePage,
    successor: WorkspaceSearchMigrationTargetEvidenceProgress,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    let currentHead: TargetEvidenceHeadRead
    let currentPage: TargetEvidencePageRead | undefined
    try {
      currentHead = await this.readHead(request)
      currentPage = await this.readPage(request, pageRecordKey)
    } catch (reconciliationError: unknown) {
      return failTargetEvidenceAws(
        isTargetEvidenceConfigurationDrift(reconciliationError)
          ? 'CONFIGURATION_DRIFT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }

    if (
      currentHead.exists &&
      currentPage !== undefined &&
      currentHead.chainEvidenceVersion === page.evidenceVersion &&
      targetEvidencePageReadEquals(currentPage, page, successor.pageSequence)
    ) {
      if (targetEvidenceProgressEquals(currentHead.progress, successor)) {
        try {
          await this.verifyPlanningArtifactPage(
            request,
            predecessor,
            page,
          )
        } catch (verificationError: unknown) {
          return failTargetEvidenceAws(
            isTargetEvidenceConfigurationDrift(verificationError)
              ? 'CONFIGURATION_DRIFT'
              : 'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        return successor
      }
      if (
        currentHead.progress.pageSequence > successor.pageSequence
      ) {
        try {
          await this.readAndReplayEvidenceAtProgress(
            request,
            currentHead.progress,
          )
        } catch (replayError: unknown) {
          return failTargetEvidenceAws(
            isTargetEvidenceConfigurationDrift(replayError)
              ? 'CONFIGURATION_DRIFT'
              : 'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        return successor
      }
    }

    if (
      targetEvidenceHeadReadEquals(
        currentHead,
        predecessorRead,
        predecessor,
      ) &&
      currentPage === undefined
    ) {
      return failTargetEvidenceAws(
        classifyTargetEvidenceTransactionError(transactionError),
      )
    }

    return failTargetEvidenceAws('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
}

/**
 * Creates one target-evidence AWS adapter.
 *
 * @param input - Exact state table, artifact gateway, clock, and transport.
 * @returns Durable target-evidence port.
 */
export function createAwsWorkspaceSearchMigrationTargetEvidencePort(
  input: CreateWorkspaceSearchMigrationTargetEvidenceAwsPortInput,
): WorkspaceSearchMigrationTargetEvidenceAwsPort {
  try {
    requireMigrationStateTableIdentity(input.stateTable)
    if (typeof input.clock !== 'function') {
      return failTargetEvidenceAws('INVALID_ARGUMENT')
    }
    requirePlanningTargetArtifactGateway(
      input.planningArtifactGateway,
    )
    requireTargetEvidenceAwsTransport(input.transport)
    return new AwsWorkspaceSearchMigrationTargetEvidencePort(input)
  } catch {
    throw createTargetEvidenceAwsBoundaryFailure('INVALID_ARGUMENT')
  }
}

/**
 * Creates one exact terminal planning-v1 target-head ConditionCheck.
 *
 * The returned item is intended for a later sealed-plan publication
 * transaction. It compares the complete durable identity, chain version,
 * terminal checkpoint, recursive head digest, and completion state.
 *
 * @param input - Exact measured state table and terminal target progress.
 * @returns One adapter-owned DynamoDB ConditionCheck transaction item.
 */
export function createWorkspaceSearchMigrationTargetTerminalHeadConditionCheck(
  input:
    CreateWorkspaceSearchMigrationTargetTerminalHeadConditionCheckInput,
): TransactWriteItem {
  try {
    const inputRecord = requireTargetEvidenceInputRecord(input)
    requireExactTargetEvidenceInputKeys(inputRecord, [
      'progress',
      'stateTable',
    ])
    const snapshot = structuredClone(input)
    requireMigrationStateTableIdentity(snapshot.stateTable)
    const progress = snapshot.progress
    void createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
      progress,
    )
    if (
      progress.purpose !== 'planning' ||
      progress.stateTableId !== snapshot.stateTable.tableId ||
      progress.pageSequence <= 0 ||
      !progress.checkpoint.completed ||
      progress.checkpoint.cursor !== undefined ||
      progress.checkpoint.aggregate.pageCount !==
        progress.pageSequence ||
      progress.checkpoint.aggregate.invalid !== 0
    ) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
    const identity: WorkspaceSearchMigrationTargetEvidenceIdentity = {
      purpose: 'planning',
      runId: progress.runId,
      configurationHash: progress.configurationHash,
      targetTableId: progress.targetTableId,
      stateTableId: progress.stateTableId,
    }
    const conditionCheck:
      NonNullable<TransactWriteItem['ConditionCheck']> = {
        TableName: snapshot.stateTable.tableName,
        Key: {
          migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
          recordKey: {
            S: createTargetEvidenceHeadRecordKey(identity),
          },
        },
        ConditionExpression: [
          '#kind = :kind',
          '#version = :version',
          '#run = :run',
          '#purpose = :purpose',
          '#config = :config',
          '#targetTableId = :targetTableId',
          '#stateTableId = :stateTableId',
          '#chainEvidenceVersion = :chainEvidenceVersion',
          '#revision = :revision',
          '#checkpoint = :checkpoint',
          '#checkpointDigest = :checkpointDigest',
          '#headDigest = :headDigest',
          '#completed = :completed',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#kind': 'kind',
          '#version': 'version',
          '#run': 'run',
          '#purpose': 'purpose',
          '#config': 'config',
          '#targetTableId': 'targetTableId',
          '#stateTableId': 'stateTableId',
          '#chainEvidenceVersion': 'chainEvidenceVersion',
          '#revision': 'revision',
          '#checkpoint': 'checkpoint',
          '#checkpointDigest': 'checkpointDigest',
          '#headDigest': 'headDigest',
          '#completed': 'completed',
        },
        ExpressionAttributeValues: {
          ':kind': { S: targetEvidenceHeadKind },
          ':version': { N: String(targetEvidenceAwsRecordVersion) },
          ':run': { S: progress.runId },
          ':purpose': { S: 'planning' },
          ':config': { S: progress.configurationHash },
          ':targetTableId': { S: progress.targetTableId },
          ':stateTableId': { S: progress.stateTableId },
          ':chainEvidenceVersion': {
            N: String(planningTargetEvidenceChainVersion),
          },
          ':revision': { N: String(progress.pageSequence) },
          ':checkpoint': encodeTargetEvidenceCheckpoint(
            progress.checkpoint,
          ),
          ':checkpointDigest': {
            S: createWorkspaceSearchMigrationTargetCheckpointDigest(
              progress.checkpoint,
            ),
          },
          ':headDigest': { S: progress.evidenceDigest },
          ':completed': { BOOL: true },
        },
      }
    return { ConditionCheck: conditionCheck }
  } catch (error: unknown) {
    throw createTargetEvidenceAwsBoundaryFailure(
      readTargetEvidenceAwsFailureCode(error),
    )
  }
}

/**
 * Values required to build one atomic page/head commit.
 */
type CreateTargetEvidenceCommitCommandInput = {
  /** Exact physical state table name. */
  readonly stateTableName: string
  /** Whether a physical predecessor head existed before the scan. */
  readonly predecessorRead: TargetEvidenceHeadRead
  /** Exact logical predecessor progress. */
  readonly predecessor: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Deterministic immutable page record key. */
  readonly pageRecordKey: string
  /** Complete immutable page item. */
  readonly pageItem: Readonly<Record<string, AttributeValue>>
  /** Exact successor progress. */
  readonly successor: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Complete successor head item. */
  readonly successorHeadItem: Readonly<Record<string, AttributeValue>>
  /** Planning-only lease, pointer, and receipt condition checks. */
  readonly authorityConditionChecks:
    readonly TransactWriteItem[]
  /** Planning commit clock bound into authority conditions and token. */
  readonly commitClock: TargetEvidenceCommitClock
}

/**
 * Validates and snapshots one public adapter request.
 *
 * @param input - Candidate request.
 * @param adapterStateTable - Adapter-bound physical state-table incarnation.
 * @returns Detached evidence identity and target capture context.
 */
function prepareTargetEvidenceAwsRequest(
  input:
    | WorkspaceSearchMigrationTargetEvidenceAwsRequest
    | WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  adapterStateTable: MigrationTableIdentity,
  operation: 'commit' | 'read',
): PreparedTargetEvidenceAwsRequest {
  const inputRecord = requireTargetEvidenceInputRecord(input)
  const hasAuthority = Object.prototype.hasOwnProperty.call(
    inputRecord,
    'authority',
  )
  requireExactTargetEvidenceInputKeys(
    inputRecord,
    hasAuthority
      ? [
          'authority',
          'configuration',
          'configurationHash',
          'purpose',
          'runId',
        ]
      : [
          'configuration',
          'configurationHash',
          'purpose',
          'runId',
        ],
  )
  if (operation === 'read' && hasAuthority) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  if (input.purpose !== 'planning') {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  const configuration = structuredClone(input.configuration)
  const configurationHash = input.configurationHash
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failTargetEvidenceAws('CONFIGURATION_HASH_MISMATCH')
  }
  const targetTable = configuration.tables['workspace-search']
  const stateTable = configuration.tables['migration-state']
  if (
    targetTable === undefined ||
    stateTable === undefined ||
    targetTable.role !== 'workspace-search' ||
    stateTable.role !== 'migration-state' ||
    !targetEvidenceStateTableIdentityMatches(
      stateTable,
      adapterStateTable,
    )
  ) {
    return failTargetEvidenceAws('IDENTITY_MISMATCH')
  }
  const identity: WorkspaceSearchMigrationTargetEvidenceIdentity = {
    purpose: input.purpose,
    runId: input.runId,
    configurationHash,
    targetTableId: targetTable.tableId,
    stateTableId: stateTable.tableId,
  }
  let authority: WorkspaceSearchMigrationPrePlanAuthority | null = null
  let planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority | null = null
  if (operation === 'commit') {
    if (!hasAuthority) {
      return failTargetEvidenceAws('INVALID_MAINTENANCE_EVIDENCE')
    }
    authority = snapshotTargetEvidencePrePlanAuthority(
      Reflect.get(input, 'authority'),
    )
    if (
      authority.configurationHash !== configurationHash ||
      authority.stateTableId !== stateTable.tableId ||
      authority.lease.runId !== identity.runId
    ) {
      return failTargetEvidenceAws('IDENTITY_MISMATCH')
    }
    planningAuthority = {
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
      maintenanceEvidencePointerRevision:
        authority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        authority.maintenanceEvidenceReceiptDigest,
    }
  }
  const initialProgress =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
  const preflight = prepareWorkspaceSearchMigrationTargetScanContext({
    configuration,
    configurationHash,
    previousCheckpoint: initialProgress.checkpoint,
  })
  if (!preflight.ok) return failTargetEvidenceAws(preflight.code)
  return {
    identity,
    initialProgress,
    configuration: preflight.context.configuration,
    configurationHash,
    authority,
    planningAuthority,
  }
}

/**
 * Creates the stable digest binding one evidence chain's durable keys.
 *
 * @param identity - Exact immutable evidence-chain identity.
 * @returns Lowercase SHA-256 identity digest.
 */
function createTargetEvidenceIdentityDigest(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-target-evidence-identity',
    version: targetEvidenceAwsRecordVersion,
    purpose: identity.purpose,
    runId: identity.runId,
    configurationHash: identity.configurationHash,
    targetTableId: identity.targetTableId,
    stateTableId: identity.stateTableId,
  })
}

/**
 * Creates the deterministic durable head key for one evidence chain.
 *
 * @param identity - Exact immutable evidence-chain identity.
 * @returns Bounded state-table sort key.
 */
function createTargetEvidenceHeadRecordKey(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): string {
  return `${targetEvidenceRecordKeyPrefix}/${createTargetEvidenceIdentityDigest(identity)}/head`
}

/**
 * Creates the deterministic immutable page key for one chain position.
 *
 * @param identity - Exact immutable evidence-chain identity.
 * @param revision - One-based successor page sequence.
 * @returns Bounded state-table sort key.
 */
function createTargetEvidencePageRecordKey(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
  revision: number,
): string {
  requirePositiveSafeInteger(revision)
  return `${targetEvidenceRecordKeyPrefix}/${createTargetEvidenceIdentityDigest(identity)}/page/${String(revision).padStart(16, '0')}`
}

/**
 * Creates one strongly consistent point read for an exact evidence record.
 *
 * @param stateTableName - Exact physical migration-state table name.
 * @param recordKey - Deterministic evidence record key.
 * @returns Adapter-owned GetItem command.
 */
function createStrongTargetEvidenceGetCommand(
  stateTableName: string,
  recordKey: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: stateTableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: { S: recordKey },
    },
  })
}

/**
 * Creates the complete successor head item.
 *
 * @param identity - Exact immutable evidence identity.
 * @param recordKey - Deterministic head record key.
 * @param progress - Exact successor progress.
 * @param chainEvidenceVersion - Schema version shared by the complete chain.
 * @returns Validated low-level DynamoDB item.
 */
function createTargetEvidenceHeadItem(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
  recordKey: string,
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
  chainEvidenceVersion: 1,
): Readonly<Record<string, AttributeValue>> {
  requireProgressIdentity(identity, progress)
  void createWorkspaceSearchMigrationTargetEvidenceProgressDigest(progress)
  if (chainEvidenceVersion !== planningTargetEvidenceChainVersion) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    kind: { S: targetEvidenceHeadKind },
    version: { N: String(targetEvidenceAwsRecordVersion) },
    run: { S: progress.runId },
    purpose: { S: progress.purpose },
    config: { S: progress.configurationHash },
    targetTableId: { S: progress.targetTableId },
    stateTableId: { S: progress.stateTableId },
    chainEvidenceVersion: { N: String(chainEvidenceVersion) },
    revision: { N: String(progress.pageSequence) },
    checkpointDigest: {
      S: createWorkspaceSearchMigrationTargetCheckpointDigest(
        progress.checkpoint,
      ),
    },
    headDigest: { S: progress.evidenceDigest },
    completed: { BOOL: progress.checkpoint.completed },
    checkpoint: encodeTargetEvidenceCheckpoint(progress.checkpoint),
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one immutable page item containing canonical exact evidence bytes.
 *
 * @param identity - Exact immutable evidence identity.
 * @param recordKey - Deterministic page record key.
 * @param revision - One-based page sequence.
 * @param page - Strict row evidence and exact checkpoint page.
 * @returns Validated low-level DynamoDB item.
 */
function createTargetEvidencePageItem(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
  recordKey: string,
  revision: number,
  page: WorkspaceSearchMigrationTargetEvidencePage,
): Readonly<Record<string, AttributeValue>> {
  const payload =
    serializeWorkspaceSearchMigrationTargetEvidencePage(page)
  const pageDigest =
    createWorkspaceSearchMigrationTargetEvidencePageDigest(page)
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    kind: { S: targetEvidencePageRecordKind },
    version: { N: String(targetEvidenceAwsRecordVersion) },
    identityDigest: {
      S: createTargetEvidenceIdentityDigest(identity),
    },
    revision: { N: String(revision) },
    pageDigest: { S: pageDigest },
    payload: { B: payload },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates the atomic immutable-page and CAS-head transaction.
 *
 * @param input - Exact predecessor and successor transaction material.
 * @returns Adapter-owned TransactWriteItems command.
 */
function createTargetEvidenceCommitCommand(
  input: CreateTargetEvidenceCommitCommandInput,
): TransactWriteItemsCommand {
  if (
    input.authorityConditionChecks.length !==
      workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex.count
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const headCondition = input.predecessorRead.exists
    ? createExistingHeadCondition(
        input.predecessor,
        input.predecessorRead.chainEvidenceVersion,
      )
    : createAbsentHeadCondition()
  const transactionToken = createTargetEvidenceTransactionToken(
    input.predecessor,
    input.successor,
    input.pageRecordKey,
    input.commitClock,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: transactionToken,
    TransactItems: [
      ...input.authorityConditionChecks,
      {
        Put: {
          TableName: input.stateTableName,
          Item: input.pageItem,
          ConditionExpression:
            'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
          ExpressionAttributeNames: {
            '#migrationId': 'migrationId',
            '#recordKey': 'recordKey',
          },
        },
      },
      {
        Put: {
          TableName: input.stateTableName,
          Item: input.successorHeadItem,
          ConditionExpression: headCondition.expression,
          ExpressionAttributeNames: headCondition.names,
          ExpressionAttributeValues: headCondition.values,
        },
      },
    ],
  })
}

/**
 * DynamoDB condition material for one head replacement.
 */
type TargetEvidenceHeadCondition = {
  /** Exact conditional expression. */
  readonly expression: string
  /** Attribute-name aliases used by the condition. */
  readonly names: Readonly<Record<string, string>>
  /** Exact expected predecessor values, when a head exists. */
  readonly values?: Readonly<Record<string, AttributeValue>>
}

/**
 * Creates the conditional expression for the first head.
 *
 * @returns Attribute-absence condition with no value operands.
 */
function createAbsentHeadCondition(): TargetEvidenceHeadCondition {
  return {
    expression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    names: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
  }
}

/**
 * Creates the complete exact-predecessor CAS for an existing head.
 *
 * @param predecessor - Exact validated predecessor progress.
 * @param chainEvidenceVersion - Persisted v1 chain discriminator.
 * @returns Full kind, identity, revision, digest, and completion condition.
 */
function createExistingHeadCondition(
  predecessor: WorkspaceSearchMigrationTargetEvidenceProgress,
  chainEvidenceVersion: 1,
): TargetEvidenceHeadCondition {
  if (predecessor.checkpoint.completed) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return {
    expression: [
      '#kind = :kind',
      '#version = :version',
      '#run = :run',
      '#purpose = :purpose',
      '#config = :config',
      '#targetTableId = :targetTableId',
      '#stateTableId = :stateTableId',
      '#revision = :revision',
      '#checkpoint = :checkpoint',
      '#checkpointDigest = :checkpointDigest',
      '#headDigest = :headDigest',
      '#completed = :completed',
      '#chainEvidenceVersion = :chainEvidenceVersion',
    ].join(' AND '),
    names: {
      '#kind': 'kind',
      '#version': 'version',
      '#run': 'run',
      '#purpose': 'purpose',
      '#config': 'config',
      '#targetTableId': 'targetTableId',
      '#stateTableId': 'stateTableId',
      '#revision': 'revision',
      '#checkpoint': 'checkpoint',
      '#checkpointDigest': 'checkpointDigest',
      '#headDigest': 'headDigest',
      '#completed': 'completed',
      '#chainEvidenceVersion': 'chainEvidenceVersion',
    },
    values: {
      ':kind': { S: targetEvidenceHeadKind },
      ':version': { N: String(targetEvidenceAwsRecordVersion) },
      ':run': { S: predecessor.runId },
      ':purpose': { S: predecessor.purpose },
      ':config': { S: predecessor.configurationHash },
      ':targetTableId': { S: predecessor.targetTableId },
      ':stateTableId': { S: predecessor.stateTableId },
      ':revision': { N: String(predecessor.pageSequence) },
      ':checkpoint': encodeTargetEvidenceCheckpoint(
        predecessor.checkpoint,
      ),
      ':checkpointDigest': {
        S: createWorkspaceSearchMigrationTargetCheckpointDigest(
          predecessor.checkpoint,
        ),
      },
      ':headDigest': { S: predecessor.evidenceDigest },
      ':completed': { BOOL: false },
      ':chainEvidenceVersion': {
        N: String(chainEvidenceVersion),
      },
    },
  }
}

/**
 * Creates one deterministic idempotency token that remains within DynamoDB's
 * 36-character `ClientRequestToken` limit.
 *
 * @param predecessor - Exact predecessor progress.
 * @param successor - Exact intended successor progress.
 * @param pageRecordKey - Deterministic immutable page record key.
 * @param commitClock - Planning clock that shaped authority conditions.
 * @returns Stable token of at most 36 ASCII characters.
 */
function createTargetEvidenceTransactionToken(
  predecessor: WorkspaceSearchMigrationTargetEvidenceProgress,
  successor: WorkspaceSearchMigrationTargetEvidenceProgress,
  pageRecordKey: string,
  commitClock: TargetEvidenceCommitClock,
): string {
  if (successor.purpose !== 'planning') {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const digest = createMigrationDigest({
    kind: 'workspace-search-target-evidence-commit',
    version: targetEvidenceAwsRecordVersion,
    predecessor:
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(predecessor),
    successor:
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(successor),
    pageRecordKey,
    authorityConditionEpochMilliseconds:
      commitClock.epochMilliseconds,
  })
  const token = `wsm1-${digest.slice(0, 31)}`
  if (token.length > 36) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return token
}

/**
 * Parses and validates one durable evidence head item.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expectedRecordKey - Exact deterministic head key.
 * @param request - Exact requested identity and measured scan context.
 * @returns Detached validated progress and required v1 chain discriminator.
 */
function parseTargetEvidenceHeadItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  request: PreparedTargetEvidenceAwsRequest,
): ParsedTargetEvidenceHeadItem {
  const item = cloneTargetEvidenceItem(rawItem)
  requireExactItemKeys(item, [
    'chainEvidenceVersion',
    'checkpoint',
    'checkpointDigest',
    'completed',
    'config',
    'headDigest',
    'kind',
    'migrationId',
    'purpose',
    'recordKey',
    'revision',
    'run',
    'targetTableId',
    'stateTableId',
    'version',
  ])
  if (
    readRequiredStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readRequiredStringAttribute(item, 'recordKey') !==
      expectedRecordKey ||
    readRequiredStringAttribute(item, 'kind') !==
      targetEvidenceHeadKind ||
    readRequiredNaturalNumberAttribute(item, 'version') !==
      targetEvidenceAwsRecordVersion
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const chainEvidenceVersion =
    readRequiredPositiveNumberAttribute(item, 'chainEvidenceVersion')
  if (chainEvidenceVersion !== planningTargetEvidenceChainVersion) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  requireHeadIdentity(item, request.identity)
  const checkpoint = decodeTargetEvidenceCheckpoint(
    readRequiredMapAttribute(item, 'checkpoint'),
  )
  const checkpointDigest =
    createWorkspaceSearchMigrationTargetCheckpointDigest(checkpoint)
  if (
    readRequiredStringAttribute(item, 'checkpointDigest') !==
      checkpointDigest ||
    readRequiredBooleanAttribute(item, 'completed') !==
      checkpoint.completed
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const progress: WorkspaceSearchMigrationTargetEvidenceProgress = {
    purpose: request.identity.purpose,
    runId: request.identity.runId,
    configurationHash: request.identity.configurationHash,
    targetTableId: request.identity.targetTableId,
    stateTableId: request.identity.stateTableId,
    pageSequence:
      readRequiredNaturalNumberAttribute(item, 'revision'),
    evidenceDigest: readRequiredStringAttribute(item, 'headDigest'),
    checkpoint,
  }
  void createWorkspaceSearchMigrationTargetEvidenceProgressDigest(progress)
  if (checkpoint.completed) {
    return { progress, chainEvidenceVersion }
  }
  const context = prepareWorkspaceSearchMigrationTargetScanContext({
    configuration: request.configuration,
    configurationHash: request.configurationHash,
    previousCheckpoint: checkpoint,
  })
  if (!context.ok) return failTargetEvidenceAws(context.code)
  return {
    progress: {
      ...progress,
      checkpoint: context.context.previousCheckpoint,
    },
    chainEvidenceVersion,
  }
}

/**
 * Parses and validates one immutable page record item.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expectedRecordKey - Exact deterministic page key.
 * @param identity - Exact requested evidence identity.
 * @returns Detached strict page record.
 */
function parseTargetEvidencePageItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): TargetEvidencePageRead {
  const item = cloneTargetEvidenceItem(rawItem)
  requireExactItemKeys(item, [
    'identityDigest',
    'kind',
    'migrationId',
    'pageDigest',
    'payload',
    'recordKey',
    'revision',
    'version',
  ])
  if (
    readRequiredStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readRequiredStringAttribute(item, 'recordKey') !==
      expectedRecordKey ||
    readRequiredStringAttribute(item, 'kind') !==
      targetEvidencePageRecordKind ||
    readRequiredNaturalNumberAttribute(item, 'version') !==
      targetEvidenceAwsRecordVersion ||
    readRequiredStringAttribute(item, 'identityDigest') !==
      createTargetEvidenceIdentityDigest(identity)
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const revision =
    readRequiredPositiveNumberAttribute(item, 'revision')
  if (
    createTargetEvidencePageRecordKey(identity, revision) !==
      expectedRecordKey
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const payload = readRequiredBinaryAttribute(item, 'payload')
  const page =
    parseWorkspaceSearchMigrationTargetEvidencePage(payload)
  const pageDigest =
    createWorkspaceSearchMigrationTargetEvidencePageDigest(page)
  if (
    readRequiredStringAttribute(item, 'pageDigest') !== pageDigest ||
    page.pageSequence !== revision ||
    !targetEvidencePageHasIdentity(page, identity)
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return {
    page,
    payload,
    revision,
    pageDigest,
  }
}

/**
 * Encodes one checkpoint as a strict native DynamoDB document.
 *
 * @param checkpoint - Exact validated cumulative checkpoint.
 * @returns Low-level DynamoDB map attribute.
 */
function encodeTargetEvidenceCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): AttributeValue {
  validateWorkspaceSearchMigrationTargetScanCheckpoint(checkpoint)
  const aggregate = checkpoint.aggregate
  const map: Record<string, AttributeValue> = {
    configurationHash: { S: checkpoint.configurationHash },
    completed: { BOOL: checkpoint.completed },
    aggregate: {
      M: {
        scanned: { N: String(aggregate.scanned) },
        owned: { N: String(aggregate.owned) },
        ignored: { N: String(aggregate.ignored) },
        invalid: { N: String(aggregate.invalid) },
        pageCount: { N: String(aggregate.pageCount) },
        keyDigest: { S: aggregate.keyDigest },
        contentDigest: { S: aggregate.contentDigest },
      },
    },
    keyDigestState: encodeTargetEvidenceDigestState(
      checkpoint.keyDigestState,
    ),
    contentDigestState: encodeTargetEvidenceDigestState(
      checkpoint.contentDigestState,
    ),
  }
  if (checkpoint.cursor !== undefined) {
    map.cursor = {
      M: decodeAttributeMap(encodeAttributeMap(checkpoint.cursor)),
    }
  }
  return { M: map }
}

/**
 * Encodes one order-independent digest accumulator state.
 *
 * @param state - Exact validated digest state.
 * @returns Low-level DynamoDB map attribute.
 */
function encodeTargetEvidenceDigestState(
  state: MigrationDigestState,
): AttributeValue {
  return {
    M: {
      count: { N: String(state.count) },
      sumHex: { S: state.sumHex },
      xorHex: { S: state.xorHex },
    },
  }
}

/**
 * Decodes and validates one strict checkpoint document.
 *
 * @param map - Detached low-level DynamoDB checkpoint map.
 * @returns Exact validated checkpoint.
 */
function decodeTargetEvidenceCheckpoint(
  map: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  requireExactItemKeys(
    map,
    [
      'aggregate',
      'completed',
      'configurationHash',
      'contentDigestState',
      'keyDigestState',
    ],
    ['cursor'],
  )
  const checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint = {
    configurationHash:
      readRequiredStringAttribute(map, 'configurationHash'),
    completed: readRequiredBooleanAttribute(map, 'completed'),
    aggregate: decodeTargetEvidenceAggregate(
      readRequiredMapAttribute(map, 'aggregate'),
    ),
    keyDigestState: decodeTargetEvidenceDigestState(
      readRequiredMapAttribute(map, 'keyDigestState'),
    ),
    contentDigestState: decodeTargetEvidenceDigestState(
      readRequiredMapAttribute(map, 'contentDigestState'),
    ),
    ...(map.cursor === undefined
      ? {}
      : {
          cursor: cloneTargetEvidenceCursor(
            readRequiredMapAttribute(map, 'cursor'),
          ),
        }),
  }
  validateWorkspaceSearchMigrationTargetScanCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Decodes one strict cumulative scan aggregate.
 *
 * @param map - Detached low-level DynamoDB aggregate map.
 * @returns Exact cumulative aggregate.
 */
function decodeTargetEvidenceAggregate(
  map: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationTargetScanAggregate {
  requireExactItemKeys(map, [
    'contentDigest',
    'ignored',
    'invalid',
    'keyDigest',
    'owned',
    'pageCount',
    'scanned',
  ])
  return {
    scanned: readRequiredNaturalNumberAttribute(map, 'scanned'),
    owned: readRequiredNaturalNumberAttribute(map, 'owned'),
    ignored: readRequiredNaturalNumberAttribute(map, 'ignored'),
    invalid: readRequiredNaturalNumberAttribute(map, 'invalid'),
    pageCount: readRequiredNaturalNumberAttribute(map, 'pageCount'),
    keyDigest: readRequiredStringAttribute(map, 'keyDigest'),
    contentDigest: readRequiredStringAttribute(map, 'contentDigest'),
  }
}

/**
 * Decodes one strict order-independent digest accumulator state.
 *
 * @param map - Detached low-level DynamoDB digest-state map.
 * @returns Exact accumulator state.
 */
function decodeTargetEvidenceDigestState(
  map: Readonly<Record<string, AttributeValue>>,
): MigrationDigestState {
  requireExactItemKeys(map, ['count', 'sumHex', 'xorHex'])
  return {
    count: readRequiredNaturalNumberAttribute(map, 'count'),
    sumHex: readRequiredStringAttribute(map, 'sumHex'),
    xorHex: readRequiredStringAttribute(map, 'xorHex'),
  }
}

/**
 * Detaches one low-level checkpoint cursor through the lossless codec.
 *
 * @param map - Candidate nested DynamoDB attribute map.
 * @returns Detached exact cursor.
 */
function cloneTargetEvidenceCursor(
  map: Readonly<Record<string, AttributeValue>>,
): DynamoAttributeMap {
  return decodeAttributeMap(encodeAttributeMap(map))
}

/**
 * Detaches and validates one complete untrusted DynamoDB item.
 *
 * @param item - Raw SDK response item.
 * @returns Strict detached low-level item.
 */
function cloneTargetEvidenceItem(
  item: unknown,
): Record<string, AttributeValue> {
  const detached =
    decodeAttributeMap(encodeUnknownAttributeMap(item))
  validateDynamoDbItemSize(detached)
  return detached
}

/**
 * Verifies that a head item carries the exact requested identity.
 *
 * @param item - Strict detached head item.
 * @param identity - Exact requested evidence identity.
 */
function requireHeadIdentity(
  item: Readonly<Record<string, AttributeValue>>,
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): void {
  if (
    readRequiredStringAttribute(item, 'run') !== identity.runId ||
    readRequiredStringAttribute(item, 'purpose') !== identity.purpose ||
    readRequiredStringAttribute(item, 'config') !==
      identity.configurationHash ||
    readRequiredStringAttribute(item, 'targetTableId') !==
      identity.targetTableId ||
    readRequiredStringAttribute(item, 'stateTableId') !==
      identity.stateTableId
  ) {
    return failTargetEvidenceAws('IDENTITY_MISMATCH')
  }
}

/**
 * Verifies that progress carries the exact requested identity.
 *
 * @param identity - Exact requested evidence identity.
 * @param progress - Candidate progress.
 */
function requireProgressIdentity(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
): void {
  if (
    progress.purpose !== identity.purpose ||
    progress.runId !== identity.runId ||
    progress.configurationHash !== identity.configurationHash ||
    progress.targetTableId !== identity.targetTableId ||
    progress.stateTableId !== identity.stateTableId
  ) {
    return failTargetEvidenceAws('IDENTITY_MISMATCH')
  }
}

/**
 * Strictly snapshots one caller-fixed planning target progress before I/O.
 *
 * @param value - Candidate progress captured by the managed composition.
 * @param identity - Exact planning target chain being materialized.
 * @returns Detached validated progress bound to the requested chain.
 */
function snapshotPlanningTargetExpectedProgress(
  value: WorkspaceSearchMigrationTargetEvidenceProgress,
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  const record = requireTargetEvidenceInputRecord(value)
  requireExactTargetEvidenceInputKeys(record, [
    'checkpoint',
    'configurationHash',
    'evidenceDigest',
    'pageSequence',
    'purpose',
    'runId',
    'stateTableId',
    'targetTableId',
  ])
  let progress: WorkspaceSearchMigrationTargetEvidenceProgress
  try {
    progress = structuredClone(value)
    void createWorkspaceSearchMigrationTargetEvidenceProgressDigest(progress)
  } catch {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  requireProgressIdentity(identity, progress)
  if (
    progress.pageSequence >
      WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return progress
}

/**
 * Strictly snapshots one remaining planning-material budget before I/O.
 *
 * @param value - Candidate remaining row and canonical-byte limits.
 * @returns Detached non-negative safe-integer limits.
 */
function snapshotPlanningTargetMaterialReadLimits(
  value: WorkspaceSearchMigrationPlanningMaterialReadLimits,
): WorkspaceSearchMigrationPlanningMaterialReadLimits {
  const record = requireTargetEvidenceInputRecord(value)
  requireExactTargetEvidenceInputKeys(record, [
    'maxCanonicalItemBytes',
    'maxRows',
  ])
  const maxRows = readPlanningTargetMaterialLimit(
    record,
    'maxRows',
  )
  const maxCanonicalItemBytes = readPlanningTargetMaterialLimit(
    record,
    'maxCanonicalItemBytes',
  )
  return {
    maxRows,
    maxCanonicalItemBytes,
  }
}

/**
 * Reads one non-negative safe integer from an own enumerable data descriptor.
 *
 * @param record - Exact limits record already checked for its own key set.
 * @param property - Fixed material-limit property to read.
 * @returns Detached validated scalar without invoking an accessor.
 */
function readPlanningTargetMaterialLimit(
  record: object,
  property: 'maxCanonicalItemBytes' | 'maxRows',
): number {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, property)
  } catch {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  const candidate: unknown = descriptor.value
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return candidate
}

/**
 * Compares immutable state-table incarnation fields across adapter and request.
 *
 * Mutable PITR windows are intentionally excluded because they advance while
 * the same physical table remains authoritative.
 *
 * @param requested - State identity carried by the measured configuration.
 * @param adapter - State identity captured when the adapter was constructed.
 * @returns Whether both identify the exact same physical table incarnation.
 */
function targetEvidenceStateTableIdentityMatches(
  requested: MigrationTableIdentity,
  adapter: MigrationTableIdentity,
): boolean {
  return requested.role === 'migration-state' &&
    adapter.role === 'migration-state' &&
    requested.tableName === adapter.tableName &&
    requested.tableArn === adapter.tableArn &&
    requested.tableId === adapter.tableId &&
    requested.creationTime === adapter.creationTime &&
    requested.account === adapter.account &&
    requested.region === adapter.region
}

/**
 * Tests whether one page carries an exact evidence-chain identity.
 *
 * @param page - Strict parsed page evidence.
 * @param identity - Exact requested evidence identity.
 * @returns Whether every immutable identity field matches.
 */
function targetEvidencePageHasIdentity(
  page: WorkspaceSearchMigrationTargetEvidencePage,
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): boolean {
  return page.purpose === identity.purpose &&
    page.runId === identity.runId &&
    page.configurationHash === identity.configurationHash &&
    page.targetTableId === identity.targetTableId &&
    page.stateTableId === identity.stateTableId
}

/**
 * Compares two validated progress heads by their exact CAS fingerprint.
 *
 * @param left - First progress head.
 * @param right - Second progress head.
 * @returns Whether both represent the exact same progress.
 */
function targetEvidenceProgressEquals(
  left: WorkspaceSearchMigrationTargetEvidenceProgress,
  right: WorkspaceSearchMigrationTargetEvidenceProgress,
): boolean {
  return createWorkspaceSearchMigrationTargetEvidenceProgressDigest(left) ===
    createWorkspaceSearchMigrationTargetEvidenceProgressDigest(right)
}

/**
 * Compares a reconciliation page read with the exact intended page.
 *
 * @param read - Validated durable page read.
 * @param expected - Exact intended page.
 * @param expectedRevision - Exact intended successor revision.
 * @returns Whether the record contains byte-identical intended evidence.
 */
function targetEvidencePageReadEquals(
  read: TargetEvidencePageRead,
  expected: WorkspaceSearchMigrationTargetEvidencePage,
  expectedRevision: number,
): boolean {
  if (
    read.revision !== expectedRevision ||
    read.pageDigest !==
      createWorkspaceSearchMigrationTargetEvidencePageDigest(expected)
  ) {
    return false
  }
  const expectedPayload =
    serializeWorkspaceSearchMigrationTargetEvidencePage(expected)
  return uint8ArraysEqual(read.payload, expectedPayload)
}

/**
 * Compares a reconciliation head read with its exact pre-transaction state.
 *
 * @param current - Strongly reread current head.
 * @param before - Physical existence observed before the transaction.
 * @param predecessor - Exact logical predecessor.
 * @returns Whether the durable head demonstrably remained unchanged.
 */
function targetEvidenceHeadReadEquals(
  current: TargetEvidenceHeadRead,
  before: TargetEvidenceHeadRead,
  predecessor: WorkspaceSearchMigrationTargetEvidenceProgress,
): boolean {
  if (!before.exists) return !current.exists
  return current.exists &&
    current.chainEvidenceVersion === before.chainEvidenceVersion &&
    current.latestEvidenceVersion === before.latestEvidenceVersion &&
    targetEvidenceProgressEquals(current.progress, predecessor)
}

/**
 * Compares two byte arrays without decoding their contents.
 *
 * @param left - First byte sequence.
 * @param right - Second byte sequence.
 * @returns Whether both have exactly the same bytes.
 */
function uint8ArraysEqual(
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
 * Requires an item to contain exactly the allowed attributes.
 *
 * @param item - Strict detached low-level map.
 * @param required - Required attribute names.
 * @param optional - Optional attribute names.
 */
function requireExactItemKeys(
  item: Readonly<Record<string, AttributeValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(item).sort()
  const requiredSet = new Set(required)
  const optionalSet = new Set(optional)
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(item, name)) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
  }
  for (const key of keys) {
    if (!requiredSet.has(key) && !optionalSet.has(key)) {
      return failTargetEvidenceAws('INVALID_STATE')
    }
  }
}

/**
 * Reads one required exact string attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readRequiredStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = item[name]
  if (
    value === undefined ||
    value.S === undefined ||
    Object.keys(value).length !== 1
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return value.S
}

/**
 * Reads one required exact Boolean attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Exact Boolean value.
 */
function readRequiredBooleanAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): boolean {
  const value = item[name]
  if (
    value === undefined ||
    value.BOOL === undefined ||
    Object.keys(value).length !== 1
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return value.BOOL
}

/**
 * Reads one required exact map attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Exact nested map.
 */
function readRequiredMapAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Readonly<Record<string, AttributeValue>> {
  const value = item[name]
  if (
    value === undefined ||
    value.M === undefined ||
    Object.keys(value).length !== 1
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return value.M
}

/**
 * Reads one required exact binary attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Detached exact bytes.
 */
function readRequiredBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const value = item[name]
  if (
    value === undefined ||
    value.B === undefined ||
    Object.keys(value).length !== 1
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return new Uint8Array(value.B)
}

/**
 * Reads one required nonnegative safe-integer number attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Exact nonnegative safe integer.
 */
function readRequiredNaturalNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const value = item[name]
  if (
    value === undefined ||
    value.N === undefined ||
    Object.keys(value).length !== 1 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.N)
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  const parsed = Number(value.N)
  if (!Number.isSafeInteger(parsed)) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one required positive safe-integer number attribute.
 *
 * @param item - Strict detached low-level map.
 * @param name - Required attribute name.
 * @returns Exact positive safe integer.
 */
function readRequiredPositiveNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const value = readRequiredNaturalNumberAttribute(item, name)
  requirePositiveSafeInteger(value)
  return value
}

/**
 * Requires one positive safe integer.
 *
 * @param value - Candidate positive integer.
 */
function requirePositiveSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
}

/**
 * Rejects evidence chains whose replay could exceed the operational bound.
 *
 * @param pageCount - Captured or proposed evidence page count.
 */
function requireTargetEvidencePageCountWithinLimit(
  pageCount: number,
): void {
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 0 ||
    pageCount >
      WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
}

/**
 * Detaches and validates planning authority before the operation's first await.
 *
 * Commit-time freshness and durable currentness are deliberately revalidated
 * after the final state-incarnation guard. This snapshot prevents caller
 * mutation during the preceding reads and target scan from changing the
 * authority that the transaction eventually checks.
 *
 * @param value - Candidate caller-owned authority aggregate.
 * @returns Exact detached authority material.
 */
function snapshotTargetEvidencePrePlanAuthority(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  const record = requireTargetEvidenceInputRecord(value)
  requireExactTargetEvidenceInputKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  const lease = snapshotTargetEvidenceAuthorityLease(
    Reflect.get(record, 'lease'),
  )
  const receipt = snapshotTargetEvidenceAuthorityReceipt(
    Reflect.get(record, 'maintenanceEvidenceReceipt'),
  )
  const receiptDigest = readTargetEvidenceInputDigest(
    Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
  )
  const pointerRevision = readTargetEvidencePositiveSafeInteger(
    Reflect.get(record, 'maintenanceEvidencePointerRevision'),
  )
  if (
    receipt.runId !== lease.runId ||
    receipt.fenceToken !== lease.fenceToken ||
    receiptDigest !== createMigrationDigest(receipt)
  ) {
    return failTargetEvidenceAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  return {
    configurationHash: readTargetEvidenceInputDigest(
      Reflect.get(record, 'configurationHash'),
    ),
    stateTableId: readTargetEvidenceBoundedText(
      Reflect.get(record, 'stateTableId'),
      1_024,
    ),
    lease,
    maintenanceEvidenceReceiptDigest: receiptDigest,
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'evaluatedAt'),
    ),
  }
}

/**
 * Detaches one complete lease embedded in a planning-authority aggregate.
 *
 * @param value - Candidate caller-owned lease.
 * @returns Exact validated lease.
 */
function snapshotTargetEvidenceAuthorityLease(
  value: unknown,
): WorkspaceSearchMigrationLease {
  const record = requireTargetEvidenceInputRecord(value)
  requireExactTargetEvidenceInputKeys(record, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  const lease: WorkspaceSearchMigrationLease = {
    runId: readTargetEvidenceMigrationIdentifier(
      Reflect.get(record, 'runId'),
    ),
    ownerId: readTargetEvidenceMigrationIdentifier(
      Reflect.get(record, 'ownerId'),
    ),
    fenceToken: readTargetEvidencePositiveSafeInteger(
      Reflect.get(record, 'fenceToken'),
    ),
    expiresAt: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'expiresAt'),
    ),
    heartbeatAt: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'heartbeatAt'),
    ),
  }
  validateWorkspaceSearchMigrationLease(lease)
  return lease
}

/**
 * Detaches one complete receipt embedded in planning authority.
 *
 * @param value - Candidate caller-owned maintenance receipt.
 * @returns Exact validated receipt.
 */
function snapshotTargetEvidenceAuthorityReceipt(
  value: unknown,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requireTargetEvidenceInputRecord(value)
  requireExactTargetEvidenceInputKeys(record, [
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'oldestObservationAt',
    'runId',
    'runtimeRevision',
    'validatedAt',
    'validUntil',
  ])
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId: readTargetEvidenceMigrationIdentifier(
      Reflect.get(record, 'runId'),
    ),
    evidenceDigest: readTargetEvidenceInputDigest(
      Reflect.get(record, 'evidenceDigest'),
    ),
    evidenceLocator: readTargetEvidenceBoundedText(
      Reflect.get(record, 'evidenceLocator'),
      2_048,
    ),
    runtimeRevision: readTargetEvidencePositiveSafeInteger(
      Reflect.get(record, 'runtimeRevision'),
    ),
    fenceToken: readTargetEvidencePositiveSafeInteger(
      Reflect.get(record, 'fenceToken'),
    ),
    validatedAt: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'validatedAt'),
    ),
    oldestObservationAt: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'oldestObservationAt'),
    ),
    validUntil: readTargetEvidenceCanonicalTime(
      Reflect.get(record, 'validUntil'),
    ),
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    receipt.runId,
  )
  return receipt
}

/**
 * Captures one trusted clock value after write preparation.
 *
 * @param clock - Adapter-owned clock dependency.
 * @returns Canonical time and exact epoch milliseconds.
 */
function readTargetEvidenceCommitClock(
  clock: WorkspaceSearchMigrationPrePlanAuthorityClock,
): TargetEvidenceCommitClock {
  const value = clock()
  if (!(value instanceof Date)) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failTargetEvidenceAws('INVALID_STATE')
  }
  try {
    return {
      at: new Date(epochMilliseconds).toISOString(),
      epochMilliseconds,
    }
  } catch {
    return failTargetEvidenceAws('INVALID_STATE')
  }
}

/**
 * Validates the immutable state-table fields consumed by this adapter.
 *
 * @param value - Candidate measured migration-state identity.
 */
function requireMigrationStateTableIdentity(value: unknown): void {
  const record = requireTargetEvidenceInputRecord(value)
  if (Reflect.get(record, 'role') !== 'migration-state') {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  requireStateTableName(Reflect.get(record, 'tableName'))
  readTargetEvidenceBoundedText(Reflect.get(record, 'tableArn'), 2_048)
  readTargetEvidenceBoundedText(Reflect.get(record, 'tableId'), 1_024)
  readTargetEvidenceCanonicalTime(Reflect.get(record, 'creationTime'))
  readTargetEvidenceBoundedText(Reflect.get(record, 'account'), 64)
  readTargetEvidenceBoundedText(Reflect.get(record, 'region'), 64)
}

/**
 * Validates the narrow target-evidence transport without invoking its methods.
 *
 * @param transport - Candidate transport dependency.
 */
function requireTargetEvidenceAwsTransport(transport: unknown): void {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    typeof Reflect.get(transport, 'getTargetEvidence') !== 'function' ||
    typeof Reflect.get(
      transport,
      'prepareTargetEvidenceWrite',
    ) !== 'function' ||
    typeof Reflect.get(
      transport,
      'transactWriteTargetEvidence',
    ) !== 'function'
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Validates the planning artifact gateway without invoking its methods.
 *
 * @param gateway - Candidate managed planning artifact gateway.
 */
function requirePlanningTargetArtifactGateway(gateway: unknown): void {
  if (
    typeof gateway !== 'object' ||
    gateway === null ||
    typeof Reflect.get(
      gateway,
      'captureAndStorePlanningPage',
    ) !== 'function' ||
    typeof Reflect.get(
      gateway,
      'readVerifiedPlanningPage',
    ) !== 'function'
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Requires one non-array input object.
 *
 * @param value - Candidate runtime input.
 * @returns Object suitable for bounded reflection.
 */
function requireTargetEvidenceInputRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires an input object to carry exactly the declared enumerable own keys.
 *
 * @param value - Candidate input object.
 * @param expected - Exact accepted key names.
 */
function requireExactTargetEvidenceInputKeys(
  value: object,
  expected: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Reads one strict migration identifier from caller input.
 *
 * @param value - Candidate identifier.
 * @returns Exact safe identifier.
 */
function readTargetEvidenceMigrationIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest from caller input.
 *
 * @param value - Candidate digest.
 * @returns Exact validated digest.
 */
function readTargetEvidenceInputDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one positive safe integer from caller input.
 *
 * @param value - Candidate numeric value.
 * @returns Exact positive safe integer.
 */
function readTargetEvidencePositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one nonempty bounded caller-supplied string.
 *
 * @param value - Candidate text.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns Exact validated text.
 */
function readTargetEvidenceBoundedText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one canonical nonnegative UTC timestamp from caller input.
 *
 * @param value - Candidate timestamp.
 * @returns Exact canonical timestamp.
 */
function readTargetEvidenceCanonicalTime(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  const epochMilliseconds = Date.parse(value)
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates a physical DynamoDB table name without echoing it on failure.
 *
 * @param value - Candidate exact table name.
 */
function requireStateTableName(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    return failTargetEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Runs one adapter operation behind a fixed raw-error replacement boundary.
 *
 * @param operation - Exact validation and AWS operation.
 * @returns Detached successful operation result.
 */
async function runTargetEvidenceAwsBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readTargetEvidenceAwsFailureCode(error)
    throw createTargetEvidenceAwsBoundaryFailure(code)
  }
}

/**
 * Reads a trusted private or public migration failure code.
 *
 * @param error - Arbitrary error raised by validation or AWS I/O.
 * @returns Stable fail-closed migration failure code.
 */
function readTargetEvidenceAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof TargetEvidenceAwsFailure) return error.code
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (error instanceof ResourceNotFoundException) {
      return 'TARGET_DRIFT'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createTargetEvidenceAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput) ||
      isTransientError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Detects trusted state-table drift failures during transaction reconciliation.
 *
 * @param error - Failure raised by a state read or managed preparation.
 * @returns Whether the failure proves the migration-state incarnation changed.
 */
function isTargetEvidenceConfigurationDrift(error: unknown): boolean {
  if (error instanceof TargetEvidenceAwsFailure) {
    return error.code === 'CONFIGURATION_DRIFT'
  }
  if (error instanceof WorkspaceSearchMigrationFailure) {
    try {
      return error.code === 'CONFIGURATION_DRIFT'
    } catch {
      return false
    }
  }
  return false
}

/**
 * Classifies a transaction error only after rereads prove no write occurred.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retryable, authority, ambiguous, or fail-closed code.
 */
function classifyTargetEvidenceTransactionError(
  error: unknown,
): TargetEvidenceAwsFailureCode {
  try {
    if (error instanceof ResourceNotFoundException) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      isTransactionConflictErrorName(error)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (error instanceof TransactionCanceledException) {
      if (
        readTransactionCancellationReasonCode(
          error,
          workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex.lease,
        ) ===
          'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readTransactionCancellationReasonCode(
          error,
          workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex.pointer,
        ) ===
          'ConditionalCheckFailed' ||
        readTransactionCancellationReasonCode(
          error,
          workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex.receipt,
        ) ===
          'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      if (transactionCancellationHasConditionalFailure(error)) {
        return 'INVALID_STATE'
      }
      return transactionCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createTargetEvidenceAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (
      isTransientError(classificationInput)
    ) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Detects a safe transaction-conflict name on an arbitrary error.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether the stable name represents a retryable transaction race.
 */
function isTransactionConflictErrorName(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name: unknown = Reflect.get(error, 'name')
  return name === 'TransactionConflictException'
}

/**
 * Detects a transaction whose original idempotent request may still commit.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether the stable name denotes an in-progress transaction.
 */
function isTransactionInProgressErrorName(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name: unknown = Reflect.get(error, 'name')
  return name === 'TransactionInProgressException'
}

/**
 * Reads one stable cancellation reason code by transaction item index.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable reason code or undefined.
 */
function readTransactionCancellationReasonCode(
  error: TransactionCanceledException,
  index: number,
): string | undefined {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return undefined
  const reason: unknown = reasons[index]
  if (typeof reason !== 'object' || reason === null) return undefined
  const code: unknown = Reflect.get(reason, 'Code')
  return typeof code === 'string' ? code : undefined
}

/**
 * Detects any conditional failure in one transaction cancellation.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether one transaction item rejected its condition.
 */
function transactionCancellationHasConditionalFailure(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  for (const reason of reasons) {
    if (typeof reason !== 'object' || reason === null) continue
    if (Reflect.get(reason, 'Code') === 'ConditionalCheckFailed') {
      return true
    }
  }
  return false
}

/**
 * Reads only cancellation reason codes to detect retryable DynamoDB failures.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether a safe reason code indicates retryable infrastructure.
 */
function transactionCancellationWasTransient(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  for (const reason of reasons) {
    if (typeof reason !== 'object' || reason === null) continue
    const code: unknown = Reflect.get(reason, 'Code')
    if (
      code === 'ThrottlingError' ||
      code === 'ProvisionedThroughputExceeded' ||
      code === 'TransactionConflict'
    ) {
      return true
    }
  }
  return false
}

/**
 * Copies only fields required by Smithy's retry classifiers.
 *
 * @param error - Raw SDK or Node.js transport error.
 * @param depth - Bounded wrapped-cause depth copied so far.
 * @returns Detached secret-free classifier input.
 */
function createTargetEvidenceAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): TargetEvidenceAwsErrorClassificationInput {
  const nameValue: unknown = Reflect.get(error, 'name')
  const codeValue: unknown = Reflect.get(error, 'code')
  const metadataValue: unknown = Reflect.get(error, '$metadata')
  const retryableValue: unknown = Reflect.get(error, '$retryable')
  const causeValue: unknown =
    depth <= 10 ? Reflect.get(error, 'cause') : undefined
  const httpStatusCode = readOptionalNumericProperty(
    metadataValue,
    'httpStatusCode',
  )
  const throttling = readOptionalBooleanProperty(
    retryableValue,
    'throttling',
  )
  const hasRetryableTrait =
    typeof retryableValue === 'object' && retryableValue !== null
  return {
    name: typeof nameValue === 'string' ? nameValue : '',
    message: '',
    ...(typeof codeValue === 'string' ? { code: codeValue } : {}),
    ...(httpStatusCode === undefined
      ? {}
      : { $metadata: { httpStatusCode } }),
    ...(hasRetryableTrait
      ? {
          $retryable:
            throttling === undefined ? {} : { throttling },
        }
      : {}),
    ...(causeValue instanceof Error
      ? {
          cause: createTargetEvidenceAwsErrorClassificationInput(
            causeValue,
            depth + 1,
          ),
        }
      : {}),
  }
}

/**
 * Reads one optional numeric classifier property.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Finite number or undefined.
 */
function readOptionalNumericProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'number' && Number.isFinite(propertyValue)
    ? propertyValue
    : undefined
}

/**
 * Reads one optional Boolean classifier property.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Boolean or undefined.
 */
function readOptionalBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'boolean' ? propertyValue : undefined
}

/**
 * Raises one privately branded adapter failure.
 *
 * @param code - Stable trusted failure code.
 * @returns Never returns.
 */
function failTargetEvidenceAws(
  code: TargetEvidenceAwsFailureCode,
): never {
  throw new TargetEvidenceAwsFailure(code)
}

/**
 * Creates one public fixed-error adapter boundary failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Secret-free target-evidence failure.
 */
function createTargetEvidenceAwsBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search target evidence stopped safely (${code}).`,
  )
}
