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
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidencePage,
  createWorkspaceSearchMigrationSourceEvidencePageDigest,
  createWorkspaceSearchMigrationSourceEvidenceProgressDigest,
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  replayWorkspaceSearchMigrationSourceEvidencePages,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationSourceEvidenceIdentity,
  type WorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationPlanningSourceArtifactReference,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
  type WorkspaceSearchMigrationSourceEvidencePurpose,
  type WorkspaceSearchMigrationSourceEvidenceReplayResult,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityClock,
  workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex,
} from './migration-pre-plan-authority-aws'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  prepareWorkspaceSearchMigrationSourceScanContext,
} from './migration-source-scan-context'
import {
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
  validateWorkspaceSearchMigrationLease,
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'

const sourceEvidenceHeadKind =
  'workspace-search-migration-source-evidence-head'
const sourceEvidencePageRecordKind =
  'workspace-search-migration-source-evidence-page-record'
const sourceEvidenceAwsRecordVersion = 1
const sourceEvidenceRecordKeyPrefix = 'source-evidence/v1'
/** Maximum replayable pages, bounding evidence to 1,000,000 source rows. */
const sourceEvidenceMaximumPageCount = 10_000

/**
 * Narrow DynamoDB transport used to read and atomically commit source evidence.
 */
export interface WorkspaceSearchMigrationSourceEvidenceAwsTransport {
  /**
   * Reads one exact evidence record with strong consistency.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getSourceEvidence(command: GetItemCommand): Promise<GetItemCommandOutput>

  /**
   * Completes the state-incarnation guard immediately before commit time.
   */
  prepareSourceEvidenceWrite(): Promise<void>

  /**
   * Atomically writes one immutable page and its successor head.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteSourceEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Measured source scanner composed into the evidence commit adapter.
 */
export interface WorkspaceSearchMigrationSourceEvidenceScanner {
  /**
   * Scans and reduces exactly one bounded source page.
   *
   * @param input - Measured source context and durable predecessor checkpoint.
   * @returns Detached digest-only row evidence and exact resume checkpoint.
   */
  scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult>
}

/**
 * Planning-only gateway that keeps raw Scan items inside the managed session.
 */
export interface WorkspaceSearchMigrationPlanningSourceArtifactGateway {
  /**
   * Captures one exact page, reduces it, and stores every lossless segment.
   *
   * @param input - Exact predecessor, identity, authority, and measured scan context.
   * @returns Digest evidence plus ordered immutable S3-version references.
   */
  captureAndStorePlanningPage(
    input: WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput,
  ): Promise<WorkspaceSearchMigrationPlanningSourceArtifactCaptureResult>

  /**
   * Reads and verifies every exact immutable segment for one committed page.
   *
   * @param input - Expected page identity, authority, and exact S3 references.
   * @returns Detached raw items without the restricted DynamoDB cursor.
   */
  readVerifiedPlanningPage(
    input: WorkspaceSearchMigrationPlanningSourceArtifactReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPage>
}

/** Planning context required to capture and persist one raw source page. */
export type WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput =
  WorkspaceSearchMigrationSourceScanReadInput & {
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
      WorkspaceSearchMigrationPlanningAuthorityBinding
  }

/** Result of one same-page planning capture, reduction, and immutable upload. */
export type WorkspaceSearchMigrationPlanningSourceArtifactCaptureResult = {
  /** Digest-only reduction of the exact captured raw page. */
  readonly pageResult: WorkspaceSearchMigrationSourceScanPageResult
  /** Ordered exact immutable S3 versions for every raw page segment. */
  readonly sourceArtifacts:
    readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[]
}

/** Exact context required to read one already committed planning artifact page. */
export type WorkspaceSearchMigrationPlanningSourceArtifactReadInput =
  Omit<
    WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput,
    'previousCheckpoint'
  > & {
    /** Ordered exact immutable S3 versions bound into planning evidence v3. */
    readonly sourceArtifacts:
      readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[]
  }

/**
 * Dependencies for one source-evidence AWS adapter.
 */
export type CreateWorkspaceSearchMigrationSourceEvidenceAwsPortInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Measured scanner sharing the pinned AWS identity session. */
  readonly scanner: WorkspaceSearchMigrationSourceEvidenceScanner
  /** Managed planning-only raw-page capture and immutable artifact gateway. */
  readonly planningArtifactGateway:
    WorkspaceSearchMigrationPlanningSourceArtifactGateway
  /** Narrow strongly-consistent read and transactional-write transport. */
  readonly transport: WorkspaceSearchMigrationSourceEvidenceAwsTransport
  /** Adapter-owned trusted clock sampled immediately before each write. */
  readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock
}

/**
 * Identity and configuration required to address one durable scan head.
 */
export type WorkspaceSearchMigrationSourceEvidenceAwsRequest = {
  /** Operator-selected run identifier separating independent evidence scans. */
  readonly runId: string
  /** Pre-plan workflow that owns this evidence chain. */
  readonly purpose: WorkspaceSearchMigrationSourceEvidencePurpose
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Exact source table advanced by this evidence chain. */
  readonly source: WorkspaceSearchMigrationSourceName
}

/**
 * Dry-run commit request that cannot carry planning authority.
 */
export type WorkspaceSearchMigrationDryRunSourceEvidenceAwsCommitRequest =
  Omit<WorkspaceSearchMigrationSourceEvidenceAwsRequest, 'purpose'> & {
    /** Non-authoritative dry-run chain. */
    readonly purpose: 'dry-run'
    /** Planning authority is forbidden on a dry-run chain. */
    readonly authority?: never
  }

/**
 * Planning commit request authorized by one exact durable lease and receipt.
 */
export type WorkspaceSearchMigrationPlanningSourceEvidenceAwsCommitRequest =
  Omit<WorkspaceSearchMigrationSourceEvidenceAwsRequest, 'purpose'> & {
    /** Authority-bearing planning chain. */
    readonly purpose: 'planning'
    /** Exact pre-plan authority atomically revalidated by the commit. */
    readonly authority: WorkspaceSearchMigrationPrePlanAuthority
  }

/**
 * Exact request accepted by a source-evidence mutation.
 */
export type WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest =
  | WorkspaceSearchMigrationDryRunSourceEvidenceAwsCommitRequest
  | WorkspaceSearchMigrationPlanningSourceEvidenceAwsCommitRequest

/**
 * Durable source-evidence operations exposed to the migration workflow.
 */
export interface WorkspaceSearchMigrationSourceEvidenceAwsPort {
  /**
   * Reads the current durable progress or its canonical initial state.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Validated current progress.
   */
  readProgress(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress>

  /**
   * Strongly reads and replays every immutable page at one captured head.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Globally validated row evidence and exact captured head.
   */
  readCommittedEvidence(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceReplayResult>

  /**
   * Commits exactly one next source page, or returns completed progress.
   *
   * @param input - Exact evidence-chain identity and measured configuration.
   * @returns Atomically committed successor progress.
   */
  commitNextPage(
    input: WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress>
}

/**
 * Validated request snapshot used across one adapter operation.
 */
type PreparedSourceEvidenceAwsRequest = {
  /** Exact detached evidence identity. */
  readonly identity: WorkspaceSearchMigrationSourceEvidenceIdentity
  /** Canonical initial progress for an absent head. */
  readonly initialProgress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Exact measured configuration supplied to the managed scanner. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Exact reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact source advanced by the request. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Detached durable authority required only by planning commits. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority | null
  /** Compact canonical authority embedded in planning page bytes. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningAuthorityBinding | null
}

/**
 * Result of reading the durable source-evidence head.
 */
type SourceEvidenceHeadRead =
  | {
      /** Indicates that no durable head exists yet. */
      readonly exists: false
    }
  | {
      /** Indicates that a validated durable head exists. */
      readonly exists: true
      /** Exact validated durable progress. */
      readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
      /** Payload schema version of the latest immutable page. */
      readonly latestEvidenceVersion: 1 | 2 | 3
      /**
       * CAS-bound schema version for the complete chain, or null on a
       * historical head created before this discriminator existed.
       */
      readonly chainEvidenceVersion: 1 | 2 | 3 | null
    }

/** Strictly parsed progress and optional historical chain discriminator. */
type ParsedSourceEvidenceHeadItem = {
  /** Exact validated durable progress. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** CAS-bound complete-chain schema version, when durably present. */
  readonly chainEvidenceVersion: 1 | 2 | 3 | null
}

/**
 * Validated immutable page record used during response-loss reconciliation.
 */
type SourceEvidencePageRead = {
  /** Parsed strict page evidence. */
  readonly page: WorkspaceSearchMigrationSourceEvidencePage
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
type SourceEvidenceCommitClock = {
  /** Canonical UTC commit time. */
  readonly at: string
  /** Exact finite epoch milliseconds. */
  readonly epochMilliseconds: number
}

/**
 * Failure codes deliberately emitted by the private AWS adapter.
 */
type SourceEvidenceAwsFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_DRIFT'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_SOURCE_ARTIFACT'
  | 'INVALID_STATE'
  | 'LEASE_LOST'
  | 'SOURCE_DRIFT'
  | 'TABLE_SCHEMA_MISMATCH'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type SourceEvidenceAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Privately branded fixed-code failure for the source-evidence boundary.
 */
class SourceEvidenceAwsFailure extends Error {
  /** Stable operator-safe code chosen by trusted adapter logic. */
  readonly code: SourceEvidenceAwsFailureCode

  /**
   * Creates one fixed-code source-evidence failure.
   *
   * @param code - Stable operator-safe failure code.
   */
  constructor(code: SourceEvidenceAwsFailureCode) {
    super(code)
    this.name = 'SourceEvidenceAwsFailure'
    this.code = code
  }
}

/**
 * DynamoDB adapter committing digest-only row evidence and exact checkpoints.
 */
class AwsWorkspaceSearchMigrationSourceEvidencePort
  implements WorkspaceSearchMigrationSourceEvidenceAwsPort {
  /** Exact measured migration-state table incarnation. */
  private readonly stateTable: MigrationTableIdentity

  /** Managed source scanner sharing the measured identity session. */
  private readonly scanner: WorkspaceSearchMigrationSourceEvidenceScanner

  /** Planning-only lossless source artifact gateway. */
  private readonly planningArtifactGateway:
    WorkspaceSearchMigrationPlanningSourceArtifactGateway

  /** Narrow DynamoDB command transport. */
  private readonly transport: WorkspaceSearchMigrationSourceEvidenceAwsTransport

  /** Adapter-owned trusted clock sampled after write preparation. */
  private readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock

  /**
   * Creates an adapter bound to one exact state table and transport.
   *
   * @param input - Validated adapter dependencies.
   */
  constructor(
    input: CreateWorkspaceSearchMigrationSourceEvidenceAwsPortInput,
  ) {
    this.stateTable = structuredClone(input.stateTable)
    this.scanner = input.scanner
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
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    return runSourceEvidenceAwsBoundary(async () => {
      const request = prepareSourceEvidenceAwsRequest(
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
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceReplayResult> {
    return runSourceEvidenceAwsBoundary(async () => {
      const request = prepareSourceEvidenceAwsRequest(
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
   * Scans and atomically commits exactly one next source page.
   *
   * @param input - Exact evidence-chain identity and configuration.
   * @returns Committed successor or already-completed progress.
   */
  async commitNextPage(
    input: WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    return runSourceEvidenceAwsBoundary(async () => {
      const request = prepareSourceEvidenceAwsRequest(
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
        request.identity.purpose === 'planning' &&
        (
          predecessorRead.latestEvidenceVersion !== 3 ||
          predecessorRead.chainEvidenceVersion !== 3
        )
      ) {
        return failSourceEvidenceAws('INVALID_STATE')
      }
      if (predecessor.checkpoint.completed) return predecessor

      let pageResult: WorkspaceSearchMigrationSourceScanPageResult
      let sourceArtifacts:
        readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[] |
        null = null
      if (request.identity.purpose === 'planning') {
        const planningAuthority = request.planningAuthority
        if (planningAuthority === null) {
          return failSourceEvidenceAws('INVALID_STATE')
        }
        const captured =
          await this.planningArtifactGateway.captureAndStorePlanningPage({
            configuration: request.configuration,
            configurationHash: request.configurationHash,
            source: request.source,
            previousCheckpoint: predecessor.checkpoint,
            runId: request.identity.runId,
            pageSequence: predecessor.pageSequence + 1,
            previousEvidenceDigest: predecessor.evidenceDigest,
            previousCheckpointDigest:
              createWorkspaceSearchMigrationSourceCheckpointDigest(
                predecessor.checkpoint,
              ),
            planningAuthority,
          })
        pageResult = captured.pageResult
        sourceArtifacts = captured.sourceArtifacts
      } else {
        pageResult = await this.scanner.scanSourcePage({
          configuration: request.configuration,
          configurationHash: request.configurationHash,
          source: request.source,
          previousCheckpoint: predecessor.checkpoint,
        })
      }
      const page = createWorkspaceSearchMigrationSourceEvidencePage({
        identity: request.identity,
        previousProgress: predecessor,
        pageResult,
        planningAuthority: request.planningAuthority,
        sourceArtifacts,
      })
      const successor =
        advanceWorkspaceSearchMigrationSourceEvidenceProgress(
          predecessor,
          page,
        )
      requireSourceEvidencePageCountWithinLimit(successor.pageSequence)
      if (successor.checkpoint.cursor !== undefined) {
        const cursor = cloneWorkspaceSearchMigrationExactTableKey(
          successor.checkpoint.cursor,
          request.configuration.tables[request.source],
        )
        if (!cursor.ok) return failSourceEvidenceAws(cursor.code)
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
        const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
          request.identity,
          [...committedPages, page],
        )
        if (!sourceEvidenceProgressEquals(replay.progress, successor)) {
          return failSourceEvidenceAws('INVALID_STATE')
        }
      }
      const pageRecordKey = createSourceEvidencePageRecordKey(
        request.identity,
        successor.pageSequence,
      )
      const pageItem = createSourceEvidencePageItem(
        request.identity,
        pageRecordKey,
        successor.pageSequence,
        page,
      )
      const successorHeadItem = createSourceEvidenceHeadItem(
        request.identity,
        createSourceEvidenceHeadRecordKey(request.identity),
        successor,
        page.evidenceVersion,
      )
      await this.prepareWrite()
      const commitClock = request.authority === null
        ? null
        : readSourceEvidenceCommitClock(this.clock)
      const authorityConditionChecks =
        request.authority === null || commitClock === null
          ? []
          : createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
            stateTable: this.stateTable,
            configurationHash: request.configurationHash,
            authority: request.authority,
            commitAt: new Date(commitClock.epochMilliseconds),
          })
      const transaction = createSourceEvidenceCommitCommand({
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
        await this.transport.transactWriteSourceEvidence(transaction)
      } catch (error: unknown) {
        return this.reconcileTransaction(
          request,
          predecessorRead,
          predecessor,
          pageRecordKey,
          page,
          successor,
          request.identity.purpose,
          error,
        )
      }
      return successor
    })
  }

  /**
   * Runs the final state-table write preparation with drift classification.
   */
  private async prepareWrite(): Promise<void> {
    try {
      await this.transport.prepareSourceEvidenceWrite()
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return failSourceEvidenceAws('CONFIGURATION_DRIFT')
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
      return await this.transport.getSourceEvidence(command)
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return failSourceEvidenceAws('CONFIGURATION_DRIFT')
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
    request: PreparedSourceEvidenceAwsRequest,
  ): Promise<SourceEvidenceHeadRead> {
    const recordKey = createSourceEvidenceHeadRecordKey(request.identity)
    const output = await this.getStateEvidence(
      createStrongSourceEvidenceGetCommand(
        this.stateTable.tableName,
        recordKey,
      ),
    )
    if (output.Item === undefined) return { exists: false }
    const parsedHead = parseSourceEvidenceHeadItem(
      output.Item,
      recordKey,
      request,
    )
    const progress = parsedHead.progress
    if (progress.pageSequence === 0) {
      return failSourceEvidenceAws('INVALID_STATE')
    }
    requireSourceEvidencePageCountWithinLimit(progress.pageSequence)
    const latestRecordKey = createSourceEvidencePageRecordKey(
      request.identity,
      progress.pageSequence,
    )
    const latestPage = await this.readPage(request, latestRecordKey)
    if (
      latestPage === undefined ||
      latestPage.revision !== progress.pageSequence ||
      latestPage.pageDigest !== progress.evidenceDigest ||
      (
        parsedHead.chainEvidenceVersion !== null &&
        parsedHead.chainEvidenceVersion !==
          latestPage.page.evidenceVersion
      ) ||
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        latestPage.page.checkpoint,
      ) !==
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.checkpoint,
        )
    ) {
      return failSourceEvidenceAws('INVALID_STATE')
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
    request: PreparedSourceEvidenceAwsRequest,
    recordKey: string,
  ): Promise<SourceEvidencePageRead | undefined> {
    const output = await this.getStateEvidence(
      createStrongSourceEvidenceGetCommand(
        this.stateTable.tableName,
        recordKey,
      ),
    )
    if (output.Item === undefined) return undefined
    return parseSourceEvidencePageItem(
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
    request: PreparedSourceEvidenceAwsRequest,
    pageCount: number,
  ): Promise<WorkspaceSearchMigrationSourceEvidencePage[]> {
    requireSourceEvidencePageCountWithinLimit(pageCount)
    const pages: WorkspaceSearchMigrationSourceEvidencePage[] = []
    for (let sequence = 1; sequence <= pageCount; sequence += 1) {
      const recordKey = createSourceEvidencePageRecordKey(
        request.identity,
        sequence,
      )
      const page = await this.readPage(request, recordKey)
      if (page === undefined || page.revision !== sequence) {
        return failSourceEvidenceAws('INVALID_STATE')
      }
      pages.push(page.page)
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
    request: PreparedSourceEvidenceAwsRequest,
    expectedProgress: WorkspaceSearchMigrationSourceEvidenceProgress,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceReplayResult> {
    const pages = await this.readEvidencePages(
      request,
      expectedProgress.pageSequence,
    )
    await this.verifyPlanningArtifactPages(request, pages)
    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      request.identity,
      pages,
    )
    if (!sourceEvidenceProgressEquals(
      replay.progress,
      expectedProgress,
    )) {
      return failSourceEvidenceAws('INVALID_STATE')
    }
    return replay
  }

  /**
   * Verifies every artifact-bearing planning page against its exact transition.
   *
   * Legacy planning v2 remains readable as digest-only evidence but is never
   * treated as artifact-complete.
   *
   * @param request - Exact measured chain request.
   * @param pages - Ordered validated durable evidence pages.
   */
  private async verifyPlanningArtifactPages(
    request: PreparedSourceEvidenceAwsRequest,
    pages: readonly WorkspaceSearchMigrationSourceEvidencePage[],
  ): Promise<void> {
    let progress = request.initialProgress
    for (const page of pages) {
      if (
        page.purpose === 'planning' &&
        page.evidenceVersion === 3
      ) {
        await this.verifyPlanningArtifactPage(
          request,
          progress,
          page,
        )
      }
      progress =
        advanceWorkspaceSearchMigrationSourceEvidenceProgress(
          progress,
          page,
        )
    }
  }

  /**
   * Re-reduces one exact immutable raw page and compares its full v3 evidence.
   *
   * @param request - Exact measured chain request.
   * @param predecessor - Exact predecessor progress.
   * @param page - Artifact-bearing planning v3 page.
   */
  private async verifyPlanningArtifactPage(
    request: PreparedSourceEvidenceAwsRequest,
    predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
    page: Extract<
      WorkspaceSearchMigrationSourceEvidencePage,
      { readonly evidenceVersion: 3 }
    >,
  ): Promise<void> {
    const rawPage =
      await this.planningArtifactGateway.readVerifiedPlanningPage({
        configuration: request.configuration,
        configurationHash: request.configurationHash,
        source: request.source,
        runId: page.runId,
        pageSequence: page.pageSequence,
        previousEvidenceDigest: page.previousEvidenceDigest,
        previousCheckpointDigest: page.previousCheckpointDigest,
        planningAuthority: page.planningAuthority,
        sourceArtifacts: page.sourceArtifacts,
      })
    if (rawPage.lastEvaluatedKey !== undefined) {
      return failSourceEvidenceAws('INVALID_SOURCE_ARTIFACT')
    }
    const cursor = page.checkpoint.cursor
    if (
      page.checkpoint.completed
        ? cursor !== undefined
        : cursor === undefined
    ) {
      return failSourceEvidenceAws('INVALID_STATE')
    }
    const reconstructedPage: WorkspaceSearchMigrationSourceScanPage =
      cursor === undefined
        ? { items: rawPage.items }
        : {
            items: rawPage.items,
            lastEvaluatedKey: cursor,
          }
    const pageResult = reduceWorkspaceSearchMigrationSourceScanPage({
      configuration: request.configuration,
      configurationHash: request.configurationHash,
      source: request.source,
      previousCheckpoint: predecessor.checkpoint,
      page: reconstructedPage,
    })
    const reconstructedEvidence =
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity: request.identity,
        previousProgress: predecessor,
        pageResult,
        planningAuthority: page.planningAuthority,
        sourceArtifacts: page.sourceArtifacts,
      })
    if (
      !Buffer.from(
        serializeWorkspaceSearchMigrationSourceEvidencePage(
          reconstructedEvidence,
        ),
      ).equals(
        Buffer.from(
          serializeWorkspaceSearchMigrationSourceEvidencePage(page),
        ),
      )
    ) {
      return failSourceEvidenceAws('INVALID_SOURCE_ARTIFACT')
    }
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
    request: PreparedSourceEvidenceAwsRequest,
    predecessorRead: SourceEvidenceHeadRead,
    predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
    pageRecordKey: string,
    page: WorkspaceSearchMigrationSourceEvidencePage,
    successor: WorkspaceSearchMigrationSourceEvidenceProgress,
    purpose: WorkspaceSearchMigrationSourceEvidencePurpose,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    let currentHead: SourceEvidenceHeadRead
    let currentPage: SourceEvidencePageRead | undefined
    try {
      currentHead = await this.readHead(request)
      currentPage = await this.readPage(request, pageRecordKey)
    } catch (reconciliationError: unknown) {
      return failSourceEvidenceAws(
        isSourceEvidenceConfigurationDrift(reconciliationError)
          ? 'CONFIGURATION_DRIFT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }

    if (
      currentHead.exists &&
      currentPage !== undefined &&
      currentHead.chainEvidenceVersion === page.evidenceVersion &&
      sourceEvidencePageReadEquals(currentPage, page, successor.pageSequence)
    ) {
      if (sourceEvidenceProgressEquals(currentHead.progress, successor)) {
        if (
          page.purpose === 'planning' &&
          page.evidenceVersion === 3
        ) {
          try {
            await this.verifyPlanningArtifactPage(
              request,
              predecessor,
              page,
            )
          } catch (verificationError: unknown) {
            return failSourceEvidenceAws(
              isSourceEvidenceConfigurationDrift(verificationError)
                ? 'CONFIGURATION_DRIFT'
                : 'AMBIGUOUS_OPERATION_UNRESOLVED',
            )
          }
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
          return failSourceEvidenceAws(
            isSourceEvidenceConfigurationDrift(replayError)
              ? 'CONFIGURATION_DRIFT'
              : 'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        return successor
      }
    }

    if (
      sourceEvidenceHeadReadEquals(
        currentHead,
        predecessorRead,
        predecessor,
      ) &&
      currentPage === undefined
    ) {
      return failSourceEvidenceAws(
        classifySourceEvidenceTransactionError(transactionError, purpose),
      )
    }

    return failSourceEvidenceAws('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
}

/**
 * Creates one source-evidence AWS adapter.
 *
 * @param input - Exact state table, scanner, and narrow transport.
 * @returns Durable source-evidence port.
 */
export function createAwsWorkspaceSearchMigrationSourceEvidencePort(
  input: CreateWorkspaceSearchMigrationSourceEvidenceAwsPortInput,
): WorkspaceSearchMigrationSourceEvidenceAwsPort {
  try {
    requireMigrationStateTableIdentity(input.stateTable)
    if (typeof input.clock !== 'function') {
      return failSourceEvidenceAws('INVALID_ARGUMENT')
    }
    requireSourceEvidenceScanner(input.scanner)
    requirePlanningSourceArtifactGateway(
      input.planningArtifactGateway,
    )
    requireSourceEvidenceAwsTransport(input.transport)
    return new AwsWorkspaceSearchMigrationSourceEvidencePort(input)
  } catch {
    throw createSourceEvidenceAwsBoundaryFailure('INVALID_ARGUMENT')
  }
}

/**
 * Values required to build one atomic page/head commit.
 */
type CreateSourceEvidenceCommitCommandInput = {
  /** Exact physical state table name. */
  readonly stateTableName: string
  /** Whether a physical predecessor head existed before the scan. */
  readonly predecessorRead: SourceEvidenceHeadRead
  /** Exact logical predecessor progress. */
  readonly predecessor: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Deterministic immutable page record key. */
  readonly pageRecordKey: string
  /** Complete immutable page item. */
  readonly pageItem: Readonly<Record<string, AttributeValue>>
  /** Exact successor progress. */
  readonly successor: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Complete successor head item. */
  readonly successorHeadItem: Readonly<Record<string, AttributeValue>>
  /** Planning-only lease, pointer, and receipt condition checks. */
  readonly authorityConditionChecks:
    readonly TransactWriteItem[]
  /** Planning commit clock bound into authority conditions and token. */
  readonly commitClock: SourceEvidenceCommitClock | null
}

/**
 * Validates and snapshots one public adapter request.
 *
 * @param input - Candidate request.
 * @param adapterStateTable - Adapter-bound physical state-table incarnation.
 * @returns Detached evidence identity and scanner context.
 */
function prepareSourceEvidenceAwsRequest(
  input:
    | WorkspaceSearchMigrationSourceEvidenceAwsRequest
    | WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  adapterStateTable: MigrationTableIdentity,
  operation: 'commit' | 'read',
): PreparedSourceEvidenceAwsRequest {
  const inputRecord = requireSourceEvidenceInputRecord(input)
  const hasAuthority = Object.prototype.hasOwnProperty.call(
    inputRecord,
    'authority',
  )
  requireExactSourceEvidenceInputKeys(
    inputRecord,
    hasAuthority
      ? [
          'authority',
          'configuration',
          'configurationHash',
          'purpose',
          'runId',
          'source',
        ]
      : [
          'configuration',
          'configurationHash',
          'purpose',
          'runId',
          'source',
        ],
  )
  if (operation === 'read' && hasAuthority) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  const configuration = structuredClone(input.configuration)
  const configurationHash = input.configurationHash
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failSourceEvidenceAws('CONFIGURATION_HASH_MISMATCH')
  }
  const source = input.source
  const sourceTable = configuration.tables[source]
  const stateTable = configuration.tables['migration-state']
  if (
    sourceTable === undefined ||
    stateTable === undefined ||
    sourceTable.role !== source ||
    stateTable.role !== 'migration-state' ||
    !sourceEvidenceStateTableIdentityMatches(
      stateTable,
      adapterStateTable,
    )
  ) {
    return failSourceEvidenceAws('IDENTITY_MISMATCH')
  }
  const identity: WorkspaceSearchMigrationSourceEvidenceIdentity = {
    purpose: input.purpose,
    runId: input.runId,
    configurationHash,
    source,
    sourceTableId: sourceTable.tableId,
    stateTableId: stateTable.tableId,
  }
  let authority: WorkspaceSearchMigrationPrePlanAuthority | null = null
  let planningAuthority:
    WorkspaceSearchMigrationPlanningAuthorityBinding | null = null
  if (operation === 'commit') {
    if (identity.purpose === 'dry-run') {
      if (hasAuthority) return failSourceEvidenceAws('INVALID_ARGUMENT')
    } else {
      if (!hasAuthority) {
        return failSourceEvidenceAws('INVALID_MAINTENANCE_EVIDENCE')
      }
      authority = snapshotSourceEvidencePrePlanAuthority(
        Reflect.get(input, 'authority'),
      )
      if (
        authority.configurationHash !== configurationHash ||
        authority.stateTableId !== stateTable.tableId ||
        authority.lease.runId !== identity.runId
      ) {
        return failSourceEvidenceAws('IDENTITY_MISMATCH')
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
  }
  const initialProgress =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const preflight = prepareWorkspaceSearchMigrationSourceScanContext({
    configuration,
    configurationHash,
    source,
    previousCheckpoint: initialProgress.checkpoint,
  })
  if (!preflight.ok) return failSourceEvidenceAws(preflight.code)
  return {
    identity,
    initialProgress,
    configuration: preflight.context.configuration,
    configurationHash,
    source,
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
function createSourceEvidenceIdentityDigest(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-source-evidence-identity',
    version: sourceEvidenceAwsRecordVersion,
    purpose: identity.purpose,
    runId: identity.runId,
    configurationHash: identity.configurationHash,
    source: identity.source,
    sourceTableId: identity.sourceTableId,
    stateTableId: identity.stateTableId,
  })
}

/**
 * Creates the deterministic durable head key for one evidence chain.
 *
 * @param identity - Exact immutable evidence-chain identity.
 * @returns Bounded state-table sort key.
 */
function createSourceEvidenceHeadRecordKey(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): string {
  return `${sourceEvidenceRecordKeyPrefix}/${createSourceEvidenceIdentityDigest(identity)}/head`
}

/**
 * Creates the deterministic immutable page key for one chain position.
 *
 * @param identity - Exact immutable evidence-chain identity.
 * @param revision - One-based successor page sequence.
 * @returns Bounded state-table sort key.
 */
function createSourceEvidencePageRecordKey(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  revision: number,
): string {
  requirePositiveSafeInteger(revision)
  return `${sourceEvidenceRecordKeyPrefix}/${createSourceEvidenceIdentityDigest(identity)}/page/${String(revision).padStart(16, '0')}`
}

/**
 * Creates one strongly consistent point read for an exact evidence record.
 *
 * @param stateTableName - Exact physical migration-state table name.
 * @param recordKey - Deterministic evidence record key.
 * @returns Adapter-owned GetItem command.
 */
function createStrongSourceEvidenceGetCommand(
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
function createSourceEvidenceHeadItem(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  recordKey: string,
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  chainEvidenceVersion: 1 | 2 | 3,
): Readonly<Record<string, AttributeValue>> {
  requireProgressIdentity(identity, progress)
  void createWorkspaceSearchMigrationSourceEvidenceProgressDigest(progress)
  if (
    (progress.purpose === 'dry-run' && chainEvidenceVersion !== 1) ||
    (progress.purpose === 'planning' && chainEvidenceVersion !== 3)
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    kind: { S: sourceEvidenceHeadKind },
    version: { N: String(sourceEvidenceAwsRecordVersion) },
    run: { S: progress.runId },
    purpose: { S: progress.purpose },
    config: { S: progress.configurationHash },
    source: { S: progress.source },
    sourceTableId: { S: progress.sourceTableId },
    stateTableId: { S: progress.stateTableId },
    chainEvidenceVersion: { N: String(chainEvidenceVersion) },
    revision: { N: String(progress.pageSequence) },
    checkpointDigest: {
      S: createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.checkpoint,
      ),
    },
    headDigest: { S: progress.evidenceDigest },
    completed: { BOOL: progress.checkpoint.completed },
    checkpoint: encodeSourceEvidenceCheckpoint(progress.checkpoint),
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
function createSourceEvidencePageItem(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  recordKey: string,
  revision: number,
  page: WorkspaceSearchMigrationSourceEvidencePage,
): Readonly<Record<string, AttributeValue>> {
  const payload =
    serializeWorkspaceSearchMigrationSourceEvidencePage(page)
  const pageDigest =
    createWorkspaceSearchMigrationSourceEvidencePageDigest(page)
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    kind: { S: sourceEvidencePageRecordKind },
    version: { N: String(sourceEvidenceAwsRecordVersion) },
    identityDigest: {
      S: createSourceEvidenceIdentityDigest(identity),
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
function createSourceEvidenceCommitCommand(
  input: CreateSourceEvidenceCommitCommandInput,
): TransactWriteItemsCommand {
  const requiredAuthorityConditionCount =
    input.successor.purpose === 'planning'
      ? workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex.count
      : 0
  if (
    input.authorityConditionChecks.length !==
      requiredAuthorityConditionCount ||
    (input.successor.purpose === 'planning') !==
      (input.commitClock !== null)
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const headCondition = input.predecessorRead.exists
    ? createExistingHeadCondition(
        input.predecessor,
        input.predecessorRead.chainEvidenceVersion,
      )
    : createAbsentHeadCondition()
  const transactionToken = createSourceEvidenceTransactionToken(
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
type SourceEvidenceHeadCondition = {
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
function createAbsentHeadCondition(): SourceEvidenceHeadCondition {
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
 * @param chainEvidenceVersion - Persisted chain discriminator, when present.
 * @returns Full kind, identity, revision, digest, and completion condition.
 */
function createExistingHeadCondition(
  predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
  chainEvidenceVersion: 1 | 2 | 3 | null,
): SourceEvidenceHeadCondition {
  if (predecessor.checkpoint.completed) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const chainVersionExpression =
    chainEvidenceVersion === null
      ? 'attribute_not_exists(#chainEvidenceVersion)'
      : '#chainEvidenceVersion = :chainEvidenceVersion'
  return {
    expression: [
      '#kind = :kind',
      '#version = :version',
      '#run = :run',
      '#purpose = :purpose',
      '#config = :config',
      '#source = :source',
      '#sourceTableId = :sourceTableId',
      '#stateTableId = :stateTableId',
      '#revision = :revision',
      '#checkpointDigest = :checkpointDigest',
      '#headDigest = :headDigest',
      '#completed = :completed',
      chainVersionExpression,
    ].join(' AND '),
    names: {
      '#kind': 'kind',
      '#version': 'version',
      '#run': 'run',
      '#purpose': 'purpose',
      '#config': 'config',
      '#source': 'source',
      '#sourceTableId': 'sourceTableId',
      '#stateTableId': 'stateTableId',
      '#revision': 'revision',
      '#checkpointDigest': 'checkpointDigest',
      '#headDigest': 'headDigest',
      '#completed': 'completed',
      '#chainEvidenceVersion': 'chainEvidenceVersion',
    },
    values: {
      ':kind': { S: sourceEvidenceHeadKind },
      ':version': { N: String(sourceEvidenceAwsRecordVersion) },
      ':run': { S: predecessor.runId },
      ':purpose': { S: predecessor.purpose },
      ':config': { S: predecessor.configurationHash },
      ':source': { S: predecessor.source },
      ':sourceTableId': { S: predecessor.sourceTableId },
      ':stateTableId': { S: predecessor.stateTableId },
      ':revision': { N: String(predecessor.pageSequence) },
      ':checkpointDigest': {
        S: createWorkspaceSearchMigrationSourceCheckpointDigest(
          predecessor.checkpoint,
        ),
      },
      ':headDigest': { S: predecessor.evidenceDigest },
      ':completed': { BOOL: false },
      ...(chainEvidenceVersion === null
        ? {}
        : {
            ':chainEvidenceVersion': {
              N: String(chainEvidenceVersion),
            },
          }),
    },
  }
}

/**
 * Creates one bounded deterministic DynamoDB idempotency token.
 *
 * @param predecessor - Exact predecessor progress.
 * @param successor - Exact intended successor progress.
 * @param pageRecordKey - Deterministic immutable page record key.
 * @param commitClock - Planning clock that shaped authority conditions.
 * @returns Stable token of at most 36 ASCII characters.
 */
function createSourceEvidenceTransactionToken(
  predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
  successor: WorkspaceSearchMigrationSourceEvidenceProgress,
  pageRecordKey: string,
  commitClock: SourceEvidenceCommitClock | null,
): string {
  if (
    (successor.purpose === 'planning') !== (commitClock !== null)
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const digest = createMigrationDigest({
    kind: 'workspace-search-source-evidence-commit',
    version: sourceEvidenceAwsRecordVersion,
    predecessor:
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(predecessor),
    successor:
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(successor),
    pageRecordKey,
    authorityConditionEpochMilliseconds:
      commitClock === null ? null : commitClock.epochMilliseconds,
  })
  return `wsm1-${digest.slice(0, 31)}`
}

/**
 * Parses and validates one durable evidence head item.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expectedRecordKey - Exact deterministic head key.
 * @param request - Exact requested identity and measured scan context.
 * @returns Detached validated progress and optional chain discriminator.
 */
function parseSourceEvidenceHeadItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  request: PreparedSourceEvidenceAwsRequest,
): ParsedSourceEvidenceHeadItem {
  const item = cloneSourceEvidenceItem(rawItem)
  const headItemKeys = [
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
    'source',
    'sourceTableId',
    'stateTableId',
    'version',
  ]
  const hasChainEvidenceVersion =
    Object.hasOwn(item, 'chainEvidenceVersion')
  requireExactItemKeys(
    item,
    hasChainEvidenceVersion
      ? [...headItemKeys, 'chainEvidenceVersion']
      : headItemKeys,
  )
  if (
    readRequiredStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readRequiredStringAttribute(item, 'recordKey') !==
      expectedRecordKey ||
    readRequiredStringAttribute(item, 'kind') !==
      sourceEvidenceHeadKind ||
    readRequiredNaturalNumberAttribute(item, 'version') !==
      sourceEvidenceAwsRecordVersion
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  let chainEvidenceVersion: 1 | 2 | 3 | null = null
  if (hasChainEvidenceVersion) {
    const candidate =
      readRequiredPositiveNumberAttribute(
        item,
        'chainEvidenceVersion',
      )
    if (candidate !== 1 && candidate !== 2 && candidate !== 3) {
      return failSourceEvidenceAws('INVALID_STATE')
    }
    chainEvidenceVersion = candidate
  }
  requireHeadIdentity(item, request.identity)
  const checkpoint = decodeSourceEvidenceCheckpoint(
    readRequiredMapAttribute(item, 'checkpoint'),
  )
  const checkpointDigest =
    createWorkspaceSearchMigrationSourceCheckpointDigest(checkpoint)
  if (
    readRequiredStringAttribute(item, 'checkpointDigest') !==
      checkpointDigest ||
    readRequiredBooleanAttribute(item, 'completed') !==
      checkpoint.completed
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const progress: WorkspaceSearchMigrationSourceEvidenceProgress = {
    purpose: request.identity.purpose,
    runId: request.identity.runId,
    configurationHash: request.identity.configurationHash,
    source: request.identity.source,
    sourceTableId: request.identity.sourceTableId,
    stateTableId: request.identity.stateTableId,
    pageSequence:
      readRequiredNaturalNumberAttribute(item, 'revision'),
    evidenceDigest: readRequiredStringAttribute(item, 'headDigest'),
    checkpoint,
  }
  void createWorkspaceSearchMigrationSourceEvidenceProgressDigest(progress)
  if (checkpoint.completed) {
    return { progress, chainEvidenceVersion }
  }
  const context = prepareWorkspaceSearchMigrationSourceScanContext({
    configuration: request.configuration,
    configurationHash: request.configurationHash,
    source: request.source,
    previousCheckpoint: checkpoint,
  })
  if (!context.ok) return failSourceEvidenceAws(context.code)
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
function parseSourceEvidencePageItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): SourceEvidencePageRead {
  const item = cloneSourceEvidenceItem(rawItem)
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
      sourceEvidencePageRecordKind ||
    readRequiredNaturalNumberAttribute(item, 'version') !==
      sourceEvidenceAwsRecordVersion ||
    readRequiredStringAttribute(item, 'identityDigest') !==
      createSourceEvidenceIdentityDigest(identity)
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const revision =
    readRequiredPositiveNumberAttribute(item, 'revision')
  if (
    createSourceEvidencePageRecordKey(identity, revision) !==
      expectedRecordKey
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const payload = readRequiredBinaryAttribute(item, 'payload')
  const page =
    parseWorkspaceSearchMigrationSourceEvidencePage(payload)
  const pageDigest =
    createWorkspaceSearchMigrationSourceEvidencePageDigest(page)
  if (
    readRequiredStringAttribute(item, 'pageDigest') !== pageDigest ||
    page.pageSequence !== revision ||
    !sourceEvidencePageHasIdentity(page, identity)
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
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
function encodeSourceEvidenceCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): AttributeValue {
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  const aggregate = checkpoint.aggregate
  const map: Record<string, AttributeValue> = {
    completed: { BOOL: checkpoint.completed },
    aggregate: {
      M: {
        scanned: { N: String(aggregate.scanned) },
        mapped: { N: String(aggregate.mapped) },
        ignored: { N: String(aggregate.ignored) },
        invalid: { N: String(aggregate.invalid) },
        projected: { N: String(aggregate.projected) },
        deleted: { N: String(aggregate.deleted) },
        pageCount: { N: String(aggregate.pageCount) },
        keyDigest: { S: aggregate.keyDigest },
        contentDigest: { S: aggregate.contentDigest },
      },
    },
    keyDigestState: encodeSourceEvidenceDigestState(
      checkpoint.keyDigestState,
    ),
    contentDigestState: encodeSourceEvidenceDigestState(
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
function encodeSourceEvidenceDigestState(
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
function decodeSourceEvidenceCheckpoint(
  map: Readonly<Record<string, AttributeValue>>,
): MigrationSourceCheckpoint {
  requireExactItemKeys(
    map,
    [
      'aggregate',
      'completed',
      'contentDigestState',
      'keyDigestState',
    ],
    ['cursor'],
  )
  const checkpoint: MigrationSourceCheckpoint = {
    completed: readRequiredBooleanAttribute(map, 'completed'),
    aggregate: decodeSourceEvidenceAggregate(
      readRequiredMapAttribute(map, 'aggregate'),
    ),
    keyDigestState: decodeSourceEvidenceDigestState(
      readRequiredMapAttribute(map, 'keyDigestState'),
    ),
    contentDigestState: decodeSourceEvidenceDigestState(
      readRequiredMapAttribute(map, 'contentDigestState'),
    ),
    ...(map.cursor === undefined
      ? {}
      : {
          cursor: cloneSourceEvidenceCursor(
            readRequiredMapAttribute(map, 'cursor'),
          ),
        }),
  }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Decodes one strict cumulative scan aggregate.
 *
 * @param map - Detached low-level DynamoDB aggregate map.
 * @returns Exact cumulative aggregate.
 */
function decodeSourceEvidenceAggregate(
  map: Readonly<Record<string, AttributeValue>>,
): MigrationScanAggregate {
  requireExactItemKeys(map, [
    'contentDigest',
    'deleted',
    'ignored',
    'invalid',
    'keyDigest',
    'mapped',
    'pageCount',
    'projected',
    'scanned',
  ])
  return {
    scanned: readRequiredNaturalNumberAttribute(map, 'scanned'),
    mapped: readRequiredNaturalNumberAttribute(map, 'mapped'),
    ignored: readRequiredNaturalNumberAttribute(map, 'ignored'),
    invalid: readRequiredNaturalNumberAttribute(map, 'invalid'),
    projected: readRequiredNaturalNumberAttribute(map, 'projected'),
    deleted: readRequiredNaturalNumberAttribute(map, 'deleted'),
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
function decodeSourceEvidenceDigestState(
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
function cloneSourceEvidenceCursor(
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
function cloneSourceEvidenceItem(
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
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): void {
  if (
    readRequiredStringAttribute(item, 'run') !== identity.runId ||
    readRequiredStringAttribute(item, 'purpose') !== identity.purpose ||
    readRequiredStringAttribute(item, 'config') !==
      identity.configurationHash ||
    readRequiredStringAttribute(item, 'source') !== identity.source ||
    readRequiredStringAttribute(item, 'sourceTableId') !==
      identity.sourceTableId ||
    readRequiredStringAttribute(item, 'stateTableId') !==
      identity.stateTableId
  ) {
    return failSourceEvidenceAws('IDENTITY_MISMATCH')
  }
}

/**
 * Verifies that progress carries the exact requested identity.
 *
 * @param identity - Exact requested evidence identity.
 * @param progress - Candidate progress.
 */
function requireProgressIdentity(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
): void {
  if (
    progress.purpose !== identity.purpose ||
    progress.runId !== identity.runId ||
    progress.configurationHash !== identity.configurationHash ||
    progress.source !== identity.source ||
    progress.sourceTableId !== identity.sourceTableId ||
    progress.stateTableId !== identity.stateTableId
  ) {
    return failSourceEvidenceAws('IDENTITY_MISMATCH')
  }
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
function sourceEvidenceStateTableIdentityMatches(
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
function sourceEvidencePageHasIdentity(
  page: WorkspaceSearchMigrationSourceEvidencePage,
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): boolean {
  return page.purpose === identity.purpose &&
    page.runId === identity.runId &&
    page.configurationHash === identity.configurationHash &&
    page.source === identity.source &&
    page.sourceTableId === identity.sourceTableId &&
    page.stateTableId === identity.stateTableId
}

/**
 * Compares two validated progress heads by their exact CAS fingerprint.
 *
 * @param left - First progress head.
 * @param right - Second progress head.
 * @returns Whether both represent the exact same progress.
 */
function sourceEvidenceProgressEquals(
  left: WorkspaceSearchMigrationSourceEvidenceProgress,
  right: WorkspaceSearchMigrationSourceEvidenceProgress,
): boolean {
  return createWorkspaceSearchMigrationSourceEvidenceProgressDigest(left) ===
    createWorkspaceSearchMigrationSourceEvidenceProgressDigest(right)
}

/**
 * Compares a reconciliation page read with the exact intended page.
 *
 * @param read - Validated durable page read.
 * @param expected - Exact intended page.
 * @param expectedRevision - Exact intended successor revision.
 * @returns Whether the record contains byte-identical intended evidence.
 */
function sourceEvidencePageReadEquals(
  read: SourceEvidencePageRead,
  expected: WorkspaceSearchMigrationSourceEvidencePage,
  expectedRevision: number,
): boolean {
  if (
    read.revision !== expectedRevision ||
    read.pageDigest !==
      createWorkspaceSearchMigrationSourceEvidencePageDigest(expected)
  ) {
    return false
  }
  const expectedPayload =
    serializeWorkspaceSearchMigrationSourceEvidencePage(expected)
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
function sourceEvidenceHeadReadEquals(
  current: SourceEvidenceHeadRead,
  before: SourceEvidenceHeadRead,
  predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
): boolean {
  if (!before.exists) return !current.exists
  return current.exists &&
    current.chainEvidenceVersion === before.chainEvidenceVersion &&
    current.latestEvidenceVersion === before.latestEvidenceVersion &&
    sourceEvidenceProgressEquals(current.progress, predecessor)
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
      return failSourceEvidenceAws('INVALID_STATE')
    }
  }
  for (const key of keys) {
    if (!requiredSet.has(key) && !optionalSet.has(key)) {
      return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
  }
  const parsed = Number(value.N)
  if (!Number.isSafeInteger(parsed)) {
    return failSourceEvidenceAws('INVALID_STATE')
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
    return failSourceEvidenceAws('INVALID_STATE')
  }
}

/**
 * Rejects evidence chains whose replay could exceed the operational bound.
 *
 * @param pageCount - Captured or proposed evidence page count.
 */
function requireSourceEvidencePageCountWithinLimit(
  pageCount: number,
): void {
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 0 ||
    pageCount > sourceEvidenceMaximumPageCount
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
}

/**
 * Detaches and validates planning authority before the operation's first await.
 *
 * Commit-time freshness and durable currentness are deliberately revalidated
 * after the final state-incarnation guard. This snapshot prevents caller
 * mutation during the preceding reads and source scan from changing the
 * authority that the transaction eventually checks.
 *
 * @param value - Candidate caller-owned authority aggregate.
 * @returns Exact detached authority material.
 */
function snapshotSourceEvidencePrePlanAuthority(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  const record = requireSourceEvidenceInputRecord(value)
  requireExactSourceEvidenceInputKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  const lease = snapshotSourceEvidenceAuthorityLease(
    Reflect.get(record, 'lease'),
  )
  const receipt = snapshotSourceEvidenceAuthorityReceipt(
    Reflect.get(record, 'maintenanceEvidenceReceipt'),
  )
  const receiptDigest = readSourceEvidenceInputDigest(
    Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
  )
  const pointerRevision = readSourceEvidencePositiveSafeInteger(
    Reflect.get(record, 'maintenanceEvidencePointerRevision'),
  )
  if (
    receipt.runId !== lease.runId ||
    receipt.fenceToken !== lease.fenceToken ||
    receiptDigest !== createMigrationDigest(receipt)
  ) {
    return failSourceEvidenceAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  return {
    configurationHash: readSourceEvidenceInputDigest(
      Reflect.get(record, 'configurationHash'),
    ),
    stateTableId: readSourceEvidenceBoundedText(
      Reflect.get(record, 'stateTableId'),
      1_024,
    ),
    lease,
    maintenanceEvidenceReceiptDigest: receiptDigest,
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: readSourceEvidenceCanonicalTime(
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
function snapshotSourceEvidenceAuthorityLease(
  value: unknown,
): WorkspaceSearchMigrationLease {
  const record = requireSourceEvidenceInputRecord(value)
  requireExactSourceEvidenceInputKeys(record, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  const lease: WorkspaceSearchMigrationLease = {
    runId: readSourceEvidenceMigrationIdentifier(
      Reflect.get(record, 'runId'),
    ),
    ownerId: readSourceEvidenceMigrationIdentifier(
      Reflect.get(record, 'ownerId'),
    ),
    fenceToken: readSourceEvidencePositiveSafeInteger(
      Reflect.get(record, 'fenceToken'),
    ),
    expiresAt: readSourceEvidenceCanonicalTime(
      Reflect.get(record, 'expiresAt'),
    ),
    heartbeatAt: readSourceEvidenceCanonicalTime(
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
function snapshotSourceEvidenceAuthorityReceipt(
  value: unknown,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requireSourceEvidenceInputRecord(value)
  requireExactSourceEvidenceInputKeys(record, [
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
    runId: readSourceEvidenceMigrationIdentifier(
      Reflect.get(record, 'runId'),
    ),
    evidenceDigest: readSourceEvidenceInputDigest(
      Reflect.get(record, 'evidenceDigest'),
    ),
    evidenceLocator: readSourceEvidenceBoundedText(
      Reflect.get(record, 'evidenceLocator'),
      2_048,
    ),
    runtimeRevision: readSourceEvidencePositiveSafeInteger(
      Reflect.get(record, 'runtimeRevision'),
    ),
    fenceToken: readSourceEvidencePositiveSafeInteger(
      Reflect.get(record, 'fenceToken'),
    ),
    validatedAt: readSourceEvidenceCanonicalTime(
      Reflect.get(record, 'validatedAt'),
    ),
    oldestObservationAt: readSourceEvidenceCanonicalTime(
      Reflect.get(record, 'oldestObservationAt'),
    ),
    validUntil: readSourceEvidenceCanonicalTime(
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
function readSourceEvidenceCommitClock(
  clock: WorkspaceSearchMigrationPrePlanAuthorityClock,
): SourceEvidenceCommitClock {
  const value = clock()
  if (!(value instanceof Date)) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
  try {
    return {
      at: new Date(epochMilliseconds).toISOString(),
      epochMilliseconds,
    }
  } catch {
    return failSourceEvidenceAws('INVALID_STATE')
  }
}

/**
 * Validates the immutable state-table fields consumed by this adapter.
 *
 * @param value - Candidate measured migration-state identity.
 */
function requireMigrationStateTableIdentity(value: unknown): void {
  const record = requireSourceEvidenceInputRecord(value)
  if (Reflect.get(record, 'role') !== 'migration-state') {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  requireStateTableName(Reflect.get(record, 'tableName'))
  readSourceEvidenceBoundedText(Reflect.get(record, 'tableArn'), 2_048)
  readSourceEvidenceBoundedText(Reflect.get(record, 'tableId'), 1_024)
  readSourceEvidenceCanonicalTime(Reflect.get(record, 'creationTime'))
  readSourceEvidenceBoundedText(Reflect.get(record, 'account'), 64)
  readSourceEvidenceBoundedText(Reflect.get(record, 'region'), 64)
}

/**
 * Validates the narrow source-evidence transport without invoking its methods.
 *
 * @param transport - Candidate transport dependency.
 */
function requireSourceEvidenceAwsTransport(transport: unknown): void {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    typeof Reflect.get(transport, 'getSourceEvidence') !== 'function' ||
    typeof Reflect.get(
      transport,
      'prepareSourceEvidenceWrite',
    ) !== 'function' ||
    typeof Reflect.get(
      transport,
      'transactWriteSourceEvidence',
    ) !== 'function'
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Validates the digest-only scanner dependency without invoking it.
 *
 * @param scanner - Candidate managed source scanner.
 */
function requireSourceEvidenceScanner(scanner: unknown): void {
  if (
    typeof scanner !== 'object' ||
    scanner === null ||
    typeof Reflect.get(scanner, 'scanSourcePage') !== 'function'
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Validates the planning artifact gateway without invoking its methods.
 *
 * @param gateway - Candidate managed planning artifact gateway.
 */
function requirePlanningSourceArtifactGateway(gateway: unknown): void {
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
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Requires one non-array input object.
 *
 * @param value - Candidate runtime input.
 * @returns Object suitable for bounded reflection.
 */
function requireSourceEvidenceInputRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires an input object to carry exactly the declared enumerable own keys.
 *
 * @param value - Candidate input object.
 * @param expected - Exact accepted key names.
 */
function requireExactSourceEvidenceInputKeys(
  value: object,
  expected: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Reads one strict migration identifier from caller input.
 *
 * @param value - Candidate identifier.
 * @returns Exact safe identifier.
 */
function readSourceEvidenceMigrationIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest from caller input.
 *
 * @param value - Candidate digest.
 * @returns Exact validated digest.
 */
function readSourceEvidenceInputDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one positive safe integer from caller input.
 *
 * @param value - Candidate numeric value.
 * @returns Exact positive safe integer.
 */
function readSourceEvidencePositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
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
function readSourceEvidenceBoundedText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one canonical nonnegative UTC timestamp from caller input.
 *
 * @param value - Candidate timestamp.
 * @returns Exact canonical timestamp.
 */
function readSourceEvidenceCanonicalTime(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
  const epochMilliseconds = Date.parse(value)
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failSourceEvidenceAws('INVALID_ARGUMENT')
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
    return failSourceEvidenceAws('INVALID_ARGUMENT')
  }
}

/**
 * Runs one adapter operation behind a fixed raw-error replacement boundary.
 *
 * @param operation - Exact validation and AWS operation.
 * @returns Detached successful operation result.
 */
async function runSourceEvidenceAwsBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readSourceEvidenceAwsFailureCode(error)
    throw createSourceEvidenceAwsBoundaryFailure(code)
  }
}

/**
 * Reads a trusted private or public migration failure code.
 *
 * @param error - Arbitrary error raised by validation or AWS I/O.
 * @returns Stable fail-closed migration failure code.
 */
function readSourceEvidenceAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof SourceEvidenceAwsFailure) return error.code
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (error instanceof ResourceNotFoundException) {
      return 'SOURCE_DRIFT'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createSourceEvidenceAwsErrorClassificationInput(error)
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
function isSourceEvidenceConfigurationDrift(error: unknown): boolean {
  if (error instanceof ResourceNotFoundException) return true
  if (error instanceof SourceEvidenceAwsFailure) {
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
 * @param purpose - Transaction layout discriminator.
 * @returns Stable retryable, authority, ambiguous, or fail-closed code.
 */
function classifySourceEvidenceTransactionError(
  error: unknown,
  purpose: WorkspaceSearchMigrationSourceEvidencePurpose,
): SourceEvidenceAwsFailureCode {
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
      if (purpose === 'planning') {
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
      createSourceEvidenceAwsErrorClassificationInput(error)
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
function createSourceEvidenceAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): SourceEvidenceAwsErrorClassificationInput {
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
          cause: createSourceEvidenceAwsErrorClassificationInput(
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
function failSourceEvidenceAws(
  code: SourceEvidenceAwsFailureCode,
): never {
  throw new SourceEvidenceAwsFailure(code)
}

/**
 * Creates one public fixed-error adapter boundary failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Secret-free source-evidence failure.
 */
function createSourceEvidenceAwsBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search source evidence stopped safely (${code}).`,
  )
}
