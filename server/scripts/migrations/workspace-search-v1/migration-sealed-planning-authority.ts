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
  type WorkspaceSearchPlanSealReference,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  type WorkspaceSearchMigrationPlanningAuthorityProvenance,
  type WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
  type WorkspaceSearchMigrationPlanningAuthorityTransition,
  type WorkspaceSearchMigrationPlanningEvidenceChainRole,
  type WorkspaceSearchMigrationPlanningEvidenceChainRoot,
} from './migration-planning-join'
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
 * Maximum canonical bytes accepted for one full planning provenance artifact.
 */
export const WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES =
  64 * 1024 * 1024

/**
 * Maximum canonical bytes accepted for one compact sealed-authority record.
 */
export const WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES =
  256 * 1024

const maximumPlanningEvidencePageCount = 10_000
const maximumPlannedOperationCount = 100_000
const planningChainOrder:
  readonly WorkspaceSearchMigrationPlanningEvidenceChainRole[] = [
    ...workspaceSearchMigrationSourceNames,
    'workspace-search',
  ]

/**
 * Stable raw-value-free failure raised for an invalid planning authority.
 */
export class WorkspaceSearchMigrationSealedPlanningAuthorityError
extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_SEALED_PLANNING_AUTHORITY'

  /**
   * Creates one stable planning-authority validation failure.
   */
  constructor() {
    super('INVALID_SEALED_PLANNING_AUTHORITY')
    this.name = 'WorkspaceSearchMigrationSealedPlanningAuthorityError'
  }
}

/**
 * Exact immutable S3 reference for a complete planning provenance artifact.
 */
export type WorkspaceSearchMigrationPlanningProvenanceArtifactReference = {
  /** Exact content-addressed S3 object key. */
  readonly objectKey: string
  /** Exact immutable S3 object version. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical artifact bytes. */
  readonly contentDigest: string
}

/**
 * Exact immutable S3 reference for the complete planned-operation manifest.
 */
export type WorkspaceSearchMigrationPlanManifestReference = {
  /** Exact content-addressed S3 object key. */
  readonly objectKey: string
  /** Exact immutable S3 object version. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical manifest bytes. */
  readonly contentDigest: string
}

/**
 * One historical receipt proven to match a provenance transition.
 */
export type WorkspaceSearchMigrationVerifiedHistoricalReceipt = {
  /** Lease owner persisted in the immutable receipt envelope. */
  readonly ownerId: string
  /** Digest addressing the exact immutable receipt. */
  readonly receiptDigest: string
  /** Exact historical receipt payload, which may now be expired. */
  readonly receipt: WorkspaceSearchMaintenanceEvidenceReceipt
}

/**
 * Full immutable provenance and historical receipts stored before publication.
 */
export type WorkspaceSearchMigrationPlanningProvenanceArtifact = {
  /** Planning-provenance artifact discriminator. */
  readonly kind: 'workspace-search-planning-provenance-artifact'
  /** Planning-provenance artifact schema version. */
  readonly artifactVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run shared by every receipt and evidence chain. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Complete canonical five-chain planning provenance. */
  readonly provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Historical receipts ordered exactly like provenance transitions. */
  readonly historicalReceipts:
    readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[]
  /** Digest of the complete ordered historical receipt binding set. */
  readonly historicalReceiptBindingDigest: string
}

/**
 * Input used to bind provenance transitions to immutable receipt envelopes.
 */
export type CreateWorkspaceSearchMigrationPlanningProvenanceArtifactInput = {
  /** Complete canonical five-chain planning provenance. */
  readonly provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Durable historical bindings ordered like provenance transitions. */
  readonly historicalReceiptBindings:
    readonly WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding[]
}

/**
 * One exact terminal evidence head committed by sealed-plan publication.
 */
export type WorkspaceSearchMigrationSealedPlanningEvidenceHead = {
  /** Fixed source or target evidence-chain role. */
  readonly chain: WorkspaceSearchMigrationPlanningEvidenceChainRole
  /** Digest of the complete terminal progress and its physical identity. */
  readonly progressDigest: string
  /** Exact number of committed pages in the terminal chain. */
  readonly pageCount: number
  /** Recursive terminal evidence-page digest. */
  readonly terminalEvidenceDigest: string
  /** Digest of the exact completed terminal checkpoint. */
  readonly terminalCheckpointDigest: string
}

/**
 * Current authority atomically condition-checked during plan publication.
 */
export type WorkspaceSearchMigrationSealedPlanningCurrentAuthority = {
  /** Current lease owner. */
  readonly ownerId: string
  /** Current global lease fencing token. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
}

/**
 * Fixed table incarnations retained by one compact sealed-authority record.
 */
export type WorkspaceSearchMigrationSealedPlanningTableIds = Readonly<
  Record<WorkspaceSearchMigrationTableRole, string>
>

/**
 * Compact immutable publication root for one reviewed deterministic plan.
 */
export type WorkspaceSearchMigrationSealedPlanningAuthority = {
  /** Sealed planning-authority record discriminator. */
  readonly kind: 'workspace-search-sealed-planning-authority'
  /** Sealed planning-authority schema version. */
  readonly authorityVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact immutable reference to the existing plan-seal v2 root. */
  readonly planSealReference: WorkspaceSearchPlanSealReference
  /** Exact immutable reference to the complete operation manifest. */
  readonly planManifestReference:
    WorkspaceSearchMigrationPlanManifestReference
  /** Merkle root of every exact ordered planned operation. */
  readonly planDigest: string
  /** Exact number of ordered planned operations. */
  readonly planOperationCount: number
  /** Exact immutable reference to provenance and historical receipts. */
  readonly planningProvenanceArtifactReference:
    WorkspaceSearchMigrationPlanningProvenanceArtifactReference
  /** Canonical digest of the five-chain authority provenance. */
  readonly planningAuthorityProvenanceDigest: string
  /** Digest of every verified historical receipt binding. */
  readonly historicalReceiptBindingDigest: string
  /** Exact number of unique verified historical receipt bindings. */
  readonly historicalReceiptCount: number
  /** Five exact terminal heads in canonical source-then-target order. */
  readonly evidenceHeads:
    readonly WorkspaceSearchMigrationSealedPlanningEvidenceHead[]
  /** Current authority fixed by the publication transaction. */
  readonly currentAuthority:
    WorkspaceSearchMigrationSealedPlanningCurrentAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly sealedAt: string
  /** Digest of every preceding compact authority field. */
  readonly authorityDigest: string
}

/**
 * Input used to construct one compact sealed planning-authority root.
 */
export type CreateWorkspaceSearchMigrationSealedPlanningAuthorityInput = {
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Complete measured configuration whose digest was reviewed. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Existing immutable plan-seal v2 root. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact immutable S3 version of the plan-seal root. */
  readonly planSealReference: WorkspaceSearchPlanSealReference
  /** Exact immutable S3 version of the complete operation manifest. */
  readonly planManifestReference:
    WorkspaceSearchMigrationPlanManifestReference
  /** Exact provenance artifact created from all five evidence chains. */
  readonly planningProvenanceArtifact:
    WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Exact immutable S3 version of the provenance artifact. */
  readonly planningProvenanceArtifactReference:
    WorkspaceSearchMigrationPlanningProvenanceArtifactReference
  /** Four exact completed planning-v3 source heads. */
  readonly sourceProgress: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >
  /** Exact completed planning-v1 target head. */
  readonly targetProgress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Exact fresh authority resolved immediately before publication. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly sealedAt: string
}

/**
 * Creates a canonical provenance artifact from durable historical bindings.
 *
 * Historical receipts are validated for immutable run/fence/owner/configuration
 * binding but are deliberately not required to remain fresh.
 *
 * @param input - Canonical provenance and ordered durable receipt bindings.
 * @returns Detached strict provenance artifact.
 */
export function createWorkspaceSearchMigrationPlanningProvenanceArtifact(
  input: CreateWorkspaceSearchMigrationPlanningProvenanceArtifactInput,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  return runSealedAuthorityBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, [
      'historicalReceiptBindings',
      'provenance',
    ])
    const provenance = readPlanningAuthorityProvenance(
      readOwn(inputRecord, 'provenance'),
    )
    const bindings = requireDenseArray(
      readOwn(inputRecord, 'historicalReceiptBindings'),
      maximumPlanningEvidencePageCount,
    )
    if (
      bindings.length !== provenance.authorityTransitions.length
    ) {
      return failSealedAuthority()
    }
    const historicalReceipts = bindings.map((candidate, index) => {
      const transition = provenance.authorityTransitions[index]
      if (transition === undefined) return failSealedAuthority()
      return readDurableHistoricalReceiptBinding(
        candidate,
        provenance,
        transition,
      )
    })
    const historicalReceiptBindingDigest =
      createHistoricalReceiptBindingDigest(
        provenance,
        historicalReceipts,
      )
    return {
      kind: 'workspace-search-planning-provenance-artifact',
      artifactVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: provenance.runId,
      configurationHash: provenance.configurationHash,
      stateTableId: provenance.stateTableId,
      provenance,
      historicalReceipts,
      historicalReceiptBindingDigest,
    }
  })
}

/**
 * Serializes one full planning provenance artifact as canonical UTF-8 JSON.
 *
 * @param value - Candidate provenance artifact.
 * @returns Exact canonical artifact bytes.
 */
export function serializeWorkspaceSearchMigrationPlanningProvenanceArtifact(
  value: WorkspaceSearchMigrationPlanningProvenanceArtifact,
): Uint8Array {
  return runSealedAuthorityBoundary(() =>
    encodeCanonicalArtifact(
      readPlanningProvenanceArtifact(value),
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES,
    )
  )
}

/**
 * Parses exact canonical planning provenance artifact bytes.
 *
 * @param bytes - Untrusted bounded UTF-8 bytes.
 * @returns Detached strict provenance artifact.
 */
export function parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
  bytes: Uint8Array,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  return runSealedAuthorityBoundary(() => {
    const parsed = parseArtifactJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES,
    )
    const artifact = readPlanningProvenanceArtifact(parsed)
    requireCanonicalBytes(
      bytes,
      artifact,
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES,
    )
    return artifact
  })
}

/**
 * Creates one compact immutable sealed planning-authority root.
 *
 * The operation manifest and provenance artifact must already have immutable
 * exact-version references. Publication remains non-executable until the
 * returned root is conditionally committed with the current authority and all
 * five terminal heads.
 *
 * @param input - Exact plan, artifacts, heads, current authority, and time.
 * @returns Detached canonical sealed planning-authority root.
 */
export function createWorkspaceSearchMigrationSealedPlanningAuthority(
  input: CreateWorkspaceSearchMigrationSealedPlanningAuthorityInput,
): WorkspaceSearchMigrationSealedPlanningAuthority {
  return runSealedAuthorityBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, [
      'configuration',
      'configurationHash',
      'currentAuthority',
      'planManifestReference',
      'planSeal',
      'planSealReference',
      'planningProvenanceArtifact',
      'planningProvenanceArtifactReference',
      'runId',
      'sealedAt',
      'sourceProgress',
      'targetProgress',
    ])
    const runId = readIdentifier(readOwn(inputRecord, 'runId'))
    const configurationHash = readDigest(
      readOwn(inputRecord, 'configurationHash'),
    )
    const configuration = input.configuration
    if (
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationHash
    ) {
      return failSealedAuthority()
    }
    const tableIds = createTableIds(configuration)
    const stateTableId = tableIds['migration-state']
    const planSeal = parseWorkspaceSearchPlanSeal(
      serializeWorkspaceSearchPlanSeal(input.planSeal),
    )
    const planSealReference = readArtifactReference(
      readOwn(inputRecord, 'planSealReference'),
    )
    if (
      planSeal.runId !== runId ||
      planSeal.configurationHash !== configurationHash ||
      planSeal.planOperationCount > maximumPlannedOperationCount ||
      planSealReference.contentDigest !==
        createMigrationDigest(planSeal)
    ) {
      return failSealedAuthority()
    }
    const planManifestReference = readArtifactReference(
      readOwn(inputRecord, 'planManifestReference'),
    )
    const planningProvenanceArtifact =
      readPlanningProvenanceArtifact(
        readOwn(inputRecord, 'planningProvenanceArtifact'),
      )
    const planningProvenanceArtifactReference = readArtifactReference(
      readOwn(inputRecord, 'planningProvenanceArtifactReference'),
    )
    if (
      planningProvenanceArtifact.runId !== runId ||
      planningProvenanceArtifact.configurationHash !==
        configurationHash ||
      planningProvenanceArtifact.stateTableId !== stateTableId ||
      planningProvenanceArtifactReference.contentDigest !==
        createMigrationDigest(planningProvenanceArtifact)
    ) {
      return failSealedAuthority()
    }
    const evidenceHeads = createSealedEvidenceHeads(
      input.sourceProgress,
      input.targetProgress,
      planningProvenanceArtifact.provenance,
      runId,
      configurationHash,
      tableIds,
    )
    const sealedAt = readTimestamp(readOwn(inputRecord, 'sealedAt'))
    if (Date.parse(planSeal.createdAt) > Date.parse(sealedAt)) {
      return failSealedAuthority()
    }
    const currentAuthority = readCurrentAuthorityForSeal(
      readOwn(inputRecord, 'currentAuthority'),
      runId,
      configurationHash,
      stateTableId,
      sealedAt,
    )
    requireCurrentAuthoritySuccessor(
      planningProvenanceArtifact.provenance.authorityTransitions,
      currentAuthority,
    )
    const authority = {
      kind: 'workspace-search-sealed-planning-authority',
      authorityVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      tableIds,
      planSealReference,
      planManifestReference,
      planDigest: planSeal.planDigest,
      planOperationCount: planSeal.planOperationCount,
      planningProvenanceArtifactReference,
      planningAuthorityProvenanceDigest:
        planningProvenanceArtifact.provenance.provenanceDigest,
      historicalReceiptBindingDigest:
        planningProvenanceArtifact.historicalReceiptBindingDigest,
      historicalReceiptCount:
        planningProvenanceArtifact.historicalReceipts.length,
      evidenceHeads,
      currentAuthority,
      sealedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationSealedPlanningAuthority,
      'authorityDigest'
    >
    return {
      ...authority,
      authorityDigest: createMigrationDigest(authority),
    }
  })
}

/**
 * Serializes one compact sealed planning-authority root.
 *
 * @param value - Candidate compact authority root.
 * @returns Exact canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationSealedPlanningAuthority(
  value: WorkspaceSearchMigrationSealedPlanningAuthority,
): Uint8Array {
  return runSealedAuthorityBoundary(() =>
    encodeCanonicalArtifact(
      readSealedPlanningAuthority(value),
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES,
    )
  )
}

/**
 * Parses exact canonical sealed planning-authority bytes.
 *
 * @param bytes - Untrusted bounded UTF-8 bytes.
 * @returns Detached strict compact authority root.
 */
export function parseWorkspaceSearchMigrationSealedPlanningAuthority(
  bytes: Uint8Array,
): WorkspaceSearchMigrationSealedPlanningAuthority {
  return runSealedAuthorityBoundary(() => {
    const parsed = parseArtifactJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES,
    )
    const authority = readSealedPlanningAuthority(parsed)
    requireCanonicalBytes(
      bytes,
      authority,
      WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES,
    )
    return authority
  })
}

/**
 * Reads and validates one full provenance artifact.
 *
 * @param value - Candidate parsed artifact.
 * @returns Detached strict provenance artifact.
 */
function readPlanningProvenanceArtifact(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'artifactVersion',
    'configurationHash',
    'historicalReceiptBindingDigest',
    'historicalReceipts',
    'kind',
    'migrationId',
    'migrationVersion',
    'provenance',
    'runId',
    'stateTableId',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-planning-provenance-artifact' ||
    readOwn(record, 'artifactVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failSealedAuthority()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const stateTableId = readBoundedText(
    readOwn(record, 'stateTableId'),
    1_024,
  )
  const provenance = readPlanningAuthorityProvenance(
    readOwn(record, 'provenance'),
  )
  if (
    provenance.runId !== runId ||
    provenance.configurationHash !== configurationHash ||
    provenance.stateTableId !== stateTableId
  ) {
    return failSealedAuthority()
  }
  const candidates = requireDenseArray(
    readOwn(record, 'historicalReceipts'),
    maximumPlanningEvidencePageCount,
  )
  if (candidates.length !== provenance.authorityTransitions.length) {
    return failSealedAuthority()
  }
  const historicalReceipts = candidates.map((candidate, index) => {
    const transition = provenance.authorityTransitions[index]
    if (transition === undefined) return failSealedAuthority()
    return readVerifiedHistoricalReceipt(
      candidate,
      provenance,
      transition,
    )
  })
  const historicalReceiptBindingDigest = readDigest(
    readOwn(record, 'historicalReceiptBindingDigest'),
  )
  if (
    historicalReceiptBindingDigest !==
      createHistoricalReceiptBindingDigest(
        provenance,
        historicalReceipts,
      )
  ) {
    return failSealedAuthority()
  }
  return {
    kind: 'workspace-search-planning-provenance-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    stateTableId,
    provenance,
    historicalReceipts,
    historicalReceiptBindingDigest,
  }
}

/**
 * Reads one complete canonical planning provenance document.
 *
 * @param value - Candidate provenance value.
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
    return failSealedAuthority()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const stateTableId = readBoundedText(
    readOwn(record, 'stateTableId'),
    1_024,
  )
  const rootCandidates = requireDenseArray(
    readOwn(record, 'chainRoots'),
    planningChainOrder.length,
  )
  if (rootCandidates.length !== planningChainOrder.length) {
    return failSealedAuthority()
  }
  const chainRoots = rootCandidates.map((candidate, index) => {
    const expectedChain = planningChainOrder[index]
    if (expectedChain === undefined) return failSealedAuthority()
    return readChainRoot(candidate, expectedChain)
  })
  const traceCandidates = requireDenseArray(
    readOwn(record, 'authorityTrace'),
    maximumPlanningEvidencePageCount,
  )
  const expectedTraceLength = chainRoots.reduce(
    (total, root) => addSafeCounts(total, root.pageCount),
    0,
  )
  if (
    expectedTraceLength === 0 ||
    traceCandidates.length !== expectedTraceLength
  ) {
    return failSealedAuthority()
  }
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  let traceIndex = 0
  for (const root of chainRoots) {
    let terminalEvidenceDigest: string | undefined
    for (
      let pageSequence = 1;
      pageSequence <= root.pageCount;
      pageSequence += 1
    ) {
      const candidate = traceCandidates[traceIndex]
      if (candidate === undefined) return failSealedAuthority()
      const entry = readTraceEntry(
        candidate,
        root.chain,
        pageSequence,
      )
      authorityTrace.push(entry)
      terminalEvidenceDigest = entry.evidenceDigest
      traceIndex += 1
    }
    if (terminalEvidenceDigest !== root.terminalEvidenceDigest) {
      return failSealedAuthority()
    }
  }
  const derivedTransitions =
    derivePlanningAuthorityTransitions(authorityTrace)
  const transitionCandidates = requireDenseArray(
    readOwn(record, 'authorityTransitions'),
    maximumPlanningEvidencePageCount,
  )
  if (transitionCandidates.length !== derivedTransitions.length) {
    return failSealedAuthority()
  }
  const authorityTransitions = transitionCandidates.map(
    (candidate, index) => {
      const transition = readTransition(candidate)
      const derived = derivedTransitions[index]
      if (
        derived === undefined ||
        !sameTransition(transition, derived)
      ) {
        return failSealedAuthority()
      }
      return transition
    },
  )
  const provenance = {
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
  if (provenanceDigest !== createMigrationDigest(provenance)) {
    return failSealedAuthority()
  }
  return {
    ...provenance,
    provenanceDigest,
  }
}

/**
 * Reads one exact chain root at its required canonical position.
 *
 * @param value - Candidate chain root.
 * @param expectedChain - Required chain role.
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
  if (readOwn(record, 'chain') !== expectedChain) {
    return failSealedAuthority()
  }
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
 * Reads one trace entry at its required chain and page position.
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
    return failSealedAuthority()
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
 * Reconstructs and validates unique monotonic transitions from page trace.
 *
 * @param trace - Canonical chain/page ordered trace.
 * @returns Transitions ordered by pointer revision.
 */
function derivePlanningAuthorityTransitions(
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
      return failSealedAuthority()
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
    const existingTransition = transitionByRevision.get(
      transition.maintenanceEvidencePointerRevision,
    )
    if (
      existingTransition !== undefined &&
      !sameTransition(existingTransition, transition)
    ) {
      return failSealedAuthority()
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
      return failSealedAuthority()
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
      return failSealedAuthority()
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
      return failSealedAuthority()
    }
  }
  return transitions
}

/**
 * Reads one durable historical receipt binding used during artifact creation.
 *
 * @param value - Candidate adapter-returned durable binding.
 * @param provenance - Provenance owning the transition.
 * @param transition - Exact transition at the same ordered index.
 * @returns Detached verified receipt summary.
 */
function readDurableHistoricalReceiptBinding(
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
  if (
    readOwn(record, 'configurationHash') !==
      provenance.configurationHash ||
    readOwn(record, 'stateTableId') !== provenance.stateTableId
  ) {
    return failSealedAuthority()
  }
  return readHistoricalReceiptSummary(record, provenance, transition)
}

/**
 * Reads one compact verified receipt already inside a provenance artifact.
 *
 * @param value - Candidate artifact receipt entry.
 * @param provenance - Provenance owning the transition.
 * @param transition - Exact transition at the same ordered index.
 * @returns Detached verified receipt summary.
 */
function readVerifiedHistoricalReceipt(
  value: unknown,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  transition: WorkspaceSearchMigrationPlanningAuthorityTransition,
): WorkspaceSearchMigrationVerifiedHistoricalReceipt {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'ownerId',
    'receipt',
    'receiptDigest',
  ])
  return readHistoricalReceiptSummary(record, provenance, transition)
}

/**
 * Verifies receipt fields shared by durable bindings and compact artifacts.
 *
 * @param record - Strict binding or artifact record.
 * @param provenance - Provenance owning the transition.
 * @param transition - Exact transition at the same ordered index.
 * @returns Detached verified receipt summary.
 */
function readHistoricalReceiptSummary(
  record: object,
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  transition: WorkspaceSearchMigrationPlanningAuthorityTransition,
): WorkspaceSearchMigrationVerifiedHistoricalReceipt {
  const ownerId = readIdentifier(readOwn(record, 'ownerId'))
  const receiptDigest = readDigest(readOwn(record, 'receiptDigest'))
  const receipt = readMaintenanceReceipt(readOwn(record, 'receipt'))
  if (
    ownerId !== transition.ownerId ||
    receiptDigest !==
      transition.maintenanceEvidenceReceiptDigest ||
    receipt.runId !== provenance.runId ||
    receipt.fenceToken !== transition.fenceToken ||
    createMigrationDigest(receipt) !== receiptDigest
  ) {
    return failSealedAuthority()
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
  const receipt = {
    runId: readIdentifier(readOwn(record, 'runId')),
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    evidenceLocator: readBoundedText(
      readOwn(record, 'evidenceLocator'),
      2_048,
    ),
    runtimeRevision: readPositiveSafeInteger(
      readOwn(record, 'runtimeRevision'),
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
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
 * Computes the canonical ordered historical receipt binding digest.
 *
 * @param provenance - Provenance owning every receipt.
 * @param receipts - Exact transition-ordered receipt summaries.
 * @returns Lowercase SHA-256 binding-set digest.
 */
function createHistoricalReceiptBindingDigest(
  provenance: WorkspaceSearchMigrationPlanningAuthorityProvenance,
  receipts:
    readonly WorkspaceSearchMigrationVerifiedHistoricalReceipt[],
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
 * Creates five exact head commitments and validates their provenance roots.
 *
 * @param sourceProgress - Four completed source progress heads.
 * @param targetProgress - Completed target progress head.
 * @param provenance - Exact five-chain planning provenance.
 * @param runId - Run shared by every head.
 * @param configurationHash - Configuration shared by every head.
 * @param tableIds - Exact measured physical table IDs.
 * @returns Five detached head commitments in canonical order.
 */
function createSealedEvidenceHeads(
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
  const sourceRecord = requireRecord(sourceProgress)
  requireExactKeys(sourceRecord, workspaceSearchMigrationSourceNames)
  const heads: WorkspaceSearchMigrationSealedPlanningEvidenceHead[] = []
  for (const source of workspaceSearchMigrationSourceNames) {
    const progress = sourceProgress[source]
    const root = provenance.chainRoots[heads.length]
    if (
      root === undefined ||
      root.chain !== source
    ) {
      return failSealedAuthority()
    }
    void createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
      progress,
    )
    if (
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
      return failSealedAuthority()
    }
    heads.push({
      chain: source,
      progressDigest:
        createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
          progress,
        ),
      pageCount: root.pageCount,
      terminalEvidenceDigest: root.terminalEvidenceDigest,
      terminalCheckpointDigest: root.terminalCheckpointDigest,
    })
  }
  const target = targetProgress
  const targetRoot = provenance.chainRoots[heads.length]
  void createWorkspaceSearchMigrationTargetEvidenceProgressDigest(target)
  if (
    targetRoot === undefined ||
    targetRoot.chain !== 'workspace-search' ||
    target.purpose !== 'planning' ||
    target.runId !== runId ||
    target.configurationHash !== configurationHash ||
    target.targetTableId !== tableIds['workspace-search'] ||
    target.stateTableId !== tableIds['migration-state'] ||
    target.pageSequence !== targetRoot.pageCount ||
    target.evidenceDigest !== targetRoot.terminalEvidenceDigest ||
    !target.checkpoint.completed ||
    target.checkpoint.cursor !== undefined ||
    target.checkpoint.aggregate.invalid !== 0 ||
    createWorkspaceSearchMigrationTargetCheckpointDigest(
      target.checkpoint,
    ) !== targetRoot.terminalCheckpointDigest
  ) {
    return failSealedAuthority()
  }
  heads.push({
    chain: 'workspace-search',
    progressDigest:
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(target),
    pageCount: targetRoot.pageCount,
    terminalEvidenceDigest: targetRoot.terminalEvidenceDigest,
    terminalCheckpointDigest: targetRoot.terminalCheckpointDigest,
  })
  return heads
}

/**
 * Validates fresh current authority and projects its compact tuple.
 *
 * @param value - Candidate current authority aggregate.
 * @param runId - Required run.
 * @param configurationHash - Required configuration digest.
 * @param stateTableId - Required physical state-table incarnation.
 * @param sealedAt - Adapter-owned publication time.
 * @returns Compact detached current authority tuple.
 */
function readCurrentAuthorityForSeal(
  value: unknown,
  runId: string,
  configurationHash: string,
  stateTableId: string,
  sealedAt: string,
): WorkspaceSearchMigrationSealedPlanningCurrentAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  if (
    readOwn(record, 'configurationHash') !== configurationHash ||
    readOwn(record, 'stateTableId') !== stateTableId
  ) {
    return failSealedAuthority()
  }
  const leaseRecord = requireRecord(readOwn(record, 'lease'))
  requireExactKeys(leaseRecord, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  const leaseRunId = readIdentifier(readOwn(leaseRecord, 'runId'))
  const ownerId = readIdentifier(readOwn(leaseRecord, 'ownerId'))
  const fenceToken = readPositiveSafeInteger(
    readOwn(leaseRecord, 'fenceToken'),
  )
  const heartbeatAt = readTimestamp(
    readOwn(leaseRecord, 'heartbeatAt'),
  )
  const expiresAt = readTimestamp(readOwn(leaseRecord, 'expiresAt'))
  const evaluatedAt = readTimestamp(readOwn(record, 'evaluatedAt'))
  if (
    leaseRunId !== runId ||
    Date.parse(heartbeatAt) > Date.parse(evaluatedAt) ||
    Date.parse(evaluatedAt) > Date.parse(sealedAt)
  ) {
    return failSealedAuthority()
  }
  assertWorkspaceSearchMigrationLeaseAuthority(runId, {
    ownerId,
    lease: {
      runId: leaseRunId,
      ownerId,
      fenceToken,
      heartbeatAt,
      expiresAt,
    },
    at: sealedAt,
  })
  const maintenanceEvidenceReceiptDigest = readDigest(
    readOwn(record, 'maintenanceEvidenceReceiptDigest'),
  )
  const maintenanceEvidenceReceipt = readMaintenanceReceipt(
    readOwn(record, 'maintenanceEvidenceReceipt'),
  )
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    maintenanceEvidenceReceipt,
    runId,
    fenceToken,
    sealedAt,
  )
  if (
    createMigrationDigest(maintenanceEvidenceReceipt) !==
      maintenanceEvidenceReceiptDigest ||
    Date.parse(maintenanceEvidenceReceipt.validatedAt) >
      Date.parse(evaluatedAt)
  ) {
    return failSealedAuthority()
  }
  return {
    ownerId,
    fenceToken,
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Requires current authority to be a realizable provenance successor.
 *
 * @param transitions - Historical transitions ordered by pointer revision.
 * @param current - Current publication authority tuple.
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
    return failSealedAuthority()
  }
  if (
    current.maintenanceEvidencePointerRevision ===
      latest.maintenanceEvidencePointerRevision
  ) {
    if (!sameTransition(current, latest)) return failSealedAuthority()
    return
  }
  if (
    current.fenceToken === latest.fenceToken &&
    current.ownerId !== latest.ownerId
  ) {
    return failSealedAuthority()
  }
  if (
    transitions.some((transition) =>
      transition.maintenanceEvidenceReceiptDigest ===
        current.maintenanceEvidenceReceiptDigest
    )
  ) {
    return failSealedAuthority()
  }
}

/**
 * Reads one compact sealed planning-authority root.
 *
 * @param value - Candidate parsed root.
 * @returns Detached strict compact root.
 */
function readSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthority {
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
    'planDigest',
    'planManifestReference',
    'planOperationCount',
    'planSealReference',
    'planningAuthorityProvenanceDigest',
    'planningProvenanceArtifactReference',
    'runId',
    'sealedAt',
    'tableIds',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-sealed-planning-authority' ||
    readOwn(record, 'authorityVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failSealedAuthority()
  }
  const planOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  if (
    planOperationCount > maximumPlannedOperationCount ||
    (planOperationCount === 0) !==
      (planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failSealedAuthority()
  }
  const headCandidates = requireDenseArray(
    readOwn(record, 'evidenceHeads'),
    planningChainOrder.length,
  )
  if (headCandidates.length !== planningChainOrder.length) {
    return failSealedAuthority()
  }
  const evidenceHeads = headCandidates.map((candidate, index) => {
    const expectedChain = planningChainOrder[index]
    if (expectedChain === undefined) return failSealedAuthority()
    return readSealedEvidenceHead(candidate, expectedChain)
  })
  const totalPageCount = evidenceHeads.reduce(
    (total, head) => addSafeCounts(total, head.pageCount),
    0,
  )
  if (totalPageCount > maximumPlanningEvidencePageCount) {
    return failSealedAuthority()
  }
  const currentAuthority = readCompactCurrentAuthority(
    readOwn(record, 'currentAuthority'),
  )
  const authority = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planSealReference: readArtifactReference(
      readOwn(record, 'planSealReference'),
    ),
    planManifestReference: readArtifactReference(
      readOwn(record, 'planManifestReference'),
    ),
    planDigest,
    planOperationCount,
    planningProvenanceArtifactReference: readArtifactReference(
      readOwn(record, 'planningProvenanceArtifactReference'),
    ),
    planningAuthorityProvenanceDigest: readDigest(
      readOwn(record, 'planningAuthorityProvenanceDigest'),
    ),
    historicalReceiptBindingDigest: readDigest(
      readOwn(record, 'historicalReceiptBindingDigest'),
    ),
    historicalReceiptCount: readBoundedPositiveSafeInteger(
      readOwn(record, 'historicalReceiptCount'),
      maximumPlanningEvidencePageCount,
    ),
    evidenceHeads,
    currentAuthority,
    sealedAt: readTimestamp(readOwn(record, 'sealedAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthority,
    'authorityDigest'
  >
  const authorityDigest = readDigest(
    readOwn(record, 'authorityDigest'),
  )
  if (authorityDigest !== createMigrationDigest(authority)) {
    return failSealedAuthority()
  }
  return { ...authority, authorityDigest }
}

/**
 * Reads one exact compact terminal-head commitment.
 *
 * @param value - Candidate head.
 * @param expectedChain - Required canonical chain role.
 * @returns Detached strict head.
 */
function readSealedEvidenceHead(
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
  if (readOwn(record, 'chain') !== expectedChain) {
    return failSealedAuthority()
  }
  return {
    chain: expectedChain,
    progressDigest: readDigest(readOwn(record, 'progressDigest')),
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
 * Creates a detached fixed-role table-ID record from measured configuration.
 *
 * @param configuration - Exact measured configuration.
 * @returns All six immutable physical table IDs.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      readBoundedText(
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
 * Reads one strict fixed-role table-ID record.
 *
 * @param value - Candidate table-ID record.
 * @returns Detached strict table IDs.
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
 * Reads one exact immutable S3 artifact reference.
 *
 * @param value - Candidate reference.
 * @returns Detached strict reference.
 */
function readArtifactReference(
  value: unknown,
): WorkspaceSearchMigrationPlanningProvenanceArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, ['contentDigest', 'objectKey', 'versionId'])
  return {
    objectKey: readBoundedText(readOwn(record, 'objectKey'), 1_024),
    versionId: readBoundedText(readOwn(record, 'versionId'), 1_024),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
  }
}

/**
 * Compares two compact or provenance authority tuples.
 *
 * @param left - First tuple.
 * @param right - Second tuple.
 * @returns Whether all authority fields match exactly.
 */
function sameTransition(
  left: WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
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
 * Orders transitions by positive pointer revision.
 *
 * @param left - First transition.
 * @param right - Second transition.
 * @returns Stable numeric order without unsafe subtraction.
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
 * Adds two nonnegative counts without exceeding safe integer range.
 *
 * @param left - Existing total.
 * @param right - Additional count.
 * @returns Safe sum.
 */
function addSafeCounts(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) return failSealedAuthority()
  return total
}

/**
 * Requires one non-array object.
 *
 * @param value - Candidate runtime value.
 * @returns Object suitable for bounded reflection.
 */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return failSealedAuthority()
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
    return failSealedAuthority()
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failSealedAuthority()
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
    return failSealedAuthority()
  }
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failSealedAuthority()
  }
  return descriptor.value
}

/**
 * Requires one dense array under an explicit element ceiling.
 *
 * @param value - Candidate array.
 * @param maximumLength - Maximum accepted element count.
 * @returns Runtime array without sparse or inherited indices.
 */
function requireDenseArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    !hasCanonicalDenseArrayShape(value)
  ) {
    return failSealedAuthority()
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
  if (typeof value !== 'string') return failSealedAuthority()
  try {
    return requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failSealedAuthority()
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
    return failSealedAuthority()
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
  if (!isHexDigest(value)) return failSealedAuthority()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failSealedAuthority()
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
    return failSealedAuthority()
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
  if (parsed === 0) return failSealedAuthority()
  return parsed
}

/**
 * Reads one positive safe integer under an explicit ceiling.
 *
 * @param value - Candidate number.
 * @param maximum - Maximum accepted value.
 * @returns Validated bounded positive integer.
 */
function readBoundedPositiveSafeInteger(
  value: unknown,
  maximum: number,
): number {
  const parsed = readPositiveSafeInteger(value)
  if (parsed > maximum) return failSealedAuthority()
  return parsed
}

/**
 * Parses bounded strict UTF-8 JSON.
 *
 * @param bytes - Candidate exact bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Untrusted parsed JSON.
 */
function parseArtifactJson(
  bytes: Uint8Array,
  maximumBytes: number,
): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failSealedAuthority()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failSealedAuthority()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failSealedAuthority()
  }
}

/**
 * Encodes canonical JSON under an explicit byte ceiling.
 *
 * @param value - Validated JSON-safe value.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonicalArtifact(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failSealedAuthority()
  }
  return bytes
}

/**
 * Requires exact byte-for-byte canonical representation.
 *
 * @param actual - Original untrusted bytes.
 * @param value - Reconstructed canonical value.
 * @param maximumBytes - Maximum accepted byte length.
 */
function requireCanonicalBytes(
  actual: Uint8Array,
  value: unknown,
  maximumBytes: number,
): void {
  const expected = encodeCanonicalArtifact(value, maximumBytes)
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    return failSealedAuthority()
  }
}

/**
 * Runs one synchronous operation behind a fixed redaction boundary.
 *
 * @param operation - Exact validation or construction operation.
 * @returns Operation result.
 */
function runSealedAuthorityBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationSealedPlanningAuthorityError()
  }
}

/**
 * Raises the stable sealed-authority validation failure.
 *
 * @returns Never returns.
 */
function failSealedAuthority(): never {
  throw new WorkspaceSearchMigrationSealedPlanningAuthorityError()
}
