import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  createWorkspaceSearchMigrationScanSnapshotDigest,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationScanAggregate,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationScanSnapshot,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTableRole,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationPlanningAuthorityProvenance,
  WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
  WorkspaceSearchMigrationPlanningAuthorityTransition,
  WorkspaceSearchMigrationPlanningEvidenceChainRole,
  WorkspaceSearchMigrationPlanningEvidenceChainRoot,
} from './migration-planning-join'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
} from './migration-pre-plan-authority-aws'
import {
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
} from './migration-state-machine'
import type {
  WorkspaceSearchMigrationPlanningEvidencePageWitnesses,
  WorkspaceSearchMigrationPlanningProvenanceArtifact,
  WorkspaceSearchMigrationPlanningSourceEvidencePage,
  WorkspaceSearchMigrationSealedPlanningTableIds,
  WorkspaceSearchMigrationVerifiedHistoricalReceipt,
} from './migration-sealed-planning-authority'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidencePageDigest,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  replayWorkspaceSearchMigrationSourceEvidencePages,
  WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePageDigest,
  parseWorkspaceSearchMigrationTargetEvidencePage,
  replayWorkspaceSearchMigrationTargetEvidencePages,
  type WorkspaceSearchMigrationTargetEvidencePage,
  WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES,
} from './migration-target-evidence'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Maximum canonical size of one immutable provenance data segment. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES =
  16 * 1024 * 1024

/**
 * Maximum combined canonical bytes retained by all provenance data segments.
 */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES =
  256 * 1024 * 1024

/** Maximum canonical size of one immutable provenance manifest page. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES =
  256 * 1024

/** Maximum canonical size of the compact provenance manifest head. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES =
  256 * 1024

/** Maximum combined evidence-page entries retained by one manifest. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES =
  10_000

/** Maximum historical authority transitions retained by one manifest. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS =
  10_000

/** Maximum data segments retained by one complete provenance manifest. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS =
  20_000

/** Maximum manifest pages bound by one compact manifest head. */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES =
  1_000

/** Immutable-storage roles owned by the provenance manifest codec. */
export type WorkspaceSearchMigrationPlanningProvenanceArtifactRole =
  | 'segments'
  | 'manifest-pages'
  | 'manifest-heads'

const planningChainOrder:
  readonly WorkspaceSearchMigrationPlanningEvidenceChainRole[] = [
    ...workspaceSearchMigrationSourceNames,
    'workspace-search',
  ]
const maximumArtifactTextLength = 32 * 1024 * 1024
const maximumPlannedOperationCount = 100_000
const maximumReferenceTextLength = 2_048
const placeholderDigest = '0'.repeat(64)
const placeholderSegmentIndex =
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS - 1
const placeholderManifestPageIndex =
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES - 1

/**
 * Stable raw-value-free failure raised by the provenance manifest boundary.
 */
export class WorkspaceSearchMigrationPlanningProvenanceManifestError
  extends Error {
  /** Secret-free machine-readable manifest failure code. */
  readonly code = 'INVALID_PLANNING_PROVENANCE_MANIFEST'

  /** Creates one stable provenance manifest failure. */
  constructor() {
    super('INVALID_PLANNING_PROVENANCE_MANIFEST')
    this.name = 'WorkspaceSearchMigrationPlanningProvenanceManifestError'
  }
}

/**
 * Rich exact-version reference retained at every immutable manifest layer.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestReference = {
  /** Exact content-addressed S3 object key. */
  readonly objectKey: string
  /** Exact immutable S3 object version. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical object bytes. */
  readonly contentDigest: string
  /** Exact canonical object byte length. */
  readonly byteLength: number
  /** Canonical UTC Object Lock COMPLIANCE retention deadline. */
  readonly retainUntil: string
}

/**
 * Compact semantic identity copied into every segment and manifest layer.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestSummary = {
  /** Summary document discriminator. */
  readonly kind: 'workspace-search-planning-provenance-summary'
  /** Summary schema version. */
  readonly summaryVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Canonical run-scoped immutable-artifact object-key prefix. */
  readonly objectKeyPrefix: string
  /** All six physical DynamoDB table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Five terminal roots in canonical source-then-target order. */
  readonly chainRoots:
    readonly WorkspaceSearchMigrationPlanningEvidenceChainRoot[]
  /** Total canonical evidence-page witness count. */
  readonly evidencePageCount: number
  /** Digest of the replayed source/target planning snapshot. */
  readonly planningSnapshotDigest: string
  /** Exact number of source-owned planned operations. */
  readonly sourceOperationCount: number
  /** Exact number of orphan-target planned operations. */
  readonly orphanOperationCount: number
  /** Exact complete planned-operation count. */
  readonly planOperationCount: number
  /** Digest of the complete canonical authority provenance. */
  readonly provenanceDigest: string
  /** Digest of every transition-ordered historical receipt binding. */
  readonly historicalReceiptBindingDigest: string
  /** Exact number of transition-ordered historical receipts. */
  readonly historicalReceiptCount: number
  /** Digest of every preceding summary field. */
  readonly summaryDigest: string
}

/**
 * One complete evidence witness paired with its exact provenance trace entry.
 */
export type WorkspaceSearchMigrationPlanningProvenanceEvidenceEntry = {
  /** Evidence-entry discriminator. */
  readonly kind: 'workspace-search-planning-provenance-evidence-entry'
  /** Fixed source or target evidence-chain role. */
  readonly chain: WorkspaceSearchMigrationPlanningEvidenceChainRole
  /** One-based canonical position within the evidence chain. */
  readonly pageSequence: number
  /** Exact canonical evidence-page bytes encoded as canonical Base64. */
  readonly witness: string
  /** Exact authority trace entry proven by the witness bytes. */
  readonly authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry
}

/**
 * One complete transition and its exact immutable historical receipt.
 */
export type WorkspaceSearchMigrationPlanningProvenanceReceiptEntry = {
  /** Receipt-entry discriminator. */
  readonly kind: 'workspace-search-planning-provenance-receipt-entry'
  /** Zero-based canonical authority-transition position. */
  readonly transitionIndex: number
  /** Exact deduplicated authority transition. */
  readonly authorityTransition:
    WorkspaceSearchMigrationPlanningAuthorityTransition
  /** Exact historical receipt bound to the transition. */
  readonly historicalReceipt:
    WorkspaceSearchMigrationVerifiedHistoricalReceipt
}

/** Entry roles stored in separate deterministic provenance segment streams. */
export type WorkspaceSearchMigrationPlanningProvenanceSegmentRole =
  | 'evidence-pages'
  | 'historical-receipts'

/** Complete entry accepted by one provenance data segment. */
export type WorkspaceSearchMigrationPlanningProvenanceSegmentEntry =
  | WorkspaceSearchMigrationPlanningProvenanceEvidenceEntry
  | WorkspaceSearchMigrationPlanningProvenanceReceiptEntry

/**
 * One bounded immutable segment containing only complete semantic entries.
 */
export type WorkspaceSearchMigrationPlanningProvenanceSegment = {
  /** Data-segment discriminator. */
  readonly kind: 'workspace-search-planning-provenance-segment'
  /** Data-segment schema version. */
  readonly segmentVersion: 1
  /** Complete manifest summary binding this segment to one artifact. */
  readonly summary:
    WorkspaceSearchMigrationPlanningProvenanceManifestSummary
  /** Homogeneous semantic entry stream stored by this segment. */
  readonly role: WorkspaceSearchMigrationPlanningProvenanceSegmentRole
  /** Zero-based position among all data segments. */
  readonly segmentIndex: number
  /** Exact total data-segment count. */
  readonly segmentCount: number
  /** Zero-based first entry position in this role's complete stream. */
  readonly entryStartIndex: number
  /** Exact complete entry count in this segment. */
  readonly entryCount: number
  /** Complete entries; no entry may be split across segments. */
  readonly entries:
    readonly WorkspaceSearchMigrationPlanningProvenanceSegmentEntry[]
  /** Digest of every preceding canonical segment field. */
  readonly segmentDigest: string
}

/**
 * Canonical bytes and content identity of one provenance data segment.
 */
export type WorkspaceSearchMigrationPlanningProvenanceEncodedSegment = {
  /** Detached strict segment represented by the bytes. */
  readonly segment: WorkspaceSearchMigrationPlanningProvenanceSegment
  /** Exact canonical UTF-8 JSON bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact canonical bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
}

/**
 * One stored segment supplied after its immutable S3 upload completes.
 */
export type WorkspaceSearchMigrationPlanningProvenanceStoredSegment = {
  /** Exact locally encoded segment uploaded to storage. */
  readonly encoded:
    WorkspaceSearchMigrationPlanningProvenanceEncodedSegment
  /** Rich exact-version S3 reference returned by storage. */
  readonly reference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference
}

/**
 * Compact segment locator retained in a bounded manifest page.
 */
export type WorkspaceSearchMigrationPlanningProvenanceSegmentLocator = {
  /** Homogeneous semantic entry stream stored by the segment. */
  readonly role: WorkspaceSearchMigrationPlanningProvenanceSegmentRole
  /** Zero-based global segment position. */
  readonly segmentIndex: number
  /** Exact total data-segment count. */
  readonly segmentCount: number
  /** Zero-based first role-local entry position. */
  readonly entryStartIndex: number
  /** Exact complete entry count in this segment. */
  readonly entryCount: number
  /** Self-digest of the exact canonical segment document. */
  readonly segmentDigest: string
  /** Exact immutable version containing the canonical segment bytes. */
  readonly reference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference
}

/**
 * One bounded immutable page of ordered provenance segment locators.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestPage = {
  /** Manifest-page discriminator. */
  readonly kind: 'workspace-search-planning-provenance-manifest-page'
  /** Manifest-page schema version. */
  readonly manifestPageVersion: 1
  /** Complete semantic summary shared by every manifest layer. */
  readonly summary:
    WorkspaceSearchMigrationPlanningProvenanceManifestSummary
  /** Zero-based manifest-page position. */
  readonly pageIndex: number
  /** Exact total manifest-page count. */
  readonly pageCount: number
  /** Zero-based first global segment position retained by this page. */
  readonly segmentStartIndex: number
  /** Exact number of ordered segment locators in this page. */
  readonly segmentCount: number
  /** Complete contiguous segment locators. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanningProvenanceSegmentLocator[]
  /** Exact immutable reference to the immediately preceding page, if any. */
  readonly previousPageReference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference | null
  /** Digest of every preceding canonical manifest-page field. */
  readonly pageDigest: string
}

/**
 * Canonical bytes and content identity of one provenance manifest page.
 */
export type WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage = {
  /** Detached strict manifest page represented by the bytes. */
  readonly page:
    WorkspaceSearchMigrationPlanningProvenanceManifestPage
  /** Exact canonical UTF-8 JSON bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact canonical bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
}

/**
 * One stored manifest page supplied after immutable upload completes.
 */
export type WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage = {
  /** Exact locally encoded page uploaded to storage. */
  readonly encoded:
    WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage
  /** Rich exact-version S3 reference returned by storage. */
  readonly reference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference
}

/**
 * Compact manifest-page locator retained by the final immutable head.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator = {
  /** Zero-based manifest-page position. */
  readonly pageIndex: number
  /** Exact total manifest-page count. */
  readonly pageCount: number
  /** Zero-based first data-segment position retained by the page. */
  readonly segmentStartIndex: number
  /** Exact number of segment locators retained by the page. */
  readonly segmentCount: number
  /** Self-digest of the exact canonical manifest page. */
  readonly pageDigest: string
  /** Exact immutable version containing the manifest page. */
  readonly reference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference
}

/**
 * Compact final root for every provenance segment and manifest page.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestHead = {
  /** Compact-head discriminator. */
  readonly kind: 'workspace-search-planning-provenance-manifest-head'
  /** Compact-head schema version. */
  readonly manifestHeadVersion: 1
  /** Complete semantic summary shared by every manifest layer. */
  readonly summary:
    WorkspaceSearchMigrationPlanningProvenanceManifestSummary
  /** Exact total data-segment count. */
  readonly segmentCount: number
  /** Exact number of evidence-page data segments. */
  readonly evidenceSegmentCount: number
  /** Exact number of historical-receipt data segments. */
  readonly receiptSegmentCount: number
  /** Exact total bounded manifest-page count. */
  readonly manifestPageCount: number
  /** Digest of the complete ordered exact-version manifest-page locator set. */
  readonly manifestPageLocatorsDigest: string
  /** Exact terminal locator proving the final page and segment boundary. */
  readonly terminalManifestPageLocator:
    WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator
  /** Digest of every preceding canonical compact-head field. */
  readonly headDigest: string
}

/**
 * Segmentation input for one previously verified full provenance artifact.
 *
 * The existing full-artifact validator remains the trust boundary for this
 * compatibility API, so its current 64 MiB direct-object ceiling still applies.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceSegmentsInput = {
  /** Existing strict full provenance artifact to segment losslessly. */
  readonly artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Canonical run-scoped prefix used by every immutable manifest object. */
  readonly objectKeyPrefix: string
  /** Optional smaller segment ceiling used by constrained storage or tests. */
  readonly maximumSegmentBytes?: number
  /** Optional smaller reject-only ceiling for all canonical segment bytes. */
  readonly maximumTotalSegmentBytes?: number
}

/**
 * Raw canonical evidence and receipt bindings accepted by the direct manifest
 * path without constructing the legacy 64 MiB full-artifact envelope.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceDirectBuilderInput =
  {
    /** Four complete canonical planning-v3 source evidence chains. */
    readonly sourceEvidencePageBytes: Readonly<
      Record<
        WorkspaceSearchMigrationSourceName,
        readonly Uint8Array[]
      >
    >
    /** Complete canonical planning-v1 target evidence chain. */
    readonly targetEvidencePageBytes: readonly Uint8Array[]
    /** Durable historical bindings ordered by derived authority transition. */
    readonly historicalReceiptBindings:
      readonly WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding[]
    /** Canonical run-scoped prefix used by every immutable manifest object. */
    readonly objectKeyPrefix: string
    /** Optional smaller segment ceiling used by constrained storage or tests. */
    readonly maximumSegmentBytes?: number
    /** Optional smaller reject-only ceiling for all canonical segment bytes. */
    readonly maximumTotalSegmentBytes?: number
  }

/**
 * Stored-segment input accepted by a direct builder after preflight succeeds.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceDirectManifestPageBuilderInput =
  {
    /** Complete ordered exact-version envelopes for every prepared segment. */
    readonly storedSegments:
      readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[]
    /** Optional smaller manifest-page ceiling. */
    readonly maximumManifestPageBytes?: number
  }

/**
 * Stored-page input accepted by a direct builder after all pages are immutable.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceDirectManifestHeadInput =
  {
    /** Complete ordered exact-version envelopes for every manifest page. */
    readonly storedManifestPages:
      readonly WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[]
  }

/**
 * Staged direct builder that keeps its verified semantic summary private while
 * the caller stores data segments, manifest pages, and the compact head.
 */
export type WorkspaceSearchMigrationPlanningProvenanceDirectBuilder = {
  /** Detached strict authority provenance derived from the raw evidence. */
  readonly planningAuthorityProvenance:
    WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Complete preflighted encoded segments in immutable dependency order. */
  readonly encodedSegments:
    readonly WorkspaceSearchMigrationPlanningProvenanceEncodedSegment[]
  /**
   * Creates a page builder after validating every stored segment envelope.
   *
   * @param input - Complete stored segments and optional page ceiling.
   * @returns Stateful predecessor-linked manifest-page builder.
   */
  readonly createManifestPageBuilder: (
    input:
      CreateWorkspaceSearchMigrationPlanningProvenanceDirectManifestPageBuilderInput,
  ) => WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder
  /**
   * Creates the compact head after validating every stored manifest page.
   *
   * @param input - Complete ordered stored manifest pages.
   * @returns Detached strict compact provenance head.
   */
  readonly createManifestHead: (
    input:
      CreateWorkspaceSearchMigrationPlanningProvenanceDirectManifestHeadInput,
  ) => WorkspaceSearchMigrationPlanningProvenanceManifestHead
}

/**
 * Manifest-page construction input after every data segment is immutable.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilderInput = {
  /** Existing strict full provenance artifact owning every segment. */
  readonly artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Canonical run-scoped prefix fixed in the segment summaries. */
  readonly objectKeyPrefix: string
  /** Complete ordered stored segment set. */
  readonly storedSegments:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[]
  /** Optional smaller manifest-page ceiling. */
  readonly maximumManifestPageBytes?: number
}

/**
 * Stateful sequential builder for immutable provenance manifest pages.
 */
export type WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder = {
  /** Exact number of pages selected by the one-time deterministic layout. */
  readonly pageCount: number
  /**
   * Creates the next page after validating its stored predecessor.
   *
   * @param previousStoredManifestPage - Null for page zero, otherwise the
   * exact immutable envelope for the page returned by the preceding call.
   * @returns Canonical bytes for the next page to upload immutably.
   */
  readonly createNextPage: (
    previousStoredManifestPage:
      WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage | null,
  ) => WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage
}

/**
 * Compact-head construction input after every manifest page is immutable.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceManifestHeadInput = {
  /** Existing strict full provenance artifact owning every manifest layer. */
  readonly artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Canonical run-scoped prefix fixed in every manifest layer. */
  readonly objectKeyPrefix: string
  /** Complete ordered stored manifest-page set. */
  readonly storedManifestPages:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[]
}

/**
 * Exact immutable object bytes supplied during complete manifest replay.
 */
export type WorkspaceSearchMigrationPlanningProvenanceReferencedBytes = {
  /** Rich exact-version reference selected by the parent manifest layer. */
  readonly reference:
    WorkspaceSearchMigrationPlanningProvenanceManifestReference
  /** Exact canonical bytes returned by a version-pinned object read. */
  readonly bytes: Uint8Array
}

/**
 * Complete replay input rooted at one compact provenance manifest head.
 */
export type ReplayWorkspaceSearchMigrationPlanningProvenanceManifestInput = {
  /** Strict compact manifest head, normally parsed from exact stored bytes. */
  readonly head:
    WorkspaceSearchMigrationPlanningProvenanceManifestHead
  /** Ordered exact-version bytes for every page bound by the head digest. */
  readonly manifestPages:
    readonly WorkspaceSearchMigrationPlanningProvenanceReferencedBytes[]
  /** Exact version-pinned bytes for every page-referenced data segment. */
  readonly segments:
    readonly WorkspaceSearchMigrationPlanningProvenanceReferencedBytes[]
}

/**
 * Creates the exact content-addressed object key required by the immutable
 * storage adapter for one provenance manifest layer.
 *
 * @param objectKeyPrefix - Canonical run-scoped immutable-artifact prefix.
 * @param role - Fixed provenance manifest storage role.
 * @param contentDigest - SHA-256 digest of the exact stored bytes.
 * @returns Exact role-separated content-addressed object key.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
  objectKeyPrefix: string,
  role: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  contentDigest: string,
): string {
  return runManifestBoundary(() =>
    createProvenanceObjectKey(
      readObjectKeyPrefix(objectKeyPrefix),
      readArtifactRole(role),
      readDigest(contentDigest),
    )
  )
}

/**
 * Preflights and stages a provenance manifest directly from raw canonical
 * evidence and durable receipt bindings.
 *
 * This path deliberately bypasses the compatibility full-artifact envelope,
 * while preserving identical version-one segment, page, and head bytes for
 * inputs that fit both boundaries.
 *
 * @param input - Raw evidence, exact receipt bindings, prefix, and limits.
 * @returns Staged builder with every segment byte validated before storage I/O.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceDirectBuilder(
  input:
    CreateWorkspaceSearchMigrationPlanningProvenanceDirectBuilderInput,
): WorkspaceSearchMigrationPlanningProvenanceDirectBuilder {
  return runManifestBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactOptionalKeys(inputRecord, [
      'historicalReceiptBindings',
      'maximumSegmentBytes',
      'maximumTotalSegmentBytes',
      'objectKeyPrefix',
      'sourceEvidencePageBytes',
      'targetEvidencePageBytes',
    ], [
      'historicalReceiptBindings',
      'objectKeyPrefix',
      'sourceEvidencePageBytes',
      'targetEvidencePageBytes',
    ])
    const maximumSegmentBytes = readOptionalMaximumBytes(
      readOwnOptional(inputRecord, 'maximumSegmentBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    )
    const maximumTotalSegmentBytes = readOptionalMaximumBytes(
      readOwnOptional(inputRecord, 'maximumTotalSegmentBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
    )
    const objectKeyPrefix = readObjectKeyPrefix(
      readOwn(inputRecord, 'objectKeyPrefix'),
    )
    const material = readDirectPlanningProvenanceMaterial(
      readOwn(inputRecord, 'sourceEvidencePageBytes'),
      readOwn(inputRecord, 'targetEvidencePageBytes'),
      readOwn(inputRecord, 'historicalReceiptBindings'),
      maximumTotalSegmentBytes,
    )
    const summary = createManifestSummary(material, objectKeyPrefix)
    const encodedSegments = createEncodedProvenanceSegments(
      material,
      summary,
      maximumSegmentBytes,
      maximumTotalSegmentBytes,
    )
    const capturedSummary = readSummary(summary)
    const planningAuthorityProvenance = readProvenance(
      material.provenance,
      material.evidencePageWitnesses,
      material.runId,
      material.configurationHash,
      material.tableIds['migration-state'],
    )
    return {
      planningAuthorityProvenance,
      encodedSegments,
      createManifestPageBuilder: (builderInput) =>
        runManifestBoundary(() => {
          const builderRecord = requireRecord(builderInput)
          requireExactOptionalKeys(builderRecord, [
            'maximumManifestPageBytes',
            'storedSegments',
          ], ['storedSegments'])
          return createManifestPageBuilderFromSummary(
            capturedSummary,
            readOwn(builderRecord, 'storedSegments'),
            readOptionalMaximumBytes(
              readOwnOptional(
                builderRecord,
                'maximumManifestPageBytes',
              ),
              WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
            ),
          )
        }),
      createManifestHead: (headInput) =>
        runManifestBoundary(() => {
          const headRecord = requireRecord(headInput)
          requireExactKeys(headRecord, ['storedManifestPages'])
          return createManifestHeadFromSummary(
            capturedSummary,
            readOwn(headRecord, 'storedManifestPages'),
          )
        }),
    }
  })
}

/**
 * Deterministically packs a previously verified full provenance artifact into
 * bounded complete-entry data segments.
 *
 * @param input - Strict artifact and optional smaller segment ceiling.
 * @returns Ordered evidence segments followed by historical-receipt segments.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceSegments(
  input: CreateWorkspaceSearchMigrationPlanningProvenanceSegmentsInput,
): readonly WorkspaceSearchMigrationPlanningProvenanceEncodedSegment[] {
  return runManifestBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactOptionalKeys(inputRecord, [
      'artifact',
      'maximumSegmentBytes',
      'maximumTotalSegmentBytes',
      'objectKeyPrefix',
    ], [
      'artifact',
      'objectKeyPrefix',
    ])
    const artifact = readPlanningProvenanceArtifact(
      readOwn(inputRecord, 'artifact'),
    )
    const maximumSegmentBytes = readOptionalMaximumBytes(
      readOwnOptional(inputRecord, 'maximumSegmentBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    )
    const maximumTotalSegmentBytes = readOptionalMaximumBytes(
      readOwnOptional(inputRecord, 'maximumTotalSegmentBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
    )
    const objectKeyPrefix = readObjectKeyPrefix(
      readOwn(inputRecord, 'objectKeyPrefix'),
    )
    const summary = createManifestSummary(artifact, objectKeyPrefix)
    return createEncodedProvenanceSegments(
      artifact,
      summary,
      maximumSegmentBytes,
      maximumTotalSegmentBytes,
    )
  })
}

/**
 * Parses one exact canonical bounded provenance data segment.
 *
 * @param bytes - Untrusted exact segment bytes.
 * @returns Detached strict provenance segment.
 */
export function parseWorkspaceSearchMigrationPlanningProvenanceSegment(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningProvenanceSegment {
  return runManifestBoundary(() => {
    const parsed = parseCanonicalJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    )
    const segment = readSegment(parsed.value)
    requireCanonicalBytes(
      parsed.bytes,
      segment,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    )
    return segment
  })
}

/**
 * Builds one deterministic sequential manifest-page writer.
 *
 * The complete page layout is packed once. Each page after page zero can only
 * be created after the caller supplies the exact immutable storage envelope
 * for the page returned by the preceding call.
 *
 * @param input - Artifact, complete stored segments, and optional page ceiling.
 * @returns Stateful builder for the precomputed ordered page layout.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder(
  input:
    CreateWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilderInput,
): WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder {
  return runManifestBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactOptionalKeys(inputRecord, [
      'artifact',
      'maximumManifestPageBytes',
      'objectKeyPrefix',
      'storedSegments',
    ], [
      'artifact',
      'objectKeyPrefix',
      'storedSegments',
    ])
    const artifact = readPlanningProvenanceArtifact(
      readOwn(inputRecord, 'artifact'),
    )
    const objectKeyPrefix = readObjectKeyPrefix(
      readOwn(inputRecord, 'objectKeyPrefix'),
    )
    const summary = createManifestSummary(artifact, objectKeyPrefix)
    const maximumManifestPageBytes = readOptionalMaximumBytes(
      readOwnOptional(inputRecord, 'maximumManifestPageBytes'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
    )
    return createManifestPageBuilderFromSummary(
      summary,
      readOwn(inputRecord, 'storedSegments'),
      maximumManifestPageBytes,
    )
  })
}

/**
 * Parses one exact canonical bounded provenance manifest page.
 *
 * @param bytes - Untrusted exact manifest-page bytes.
 * @returns Detached strict manifest page.
 */
export function parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningProvenanceManifestPage {
  return runManifestBoundary(() => {
    const parsed = parseCanonicalJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
    )
    const page = readManifestPage(parsed.value)
    requireCanonicalBytes(
      parsed.bytes,
      page,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
    )
    return page
  })
}

/**
 * Creates the compact immutable root after every manifest page is stored.
 *
 * @param input - Artifact and complete exact-version manifest-page set.
 * @returns Detached strict compact manifest head.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceManifestHead(
  input: CreateWorkspaceSearchMigrationPlanningProvenanceManifestHeadInput,
): WorkspaceSearchMigrationPlanningProvenanceManifestHead {
  return runManifestBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, [
      'artifact',
      'objectKeyPrefix',
      'storedManifestPages',
    ])
    const artifact = readPlanningProvenanceArtifact(
      readOwn(inputRecord, 'artifact'),
    )
    const objectKeyPrefix = readObjectKeyPrefix(
      readOwn(inputRecord, 'objectKeyPrefix'),
    )
    const summary = createManifestSummary(artifact, objectKeyPrefix)
    return createManifestHeadFromSummary(
      summary,
      readOwn(inputRecord, 'storedManifestPages'),
    )
  })
}

/**
 * Serializes one compact provenance manifest head as canonical UTF-8 JSON.
 *
 * @param value - Candidate compact manifest head.
 * @returns Exact canonical bounded bytes.
 */
export function serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
  value: WorkspaceSearchMigrationPlanningProvenanceManifestHead,
): Uint8Array {
  return runManifestBoundary(() => {
    const head = readManifestHead(value)
    return encodeCanonical(
      head,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
    )
  })
}

/**
 * Parses one exact canonical compact provenance manifest head.
 *
 * @param bytes - Untrusted exact compact-head bytes.
 * @returns Detached strict compact manifest head.
 */
export function parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningProvenanceManifestHead {
  return runManifestBoundary(() => {
    const parsed = parseCanonicalJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
    )
    const head = readManifestHead(parsed.value)
    requireCanonicalBytes(
      parsed.bytes,
      head,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
    )
    return head
  })
}

/**
 * Replays every exact immutable manifest page and data segment to reconstruct
 * the original full provenance artifact with identical semantics.
 *
 * @param input - Compact head and exact version-pinned object bytes.
 * @param maximumTotalSegmentBytes - Optional smaller aggregate segment-byte
 * ceiling that may only reject an otherwise valid replay.
 * @returns Detached full provenance artifact equal to the segmented input.
 */
export function replayWorkspaceSearchMigrationPlanningProvenanceManifest(
  input: ReplayWorkspaceSearchMigrationPlanningProvenanceManifestInput,
  maximumTotalSegmentBytes =
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  return runManifestBoundary(() => {
    const totalSegmentByteCeiling = readBoundedPositiveSafeInteger(
      maximumTotalSegmentBytes,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
    )
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, ['head', 'manifestPages', 'segments'])
    const head = readManifestHead(readOwn(inputRecord, 'head'))
    const manifestPageValues = requireDenseArray(
      readOwn(inputRecord, 'manifestPages'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
    )
    if (manifestPageValues.length !== head.manifestPageCount) {
      return failManifest()
    }
    const manifestPages = manifestPageValues.map((value, index) =>
      readReferencedManifestPageLocator(
        value,
        index,
        head.manifestPageCount,
        head.summary,
      )
    )
    const segmentCount =
      requireCompleteManifestPageLocators(manifestPages)
    const manifestPageLocators =
      manifestPages.map(({ locator }) => locator)
    const terminalManifestPageLocator =
      manifestPageLocators.at(-1)
    if (
      segmentCount !== head.segmentCount ||
      terminalManifestPageLocator === undefined ||
      createManifestPageLocatorsDigest(manifestPageLocators) !==
        head.manifestPageLocatorsDigest ||
      !sameManifestPageLocator(
        terminalManifestPageLocator,
        head.terminalManifestPageLocator,
      )
    ) {
      return failManifest()
    }
    const pages = manifestPages.map(({ encodedPage }) => encodedPage)
    const locators = pages.flatMap(({ segments }) => segments)
    if (
      locators.length !== head.segmentCount ||
      locators.filter(({ role }) => role === 'evidence-pages').length !==
        head.evidenceSegmentCount ||
      locators.filter(({ role }) => role === 'historical-receipts').length !==
        head.receiptSegmentCount
    ) {
      return failManifest()
    }
    requireCompleteSegmentLocatorStreams(locators, head.summary)
    let totalSegmentBytes = 0
    for (const locator of locators) {
      totalSegmentBytes = addBoundedCanonicalBytes(
        totalSegmentBytes,
        locator.reference.byteLength,
        totalSegmentByteCeiling,
      )
    }
    const segmentBytes = readReferencedBytesArray(
      readOwn(inputRecord, 'segments'),
      locators.map(({ reference }) => reference),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    )
    const segments = segmentBytes.map((bytes, index) => {
      const segment =
        parseWorkspaceSearchMigrationPlanningProvenanceSegment(bytes)
      const locator = locators[index]
      if (
        locator === undefined ||
        !sameSummary(segment.summary, head.summary) ||
        segment.role !== locator.role ||
        segment.segmentIndex !== locator.segmentIndex ||
        segment.segmentCount !== locator.segmentCount ||
        segment.entryStartIndex !== locator.entryStartIndex ||
        segment.entryCount !== locator.entryCount ||
        segment.segmentDigest !== locator.segmentDigest
      ) {
        return failManifest()
      }
      return segment
    })
    const artifact = reconstructArtifact(head.summary, segments)
    const validated = readPlanningProvenanceArtifact(artifact)
    if (
      !sameSummary(
        createManifestSummary(
          validated,
          head.summary.objectKeyPrefix,
        ),
        head.summary,
      )
    ) {
      return failManifest()
    }
    return validated
  })
}

/**
 * One deterministic contiguous data-segment range selected during packing.
 */
type ProvenanceSegmentRange = {
  /** Homogeneous semantic stream stored by this range. */
  readonly role: WorkspaceSearchMigrationPlanningProvenanceSegmentRole
  /** Zero-based first role-local entry position. */
  readonly entryStartIndex: number
  /** Exact complete entry count. */
  readonly entryCount: number
}

/** One contiguous manifest-page locator range selected during packing. */
type ProvenanceManifestPageRange = {
  /** Zero-based first global data-segment position. */
  readonly segmentStartIndex: number
  /** Exact locator count retained by the page. */
  readonly segmentCount: number
}

/** Parsed JSON paired with the immutable byte snapshot used for parsing. */
type ParsedCanonicalJson = {
  /** Untrusted JSON value parsed from the exact byte snapshot. */
  readonly value: unknown
  /** Detached non-shared bytes used for canonical comparison. */
  readonly bytes: Uint8Array
}

/** Parsed stored page paired with its derived exact-version locator. */
type PreparedStoredManifestPage = {
  /** Exact strict page reconstructed from local canonical bytes. */
  readonly encodedPage:
    WorkspaceSearchMigrationPlanningProvenanceManifestPage
  /** Compact exact-version locator bound by the final head. */
  readonly locator:
    WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator
}

/** Strict parsed page documents for all five planning evidence chains. */
type ParsedPlanningEvidencePages = {
  /** Four complete source planning evidence chains. */
  readonly sources: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      readonly WorkspaceSearchMigrationPlanningSourceEvidencePage[]
    >
  >
  /** Complete Workspace Search target planning evidence chain. */
  readonly target: readonly WorkspaceSearchMigrationTargetEvidencePage[]
}

/**
 * Semantic material shared by legacy full-artifact and direct raw builders.
 */
type PlanningProvenanceManifestMaterial = {
  /** Operator-selected run shared by every evidence chain. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six physical DynamoDB table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact canonical page witnesses for all five chains. */
  readonly evidencePageWitnesses:
    WorkspaceSearchMigrationPlanningEvidencePageWitnesses
  /** Complete canonical authority provenance derived from the pages. */
  readonly provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Digest of the complete replayed planning snapshot. */
  readonly planningSnapshotDigest: string
  /** Exact source-owned planned-operation count. */
  readonly sourceOperationCount: number
  /** Exact orphan-target planned-operation count. */
  readonly orphanOperationCount: number
  /** Exact complete planned-operation count. */
  readonly planOperationCount: number
  /** Transition-ordered verified historical receipts. */
  readonly historicalReceipts:
    readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[]
  /** Digest of every verified historical receipt binding. */
  readonly historicalReceiptBindingDigest: string
}

/**
 * Raw evidence parse result retained only until semantic replay completes.
 */
type ParsedDirectPlanningEvidence = {
  /** Detached canonical Base64 witnesses for all five chains. */
  readonly witnesses: WorkspaceSearchMigrationPlanningEvidencePageWitnesses
  /** Strict parsed planning evidence pages in fixed chain order. */
  readonly pages: ParsedPlanningEvidencePages
}

/** Mutable aggregate budget used while snapshotting direct raw evidence. */
type DirectPlanningEvidenceBudget = {
  /** Number of canonical evidence pages accepted so far. */
  pageCount: number
  /** Canonical Base64 characters retained by accepted witnesses. */
  base64Characters: number
  /** Reject-only upper bound inherited from total segment bytes. */
  readonly maximumBase64Characters: number
}

/** Evidence semantics independently replayed from retained witness bytes. */
type VerifiedPlanningEvidenceSemantics = {
  /** All six physical table incarnations derived from exact pages. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Canonical authority provenance derived from page authority bindings. */
  readonly provenance:
    WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Digest of the complete replayed planning scan snapshot. */
  readonly planningSnapshotDigest: string
  /** Exact number of source-owned plan operations. */
  readonly sourceOperationCount: number
  /** Exact number of orphan-target plan operations. */
  readonly orphanOperationCount: number
  /** Exact complete plan operation count. */
  readonly planOperationCount: number
}

/**
 * Creates one detached complete semantic summary from a strict artifact.
 *
 * @param artifact - Existing validated full provenance artifact.
 * @param objectKeyPrefix - Canonical immutable-artifact key prefix.
 * @returns Compact summary shared by every manifest layer.
 */
function createManifestSummary(
  artifact: PlanningProvenanceManifestMaterial,
  objectKeyPrefix: string,
): WorkspaceSearchMigrationPlanningProvenanceManifestSummary {
  const summaryFields = {
    kind: 'workspace-search-planning-provenance-summary',
    summaryVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: artifact.runId,
    configurationHash: artifact.configurationHash,
    objectKeyPrefix,
    tableIds: artifact.tableIds,
    chainRoots: artifact.provenance.chainRoots,
    evidencePageCount: artifact.provenance.authorityTrace.length,
    planningSnapshotDigest: artifact.planningSnapshotDigest,
    sourceOperationCount: artifact.sourceOperationCount,
    orphanOperationCount: artifact.orphanOperationCount,
    planOperationCount: artifact.planOperationCount,
    provenanceDigest: artifact.provenance.provenanceDigest,
    historicalReceiptBindingDigest:
      artifact.historicalReceiptBindingDigest,
    historicalReceiptCount: artifact.historicalReceipts.length,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
    'summaryDigest'
  >
  return {
    ...summaryFields,
    summaryDigest: createMigrationDigest(summaryFields),
  }
}

/**
 * Pairs every retained evidence witness with its canonical trace entry.
 *
 * @param artifact - Strict existing full artifact.
 * @returns Complete chain-major/page-major evidence entry stream.
 */
function createEvidenceEntries(
  artifact: PlanningProvenanceManifestMaterial,
): readonly WorkspaceSearchMigrationPlanningProvenanceEvidenceEntry[] {
  const entries:
    WorkspaceSearchMigrationPlanningProvenanceEvidenceEntry[] = []
  let traceIndex = 0
  for (const chain of planningChainOrder) {
    const witnesses = chain === 'workspace-search'
      ? artifact.evidencePageWitnesses.target
      : artifact.evidencePageWitnesses.sources[chain]
    for (let pageIndex = 0; pageIndex < witnesses.length; pageIndex += 1) {
      const witness = witnesses[pageIndex]
      const authorityTrace = artifact.provenance.authorityTrace[traceIndex]
      if (
        witness === undefined ||
        authorityTrace === undefined ||
        authorityTrace.chain !== chain ||
        authorityTrace.pageSequence !== pageIndex + 1
      ) {
        return failManifest()
      }
      entries.push({
        kind: 'workspace-search-planning-provenance-evidence-entry',
        chain,
        pageSequence: pageIndex + 1,
        witness,
        authorityTrace,
      })
      traceIndex += 1
    }
  }
  if (traceIndex !== artifact.provenance.authorityTrace.length) {
    return failManifest()
  }
  return entries
}

/**
 * Pairs every authority transition with its exact historical receipt.
 *
 * @param artifact - Strict existing full artifact.
 * @returns Complete transition-ordered receipt entry stream.
 */
function createReceiptEntries(
  artifact: PlanningProvenanceManifestMaterial,
): readonly WorkspaceSearchMigrationPlanningProvenanceReceiptEntry[] {
  if (
    artifact.provenance.authorityTransitions.length !==
      artifact.historicalReceipts.length
  ) {
    return failManifest()
  }
  return artifact.provenance.authorityTransitions.map(
    (authorityTransition, transitionIndex) => {
      const historicalReceipt =
        artifact.historicalReceipts[transitionIndex]
      if (historicalReceipt === undefined) return failManifest()
      return {
        kind: 'workspace-search-planning-provenance-receipt-entry',
        transitionIndex,
        authorityTransition,
        historicalReceipt,
      }
    },
  )
}

/**
 * Encodes both homogeneous provenance entry streams after exact preflight.
 *
 * @param material - Verified legacy or direct semantic material.
 * @param summary - Exact manifest summary derived from that material.
 * @param maximumSegmentBytes - Inclusive per-segment canonical byte ceiling.
 * @param maximumTotalSegmentBytes - Inclusive aggregate byte ceiling.
 * @returns Complete evidence-then-receipt encoded segment sequence.
 */
function createEncodedProvenanceSegments(
  material: PlanningProvenanceManifestMaterial,
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  maximumSegmentBytes: number,
  maximumTotalSegmentBytes: number,
): readonly WorkspaceSearchMigrationPlanningProvenanceEncodedSegment[] {
  const evidenceEntries = createEvidenceEntries(material)
  const receiptEntries = createReceiptEntries(material)
  const evidenceRanges = packSegmentRanges(
    summary,
    'evidence-pages',
    evidenceEntries,
    maximumSegmentBytes,
  )
  const receiptRanges = packSegmentRanges(
    summary,
    'historical-receipts',
    receiptEntries,
    maximumSegmentBytes,
  )
  const ranges = [...evidenceRanges, ...receiptRanges]
  const segmentCount = ranges.length
  if (
    segmentCount === 0 ||
    segmentCount >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS
  ) {
    return failManifest()
  }
  const encoded:
    WorkspaceSearchMigrationPlanningProvenanceEncodedSegment[] = []
  let totalSegmentBytes = 0
  for (const range of ranges) {
    const sourceEntries = range.role === 'evidence-pages'
      ? evidenceEntries
      : receiptEntries
    const entries = sourceEntries.slice(
      range.entryStartIndex,
      range.entryStartIndex + range.entryCount,
    )
    const segmentFields = {
      kind: 'workspace-search-planning-provenance-segment',
      segmentVersion: 1,
      summary,
      role: range.role,
      segmentIndex: encoded.length,
      segmentCount,
      entryStartIndex: range.entryStartIndex,
      entryCount: entries.length,
      entries,
    } satisfies Omit<
      WorkspaceSearchMigrationPlanningProvenanceSegment,
      'segmentDigest'
    >
    const segment:
      WorkspaceSearchMigrationPlanningProvenanceSegment = {
        ...segmentFields,
        segmentDigest: createMigrationDigest(segmentFields),
      }
    const bytes = encodeCanonical(segment, maximumSegmentBytes)
    totalSegmentBytes = addBoundedCanonicalBytes(
      totalSegmentBytes,
      bytes.byteLength,
      maximumTotalSegmentBytes,
    )
    encoded.push({
      segment,
      bytes,
      contentDigest: digestBytes(bytes),
      byteLength: bytes.byteLength,
    })
  }
  return encoded
}

/**
 * Greedily packs one homogeneous entry stream using pessimistic index widths.
 *
 * @param summary - Complete artifact summary copied into every segment.
 * @param role - Homogeneous stream being packed.
 * @param entries - Complete semantic entries.
 * @param maximumBytes - Caller-selected ceiling no larger than 16 MiB.
 * @returns Deterministic complete-entry ranges.
 */
function packSegmentRanges(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  role: WorkspaceSearchMigrationPlanningProvenanceSegmentRole,
  entries: readonly WorkspaceSearchMigrationPlanningProvenanceSegmentEntry[],
  maximumBytes: number,
): readonly ProvenanceSegmentRange[] {
  if (entries.length === 0) return failManifest()
  const entryByteLengths = entries.map(canonicalByteLength)
  const ranges: ProvenanceSegmentRange[] = []
  let entryStartIndex = 0
  while (entryStartIndex < entries.length) {
    let acceptedCount = 0
    let acceptedEntryBytes = 0
    while (entryStartIndex + acceptedCount < entries.length) {
      const nextCount = acceptedCount + 1
      const nextEntryByteLength =
        entryByteLengths[entryStartIndex + acceptedCount]
      if (nextEntryByteLength === undefined) return failManifest()
      const nextEntryBytes =
        acceptedEntryBytes + nextEntryByteLength
      const candidate = {
        kind: 'workspace-search-planning-provenance-segment',
        segmentVersion: 1,
        summary,
        role,
        segmentIndex: placeholderSegmentIndex,
        segmentCount:
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
        entryStartIndex,
        entryCount: nextCount,
        entries: [],
        segmentDigest: placeholderDigest,
      } satisfies WorkspaceSearchMigrationPlanningProvenanceSegment
      const candidateByteLength =
        canonicalByteLength(candidate) +
        nextEntryBytes +
        nextCount - 1
      if (candidateByteLength > maximumBytes) break
      acceptedCount = nextCount
      acceptedEntryBytes = nextEntryBytes
    }
    if (acceptedCount === 0) return failManifest()
    ranges.push({ role, entryStartIndex, entryCount: acceptedCount })
    entryStartIndex += acceptedCount
  }
  return ranges
}

/**
 * Greedily packs exact segment locators into bounded manifest-page ranges.
 *
 * @param summary - Complete artifact summary copied into every page.
 * @param locators - Complete ordered segment locators.
 * @param maximumBytes - Caller-selected ceiling no larger than 256 KiB.
 * @returns Deterministic contiguous manifest-page ranges.
 */
function packManifestPageRanges(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  locators:
    readonly WorkspaceSearchMigrationPlanningProvenanceSegmentLocator[],
  maximumBytes: number,
): readonly ProvenanceManifestPageRange[] {
  const locatorByteLengths = locators.map(canonicalByteLength)
  const maximumPreviousPageReference =
    createMaximumManifestPageReferencePlaceholder(
      summary.objectKeyPrefix,
    )
  const ranges: ProvenanceManifestPageRange[] = []
  let segmentStartIndex = 0
  while (segmentStartIndex < locators.length) {
    let acceptedCount = 0
    let acceptedLocatorBytes = 0
    while (segmentStartIndex + acceptedCount < locators.length) {
      const nextCount = acceptedCount + 1
      const nextLocatorByteLength =
        locatorByteLengths[segmentStartIndex + acceptedCount]
      if (nextLocatorByteLength === undefined) return failManifest()
      const nextLocatorBytes =
        acceptedLocatorBytes + nextLocatorByteLength
      const candidate = {
        kind: 'workspace-search-planning-provenance-manifest-page',
        manifestPageVersion: 1,
        summary,
        pageIndex: placeholderManifestPageIndex,
        pageCount:
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
        segmentStartIndex,
        segmentCount: nextCount,
        segments: [],
        previousPageReference: maximumPreviousPageReference,
        pageDigest: placeholderDigest,
      } satisfies WorkspaceSearchMigrationPlanningProvenanceManifestPage
      const candidateByteLength =
        canonicalByteLength(candidate) +
        nextLocatorBytes +
        nextCount - 1
      if (candidateByteLength > maximumBytes) break
      acceptedCount = nextCount
      acceptedLocatorBytes = nextLocatorBytes
    }
    if (acceptedCount === 0) return failManifest()
    ranges.push({ segmentStartIndex, segmentCount: acceptedCount })
    segmentStartIndex += acceptedCount
  }
  return ranges
}

/**
 * Builds manifest pages against one privately captured verified summary.
 *
 * @param summary - Exact semantic summary derived before immutable writes.
 * @param storedValue - Candidate complete stored-segment array.
 * @param maximumManifestPageBytes - Inclusive canonical page ceiling.
 * @returns Stateful predecessor-linked manifest-page builder.
 */
function createManifestPageBuilderFromSummary(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  storedValue: unknown,
  maximumManifestPageBytes: number,
): WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder {
  const storedValues = requireDenseArray(
    storedValue,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  )
  if (storedValues.length === 0) return failManifest()
  const locators = storedValues.map((value, index) =>
    readStoredSegmentLocator(value, index, storedValues.length, summary)
  )
  requireCompleteSegmentLocatorStreams(locators, summary)
  const pageRanges = packManifestPageRanges(
    summary,
    locators,
    maximumManifestPageBytes,
  )
  if (
    pageRanges.length === 0 ||
    pageRanges.length >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES
  ) {
    return failManifest()
  }
  let nextPageIndex = 0
  let expectedPreviousPageDigest: string | null = null
  let expectedPreviousContentDigest: string | null = null
  let expectedPreviousByteLength: number | null = null
  return {
    pageCount: pageRanges.length,
    createNextPage: (previousStoredManifestPage) =>
      runManifestBoundary(() => {
        const range = pageRanges[nextPageIndex]
        if (range === undefined) return failManifest()
        let previousPageReference:
          WorkspaceSearchMigrationPlanningProvenanceManifestReference
            | null = null
        if (nextPageIndex === 0) {
          if (
            previousStoredManifestPage !== null ||
            expectedPreviousPageDigest !== null ||
            expectedPreviousContentDigest !== null ||
            expectedPreviousByteLength !== null
          ) {
            return failManifest()
          }
        } else {
          if (
            previousStoredManifestPage === null ||
            expectedPreviousPageDigest === null ||
            expectedPreviousContentDigest === null ||
            expectedPreviousByteLength === null
          ) {
            return failManifest()
          }
          const previous = readStoredManifestPageLocator(
            previousStoredManifestPage,
            nextPageIndex - 1,
            pageRanges.length,
            summary,
          )
          if (
            previous.encodedPage.pageDigest !==
              expectedPreviousPageDigest ||
            previous.locator.reference.contentDigest !==
              expectedPreviousContentDigest ||
            previous.locator.reference.byteLength !==
              expectedPreviousByteLength
          ) {
            return failManifest()
          }
          previousPageReference = previous.locator.reference
        }
        const segments = locators.slice(
          range.segmentStartIndex,
          range.segmentStartIndex + range.segmentCount,
        )
        const pageFields = {
          kind: 'workspace-search-planning-provenance-manifest-page',
          manifestPageVersion: 1,
          summary,
          pageIndex: nextPageIndex,
          pageCount: pageRanges.length,
          segmentStartIndex: range.segmentStartIndex,
          segmentCount: segments.length,
          segments,
          previousPageReference,
        } satisfies Omit<
          WorkspaceSearchMigrationPlanningProvenanceManifestPage,
          'pageDigest'
        >
        const page:
          WorkspaceSearchMigrationPlanningProvenanceManifestPage = {
            ...pageFields,
            pageDigest: createMigrationDigest(pageFields),
          }
        const bytes = encodeCanonical(page, maximumManifestPageBytes)
        const detachedPage =
          parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(
            bytes,
          )
        const encoded = {
          page: detachedPage,
          bytes,
          contentDigest: digestBytes(bytes),
          byteLength: bytes.byteLength,
        }
        nextPageIndex += 1
        expectedPreviousPageDigest = detachedPage.pageDigest
        expectedPreviousContentDigest = encoded.contentDigest
        expectedPreviousByteLength = encoded.byteLength
        return encoded
      }),
  }
}

/**
 * Creates one compact head against a privately captured verified summary.
 *
 * @param summary - Exact semantic summary derived before immutable writes.
 * @param storedValue - Candidate complete stored manifest-page array.
 * @returns Detached strict compact provenance head.
 */
function createManifestHeadFromSummary(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  storedValue: unknown,
): WorkspaceSearchMigrationPlanningProvenanceManifestHead {
  const detachedSummary = readSummary(summary)
  const storedValues = requireDenseArray(
    storedValue,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  )
  if (storedValues.length === 0) return failManifest()
  const manifestPages = storedValues.map((value, index) =>
    readStoredManifestPageLocator(
      value,
      index,
      storedValues.length,
      detachedSummary,
    )
  )
  const segmentCount = requireCompleteManifestPageLocators(manifestPages)
  const evidenceSegmentCount = manifestPages
    .flatMap(({ encodedPage }) => encodedPage.segments)
    .filter(({ role }) => role === 'evidence-pages')
    .length
  const receiptSegmentCount = segmentCount - evidenceSegmentCount
  if (evidenceSegmentCount === 0 || receiptSegmentCount === 0) {
    return failManifest()
  }
  const locators = manifestPages.map(({ locator }) => locator)
  const terminalManifestPageLocator = locators.at(-1)
  if (terminalManifestPageLocator === undefined) return failManifest()
  const headFields = {
    kind: 'workspace-search-planning-provenance-manifest-head',
    manifestHeadVersion: 1,
    summary: detachedSummary,
    segmentCount,
    evidenceSegmentCount,
    receiptSegmentCount,
    manifestPageCount: locators.length,
    manifestPageLocatorsDigest:
      createManifestPageLocatorsDigest(locators),
    terminalManifestPageLocator,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceManifestHead,
    'headDigest'
  >
  const head: WorkspaceSearchMigrationPlanningProvenanceManifestHead = {
    ...headFields,
    headDigest: createMigrationDigest(headFields),
  }
  const bytes = encodeCanonical(
    head,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  )
  return parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
    bytes,
  )
}

/**
 * Creates a conservative predecessor reference used only for size packing.
 *
 * Every field is at least as large canonically as an accepted stored-page
 * reference, so the one-time page layout remains valid after upload supplies
 * the exact version and retention values.
 *
 * @param objectKeyPrefix - Canonical run-scoped immutable-artifact prefix.
 * @returns Maximum canonical-size placeholder for one page reference.
 */
function createMaximumManifestPageReferencePlaceholder(
  objectKeyPrefix: string,
): WorkspaceSearchMigrationPlanningProvenanceManifestReference {
  return {
    objectKey: createProvenanceObjectKey(
      objectKeyPrefix,
      'manifest-pages',
      placeholderDigest,
    ),
    versionId: '\0'.repeat(maximumReferenceTextLength),
    contentDigest: placeholderDigest,
    byteLength: Number.MAX_SAFE_INTEGER,
    retainUntil: '+275760-09-13T00:00:00.000Z',
  }
}

/**
 * Reads and correlates one stored data segment into its manifest locator.
 *
 * @param value - Candidate stored segment envelope.
 * @param expectedIndex - Required global segment position.
 * @param expectedCount - Required complete segment count.
 * @param summary - Required complete artifact summary.
 * @returns Strict compact segment locator.
 */
function readStoredSegmentLocator(
  value: unknown,
  expectedIndex: number,
  expectedCount: number,
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
): WorkspaceSearchMigrationPlanningProvenanceSegmentLocator {
  const record = requireRecord(value)
  requireExactKeys(record, ['encoded', 'reference'])
  const encodedRecord = requireRecord(readOwn(record, 'encoded'))
  requireExactKeys(encodedRecord, [
    'byteLength',
    'bytes',
    'contentDigest',
    'segment',
  ])
  const bytes = readDetachedUnsharedBytes(
    readOwn(encodedRecord, 'bytes'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
  )
  const segment =
    parseWorkspaceSearchMigrationPlanningProvenanceSegment(bytes)
  const byteLength = readPositiveSafeInteger(
    readOwn(encodedRecord, 'byteLength'),
  )
  const contentDigest = readDigest(
    readOwn(encodedRecord, 'contentDigest'),
  )
  const suppliedSegment = readSegment(readOwn(encodedRecord, 'segment'))
  if (
    byteLength !== bytes.byteLength ||
    contentDigest !== digestBytes(bytes) ||
    suppliedSegment.segmentDigest !== segment.segmentDigest ||
    segment.segmentIndex !== expectedIndex ||
    segment.segmentCount !== expectedCount ||
    !sameSummary(segment.summary, summary)
  ) {
    return failManifest()
  }
  const reference = readReference(
    readOwn(record, 'reference'),
    summary.objectKeyPrefix,
    'segments',
  )
  requireReferenceMatchesBytes(reference, bytes)
  return {
    role: segment.role,
    segmentIndex: segment.segmentIndex,
    segmentCount: segment.segmentCount,
    entryStartIndex: segment.entryStartIndex,
    entryCount: segment.entryCount,
    segmentDigest: segment.segmentDigest,
    reference,
  }
}

/**
 * Reads and correlates one stored manifest page into its compact locator.
 *
 * @param value - Candidate stored manifest-page envelope.
 * @param expectedIndex - Required page position.
 * @param expectedCount - Required complete page count.
 * @param summary - Required complete artifact summary.
 * @returns Strict page and compact locator.
 */
function readStoredManifestPageLocator(
  value: unknown,
  expectedIndex: number,
  expectedCount: number,
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
): PreparedStoredManifestPage {
  const record = requireRecord(value)
  requireExactKeys(record, ['encoded', 'reference'])
  const encodedRecord = requireRecord(readOwn(record, 'encoded'))
  requireExactKeys(encodedRecord, [
    'byteLength',
    'bytes',
    'contentDigest',
    'page',
  ])
  const bytes = readDetachedUnsharedBytes(
    readOwn(encodedRecord, 'bytes'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  )
  const page =
    parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(bytes)
  const byteLength = readPositiveSafeInteger(
    readOwn(encodedRecord, 'byteLength'),
  )
  const contentDigest = readDigest(
    readOwn(encodedRecord, 'contentDigest'),
  )
  const suppliedPage = readManifestPage(readOwn(encodedRecord, 'page'))
  if (
    byteLength !== bytes.byteLength ||
    contentDigest !== digestBytes(bytes) ||
    suppliedPage.pageDigest !== page.pageDigest ||
    page.pageIndex !== expectedIndex ||
    page.pageCount !== expectedCount ||
    !sameSummary(page.summary, summary)
  ) {
    return failManifest()
  }
  const reference = readReference(
    readOwn(record, 'reference'),
    summary.objectKeyPrefix,
    'manifest-pages',
  )
  requireReferenceMatchesBytes(reference, bytes)
  return {
    encodedPage: page,
    locator: {
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      segmentStartIndex: page.segmentStartIndex,
      segmentCount: page.segmentCount,
      pageDigest: page.pageDigest,
      reference,
    },
  }
}

/**
 * Re-derives one exact manifest-page locator from replay-supplied bytes.
 *
 * @param value - Candidate exact-version reference and page bytes.
 * @param expectedIndex - Required page position.
 * @param expectedCount - Required complete page count.
 * @param summary - Required complete artifact summary.
 * @returns Strict page and locator derived from the supplied immutable object.
 */
function readReferencedManifestPageLocator(
  value: unknown,
  expectedIndex: number,
  expectedCount: number,
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
): PreparedStoredManifestPage {
  const record = requireRecord(value)
  requireExactKeys(record, ['bytes', 'reference'])
  const bytes = readDetachedUnsharedBytes(
    readOwn(record, 'bytes'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  )
  const page =
    parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(bytes)
  if (
    page.pageIndex !== expectedIndex ||
    page.pageCount !== expectedCount ||
    !sameSummary(page.summary, summary)
  ) {
    return failManifest()
  }
  const reference = readReference(
    readOwn(record, 'reference'),
    summary.objectKeyPrefix,
    'manifest-pages',
  )
  requireReferenceMatchesBytes(reference, bytes)
  return {
    encodedPage: page,
    locator: {
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      segmentStartIndex: page.segmentStartIndex,
      segmentCount: page.segmentCount,
      pageDigest: page.pageDigest,
      reference,
    },
  }
}

/**
 * Requires complete canonical segment and role-local entry coverage.
 *
 * @param locators - Complete ordered segment locator set.
 * @param summary - Artifact summary providing exact entry counts.
 */
function requireCompleteSegmentLocatorStreams(
  locators:
    readonly WorkspaceSearchMigrationPlanningProvenanceSegmentLocator[],
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
): void {
  let evidenceEntryIndex = 0
  let receiptEntryIndex = 0
  let sawReceipt = false
  for (let index = 0; index < locators.length; index += 1) {
    const locator = locators[index]
    if (
      locator === undefined ||
      locator.segmentIndex !== index ||
      locator.segmentCount !== locators.length ||
      locator.entryCount <= 0
    ) {
      return failManifest()
    }
    if (locator.role === 'evidence-pages') {
      if (
        sawReceipt ||
        locator.entryStartIndex !== evidenceEntryIndex
      ) {
        return failManifest()
      }
      evidenceEntryIndex += locator.entryCount
    } else {
      sawReceipt = true
      if (locator.entryStartIndex !== receiptEntryIndex) {
        return failManifest()
      }
      receiptEntryIndex += locator.entryCount
    }
  }
  if (
    evidenceEntryIndex !== summary.evidencePageCount ||
    receiptEntryIndex !== summary.historicalReceiptCount
  ) {
    return failManifest()
  }
}

/**
 * Requires complete manifest-page and global segment coverage.
 *
 * @param pages - Ordered stored manifest pages and locators.
 * @returns Exact total data-segment count.
 */
function requireCompleteManifestPageLocators(
  pages: readonly PreparedStoredManifestPage[],
): number {
  let segmentIndex = 0
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    const previousPage = index === 0 ? undefined : pages[index - 1]
    if (
      page === undefined ||
      page.locator.pageIndex !== index ||
      page.locator.pageCount !== pages.length ||
      page.locator.segmentStartIndex !== segmentIndex ||
      page.locator.segmentCount !== page.encodedPage.segments.length ||
      (
        index === 0
          ? page.encodedPage.previousPageReference !== null
          : previousPage === undefined ||
            page.encodedPage.previousPageReference === null ||
            !sameReference(
              page.encodedPage.previousPageReference,
              previousPage.locator.reference,
            )
      )
    ) {
      return failManifest()
    }
    segmentIndex += page.locator.segmentCount
  }
  if (
    segmentIndex === 0 ||
    segmentIndex >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS
  ) {
    return failManifest()
  }
  return segmentIndex
}

/**
 * Reconstructs the original full artifact from complete segment entry streams.
 *
 * @param summary - Exact manifest semantic summary.
 * @param segments - Complete parsed data segments.
 * @returns Candidate full artifact for final strict validation.
 */
function reconstructArtifact(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  segments: readonly WorkspaceSearchMigrationPlanningProvenanceSegment[],
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const evidenceEntries = segments
    .filter(({ role }) => role === 'evidence-pages')
    .flatMap(({ entries }) => entries)
    .map(readEvidenceEntry)
  const receiptEntries = segments
    .filter(({ role }) => role === 'historical-receipts')
    .flatMap(({ entries }) => entries)
    .map(readReceiptEntry)
  if (
    evidenceEntries.length !== summary.evidencePageCount ||
    receiptEntries.length !== summary.historicalReceiptCount
  ) {
    return failManifest()
  }
  const sourceWitnesses:
    Record<WorkspaceSearchMigrationSourceName, string[]> = {
      'project-directory': [],
      'work-items': [],
      collaboration: [],
      documents: [],
    }
  const targetWitnesses: string[] = []
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  for (const entry of evidenceEntries) {
    if (entry.chain === 'workspace-search') {
      targetWitnesses.push(entry.witness)
    } else {
      sourceWitnesses[entry.chain].push(entry.witness)
    }
    authorityTrace.push(entry.authorityTrace)
  }
  const authorityTransitions = receiptEntries.map(
    ({ authorityTransition }) => authorityTransition,
  )
  const historicalReceipts = receiptEntries.map(
    ({ historicalReceipt }) => historicalReceipt,
  )
  const provenanceFields = {
    kind: 'workspace-search-planning-authority-provenance',
    provenanceVersion: 1,
    runId: summary.runId,
    configurationHash: summary.configurationHash,
    stateTableId: summary.tableIds['migration-state'],
    chainRoots: summary.chainRoots,
    authorityTrace,
    authorityTransitions,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAuthorityProvenance,
    'provenanceDigest'
  >
  const provenance:
    WorkspaceSearchMigrationPlanningAuthorityProvenance = {
      ...provenanceFields,
      provenanceDigest: createMigrationDigest(provenanceFields),
    }
  return {
    kind: 'workspace-search-planning-provenance-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: summary.runId,
    configurationHash: summary.configurationHash,
    stateTableId: summary.tableIds['migration-state'],
    tableIds: summary.tableIds,
    evidencePageWitnesses: {
      sources: sourceWitnesses,
      target: targetWitnesses,
    },
    provenance,
    planningSnapshotDigest: summary.planningSnapshotDigest,
    sourceOperationCount: summary.sourceOperationCount,
    orphanOperationCount: summary.orphanOperationCount,
    planOperationCount: summary.planOperationCount,
    historicalReceipts,
    historicalReceiptBindingDigest:
      summary.historicalReceiptBindingDigest,
  }
}

/**
 * Reads direct raw material without constructing the legacy full artifact.
 *
 * @param sourceValue - Four fixed-role canonical source evidence chains.
 * @param targetValue - Canonical target evidence chain.
 * @param bindingValue - Transition-ordered historical receipt bindings.
 * @param maximumTotalSegmentBytes - Reject-only aggregate segment ceiling.
 * @returns Verified semantic material suitable for manifest construction.
 */
function readDirectPlanningProvenanceMaterial(
  sourceValue: unknown,
  targetValue: unknown,
  bindingValue: unknown,
  maximumTotalSegmentBytes: number,
): PlanningProvenanceManifestMaterial {
  const directEvidence = readDirectPlanningEvidence(
    sourceValue,
    targetValue,
    maximumTotalSegmentBytes,
  )
  const verifiedEvidence =
    verifyParsedPlanningEvidencePages(directEvidence.pages)
  const historicalReceipts = readDirectHistoricalReceiptBindings(
    bindingValue,
    verifiedEvidence.provenance,
  )
  return {
    runId: verifiedEvidence.provenance.runId,
    configurationHash:
      verifiedEvidence.provenance.configurationHash,
    tableIds: verifiedEvidence.tableIds,
    evidencePageWitnesses: directEvidence.witnesses,
    provenance: verifiedEvidence.provenance,
    planningSnapshotDigest:
      verifiedEvidence.planningSnapshotDigest,
    sourceOperationCount: verifiedEvidence.sourceOperationCount,
    orphanOperationCount: verifiedEvidence.orphanOperationCount,
    planOperationCount: verifiedEvidence.planOperationCount,
    historicalReceipts,
    historicalReceiptBindingDigest:
      createHistoricalReceiptBindingDigest(
        verifiedEvidence.provenance,
        historicalReceipts,
      ),
  }
}

/**
 * Snapshots and parses five fixed raw evidence chains under one byte budget.
 *
 * @param sourceValue - Four fixed-role source byte arrays.
 * @param targetValue - Target byte array.
 * @param maximumBase64Characters - Early reject-only witness budget.
 * @returns Detached witnesses paired with strict parsed pages.
 */
function readDirectPlanningEvidence(
  sourceValue: unknown,
  targetValue: unknown,
  maximumBase64Characters: number,
): ParsedDirectPlanningEvidence {
  const sourceRecord = requireRecord(sourceValue)
  requireExactKeys(sourceRecord, workspaceSearchMigrationSourceNames)
  const budget: DirectPlanningEvidenceBudget = {
    pageCount: 0,
    base64Characters: 0,
    maximumBase64Characters,
  }
  const projectDirectory = readDirectSourceEvidenceChain(
    readOwn(sourceRecord, 'project-directory'),
    'project-directory',
    budget,
  )
  const workItems = readDirectSourceEvidenceChain(
    readOwn(sourceRecord, 'work-items'),
    'work-items',
    budget,
  )
  const collaboration = readDirectSourceEvidenceChain(
    readOwn(sourceRecord, 'collaboration'),
    'collaboration',
    budget,
  )
  const documents = readDirectSourceEvidenceChain(
    readOwn(sourceRecord, 'documents'),
    'documents',
    budget,
  )
  const target = readDirectTargetEvidenceChain(targetValue, budget)
  return {
    witnesses: {
      sources: {
        'project-directory': projectDirectory.witnesses,
        'work-items': workItems.witnesses,
        collaboration: collaboration.witnesses,
        documents: documents.witnesses,
      },
      target: target.witnesses,
    },
    pages: {
      sources: {
        'project-directory': projectDirectory.pages,
        'work-items': workItems.pages,
        collaboration: collaboration.pages,
        documents: documents.pages,
      },
      target: target.pages,
    },
  }
}

/**
 * Detached witnesses and strict pages from one direct source chain.
 */
type DirectSourceEvidenceChain = {
  /** Canonical Base64 witnesses in exact page order. */
  readonly witnesses: readonly string[]
  /** Strict planning-v3 source pages in exact page order. */
  readonly pages:
    readonly WorkspaceSearchMigrationPlanningSourceEvidencePage[]
}

/**
 * Reads one nonempty canonical planning-v3 source evidence chain.
 *
 * @param value - Candidate dense raw page-byte array.
 * @param source - Required fixed logical source role.
 * @param budget - Shared five-chain page and Base64 budget.
 * @returns Detached canonical witnesses and strict parsed pages.
 */
function readDirectSourceEvidenceChain(
  value: unknown,
  source: WorkspaceSearchMigrationSourceName,
  budget: DirectPlanningEvidenceBudget,
): DirectSourceEvidenceChain {
  const values = requireDenseArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES,
  )
  if (values.length === 0) return failManifest()
  const witnesses: string[] = []
  const pages:
    WorkspaceSearchMigrationPlanningSourceEvidencePage[] = []
  for (let index = 0; index < values.length; index += 1) {
    const bytes = readDetachedUnsharedBytes(
      values[index],
      WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES,
    )
    const witness = Buffer.from(bytes).toString('base64')
    addDirectEvidencePageToBudget(witness.length, budget)
    const page =
      parseWorkspaceSearchMigrationSourceEvidencePage(bytes)
    if (
      page.purpose !== 'planning' ||
      page.evidenceVersion !== 3 ||
      page.source !== source ||
      page.pageSequence !== index + 1
    ) {
      return failManifest()
    }
    witnesses.push(witness)
    pages.push(page)
  }
  return { witnesses, pages }
}

/**
 * Detached witnesses and strict pages from the direct target chain.
 */
type DirectTargetEvidenceChain = {
  /** Canonical Base64 witnesses in exact page order. */
  readonly witnesses: readonly string[]
  /** Strict planning-v1 target pages in exact page order. */
  readonly pages: readonly WorkspaceSearchMigrationTargetEvidencePage[]
}

/**
 * Reads the nonempty canonical planning-v1 target evidence chain.
 *
 * @param value - Candidate dense raw target page-byte array.
 * @param budget - Shared five-chain page and Base64 budget.
 * @returns Detached canonical witnesses and strict parsed target pages.
 */
function readDirectTargetEvidenceChain(
  value: unknown,
  budget: DirectPlanningEvidenceBudget,
): DirectTargetEvidenceChain {
  const values = requireDenseArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES,
  )
  if (values.length === 0) return failManifest()
  const witnesses: string[] = []
  const pages: WorkspaceSearchMigrationTargetEvidencePage[] = []
  for (let index = 0; index < values.length; index += 1) {
    const bytes = readDetachedUnsharedBytes(
      values[index],
      WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES,
    )
    const witness = Buffer.from(bytes).toString('base64')
    addDirectEvidencePageToBudget(witness.length, budget)
    const page =
      parseWorkspaceSearchMigrationTargetEvidencePage(bytes)
    if (page.pageSequence !== index + 1) return failManifest()
    witnesses.push(witness)
    pages.push(page)
  }
  return { witnesses, pages }
}

/**
 * Accounts for one direct witness before retaining or deeply replaying it.
 *
 * @param base64Characters - Exact canonical Base64 character count.
 * @param budget - Shared mutable five-chain budget.
 */
function addDirectEvidencePageToBudget(
  base64Characters: number,
  budget: DirectPlanningEvidenceBudget,
): void {
  budget.pageCount = addSafeCounts(budget.pageCount, 1)
  budget.base64Characters = addSafeCounts(
    budget.base64Characters,
    base64Characters,
  )
  if (
    budget.pageCount >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES ||
    budget.base64Characters > budget.maximumBase64Characters
  ) {
    return failManifest()
  }
}

/**
 * Reads direct durable receipt bindings against derived authority transitions.
 *
 * @param value - Candidate transition-ordered binding array.
 * @param provenance - Exact authority provenance derived from raw pages.
 * @returns Detached verified historical receipts.
 */
function readDirectHistoricalReceiptBindings(
  value: unknown,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
): readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[] {
  const values = requireDenseArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS,
  )
  if (values.length !== provenance.authorityTransitions.length) {
    return failManifest()
  }
  return values.map((candidate, index) => {
    const transition = provenance.authorityTransitions[index]
    if (transition === undefined) return failManifest()
    return readDirectHistoricalReceiptBinding(
      candidate,
      provenance,
      transition,
    )
  })
}

/**
 * Reads one durable receipt binding without applying present-time freshness.
 *
 * @param value - Candidate durable historical binding.
 * @param provenance - Exact owning authority provenance.
 * @param transition - Exact transition at the same ordered index.
 * @returns Detached verified historical receipt.
 */
function readDirectHistoricalReceiptBinding(
  value: unknown,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  transition: WorkspaceSearchMigrationPlanningAuthorityTransition,
): WorkspaceSearchMigrationVerifiedHistoricalReceipt {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'ownerId',
    'receipt',
    'receiptDigest',
    'stateTableId',
  ])
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const stateTableId = readBoundedText(
    readOwn(record, 'stateTableId'),
    1_024,
  )
  const ownerId = readIdentifier(readOwn(record, 'ownerId'))
  const receiptDigest = readDigest(readOwn(record, 'receiptDigest'))
  const receipt = readMaintenanceReceipt(readOwn(record, 'receipt'))
  if (
    configurationHash !== provenance.configurationHash ||
    stateTableId !== provenance.stateTableId ||
    ownerId !== transition.ownerId ||
    receiptDigest !== transition.maintenanceEvidenceReceiptDigest ||
    receipt.runId !== provenance.runId ||
    receipt.fenceToken !== transition.fenceToken ||
    createMigrationDigest(receipt) !== receiptDigest
  ) {
    return failManifest()
  }
  return { ownerId, receiptDigest, receipt }
}

/**
 * Strictly projects one existing full provenance artifact without importing its
 * runtime codec, preventing a runtime dependency cycle.
 *
 * @param value - Candidate previously verified full artifact.
 * @returns Detached artifact preserving identical semantic fields.
 */
function readPlanningProvenanceArtifact(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'artifactVersion',
    'configurationHash',
    'evidencePageWitnesses',
    'historicalReceiptBindingDigest',
    'historicalReceipts',
    'kind',
    'migrationId',
    'migrationVersion',
    'orphanOperationCount',
    'planOperationCount',
    'planningSnapshotDigest',
    'provenance',
    'runId',
    'sourceOperationCount',
    'stateTableId',
    'tableIds',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-artifact' ||
    readOwn(record, 'artifactVersion') !== 1 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failManifest()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const stateTableId = readBoundedText(readOwn(record, 'stateTableId'), 1_024)
  const tableIds = readTableIds(readOwn(record, 'tableIds'))
  if (tableIds['migration-state'] !== stateTableId) {
    return failManifest()
  }
  const evidencePageWitnesses = readEvidencePageWitnesses(
    readOwn(record, 'evidencePageWitnesses'),
  )
  const verifiedEvidence =
    verifyPlanningEvidencePageWitnesses(evidencePageWitnesses)
  const provenance = readProvenance(
    readOwn(record, 'provenance'),
    evidencePageWitnesses,
    runId,
    configurationHash,
    stateTableId,
  )
  const planningSnapshotDigest = readDigest(
    readOwn(record, 'planningSnapshotDigest'),
  )
  const sourceOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'sourceOperationCount'),
    maximumPlannedOperationCount,
  )
  const orphanOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'orphanOperationCount'),
    maximumPlannedOperationCount,
  )
  const planOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
    maximumPlannedOperationCount,
  )
  if (
    runId !== verifiedEvidence.provenance.runId ||
    configurationHash !==
      verifiedEvidence.provenance.configurationHash ||
    stateTableId !== verifiedEvidence.provenance.stateTableId ||
    !sameTableIds(tableIds, verifiedEvidence.tableIds) ||
    provenance.provenanceDigest !==
      verifiedEvidence.provenance.provenanceDigest ||
    planningSnapshotDigest !==
      verifiedEvidence.planningSnapshotDigest ||
    sourceOperationCount !== verifiedEvidence.sourceOperationCount ||
    orphanOperationCount !== verifiedEvidence.orphanOperationCount ||
    planOperationCount !== verifiedEvidence.planOperationCount ||
    planOperationCount > maximumPlannedOperationCount ||
    sourceOperationCount + orphanOperationCount !== planOperationCount ||
    !Number.isSafeInteger(planOperationCount)
  ) {
    return failManifest()
  }
  const historicalReceipts = readHistoricalReceipts(
    readOwn(record, 'historicalReceipts'),
    provenance,
  )
  const historicalReceiptBindingDigest = readDigest(
    readOwn(record, 'historicalReceiptBindingDigest'),
  )
  if (
    historicalReceiptBindingDigest !==
      createHistoricalReceiptBindingDigest(provenance, historicalReceipts)
  ) {
    return failManifest()
  }
  return {
    kind: 'workspace-search-planning-provenance-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    stateTableId,
    tableIds,
    evidencePageWitnesses,
    provenance,
    planningSnapshotDigest,
    sourceOperationCount,
    orphanOperationCount,
    planOperationCount,
    historicalReceipts,
    historicalReceiptBindingDigest,
  }
}

/**
 * Reads the fixed-role witness bundle and canonical Base64 entry bytes.
 *
 * @param value - Candidate witness bundle.
 * @returns Detached fixed-role witness arrays.
 */
function readEvidencePageWitnesses(
  value: unknown,
): WorkspaceSearchMigrationPlanningEvidencePageWitnesses {
  const record = requireRecord(value)
  requireExactKeys(record, ['sources', 'target'])
  const sourcesRecord = requireRecord(readOwn(record, 'sources'))
  requireExactKeys(sourcesRecord, workspaceSearchMigrationSourceNames)
  const readChain = (chainValue: unknown): readonly string[] =>
    requireDenseArray(
      chainValue,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES,
    ).map(readCanonicalBase64)
  const sources = {
    'project-directory': readChain(
      readOwn(sourcesRecord, 'project-directory'),
    ),
    'work-items': readChain(readOwn(sourcesRecord, 'work-items')),
    collaboration: readChain(readOwn(sourcesRecord, 'collaboration')),
    documents: readChain(readOwn(sourcesRecord, 'documents')),
  }
  const target = readChain(readOwn(record, 'target'))
  const pageCount = workspaceSearchMigrationSourceNames.reduce(
    (total, source) => total + sources[source].length,
    target.length,
  )
  if (
    pageCount === 0 ||
    pageCount >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES ||
    workspaceSearchMigrationSourceNames.some(
      (source) => sources[source].length === 0,
    ) ||
    target.length === 0
  ) {
    return failManifest()
  }
  return { sources, target }
}

/**
 * Parses every retained witness as its exact canonical evidence-page schema and
 * independently replays all five chains to derive planning semantics.
 *
 * @param witnesses - Strict canonical Base64 evidence-page witnesses.
 * @returns Table identities, provenance, snapshot digest, and operation counts.
 */
function verifyPlanningEvidencePageWitnesses(
  witnesses: WorkspaceSearchMigrationPlanningEvidencePageWitnesses,
): VerifiedPlanningEvidenceSemantics {
  const sources = {
    'project-directory': parseSourceWitnessChain(
      witnesses.sources['project-directory'],
      'project-directory',
    ),
    'work-items': parseSourceWitnessChain(
      witnesses.sources['work-items'],
      'work-items',
    ),
    collaboration: parseSourceWitnessChain(
      witnesses.sources.collaboration,
      'collaboration',
    ),
    documents: parseSourceWitnessChain(
      witnesses.sources.documents,
      'documents',
    ),
  }
  const target = witnesses.target.map((witness, index) => {
    const page = parseWorkspaceSearchMigrationTargetEvidencePage(
      decodeCanonicalBase64(witness),
    )
    if (page.pageSequence !== index + 1) return failManifest()
    return page
  })
  return verifyParsedPlanningEvidencePages({ sources, target })
}

/**
 * Parses one complete source witness chain under its fixed logical role.
 *
 * @param witnesses - Ordered canonical source-page witnesses.
 * @param source - Required logical source role.
 * @returns Strict parsed source planning pages.
 */
function parseSourceWitnessChain(
  witnesses: readonly string[],
  source: WorkspaceSearchMigrationSourceName,
): readonly WorkspaceSearchMigrationPlanningSourceEvidencePage[] {
  return witnesses.map((witness, index) => {
    const page = parseWorkspaceSearchMigrationSourceEvidencePage(
      decodeCanonicalBase64(witness),
    )
    if (
      page.purpose !== 'planning' ||
      page.evidenceVersion !== 3 ||
      page.source !== source ||
      page.pageSequence !== index + 1
    ) {
      return failManifest()
    }
    return page
  })
}

/**
 * Replays strict source and target pages and derives all semantics retained by
 * the full planning provenance artifact.
 *
 * @param evidencePages - Complete strict source and target page chains.
 * @returns Independently derived artifact semantics.
 */
function verifyParsedPlanningEvidencePages(
  evidencePages: ParsedPlanningEvidencePages,
): VerifiedPlanningEvidenceSemantics {
  const anchor = evidencePages.sources['project-directory'][0]
  if (anchor === undefined) return failManifest()
  const runId = anchor.runId
  const configurationHash = anchor.configurationHash
  const stateTableId = anchor.stateTableId
  const chainRoots:
    WorkspaceSearchMigrationPlanningEvidenceChainRoot[] = []
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  const sourceAggregates:
    Partial<Record<WorkspaceSearchMigrationSourceName, MigrationScanAggregate>> =
      {}
  const sourceTableIds:
    Partial<Record<WorkspaceSearchMigrationSourceName, string>> = {}
  const sourceActionByTargetDigest = new Map<string, 'delete' | 'put'>()
  let sourceOperationCount = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    const pages = evidencePages.sources[source]
    const first = pages[0]
    if (
      first === undefined ||
      first.runId !== runId ||
      first.configurationHash !== configurationHash ||
      first.stateTableId !== stateTableId
    ) {
      return failManifest()
    }
    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      {
        purpose: 'planning',
        runId,
        configurationHash,
        source,
        sourceTableId: first.sourceTableId,
        stateTableId,
      },
      pages,
    )
    if (
      !replay.progress.checkpoint.completed ||
      replay.progress.checkpoint.cursor !== undefined ||
      replay.progress.checkpoint.aggregate.invalid !== 0
    ) {
      return failManifest()
    }
    const progress = replay.progress
    chainRoots.push({
      chain: source,
      pageCount: progress.pageSequence,
      terminalEvidenceDigest: progress.evidenceDigest,
      terminalCheckpointDigest:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.checkpoint,
        ),
    })
    sourceAggregates[source] = progress.checkpoint.aggregate
    sourceTableIds[source] = first.sourceTableId
    for (const page of pages) {
      authorityTrace.push({
        chain: source,
        pageSequence: page.pageSequence,
        evidenceDigest:
          createWorkspaceSearchMigrationSourceEvidencePageDigest(page),
        ownerId: page.planningAuthority.ownerId,
        fenceToken: page.planningAuthority.fenceToken,
        maintenanceEvidencePointerRevision:
          page.planningAuthority.maintenanceEvidencePointerRevision,
        maintenanceEvidenceReceiptDigest:
          page.planningAuthority.maintenanceEvidenceReceiptDigest,
      })
    }
    sourceOperationCount = addSafeCounts(
      sourceOperationCount,
      replay.sourceBindings.length,
    )
    for (const binding of replay.sourceBindings) {
      if (sourceActionByTargetDigest.has(binding.targetKeyDigest)) {
        return failManifest()
      }
      sourceActionByTargetDigest.set(
        binding.targetKeyDigest,
        binding.targetAction,
      )
    }
  }
  const firstTarget = evidencePages.target[0]
  if (
    firstTarget === undefined ||
    firstTarget.runId !== runId ||
    firstTarget.configurationHash !== configurationHash ||
    firstTarget.stateTableId !== stateTableId
  ) {
    return failManifest()
  }
  const targetReplay = replayWorkspaceSearchMigrationTargetEvidencePages(
    {
      purpose: 'planning',
      runId,
      configurationHash,
      targetTableId: firstTarget.targetTableId,
      stateTableId,
    },
    evidencePages.target,
  )
  if (
    !targetReplay.progress.checkpoint.completed ||
    targetReplay.progress.checkpoint.cursor !== undefined ||
    targetReplay.progress.checkpoint.aggregate.invalid !== 0
  ) {
    return failManifest()
  }
  const targetProgress = targetReplay.progress
  chainRoots.push({
    chain: 'workspace-search',
    pageCount: targetProgress.pageSequence,
    terminalEvidenceDigest: targetProgress.evidenceDigest,
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationTargetCheckpointDigest(
        targetProgress.checkpoint,
      ),
  })
  for (const page of evidencePages.target) {
    authorityTrace.push({
      chain: 'workspace-search',
      pageSequence: page.pageSequence,
      evidenceDigest:
        createWorkspaceSearchMigrationTargetEvidencePageDigest(page),
      ownerId: page.planningAuthority.ownerId,
      fenceToken: page.planningAuthority.fenceToken,
      maintenanceEvidencePointerRevision:
        page.planningAuthority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        page.planningAuthority.maintenanceEvidenceReceiptDigest,
    })
  }
  const observedTargetDigests = new Set<string>()
  let projectedTargetCount = 0
  let orphanOperationCount = 0
  for (const binding of targetReplay.observedTargetBindings) {
    if (observedTargetDigests.has(binding.targetKeyDigest)) {
      return failManifest()
    }
    observedTargetDigests.add(binding.targetKeyDigest)
    const sourceAction = sourceActionByTargetDigest.get(
      binding.targetKeyDigest,
    )
    if (sourceAction === undefined) {
      orphanOperationCount = addSafeCounts(orphanOperationCount, 1)
    } else if (sourceAction === 'put') {
      projectedTargetCount = addSafeCounts(projectedTargetCount, 1)
    }
  }
  for (const row of targetReplay.targetRows) {
    if (
      row.classification === 'ignored' &&
      sourceActionByTargetDigest.has(row.targetKeyDigest)
    ) {
      return failManifest()
    }
  }
  const planOperationCount = addSafeCounts(
    sourceOperationCount,
    orphanOperationCount,
  )
  if (
    planOperationCount > maximumPlannedOperationCount ||
    targetReplay.observedTargetBindings.length !==
      targetProgress.checkpoint.aggregate.owned
  ) {
    return failManifest()
  }
  const projectDirectoryAggregate =
    sourceAggregates['project-directory']
  const workItemsAggregate = sourceAggregates['work-items']
  const collaborationAggregate = sourceAggregates.collaboration
  const documentsAggregate = sourceAggregates.documents
  const projectDirectoryTableId =
    sourceTableIds['project-directory']
  const workItemsTableId = sourceTableIds['work-items']
  const collaborationTableId = sourceTableIds.collaboration
  const documentsTableId = sourceTableIds.documents
  if (
    projectDirectoryAggregate === undefined ||
    workItemsAggregate === undefined ||
    collaborationAggregate === undefined ||
    documentsAggregate === undefined ||
    projectDirectoryTableId === undefined ||
    workItemsTableId === undefined ||
    collaborationTableId === undefined ||
    documentsTableId === undefined
  ) {
    return failManifest()
  }
  const targetAggregate = targetProgress.checkpoint.aggregate
  const scanSnapshot: WorkspaceSearchMigrationScanSnapshot = {
    configurationHash,
    sources: {
      'project-directory': projectDirectoryAggregate,
      'work-items': workItemsAggregate,
      collaboration: collaborationAggregate,
      documents: documentsAggregate,
    },
    target: {
      scanned: targetAggregate.scanned,
      mapped: targetAggregate.owned,
      ignored: targetAggregate.ignored,
      invalid: targetAggregate.invalid,
      projected: projectedTargetCount,
      deleted:
        targetReplay.observedTargetBindings.length -
        projectedTargetCount,
      keyDigest: targetAggregate.keyDigest,
      contentDigest: targetAggregate.contentDigest,
      pageCount: targetAggregate.pageCount,
    },
  }
  const authorityTransitions =
    derivePlanningAuthorityTransitions(authorityTrace)
  const provenanceFields = {
    kind: 'workspace-search-planning-authority-provenance',
    provenanceVersion: 1,
    runId,
    configurationHash,
    stateTableId,
    chainRoots,
    authorityTrace,
    authorityTransitions,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAuthorityProvenance,
    'provenanceDigest'
  >
  return {
    tableIds: readTableIds({
      'project-directory': projectDirectoryTableId,
      'work-items': workItemsTableId,
      collaboration: collaborationTableId,
      documents: documentsTableId,
      'workspace-search': firstTarget.targetTableId,
      'migration-state': stateTableId,
    }),
    provenance: {
      ...provenanceFields,
      provenanceDigest: createMigrationDigest(provenanceFields),
    },
    planningSnapshotDigest:
      createWorkspaceSearchMigrationScanSnapshotDigest(scanSnapshot),
    sourceOperationCount,
    orphanOperationCount,
    planOperationCount,
  }
}

/**
 * Reads and correlates complete authority provenance with witness order.
 *
 * @param value - Candidate provenance document.
 * @param witnesses - Exact retained page witnesses.
 * @param runId - Required run identifier.
 * @param configurationHash - Required configuration digest.
 * @param stateTableId - Required migration-state incarnation.
 * @returns Detached strict provenance.
 */
function readProvenance(
  value: unknown,
  witnesses: WorkspaceSearchMigrationPlanningEvidencePageWitnesses,
  runId: string,
  configurationHash: string,
  stateTableId: string,
): WorkspaceSearchMigrationPlanningAuthorityProvenance {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authorityTrace',
    'authorityTransitions',
    'chainRoots',
    'configurationHash',
    'kind',
    'provenanceDigest',
    'provenanceVersion',
    'runId',
    'stateTableId',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-authority-provenance' ||
    readOwn(record, 'provenanceVersion') !== 1 ||
    readOwn(record, 'runId') !== runId ||
    readOwn(record, 'configurationHash') !== configurationHash ||
    readOwn(record, 'stateTableId') !== stateTableId
  ) {
    return failManifest()
  }
  const rootValues = requireDenseArray(
    readOwn(record, 'chainRoots'),
    planningChainOrder.length,
  )
  if (rootValues.length !== planningChainOrder.length) {
    return failManifest()
  }
  const chainRoots = rootValues.map((candidate, index) => {
    const chain = planningChainOrder[index]
    if (chain === undefined) return failManifest()
    return readChainRoot(candidate, chain)
  })
  const traceValues = requireDenseArray(
    readOwn(record, 'authorityTrace'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES,
  )
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  let traceIndex = 0
  for (let chainIndex = 0; chainIndex < planningChainOrder.length; chainIndex += 1) {
    const chain = planningChainOrder[chainIndex]
    const root = chainRoots[chainIndex]
    if (chain === undefined || root === undefined) return failManifest()
    const chainWitnesses = chain === 'workspace-search'
      ? witnesses.target
      : witnesses.sources[chain]
    if (root.pageCount !== chainWitnesses.length) return failManifest()
    for (let pageIndex = 0; pageIndex < chainWitnesses.length; pageIndex += 1) {
      const trace = readTraceEntry(
        traceValues[traceIndex],
        chain,
        pageIndex + 1,
      )
      const witness = chainWitnesses[pageIndex]
      if (
        witness === undefined ||
        digestBytes(decodeCanonicalBase64(witness)) !==
          trace.evidenceDigest
      ) {
        return failManifest()
      }
      authorityTrace.push(trace)
      traceIndex += 1
    }
    const terminalTrace = authorityTrace[traceIndex - 1]
    if (
      terminalTrace === undefined ||
      terminalTrace.evidenceDigest !== root.terminalEvidenceDigest
    ) {
      return failManifest()
    }
  }
  if (traceIndex !== traceValues.length) return failManifest()
  const authorityTransitions =
    derivePlanningAuthorityTransitions(authorityTrace)
  const transitionValues = requireDenseArray(
    readOwn(record, 'authorityTransitions'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS,
  )
  if (transitionValues.length !== authorityTransitions.length) {
    return failManifest()
  }
  for (let index = 0; index < transitionValues.length; index += 1) {
    const expected = authorityTransitions[index]
    const actual = readTransition(transitionValues[index])
    if (expected === undefined || !sameTransition(expected, actual)) {
      return failManifest()
    }
  }
  const provenanceFields = {
    kind: 'workspace-search-planning-authority-provenance',
    provenanceVersion: 1,
    runId,
    configurationHash,
    stateTableId,
    chainRoots,
    authorityTrace,
    authorityTransitions,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAuthorityProvenance,
    'provenanceDigest'
  >
  const provenanceDigest = readDigest(
    readOwn(record, 'provenanceDigest'),
  )
  if (provenanceDigest !== createMigrationDigest(provenanceFields)) {
    return failManifest()
  }
  return { ...provenanceFields, provenanceDigest }
}

/**
 * Reads transition-ordered historical receipts and verifies their bindings.
 *
 * @param value - Candidate historical receipt array.
 * @param provenance - Exact owning provenance.
 * @returns Detached verified historical receipts.
 */
function readHistoricalReceipts(
  value: unknown,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
): readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[] {
  const values = requireDenseArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS,
  )
  if (values.length !== provenance.authorityTransitions.length) {
    return failManifest()
  }
  return values.map((candidate, index) => {
    const transition = provenance.authorityTransitions[index]
    if (transition === undefined) return failManifest()
    return readHistoricalReceipt(candidate, provenance, transition)
  })
}

/**
 * Reads one exact historical receipt and verifies its authority transition.
 *
 * @param value - Candidate verified historical receipt.
 * @param provenance - Exact owning provenance.
 * @param transition - Exact transition at the same ordered index.
 * @returns Detached verified historical receipt.
 */
function readHistoricalReceipt(
  value: unknown,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  transition: WorkspaceSearchMigrationPlanningAuthorityTransition,
): WorkspaceSearchMigrationVerifiedHistoricalReceipt {
  const record = requireRecord(value)
  requireExactKeys(record, ['ownerId', 'receipt', 'receiptDigest'])
  const ownerId = readIdentifier(readOwn(record, 'ownerId'))
  const receiptDigest = readDigest(readOwn(record, 'receiptDigest'))
  const receipt = readMaintenanceReceipt(readOwn(record, 'receipt'))
  if (
    ownerId !== transition.ownerId ||
    receiptDigest !== transition.maintenanceEvidenceReceiptDigest ||
    receipt.runId !== provenance.runId ||
    receipt.fenceToken !== transition.fenceToken ||
    createMigrationDigest(receipt) !== receiptDigest
  ) {
    return failManifest()
  }
  return { ownerId, receiptDigest, receipt }
}

/**
 * Reads one strict historical maintenance receipt without freshness checks.
 *
 * @param value - Candidate receipt payload.
 * @returns Detached strict receipt.
 */
function readMaintenanceReceipt(
  value: unknown,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
    runId: readIdentifier(readOwn(record, 'runId')),
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    evidenceLocator: readBoundedText(
      readOwn(record, 'evidenceLocator'),
      maximumReferenceTextLength,
    ),
    runtimeRevision: readPositiveSafeInteger(
      readOwn(record, 'runtimeRevision'),
    ),
    fenceToken: readPositiveSafeInteger(readOwn(record, 'fenceToken')),
    validatedAt: readTimestamp(readOwn(record, 'validatedAt')),
    oldestObservationAt: readTimestamp(
      readOwn(record, 'oldestObservationAt'),
    ),
    validUntil: readTimestamp(readOwn(record, 'validUntil')),
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    receipt.runId,
  )
  return receipt
}

/**
 * Computes the historical receipt binding digest used by the full artifact.
 *
 * @param provenance - Exact owning provenance.
 * @param receipts - Exact transition-ordered historical receipts.
 * @returns Lowercase SHA-256 binding digest.
 */
function createHistoricalReceiptBindingDigest(
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  receipts: readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[],
): string {
  return createMigrationDigest({
    kind: 'workspace-search-planning-historical-receipt-bindings',
    bindingVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: provenance.runId,
    configurationHash: provenance.configurationHash,
    stateTableId: provenance.stateTableId,
    receipts,
  })
}

/**
 * Reads one exact chain root at its required canonical role position.
 *
 * @param value - Candidate chain root.
 * @param expectedChain - Required fixed chain role.
 * @returns Detached strict chain root.
 */
function readChainRoot(
  value: unknown,
  expectedChain: WorkspaceSearchMigrationPlanningEvidenceChainRole,
): WorkspaceSearchMigrationPlanningEvidenceChainRoot {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'chain',
    'pageCount',
    'terminalCheckpointDigest',
    'terminalEvidenceDigest',
  ])
  if (readOwn(record, 'chain') !== expectedChain) return failManifest()
  return {
    chain: expectedChain,
    pageCount: readPositiveSafeInteger(readOwn(record, 'pageCount')),
    terminalEvidenceDigest: readDigest(
      readOwn(record, 'terminalEvidenceDigest'),
    ),
    terminalCheckpointDigest: readDigest(
      readOwn(record, 'terminalCheckpointDigest'),
    ),
  }
}

/**
 * Reads one authority trace entry at its exact chain and page position.
 *
 * @param value - Candidate trace entry.
 * @param expectedChain - Required chain role.
 * @param expectedPageSequence - Required one-based page position.
 * @returns Detached strict trace entry.
 */
function readTraceEntry(
  value: unknown,
  expectedChain: WorkspaceSearchMigrationPlanningEvidenceChainRole,
  expectedPageSequence: number,
): WorkspaceSearchMigrationPlanningAuthorityTraceEntry {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'chain',
    'evidenceDigest',
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
    'pageSequence',
  ])
  if (
    readOwn(record, 'chain') !== expectedChain ||
    readOwn(record, 'pageSequence') !== expectedPageSequence
  ) {
    return failManifest()
  }
  return {
    chain: expectedChain,
    pageSequence: expectedPageSequence,
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(readOwn(record, 'fenceToken')),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
  }
}

/**
 * Reads one exact authority transition.
 *
 * @param value - Candidate transition.
 * @returns Detached strict transition.
 */
function readTransition(
  value: unknown,
): WorkspaceSearchMigrationPlanningAuthorityTransition {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(readOwn(record, 'fenceToken')),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
  }
}

/**
 * Reconstructs unique monotonic transitions from chain/page-ordered trace.
 *
 * @param trace - Complete canonical authority trace.
 * @returns Unique transitions ordered by pointer revision.
 */
function derivePlanningAuthorityTransitions(
  trace: readonly WorkspaceSearchMigrationPlanningAuthorityTraceEntry[],
): readonly WorkspaceSearchMigrationPlanningAuthorityTransition[] {
  const previousByChain = new Map<
    WorkspaceSearchMigrationPlanningEvidenceChainRole,
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry
  >()
  const transitionByRevision = new Map<
    number,
    WorkspaceSearchMigrationPlanningAuthorityTransition
  >()
  const ownerByFence = new Map<number, string>()
  const revisionByReceipt = new Map<string, number>()
  for (const entry of trace) {
    const previous = previousByChain.get(entry.chain)
    if (
      previous !== undefined &&
      (
        entry.fenceToken < previous.fenceToken ||
        entry.maintenanceEvidencePointerRevision <
          previous.maintenanceEvidencePointerRevision ||
        entry.fenceToken === previous.fenceToken &&
          entry.ownerId !== previous.ownerId ||
        entry.fenceToken > previous.fenceToken &&
          entry.maintenanceEvidencePointerRevision <=
            previous.maintenanceEvidencePointerRevision
      )
    ) {
      return failManifest()
    }
    previousByChain.set(entry.chain, entry)
    const transition:
      WorkspaceSearchMigrationPlanningAuthorityTransition = {
        ownerId: entry.ownerId,
        fenceToken: entry.fenceToken,
        maintenanceEvidencePointerRevision:
          entry.maintenanceEvidencePointerRevision,
        maintenanceEvidenceReceiptDigest:
          entry.maintenanceEvidenceReceiptDigest,
      }
    const existing = transitionByRevision.get(
      transition.maintenanceEvidencePointerRevision,
    )
    if (existing !== undefined && !sameTransition(existing, transition)) {
      return failManifest()
    }
    transitionByRevision.set(
      transition.maintenanceEvidencePointerRevision,
      transition,
    )
    const existingOwner = ownerByFence.get(transition.fenceToken)
    if (
      existingOwner !== undefined &&
      existingOwner !== transition.ownerId
    ) {
      return failManifest()
    }
    ownerByFence.set(transition.fenceToken, transition.ownerId)
    const existingRevision = revisionByReceipt.get(
      transition.maintenanceEvidenceReceiptDigest,
    )
    if (
      existingRevision !== undefined &&
      existingRevision !==
        transition.maintenanceEvidencePointerRevision
    ) {
      return failManifest()
    }
    revisionByReceipt.set(
      transition.maintenanceEvidenceReceiptDigest,
      transition.maintenanceEvidencePointerRevision,
    )
  }
  const transitions = [...transitionByRevision.values()].sort(
    compareTransitions,
  )
  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1]
    const current = transitions[index]
    if (
      previous === undefined ||
      current === undefined ||
      current.fenceToken < previous.fenceToken
    ) {
      return failManifest()
    }
  }
  if (transitions.length === 0) return failManifest()
  return transitions
}

/**
 * Reads one strict data segment.
 *
 * @param value - Candidate parsed segment document.
 * @returns Detached strict segment.
 */
function readSegment(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceSegment {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'entries',
    'entryCount',
    'entryStartIndex',
    'kind',
    'role',
    'segmentCount',
    'segmentDigest',
    'segmentIndex',
    'segmentVersion',
    'summary',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-segment' ||
    readOwn(record, 'segmentVersion') !== 1
  ) {
    return failManifest()
  }
  const summary = readSummary(readOwn(record, 'summary'))
  const role = readSegmentRole(readOwn(record, 'role'))
  const segmentIndex = readNonNegativeSafeInteger(
    readOwn(record, 'segmentIndex'),
  )
  const segmentCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'segmentCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  )
  const entryStartIndex = readNonNegativeSafeInteger(
    readOwn(record, 'entryStartIndex'),
  )
  const entries = requireDenseArray(
    readOwn(record, 'entries'),
    role === 'evidence-pages'
      ? WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES
      : WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS,
  ).map((candidate) =>
    role === 'evidence-pages'
      ? readEvidenceEntry(candidate)
      : readReceiptEntry(candidate)
  )
  const entryCount = readPositiveSafeInteger(
    readOwn(record, 'entryCount'),
  )
  if (
    segmentIndex >= segmentCount ||
    entryCount !== entries.length
  ) {
    return failManifest()
  }
  const segmentFields = {
    kind: 'workspace-search-planning-provenance-segment',
    segmentVersion: 1,
    summary,
    role,
    segmentIndex,
    segmentCount,
    entryStartIndex,
    entryCount,
    entries,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceSegment,
    'segmentDigest'
  >
  const segmentDigest = readDigest(readOwn(record, 'segmentDigest'))
  if (segmentDigest !== createMigrationDigest(segmentFields)) {
    return failManifest()
  }
  return { ...segmentFields, segmentDigest }
}

/**
 * Reads one strict evidence segment entry.
 *
 * @param value - Candidate segment entry.
 * @returns Detached evidence entry.
 */
function readEvidenceEntry(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceEvidenceEntry {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authorityTrace',
    'chain',
    'kind',
    'pageSequence',
    'witness',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-evidence-entry'
  ) {
    return failManifest()
  }
  const chain = readChainRole(readOwn(record, 'chain'))
  const pageSequence = readPositiveSafeInteger(
    readOwn(record, 'pageSequence'),
  )
  const witness = readCanonicalBase64(readOwn(record, 'witness'))
  const authorityTrace = readTraceEntry(
    readOwn(record, 'authorityTrace'),
    chain,
    pageSequence,
  )
  if (
    digestBytes(decodeCanonicalBase64(witness)) !==
      authorityTrace.evidenceDigest
  ) {
    return failManifest()
  }
  return {
    kind: 'workspace-search-planning-provenance-evidence-entry',
    chain,
    pageSequence,
    witness,
    authorityTrace,
  }
}

/**
 * Reads one strict historical-receipt segment entry.
 *
 * @param value - Candidate segment entry.
 * @returns Detached receipt entry.
 */
function readReceiptEntry(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceReceiptEntry {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authorityTransition',
    'historicalReceipt',
    'kind',
    'transitionIndex',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-receipt-entry'
  ) {
    return failManifest()
  }
  const authorityTransition = readTransition(
    readOwn(record, 'authorityTransition'),
  )
  const historicalReceiptRecord = requireRecord(
    readOwn(record, 'historicalReceipt'),
  )
  requireExactKeys(historicalReceiptRecord, [
    'ownerId',
    'receipt',
    'receiptDigest',
  ])
  const ownerId = readIdentifier(
    readOwn(historicalReceiptRecord, 'ownerId'),
  )
  const receiptDigest = readDigest(
    readOwn(historicalReceiptRecord, 'receiptDigest'),
  )
  const receipt = readMaintenanceReceipt(
    readOwn(historicalReceiptRecord, 'receipt'),
  )
  if (
    ownerId !== authorityTransition.ownerId ||
    receiptDigest !==
      authorityTransition.maintenanceEvidenceReceiptDigest ||
    receipt.fenceToken !== authorityTransition.fenceToken ||
    createMigrationDigest(receipt) !== receiptDigest
  ) {
    return failManifest()
  }
  return {
    kind: 'workspace-search-planning-provenance-receipt-entry',
    transitionIndex: readNonNegativeSafeInteger(
      readOwn(record, 'transitionIndex'),
    ),
    authorityTransition,
    historicalReceipt: { ownerId, receiptDigest, receipt },
  }
}

/**
 * Reads one strict bounded manifest page.
 *
 * @param value - Candidate parsed manifest page.
 * @returns Detached strict manifest page.
 */
function readManifestPage(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceManifestPage {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'kind',
    'manifestPageVersion',
    'pageCount',
    'pageDigest',
    'pageIndex',
    'previousPageReference',
    'segmentCount',
    'segmentStartIndex',
    'segments',
    'summary',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-manifest-page' ||
    readOwn(record, 'manifestPageVersion') !== 1
  ) {
    return failManifest()
  }
  const summary = readSummary(readOwn(record, 'summary'))
  const pageIndex = readNonNegativeSafeInteger(
    readOwn(record, 'pageIndex'),
  )
  const pageCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'pageCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  )
  const segmentStartIndex = readNonNegativeSafeInteger(
    readOwn(record, 'segmentStartIndex'),
  )
  const segments = requireDenseArray(
    readOwn(record, 'segments'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  ).map((candidate) =>
    readSegmentLocator(candidate, summary.objectKeyPrefix)
  )
  const segmentCount = readPositiveSafeInteger(
    readOwn(record, 'segmentCount'),
  )
  const previousPageReferenceValue =
    readOwn(record, 'previousPageReference')
  const previousPageReference =
    previousPageReferenceValue === null
      ? null
      : readReference(
        previousPageReferenceValue,
        summary.objectKeyPrefix,
        'manifest-pages',
      )
  if (
    pageIndex >= pageCount ||
    (pageIndex === 0) !== (previousPageReference === null) ||
    segmentCount !== segments.length ||
    segments.some(
      (segment, index) =>
        segment.segmentIndex !== segmentStartIndex + index,
    )
  ) {
    return failManifest()
  }
  const pageFields = {
    kind: 'workspace-search-planning-provenance-manifest-page',
    manifestPageVersion: 1,
    summary,
    pageIndex,
    pageCount,
    segmentStartIndex,
    segmentCount,
    segments,
    previousPageReference,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceManifestPage,
    'pageDigest'
  >
  const pageDigest = readDigest(readOwn(record, 'pageDigest'))
  if (pageDigest !== createMigrationDigest(pageFields)) {
    return failManifest()
  }
  return { ...pageFields, pageDigest }
}

/**
 * Reads one compact data-segment locator.
 *
 * @param value - Candidate locator.
 * @param objectKeyPrefix - Required immutable-artifact key prefix.
 * @returns Detached strict segment locator.
 */
function readSegmentLocator(
  value: unknown,
  objectKeyPrefix: string,
): WorkspaceSearchMigrationPlanningProvenanceSegmentLocator {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'entryCount',
    'entryStartIndex',
    'reference',
    'role',
    'segmentCount',
    'segmentDigest',
    'segmentIndex',
  ])
  const segmentCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'segmentCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  )
  const segmentIndex = readNonNegativeSafeInteger(
    readOwn(record, 'segmentIndex'),
  )
  if (segmentIndex >= segmentCount) return failManifest()
  return {
    role: readSegmentRole(readOwn(record, 'role')),
    segmentIndex,
    segmentCount,
    entryStartIndex: readNonNegativeSafeInteger(
      readOwn(record, 'entryStartIndex'),
    ),
    entryCount: readPositiveSafeInteger(
      readOwn(record, 'entryCount'),
    ),
    segmentDigest: readDigest(readOwn(record, 'segmentDigest')),
    reference: readReference(
      readOwn(record, 'reference'),
      objectKeyPrefix,
      'segments',
    ),
  }
}

/**
 * Reads one strict compact manifest head.
 *
 * @param value - Candidate compact head.
 * @returns Detached strict compact head.
 */
function readManifestHead(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceManifestHead {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'evidenceSegmentCount',
    'headDigest',
    'kind',
    'manifestHeadVersion',
    'manifestPageCount',
    'manifestPageLocatorsDigest',
    'receiptSegmentCount',
    'segmentCount',
    'summary',
    'terminalManifestPageLocator',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-manifest-head' ||
    readOwn(record, 'manifestHeadVersion') !== 1
  ) {
    return failManifest()
  }
  const summary = readSummary(readOwn(record, 'summary'))
  const segmentCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'segmentCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  )
  const evidenceSegmentCount = readPositiveSafeInteger(
    readOwn(record, 'evidenceSegmentCount'),
  )
  const receiptSegmentCount = readPositiveSafeInteger(
    readOwn(record, 'receiptSegmentCount'),
  )
  const manifestPageCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'manifestPageCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  )
  const manifestPageLocatorsDigest = readDigest(
    readOwn(record, 'manifestPageLocatorsDigest'),
  )
  const terminalManifestPageLocator = readManifestPageLocator(
    readOwn(record, 'terminalManifestPageLocator'),
    summary.objectKeyPrefix,
  )
  if (
    evidenceSegmentCount + receiptSegmentCount !== segmentCount ||
    terminalManifestPageLocator.pageIndex !== manifestPageCount - 1 ||
    terminalManifestPageLocator.pageCount !== manifestPageCount ||
    addSafeCounts(
      terminalManifestPageLocator.segmentStartIndex,
      terminalManifestPageLocator.segmentCount,
    ) !== segmentCount
  ) {
    return failManifest()
  }
  const headFields = {
    kind: 'workspace-search-planning-provenance-manifest-head',
    manifestHeadVersion: 1,
    summary,
    segmentCount,
    evidenceSegmentCount,
    receiptSegmentCount,
    manifestPageCount,
    manifestPageLocatorsDigest,
    terminalManifestPageLocator,
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceManifestHead,
    'headDigest'
  >
  const headDigest = readDigest(readOwn(record, 'headDigest'))
  if (headDigest !== createMigrationDigest(headFields)) {
    return failManifest()
  }
  return { ...headFields, headDigest }
}

/**
 * Reads one compact manifest-page locator.
 *
 * @param value - Candidate page locator.
 * @param objectKeyPrefix - Required immutable-artifact key prefix.
 * @returns Detached strict page locator.
 */
function readManifestPageLocator(
  value: unknown,
  objectKeyPrefix: string,
): WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'pageCount',
    'pageDigest',
    'pageIndex',
    'reference',
    'segmentCount',
    'segmentStartIndex',
  ])
  const pageCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'pageCount'),
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  )
  const pageIndex = readNonNegativeSafeInteger(
    readOwn(record, 'pageIndex'),
  )
  if (pageIndex >= pageCount) return failManifest()
  return {
    pageIndex,
    pageCount,
    segmentStartIndex: readNonNegativeSafeInteger(
      readOwn(record, 'segmentStartIndex'),
    ),
    segmentCount: readPositiveSafeInteger(
      readOwn(record, 'segmentCount'),
    ),
    pageDigest: readDigest(readOwn(record, 'pageDigest')),
    reference: readReference(
      readOwn(record, 'reference'),
      objectKeyPrefix,
      'manifest-pages',
    ),
  }
}

/**
 * Reads one complete summary and validates its self-digest and fixed roles.
 *
 * @param value - Candidate summary.
 * @returns Detached strict summary.
 */
function readSummary(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceManifestSummary {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'chainRoots',
    'configurationHash',
    'evidencePageCount',
    'historicalReceiptBindingDigest',
    'historicalReceiptCount',
    'kind',
    'migrationId',
    'migrationVersion',
    'objectKeyPrefix',
    'orphanOperationCount',
    'planOperationCount',
    'planningSnapshotDigest',
    'provenanceDigest',
    'runId',
    'sourceOperationCount',
    'summaryDigest',
    'summaryVersion',
    'tableIds',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-summary' ||
    readOwn(record, 'summaryVersion') !== 1 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failManifest()
  }
  const roots = requireDenseArray(
    readOwn(record, 'chainRoots'),
    planningChainOrder.length,
  )
  if (roots.length !== planningChainOrder.length) return failManifest()
  const chainRoots = roots.map((candidate, index) => {
    const chain = planningChainOrder[index]
    if (chain === undefined) return failManifest()
    return readChainRoot(candidate, chain)
  })
  const sourceOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'sourceOperationCount'),
    maximumPlannedOperationCount,
  )
  const orphanOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'orphanOperationCount'),
    maximumPlannedOperationCount,
  )
  const planOperationCount = readBoundedNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
    maximumPlannedOperationCount,
  )
  if (
    sourceOperationCount + orphanOperationCount !== planOperationCount ||
    !Number.isSafeInteger(planOperationCount)
  ) {
    return failManifest()
  }
  const summaryFields = {
    kind: 'workspace-search-planning-provenance-summary',
    summaryVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    objectKeyPrefix: readObjectKeyPrefix(
      readOwn(record, 'objectKeyPrefix'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    chainRoots,
    evidencePageCount: readBoundedPositiveSafeInteger(
      readOwn(record, 'evidencePageCount'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_EVIDENCE_PAGES,
    ),
    planningSnapshotDigest: readDigest(
      readOwn(record, 'planningSnapshotDigest'),
    ),
    sourceOperationCount,
    orphanOperationCount,
    planOperationCount,
    provenanceDigest: readDigest(readOwn(record, 'provenanceDigest')),
    historicalReceiptBindingDigest: readDigest(
      readOwn(record, 'historicalReceiptBindingDigest'),
    ),
    historicalReceiptCount: readBoundedPositiveSafeInteger(
      readOwn(record, 'historicalReceiptCount'),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_RECEIPTS,
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
    'summaryDigest'
  >
  const summaryDigest = readDigest(readOwn(record, 'summaryDigest'))
  if (
    summaryDigest !== createMigrationDigest(summaryFields) ||
    summaryFields.tableIds['migration-state'] === ''
  ) {
    return failManifest()
  }
  return { ...summaryFields, summaryDigest }
}

/**
 * Reads all six exact physical table IDs.
 *
 * @param value - Candidate fixed-role table-ID record.
 * @returns Detached strict table-ID record.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  const record = requireRecord(value)
  const roles: readonly WorkspaceSearchMigrationTableRole[] = [
    ...workspaceSearchMigrationSourceNames,
    'workspace-search',
    'migration-state',
  ]
  requireExactKeys(record, roles)
  return {
    'project-directory': readBoundedText(
      readOwn(record, 'project-directory'),
      1_024,
    ),
    'work-items': readBoundedText(readOwn(record, 'work-items'), 1_024),
    collaboration: readBoundedText(readOwn(record, 'collaboration'), 1_024),
    documents: readBoundedText(readOwn(record, 'documents'), 1_024),
    'workspace-search': readBoundedText(
      readOwn(record, 'workspace-search'),
      1_024,
    ),
    'migration-state': readBoundedText(
      readOwn(record, 'migration-state'),
      1_024,
    ),
  }
}

/**
 * Compares all six physical table incarnations without serialization.
 *
 * @param left - First strict table-ID record.
 * @param right - Second strict table-ID record.
 * @returns Whether every fixed-role table ID is identical.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return (
    left['project-directory'] === right['project-directory'] &&
    left['work-items'] === right['work-items'] &&
    left.collaboration === right.collaboration &&
    left.documents === right.documents &&
    left['workspace-search'] === right['workspace-search'] &&
    left['migration-state'] === right['migration-state']
  )
}

/**
 * Adds two nonnegative counts without permitting safe-integer overflow.
 *
 * @param left - First validated nonnegative count.
 * @param right - Second validated nonnegative count.
 * @returns Exact safe-integer sum.
 */
function addSafeCounts(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total < 0) {
    return failManifest()
  }
  return total
}

/**
 * Adds canonical bytes without exceeding one aggregate segment ceiling.
 *
 * @param current - Previously accumulated canonical bytes.
 * @param additional - Additional canonical bytes.
 * @param maximum - Inclusive aggregate byte ceiling.
 * @returns Exact bounded safe-integer byte total.
 */
function addBoundedCanonicalBytes(
  current: number,
  additional: number,
  maximum: number,
): number {
  const total = current + additional
  if (
    !Number.isSafeInteger(total) ||
    current < 0 ||
    additional < 0 ||
    total > maximum
  ) {
    return failManifest()
  }
  return total
}

/**
 * Reads one rich exact-version immutable reference.
 *
 * @param value - Candidate reference.
 * @param objectKeyPrefix - Required key prefix when role correlation applies.
 * @param role - Required storage role when key correlation applies.
 * @returns Detached strict reference.
 */
function readReference(
  value: unknown,
  objectKeyPrefix?: string,
  role?: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
): WorkspaceSearchMigrationPlanningProvenanceManifestReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const reference = {
    objectKey: readBoundedText(
      readOwn(record, 'objectKey'),
      maximumReferenceTextLength,
    ),
    versionId: readBoundedText(
      readOwn(record, 'versionId'),
      maximumReferenceTextLength,
    ),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  if (
    (objectKeyPrefix === undefined) !== (role === undefined) ||
    (
      objectKeyPrefix !== undefined &&
      role !== undefined &&
      reference.objectKey !==
        createProvenanceObjectKey(
          objectKeyPrefix,
          role,
          reference.contentDigest,
        )
    )
  ) {
    return failManifest()
  }
  return reference
}

/**
 * Reads exact referenced bytes in the same order as expected references.
 *
 * @param value - Candidate referenced-byte array.
 * @param expected - Required ordered references.
 * @param maximumBytes - Per-object byte ceiling.
 * @returns Detached exact byte snapshots.
 */
function readReferencedBytesArray(
  value: unknown,
  expected:
    readonly WorkspaceSearchMigrationPlanningProvenanceManifestReference[],
  maximumBytes: number,
): readonly Uint8Array[] {
  const values = requireDenseArray(value, expected.length)
  if (values.length !== expected.length) return failManifest()
  return values.map((candidate, index) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, ['bytes', 'reference'])
    const reference = readReference(readOwn(record, 'reference'))
    const expectedReference = expected[index]
    if (
      expectedReference === undefined ||
      !sameReference(reference, expectedReference)
    ) {
      return failManifest()
    }
    const bytes = readDetachedUnsharedBytes(
      readOwn(record, 'bytes'),
      maximumBytes,
    )
    requireReferenceMatchesBytes(reference, bytes)
    return bytes
  })
}

/**
 * Requires a rich exact-version reference to match exact canonical bytes.
 *
 * @param reference - Expected immutable object identity.
 * @param bytes - Exact bytes read or prepared for upload.
 */
function requireReferenceMatchesBytes(
  reference: WorkspaceSearchMigrationPlanningProvenanceManifestReference,
  bytes: Uint8Array,
): void {
  if (
    reference.byteLength !== bytes.byteLength ||
    reference.contentDigest !== digestBytes(bytes)
  ) {
    return failManifest()
  }
}

/**
 * Digests one complete ordered manifest-page locator set with domain separation.
 *
 * @param locators - Complete ordered exact-version page locators.
 * @returns Canonical digest binding every locator and its position.
 */
function createManifestPageLocatorsDigest(
  locators:
    readonly WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator[],
): string {
  return createMigrationDigest({
    kind: 'workspace-search-planning-provenance-manifest-page-locators',
    locatorSetVersion: 1,
    manifestPages: locators,
  })
}

/**
 * Checks two manifest-page locators for exact equality.
 *
 * @param left - First page locator.
 * @param right - Second page locator.
 * @returns Whether every page and immutable-reference field matches.
 */
function sameManifestPageLocator(
  left: WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator,
  right: WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator,
): boolean {
  return left.pageIndex === right.pageIndex &&
    left.pageCount === right.pageCount &&
    left.segmentStartIndex === right.segmentStartIndex &&
    left.segmentCount === right.segmentCount &&
    left.pageDigest === right.pageDigest &&
    sameReference(left.reference, right.reference)
}

/**
 * Checks two rich exact-version references for exact equality.
 *
 * @param left - First reference.
 * @param right - Second reference.
 * @returns Whether every reference field matches.
 */
function sameReference(
  left: WorkspaceSearchMigrationPlanningProvenanceManifestReference,
  right: WorkspaceSearchMigrationPlanningProvenanceManifestReference,
): boolean {
  return left.objectKey === right.objectKey &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.retainUntil === right.retainUntil
}

/**
 * Checks two complete semantic summaries for exact equality by self-digest.
 *
 * @param left - First strict summary.
 * @param right - Second strict summary.
 * @returns Whether both summaries identify the same canonical artifact.
 */
function sameSummary(
  left: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  right: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
): boolean {
  return left.summaryDigest === right.summaryDigest
}

/**
 * Checks two authority transitions for exact equality.
 *
 * @param left - First transition.
 * @param right - Second transition.
 * @returns Whether all authority fields match.
 */
function sameTransition(
  left: WorkspaceSearchMigrationPlanningAuthorityTransition,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): boolean {
  return left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest
}

/**
 * Orders authority transitions by positive pointer revision.
 *
 * @param left - First transition.
 * @param right - Second transition.
 * @returns Stable numeric ordering.
 */
function compareTransitions(
  left: WorkspaceSearchMigrationPlanningAuthorityTransition,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): number {
  return left.maintenanceEvidencePointerRevision <
      right.maintenanceEvidencePointerRevision
    ? -1
    : left.maintenanceEvidencePointerRevision >
        right.maintenanceEvidencePointerRevision
      ? 1
      : 0
}

/**
 * Reads one accepted fixed evidence-chain role.
 *
 * @param value - Candidate role.
 * @returns Strict fixed role.
 */
function readChainRole(
  value: unknown,
): WorkspaceSearchMigrationPlanningEvidenceChainRole {
  if (
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'workspace-search'
  ) {
    return value
  }
  return failManifest()
}

/**
 * Reads one accepted homogeneous segment stream role.
 *
 * @param value - Candidate role.
 * @returns Strict segment role.
 */
function readSegmentRole(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceSegmentRole {
  if (value === 'evidence-pages' || value === 'historical-receipts') {
    return value
  }
  return failManifest()
}

/**
 * Reads one fixed immutable-storage role owned by this codec.
 *
 * @param value - Candidate immutable-artifact role.
 * @returns Strict provenance artifact role.
 */
function readArtifactRole(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceArtifactRole {
  if (
    value === 'segments' ||
    value === 'manifest-pages' ||
    value === 'manifest-heads'
  ) {
    return value
  }
  return failManifest()
}

/**
 * Reads one safe canonical run-scoped immutable-artifact key prefix.
 *
 * The storage adapter additionally proves that this prefix is below the
 * measured journal namespace.
 *
 * @param value - Candidate object-key prefix.
 * @returns Safe canonical prefix.
 */
function readObjectKeyPrefix(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 700 ||
    value.endsWith('/')
  ) {
    return failManifest()
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) ||
        segment === '.' ||
        segment === '..',
    )
  ) {
    return failManifest()
  }
  return value
}

/**
 * Creates one exact generic-storage-compatible content-addressed key.
 *
 * @param objectKeyPrefix - Safe run-scoped key prefix.
 * @param role - Fixed semantic storage role.
 * @param contentDigest - Digest of exact stored bytes.
 * @returns Exact content-addressed object key.
 */
function createProvenanceObjectKey(
  objectKeyPrefix: string,
  role: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  contentDigest: string,
): string {
  const objectKey =
    `${objectKeyPrefix}/${role}/${contentDigest}.artifact`
  if (Buffer.byteLength(objectKey, 'utf8') > 1_024) {
    return failManifest()
  }
  return objectKey
}

/**
 * Reads canonical Base64 without accepting whitespace or alternate spellings.
 *
 * @param value - Candidate Base64 witness.
 * @returns Canonical Base64 text.
 */
function readCanonicalBase64(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumArtifactTextLength ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    return failManifest()
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    return failManifest()
  }
  return value
}

/**
 * Decodes already validated canonical Base64 to detached bytes.
 *
 * @param value - Canonical Base64 witness.
 * @returns Detached decoded bytes.
 */
function decodeCanonicalBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/**
 * Reads an optional caller-selected byte ceiling.
 *
 * @param value - Candidate optional ceiling.
 * @param maximum - Hard contract maximum.
 * @returns Validated positive ceiling.
 */
function readOptionalMaximumBytes(
  value: unknown,
  maximum: number,
): number {
  if (value === undefined) return maximum
  return readBoundedPositiveSafeInteger(value, maximum)
}

/**
 * Reads one non-array non-Proxy runtime object.
 *
 * @param value - Candidate runtime value.
 * @returns Object suitable for descriptor-only reads.
 */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failManifest()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own keys.
 *
 * @param value - Candidate object.
 * @param expected - Exact accepted key names.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failManifest()
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failManifest()
  }
}

/**
 * Requires exactly required keys plus optional absent keys.
 *
 * @param value - Candidate input object.
 * @param accepted - Exact complete accepted key set.
 * @param required - Keys that must be present in the accepted set.
 */
function requireExactOptionalKeys(
  value: object,
  accepted: readonly string[],
  required: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failManifest()
  }
  if (
    keys.some((key) => !accepted.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return failManifest()
  }
}

/**
 * Reads one enumerable own data property without invoking accessors.
 *
 * @param value - Candidate object.
 * @param key - Required property name.
 * @returns Exact property value.
 */
function readOwn(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return failManifest()
  }
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failManifest()
  }
  return descriptor.value
}

/**
 * Reads one optional enumerable own data property without invoking accessors.
 *
 * @param value - Candidate object.
 * @param key - Optional property name.
 * @returns Exact property value or undefined when absent.
 */
function readOwnOptional(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return failManifest()
  }
  if (descriptor === undefined) return undefined
  if (
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failManifest()
  }
  return descriptor.value
}

/**
 * Requires one dense ordinary array under an explicit element ceiling.
 *
 * @param value - Candidate array.
 * @param maximumLength - Maximum accepted element count.
 * @returns Dense array without sparse or inherited indices.
 */
function requireDenseArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > maximumLength ||
    !hasCanonicalDenseArrayShape(value)
  ) {
    return failManifest()
  }
  return value
}

/**
 * Reads one strict migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') return failManifest()
  try {
    return requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failManifest()
  }
}

/**
 * Reads one bounded nonblank Unicode string.
 *
 * @param value - Candidate text.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns Validated text.
 */
function readBoundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failManifest()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failManifest()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failManifest()
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate count.
 * @returns Validated count.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failManifest()
  }
  return value
}

/**
 * Reads one nonnegative safe integer under an explicit maximum.
 *
 * @param value - Candidate count.
 * @param maximum - Maximum accepted value.
 * @returns Validated bounded nonnegative count.
 */
function readBoundedNonNegativeSafeInteger(
  value: unknown,
  maximum: number,
): number {
  const parsed = readNonNegativeSafeInteger(value)
  if (parsed > maximum) return failManifest()
  return parsed
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate count.
 * @returns Validated positive count.
 */
function readPositiveSafeInteger(value: unknown): number {
  const parsed = readNonNegativeSafeInteger(value)
  if (parsed === 0) return failManifest()
  return parsed
}

/**
 * Reads one positive safe integer under an explicit maximum.
 *
 * @param value - Candidate count.
 * @param maximum - Maximum accepted value.
 * @returns Validated bounded positive count.
 */
function readBoundedPositiveSafeInteger(
  value: unknown,
  maximum: number,
): number {
  const parsed = readPositiveSafeInteger(value)
  if (parsed > maximum) return failManifest()
  return parsed
}

/**
 * Parses bounded strict UTF-8 JSON from an immutable byte snapshot.
 *
 * @param bytes - Candidate exact bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Parsed value and detached exact byte snapshot.
 */
function parseCanonicalJson(
  bytes: Uint8Array,
  maximumBytes: number,
): ParsedCanonicalJson {
  const detached = readDetachedUnsharedBytes(bytes, maximumBytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(detached)
  } catch {
    return failManifest()
  }
  try {
    return { value: JSON.parse(text), bytes: detached }
  } catch {
    return failManifest()
  }
}

/**
 * Copies exact bytes without accepting Proxy or shared backing memory.
 *
 * @param value - Candidate Uint8Array.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Detached ordinary-ArrayBuffer-backed bytes.
 */
function readDetachedUnsharedBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failManifest()
  }
  const buffer = readIntrinsicUint8ArrayBuffer(value)
  const byteLength = readIntrinsicUint8ArrayByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > maximumBytes
  ) {
    return failManifest()
  }
  const detached = new Uint8Array(value)
  if (readIntrinsicUint8ArrayByteLength(detached) !== byteLength) {
    return failManifest()
  }
  return detached
}

/**
 * Reads a typed array's internal backing buffer without own property access.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failManifest()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) return failManifest()
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failManifest()
  }
  return buffer
}

/**
 * Reads a typed array's intrinsic byte length without invoking own accessors.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic byte length.
 */
function readIntrinsicUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failManifest()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) return failManifest()
  const byteLength: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failManifest()
  }
  return byteLength
}

/**
 * Encodes strict canonical JSON under an explicit byte ceiling.
 *
 * @param value - Validated JSON-safe value.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonical(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    return failManifest()
  }
  return bytes
}

/**
 * Computes canonical UTF-8 byte length without retaining the byte array.
 *
 * @param value - Canonical JSON-safe value.
 * @returns Exact UTF-8 byte length.
 */
function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(serializeCanonicalJson(value), 'utf8')
}

/**
 * Requires exact byte-for-byte canonical representation.
 *
 * @param actual - Original detached bytes.
 * @param value - Reconstructed canonical value.
 * @param maximumBytes - Maximum accepted byte length.
 */
function requireCanonicalBytes(
  actual: Uint8Array,
  value: unknown,
  maximumBytes: number,
): void {
  const expected = encodeCanonical(value, maximumBytes)
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    return failManifest()
  }
}

/**
 * Computes the SHA-256 digest of exact canonical bytes.
 *
 * @param bytes - Exact detached bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Runs one synchronous operation behind a fixed redaction boundary.
 *
 * @param operation - Exact construction, parse, or replay operation.
 * @returns Operation result.
 */
function runManifestBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationPlanningProvenanceManifestError()
  }
}

/**
 * Raises one stable provenance manifest validation failure.
 *
 * @returns Never returns.
 */
function failManifest(): never {
  throw new WorkspaceSearchMigrationPlanningProvenanceManifestError()
}
