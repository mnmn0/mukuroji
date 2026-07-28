import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchPlanSeal,
} from './migration-contract'
import {
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  parseWorkspaceSearchMigrationPlanManifestHead,
  parseWorkspaceSearchMigrationPlanManifestPage,
  replayWorkspaceSearchMigrationPlanArtifact,
  serializeWorkspaceSearchMigrationPlanArtifactSegments,
  serializeWorkspaceSearchMigrationPlanManifestHead,
  serializeWorkspaceSearchMigrationPlanManifestPage,
  type WorkspaceSearchMigrationPlanArtifactReplayResult,
  type WorkspaceSearchMigrationPlanArtifactStoredObject,
  type WorkspaceSearchMigrationPlanManifestHead,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder,
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
  createWorkspaceSearchMigrationPlanningProvenanceSegments,
  parseWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  parseWorkspaceSearchMigrationPlanningProvenanceManifestPage,
  replayWorkspaceSearchMigrationPlanningProvenanceManifest,
  serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceManifestReference,
  type WorkspaceSearchMigrationPlanningProvenanceReferencedBytes,
  type WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceStoredSegment,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
} from './migration-planning-provenance-manifest'
import {
  parseWorkspaceSearchMigrationPlanningProvenanceArtifact,
  serializeWorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationPlanningProvenanceArtifact,
} from './migration-sealed-planning-authority'
import { hasOnlyPairedSurrogates } from './migration-value-guards'
import type {
  WorkspaceSearchPlannedOperation,
} from './migration-state-machine'

/**
 * Run-scoped namespace used for immutable planning-provenance bundles.
 */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX =
  'workspace-search/v1/planning-provenance-artifacts/v1'

/**
 * Maximum size of one object emitted by the planning storage gateway.
 */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES =
  Math.max(
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  )

const planSealRole = 'plan-seals'
const segmentRole = 'segments'
const manifestPageRole = 'manifest-pages'
const manifestHeadRole = 'manifest-heads'
const maximumPlanManifestPages = Math.ceil(
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS /
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
)

/**
 * Stable raw-value-free failure for invalid planning storage graphs.
 */
export class WorkspaceSearchMigrationPlanningArtifactAwsError
  extends Error {
  /** Secret-free machine-readable storage-graph failure code. */
  readonly code = 'INVALID_PLANNING_ARTIFACT_STORAGE'

  /** Creates one stable planning storage failure. */
  constructor() {
    super('INVALID_PLANNING_ARTIFACT_STORAGE')
    this.name = 'WorkspaceSearchMigrationPlanningArtifactAwsError'
  }
}

/**
 * Dependencies and measured identity for one run-scoped planning gateway.
 */
export type CreateAwsWorkspaceSearchMigrationPlanningArtifactGatewayInput = {
  /** Operator-selected run bound into every object and metadata set. */
  readonly runId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Codec-agnostic immutable object port from the measured AWS session. */
  readonly immutableArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort
}

/**
 * Input for uploading one reviewed operation-plan bundle.
 */
export type WriteWorkspaceSearchMigrationPlanArtifactInput = {
  /** Reviewed immutable plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Complete ordered operations bound by the seal. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
  /** Optional smaller ceiling for all encoded plan-segment bytes. */
  readonly maximumTotalPlanSegmentBytes?: number
  /** Shared canonical COMPLIANCE retention deadline for the entire graph. */
  readonly retainUntil: string
}

/**
 * Exact roots returned after a complete plan graph is immutable.
 */
export type WorkspaceSearchMigrationStoredPlanArtifact = {
  /** Exact immutable version containing the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact immutable version containing the compact operation-manifest head. */
  readonly manifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
}

/**
 * Input for replaying a stored operation plan from its two authority roots.
 */
export type ReplayWorkspaceSearchMigrationStoredPlanArtifactInput = {
  /** Exact immutable version containing the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact immutable version containing the compact operation-manifest head. */
  readonly manifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
}

/**
 * Input for uploading one complete planning-provenance bundle.
 */
export type WriteWorkspaceSearchMigrationPlanningProvenanceArtifactInput = {
  /** Strict full provenance artifact to segment without semantic loss. */
  readonly artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Shared canonical COMPLIANCE retention deadline for the entire graph. */
  readonly retainUntil: string
  /** Optional smaller segment ceiling for constrained runs or tests. */
  readonly maximumSegmentBytes?: number
  /** Optional smaller manifest-page ceiling for constrained runs or tests. */
  readonly maximumManifestPageBytes?: number
}

/**
 * Exact provenance head returned after every predecessor is immutable.
 */
export type WorkspaceSearchMigrationStoredPlanningProvenanceArtifact = {
  /** Detached strict compact provenance manifest head. */
  readonly manifestHead:
    WorkspaceSearchMigrationPlanningProvenanceManifestHead
  /** Exact immutable version containing the compact manifest head. */
  readonly manifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
}

/**
 * Input for replaying provenance from one exact compact-head version.
 */
export type ReplayWorkspaceSearchMigrationStoredPlanningProvenanceArtifactInput =
  {
    /** Exact immutable version containing the compact provenance head. */
    readonly manifestHeadReference:
      WorkspaceSearchMigrationImmutableArtifactReference
  }

/**
 * Planning-specific immutable graph storage operations.
 */
export interface WorkspaceSearchMigrationPlanningArtifactAwsGateway {
  /**
   * Uploads a plan seal, complete segments, predecessor-linked pages, and head.
   *
   * @param input - Reviewed plan material and one shared retention deadline.
   * @returns Exact seal and manifest-head roots.
   */
  writePlanArtifact(
    input: WriteWorkspaceSearchMigrationPlanArtifactInput,
  ): Promise<WorkspaceSearchMigrationStoredPlanArtifact>

  /**
   * Replays a complete operation plan using exact version-pinned reads only.
   *
   * @param input - Exact plan-seal and operation-manifest roots.
   * @returns Detached validated seal, head, and ordered operations.
   */
  replayPlanArtifact(
    input: ReplayWorkspaceSearchMigrationStoredPlanArtifactInput,
  ): Promise<WorkspaceSearchMigrationPlanArtifactReplayResult>

  /**
   * Uploads provenance segments, predecessor-linked pages, and compact head.
   *
   * @param input - Strict provenance material and bounded packing options.
   * @returns Exact compact head and its immutable reference.
   */
  writePlanningProvenanceArtifact(
    input: WriteWorkspaceSearchMigrationPlanningProvenanceArtifactInput,
  ): Promise<WorkspaceSearchMigrationStoredPlanningProvenanceArtifact>

  /**
   * Replays complete provenance from one exact compact-head reference.
   *
   * @param input - Exact compact provenance head.
   * @returns Detached strict full provenance artifact.
   */
  replayPlanningProvenanceArtifact(
    input:
      ReplayWorkspaceSearchMigrationStoredPlanningProvenanceArtifactInput,
  ): Promise<WorkspaceSearchMigrationPlanningProvenanceArtifact>
}

/**
 * Exact canonical bytes prepared for one immutable object operation.
 */
type PreparedPlanningArtifactObject = {
  /** Codec-owned object-key prefix. */
  readonly objectKeyPrefix: string
  /** Role-separated object namespace. */
  readonly role: string
  /** Exact canonical object bytes. */
  readonly bytes: Uint8Array
  /** SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Shared canonical retention deadline. */
  readonly retainUntil: string
  /** Exact caller-owned metadata expected on write and read. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Optional exact fields required while validating one rich reference.
 */
type PlanningArtifactReferenceExpectation = {
  /** Exact expected content digest, when already known. */
  readonly contentDigest?: string
  /** Exact expected byte length, when already known. */
  readonly byteLength?: number
  /** Exact shared retention deadline, when already known. */
  readonly retainUntil?: string
}

/**
 * Detached immutable-object methods retained without later property reads.
 */
type PreparedPlanningArtifactImmutablePort = {
  /**
   * Invokes one immutable object write.
   *
   * @param input - Exact immutable object write input.
   * @returns Untrusted storage result for strict gateway validation.
   */
  readonly write: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'writeImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
  /**
   * Invokes one exact immutable object read.
   *
   * @param input - Exact immutable object read input.
   * @returns Untrusted storage result for strict gateway validation.
   */
  readonly read: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'readImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
}

/**
 * Creates one run-scoped planning artifact gateway.
 *
 * @param input - Measured run identity and immutable object port.
 * @returns Planning-specific graph storage gateway.
 */
export function createAwsWorkspaceSearchMigrationPlanningArtifactGateway(
  input: CreateAwsWorkspaceSearchMigrationPlanningArtifactGatewayInput,
): WorkspaceSearchMigrationPlanningArtifactAwsGateway {
  return runPlanningArtifactStorageBoundary(() => {
    const inputRecord = requirePlanningArtifactRecord(input)
    requireExactPlanningArtifactKeys(inputRecord, [
      'configurationHash',
      'immutableArtifactPort',
      'runId',
    ])
    const runIdCandidate =
      readRequiredPlanningArtifactData(inputRecord, 'runId')
    if (typeof runIdCandidate !== 'string') {
      return failPlanningArtifactStorage()
    }
    const runId = readPlanningArtifactRunId(runIdCandidate)
    const configurationHash = readRequiredPlanningArtifactData(
      inputRecord,
      'configurationHash',
    )
    if (!isHexDigest(configurationHash)) {
      return failPlanningArtifactStorage()
    }
    const immutableArtifactPort =
      snapshotPlanningArtifactImmutablePort(
        readRequiredPlanningArtifactData(
          inputRecord,
          'immutableArtifactPort',
        ),
      )
    return new AwsWorkspaceSearchMigrationPlanningArtifactGateway(
      runId,
      configurationHash,
      immutableArtifactPort,
    )
  })
}

/**
 * Concrete planning graph adapter over the codec-agnostic immutable core.
 */
class AwsWorkspaceSearchMigrationPlanningArtifactGateway
implements WorkspaceSearchMigrationPlanningArtifactAwsGateway {
  /** Operator-selected run bound to this gateway. */
  private readonly runId: string

  /** Exact measured-configuration digest bound to this gateway. */
  private readonly configurationHash: string

  /** Run-scoped provenance object-key prefix. */
  private readonly provenanceObjectKeyPrefix: string

  /** Exact metadata expected on every plan object. */
  private readonly planMetadata: Readonly<Record<string, string>>

  /** Exact metadata expected on every provenance object. */
  private readonly provenanceMetadata: Readonly<Record<string, string>>

  /** Measured immutable single-object storage port. */
  private readonly immutableArtifactPort:
    PreparedPlanningArtifactImmutablePort

  /**
   * Creates one gateway from validated measured identity.
   *
   * @param runId - Safe operator-selected run identifier.
   * @param configurationHash - Exact measured-configuration digest.
   * @param immutableArtifactPort - Measured immutable object port.
   */
  constructor(
    runId: string,
    configurationHash: string,
    immutableArtifactPort:
      PreparedPlanningArtifactImmutablePort,
  ) {
    this.runId = runId
    this.configurationHash = configurationHash
    this.provenanceObjectKeyPrefix =
      `${WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX}/${runId}/${configurationHash}`
    void createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
      this.provenanceObjectKeyPrefix,
      manifestHeadRole,
      '0'.repeat(64),
    )
    this.planMetadata = createPlanningArtifactMetadata(
      'plan',
      runId,
      configurationHash,
    )
    this.provenanceMetadata = createPlanningArtifactMetadata(
      'provenance',
      runId,
      configurationHash,
    )
    this.immutableArtifactPort = immutableArtifactPort
  }

  /**
   * Uploads one complete operation-plan graph in dependency order.
   *
   * @param input - Reviewed plan, operations, and shared retention.
   * @returns Exact authority roots for the seal and manifest.
   */
  async writePlanArtifact(
    input: WriteWorkspaceSearchMigrationPlanArtifactInput,
  ): Promise<WorkspaceSearchMigrationStoredPlanArtifact> {
    return runPlanningArtifactStorageAsyncBoundary(async () => {
      const inputRecord = requirePlanningArtifactRecord(input)
      requireExactOptionalPlanningArtifactKeys(inputRecord, [
        'maximumTotalPlanSegmentBytes',
        'operations',
        'planSeal',
        'retainUntil',
      ], ['operations', 'planSeal', 'retainUntil'])
      const retainUntil = readPlanningArtifactRetention(
        readRequiredPlanningArtifactData(inputRecord, 'retainUntil'),
      )
      const planSealCandidate =
        readRequiredPlanningArtifactData(inputRecord, 'planSeal')
      const operationsCandidate =
        readRequiredPlanningArtifactData(inputRecord, 'operations')
      if (
        !isWorkspaceSearchPlanSealCandidate(planSealCandidate) ||
        !isWorkspaceSearchPlannedOperationArrayCandidate(
          operationsCandidate,
        )
      ) {
        return failPlanningArtifactStorage()
      }
      const planSealBytes =
        serializeWorkspaceSearchPlanSeal(planSealCandidate)
      const planSeal = parseWorkspaceSearchPlanSeal(planSealBytes)
      this.requirePlanIdentity(planSeal)
      const maximumTotalPlanSegmentBytes =
        readOptionalPlanningArtifactMaximum(
          readOptionalPlanningArtifactData(
            inputRecord,
            'maximumTotalPlanSegmentBytes',
          ),
          WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
        )
      const encodedSegments =
        serializeWorkspaceSearchMigrationPlanArtifactSegments(
          planSeal,
          operationsCandidate,
          maximumTotalPlanSegmentBytes,
        )
      const planSealReference = await this.writeObject({
        objectKeyPrefix:
          WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        role: planSealRole,
        bytes: planSealBytes,
        contentDigest: digestPlanningArtifactBytes(planSealBytes),
        retainUntil,
        metadata: this.planMetadata,
      })

      const storedSegments:
        WorkspaceSearchMigrationPlanArtifactStoredObject[] = []
      for (const encoded of encodedSegments) {
        const reference = await this.writeObject({
          objectKeyPrefix:
            WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
          role: segmentRole,
          bytes: encoded.bytes,
          contentDigest: encoded.contentDigest,
          retainUntil,
          metadata: this.planMetadata,
        })
        storedSegments.push({ reference, bytes: encoded.bytes })
      }

      const storedPages:
        WorkspaceSearchMigrationPlanArtifactStoredObject[] = []
      let previousPage:
        WorkspaceSearchMigrationPlanArtifactStoredObject | null = null
      for (
        let start = 0;
        start < storedSegments.length;
        start +=
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES
      ) {
        const encoded =
          serializeWorkspaceSearchMigrationPlanManifestPage({
            planSeal,
            planSegmentCount: storedSegments.length,
            pageSequence: storedPages.length + 1,
            previousPage,
            segments: storedSegments.slice(
              start,
              start +
                WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
            ),
          })
        const reference = await this.writeObject({
          objectKeyPrefix:
            WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
          role: manifestPageRole,
          bytes: encoded.bytes,
          contentDigest: encoded.contentDigest,
          retainUntil,
          metadata: this.planMetadata,
        })
        const stored = { reference, bytes: encoded.bytes }
        storedPages.push(stored)
        previousPage = stored
      }

      const encodedHead =
        serializeWorkspaceSearchMigrationPlanManifestHead({
          planSeal,
          manifestPages: storedPages,
          segments: storedSegments,
        })
      const manifestHeadReference = await this.writeObject({
        objectKeyPrefix:
          WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        role: manifestHeadRole,
        bytes: encodedHead.bytes,
        contentDigest: encodedHead.contentDigest,
        retainUntil,
        metadata: this.planMetadata,
      })
      requireSameRetention(
        planSealReference,
        manifestHeadReference.retainUntil,
      )
      return { planSealReference, manifestHeadReference }
    })
  }

  /**
   * Replays a complete plan using only exact rich references.
   *
   * @param input - Exact plan-seal and compact-head roots.
   * @returns Detached strict plan replay.
   */
  async replayPlanArtifact(
    input: ReplayWorkspaceSearchMigrationStoredPlanArtifactInput,
  ): Promise<WorkspaceSearchMigrationPlanArtifactReplayResult> {
    return runPlanningArtifactStorageAsyncBoundary(async () => {
      const inputRecord = requirePlanningArtifactRecord(input)
      requireExactPlanningArtifactKeys(inputRecord, [
        'manifestHeadReference',
        'planSealReference',
      ])
      const planSealReference = readPlanningArtifactReference(
        readRequiredPlanningArtifactData(
          inputRecord,
          'planSealReference',
        ),
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        planSealRole,
      )
      const manifestHeadReference = readPlanningArtifactReference(
        readRequiredPlanningArtifactData(
          inputRecord,
          'manifestHeadReference',
        ),
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        manifestHeadRole,
      )
      requireSameRetention(
        manifestHeadReference,
        planSealReference.retainUntil,
      )
      const planSealBytes = await this.readObject(
        planSealReference,
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        planSealRole,
        this.planMetadata,
        planSealReference.retainUntil,
      )
      const planSeal = parseWorkspaceSearchPlanSeal(planSealBytes)
      this.requirePlanIdentity(planSeal)
      const manifestHeadBytes = await this.readObject(
        manifestHeadReference,
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        manifestHeadRole,
        this.planMetadata,
        planSealReference.retainUntil,
      )
      const manifestHead =
        parseWorkspaceSearchMigrationPlanManifestHead(manifestHeadBytes)
      this.requirePlanHeadIdentity(manifestHead)

      const reversedPages:
        WorkspaceSearchMigrationPlanArtifactStoredObject[] = []
      let pageReference = manifestHead.terminalManifestPageReference
      for (
        let pageIndex = manifestHead.manifestPageCount - 1;
        pageIndex >= 0;
        pageIndex -= 1
      ) {
        if (pageReference === null) {
          return failPlanningArtifactStorage()
        }
        const reference = readPlanningArtifactReference(
          pageReference,
          WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
          manifestPageRole,
        )
        const bytes = await this.readObject(
          reference,
          WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
          manifestPageRole,
          this.planMetadata,
          planSealReference.retainUntil,
        )
        const page = parseWorkspaceSearchMigrationPlanManifestPage(bytes)
        if (
          page.pageSequence !== pageIndex + 1 ||
          page.runId !== this.runId ||
          page.configurationHash !== this.configurationHash
        ) {
          return failPlanningArtifactStorage()
        }
        reversedPages.push({ reference, bytes })
        pageReference = page.previousPageReference
      }
      if (
        pageReference !== null ||
        reversedPages.length > maximumPlanManifestPages
      ) {
        return failPlanningArtifactStorage()
      }
      const manifestPages = reversedPages.reverse()
      const segmentReferences =
        manifestPages.flatMap(({ bytes }) =>
          parseWorkspaceSearchMigrationPlanManifestPage(bytes)
            .segments.map(({ reference }) => reference)
        )
      if (
        segmentReferences.length !== manifestHead.planSegmentCount ||
        segmentReferences.length >
          WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS
      ) {
        return failPlanningArtifactStorage()
      }
      const preparedSegmentReferences =
        segmentReferences.map((candidate) =>
          readPlanningArtifactReference(
            candidate,
            WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
            segmentRole,
            { retainUntil: planSealReference.retainUntil },
          )
        )
      let totalSegmentBytes = 0
      for (const reference of preparedSegmentReferences) {
        totalSegmentBytes += reference.byteLength
        if (
          !Number.isSafeInteger(totalSegmentBytes) ||
          totalSegmentBytes >
            WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES
        ) {
          return failPlanningArtifactStorage()
        }
      }
      const segments:
        WorkspaceSearchMigrationPlanArtifactStoredObject[] = []
      for (const reference of preparedSegmentReferences) {
        const bytes = await this.readObject(
          reference,
          WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
          segmentRole,
          this.planMetadata,
          planSealReference.retainUntil,
        )
        segments.push({ reference, bytes })
      }
      return replayWorkspaceSearchMigrationPlanArtifact({
        planSeal,
        manifestHeadBytes,
        manifestPages,
        segments,
      })
    })
  }

  /**
   * Uploads one complete provenance graph in dependency order.
   *
   * @param input - Strict provenance and bounded packing options.
   * @returns Compact provenance head and its exact immutable reference.
   */
  async writePlanningProvenanceArtifact(
    input: WriteWorkspaceSearchMigrationPlanningProvenanceArtifactInput,
  ): Promise<WorkspaceSearchMigrationStoredPlanningProvenanceArtifact> {
    return runPlanningArtifactStorageAsyncBoundary(async () => {
      const inputRecord = requirePlanningArtifactRecord(input)
      requireExactOptionalPlanningArtifactKeys(inputRecord, [
        'artifact',
        'maximumManifestPageBytes',
        'maximumSegmentBytes',
        'retainUntil',
      ], ['artifact', 'retainUntil'])
      const retainUntil = readPlanningArtifactRetention(
        readRequiredPlanningArtifactData(inputRecord, 'retainUntil'),
      )
      const artifactCandidate =
        readRequiredPlanningArtifactData(inputRecord, 'artifact')
      if (
        !isWorkspaceSearchPlanningProvenanceArtifactCandidate(
          artifactCandidate,
        )
      ) {
        return failPlanningArtifactStorage()
      }
      const artifact =
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          serializeWorkspaceSearchMigrationPlanningProvenanceArtifact(
            artifactCandidate,
          ),
        )
      const maximumSegmentBytes = readOptionalPlanningArtifactMaximum(
        readOptionalPlanningArtifactData(
          inputRecord,
          'maximumSegmentBytes',
        ),
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
      )
      const maximumManifestPageBytes =
        readOptionalPlanningArtifactMaximum(
          readOptionalPlanningArtifactData(
            inputRecord,
            'maximumManifestPageBytes',
          ),
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
        )
      const encodedSegments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumTotalSegmentBytes:
            WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
          objectKeyPrefix: this.provenanceObjectKeyPrefix,
          ...(maximumSegmentBytes === undefined
            ? {}
            : { maximumSegmentBytes }),
        })
      const firstSegment = encodedSegments[0]
      if (
        firstSegment === undefined ||
        firstSegment.segment.summary.runId !== this.runId ||
        firstSegment.segment.summary.configurationHash !==
          this.configurationHash
      ) {
        return failPlanningArtifactStorage()
      }
      const storedSegments:
        WorkspaceSearchMigrationPlanningProvenanceStoredSegment[] = []
      for (const encoded of encodedSegments) {
        const reference = await this.writeObject({
          objectKeyPrefix: this.provenanceObjectKeyPrefix,
          role: segmentRole,
          bytes: encoded.bytes,
          contentDigest: encoded.contentDigest,
          retainUntil,
          metadata: this.provenanceMetadata,
        })
        storedSegments.push({ encoded, reference })
      }

      const builder =
        createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder({
          artifact,
          objectKeyPrefix: this.provenanceObjectKeyPrefix,
          storedSegments,
          ...(maximumManifestPageBytes === undefined
            ? {}
            : {
                maximumManifestPageBytes,
              }),
        })
      const storedManifestPages:
        WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[] = []
      let previousStoredManifestPage:
        WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage
          | null = null
      for (let pageIndex = 0; pageIndex < builder.pageCount; pageIndex += 1) {
        const encoded = builder.createNextPage(
          previousStoredManifestPage,
        )
        const reference = await this.writeObject({
          objectKeyPrefix: this.provenanceObjectKeyPrefix,
          role: manifestPageRole,
          bytes: encoded.bytes,
          contentDigest: encoded.contentDigest,
          retainUntil,
          metadata: this.provenanceMetadata,
        })
        const stored = { encoded, reference }
        storedManifestPages.push(stored)
        previousStoredManifestPage = stored
      }
      const manifestHead =
        createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
          artifact,
          objectKeyPrefix: this.provenanceObjectKeyPrefix,
          storedManifestPages,
        })
      this.requireProvenanceHeadIdentity(manifestHead)
      const manifestHeadBytes =
        serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          manifestHead,
        )
      const manifestHeadReference = await this.writeObject({
        objectKeyPrefix: this.provenanceObjectKeyPrefix,
        role: manifestHeadRole,
        bytes: manifestHeadBytes,
        contentDigest: digestPlanningArtifactBytes(manifestHeadBytes),
        retainUntil,
        metadata: this.provenanceMetadata,
      })
      return { manifestHead, manifestHeadReference }
    })
  }

  /**
   * Replays complete provenance from one exact compact-head version.
   *
   * @param input - Exact immutable compact-head root.
   * @returns Detached strict full provenance artifact.
   */
  async replayPlanningProvenanceArtifact(
    input:
      ReplayWorkspaceSearchMigrationStoredPlanningProvenanceArtifactInput,
  ): Promise<WorkspaceSearchMigrationPlanningProvenanceArtifact> {
    return runPlanningArtifactStorageAsyncBoundary(async () => {
      const inputRecord = requirePlanningArtifactRecord(input)
      requireExactPlanningArtifactKeys(inputRecord, [
        'manifestHeadReference',
      ])
      const manifestHeadReference = readPlanningArtifactReference(
        readRequiredPlanningArtifactData(
          inputRecord,
          'manifestHeadReference',
        ),
        this.provenanceObjectKeyPrefix,
        manifestHeadRole,
      )
      const retainUntil = manifestHeadReference.retainUntil
      const manifestHeadBytes = await this.readObject(
        manifestHeadReference,
        this.provenanceObjectKeyPrefix,
        manifestHeadRole,
        this.provenanceMetadata,
        retainUntil,
      )
      const manifestHead =
        parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          manifestHeadBytes,
        )
      this.requireProvenanceHeadIdentity(manifestHead)

      const reversedPages:
        WorkspaceSearchMigrationPlanningProvenanceReferencedBytes[] = []
      let pageReference:
        WorkspaceSearchMigrationPlanningProvenanceManifestReference | null =
          manifestHead.terminalManifestPageLocator.reference
      for (
        let pageIndex = manifestHead.manifestPageCount - 1;
        pageIndex >= 0;
        pageIndex -= 1
      ) {
        if (pageReference === null) {
          return failPlanningArtifactStorage()
        }
        const reference = readPlanningArtifactReference(
          pageReference,
          this.provenanceObjectKeyPrefix,
          manifestPageRole,
        )
        const bytes = await this.readObject(
          reference,
          this.provenanceObjectKeyPrefix,
          manifestPageRole,
          this.provenanceMetadata,
          retainUntil,
        )
        const page =
          parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(
            bytes,
          )
        if (
          page.pageIndex !== pageIndex ||
          page.summary.runId !== this.runId ||
          page.summary.configurationHash !== this.configurationHash ||
          page.summary.objectKeyPrefix !==
            this.provenanceObjectKeyPrefix
        ) {
          return failPlanningArtifactStorage()
        }
        reversedPages.push({ reference, bytes })
        pageReference = page.previousPageReference
      }
      if (
        pageReference !== null ||
        reversedPages.length >
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES
      ) {
        return failPlanningArtifactStorage()
      }
      const manifestPages = reversedPages.reverse()
      const segmentReferences = manifestPages.flatMap(({ bytes }) =>
        parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(bytes)
          .segments.map(({ reference }) => reference)
      )
      if (
        segmentReferences.length !== manifestHead.segmentCount ||
        segmentReferences.length >
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS
      ) {
        return failPlanningArtifactStorage()
      }
      const preparedSegmentReferences =
        segmentReferences.map((candidate) =>
          readPlanningArtifactReference(
            candidate,
            this.provenanceObjectKeyPrefix,
            segmentRole,
            { retainUntil },
          )
        )
      let totalSegmentBytes = 0
      for (const reference of preparedSegmentReferences) {
        totalSegmentBytes = addBoundedPlanningArtifactBytes(
          totalSegmentBytes,
          reference.byteLength,
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
        )
      }
      const segments:
        WorkspaceSearchMigrationPlanningProvenanceReferencedBytes[] = []
      for (const reference of preparedSegmentReferences) {
        const bytes = await this.readObject(
          reference,
          this.provenanceObjectKeyPrefix,
          segmentRole,
          this.provenanceMetadata,
          retainUntil,
        )
        segments.push({ reference, bytes })
      }
      const artifact =
        replayWorkspaceSearchMigrationPlanningProvenanceManifest(
          {
            head: manifestHead,
            manifestPages,
            segments,
          },
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
        )
      if (
        artifact.runId !== this.runId ||
        artifact.configurationHash !== this.configurationHash
      ) {
        return failPlanningArtifactStorage()
      }
      return artifact
    })
  }

  /**
   * Uploads and verifies one exact codec-owned immutable object.
   *
   * @param input - Exact bytes, role, prefix, metadata, and retention.
   * @returns Detached strict rich immutable reference.
   */
  private async writeObject(
    input: PreparedPlanningArtifactObject,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    const reference =
      await this.immutableArtifactPort.write({
        role: input.role,
        objectKeyPrefix: input.objectKeyPrefix,
        bytes: input.bytes,
        metadata: input.metadata,
        retainUntil: input.retainUntil,
      })
    return readPlanningArtifactReference(
      reference,
      input.objectKeyPrefix,
      input.role,
      {
        contentDigest: input.contentDigest,
        byteLength: input.bytes.byteLength,
        retainUntil: input.retainUntil,
      },
    )
  }

  /**
   * Reads and verifies one exact version-pinned immutable object.
   *
   * @param reference - Exact expected rich reference.
   * @param objectKeyPrefix - Codec-owned object-key prefix.
   * @param role - Role-separated object namespace.
   * @param metadata - Exact caller-owned metadata.
   * @param retainUntil - Shared graph retention deadline.
   * @returns Detached exact bytes.
   */
  private async readObject(
    reference: WorkspaceSearchMigrationImmutableArtifactReference,
    objectKeyPrefix: string,
    role: string,
    metadata: Readonly<Record<string, string>>,
    retainUntil: string,
  ): Promise<Uint8Array> {
    const expected = readPlanningArtifactReference(
      reference,
      objectKeyPrefix,
      role,
      {
        contentDigest: reference.contentDigest,
        byteLength: reference.byteLength,
        retainUntil,
      },
    )
    const bytes =
      await this.immutableArtifactPort.read({
        role,
        objectKeyPrefix,
        reference: expected,
        metadata,
      })
    const detached = snapshotPlanningArtifactBytes(bytes)
    if (
      detached.byteLength !== expected.byteLength ||
      digestPlanningArtifactBytes(detached) !== expected.contentDigest
    ) {
      return failPlanningArtifactStorage()
    }
    return detached
  }

  /**
   * Requires one strict plan seal to match the measured gateway identity.
   *
   * @param planSeal - Detached strict plan seal.
   */
  private requirePlanIdentity(planSeal: WorkspaceSearchPlanSeal): void {
    if (
      planSeal.runId !== this.runId ||
      planSeal.configurationHash !== this.configurationHash
    ) {
      return failPlanningArtifactStorage()
    }
  }

  /**
   * Requires one strict plan head to match the measured gateway identity.
   *
   * @param head - Detached strict operation-manifest head.
   */
  private requirePlanHeadIdentity(
    head: WorkspaceSearchMigrationPlanManifestHead,
  ): void {
    if (
      head.runId !== this.runId ||
      head.configurationHash !== this.configurationHash
    ) {
      return failPlanningArtifactStorage()
    }
  }

  /**
   * Requires one strict provenance head to match gateway identity and prefix.
   *
   * @param head - Detached strict provenance manifest head.
   */
  private requireProvenanceHeadIdentity(
    head: WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  ): void {
    if (
      head.summary.runId !== this.runId ||
      head.summary.configurationHash !== this.configurationHash ||
      head.summary.objectKeyPrefix !==
        this.provenanceObjectKeyPrefix
    ) {
      return failPlanningArtifactStorage()
    }
  }
}

/**
 * Snapshots the immutable-object port without retaining mutable methods.
 *
 * @param value - Candidate measured immutable-object port.
 * @returns Detached method closures.
 */
function snapshotPlanningArtifactImmutablePort(
  value: unknown,
): PreparedPlanningArtifactImmutablePort {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPlanningArtifactStorage()
  }
  const writeMethod = readPlanningArtifactDataMethod(
    value,
    'writeImmutableArtifact',
  )
  const readMethod = readPlanningArtifactDataMethod(
    value,
    'readImmutableArtifact',
  )
  return {
    write: (input) =>
      Promise.resolve(Reflect.apply(writeMethod, value, [input])),
    read: (input) =>
      Promise.resolve(Reflect.apply(readMethod, value, [input])),
  }
}

/**
 * Reads one inherited data method without invoking accessors.
 *
 * @param value - Validated non-proxy receiver.
 * @param name - Required method name.
 * @returns Exact callable data property.
 */
function readPlanningArtifactDataMethod(
  value: object | Function,
  name: string,
): Function {
  let current: object | null = value
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      return failPlanningArtifactStorage()
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failPlanningArtifactStorage()
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failPlanningArtifactStorage()
}

/**
 * Requires one plain non-array, non-proxy data record.
 *
 * @param value - Candidate record.
 * @returns Safe object for descriptor-only reads.
 */
function requirePlanningArtifactRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPlanningArtifactStorage()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact required property set.
 */
function requireExactPlanningArtifactKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = readPlanningArtifactOwnDataKeys(value).sort()
  const expectedKeys = [...expected].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failPlanningArtifactStorage()
  }
}

/**
 * Requires only accepted keys and the complete required subset.
 *
 * @param value - Validated record.
 * @param accepted - Complete accepted property set.
 * @param required - Required property subset.
 */
function requireExactOptionalPlanningArtifactKeys(
  value: object,
  accepted: readonly string[],
  required: readonly string[],
): void {
  const keys = readPlanningArtifactOwnDataKeys(value)
  const acceptedSet = new Set(accepted)
  if (
    keys.some((key) => !acceptedSet.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return failPlanningArtifactStorage()
  }
}

/**
 * Reads all enumerable own string data-property keys.
 *
 * @param value - Validated non-proxy record.
 * @returns Exact enumerable data-property keys.
 */
function readPlanningArtifactOwnDataKeys(value: object): string[] {
  const ownKeys = Reflect.ownKeys(value)
  const keys = Object.keys(value)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length
  ) {
    return failPlanningArtifactStorage()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failPlanningArtifactStorage()
    }
  }
  return keys
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required property name.
 * @returns Exact untrusted data value.
 */
function readRequiredPlanningArtifactData(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failPlanningArtifactStorage()
  }
  return descriptor.value
}

/**
 * Reads one optional enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Optional property name.
 * @returns Exact untrusted data value or undefined.
 */
function readOptionalPlanningArtifactData(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failPlanningArtifactStorage()
  }
  return descriptor.value
}

/**
 * Checks whether a candidate can be passed to the strict plan-seal codec.
 *
 * @param value - Candidate semantic plan seal.
 * @returns Whether strict codec validation can safely inspect the candidate.
 */
function isWorkspaceSearchPlanSealCandidate(
  value: unknown,
): value is WorkspaceSearchPlanSeal {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
  )
}

/**
 * Checks whether a candidate can be passed to the strict operation codec.
 *
 * @param value - Candidate complete operation list.
 * @returns Whether strict codec validation can safely inspect the list.
 */
function isWorkspaceSearchPlannedOperationArrayCandidate(
  value: unknown,
): value is readonly WorkspaceSearchPlannedOperation[] {
  return Array.isArray(value) && !nodeUtilTypes.isProxy(value)
}

/**
 * Checks whether a candidate can enter the strict provenance codec.
 *
 * @param value - Candidate full provenance artifact.
 * @returns Whether strict codec validation can safely inspect the candidate.
 */
function isWorkspaceSearchPlanningProvenanceArtifactCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningProvenanceArtifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
  )
}

/**
 * Reads one optional positive bounded packing limit.
 *
 * @param value - Candidate optional byte ceiling.
 * @param maximum - Absolute codec ceiling.
 * @returns Valid optional finite byte ceiling.
 */
function readOptionalPlanningArtifactMaximum(
  value: unknown,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return failPlanningArtifactStorage()
  }
  return value
}

/**
 * Adds canonical bytes without exceeding one planning graph ceiling.
 *
 * @param current - Previously accumulated canonical bytes.
 * @param additional - Additional canonical bytes.
 * @param maximum - Inclusive aggregate byte ceiling.
 * @returns Exact bounded safe-integer byte total.
 */
function addBoundedPlanningArtifactBytes(
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
    return failPlanningArtifactStorage()
  }
  return total
}

/**
 * Validates one safe operator-selected run identifier.
 *
 * @param value - Candidate run identifier.
 * @returns Safe run identifier.
 */
function readPlanningArtifactRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    return failPlanningArtifactStorage()
  }
  return value
}

/**
 * Creates exact nonsecret caller metadata for one planning graph.
 *
 * @param bundle - Plan or provenance graph family.
 * @param runId - Safe run identifier.
 * @param configurationHash - Exact measured-configuration digest.
 * @returns Exact metadata shared by every object in the graph.
 */
function createPlanningArtifactMetadata(
  bundle: 'plan' | 'provenance',
  runId: string,
  configurationHash: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'mukuroji-planning-artifact-bundle': bundle,
    'mukuroji-planning-run-id': runId,
    'mukuroji-planning-configuration-sha256': configurationHash,
  })
}

/**
 * Validates and detaches one rich immutable planning reference.
 *
 * @param value - Candidate exact rich reference.
 * @param objectKeyPrefix - Expected codec-owned key prefix.
 * @param role - Expected role-separated namespace.
 * @param expectation - Optional exact digest, length, and retention fields.
 * @returns Detached strict rich immutable reference.
 */
function readPlanningArtifactReference(
  value: unknown,
  objectKeyPrefix: string,
  role: string,
  expectation: PlanningArtifactReferenceExpectation = {},
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requirePlanningArtifactRecord(value)
  requireExactPlanningArtifactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const objectKey =
    readRequiredPlanningArtifactData(record, 'objectKey')
  const versionId =
    readRequiredPlanningArtifactData(record, 'versionId')
  const contentDigest =
    readRequiredPlanningArtifactData(record, 'contentDigest')
  const byteLength =
    readRequiredPlanningArtifactData(record, 'byteLength')
  const retainUntil =
    readRequiredPlanningArtifactData(record, 'retainUntil')
  const maximumObjectBytes =
    readPlanningArtifactRoleMaximumBytes(objectKeyPrefix, role)
  if (
    typeof objectKey !== 'string' ||
    typeof versionId !== 'string' ||
    versionId.length === 0 ||
    versionId.length > 1_024 ||
    versionId === 'null' ||
    !hasOnlyPairedSurrogates(versionId) ||
    !isHexDigest(contentDigest) ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > maximumObjectBytes ||
    !isCanonicalTimestamp(retainUntil) ||
    (
      expectation.contentDigest !== undefined &&
      contentDigest !== expectation.contentDigest
    ) ||
    (
      expectation.byteLength !== undefined &&
      byteLength !== expectation.byteLength
    ) ||
    (
      expectation.retainUntil !== undefined &&
      retainUntil !== expectation.retainUntil
    ) ||
    objectKey !==
      `${objectKeyPrefix}/${role}/${contentDigest}.artifact`
  ) {
    return failPlanningArtifactStorage()
  }
  return {
    objectKey,
    versionId,
    contentDigest,
    byteLength,
    retainUntil,
  }
}

/**
 * Resolves the codec-owned hard byte ceiling for one planning object role.
 *
 * @param objectKeyPrefix - Exact plan or run-scoped provenance prefix.
 * @param role - Exact object role within that prefix.
 * @returns Inclusive codec-owned object byte ceiling.
 */
function readPlanningArtifactRoleMaximumBytes(
  objectKeyPrefix: string,
  role: string,
): number {
  if (
    objectKeyPrefix ===
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX
  ) {
    if (role === planSealRole) {
      return WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES
    }
    if (role === segmentRole) {
      return WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES
    }
    if (role === manifestPageRole) {
      return WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES
    }
    if (role === manifestHeadRole) {
      return WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES
    }
    return failPlanningArtifactStorage()
  }
  if (
    !objectKeyPrefix.startsWith(
      `${WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX}/`,
    )
  ) {
    return failPlanningArtifactStorage()
  }
  if (role === segmentRole) {
    return WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES
  }
  if (role === manifestPageRole) {
    return WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES
  }
  if (role === manifestHeadRole) {
    return WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES
  }
  return failPlanningArtifactStorage()
}

/**
 * Requires one reference to use the graph's shared retention deadline.
 *
 * @param reference - Candidate exact rich reference.
 * @param retainUntil - Expected shared retention deadline.
 */
function requireSameRetention(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
  retainUntil: string,
): void {
  if (reference.retainUntil !== retainUntil) {
    return failPlanningArtifactStorage()
  }
}

/**
 * Validates one canonical graph-wide COMPLIANCE retention deadline.
 *
 * @param value - Candidate canonical UTC deadline.
 * @returns Validated canonical deadline.
 */
function readPlanningArtifactRetention(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failPlanningArtifactStorage()
  }
  return value
}

/**
 * Detaches one bounded immutable byte array without trusting subclasses.
 *
 * @param value - Candidate exact bytes returned by storage.
 * @returns Detached exact bytes.
 */
function snapshotPlanningArtifactBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failPlanningArtifactStorage()
  }
  const byteLength =
    readIntrinsicPlanningArtifactByteLength(value)
  const buffer = readIntrinsicPlanningArtifactBuffer(value)
  if (
    isPlanningArtifactSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES
  ) {
    return failPlanningArtifactStorage()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failPlanningArtifactStorage()
  }
  return copy
}

/**
 * Reads a Uint8Array's intrinsic byte length.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readIntrinsicPlanningArtifactByteLength(
  value: Uint8Array,
): number {
  const typedArrayPrototype =
    Object.getPrototypeOf(Uint8Array.prototype)
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'byteLength',
    )
  if (descriptor?.get === undefined) {
    return failPlanningArtifactStorage()
  }
  try {
    const byteLength: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength)
    ) {
      return failPlanningArtifactStorage()
    }
    return byteLength
  } catch {
    return failPlanningArtifactStorage()
  }
}

/**
 * Reads a Uint8Array's intrinsic backing buffer.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic backing buffer.
 */
function readIntrinsicPlanningArtifactBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype =
    Object.getPrototypeOf(Uint8Array.prototype)
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'buffer',
    )
  if (descriptor?.get === undefined) {
    return failPlanningArtifactStorage()
  }
  try {
    const buffer: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      !(buffer instanceof ArrayBuffer) &&
      !isPlanningArtifactSharedArrayBuffer(buffer)
    ) {
      return failPlanningArtifactStorage()
    }
    return buffer
  } catch {
    return failPlanningArtifactStorage()
  }
}

/**
 * Checks whether shared mutable memory backs one byte view.
 *
 * @param value - Candidate backing buffer.
 * @returns Whether the value is a real SharedArrayBuffer.
 */
function isPlanningArtifactSharedArrayBuffer(
  value: unknown,
): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
}

/**
 * Computes the lowercase SHA-256 digest of exact immutable bytes.
 *
 * @param bytes - Exact object bytes.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function digestPlanningArtifactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Runs one synchronous public operation behind a stable error boundary.
 *
 * Trusted codec-agnostic storage failures retain their operator-safe category;
 * codec, graph, and unknown injected-port failures are replaced.
 *
 * @param operation - Synchronous public operation.
 * @returns Exact successful result.
 */
function runPlanningArtifactStorageBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replacePlanningArtifactStorageFailure(error)
  }
}

/**
 * Runs one asynchronous public operation behind a stable error boundary.
 *
 * @param operation - Asynchronous public operation.
 * @returns Exact successful result.
 */
async function runPlanningArtifactStorageAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replacePlanningArtifactStorageFailure(error)
  }
}

/**
 * Preserves trusted core failure categories and replaces all raw failures.
 *
 * @param error - Unknown caught boundary failure.
 * @returns Never returns.
 */
function replacePlanningArtifactStorageFailure(error: unknown): never {
  if (
    !nodeUtilTypes.isProxy(error) &&
    error instanceof WorkspaceSearchMigrationFailure
  ) {
    const codeDescriptor =
      Object.getOwnPropertyDescriptor(error, 'code')
    if (
      codeDescriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(
        codeDescriptor,
        'value',
      ) &&
      isWorkspaceSearchMigrationFailureCode(codeDescriptor.value)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        codeDescriptor.value,
        codeDescriptor.value,
      )
    }
  }
  throw new WorkspaceSearchMigrationPlanningArtifactAwsError()
}

/**
 * Raises the stable planning storage-graph failure.
 *
 * @returns Never returns.
 */
function failPlanningArtifactStorage(): never {
  throw new WorkspaceSearchMigrationPlanningArtifactAwsError()
}
