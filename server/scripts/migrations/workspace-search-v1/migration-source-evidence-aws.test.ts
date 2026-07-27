import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  type AttributeValue,
  GetItemCommand,
  type GetItemCommandOutput,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationSourceEvidencePort,
  type WorkspaceSearchMigrationDryRunSourceEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationPlanningSourceEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsPort,
  type WorkspaceSearchMigrationSourceEvidenceAwsTransport,
  type WorkspaceSearchMigrationSourceEvidenceScanner,
  type WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput,
  type WorkspaceSearchMigrationPlanningSourceArtifactCaptureResult,
  type WorkspaceSearchMigrationPlanningSourceArtifactGateway,
  type WorkspaceSearchMigrationPlanningSourceArtifactReadInput,
} from './migration-source-evidence-aws'
import {
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidencePageDigest,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningSourceArtifactReference,
  type WorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationSourceEvidencePurpose,
} from './migration-source-evidence'
import {
  parseWorkspaceSearchMigrationPlanningSourceArtifactPage,
  serializeWorkspaceSearchMigrationPlanningSourceArtifactPage,
  type WorkspaceSearchMigrationPlanningSourceArtifactPage,
  WORKSPACE_SEARCH_MIGRATION_SOURCE_ARTIFACT_VERSION,
} from './migration-source-artifact'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
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

/** One transaction failure injected before or after the atomic write. */
type TransactionFault = {
  /** Whether the fake applies the transaction before throwing. */
  readonly timing: 'after-commit' | 'before-commit'
  /** Arbitrary raw failure that must not escape the adapter boundary. */
  readonly error: unknown
  /** Optional concurrent work run after the atomic commit and before failure. */
  readonly afterCommit?: () => Promise<void>
}

/** One pending source Scan owned by the concurrency test. */
type PendingSourceScan = {
  /** Detached exact Scan input observed by the fake. */
  readonly input: WorkspaceSearchMigrationSourceScanReadInput
  /** Resolves the pending Scan with one raw and reduced page pair. */
  readonly resolve: (
    value: CapturedSourceScanPage,
  ) => void
  /** Rejects the pending Scan with an arbitrary raw failure. */
  readonly reject: (reason: unknown) => void
}

/** One exact raw Scan page paired with its deterministic reduction. */
type CapturedSourceScanPage = {
  /** Detached exact low-level Scan page. */
  readonly rawPage: WorkspaceSearchMigrationSourceScanPage
  /** Reduction produced from the same exact raw page. */
  readonly pageResult: WorkspaceSearchMigrationSourceScanPageResult
}

/**
 * Test scanner that can expose the same exact raw page to the planning gateway.
 */
interface CapturingSourceEvidenceScanner
  extends WorkspaceSearchMigrationSourceEvidenceScanner {
  /**
   * Scans once and returns both raw and reduced forms of the same page.
   *
   * @param input - Exact measured Scan context and predecessor.
   * @returns Same-page raw source items and deterministic reduction.
   */
  captureSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<CapturedSourceScanPage>
}

/** One immutable stored artifact segment owned by the in-memory fake. */
type StoredPlanningSourceArtifactSegment = {
  /** Exact reference returned to the source-evidence adapter. */
  readonly reference:
    WorkspaceSearchMigrationPlanningSourceArtifactReference
  /** Exact canonical artifact-segment bytes. */
  readonly bytes: Uint8Array
}

/** One condition-checked write prepared against a shared snapshot. */
type PlannedWrite = {
  /** Deterministic record key replaced by the write. */
  readonly recordKey: string
  /** Detached complete low-level item installed atomically. */
  readonly item: Readonly<Record<string, AttributeValue>>
}

/**
 * Mutable adapter clock returning a fresh Date at the configured instant.
 */
class MutableAuthorityClock {
  /** Current finite epoch millisecond supplied to both adapters. */
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
   * Returns a detached current clock value.
   *
   * @returns Fresh Date at the configured instant.
   */
  read(): Date {
    return new Date(this.epochMilliseconds)
  }

  /**
   * Moves the test clock to one canonical UTC instant.
   *
   * @param at - Next canonical timestamp.
   */
  set(at: string): void {
    this.epochMilliseconds = requireEpochMilliseconds(at)
  }
}

/**
 * Shared immutable-segment store used by gateways attached to one transport.
 */
class InMemoryPlanningSourceArtifactStore {
  /** Exact canonical segments keyed by object key and immutable version. */
  private readonly segments =
    new Map<string, StoredPlanningSourceArtifactSegment>()

  /**
   * Stores one immutable artifact segment.
   *
   * @param segment - Exact reference and canonical bytes.
   */
  store(segment: StoredPlanningSourceArtifactSegment): void {
    const key = createStoredArtifactKey(segment.reference)
    const existing = this.segments.get(key)
    if (
      existing !== undefined &&
      (!Bun.deepEquals(existing.reference, segment.reference) ||
        !Buffer.from(existing.bytes).equals(Buffer.from(segment.bytes)))
    ) {
      throw new Error('Attempted to replace an immutable artifact.')
    }
    this.segments.set(key, {
      reference: structuredClone(segment.reference),
      bytes: new Uint8Array(segment.bytes),
    })
  }

  /**
   * Reads one exact immutable artifact segment.
   *
   * @param reference - Exact object key, version, and content digest.
   * @returns Detached canonical bytes.
   */
  read(
    reference: WorkspaceSearchMigrationPlanningSourceArtifactReference,
  ): Uint8Array {
    const stored = this.segments.get(
      createStoredArtifactKey(reference),
    )
    if (
      stored === undefined ||
      !Bun.deepEquals(stored.reference, reference)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_SOURCE_ARTIFACT',
        'RAW-MISSING-PLANNING-SOURCE-ARTIFACT',
      )
    }
    return new Uint8Array(stored.bytes)
  }

  /**
   * Deletes one exact segment to model immutable-object loss.
   *
   * @param reference - Exact stored reference to remove.
   */
  delete(
    reference: WorkspaceSearchMigrationPlanningSourceArtifactReference,
  ): void {
    this.segments.delete(createStoredArtifactKey(reference))
  }
}

/**
 * Strict planning gateway that captures, stores, reads, and verifies raw pages.
 */
class InMemoryPlanningSourceArtifactGateway
  implements WorkspaceSearchMigrationPlanningSourceArtifactGateway {
  /** Every detached planning capture input in call order. */
  readonly captureCalls:
    WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput[] = []

  /** Every detached committed-artifact read input in call order. */
  readonly readCalls:
    WorkspaceSearchMigrationPlanningSourceArtifactReadInput[] = []

  /** Scanner returning raw and reduced forms of each exact source page. */
  private readonly scanner: CapturingSourceEvidenceScanner

  /** Shared immutable segment storage for every port on one transport. */
  private readonly store: InMemoryPlanningSourceArtifactStore

  /** One-shot upload failure raised after the source page was captured. */
  private captureFailureAfterScan: unknown

  /** One-shot action completed before the next planning capture. */
  private beforeCapture: (() => void | Promise<void>) | undefined

  /** One-shot raw page override returned after strict artifact validation. */
  private nextReadItems: readonly DynamoAttributeMap[] | undefined

  /** One-shot failure raised before the next strict artifact read. */
  private nextReadFailure: unknown

  /**
   * Creates a gateway over one scanner and shared immutable store.
   *
   * @param scanner - Same managed scanner used for dry-run reads.
   * @param store - Artifact store shared by ports on one transport.
   */
  constructor(
    scanner: CapturingSourceEvidenceScanner,
    store: InMemoryPlanningSourceArtifactStore,
  ) {
    this.scanner = scanner
    this.store = store
  }

  /**
   * Schedules one action immediately before the next planning capture.
   *
   * @param action - One-shot ordering assertion or state mutation.
   */
  beforeNextCapture(
    action: () => void | Promise<void>,
  ): void {
    this.beforeCapture = action
  }

  /**
   * Injects one upload failure after a raw page has been captured.
   *
   * @param error - Arbitrary raw gateway failure.
   */
  failNextCaptureAfterScan(error: unknown): void {
    this.captureFailureAfterScan = error
  }

  /**
   * Injects one failure before the next strict artifact read.
   *
   * @param error - Arbitrary gateway failure.
   */
  failNextRead(error: unknown): void {
    this.nextReadFailure = error
  }

  /**
   * Returns different raw items after the next strict artifact read.
   *
   * @param items - Wrong raw items used to exercise adapter re-reduction.
   */
  returnWrongItemsOnNextRead(
    items: readonly DynamoAttributeMap[],
  ): void {
    this.nextReadItems = structuredClone(items)
  }

  /**
   * Removes one stored immutable segment.
   *
   * @param reference - Exact artifact reference to remove.
   */
  deleteStoredArtifact(
    reference: WorkspaceSearchMigrationPlanningSourceArtifactReference,
  ): void {
    this.store.delete(reference)
  }

  /**
   * Captures and reduces one page, then stores canonical artifact segments.
   *
   * @param input - Exact planning capture context.
   * @returns Same-page reduction and valid content-addressed references.
   */
  async captureAndStorePlanningPage(
    input: WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput,
  ): Promise<WorkspaceSearchMigrationPlanningSourceArtifactCaptureResult> {
    this.captureCalls.push(structuredClone(input))
    const beforeCapture = this.beforeCapture
    this.beforeCapture = undefined
    await beforeCapture?.()
    const captured = await this.scanner.captureSourcePage(input)
    if (this.captureFailureAfterScan !== undefined) {
      const error = this.captureFailureAfterScan
      this.captureFailureAfterScan = undefined
      throw error
    }
    const encoded =
      serializeWorkspaceSearchMigrationPlanningSourceArtifactPage(
        createPlanningSourceArtifactPage(input, captured.rawPage.items),
      )
    const sourceArtifacts = encoded.map((segment, index) => ({
      objectKey:
        `workspace-search/v1/source-artifacts/v1/${segment.contentDigest}.json`,
      versionId:
        `test-version-${input.pageSequence}-${index + 1}`,
      contentDigest: segment.contentDigest,
    }))
    for (const [index, reference] of sourceArtifacts.entries()) {
      const segment = encoded[index]
      if (segment === undefined) {
        throw new Error('Missing encoded planning artifact segment.')
      }
      this.store.store({
        reference,
        bytes: segment.bytes,
      })
    }
    return {
      pageResult: structuredClone(captured.pageResult),
      sourceArtifacts: structuredClone(sourceArtifacts),
    }
  }

  /**
   * Reads and strictly verifies exact committed artifact segments.
   *
   * @param input - Exact committed page context and artifact references.
   * @returns Detached raw items without a DynamoDB cursor.
   */
  async readVerifiedPlanningPage(
    input: WorkspaceSearchMigrationPlanningSourceArtifactReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPage> {
    this.readCalls.push(structuredClone(input))
    const nextReadFailure = this.nextReadFailure
    this.nextReadFailure = undefined
    if (nextReadFailure !== undefined) throw nextReadFailure
    const bytes = input.sourceArtifacts.map((reference) => {
      const stored = this.store.read(reference)
      const digest = createHash('sha256').update(stored).digest('hex')
      if (digest !== reference.contentDigest) {
        throw new WorkspaceSearchMigrationFailure(
          'INVALID_SOURCE_ARTIFACT',
          'RAW-PLANNING-SOURCE-ARTIFACT-DIGEST-MISMATCH',
        )
      }
      return stored
    })
    const page =
      parseWorkspaceSearchMigrationPlanningSourceArtifactPage(bytes)
    const expected = createPlanningSourceArtifactPage(input, page.items)
    if (!Bun.deepEquals(page, expected)) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_SOURCE_ARTIFACT',
        'RAW-PLANNING-SOURCE-ARTIFACT-IDENTITY-MISMATCH',
      )
    }
    const nextReadItems = this.nextReadItems
    this.nextReadItems = undefined
    return {
      items: structuredClone(nextReadItems ?? page.items),
    }
  }
}

/**
 * Condition-aware in-memory implementation of the narrow DynamoDB transport.
 */
class InMemorySourceEvidenceAwsTransport
  implements
    WorkspaceSearchMigrationSourceEvidenceAwsTransport,
    WorkspaceSearchMigrationPrePlanAuthorityAwsTransport {
  /** Every strongly consistent point-read command in call order. */
  readonly getCommands: GetItemCommand[] = []

  /** Every attempted atomic page/head transaction in call order. */
  readonly transactionCommands: TransactWriteItemsCommand[] = []

  /** Every authority point-read command in call order. */
  readonly authorityGetCommands: GetItemCommand[] = []

  /** Every authority transaction command in call order. */
  readonly authorityTransactionCommands: TransactWriteItemsCommand[] = []

  /** One marker for each completed source pre-write preparation. */
  readonly prepareCalls: true[] = []

  /** Planning artifact storage shared by every port on this transport. */
  readonly planningArtifactStore =
    new InMemoryPlanningSourceArtifactStore()

  /** Durable low-level rows keyed by deterministic recordKey. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** One-shot raw GetItem failure. */
  private getFailure: unknown

  /** One-shot transaction failure and commit timing. */
  private transactionFault: TransactionFault | undefined

  /** One-shot action completed immediately before source condition checks. */
  private beforeSourceTransaction:
    (() => void | Promise<void>) | undefined

  /** One-shot action completed inside source write preparation. */
  private beforeSourcePrepare:
    (() => void | Promise<void>) | undefined

  /**
   * Injects one raw read failure.
   *
   * @param error - Arbitrary value thrown by the next GetItem.
   */
  failNextGet(error: unknown): void {
    this.getFailure = error
  }

  /**
   * Injects one raw transaction failure.
   *
   * @param fault - Failure value and whether the write commits first.
   */
  failNextTransaction(fault: TransactionFault): void {
    this.transactionFault = fault
  }

  /**
   * Schedules concurrent work before the next source transaction snapshot.
   *
   * @param action - One-shot concurrent operation.
   */
  beforeNextSourceTransaction(
    action: () => void | Promise<void>,
  ): void {
    this.beforeSourceTransaction = action
  }

  /**
   * Schedules one action inside the next source write preparation.
   *
   * @param action - One-shot operation before the trusted clock sample.
   */
  beforeNextSourcePrepare(
    action: () => void | Promise<void>,
  ): void {
    this.beforeSourcePrepare = action
  }

  /**
   * Returns detached durable items for assertions.
   *
   * @returns Current atomic page and head records.
   */
  readStoredItems(): readonly Readonly<Record<string, AttributeValue>>[] {
    return [...this.items.values()].map((item) => structuredClone(item))
  }

  /**
   * Returns one detached durable row selected by its discriminator.
   *
   * @param kind - Exact durable row kind.
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
   * Replaces one existing durable item with an exact test-owned fixture.
   *
   * @param item - Complete low-level row carrying its deterministic record key.
   */
  replaceStoredItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const recordKey = readStringAttribute(item, 'recordKey')
    if (!this.items.has(recordKey)) {
      throw new Error('Expected one existing durable item.')
    }
    this.items.set(recordKey, structuredClone(item))
  }

  /**
   * Strongly reads one exact deterministic evidence record.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Detached low-level item when it exists.
   */
  async getSourceEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    if (this.getFailure !== undefined) {
      const error = this.getFailure
      this.getFailure = undefined
      throw error
    }
    const recordKey = readCommandRecordKey(command)
    const item = this.items.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Strongly reads one exact deterministic authority row.
   *
   * @param command - Authority-adapter-owned GetItem command.
   * @returns Detached stored item when present.
   */
  async getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.authorityGetCommands.push(command)
    const recordKey = readCommandRecordKey(command)
    const item = this.items.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Completes one source state-incarnation preparation.
   */
  async prepareSourceEvidenceWrite(): Promise<void> {
    const action = this.beforeSourcePrepare
    this.beforeSourcePrepare = undefined
    await action?.()
    this.prepareCalls.push(true)
  }

  /**
   * Completes one authority state-incarnation preparation.
   */
  async preparePrePlanAuthorityWrite(): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Evaluates both Put conditions before atomically installing both rows.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Empty successful DynamoDB response.
   */
  async transactWriteSourceEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactionCommands.push(command)
    const fault = this.transactionFault
    this.transactionFault = undefined
    if (fault?.timing === 'before-commit') throw fault.error

    const concurrentAction = this.beforeSourceTransaction
    this.beforeSourceTransaction = undefined
    await concurrentAction?.()

    this.applyTransaction(command)
    if (fault?.timing === 'after-commit') {
      await fault.afterCommit?.()
      throw fault.error
    }
    return { $metadata: {} }
  }

  /**
   * Evaluates and installs one authority transaction atomically.
   *
   * @param command - Authority-adapter-owned transaction command.
   * @returns Empty successful low-level response.
   */
  async transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.authorityTransactionCommands.push(command)
    this.applyTransaction(command)
    return { $metadata: {} }
  }

  /**
   * Applies supported checks and writes with a condition-aware atomic boundary.
   *
   * @param command - Exact authority or source-evidence transaction.
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
 * Reduces a fixed sequence of exact source pages as the adapter requests them.
 */
class SequencedSourceEvidenceScanner
  implements CapturingSourceEvidenceScanner {
  /** Every detached Scan input received from the adapter. */
  readonly inputs: WorkspaceSearchMigrationSourceScanReadInput[] = []

  /** Exact pages returned in sequence. */
  private readonly pages: readonly WorkspaceSearchMigrationSourceScanPage[]

  /**
   * Creates a scanner with a finite page sequence.
   *
   * @param pages - Exact low-level source pages.
   */
  constructor(
    pages: readonly WorkspaceSearchMigrationSourceScanPage[],
  ) {
    this.pages = pages
  }

  /**
   * Reduces the next page against the adapter-owned predecessor checkpoint.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Bound digest-only page result.
   */
  async scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult> {
    const captured = await this.captureSourcePage(input)
    return captured.pageResult
  }

  /**
   * Returns the next raw page and its reduction from one exact Scan.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Same-page raw source items and digest-only reduction.
   */
  async captureSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<CapturedSourceScanPage> {
    const index = this.inputs.length
    this.inputs.push(structuredClone(input))
    const page = this.pages[index]
    if (page === undefined) {
      throw new Error('The scanner was called after its terminal page.')
    }
    const rawPage = structuredClone(page)
    return {
      rawPage,
      pageResult: reduceWorkspaceSearchMigrationSourceScanPage({
        ...input,
        page: rawPage,
      }),
    }
  }
}

/**
 * Holds source Scans until a concurrency test supplies each exact result.
 */
class DeferredSourceEvidenceScanner
  implements CapturingSourceEvidenceScanner {
  /** Every pending Scan, in invocation order. */
  private readonly pending: PendingSourceScan[] = []

  /**
   * Returns the number of adapter calls waiting for resolution.
   *
   * @returns Pending Scan count.
   */
  pendingCount(): number {
    return this.pending.length
  }

  /**
   * Records one pending source Scan.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Promise resolved explicitly by the test.
   */
  async scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult> {
    const captured = await this.captureSourcePage(input)
    return captured.pageResult
  }

  /**
   * Records one pending source Scan retaining its eventual raw page.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Promise resolved explicitly with raw and reduced forms.
   */
  captureSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<CapturedSourceScanPage> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        input: structuredClone(input),
        resolve,
        reject,
      })
    })
  }

  /**
   * Resolves one pending Scan by reducing an exact page against its predecessor.
   *
   * @param index - Pending invocation index.
   * @param page - Exact low-level page supplied to that invocation.
   */
  resolvePage(
    index: number,
    page: WorkspaceSearchMigrationSourceScanPage,
  ): void {
    const pending = this.pending[index]
    if (pending === undefined) {
      throw new Error('Expected one pending source Scan.')
    }
    const rawPage = structuredClone(page)
    pending.resolve({
      rawPage,
      pageResult: reduceWorkspaceSearchMigrationSourceScanPage({
        ...pending.input,
        page: rawPage,
      }),
    })
  }

  /**
   * Rejects one pending Scan with an arbitrary raw failure.
   *
   * @param index - Pending invocation index.
   * @param error - Raw failure supplied to the adapter boundary.
   */
  rejectScan(index: number, error: unknown): void {
    const pending = this.pending[index]
    if (pending === undefined) {
      throw new Error('Expected one pending source Scan.')
    }
    pending.reject(error)
  }
}

/**
 * Creates the in-memory identity of one exact immutable artifact version.
 *
 * @param reference - Exact content-addressed S3 reference.
 * @returns Collision-free test-store key.
 */
function createStoredArtifactKey(
  reference: WorkspaceSearchMigrationPlanningSourceArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Creates one canonical planning artifact page from adapter capture context.
 *
 * @param input - Exact capture or committed-read identity.
 * @param items - Every raw item from the exact source Scan page.
 * @returns Complete lossless planning artifact page.
 */
function createPlanningSourceArtifactPage(
  input:
    | WorkspaceSearchMigrationPlanningSourceArtifactCaptureInput
    | WorkspaceSearchMigrationPlanningSourceArtifactReadInput,
  items: readonly DynamoAttributeMap[],
): WorkspaceSearchMigrationPlanningSourceArtifactPage {
  const sourceTable = input.configuration.tables[input.source]
  const stateTable = input.configuration.tables['migration-state']
  if (sourceTable === undefined || stateTable === undefined) {
    throw new Error('Expected measured source and state tables.')
  }
  return {
    kind: 'workspace-search-planning-source-artifact-page',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_SOURCE_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    runId: input.runId,
    configurationHash: input.configurationHash,
    source: input.source,
    sourceTable: {
      tableName: sourceTable.tableName,
      tableArn: sourceTable.tableArn,
      tableId: sourceTable.tableId,
      creationTime: sourceTable.creationTime,
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

describe('Workspace Search migration source evidence AWS adapter', () => {
  test('resumes a multi-page chain and never rescans a terminal head', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem('page-1')
    const firstScanner = new SequencedSourceEvidenceScanner([{
      items: [firstItem],
      lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
    }])
    const firstPort = createSourceEvidencePort(
      configuration,
      firstScanner,
      transport,
    )

    const first = await firstPort.commitNextPage(request)
    expect(first).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: false,
        aggregate: {
          ignored: 1,
          pageCount: 1,
          scanned: 1,
        },
      },
    })

    const secondScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('page-2')],
    }])
    const resumedPort = createSourceEvidencePort(
      configuration,
      secondScanner,
      transport,
    )
    const durableBeforeResume = await resumedPort.readProgress(request)
    expect(durableBeforeResume).toEqual(first)

    const completed = await resumedPort.commitNextPage(request)
    const transactionCount = transport.transactionCommands.length
    const scannerCount = secondScanner.inputs.length
    const repeated = await resumedPort.commitNextPage(request)
    const replay = await resumedPort.readCommittedEvidence(request)

    expect(secondScanner.inputs[0]?.previousCheckpoint).toEqual(
      first.checkpoint,
    )
    expect(completed).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: {
          ignored: 2,
          pageCount: 2,
          scanned: 2,
        },
      },
    })
    expect(repeated).toEqual(completed)
    expect(replay.progress).toEqual(completed)
    expect(replay.sourceRows).toHaveLength(2)
    expect(replay.invalidRows).toHaveLength(0)
    expect(replay.sourceBindings).toHaveLength(0)
    expect(secondScanner.inputs).toHaveLength(scannerCount)
    expect(transport.transactionCommands).toHaveLength(transactionCount)
    expect(transport.readStoredItems()).toHaveLength(3)
  })

  test('atomically puts one immutable page and an exact CAS head', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem('conditions-1')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      },
      {
        items: [createIgnoredProjectDirectoryItem('conditions-2')],
      },
    ])
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
    )

    await port.commitNextPage(request)
    await port.commitNextPage(request)

    const firstCommand = transport.transactionCommands[0]
    const secondCommand = transport.transactionCommands[1]
    const firstEntries = firstCommand?.input.TransactItems
    const secondEntries = secondCommand?.input.TransactItems
    const firstPagePut = firstEntries?.[0]?.Put
    const firstHeadPut = firstEntries?.[1]?.Put
    const secondPagePut = secondEntries?.[0]?.Put
    const secondHeadPut = secondEntries?.[1]?.Put

    expect(firstCommand).toBeInstanceOf(TransactWriteItemsCommand)
    expect(firstEntries).toHaveLength(2)
    expect(firstPagePut?.TableName)
      .toBe(configuration.tables['migration-state'].tableName)
    expect(firstHeadPut?.TableName)
      .toBe(configuration.tables['migration-state'].tableName)
    expect(firstPagePut?.ConditionExpression)
      .toBe(
        'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
      )
    expect(firstHeadPut?.ConditionExpression)
      .toBe(
        'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
      )
    expect(readStringAttribute(
      requireItem(firstPagePut?.Item),
      'kind',
    )).toBe('workspace-search-migration-source-evidence-page-record')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'kind',
    )).toBe('workspace-search-migration-source-evidence-head')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'purpose',
    )).toBe('dry-run')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'source',
    )).toBe('project-directory')
    expect(readNumberAttribute(
      requireItem(firstHeadPut?.Item),
      'chainEvidenceVersion',
    )).toBe(1)

    expect(secondPagePut?.ConditionExpression)
      .toBe(firstPagePut?.ConditionExpression)
    expect(secondHeadPut?.ConditionExpression).toContain('#revision = :revision')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#checkpointDigest = :checkpointDigest')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#headDigest = :headDigest')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#purpose = :purpose')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#sourceTableId = :sourceTableId')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#chainEvidenceVersion = :chainEvidenceVersion')
    expect(secondHeadPut?.ExpressionAttributeNames).toMatchObject({
      '#chainEvidenceVersion': 'chainEvidenceVersion',
    })
    expect(secondHeadPut?.ExpressionAttributeValues).toMatchObject({
      ':revision': { N: '1' },
      ':purpose': { S: 'dry-run' },
      ':source': { S: 'project-directory' },
      ':sourceTableId': { S: 'table-id-project-directory' },
      ':stateTableId': { S: 'table-id-migration-state' },
      ':completed': { BOOL: false },
      ':chainEvidenceVersion': { N: '1' },
    })
    expect(readNumberAttribute(
      requireItem(secondHeadPut?.Item),
      'chainEvidenceVersion',
    )).toBe(1)
    expect(firstCommand?.input.ClientRequestToken).toMatch(/^wsm1-[0-9a-f]{31}$/)
    expect(secondCommand?.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/)
    expect(firstCommand?.input.ClientRequestToken)
      .not.toBe(secondCommand?.input.ClientRequestToken)
  })

  test('CAS-binds an existing historical head to marker absence', async () => {
    const configuration = createConfiguration()
    const request = createRequest(
      configuration,
      'project-directory',
      'run-historical-chain-marker',
    )
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem =
      createIgnoredProjectDirectoryItem('historical-marker-1')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      },
      {
        items: [
          createIgnoredProjectDirectoryItem('historical-marker-2'),
        ],
      },
    ])
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
    )

    await port.commitNextPage(request)
    const historicalHead = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-head',
      ),
    )
    Reflect.deleteProperty(
      historicalHead,
      'chainEvidenceVersion',
    )
    transport.replaceStoredItem(historicalHead)

    await port.commitNextPage(request)

    const headPut =
      transport.transactionCommands[1]?.input.TransactItems?.[1]?.Put
    expect(headPut?.ConditionExpression)
      .toContain('attribute_not_exists(#chainEvidenceVersion)')
    expect(headPut?.ExpressionAttributeNames).toMatchObject({
      '#chainEvidenceVersion': 'chainEvidenceVersion',
    })
    expect(
      headPut?.ExpressionAttributeValues?.[':chainEvidenceVersion'],
    ).toBeUndefined()
    expect(readNumberAttribute(
      requireItem(headPut?.Item),
      'chainEvidenceVersion',
    )).toBe(1)
  })

  test('does not classify a marker-only predecessor change as unchanged', async () => {
    const configuration = createConfiguration()
    const request = createRequest(
      configuration,
      'project-directory',
      'run-marker-only-reconciliation-change',
    )
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem =
      createIgnoredProjectDirectoryItem('marker-only-change-1')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      },
      {
        items: [
          createIgnoredProjectDirectoryItem('marker-only-change-2'),
        ],
      },
    ])
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
    )
    const predecessor = await port.commitNextPage(request)
    transport.beforeNextSourcePrepare(() => {
      const head = requireStoredItem(
        transport.readStoredItemByKind(
          'workspace-search-migration-source-evidence-head',
        ),
      )
      Reflect.deleteProperty(head, 'chainEvidenceVersion')
      transport.replaceStoredItem(head)
    })

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(await port.readProgress(request)).toEqual(predecessor)
    expect(transport.transactionCommands).toHaveLength(2)
    expect(transport.readStoredItems()).toHaveLength(2)
    expect(
      requireStoredItem(
        transport.readStoredItemByKind(
          'workspace-search-migration-source-evidence-head',
        ),
      ).chainEvidenceVersion,
    ).toBeUndefined()
  })

  test('forbids dry-run authority and requires it for planning commits', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('dry-run-authority')],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => new Date(initialTime),
      planningArtifactGateway,
    )
    const dryRunRequest = createRequest(configuration)
    Object.defineProperty(dryRunRequest, 'authority', {
      configurable: true,
      enumerable: true,
      value: undefined,
    })

    const forbidden = await captureMigrationFailure(
      () => port.commitNextPage(dryRunRequest),
    )

    expect(forbidden.code).toBe('INVALID_ARGUMENT')
    expect(scanner.inputs).toHaveLength(0)
    expect(transport.transactionCommands).toHaveLength(0)
    Reflect.deleteProperty(dryRunRequest, 'authority')

    const committed = await port.commitNextPage(dryRunRequest)
    expect(committed.purpose).toBe('dry-run')
    const entries =
      transport.transactionCommands[0]?.input.TransactItems
    expect(entries).toHaveLength(2)
    expect(entries?.[0]?.Put).toBeDefined()
    expect(entries?.[1]?.Put).toBeDefined()
    expect(planningArtifactGateway.captureCalls).toHaveLength(0)
    expect(planningArtifactGateway.readCalls).toHaveLength(0)

    const authorityTransport =
      new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      authorityTransport,
      clock,
      'run-planning-required',
      'owner-planning-required',
    )
    const planningRequest = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    Reflect.deleteProperty(planningRequest, 'authority')
    const planningPort = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('missing-authority')],
      }]),
      authorityTransport,
      () => clock.read(),
    )

    const missing = await captureMigrationFailure(
      () => planningPort.commitNextPage(planningRequest),
    )

    expect(missing.code).toBe('INVALID_MAINTENANCE_EVIDENCE')
    expect(authorityTransport.transactionCommands).toHaveLength(0)
  })

  test('samples only planning commit time after preparation and binds the full state incarnation', async () => {
    const configuration = createConfiguration()
    const dryRunTransport = new InMemorySourceEvidenceAwsTransport()
    let dryRunClockCalls = 0
    const dryRunPort = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('dry-run-clock')],
      }]),
      dryRunTransport,
      () => {
        dryRunClockCalls += 1
        return new Date(initialTime)
      },
    )

    await dryRunPort.commitNextPage(createRequest(configuration))

    expect(dryRunClockCalls).toBe(0)
    expect(dryRunTransport.transactionCommands[0]?.input.TransactItems)
      .toHaveLength(2)

    const planningTransport = new InMemorySourceEvidenceAwsTransport()
    const planningClock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      planningTransport,
      planningClock,
      'run-prepared-planning-clock',
      'owner-prepared-planning-clock',
    )
    const preparedAt = '2026-07-25T04:00:05.000Z'
    planningTransport.beforeNextSourcePrepare(() => {
      planningClock.set(preparedAt)
    })
    const planningScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('planning-clock')],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        planningScanner,
        planningTransport.planningArtifactStore,
      )
    let planningClockCalls = 0
    planningArtifactGateway.beforeNextCapture(() => {
      expect(planningTransport.prepareCalls).toHaveLength(0)
      expect(planningClockCalls).toBe(0)
    })
    const planningPort = createSourceEvidencePort(
      configuration,
      planningScanner,
      planningTransport,
      () => {
        planningClockCalls += 1
        return planningClock.read()
      },
      planningArtifactGateway,
    )

    await planningPort.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    const leaseCheck = requireConditionCheck(
      planningTransport.transactionCommands[0]
        ?.input.TransactItems?.[0],
    )
    expect(readNumberAttribute(
      requireItem(leaseCheck.ExpressionAttributeValues),
      ':minimumExpiry',
    )).toBe(Date.parse(preparedAt) + 10_000)
    expect(planningArtifactGateway.captureCalls).toHaveLength(1)
    expect(planningClockCalls).toBe(1)
    expect(
      planningTransport.transactionCommands[0]?.input.TransactItems,
    ).toHaveLength(5)

    const driftedStateTable: MigrationTableIdentity = {
      ...configuration.tables['migration-state'],
      creationTime: '2026-01-01T00:00:00.001Z',
    }
    const driftScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('state-incarnation-drift')],
    }])
    const driftTransport = new InMemorySourceEvidenceAwsTransport()
    const driftPort =
      createAwsWorkspaceSearchMigrationSourceEvidencePort({
        stateTable: driftedStateTable,
        scanner: driftScanner,
        planningArtifactGateway:
          new InMemoryPlanningSourceArtifactGateway(
            driftScanner,
            driftTransport.planningArtifactStore,
          ),
        transport: driftTransport,
        clock: () => new Date(initialTime),
      })

    const driftFailure = await captureMigrationFailure(
      () => driftPort.commitNextPage(createRequest(configuration)),
    )

    expect(driftFailure.code).toBe('IDENTITY_MISMATCH')
    expect(driftScanner.inputs).toHaveLength(0)
    expect(driftTransport.getCommands).toHaveLength(0)
  })

  test('prepends lease, pointer, and receipt checks to each planning page transaction', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-fixed-planning-layout',
      'owner-fixed-planning-layout',
    )
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('planning-layout')],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
      planningArtifactGateway,
    )

    const result = await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    expect(result).toMatchObject({
      purpose: 'planning',
      pageSequence: 1,
      checkpoint: { completed: true },
    })
    const entries =
      transport.transactionCommands[0]?.input.TransactItems
    expect(entries).toHaveLength(5)
    const durableAuthorityRows = [
      requireStoredItem(transport.readStoredItemByKind(leaseKind)),
      requireStoredItem(transport.readStoredItemByKind(pointerKind)),
      requireStoredItem(transport.readStoredItemByKind(receiptKind)),
    ]
    for (const [index, durableRow] of durableAuthorityRows.entries()) {
      const check = requireConditionCheck(entries?.[index])
      expect(readKeyRecordKey(check.Key))
        .toBe(readStringAttribute(durableRow, 'recordKey'))
      expect(conditionMatches(
        durableRow,
        check.ConditionExpression,
        check.ExpressionAttributeNames,
        check.ExpressionAttributeValues,
      )).toBe(true)
    }
    const pageItem = requireItem(entries?.[3]?.Put?.Item)
    expect(readStringAttribute(pageItem, 'kind'))
      .toBe('workspace-search-migration-source-evidence-page-record')
    expect(readStringAttribute(
      requireItem(entries?.[4]?.Put?.Item),
      'kind',
    )).toBe('workspace-search-migration-source-evidence-head')
    expect(readNumberAttribute(
      requireItem(entries?.[4]?.Put?.Item),
      'chainEvidenceVersion',
    )).toBe(3)
    expect(transport.prepareCalls).toHaveLength(1)
    expect(planningArtifactGateway.captureCalls).toHaveLength(1)
    expect(planningArtifactGateway.readCalls).toHaveLength(0)
    const planningPage = readPlanningEvidencePage(pageItem)
    expect(planningPage.evidenceVersion).toBe(3)
    if (planningPage.evidenceVersion !== 3) {
      throw new Error('Expected artifact-bound planning evidence.')
    }
    expect(planningPage.sourceArtifacts).toHaveLength(1)
    for (const reference of planningPage.sourceArtifacts) {
      expect(reference.objectKey).toBe(
        `workspace-search/v1/source-artifacts/v1/${reference.contentDigest}.json`,
      )
      expect(reference.versionId).toMatch(/^test-version-/)
    }
  })

  test('fails an artifact upload before preparation, clock, or transaction', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-artifact-upload-failure',
      'owner-artifact-upload-failure',
    )
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('artifact-upload-failure')],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    planningArtifactGateway.failNextCaptureAfterScan(
      createNamedError(
        'TimeoutError',
        'RAW-ARTIFACT-UPLOAD-FAILURE',
      ),
    )
    let clockCalls = 0
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => {
        clockCalls += 1
        return clock.read()
      },
      planningArtifactGateway,
    )

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(createPlanningRequest(
        configuration,
        authorityContext.authority,
      )),
    )

    expect(failure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(failure.message).not.toContain('RAW-ARTIFACT-UPLOAD-FAILURE')
    expect(planningArtifactGateway.captureCalls).toHaveLength(1)
    expect(scanner.inputs).toHaveLength(1)
    expect(transport.prepareCalls).toHaveLength(0)
    expect(transport.transactionCommands).toHaveLength(0)
    expect(clockCalls).toBe(0)
  })

  test('refuses a legacy planning v2 head before another artifact capture', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-legacy-v2-head',
      'owner-legacy-v2-head',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const initialScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('legacy-v2-head')],
    }])
    const initialPort = createSourceEvidencePort(
      configuration,
      initialScanner,
      transport,
      () => clock.read(),
    )
    await initialPort.commitNextPage(request)
    const pageItem = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-page-record',
      ),
    )
    const headItem = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-head',
      ),
    )
    const legacyValue = decodeEvidencePayloadRecord(pageItem)
    Reflect.set(legacyValue, 'evidenceVersion', 2)
    Reflect.deleteProperty(legacyValue, 'sourceArtifacts')
    const legacyPayload = new TextEncoder().encode(
      serializeCanonicalJson(legacyValue),
    )
    const legacyPage =
      parseWorkspaceSearchMigrationSourceEvidencePage(legacyPayload)
    const legacyDigest =
      createWorkspaceSearchMigrationSourceEvidencePageDigest(legacyPage)
    transport.replaceStoredItem({
      ...pageItem,
      pageDigest: { S: legacyDigest },
      payload: { B: legacyPayload },
    })
    const legacyHead = {
      ...headItem,
      headDigest: { S: legacyDigest },
    }
    Reflect.deleteProperty(legacyHead, 'chainEvidenceVersion')
    transport.replaceStoredItem(legacyHead)
    const scanner = new SequencedSourceEvidenceScanner([])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
      planningArtifactGateway,
    )
    const transactionCount = transport.transactionCommands.length
    const prepareCount = transport.prepareCalls.length
    const replay = await port.readCommittedEvidence(
      createPlanningReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      ),
    )

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(legacyPage.evidenceVersion).toBe(2)
    expect(replay.progress.evidenceDigest).toBe(legacyDigest)
    expect(replay.progress.checkpoint.completed).toBe(true)
    expect(replay.progress.checkpoint.aggregate.pageCount).toBe(1)
    expect(failure.code).toBe('INVALID_STATE')
    expect(planningArtifactGateway.captureCalls).toHaveLength(0)
    expect(planningArtifactGateway.readCalls).toHaveLength(0)
    expect(scanner.inputs).toHaveLength(0)
    expect(transport.prepareCalls).toHaveLength(prepareCount)
    expect(transport.transactionCommands).toHaveLength(transactionCount)
  })

  test('refuses a planning v3 head missing its chain marker before side effects', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-missing-v3-chain-marker',
      'owner-missing-v3-chain-marker',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const initialScanner = new SequencedSourceEvidenceScanner([{
      items: [
        createIgnoredProjectDirectoryItem('missing-v3-chain-marker'),
      ],
    }])
    const initialPort = createSourceEvidencePort(
      configuration,
      initialScanner,
      transport,
      () => clock.read(),
    )
    await initialPort.commitNextPage(request)
    const pageItem = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-page-record',
      ),
    )
    expect(readPlanningEvidencePage(pageItem).evidenceVersion).toBe(3)
    const historicalHead = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-head',
      ),
    )
    Reflect.deleteProperty(
      historicalHead,
      'chainEvidenceVersion',
    )
    transport.replaceStoredItem(historicalHead)

    const scanner = new SequencedSourceEvidenceScanner([])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    let clockCalls = 0
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => {
        clockCalls += 1
        return clock.read()
      },
      planningArtifactGateway,
    )
    const transactionCount = transport.transactionCommands.length
    const prepareCount = transport.prepareCalls.length

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(planningArtifactGateway.captureCalls).toHaveLength(0)
    expect(planningArtifactGateway.readCalls).toHaveLength(0)
    expect(scanner.inputs).toHaveLength(0)
    expect(transport.prepareCalls).toHaveLength(prepareCount)
    expect(transport.transactionCommands).toHaveLength(transactionCount)
    expect(clockCalls).toBe(0)
  })

  test('re-reduces committed raw artifacts and rejects missing or wrong raw data', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-artifact-replay',
      'owner-artifact-replay',
    )
    const rawItem = createIgnoredProjectDirectoryItem('artifact-replay')
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [rawItem],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
      planningArtifactGateway,
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const committed = await port.commitNextPage(request)
    const pageItem = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-page-record',
      ),
    )
    const planningPage = readPlanningEvidencePage(pageItem)
    if (planningPage.evidenceVersion !== 3) {
      throw new Error('Expected artifact-bound planning evidence.')
    }

    const replay = await port.readCommittedEvidence(
      createPlanningReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      ),
    )

    expect(replay.progress).toEqual(committed)
    expect(replay.sourceRows).toHaveLength(1)
    expect(planningArtifactGateway.readCalls).toHaveLength(1)
    expect(
      planningArtifactGateway.readCalls[0]?.sourceArtifacts,
    ).toEqual(planningPage.sourceArtifacts)

    planningArtifactGateway.returnWrongItemsOnNextRead([
      createIgnoredProjectDirectoryItem('wrong-artifact-replay'),
    ])
    const wrongFailure = await captureMigrationFailure(
      () => port.readCommittedEvidence(createPlanningReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )
    expect(wrongFailure.code).toBe('INVALID_SOURCE_ARTIFACT')
    expect(wrongFailure.message).not.toContain('wrong-artifact-replay')

    const firstReference = planningPage.sourceArtifacts[0]
    if (firstReference === undefined) {
      throw new Error('Expected one planning artifact reference.')
    }
    planningArtifactGateway.deleteStoredArtifact(firstReference)
    const missingFailure = await captureMigrationFailure(
      () => port.readCommittedEvidence(createPlanningReadRequest(
        configuration,
        authorityContext.authority.lease.runId,
      )),
    )
    expect(missingFailure.code).toBe('INVALID_SOURCE_ARTIFACT')
    expect(missingFailure.message)
      .not.toContain('RAW-MISSING-PLANNING-SOURCE-ARTIFACT')
  })

  test('classifies each planning authority condition by its fixed index', async () => {
    const expectations = [
      { index: 0, code: 'LEASE_LOST' },
      { index: 1, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 2, code: 'INVALID_MAINTENANCE_EVIDENCE' },
    ] as const

    for (const expectation of expectations) {
      const configuration = createConfiguration()
      const transport = new InMemorySourceEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const runId = `run-condition-index-${expectation.index}`
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        runId,
        `owner-condition-index-${expectation.index}`,
      )
      const port = createSourceEvidencePort(
        configuration,
        new SequencedSourceEvidenceScanner([{
          items: [createIgnoredProjectDirectoryItem(runId)],
        }]),
        transport,
        () => clock.read(),
      )
      transport.failNextTransaction({
        timing: 'before-commit',
        error: createConditionalTransactionFailure(
          [0, 1, 2, 3, 4].map(
            (index) => index === expectation.index,
          ),
        ),
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(createPlanningRequest(
          configuration,
          authorityContext.authority,
        )),
      )

      expect(failure.code).toBe(expectation.code)
      expect(transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-head',
      )).toBeUndefined()
    }
  })

  test('allows a same-fence heartbeat between scan and planning commit', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-planning-heartbeat',
      'owner-planning-heartbeat',
    )
    const port = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('same-fence-heartbeat')],
      }]),
      transport,
      () => clock.read(),
    )
    let heartbeatFence = 0
    transport.beforeNextSourceTransaction(async () => {
      clock.set('2026-07-25T04:00:01.000Z')
      const heartbeat = await authorityContext.port.heartbeatLease({
        lease: createLeaseClaim(authorityContext.authority.lease),
      })
      heartbeatFence = heartbeat.fenceToken
    })

    const result = await port.commitNextPage(createPlanningRequest(
      configuration,
      authorityContext.authority,
    ))

    expect(result.pageSequence).toBe(1)
    expect(heartbeatFence)
      .toBe(authorityContext.authority.lease.fenceToken)
    expect(transport.transactionCommands).toHaveLength(1)
  })

  test('rejects takeover, pointer drift, and receipt drift at the planning transaction', async () => {
    const takeoverConfiguration = createConfiguration()
    const takeoverTransport = new InMemorySourceEvidenceAwsTransport()
    const takeoverClock = new MutableAuthorityClock(initialTime)
    const takeoverAuthority = await acquirePlanningAuthority(
      takeoverConfiguration,
      takeoverTransport,
      takeoverClock,
      'run-stale-fence',
      'owner-stale-fence',
    )
    const takeoverPort = createSourceEvidencePort(
      takeoverConfiguration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('stale-fence')],
      }]),
      takeoverTransport,
      () => takeoverClock.read(),
    )
    takeoverTransport.beforeNextSourceTransaction(async () => {
      takeoverClock.set(takeoverAuthority.authority.lease.expiresAt)
      const successorPort = createAuthorityPort(
        takeoverConfiguration,
        takeoverTransport,
        takeoverClock,
      )
      await successorPort.acquireLease({
        runId: 'run-successor-fence',
        ownerId: 'owner-successor-fence',
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
    const pointerTransport = new InMemorySourceEvidenceAwsTransport()
    const pointerClock = new MutableAuthorityClock(initialTime)
    const pointerAuthority = await acquirePlanningAuthority(
      pointerConfiguration,
      pointerTransport,
      pointerClock,
      'run-pointer-drift',
      'owner-pointer-drift',
    )
    const pointerPort = createSourceEvidencePort(
      pointerConfiguration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('pointer-drift')],
      }]),
      pointerTransport,
      () => pointerClock.read(),
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

    const pointerFailure = await captureMigrationFailure(
      () => pointerPort.commitNextPage(createPlanningRequest(
        pointerConfiguration,
        pointerAuthority.authority,
      )),
    )
    expect(pointerFailure.code).toBe('INVALID_MAINTENANCE_EVIDENCE')

    const receiptConfiguration = createConfiguration()
    const receiptTransport = new InMemorySourceEvidenceAwsTransport()
    const receiptClock = new MutableAuthorityClock(initialTime)
    const receiptAuthority = await acquirePlanningAuthority(
      receiptConfiguration,
      receiptTransport,
      receiptClock,
      'run-receipt-drift',
      'owner-receipt-drift',
    )
    const receiptPort = createSourceEvidencePort(
      receiptConfiguration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('receipt-drift')],
      }]),
      receiptTransport,
      () => receiptClock.read(),
    )
    const receipt = requireStoredItem(
      receiptTransport.readStoredItemByKind(receiptKind),
    )
    receiptTransport.replaceStoredItem({
      ...receipt,
      runtimeRevision: { N: '43' },
    })

    const receiptFailure = await captureMigrationFailure(
      () => receiptPort.commitNextPage(createPlanningRequest(
        receiptConfiguration,
        receiptAuthority.authority,
      )),
    )
    expect(receiptFailure.code).toBe('INVALID_MAINTENANCE_EVIDENCE')
    expect(receiptTransport.readStoredItemByKind(
      'workspace-search-migration-source-evidence-head',
    )).toBeUndefined()
  })

  test('recovers planning response loss only for the authority-bound durable page and head', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-planning-response-loss',
      'owner-planning-response-loss',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('planning-response-loss')],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
      planningArtifactGateway,
    )
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-PLANNING-RESPONSE-LOSS',
      ),
    })

    const recovered = await port.commitNextPage(request)

    expect(recovered).toMatchObject({
      purpose: 'planning',
      pageSequence: 1,
      checkpoint: { completed: true },
    })
    const page = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-page-record',
      ),
    )
    expect(readPlanningAuthorityBinding(page)).toEqual({
      ownerId: authorityContext.authority.lease.ownerId,
      fenceToken: authorityContext.authority.lease.fenceToken,
      maintenanceEvidencePointerRevision:
        authorityContext.authority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        authorityContext.authority.maintenanceEvidenceReceiptDigest,
    })
    const planningPage = readPlanningEvidencePage(page)
    if (planningPage.evidenceVersion !== 3) {
      throw new Error('Expected artifact-bound planning evidence.')
    }
    expect(planningArtifactGateway.readCalls).toHaveLength(1)
    expect(
      planningArtifactGateway.readCalls[0]?.sourceArtifacts,
    ).toEqual(planningPage.sourceArtifacts)
    expect(
      planningArtifactGateway.readCalls[0]?.planningAuthority,
    ).toEqual(planningPage.planningAuthority)
    expect(await port.readProgress(createPlanningReadRequest(
      configuration,
      authorityContext.authority.lease.runId,
    ))).toEqual(recovered)
  })

  test('preserves configuration drift from response-loss artifact verification', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-response-loss-configuration-drift',
      'owner-response-loss-configuration-drift',
    )
    const request = createPlanningRequest(
      configuration,
      authorityContext.authority,
    )
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [
        createIgnoredProjectDirectoryItem(
          'response-loss-configuration-drift',
        ),
      ],
    }])
    const planningArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      )
    planningArtifactGateway.failNextRead(
      new WorkspaceSearchMigrationFailure(
        'CONFIGURATION_DRIFT',
        'RAW-ARTIFACT-CONFIGURATION-DRIFT',
      ),
    )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
      planningArtifactGateway,
    )
    transport.failNextTransaction({
      timing: 'after-commit',
      error: createNamedError(
        'TimeoutError',
        'RAW-CONFIGURATION-DRIFT-RESPONSE-LOSS',
      ),
    })

    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(failure).toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(planningArtifactGateway.captureCalls).toHaveLength(1)
    expect(planningArtifactGateway.readCalls).toHaveLength(1)
  })

  test('does not adopt an exact planning response-loss commit with a corrupted chain marker', async () => {
    const configuration = createConfiguration()
    const markerMutations:
      readonly ('changed' | 'removed')[] = ['removed', 'changed']

    for (const markerMutation of markerMutations) {
      const transport = new InMemorySourceEvidenceAwsTransport()
      const clock = new MutableAuthorityClock(initialTime)
      const authorityContext = await acquirePlanningAuthority(
        configuration,
        transport,
        clock,
        `run-response-loss-marker-${markerMutation}`,
        `owner-response-loss-marker-${markerMutation}`,
      )
      const request = createPlanningRequest(
        configuration,
        authorityContext.authority,
      )
      const scanner = new SequencedSourceEvidenceScanner([{
        items: [
          createIgnoredProjectDirectoryItem(
            `response-loss-marker-${markerMutation}`,
          ),
        ],
      }])
      const planningArtifactGateway =
        new InMemoryPlanningSourceArtifactGateway(
          scanner,
          transport.planningArtifactStore,
        )
      const port = createSourceEvidencePort(
        configuration,
        scanner,
        transport,
        () => clock.read(),
        planningArtifactGateway,
      )
      transport.failNextTransaction({
        timing: 'after-commit',
        error: createNamedError(
          'TimeoutError',
          `RAW-RESPONSE-LOSS-MARKER-${markerMutation}`,
        ),
        afterCommit: () => {
          const head = requireStoredItem(
            transport.readStoredItemByKind(
              'workspace-search-migration-source-evidence-head',
            ),
          )
          if (markerMutation === 'removed') {
            Reflect.deleteProperty(head, 'chainEvidenceVersion')
          } else {
            Reflect.set(head, 'chainEvidenceVersion', { N: '2' })
          }
          transport.replaceStoredItem(head)
          return Promise.resolve()
        },
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(request),
      )

      expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
      expect(failure.message).not.toContain('RAW-')
      expect(planningArtifactGateway.captureCalls).toHaveLength(1)
      expect(planningArtifactGateway.readCalls).toHaveLength(0)
      const page = requireStoredItem(
        transport.readStoredItemByKind(
          'workspace-search-migration-source-evidence-page-record',
        ),
      )
      expect(readPlanningEvidencePage(page).evidenceVersion).toBe(3)
      const head = requireStoredItem(
        transport.readStoredItemByKind(
          'workspace-search-migration-source-evidence-head',
        ),
      )
      if (markerMutation === 'removed') {
        expect(head.chainEvidenceVersion).toBeUndefined()
      } else {
        expect(readNumberAttribute(
          head,
          'chainEvidenceVersion',
        )).toBe(2)
      }
    }
  })

  test('does not let an old fence adopt the same scan page committed under a new fence', async () => {
    const configuration = createConfiguration()
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const runId = 'run-fenced-page-adoption'
    const oldContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      runId,
      'owner-old-fence',
    )
    const sharedPage: WorkspaceSearchMigrationSourceScanPage = {
      items: [createIgnoredProjectDirectoryItem('same-scan-result')],
    }
    const oldPort = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([sharedPage]),
      transport,
      () => clock.read(),
    )
    let newAuthority: WorkspaceSearchMigrationPrePlanAuthority | undefined
    let newCommitSequence = 0
    transport.beforeNextSourceTransaction(async () => {
      clock.set(oldContext.authority.lease.expiresAt)
      const newAuthorityPort = createAuthorityPort(
        configuration,
        transport,
        clock,
      )
      const newLease = await newAuthorityPort.acquireLease({
        runId,
        ownerId: 'owner-new-fence',
      })
      newAuthority = await newAuthorityPort.renewMaintenanceEvidence({
        lease: createLeaseClaim(newLease),
        expectedPointer: null,
        evidenceBytes: createMaintenanceEvidenceBytes(
          oldContext.authority.lease.expiresAt,
          'change:OPS-2027',
        ),
      })
      const newPort = createSourceEvidencePort(
        configuration,
        new SequencedSourceEvidenceScanner([sharedPage]),
        transport,
        () => clock.read(),
      )
      const newResult = await newPort.commitNextPage(
        createPlanningRequest(configuration, newAuthority),
      )
      newCommitSequence = newResult.pageSequence
    })

    const failure = await captureMigrationFailure(
      () => oldPort.commitNextPage(createPlanningRequest(
        configuration,
        oldContext.authority,
      )),
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(newCommitSequence).toBe(1)
    if (newAuthority === undefined) {
      throw new Error('Expected the new fence to commit its page.')
    }
    const page = requireStoredItem(
      transport.readStoredItemByKind(
        'workspace-search-migration-source-evidence-page-record',
      ),
    )
    expect(readPlanningAuthorityBinding(page)).toMatchObject({
      ownerId: newAuthority.lease.ownerId,
      fenceToken: newAuthority.lease.fenceToken,
    })
    expect(readPlanningAuthorityBinding(page)).not.toMatchObject({
      ownerId: oldContext.authority.lease.ownerId,
      fenceToken: oldContext.authority.lease.fenceToken,
    })
  })

  test('reconciles an exact commit after transaction response loss', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('response-loss')],
    }])
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
    )
    const timeout = new Error('RAW-TRANSACTION-CANARY')
    timeout.name = 'TimeoutError'
    transport.failNextTransaction({
      timing: 'after-commit',
      error: timeout,
    })

    const result = await port.commitNextPage(request)

    expect(result).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: true,
        aggregate: { pageCount: 1, scanned: 1 },
      },
    })
    expect(transport.transactionCommands).toHaveLength(1)
    expect(transport.getCommands).toHaveLength(4)
    expect(transport.readStoredItems()).toHaveLength(2)
    expect(await port.readProgress(request)).toEqual(result)
  })

  test('reconciles an intended page after the durable head advances', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem(
      'response-loss-advanced-1',
    )
    const firstPort = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([{
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      }]),
      transport,
    )
    const advancingPort =
      createSourceEvidencePort(
        configuration,
        new SequencedSourceEvidenceScanner([{
          items: [
            createIgnoredProjectDirectoryItem(
              'response-loss-advanced-2',
            ),
          ],
        }]),
        transport,
      )
    let advancedPageSequence = 0
    const timeout = new Error('RAW-ADVANCED-TRANSACTION-CANARY')
    timeout.name = 'TimeoutError'
    transport.failNextTransaction({
      timing: 'after-commit',
      error: timeout,
      afterCommit: async () => {
        const advanced = await advancingPort.commitNextPage(request)
        advancedPageSequence = advanced.pageSequence
      },
    })

    const recovered = await firstPort.commitNextPage(request)
    const durable = await firstPort.readProgress(request)

    expect(recovered).toMatchObject({
      pageSequence: 1,
      checkpoint: { completed: false },
    })
    expect(advancedPageSequence).toBe(2)
    expect(durable).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: { pageCount: 2, scanned: 2 },
      },
    })
    expect(transport.transactionCommands).toHaveLength(2)
    expect(transport.readStoredItems()).toHaveLength(3)
  })

  test('rejects a terminal page that duplicates an earlier source key', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const duplicateItem =
      createIgnoredProjectDirectoryItem('cross-page-duplicate')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [duplicateItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(duplicateItem),
      },
      {
        items: [duplicateItem],
      },
    ])
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
    )

    const first = await port.commitNextPage(request)
    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.transactionCommands).toHaveLength(1)
    expect(transport.readStoredItems()).toHaveLength(2)
    expect(await port.readProgress(request)).toEqual(first)
  })

  test('rejects an over-limit captured head before reading page records', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const port = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('over-limit')],
      }]),
      transport,
    )
    const completed = await port.commitNextPage(request)
    const head = transport.readStoredItems().find(
      (item) =>
        readStringAttribute(item, 'kind') ===
          'workspace-search-migration-source-evidence-head',
    )
    if (head === undefined) throw new Error('Expected one durable head.')
    const checkpointMap = readMapAttribute(head, 'checkpoint')
    const aggregateMap = readMapAttribute(checkpointMap, 'aggregate')
    const pageCount = 10_001
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
        S: createWorkspaceSearchMigrationSourceCheckpointDigest(
          overLimitCheckpoint,
        ),
      },
      checkpoint: {
        M: {
          ...checkpointMap,
          aggregate: {
            M: {
              ...aggregateMap,
              pageCount: { N: String(pageCount) },
            },
          },
        },
      },
    })
    const readsBeforeReplay = transport.getCommands.length

    const failure = await captureMigrationFailure(
      () => port.readCommittedEvidence(request),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.getCommands).toHaveLength(readsBeforeReplay + 1)
  })

  test('reconciles identical concurrent successors and rejects a different one', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const sharedPage: WorkspaceSearchMigrationSourceScanPage = {
      items: [createIgnoredProjectDirectoryItem('same-successor')],
    }
    const identicalTransport = new InMemorySourceEvidenceAwsTransport()
    const identicalScanner = new DeferredSourceEvidenceScanner()
    const identicalPort = createSourceEvidencePort(
      configuration,
      identicalScanner,
      identicalTransport,
    )

    const identicalFirst = identicalPort.commitNextPage(request)
    const identicalSecond = identicalPort.commitNextPage(request)
    await waitForPendingScans(identicalScanner, 2)
    identicalScanner.resolvePage(0, sharedPage)
    const firstResult = await identicalFirst
    identicalScanner.resolvePage(1, sharedPage)
    const secondResult = await identicalSecond

    expect(secondResult).toEqual(firstResult)
    expect(identicalTransport.transactionCommands).toHaveLength(2)
    expect(identicalTransport.readStoredItems()).toHaveLength(2)

    const differentTransport = new InMemorySourceEvidenceAwsTransport()
    const differentScanner = new DeferredSourceEvidenceScanner()
    const differentPort = createSourceEvidencePort(
      configuration,
      differentScanner,
      differentTransport,
    )
    const differentFirst = differentPort.commitNextPage(request)
    const differentSecond = differentPort.commitNextPage(request)
    await waitForPendingScans(differentScanner, 2)
    differentScanner.resolvePage(0, {
      items: [createIgnoredProjectDirectoryItem('winner')],
    })
    await differentFirst
    differentScanner.resolvePage(1, {
      items: [createIgnoredProjectDirectoryItem('loser')],
    })
    const failure = await captureMigrationFailure(
      () => differentSecond,
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(failure.message).not.toContain('winner')
    expect(failure.message).not.toContain('loser')
    expect(differentTransport.readStoredItems()).toHaveLength(2)
  })

  test('keeps ambiguous transaction outcomes fail-closed and retryable races transient', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const timeout = createNamedError(
      'TimeoutError',
      'RAW-TIMEOUT-CANARY',
    )
    const internalServerError = createNamedError(
      'InternalServerError',
      'RAW-500-CANARY',
    )
    Object.defineProperty(internalServerError, '$metadata', {
      value: { httpStatusCode: 500 },
    })
    const transactionInProgress = createNamedError(
      'TransactionInProgressException',
      'RAW-IN-PROGRESS-CANARY',
    )
    const ambiguousResults: string[] = []
    for (const [index, error] of [
      timeout,
      internalServerError,
      transactionInProgress,
    ].entries()) {
      const transport = new InMemorySourceEvidenceAwsTransport()
      const port = createSourceEvidencePort(
        configuration,
        new SequencedSourceEvidenceScanner([{
          items: [createIgnoredProjectDirectoryItem(`ambiguous-${index}`)],
        }]),
        transport,
      )
      transport.failNextTransaction({
        timing: 'before-commit',
        error,
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(request),
      )

      ambiguousResults.push(`${error.name}:${failure.code}`)
      expect(failure.message).not.toContain('RAW-')
      expect(transport.readStoredItems()).toHaveLength(0)
    }
    expect(ambiguousResults).toEqual([
      'TimeoutError:AMBIGUOUS_OPERATION_UNRESOLVED',
      'InternalServerError:AMBIGUOUS_OPERATION_UNRESOLVED',
      'TransactionInProgressException:AMBIGUOUS_OPERATION_UNRESOLVED',
    ])

    const transientErrors: readonly Error[] = [
      createNamedError(
        'TransactionConflictException',
        'RAW-CONFLICT-CANARY',
      ),
      createNamedError(
        'ProvisionedThroughputExceededException',
        'RAW-THROTTLE-CANARY',
      ),
      createCancellationWithReason('TransactionConflict', 2),
    ]
    for (const [index, error] of transientErrors.entries()) {
      const transport = new InMemorySourceEvidenceAwsTransport()
      const port = createSourceEvidencePort(
        configuration,
        new SequencedSourceEvidenceScanner([{
          items: [createIgnoredProjectDirectoryItem(`transient-${index}`)],
        }]),
        transport,
      )
      transport.failNextTransaction({
        timing: 'before-commit',
        error,
      })

      const failure = await captureMigrationFailure(
        () => port.commitNextPage(request),
      )

      expect(failure).toMatchObject({
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        message:
          'Workspace Search source evidence stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
      })
      expect(failure.message).not.toContain('RAW-')
      expect(transport.readStoredItems()).toHaveLength(0)
    }
  })

  test('redacts every raw scanner and point-read error', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)

    const rawTransport = new InMemorySourceEvidenceAwsTransport()
    const rawScanner = new DeferredSourceEvidenceScanner()
    const rawPort = createSourceEvidencePort(
      configuration,
      rawScanner,
      rawTransport,
    )
    const pending = rawPort.commitNextPage(request)
    await waitForPendingScans(rawScanner, 1)
    rawScanner.rejectScan(
      0,
      new WorkspaceSearchMigrationFailure(
        'IDENTITY_MISMATCH',
        'RAW-SCANNER-CANARY',
      ),
    )
    const rawFailure = await captureMigrationFailure(() => pending)
    expect(rawFailure).toMatchObject({
      code: 'IDENTITY_MISMATCH',
      message:
        'Workspace Search source evidence stopped safely (IDENTITY_MISMATCH).',
    })
    expect(rawFailure.message).not.toContain('RAW-SCANNER-CANARY')

    const forgedCodeCanary = 'RAW-FORGED-CODE-CANARY'
    const forgedFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'fixed test failure',
    )
    Object.defineProperty(forgedFailure, 'code', {
      value: forgedCodeCanary,
    })
    const forgedScanner = new DeferredSourceEvidenceScanner()
    const forgedPort = createSourceEvidencePort(
      configuration,
      forgedScanner,
      new InMemorySourceEvidenceAwsTransport(),
    )
    const forgedPending = forgedPort.commitNextPage(request)
    await waitForPendingScans(forgedScanner, 1)
    forgedScanner.rejectScan(0, forgedFailure)
    const forgedCodeFailure = await captureMigrationFailure(
      () => forgedPending,
    )
    expect(forgedCodeFailure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    expect(forgedCodeFailure.message).not.toContain(forgedCodeCanary)

    const readTransport = new InMemorySourceEvidenceAwsTransport()
    const readPort = createSourceEvidencePort(
      configuration,
      new SequencedSourceEvidenceScanner([]),
      readTransport,
    )
    readTransport.failNextGet(new Error('RAW-GET-CANARY'))
    const readFailure = await captureMigrationFailure(
      () => readPort.readProgress(request),
    )
    expect(readFailure.code).toBe('INVALID_STATE')
    expect(readFailure.message).not.toContain('RAW-GET-CANARY')
  })

  test('isolates every dry-run and planning source chain', async () => {
    const configuration = createConfiguration()
    const purposes: readonly WorkspaceSearchMigrationSourceEvidencePurpose[] = [
      'dry-run',
      'planning',
    ]
    const transport = new InMemorySourceEvidenceAwsTransport()
    const clock = new MutableAuthorityClock(initialTime)
    const authorityContext = await acquirePlanningAuthority(
      configuration,
      transport,
      clock,
      'run-purpose-isolation',
      'owner-purpose-isolation',
    )
    const scanner = new SequencedSourceEvidenceScanner(
      purposes.flatMap(() =>
        workspaceSearchMigrationSourceNames.map(() => ({ items: [] }))
      ),
    )
    const port = createSourceEvidencePort(
      configuration,
      scanner,
      transport,
      () => clock.read(),
    )
    const committedKeys = new Set<string>()

    for (const purpose of purposes) {
      for (const source of workspaceSearchMigrationSourceNames) {
        const request = purpose === 'dry-run'
          ? createRequest(
              configuration,
              source,
              'run-purpose-isolation',
            )
          : createPlanningRequest(
              configuration,
              authorityContext.authority,
              source,
            )
        const result = await port.commitNextPage(request)
        expect(result).toMatchObject({
          purpose,
          source,
          pageSequence: 1,
          checkpoint: { completed: true },
        })
        const command = transport.transactionCommands.at(-1)
        const entries = command?.input.TransactItems
        const writeOffset = purpose === 'planning' ? 3 : 0
        const pageKey = readStringAttribute(
          requireItem(entries?.[writeOffset]?.Put?.Item),
          'recordKey',
        )
        const headItem = requireItem(entries?.[writeOffset + 1]?.Put?.Item)
        const headKey = readStringAttribute(headItem, 'recordKey')
        expect(readStringAttribute(headItem, 'purpose')).toBe(purpose)
        expect(readStringAttribute(headItem, 'source')).toBe(source)
        committedKeys.add(pageKey)
        committedKeys.add(headKey)
      }
    }

    expect(committedKeys).toHaveLength(16)
    expect(transport.readStoredItems()).toHaveLength(19)
    expect(scanner.inputs).toHaveLength(8)

    for (const purpose of purposes) {
      for (const source of workspaceSearchMigrationSourceNames) {
        const request = purpose === 'dry-run'
          ? createRequest(
              configuration,
              source,
              'run-purpose-isolation',
            )
          : createPlanningReadRequest(
              configuration,
              authorityContext.authority.lease.runId,
              source,
            )
        const progress = await port.readProgress(request)
        expect(progress).toMatchObject({
          purpose,
          source,
          pageSequence: 1,
          checkpoint: { completed: true },
        })
      }
    }
  })
})

/**
 * Creates a complete non-authoritative dry-run commit request.
 *
 * @param configuration - Exact measured migration configuration.
 * @param source - Fixed source-table role.
 * @param runId - Operator-selected run identifier.
 * @returns Complete dry-run adapter request.
 */
function createRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
  runId = 'run-source-evidence',
): WorkspaceSearchMigrationDryRunSourceEvidenceAwsCommitRequest {
  return {
    runId,
    purpose: 'dry-run',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
  }
}

/**
 * Creates a complete authority-bearing planning commit request.
 *
 * @param configuration - Exact measured migration configuration.
 * @param authority - Exact current durable authority aggregate.
 * @param source - Fixed source-table role.
 * @returns Complete planning adapter request.
 */
function createPlanningRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
): WorkspaceSearchMigrationPlanningSourceEvidenceAwsCommitRequest {
  return {
    runId: authority.lease.runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
    authority: structuredClone(authority),
  }
}

/**
 * Creates a strict authority-free read request for one planning chain.
 *
 * @param configuration - Exact measured migration configuration.
 * @param runId - Planning run identifier.
 * @param source - Fixed source-table role.
 * @returns Exact planning read request.
 */
function createPlanningReadRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  runId: string,
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
): WorkspaceSearchMigrationSourceEvidenceAwsRequest {
  return {
    runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
  }
}

/**
 * Creates one source-evidence adapter with the measured state incarnation.
 *
 * @param configuration - Exact measured migration configuration.
 * @param scanner - Source scanner used by the adapter.
 * @param transport - Shared condition-aware in-memory transport.
 * @param clock - Trusted commit clock.
 * @param planningArtifactGateway - Planning-only raw page gateway.
 * @returns Configured source-evidence port.
 */
function createSourceEvidencePort(
  configuration: WorkspaceSearchMigrationConfiguration,
  scanner: CapturingSourceEvidenceScanner,
  transport: InMemorySourceEvidenceAwsTransport,
  clock: () => Date = () => new Date(initialTime),
  planningArtifactGateway:
    WorkspaceSearchMigrationPlanningSourceArtifactGateway =
      new InMemoryPlanningSourceArtifactGateway(
        scanner,
        transport.planningArtifactStore,
      ),
): WorkspaceSearchMigrationSourceEvidenceAwsPort {
  return createAwsWorkspaceSearchMigrationSourceEvidencePort({
    stateTable: configuration.tables['migration-state'],
    scanner,
    planningArtifactGateway,
    transport,
    clock,
  })
}

/**
 * Creates one authority adapter bound to the measured configuration.
 *
 * @param configuration - Exact measured migration configuration.
 * @param transport - Shared condition-aware in-memory transport.
 * @param clock - Mutable trusted clock.
 * @returns Configured pre-plan authority port.
 */
function createAuthorityPort(
  configuration: WorkspaceSearchMigrationConfiguration,
  transport: InMemorySourceEvidenceAwsTransport,
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
 * @param transport - Shared authority and source-evidence transport.
 * @param clock - Mutable trusted clock.
 * @param runId - Planning run identifier.
 * @param ownerId - Planning owner identifier.
 * @returns Authority port and exact current authority aggregate.
 */
async function acquirePlanningAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  transport: InMemorySourceEvidenceAwsTransport,
  clock: MutableAuthorityClock,
  runId: string,
  ownerId: string,
) {
  const port = createAuthorityPort(configuration, transport, clock)
  const lease = await port.acquireLease({ runId, ownerId })
  const authority = await port.renewMaintenanceEvidence({
    lease: createLeaseClaim(lease),
    expectedPointer: null,
    evidenceBytes: createMaintenanceEvidenceBytes(clock.read().toISOString()),
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
  locator = 'change:SOURCE-EVIDENCE',
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
 * Waits a bounded number of microtasks for concurrent Scans to be recorded.
 *
 * @param scanner - Deferred scanner under test.
 * @param expected - Required pending invocation count.
 */
async function waitForPendingScans(
  scanner: DeferredSourceEvidenceScanner,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (scanner.pendingCount() >= expected) return
    await Promise.resolve()
  }
  throw new Error('Timed out waiting for pending source Scans.')
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
 * Requires one optional transaction item for test inspection.
 *
 * @param item - Candidate low-level DynamoDB item.
 * @returns Complete item.
 */
function requireItem(
  item: Record<string, AttributeValue> | undefined,
): Record<string, AttributeValue> {
  if (item === undefined) {
    throw new Error('Expected one complete transaction item.')
  }
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
 * @param name - Required binary attribute name.
 * @returns Detached exact binary value.
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
 * @param name - Required numeric attribute name.
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
 * Reads one exact map attribute from a low-level item.
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
 * Compares two low-level values with the emitted condition operators.
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
    message: 'Condition-aware source evidence transaction was canceled.',
    CancellationReasons: failures.map((failed) => ({
      Code: failed ? 'ConditionalCheckFailed' : 'None',
    })),
  })
}

/**
 * Creates a transaction cancellation carrying one transient reason code.
 *
 * @param code - Stable DynamoDB cancellation reason.
 * @param entryCount - Transaction item count.
 * @returns Real low-level transaction cancellation.
 */
function createCancellationWithReason(
  code: string,
  entryCount: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'Transient source evidence transaction cancellation.',
    CancellationReasons: Array.from(
      { length: entryCount },
      (_, index) => ({ Code: index === 0 ? code : 'None' }),
    ),
  })
}

/**
 * Creates one raw error with an explicit stable classifier name.
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
 * Parses one durable page payload as strict planning evidence.
 *
 * @param item - Durable low-level source-evidence page row.
 * @returns Validated legacy v2 or artifact-bound v3 planning page.
 */
function readPlanningEvidencePage(
  item: Readonly<Record<string, AttributeValue>>,
): Extract<
  WorkspaceSearchMigrationSourceEvidencePage,
  { readonly purpose: 'planning' }
> {
  const page = parseWorkspaceSearchMigrationSourceEvidencePage(
    readBinaryAttribute(item, 'payload'),
  )
  if (page.purpose !== 'planning') {
    throw new Error('Expected one planning page document.')
  }
  return page
}

/**
 * Decodes one page payload into a mutable non-array fixture record.
 *
 * @param item - Durable low-level source-evidence page row.
 * @returns Mutable parsed payload record.
 */
function decodeEvidencePayloadRecord(
  item: Readonly<Record<string, AttributeValue>>,
): object {
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      readBinaryAttribute(item, 'payload'),
    ),
  )
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('Expected one evidence payload record.')
  }
  return parsed
}

/**
 * Reads the authority binding from one canonical planning page payload.
 *
 * @param item - Durable low-level source-evidence page row.
 * @returns Parsed planning-authority binding.
 */
function readPlanningAuthorityBinding(
  item: Readonly<Record<string, AttributeValue>>,
): unknown {
  return structuredClone(
    readPlanningEvidencePage(item).planningAuthority,
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
 * Creates one recognized non-target Project Directory item.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored source item.
 */
function createIgnoredProjectDirectoryItem(
  identifier: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
    entryType: { S: 'workspace-member' },
    payload: { S: 'fixture' },
  }
}

/**
 * Extracts the exact Project Directory key from one fixture item.
 *
 * @param item - Complete source item.
 * @returns Detached composite primary key.
 */
function createProjectDirectoryItemKey(
  item: DynamoAttributeMap,
): DynamoAttributeMap {
  const directoryId = item.directoryId
  const entryKey = item.entryKey
  if (directoryId === undefined || entryKey === undefined) {
    throw new Error('Expected a complete Project Directory key.')
  }
  return structuredClone({ directoryId, entryKey })
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
 * @param role - Non-source migration table role.
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
 * @returns Ordered partition and optional sort key descriptors.
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
