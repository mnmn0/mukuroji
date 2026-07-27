import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
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
  isWorkspaceSearchMigrationFailureCode,
  type DynamoAttributeMap,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import type {
  WorkspaceSearchMigrationSourceScanPageResult,
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
  type WorkspaceSearchMigrationSourceEvidenceProgress,
  type WorkspaceSearchMigrationSourceEvidencePurpose,
  type WorkspaceSearchMigrationSourceEvidenceReplayResult,
} from './migration-source-evidence'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  prepareWorkspaceSearchMigrationSourceScanContext,
} from './migration-source-scan-context'
import {
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
 * Dependencies for one source-evidence AWS adapter.
 */
export type CreateWorkspaceSearchMigrationSourceEvidenceAwsPortInput = {
  /** Exact physical migration-state table name selected by the operator. */
  readonly stateTableName: string
  /** Measured scanner sharing the pinned AWS identity session. */
  readonly scanner: WorkspaceSearchMigrationSourceEvidenceScanner
  /** Narrow strongly-consistent read and transactional-write transport. */
  readonly transport: WorkspaceSearchMigrationSourceEvidenceAwsTransport
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
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
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
 * Failure codes deliberately emitted by the private AWS adapter.
 */
type SourceEvidenceAwsFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
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
  /** Exact physical migration-state table selected by the operator. */
  private readonly stateTableName: string

  /** Managed source scanner sharing the measured identity session. */
  private readonly scanner: WorkspaceSearchMigrationSourceEvidenceScanner

  /** Narrow DynamoDB command transport. */
  private readonly transport: WorkspaceSearchMigrationSourceEvidenceAwsTransport

  /**
   * Creates an adapter bound to one exact state table and transport.
   *
   * @param input - Validated adapter dependencies.
   */
  constructor(
    input: CreateWorkspaceSearchMigrationSourceEvidenceAwsPortInput,
  ) {
    this.stateTableName = input.stateTableName
    this.scanner = input.scanner
    this.transport = input.transport
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
        this.stateTableName,
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
        this.stateTableName,
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
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    return runSourceEvidenceAwsBoundary(async () => {
      const request = prepareSourceEvidenceAwsRequest(
        input,
        this.stateTableName,
      )
      const predecessorRead = await this.readHead(request)
      const predecessor = predecessorRead.exists
        ? predecessorRead.progress
        : request.initialProgress
      if (predecessor.checkpoint.completed) return predecessor

      const pageResult = await this.scanner.scanSourcePage({
        configuration: request.configuration,
        configurationHash: request.configurationHash,
        source: request.source,
        previousCheckpoint: predecessor.checkpoint,
      })
      const page = createWorkspaceSearchMigrationSourceEvidencePage({
        identity: request.identity,
        previousProgress: predecessor,
        pageResult,
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
      )
      const transaction = createSourceEvidenceCommitCommand({
        stateTableName: this.stateTableName,
        predecessorRead,
        predecessor,
        pageRecordKey,
        pageItem,
        successor,
        successorHeadItem,
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
          error,
        )
      }
      return successor
    })
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
    const output = await this.transport.getSourceEvidence(
      createStrongSourceEvidenceGetCommand(
        this.stateTableName,
        recordKey,
      ),
    )
    if (output.Item === undefined) return { exists: false }
    const progress = parseSourceEvidenceHeadItem(
      output.Item,
      recordKey,
      request,
    )
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
    const output = await this.transport.getSourceEvidence(
      createStrongSourceEvidenceGetCommand(
        this.stateTableName,
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
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    let currentHead: SourceEvidenceHeadRead
    let currentPage: SourceEvidencePageRead | undefined
    try {
      currentHead = await this.readHead(request)
      currentPage = await this.readPage(request, pageRecordKey)
    } catch {
      return failSourceEvidenceAws('AMBIGUOUS_OPERATION_UNRESOLVED')
    }

    if (
      currentHead.exists &&
      currentPage !== undefined &&
      sourceEvidencePageReadEquals(currentPage, page, successor.pageSequence)
    ) {
      if (sourceEvidenceProgressEquals(currentHead.progress, successor)) {
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
        } catch {
          return failSourceEvidenceAws('AMBIGUOUS_OPERATION_UNRESOLVED')
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
        classifySourceEvidenceTransactionError(transactionError),
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
    requireStateTableName(input.stateTableName)
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
}

/**
 * Validates and snapshots one public adapter request.
 *
 * @param input - Candidate request.
 * @param stateTableName - Adapter-bound physical state table name.
 * @returns Detached evidence identity and scanner context.
 */
function prepareSourceEvidenceAwsRequest(
  input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  stateTableName: string,
): PreparedSourceEvidenceAwsRequest {
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
    stateTable.tableName !== stateTableName
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
 * @returns Validated low-level DynamoDB item.
 */
function createSourceEvidenceHeadItem(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  recordKey: string,
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
): Readonly<Record<string, AttributeValue>> {
  requireProgressIdentity(identity, progress)
  void createWorkspaceSearchMigrationSourceEvidenceProgressDigest(progress)
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
  const headCondition = input.predecessorRead.exists
    ? createExistingHeadCondition(input.predecessor)
    : createAbsentHeadCondition()
  const transactionToken = createSourceEvidenceTransactionToken(
    input.predecessor,
    input.successor,
    input.pageRecordKey,
  )
  return new TransactWriteItemsCommand({
    ClientRequestToken: transactionToken,
    TransactItems: [
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
 * @returns Full kind, identity, revision, digest, and completion condition.
 */
function createExistingHeadCondition(
  predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
): SourceEvidenceHeadCondition {
  if (predecessor.checkpoint.completed) {
    return failSourceEvidenceAws('INVALID_STATE')
  }
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
    },
  }
}

/**
 * Creates one bounded deterministic DynamoDB idempotency token.
 *
 * @param predecessor - Exact predecessor progress.
 * @param successor - Exact intended successor progress.
 * @param pageRecordKey - Deterministic immutable page record key.
 * @returns Stable token of at most 36 ASCII characters.
 */
function createSourceEvidenceTransactionToken(
  predecessor: WorkspaceSearchMigrationSourceEvidenceProgress,
  successor: WorkspaceSearchMigrationSourceEvidenceProgress,
  pageRecordKey: string,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-source-evidence-commit',
    version: sourceEvidenceAwsRecordVersion,
    predecessor:
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(predecessor),
    successor:
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(successor),
    pageRecordKey,
  })
  return `wsm1-${digest.slice(0, 31)}`
}

/**
 * Parses and validates one durable evidence head item.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expectedRecordKey - Exact deterministic head key.
 * @param request - Exact requested identity and measured scan context.
 * @returns Detached validated durable progress.
 */
function parseSourceEvidenceHeadItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  request: PreparedSourceEvidenceAwsRequest,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  const item = cloneSourceEvidenceItem(rawItem)
  requireExactItemKeys(item, [
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
  ])
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
  if (checkpoint.completed) return progress
  const context = prepareWorkspaceSearchMigrationSourceScanContext({
    configuration: request.configuration,
    configurationHash: request.configurationHash,
    source: request.source,
    previousCheckpoint: checkpoint,
  })
  if (!context.ok) return failSourceEvidenceAws(context.code)
  return {
    ...progress,
    checkpoint: context.context.previousCheckpoint,
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
 * Classifies a transaction error only after rereads prove no write occurred.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retryable or fail-closed failure code.
 */
function classifySourceEvidenceTransactionError(
  error: unknown,
): SourceEvidenceAwsFailureCode {
  try {
    if (error instanceof ResourceNotFoundException) {
      return 'SOURCE_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      isTransactionConflictErrorName(error)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (error instanceof TransactionCanceledException) {
      return transactionCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
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
 * Detects a safe transaction-conflict name on an arbitrary error.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether the stable name represents a retryable transaction race.
 */
function isTransactionConflictErrorName(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name: unknown = Reflect.get(error, 'name')
  return name === 'TransactionConflictException' ||
    name === 'TransactionInProgressException'
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
