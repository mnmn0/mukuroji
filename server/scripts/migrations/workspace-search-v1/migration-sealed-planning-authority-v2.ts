import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchPlanSeal,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
} from './migration-artifacts'
import type {
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  parseWorkspaceSearchMigrationPlanManifestHead,
  type WorkspaceSearchMigrationPlanManifestHead,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
  type WorkspaceSearchMigrationPlanningAuthorityProvenance,
  type WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
  type WorkspaceSearchMigrationPlanningAuthorityTransition,
  type WorkspaceSearchMigrationPlanningEvidenceChainRole,
  type WorkspaceSearchMigrationPlanningEvidenceChainRoot,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
  parseWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
} from './migration-planning-provenance-manifest'
import {
  type WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
  type WorkspaceSearchMigrationSealedPlanningEvidenceHead,
  type WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidenceProgressDigest,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import {
  assertWorkspaceSearchMigrationLeaseAuthority,
  createEmptyWorkspaceSearchPlanDigest,
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidenceProgressDigest,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Maximum canonical bytes accepted for one version-two sealed authority.
 */
export const WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES =
  256 * 1024

const maximumPlanningEvidencePageCount = 10_000
const maximumPlannedOperationCount = 100_000
const maximumSafeGraphNodes = 250_000
const maximumSafeGraphTextBytes = 64 * 1024 * 1024
const maximumImmutableReferenceTextLength = 1_024
const planSealRole = 'plan-seals'
const segmentRole = 'segments'
const manifestPageRole = 'manifest-pages'
const manifestHeadRole = 'manifest-heads'
const planningProvenanceArtifactObjectKeyPrefix =
  'workspace-search/v1/planning-provenance-artifacts/v1'
const planningChainOrder:
  readonly WorkspaceSearchMigrationPlanningEvidenceChainRole[] = [
    ...workspaceSearchMigrationSourceNames,
    'workspace-search',
  ]

/**
 * Stable raw-value-free failure raised for an invalid version-two authority.
 */
export class WorkspaceSearchMigrationSealedPlanningAuthorityV2Error
  extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_SEALED_PLANNING_AUTHORITY_V2'

  /** Creates one stable version-two authority failure. */
  constructor() {
    super('INVALID_SEALED_PLANNING_AUTHORITY_V2')
    this.name = 'WorkspaceSearchMigrationSealedPlanningAuthorityV2Error'
  }
}

/**
 * Compact immutable publication root binding both manifest heads.
 */
export type WorkspaceSearchMigrationSealedPlanningAuthorityV2 = {
  /** Sealed planning-authority record discriminator. */
  readonly kind: 'workspace-search-sealed-planning-authority'
  /** Sealed planning-authority schema version. */
  readonly authorityVersion: 2
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical DynamoDB table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Rich exact-version reference to the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Rich exact-version reference to the compact plan manifest head. */
  readonly planManifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Rich exact-version reference to the compact provenance manifest head. */
  readonly planningProvenanceManifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Merkle root of every exact ordered planned operation. */
  readonly planDigest: string
  /** Digest of source and target aggregates reproduced during planning. */
  readonly planningSnapshotDigest: string
  /** Exact source-owned operation count. */
  readonly sourceOperationCount: number
  /** Exact orphan-target operation count. */
  readonly orphanOperationCount: number
  /** Exact complete operation count. */
  readonly planOperationCount: number
  /** Digest of the complete five-chain authority provenance. */
  readonly planningAuthorityProvenanceDigest: string
  /** Digest of every transition-ordered historical receipt binding. */
  readonly historicalReceiptBindingDigest: string
  /** Exact transition-ordered historical receipt count. */
  readonly historicalReceiptCount: number
  /** Five exact terminal evidence commitments in canonical role order. */
  readonly evidenceHeads:
    readonly WorkspaceSearchMigrationSealedPlanningEvidenceHead[]
  /** Current authority atomically condition-checked during publication. */
  readonly currentAuthority:
    WorkspaceSearchMigrationSealedPlanningCurrentAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly sealedAt: string
  /** Digest of every preceding compact authority field. */
  readonly authorityDigest: string
}

/**
 * Input used to construct one manifest-aware version-two authority.
 */
export type CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input = {
  /** Operator-selected migration run. */
  readonly runId: string
  /** Complete measured configuration whose digest was reviewed. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Strict canonical plan-seal v2 root. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Rich exact-version reference to the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Strict compact complete-plan manifest head. */
  readonly planManifestHead: WorkspaceSearchMigrationPlanManifestHead
  /** Rich exact-version reference to the plan manifest head. */
  readonly planManifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Strict compact complete-provenance manifest head. */
  readonly planningProvenanceManifestHead:
    WorkspaceSearchMigrationPlanningProvenanceManifestHead
  /** Rich exact-version reference to the provenance manifest head. */
  readonly planningProvenanceManifestHeadReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Complete canonical five-chain authority provenance. */
  readonly planningAuthorityProvenance:
    WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Four exact completed planning source progress heads. */
  readonly sourceProgress: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >
  /** Exact completed planning target progress head. */
  readonly targetProgress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Exact fresh authority resolved immediately before publication. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly sealedAt: string
}

/**
 * Mutable bounds used while proving a caller graph contains only safe data.
 */
type SafeGraphBudget = {
  /** Number of values already visited. */
  nodes: number
  /** UTF-8 bytes consumed by property names and string values. */
  textBytes: number
  /** Objects on the current traversal path, used to reject cycles. */
  readonly active: WeakSet<object>
  /** Objects already proven safe, allowing ordinary repeated references. */
  readonly visited: WeakSet<object>
}

/**
 * Creates one compact manifest-aware sealed planning authority.
 *
 * @param input - Exact plan, manifest heads, provenance, progress, and lease.
 * @returns Detached canonical version-two authority.
 */
export function createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
  input: CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return runV2Boundary(() => {
    const detached = detachSafeGraph(input)
    requireExactKeys(detached, [
      'configuration',
      'configurationHash',
      'currentAuthority',
      'planManifestHead',
      'planManifestHeadReference',
      'planSeal',
      'planSealReference',
      'planningAuthorityProvenance',
      'planningProvenanceManifestHead',
      'planningProvenanceManifestHeadReference',
      'runId',
      'sealedAt',
      'sourceProgress',
      'targetProgress',
    ])
    const runId = readIdentifier(detached.runId)
    const configurationHash = readDigest(detached.configurationHash)
    const configuration =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        detached.configuration,
      )
    if (
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationHash
    ) {
      return failV2()
    }
    const tableIds = createTableIds(configuration)
    const stateTableId = tableIds['migration-state']

    const planSealBytes = serializeWorkspaceSearchPlanSeal(
      detached.planSeal,
    )
    const planSeal = parseWorkspaceSearchPlanSeal(planSealBytes)
    const planSealReference = readRichReference(
      detached.planSealReference,
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
      planSealRole,
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
    )
    requireExactReferenceBytes(planSealReference, planSealBytes)

    const planManifestHeadBytes = encodeCanonical(
      detached.planManifestHead,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
    )
    const planManifestHead =
      parseWorkspaceSearchMigrationPlanManifestHead(
        planManifestHeadBytes,
      )
    const planManifestHeadReference = readRichReference(
      detached.planManifestHeadReference,
      WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
      manifestHeadRole,
      WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
    )
    requireExactReferenceBytes(
      planManifestHeadReference,
      planManifestHeadBytes,
    )
    requirePlanManifestHeadReferences(
      planManifestHead,
      planSealReference.retainUntil,
    )

    const planningProvenanceManifestHeadBytes =
      serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
        detached.planningProvenanceManifestHead,
      )
    const planningProvenanceManifestHead =
      parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
        planningProvenanceManifestHeadBytes,
      )
    const expectedPlanningProvenanceObjectKeyPrefix =
      createPlanningProvenanceObjectKeyPrefix(
        runId,
        configurationHash,
      )
    if (
      planningProvenanceManifestHead.summary.objectKeyPrefix !==
        expectedPlanningProvenanceObjectKeyPrefix
    ) {
      return failV2()
    }
    const planningProvenanceManifestHeadReference = readRichReference(
      detached.planningProvenanceManifestHeadReference,
      expectedPlanningProvenanceObjectKeyPrefix,
      manifestHeadRole,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
    )
    requireExactReferenceBytes(
      planningProvenanceManifestHeadReference,
      planningProvenanceManifestHeadBytes,
    )
    requirePlanningProvenanceManifestHeadReference(
      planningProvenanceManifestHead,
      expectedPlanningProvenanceObjectKeyPrefix,
      planningProvenanceManifestHeadReference.retainUntil,
    )

    const provenance = readPlanningAuthorityProvenance(
      detached.planningAuthorityProvenance,
    )
    const summary = planningProvenanceManifestHead.summary
    requirePlanAndProvenanceCorrelation(
      runId,
      configurationHash,
      tableIds,
      planSeal,
      planSealReference,
      planManifestHead,
      planningProvenanceManifestHead,
      provenance,
    )
    const evidenceHeads = createEvidenceHeads(
      detached.sourceProgress,
      detached.targetProgress,
      provenance,
      runId,
      configurationHash,
      tableIds,
    )
    const sealedAt = readTimestamp(detached.sealedAt)
    if (
      Date.parse(planSeal.createdAt) > Date.parse(sealedAt) ||
      Date.parse(planSealReference.retainUntil) <=
        Date.parse(sealedAt) ||
      planSealReference.retainUntil !==
        planManifestHeadReference.retainUntil ||
      planSealReference.retainUntil !==
        planningProvenanceManifestHeadReference.retainUntil
    ) {
      return failV2()
    }
    const currentAuthority = readCurrentAuthority(
      detached.currentAuthority,
      runId,
      configurationHash,
      stateTableId,
      sealedAt,
    )
    requireCurrentAuthoritySuccessor(
      provenance.authorityTransitions,
      currentAuthority,
    )

    const authority = {
      kind: 'workspace-search-sealed-planning-authority',
      authorityVersion: 2,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      tableIds,
      planSealReference,
      planManifestHeadReference,
      planningProvenanceManifestHeadReference,
      planDigest: planSeal.planDigest,
      planningSnapshotDigest: planSeal.planningSnapshotDigest,
      sourceOperationCount: planSeal.sourceOperationCount,
      orphanOperationCount: planSeal.orphanOperationCount,
      planOperationCount: planSeal.planOperationCount,
      planningAuthorityProvenanceDigest: provenance.provenanceDigest,
      historicalReceiptBindingDigest:
        summary.historicalReceiptBindingDigest,
      historicalReceiptCount: summary.historicalReceiptCount,
      evidenceHeads,
      currentAuthority,
      sealedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
      'authorityDigest'
    >
    const result = {
      ...authority,
      authorityDigest: createMigrationDigest(authority),
    }
    void encodeCanonical(
      result,
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES,
    )
    return result
  })
}

/**
 * Serializes one strict version-two authority as canonical UTF-8 JSON.
 *
 * @param value - Candidate compact authority.
 * @returns Exact canonical bounded bytes.
 */
export function serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
  value: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): Uint8Array {
  return runV2Boundary(() =>
    encodeCanonical(
      readSealedPlanningAuthorityV2(detachSafeGraph(value)),
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES,
    )
  )
}

/**
 * Parses exact canonical version-two authority bytes.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict compact authority.
 */
export function parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return runV2Boundary(() => {
    const snapshot = copyBoundedBytes(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES,
    )
    let parsed: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
      parsed = JSON.parse(text)
    } catch {
      return failV2()
    }
    const authority = readSealedPlanningAuthorityV2(parsed)
    const canonical = encodeCanonical(
      authority,
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES,
    )
    if (!Buffer.from(snapshot).equals(Buffer.from(canonical))) {
      return failV2()
    }
    return authority
  })
}

/**
 * Requires all plan, manifest, configuration, and provenance summaries agree.
 *
 * @param runId - Required run identifier.
 * @param configurationHash - Required measured-configuration digest.
 * @param tableIds - Required six measured table IDs.
 * @param planSeal - Strict plan seal.
 * @param planSealReference - Exact stored plan-seal reference.
 * @param planHead - Strict compact plan head.
 * @param provenanceHead - Strict compact provenance head.
 * @param provenance - Strict full authority provenance.
 */
function requirePlanAndProvenanceCorrelation(
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  planSealReference: WorkspaceSearchMigrationImmutableArtifactReference,
  planHead: WorkspaceSearchMigrationPlanManifestHead,
  provenanceHead:
    WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
): void {
  const summary = provenanceHead.summary
  const evidencePageCount = summary.chainRoots.reduce(
    (total, root) => addSafeCounts(total, root.pageCount),
    0,
  )
  if (
    planSeal.runId !== runId ||
    planSeal.configurationHash !== configurationHash ||
    planSeal.planOperationCount > maximumPlannedOperationCount ||
    planSeal.sourceOperationCount + planSeal.orphanOperationCount !==
      planSeal.planOperationCount ||
    !Number.isSafeInteger(planSeal.planOperationCount) ||
    (planSeal.planOperationCount === 0) !==
      (planSeal.planDigest === createEmptyWorkspaceSearchPlanDigest()) ||
    planHead.runId !== runId ||
    planHead.configurationHash !== configurationHash ||
    planHead.planDigest !== planSeal.planDigest ||
    planHead.planSealContentDigest !== planSealReference.contentDigest ||
    planHead.planOperationCount !== planSeal.planOperationCount ||
    planHead.planSegmentCount > planHead.planOperationCount ||
    summary.runId !== runId ||
    summary.configurationHash !== configurationHash ||
    !sameTableIds(summary.tableIds, tableIds) ||
    summary.planningSnapshotDigest !== planSeal.planningSnapshotDigest ||
    summary.sourceOperationCount !== planSeal.sourceOperationCount ||
    summary.orphanOperationCount !== planSeal.orphanOperationCount ||
    summary.planOperationCount !== planSeal.planOperationCount ||
    summary.evidencePageCount !== evidencePageCount ||
    provenanceHead.evidenceSegmentCount >
      summary.evidencePageCount ||
    provenanceHead.receiptSegmentCount >
      summary.historicalReceiptCount ||
    provenanceHead.manifestPageCount >
      provenanceHead.segmentCount ||
    provenance.runId !== runId ||
    provenance.configurationHash !== configurationHash ||
    provenance.stateTableId !== tableIds['migration-state'] ||
    provenance.provenanceDigest !== summary.provenanceDigest ||
    provenance.authorityTransitions.length !==
      summary.historicalReceiptCount ||
    !sameChainRoots(provenance.chainRoots, summary.chainRoots)
  ) {
    return failV2()
  }
}

/**
 * Requires both nonempty plan-head terminals to be replayable exact roles.
 *
 * @param head - Strict compact plan manifest head.
 * @param retainUntil - Shared immutable graph retention deadline.
 */
function requirePlanManifestHeadReferences(
  head: WorkspaceSearchMigrationPlanManifestHead,
  retainUntil: string,
): void {
  if (
    head.terminalSegmentReference === null ||
    head.terminalManifestPageReference === null
  ) {
    if (
      head.terminalSegmentReference !== null ||
      head.terminalManifestPageReference !== null
    ) {
      return failV2()
    }
    return
  }
  const segmentReference = readRichReference(
    head.terminalSegmentReference,
    WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
    segmentRole,
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
  )
  const manifestPageReference = readRichReference(
    head.terminalManifestPageReference,
    WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
    manifestPageRole,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  )
  if (
    segmentReference.retainUntil !== retainUntil ||
    manifestPageReference.retainUntil !== retainUntil
  ) {
    return failV2()
  }
}

/**
 * Requires the provenance-head terminal to be one replayable manifest page.
 *
 * @param head - Strict compact provenance manifest head.
 * @param objectKeyPrefix - Exact run/configuration-scoped graph prefix.
 * @param retainUntil - Shared immutable graph retention deadline.
 */
function requirePlanningProvenanceManifestHeadReference(
  head: WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  objectKeyPrefix: string,
  retainUntil: string,
): void {
  const reference = readRichReference(
    head.terminalManifestPageLocator.reference,
    objectKeyPrefix,
    manifestPageRole,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  )
  if (reference.retainUntil !== retainUntil) return failV2()
}

/**
 * Creates and validates the five compact terminal progress commitments.
 *
 * @param sourceProgress - Four completed source heads.
 * @param targetProgress - Completed target head.
 * @param provenance - Strict five-chain provenance.
 * @param runId - Required run identifier.
 * @param configurationHash - Required configuration digest.
 * @param tableIds - Required physical table IDs.
 * @returns Five heads in canonical source-then-target order.
 */
function createEvidenceHeads(
  sourceProgress: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >,
  targetProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): readonly WorkspaceSearchMigrationSealedPlanningEvidenceHead[] {
  requireExactKeys(sourceProgress, workspaceSearchMigrationSourceNames)
  const heads: WorkspaceSearchMigrationSealedPlanningEvidenceHead[] = []
  for (const source of workspaceSearchMigrationSourceNames) {
    const progress = sourceProgress[source]
    requireExactKeys(progress, [
      'checkpoint',
      'configurationHash',
      'evidenceDigest',
      'pageSequence',
      'purpose',
      'runId',
      'source',
      'sourceTableId',
      'stateTableId',
    ])
    const root = provenance.chainRoots[heads.length]
    const progressDigest =
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
        progress,
      )
    if (
      root === undefined ||
      root.chain !== source ||
      progress.purpose !== 'planning' ||
      progress.runId !== runId ||
      progress.configurationHash !== configurationHash ||
      progress.source !== source ||
      progress.sourceTableId !== tableIds[source] ||
      progress.stateTableId !== tableIds['migration-state'] ||
      progress.pageSequence !== root.pageCount ||
      progress.evidenceDigest !== root.terminalEvidenceDigest ||
      !progress.checkpoint.completed ||
      progress.checkpoint.cursor !== undefined ||
      progress.checkpoint.aggregate.invalid !== 0 ||
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.checkpoint,
      ) !== root.terminalCheckpointDigest
    ) {
      return failV2()
    }
    heads.push({
      chain: source,
      progressDigest,
      pageCount: root.pageCount,
      terminalEvidenceDigest: root.terminalEvidenceDigest,
      terminalCheckpointDigest: root.terminalCheckpointDigest,
    })
  }
  requireExactKeys(targetProgress, [
    'checkpoint',
    'configurationHash',
    'evidenceDigest',
    'pageSequence',
    'purpose',
    'runId',
    'stateTableId',
    'targetTableId',
  ])
  const targetRoot = provenance.chainRoots[heads.length]
  const targetProgressDigest =
    createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
      targetProgress,
    )
  if (
    targetRoot === undefined ||
    targetRoot.chain !== 'workspace-search' ||
    targetProgress.purpose !== 'planning' ||
    targetProgress.runId !== runId ||
    targetProgress.configurationHash !== configurationHash ||
    targetProgress.targetTableId !== tableIds['workspace-search'] ||
    targetProgress.stateTableId !== tableIds['migration-state'] ||
    targetProgress.pageSequence !== targetRoot.pageCount ||
    targetProgress.evidenceDigest !== targetRoot.terminalEvidenceDigest ||
    !targetProgress.checkpoint.completed ||
    targetProgress.checkpoint.cursor !== undefined ||
    targetProgress.checkpoint.aggregate.invalid !== 0 ||
    createWorkspaceSearchMigrationTargetCheckpointDigest(
      targetProgress.checkpoint,
    ) !== targetRoot.terminalCheckpointDigest
  ) {
    return failV2()
  }
  heads.push({
    chain: 'workspace-search',
    progressDigest: targetProgressDigest,
    pageCount: targetRoot.pageCount,
    terminalEvidenceDigest: targetRoot.terminalEvidenceDigest,
    terminalCheckpointDigest: targetRoot.terminalCheckpointDigest,
  })
  return heads
}

/**
 * Reads a fresh current authority and projects its compact tuple.
 *
 * @param value - Candidate current pre-plan authority.
 * @param runId - Required run identifier.
 * @param configurationHash - Required configuration digest.
 * @param stateTableId - Required migration-state TableId.
 * @param sealedAt - Publication timestamp used for freshness.
 * @returns Compact current authority.
 */
function readCurrentAuthority(
  value: WorkspaceSearchMigrationPrePlanAuthority,
  runId: string,
  configurationHash: string,
  stateTableId: string,
  sealedAt: string,
): WorkspaceSearchMigrationSealedPlanningCurrentAuthority {
  requireExactKeys(value, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  requireExactKeys(value.lease, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  requireExactKeys(value.maintenanceEvidenceReceipt, [
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'oldestObservationAt',
    'runId',
    'runtimeRevision',
    'validatedAt',
    'validUntil',
  ])
  const evaluatedAt = readTimestamp(value.evaluatedAt)
  const lease = {
    runId: readIdentifier(value.lease.runId),
    ownerId: readIdentifier(value.lease.ownerId),
    fenceToken: readPositiveSafeInteger(value.lease.fenceToken),
    heartbeatAt: readTimestamp(value.lease.heartbeatAt),
    expiresAt: readTimestamp(value.lease.expiresAt),
  }
  const receipt = readMaintenanceReceipt(
    value.maintenanceEvidenceReceipt,
  )
  const receiptDigest = readDigest(
    value.maintenanceEvidenceReceiptDigest,
  )
  if (
    value.configurationHash !== configurationHash ||
    value.stateTableId !== stateTableId ||
    lease.runId !== runId ||
    receipt.runId !== runId ||
    receipt.fenceToken !== lease.fenceToken ||
    createMigrationDigest(receipt) !== receiptDigest ||
    Date.parse(lease.heartbeatAt) > Date.parse(evaluatedAt) ||
    Date.parse(receipt.validatedAt) > Date.parse(evaluatedAt) ||
    Date.parse(evaluatedAt) > Date.parse(sealedAt)
  ) {
    return failV2()
  }
  assertWorkspaceSearchMigrationLeaseAuthority(runId, {
    ownerId: lease.ownerId,
    lease,
    at: sealedAt,
  })
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    runId,
    lease.fenceToken,
    sealedAt,
  )
  return {
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      value.maintenanceEvidencePointerRevision,
    ),
    maintenanceEvidenceReceiptDigest: receiptDigest,
  }
}

/**
 * Reads one exact maintenance-evidence receipt.
 *
 * @param value - Candidate receipt.
 * @returns Detached strict receipt.
 */
function readMaintenanceReceipt(
  value: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const receipt = {
    runId: readIdentifier(value.runId),
    evidenceDigest: readDigest(value.evidenceDigest),
    evidenceLocator: readBoundedText(value.evidenceLocator, 2_048),
    runtimeRevision: readPositiveSafeInteger(value.runtimeRevision),
    fenceToken: readPositiveSafeInteger(value.fenceToken),
    validatedAt: readTimestamp(value.validatedAt),
    oldestObservationAt: readTimestamp(value.oldestObservationAt),
    validUntil: readTimestamp(value.validUntil),
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    receipt.runId,
  )
  return receipt
}

/**
 * Requires current authority to be a realizable provenance successor.
 *
 * @param transitions - Historical transitions ordered by pointer revision.
 * @param current - Current publication authority.
 */
function requireCurrentAuthoritySuccessor(
  transitions:
    readonly WorkspaceSearchMigrationPlanningAuthorityTransition[],
  current: WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
): void {
  const latest = transitions.at(-1)
  if (
    latest === undefined ||
    current.maintenanceEvidencePointerRevision <
      latest.maintenanceEvidencePointerRevision ||
    current.fenceToken < latest.fenceToken
  ) {
    return failV2()
  }
  if (
    current.maintenanceEvidencePointerRevision ===
      latest.maintenanceEvidencePointerRevision
  ) {
    if (!sameTransition(current, latest)) return failV2()
    return
  }
  if (
    current.fenceToken === latest.fenceToken &&
    current.ownerId !== latest.ownerId
  ) {
    return failV2()
  }
  if (
    transitions.some((transition) =>
      transition.maintenanceEvidenceReceiptDigest ===
        current.maintenanceEvidenceReceiptDigest
    )
  ) {
    return failV2()
  }
}

/**
 * Reads and validates a complete five-chain authority provenance.
 *
 * @param value - Candidate provenance.
 * @returns Detached strict provenance.
 */
function readPlanningAuthorityProvenance(
  value: unknown,
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
    readOwn(record, 'provenanceVersion') !== 1
  ) {
    return failV2()
  }
  const roots = requireDenseArray(
    readOwn(record, 'chainRoots'),
    planningChainOrder.length,
  )
  if (roots.length !== planningChainOrder.length) return failV2()
  const chainRoots = roots.map((candidate, index) => {
    const chain = planningChainOrder[index]
    if (chain === undefined) return failV2()
    return readChainRoot(candidate, chain)
  })
  const traceCandidates = requireDenseArray(
    readOwn(record, 'authorityTrace'),
    maximumPlanningEvidencePageCount,
  )
  const expectedTraceCount = chainRoots.reduce(
    (total, root) => addSafeCounts(total, root.pageCount),
    0,
  )
  if (
    expectedTraceCount === 0 ||
    traceCandidates.length !== expectedTraceCount
  ) {
    return failV2()
  }
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  let traceIndex = 0
  for (const root of chainRoots) {
    let terminalDigest: string | undefined
    for (
      let pageSequence = 1;
      pageSequence <= root.pageCount;
      pageSequence += 1
    ) {
      const candidate = traceCandidates[traceIndex]
      if (candidate === undefined) return failV2()
      const entry = readTraceEntry(
        candidate,
        root.chain,
        pageSequence,
      )
      authorityTrace.push(entry)
      terminalDigest = entry.evidenceDigest
      traceIndex += 1
    }
    if (terminalDigest !== root.terminalEvidenceDigest) return failV2()
  }
  const derivedTransitions = deriveTransitions(authorityTrace)
  const transitionCandidates = requireDenseArray(
    readOwn(record, 'authorityTransitions'),
    maximumPlanningEvidencePageCount,
  )
  if (transitionCandidates.length !== derivedTransitions.length) {
    return failV2()
  }
  const authorityTransitions = transitionCandidates.map(
    (candidate, index) => {
      const transition = readTransition(candidate)
      const derived = derivedTransitions[index]
      if (derived === undefined || !sameTransition(transition, derived)) {
        return failV2()
      }
      return transition
    },
  )
  const fields = {
    kind: 'workspace-search-planning-authority-provenance',
    provenanceVersion: 1,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    stateTableId: readBoundedText(
      readOwn(record, 'stateTableId'),
      1_024,
    ),
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
  if (provenanceDigest !== createMigrationDigest(fields)) return failV2()
  return { ...fields, provenanceDigest }
}

/**
 * Reads one terminal chain root in its required canonical position.
 *
 * @param value - Candidate root.
 * @param expectedChain - Required chain role.
 * @returns Detached strict root.
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
  if (readOwn(record, 'chain') !== expectedChain) return failV2()
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
 * Reads one page authority trace entry at its required position.
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
    return failV2()
  }
  return {
    chain: expectedChain,
    pageSequence: expectedPageSequence,
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
  }
}

/**
 * Reads one canonical deduplicated authority transition.
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
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
  }
}

/**
 * Reconstructs unique monotonic transitions from the complete page trace.
 *
 * @param trace - Canonical chain/page ordered trace.
 * @returns Transitions ordered by pointer revision.
 */
function deriveTransitions(
  trace: readonly WorkspaceSearchMigrationPlanningAuthorityTraceEntry[],
): WorkspaceSearchMigrationPlanningAuthorityTransition[] {
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
      return failV2()
    }
    previousByChain.set(entry.chain, entry)
    const transition: WorkspaceSearchMigrationPlanningAuthorityTransition = {
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
      return failV2()
    }
    transitionByRevision.set(
      transition.maintenanceEvidencePointerRevision,
      transition,
    )
    const owner = ownerByFence.get(transition.fenceToken)
    if (owner !== undefined && owner !== transition.ownerId) {
      return failV2()
    }
    ownerByFence.set(transition.fenceToken, transition.ownerId)
    const revision = revisionByReceipt.get(
      transition.maintenanceEvidenceReceiptDigest,
    )
    if (
      revision !== undefined &&
      revision !== transition.maintenanceEvidencePointerRevision
    ) {
      return failV2()
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
      return failV2()
    }
  }
  return transitions
}

/**
 * Reads one strict compact version-two authority root.
 *
 * @param value - Candidate parsed root.
 * @returns Detached strict root.
 */
function readSealedPlanningAuthorityV2(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authorityDigest',
    'authorityVersion',
    'configurationHash',
    'currentAuthority',
    'evidenceHeads',
    'historicalReceiptBindingDigest',
    'historicalReceiptCount',
    'kind',
    'migrationId',
    'migrationVersion',
    'orphanOperationCount',
    'planDigest',
    'planManifestHeadReference',
    'planOperationCount',
    'planSealReference',
    'planningAuthorityProvenanceDigest',
    'planningProvenanceManifestHeadReference',
    'planningSnapshotDigest',
    'runId',
    'sealedAt',
    'sourceOperationCount',
    'tableIds',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-sealed-planning-authority' ||
    readOwn(record, 'authorityVersion') !== 2 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failV2()
  }
  const sourceOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'sourceOperationCount'),
  )
  const orphanOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'orphanOperationCount'),
  )
  const planOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  if (
    sourceOperationCount + orphanOperationCount !== planOperationCount ||
    !Number.isSafeInteger(planOperationCount) ||
    planOperationCount > maximumPlannedOperationCount ||
    (planOperationCount === 0) !==
      (planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failV2()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const planSealReference = readRichReference(
    readOwn(record, 'planSealReference'),
    WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
    planSealRole,
    WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
  )
  const planManifestHeadReference = readRichReference(
    readOwn(record, 'planManifestHeadReference'),
    WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
    manifestHeadRole,
    WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  )
  const planningProvenanceManifestHeadReference = readRichReference(
    readOwn(record, 'planningProvenanceManifestHeadReference'),
    createPlanningProvenanceObjectKeyPrefix(
      runId,
      configurationHash,
    ),
    manifestHeadRole,
    WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  )
  const sealedAt = readTimestamp(readOwn(record, 'sealedAt'))
  if (
    planSealReference.retainUntil !==
      planManifestHeadReference.retainUntil ||
    planSealReference.retainUntil !==
      planningProvenanceManifestHeadReference.retainUntil ||
    Date.parse(planSealReference.retainUntil) <= Date.parse(sealedAt)
  ) {
    return failV2()
  }
  const heads = requireDenseArray(
    readOwn(record, 'evidenceHeads'),
    planningChainOrder.length,
  )
  if (heads.length !== planningChainOrder.length) return failV2()
  const evidenceHeads = heads.map((candidate, index) => {
    const chain = planningChainOrder[index]
    if (chain === undefined) return failV2()
    return readEvidenceHead(candidate, chain)
  })
  const evidencePageCount = evidenceHeads.reduce(
    (total, head) => addSafeCounts(total, head.pageCount),
    0,
  )
  if (evidencePageCount > maximumPlanningEvidencePageCount) {
    return failV2()
  }
  const currentAuthority = readCompactCurrentAuthority(
    readOwn(record, 'currentAuthority'),
  )
  const historicalReceiptCount = readBoundedPositiveSafeInteger(
    readOwn(record, 'historicalReceiptCount'),
    maximumPlanningEvidencePageCount,
  )
  if (historicalReceiptCount > evidencePageCount) return failV2()
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planSealReference,
    planManifestHeadReference,
    planningProvenanceManifestHeadReference,
    planDigest,
    planningSnapshotDigest: readDigest(
      readOwn(record, 'planningSnapshotDigest'),
    ),
    sourceOperationCount,
    orphanOperationCount,
    planOperationCount,
    planningAuthorityProvenanceDigest: readDigest(
      readOwn(record, 'planningAuthorityProvenanceDigest'),
    ),
    historicalReceiptBindingDigest: readDigest(
      readOwn(record, 'historicalReceiptBindingDigest'),
    ),
    historicalReceiptCount,
    evidenceHeads,
    currentAuthority,
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  const authorityDigest = readDigest(readOwn(record, 'authorityDigest'))
  if (authorityDigest !== createMigrationDigest(fields)) return failV2()
  return { ...fields, authorityDigest }
}

/**
 * Reads one compact evidence head at its required canonical position.
 *
 * @param value - Candidate head.
 * @param expectedChain - Required chain role.
 * @returns Detached strict head.
 */
function readEvidenceHead(
  value: unknown,
  expectedChain: WorkspaceSearchMigrationPlanningEvidenceChainRole,
): WorkspaceSearchMigrationSealedPlanningEvidenceHead {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'chain',
    'pageCount',
    'progressDigest',
    'terminalCheckpointDigest',
    'terminalEvidenceDigest',
  ])
  if (readOwn(record, 'chain') !== expectedChain) return failV2()
  return {
    chain: expectedChain,
    progressDigest: readDigest(readOwn(record, 'progressDigest')),
    pageCount: readBoundedPositiveSafeInteger(
      readOwn(record, 'pageCount'),
      maximumPlanningEvidencePageCount,
    ),
    terminalEvidenceDigest: readDigest(
      readOwn(record, 'terminalEvidenceDigest'),
    ),
    terminalCheckpointDigest: readDigest(
      readOwn(record, 'terminalCheckpointDigest'),
    ),
  }
}

/**
 * Reads one compact current-authority tuple.
 *
 * @param value - Candidate tuple.
 * @returns Detached strict tuple.
 */
function readCompactCurrentAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningCurrentAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
  }
}

/**
 * Reads one rich immutable reference and enforces its storage role.
 *
 * @param value - Candidate exact-version reference.
 * @param objectKeyPrefix - Exact expected prefix, or undefined for suffix-only
 * provenance validation during standalone root parsing.
 * @param role - Required immutable object role.
 * @param maximumBytes - Maximum possible canonical object length.
 * @returns Detached strict rich reference.
 */
function readRichReference(
  value: unknown,
  objectKeyPrefix: string | undefined,
  role: string,
  maximumBytes: number,
): WorkspaceSearchMigrationImmutableArtifactReference {
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
      maximumImmutableReferenceTextLength,
    ),
    versionId: readBoundedText(
      readOwn(record, 'versionId'),
      maximumImmutableReferenceTextLength,
    ),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readBoundedPositiveSafeInteger(
      readOwn(record, 'byteLength'),
      maximumBytes,
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  const suffix = `/${role}/${reference.contentDigest}.artifact`
  if (
    reference.versionId === 'null' ||
    (
      objectKeyPrefix === undefined
        ? !reference.objectKey.endsWith(suffix) ||
          reference.objectKey.length === suffix.length
        : reference.objectKey !==
          (
            role === manifestHeadRole &&
            objectKeyPrefix !==
              WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX
              ? createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
                  objectKeyPrefix,
                  'manifest-heads',
                  reference.contentDigest,
                )
              : `${objectKeyPrefix}/${role}/${reference.contentDigest}.artifact`
          )
    )
  ) {
    return failV2()
  }
  return reference
}

/**
 * Requires a rich reference to bind exact canonical bytes.
 *
 * @param reference - Exact immutable reference.
 * @param bytes - Exact canonical object bytes.
 */
function requireExactReferenceBytes(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
  bytes: Uint8Array,
): void {
  if (
    reference.byteLength !== bytes.byteLength ||
    reference.contentDigest !== digestExactBytes(bytes)
  ) {
    return failV2()
  }
}

/**
 * Creates the only run/configuration-scoped provenance object-key prefix.
 *
 * @param runId - Validated migration run identifier.
 * @param configurationHash - Validated measured-configuration digest.
 * @returns Exact provenance immutable-artifact prefix.
 */
function createPlanningProvenanceObjectKeyPrefix(
  runId: string,
  configurationHash: string,
): string {
  return `${planningProvenanceArtifactObjectKeyPrefix}/${runId}/${configurationHash}`
}

/**
 * Creates all six fixed-role TableIds from measured configuration.
 *
 * @param configuration - Detached measured configuration.
 * @returns Six exact physical table incarnations.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory': readBoundedText(
      configuration.tables['project-directory'].tableId,
      1_024,
    ),
    'work-items': readBoundedText(
      configuration.tables['work-items'].tableId,
      1_024,
    ),
    collaboration: readBoundedText(
      configuration.tables.collaboration.tableId,
      1_024,
    ),
    documents: readBoundedText(
      configuration.tables.documents.tableId,
      1_024,
    ),
    'workspace-search': readBoundedText(
      configuration.tables['workspace-search'].tableId,
      1_024,
    ),
    'migration-state': readBoundedText(
      configuration.tables['migration-state'].tableId,
      1_024,
    ),
  }
}

/**
 * Reads one strict fixed-role TableId record.
 *
 * @param value - Candidate TableId record.
 * @returns Detached strict TableIds.
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
    'work-items': readBoundedText(
      readOwn(record, 'work-items'),
      1_024,
    ),
    collaboration: readBoundedText(
      readOwn(record, 'collaboration'),
      1_024,
    ),
    documents: readBoundedText(
      readOwn(record, 'documents'),
      1_024,
    ),
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
 * Compares all six physical table incarnations.
 *
 * @param left - First TableId record.
 * @param right - Second TableId record.
 * @returns Whether every fixed role is identical.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return (
    workspaceSearchMigrationSourceNames.every(
      (source) => left[source] === right[source],
    ) &&
    left['workspace-search'] === right['workspace-search'] &&
    left['migration-state'] === right['migration-state']
  )
}

/**
 * Compares canonical chain-root arrays exactly.
 *
 * @param left - First ordered root array.
 * @param right - Second ordered root array.
 * @returns Whether every root field is identical.
 */
function sameChainRoots(
  left: readonly WorkspaceSearchMigrationPlanningEvidenceChainRoot[],
  right: readonly WorkspaceSearchMigrationPlanningEvidenceChainRoot[],
): boolean {
  return left.length === right.length &&
    left.every((root, index) => {
      const candidate = right[index]
      return candidate !== undefined &&
        root.chain === candidate.chain &&
        root.pageCount === candidate.pageCount &&
        root.terminalEvidenceDigest ===
          candidate.terminalEvidenceDigest &&
        root.terminalCheckpointDigest ===
          candidate.terminalCheckpointDigest
    })
}

/**
 * Compares two compact authority transitions exactly.
 *
 * @param left - First authority tuple.
 * @param right - Second authority tuple.
 * @returns Whether all tuple fields are identical.
 */
function sameTransition(
  left: WorkspaceSearchMigrationPlanningAuthorityTransition,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): boolean
function sameTransition(
  left: WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): boolean
function sameTransition(
  left:
    | WorkspaceSearchMigrationPlanningAuthorityTransition
    | WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
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
 * @returns Stable numeric order.
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
 * Copies a typed caller graph after proving it contains only bounded data.
 *
 * @param value - Caller-owned typed graph.
 * @returns Detached graph of the same static type.
 */
function detachSafeGraph<Value>(value: Value): Value {
  inspectSafeGraph(value, {
    nodes: 0,
    textBytes: 0,
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
  })
  return structuredClone(value)
}

/**
 * Proves one graph contains no proxy, accessor, cycle, or exotic object.
 *
 * @param value - Candidate graph value.
 * @param budget - Shared graph resource budget.
 */
function inspectSafeGraph(value: unknown, budget: SafeGraphBudget): void {
  budget.nodes += 1
  if (budget.nodes > maximumSafeGraphNodes) return failV2()
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'string') {
    addGraphTextBytes(value, budget)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failV2()
    return
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    return failV2()
  }
  if (budget.active.has(value)) return failV2()
  if (budget.visited.has(value)) return
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (!hasCanonicalDenseArrayShape(value)) return failV2()
    for (const candidate of value) inspectSafeGraph(candidate, budget)
    budget.active.delete(value)
    budget.visited.add(value)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failV2()
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !hasOnlyPairedSurrogates(key)) {
      return failV2()
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failV2()
    }
    addGraphTextBytes(key, budget)
    inspectSafeGraph(descriptor.value, budget)
  }
  budget.active.delete(value)
  budget.visited.add(value)
}

/**
 * Adds one string's UTF-8 bytes to the safe graph budget.
 *
 * @param value - Property name or primitive string.
 * @param budget - Shared graph budget.
 */
function addGraphTextBytes(value: string, budget: SafeGraphBudget): void {
  budget.textBytes += Buffer.byteLength(value, 'utf8')
  if (
    !Number.isSafeInteger(budget.textBytes) ||
    budget.textBytes > maximumSafeGraphTextBytes
  ) {
    return failV2()
  }
}

/**
 * Reads one non-array, non-Proxy object.
 *
 * @param value - Candidate record.
 * @returns Object suitable for bounded reflection.
 */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failV2()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own keys.
 *
 * @param value - Candidate object.
 * @param expected - Complete recognized keys.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failV2()
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failV2()
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
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failV2()
  }
  return descriptor.value
}

/**
 * Reads one dense array under an explicit element ceiling.
 *
 * @param value - Candidate array.
 * @param maximumLength - Maximum accepted element count.
 * @returns Dense runtime array.
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
    return failV2()
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
  if (typeof value !== 'string') return failV2()
  try {
    return requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failV2()
  }
}

/**
 * Reads one nonblank bounded Unicode string.
 *
 * @param value - Candidate string.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns Validated string.
 */
function readBoundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failV2()
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
  if (!isHexDigest(value)) return failV2()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failV2()
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate number.
 * @returns Validated integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failV2()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Validated positive integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  const parsed = readNonNegativeSafeInteger(value)
  if (parsed === 0) return failV2()
  return parsed
}

/**
 * Reads one bounded positive safe integer.
 *
 * @param value - Candidate number.
 * @param maximum - Inclusive maximum.
 * @returns Validated bounded integer.
 */
function readBoundedPositiveSafeInteger(
  value: unknown,
  maximum: number,
): number {
  const parsed = readPositiveSafeInteger(value)
  if (parsed > maximum) return failV2()
  return parsed
}

/**
 * Adds two nonnegative counts without safe-integer overflow.
 *
 * @param left - Existing count.
 * @param right - Additional count.
 * @returns Exact safe sum.
 */
function addSafeCounts(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) return failV2()
  return result
}

/**
 * Encodes one validated value as bounded canonical JSON.
 *
 * @param value - Strict JSON-safe value.
 * @param maximumBytes - Inclusive byte ceiling.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonical(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    return failV2()
  }
  return bytes
}

/**
 * Computes SHA-256 over exact bytes.
 *
 * @param bytes - Exact immutable object bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestExactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Copies one exact nonshared Uint8Array under a byte ceiling.
 *
 * @param value - Candidate byte view.
 * @param maximumBytes - Inclusive byte ceiling.
 * @returns Detached ordinary bytes.
 */
function copyBoundedBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failV2()
  }
  const buffer = readIntrinsicUint8ArrayBuffer(value)
  const byteLength = readIntrinsicUint8ArrayByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > maximumBytes
  ) {
    return failV2()
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength !== byteLength) return failV2()
  return copy
}

/**
 * Reads a Uint8Array's intrinsic backing buffer.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failV2()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) return failV2()
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failV2()
  }
  return buffer
}

/**
 * Reads a Uint8Array's intrinsic byte length.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic byte length.
 */
function readIntrinsicUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failV2()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) return failV2()
  const byteLength: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failV2()
  }
  return byteLength
}

/**
 * Runs one operation behind the fixed version-two redaction boundary.
 *
 * @param operation - Validation or construction operation.
 * @returns Operation result.
 */
function runV2Boundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationSealedPlanningAuthorityV2Error()
  }
}

/**
 * Raises the stable version-two authority failure.
 *
 * @returns Never returns.
 */
function failV2(): never {
  throw new WorkspaceSearchMigrationSealedPlanningAuthorityV2Error()
}
