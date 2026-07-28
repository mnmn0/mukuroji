import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  type AttributeValue,
  GetItemCommand,
  type GetItemCommandOutput,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
} from './migration-pre-plan-authority-aws'
import {
  createAwsWorkspaceSearchMigrationTargetEvidencePort,
  type WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput,
  type WorkspaceSearchMigrationPlanningTargetArtifactCaptureResult,
  type WorkspaceSearchMigrationPlanningTargetArtifactGateway,
  type WorkspaceSearchMigrationPlanningTargetArtifactReadInput,
  type WorkspaceSearchMigrationPlanningTargetEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationTargetEvidenceAwsPort,
  type WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  type WorkspaceSearchMigrationTargetEvidenceAwsTransport,
  WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT,
} from './migration-target-evidence-aws'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  parseWorkspaceSearchMigrationPlanningTargetArtifactPage,
  serializeWorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
} from './migration-target-artifact'
import {
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePageDigest,
  parseWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidencePage,
} from './migration-target-evidence'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import type {
  WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'
import {
  maintenanceRuntimeControlSurfaces,
} from './maintenance-evidence'

/** Canonical starting point shared by deterministic authority tests. */
const initialTime = '2026-07-25T04:00:00.000Z'

/** Durable discriminator used by the global planning lease row. */
const leaseKind = 'workspace-search-pre-plan-global-lease'

/** Durable discriminator used by a current maintenance pointer row. */
const pointerKind = 'workspace-search-pre-plan-maintenance-pointer'

/** Durable discriminator used by an immutable maintenance receipt row. */
const receiptKind = 'workspace-search-pre-plan-maintenance-receipt'

/** Durable discriminator used by a target-evidence head row. */
const targetHeadKind = 'workspace-search-migration-target-evidence-head'

/** Durable discriminator used by a target-evidence page row. */
const targetPageKind =
  'workspace-search-migration-target-evidence-page-record'

/** One transaction failure injected before or after the atomic write. */
type TransactionFault = {
  /** Whether the fake applies the transaction before throwing. */
  readonly timing: 'after-commit' | 'before-commit'
  /** Arbitrary raw failure that must not escape the adapter boundary. */
  readonly error: unknown
  /** Optional concurrent work run after commit but before response loss. */
  readonly afterCommit?: () => Promise<void>
}

/** One immutable target artifact segment stored by the in-memory gateway. */
type StoredPlanningTargetArtifactSegment = {
  /** Exact immutable reference returned to the evidence adapter. */
  readonly reference:
    WorkspaceSearchMigrationPlanningTargetArtifactReference
  /** Exact canonical artifact-segment bytes. */
  readonly bytes: Uint8Array
}

/** One condition-checked write prepared against a shared snapshot. */
type PlannedWrite = {
  /** Deterministic state-table record key replaced by the write. */
  readonly recordKey: string
  /** Detached complete low-level item installed atomically. */
  readonly item: Readonly<Record<string, AttributeValue>>
}

/**
 * Mutable trusted clock returning a detached Date at its configured instant.
 */
class MutableAuthorityClock {
  /** Current finite epoch millisecond returned to both adapters. */
  private epochMilliseconds: number

  /**
   * Creates a clock at one canonical UTC instant.
   *
   * @param at - Initial canonical timestamp.
   */
  constructor(at: string) {
    this.epochMilliseconds = requireEpochMilliseconds(at)
  }

  /**
   * Returns one fresh Date at the configured instant.
   *
   * @returns Detached trusted time.
   */
  read(): Date {
    return new Date(this.epochMilliseconds)
  }

  /**
   * Moves the clock to one canonical UTC instant.
   *
   * @param at - Next canonical timestamp.
   */
  set(at: string): void {
    this.epochMilliseconds = requireEpochMilliseconds(at)
  }
}

/**
 * Shared immutable target-artifact store supporting exact S3 version reads.
 */
class InMemoryPlanningTargetArtifactStore {
  /** Exact segments keyed by object key and immutable version identifier. */
  private readonly segments =
    new Map<string, StoredPlanningTargetArtifactSegment>()

  /**
   * Stores one immutable artifact version.
   *
   * @param segment - Exact reference and canonical bytes.
   */
  store(segment: StoredPlanningTargetArtifactSegment): void {
    const key = createStoredArtifactKey(segment.reference)
    const existing = this.segments.get(key)
    if (
      existing !== undefined &&
      (
        !Bun.deepEquals(existing.reference, segment.reference) ||
        !Buffer.from(existing.bytes).equals(Buffer.from(segment.bytes))
      )
    ) {
      throw new Error('Attempted to replace an immutable target artifact.')
    }
    this.segments.set(key, {
      reference: structuredClone(segment.reference),
      bytes: new Uint8Array(segment.bytes),
    })
  }

  /**
   * Reads one exact immutable artifact version.
   *
   * @param reference - Exact object key, version, and content digest.
   * @returns Detached canonical bytes.
   */
  read(
    reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
  ): Uint8Array {
    const stored = this.segments.get(
      createStoredArtifactKey(reference),
    )
    if (
      stored === undefined ||
      !Bun.deepEquals(stored.reference, reference)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_TARGET_ARTIFACT',
        'RAW-MISSING-PLANNING-TARGET-ARTIFACT',
      )
    }
    return new Uint8Array(stored.bytes)
  }

  /**
   * Deletes one exact immutable artifact version.
   *
   * @param reference - Exact version reference to remove.
   */
  delete(
    reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
  ): void {
    this.segments.delete(createStoredArtifactKey(reference))
  }
}

/**
 * Strict planning gateway owning target capture, reduction, storage, and read.
 */
class InMemoryPlanningTargetArtifactGateway
  implements WorkspaceSearchMigrationPlanningTargetArtifactGateway {
  /** Every detached planning capture input in call order. */
  readonly captureCalls:
    WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput[] = []

  /** Every detached exact-version artifact read input in call order. */
  readonly readCalls:
    WorkspaceSearchMigrationPlanningTargetArtifactReadInput[] = []

  /** Finite sequence of exact unfiltered target Scan pages. */
  private readonly pages: readonly WorkspaceSearchMigrationTargetScanPage[]

  /** Immutable storage shared by ports participating in one chain. */
  private readonly store: InMemoryPlanningTargetArtifactStore

  /** Optional shared event trace for ordering assertions. */
  private readonly events: string[] | undefined

  /** One-shot capture failure raised after reduction and before upload. */
  private nextCaptureFailure: unknown

  /** One-shot strict read failure. */
  private nextReadFailure: unknown

  /** One-shot raw-item override after an otherwise exact artifact read. */
  private nextReadItems: readonly DynamoAttributeMap[] | undefined

  /** One-shot hook run before the next capture begins. */
  private beforeCapture: (() => void | Promise<void>) | undefined

  /**
   * Creates a gateway over exact pages and shared immutable storage.
   *
   * @param pages - Finite sequence of raw target pages.
   * @param store - Exact-version artifact store.
   * @param events - Optional shared operation trace.
   */
  constructor(
    pages: readonly WorkspaceSearchMigrationTargetScanPage[],
    store: InMemoryPlanningTargetArtifactStore,
    events?: string[],
  ) {
    this.pages = structuredClone(pages)
    this.store = store
    this.events = events
  }

  /**
   * Schedules one action before the next planning capture.
   *
   * @param action - Ordering assertion or concurrent mutation.
   */
  beforeNextCapture(
    action: () => void | Promise<void>,
  ): void {
    this.beforeCapture = action
  }

  /**
   * Injects one upload failure after reduction and before durable storage.
   *
   * @param error - Arbitrary raw gateway failure.
   */
  failNextCapture(error: unknown): void {
    this.nextCaptureFailure = error
  }

  /**
   * Injects one failure before the next exact-version artifact read.
   *
   * @param error - Arbitrary raw gateway failure.
   */
  failNextRead(error: unknown): void {
    this.nextReadFailure = error
  }

  /**
   * Returns different raw items after the next valid artifact read.
   *
   * @param items - Wrong raw target items used for re-reduction checks.
   */
  returnWrongItemsOnNextRead(
    items: readonly DynamoAttributeMap[],
  ): void {
    this.nextReadItems = structuredClone(items)
  }

  /**
   * Removes one immutable stored artifact version.
   *
   * @param reference - Exact committed reference to remove.
   */
  deleteStoredArtifact(
    reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
  ): void {
    this.store.delete(reference)
  }

  /**
   * Captures, reduces, and stores one exact target page.
   *
   * @param input - Exact predecessor, configuration, and authority.
   * @returns Digest evidence and ordered immutable artifact references.
   */
  async captureAndStorePlanningPage(
    input: WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput,
  ): Promise<WorkspaceSearchMigrationPlanningTargetArtifactCaptureResult> {
    this.captureCalls.push(structuredClone(input))
    this.events?.push('capture')
    const beforeCapture = this.beforeCapture
    this.beforeCapture = undefined
    await beforeCapture?.()
    const page = this.pages[this.captureCalls.length - 1]
    if (page === undefined) {
      throw new Error('The target gateway was called after its terminal page.')
    }
    const rawPage = structuredClone(page)
    const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      previousCheckpoint: input.previousCheckpoint,
      page: rawPage,
    })
    if (this.nextCaptureFailure !== undefined) {
      const failure = this.nextCaptureFailure
      this.nextCaptureFailure = undefined
      throw failure
    }
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPlanningTargetArtifactPage(input, rawPage.items),
      )
    const targetArtifacts = encoded.map((segment, index) => ({
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          segment.contentDigest,
        ),
      versionId:
        `target-version-${input.pageSequence}-${index + 1}`,
      contentDigest: segment.contentDigest,
    }))
    for (const [index, reference] of targetArtifacts.entries()) {
      const segment = encoded[index]
      if (segment === undefined) {
        throw new Error('Missing encoded target artifact segment.')
      }
      this.store.store({
        reference,
        bytes: segment.bytes,
      })
    }
    this.events?.push('artifact-stored')
    return {
      pageResult: structuredClone(pageResult),
      targetArtifacts: structuredClone(targetArtifacts),
    }
  }

  /**
   * Reads and strictly verifies every exact committed artifact version.
   *
   * @param input - Committed page context and immutable references.
   * @returns Detached raw items with no cursor.
   */
  async readVerifiedPlanningPage(
    input: WorkspaceSearchMigrationPlanningTargetArtifactReadInput,
  ): Promise<WorkspaceSearchMigrationTargetScanPage> {
    this.readCalls.push(structuredClone(input))
    const readFailure = this.nextReadFailure
    this.nextReadFailure = undefined
    if (readFailure !== undefined) throw readFailure
    const bytes = input.targetArtifacts.map((reference) => {
      const stored = this.store.read(reference)
      const digest = createHash('sha256').update(stored).digest('hex')
      if (digest !== reference.contentDigest) {
        throw new WorkspaceSearchMigrationFailure(
          'INVALID_TARGET_ARTIFACT',
          'RAW-PLANNING-TARGET-ARTIFACT-DIGEST-MISMATCH',
        )
      }
      return stored
    })
    const page =
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(bytes)
    const expected = createPlanningTargetArtifactPage(
      input,
      page.items,
    )
    if (!Bun.deepEquals(page, expected)) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_TARGET_ARTIFACT',
        'RAW-PLANNING-TARGET-ARTIFACT-IDENTITY-MISMATCH',
      )
    }
    const wrongItems = this.nextReadItems
    this.nextReadItems = undefined
    return {
      items: structuredClone(wrongItems ?? page.items),
    }
  }
}

/**
 * Condition-aware in-memory transport shared by authority and target evidence.
 */
class InMemoryTargetEvidenceAwsTransport
  implements
    WorkspaceSearchMigrationTargetEvidenceAwsTransport,
    WorkspaceSearchMigrationPrePlanAuthorityAwsTransport {
  /** Every target-evidence GetItem command in call order. */
  readonly getCommands: GetItemCommand[] = []

  /** Every attempted target-evidence atomic transaction in call order. */
  readonly transactionCommands: TransactWriteItemsCommand[] = []

  /** Every authority GetItem command in call order. */
  readonly authorityGetCommands: GetItemCommand[] = []

  /** Every authority transaction in call order. */
  readonly authorityTransactionCommands: TransactWriteItemsCommand[] = []

  /** Marker for every completed target pre-write preparation. */
  readonly prepareCalls: true[] = []

  /** Whether page reads should yield so concurrent prefetch is measurable. */
  private measureTargetPageReadConcurrency = false

  /** Number of target page reads currently inside the measurement window. */
  private activeTargetPageReads = 0

  /** Highest measured number of simultaneous target page reads. */
  private maximumConcurrentTargetPageReads = 0

  /** Exact-version target artifact storage shared across resumed ports. */
  readonly planningArtifactStore =
    new InMemoryPlanningTargetArtifactStore()

  /** Durable low-level rows keyed by deterministic recordKey. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Optional shared event trace for ordering assertions. */
  private readonly events: string[] | undefined

  /** One-shot raw target-evidence GetItem failure. */
  private getFailure: unknown

  /** One-shot target transaction fault. */
  private transactionFault: TransactionFault | undefined

  /** One-shot action completed before target condition evaluation. */
  private beforeTargetTransaction:
    (() => void | Promise<void>) | undefined

  /** One-shot action completed inside target write preparation. */
  private beforeTargetPrepare:
    (() => void | Promise<void>) | undefined

  /**
   * Creates a transport with optional shared operation tracing.
   *
   * @param events - Optional ordered event sink.
   */
  constructor(events?: string[]) {
    this.events = events
  }

  /**
   * Injects one raw target point-read failure.
   *
   * @param error - Arbitrary value thrown by the next GetItem.
   */
  failNextGet(error: unknown): void {
    this.getFailure = error
  }

  /**
   * Injects one target transaction failure.
   *
   * @param fault - Commit timing and raw error.
   */
  failNextTransaction(fault: TransactionFault): void {
    this.transactionFault = fault
  }

  /**
   * Schedules concurrent work before the next target condition snapshot.
   *
   * @param action - One-shot concurrent authority or evidence operation.
   */
  beforeNextTargetTransaction(
    action: () => void | Promise<void>,
  ): void {
    this.beforeTargetTransaction = action
  }

  /**
   * Schedules one action during target write preparation.
   *
   * @param action - One-shot drift or clock mutation.
   */
  beforeNextTargetPrepare(
    action: () => void | Promise<void>,
  ): void {
    this.beforeTargetPrepare = action
  }

  /**
   * Starts measuring target-page read concurrency for subsequent operations.
   */
  startTargetPageReadConcurrencyMeasurement(): void {
    this.measureTargetPageReadConcurrency = true
    this.activeTargetPageReads = 0
    this.maximumConcurrentTargetPageReads = 0
  }

  /**
   * Reads the maximum simultaneous target-page reads since measurement began.
   *
   * @returns Highest number of in-flight page reads.
   */
  readMaximumConcurrentTargetPageReads(): number {
    return this.maximumConcurrentTargetPageReads
  }

  /**
   * Returns detached durable rows for assertions.
   *
   * @returns Current authority, page, and head rows.
   */
  readStoredItems(): readonly Readonly<Record<string, AttributeValue>>[] {
    return [...this.items.values()].map((item) => structuredClone(item))
  }

  /**
   * Returns one detached durable row selected by its kind.
   *
   * @param kind - Exact durable row discriminator.
   * @returns Matching row or undefined.
   */
  readStoredItemByKind(
    kind: string,
  ): Readonly<Record<string, AttributeValue>> | undefined {
    for (const item of this.items.values()) {
      if (readStringAttribute(item, 'kind') === kind) {
        return structuredClone(item)
      }
    }
    return undefined
  }

  /**
   * Returns every detached durable row selected by its kind.
   *
   * @param kind - Exact durable row discriminator.
   * @returns Matching rows in insertion order.
   */
  readStoredItemsByKind(
    kind: string,
  ): readonly Readonly<Record<string, AttributeValue>>[] {
    return [...this.items.values()]
      .filter((item) => readStringAttribute(item, 'kind') === kind)
      .map((item) => structuredClone(item))
  }

  /**
   * Replaces one existing row with an exact test-owned fixture.
   *
   * @param item - Complete low-level row carrying its record key.
   */
  replaceStoredItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const recordKey = readStringAttribute(item, 'recordKey')
    if (!this.items.has(recordKey)) {
      throw new Error('Expected one existing durable row.')
    }
    this.items.set(recordKey, structuredClone(item))
  }

  /**
   * Strongly reads one exact target-evidence row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Detached low-level item when present.
   */
  async getTargetEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    if (this.getFailure !== undefined) {
      const failure = this.getFailure
      this.getFailure = undefined
      throw failure
    }
    const recordKey = readCommandRecordKey(command)
    if (
      this.measureTargetPageReadConcurrency &&
      recordKey.includes('/page/')
    ) {
      this.activeTargetPageReads += 1
      this.maximumConcurrentTargetPageReads = Math.max(
        this.maximumConcurrentTargetPageReads,
        this.activeTargetPageReads,
      )
      await Promise.resolve()
      this.activeTargetPageReads -= 1
    }
    const item = this.items.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Strongly reads one exact pre-plan authority row.
   *
   * @param command - Authority-adapter-owned GetItem command.
   * @returns Detached low-level item when present.
   */
  async getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.authorityGetCommands.push(command)
    const item = this.items.get(readCommandRecordKey(command))
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Completes target state-incarnation preparation.
   */
  async prepareTargetEvidenceWrite(): Promise<void> {
    this.events?.push('prepare')
    const action = this.beforeTargetPrepare
    this.beforeTargetPrepare = undefined
    await action?.()
    this.prepareCalls.push(true)
  }

  /**
   * Completes authority state-incarnation preparation.
   */
  async preparePrePlanAuthorityWrite(): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Evaluates and atomically applies one target-evidence transaction.
   *
   * @param command - Adapter-owned five-item transaction.
   * @returns Empty successful DynamoDB response.
   */
  async transactWriteTargetEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.events?.push('transaction')
    this.transactionCommands.push(command)
    const fault = this.transactionFault
    this.transactionFault = undefined
    if (fault?.timing === 'before-commit') throw fault.error
    const action = this.beforeTargetTransaction
    this.beforeTargetTransaction = undefined
    await action?.()
    this.applyTransaction(command)
    if (fault?.timing === 'after-commit') {
      await fault.afterCommit?.()
      throw fault.error
    }
    return { $metadata: {} }
  }

  /**
   * Evaluates and atomically applies one authority transaction.
   *
   * @param command - Authority-adapter-owned transaction.
   * @returns Empty successful DynamoDB response.
   */
  async transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.authorityTransactionCommands.push(command)
    this.applyTransaction(command)
    return { $metadata: {} }
  }

  /**
   * Applies supported conditions and writes against one atomic snapshot.
   *
   * @param command - Exact authority or target-evidence transaction.
   */
  private applyTransaction(command: TransactWriteItemsCommand): void {
    const entries = requireTransactionItems(command)
    const failures: boolean[] = []
    const writes: PlannedWrite[] = []
    for (const entry of entries) {
      if (entry.ConditionCheck !== undefined) {
        const check = entry.ConditionCheck
        const recordKey = readKeyRecordKey(check.Key)
        failures.push(!conditionMatches(
          this.items.get(recordKey),
          check.ConditionExpression,
          check.ExpressionAttributeNames,
          check.ExpressionAttributeValues,
        ))
        continue
      }
      if (entry.Put !== undefined) {
        const put = entry.Put
        const item = requireItem(put.Item)
        const recordKey = readStringAttribute(item, 'recordKey')
        failures.push(!conditionMatches(
          this.items.get(recordKey),
          put.ConditionExpression,
          put.ExpressionAttributeNames,
          put.ExpressionAttributeValues,
        ))
        writes.push({
          recordKey,
          item: structuredClone(item),
        })
        continue
      }
      throw new Error('Unsupported in-memory transaction entry.')
    }
    if (failures.some(Boolean)) {
      throw createConditionalTransactionFailure(failures)
    }
    for (const write of writes) {
      this.items.set(write.recordKey, write.item)
    }
  }
}

/**
 * Creates the in-memory identity of one exact immutable artifact version.
 *
 * @param reference - Exact content-addressed S3 version reference.
 * @returns Collision-free test-store key.
 */
function createStoredArtifactKey(
  reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Creates one canonical planning target artifact page.
 *
 * @param input - Exact capture or committed-read identity.
 * @param items - Every raw item from the target Scan page.
 * @returns Complete lossless planning target page.
 */
function createPlanningTargetArtifactPage(
  input:
    | WorkspaceSearchMigrationPlanningTargetArtifactCaptureInput
    | WorkspaceSearchMigrationPlanningTargetArtifactReadInput,
  items: readonly DynamoAttributeMap[],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const targetTable = input.configuration.tables['workspace-search']
  const stateTable = input.configuration.tables['migration-state']
  return {
    kind: 'workspace-search-planning-target-artifact-page',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    runId: input.runId,
    configurationHash: input.configurationHash,
    targetTable: {
      tableName: targetTable.tableName,
      tableArn: targetTable.tableArn,
      tableId: targetTable.tableId,
      creationTime: targetTable.creationTime,
    },
    stateTable: {
      tableName: stateTable.tableName,
      tableArn: stateTable.tableArn,
      tableId: stateTable.tableId,
      creationTime: stateTable.creationTime,
    },
    pageSequence: input.pageSequence,
    previousEvidenceDigest: input.previousEvidenceDigest,
    previousCheckpointDigest: input.previousCheckpointDigest,
    planningAuthority: structuredClone(input.planningAuthority),
    items: structuredClone(items),
  }
}

/**
 * Creates one authority-bearing planning commit request.
 *
 * @param configuration - Exact measured migration configuration.
 * @param authority - Exact current durable authority aggregate.
 * @returns Complete planning target-evidence commit request.
 */
function createPlanningRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationPlanningTargetEvidenceAwsCommitRequest {
  return {
    runId: authority.lease.runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    authority: structuredClone(authority),
  }
}

/**
 * Creates one strict authority-free planning read request.
 *
 * @param configuration - Exact measured migration configuration.
 * @param runId - Operator-selected planning run identifier.
 * @returns Complete target-evidence read request.
 */
function createReadRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  runId: string,
): WorkspaceSearchMigrationTargetEvidenceAwsRequest {
  return {
    runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
  }
}

/**
 * Creates one target-evidence port over a supplied gateway and transport.
 *
 * @param configuration - Exact measured migration configuration.
 * @param gateway - Planning-only target artifact gateway.
 * @param transport - Shared condition-aware state transport.
 * @param clock - Trusted commit clock.
 * @returns Configured durable target-evidence port.
 */
function createTargetEvidencePort(
  configuration: WorkspaceSearchMigrationConfiguration,
  gateway: WorkspaceSearchMigrationPlanningTargetArtifactGateway,
  transport: InMemoryTargetEvidenceAwsTransport,
  clock: () => Date = () => new Date(initialTime),
): WorkspaceSearchMigrationTargetEvidenceAwsPort {
  return createAwsWorkspaceSearchMigrationTargetEvidencePort({
    stateTable: configuration.tables['migration-state'],
    planningArtifactGateway: gateway,
    transport,
    clock,
  })
}

/**
 * Creates one authority adapter bound to the measured configuration.
 *
 * @param configuration - Exact measured migration configuration.
 * @param transport - Shared authority and evidence transport.
 * @param clock - Mutable trusted clock.
 * @returns Configured pre-plan authority port.
 */
function createAuthorityPort(
  configuration: WorkspaceSearchMigrationConfiguration,
  transport: InMemoryTargetEvidenceAwsTransport,
  clock: MutableAuthorityClock,
): WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  return createAwsWorkspaceSearchMigrationPrePlanAuthorityPort({
    stateTable: configuration.tables['migration-state'],
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    transport,
    clock: () => clock.read(),
  })
}

/**
 * Acquires one global lease and publishes its first maintenance receipt.
 *
 * @param configuration - Exact measured migration configuration.
 * @param transport - Shared authority and evidence transport.
 * @param clock - Mutable trusted clock.
 * @param runId - Planning run identifier.
 * @param ownerId - Process-unique planning owner.
 * @returns Authority port and exact current authority aggregate.
 */
async function acquirePlanningAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  transport: InMemoryTargetEvidenceAwsTransport,
  clock: MutableAuthorityClock,
  runId: string,
  ownerId: string,
): Promise<{
  /** Durable authority port used for same-fence updates. */
  readonly port: WorkspaceSearchMigrationPrePlanAuthorityAwsPort
  /** Exact lease, pointer, and receipt aggregate. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
}> {
  const port = createAuthorityPort(configuration, transport, clock)
  const lease = await port.acquireLease({ runId, ownerId })
  const authority = await port.renewMaintenanceEvidence({
    lease: createLeaseClaim(lease),
    expectedPointer: null,
    evidenceBytes: createMaintenanceEvidenceBytes(
      clock.read().toISOString(),
    ),
  })
  return { port, authority }
}

/**
 * Creates the exact fenced lease claim used by authority mutations.
 *
 * @param lease - Current durable lease.
 * @returns Detached run, owner, and fence claim.
 */
function createLeaseClaim(
  lease: WorkspaceSearchMigrationPrePlanAuthority['lease'],
): WorkspaceSearchMigrationLeaseClaim {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
  }
}

/**
 * Creates valid fresh maintenance-evidence bytes at one clock instant.
 *
 * @param at - Adapter validation time.
 * @param locator - Secret-free change-record locator.
 * @returns Strict UTF-8 JSON evidence bytes.
 */
function createMaintenanceEvidenceBytes(
  at: string,
  locator = 'change:TARGET-EVIDENCE',
): Uint8Array {
  const now = requireEpochMilliseconds(at)
  const drainCompletedAt = new Date(now - 60_000).toISOString()
  const drainStartedAt =
    new Date(now - 60_000 - 15 * 60_000).toISOString()
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    locator,
    runtimeMode: 'disabled',
    runtimeRevision: 42,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 42,
      observedAt: drainCompletedAt,
    })),
  }))
}

/**
 * Captures one public fixed-code migration failure.
 *
 * @param operation - Asynchronous adapter call expected to fail.
 * @returns Exact public failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected a Workspace Search migration failure.')
}

/**
 * Reads the deterministic record key from one GetItem command.
 *
 * @param command - Adapter-owned strongly consistent read.
 * @returns Exact state-table sort key.
 */
function readCommandRecordKey(command: GetItemCommand): string {
  return readKeyRecordKey(command.input.Key)
}

/**
 * Reads a complete DynamoDB key and validates its migration partition.
 *
 * @param key - Candidate low-level key.
 * @returns Exact deterministic record key.
 */
function readKeyRecordKey(
  key: Record<string, AttributeValue> | undefined,
): string {
  if (key === undefined) throw new Error('Expected one DynamoDB key.')
  if (
    readStringAttribute(key, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID
  ) {
    throw new Error('Unexpected migration partition key.')
  }
  return readStringAttribute(key, 'recordKey')
}

/**
 * Requires a nonempty adapter-generated transaction.
 *
 * @param command - Candidate transaction command.
 * @returns Exact transaction entries.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand,
): readonly TransactWriteItem[] {
  const entries = command.input.TransactItems
  if (entries === undefined || entries.length === 0) {
    throw new Error('Expected one nonempty transaction.')
  }
  return entries
}

/**
 * Requires one complete transaction condition check.
 *
 * @param item - Candidate transaction entry.
 * @returns Exact condition check.
 */
function requireConditionCheck(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['ConditionCheck']> {
  if (item?.ConditionCheck === undefined) {
    throw new Error('Expected one transaction condition check.')
  }
  return item.ConditionCheck
}

/**
 * Requires one detached stored item.
 *
 * @param item - Candidate durable row.
 * @returns Complete stored item.
 */
function requireStoredItem(
  item: Readonly<Record<string, AttributeValue>> | undefined,
): Readonly<Record<string, AttributeValue>> {
  if (item === undefined) throw new Error('Expected one stored item.')
  return item
}

/**
 * Requires one optional low-level item for inspection.
 *
 * @param item - Candidate low-level DynamoDB item.
 * @returns Complete item.
 */
function requireItem(
  item: Record<string, AttributeValue> | undefined,
): Record<string, AttributeValue> {
  if (item === undefined) throw new Error('Expected one complete item.')
  return item
}

/**
 * Reads one exact string attribute from a low-level item.
 *
 * @param item - Low-level DynamoDB item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.S === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact string attribute ${name}.`)
  }
  return attribute.S
}

/**
 * Reads one exact binary attribute from a low-level item.
 *
 * @param item - Low-level DynamoDB item.
 * @param name - Required attribute name.
 * @returns Detached exact bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.B === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact binary attribute ${name}.`)
  }
  return new Uint8Array(attribute.B)
}

/**
 * Reads one exact safe integer attribute from a low-level item.
 *
 * @param item - Low-level DynamoDB item.
 * @param name - Required attribute name.
 * @returns Parsed safe integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.N === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact number attribute ${name}.`)
  }
  const value = Number(attribute.N)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected safe integer attribute ${name}.`)
  }
  return value
}

/**
 * Reads one exact nested map from a low-level item.
 *
 * @param item - Low-level DynamoDB item or nested map.
 * @param name - Required attribute name.
 * @returns Exact nested attribute map.
 */
function readMapAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Readonly<Record<string, AttributeValue>> {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.M === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact map attribute ${name}.`)
  }
  return attribute.M
}

/**
 * Evaluates the constrained condition grammar emitted by both adapters.
 *
 * @param current - Existing row in the transaction snapshot.
 * @param expression - Adapter-generated condition expression.
 * @param names - Exact attribute aliases.
 * @param values - Exact condition operands.
 * @returns Whether every AND clause is true.
 */
function conditionMatches(
  current: Readonly<Record<string, AttributeValue>> | undefined,
  expression: string | undefined,
  names: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, AttributeValue>> | undefined,
): boolean {
  if (expression === undefined) {
    throw new Error('Every in-memory write must carry a condition.')
  }
  const attributeNames = names ?? {}
  const attributeValues = values ?? {}
  for (const clause of expression.split(' AND ')) {
    const absentMatch =
      /^attribute_not_exists\((#[A-Za-z0-9_]+)\)$/u.exec(clause)
    if (absentMatch !== null) {
      const alias = absentMatch[1]
      if (alias === undefined) {
        throw new Error('Malformed attribute-not-exists condition.')
      }
      const name = attributeNames[alias]
      if (name === undefined) {
        throw new Error('Missing attribute-name alias.')
      }
      if (current?.[name] !== undefined) return false
      continue
    }
    const comparison =
      /^(#[A-Za-z0-9_]+) (=|<=|>=|<|>) (:[A-Za-z0-9_]+)$/u
        .exec(clause)
    if (comparison === null) {
      throw new Error(`Unsupported condition clause: ${clause}`)
    }
    const alias = comparison[1]
    const operator = comparison[2]
    const valueAlias = comparison[3]
    if (
      alias === undefined ||
      operator === undefined ||
      valueAlias === undefined
    ) {
      throw new Error('Malformed comparison condition.')
    }
    const name = attributeNames[alias]
    const expected = attributeValues[valueAlias]
    if (name === undefined || expected === undefined) {
      throw new Error('Missing comparison alias or operand.')
    }
    const actual = current?.[name]
    if (
      actual === undefined ||
      !attributeComparisonMatches(actual, operator, expected)
    ) {
      return false
    }
  }
  return true
}

/**
 * Compares two low-level values with the emitted condition operator.
 *
 * @param actual - Existing attribute value.
 * @param operator - Exact comparison operator.
 * @param expected - Condition operand.
 * @returns Whether the comparison succeeds.
 */
function attributeComparisonMatches(
  actual: AttributeValue,
  operator: string,
  expected: AttributeValue,
): boolean {
  if (operator === '=') return Bun.deepEquals(actual, expected)
  if (actual.N === undefined || expected.N === undefined) {
    throw new Error('Ordered conditions require numeric values.')
  }
  const actualNumber = Number(actual.N)
  const expectedNumber = Number(expected.N)
  if (
    !Number.isFinite(actualNumber) ||
    !Number.isFinite(expectedNumber)
  ) {
    throw new Error('Invalid numeric condition.')
  }
  if (operator === '<') return actualNumber < expectedNumber
  if (operator === '<=') return actualNumber <= expectedNumber
  if (operator === '>') return actualNumber > expectedNumber
  if (operator === '>=') return actualNumber >= expectedNumber
  throw new Error(`Unsupported comparison operator: ${operator}`)
}

/**
 * Creates an SDK cancellation with one reason per transaction entry.
 *
 * @param failures - Whether each corresponding condition failed.
 * @returns Real low-level transaction cancellation.
 */
function createConditionalTransactionFailure(
  failures: readonly boolean[],
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'Condition-aware target evidence transaction was canceled.',
    CancellationReasons: failures.map((failed) => ({
      Code: failed ? 'ConditionalCheckFailed' : 'None',
    })),
  })
}

/**
 * Creates one cancellation carrying a failure at a fixed transaction index.
 *
 * @param index - Zero-based failed transaction item.
 * @param entryCount - Total transaction item count.
 * @param code - Stable DynamoDB reason code.
 * @returns Real SDK transaction cancellation.
 */
function createCancellationAtIndex(
  index: number,
  entryCount: number,
  code = 'ConditionalCheckFailed',
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'Indexed target evidence cancellation.',
    CancellationReasons: Array.from(
      { length: entryCount },
      (_, reasonIndex) => ({
        Code: reasonIndex === index ? code : 'None',
      }),
    ),
  })
}

/**
 * Creates one raw Error with an explicit stable classifier name.
 *
 * @param name - Error name consumed by the adapter classifier.
 * @param message - Secret-bearing canary message.
 * @returns Named raw error.
 */
function createNamedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * Parses one durable target-evidence page payload.
 *
 * @param item - Durable low-level page row.
 * @returns Strict planning v1 target evidence.
 */
function readTargetEvidencePage(
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationTargetEvidencePage {
  return parseWorkspaceSearchMigrationTargetEvidencePage(
    readBinaryAttribute(item, 'payload'),
  )
}

/**
 * Parses one canonical timestamp for mutable clock fixtures.
 *
 * @param at - Candidate timestamp.
 * @returns Finite nonnegative epoch milliseconds.
 */
function requireEpochMilliseconds(at: string): number {
  const value = Date.parse(at)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected one valid test timestamp.')
  }
  return value
}

/**
 * Creates one recognized saved-view target row.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level ignored target item.
 */
function createIgnoredTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one key-valid row with a conflicting target discriminator.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level invalid target item.
 */
function createInvalidTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'search-document' },
  }
}

/**
 * Extracts one exact target primary key from a fixture item.
 *
 * @param item - Complete target item.
 * @returns Detached composite primary key.
 */
function createTargetItemKey(
  item: DynamoAttributeMap,
): DynamoAttributeMap {
  const workspaceId = item.workspaceId
  const recordKey = item.recordKey
  if (workspaceId === undefined || recordKey === undefined) {
    throw new Error('Expected one complete target key.')
  }
  return structuredClone({ workspaceId, recordKey })
}

/**
 * Creates one ResourceNotFoundException without exposing raw resources.
 *
 * @returns SDK-compatible table-not-found exception.
 */
function createResourceNotFoundError(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    $metadata: {},
    message: 'RAW-RESOURCE-NOT-FOUND-CANARY',
  })
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Exact configuration bound to every test request.
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
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
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
 * Creates one complete measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
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
    key: sourceKeyDescriptors(role),
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: false,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? createMigrationDigest('documents-key')
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
 * Creates one complete target or state table identity.
 *
 * @param role - Supporting migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
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
    key: role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and optional sort-key descriptors.
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

describe('Workspace Search migration target evidence AWS adapter', () => {
  test('resumes a multi-page chain and never captures a terminal head again', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-resume',
      'owner-target-resume',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const readRequest = createReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    )
    const firstItem = createIgnoredTargetItem('page-1')
    const firstGateway = new InMemoryPlanningTargetArtifactGateway(
      [{
        items: [firstItem],
        lastEvaluatedKey: createTargetItemKey(firstItem),
      }],
      transport.planningArtifactStore,
    )
    const firstPort = createTargetEvidencePort(
      configuration,
      firstGateway,
      transport,
      () => clock.read(),
    )

    const initial = await firstPort.readProgress(readRequest)
    const first = await firstPort.commitNextPage(request)

    expect(initial).toMatchObject({
      purpose: 'planning',
      pageSequence: 0,
      checkpoint: {
        completed: false,
        aggregate: {
          scanned: 0,
          ignored: 0,
          invalid: 0,
          owned: 0,
          pageCount: 0,
        },
      },
    })
    expect(first).toMatchObject({
      purpose: 'planning',
      pageSequence: 1,
      checkpoint: {
        completed: false,
        aggregate: {
          scanned: 1,
          ignored: 1,
          invalid: 0,
          owned: 0,
          pageCount: 1,
        },
      },
    })
    const secondGateway = new InMemoryPlanningTargetArtifactGateway(
      [{
        items: [createInvalidTargetItem('page-2')],
      }],
      transport.planningArtifactStore,
    )
    const resumedPort = createTargetEvidencePort(
      configuration,
      secondGateway,
      transport,
      () => clock.read(),
    )

    expect(await resumedPort.readProgress(readRequest)).toEqual(first)
    const completed = await resumedPort.commitNextPage(request)
    const captureCount = secondGateway.captureCalls.length
    const prepareCount = transport.prepareCalls.length
    const transactionCount = transport.transactionCommands.length
    const repeated = await resumedPort.commitNextPage(request)
    transport.startTargetPageReadConcurrencyMeasurement()
    const replay = await resumedPort.readCommittedEvidence(readRequest)

    expect(secondGateway.captureCalls[0]?.previousCheckpoint)
      .toEqual(first.checkpoint)
    expect(completed).toMatchObject({
      purpose: 'planning',
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: {
          scanned: 2,
          ignored: 1,
          invalid: 1,
          owned: 0,
          pageCount: 2,
        },
      },
    })
    expect(repeated).toEqual(completed)
    expect(replay.progress).toEqual(completed)
    expect(replay.targetRows).toHaveLength(1)
    expect(replay.invalidRows).toHaveLength(1)
    expect(replay.observedTargetBindings).toHaveLength(0)
    expect(transport.readMaximumConcurrentTargetPageReads()).toBe(2)
    expect(secondGateway.captureCalls).toHaveLength(captureCount)
    expect(transport.prepareCalls).toHaveLength(prepareCount)
    expect(transport.transactionCommands).toHaveLength(transactionCount)
    expect(transport.readStoredItemsByKind(targetPageKind)).toHaveLength(2)
    expect(transport.readStoredItemsByKind(targetHeadKind)).toHaveLength(1)
  })

  test('validates prior artifacts and global uniqueness before a terminal commit', async () => {
    {
      const configuration = createConfiguration()
      const transport = new InMemoryTargetEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        'run-target-terminal-artifact-loss',
        'owner-target-terminal-artifact-loss',
      )
      const firstItem = createIgnoredTargetItem('terminal-artifact-first')
      const gateway = new InMemoryPlanningTargetArtifactGateway(
        [
          {
            items: [firstItem],
            lastEvaluatedKey: createTargetItemKey(firstItem),
          },
          {
            items: [
              createIgnoredTargetItem('terminal-artifact-second'),
            ],
          },
        ],
        transport.planningArtifactStore,
      )
      const port = createTargetEvidencePort(
        configuration,
        gateway,
        transport,
        () => clock.read(),
      )
      const request = createPlanningRequest(
        configuration,
        authorityContext.authority,
      )
      await port.commitNextPage(request)
      const firstPage = readTargetEvidencePage(requireStoredItem(
        transport.readStoredItemByKind(targetPageKind),
      ))
      const firstReference = firstPage.targetArtifacts[0]
      if (firstReference === undefined) {
        throw new Error('Expected one first-page target artifact.')
      }
      gateway.deleteStoredArtifact(firstReference)
      const prepareCount = transport.prepareCalls.length

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(request),
      )

      expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
      expect(gateway.readCalls).toHaveLength(1)
      expect(transport.prepareCalls).toHaveLength(prepareCount)
      expect(transport.transactionCommands).toHaveLength(1)
      expect(transport.readStoredItemsByKind(targetPageKind))
        .toHaveLength(1)
      expect(readNumberAttribute(
        requireStoredItem(
          transport.readStoredItemByKind(targetHeadKind),
        ),
        'revision',
      )).toBe(1)
    }

    {
      const configuration = createConfiguration()
      const transport = new InMemoryTargetEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        'run-target-terminal-duplicate',
        'owner-target-terminal-duplicate',
      )
      const duplicateItem = createIgnoredTargetItem(
        'terminal-cross-page-duplicate',
      )
      const gateway = new InMemoryPlanningTargetArtifactGateway(
        [
          {
            items: [duplicateItem],
            lastEvaluatedKey: createTargetItemKey(duplicateItem),
          },
          { items: [duplicateItem] },
        ],
        transport.planningArtifactStore,
      )
      const port = createTargetEvidencePort(
        configuration,
        gateway,
        transport,
        () => clock.read(),
      )
      const request = createPlanningRequest(
        configuration,
        authorityContext.authority,
      )
      await port.commitNextPage(request)
      const prepareCount = transport.prepareCalls.length

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(request),
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(gateway.readCalls).toHaveLength(1)
      expect(transport.prepareCalls).toHaveLength(prepareCount)
      expect(transport.transactionCommands).toHaveLength(1)
      expect(transport.readStoredItemsByKind(targetPageKind))
        .toHaveLength(1)
      expect(readNumberAttribute(
        requireStoredItem(
          transport.readStoredItemByKind(targetHeadKind),
        ),
        'revision',
      )).toBe(1)
    }
  })

  test('uses v1 physical keys and strongly isolates independent runs', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-key-a',
      'owner-target-key-a',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('physical-key')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    const firstRunRead = createReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    )
    const secondRunRead = createReadRequest(
      configuration,
      'run-target-key-b',
    )

    const firstInitial = await port.readProgress(firstRunRead)
    const secondInitial = await port.readProgress(secondRunRead)
    const firstCommitted = await port.commitNextPage(
      createPlanningRequest(configuration, authorityContext.authority),
    )
    const secondAfterFirstCommit = await port.readProgress(secondRunRead)

    expect(firstInitial.pageSequence).toBe(0)
    expect(firstCommitted.pageSequence).toBe(1)
    expect(secondAfterFirstCommit).toEqual(secondInitial)
    expect(secondInitial.pageSequence).toBe(0)
    const firstRunHeadRead = transport.getCommands[0]
    const secondRunHeadRead = transport.getCommands[1]
    if (
      firstRunHeadRead === undefined ||
      secondRunHeadRead === undefined
    ) {
      throw new Error('Expected both isolated run head reads.')
    }
    const firstRunHeadKey = readCommandRecordKey(firstRunHeadRead)
    const secondRunHeadKey = readCommandRecordKey(secondRunHeadRead)
    expect(firstRunHeadKey)
      .toMatch(/^target-evidence\/v1\/[0-9a-f]{64}\/head$/u)
    expect(secondRunHeadKey)
      .toMatch(/^target-evidence\/v1\/[0-9a-f]{64}\/head$/u)
    expect(firstRunHeadKey).not.toBe(secondRunHeadKey)
    for (const command of transport.getCommands) {
      expect(command.input.TableName)
        .toBe(configuration.tables['migration-state'].tableName)
      expect(command.input.ConsistentRead).toBe(true)
    }
    const transaction = transport.transactionCommands[0]
    if (transaction === undefined) {
      throw new Error('Expected one target-evidence transaction.')
    }
    const entries = requireTransactionItems(transaction)
    for (const entry of entries) {
      expect(
        entry.ConditionCheck?.TableName ?? entry.Put?.TableName,
      ).toBe(configuration.tables['migration-state'].tableName)
    }
    const pageItem = requireItem(entries[3]?.Put?.Item)
    const headItem = requireItem(entries[4]?.Put?.Item)
    const pageRecordKey = readStringAttribute(pageItem, 'recordKey')
    const headRecordKey = readStringAttribute(headItem, 'recordKey')
    expect(headRecordKey).toBe(firstRunHeadKey)
    expect(pageRecordKey)
      .toMatch(
        /^target-evidence\/v1\/[0-9a-f]{64}\/page\/0000000000000001$/u,
      )
    expect(pageRecordKey)
      .toBe(firstRunHeadKey.replace(
        /\/head$/u,
        '/page/0000000000000001',
      ))
  })

  test('uses the fixed five-item layout and exact absent and existing CAS', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-cas',
      'owner-target-cas',
    )
    const firstItem = createIgnoredTargetItem('cas-1')
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [
        {
          items: [firstItem],
          lastEvaluatedKey: createTargetItemKey(firstItem),
        },
        { items: [createIgnoredTargetItem('cas-2')] },
      ],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )

    await port.commitNextPage(request)
    await port.commitNextPage(request)

    const firstCommand = transport.transactionCommands[0]
    const secondCommand = transport.transactionCommands[1]
    if (firstCommand === undefined || secondCommand === undefined) {
      throw new Error('Expected two target evidence transactions.')
    }
    const firstEntries = requireTransactionItems(firstCommand)
    const secondEntries = requireTransactionItems(secondCommand)
    expect(firstEntries).toHaveLength(5)
    expect(secondEntries).toHaveLength(5)
    const authorityRows = [
      requireStoredItem(transport.readStoredItemByKind(leaseKind)),
      requireStoredItem(transport.readStoredItemByKind(pointerKind)),
      requireStoredItem(transport.readStoredItemByKind(receiptKind)),
    ]
    for (const [index, authorityRow] of authorityRows.entries()) {
      const check = requireConditionCheck(firstEntries[index])
      expect(readKeyRecordKey(check.Key))
        .toBe(readStringAttribute(authorityRow, 'recordKey'))
      expect(conditionMatches(
        authorityRow,
        check.ConditionExpression,
        check.ExpressionAttributeNames,
        check.ExpressionAttributeValues,
      )).toBe(true)
    }
    const firstPagePut = firstEntries[3]?.Put
    const firstHeadPut = firstEntries[4]?.Put
    const secondPagePut = secondEntries[3]?.Put
    const secondHeadPut = secondEntries[4]?.Put
    const absentCondition =
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)'
    expect(firstPagePut?.ConditionExpression).toBe(absentCondition)
    expect(firstHeadPut?.ConditionExpression).toBe(absentCondition)
    expect(secondPagePut?.ConditionExpression).toBe(absentCondition)
    expect(readStringAttribute(
      requireItem(firstPagePut?.Item),
      'kind',
    )).toBe(targetPageKind)
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'kind',
    )).toBe(targetHeadKind)
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'purpose',
    )).toBe('planning')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'targetTableId',
    )).toBe('table-id-workspace-search')
    expect(readNumberAttribute(
      requireItem(firstHeadPut?.Item),
      'chainEvidenceVersion',
    )).toBe(1)
    expect(secondHeadPut?.ConditionExpression).toBe([
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
    ].join(' AND '))
    expect(secondHeadPut?.ExpressionAttributeValues).toMatchObject({
      ':kind': { S: targetHeadKind },
      ':version': { N: '1' },
      ':run': { S: 'run-target-cas' },
      ':purpose': { S: 'planning' },
      ':targetTableId': { S: 'table-id-workspace-search' },
      ':stateTableId': { S: 'table-id-migration-state' },
      ':revision': { N: '1' },
      ':completed': { BOOL: false },
      ':chainEvidenceVersion': { N: '1' },
    })
    expect(firstCommand.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/u)
    expect(secondCommand.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/u)
    expect(firstCommand.input.ClientRequestToken).toHaveLength(36)
    expect(secondCommand.input.ClientRequestToken).toHaveLength(36)
    expect(firstCommand.input.ClientRequestToken)
      .not.toBe(secondCommand.input.ClientRequestToken)
    const page = readTargetEvidencePage(
      requireItem(firstPagePut?.Item),
    )
    expect(page.evidenceVersion).toBe(1)
    expect(page.targetArtifacts).toHaveLength(1)
  })

  test('binds retry tokens and authority deadlines to each commit clock', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-clock-retry',
      'owner-target-clock-retry',
    )
    const retriedPage = {
      items: [createIgnoredTargetItem('clock-retry')],
    }
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [retriedPage, retriedPage],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    transport.failNextTransaction({
      timing: 'before-commit',
      error: createNamedError(
        'TransactionConflictException',
        'RAW-TARGET-CLOCK-RETRY-CANARY',
      ),
    })

    const firstFailure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )
    clock.set('2026-07-25T04:00:05.000Z')
    const committed = await port.commitNextPage(request)

    expect(firstFailure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(committed.pageSequence).toBe(1)
    expect(gateway.captureCalls).toHaveLength(2)
    expect(transport.prepareCalls).toHaveLength(2)
    expect(transport.transactionCommands).toHaveLength(2)
    const firstCommand = transport.transactionCommands[0]
    const secondCommand = transport.transactionCommands[1]
    if (firstCommand === undefined || secondCommand === undefined) {
      throw new Error('Expected both retry transaction attempts.')
    }
    expect(firstCommand.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/u)
    expect(secondCommand.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/u)
    expect(firstCommand.input.ClientRequestToken)
      .not.toBe(secondCommand.input.ClientRequestToken)
    const firstEntries = requireTransactionItems(firstCommand)
    const secondEntries = requireTransactionItems(secondCommand)
    expect(firstEntries[3]?.Put?.Item)
      .toEqual(secondEntries[3]?.Put?.Item)
    expect(firstEntries[4]?.Put?.Item)
      .toEqual(secondEntries[4]?.Put?.Item)
    for (let index = 0; index < 3; index += 1) {
      const firstCheck = requireConditionCheck(firstEntries[index])
      const secondCheck = requireConditionCheck(secondEntries[index])
      const firstDeadline = readNumberAttribute(
        requireItem(firstCheck.ExpressionAttributeValues),
        ':minimumExpiry',
      )
      const secondDeadline = readNumberAttribute(
        requireItem(secondCheck.ExpressionAttributeValues),
        ':minimumExpiry',
      )
      expect(secondDeadline - firstDeadline).toBe(5_000)
    }
  })

  test('stores artifacts before prepare, clock, and transaction', async () => {
    const events: string[] = []
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport(events)
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-order',
      'owner-target-order',
    )
    events.splice(0)
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('order')] }],
      transport.planningArtifactStore,
      events,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => {
        events.push('clock')
        return clock.read()
      },
    )

    await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    expect(events).toEqual([
      'capture',
      'artifact-stored',
      'prepare',
      'clock',
      'transaction',
    ])
  })

  test('stops after artifact upload failure without later side effects', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-upload-failure',
      'owner-target-upload-failure',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('upload-failure')] }],
      transport.planningArtifactStore,
    )
    gateway.failNextCapture(createNamedError(
      'TimeoutError',
      'RAW-TARGET-ARTIFACT-UPLOAD-CANARY',
    ))
    let clockCalls = 0
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => {
        clockCalls += 1
        return clock.read()
      },
    )

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(createPlanningRequest(
        configuration,
        authorityContext.authority,
      )),
    )

    expect(failure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(failure.message)
      .not.toContain('RAW-TARGET-ARTIFACT-UPLOAD-CANARY')
    expect(gateway.captureCalls).toHaveLength(1)
    expect(transport.prepareCalls).toHaveLength(0)
    expect(clockCalls).toBe(0)
    expect(transport.transactionCommands).toHaveLength(0)
    expect(transport.readStoredItemsByKind(targetPageKind)).toHaveLength(0)
  })

  test('requires the gateway and rejects caller-supplied commit material before I/O', async () => {
    const configuration = createConfiguration()
    const dependencyTransport =
      new InMemoryTargetEvidenceAwsTransport()
    const dependencyGateway =
      new InMemoryPlanningTargetArtifactGateway(
        [],
        dependencyTransport.planningArtifactStore,
      )
    const missingGatewayInput = {
      stateTable: configuration.tables['migration-state'],
      planningArtifactGateway: dependencyGateway,
      transport: dependencyTransport,
      clock: () => new Date(initialTime),
    }
    expect(Reflect.deleteProperty(
      missingGatewayInput,
      'planningArtifactGateway',
    )).toBe(true)

    const missingGatewayFailure = await captureMigrationFailure(
      async () => {
        createAwsWorkspaceSearchMigrationTargetEvidencePort(
          missingGatewayInput,
        )
        await Promise.resolve()
      },
    )

    expect(missingGatewayFailure.code).toBe('INVALID_ARGUMENT')
    expect(dependencyGateway.captureCalls).toHaveLength(0)
    expect(dependencyGateway.readCalls).toHaveLength(0)
    expect(dependencyTransport.getCommands).toHaveLength(0)
    expect(dependencyTransport.prepareCalls).toHaveLength(0)
    expect(dependencyTransport.transactionCommands).toHaveLength(0)

    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-strict-input',
      'owner-target-strict-input',
    )
    const authorityGetCount = transport.authorityGetCommands.length
    const authorityTransactionCount =
      transport.authorityTransactionCommands.length
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('strict-input')] }],
      transport.planningArtifactStore,
    )
    let commitClockCalls = 0
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => {
        commitClockCalls += 1
        return clock.read()
      },
    )
    const missingAuthorityRequest = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    expect(Reflect.deleteProperty(
      missingAuthorityRequest,
      'authority',
    )).toBe(true)

    const missingAuthorityFailure = await captureMigrationFailure(
      () => port.commitNextPage(missingAuthorityRequest),
    )

    expect(missingAuthorityFailure.code)
      .toBe('INVALID_MAINTENANCE_EVIDENCE')
    const injectedValues: Readonly<Record<string, unknown>> = {
      pageResult: {},
      items: [createIgnoredTargetItem('injected-raw-item')],
      cursor: createTargetItemKey(
        createIgnoredTargetItem('injected-cursor'),
      ),
    }
    for (const [property, value] of Object.entries(injectedValues)) {
      const injectedRequest = createPlanningRequest(
        configuration,
        authorityContext.authority,
      )
      expect(Reflect.set(injectedRequest, property, value)).toBe(true)
      const failure = await captureMigrationFailure(
        () => port.commitNextPage(injectedRequest),
      )
      expect(failure.code).toBe('INVALID_ARGUMENT')
    }
    expect(gateway.captureCalls).toHaveLength(0)
    expect(gateway.readCalls).toHaveLength(0)
    expect(transport.getCommands).toHaveLength(0)
    expect(transport.prepareCalls).toHaveLength(0)
    expect(transport.transactionCommands).toHaveLength(0)
    expect(transport.authorityGetCommands)
      .toHaveLength(authorityGetCount)
    expect(transport.authorityTransactionCommands)
      .toHaveLength(authorityTransactionCount)
    expect(commitClockCalls).toBe(0)
  })

  test('classifies authority failures by fixed transaction index', async () => {
    const expectedCodes:
      readonly WorkspaceSearchMigrationFailureCode[] = [
      'LEASE_LOST',
      'INVALID_MAINTENANCE_EVIDENCE',
      'INVALID_MAINTENANCE_EVIDENCE',
      'INVALID_STATE',
      'INVALID_STATE',
    ]
    for (const [index, expectedCode] of expectedCodes.entries()) {
      const configuration = createConfiguration()
      const transport = new InMemoryTargetEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        `run-target-index-${index}`,
        `owner-target-index-${index}`,
      )
      const gateway = new InMemoryPlanningTargetArtifactGateway(
        [{ items: [createIgnoredTargetItem(`index-${index}`)] }],
        transport.planningArtifactStore,
      )
      const port = createTargetEvidencePort(
        configuration,
        gateway,
        transport,
        () => clock.read(),
      )
      transport.failNextTransaction({
        timing: 'before-commit',
        error: createCancellationAtIndex(index, 5),
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(createPlanningRequest(
          configuration,
          authorityContext.authority,
        )),
      )

      expect(failure.code).toBe(expectedCode)
      expect(transport.readStoredItemsByKind(targetPageKind))
        .toHaveLength(0)
      expect(transport.readStoredItemsByKind(targetHeadKind))
        .toHaveLength(0)
    }
  })

  test('classifies retryable transaction cancellation reasons as transient', async () => {
    const reasonCodes: readonly string[] = [
      'ThrottlingError',
      'ProvisionedThroughputExceeded',
      'TransactionConflict',
    ]
    for (const reasonCode of reasonCodes) {
      const configuration = createConfiguration()
      const transport = new InMemoryTargetEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        `run-target-cancellation-${reasonCode}`,
        `owner-target-cancellation-${reasonCode}`,
      )
      const gateway = new InMemoryPlanningTargetArtifactGateway(
        [{
          items: [
            createIgnoredTargetItem(`cancellation-${reasonCode}`),
          ],
        }],
        transport.planningArtifactStore,
      )
      const port = createTargetEvidencePort(
        configuration,
        gateway,
        transport,
        () => clock.read(),
      )
      transport.failNextTransaction({
        timing: 'before-commit',
        error: createCancellationAtIndex(4, 5, reasonCode),
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(createPlanningRequest(
          configuration,
          authorityContext.authority,
        )),
      )

      expect(failure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
      expect(transport.transactionCommands).toHaveLength(1)
      expect(transport.readStoredItemsByKind(targetPageKind))
        .toHaveLength(0)
      expect(transport.readStoredItemsByKind(targetHeadKind))
        .toHaveLength(0)
    }
  })

  test('allows a same-fence heartbeat between capture and commit', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-heartbeat',
      'owner-target-heartbeat',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('heartbeat')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    transport.beforeNextTargetTransaction(async () => {
      clock.set('2026-07-25T04:00:05.000Z')
      await authorityContext.port.heartbeatLease({
        lease: createLeaseClaim(authorityContext.authority.lease),
      })
    })

    const result = await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    expect(result).toMatchObject({
      pageSequence: 1,
      checkpoint: { completed: true },
    })
    expect(transport.transactionCommands).toHaveLength(1)
  })

  test('rejects takeover, pointer drift, and receipt drift atomically', async () => {
    const takeoverConfiguration = createConfiguration()
    const takeoverTransport = new InMemoryTargetEvidenceAwsTransport()
    const takeoverClock = new MutableAuthorityClock(initialTime)
    const takeoverAuthority = await acquirePlanningAuthority(
      takeoverConfiguration,
      takeoverTransport,
      takeoverClock,
      'run-target-takeover',
      'owner-target-takeover',
    )
    const takeoverGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('takeover')] }],
      takeoverTransport.planningArtifactStore,
    )
    const takeoverPort = createTargetEvidencePort(
      takeoverConfiguration,
      takeoverGateway,
      takeoverTransport,
      () => takeoverClock.read(),
    )
    takeoverTransport.beforeNextTargetTransaction(async () => {
      takeoverClock.set(takeoverAuthority.authority.lease.expiresAt)
      await createAuthorityPort(
        takeoverConfiguration,
        takeoverTransport,
        takeoverClock,
      ).acquireLease({
        runId: 'run-target-successor',
        ownerId: 'owner-target-successor',
      })
    })
    const takeoverFailure = await captureMigrationFailure(
      () => takeoverPort.commitNextPage(createPlanningRequest(
        takeoverConfiguration,
        takeoverAuthority.authority,
      )),
    )
    expect(takeoverFailure.code).toBe('LEASE_LOST')

    const pointerConfiguration = createConfiguration()
    const pointerTransport = new InMemoryTargetEvidenceAwsTransport()
    const pointerClock = new MutableAuthorityClock(initialTime)
    const pointerAuthority = await acquirePlanningAuthority(
      pointerConfiguration,
      pointerTransport,
      pointerClock,
      'run-target-pointer',
      'owner-target-pointer',
    )
    const pointer = requireStoredItem(
      pointerTransport.readStoredItemByKind(pointerKind),
    )
    pointerTransport.replaceStoredItem({
      ...pointer,
      revision: {
        N: String(
          pointerAuthority.authority
            .maintenanceEvidencePointerRevision + 1,
        ),
      },
    })
    const pointerPort = createTargetEvidencePort(
      pointerConfiguration,
      new InMemoryPlanningTargetArtifactGateway(
        [{ items: [createIgnoredTargetItem('pointer')] }],
        pointerTransport.planningArtifactStore,
      ),
      pointerTransport,
      () => pointerClock.read(),
    )
    const pointerFailure = await captureMigrationFailure(
      () => pointerPort.commitNextPage(createPlanningRequest(
        pointerConfiguration,
        pointerAuthority.authority,
      )),
    )
    expect(pointerFailure.code).toBe('INVALID_MAINTENANCE_EVIDENCE')

    const receiptConfiguration = createConfiguration()
    const receiptTransport = new InMemoryTargetEvidenceAwsTransport()
    const receiptClock = new MutableAuthorityClock(initialTime)
    const receiptAuthority = await acquirePlanningAuthority(
      receiptConfiguration,
      receiptTransport,
      receiptClock,
      'run-target-receipt',
      'owner-target-receipt',
    )
    const receipt = requireStoredItem(
      receiptTransport.readStoredItemByKind(receiptKind),
    )
    receiptTransport.replaceStoredItem({
      ...receipt,
      runtimeRevision: { N: '43' },
    })
    const receiptPort = createTargetEvidencePort(
      receiptConfiguration,
      new InMemoryPlanningTargetArtifactGateway(
        [{ items: [createIgnoredTargetItem('receipt')] }],
        receiptTransport.planningArtifactStore,
      ),
      receiptTransport,
      () => receiptClock.read(),
    )
    const receiptFailure = await captureMigrationFailure(
      () => receiptPort.commitNextPage(createPlanningRequest(
        receiptConfiguration,
        receiptAuthority.authority,
      )),
    )
    expect(receiptFailure.code).toBe('INVALID_MAINTENANCE_EVIDENCE')
    expect(receiptTransport.readStoredItemsByKind(targetHeadKind))
      .toHaveLength(0)
  })

  test('recovers an exact authority-bound commit after response loss', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-response-loss',
      'owner-target-response-loss',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('response-loss')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-TARGET-RESPONSE-LOSS-CANARY',
      ),
    })

    const recovered = await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    expect(recovered).toMatchObject({
      purpose: 'planning',
      pageSequence: 1,
      checkpoint: { completed: true },
    })
    const storedPage = readTargetEvidencePage(requireStoredItem(
      transport.readStoredItemByKind(targetPageKind),
    ))
    expect(gateway.readCalls).toHaveLength(1)
    expect(gateway.readCalls[0]?.targetArtifacts)
      .toEqual(storedPage.targetArtifacts)
    expect(gateway.readCalls[0]?.planningAuthority)
      .toEqual(storedPage.planningAuthority)
    expect(gateway.readCalls[0]?.targetArtifacts[0]?.versionId)
      .toMatch(/^target-version-/u)
    expect(await port.readProgress(createReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    ))).toEqual(recovered)
  })

  test('keeps response loss ambiguous when artifact replay loses its target', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-response-loss-artifact-drift',
      'owner-target-response-loss-artifact-drift',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('response-loss-artifact-drift')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    gateway.failNextRead(createResourceNotFoundError())
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-TARGET-RESPONSE-LOSS-ARTIFACT-CANARY',
      ),
    })

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(createPlanningRequest(
        configuration,
        authorityContext.authority,
      )),
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(failure.message).not.toContain('RAW-RESOURCE-NOT-FOUND-CANARY')
    expect(failure.message)
      .not.toContain('RAW-TARGET-RESPONSE-LOSS-ARTIFACT-CANARY')
  })

  test('recovers its page after a response-lost head advances', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-head-ahead',
      'owner-target-head-ahead',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const firstItem = createIgnoredTargetItem('head-ahead-1')
    const firstGateway = new InMemoryPlanningTargetArtifactGateway(
      [{
        items: [firstItem],
        lastEvaluatedKey: createTargetItemKey(firstItem),
      }],
      transport.planningArtifactStore,
    )
    const firstPort = createTargetEvidencePort(
      configuration,
      firstGateway,
      transport,
      () => clock.read(),
    )
    const advancingGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createInvalidTargetItem('head-ahead-2')] }],
      transport.planningArtifactStore,
    )
    const advancingPort = createTargetEvidencePort(
      configuration,
      advancingGateway,
      transport,
      () => clock.read(),
    )
    let advancedSequence = 0
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-TARGET-HEAD-AHEAD-CANARY',
      ),
      afterCommit: async () => {
        const advanced = await advancingPort.commitNextPage(request)
        advancedSequence = advanced.pageSequence
      },
    })

    const recovered = await firstPort.commitNextPage(request)
    const durable = await firstPort.readProgress(createReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    ))

    expect(recovered).toMatchObject({
      pageSequence: 1,
      checkpoint: { completed: false },
    })
    expect(advancedSequence).toBe(2)
    expect(durable).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: { scanned: 2, pageCount: 2 },
      },
    })
    expect(firstGateway.readCalls).toHaveLength(2)
    expect(transport.readStoredItemsByKind(targetPageKind)).toHaveLength(2)
  })

  test('never adopts a torn page and head after response loss', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-torn-response',
      'owner-target-torn-response',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('torn-response')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-TARGET-TORN-CANARY',
      ),
      afterCommit: async () => {
        const head = requireStoredItem(
          transport.readStoredItemByKind(targetHeadKind),
        )
        transport.replaceStoredItem({
          ...head,
          chainEvidenceVersion: { N: '2' },
        })
        await Promise.resolve()
      },
    })

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(createPlanningRequest(
        configuration,
        authorityContext.authority,
      )),
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(failure.message).not.toContain('RAW-TARGET-TORN-CANARY')
  })

  test('re-reads exact artifact versions and reconstructs target rows', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-artifact-replay',
      'owner-target-artifact-replay',
    )
    const firstItem = createIgnoredTargetItem('artifact-replay-1')
    const secondItem = createInvalidTargetItem('artifact-replay-2')
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [
        {
          items: [firstItem],
          lastEvaluatedKey: createTargetItemKey(firstItem),
        },
        { items: [secondItem] },
      ],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    await port.commitNextPage(request)
    await port.commitNextPage(request)
    gateway.readCalls.splice(0)
    const storedPages = transport.readStoredItemsByKind(targetPageKind)
      .map((item) => readTargetEvidencePage(item))

    const replay = await port.readCommittedEvidence(createReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    ))

    expect(replay.progress.checkpoint.completed).toBe(true)
    expect(replay.targetRows).toHaveLength(1)
    expect(replay.invalidRows).toHaveLength(1)
    expect(gateway.readCalls).toHaveLength(2)
    expect(gateway.readCalls[0]?.targetArtifacts)
      .toEqual(storedPages[0]?.targetArtifacts)
    expect(gateway.readCalls[1]?.targetArtifacts)
      .toEqual(storedPages[1]?.targetArtifacts)
    expect(gateway.readCalls[0]).not.toHaveProperty('previousCheckpoint')
    expect(gateway.readCalls[0]?.targetArtifacts[0]?.versionId)
      .toBe('target-version-1-1')

    gateway.readCalls.splice(0)
    const pointReadCount = transport.getCommands.length
    const canonicalItemBytes =
      Buffer.byteLength(
        serializeCanonicalAttributeMap(firstItem),
        'utf8',
      ) +
      Buffer.byteLength(
        serializeCanonicalAttributeMap(secondItem),
        'utf8',
      )
    const material =
      await port.readPlanningMaterialAtProgress(
        createReadRequest(
          configuration,
          authorityContext.authority.lease.runId,
        ),
        replay.progress,
        {
          maxRows: 2,
          maxCanonicalItemBytes: canonicalItemBytes,
        },
      )
    expect(material).toEqual({
      progress: replay.progress,
      materials: [
        {
          page: storedPages[0],
          items: [firstItem],
        },
        {
          page: storedPages[1],
          items: [secondItem],
        },
      ],
      rowCount: 2,
      canonicalItemBytes,
    })
    expect(gateway.readCalls).toHaveLength(2)
    expect(transport.getCommands).toHaveLength(pointReadCount + 2)

    gateway.readCalls.splice(0)
    const cumulativePointReadCount = transport.getCommands.length
    const byteLimitFailure = await captureMigrationFailure(
      () => port.readPlanningMaterialAtProgress(
        createReadRequest(
          configuration,
          authorityContext.authority.lease.runId,
        ),
        replay.progress,
        {
          maxRows: 2,
          maxCanonicalItemBytes: canonicalItemBytes - 1,
        },
      ),
    )
    expect(byteLimitFailure.code).toBe('INVALID_ARGUMENT')
    expect(gateway.readCalls).toHaveLength(2)
    expect(transport.getCommands).toHaveLength(
      cumulativePointReadCount + 2,
    )

    gateway.readCalls.splice(0)
    const boundedPointReadCount = transport.getCommands.length
    const rowLimitFailure = await captureMigrationFailure(
      () => port.readPlanningMaterialAtProgress(
        createReadRequest(
          configuration,
          authorityContext.authority.lease.runId,
        ),
        replay.progress,
        {
          maxRows: 1,
          maxCanonicalItemBytes: canonicalItemBytes,
        },
      ),
    )
    expect(rowLimitFailure.code).toBe('INVALID_ARGUMENT')
    expect(gateway.readCalls).toHaveLength(0)
    expect(transport.getCommands).toHaveLength(boundedPointReadCount)

    let limitGetterCalls = 0
    const accessorLimits = {
      maxRows: 2,
      get maxCanonicalItemBytes(): number {
        limitGetterCalls += 1
        throw new WorkspaceSearchMigrationFailure(
          'SOURCE_DRIFT',
          'RAW-FORGED-TARGET-LIMIT-FAILURE',
        )
      },
    }
    const accessorFailure = await captureMigrationFailure(
      () => port.readPlanningMaterialAtProgress(
        createReadRequest(
          configuration,
          authorityContext.authority.lease.runId,
        ),
        replay.progress,
        accessorLimits,
      ),
    )
    expect(accessorFailure.code).toBe('INVALID_ARGUMENT')
    expect(accessorFailure.message)
      .not.toContain('RAW-FORGED-TARGET-LIMIT-FAILURE')
    expect(limitGetterCalls).toBe(0)
    expect(transport.getCommands).toHaveLength(boundedPointReadCount)

    gateway.returnWrongItemsOnNextRead([{
      ...firstItem,
      payload: { S: 'different-artifact-payload' },
    }])
    const wrongItems = await captureMigrationFailure(
      () => port.readCommittedEvidence(createReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )
    expect(wrongItems.code).toBe('INVALID_TARGET_ARTIFACT')

    const firstReference = storedPages[0]?.targetArtifacts[0]
    if (firstReference === undefined) {
      throw new Error('Expected one exact first-page artifact reference.')
    }
    gateway.deleteStoredArtifact(firstReference)
    const missingVersion = await captureMigrationFailure(
      () => port.readCommittedEvidence(createReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )
    expect(missingVersion.code).toBe('INVALID_TARGET_ARTIFACT')
    expect(missingVersion.message)
      .not.toContain('RAW-MISSING-PLANNING-TARGET-ARTIFACT')
  })

  test('rejects wrong artifact references and authority bindings', async () => {
    for (const mutation of ['authority', 'reference']) {
      const configuration = createConfiguration()
      const transport = new InMemoryTargetEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        `run-target-wrong-${mutation}`,
        `owner-target-wrong-${mutation}`,
      )
      const gateway = new InMemoryPlanningTargetArtifactGateway(
        [{ items: [createIgnoredTargetItem(`wrong-${mutation}`)] }],
        transport.planningArtifactStore,
      )
      const port = createTargetEvidencePort(
        configuration,
        gateway,
        transport,
        () => clock.read(),
      )
      await port.commitNextPage(createPlanningRequest(
        configuration,
        authorityContext.authority,
      ))
      const pageItem = requireStoredItem(
        transport.readStoredItemByKind(targetPageKind),
      )
      const originalPage = readTargetEvidencePage(pageItem)
      const changedPage: WorkspaceSearchMigrationTargetEvidencePage =
        mutation === 'authority'
          ? {
              ...originalPage,
              planningAuthority: {
                ...originalPage.planningAuthority,
                ownerId: 'different-artifact-owner',
              },
            }
          : {
              ...originalPage,
              targetArtifacts: originalPage.targetArtifacts.map(
                (reference) => ({
                  ...reference,
                  versionId: `${reference.versionId}-different`,
                }),
              ),
            }
      const payload =
        serializeWorkspaceSearchMigrationTargetEvidencePage(changedPage)
      const pageDigest =
        createWorkspaceSearchMigrationTargetEvidencePageDigest(changedPage)
      transport.replaceStoredItem({
        ...pageItem,
        payload: { B: payload },
        pageDigest: { S: pageDigest },
      })
      const head = requireStoredItem(
        transport.readStoredItemByKind(targetHeadKind),
      )
      transport.replaceStoredItem({
        ...head,
        headDigest: { S: pageDigest },
      })

      const failure = await captureMigrationFailure(
        () => port.readCommittedEvidence(createReadRequest(
          configuration,
          authorityContext.authority.lease.runId,
        )),
      )

      expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
      expect(failure.message).not.toContain('different-artifact-owner')
      expect(failure.message).not.toContain('-different')
    }
  })

  test('derives replay cursor from the committed successor checkpoint', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-cursor-replay',
      'owner-target-cursor-replay',
    )
    const firstItem = createIgnoredTargetItem('cursor-first')
    const secondItem = createIgnoredTargetItem('cursor-second')
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{
        items: [firstItem, secondItem],
        lastEvaluatedKey: createTargetItemKey(secondItem),
      }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))
    const pageItem = requireStoredItem(
      transport.readStoredItemByKind(targetPageKind),
    )
    const originalPage = readTargetEvidencePage(pageItem)
    const wrongCursor = createTargetItemKey(firstItem)
    const changedCheckpoint = {
      ...originalPage.checkpoint,
      cursor: wrongCursor,
    }
    const changedPage: WorkspaceSearchMigrationTargetEvidencePage = {
      ...originalPage,
      checkpoint: changedCheckpoint,
    }
    const pageDigest =
      createWorkspaceSearchMigrationTargetEvidencePageDigest(changedPage)
    transport.replaceStoredItem({
      ...pageItem,
      payload: {
        B: serializeWorkspaceSearchMigrationTargetEvidencePage(
          changedPage,
        ),
      },
      pageDigest: { S: pageDigest },
    })
    const head = requireStoredItem(
      transport.readStoredItemByKind(targetHeadKind),
    )
    const checkpoint = readMapAttribute(head, 'checkpoint')
    transport.replaceStoredItem({
      ...head,
      headDigest: { S: pageDigest },
      checkpointDigest: {
        S: createWorkspaceSearchMigrationTargetCheckpointDigest(
          changedCheckpoint,
        ),
      },
      checkpoint: {
        M: {
          ...checkpoint,
          cursor: { M: wrongCursor },
        },
      },
    })

    const failure = await captureMigrationFailure(
      () => port.readCommittedEvidence(createReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )

    expect(gateway.readCalls).toHaveLength(1)
    expect(failure.code).toBe('INVALID_STATE')
  })

  test('separates target drift from migration-state drift', async () => {
    const configuration = createConfiguration()
    const mismatchedStateTable: MigrationTableIdentity = {
      ...configuration.tables['migration-state'],
      creationTime: '2026-01-01T00:00:00.001Z',
    }
    const mismatchTransport = new InMemoryTargetEvidenceAwsTransport()
    const mismatchGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('state-identity')] }],
      mismatchTransport.planningArtifactStore,
    )
    const mismatchPort =
      createAwsWorkspaceSearchMigrationTargetEvidencePort({
        stateTable: mismatchedStateTable,
        planningArtifactGateway: mismatchGateway,
        transport: mismatchTransport,
        clock: () => new Date(initialTime),
      })
    const mismatch = await captureMigrationFailure(
      () => mismatchPort.readProgress(
        createReadRequest(configuration, 'run-target-state-identity'),
      ),
    )
    expect(mismatch.code).toBe('IDENTITY_MISMATCH')
    expect(mismatchTransport.getCommands).toHaveLength(0)
    expect(mismatchGateway.captureCalls).toHaveLength(0)

    const stateTransport = new InMemoryTargetEvidenceAwsTransport()
    const statePort = createTargetEvidencePort(
      configuration,
      new InMemoryPlanningTargetArtifactGateway(
        [],
        stateTransport.planningArtifactStore,
      ),
      stateTransport,
    )
    stateTransport.failNextGet(createResourceNotFoundError())
    const missingState = await captureMigrationFailure(
      () => statePort.readProgress(
        createReadRequest(configuration, 'run-target-state-missing'),
      ),
    )
    expect(missingState.code).toBe('CONFIGURATION_DRIFT')
    expect(missingState.message)
      .not.toContain('RAW-RESOURCE-NOT-FOUND-CANARY')

    const targetTransport = new InMemoryTargetEvidenceAwsTransport()
    const targetClock = new MutableAuthorityClock(initialTime)
    const targetAuthority = await acquirePlanningAuthority(
      configuration,
      targetTransport,
      targetClock,
      'run-target-table-missing',
      'owner-target-table-missing',
    )
    const targetGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('target-missing')] }],
      targetTransport.planningArtifactStore,
    )
    targetGateway.failNextCapture(createResourceNotFoundError())
    const targetPort = createTargetEvidencePort(
      configuration,
      targetGateway,
      targetTransport,
      () => targetClock.read(),
    )
    const missingTarget = await captureMigrationFailure(
      () => targetPort.commitNextPage(createPlanningRequest(
        configuration,
        targetAuthority.authority,
      )),
    )
    expect(missingTarget.code).toBe('TARGET_DRIFT')
    expect(targetTransport.prepareCalls).toHaveLength(0)
  })

  test('classifies state preparation and artifact reread drift', async () => {
    const configuration = createConfiguration()
    const prepareTransport = new InMemoryTargetEvidenceAwsTransport()
    const prepareClock = new MutableAuthorityClock(initialTime)
    const prepareAuthority = await acquirePlanningAuthority(
      configuration,
      prepareTransport,
      prepareClock,
      'run-target-prepare-drift',
      'owner-target-prepare-drift',
    )
    const prepareGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('prepare-drift')] }],
      prepareTransport.planningArtifactStore,
    )
    const preparePort = createTargetEvidencePort(
      configuration,
      prepareGateway,
      prepareTransport,
      () => prepareClock.read(),
    )
    prepareTransport.beforeNextTargetPrepare(() => {
      throw createResourceNotFoundError()
    })
    const prepareFailure = await captureMigrationFailure(
      () => preparePort.commitNextPage(createPlanningRequest(
        configuration,
        prepareAuthority.authority,
      )),
    )
    expect(prepareFailure.code).toBe('CONFIGURATION_DRIFT')
    expect(prepareTransport.transactionCommands).toHaveLength(0)

    const targetEvents: string[] = []
    const targetPrepareTransport =
      new InMemoryTargetEvidenceAwsTransport(targetEvents)
    const targetPrepareClock = new MutableAuthorityClock(initialTime)
    const targetPrepareAuthority = await acquirePlanningAuthority(
      configuration,
      targetPrepareTransport,
      targetPrepareClock,
      'run-target-prepare-target-drift',
      'owner-target-prepare-target-drift',
    )
    targetEvents.splice(0)
    const targetPrepareGateway =
      new InMemoryPlanningTargetArtifactGateway(
        [{ items: [createIgnoredTargetItem('prepare-target-drift')] }],
        targetPrepareTransport.planningArtifactStore,
        targetEvents,
      )
    targetPrepareTransport.beforeNextTargetPrepare(() => {
      throw new WorkspaceSearchMigrationFailure(
        'TARGET_DRIFT',
        'RAW-TARGET-PREPARE-DRIFT-CANARY',
      )
    })
    const targetPreparePort = createTargetEvidencePort(
      configuration,
      targetPrepareGateway,
      targetPrepareTransport,
      () => {
        targetEvents.push('clock')
        return targetPrepareClock.read()
      },
    )

    const targetPrepareFailure = await captureMigrationFailure(
      () => targetPreparePort.commitNextPage(createPlanningRequest(
        configuration,
        targetPrepareAuthority.authority,
      )),
    )

    expect(targetPrepareFailure.code).toBe('TARGET_DRIFT')
    expect(targetPrepareFailure.message)
      .not.toContain('RAW-TARGET-PREPARE-DRIFT-CANARY')
    expect(targetEvents).toEqual([
      'capture',
      'artifact-stored',
      'prepare',
    ])
    expect(targetPrepareTransport.transactionCommands).toHaveLength(0)

    const readTransport = new InMemoryTargetEvidenceAwsTransport()
    const readClock = new MutableAuthorityClock(initialTime)
    const readAuthority = await acquirePlanningAuthority(
      configuration,
      readTransport,
      readClock,
      'run-target-read-drift',
      'owner-target-read-drift',
    )
    const readGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('read-drift')] }],
      readTransport.planningArtifactStore,
    )
    const readPort = createTargetEvidencePort(
      configuration,
      readGateway,
      readTransport,
      () => readClock.read(),
    )
    await readPort.commitNextPage(createPlanningRequest(
      configuration,
      readAuthority.authority,
    ))
    readGateway.failNextRead(createResourceNotFoundError())
    const readFailure = await captureMigrationFailure(
      () => readPort.readCommittedEvidence(createReadRequest(
        configuration,
        readAuthority.authority.lease.runId,
      )),
    )
    expect(readFailure.code).toBe('TARGET_DRIFT')
  })

  test('accepts 100 target items and rejects 101 before preparation', async () => {
    const configuration = createConfiguration()
    const acceptedTransport = new InMemoryTargetEvidenceAwsTransport()
    const acceptedClock = new MutableAuthorityClock(initialTime)
    const acceptedAuthority = await acquirePlanningAuthority(
      configuration,
      acceptedTransport,
      acceptedClock,
      'run-target-page-limit',
      'owner-target-page-limit',
    )
    const hundred = Array.from(
      { length: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE },
      (_, index) => createIgnoredTargetItem(`limit-${index}`),
    )
    const acceptedGateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: hundred }],
      acceptedTransport.planningArtifactStore,
    )
    const acceptedPort = createTargetEvidencePort(
      configuration,
      acceptedGateway,
      acceptedTransport,
      () => acceptedClock.read(),
    )

    const accepted = await acceptedPort.commitNextPage(
      createPlanningRequest(
        configuration,
        acceptedAuthority.authority,
      ),
    )

    expect(accepted.checkpoint.aggregate.scanned)
      .toBe(WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE)
    expect(accepted.checkpoint.aggregate.ignored)
      .toBe(WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE)

    const rejectedTransport = new InMemoryTargetEvidenceAwsTransport()
    const rejectedClock = new MutableAuthorityClock(initialTime)
    const rejectedAuthority = await acquirePlanningAuthority(
      configuration,
      rejectedTransport,
      rejectedClock,
      'run-target-page-over-limit',
      'owner-target-page-over-limit',
    )
    const rejectedGateway = new InMemoryPlanningTargetArtifactGateway(
      [{
        items: [
          ...hundred,
          createIgnoredTargetItem('limit-overflow'),
        ],
      }],
      rejectedTransport.planningArtifactStore,
    )
    const rejectedPort = createTargetEvidencePort(
      configuration,
      rejectedGateway,
      rejectedTransport,
      () => rejectedClock.read(),
    )

    const rejected = await captureMigrationFailure(
      () => rejectedPort.commitNextPage(createPlanningRequest(
        configuration,
        rejectedAuthority.authority,
      )),
    )

    expect(rejected.code).toBe('INVALID_ARGUMENT')
    expect(rejectedTransport.prepareCalls).toHaveLength(0)
    expect(rejectedTransport.transactionCommands).toHaveLength(0)
  })

  test('rejects an over-limit durable head before reading page records', async () => {
    const configuration = createConfiguration()
    const transport = new InMemoryTargetEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-target-chain-limit',
      'owner-target-chain-limit',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('chain-limit')] }],
      transport.planningArtifactStore,
    )
    const port = createTargetEvidencePort(
      configuration,
      gateway,
      transport,
      () => clock.read(),
    )
    const completed = await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))
    const head = requireStoredItem(
      transport.readStoredItemByKind(targetHeadKind),
    )
    const checkpoint = readMapAttribute(head, 'checkpoint')
    const aggregate = readMapAttribute(checkpoint, 'aggregate')
    const pageCount =
      WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAXIMUM_PAGE_COUNT + 1
    const overLimitCheckpoint = {
      ...completed.checkpoint,
      aggregate: {
        ...completed.checkpoint.aggregate,
        pageCount,
      },
    }
    transport.replaceStoredItem({
      ...head,
      revision: { N: String(pageCount) },
      checkpointDigest: {
        S: createWorkspaceSearchMigrationTargetCheckpointDigest(
          overLimitCheckpoint,
        ),
      },
      checkpoint: {
        M: {
          ...checkpoint,
          aggregate: {
            M: {
              ...aggregate,
              pageCount: { N: String(pageCount) },
            },
          },
        },
      },
    })
    const readsBefore = transport.getCommands.length

    const failure = await captureMigrationFailure(
      () => port.readCommittedEvidence(createReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.getCommands).toHaveLength(readsBefore + 1)
  })

  test('redacts raw target gateway errors', async () => {
    const configuration = createConfiguration()
    const gatewayTransport = new InMemoryTargetEvidenceAwsTransport()
    const gatewayClock = new MutableAuthorityClock(initialTime)
    const gatewayAuthority = await acquirePlanningAuthority(
      configuration,
      gatewayTransport,
      gatewayClock,
      'run-target-gateway-redaction',
      'owner-target-gateway-redaction',
    )
    const gateway = new InMemoryPlanningTargetArtifactGateway(
      [{ items: [createIgnoredTargetItem('gateway-redaction')] }],
      gatewayTransport.planningArtifactStore,
    )
    gateway.failNextCapture(new WorkspaceSearchMigrationFailure(
      'TARGET_DRIFT',
      'RAW-TARGET-GATEWAY-CANARY',
    ))
    const gatewayFailure = await captureMigrationFailure(
      () => createTargetEvidencePort(
        configuration,
        gateway,
        gatewayTransport,
        () => gatewayClock.read(),
      ).commitNextPage(createPlanningRequest(
        configuration,
        gatewayAuthority.authority,
      )),
    )
    expect(gatewayFailure).toMatchObject({
      code: 'TARGET_DRIFT',
      message:
        'Workspace Search target evidence stopped safely (TARGET_DRIFT).',
    })
    expect(gatewayFailure.message)
      .not.toContain('RAW-TARGET-GATEWAY-CANARY')
  })

  test('redacts raw target evidence read errors', async () => {
    const configuration = createConfiguration()
    const readTransport = new InMemoryTargetEvidenceAwsTransport()
    readTransport.failNextGet(new Error('RAW-TARGET-GET-CANARY'))
    const readFailure = await captureMigrationFailure(
      () => createTargetEvidencePort(
        configuration,
        new InMemoryPlanningTargetArtifactGateway(
          [],
          readTransport.planningArtifactStore,
        ),
        readTransport,
      ).readProgress(
        createReadRequest(configuration, 'run-target-get-redaction'),
      ),
    )
    expect(readFailure.code).toBe('INVALID_STATE')
    expect(readFailure.message).not.toContain('RAW-TARGET-GET-CANARY')
  })

  test('redacts raw target evidence preparation errors', async () => {
    const configuration = createConfiguration()
    const prepareTransport = new InMemoryTargetEvidenceAwsTransport()
    const prepareClock = new MutableAuthorityClock(initialTime)
    const prepareAuthority = await acquirePlanningAuthority(
      configuration,
      prepareTransport,
      prepareClock,
      'run-target-prepare-redaction',
      'owner-target-prepare-redaction',
    )
    prepareTransport.beforeNextTargetPrepare(() => {
      throw new Error('RAW-TARGET-PREPARE-CANARY')
    })
    const prepareFailure = await captureMigrationFailure(
      () => createTargetEvidencePort(
        configuration,
        new InMemoryPlanningTargetArtifactGateway(
          [{ items: [createIgnoredTargetItem('prepare-redaction')] }],
          prepareTransport.planningArtifactStore,
        ),
        prepareTransport,
        () => prepareClock.read(),
      ).commitNextPage(createPlanningRequest(
        configuration,
        prepareAuthority.authority,
      )),
    )
    expect(prepareFailure.code).toBe('INVALID_STATE')
    expect(prepareFailure.message)
      .not.toContain('RAW-TARGET-PREPARE-CANARY')
  })

  test('redacts raw target evidence transaction errors', async () => {
    const configuration = createConfiguration()
    const transactionClassifications: readonly {
      /** Stable raw error name supplied to Smithy's classifier. */
      readonly name: string
      /** Expected secret-free public failure code. */
      readonly expectedCode: WorkspaceSearchMigrationFailureCode
    }[] = [
      {
        name: 'TimeoutError',
        expectedCode: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
      {
        name: 'ProvisionedThroughputExceededException',
        expectedCode: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
      {
        name: 'TransactionConflictException',
        expectedCode: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
    ]
    for (const {
      name,
      expectedCode,
    } of transactionClassifications) {
      const transactionTransport =
        new InMemoryTargetEvidenceAwsTransport()
      const transactionClock = new MutableAuthorityClock(initialTime)
      const transactionAuthority = await acquirePlanningAuthority(
        configuration,
        transactionTransport,
        transactionClock,
        `run-target-transaction-${name}`,
        `owner-target-transaction-${name}`,
      )
      transactionTransport.failNextTransaction({
        timing: 'before-commit',
        error: createNamedError(
          name,
          `RAW-TARGET-TRANSACTION-${name}`,
        ),
      })
      const transactionFailure = await captureMigrationFailure(
        () => createTargetEvidencePort(
          configuration,
          new InMemoryPlanningTargetArtifactGateway(
            [{ items: [createIgnoredTargetItem(name)] }],
            transactionTransport.planningArtifactStore,
          ),
          transactionTransport,
          () => transactionClock.read(),
        ).commitNextPage(createPlanningRequest(
          configuration,
          transactionAuthority.authority,
        )),
      )
      expect(transactionFailure.code).toBe(expectedCode)
      expect(transactionFailure.message)
        .not.toContain(`RAW-TARGET-TRANSACTION-${name}`)
    }
  })
})
