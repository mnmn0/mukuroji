import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchMigrationTraversalProgress,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
} from './migration-execution-boundary'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  parseWorkspaceSearchMigrationExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
  serializeWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationTraversalExecutionState,
} from './migration-execution-state'
import type {
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  assertWorkspaceSearchMigrationMutationAuthority,
  validateWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationRunState,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'

/** Maximum canonical bytes accepted for a complete seal or applied root. */
export const WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES =
  256 * 1024

const maximumTextLength = 8_192
const maximumVersionIdLength = 1_024
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure raised for an invalid complete apply seal.
 */
export class WorkspaceSearchMigrationApplySealError extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_MIGRATION_APPLY_SEAL'

  /** Creates one stable complete apply-seal failure. */
  constructor() {
    super('INVALID_MIGRATION_APPLY_SEAL')
    this.name = 'WorkspaceSearchMigrationApplySealError'
  }
}

/**
 * Production complete-plan seal rooted in terminal execution evidence.
 */
export type WorkspaceSearchMigrationCompleteApplySeal = {
  /** Complete apply-seal discriminator. */
  readonly kind: 'workspace-search-migration-complete-apply-seal'
  /** Complete apply-seal schema version. */
  readonly sealVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Only complete plans may publish this production seal. */
  readonly scope: 'complete-plan'
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable execution-run authority binding. */
  readonly executionRunBindingDigest: string
  /** Digest of the immutable sealed planning-authority root. */
  readonly sealedPlanningAuthorityDigest: string
  /** All six immutable physical DynamoDB table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Rich exact-version reference to the admitted plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Merkle root of the exact admitted operation plan. */
  readonly planDigest: string
  /** Exact source-owned operation count. */
  readonly sourceOperationCount: number
  /** Exact orphan-target operation count. */
  readonly orphanOperationCount: number
  /** Exact complete operation count. */
  readonly planOperationCount: number
  /** Exact terminal applying-state revision. */
  readonly predecessorRevision: number
  /** Durable authority renewals included in a version-three predecessor. */
  readonly maintenanceEvidenceRenewalCount?: number
  /** Self digest of the exact terminal mutable execution state. */
  readonly predecessorExecutionStateDigest: string
  /** Digest of the exact terminal reconstructed run state. */
  readonly predecessorRunStateDigest: string
  /** Exact count of durable operation markers. */
  readonly markerCount: number
  /** Restorable digest accumulator for every operation marker. */
  readonly applyMarkerDigestState: MigrationDigestState
  /** Final order-independent aggregate digest of every marker. */
  readonly applyMarkerAggregateDigest: string
  /** Highest committed mutating journal sequence. */
  readonly journalSequence: number
  /** Hash-chain head for the highest mutating journal sequence. */
  readonly journalHeadDigest: string
  /** Earliest Object Lock deadline among committed journal segments. */
  readonly minimumJournalRetainUntil?: string
  /** Complete cursor-free terminal traversal over four sources and target. */
  readonly apply: WorkspaceSearchMigrationTraversalProgress
  /** Digest of the exact canonical terminal traversal. */
  readonly applyTraversalDigest: string
  /** Canonical adapter-owned artifact creation time. */
  readonly createdAt: string
  /** Digest of every preceding canonical seal field. */
  readonly sealDigest: string
}

/**
 * Rich exact-version reference to a production complete apply seal.
 */
export type WorkspaceSearchMigrationCompleteApplySealReference = {
  /** Production seals cover only the complete plan. */
  readonly scope: 'complete-plan'
  /** Exact content-addressed S3 object key. */
  readonly objectKey: string
  /** Exact immutable S3 object version. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical stored bytes. */
  readonly contentDigest: string
  /** Exact stored byte length. */
  readonly byteLength: number
  /** Exact canonical UTC Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Authority tuple atomically consumed by one applied-root publication.
 */
export type WorkspaceSearchMigrationAppliedRootAuthority = {
  /** Current lease owner condition-checked by the transaction. */
  readonly ownerId: string
  /** Current lease fencing token condition-checked by the transaction. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Canonical time at which the authority was strongly evaluated. */
  readonly evaluatedAt: string
}

/**
 * Immutable phase root published after a complete clean apply.
 */
export type WorkspaceSearchMigrationAppliedRoot = {
  /** Applied phase-root discriminator. */
  readonly kind: 'workspace-search-migration-applied-root'
  /** Applied phase-root schema version. */
  readonly rootVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Exact terminal applying-state revision. */
  readonly predecessorRevision: number
  /** Self digest of the exact terminal mutable execution state. */
  readonly predecessorExecutionStateDigest: string
  /** Digest of the exact terminal reconstructed run state. */
  readonly predecessorRunStateDigest: string
  /** Exact production complete-plan seal stored by this root. */
  readonly seal: WorkspaceSearchMigrationCompleteApplySeal
  /** Rich exact-version reference to the stored seal bytes. */
  readonly sealReference:
    WorkspaceSearchMigrationCompleteApplySealReference
  /** Authority tuple atomically consumed by publication. */
  readonly authority: WorkspaceSearchMigrationAppliedRootAuthority
  /** Earliest Object Lock deadline among committed journal segments. */
  readonly minimumJournalRetainUntil?: string
  /** Exact successor revision after the phase transition. */
  readonly successorRevision: number
  /** Applied lifecycle status fixed by this root version. */
  readonly status: 'applied'
  /** Digest of the reconstructed applied successor run state. */
  readonly successorRunStateDigest: string
  /** Canonical transaction commit time. */
  readonly committedAt: string
  /** Digest of every preceding canonical root field. */
  readonly rootDigest: string
}

/**
 * Material required to create one complete production apply seal.
 */
export type CreateWorkspaceSearchMigrationCompleteApplySealInput = {
  /** Immutable revision-one execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Exact terminal traversal-capable mutable state. */
  readonly predecessor: WorkspaceSearchMigrationTraversalExecutionState
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Adapter-owned canonical seal creation time. */
  readonly createdAt: string
}

/**
 * Material required to create one immutable applied phase root.
 */
export type CreateWorkspaceSearchMigrationAppliedRootInput = {
  /** Immutable revision-one execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Exact terminal traversal-capable mutable state. */
  readonly predecessor: WorkspaceSearchMigrationTraversalExecutionState
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact production seal uploaded before publication. */
  readonly seal: WorkspaceSearchMigrationCompleteApplySeal
  /** Rich exact-version reference returned by immutable storage. */
  readonly sealReference:
    WorkspaceSearchMigrationCompleteApplySealReference
  /** Fresh authority condition-checked by publication. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical transaction time. */
  readonly committedAt: string
}

/**
 * External immutable material used to validate and reconstruct a root.
 */
export type RequireWorkspaceSearchMigrationAppliedRootBindingInput = {
  /** Immutable revision-one execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Exact terminal traversal-capable mutable state. */
  readonly predecessor: WorkspaceSearchMigrationTraversalExecutionState
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact production seal read from its immutable object version. */
  readonly seal: WorkspaceSearchMigrationCompleteApplySeal
  /** Rich exact-version reference used for that read. */
  readonly sealReference:
    WorkspaceSearchMigrationCompleteApplySealReference
  /** Candidate immutable applied phase root. */
  readonly root: WorkspaceSearchMigrationAppliedRoot
}

/**
 * Creates one terminal execution-bound production complete-plan seal.
 *
 * @param input - Admission, terminal state, planning root, and creation time.
 * @returns Detached strict complete apply seal.
 */
export function createWorkspaceSearchMigrationCompleteApplySeal(
  input: CreateWorkspaceSearchMigrationCompleteApplySealInput,
): WorkspaceSearchMigrationCompleteApplySeal {
  return atApplySealBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'admission',
      'createdAt',
      'predecessor',
      'sealedPlanningAuthority',
    ])
    const admission = detachAdmission(readOwn(record, 'admission'))
    const predecessor = detachTraversalExecutionState(
      readOwn(record, 'predecessor'),
    )
    const sealedPlanningAuthority = detachSealedPlanningAuthority(
      readOwn(record, 'sealedPlanningAuthority'),
    )
    const createdAt = readTimestamp(readOwn(record, 'createdAt'))
    const state = requireTerminalSealBinding(
      admission,
      predecessor,
      sealedPlanningAuthority,
    )
    if (Date.parse(createdAt) < Date.parse(state.updatedAt)) {
      return failApplySeal()
    }
    const accumulator = MigrationDigestAccumulator.fromState(
      state.applyMarkerDigestState,
    )
    const common = {
      kind: 'workspace-search-migration-complete-apply-seal',
      sealVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      scope: 'complete-plan',
      runId: admission.runId,
      configurationHash: admission.configurationHash,
      executionRunDigest: admission.executionRunDigest,
      executionRunBindingDigest: admission.binding.bindingDigest,
      sealedPlanningAuthorityDigest:
        sealedPlanningAuthority.authorityDigest,
      tableIds: readTableIds(admission.binding.tableIds),
      planSealReference: readImmutableReference(
        admission.binding.planSealReference,
      ),
      planDigest: state.planDigest,
      sourceOperationCount:
        sealedPlanningAuthority.sourceOperationCount,
      orphanOperationCount:
        sealedPlanningAuthority.orphanOperationCount,
      planOperationCount: state.planOperationCount,
      predecessorRevision: predecessor.revision,
      ...(predecessor.executionStateVersion === 3
        ? {
            maintenanceEvidenceRenewalCount:
              predecessor.maintenanceEvidenceRenewalCount,
          }
        : {}),
      predecessorExecutionStateDigest:
        predecessor.executionStateDigest,
      predecessorRunStateDigest: predecessor.runStateDigest,
      markerCount: state.appliedOperationCount,
      applyMarkerDigestState: readDigestState(
        state.applyMarkerDigestState,
      ),
      applyMarkerAggregateDigest: accumulator.digest(),
      journalSequence: state.journalSequence,
      journalHeadDigest: state.journalHeadDigest,
      ...(predecessor.minimumJournalRetainUntil === undefined
        ? {}
        : {
            minimumJournalRetainUntil:
              predecessor.minimumJournalRetainUntil,
          }),
      apply: readTerminalTraversal(state.apply),
      applyTraversalDigest: createMigrationDigest(state.apply),
      createdAt,
    } satisfies Omit<
      WorkspaceSearchMigrationCompleteApplySeal,
      'sealDigest'
    >
    return readCompleteApplySeal({
      ...common,
      sealDigest: createMigrationDigest(common),
    })
  })
}

/**
 * Serializes one strict complete apply seal as canonical UTF-8 JSON.
 *
 * @param value - Candidate complete apply seal.
 * @returns Exact bounded canonical bytes.
 */
export function serializeWorkspaceSearchMigrationCompleteApplySeal(
  value: WorkspaceSearchMigrationCompleteApplySeal,
): Uint8Array {
  return atApplySealBoundary(() =>
    encodeDocument(readCompleteApplySeal(value))
  )
}

/**
 * Parses one exact canonical complete apply-seal document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict complete apply seal.
 */
export function parseWorkspaceSearchMigrationCompleteApplySeal(
  bytes: Uint8Array,
): WorkspaceSearchMigrationCompleteApplySeal {
  return atApplySealBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    const parsed = parseJson(snapshot)
    const seal = readCompleteApplySeal(parsed)
    if (!equalBytes(snapshot, encodeDocument(seal))) {
      return failApplySeal()
    }
    return seal
  })
}

/**
 * Validates and detaches one rich exact-version complete-seal reference.
 *
 * @param value - Candidate rich immutable reference.
 * @returns Detached strict complete-plan reference.
 */
export function readWorkspaceSearchMigrationCompleteApplySealReference(
  value: unknown,
): WorkspaceSearchMigrationCompleteApplySealReference {
  return atApplySealBoundary(() => {
    const record = requireRecord(value)
    requireExactKeys(record, [
      'byteLength',
      'contentDigest',
      'objectKey',
      'retainUntil',
      'scope',
      'versionId',
    ])
    const scope = readOwn(record, 'scope')
    const byteLength = readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    )
    if (
      scope !== 'complete-plan' ||
      byteLength >
        WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES
    ) {
      return failApplySeal()
    }
    return {
      scope,
      objectKey: readText(readOwn(record, 'objectKey')),
      versionId: readVersionId(readOwn(record, 'versionId')),
      contentDigest: readDigest(readOwn(record, 'contentDigest')),
      byteLength,
      retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
    }
  })
}

/**
 * Creates one immutable root for an atomically published applied phase.
 *
 * @param input - Terminal state, immutable seal, reference, and authority.
 * @returns Detached strict applied root.
 */
export function createWorkspaceSearchMigrationAppliedRoot(
  input: CreateWorkspaceSearchMigrationAppliedRootInput,
): WorkspaceSearchMigrationAppliedRoot {
  return atApplySealBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'admission',
      'committedAt',
      'currentAuthority',
      'predecessor',
      'seal',
      'sealReference',
      'sealedPlanningAuthority',
    ])
    const admission = detachAdmission(readOwn(record, 'admission'))
    const predecessor = detachTraversalExecutionState(
      readOwn(record, 'predecessor'),
    )
    const sealedPlanningAuthority = detachSealedPlanningAuthority(
      readOwn(record, 'sealedPlanningAuthority'),
    )
    const seal = readCompleteApplySeal(readOwn(record, 'seal'))
    const sealReference =
      readWorkspaceSearchMigrationCompleteApplySealReference(
        readOwn(record, 'sealReference'),
      )
    const currentAuthority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        readOwn(record, 'currentAuthority'),
      )
    const committedAt = readTimestamp(readOwn(record, 'committedAt'))
    const predecessorState = requireTerminalSealBinding(
      admission,
      predecessor,
      sealedPlanningAuthority,
    )
    requireSealMatchesTerminal(
      seal,
      admission,
      predecessor,
      sealedPlanningAuthority,
    )
    requireSealReference(
      seal,
      sealReference,
      predecessor.minimumJournalRetainUntil,
      committedAt,
    )
    const predecessorAuthority =
      predecessor.executionStateVersion === 3
        ? predecessor.currentAuthority
        : admission.binding.currentAuthority
    if (
      currentAuthority.configurationHash !==
        admission.configurationHash ||
      currentAuthority.stateTableId !==
        admission.binding.tableIds['migration-state'] ||
      currentAuthority.lease.runId !== admission.runId ||
      currentAuthority.lease.ownerId !==
        predecessorAuthority.ownerId ||
      currentAuthority.lease.fenceToken !==
        predecessorAuthority.fenceToken ||
      currentAuthority.maintenanceEvidencePointerRevision !==
        predecessorAuthority.maintenanceEvidencePointerRevision ||
      currentAuthority.maintenanceEvidenceReceiptDigest !==
        predecessorAuthority.maintenanceEvidenceReceiptDigest ||
      currentAuthority.maintenanceEvidenceReceiptDigest !==
        createMigrationDigest(
          predecessorState.maintenanceEvidenceReceipt,
        ) ||
      Date.parse(committedAt) < Date.parse(seal.createdAt)
    ) {
      return failApplySeal()
    }
    assertWorkspaceSearchMigrationMutationAuthority(
      predecessorState,
      {
        lease: currentAuthority.lease,
        ownerId: currentAuthority.lease.ownerId,
        at: committedAt,
      },
    )
    const successor = createAppliedSuccessor(
      predecessorState,
      sealReference,
      committedAt,
    )
    const authority: WorkspaceSearchMigrationAppliedRootAuthority = {
      ownerId: currentAuthority.lease.ownerId,
      fenceToken: currentAuthority.lease.fenceToken,
      maintenanceEvidencePointerRevision:
        currentAuthority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        currentAuthority.maintenanceEvidenceReceiptDigest,
      evaluatedAt: currentAuthority.evaluatedAt,
    }
    const common = {
      kind: 'workspace-search-migration-applied-root',
      rootVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      stateTableId: currentAuthority.stateTableId,
      configurationHash: admission.configurationHash,
      runId: admission.runId,
      executionRunDigest: admission.executionRunDigest,
      predecessorRevision: predecessor.revision,
      predecessorExecutionStateDigest:
        predecessor.executionStateDigest,
      predecessorRunStateDigest: predecessor.runStateDigest,
      seal,
      sealReference,
      authority,
      ...(predecessor.minimumJournalRetainUntil === undefined
        ? {}
        : {
            minimumJournalRetainUntil:
              predecessor.minimumJournalRetainUntil,
          }),
      successorRevision: successor.revision,
      status: 'applied',
      successorRunStateDigest: createMigrationDigest(successor),
      committedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationAppliedRoot,
      'rootDigest'
    >
    const root = readAppliedRoot({
      ...common,
      rootDigest: createMigrationDigest(common),
    })
    requireWorkspaceSearchMigrationAppliedRootBinding({
      admission,
      predecessor,
      sealedPlanningAuthority,
      seal,
      sealReference,
      root,
    })
    return root
  })
}

/**
 * Serializes one strict immutable applied root as canonical UTF-8 JSON.
 *
 * @param value - Candidate immutable applied root.
 * @returns Exact bounded canonical bytes.
 */
export function serializeWorkspaceSearchMigrationAppliedRoot(
  value: WorkspaceSearchMigrationAppliedRoot,
): Uint8Array {
  return atApplySealBoundary(() =>
    encodeDocument(readAppliedRoot(value))
  )
}

/**
 * Parses one exact canonical immutable applied-root document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict applied root.
 */
export function parseWorkspaceSearchMigrationAppliedRoot(
  bytes: Uint8Array,
): WorkspaceSearchMigrationAppliedRoot {
  return atApplySealBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    const parsed = parseJson(snapshot)
    const root = readAppliedRoot(parsed)
    if (!equalBytes(snapshot, encodeDocument(root))) {
      return failApplySeal()
    }
    return root
  })
}

/**
 * Cross-validates an applied root and reconstructs its durable successor.
 *
 * @param input - Immutable admission, predecessor, seal, reference, and root.
 * @returns Exact reconstructed applied run state.
 */
export function requireWorkspaceSearchMigrationAppliedRootBinding(
  input: RequireWorkspaceSearchMigrationAppliedRootBindingInput,
): WorkspaceSearchMigrationRunState {
  return atApplySealBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'admission',
      'predecessor',
      'root',
      'seal',
      'sealReference',
      'sealedPlanningAuthority',
    ])
    const admission = detachAdmission(readOwn(record, 'admission'))
    const predecessor = detachTraversalExecutionState(
      readOwn(record, 'predecessor'),
    )
    const sealedPlanningAuthority = detachSealedPlanningAuthority(
      readOwn(record, 'sealedPlanningAuthority'),
    )
    const seal = readCompleteApplySeal(readOwn(record, 'seal'))
    const sealReference =
      readWorkspaceSearchMigrationCompleteApplySealReference(
        readOwn(record, 'sealReference'),
      )
    const root = readAppliedRoot(readOwn(record, 'root'))
    const predecessorState = requireTerminalSealBinding(
      admission,
      predecessor,
      sealedPlanningAuthority,
    )
    requireSealMatchesTerminal(
      seal,
      admission,
      predecessor,
      sealedPlanningAuthority,
    )
    requireSealReference(
      seal,
      sealReference,
      predecessor.minimumJournalRetainUntil,
      root.committedAt,
    )
    const predecessorAuthority =
      predecessor.executionStateVersion === 3
        ? predecessor.currentAuthority
        : admission.binding.currentAuthority
    if (
      root.stateTableId !==
        admission.binding.tableIds['migration-state'] ||
      root.configurationHash !== admission.configurationHash ||
      root.runId !== admission.runId ||
      root.executionRunDigest !== admission.executionRunDigest ||
      root.predecessorRevision !== predecessor.revision ||
      root.predecessorExecutionStateDigest !==
        predecessor.executionStateDigest ||
      root.predecessorRunStateDigest !==
        predecessor.runStateDigest ||
      serializeCanonicalJson(root.seal) !==
        serializeCanonicalJson(seal) ||
      serializeCanonicalJson(root.sealReference) !==
        serializeCanonicalJson(sealReference) ||
      root.authority.ownerId !==
        predecessorAuthority.ownerId ||
      root.authority.fenceToken !==
        predecessorAuthority.fenceToken ||
      root.authority.maintenanceEvidencePointerRevision !==
        predecessorAuthority.maintenanceEvidencePointerRevision ||
      root.authority.maintenanceEvidenceReceiptDigest !==
        predecessorAuthority.maintenanceEvidenceReceiptDigest ||
      root.authority.maintenanceEvidenceReceiptDigest !==
        createMigrationDigest(
          predecessorState.maintenanceEvidenceReceipt,
        ) ||
      root.minimumJournalRetainUntil !==
        predecessor.minimumJournalRetainUntil
    ) {
      return failApplySeal()
    }
    const successor = createAppliedSuccessor(
      predecessorState,
      sealReference,
      root.committedAt,
    )
    if (
      root.successorRevision !== successor.revision ||
      root.successorRunStateDigest !==
        createMigrationDigest(successor)
    ) {
      return failApplySeal()
    }
    return successor
  })
}

/**
 * Detaches and validates a complete apply seal.
 *
 * @param value - Candidate complete seal.
 * @returns Detached strict complete seal.
 */
function readCompleteApplySeal(
  value: unknown,
): WorkspaceSearchMigrationCompleteApplySeal {
  const record = requireRecord(value)
  const hasMinimum = hasOwnDataProperty(
    record,
    'minimumJournalRetainUntil',
  )
  const hasRenewalCount = hasOwnDataProperty(
    record,
    'maintenanceEvidenceRenewalCount',
  )
  requireExactKeys(record, [
    'apply',
    'applyMarkerAggregateDigest',
    'applyMarkerDigestState',
    'applyTraversalDigest',
    'configurationHash',
    'createdAt',
    'executionRunBindingDigest',
    'executionRunDigest',
    'journalHeadDigest',
    'journalSequence',
    'kind',
    'markerCount',
    ...(hasRenewalCount
      ? ['maintenanceEvidenceRenewalCount']
      : []),
    'migrationId',
    'migrationVersion',
    'orphanOperationCount',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'predecessorExecutionStateDigest',
    'predecessorRevision',
    'predecessorRunStateDigest',
    'runId',
    'scope',
    'sealVersion',
    'sealDigest',
    'sealedPlanningAuthorityDigest',
    'sourceOperationCount',
    'tableIds',
    ...(hasMinimum ? ['minimumJournalRetainUntil'] : []),
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-complete-apply-seal' ||
    readOwn(record, 'sealVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'scope') !== 'complete-plan'
  ) {
    return failApplySeal()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const executionRunBindingDigest = readDigest(
    readOwn(record, 'executionRunBindingDigest'),
  )
  const sealedPlanningAuthorityDigest = readDigest(
    readOwn(record, 'sealedPlanningAuthorityDigest'),
  )
  const tableIds = readTableIds(readOwn(record, 'tableIds'))
  const planSealReference = readImmutableReference(
    readOwn(record, 'planSealReference'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  const sourceOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'sourceOperationCount'),
  )
  const orphanOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'orphanOperationCount'),
  )
  const planOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  const maintenanceEvidenceRenewalCount = hasRenewalCount
    ? readPositiveSafeInteger(
        readOwn(record, 'maintenanceEvidenceRenewalCount'),
      )
    : 0
  const predecessorExecutionStateDigest = readDigest(
    readOwn(record, 'predecessorExecutionStateDigest'),
  )
  const predecessorRunStateDigest = readDigest(
    readOwn(record, 'predecessorRunStateDigest'),
  )
  const markerCount = readNonNegativeSafeInteger(
    readOwn(record, 'markerCount'),
  )
  const applyMarkerDigestState = readDigestState(
    readOwn(record, 'applyMarkerDigestState'),
  )
  const applyMarkerAggregateDigest = readDigest(
    readOwn(record, 'applyMarkerAggregateDigest'),
  )
  const journalSequence = readNonNegativeSafeInteger(
    readOwn(record, 'journalSequence'),
  )
  const journalHeadDigest = readDigest(
    readOwn(record, 'journalHeadDigest'),
  )
  const minimumJournalRetainUntil = hasMinimum
    ? readTimestamp(
        readOwn(record, 'minimumJournalRetainUntil'),
      )
    : undefined
  const apply = readTerminalTraversal(readOwn(record, 'apply'))
  const applyTraversalDigest = readDigest(
    readOwn(record, 'applyTraversalDigest'),
  )
  const createdAt = readTimestamp(readOwn(record, 'createdAt'))
  const markerAccumulator = MigrationDigestAccumulator.fromState(
    applyMarkerDigestState,
  )
  if (
    addSafeCounts(sourceOperationCount, orphanOperationCount) !==
      planOperationCount ||
    markerCount !== planOperationCount ||
    applyMarkerDigestState.count !== markerCount ||
    markerAccumulator.digest() !== applyMarkerAggregateDigest ||
    journalSequence > markerCount ||
    (journalSequence === 0) !==
      (journalHeadDigest === zeroHexDigest()) ||
    (journalSequence === 0) !==
      (minimumJournalRetainUntil === undefined) ||
    createMigrationDigest(apply) !== applyTraversalDigest ||
    addSafeCounts(
      calculateTerminalRevision(markerCount, apply),
      maintenanceEvidenceRenewalCount,
    ) !==
      predecessorRevision
  ) {
    return failApplySeal()
  }
  const common = {
    kind: 'workspace-search-migration-complete-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    scope: 'complete-plan',
    runId,
    configurationHash,
    executionRunDigest,
    executionRunBindingDigest,
    sealedPlanningAuthorityDigest,
    tableIds,
    planSealReference,
    planDigest,
    sourceOperationCount,
    orphanOperationCount,
    planOperationCount,
    predecessorRevision,
    ...(hasRenewalCount
      ? { maintenanceEvidenceRenewalCount }
      : {}),
    predecessorExecutionStateDigest,
    predecessorRunStateDigest,
    markerCount,
    applyMarkerDigestState,
    applyMarkerAggregateDigest,
    journalSequence,
    journalHeadDigest,
    ...(minimumJournalRetainUntil === undefined
      ? {}
      : { minimumJournalRetainUntil }),
    apply,
    applyTraversalDigest,
    createdAt,
  } satisfies Omit<
    WorkspaceSearchMigrationCompleteApplySeal,
    'sealDigest'
  >
  const sealDigest = readDigest(readOwn(record, 'sealDigest'))
  if (sealDigest !== createMigrationDigest(common)) {
    return failApplySeal()
  }
  return {
    ...common,
    sealDigest,
  }
}

/**
 * Detaches and validates one immutable applied root.
 *
 * @param value - Candidate applied root.
 * @returns Detached strict applied root.
 */
function readAppliedRoot(
  value: unknown,
): WorkspaceSearchMigrationAppliedRoot {
  const record = requireRecord(value)
  const hasMinimum = hasOwnDataProperty(
    record,
    'minimumJournalRetainUntil',
  )
  requireExactKeys(record, [
    'authority',
    'committedAt',
    'configurationHash',
    'executionRunDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'predecessorExecutionStateDigest',
    'predecessorRevision',
    'predecessorRunStateDigest',
    'rootDigest',
    'rootVersion',
    'runId',
    'seal',
    'sealReference',
    'stateTableId',
    'status',
    'successorRevision',
    'successorRunStateDigest',
    ...(hasMinimum ? ['minimumJournalRetainUntil'] : []),
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-applied-root' ||
    readOwn(record, 'rootVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'status') !== 'applied'
  ) {
    return failApplySeal()
  }
  const stateTableId = readText(readOwn(record, 'stateTableId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const runId = readIdentifier(readOwn(record, 'runId'))
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  const predecessorExecutionStateDigest = readDigest(
    readOwn(record, 'predecessorExecutionStateDigest'),
  )
  const predecessorRunStateDigest = readDigest(
    readOwn(record, 'predecessorRunStateDigest'),
  )
  const seal = readCompleteApplySeal(readOwn(record, 'seal'))
  const sealReference =
    readWorkspaceSearchMigrationCompleteApplySealReference(
      readOwn(record, 'sealReference'),
    )
  const authority = readAppliedRootAuthority(
    readOwn(record, 'authority'),
  )
  const minimumJournalRetainUntil = hasMinimum
    ? readTimestamp(
        readOwn(record, 'minimumJournalRetainUntil'),
      )
    : undefined
  const successorRevision = readPositiveSafeInteger(
    readOwn(record, 'successorRevision'),
  )
  const successorRunStateDigest = readDigest(
    readOwn(record, 'successorRunStateDigest'),
  )
  const committedAt = readTimestamp(readOwn(record, 'committedAt'))
  if (
    successorRevision !== addSafeCounts(predecessorRevision, 1) ||
    stateTableId !== seal.tableIds['migration-state'] ||
    configurationHash !== seal.configurationHash ||
    runId !== seal.runId ||
    executionRunDigest !== seal.executionRunDigest ||
    predecessorRevision !== seal.predecessorRevision ||
    predecessorExecutionStateDigest !==
      seal.predecessorExecutionStateDigest ||
    predecessorRunStateDigest !==
      seal.predecessorRunStateDigest ||
    minimumJournalRetainUntil !==
      seal.minimumJournalRetainUntil ||
    sealReference.contentDigest !== createMigrationDigest(seal) ||
    sealReference.byteLength !==
      encodeDocument(seal).byteLength ||
    Date.parse(committedAt) < Date.parse(seal.createdAt) ||
    Date.parse(sealReference.retainUntil) <=
      Date.parse(committedAt)
  ) {
    return failApplySeal()
  }
  const common = {
    kind: 'workspace-search-migration-applied-root',
    rootVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId,
    configurationHash,
    runId,
    executionRunDigest,
    predecessorRevision,
    predecessorExecutionStateDigest,
    predecessorRunStateDigest,
    seal,
    sealReference,
    authority,
    ...(minimumJournalRetainUntil === undefined
      ? {}
      : { minimumJournalRetainUntil }),
    successorRevision,
    status: 'applied',
    successorRunStateDigest,
    committedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationAppliedRoot,
    'rootDigest'
  >
  const rootDigest = readDigest(readOwn(record, 'rootDigest'))
  if (rootDigest !== createMigrationDigest(common)) {
    return failApplySeal()
  }
  return {
    ...common,
    rootDigest,
  }
}

/**
 * Reads one strict applied-root authority tuple.
 *
 * @param value - Candidate authority tuple.
 * @returns Detached strict authority tuple.
 */
function readAppliedRootAuthority(
  value: unknown,
): WorkspaceSearchMigrationAppliedRootAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'evaluatedAt',
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
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
}

/**
 * Requires the admission, planning authority, and terminal state to correlate.
 *
 * @param admission - Detached immutable execution admission.
 * @param predecessor - Detached terminal mutable execution state.
 * @param sealedPlanningAuthority - Detached immutable planning root.
 * @returns Exact reconstructed terminal applying run state.
 */
function requireTerminalSealBinding(
  admission: WorkspaceSearchMigrationExecutionRun,
  predecessor: WorkspaceSearchMigrationTraversalExecutionState,
  sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): WorkspaceSearchMigrationRunState {
  const state = reconstructWorkspaceSearchMigrationRunState(
    admission,
    predecessor,
  )
  const terminalTraversal = readTerminalTraversal(state.apply)
  let sourceOperationCount = 0
  let sourceProjectedCount = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    const checkpoint = terminalTraversal.sources[source]
    const evidenceHead = sealedPlanningAuthority.evidenceHeads.find(
      (candidate) => candidate.chain === source,
    )
    if (
      evidenceHead === undefined ||
      evidenceHead.pageCount !== checkpoint.aggregate.pageCount ||
      evidenceHead.terminalCheckpointDigest !==
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          checkpoint,
        )
    ) {
      return failApplySeal()
    }
    sourceOperationCount = addSafeCounts(
      sourceOperationCount,
      checkpoint.aggregate.mapped,
    )
    sourceProjectedCount = addSafeCounts(
      sourceProjectedCount,
      checkpoint.aggregate.projected,
    )
  }
  const targetCheckpoint = terminalTraversal.target
  if (
    (
      predecessor.executionStateVersion !== 2 &&
      predecessor.executionStateVersion !== 3
    ) ||
    predecessor.status !== 'applying' ||
    predecessor.executionRunDigest !== admission.executionRunDigest ||
    admission.binding.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthority.authorityDigest ||
    admission.runId !== sealedPlanningAuthority.runId ||
    admission.configurationHash !==
      sealedPlanningAuthority.configurationHash ||
    admission.binding.planDigest !==
      sealedPlanningAuthority.planDigest ||
    admission.binding.planOperationCount !==
      sealedPlanningAuthority.planOperationCount ||
    serializeCanonicalJson(admission.binding.tableIds) !==
      serializeCanonicalJson(sealedPlanningAuthority.tableIds) ||
    serializeCanonicalJson(admission.binding.planSealReference) !==
      serializeCanonicalJson(
        sealedPlanningAuthority.planSealReference,
      ) ||
    state.status !== 'applying' ||
    state.appliedOperationCount !== state.planOperationCount ||
    state.planOperationCount !==
      sealedPlanningAuthority.planOperationCount ||
    sourceOperationCount !==
      sealedPlanningAuthority.sourceOperationCount ||
    targetCheckpoint.aggregate.mapped !== sourceProjectedCount ||
    targetCheckpoint.aggregate.projected !== sourceProjectedCount ||
    targetCheckpoint.aggregate.deleted !== 0 ||
    state.applyMarkerDigestState.count !==
      state.appliedOperationCount ||
    addSafeCounts(
      calculateTerminalRevision(
        state.appliedOperationCount,
        terminalTraversal,
      ),
      predecessor.executionStateVersion === 3
        ? predecessor.maintenanceEvidenceRenewalCount
        : 0,
    ) !== state.revision ||
    state.revision !== predecessor.revision
  ) {
    return failApplySeal()
  }
  return state
}

/**
 * Requires one complete seal to be the unique seal for a terminal state.
 *
 * @param seal - Detached candidate complete seal.
 * @param admission - Detached immutable admission.
 * @param predecessor - Detached terminal mutable state.
 * @param sealedPlanningAuthority - Detached immutable planning root.
 */
function requireSealMatchesTerminal(
  seal: WorkspaceSearchMigrationCompleteApplySeal,
  admission: WorkspaceSearchMigrationExecutionRun,
  predecessor: WorkspaceSearchMigrationTraversalExecutionState,
  sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): void {
  const expected = createWorkspaceSearchMigrationCompleteApplySeal({
    admission,
    predecessor,
    sealedPlanningAuthority,
    createdAt: seal.createdAt,
  })
  if (
    serializeCanonicalJson(seal) !==
      serializeCanonicalJson(expected)
  ) {
    return failApplySeal()
  }
}

/**
 * Requires one rich reference to retain the exact production seal safely.
 *
 * @param seal - Exact canonical production seal.
 * @param reference - Rich exact-version immutable reference.
 * @param minimumJournalRetainUntil - Earliest committed journal deadline.
 * @param committedAt - Final applied-root transaction time.
 */
function requireSealReference(
  seal: WorkspaceSearchMigrationCompleteApplySeal,
  reference: WorkspaceSearchMigrationCompleteApplySealReference,
  minimumJournalRetainUntil: string | undefined,
  committedAt: string,
): void {
  const commitEpoch = Date.parse(committedAt)
  const retainUntilEpoch = Date.parse(reference.retainUntil)
  if (
    reference.contentDigest !== createMigrationDigest(seal) ||
    reference.byteLength !== encodeDocument(seal).byteLength ||
    reference.retainUntil !== seal.planSealReference.retainUntil ||
    Date.parse(seal.createdAt) > commitEpoch ||
    retainUntilEpoch <=
      commitEpoch +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    (
      minimumJournalRetainUntil !== undefined &&
      (
        Date.parse(minimumJournalRetainUntil) <
          retainUntilEpoch ||
        Date.parse(minimumJournalRetainUntil) <=
          commitEpoch +
            WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
      )
    ) ||
    Date.parse(seal.planSealReference.retainUntil) <=
      commitEpoch +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  ) {
    return failApplySeal()
  }
}

/**
 * Creates and validates the applied successor represented by one root.
 *
 * @param predecessor - Exact terminal applying run state.
 * @param reference - Rich exact-version complete-seal reference.
 * @param committedAt - Canonical transaction time.
 * @returns Exact validated applied run state.
 */
function createAppliedSuccessor(
  predecessor: WorkspaceSearchMigrationRunState,
  reference: WorkspaceSearchMigrationCompleteApplySealReference,
  committedAt: string,
): WorkspaceSearchMigrationRunState {
  if (
    predecessor.status !== 'applying' ||
    predecessor.revision === Number.MAX_SAFE_INTEGER ||
    Date.parse(committedAt) < Date.parse(predecessor.updatedAt)
  ) {
    return failApplySeal()
  }
  const successor: WorkspaceSearchMigrationRunState = {
    ...predecessor,
    revision: predecessor.revision + 1,
    status: 'applied',
    applySeal: {
      scope: 'complete-plan',
      objectKey: reference.objectKey,
      versionId: reference.versionId,
      contentDigest: reference.contentDigest,
    },
    updatedAt: committedAt,
  }
  validateWorkspaceSearchMigrationRunState(successor)
  return successor
}

/**
 * Detaches one immutable execution admission through its strict codec.
 *
 * @param value - Candidate immutable admission.
 * @returns Detached strict immutable admission.
 */
function detachAdmission(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRun(value)) return failApplySeal()
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(value),
  )
}

/**
 * Minimally narrows one candidate execution admission for strict serialization.
 *
 * @param value - Candidate admission.
 * @returns Whether the strict admission codec may consume it.
 */
function isExecutionRun(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isOrdinaryObject(value)
}

/**
 * Detaches one traversal-capable mutable state through its strict codec.
 *
 * @param value - Candidate mutable execution state.
 * @returns Detached strict version-two mutable state.
 */
function detachTraversalExecutionState(
  value: unknown,
): WorkspaceSearchMigrationTraversalExecutionState {
  if (!isTraversalExecutionState(value)) return failApplySeal()
  const detached = parseWorkspaceSearchMigrationExecutionState(
    serializeWorkspaceSearchMigrationExecutionState(value),
  )
  if (
    detached.executionStateVersion !== 2 &&
    detached.executionStateVersion !== 3
  ) {
    return failApplySeal()
  }
  return detached
}

/**
 * Minimally narrows a candidate traversal state for strict serialization.
 *
 * @param value - Candidate execution state.
 * @returns Whether the strict execution-state codec may consume it.
 */
function isTraversalExecutionState(
  value: unknown,
): value is WorkspaceSearchMigrationTraversalExecutionState {
  return isOrdinaryObject(value)
}

/**
 * Detaches one sealed planning authority through its strict codec.
 *
 * @param value - Candidate sealed planning authority.
 * @returns Detached strict version-two authority.
 */
function detachSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthority(value)) return failApplySeal()
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      value,
    ),
  )
}

/**
 * Minimally narrows a candidate authority for strict serialization.
 *
 * @param value - Candidate planning authority.
 * @returns Whether the strict authority codec may consume it.
 */
function isSealedPlanningAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isOrdinaryObject(value)
}

/**
 * Reads the exact six role-indexed immutable TableIds.
 *
 * @param value - Candidate role-indexed TableIds.
 * @returns Detached exact TableIds.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  const record = requireRecord(value)
  requireExactKeys(record, tableRoles)
  return {
    'project-directory': readText(
      readOwn(record, 'project-directory'),
    ),
    'work-items': readText(readOwn(record, 'work-items')),
    collaboration: readText(readOwn(record, 'collaboration')),
    documents: readText(readOwn(record, 'documents')),
    'workspace-search': readText(
      readOwn(record, 'workspace-search'),
    ),
    'migration-state': readText(
      readOwn(record, 'migration-state'),
    ),
  }
}

/**
 * Reads one rich generic immutable artifact reference.
 *
 * @param value - Candidate rich immutable reference.
 * @returns Detached strict immutable reference.
 */
function readImmutableReference(
  value: unknown,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  return {
    objectKey: readText(readOwn(record, 'objectKey')),
    versionId: readVersionId(readOwn(record, 'versionId')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
}

/**
 * Reads and validates a cursor-free terminal five-location traversal.
 *
 * @param value - Candidate terminal traversal.
 * @returns Detached strict terminal traversal.
 */
function readTerminalTraversal(
  value: unknown,
): WorkspaceSearchMigrationTraversalProgress {
  const record = requireRecord(value)
  requireExactKeys(record, ['sources', 'target'])
  const sourcesRecord = requireRecord(readOwn(record, 'sources'))
  requireExactKeys(
    sourcesRecord,
    workspaceSearchMigrationSourceNames,
  )
  const traversal: WorkspaceSearchMigrationTraversalProgress = {
    sources: {
      'project-directory': readTerminalCheckpoint(
        readOwn(sourcesRecord, 'project-directory'),
      ),
      'work-items': readTerminalCheckpoint(
        readOwn(sourcesRecord, 'work-items'),
      ),
      collaboration: readTerminalCheckpoint(
        readOwn(sourcesRecord, 'collaboration'),
      ),
      documents: readTerminalCheckpoint(
        readOwn(sourcesRecord, 'documents'),
      ),
    },
    target: readTerminalCheckpoint(readOwn(record, 'target')),
  }
  return traversal
}

/**
 * Reads one complete, clean, cursor-free terminal checkpoint.
 *
 * @param value - Candidate terminal checkpoint.
 * @returns Detached strict terminal checkpoint.
 */
function readTerminalCheckpoint(
  value: unknown,
): MigrationSourceCheckpoint {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'aggregate',
    'completed',
    'contentDigestState',
    'keyDigestState',
  ])
  if (readOwn(record, 'completed') !== true) {
    return failApplySeal()
  }
  const checkpoint: MigrationSourceCheckpoint = {
    completed: true,
    aggregate: readScanAggregate(readOwn(record, 'aggregate')),
    keyDigestState: readDigestState(
      readOwn(record, 'keyDigestState'),
    ),
    contentDigestState: readDigestState(
      readOwn(record, 'contentDigestState'),
    ),
  }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  if (
    checkpoint.aggregate.invalid !== 0 ||
    checkpoint.aggregate.pageCount <= 0
  ) {
    return failApplySeal()
  }
  return checkpoint
}

/**
 * Reads one strict cumulative scan aggregate.
 *
 * @param value - Candidate scan aggregate.
 * @returns Detached strict scan aggregate.
 */
function readScanAggregate(value: unknown): MigrationScanAggregate {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
    scanned: readNonNegativeSafeInteger(
      readOwn(record, 'scanned'),
    ),
    mapped: readNonNegativeSafeInteger(
      readOwn(record, 'mapped'),
    ),
    ignored: readNonNegativeSafeInteger(
      readOwn(record, 'ignored'),
    ),
    invalid: readNonNegativeSafeInteger(
      readOwn(record, 'invalid'),
    ),
    projected: readNonNegativeSafeInteger(
      readOwn(record, 'projected'),
    ),
    deleted: readNonNegativeSafeInteger(
      readOwn(record, 'deleted'),
    ),
    keyDigest: readDigest(readOwn(record, 'keyDigest')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    pageCount: readNonNegativeSafeInteger(
      readOwn(record, 'pageCount'),
    ),
  }
}

/**
 * Reads one restorable migration digest accumulator state.
 *
 * @param value - Candidate digest state.
 * @returns Detached strict digest state.
 */
function readDigestState(value: unknown): MigrationDigestState {
  const record = requireRecord(value)
  requireExactKeys(record, ['count', 'sumHex', 'xorHex'])
  const state: MigrationDigestState = {
    count: readNonNegativeSafeInteger(readOwn(record, 'count')),
    sumHex: readDigest(readOwn(record, 'sumHex')),
    xorHex: readDigest(readOwn(record, 'xorHex')),
  }
  MigrationDigestAccumulator.fromState(state)
  return state
}

/**
 * Derives the unique terminal v2 revision.
 *
 * @param markerCount - Exact durable marker count.
 * @param traversal - Complete five-location traversal.
 * @returns Admission plus markers plus every durable page.
 */
function calculateTerminalRevision(
  markerCount: number,
  traversal: WorkspaceSearchMigrationTraversalProgress,
): number {
  let revision = addSafeCounts(1, markerCount)
  for (const source of workspaceSearchMigrationSourceNames) {
    revision = addSafeCounts(
      revision,
      traversal.sources[source].aggregate.pageCount,
    )
  }
  return addSafeCounts(
    revision,
    traversal.target.aggregate.pageCount,
  )
}

/**
 * Adds two nonnegative counts without exceeding the safe integer range.
 *
 * @param left - Existing count.
 * @param right - Additional count.
 * @returns Safe exact sum.
 */
function addSafeCounts(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) {
    return failApplySeal()
  }
  return sum
}

/**
 * Encodes one validated document as bounded canonical UTF-8 bytes.
 *
 * @param value - Validated canonical document.
 * @returns Exact bounded bytes.
 */
function encodeDocument(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES
  ) {
    return failApplySeal()
  }
  return bytes
}

/**
 * Parses exact UTF-8 JSON without replacement characters.
 *
 * @param bytes - Detached bounded bytes.
 * @returns Untrusted parsed JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failApplySeal()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failApplySeal()
  }
}

/**
 * Copies one bounded non-shared Uint8Array.
 *
 * @param value - Candidate document bytes.
 * @returns Detached exact bytes.
 */
function copyBoundedBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failApplySeal()
  }
  const buffer = readIntrinsicBuffer(value)
  const byteLength = readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES
  ) {
    return failApplySeal()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failApplySeal()
  }
  return copy
}

/**
 * Reads the intrinsic backing buffer of one Uint8Array.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic ArrayBuffer or SharedArrayBuffer.
 */
function readIntrinsicBuffer(value: Uint8Array): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'buffer',
      )
  if (descriptor?.get === undefined) return failApplySeal()
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      !nodeUtilTypes.isArrayBuffer(result) &&
      !nodeUtilTypes.isSharedArrayBuffer(result)
    ) {
      return failApplySeal()
    }
    return result
  } catch {
    return failApplySeal()
  }
}

/**
 * Reads the intrinsic byte length of one Uint8Array.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readIntrinsicByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'byteLength',
      )
  if (descriptor?.get === undefined) return failApplySeal()
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      typeof result !== 'number' ||
      !Number.isSafeInteger(result)
    ) {
      return failApplySeal()
    }
    return result
  } catch {
    return failApplySeal()
  }
}

/**
 * Compares two byte arrays without reading caller-modifiable properties.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether every byte is identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Requires one ordinary non-array, non-proxy record.
 *
 * @param value - Candidate record.
 * @returns Validated record.
 */
function requireRecord(value: unknown): object {
  if (!isOrdinaryObject(value)) return failApplySeal()
  return value
}

/**
 * Checks whether one value is an ordinary data object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is an ordinary non-proxy object.
 */
function isOrdinaryObject(value: unknown): value is object {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Requires exactly the declared enumerable own data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact required key set.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort()
  const ownKeys = Reflect.ownKeys(value)
  const expectedKeys = [...expected].sort()
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failApplySeal()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failApplySeal()
    }
  }
}

/**
 * Checks whether an enumerable own data property exists.
 *
 * @param value - Validated record.
 * @param key - Candidate property name.
 * @returns Whether the exact own data property exists.
 */
function hasOwnDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return false
  if (
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failApplySeal()
  }
  return true
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required property name.
 * @returns Exact untrusted value.
 */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failApplySeal()
  }
  return descriptor.value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Exact identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') return failApplySeal()
  try {
    requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failApplySeal()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Exact digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failApplySeal()
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failApplySeal()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate number.
 * @returns Exact nonnegative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failApplySeal()
  }
  return value
}

/**
 * Reads one canonical UTC millisecond timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failApplySeal()
  return value
}

/**
 * Reads one bounded nonempty text value.
 *
 * @param value - Candidate text.
 * @returns Exact text.
 */
function readText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    value !== value.trim()
  ) {
    return failApplySeal()
  }
  return value
}

/**
 * Reads one bounded immutable S3 version identifier.
 *
 * @param value - Candidate version identifier.
 * @returns Exact version identifier.
 */
function readVersionId(value: unknown): string {
  const versionId = readText(value)
  if (
    versionId.length > maximumVersionIdLength ||
    versionId === 'null'
  ) {
    return failApplySeal()
  }
  return versionId
}

/**
 * Runs one public operation behind the stable apply-seal boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function atApplySealBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationApplySealError()
  }
}

/**
 * Raises the stable apply-seal failure.
 *
 * @returns Never returns.
 */
function failApplySeal(): never {
  throw new WorkspaceSearchMigrationApplySealError()
}
