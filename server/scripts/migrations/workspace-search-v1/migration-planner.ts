import type { SearchEntityType } from '@mukuroji/contracts'
import {
  readWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  decodeAttributeMapToNativeRecord,
  encodeAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchMigrationScanSnapshotDigest,
  createWorkspaceSearchOperationId,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationScanAggregate,
  type MigrationTableIdentity,
  requireMigrationIdentifier,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationScanSnapshot,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchDryRunEvidence,
  parseWorkspaceSearchPlannedOperation,
  serializeWorkspaceSearchPlannedOperation,
} from './migration-artifacts'
import {
  mapWorkspaceSearchMigrationRow,
} from './migration-mapper'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchPlannedOperation,
  type WorkspaceSearchPlanMembershipProofStep,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationAbsentSnapshot,
  createWorkspaceSearchMigrationDocumentSnapshot,
  createWorkspaceSearchMigrationExistingSnapshot,
} from './migration-target-snapshot'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/** Origin of one deterministic operation candidate. */
export type WorkspaceSearchMigrationPlanCandidateOrigin = 'orphan' | 'source'

/** One validated operation before stable plan sequencing and Merkle sealing. */
export type WorkspaceSearchMigrationPlanCandidate = {
  /** Whether a source row or an orphan target produced the operation. */
  readonly origin: WorkspaceSearchMigrationPlanCandidateOrigin
  /** Exact source condition and target transition. */
  readonly operation: WorkspaceSearchMigrationOperation
  /** Digest of the exact losslessly encoded operation. */
  readonly operationDigest: string
}

/** Input used to derive an operation from one exact source row. */
export type CreateWorkspaceSearchMigrationSourceCandidateInput = {
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Logical source table being scanned. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Measured immutable identity of that source table. */
  readonly sourceTable: MigrationTableIdentity
  /** Exact low-level source item returned by a consistent scan. */
  readonly sourceItem: DynamoAttributeMap
  /**
   * Exact target item returned by a strong point read, or undefined when the
   * deterministic target key was absent.
   */
  readonly targetItem?: DynamoAttributeMap
}

/** Input used to derive a deletion from one target-only Search document. */
export type CreateWorkspaceSearchMigrationOrphanCandidateInput = {
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Measured source table that owns the target entity family. */
  readonly sourceTable: MigrationTableIdentity
  /** Exact low-level orphan target item returned by a consistent scan. */
  readonly targetItem: DynamoAttributeMap
}

/** Recognized target row that this migration intentionally leaves unchanged. */
export type WorkspaceSearchMigrationIgnoredTargetRow = {
  /** Classification discriminator. */
  readonly classification: 'ignored'
  /** Stable raw-value-free reason for the ignored row. */
  readonly reasonCode:
    | 'RECOGNIZED_NON_TARGET_ROW'
    | 'UNOWNED_SEARCH_ENTITY'
}

/** Valid migration-owned target row available for source join or orphan repair. */
export type WorkspaceSearchMigrationOwnedTargetRow = {
  /** Classification discriminator. */
  readonly classification: 'owned'
  /** Fully validated current or legacy Search document. */
  readonly document: WorkspaceSearchDocument
  /** Exact low-level target primary key. */
  readonly targetKey: DynamoAttributeMap
  /** Digest of the exact target primary key. */
  readonly targetKeyDigest: string
}

/** Fail-closed classification of one Workspace Search table row. */
export type WorkspaceSearchMigrationTargetRowClassification =
  | WorkspaceSearchMigrationIgnoredTargetRow
  | WorkspaceSearchMigrationOwnedTargetRow

/** Complete deterministic plan and its independently storable root seal. */
export type WorkspaceSearchMigrationSealedPlan = {
  /** Ordered plan entries with proofs against the exact common root. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
  /** Canonical root document binding scan evidence, counts, and Merkle root. */
  readonly seal: WorkspaceSearchPlanSeal
}

/**
 * Exact target-ownership evidence accumulated while joining complete source
 * and target scans.
 */
export type WorkspaceSearchMigrationTargetOwnershipEvidence = {
  /** Every exact source row independently accumulated by each complete scan. */
  readonly sourceRows: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      readonly WorkspaceSearchMigrationSourceScanRowEvidence[]
    >
  >
  /** Every exact target row independently accumulated by the complete scan. */
  readonly targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[]
  /** Exact mapped-source bindings independently accumulated per source scan. */
  readonly sourceBindings: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      readonly WorkspaceSearchMigrationSourceOwnershipBinding[]
    >
  >
  /** Exact owned-target bindings independently accumulated by the target scan. */
  readonly observedTargetBindings:
    readonly WorkspaceSearchMigrationObservedTargetBinding[]
  /** Target-key digests expected from every mapped source row. */
  readonly expectedSourceTargetKeyDigests: readonly string[]
  /** Target-key digests for every migration-owned row observed in the target scan. */
  readonly observedTargetKeyDigests: readonly string[]
  /** Observed target-key digests that have no mapped source owner. */
  readonly orphanTargetKeyDigests: readonly string[]
}

/** Exact mapped-source identity and intended target action observed by a scan. */
export type WorkspaceSearchMigrationSourceOwnershipBinding = {
  /** Digest of the exact physical source key. */
  readonly sourceKeyDigest: string
  /** Digest of the exact low-level source item. */
  readonly sourceItemDigest: string
  /** Digest of the deterministic target key owned by the source row. */
  readonly targetKeyDigest: string
  /** Deterministic target state selected by the source mapper. */
  readonly targetAction: 'delete' | 'put'
}

/** Exact owned target identity and preimage observed by the target scan. */
export type WorkspaceSearchMigrationObservedTargetBinding = {
  /** Digest of the exact Workspace Search target key. */
  readonly targetKeyDigest: string
  /** Digest of the exact low-level target item. */
  readonly targetItemDigest: string
}

/** Exact digest evidence for one row returned by a complete source scan. */
export type WorkspaceSearchMigrationSourceScanRowEvidence = {
  /** Whether the pure source mapper classified the row for migration. */
  readonly classification: 'ignored' | 'mapped'
  /** Digest of the exact physical source key. */
  readonly sourceKeyDigest: string
  /** Digest of the exact low-level source item. */
  readonly sourceItemDigest: string
}

/** Exact digest evidence for one row returned by the complete target scan. */
export type WorkspaceSearchMigrationTargetScanRowEvidence = {
  /** Whether the target classifier assigned this row to migration v1. */
  readonly classification: 'ignored' | 'owned'
  /** Digest of the exact Workspace Search target key. */
  readonly targetKeyDigest: string
  /** Digest of the exact low-level target item. */
  readonly targetItemDigest: string
}

/** Input used to deterministically order and seal all operation candidates. */
export type SealWorkspaceSearchMigrationPlanInput = {
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Complete measured configuration whose digest was reviewed. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact operator-reviewed dry-run evidence bytes. */
  readonly dryRunEvidenceDigest: string
  /** Exact canonical operator-reviewed dry-run evidence bytes. */
  readonly reviewedDryRunEvidenceBytes: Uint8Array
  /** Complete scan aggregates independently reproduced by planning. */
  readonly scanSnapshot: WorkspaceSearchMigrationScanSnapshot
  /** Exact source-to-target ownership sets reproduced during planning. */
  readonly targetOwnershipEvidence:
    WorkspaceSearchMigrationTargetOwnershipEvidence
  /** Complete set of source and orphan operation candidates. */
  readonly candidates: readonly WorkspaceSearchMigrationPlanCandidate[]
  /** Canonical adapter-owned time at which plan construction completed. */
  readonly createdAt: string
}

/**
 * Derives one exact operation candidate from a consistently read source row.
 *
 * Recognized non-target rows return undefined. Malformed rows and inconsistent
 * target preimages fail closed without including raw tenant values in errors.
 *
 * @param input - Exact source identity, item, and target preimage.
 * @returns Deterministic operation candidate, or undefined for an ignored row.
 */
export function createWorkspaceSearchMigrationSourceCandidate(
  input: CreateWorkspaceSearchMigrationSourceCandidateInput,
): WorkspaceSearchMigrationPlanCandidate | undefined {
  return runPlannerBoundary(
    () => createWorkspaceSearchMigrationSourceCandidateUnchecked(
      structuredClone(input),
    ),
  )
}

/**
 * Derives a source candidate inside the public raw-error replacement boundary.
 *
 * @param input - Exact source identity, item, and target preimage.
 * @returns Deterministic operation candidate, or undefined for an ignored row.
 */
function createWorkspaceSearchMigrationSourceCandidateUnchecked(
  input: CreateWorkspaceSearchMigrationSourceCandidateInput,
): WorkspaceSearchMigrationPlanCandidate | undefined {
  requireDigest(input.configurationHash, 'planning configuration hash')
  requireSourceTable(input.sourceTable, input.source)
  const sourceItem = cloneDynamoAttributeMap(input.sourceItem)

  let mapped: ReturnType<typeof mapWorkspaceSearchMigrationRow>
  try {
    mapped = mapWorkspaceSearchMigrationRow(
      input.source,
      decodeAttributeMapToNativeRecord(sourceItem),
    )
  } catch {
    return failInvalidSourceRow()
  }
  if (mapped.classification === 'ignored') return undefined
  if (mapped.classification === 'invalid') return failInvalidSourceRow()
  if (!isMigrationEntityType(mapped.entityType)) return failInvalidSourceRow()

  const sourceKey = readExactTableKey(sourceItem, input.sourceTable)
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const sourceItemDigest = createAttributeMapDigest(sourceItem)
  const targetKey = createTargetKey(
    mapped.targetKey.workspaceId,
    mapped.targetKey.recordKey,
  )
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const before = input.targetItem === undefined
    ? createWorkspaceSearchMigrationAbsentSnapshot()
    : createWorkspaceSearchMigrationExistingSnapshot(input.targetItem)
  const after = mapped.operation.action === 'delete'
    ? createWorkspaceSearchMigrationAbsentSnapshot()
    : createWorkspaceSearchMigrationDocumentSnapshot(
      mapped.operation.document,
    )
  const operation: WorkspaceSearchMigrationOperation = {
    operationId: createWorkspaceSearchOperationId({
      configurationHash: input.configurationHash,
      sourceTableId: input.sourceTable.tableId,
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition: {
      exists: true,
      source: input.source,
      tableId: input.sourceTable.tableId,
      tableName: input.sourceTable.tableName,
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: sourceItemDigest,
    },
    targetKey,
    targetKeyDigest,
    before,
    after,
    entityType: mapped.entityType,
  }
  return createCandidate('source', operation)
}

/**
 * Classifies one exact Workspace Search table item for migration planning.
 *
 * Saved-view families and valid file projections are recognized but ignored.
 * Unknown, mismatched, or malformed rows fail closed.
 *
 * @param item - Exact low-level target row from a consistent scan.
 * @returns Owned migration target or recognized ignored classification.
 */
export function classifyWorkspaceSearchMigrationTargetRow(
  item: DynamoAttributeMap,
): WorkspaceSearchMigrationTargetRowClassification {
  return runPlannerBoundary(
    () => classifyDetachedWorkspaceSearchMigrationTargetRow(
      cloneDynamoAttributeMap(item),
    ),
  )
}

/**
 * Classifies an already detached target row inside the planner boundary.
 *
 * @param item - Detached exact low-level target row.
 * @returns Owned migration target or recognized ignored classification.
 */
function classifyDetachedWorkspaceSearchMigrationTargetRow(
  item: DynamoAttributeMap,
): WorkspaceSearchMigrationTargetRowClassification {
  const targetKey = readTargetKey(item)
  const recordKey = readStringAttribute(targetKey.recordKey)
  const entryType = readStringAttribute(item.entryType)
  if (!recordKey || !entryType) return failInvalidTargetRow()

  if (recordKey.startsWith('VIEW#')) {
    return entryType === 'saved-view'
      ? ignoredTargetRow('RECOGNIZED_NON_TARGET_ROW')
      : failInvalidTargetRow()
  }
  if (recordKey.startsWith('PREFERENCE#')) {
    return entryType === 'saved-view-preference'
      ? ignoredTargetRow('RECOGNIZED_NON_TARGET_ROW')
      : failInvalidTargetRow()
  }
  if (recordKey.startsWith('DEFAULT#')) {
    return entryType === 'saved-view-default'
      ? ignoredTargetRow('RECOGNIZED_NON_TARGET_ROW')
      : failInvalidTargetRow()
  }
  if (!recordKey.startsWith('DOCUMENT#')) return failInvalidTargetRow()

  let document: WorkspaceSearchDocument
  try {
    document = readWorkspaceSearchDocument(
      decodeAttributeMapToNativeRecord(item),
    )
  } catch {
    return failInvalidTargetRow()
  }
  if (document.entityType === 'file') {
    return ignoredTargetRow('UNOWNED_SEARCH_ENTITY')
  }
  if (!isMigrationEntityType(document.entityType)) {
    return failInvalidTargetRow()
  }
  return {
    classification: 'owned',
    document,
    targetKey,
    targetKeyDigest: createAttributeMapDigest(targetKey),
  }
}

/**
 * Derives one exact absent-source deletion candidate for a target-only row.
 *
 * Work Item, Collaboration, and Document primary keys are recoverable from
 * canonical target identity. Team and Project directory keys include display
 * sort orders that are not present in Search projections, so those orphans
 * deliberately stop planning for operator reconciliation.
 *
 * @param input - Exact target row and measured owning source table.
 * @returns Orphan deletion candidate, or undefined for an unowned file row.
 */
export function createWorkspaceSearchMigrationOrphanCandidate(
  input: CreateWorkspaceSearchMigrationOrphanCandidateInput,
): WorkspaceSearchMigrationPlanCandidate | undefined {
  return runPlannerBoundary(
    () => createWorkspaceSearchMigrationOrphanCandidateUnchecked(
      structuredClone(input),
    ),
  )
}

/**
 * Derives an orphan candidate inside the public raw-error replacement boundary.
 *
 * @param input - Exact target row and measured owning source table.
 * @returns Orphan deletion candidate, or undefined for an unowned file row.
 */
function createWorkspaceSearchMigrationOrphanCandidateUnchecked(
  input: CreateWorkspaceSearchMigrationOrphanCandidateInput,
): WorkspaceSearchMigrationPlanCandidate | undefined {
  requireDigest(input.configurationHash, 'planning configuration hash')
  const targetItem = cloneDynamoAttributeMap(input.targetItem)
  const classification = classifyDetachedWorkspaceSearchMigrationTargetRow(
    targetItem,
  )
  if (classification.classification === 'ignored') return undefined

  const document = classification.document
  if (!isMigrationEntityType(document.entityType)) {
    return failInvalidTargetRow()
  }
  if (document.entityType === 'team' || document.entityType === 'project') {
    throw new WorkspaceSearchMigrationFailure(
      'AMBIGUOUS_OPERATION_UNRESOLVED',
      'A Team or Project orphan cannot be bound to one physical source key.',
    )
  }
  const source = sourceForEntityType(document.entityType)
  requireSourceTable(input.sourceTable, source)
  const sourceKey = createAbsentSourceKey(document)
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const before = createWorkspaceSearchMigrationExistingSnapshot(
    targetItem,
  )
  const after = createWorkspaceSearchMigrationAbsentSnapshot()
  const operation: WorkspaceSearchMigrationOperation = {
    operationId: createWorkspaceSearchOperationId({
      configurationHash: input.configurationHash,
      sourceTableId: input.sourceTable.tableId,
      sourceKeyDigest,
      targetKeyDigest: classification.targetKeyDigest,
    }),
    sourceCondition: {
      exists: false,
      source,
      tableId: input.sourceTable.tableId,
      tableName: input.sourceTable.tableName,
      key: sourceKey,
      keyDigest: sourceKeyDigest,
    },
    targetKey: classification.targetKey,
    targetKeyDigest: classification.targetKeyDigest,
    before,
    after,
    entityType: document.entityType,
  }
  return createCandidate('orphan', operation)
}

/**
 * Orders all exact candidates, constructs the compatible Merkle tree and
 * proofs, and creates the reviewed plan-seal document.
 *
 * Ordering uses lowercase target-key digests, not Scan response order or page
 * boundaries. Every target digest must occur exactly once.
 *
 * This pure boundary intentionally materializes the complete candidate and
 * operation lists. Production orchestration must preflight explicit row and
 * byte limits and run in a bounded operator process; it must not route this
 * implementation through Lambda until chunked persistence is available.
 *
 * @param input - Run identity, scan evidence, candidates, and seal time.
 * @returns Ordered immutable plan entries and canonical seal.
 */
export function sealWorkspaceSearchMigrationPlan(
  input: SealWorkspaceSearchMigrationPlanInput,
): WorkspaceSearchMigrationSealedPlan {
  return runPlannerBoundary(
    () => sealWorkspaceSearchMigrationPlanUnchecked(structuredClone(input)),
  )
}

/**
 * Seals a plan inside the public raw-error replacement boundary.
 *
 * @param input - Run identity, scan evidence, candidates, and seal time.
 * @returns Ordered detached plan entries and canonical seal.
 */
function sealWorkspaceSearchMigrationPlanUnchecked(
  input: SealWorkspaceSearchMigrationPlanInput,
): WorkspaceSearchMigrationSealedPlan {
  requireMigrationIdentifier(input.runId, 'Run ID')
  requireDigest(input.configurationHash, 'planning configuration hash')
  if (
    createWorkspaceSearchConfigurationHash(input.configuration) !==
      input.configurationHash
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Planning configuration differs from its reviewed hash.',
    )
  }
  requireDigest(input.dryRunEvidenceDigest, 'dry-run evidence digest')
  const reviewedDryRunEvidence = readReviewedDryRunEvidence(
    input.reviewedDryRunEvidenceBytes,
  )
  const reproducedDryRunEvidenceDigest = createMigrationDigest(
    reviewedDryRunEvidence,
  )
  if (input.dryRunEvidenceDigest !== reproducedDryRunEvidenceDigest) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Reviewed dry-run evidence digest differs from its exact bytes.',
    )
  }
  if (reviewedDryRunEvidence.configurationHash !== input.configurationHash) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Reviewed dry-run evidence uses a different configuration hash.',
    )
  }
  if (!isCanonicalTimestamp(input.createdAt)) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_ARGUMENT',
      'Plan seal creation time must be canonical UTC.',
    )
  }
  if (
    Date.parse(input.createdAt) <
      Date.parse(reviewedDryRunEvidence.completedAt)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan seal creation time precedes the reviewed dry run.',
    )
  }
  if (input.scanSnapshot.configurationHash !== input.configurationHash) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Planning scan snapshot uses a different configuration hash.',
    )
  }
  requireCleanScanSnapshot(input.scanSnapshot)
  const planningSnapshotDigest =
    createWorkspaceSearchMigrationScanSnapshotDigest(input.scanSnapshot)
  const reviewedSnapshotDigest =
    createWorkspaceSearchMigrationScanSnapshotDigest({
      configurationHash: reviewedDryRunEvidence.configurationHash,
      sources: reviewedDryRunEvidence.sources,
      target: reviewedDryRunEvidence.target,
    })
  if (reviewedSnapshotDigest !== planningSnapshotDigest) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Planning scans differ from the exact reviewed dry-run evidence.',
    )
  }

  requireDenseCandidateList(input.candidates)
  const candidates = input.candidates.map((candidate) =>
    validateCandidate(
      candidate,
      input.configurationHash,
      input.configuration,
    )
  )
    .sort(compareCandidates)
  rejectTargetCollisions(candidates)
  const sourceOperationCount = candidates.filter(
    ({ origin }) => origin === 'source',
  ).length
  const orphanOperationCount = candidates.length - sourceOperationCount
  requireCandidateAggregateCounts(
    candidates,
    input.scanSnapshot,
  )
  requireCompleteTargetOwnership(
    input.targetOwnershipEvidence,
    candidates,
    input.scanSnapshot,
  )

  const leaves = candidates.map((candidate, index) =>
    createWorkspaceSearchPlanLeafDigest({
      planSequence: index + 1,
      operationDigest: candidate.operationDigest,
    })
  )
  const levels = buildMerkleLevels(leaves)
  const planDigest = leaves.length === 0
    ? createEmptyWorkspaceSearchPlanDigest()
    : levels.at(-1)?.[0]
  if (!planDigest) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Nonempty plan did not produce a Merkle root.',
    )
  }

  const operations = candidates.map((candidate, index) => {
    const planSequence = index + 1
    const planned: WorkspaceSearchPlannedOperation = {
      runId: input.runId,
      configurationHash: input.configurationHash,
      planDigest,
      planSequence,
      operationDigest: candidate.operationDigest,
      membershipProof: createMembershipProof(levels, index),
      operation: candidate.operation,
    }
    return parseWorkspaceSearchPlannedOperation(
      serializeWorkspaceSearchPlannedOperation(planned),
    )
  })
  const seal: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.runId,
    configurationHash: input.configurationHash,
    dryRunEvidenceDigest: reproducedDryRunEvidenceDigest,
    planningSnapshotDigest,
    planDigest,
    planOperationCount: operations.length,
    sourceOperationCount,
    orphanOperationCount,
    createdAt: input.createdAt,
  }
  return { operations, seal }
}

/**
 * Requires candidates to occupy every canonical array index exactly once.
 *
 * Sparse arrays would make callback-based counts disagree with array length and
 * could otherwise create a sealed plan with missing physical entries.
 *
 * @param candidates - Runtime candidate collection at the sealing boundary.
 */
function requireDenseCandidateList(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): void {
  if (!hasCanonicalDenseArrayShape(candidates)) {
    return failCandidateList()
  }
}

/**
 * Raises the stable invalid-state failure for a noncanonical candidate list.
 *
 * @returns Never returns.
 */
function failCandidateList(): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Plan candidates must form one dense canonical list.',
  )
}

/**
 * Parses exact canonical dry-run bytes at the planner trust boundary.
 *
 * @param bytes - Exact bytes selected by the operator for review.
 * @returns Strictly parsed canonical dry-run evidence.
 */
function readReviewedDryRunEvidence(
  bytes: Uint8Array,
): ReturnType<typeof parseWorkspaceSearchDryRunEvidence> {
  try {
    return parseWorkspaceSearchDryRunEvidence(bytes)
  } catch {
    throw new WorkspaceSearchMigrationFailure(
      'DRY_RUN_INVALID_ROWS',
      'Reviewed dry-run evidence is not a valid canonical artifact.',
    )
  }
}

/**
 * Requires exact source ownership, observed-target, and orphan digest sets.
 *
 * The observed set is checked against every candidate with an existing target
 * preimage. Orphans are then independently recomputed as observed target keys
 * that are absent from the complete expected source-target set.
 *
 * @param evidence - Explicit ownership evidence from complete planning scans.
 * @param candidates - Validated collision-free operation candidates.
 * @param snapshot - Complete planning scan aggregates.
 */
function requireCompleteTargetOwnership(
  evidence: WorkspaceSearchMigrationTargetOwnershipEvidence,
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  snapshot: WorkspaceSearchMigrationScanSnapshot,
): void {
  requireCompleteScanRowEvidence(evidence, snapshot)
  const evidenceSourceTargetKeyDigests: string[] = []
  for (const source of [
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
  ] satisfies readonly WorkspaceSearchMigrationSourceName[]) {
    const sourceBindings = evidence.sourceBindings[source]
    const candidateBindings = candidates
      .filter(
        (candidate) =>
          candidate.origin === 'source' &&
          candidate.operation.sourceCondition.source === source,
      )
      .map(createCandidateSourceOwnershipBinding)
    const evidenceBindingDigests = normalizeSourceOwnershipBindings(
      sourceBindings,
      `${source} source ownership evidence`,
    )
    const candidateBindingDigests = normalizeSourceOwnershipBindings(
      candidateBindings,
      `${source} candidate ownership`,
    )
    if (!equalDigestLists(
      evidenceBindingDigests,
      candidateBindingDigests,
    )) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Plan source candidates differ from independent scan ownership.',
      )
    }
    evidenceSourceTargetKeyDigests.push(
      ...sourceBindings.map(({ targetKeyDigest }) => targetKeyDigest),
    )
  }

  const candidateObservedTargetBindings = candidates
    .filter(({ operation }) => operation.before.exists)
    .map(createCandidateObservedTargetBinding)
  const evidenceObservedBindingDigests = normalizeObservedTargetBindings(
    evidence.observedTargetBindings,
    'observed target ownership evidence',
  )
  const candidateObservedBindingDigests = normalizeObservedTargetBindings(
    candidateObservedTargetBindings,
    'candidate target ownership',
  )
  if (!equalDigestLists(
    evidenceObservedBindingDigests,
    candidateObservedBindingDigests,
  )) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan target preimages differ from independent target scan ownership.',
    )
  }

  const expectedSourceTargetKeyDigests = normalizeDistinctTargetDigests(
    evidence.expectedSourceTargetKeyDigests,
    'expected source target evidence',
  )
  const observedTargetKeyDigests = normalizeDistinctTargetDigests(
    evidence.observedTargetKeyDigests,
    'observed target evidence',
  )
  const orphanTargetKeyDigests = normalizeDistinctTargetDigests(
    evidence.orphanTargetKeyDigests,
    'orphan target evidence',
  )
  const candidateSourceTargetKeyDigests = candidates
    .filter(({ origin }) => origin === 'source')
    .map(({ operation }) => operation.targetKeyDigest)
    .sort(compareUtf8Ordinal)
  const candidateObservedTargetKeyDigests = candidates
    .filter(({ operation }) => operation.before.exists)
    .map(({ operation }) => operation.targetKeyDigest)
    .sort(compareUtf8Ordinal)
  const candidateOrphanTargetKeyDigests = candidates
    .filter(({ origin }) => origin === 'orphan')
    .map(({ operation }) => operation.targetKeyDigest)
    .sort(compareUtf8Ordinal)
  const boundSourceTargetKeyDigests = normalizeDistinctTargetDigests(
    evidenceSourceTargetKeyDigests,
    'bound source target evidence',
  )
  const boundObservedTargetKeyDigests = normalizeDistinctTargetDigests(
    evidence.observedTargetBindings.map(
      ({ targetKeyDigest }) => targetKeyDigest,
    ),
    'bound observed target evidence',
  )

  if (
    !equalDigestLists(
      expectedSourceTargetKeyDigests,
      boundSourceTargetKeyDigests,
    ) ||
    !equalDigestLists(
      observedTargetKeyDigests,
      boundObservedTargetKeyDigests,
    ) ||
    !equalDigestLists(
      expectedSourceTargetKeyDigests,
      candidateSourceTargetKeyDigests,
    ) ||
    !equalDigestLists(
      observedTargetKeyDigests,
      candidateObservedTargetKeyDigests,
    ) ||
    !equalDigestLists(orphanTargetKeyDigests, candidateOrphanTargetKeyDigests)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan candidates differ from complete target-ownership evidence.',
    )
  }
  if (observedTargetKeyDigests.length !== snapshot.target.mapped) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Observed target ownership differs from the reproduced target scan.',
    )
  }

  const sourceTargets = new Set(expectedSourceTargetKeyDigests)
  const derivedOrphanTargetKeyDigests = observedTargetKeyDigests
    .filter((digest) => !sourceTargets.has(digest))
  if (!equalDigestLists(
    orphanTargetKeyDigests,
    derivedOrphanTargetKeyDigests,
  )) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Orphan target evidence differs from the complete source-target join.',
    )
  }
}

/**
 * Reconstructs every reviewed scan aggregate from independent row evidence.
 *
 * @param evidence - Complete source and target scan-row evidence.
 * @param snapshot - Reviewed aggregate snapshot that must be reproduced.
 */
function requireCompleteScanRowEvidence(
  evidence: WorkspaceSearchMigrationTargetOwnershipEvidence,
  snapshot: WorkspaceSearchMigrationScanSnapshot,
): void {
  for (const source of [
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
  ] satisfies readonly WorkspaceSearchMigrationSourceName[]) {
    requireSourceScanRows(
      evidence.sourceRows[source],
      evidence.sourceBindings[source],
      snapshot.sources[source],
      `${source} scan evidence`,
    )
  }
  requireTargetScanRows(
    evidence.targetRows,
    evidence.observedTargetBindings,
    snapshot.target,
  )
}

/**
 * Reconstructs one source aggregate and its exact mapped-row subset.
 *
 * @param rows - Every row digest returned by the source scan.
 * @param bindings - Exact mapped-source ownership bindings.
 * @param aggregate - Reviewed aggregate that must be reproduced.
 * @param label - Secret-free source evidence purpose.
 */
function requireSourceScanRows(
  rows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
  aggregate: MigrationScanAggregate,
  label: string,
): void {
  if (!Array.isArray(rows) || !Array.isArray(bindings)) {
    return failScanRowEvidence(label)
  }
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  const sourceKeys = new Set<string>()
  const mappedRows: string[] = []
  let mapped = 0
  let ignored = 0
  for (const row of rows) {
    if (
      Object.keys(row).sort(compareUtf8Ordinal).join('\u0000') !==
        'classification\u0000sourceItemDigest\u0000sourceKeyDigest' ||
      !isHexDigest(row.sourceKeyDigest) ||
      !isHexDigest(row.sourceItemDigest) ||
      row.classification !== 'ignored' && row.classification !== 'mapped'
    ) {
      return failScanRowEvidence(label)
    }
    if (sourceKeys.has(row.sourceKeyDigest)) {
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        `${label} contains duplicate physical source keys.`,
      )
    }
    sourceKeys.add(row.sourceKeyDigest)
    keyAccumulator.add(row.sourceKeyDigest)
    contentAccumulator.add(row.sourceItemDigest)
    if (row.classification === 'mapped') {
      mapped += 1
      mappedRows.push(createMigrationDigest({
        kind: 'workspace-search-mapped-source-row',
        rowVersion: 1,
        sourceKeyDigest: row.sourceKeyDigest,
        sourceItemDigest: row.sourceItemDigest,
      }))
    } else {
      ignored += 1
    }
  }
  const boundRows = bindings.map((binding) => {
    if (
      !isHexDigest(binding.sourceKeyDigest) ||
      !isHexDigest(binding.sourceItemDigest)
    ) {
      return failScanRowEvidence(label)
    }
    return createMigrationDigest({
      kind: 'workspace-search-mapped-source-row',
      rowVersion: 1,
      sourceKeyDigest: binding.sourceKeyDigest,
      sourceItemDigest: binding.sourceItemDigest,
    })
  }).sort(compareUtf8Ordinal)
  mappedRows.sort(compareUtf8Ordinal)
  if (
    rows.length !== aggregate.scanned ||
    mapped !== aggregate.mapped ||
    ignored !== aggregate.ignored ||
    aggregate.invalid !== 0 ||
    keyAccumulator.digest() !== aggregate.keyDigest ||
    contentAccumulator.digest() !== aggregate.contentDigest ||
    !equalDigestLists(mappedRows, boundRows)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      `${label} differs from the reviewed scan aggregate.`,
    )
  }
}

/**
 * Reconstructs the target aggregate and its exact owned-row subset.
 *
 * @param rows - Every row digest returned by the target scan.
 * @param bindings - Exact migration-owned target bindings.
 * @param aggregate - Reviewed target aggregate that must be reproduced.
 */
function requireTargetScanRows(
  rows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
  aggregate: MigrationScanAggregate,
): void {
  if (!Array.isArray(rows) || !Array.isArray(bindings)) {
    return failScanRowEvidence('target scan evidence')
  }
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  const targetKeys = new Set<string>()
  const ownedRows: string[] = []
  let mapped = 0
  let ignored = 0
  for (const row of rows) {
    if (
      Object.keys(row).sort(compareUtf8Ordinal).join('\u0000') !==
        'classification\u0000targetItemDigest\u0000targetKeyDigest' ||
      !isHexDigest(row.targetKeyDigest) ||
      !isHexDigest(row.targetItemDigest) ||
      row.classification !== 'ignored' && row.classification !== 'owned'
    ) {
      return failScanRowEvidence('target scan evidence')
    }
    if (targetKeys.has(row.targetKeyDigest)) {
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        'Target scan evidence contains duplicate physical target keys.',
      )
    }
    targetKeys.add(row.targetKeyDigest)
    keyAccumulator.add(row.targetKeyDigest)
    contentAccumulator.add(row.targetItemDigest)
    if (row.classification === 'owned') {
      mapped += 1
      ownedRows.push(createMigrationDigest({
        kind: 'workspace-search-owned-target-row',
        rowVersion: 1,
        targetKeyDigest: row.targetKeyDigest,
        targetItemDigest: row.targetItemDigest,
      }))
    } else {
      ignored += 1
    }
  }
  const boundRows = bindings.map((binding) => {
    if (
      !isHexDigest(binding.targetKeyDigest) ||
      !isHexDigest(binding.targetItemDigest)
    ) {
      return failScanRowEvidence('target scan evidence')
    }
    return createMigrationDigest({
      kind: 'workspace-search-owned-target-row',
      rowVersion: 1,
      targetKeyDigest: binding.targetKeyDigest,
      targetItemDigest: binding.targetItemDigest,
    })
  }).sort(compareUtf8Ordinal)
  ownedRows.sort(compareUtf8Ordinal)
  if (
    rows.length !== aggregate.scanned ||
    mapped !== aggregate.mapped ||
    ignored !== aggregate.ignored ||
    aggregate.invalid !== 0 ||
    keyAccumulator.digest() !== aggregate.keyDigest ||
    contentAccumulator.digest() !== aggregate.contentDigest ||
    !equalDigestLists(ownedRows, boundRows)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Target scan evidence differs from the reviewed scan aggregate.',
    )
  }
}

/**
 * Raises a stable malformed scan-row evidence failure.
 *
 * @param label - Secret-free scan evidence purpose.
 * @returns Never returns.
 */
function failScanRowEvidence(label: string): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_ARGUMENT',
    `${label} contains an invalid row binding.`,
  )
}

/**
 * Reconstructs the exact independent source ownership bound by one candidate.
 *
 * @param candidate - Validated present-source plan candidate.
 * @returns Exact source key, item, target, and action binding.
 */
function createCandidateSourceOwnershipBinding(
  candidate: WorkspaceSearchMigrationPlanCandidate,
): WorkspaceSearchMigrationSourceOwnershipBinding {
  const source = candidate.operation.sourceCondition
  if (candidate.origin !== 'source' || !source.exists) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Source ownership binding requires a present-source candidate.',
    )
  }
  return {
    sourceKeyDigest: source.keyDigest,
    sourceItemDigest: source.itemDigest,
    targetKeyDigest: candidate.operation.targetKeyDigest,
    targetAction: candidate.operation.after.exists ? 'put' : 'delete',
  }
}

/**
 * Reconstructs the exact observed target preimage bound by one candidate.
 *
 * @param candidate - Candidate with an existing target preimage.
 * @returns Exact target key and item digest binding.
 */
function createCandidateObservedTargetBinding(
  candidate: WorkspaceSearchMigrationPlanCandidate,
): WorkspaceSearchMigrationObservedTargetBinding {
  if (!candidate.operation.before.exists) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Observed target binding requires an existing target preimage.',
    )
  }
  return {
    targetKeyDigest: candidate.operation.targetKeyDigest,
    targetItemDigest: candidate.operation.before.digest,
  }
}

/**
 * Validates and canonicalizes exact source ownership bindings.
 *
 * Duplicate physical source keys fail closed even when their contents differ.
 *
 * @param bindings - Independently accumulated source ownership bindings.
 * @param label - Secret-free evidence purpose.
 * @returns Sorted canonical binding digests.
 */
function normalizeSourceOwnershipBindings(
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
  label: string,
): readonly string[] {
  const sourceKeys = new Set<string>()
  const digests = bindings.map((binding) => {
    if (
      Object.keys(binding).sort(compareUtf8Ordinal).join('\u0000') !==
        'sourceItemDigest\u0000sourceKeyDigest\u0000targetAction\u0000targetKeyDigest' ||
      !isHexDigest(binding.sourceKeyDigest) ||
      !isHexDigest(binding.sourceItemDigest) ||
      !isHexDigest(binding.targetKeyDigest) ||
      binding.targetAction !== 'delete' && binding.targetAction !== 'put'
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_ARGUMENT',
        `${label} contains an invalid source binding.`,
      )
    }
    if (sourceKeys.has(binding.sourceKeyDigest)) {
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        `${label} contains duplicate source ownership.`,
      )
    }
    sourceKeys.add(binding.sourceKeyDigest)
    return createMigrationDigest({
      kind: 'workspace-search-source-ownership',
      ownershipVersion: 1,
      sourceKeyDigest: binding.sourceKeyDigest,
      sourceItemDigest: binding.sourceItemDigest,
      targetKeyDigest: binding.targetKeyDigest,
      targetAction: binding.targetAction,
    })
  })
  return digests.sort(compareUtf8Ordinal)
}

/**
 * Validates and canonicalizes exact observed target bindings.
 *
 * @param bindings - Independently accumulated target key and item digests.
 * @param label - Secret-free evidence purpose.
 * @returns Sorted canonical binding digests.
 */
function normalizeObservedTargetBindings(
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
  label: string,
): readonly string[] {
  const targetKeys = new Set<string>()
  const digests = bindings.map((binding) => {
    if (
      Object.keys(binding).sort(compareUtf8Ordinal).join('\u0000') !==
        'targetItemDigest\u0000targetKeyDigest' ||
      !isHexDigest(binding.targetKeyDigest) ||
      !isHexDigest(binding.targetItemDigest)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_ARGUMENT',
        `${label} contains an invalid target binding.`,
      )
    }
    if (targetKeys.has(binding.targetKeyDigest)) {
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        `${label} contains duplicate target ownership.`,
      )
    }
    targetKeys.add(binding.targetKeyDigest)
    return createMigrationDigest({
      kind: 'workspace-search-observed-target-ownership',
      ownershipVersion: 1,
      targetKeyDigest: binding.targetKeyDigest,
      targetItemDigest: binding.targetItemDigest,
    })
  })
  return digests.sort(compareUtf8Ordinal)
}

/**
 * Validates, sorts, and rejects duplicate digests in one ownership set.
 *
 * @param values - Candidate target-key digests.
 * @param label - Secret-free evidence purpose.
 * @returns A new deterministic digest list.
 */
function normalizeDistinctTargetDigests(
  values: readonly string[],
  label: string,
): readonly string[] {
  const normalized = [...values]
  for (const value of normalized) {
    if (!isHexDigest(value)) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_ARGUMENT',
        `${label} contains an invalid target-key digest.`,
      )
    }
  }
  normalized.sort(compareUtf8Ordinal)
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1] === normalized[index]) {
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        `${label} contains duplicate target ownership.`,
      )
    }
  }
  return normalized
}

/**
 * Compares two already-sorted digest lists exactly.
 *
 * @param left - First sorted digest list.
 * @param right - Second sorted digest list.
 * @returns Whether both lists contain the same digests.
 */
function equalDigestLists(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return hasCanonicalDenseArrayShape(left) &&
    hasCanonicalDenseArrayShape(right) &&
    left.length === right.length &&
    left.every((digest, index) => digest === right[index])
}

/**
 * Validates and canonicalizes one candidate before ordering.
 *
 * @param candidate - Candidate supplied to final plan construction.
 * @param configurationHash - Exact reviewed configuration digest.
 * @param configuration - Complete measured configuration.
 * @returns Candidate with a verified exact operation digest.
 */
function validateCandidate(
  candidate: WorkspaceSearchMigrationPlanCandidate,
  configurationHash: string,
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationPlanCandidate {
  if (candidate.origin !== 'source' && candidate.origin !== 'orphan') {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan candidate origin is unsupported.',
    )
  }
  const sourceExists = candidate.operation.sourceCondition.exists
  if (typeof sourceExists !== 'boolean') {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan candidate source discriminator is invalid.',
    )
  }
  if (
    candidate.origin === 'source' && !sourceExists ||
    candidate.origin === 'orphan' && sourceExists
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan candidate origin differs from its source condition.',
    )
  }
  validateCandidateSourceIdentity(
    candidate.operation,
    configurationHash,
    configuration,
  )
  const operationDigest = createWorkspaceSearchMigrationOperationDigest(
    candidate.operation,
  )
  if (candidate.operationDigest !== operationDigest) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan candidate digest differs from its exact operation.',
    )
  }
  return candidate
}

/**
 * Rebinds one candidate to the exact reviewed physical source configuration.
 *
 * @param operation - Candidate source condition and deterministic target.
 * @param configurationHash - Exact reviewed configuration digest.
 * @param configuration - Complete measured configuration.
 */
function validateCandidateSourceIdentity(
  operation: WorkspaceSearchMigrationOperation,
  configurationHash: string,
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  const source = operation.sourceCondition
  if (!isWorkspaceSearchMigrationSourceName(source.source)) {
    throw new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'Plan candidate source role is unsupported.',
    )
  }
  const table = configuration.tables[source.source]
  if (
    table.role !== source.source ||
    table.tableId !== source.tableId ||
    table.tableName !== source.tableName
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'Plan candidate source identity differs from reviewed configuration.',
    )
  }
  validateCandidateSourceKey(source, table)
  validateCandidateTargetKey(
    operation.targetKey,
    configuration.tables['workspace-search'],
  )
  const expectedOperationId = createWorkspaceSearchOperationId({
    configurationHash,
    sourceTableId: table.tableId,
    sourceKeyDigest: source.keyDigest,
    targetKeyDigest: operation.targetKeyDigest,
  })
  if (operation.operationId !== expectedOperationId) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Plan candidate operation ID differs from reviewed configuration.',
    )
  }
}

/**
 * Narrows an untrusted source role to one supported migration source.
 *
 * @param value - Candidate source role from an operation boundary.
 * @returns Whether the value is a supported source role.
 */
function isWorkspaceSearchMigrationSourceName(
  value: unknown,
): value is WorkspaceSearchMigrationSourceName {
  return value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents'
}

/**
 * Validates one target key against the reviewed Workspace Search table schema.
 *
 * @param key - Exact target key carried by the candidate operation.
 * @param table - Reviewed Workspace Search table identity.
 */
function validateCandidateTargetKey(
  key: WorkspaceSearchMigrationOperation['targetKey'],
  table: MigrationTableIdentity,
): void {
  if (
    table.role !== 'workspace-search' ||
    Object.keys(key).length !== table.key.length
  ) {
    return failCandidateTargetKey()
  }
  for (const descriptor of table.key) {
    const keyAttribute = key[descriptor.name]
    if (
      !keyAttribute ||
      !matchesKeyAttributeType(keyAttribute, descriptor.type)
    ) {
      return failCandidateTargetKey()
    }
  }
}

/**
 * Raises the stable target-key identity failure.
 *
 * @returns Never returns.
 */
function failCandidateTargetKey(): never {
  throw new WorkspaceSearchMigrationFailure(
    'IDENTITY_MISMATCH',
    'Plan candidate target key differs from reviewed table schema.',
  )
}

/**
 * Validates one candidate source key against the reviewed table key schema.
 *
 * @param source - Exact present or absent source condition.
 * @param table - Reviewed measured source table.
 */
function validateCandidateSourceKey(
  source: WorkspaceSearchMigrationOperation['sourceCondition'],
  table: MigrationTableIdentity,
): void {
  const keyNames = Object.keys(source.key)
  if (keyNames.length !== table.key.length) {
    return failCandidateSourceKey()
  }
  for (const descriptor of table.key) {
    const keyAttribute = source.key[descriptor.name]
    if (
      !keyAttribute ||
      !matchesKeyAttributeType(keyAttribute, descriptor.type)
    ) {
      return failCandidateSourceKey()
    }
    if (source.exists) {
      const itemAttribute = source.item[descriptor.name]
      if (
        !itemAttribute ||
        serializeCanonicalAttributeMap({ value: itemAttribute }) !==
          serializeCanonicalAttributeMap({ value: keyAttribute })
      ) {
        return failCandidateSourceKey()
      }
    }
  }
}

/**
 * Raises the stable source-key identity failure.
 *
 * @returns Never returns.
 */
function failCandidateSourceKey(): never {
  throw new WorkspaceSearchMigrationFailure(
    'IDENTITY_MISMATCH',
    'Plan candidate source key differs from reviewed table schema.',
  )
}

/**
 * Wraps a validated operation with its exact digest.
 *
 * @param origin - Source-row or orphan-target origin.
 * @param operation - Exact deterministic migration operation.
 * @returns Validated unsequenced plan candidate.
 */
function createCandidate(
  origin: WorkspaceSearchMigrationPlanCandidateOrigin,
  operation: WorkspaceSearchMigrationOperation,
): WorkspaceSearchMigrationPlanCandidate {
  return {
    origin,
    operation,
    operationDigest: createWorkspaceSearchMigrationOperationDigest(operation),
  }
}

/**
 * Deeply detaches one exact DynamoDB map through the lossless shared codec.
 *
 * @param item - Candidate low-level DynamoDB item or key.
 * @returns Detached map with fresh containers and binary values.
 */
function cloneDynamoAttributeMap(
  item: DynamoAttributeMap,
): DynamoAttributeMap {
  return decodeAttributeMap(encodeAttributeMap(item))
}

/**
 * Runs one public planner entrypoint behind a fresh safe-error boundary.
 *
 * Every thrown value, including an existing migration failure, is replaced so
 * hostile getters and modified error instances cannot expose raw values.
 *
 * @param operation - Planner work that may inspect untrusted runtime values.
 * @returns Exact planner result.
 */
function runPlannerBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = readPlannerFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search migration planner stopped safely (${code}).`,
    )
  }
}

/**
 * Extracts only an allowlisted stable code from an arbitrary thrown value.
 *
 * @param error - Arbitrary thrown value from inside a planner boundary.
 * @returns Preserved stable code, or the fail-closed default.
 */
function readPlannerFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      if (isWorkspaceSearchMigrationFailureCode(code)) return code
    }
  } catch {
    return 'INVALID_STATE'
  }
  return 'INVALID_STATE'
}

/**
 * Narrows an unknown value to the complete stable migration failure-code set.
 *
 * @param value - Candidate code read from an untrusted error object.
 * @returns Whether the value is one supported failure code.
 */
function isWorkspaceSearchMigrationFailureCode(
  value: unknown,
): value is WorkspaceSearchMigrationFailureCode {
  return value === 'AMBIGUOUS_OPERATION_UNRESOLVED' ||
    value === 'CONFIGURATION_DRIFT' ||
    value === 'CONFIGURATION_HASH_MISMATCH' ||
    value === 'DRY_RUN_INVALID_ROWS' ||
    value === 'IDENTITY_MISMATCH' ||
    value === 'INVALID_ARGUMENT' ||
    value === 'INVALID_JOURNAL' ||
    value === 'INVALID_MAINTENANCE_EVIDENCE' ||
    value === 'INVALID_STATE' ||
    value === 'JOURNAL_WRITE_FAILED' ||
    value === 'LEASE_CONFLICT' ||
    value === 'LEASE_LOST' ||
    value === 'PITR_NOT_READY' ||
    value === 'ROLLBACK_TARGET_DRIFT' ||
    value === 'SOURCE_DRIFT' ||
    value === 'TABLE_SCHEMA_MISMATCH' ||
    value === 'TARGET_DRIFT' ||
    value === 'TRANSIENT_INFRASTRUCTURE_FAILURE' ||
    value === 'VERIFY_FAILED'
}

/**
 * Extracts the exact primary key described by a measured table identity.
 *
 * @param item - Exact low-level source item.
 * @param table - Measured table schema.
 * @returns Exact low-level primary key.
 */
function readExactTableKey(
  item: DynamoAttributeMap,
  table: MigrationTableIdentity,
): DynamoAttributeMap {
  const key: DynamoAttributeMap = {}
  for (const descriptor of table.key) {
    const value = item[descriptor.name]
    if (!value || !matchesKeyAttributeType(value, descriptor.type)) {
      return failInvalidSourceRow()
    }
    Object.defineProperty(key, descriptor.name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  if (Object.keys(key).length !== table.key.length) {
    return failInvalidSourceRow()
  }
  createAttributeMapDigest(key)
  return key
}

/**
 * Checks a low-level key attribute against its measured scalar type.
 *
 * @param value - Candidate exact key attribute.
 * @param type - Measured DynamoDB scalar key type.
 * @returns Whether the attribute has exactly the required scalar tag.
 */
function matchesKeyAttributeType(
  value: DynamoAttributeMap[string],
  type: MigrationTableIdentity['key'][number]['type'],
): boolean {
  if (Object.keys(value).length !== 1) return false
  if (type === 'S') return typeof value.S === 'string'
  if (type === 'N') return typeof value.N === 'string'
  return value.B instanceof Uint8Array
}

/**
 * Requires a measured table to own the requested logical source.
 *
 * @param table - Candidate measured source identity.
 * @param source - Required logical source.
 */
function requireSourceTable(
  table: MigrationTableIdentity,
  source: WorkspaceSearchMigrationSourceName,
): void {
  if (
    table.role !== source ||
    table.tableId.length === 0 ||
    table.tableName.length === 0
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'Planner source table identity does not match the entity owner.',
    )
  }
}

/**
 * Creates the exact Workspace Search primary key.
 *
 * @param workspaceId - Canonical Workspace partition key.
 * @param recordKey - Canonical Search document sort key.
 * @returns Exact low-level target key.
 */
function createTargetKey(
  workspaceId: string,
  recordKey: string,
): DynamoAttributeMap {
  return {
    workspaceId: { S: workspaceId },
    recordKey: { S: recordKey },
  }
}

/**
 * Reads the exact target key from one low-level item.
 *
 * @param item - Exact target table item.
 * @returns Exact Workspace Search primary key.
 */
function readTargetKey(item: DynamoAttributeMap): DynamoAttributeMap {
  const workspaceId = item.workspaceId
  const recordKey = item.recordKey
  if (
    !workspaceId ||
    !recordKey ||
    readStringAttribute(workspaceId) === undefined ||
    readStringAttribute(recordKey) === undefined
  ) {
    return failInvalidTargetRow()
  }
  return { workspaceId, recordKey }
}

/**
 * Reads one exact nonempty low-level DynamoDB string.
 *
 * @param value - Candidate low-level attribute.
 * @returns Exact string, or undefined for any other representation.
 */
function readStringAttribute(
  value: DynamoAttributeMap[string] | undefined,
): string | undefined {
  return value !== undefined &&
      Object.keys(value).length === 1 &&
      typeof value.S === 'string' &&
      value.S.length > 0
    ? value.S
    : undefined
}

/**
 * Creates the only recoverable absent source key for one orphan target.
 *
 * @param document - Valid migration-owned orphan projection.
 * @returns Exact low-level owning source key.
 */
function createAbsentSourceKey(
  document: WorkspaceSearchDocument,
): DynamoAttributeMap {
  const parts = document.entityId.split('/')
  if (document.entityType === 'work-item') {
    const teamId = parts[1]
    const issueId = parts[3]
    if (
      parts.length !== 4 ||
      parts[0] !== 'team' ||
      parts[2] !== 'issue' ||
      !teamId ||
      !issueId
    ) {
      return failInvalidTargetRow()
    }
    return {
      directoryTeamId: {
        S: `${document.workspaceId}#team#${teamId}`,
      },
      issueId: { S: issueId },
    }
  }
  if (document.entityType === 'comment') {
    const teamId = parts[1]
    const issueId = parts[3]
    const commentId = parts[5]
    if (
      parts.length !== 6 ||
      parts[0] !== 'team' ||
      parts[2] !== 'issue' ||
      parts[4] !== 'comment' ||
      !teamId ||
      !issueId ||
      !commentId
    ) {
      return failInvalidTargetRow()
    }
    return {
      entityKey: {
        S:
          `${document.workspaceId}#work-item#team/` +
          `${teamId}/issue/${issueId}`,
      },
      recordKey: { S: `COMMENT#${commentId}` },
    }
  }
  if (document.entityType === 'document') {
    return {
      workspaceId: { S: document.workspaceId },
      recordKey: { S: `DOCUMENT#${document.entityId}` },
    }
  }
  throw new WorkspaceSearchMigrationFailure(
    'AMBIGUOUS_OPERATION_UNRESOLVED',
    'Target orphan does not have a recoverable physical source key.',
  )
}

/**
 * Returns the source table that owns one recoverable orphan family.
 *
 * @param entityType - Migration-owned target entity type.
 * @returns Required source table role.
 */
function sourceForEntityType(
  entityType: WorkspaceSearchMigrationOperation['entityType'],
): WorkspaceSearchMigrationSourceName {
  if (entityType === 'work-item') return 'work-items'
  if (entityType === 'comment') return 'collaboration'
  if (entityType === 'document') return 'documents'
  return 'project-directory'
}

/**
 * Narrows a Search entity type to the families owned by migration v1.
 *
 * @param entityType - Candidate Search entity family.
 * @returns Whether migration v1 owns the entity family.
 */
function isMigrationEntityType(
  entityType: SearchEntityType,
): entityType is WorkspaceSearchMigrationOperation['entityType'] {
  return entityType === 'comment' ||
    entityType === 'document' ||
    entityType === 'project' ||
    entityType === 'team' ||
    entityType === 'work-item'
}

/**
 * Creates a recognized ignored-target result.
 *
 * @param reasonCode - Stable reason without row values.
 * @returns Ignored target classification.
 */
function ignoredTargetRow(
  reasonCode: WorkspaceSearchMigrationIgnoredTargetRow['reasonCode'],
): WorkspaceSearchMigrationIgnoredTargetRow {
  return { classification: 'ignored', reasonCode }
}

/**
 * Sorts candidates by their exact lowercase target-key digest.
 *
 * @param left - First candidate.
 * @param right - Second candidate.
 * @returns UTF-8 ordinal comparison result.
 */
function compareCandidates(
  left: WorkspaceSearchMigrationPlanCandidate,
  right: WorkspaceSearchMigrationPlanCandidate,
): number {
  return compareUtf8Ordinal(
    left.operation.targetKeyDigest,
    right.operation.targetKeyDigest,
  )
}

/**
 * Rejects duplicate target ownership and digest collisions.
 *
 * @param candidates - Candidates already sorted by target-key digest.
 */
function rejectTargetCollisions(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): void {
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]
    const current = candidates[index]
    if (
      previous?.operation.targetKeyDigest ===
        current?.operation.targetKeyDigest
    ) {
      if (
        previous &&
        current &&
        serializeCanonicalAttributeMap(previous.operation.targetKey) !==
          serializeCanonicalAttributeMap(current.operation.targetKey)
      ) {
        throw new WorkspaceSearchMigrationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
          'Distinct target keys produced the same migration digest.',
        )
      }
      throw new WorkspaceSearchMigrationFailure(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
        'Multiple migration operations own the same target key.',
      )
    }
  }
}

/**
 * Builds every Merkle level using duplicate-last odd-node padding.
 *
 * @param leaves - Ordered domain-separated plan leaves.
 * @returns Levels from leaves through the one-node root.
 */
function buildMerkleLevels(leaves: readonly string[]): readonly string[][] {
  if (leaves.length === 0) return []
  const levels: string[][] = [[...leaves]]
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const current = levels.at(-1)
    if (!current) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Merkle tree lost its current level.',
      )
    }
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]
      const right = current[index + 1] ?? left
      if (!left || !right) {
        throw new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Merkle tree contains an incomplete node pair.',
        )
      }
      next.push(createWorkspaceSearchPlanNodeDigest(left, right))
    }
    levels.push(next)
  }
  return levels
}

/**
 * Creates one exact sibling path from a leaf to the common plan root.
 *
 * @param levels - Complete Merkle levels from leaf to root.
 * @param leafIndex - Zero-based ordered leaf position.
 * @returns Deterministic membership proof compatible with the state-machine.
 */
function createMembershipProof(
  levels: readonly (readonly string[])[],
  leafIndex: number,
): readonly WorkspaceSearchPlanMembershipProofStep[] {
  const proof: WorkspaceSearchPlanMembershipProofStep[] = []
  let index = leafIndex
  for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
    const level = levels[levelIndex]
    if (!level) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Merkle proof is missing a tree level.',
      )
    }
    const current = level[index]
    if (!current) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Merkle proof leaf position lies outside its level.',
      )
    }
    const isLeft = index % 2 === 0
    const sibling = isLeft
      ? level[index + 1] ?? current
      : level[index - 1]
    if (!sibling) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Merkle proof is missing a sibling node.',
      )
    }
    proof.push({
      side: isLeft ? 'right' : 'left',
      digest: sibling,
    })
    index = Math.floor(index / 2)
  }
  return proof
}

/**
 * Requires all reproduced scans to be complete and free of invalid rows.
 *
 * @param snapshot - Complete planning scan snapshot.
 */
function requireCleanScanSnapshot(
  snapshot: WorkspaceSearchMigrationScanSnapshot,
): void {
  for (const source of [
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
  ] satisfies readonly WorkspaceSearchMigrationSourceName[]) {
    if (
      snapshot.sources[source].pageCount < 1 ||
      snapshot.sources[source].invalid !== 0
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'DRY_RUN_INVALID_ROWS',
        'Planning source scans are incomplete or contain invalid rows.',
      )
    }
  }
  if (snapshot.target.pageCount < 1 || snapshot.target.invalid !== 0) {
    throw new WorkspaceSearchMigrationFailure(
      'DRY_RUN_INVALID_ROWS',
      'Planning target scan is incomplete or contains invalid rows.',
    )
  }
}

/**
 * Requires candidate counts and target actions to match every scan aggregate.
 *
 * Source counts are compared per physical owner rather than as one total.
 * Existing target preimages are independently divided into retained puts and
 * planned deletions.
 *
 * @param candidates - Complete validated operation candidate set.
 * @param snapshot - Complete planning scan snapshot.
 */
function requireCandidateAggregateCounts(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  snapshot: WorkspaceSearchMigrationScanSnapshot,
): void {
  for (const source of [
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
  ] satisfies readonly WorkspaceSearchMigrationSourceName[]) {
    const sourceCandidates = candidates.filter(
      (candidate) =>
        candidate.origin === 'source' &&
        candidate.operation.sourceCondition.source === source,
    )
    const projected = sourceCandidates.filter(
      ({ operation }) => operation.after.exists,
    ).length
    const deleted = sourceCandidates.length - projected
    const aggregate = snapshot.sources[source]
    if (
      sourceCandidates.length !== aggregate.mapped ||
      projected !== aggregate.projected ||
      deleted !== aggregate.deleted
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Plan source counts differ from reproduced source scan classifications.',
      )
    }
  }

  const observedTargetCandidates = candidates.filter(
    ({ operation }) => operation.before.exists,
  )
  const projectedTargets = observedTargetCandidates.filter(
    ({ operation }) => operation.after.exists,
  ).length
  const deletedTargets =
    observedTargetCandidates.length - projectedTargets
  if (
    observedTargetCandidates.length !== snapshot.target.mapped ||
    projectedTargets !== snapshot.target.projected ||
    deletedTargets !== snapshot.target.deleted
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Plan target counts differ from reproduced target scan classifications.',
    )
  }
}

/**
 * Throws the stable failure used for malformed source rows.
 *
 * @returns Never returns.
 */
function failInvalidSourceRow(): never {
  throw new WorkspaceSearchMigrationFailure(
    'DRY_RUN_INVALID_ROWS',
    'A migration source scan contains an invalid row.',
  )
}

/**
 * Throws the stable failure used for malformed target rows.
 *
 * @returns Never returns.
 */
function failInvalidTargetRow(): never {
  throw new WorkspaceSearchMigrationFailure(
    'DRY_RUN_INVALID_ROWS',
    'The Workspace Search target scan contains an invalid row.',
  )
}

/**
 * Requires a conventional lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param label - Secret-free digest purpose.
 */
function requireDigest(value: string, label: string): void {
  if (!isHexDigest(value)) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_ARGUMENT',
      `${label} must be a lowercase SHA-256 digest.`,
    )
  }
}

/**
 * Compares two strings by their UTF-8 byte order without locale dependence.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive ordering result.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
