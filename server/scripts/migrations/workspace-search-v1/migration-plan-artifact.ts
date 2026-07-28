import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchPlannedOperation,
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlannedOperation,
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createEmptyWorkspaceSearchPlanDigest,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Schema version of the immutable migration-plan artifact bundle. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION = 1

/** Maximum canonical size of one complete-operation plan segment. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES =
  16 * 1024 * 1024

/** Maximum number of exact segment references stored in one manifest page. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES = 256

/** Maximum canonical size of one manifest page. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES =
  1024 * 1024

/** Maximum accepted planned-operation count. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS = 100_000

/**
 * Maximum combined canonical bytes retained by all plan segments.
 *
 * This separately bounds aggregate in-process planning material even when
 * every individual segment remains below its own 16 MiB ceiling.
 */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES =
  256 * 1024 * 1024

/** Maximum canonical size of the compact manifest head. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES =
  16 * 1024

/** Content-addressed namespace reserved for migration-plan artifacts. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX =
  'workspace-search/v1/plan-artifacts/v1'

/** Exact immutable object identity retained by the plan manifest. */
export type WorkspaceSearchMigrationPlanArtifactReference = {
  /** Deterministic content-addressed object key. */
  readonly objectKey: string
  /** Exact immutable S3 version identifier. */
  readonly versionId: string
  /** SHA-256 digest of the exact stored bytes. */
  readonly contentDigest: string
  /** Exact stored byte length. */
  readonly byteLength: number
  /** Canonical retention deadline applied to this object version. */
  readonly retainUntil: string
}

/** One complete-operation bounded plan segment. */
export type WorkspaceSearchMigrationPlanArtifactSegment = {
  /** Plan-segment discriminator. */
  readonly kind: 'workspace-search-migration-plan-segment'
  /** Plan artifact schema version. */
  readonly artifactVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the reviewed migration configuration. */
  readonly configurationHash: string
  /** Digest of the complete ordered operation plan. */
  readonly planDigest: string
  /** Digest of the exact canonical plan seal. */
  readonly planSealContentDigest: string
  /** Exact operation count across the complete plan. */
  readonly planOperationCount: number
  /** One-based position in the segment predecessor chain. */
  readonly segmentSequence: number
  /** One-based sequence of this segment's first complete operation. */
  readonly operationStartSequence: number
  /** Number of complete operations carried by this segment. */
  readonly segmentOperationCount: number
  /** Content digest of the previous segment, or null for the first. */
  readonly previousSegmentContentDigest: string | null
  /** Canonically encoded complete planned operations. */
  readonly operations: readonly Readonly<Record<string, unknown>>[]
}

/** Canonical stored material for one plan segment. */
export type WorkspaceSearchMigrationPlanArtifactEncodedSegment = {
  /** Detached parsed segment represented by the stored bytes. */
  readonly segment: WorkspaceSearchMigrationPlanArtifactSegment
  /** Exact canonical UTF-8 bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Deterministic content-addressed object key. */
  readonly objectKey: string
}

/** Exact segment binding stored in one bounded manifest page. */
export type WorkspaceSearchMigrationPlanManifestSegmentBinding = {
  /** One-based segment position. */
  readonly segmentSequence: number
  /** One-based first operation position. */
  readonly operationStartSequence: number
  /** Complete operation count in the segment. */
  readonly segmentOperationCount: number
  /** Exact immutable stored segment reference. */
  readonly reference: WorkspaceSearchMigrationPlanArtifactReference
}

/** One bounded page of exact immutable segment references. */
export type WorkspaceSearchMigrationPlanManifestPage = {
  /** Manifest-page discriminator. */
  readonly kind: 'workspace-search-migration-plan-manifest-page'
  /** Plan artifact schema version. */
  readonly artifactVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the reviewed migration configuration. */
  readonly configurationHash: string
  /** Digest of the complete ordered operation plan. */
  readonly planDigest: string
  /** Digest of the exact canonical plan seal. */
  readonly planSealContentDigest: string
  /** Exact operation count across the complete plan. */
  readonly planOperationCount: number
  /** Exact segment count across the complete plan. */
  readonly planSegmentCount: number
  /** One-based position in the manifest-page chain. */
  readonly pageSequence: number
  /** Exact preceding page reference, or null for the first page. */
  readonly previousPageReference:
    WorkspaceSearchMigrationPlanArtifactReference | null
  /** Ordered exact references covered by this page. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanManifestSegmentBinding[]
}

/** Canonical stored material for one manifest page. */
export type WorkspaceSearchMigrationPlanManifestEncodedPage = {
  /** Detached parsed page represented by the stored bytes. */
  readonly page: WorkspaceSearchMigrationPlanManifestPage
  /** Exact canonical UTF-8 bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Deterministic content-addressed object key. */
  readonly objectKey: string
}

/** Compact root that anchors both predecessor chains. */
export type WorkspaceSearchMigrationPlanManifestHead = {
  /** Manifest-head discriminator. */
  readonly kind: 'workspace-search-migration-plan-manifest-head'
  /** Plan artifact schema version. */
  readonly artifactVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Digest of the reviewed migration configuration. */
  readonly configurationHash: string
  /** Digest of the complete ordered operation plan. */
  readonly planDigest: string
  /** Digest of the exact canonical plan seal. */
  readonly planSealContentDigest: string
  /** Exact complete operation count. */
  readonly planOperationCount: number
  /** Exact complete segment count. */
  readonly planSegmentCount: number
  /** Exact complete manifest-page count. */
  readonly manifestPageCount: number
  /** Exact terminal segment reference, or null for an empty plan. */
  readonly terminalSegmentReference:
    WorkspaceSearchMigrationPlanArtifactReference | null
  /** Exact terminal manifest-page reference, or null for an empty plan. */
  readonly terminalManifestPageReference:
    WorkspaceSearchMigrationPlanArtifactReference | null
}

/** Canonical stored material for the compact manifest head. */
export type WorkspaceSearchMigrationPlanManifestEncodedHead = {
  /** Detached parsed head represented by the stored bytes. */
  readonly head: WorkspaceSearchMigrationPlanManifestHead
  /** Exact canonical UTF-8 bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Deterministic content-addressed object key. */
  readonly objectKey: string
}

/** Exact downloaded immutable artifact object used during replay. */
export type WorkspaceSearchMigrationPlanArtifactStoredObject = {
  /** Expected rich immutable object reference. */
  readonly reference: WorkspaceSearchMigrationPlanArtifactReference
  /** Exact downloaded object bytes. */
  readonly bytes: Uint8Array
}

/** Stable raw-value-free failure for invalid plan artifacts. */
export class WorkspaceSearchMigrationPlanArtifactError extends Error {
  /** Secret-free machine-readable failure code. */
  readonly code = 'INVALID_PLAN_ARTIFACT'

  /** Creates a stable artifact failure. */
  constructor() {
    super('INVALID_PLAN_ARTIFACT')
    this.name = 'WorkspaceSearchMigrationPlanArtifactError'
  }
}

/**
 * Deterministically partitions a sealed plan at complete operation boundaries.
 *
 * @param planSeal - Reviewed immutable plan seal.
 * @param operations - Complete ordered planned operations.
 * @param maximumTotalSegmentBytes - Optional smaller aggregate segment-byte
 * ceiling that may only reject an otherwise valid plan.
 * @returns Ordered content-addressed canonical segments.
 */
export function serializeWorkspaceSearchMigrationPlanArtifactSegments(
  planSeal: WorkspaceSearchPlanSeal,
  operations: readonly WorkspaceSearchPlannedOperation[],
  maximumTotalSegmentBytes =
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
): readonly WorkspaceSearchMigrationPlanArtifactEncodedSegment[] {
  return runPlanArtifactBoundary(() => {
    const seal = validatePlanSeal(planSeal)
    const totalSegmentByteCeiling = readBoundedPositiveInteger(
      maximumTotalSegmentBytes,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
    )
    const operationCandidates = readDenseArray(
      operations,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    )
    if (
      operationCandidates.length !== seal.planOperationCount
    ) {
      return failPlanArtifact()
    }
    if (operationCandidates.length === 0) return []

    const planSealContentDigest = digestExactBytes(
      serializeWorkspaceSearchPlanSeal(seal),
    )
    let totalOperationBytes = 0
    const encodedOperations = operationCandidates.map((candidate, index) => {
      const operation = readPlannedOperationCandidate(candidate)
      const bytes = serializeWorkspaceSearchPlannedOperation(operation)
      totalOperationBytes = addBoundedPlanArtifactBytes(
        totalOperationBytes,
        bytes.byteLength,
        totalSegmentByteCeiling,
      )
      const parsed = parseWorkspaceSearchPlannedOperation(bytes)
      if (
        parsed.runId !== seal.runId ||
        parsed.configurationHash !== seal.configurationHash ||
        parsed.planDigest !== seal.planDigest ||
        parsed.planSequence !== index + 1
      ) {
        return failPlanArtifact()
      }
      return {
        value: parseCanonicalOperationValue(bytes),
        byteLength: bytes.byteLength,
      }
    })

    const segments:
      WorkspaceSearchMigrationPlanArtifactEncodedSegment[] = []
    let totalSegmentBytes = 0
    let operationIndex = 0
    let previousSegmentContentDigest: string | null = null
    while (operationIndex < encodedOperations.length) {
      const segmentSequence = segments.length + 1
      const operationStartSequence = operationIndex + 1
      const values: Readonly<Record<string, unknown>>[] = []
      let operationBytes = 0
      while (operationIndex < encodedOperations.length) {
        const candidate = encodedOperations[operationIndex]
        if (candidate === undefined) return failPlanArtifact()
        const candidateCount = values.length + 1
        const candidateBase = createSegment({
          seal,
          planSealContentDigest,
          segmentSequence,
          operationStartSequence,
          previousSegmentContentDigest,
          operations: [],
          segmentOperationCount: candidateCount,
        })
        const candidateByteLength =
          canonicalByteLength(candidateBase) +
          operationBytes +
          candidate.byteLength +
          values.length
        if (
          candidateByteLength >
          WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES
        ) {
          if (values.length === 0) return failPlanArtifact()
          break
        }
        values.push(candidate.value)
        operationBytes += candidate.byteLength
        operationIndex += 1
      }
      const segment = createSegment({
        seal,
        planSealContentDigest,
        segmentSequence,
        operationStartSequence,
        previousSegmentContentDigest,
        operations: values,
        segmentOperationCount: values.length,
      })
      const encoded = encodeSegment(segment)
      totalSegmentBytes = addBoundedPlanArtifactBytes(
        totalSegmentBytes,
        encoded.byteLength,
        totalSegmentByteCeiling,
      )
      segments.push(encoded)
      previousSegmentContentDigest = encoded.contentDigest
    }
    return segments
  })
}

/**
 * Parses one exact canonical complete-operation plan segment.
 *
 * @param bytes - Untrusted canonical segment bytes.
 * @returns Detached validated plan segment.
 */
export function parseWorkspaceSearchMigrationPlanArtifactSegment(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanArtifactSegment {
  return runPlanArtifactBoundary(() => parseSegmentUnchecked(bytes))
}

/**
 * Creates one detached strict rich reference for stored artifact bytes.
 *
 * @param value - Candidate exact reference.
 * @returns Detached validated reference.
 */
export function validateWorkspaceSearchMigrationPlanArtifactReference(
  value: WorkspaceSearchMigrationPlanArtifactReference,
): WorkspaceSearchMigrationPlanArtifactReference {
  return runPlanArtifactBoundary(() => readReference(value))
}

/** Inputs required to construct one segment. */
type CreateSegmentInput = {
  /** Validated plan seal. */
  readonly seal: WorkspaceSearchPlanSeal
  /** Digest of the exact plan seal bytes. */
  readonly planSealContentDigest: string
  /** One-based segment sequence. */
  readonly segmentSequence: number
  /** One-based first operation sequence. */
  readonly operationStartSequence: number
  /** Previous segment digest. */
  readonly previousSegmentContentDigest: string | null
  /** Exact encoded operations. */
  readonly operations: readonly Readonly<Record<string, unknown>>[]
  /** Exact operation count represented by the segment. */
  readonly segmentOperationCount: number
}

/**
 * Constructs one canonical segment value.
 *
 * @param input - Validated segment components.
 * @returns Complete segment.
 */
function createSegment(
  input: CreateSegmentInput,
): WorkspaceSearchMigrationPlanArtifactSegment {
  return {
    kind: 'workspace-search-migration-plan-segment',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.seal.runId,
    configurationHash: input.seal.configurationHash,
    planDigest: input.seal.planDigest,
    planSealContentDigest: input.planSealContentDigest,
    planOperationCount: input.seal.planOperationCount,
    segmentSequence: input.segmentSequence,
    operationStartSequence: input.operationStartSequence,
    segmentOperationCount: input.segmentOperationCount,
    previousSegmentContentDigest: input.previousSegmentContentDigest,
    operations: input.operations,
  }
}

/**
 * Encodes one locally validated segment.
 *
 * @param segment - Complete segment value.
 * @returns Canonical content-addressed material.
 */
function encodeSegment(
  segment: WorkspaceSearchMigrationPlanArtifactSegment,
): WorkspaceSearchMigrationPlanArtifactEncodedSegment {
  const bytes = encodeCanonicalValue(
    segment,
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
  )
  const contentDigest = digestExactBytes(bytes)
  return {
    segment,
    bytes,
    contentDigest,
    byteLength: bytes.byteLength,
    objectKey: createObjectKey('segments', contentDigest),
  }
}

/**
 * Parses one segment without replacing its failure boundary.
 *
 * @param bytes - Candidate exact bytes.
 * @returns Detached strict segment.
 */
function parseSegmentUnchecked(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanArtifactSegment {
  const snapshot = copyBoundedBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
  )
  const record = requireRecord(parseJson(snapshot))
  requireExactKeys(record, segmentKeys)
  if (
    record.kind !== 'workspace-search-migration-plan-segment' ||
    record.artifactVersion !==
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPlanArtifact()
  }
  const encodedOperations = readDenseArray(
    record.operations,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
  )
  const operations = encodedOperations.map((value) => {
    const operationRecord = requireRecord(value)
    const operationBytes = encodeCanonicalValue(
      operationRecord,
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
    )
    const parsed = parseWorkspaceSearchPlannedOperation(operationBytes)
    return {
      encoded: parseCanonicalOperationValue(
        serializeWorkspaceSearchPlannedOperation(parsed),
      ),
      parsed,
    }
  })
  const segment: WorkspaceSearchMigrationPlanArtifactSegment = {
    kind: 'workspace-search-migration-plan-segment',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(record.runId),
    configurationHash: readDigest(record.configurationHash),
    planDigest: readDigest(record.planDigest),
    planSealContentDigest: readDigest(record.planSealContentDigest),
    planOperationCount: readBoundedCount(
      record.planOperationCount,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ),
    segmentSequence: readPositiveInteger(record.segmentSequence),
    operationStartSequence:
      readPositiveInteger(record.operationStartSequence),
    segmentOperationCount:
      readPositiveInteger(record.segmentOperationCount),
    previousSegmentContentDigest:
      readNullableDigest(record.previousSegmentContentDigest),
    operations: operations.map(({ encoded }) => encoded),
  }
  if (
    segment.segmentOperationCount !== operations.length ||
    segment.operationStartSequence +
        segment.segmentOperationCount - 1 >
      segment.planOperationCount ||
    (segment.segmentSequence === 1) !==
      (segment.previousSegmentContentDigest === null) ||
    operations.some(
      ({ parsed }, index) =>
        parsed.runId !== segment.runId ||
        parsed.configurationHash !== segment.configurationHash ||
        parsed.planDigest !== segment.planDigest ||
        parsed.planSequence !==
          segment.operationStartSequence + index,
    )
  ) {
    return failPlanArtifact()
  }
  requireCanonicalBytes(snapshot, segment)
  return segment
}

/** Input for constructing one bounded manifest page. */
export type WorkspaceSearchMigrationPlanManifestPageInput = {
  /** Reviewed immutable plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact segment count across the complete plan. */
  readonly planSegmentCount: number
  /** One-based page sequence. */
  readonly pageSequence: number
  /** Exact preceding stored page, or null for the first page. */
  readonly previousPage:
    WorkspaceSearchMigrationPlanArtifactStoredObject | null
  /** Ordered stored segments assigned to this page. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
}

/**
 * Creates one bounded page of exact immutable segment references.
 *
 * @param input - Exact page position, predecessor, and stored segment objects.
 * @returns Canonical content-addressed manifest page.
 */
export function serializeWorkspaceSearchMigrationPlanManifestPage(
  input: WorkspaceSearchMigrationPlanManifestPageInput,
): WorkspaceSearchMigrationPlanManifestEncodedPage {
  return runPlanArtifactBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, manifestPageInputKeys)
    const seal = validatePlanSeal(readOwn(inputRecord, 'planSeal'))
    const planSegmentCount = readBoundedCount(
      readOwn(inputRecord, 'planSegmentCount'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    )
    const pageSequence = readPositiveInteger(
      readOwn(inputRecord, 'pageSequence'),
    )
    const storedSegments = readDenseArray(
      readOwn(inputRecord, 'segments'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
    )
    const previousPageCandidate = readOwn(
      inputRecord,
      'previousPage',
    )
    const previousStoredPage =
      previousPageCandidate === null
        ? null
        : readStoredObject(previousPageCandidate, 'manifest-pages')
    const previousPage =
      previousStoredPage === null
        ? null
        : parsePageUnchecked(previousStoredPage.bytes)
    const previousPageReference =
      previousStoredPage?.reference ?? null
    const expectedPageCount = Math.ceil(
      planSegmentCount /
        WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
    )
    if (
      seal.planOperationCount === 0 ||
      planSegmentCount === 0 ||
      pageSequence > expectedPageCount ||
      storedSegments.length === 0 ||
      (pageSequence < expectedPageCount &&
        storedSegments.length !==
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES) ||
      (pageSequence === 1) !== (previousPageReference === null)
    ) {
      return failPlanArtifact()
    }
    const expectedSegmentStart =
      (pageSequence - 1) *
        WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES +
      1
    if (
      expectedSegmentStart + storedSegments.length - 1 >
      planSegmentCount
    ) {
      return failPlanArtifact()
    }
    const planSealContentDigest = digestExactBytes(
      serializeWorkspaceSearchPlanSeal(seal),
    )
    const previousTerminalBinding =
      previousPage?.segments.at(-1)
    if (
      previousPage !== null &&
      (
        previousPage.pageSequence !== pageSequence - 1 ||
        previousPage.runId !== seal.runId ||
        previousPage.configurationHash !== seal.configurationHash ||
        previousPage.planDigest !== seal.planDigest ||
        previousPage.planSealContentDigest !==
          planSealContentDigest ||
        previousPage.planOperationCount !== seal.planOperationCount ||
        previousPage.planSegmentCount !== planSegmentCount ||
        previousTerminalBinding === undefined ||
        previousTerminalBinding.segmentSequence !==
          expectedSegmentStart - 1
      )
    ) {
      return failPlanArtifact()
    }
    const bindings =
      storedSegments.map((candidate, index) => {
        const stored = readStoredObject(candidate, 'segments')
        const segment = parseSegmentUnchecked(stored.bytes)
        const previousSegmentReference =
          index === 0
            ? previousTerminalBinding?.reference ?? null
            : readStoredObject(
                storedSegments[index - 1],
                'segments',
              ).reference
        if (
          segment.runId !== seal.runId ||
          segment.configurationHash !== seal.configurationHash ||
          segment.planDigest !== seal.planDigest ||
          segment.planSealContentDigest !== planSealContentDigest ||
          segment.planOperationCount !== seal.planOperationCount ||
          segment.segmentSequence !== expectedSegmentStart + index ||
          segment.previousSegmentContentDigest !==
            (previousSegmentReference?.contentDigest ?? null)
        ) {
          return failPlanArtifact()
        }
        return {
          segmentSequence: segment.segmentSequence,
          operationStartSequence: segment.operationStartSequence,
          segmentOperationCount: segment.segmentOperationCount,
          reference: stored.reference,
        }
      })
    const page: WorkspaceSearchMigrationPlanManifestPage = {
      kind: 'workspace-search-migration-plan-manifest-page',
      artifactVersion:
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: seal.runId,
      configurationHash: seal.configurationHash,
      planDigest: seal.planDigest,
      planSealContentDigest,
      planOperationCount: seal.planOperationCount,
      planSegmentCount,
      pageSequence,
      previousPageReference,
      segments: bindings,
    }
    return encodePage(page)
  })
}

/**
 * Parses one exact canonical bounded manifest page.
 *
 * @param bytes - Untrusted manifest-page bytes.
 * @returns Detached strict page.
 */
export function parseWorkspaceSearchMigrationPlanManifestPage(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanManifestPage {
  return runPlanArtifactBoundary(() => parsePageUnchecked(bytes))
}

/** Input for constructing the compact manifest head. */
export type WorkspaceSearchMigrationPlanManifestHeadInput = {
  /** Reviewed immutable plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Ordered complete stored manifest-page chain. */
  readonly manifestPages:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
  /** Ordered complete stored plan-segment chain. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
}

/**
 * Creates the compact root anchoring a complete staged plan artifact.
 *
 * @param input - Seal and the complete staged page and segment graph.
 * @returns Canonical content-addressed manifest head.
 */
export function serializeWorkspaceSearchMigrationPlanManifestHead(
  input: WorkspaceSearchMigrationPlanManifestHeadInput,
): WorkspaceSearchMigrationPlanManifestEncodedHead {
  return runPlanArtifactBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, manifestHeadInputKeys)
    const seal = validatePlanSeal(readOwn(inputRecord, 'planSeal'))
    const storedSegments = readDenseArray(
      readOwn(inputRecord, 'segments'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ).map((candidate) => readStoredObject(candidate, 'segments'))
    const storedPages = readDenseArray(
      readOwn(inputRecord, 'manifestPages'),
      Math.ceil(
        WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS /
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
      ),
    ).map((candidate) =>
      readStoredObject(candidate, 'manifest-pages')
    )
    const planSegmentCount = storedSegments.length
    const manifestPageCount = storedPages.length
    const terminalSegmentReference =
      storedSegments.at(-1)?.reference ?? null
    const terminalManifestPageReference =
      storedPages.at(-1)?.reference ?? null
    const empty = seal.planOperationCount === 0
    if (
      empty !== (planSegmentCount === 0) ||
      empty !== (manifestPageCount === 0) ||
      empty !== (terminalSegmentReference === null) ||
      empty !== (terminalManifestPageReference === null) ||
      manifestPageCount !==
        Math.ceil(
          planSegmentCount /
            WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
        )
    ) {
      return failPlanArtifact()
    }
    const head: WorkspaceSearchMigrationPlanManifestHead = {
      kind: 'workspace-search-migration-plan-manifest-head',
      artifactVersion:
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: seal.runId,
      configurationHash: seal.configurationHash,
      planDigest: seal.planDigest,
      planSealContentDigest: digestExactBytes(
        serializeWorkspaceSearchPlanSeal(seal),
      ),
      planOperationCount: seal.planOperationCount,
      planSegmentCount,
      manifestPageCount,
      terminalSegmentReference,
      terminalManifestPageReference,
    }
    const encodedHead = encodeHead(head)
    replayUnchecked({
      planSeal: seal,
      manifestHeadBytes: encodedHead.bytes,
      manifestPages: storedPages,
      segments: storedSegments,
    })
    return encodedHead
  })
}

/**
 * Parses one exact canonical compact manifest head.
 *
 * @param bytes - Untrusted head bytes.
 * @returns Detached strict head.
 */
export function parseWorkspaceSearchMigrationPlanManifestHead(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanManifestHead {
  return runPlanArtifactBoundary(() => parseHeadUnchecked(bytes))
}

/**
 * Encodes one validated manifest page.
 *
 * @param page - Complete strict page.
 * @returns Canonical content-addressed page material.
 */
function encodePage(
  page: WorkspaceSearchMigrationPlanManifestPage,
): WorkspaceSearchMigrationPlanManifestEncodedPage {
  const bytes = encodeCanonicalValue(
    page,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  )
  const contentDigest = digestExactBytes(bytes)
  return {
    page,
    bytes,
    contentDigest,
    byteLength: bytes.byteLength,
    objectKey: createObjectKey('manifest-pages', contentDigest),
  }
}

/**
 * Encodes one validated compact head.
 *
 * @param head - Complete strict head.
 * @returns Canonical content-addressed head material.
 */
function encodeHead(
  head: WorkspaceSearchMigrationPlanManifestHead,
): WorkspaceSearchMigrationPlanManifestEncodedHead {
  const bytes = encodeCanonicalValue(
    head,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  )
  const contentDigest = digestExactBytes(bytes)
  return {
    head,
    bytes,
    contentDigest,
    byteLength: bytes.byteLength,
    objectKey: createObjectKey('manifest-heads', contentDigest),
  }
}

/**
 * Parses one manifest page without replacing its failure boundary.
 *
 * @param bytes - Candidate exact bytes.
 * @returns Detached strict page.
 */
function parsePageUnchecked(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanManifestPage {
  const snapshot = copyBoundedBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  )
  const record = requireRecord(parseJson(snapshot))
  requireExactKeys(record, manifestPageKeys)
  if (
    record.kind !== 'workspace-search-migration-plan-manifest-page' ||
    record.artifactVersion !==
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPlanArtifact()
  }
  const pageSequence = readPositiveInteger(record.pageSequence)
  const planSegmentCount = readPositiveInteger(record.planSegmentCount)
  if (planSegmentCount > WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS) {
    return failPlanArtifact()
  }
  const candidates = readDenseArray(
    record.segments,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
  )
  const expectedPageCount = Math.ceil(
    planSegmentCount /
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
  )
  const expectedStart =
    (pageSequence - 1) *
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES +
    1
  if (
    pageSequence > expectedPageCount ||
    candidates.length === 0 ||
    (pageSequence < expectedPageCount &&
      candidates.length !==
        WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES) ||
    expectedStart + candidates.length - 1 > planSegmentCount
  ) {
    return failPlanArtifact()
  }
  const segments = candidates.map((candidate, index) => {
    const binding = requireRecord(candidate)
    requireExactKeys(binding, manifestBindingKeys)
    const segmentSequence = readPositiveInteger(binding.segmentSequence)
    if (segmentSequence !== expectedStart + index) {
      return failPlanArtifact()
    }
    return {
      segmentSequence,
      operationStartSequence:
        readPositiveInteger(binding.operationStartSequence),
      segmentOperationCount:
        readPositiveInteger(binding.segmentOperationCount),
      reference: readReference(binding.reference),
    }
  })
  const page: WorkspaceSearchMigrationPlanManifestPage = {
    kind: 'workspace-search-migration-plan-manifest-page',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(record.runId),
    configurationHash: readDigest(record.configurationHash),
    planDigest: readDigest(record.planDigest),
    planSealContentDigest: readDigest(record.planSealContentDigest),
    planOperationCount: readBoundedCount(
      record.planOperationCount,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ),
    planSegmentCount,
    pageSequence,
    previousPageReference:
      record.previousPageReference === null
        ? null
        : readReference(record.previousPageReference),
    segments,
  }
  if (
    (page.pageSequence === 1) !==
      (page.previousPageReference === null)
  ) {
    return failPlanArtifact()
  }
  requireCanonicalBytes(snapshot, page)
  return page
}

/**
 * Parses one compact head without replacing its failure boundary.
 *
 * @param bytes - Candidate exact bytes.
 * @returns Detached strict head.
 */
function parseHeadUnchecked(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanManifestHead {
  const snapshot = copyBoundedBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  )
  const record = requireRecord(parseJson(snapshot))
  requireExactKeys(record, manifestHeadKeys)
  if (
    record.kind !== 'workspace-search-migration-plan-manifest-head' ||
    record.artifactVersion !==
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPlanArtifact()
  }
  const planOperationCount = readBoundedCount(
    record.planOperationCount,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
  )
  const planSegmentCount = readBoundedCount(
    record.planSegmentCount,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
  )
  const manifestPageCount = readBoundedCount(
    record.manifestPageCount,
    Math.ceil(
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS /
        WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
    ),
  )
  const head: WorkspaceSearchMigrationPlanManifestHead = {
    kind: 'workspace-search-migration-plan-manifest-head',
    artifactVersion: WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(record.runId),
    configurationHash: readDigest(record.configurationHash),
    planDigest: readDigest(record.planDigest),
    planSealContentDigest: readDigest(record.planSealContentDigest),
    planOperationCount,
    planSegmentCount,
    manifestPageCount,
    terminalSegmentReference:
      record.terminalSegmentReference === null
        ? null
        : readReference(record.terminalSegmentReference),
    terminalManifestPageReference:
      record.terminalManifestPageReference === null
        ? null
        : readReference(record.terminalManifestPageReference),
  }
  const empty = planOperationCount === 0
  if (
    empty !== (planSegmentCount === 0) ||
    empty !== (manifestPageCount === 0) ||
    empty !== (head.terminalSegmentReference === null) ||
    empty !== (head.terminalManifestPageReference === null) ||
    manifestPageCount !==
      Math.ceil(
        planSegmentCount /
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
      ) ||
    empty !== (head.planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failPlanArtifact()
  }
  requireCanonicalBytes(snapshot, head)
  return head
}

/** Input material required to replay one complete stored plan. */
export type WorkspaceSearchMigrationPlanArtifactReplayInput = {
  /** Reviewed immutable plan seal expected by the bundle. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact canonical compact manifest-head bytes. */
  readonly manifestHeadBytes: Uint8Array
  /** Ordered exact stored manifest pages. */
  readonly manifestPages:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
  /** Ordered exact stored plan segments. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
}

/** Successful detached replay result. */
export type WorkspaceSearchMigrationPlanArtifactReplayResult = {
  /** Detached validated plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Detached validated compact manifest head. */
  readonly manifestHead: WorkspaceSearchMigrationPlanManifestHead
  /** Complete detached ordered planned operations. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
}

/**
 * Replays and verifies a complete immutable plan artifact graph.
 *
 * @param input - Seal, compact head, and exact ordered stored objects.
 * @param maximumTotalSegmentBytes - Optional smaller aggregate segment-byte
 * ceiling that may only reject an otherwise valid replay.
 * @returns Detached complete ordered planned operations.
 */
export function replayWorkspaceSearchMigrationPlanArtifact(
  input: WorkspaceSearchMigrationPlanArtifactReplayInput,
  maximumTotalSegmentBytes =
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
): WorkspaceSearchMigrationPlanArtifactReplayResult {
  return runPlanArtifactBoundary(() =>
    replayUnchecked(input, maximumTotalSegmentBytes)
  )
}

/**
 * Replays a complete bundle without replacing its failure boundary.
 *
 * @param input - Candidate complete replay graph.
 * @param maximumTotalSegmentBytes - Aggregate segment-byte ceiling.
 * @returns Detached validated result.
 */
function replayUnchecked(
  input: WorkspaceSearchMigrationPlanArtifactReplayInput,
  maximumTotalSegmentBytes =
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
): WorkspaceSearchMigrationPlanArtifactReplayResult {
  const totalSegmentByteCeiling = readBoundedPositiveInteger(
    maximumTotalSegmentBytes,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
  )
  const inputRecord = requireRecord(input)
  requireExactKeys(inputRecord, replayInputKeys)
  const seal = validatePlanSeal(readOwn(inputRecord, 'planSeal'))
  const head = parseHeadUnchecked(
    copyBoundedBytes(
      readOwn(inputRecord, 'manifestHeadBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
    ),
  )
  const sealDigest = digestExactBytes(serializeWorkspaceSearchPlanSeal(seal))
  if (
    head.runId !== seal.runId ||
    head.configurationHash !== seal.configurationHash ||
    head.planDigest !== seal.planDigest ||
    head.planSealContentDigest !== sealDigest ||
    head.planOperationCount !== seal.planOperationCount
  ) {
    return failPlanArtifact()
  }
  const pageCandidates = readDenseArray(
    readOwn(inputRecord, 'manifestPages'),
    Math.ceil(
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS /
        WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
    ),
  )
  const segmentCandidates = readDenseArray(
    readOwn(inputRecord, 'segments'),
    WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
  )
  if (
    pageCandidates.length !== head.manifestPageCount ||
    segmentCandidates.length !== head.planSegmentCount
  ) {
    return failPlanArtifact()
  }

  const bindings:
    WorkspaceSearchMigrationPlanManifestSegmentBinding[] = []
  let previousPageReference:
    WorkspaceSearchMigrationPlanArtifactReference | null = null
  for (let index = 0; index < pageCandidates.length; index += 1) {
    const stored = readStoredObject(pageCandidates[index], 'manifest-pages')
    const page = parsePageUnchecked(stored.bytes)
    if (
      page.pageSequence !== index + 1 ||
      page.runId !== head.runId ||
      page.configurationHash !== head.configurationHash ||
      page.planDigest !== head.planDigest ||
      page.planSealContentDigest !== head.planSealContentDigest ||
      page.planOperationCount !== head.planOperationCount ||
      page.planSegmentCount !== head.planSegmentCount ||
      !referencesEqual(page.previousPageReference, previousPageReference)
    ) {
      return failPlanArtifact()
    }
    bindings.push(...page.segments)
    previousPageReference = stored.reference
  }
  if (
    bindings.length !== head.planSegmentCount ||
    !referencesEqual(
      previousPageReference,
      head.terminalManifestPageReference,
    )
  ) {
    return failPlanArtifact()
  }

  let totalSegmentBytes = 0
  for (const binding of bindings) {
    totalSegmentBytes = addBoundedPlanArtifactBytes(
      totalSegmentBytes,
      binding.reference.byteLength,
      totalSegmentByteCeiling,
    )
  }

  const operations: WorkspaceSearchPlannedOperation[] = []
  let previousSegmentReference:
    WorkspaceSearchMigrationPlanArtifactReference | null = null
  for (let index = 0; index < segmentCandidates.length; index += 1) {
    const stored = readStoredObject(segmentCandidates[index], 'segments')
    const binding = bindings[index]
    if (
      binding === undefined ||
      !referencesEqual(stored.reference, binding.reference)
    ) {
      return failPlanArtifact()
    }
    const segment = parseSegmentUnchecked(stored.bytes)
    if (
      segment.segmentSequence !== index + 1 ||
      segment.segmentSequence !== binding.segmentSequence ||
      segment.operationStartSequence !== operations.length + 1 ||
      segment.operationStartSequence !== binding.operationStartSequence ||
      segment.segmentOperationCount !== binding.segmentOperationCount ||
      segment.runId !== head.runId ||
      segment.configurationHash !== head.configurationHash ||
      segment.planDigest !== head.planDigest ||
      segment.planSealContentDigest !== head.planSealContentDigest ||
      segment.planOperationCount !== head.planOperationCount ||
      segment.previousSegmentContentDigest !==
        (previousSegmentReference === null
          ? null
          : previousSegmentReference.contentDigest)
    ) {
      return failPlanArtifact()
    }
    for (const encoded of segment.operations) {
      const bytes = encodeCanonicalValue(
        encoded,
        WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
      )
      operations.push(parseWorkspaceSearchPlannedOperation(bytes))
    }
    previousSegmentReference = stored.reference
  }
  if (
    operations.length !== head.planOperationCount ||
    !referencesEqual(
      previousSegmentReference,
      head.terminalSegmentReference,
    )
  ) {
    return failPlanArtifact()
  }

  const canonicalSegments =
    serializeWorkspaceSearchMigrationPlanArtifactSegments(seal, operations)
  if (canonicalSegments.length !== segmentCandidates.length) {
    return failPlanArtifact()
  }
  for (let index = 0; index < canonicalSegments.length; index += 1) {
    const canonical = canonicalSegments[index]
    const stored = readStoredObject(segmentCandidates[index], 'segments')
    if (
      canonical === undefined ||
      !Buffer.from(canonical.bytes).equals(Buffer.from(stored.bytes))
    ) {
      return failPlanArtifact()
    }
  }
  return { planSeal: seal, manifestHead: head, operations }
}

/** Supported content-addressed plan artifact object namespaces. */
type PlanArtifactObjectRole =
  | 'segments'
  | 'manifest-pages'
  | 'manifest-heads'

/**
 * Round-trips a plan seal through the existing strict seal codec.
 *
 * @param value - Candidate reviewed seal.
 * @returns Detached validated seal.
 */
function validatePlanSeal(
  value: unknown,
): WorkspaceSearchPlanSeal {
  const record = requireRecord(value)
  requireExactKeys(record, planSealKeys)
  if (
    readOwn(record, 'kind') !== 'workspace-search-plan-seal' ||
    readOwn(record, 'sealVersion') !== 2 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPlanArtifact()
  }
  const candidate: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    dryRunEvidenceDigest: readDigest(
      readOwn(record, 'dryRunEvidenceDigest'),
    ),
    planningSnapshotDigest: readDigest(
      readOwn(record, 'planningSnapshotDigest'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount: readBoundedCount(
      readOwn(record, 'planOperationCount'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ),
    sourceOperationCount: readBoundedCount(
      readOwn(record, 'sourceOperationCount'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ),
    orphanOperationCount: readBoundedCount(
      readOwn(record, 'orphanOperationCount'),
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
    ),
    createdAt: readTimestamp(readOwn(record, 'createdAt')),
  }
  const seal = parseWorkspaceSearchPlanSeal(
    serializeWorkspaceSearchPlanSeal(candidate),
  )
  return seal
}

/**
 * Validates a planned-operation graph before invoking the existing codec.
 *
 * @param value - Candidate caller-owned operation.
 * @returns Safe typed candidate for the strict operation codec.
 */
function readPlannedOperationCandidate(
  value: unknown,
): WorkspaceSearchPlannedOperation {
  validateSafeOperationGraph(value)
  const record = requireRecord(value)
  requireExactKeys(record, plannedOperationKeys)
  if (!isPlannedOperationCandidate(value)) return failPlanArtifact()
  return value
}

/**
 * Narrows a safely traversed operation to its top-level typed shape.
 *
 * Deeper semantic validation remains owned by the existing operation codec.
 *
 * @param value - Safely traversed candidate.
 * @returns Whether required top-level value categories are present.
 */
function isPlannedOperationCandidate(
  value: unknown,
): value is WorkspaceSearchPlannedOperation {
  if (!isRecord(value)) return false
  return (
    typeof readOwn(value, 'runId') === 'string' &&
    typeof readOwn(value, 'configurationHash') === 'string' &&
    typeof readOwn(value, 'planDigest') === 'string' &&
    typeof readOwn(value, 'planSequence') === 'number' &&
    typeof readOwn(value, 'operationDigest') === 'string' &&
    Array.isArray(readOwn(value, 'membershipProof')) &&
    isRecord(readOwn(value, 'operation'))
  )
}

/** Mutable traversal budget for one caller-owned planned operation. */
type SafeOperationGraphBudget = {
  /** Number of traversed objects and primitive leaves. */
  nodes: number
  /** Conservative projected string, key, and binary bytes. */
  bytes: number
  /** Object identities already traversed and skipped for cycle-safe traversal. */
  readonly seen: WeakSet<object>
}

/**
 * Rejects Proxy, accessor, sparse, shared-memory, cyclic, or oversized graphs.
 *
 * @param value - Candidate complete operation.
 */
function validateSafeOperationGraph(value: unknown): void {
  visitSafeOperationGraph(
    value,
    { nodes: 0, bytes: 0, seen: new WeakSet<object>() },
    0,
  )
}

/**
 * Traverses one safe operation graph node under finite resource ceilings.
 *
 * @param value - Candidate graph node.
 * @param budget - Shared traversal budget.
 * @param depth - Current graph depth.
 */
function visitSafeOperationGraph(
  value: unknown,
  budget: SafeOperationGraphBudget,
  depth: number,
): void {
  budget.nodes += 1
  if (budget.nodes > 200_000 || depth > 128) return failPlanArtifact()
  if (
    value === null ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failPlanArtifact()
    return
  }
  if (typeof value === 'string') {
    if (!hasOnlyPairedSurrogates(value)) return failPlanArtifact()
    addSafeOperationBytes(budget, Buffer.byteLength(value, 'utf8'))
    return
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    return failPlanArtifact()
  }
  if (budget.seen.has(value)) return
  budget.seen.add(value)
  if (nodeUtilTypes.isUint8Array(value)) {
    const buffer = readIntrinsicUint8ArrayBuffer(value)
    if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
      return failPlanArtifact()
    }
    addSafeOperationBytes(
      budget,
      readIntrinsicUint8ArrayByteLength(value),
    )
    return
  }
  if (Array.isArray(value)) {
    const candidates = readDenseArray(value, 200_000)
    for (const candidate of candidates) {
      visitSafeOperationGraph(candidate, budget, depth + 1)
    }
    return
  }
  const record = requireRecord(value)
  const keys = Reflect.ownKeys(record)
  if (keys.length > 200_000) return failPlanArtifact()
  for (const key of keys) {
    if (typeof key !== 'string' || !hasOnlyPairedSurrogates(key)) {
      return failPlanArtifact()
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failPlanArtifact()
    }
    addSafeOperationBytes(budget, Buffer.byteLength(key, 'utf8'))
    visitSafeOperationGraph(descriptor.value, budget, depth + 1)
  }
}

/**
 * Adds conservative operation graph bytes under the segment ceiling.
 *
 * @param budget - Shared graph traversal budget.
 * @param additional - Additional projected bytes.
 */
function addSafeOperationBytes(
  budget: SafeOperationGraphBudget,
  additional: number,
): void {
  budget.bytes += additional
  if (
    !Number.isSafeInteger(budget.bytes) ||
    budget.bytes >
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES
  ) {
    return failPlanArtifact()
  }
}

/**
 * Parses an existing canonical operation encoding for segment embedding.
 *
 * @param bytes - Exact canonical operation bytes.
 * @returns JSON-safe operation record.
 */
function parseCanonicalOperationValue(
  bytes: Uint8Array,
): Readonly<Record<string, unknown>> {
  return requireRecord(parseJson(bytes))
}

/**
 * Reads and verifies one exact stored artifact object.
 *
 * @param value - Candidate stored object.
 * @param role - Expected content-addressed namespace.
 * @returns Detached exact stored object.
 */
function readStoredObject(
  value: unknown,
  role: PlanArtifactObjectRole,
): WorkspaceSearchMigrationPlanArtifactStoredObject {
  const record = requireRecord(value)
  requireExactKeys(record, ['bytes', 'reference'])
  const reference = readReference(record.reference)
  const maximumBytes =
    role === 'segments'
      ? WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES
      : role === 'manifest-pages'
        ? WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES
        : WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES
  const bytes = copyBoundedBytes(record.bytes, maximumBytes)
  if (
    reference.byteLength !== bytes.byteLength ||
    reference.contentDigest !== digestExactBytes(bytes) ||
    reference.objectKey !==
      createObjectKey(role, reference.contentDigest)
  ) {
    return failPlanArtifact()
  }
  return { reference, bytes }
}

/**
 * Reads one strict rich immutable reference.
 *
 * @param value - Candidate reference.
 * @returns Detached reference.
 */
function readReference(
  value: unknown,
): WorkspaceSearchMigrationPlanArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const objectKey = readBoundedText(record.objectKey, 1_024)
  if (
    !objectKey.startsWith(
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/`,
    )
  ) {
    return failPlanArtifact()
  }
  const retainUntil = record.retainUntil
  if (!isCanonicalTimestamp(retainUntil)) return failPlanArtifact()
  return {
    objectKey,
    versionId: readBoundedText(record.versionId, 1_024),
    contentDigest: readDigest(record.contentDigest),
    byteLength: readPositiveInteger(record.byteLength),
    retainUntil,
  }
}

/**
 * Compares two nullable rich references exactly.
 *
 * @param left - First candidate reference.
 * @param right - Second candidate reference.
 * @returns Whether all immutable reference fields match.
 */
function referencesEqual(
  left: WorkspaceSearchMigrationPlanArtifactReference | null,
  right: WorkspaceSearchMigrationPlanArtifactReference | null,
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.objectKey === right.objectKey &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.retainUntil === right.retainUntil
  )
}

/**
 * Creates a deterministic role-specific content-addressed object key.
 *
 * @param role - Artifact namespace.
 * @param contentDigest - Exact stored byte digest.
 * @returns Deterministic object key.
 */
function createObjectKey(
  role: PlanArtifactObjectRole,
  contentDigest: string,
): string {
  return `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/${role}/${contentDigest}.artifact`
}

/**
 * Encodes one JSON-safe value under an exact byte ceiling.
 *
 * @param value - Strict canonicalizable value.
 * @param maximumBytes - Accepted byte ceiling.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonicalValue(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    return failPlanArtifact()
  }
  return bytes
}

/**
 * Computes one canonical value's UTF-8 byte length.
 *
 * @param value - Strict canonicalizable value.
 * @returns Exact byte length.
 */
function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(serializeCanonicalJson(value), 'utf8')
}

/**
 * Computes a SHA-256 digest over exact stored bytes.
 *
 * @param bytes - Exact stored bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestExactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Copies one nonempty bounded byte input.
 *
 * @param value - Candidate bytes.
 * @param maximumBytes - Accepted byte ceiling.
 * @returns Detached byte snapshot.
 */
function copyBoundedBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failPlanArtifact()
  }
  const buffer = readIntrinsicUint8ArrayBuffer(value)
  const byteLength = readIntrinsicUint8ArrayByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > maximumBytes
  ) {
    return failPlanArtifact()
  }
  return new Uint8Array(value)
}

/**
 * Reads a Uint8Array backing buffer through the intrinsic getter.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Exact internal backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failPlanArtifact()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) return failPlanArtifact()
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failPlanArtifact()
  }
  return buffer
}

/**
 * Reads a Uint8Array byte length through the intrinsic getter.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Exact internal byte length.
 */
function readIntrinsicUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failPlanArtifact()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) return failPlanArtifact()
  const byteLength: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failPlanArtifact()
  }
  return byteLength
}

/**
 * Parses exact UTF-8 JSON bytes.
 *
 * @param bytes - Bounded exact bytes.
 * @returns Untrusted JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failPlanArtifact()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failPlanArtifact()
  }
}

/**
 * Requires exact canonical bytes for a reconstructed value.
 *
 * @param actual - Original exact bytes.
 * @param value - Reconstructed strict value.
 */
function requireCanonicalBytes(actual: Uint8Array, value: unknown): void {
  const expected = encodeCanonicalValue(
    value,
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
  )
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    return failPlanArtifact()
  }
}

/**
 * Reads a canonical dense array under a finite element bound.
 *
 * @param value - Candidate array.
 * @param maximumLength - Accepted element ceiling.
 * @returns Candidate array after strict shape validation.
 */
function readDenseArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] {
  if (
    nodeUtilTypes.isProxy(value) ||
    !hasCanonicalDenseArrayShape(value) ||
    value.length > maximumLength
  ) {
    return failPlanArtifact()
  }
  const values: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    )
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failPlanArtifact()
    }
    values.push(descriptor.value)
  }
  return values
}

/**
 * Reads one plain record.
 *
 * @param value - Candidate object.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failPlanArtifact()
  return value
}

/**
 * Checks whether one value is a plain record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is a plain string-keyed record.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires exactly the listed enumerable own keys.
 *
 * @param record - Candidate record.
 * @param expected - Complete accepted key set.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const ownKeys = Reflect.ownKeys(record)
  const actual: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') return failPlanArtifact()
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failPlanArtifact()
    }
    actual.push(key)
  }
  actual.sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failPlanArtifact()
  }
}

/**
 * Reads one required enumerable own data property.
 *
 * @param record - Strict non-Proxy record.
 * @param key - Required property name.
 * @returns Exact own data value.
 */
function readOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failPlanArtifact()
  }
  return descriptor.value
}

/**
 * Reads one strict migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failPlanArtifact()
  }
  return value
}

/**
 * Reads one bounded nonempty paired-surrogate string.
 *
 * @param value - Candidate text.
 * @param maximumLength - Accepted UTF-16 code-unit ceiling.
 * @returns Validated text.
 */
function readBoundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failPlanArtifact()
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
  if (!isHexDigest(value)) return failPlanArtifact()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failPlanArtifact()
  return value
}

/**
 * Reads one nullable conventional digest.
 *
 * @param value - Candidate nullable digest.
 * @returns Validated nullable digest.
 */
function readNullableDigest(value: unknown): string | null {
  return value === null ? null : readDigest(value)
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated positive integer.
 */
function readPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failPlanArtifact()
  }
  return value
}

/**
 * Reads one positive safe integer under an inclusive ceiling.
 *
 * @param value - Candidate positive integer.
 * @param maximum - Inclusive accepted ceiling.
 * @returns Validated bounded positive integer.
 */
function readBoundedPositiveInteger(
  value: unknown,
  maximum: number,
): number {
  const parsed = readPositiveInteger(value)
  if (parsed > maximum) return failPlanArtifact()
  return parsed
}

/**
 * Adds exact canonical bytes without exceeding one aggregate plan ceiling.
 *
 * @param current - Previously accumulated canonical bytes.
 * @param additional - Additional canonical bytes to retain.
 * @param maximum - Inclusive aggregate byte ceiling.
 * @returns Exact safe-integer byte total.
 */
function addBoundedPlanArtifactBytes(
  current: number,
  additional: number,
  maximum: number,
): number {
  const total = current + additional
  if (
    !Number.isSafeInteger(total) ||
    additional < 0 ||
    total > maximum
  ) {
    return failPlanArtifact()
  }
  return total
}

/**
 * Reads one nonnegative safe integer under an inclusive ceiling.
 *
 * @param value - Candidate count.
 * @param maximum - Inclusive accepted ceiling.
 * @returns Validated count.
 */
function readBoundedCount(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    return failPlanArtifact()
  }
  return value
}

/**
 * Replaces all internal failures with a stable raw-value-free boundary.
 *
 * @param operation - Plan artifact work.
 * @returns Successful operation result.
 */
function runPlanArtifactBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    void error
    throw new WorkspaceSearchMigrationPlanArtifactError()
  }
}

/**
 * Raises a stable plan artifact failure.
 *
 * @returns Never returns.
 */
function failPlanArtifact(): never {
  throw new WorkspaceSearchMigrationPlanArtifactError()
}

/** Exact strict fields of one plan segment. */
const segmentKeys = [
  'artifactVersion',
  'configurationHash',
  'kind',
  'migrationId',
  'migrationVersion',
  'operationStartSequence',
  'operations',
  'planDigest',
  'planOperationCount',
  'planSealContentDigest',
  'previousSegmentContentDigest',
  'runId',
  'segmentOperationCount',
  'segmentSequence',
]

/** Exact strict fields of one manifest binding. */
const manifestBindingKeys = [
  'operationStartSequence',
  'reference',
  'segmentOperationCount',
  'segmentSequence',
]

/** Exact strict fields of one manifest page. */
const manifestPageKeys = [
  'artifactVersion',
  'configurationHash',
  'kind',
  'migrationId',
  'migrationVersion',
  'pageSequence',
  'planDigest',
  'planOperationCount',
  'planSealContentDigest',
  'planSegmentCount',
  'previousPageReference',
  'runId',
  'segments',
]

/** Exact strict fields of the compact manifest head. */
const manifestHeadKeys = [
  'artifactVersion',
  'configurationHash',
  'kind',
  'manifestPageCount',
  'migrationId',
  'migrationVersion',
  'planDigest',
  'planOperationCount',
  'planSealContentDigest',
  'planSegmentCount',
  'runId',
  'terminalManifestPageReference',
  'terminalSegmentReference',
]

/** Exact public input fields for one manifest-page construction. */
const manifestPageInputKeys = [
  'pageSequence',
  'planSeal',
  'planSegmentCount',
  'previousPage',
  'segments',
]

/** Exact public input fields for compact-head construction. */
const manifestHeadInputKeys = [
  'manifestPages',
  'planSeal',
  'segments',
]

/** Exact public replay input fields. */
const replayInputKeys = [
  'manifestHeadBytes',
  'manifestPages',
  'planSeal',
  'segments',
]

/** Exact strict fields of the existing plan-seal contract. */
const planSealKeys = [
  'configurationHash',
  'createdAt',
  'dryRunEvidenceDigest',
  'kind',
  'migrationId',
  'migrationVersion',
  'orphanOperationCount',
  'planDigest',
  'planOperationCount',
  'planningSnapshotDigest',
  'runId',
  'sealVersion',
  'sourceOperationCount',
]

/** Exact top-level fields of one raw planned operation. */
const plannedOperationKeys = [
  'configurationHash',
  'membershipProof',
  'operation',
  'operationDigest',
  'planDigest',
  'planSequence',
  'runId',
]
