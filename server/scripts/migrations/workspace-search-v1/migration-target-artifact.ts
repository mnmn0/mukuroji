import { createHash } from 'node:crypto'
import {
  decodeAttributeMap,
  encodeAttributeMap,
  encodeUnknownAttributeMap,
  type EncodedAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Schema version of one lossless planning-target artifact segment. */
export const WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION = 1

/** Content-addressed namespace reserved for planning target artifacts. */
export const WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX =
  'workspace-search/v1/target-artifacts/v1'

/**
 * Maximum canonical UTF-8 size of one planning-target artifact segment.
 *
 * Segmentation occurs only between complete DynamoDB items, keeping every
 * object within a finite single-request boundary. The ceiling also retains a
 * legal 400 KiB item when every string byte expands to a six-byte JSON escape,
 * without splitting native AttributeValue state.
 */
export const WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES =
  16 * 1024 * 1024

/**
 * Immutable physical table fields required to bind an artifact to one
 * DynamoDB incarnation.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation = {
  /** Exact physical table name selected by the measured configuration. */
  readonly tableName: string
  /** Exact physical table ARN measured before the planning scan. */
  readonly tableArn: string
  /** Immutable DynamoDB TableId measured before the planning scan. */
  readonly tableId: string
  /** Canonical UTC creation time of the measured table incarnation. */
  readonly creationTime: string
}

/**
 * Durable planning authority copied into every segment of one target page.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactAuthority = {
  /** Process-unique owner of the authorizing global lease. */
  readonly ownerId: string
  /** Positive fencing token of the authorizing global lease. */
  readonly fenceToken: number
  /** Positive revision of the selected maintenance-evidence pointer. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the selected immutable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
}

/**
 * Exact immutable S3 identity of one persisted planning target artifact segment.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactReference = {
  /** Canonical target-artifact object key derived from the content digest. */
  readonly objectKey: string
  /** Exact non-null S3 object version selected after the immutable write. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical stored segment bytes. */
  readonly contentDigest: string
}

/**
 * Complete lossless target page before deterministic artifact segmentation.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactPage = {
  /** Planning-target page discriminator. */
  readonly kind: 'workspace-search-planning-target-artifact-page'
  /** Planning-target artifact schema version. */
  readonly artifactVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Artifact purpose, separated from dry-run evidence and rollback journals. */
  readonly purpose: 'planning'
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the exact reviewed measured configuration. */
  readonly configurationHash: string
  /** Exact physical target-table incarnation scanned for this page. */
  readonly targetTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** Exact physical migration-state table incarnation owning page evidence. */
  readonly stateTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** One-based position of this page in its planning evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding planning evidence page. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor checkpoint retained in DynamoDB. */
  readonly previousCheckpointDigest: string
  /** Exact lease and maintenance receipt authorizing this planning page. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
  /** Every exact raw item returned by the unfiltered target Scan page. */
  readonly items: readonly DynamoAttributeMap[]
}

/**
 * One bounded immutable segment of a complete planning target page.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactSegment = {
  /** Planning-target segment discriminator. */
  readonly kind: 'workspace-search-planning-target-artifact-segment'
  /** Planning-target artifact schema version. */
  readonly artifactVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Artifact purpose, separated from dry-run evidence and rollback journals. */
  readonly purpose: 'planning'
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the exact reviewed measured configuration. */
  readonly configurationHash: string
  /** Exact physical target-table incarnation scanned for this page. */
  readonly targetTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** Exact physical migration-state table incarnation owning page evidence. */
  readonly stateTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** One-based position of this page in its planning evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding planning evidence page. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor checkpoint retained in DynamoDB. */
  readonly previousCheckpointDigest: string
  /** Exact lease and maintenance receipt authorizing this planning page. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
  /** Zero-based position of this segment in the complete page artifact. */
  readonly segmentIndex: number
  /** Exact number of segments comprising the complete page artifact. */
  readonly segmentCount: number
  /** Zero-based page item index of this segment's first item. */
  readonly itemStartIndex: number
  /** Exact number of complete items stored in this segment. */
  readonly itemCount: number
  /** Exact raw item count across every segment of this target page. */
  readonly pageItemCount: number
  /** Ordered complete raw items stored without splitting an item. */
  readonly items: readonly DynamoAttributeMap[]
}

/**
 * Canonical stored bytes and their exact content identity for one segment.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment = {
  /** Detached validated segment represented by the stored bytes. */
  readonly segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment
  /** Exact canonical UTF-8 bytes without a trailing newline. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact canonical stored bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length of the segment. */
  readonly byteLength: number
}

/**
 * Stable raw-value-free failure raised for every invalid target artifact.
 */
export class WorkspaceSearchMigrationTargetArtifactError extends Error {
  /** Secret-free machine-readable target artifact failure code. */
  readonly code = 'INVALID_TARGET_ARTIFACT'

  /**
   * Creates a fresh stable target artifact failure.
   */
  constructor() {
    super('INVALID_TARGET_ARTIFACT')
    this.name = 'WorkspaceSearchMigrationTargetArtifactError'
  }
}

/**
 * Deterministically partitions and serializes one complete planning target page.
 *
 * Segment boundaries are chosen greedily at item boundaries under the fixed
 * canonical byte ceiling. The same page always produces identical segments.
 *
 * @param page - Complete planning page containing every raw Scan item.
 * @returns Ordered canonical segments and exact content digests.
 */
export function serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
): readonly WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment[] {
  return runTargetArtifactBoundary(() =>
    serializePlanningTargetArtifactPageUnchecked(page)
  )
}

/**
 * Parses a complete ordered segment set and reconstructs the lossless page.
 *
 * The parser rejects missing, duplicated, reordered, differently partitioned,
 * non-canonical, or identity-inconsistent segments.
 *
 * @param encodedSegments - Ordered exact bytes of every page segment.
 * @returns Detached complete planning target page.
 */
export function parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
  encodedSegments: readonly Uint8Array[],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  return runTargetArtifactBoundary(() =>
    parsePlanningTargetArtifactPageUnchecked(encodedSegments)
  )
}

/**
 * Serializes one locally assembled segment into strict canonical bytes.
 *
 * Full-page callers should prefer
 * {@link serializeWorkspaceSearchMigrationPlanningTargetArtifactPage}, which
 * additionally enforces the canonical segment partition.
 *
 * @param segment - Candidate complete artifact segment.
 * @returns Exact canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationPlanningTargetArtifactSegment(
  segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment,
): Uint8Array {
  return runTargetArtifactBoundary(() =>
    encodeCanonicalSegment(readRawSegment(segment))
  )
}

/**
 * Parses and validates one exact canonical artifact segment.
 *
 * @param bytes - Untrusted bounded UTF-8 segment bytes.
 * @returns Detached lossless planning-target segment.
 */
export function parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  return runTargetArtifactBoundary(() => parseSegmentBytesUnchecked(bytes))
}

/**
 * Creates the SHA-256 digest of one exact valid canonical segment.
 *
 * @param bytes - Exact canonical bytes selected for immutable storage.
 * @returns Lowercase SHA-256 content digest.
 */
export function createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest(
  bytes: Uint8Array,
): string {
  return runTargetArtifactBoundary(() => {
    void parseSegmentBytesUnchecked(bytes)
    return digestExactBytes(bytes)
  })
}

/**
 * Creates the canonical content-addressed key for one planning artifact segment.
 *
 * @param contentDigest - Lowercase SHA-256 digest of the exact segment bytes.
 * @returns Canonical secret-free S3 object key.
 */
export function createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
  contentDigest: string,
): string {
  return runTargetArtifactBoundary(() => {
    if (!isHexDigest(contentDigest)) return failTargetArtifact()
    return `${WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX}/${contentDigest}.json`
  })
}

/**
 * Common identity and authority shared by a page and every one of its segments.
 */
type PlanningTargetArtifactCommonFields = {
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the exact reviewed measured configuration. */
  readonly configurationHash: string
  /** Exact physical target-table incarnation scanned for this page. */
  readonly targetTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** Exact physical migration-state table incarnation owning page evidence. */
  readonly stateTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** One-based position of this page in its planning evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding planning evidence page. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor checkpoint retained in DynamoDB. */
  readonly previousCheckpointDigest: string
  /** Exact lease and maintenance receipt authorizing this planning page. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
}

/**
 * Canonical raw and encoded forms retained while choosing segment boundaries.
 */
type PreparedPlanningTargetArtifactItem = {
  /** Detached exact raw DynamoDB item. */
  readonly raw: DynamoAttributeMap
  /** Canonical tagged AttributeValue representation. */
  readonly encoded: EncodedAttributeMap
  /** Exact canonical UTF-8 byte length of the encoded item alone. */
  readonly canonicalByteLength: number
}

/**
 * Validated page and pre-encoded item material used by the partitioner.
 */
type PreparedPlanningTargetArtifactPage = {
  /** Detached complete validated page. */
  readonly page: WorkspaceSearchMigrationPlanningTargetArtifactPage
  /** Canonical item representations in exact Scan order. */
  readonly items: readonly PreparedPlanningTargetArtifactItem[]
}

/**
 * One contiguous item range selected for an artifact segment.
 */
type PlanningTargetArtifactSegmentRange = {
  /** Zero-based first page item index. */
  readonly itemStartIndex: number
  /** Number of complete items in the range. */
  readonly itemCount: number
}

/**
 * Serializes a validated page without crossing the public error boundary.
 *
 * @param value - Candidate complete planning target page.
 * @returns Ordered canonical encoded segments.
 */
function serializePlanningTargetArtifactPageUnchecked(
  value: WorkspaceSearchMigrationPlanningTargetArtifactPage,
): readonly WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment[] {
  const prepared = preparePlanningTargetArtifactPage(value)
  const ranges = partitionPlanningTargetArtifactPage(prepared)
  const segmentCount = ranges.length
  return ranges.map((range, segmentIndex) => {
    const segment = createPlanningTargetArtifactSegment(
      prepared.page,
      range,
      segmentIndex,
      segmentCount,
    )
    const bytes = encodeCanonicalSegment(segment)
    const detached = parseSegmentBytesUnchecked(bytes)
    return {
      segment: detached,
      bytes: new Uint8Array(bytes),
      contentDigest: digestExactBytes(bytes),
      byteLength: bytes.byteLength,
    }
  })
}

/**
 * Parses and validates a complete canonical segment collection.
 *
 * @param value - Candidate ordered segment byte collection.
 * @returns Reconstructed complete planning page.
 */
function parsePlanningTargetArtifactPageUnchecked(
  value: readonly Uint8Array[],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const encodedSegments = readDenseArrayValues(value)
  if (
    encodedSegments.length === 0 ||
    encodedSegments.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetArtifact()
  }
  const bytes = encodedSegments.map((candidate) => {
    if (!(candidate instanceof Uint8Array)) return failTargetArtifact()
    return new Uint8Array(candidate)
  })
  const segments = bytes.map(parseSegmentBytesUnchecked)
  const page = assemblePlanningTargetArtifactPage(segments)
  const expected =
    serializePlanningTargetArtifactPageUnchecked(page)
  if (
    expected.length !== bytes.length ||
    expected.some((segment, index) => {
      const candidate = bytes[index]
      return candidate === undefined ||
        !Buffer.from(segment.bytes).equals(Buffer.from(candidate))
    })
  ) {
    return failTargetArtifact()
  }
  return page
}

/**
 * Strictly validates and pre-encodes a complete page.
 *
 * @param value - Candidate complete planning target page.
 * @returns Detached page and canonical item encodings.
 */
function preparePlanningTargetArtifactPage(
  value: WorkspaceSearchMigrationPlanningTargetArtifactPage,
): PreparedPlanningTargetArtifactPage {
  const page = readRawPage(value)
  const items = page.items.map((item) => {
    const encoded = encodeAttributeMap(item)
    return {
      raw: item,
      encoded,
      canonicalByteLength: canonicalByteLength(encoded),
    }
  })
  return { page, items }
}

/**
 * Greedily creates deterministic bounded item ranges for one page.
 *
 * A conservative maximum-width segment index and count are used while packing,
 * so replacing them with the final smaller values cannot exceed the limit.
 *
 * @param prepared - Validated page with pre-encoded item lengths.
 * @returns Ordered contiguous ranges covering every page item exactly once.
 */
function partitionPlanningTargetArtifactPage(
  prepared: PreparedPlanningTargetArtifactPage,
): readonly PlanningTargetArtifactSegmentRange[] {
  if (prepared.items.length === 0) {
    return [{ itemStartIndex: 0, itemCount: 0 }]
  }

  const ranges: PlanningTargetArtifactSegmentRange[] = []
  let itemStartIndex = 0
  let itemCount = 0
  let encodedItemsByteLength = 0
  for (let index = 0; index < prepared.items.length; index += 1) {
    const item = prepared.items[index]
    if (item === undefined) return failTargetArtifact()
    const candidateCount = itemCount + 1
    const candidateItemsByteLength =
      encodedItemsByteLength +
      item.canonicalByteLength +
      (itemCount === 0 ? 0 : 1)
    const candidateSegmentByteLength =
      calculateConservativeSegmentByteLength(
        prepared.page,
        itemStartIndex,
        candidateCount,
        candidateItemsByteLength,
      )
    if (
      candidateSegmentByteLength <=
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
    ) {
      itemCount = candidateCount
      encodedItemsByteLength = candidateItemsByteLength
      continue
    }
    if (itemCount === 0) return failTargetArtifact()
    ranges.push({ itemStartIndex, itemCount })
    itemStartIndex = index
    itemCount = 1
    encodedItemsByteLength = item.canonicalByteLength
    if (
      calculateConservativeSegmentByteLength(
        prepared.page,
        itemStartIndex,
        itemCount,
        encodedItemsByteLength,
      ) >
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
    ) {
      return failTargetArtifact()
    }
  }
  if (itemCount === 0) return failTargetArtifact()
  ranges.push({ itemStartIndex, itemCount })
  return ranges
}

/**
 * Computes a conservative exact segment size using maximum-width indices.
 *
 * @param page - Validated page supplying common artifact metadata.
 * @param itemStartIndex - Zero-based first page item index.
 * @param itemCount - Candidate complete item count.
 * @param encodedItemsByteLength - Encoded item bytes plus inter-item commas.
 * @returns Conservative canonical segment byte length.
 */
function calculateConservativeSegmentByteLength(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
  itemStartIndex: number,
  itemCount: number,
  encodedItemsByteLength: number,
): number {
  const encoded: EncodedPlanningTargetArtifactSegmentValue = {
    ...commonSegmentValue(page),
    segmentIndex: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE - 1,
    segmentCount: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
    itemStartIndex,
    itemCount,
    pageItemCount: page.items.length,
    items: [],
  }
  const emptyItemsLength = canonicalByteLength(encoded)
  return emptyItemsLength + encodedItemsByteLength
}

/**
 * Creates one final raw segment from a deterministic contiguous item range.
 *
 * @param page - Complete validated planning page.
 * @param range - Contiguous complete item range.
 * @param segmentIndex - Zero-based segment position.
 * @param segmentCount - Exact total number of segments.
 * @returns Complete raw artifact segment.
 */
function createPlanningTargetArtifactSegment(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
  range: PlanningTargetArtifactSegmentRange,
  segmentIndex: number,
  segmentCount: number,
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  const segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment = {
    kind: 'workspace-search-planning-target-artifact-segment',
    artifactVersion:
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    ...copyCommonFields(page),
    segmentIndex,
    segmentCount,
    itemStartIndex: range.itemStartIndex,
    itemCount: range.itemCount,
    pageItemCount: page.items.length,
    items: page.items.slice(
      range.itemStartIndex,
      range.itemStartIndex + range.itemCount,
    ),
  }
  validateSegmentShape(segment)
  return segment
}

/**
 * Reconstructs and validates one complete page from parsed segments.
 *
 * @param segments - Ordered detached segment documents.
 * @returns Complete lossless planning target page.
 */
function assemblePlanningTargetArtifactPage(
  segments: readonly WorkspaceSearchMigrationPlanningTargetArtifactSegment[],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const first = segments[0]
  if (first === undefined || first.segmentCount !== segments.length) {
    return failTargetArtifact()
  }
  const commonFingerprint = createCommonFieldsFingerprint(first)
  const items: DynamoAttributeMap[] = []
  let expectedItemStartIndex = 0
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    if (
      segment === undefined ||
      segment.segmentIndex !== segmentIndex ||
      segment.segmentCount !== segments.length ||
      segment.pageItemCount !== first.pageItemCount ||
      segment.itemStartIndex !== expectedItemStartIndex ||
      createCommonFieldsFingerprint(segment) !== commonFingerprint
    ) {
      return failTargetArtifact()
    }
    items.push(...segment.items)
    expectedItemStartIndex += segment.itemCount
  }
  if (
    expectedItemStartIndex !== first.pageItemCount ||
    items.length !== first.pageItemCount
  ) {
    return failTargetArtifact()
  }
  return readRawPage({
    kind: 'workspace-search-planning-target-artifact-page',
    artifactVersion:
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    ...copyCommonFields(first),
    items,
  })
}

/**
 * Reads a typed page through an exact runtime shape and AttributeValue boundary.
 *
 * @param value - Candidate raw page.
 * @returns Detached validated page.
 */
function readRawPage(
  value: WorkspaceSearchMigrationPlanningTargetArtifactPage,
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const record = requireRecord(value)
  requireExactKeys(record, pageKeys)
  requirePageDiscriminators(record)
  const common = readCommonFields(record)
  const items = readRawItems(record.items)
  return {
    kind: 'workspace-search-planning-target-artifact-page',
    artifactVersion:
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    ...common,
    items,
  }
}

/**
 * Reads a typed segment through an exact runtime shape and AttributeValue boundary.
 *
 * @param value - Candidate raw segment.
 * @returns Detached validated segment.
 */
function readRawSegment(
  value: WorkspaceSearchMigrationPlanningTargetArtifactSegment,
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  const record = requireRecord(value)
  requireExactKeys(record, segmentKeys)
  requireSegmentDiscriminators(record)
  return readSegmentRecord(record, readRawItems(record.items))
}

/**
 * Parses one canonical segment without replacing its failure boundary.
 *
 * @param bytes - Candidate exact canonical UTF-8 bytes.
 * @returns Detached validated segment.
 */
function parseSegmentBytesUnchecked(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
  ) {
    return failTargetArtifact()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failTargetArtifact()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failTargetArtifact()
  }
  const segment = readEncodedSegment(parsed)
  const canonical = encodeCanonicalSegment(segment)
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    return failTargetArtifact()
  }
  return segment
}

/**
 * Reads one parsed tagged segment document.
 *
 * @param value - Candidate parsed JSON value.
 * @returns Detached segment containing raw DynamoDB AttributeValues.
 */
function readEncodedSegment(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  const record = requireRecord(value)
  requireExactKeys(record, segmentKeys)
  requireSegmentDiscriminators(record)
  return readSegmentRecord(record, readEncodedItems(record.items))
}

/**
 * Reconstructs a segment from validated common fields and raw items.
 *
 * @param record - Strict segment record.
 * @param items - Detached validated raw item list.
 * @returns Complete validated segment.
 */
function readSegmentRecord(
  record: Readonly<Record<string, unknown>>,
  items: readonly DynamoAttributeMap[],
): WorkspaceSearchMigrationPlanningTargetArtifactSegment {
  const segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment = {
    kind: 'workspace-search-planning-target-artifact-segment',
    artifactVersion:
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    ...readCommonFields(record),
    segmentIndex: readNonNegativeSafeInteger(record.segmentIndex),
    segmentCount: readPositiveSafeInteger(record.segmentCount),
    itemStartIndex: readNonNegativeSafeInteger(record.itemStartIndex),
    itemCount: readNonNegativeSafeInteger(record.itemCount),
    pageItemCount: readNonNegativeSafeInteger(record.pageItemCount),
    items,
  }
  validateSegmentShape(segment)
  return segment
}

/**
 * Validates one segment's local range and cardinality invariants.
 *
 * @param segment - Candidate reconstructed segment.
 */
function validateSegmentShape(
  segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment,
): void {
  if (
    segment.segmentCount > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE ||
    segment.segmentIndex >= segment.segmentCount ||
    segment.pageItemCount > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE ||
    segment.itemCount !== segment.items.length ||
    segment.itemStartIndex + segment.itemCount > segment.pageItemCount
  ) {
    return failTargetArtifact()
  }
  if (segment.pageItemCount === 0) {
    if (
      segment.segmentCount !== 1 ||
      segment.segmentIndex !== 0 ||
      segment.itemStartIndex !== 0 ||
      segment.itemCount !== 0
    ) {
      return failTargetArtifact()
    }
    return
  }
  if (segment.itemCount === 0) return failTargetArtifact()
}

/**
 * Encodes one segment into bounded strict canonical bytes.
 *
 * @param segment - Validated raw segment.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonicalSegment(
  segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment,
): Uint8Array {
  const encoded: EncodedPlanningTargetArtifactSegmentValue = {
    ...commonSegmentValue(segment),
    segmentIndex: segment.segmentIndex,
    segmentCount: segment.segmentCount,
    itemStartIndex: segment.itemStartIndex,
    itemCount: segment.itemCount,
    pageItemCount: segment.pageItemCount,
    items: segment.items.map(encodeAttributeMap),
  }
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(encoded),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
  ) {
    return failTargetArtifact()
  }
  return bytes
}

/**
 * JSON-safe common segment value used by size calculation and serialization.
 */
type EncodedPlanningTargetArtifactSegmentValue =
  ReturnType<typeof commonSegmentValue> & {
    /** Zero-based segment position. */
    readonly segmentIndex: number
    /** Exact complete segment count. */
    readonly segmentCount: number
    /** Zero-based first page item index. */
    readonly itemStartIndex: number
    /** Exact segment item count. */
    readonly itemCount: number
    /** Exact complete page item count. */
    readonly pageItemCount: number
    /** Canonical tagged target items. */
    readonly items: readonly EncodedAttributeMap[]
  }

/**
 * Projects common segment fields into their strict JSON-safe representation.
 *
 * @param value - Page or segment carrying common artifact bindings.
 * @returns Canonical JSON-safe common segment fields.
 */
function commonSegmentValue(
  value: PlanningTargetArtifactCommonFields,
) {
  return {
    kind: 'workspace-search-planning-target-artifact-segment',
    artifactVersion:
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    runId: value.runId,
    configurationHash: value.configurationHash,
    targetTable: encodeTableIncarnation(value.targetTable),
    stateTable: encodeTableIncarnation(value.stateTable),
    pageSequence: value.pageSequence,
    previousEvidenceDigest: value.previousEvidenceDigest,
    previousCheckpointDigest: value.previousCheckpointDigest,
    planningAuthority: encodePlanningAuthority(value.planningAuthority),
  }
}

/**
 * Copies common page bindings without retaining caller-owned wrapper objects.
 *
 * @param value - Page or segment carrying common artifact bindings.
 * @returns Detached common artifact bindings.
 */
function copyCommonFields(
  value: PlanningTargetArtifactCommonFields,
): PlanningTargetArtifactCommonFields {
  return {
    runId: value.runId,
    configurationHash: value.configurationHash,
    targetTable: { ...value.targetTable },
    stateTable: { ...value.stateTable },
    pageSequence: value.pageSequence,
    previousEvidenceDigest: value.previousEvidenceDigest,
    previousCheckpointDigest: value.previousCheckpointDigest,
    planningAuthority: { ...value.planningAuthority },
  }
}

/**
 * Reads and validates fields common to pages and segments.
 *
 * @param record - Strict page or segment record.
 * @returns Detached common artifact bindings.
 */
function readCommonFields(
  record: Readonly<Record<string, unknown>>,
): PlanningTargetArtifactCommonFields {
  const targetTable = readTableIncarnation(record.targetTable)
  const stateTable = readTableIncarnation(record.stateTable)
  if (
    targetTable.tableId === stateTable.tableId ||
    targetTable.tableArn === stateTable.tableArn
  ) {
    return failTargetArtifact()
  }
  return {
    runId: readIdentifier(record.runId),
    configurationHash: readDigest(record.configurationHash),
    targetTable,
    stateTable,
    pageSequence: readPositiveSafeInteger(record.pageSequence),
    previousEvidenceDigest: readDigest(record.previousEvidenceDigest),
    previousCheckpointDigest: readDigest(record.previousCheckpointDigest),
    planningAuthority: readPlanningAuthority(record.planningAuthority),
  }
}

/**
 * Creates a canonical equality fingerprint for common segment bindings.
 *
 * @param value - Page or segment carrying common artifact bindings.
 * @returns Canonical common-field JSON.
 */
function createCommonFieldsFingerprint(
  value: PlanningTargetArtifactCommonFields,
): string {
  return serializeCanonicalJson({
    runId: value.runId,
    configurationHash: value.configurationHash,
    targetTable: encodeTableIncarnation(value.targetTable),
    stateTable: encodeTableIncarnation(value.stateTable),
    pageSequence: value.pageSequence,
    previousEvidenceDigest: value.previousEvidenceDigest,
    previousCheckpointDigest: value.previousCheckpointDigest,
    planningAuthority: encodePlanningAuthority(value.planningAuthority),
  })
}

/**
 * Reads one exact physical table-incarnation binding.
 *
 * @param value - Candidate table incarnation.
 * @returns Detached validated table incarnation.
 */
function readTableIncarnation(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation {
  const record = requireRecord(value)
  requireExactKeys(record, tableIncarnationKeys)
  const creationTime = record.creationTime
  if (!isCanonicalTimestamp(creationTime)) return failTargetArtifact()
  return {
    tableName: readBoundedText(record.tableName),
    tableArn: readBoundedText(record.tableArn),
    tableId: readBoundedText(record.tableId),
    creationTime,
  }
}

/**
 * Encodes one validated table incarnation.
 *
 * @param value - Exact table incarnation.
 * @returns Strict JSON-safe table fields.
 */
function encodeTableIncarnation(
  value: WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation,
) {
  return {
    tableName: value.tableName,
    tableArn: value.tableArn,
    tableId: value.tableId,
    creationTime: value.creationTime,
  }
}

/**
 * Reads one exact planning authority binding.
 *
 * @param value - Candidate planning authority.
 * @returns Detached validated authority.
 */
function readPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, planningAuthorityKeys)
  return {
    ownerId: readIdentifier(record.ownerId),
    fenceToken: readPositiveSafeInteger(record.fenceToken),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(record.maintenanceEvidencePointerRevision),
    maintenanceEvidenceReceiptDigest:
      readDigest(record.maintenanceEvidenceReceiptDigest),
  }
}

/**
 * Encodes one validated planning authority.
 *
 * @param value - Exact planning authority.
 * @returns Strict JSON-safe authority fields.
 */
function encodePlanningAuthority(
  value: WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
) {
  return {
    ownerId: value.ownerId,
    fenceToken: value.fenceToken,
    maintenanceEvidencePointerRevision:
      value.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      value.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Reads and detaches a bounded dense raw target item list.
 *
 * @param value - Candidate raw DynamoDB item list.
 * @returns Detached exact target items.
 */
function readRawItems(value: unknown): readonly DynamoAttributeMap[] {
  const candidates = readDenseArrayValues(value)
  if (candidates.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE) {
    return failTargetArtifact()
  }
  return candidates.map((candidate) => {
    const item = decodeAttributeMap(encodeUnknownAttributeMap(candidate))
    if (Object.keys(item).length === 0) return failTargetArtifact()
    validateDynamoDbItemSize(item)
    return item
  })
}

/**
 * Reads and detaches a bounded dense tagged target item list.
 *
 * @param value - Candidate canonical tagged item list.
 * @returns Detached exact raw target items.
 */
function readEncodedItems(value: unknown): readonly DynamoAttributeMap[] {
  const candidates = readDenseArrayValues(value)
  if (candidates.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE) {
    return failTargetArtifact()
  }
  return candidates.map((candidate) => {
    const item = decodeAttributeMap(candidate)
    if (Object.keys(item).length === 0) return failTargetArtifact()
    validateDynamoDbItemSize(item)
    return item
  })
}

/**
 * Reads a dense array through own enumerable data properties only.
 *
 * @param value - Candidate dense array.
 * @returns Fresh array containing exact own values.
 */
function readDenseArrayValues(value: unknown): readonly unknown[] {
  if (!hasCanonicalDenseArrayShape(value)) return failTargetArtifact()
  const values: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failTargetArtifact()
    }
    values.push(descriptor.value)
  }
  return values
}

/**
 * Requires exact page discriminator constants.
 *
 * @param record - Candidate page record.
 */
function requirePageDiscriminators(
  record: Readonly<Record<string, unknown>>,
): void {
  if (
    record.kind !== 'workspace-search-planning-target-artifact-page' ||
    record.artifactVersion !==
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION ||
    record.purpose !== 'planning'
  ) {
    return failTargetArtifact()
  }
}

/**
 * Requires exact segment discriminator constants.
 *
 * @param record - Candidate segment record.
 */
function requireSegmentDiscriminators(
  record: Readonly<Record<string, unknown>>,
): void {
  if (
    record.kind !== 'workspace-search-planning-target-artifact-segment' ||
    record.artifactVersion !==
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION ||
    record.purpose !== 'planning'
  ) {
    return failTargetArtifact()
  }
}

/**
 * Reads one safe bounded migration identifier.
 *
 * @param value - Candidate run or owner identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failTargetArtifact()
  }
  return value
}

/**
 * Reads one exact-trimmed bounded UTF-8 text field.
 *
 * @param value - Candidate physical resource identity text.
 * @returns Validated text.
 */
function readBoundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failTargetArtifact()
  }
  return value
}

/**
 * Reads one conventional lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failTargetArtifact()
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated nonnegative integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failTargetArtifact()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated positive integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  const parsed = readNonNegativeSafeInteger(value)
  if (parsed === 0) return failTargetArtifact()
  return parsed
}

/**
 * Reads one plain non-array record.
 *
 * @param value - Candidate record.
 * @returns Validated plain record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failTargetArtifact()
  return value
}

/**
 * Checks whether one value is a plain non-array record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is suitable for strict field validation.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires a record to contain exactly the listed enumerable data fields.
 *
 * @param record - Candidate strict record.
 * @param expected - Complete expected key list.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const ownKeys = Reflect.ownKeys(record)
  const actual: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') return failTargetArtifact()
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failTargetArtifact()
    }
    actual.push(key)
  }
  actual.sort(compareUtf8Ordinal)
  const sortedExpected = [...expected].sort(compareUtf8Ordinal)
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failTargetArtifact()
  }
}

/**
 * Returns the exact canonical UTF-8 byte length of one JSON-safe value.
 *
 * @param value - Strict JSON-safe canonicalizable value.
 * @returns Canonical UTF-8 byte length.
 */
function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(serializeCanonicalJson(value), 'utf8')
}

/**
 * Creates a lowercase SHA-256 digest of exact bytes.
 *
 * @param bytes - Exact stored canonical bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestExactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Compares strings by their UTF-8 byte representation.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive byte ordering.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Replaces every internal, codec, accessor, and parser failure with one stable
 * raw-value-free target artifact failure.
 *
 * @param operation - Artifact work that may encounter hostile values.
 * @returns Successful operation result.
 */
function runTargetArtifactBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    void error
    throw new WorkspaceSearchMigrationTargetArtifactError()
  }
}

/**
 * Raises a stable raw-value-free target artifact failure.
 *
 * @returns Never returns.
 */
function failTargetArtifact(): never {
  throw new WorkspaceSearchMigrationTargetArtifactError()
}

/** Exact strict fields of a complete planning target artifact page. */
const pageKeys = [
  'artifactVersion',
  'configurationHash',
  'items',
  'kind',
  'migrationId',
  'migrationVersion',
  'pageSequence',
  'planningAuthority',
  'previousCheckpointDigest',
  'previousEvidenceDigest',
  'purpose',
  'runId',
  'targetTable',
  'stateTable',
]

/** Exact strict fields of one planning target artifact segment. */
const segmentKeys = [
  'artifactVersion',
  'configurationHash',
  'itemCount',
  'itemStartIndex',
  'items',
  'kind',
  'migrationId',
  'migrationVersion',
  'pageItemCount',
  'pageSequence',
  'planningAuthority',
  'previousCheckpointDigest',
  'previousEvidenceDigest',
  'purpose',
  'runId',
  'segmentCount',
  'segmentIndex',
  'targetTable',
  'stateTable',
]

/** Exact strict fields of one physical table-incarnation binding. */
const tableIncarnationKeys = [
  'creationTime',
  'tableArn',
  'tableId',
  'tableName',
]

/** Exact strict fields of one planning authority binding. */
const planningAuthorityKeys = [
  'fenceToken',
  'maintenanceEvidencePointerRevision',
  'maintenanceEvidenceReceiptDigest',
  'ownerId',
]
