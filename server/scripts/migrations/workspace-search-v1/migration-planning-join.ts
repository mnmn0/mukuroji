import { types as nodeUtilTypes } from 'node:util'
import {
  createAttributeMapDigest,
  DYNAMODB_MAX_ITEM_SIZE_BYTES,
  parseCanonicalAttributeMap,
  serializeCanonicalAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationGlobalSecondaryIndex,
  type MigrationJournalIdentity,
  type MigrationKeyAttribute,
  type MigrationScanAggregate,
  type MigrationTableIdentity,
  requireMigrationIdentifier,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationScanSnapshot,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationPlanningJoinLimits,
  WorkspaceSearchMigrationPlanningSourcePageMaterial,
  WorkspaceSearchMigrationPlanningTargetPageMaterial,
} from './migration-planning-material'
export type {
  WorkspaceSearchMigrationPlanningJoinLimits,
  WorkspaceSearchMigrationPlanningSourcePageMaterial,
  WorkspaceSearchMigrationPlanningTargetPageMaterial,
} from './migration-planning-material'
import {
  classifyWorkspaceSearchMigrationTargetRow,
  createWorkspaceSearchMigrationOrphanCandidate,
  createWorkspaceSearchMigrationSourceCandidate,
  type WorkspaceSearchMigrationObservedTargetBinding,
  type WorkspaceSearchMigrationPlanCandidate,
  type WorkspaceSearchMigrationSourceOwnershipBinding,
  type WorkspaceSearchMigrationSourceScanRowEvidence,
  type WorkspaceSearchMigrationTargetOwnershipEvidence,
  type WorkspaceSearchMigrationTargetScanRowEvidence,
} from './migration-planner'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidencePage,
  createWorkspaceSearchMigrationSourceEvidencePageDigest,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  replayWorkspaceSearchMigrationSourceEvidencePages,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationSourceEvidenceIdentity,
  type WorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
  WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES,
} from './migration-source-evidence'
import {
  cloneWorkspaceSearchMigrationExactTableKeyFromItem,
} from './migration-source-scan-context'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
} from './migration-source-scan-page'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePage,
  createWorkspaceSearchMigrationTargetEvidencePageDigest,
  parseWorkspaceSearchMigrationTargetEvidencePage,
  replayWorkspaceSearchMigrationTargetEvidencePages,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceIdentity,
  type WorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
  WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES,
} from './migration-target-evidence'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/** Existing durable-adapter ceiling applied to each evidence chain. */
const planningJoinMaximumPagesPerChain = 10_000

/** Number of complete evidence chains required by one planning join. */
const planningJoinRequiredChainCount =
  workspaceSearchMigrationSourceNames.length + 1

/** Maximum document nesting depth accepted by DynamoDB. */
const planningJoinMaximumAttributeDepth = 32

/**
 * Maximum scalar bytes traversed before the exact DynamoDB size check.
 *
 * Six times the 400 KiB item limit retains worst-case JSON escaping while
 * bounding a malicious number spelling or string before canonicalization.
 */
const planningJoinMaximumAttributeProjectionBytes =
  DYNAMODB_MAX_ITEM_SIZE_BYTES * 6

/** Trusted intrinsic getter that ignores caller-owned typed-array properties. */
const planningJoinTypedArrayByteLengthGetter =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'byteLength',
  )?.get

/** Trusted intrinsic getter that reveals the actual typed-array backing store. */
const planningJoinTypedArrayBufferGetter =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'buffer',
  )?.get

/**
 * Stable failure codes that the pure join is permitted to preserve.
 */
type WorkspaceSearchMigrationPlanningJoinFailureCode = Extract<
  WorkspaceSearchMigrationFailureCode,
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'DRY_RUN_INVALID_ROWS'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'
>

/**
 * Codes deliberately selected while projecting the untrusted clone envelope.
 */
type PlanningJoinDetachFailureCode = Extract<
  WorkspaceSearchMigrationPlanningJoinFailureCode,
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'TABLE_SCHEMA_MISMATCH'
>

/**
 * Private branded failure that caller-owned getters cannot construct.
 */
class PlanningJoinDetachFailure extends Error {
  /** Trusted stable code selected by bounded projection logic. */
  readonly code: PlanningJoinDetachFailureCode

  /**
   * Creates one private bounded-projection failure.
   *
   * @param code - Trusted stable projection failure code.
   */
  constructor(code: PlanningJoinDetachFailureCode) {
    super(code)
    this.name = 'PlanningJoinDetachFailure'
    this.code = code
  }
}

/** Exhaustive allowlist for trusted failures raised inside the detached join. */
const planningJoinFailureCodes = {
  AMBIGUOUS_OPERATION_UNRESOLVED: true,
  CONFIGURATION_HASH_MISMATCH: true,
  DRY_RUN_INVALID_ROWS: true,
  IDENTITY_MISMATCH: true,
  INVALID_ARGUMENT: true,
  INVALID_MAINTENANCE_EVIDENCE: true,
  INVALID_STATE: true,
  TABLE_SCHEMA_MISMATCH: true,
} satisfies Readonly<
  Record<WorkspaceSearchMigrationPlanningJoinFailureCode, true>
>

/**
 * Cheap clone-envelope counters accumulated without reading raw item values.
 */
type PlanningJoinEnvelopeCounts = {
  /** Number of source and target evidence pages observed. */
  pages: number
  /** Number of raw item array entries observed. */
  rows: number
}

/**
 * One dense array captured exclusively through own data descriptors.
 */
type PlanningJoinCapturedArray = {
  /** Caller-owned array retained only until the immediate bounded recheck. */
  readonly owner: object
  /** Exact own data-property values captured at every dense array index. */
  readonly values: readonly unknown[]
}

/**
 * One page material captured without invoking caller-owned accessors.
 */
type PlanningJoinCapturedMaterial = {
  /** Caller-owned material record retained for the immediate recheck. */
  readonly owner: object
  /** Exact page data-property value observed during envelope capture. */
  readonly page: unknown
  /** Exact raw-item-array data-property value observed during capture. */
  readonly items: unknown
  /** Raw-item count observed without reading any item value. */
  readonly rowCount: number
}

/**
 * One complete material chain captured before any deep detachment.
 */
type PlanningJoinCapturedChain = {
  /** Caller-owned material array and its captured index values. */
  readonly array: PlanningJoinCapturedArray
  /** Exact material descriptors corresponding to every captured index. */
  readonly materials: readonly PlanningJoinCapturedMaterial[]
}

/**
 * Complete bounded envelope whose configuration scalars are already detached.
 */
type PlanningJoinCapturedEnvelope = {
  /** Primitive run identifier copied without coercion. */
  readonly runId: string
  /** Recursively projected measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Primitive reviewed configuration digest copied without coercion. */
  readonly configurationHash: string
  /** Detached positive safe-integer limits. */
  readonly limits: WorkspaceSearchMigrationPlanningJoinLimits
  /** Captured four-source material chains. */
  readonly sourcePages: Readonly<
    Record<WorkspaceSearchMigrationSourceName, PlanningJoinCapturedChain>
  >
  /** Captured target material chain. */
  readonly targetPages: PlanningJoinCapturedChain
}

/**
 * Mutable exact-item budget used while constructing the detached projection.
 */
type PlanningJoinDetachBudget = {
  /** Exact number of raw items detached so far. */
  rows: number
  /** Exact canonical UTF-8 item bytes detached so far. */
  canonicalItemBytes: number
  /** Caller-selected resource ceilings. */
  readonly limits: WorkspaceSearchMigrationPlanningJoinLimits
}

/**
 * Incremental traversal budget for one caller-owned DynamoDB item or cursor.
 */
type PlanningJoinAttributeCloneBudget = {
  /** Number of AttributeValue and set-member nodes projected so far. */
  nodes: number
  /** UTF-8 string/name bytes and raw binary bytes observed so far. */
  bytes: number
}

/**
 * Incremental scalar budget while projecting one evidence page.
 */
type PlanningJoinEvidenceCloneBudget = {
  /** UTF-8 bytes of every projected primitive string. */
  bytes: number
  /** Maximum canonical evidence bytes accepted by the strict codec. */
  readonly maximumBytes: number
}

/**
 * Fixed source or target role represented by one planning evidence chain.
 */
export type WorkspaceSearchMigrationPlanningEvidenceChainRole =
  | WorkspaceSearchMigrationSourceName
  | 'workspace-search'

/**
 * Terminal evidence and checkpoint root for one complete planning chain.
 */
export type WorkspaceSearchMigrationPlanningEvidenceChainRoot = {
  /** Fixed source or target chain role. */
  readonly chain: WorkspaceSearchMigrationPlanningEvidenceChainRole
  /** Exact number of pages committed to the terminal chain. */
  readonly pageCount: number
  /** Digest of the terminal evidence page and its recursive predecessors. */
  readonly terminalEvidenceDigest: string
  /** Digest of the exact terminal restricted checkpoint. */
  readonly terminalCheckpointDigest: string
}

/**
 * One page's exact authority tuple in a chain-ordered provenance trace.
 */
export type WorkspaceSearchMigrationPlanningAuthorityTraceEntry = {
  /** Fixed source or target chain role. */
  readonly chain: WorkspaceSearchMigrationPlanningEvidenceChainRole
  /** One-based position of the page in its evidence chain. */
  readonly pageSequence: number
  /** Digest of the exact evidence page containing this authority. */
  readonly evidenceDigest: string
  /** Lease owner that authorized the page commit. */
  readonly ownerId: string
  /** Monotonic global lease fencing token. */
  readonly fenceToken: number
  /** Monotonic current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the immutable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
}

/**
 * One globally unique authority transition selected by pointer revision.
 */
export type WorkspaceSearchMigrationPlanningAuthorityTransition = {
  /** Lease owner selected by this pointer revision. */
  readonly ownerId: string
  /** Global lease fencing token selected by this pointer revision. */
  readonly fenceToken: number
  /** Unique current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the immutable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
}

/**
 * Canonical roots and monotonic authority history for all five chains.
 */
export type WorkspaceSearchMigrationPlanningAuthorityProvenance = {
  /** Canonical provenance document discriminator. */
  readonly kind: 'workspace-search-planning-authority-provenance'
  /** Canonical provenance schema version. */
  readonly provenanceVersion: 1
  /** Operator-selected run shared by every chain and receipt binding. */
  readonly runId: string
  /** Reviewed measured-configuration digest shared by every chain. */
  readonly configurationHash: string
  /** Immutable migration-state TableId owning every authority row. */
  readonly stateTableId: string
  /** Five terminal chain roots in fixed source-then-target order. */
  readonly chainRoots:
    readonly WorkspaceSearchMigrationPlanningEvidenceChainRoot[]
  /** Page authority entries in fixed chain and page order. */
  readonly authorityTrace:
    readonly WorkspaceSearchMigrationPlanningAuthorityTraceEntry[]
  /** Deduplicated authority tuples ordered by pointer revision. */
  readonly authorityTransitions:
    readonly WorkspaceSearchMigrationPlanningAuthorityTransition[]
  /** Digest of every preceding canonical provenance field. */
  readonly provenanceDigest: string
}

/**
 * Complete raw planning material and reviewed identity required by the join.
 */
export type CreateWorkspaceSearchMigrationPlanningJoinInput = {
  /** Operator-selected run identifier shared by all five evidence chains. */
  readonly runId: string
  /** Complete measured configuration owning every raw page. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Explicit bounded-process resource limits. */
  readonly limits: WorkspaceSearchMigrationPlanningJoinLimits
  /** Exact page material for each of the four fixed source tables. */
  readonly sourcePages: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      readonly WorkspaceSearchMigrationPlanningSourcePageMaterial[]
    >
  >
  /** Exact page material for the Workspace Search target table. */
  readonly targetPages:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[]
}

/**
 * Fully revalidated source-target planning input ready for plan sealing.
 */
export type WorkspaceSearchMigrationPlanningJoinResult = {
  /** Exact terminal progress reconstructed for every source evidence chain. */
  readonly sourceProgress: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >
  /** Exact terminal progress reconstructed for the target evidence chain. */
  readonly targetProgress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Canonical five-chain roots and monotonic authority provenance. */
  readonly planningAuthorityProvenance:
    WorkspaceSearchMigrationPlanningAuthorityProvenance
  /** Complete source and joined target planning aggregates. */
  readonly scanSnapshot: WorkspaceSearchMigrationScanSnapshot
  /** Exact row, binding, expected, observed, and orphan ownership evidence. */
  readonly targetOwnershipEvidence:
    WorkspaceSearchMigrationTargetOwnershipEvidence
  /** Complete deterministic candidate set ordered by target-key digest. */
  readonly candidates: readonly WorkspaceSearchMigrationPlanCandidate[]
}

/**
 * Revalidated material for one complete source evidence chain.
 */
type VerifiedSourceChain = {
  /** Exact terminal chain head. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Every mapped or ignored digest-only source row. */
  readonly sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[]
  /** Every exact mapped-source ownership binding. */
  readonly sourceBindings:
    readonly WorkspaceSearchMigrationSourceOwnershipBinding[]
  /** Every exact raw source item in evidence-page order. */
  readonly items: readonly DynamoAttributeMap[]
}

/**
 * Revalidated material for the complete target evidence chain.
 */
type VerifiedTargetChain = {
  /** Exact terminal target chain head. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Every owned or ignored digest-only target row. */
  readonly targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[]
  /** Every exact migration-owned target binding. */
  readonly observedTargetBindings:
    readonly WorkspaceSearchMigrationObservedTargetBinding[]
  /** Exact raw target items indexed by physical target-key digest. */
  readonly itemsByTargetKeyDigest: ReadonlyMap<string, DynamoAttributeMap>
}

/**
 * Joins complete lossless source and target planning evidence into candidates.
 *
 * Every page is reduced again from the canonical initial checkpoint, recreated
 * as exact evidence, compared byte-for-byte, and independently replayed before
 * any source-to-target ownership decision is made.
 *
 * @param input - Reviewed identity, bounded limits, and all five raw chains.
 * @returns Detached complete scan evidence and deterministically ordered candidates.
 */
export function joinWorkspaceSearchMigrationPlanningEvidence(
  input: CreateWorkspaceSearchMigrationPlanningJoinInput,
): WorkspaceSearchMigrationPlanningJoinResult {
  const detachedInput = detachPlanningJoinInput(input)
  return runPlanningJoinBoundary(
    () => joinPlanningEvidenceUnchecked(detachedInput),
  )
}

/**
 * Detaches one measured configuration through the planning boundary's strict,
 * bounded descriptor projection.
 *
 * @param configuration - Caller-owned measured configuration.
 * @returns Detached recognized configuration fields.
 */
export function detachWorkspaceSearchMigrationPlanningConfiguration(
  configuration: unknown,
): WorkspaceSearchMigrationConfiguration {
  try {
    return clonePlanningJoinConfiguration(configuration)
  } catch (error: unknown) {
    const code = readPlanningJoinDetachFailureCode(error)
    return throwPlanningJoinBoundaryFailure(code ?? 'INVALID_STATE')
  }
}

/**
 * Applies cheap material-envelope bounds before cloning caller-owned input.
 *
 * The raw boundary deliberately preserves no caller-thrown failure code. This
 * prevents hostile getters from forging an operator-visible migration state.
 *
 * @param input - Caller-owned planning material.
 * @returns Detached bounded input.
 */
function detachPlanningJoinInput(
  input: CreateWorkspaceSearchMigrationPlanningJoinInput,
): CreateWorkspaceSearchMigrationPlanningJoinInput {
  try {
    const envelope = capturePlanningJoinEnvelope(input)
    const limits = envelope.limits
    const budget: PlanningJoinDetachBudget = {
      rows: 0,
      canonicalItemBytes: 0,
      limits,
    }
    return {
      runId: envelope.runId,
      configuration: envelope.configuration,
      configurationHash: envelope.configurationHash,
      limits,
      sourcePages: {
        'project-directory': clonePlanningSourceMaterials(
          envelope.sourcePages['project-directory'],
          budget,
        ),
        'work-items': clonePlanningSourceMaterials(
          envelope.sourcePages['work-items'],
          budget,
        ),
        collaboration: clonePlanningSourceMaterials(
          envelope.sourcePages.collaboration,
          budget,
        ),
        documents: clonePlanningSourceMaterials(
          envelope.sourcePages.documents,
          budget,
        ),
      },
      targetPages: clonePlanningTargetMaterials(
        envelope.targetPages,
        budget,
      ),
    }
  } catch (error: unknown) {
    const code = readPlanningJoinDetachFailureCode(error)
    return throwPlanningJoinBoundaryFailure(code ?? 'INVALID_STATE')
  }
}

/**
 * Reads a private detach code without trusting a hostile thrown proxy.
 *
 * @param error - Arbitrary value thrown while inspecting caller material.
 * @returns Trusted private code or undefined.
 */
function readPlanningJoinDetachFailureCode(
  error: unknown,
): PlanningJoinDetachFailureCode | undefined {
  try {
    return error instanceof PlanningJoinDetachFailure
      ? error.code
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Captures and bounds the complete envelope through own data descriptors.
 *
 * A valid chain can contain at most one empty terminal page, so all five
 * chains together cannot contain more than `maxTotalRows + 5` pages. The
 * durable adapter's 10,000-page ceiling remains an independent hard cap.
 *
 * @param input - Caller-owned material envelope.
 * @returns Bounded envelope with every configuration scalar detached.
 */
function capturePlanningJoinEnvelope(
  input: CreateWorkspaceSearchMigrationPlanningJoinInput,
): PlanningJoinCapturedEnvelope {
  requireExactOwnEnumerableKeys(input, [
    'configuration',
    'configurationHash',
    'limits',
    'runId',
    'sourcePages',
    'targetPages',
  ])
  const runId = requirePrimitiveString(
    readOwnDataProperty(input, 'runId'),
  )
  const configuration = clonePlanningJoinConfiguration(
    readOwnDataProperty(input, 'configuration'),
  )
  const configurationHash = requirePrimitiveString(
    readOwnDataProperty(input, 'configurationHash'),
  )
  const limits = clonePlanningJoinLimits(
    readOwnDataProperty(input, 'limits'),
  )
  const sourcePages = readOwnDataProperty(input, 'sourcePages')
  requireExactOwnEnumerableKeys(
    sourcePages,
    workspaceSearchMigrationSourceNames,
  )
  const counts: PlanningJoinEnvelopeCounts = {
    pages: 0,
    rows: 0,
  }
  const capturedSourcePages = {
    'project-directory': captureBoundedMaterialArray(
      readOwnDataProperty(sourcePages, 'project-directory'),
      counts,
      limits,
    ),
    'work-items': captureBoundedMaterialArray(
      readOwnDataProperty(sourcePages, 'work-items'),
      counts,
      limits,
    ),
    collaboration: captureBoundedMaterialArray(
      readOwnDataProperty(sourcePages, 'collaboration'),
      counts,
      limits,
    ),
    documents: captureBoundedMaterialArray(
      readOwnDataProperty(sourcePages, 'documents'),
      counts,
      limits,
    ),
  }
  const capturedTargetPages = captureBoundedMaterialArray(
    readOwnDataProperty(input, 'targetPages'),
    counts,
    limits,
  )
  return {
    runId,
    configuration,
    configurationHash,
    limits,
    sourcePages: capturedSourcePages,
    targetPages: capturedTargetPages,
  }
}

/**
 * Captures one bounded material array without invoking caller accessors.
 *
 * Exact material descriptors are retained so the caller-owned chain can be
 * rechecked immediately before deep detachment.
 *
 * @param value - Candidate source or target material array.
 * @param counts - Shared page and raw-row counters.
 * @param limits - Caller-selected aggregate row and byte ceilings.
 * @returns Captured material array and exact descriptor values.
 */
function captureBoundedMaterialArray(
  value: unknown,
  counts: PlanningJoinEnvelopeCounts,
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): PlanningJoinCapturedChain {
  const array = captureDenseArray(
    value,
    planningJoinMaximumPagesPerChain,
  )
  if (array.values.length === 0) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  counts.pages = addSafeCount(counts.pages, array.values.length)
  requirePlanningJoinEnvelopeCounts(counts, limits)
  const materials: PlanningJoinCapturedMaterial[] = []
  for (const materialValue of array.values) {
    const material = requireObjectRecord(materialValue)
    requireExactOwnEnumerableKeys(material, ['items', 'page'])
    const page = readOwnDataProperty(material, 'page')
    const items = readOwnDataProperty(material, 'items')
    if (!isNonNullObject(page)) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    const capturedItems = captureDenseArray(
      items,
      WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
      false,
    )
    counts.rows = addSafeCount(
      counts.rows,
      capturedItems.values.length,
    )
    requirePlanningJoinEnvelopeCounts(counts, limits)
    materials.push({
      owner: material,
      page,
      items,
      rowCount: capturedItems.values.length,
    })
  }
  return { array, materials }
}

/**
 * Applies aggregate page and row ceilings immediately after each increment.
 *
 * @param counts - Current captured page and row counts.
 * @param limits - Caller-selected aggregate resource ceilings.
 */
function requirePlanningJoinEnvelopeCounts(
  counts: PlanningJoinEnvelopeCounts,
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): void {
  const rowBoundedPageCount =
    limits.maxTotalRows >
        Number.MAX_SAFE_INTEGER - planningJoinRequiredChainCount
      ? Number.MAX_SAFE_INTEGER
      : limits.maxTotalRows + planningJoinRequiredChainCount
  if (
    counts.rows > limits.maxTotalRows ||
    counts.pages > rowBoundedPageCount ||
    counts.pages >
      planningJoinMaximumPagesPerChain * planningJoinRequiredChainCount
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
}

/**
 * Rejects missing or extra enumerable fields without reading their values.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Complete recognized enumerable property names.
 */
function requireExactOwnEnumerableKeys(
  value: unknown,
  expectedKeys: readonly string[],
): void {
  if (!isNonNullObject(value)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    )
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
}

/**
 * Reads one enumerable own data property without invoking an accessor.
 *
 * @param value - Candidate owning object.
 * @param property - Required property name.
 * @returns Exact own data-property value.
 */
function readOwnDataProperty(
  value: unknown,
  property: string,
): unknown {
  if (!isNonNullObject(value)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return descriptor.value
}

/**
 * Requires a non-null non-array record without coercing the candidate.
 *
 * @param value - Candidate record.
 * @returns Exact caller-owned record object.
 */
function requireObjectRecord(value: unknown): object {
  if (
    !isNonNullObject(value) ||
    Array.isArray(value) ||
    !isPlainRecordPrototype(value)
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires the ordinary object or null prototype used by data records.
 *
 * @param value - Non-null non-proxy object.
 * @returns Whether the object has no caller-controlled prototype behavior.
 */
function isPlainRecordPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Captures one canonical dense array through bounded own descriptors.
 *
 * @param value - Candidate array.
 * @param maximumLength - Maximum number of accepted elements.
 * @param requireNonempty - Whether an empty array is rejected.
 * @returns Caller array identity and exact captured index values.
 */
function captureDenseArray(
  value: unknown,
  maximumLength: number,
  requireNonempty = true,
): PlanningJoinCapturedArray {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const lengthValue = lengthDescriptor?.value
  if (
    typeof lengthValue !== 'number' ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 ||
    lengthValue > maximumLength ||
    requireNonempty && lengthValue === 0
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== lengthValue + 1 ||
    keys[lengthValue] !== 'length'
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const values: unknown[] = []
  for (let index = 0; index < lengthValue; index += 1) {
    if (keys[index] !== String(index)) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    )
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    values.push(descriptor.value)
  }
  return { owner: value, values }
}

/**
 * Rechecks one caller-owned material chain immediately before detachment.
 *
 * @param captured - Previously captured material chain.
 * @returns Fresh descriptor-captured material records.
 */
function recaptureMaterialChain(
  captured: PlanningJoinCapturedChain,
): readonly PlanningJoinCapturedMaterial[] {
  const array = captureDenseArray(
    captured.array.owner,
    planningJoinMaximumPagesPerChain,
  )
  if (array.values.length !== captured.materials.length) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const materials: PlanningJoinCapturedMaterial[] = []
  for (let index = 0; index < array.values.length; index += 1) {
    const material = requireObjectRecord(array.values[index])
    const previous = captured.materials[index]
    if (previous === undefined || material !== previous.owner) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    requireExactOwnEnumerableKeys(material, ['items', 'page'])
    const page = readOwnDataProperty(material, 'page')
    const items = readOwnDataProperty(material, 'items')
    if (page !== previous.page || items !== previous.items) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    const itemArray = captureDenseArray(
      items,
      WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
      false,
    )
    if (itemArray.values.length !== previous.rowCount) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    materials.push({
      owner: material,
      page,
      items,
      rowCount: itemArray.values.length,
    })
  }
  return materials
}

/**
 * Narrows one value to a non-null object.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value can own data properties.
 */
function isNonNullObject(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !nodeUtilTypes.isProxy(value)
  )
}

/**
 * Narrows one runtime value to a positive safe integer.
 *
 * @param value - Candidate bounded counter.
 * @returns Whether the value is a positive safe integer.
 */
function isPositiveSafeIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && isPositiveSafeInteger(value)
}

/**
 * Copies one primitive string without invoking coercion hooks.
 *
 * @param value - Candidate scalar.
 * @returns Exact primitive string.
 */
function requirePrimitiveString(value: unknown): string {
  if (typeof value !== 'string') {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Copies only the three recognized scalar join limits.
 *
 * @param limits - Caller-owned resource ceilings.
 * @returns Detached exact limit record.
 */
function clonePlanningJoinLimits(
  limits: unknown,
): WorkspaceSearchMigrationPlanningJoinLimits {
  requireExactOwnEnumerableKeys(limits, [
    'maxPlanOperations',
    'maxTotalCanonicalItemBytes',
    'maxTotalRows',
  ])
  const maxTotalRows = readOwnDataProperty(limits, 'maxTotalRows')
  const maxTotalCanonicalItemBytes = readOwnDataProperty(
    limits,
    'maxTotalCanonicalItemBytes',
  )
  const maxPlanOperations = readOwnDataProperty(
    limits,
    'maxPlanOperations',
  )
  if (
    !isPositiveSafeIntegerValue(maxTotalRows) ||
    !isPositiveSafeIntegerValue(maxTotalCanonicalItemBytes) ||
    !isPositiveSafeIntegerValue(maxPlanOperations)
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return {
    maxTotalRows,
    maxTotalCanonicalItemBytes,
    maxPlanOperations,
  }
}

/**
 * Projects one measured configuration without cloning unrecognized fields.
 *
 * @param configuration - Caller-owned measured configuration.
 * @returns Detached recognized configuration fields.
 */
function clonePlanningJoinConfiguration(
  configuration: unknown,
): WorkspaceSearchMigrationConfiguration {
  requireExactOwnEnumerableKeys(configuration, [
    'account',
    'callerArn',
    'callerRoleId',
    'commit',
    'journal',
    'journalPrefix',
    'migrationId',
    'migrationVersion',
    'profile',
    'region',
    'tables',
  ])
  const migrationId = readOwnDataProperty(configuration, 'migrationId')
  const migrationVersion = readOwnDataProperty(
    configuration,
    'migrationVersion',
  )
  const journalPrefix = readOwnDataProperty(
    configuration,
    'journalPrefix',
  )
  if (
    migrationId !== 'workspace-search-maintenance' ||
    migrationVersion !== 1 ||
    journalPrefix !== 'workspace-search/v1'
  ) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  const tables = readOwnDataProperty(configuration, 'tables')
  requireExactOwnEnumerableKeys(tables, [
    'collaboration',
    'documents',
    'migration-state',
    'project-directory',
    'work-items',
    'workspace-search',
  ])
  return {
    migrationId,
    migrationVersion,
    account: requirePrimitiveString(
      readOwnDataProperty(configuration, 'account'),
    ),
    region: requirePrimitiveString(
      readOwnDataProperty(configuration, 'region'),
    ),
    profile: requirePrimitiveString(
      readOwnDataProperty(configuration, 'profile'),
    ),
    commit: requirePrimitiveString(
      readOwnDataProperty(configuration, 'commit'),
    ),
    callerArn: requirePrimitiveString(
      readOwnDataProperty(configuration, 'callerArn'),
    ),
    callerRoleId: requirePrimitiveString(
      readOwnDataProperty(configuration, 'callerRoleId'),
    ),
    tables: {
      'project-directory': clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'project-directory'),
        'project-directory',
      ),
      'work-items': clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'work-items'),
        'work-items',
      ),
      collaboration: clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'collaboration'),
        'collaboration',
      ),
      documents: clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'documents'),
        'documents',
      ),
      'workspace-search': clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'workspace-search'),
        'workspace-search',
      ),
      'migration-state': clonePlanningJoinTableIdentity(
        readOwnDataProperty(tables, 'migration-state'),
        'migration-state',
      ),
    },
    journal: clonePlanningJoinJournalIdentity(
      readOwnDataProperty(configuration, 'journal'),
    ),
    journalPrefix,
  }
}

/**
 * Projects one measured table identity with bounded descriptor arrays.
 *
 * @param table - Caller-owned measured table identity.
 * @param expectedRole - Exact configuration slot owning the identity.
 * @returns Detached recognized table identity.
 */
function clonePlanningJoinTableIdentity(
  table: unknown,
  expectedRole: MigrationTableIdentity['role'],
): MigrationTableIdentity {
  requireExactOwnEnumerableKeys(table, [
    'account',
    'billingMode',
    'creationTime',
    'deletionProtection',
    'encryption',
    'globalSecondaryIndexes',
    'key',
    'kmsKeyDigest',
    'pitr',
    'region',
    'role',
    'tableArn',
    'tableId',
    'tableName',
    'ttl',
  ])
  if (readOwnDataProperty(table, 'role') !== expectedRole) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  const keyValues = captureDenseArray(
    readOwnDataProperty(table, 'key'),
    2,
  ).values
  const globalSecondaryIndexValues = captureDenseArray(
    readOwnDataProperty(table, 'globalSecondaryIndexes'),
    20,
    false,
  ).values
  const deletionProtection = readOwnDataProperty(
    table,
    'deletionProtection',
  )
  const kmsKeyDigestValue = readOwnDataProperty(table, 'kmsKeyDigest')
  if (
    typeof deletionProtection !== 'boolean' ||
    kmsKeyDigestValue !== null &&
      typeof kmsKeyDigestValue !== 'string'
  ) {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  const billingMode = readOwnDataProperty(table, 'billingMode')
  const encryption = readOwnDataProperty(table, 'encryption')
  if (
    billingMode !== 'PAY_PER_REQUEST' ||
    encryption !== 'AWS_OWNED' && encryption !== 'KMS'
  ) {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  return {
    role: expectedRole,
    tableName: requirePrimitiveString(
      readOwnDataProperty(table, 'tableName'),
    ),
    tableArn: requirePrimitiveString(
      readOwnDataProperty(table, 'tableArn'),
    ),
    tableId: requirePrimitiveString(
      readOwnDataProperty(table, 'tableId'),
    ),
    creationTime: requirePrimitiveString(
      readOwnDataProperty(table, 'creationTime'),
    ),
    account: requirePrimitiveString(
      readOwnDataProperty(table, 'account'),
    ),
    region: requirePrimitiveString(
      readOwnDataProperty(table, 'region'),
    ),
    key: keyValues.map(clonePlanningJoinKeyAttribute),
    globalSecondaryIndexes:
      globalSecondaryIndexValues.map(
        clonePlanningJoinGlobalSecondaryIndex,
      ),
    billingMode,
    deletionProtection,
    encryption,
    kmsKeyDigest: kmsKeyDigestValue,
    ttl: clonePlanningJoinTimeToLive(
      readOwnDataProperty(table, 'ttl'),
    ),
    pitr: clonePlanningJoinPointInTimeRecovery(
      readOwnDataProperty(table, 'pitr'),
    ),
  }
}

/**
 * Projects one base-table or index key descriptor.
 *
 * @param descriptor - Caller-owned key descriptor.
 * @returns Detached recognized descriptor fields.
 */
function clonePlanningJoinKeyAttribute(
  descriptor: unknown,
): MigrationKeyAttribute {
  requireExactOwnEnumerableKeys(descriptor, ['name', 'role', 'type'])
  const role = readOwnDataProperty(descriptor, 'role')
  const type = readOwnDataProperty(descriptor, 'type')
  if (
    role !== 'HASH' && role !== 'RANGE' ||
    type !== 'B' && type !== 'N' && type !== 'S'
  ) {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  return {
    name: requirePrimitiveString(
      readOwnDataProperty(descriptor, 'name'),
    ),
    role,
    type,
  }
}

/**
 * Projects one bounded measured global secondary index.
 *
 * @param index - Caller-owned index descriptor.
 * @returns Detached recognized index fields.
 */
function clonePlanningJoinGlobalSecondaryIndex(
  index: unknown,
): MigrationGlobalSecondaryIndex {
  requireExactOwnEnumerableKeys(index, [
    'key',
    'name',
    'nonKeyAttributes',
    'projection',
    'status',
  ])
  const keyValues = captureDenseArray(
    readOwnDataProperty(index, 'key'),
    2,
  ).values
  const nonKeyAttributeValues = captureDenseArray(
    readOwnDataProperty(index, 'nonKeyAttributes'),
    100,
    false,
  ).values
  const projection = readOwnDataProperty(index, 'projection')
  const status = readOwnDataProperty(index, 'status')
  if (
    projection !== 'ALL' &&
      projection !== 'INCLUDE' &&
      projection !== 'KEYS_ONLY' ||
    status !== 'ACTIVE'
  ) {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  return {
    name: requirePrimitiveString(
      readOwnDataProperty(index, 'name'),
    ),
    key: keyValues.map(clonePlanningJoinKeyAttribute),
    projection,
    nonKeyAttributes:
      nonKeyAttributeValues.map(requirePrimitiveString),
    status,
  }
}

/**
 * Projects one exact measured time-to-live configuration.
 *
 * @param value - Caller-owned TTL record.
 * @returns Detached supported TTL shape.
 */
function clonePlanningJoinTimeToLive(
  value: unknown,
): MigrationTableIdentity['ttl'] {
  const record = requireObjectRecord(value)
  const keys = Object.keys(record)
  const hasAttribute = keys.includes('attribute')
  requireExactOwnEnumerableKeys(
    record,
    hasAttribute ? ['attribute', 'status'] : ['status'],
  )
  const status = readOwnDataProperty(record, 'status')
  if (status !== 'DISABLED' && status !== 'ENABLED') {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  if (!hasAttribute) return { status }
  return {
    status,
    attribute: requirePrimitiveString(
      readOwnDataProperty(record, 'attribute'),
    ),
  }
}

/**
 * Projects one exact measured point-in-time recovery record.
 *
 * @param value - Caller-owned PITR record.
 * @returns Detached enabled PITR evidence.
 */
function clonePlanningJoinPointInTimeRecovery(
  value: unknown,
): MigrationTableIdentity['pitr'] {
  requireExactOwnEnumerableKeys(value, [
    'earliestRestorableTime',
    'latestRestorableTime',
    'status',
  ])
  if (readOwnDataProperty(value, 'status') !== 'ENABLED') {
    return failPlanningJoinDetach('TABLE_SCHEMA_MISMATCH')
  }
  return {
    status: 'ENABLED',
    earliestRestorableTime: requirePrimitiveString(
      readOwnDataProperty(value, 'earliestRestorableTime'),
    ),
    latestRestorableTime: requirePrimitiveString(
      readOwnDataProperty(value, 'latestRestorableTime'),
    ),
  }
}

/**
 * Projects the recognized immutable journal identity fields.
 *
 * @param journal - Caller-owned journal identity.
 * @returns Detached recognized journal identity.
 */
function clonePlanningJoinJournalIdentity(
  journal: unknown,
): MigrationJournalIdentity {
  requireExactOwnEnumerableKeys(journal, [
    'accessLogBucket',
    'accessLogPrefix',
    'bucketKeyEnabled',
    'bucketName',
    'defaultRetentionDays',
    'encryption',
    'keyArn',
    'keyCreationTime',
    'keyManager',
    'keyMultiRegion',
    'keyOrigin',
    'keySpec',
    'keyState',
    'keyUsage',
    'objectLockMode',
    'versioning',
  ])
  const keyManager = readOwnDataProperty(journal, 'keyManager')
  const keyState = readOwnDataProperty(journal, 'keyState')
  const keySpec = readOwnDataProperty(journal, 'keySpec')
  const keyUsage = readOwnDataProperty(journal, 'keyUsage')
  const keyOrigin = readOwnDataProperty(journal, 'keyOrigin')
  const keyMultiRegion = readOwnDataProperty(
    journal,
    'keyMultiRegion',
  )
  const versioning = readOwnDataProperty(journal, 'versioning')
  const objectLockMode = readOwnDataProperty(
    journal,
    'objectLockMode',
  )
  const defaultRetentionDays = readOwnDataProperty(
    journal,
    'defaultRetentionDays',
  )
  const encryption = readOwnDataProperty(journal, 'encryption')
  const bucketKeyEnabled = readOwnDataProperty(
    journal,
    'bucketKeyEnabled',
  )
  if (
    keyManager !== 'CUSTOMER' ||
    keyState !== 'Enabled' ||
    keySpec !== 'SYMMETRIC_DEFAULT' ||
    keyUsage !== 'ENCRYPT_DECRYPT' ||
    keyOrigin !== 'AWS_KMS' ||
    keyMultiRegion !== false ||
    versioning !== 'Enabled' ||
    objectLockMode !== 'COMPLIANCE' ||
    !isPositiveSafeIntegerValue(defaultRetentionDays) ||
    encryption !== 'aws:kms' ||
    bucketKeyEnabled !== true
  ) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  return {
    bucketName: requirePrimitiveString(
      readOwnDataProperty(journal, 'bucketName'),
    ),
    keyArn: requirePrimitiveString(
      readOwnDataProperty(journal, 'keyArn'),
    ),
    keyCreationTime: requirePrimitiveString(
      readOwnDataProperty(journal, 'keyCreationTime'),
    ),
    keyManager,
    keyState,
    keySpec,
    keyUsage,
    keyOrigin,
    keyMultiRegion,
    versioning,
    objectLockMode,
    defaultRetentionDays,
    encryption,
    bucketKeyEnabled,
    accessLogBucket: requirePrimitiveString(
      readOwnDataProperty(journal, 'accessLogBucket'),
    ),
    accessLogPrefix: requirePrimitiveString(
      readOwnDataProperty(journal, 'accessLogPrefix'),
    ),
  }
}

/**
 * Narrows a source page candidate enough for its strict canonical codec.
 *
 * The codec performs the complete nested validation; this guard only avoids a
 * TypeScript assertion while requiring the immutable schema discriminators to
 * be own data properties.
 *
 * @param value - Candidate source evidence page.
 * @returns Whether the strict source evidence codec may inspect the value.
 */
function isWorkspaceSearchMigrationSourceEvidencePage(
  value: unknown,
): value is WorkspaceSearchMigrationSourceEvidencePage {
  if (!isNonNullObject(value) || Array.isArray(value)) return false
  return readOwnDataProperty(value, 'kind') ===
      'workspace-search-source-evidence-page' &&
    readOwnDataProperty(value, 'migrationId') ===
      'workspace-search-maintenance' &&
    readOwnDataProperty(value, 'migrationVersion') === 1
}

/**
 * Narrows a target page candidate enough for its strict canonical codec.
 *
 * @param value - Candidate target evidence page.
 * @returns Whether the strict target evidence codec may inspect the value.
 */
function isWorkspaceSearchMigrationTargetEvidencePage(
  value: unknown,
): value is WorkspaceSearchMigrationTargetEvidencePage {
  if (!isNonNullObject(value) || Array.isArray(value)) return false
  return readOwnDataProperty(value, 'kind') ===
      'workspace-search-target-evidence-page' &&
    readOwnDataProperty(value, 'migrationId') ===
      'workspace-search-maintenance' &&
    readOwnDataProperty(value, 'migrationVersion') === 1
}

/**
 * Projects one planning-v3 source page before its strict codec runs.
 *
 * @param value - Caller-owned source evidence candidate.
 * @returns Plain bounded evidence-schema object.
 */
function projectPlanningSourceEvidencePage(value: unknown): unknown {
  requireExactOwnEnumerableKeys(value, [
    'checkpoint',
    'configurationHash',
    'evidenceVersion',
    'invalidRows',
    'kind',
    'migrationId',
    'migrationVersion',
    'pageSequence',
    'planningAuthority',
    'previousCheckpointDigest',
    'previousEvidenceDigest',
    'purpose',
    'runId',
    'source',
    'sourceArtifacts',
    'sourceBindings',
    'sourceRows',
    'sourceTableId',
    'stateTableId',
  ])
  const budget = createPlanningEvidenceCloneBudget(
    WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES,
  )
  const evidenceVersion = readOwnDataProperty(value, 'evidenceVersion')
  const migrationVersion = readOwnDataProperty(value, 'migrationVersion')
  if (evidenceVersion !== 3 || migrationVersion !== 1) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  return {
    kind: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'kind'),
      budget,
    ),
    evidenceVersion,
    migrationId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'migrationId'),
      budget,
    ),
    migrationVersion,
    purpose: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'purpose'),
      budget,
    ),
    runId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'runId'),
      budget,
    ),
    configurationHash: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'configurationHash'),
      budget,
    ),
    source: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'source'),
      budget,
    ),
    sourceTableId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'sourceTableId'),
      budget,
    ),
    stateTableId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'stateTableId'),
      budget,
    ),
    pageSequence: requirePositiveSafeIntegerScalar(
      readOwnDataProperty(value, 'pageSequence'),
    ),
    previousEvidenceDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'previousEvidenceDigest'),
      budget,
    ),
    previousCheckpointDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'previousCheckpointDigest'),
      budget,
    ),
    checkpoint: clonePlanningSourceEvidenceCheckpoint(
      readOwnDataProperty(value, 'checkpoint'),
      budget,
    ),
    sourceRows: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'sourceRows'),
      ['classification', 'sourceItemDigest', 'sourceKeyDigest'],
      budget,
    ),
    invalidRows: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'invalidRows'),
      [
        'classification',
        'reasonCode',
        'sourceItemDigest',
        'sourceKeyDigest',
      ],
      budget,
    ),
    sourceBindings: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'sourceBindings'),
      [
        'sourceItemDigest',
        'sourceKeyDigest',
        'targetAction',
        'targetKeyDigest',
      ],
      budget,
    ),
    planningAuthority: clonePlanningEvidenceAuthority(
      readOwnDataProperty(value, 'planningAuthority'),
      budget,
    ),
    sourceArtifacts: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'sourceArtifacts'),
      ['contentDigest', 'objectKey', 'versionId'],
      budget,
    ),
  }
}

/**
 * Projects one planning-v1 target page before its strict codec runs.
 *
 * @param value - Caller-owned target evidence candidate.
 * @returns Plain bounded evidence-schema object.
 */
function projectPlanningTargetEvidencePage(value: unknown): unknown {
  requireExactOwnEnumerableKeys(value, [
    'checkpoint',
    'configurationHash',
    'evidenceVersion',
    'invalidRows',
    'kind',
    'migrationId',
    'migrationVersion',
    'observedTargetBindings',
    'pageSequence',
    'planningAuthority',
    'previousCheckpointDigest',
    'previousEvidenceDigest',
    'purpose',
    'runId',
    'stateTableId',
    'targetArtifacts',
    'targetRows',
    'targetTableId',
  ])
  const budget = createPlanningEvidenceCloneBudget(
    WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES,
  )
  const evidenceVersion = readOwnDataProperty(value, 'evidenceVersion')
  const migrationVersion = readOwnDataProperty(value, 'migrationVersion')
  if (evidenceVersion !== 1 || migrationVersion !== 1) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  return {
    kind: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'kind'),
      budget,
    ),
    evidenceVersion,
    migrationId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'migrationId'),
      budget,
    ),
    migrationVersion,
    purpose: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'purpose'),
      budget,
    ),
    runId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'runId'),
      budget,
    ),
    configurationHash: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'configurationHash'),
      budget,
    ),
    targetTableId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'targetTableId'),
      budget,
    ),
    stateTableId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'stateTableId'),
      budget,
    ),
    pageSequence: requirePositiveSafeIntegerScalar(
      readOwnDataProperty(value, 'pageSequence'),
    ),
    previousEvidenceDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'previousEvidenceDigest'),
      budget,
    ),
    previousCheckpointDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'previousCheckpointDigest'),
      budget,
    ),
    checkpoint: clonePlanningTargetEvidenceCheckpoint(
      readOwnDataProperty(value, 'checkpoint'),
      budget,
    ),
    targetRows: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'targetRows'),
      ['classification', 'targetItemDigest', 'targetKeyDigest'],
      budget,
    ),
    invalidRows: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'invalidRows'),
      [
        'classification',
        'reasonCode',
        'targetItemDigest',
        'targetKeyDigest',
      ],
      budget,
    ),
    observedTargetBindings: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'observedTargetBindings'),
      ['targetItemDigest', 'targetKeyDigest'],
      budget,
    ),
    planningAuthority: clonePlanningEvidenceAuthority(
      readOwnDataProperty(value, 'planningAuthority'),
      budget,
    ),
    targetArtifacts: clonePlanningEvidenceStringRecords(
      readOwnDataProperty(value, 'targetArtifacts'),
      ['contentDigest', 'objectKey', 'versionId'],
      budget,
    ),
  }
}

/**
 * Creates one zeroed evidence-page scalar budget.
 *
 * @param maximumBytes - Strict codec's canonical page ceiling.
 * @returns Mutable page projection budget.
 */
function createPlanningEvidenceCloneBudget(
  maximumBytes: number,
): PlanningJoinEvidenceCloneBudget {
  return { bytes: 0, maximumBytes }
}

/**
 * Copies one primitive evidence string under the page-wide byte ceiling.
 *
 * @param value - Candidate page scalar.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Exact immutable primitive string.
 */
function clonePlanningEvidenceString(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): string {
  const text = requirePrimitiveString(value)
  const remaining = budget.maximumBytes - budget.bytes
  if (text.length > remaining) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  budget.bytes = addSafeCount(
    budget.bytes,
    Buffer.byteLength(text, 'utf8'),
  )
  if (budget.bytes > budget.maximumBytes) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return text
}

/**
 * Projects one dense bounded array of fixed-shape string records.
 *
 * @param value - Candidate evidence record array.
 * @param keys - Exact recognized string properties for each entry.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached records.
 */
function clonePlanningEvidenceStringRecords(
  value: unknown,
  keys: readonly string[],
  budget: PlanningJoinEvidenceCloneBudget,
): Record<string, string>[] {
  const records = captureDenseArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
    false,
  ).values
  return records.map((candidate) => {
    const record = requireObjectRecord(candidate)
    requireExactOwnEnumerableKeys(record, keys)
    const cloned: Record<string, string> = {}
    for (const key of keys) {
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        value: clonePlanningEvidenceString(
          readOwnDataProperty(record, key),
          budget,
        ),
        writable: true,
      })
    }
    return cloned
  })
}

/**
 * Projects one exact page authority tuple.
 *
 * @param value - Caller-owned authority binding.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached authority fields.
 */
function clonePlanningEvidenceAuthority(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationPlanningAuthorityBinding {
  requireExactOwnEnumerableKeys(value, [
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'ownerId'),
      budget,
    ),
    fenceToken: requirePositiveSafeIntegerScalar(
      readOwnDataProperty(value, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision:
      requirePositiveSafeIntegerScalar(
        readOwnDataProperty(
          value,
          'maintenanceEvidencePointerRevision',
        ),
      ),
    maintenanceEvidenceReceiptDigest:
      clonePlanningEvidenceString(
        readOwnDataProperty(
          value,
          'maintenanceEvidenceReceiptDigest',
        ),
        budget,
      ),
  }
}

/**
 * Projects one source checkpoint and optional restricted cursor.
 *
 * @param value - Caller-owned source checkpoint.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached checkpoint.
 */
function clonePlanningSourceEvidenceCheckpoint(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationSourceEvidencePage['checkpoint'] {
  const record = requireObjectRecord(value)
  const hasCursor = Object.prototype.hasOwnProperty.call(record, 'cursor')
  requireExactOwnEnumerableKeys(
    record,
    hasCursor
      ? [
          'aggregate',
          'completed',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'contentDigestState',
          'keyDigestState',
        ],
  )
  const checkpoint = {
    completed: requirePrimitiveBoolean(
      readOwnDataProperty(record, 'completed'),
    ),
    aggregate: clonePlanningSourceEvidenceAggregate(
      readOwnDataProperty(record, 'aggregate'),
      budget,
    ),
    keyDigestState: clonePlanningEvidenceDigestState(
      readOwnDataProperty(record, 'keyDigestState'),
      budget,
    ),
    contentDigestState: clonePlanningEvidenceDigestState(
      readOwnDataProperty(record, 'contentDigestState'),
      budget,
    ),
  }
  if (!hasCursor) return checkpoint
  return {
    ...checkpoint,
    cursor: clonePlanningEvidenceCursor(
      readOwnDataProperty(record, 'cursor'),
    ),
  }
}

/**
 * Projects one target checkpoint and optional restricted cursor.
 *
 * @param value - Caller-owned target checkpoint.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached checkpoint.
 */
function clonePlanningTargetEvidenceCheckpoint(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationTargetEvidencePage['checkpoint'] {
  const record = requireObjectRecord(value)
  const hasCursor = Object.prototype.hasOwnProperty.call(record, 'cursor')
  requireExactOwnEnumerableKeys(
    record,
    hasCursor
      ? [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'keyDigestState',
        ],
  )
  const checkpoint = {
    configurationHash: clonePlanningEvidenceString(
      readOwnDataProperty(record, 'configurationHash'),
      budget,
    ),
    completed: requirePrimitiveBoolean(
      readOwnDataProperty(record, 'completed'),
    ),
    aggregate: clonePlanningTargetEvidenceAggregate(
      readOwnDataProperty(record, 'aggregate'),
      budget,
    ),
    keyDigestState: clonePlanningEvidenceDigestState(
      readOwnDataProperty(record, 'keyDigestState'),
      budget,
    ),
    contentDigestState: clonePlanningEvidenceDigestState(
      readOwnDataProperty(record, 'contentDigestState'),
      budget,
    ),
  }
  if (!hasCursor) return checkpoint
  return {
    ...checkpoint,
    cursor: clonePlanningEvidenceCursor(
      readOwnDataProperty(record, 'cursor'),
    ),
  }
}

/**
 * Projects and validates one exact restricted checkpoint cursor.
 *
 * @param value - Caller-owned low-level DynamoDB key.
 * @returns Detached canonical-size-valid AttributeValue map.
 */
function clonePlanningEvidenceCursor(value: unknown): DynamoAttributeMap {
  const cursor = clonePlanningRawAttributeMap(
    value,
    createPlanningAttributeCloneBudget(),
    0,
  )
  validateDynamoDbItemSize(cursor)
  return cursor
}

/**
 * Projects one source scan aggregate.
 *
 * @param value - Caller-owned aggregate.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached counters and digests.
 */
function clonePlanningSourceEvidenceAggregate(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationSourceEvidencePage['checkpoint']['aggregate'] {
  requireExactOwnEnumerableKeys(value, [
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
    scanned: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'scanned'),
    ),
    mapped: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'mapped'),
    ),
    ignored: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'ignored'),
    ),
    invalid: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'invalid'),
    ),
    projected: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'projected'),
    ),
    deleted: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'deleted'),
    ),
    keyDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'keyDigest'),
      budget,
    ),
    contentDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'contentDigest'),
      budget,
    ),
    pageCount: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'pageCount'),
    ),
  }
}

/**
 * Projects one target-only scan aggregate.
 *
 * @param value - Caller-owned target aggregate.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached counters and digests.
 */
function clonePlanningTargetEvidenceAggregate(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationTargetEvidencePage['checkpoint']['aggregate'] {
  requireExactOwnEnumerableKeys(value, [
    'contentDigest',
    'ignored',
    'invalid',
    'keyDigest',
    'owned',
    'pageCount',
    'scanned',
  ])
  return {
    scanned: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'scanned'),
    ),
    owned: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'owned'),
    ),
    ignored: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'ignored'),
    ),
    invalid: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'invalid'),
    ),
    keyDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'keyDigest'),
      budget,
    ),
    contentDigest: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'contentDigest'),
      budget,
    ),
    pageCount: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'pageCount'),
    ),
  }
}

/**
 * Projects one order-independent digest accumulator state.
 *
 * @param value - Caller-owned digest state.
 * @param budget - Shared evidence-page scalar budget.
 * @returns Plain detached count, sum, and XOR state.
 */
function clonePlanningEvidenceDigestState(
  value: unknown,
  budget: PlanningJoinEvidenceCloneBudget,
): WorkspaceSearchMigrationSourceEvidencePage['checkpoint']['keyDigestState'] {
  requireExactOwnEnumerableKeys(value, ['count', 'sumHex', 'xorHex'])
  return {
    count: requireNonnegativeSafeIntegerScalar(
      readOwnDataProperty(value, 'count'),
    ),
    sumHex: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'sumHex'),
      budget,
    ),
    xorHex: clonePlanningEvidenceString(
      readOwnDataProperty(value, 'xorHex'),
      budget,
    ),
  }
}

/**
 * Copies one primitive Boolean without coercion.
 *
 * @param value - Candidate Boolean scalar.
 * @returns Exact primitive Boolean.
 */
function requirePrimitiveBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Copies one positive safe integer without coercion.
 *
 * @param value - Candidate positive counter.
 * @returns Exact positive safe integer.
 */
function requirePositiveSafeIntegerScalar(value: unknown): number {
  if (!isPositiveSafeIntegerValue(value)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Copies one nonnegative safe integer without coercion.
 *
 * @param value - Candidate nonnegative counter.
 * @returns Exact nonnegative safe integer.
 */
function requireNonnegativeSafeIntegerScalar(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Strictly clones authoritative source pages and their bounded raw items.
 *
 * @param materials - Caller-owned source page material.
 * @param budget - Shared exact row and byte budget.
 * @returns Detached strict planning-v3 material.
 */
function clonePlanningSourceMaterials(
  captured: PlanningJoinCapturedChain,
  budget: PlanningJoinDetachBudget,
): WorkspaceSearchMigrationPlanningSourcePageMaterial[] {
  const materials = recaptureMaterialChain(captured)
  return materials.map((material) => ({
    page: clonePlanningSourceEvidencePage(material.page),
    items: clonePlanningRawItems(material.items, budget),
  }))
}

/**
 * Strictly round-trips one source page without copying extra properties.
 *
 * @param page - Caller-owned planning source page.
 * @returns Detached strict planning-v3 page.
 */
function clonePlanningSourceEvidencePage(
  page: unknown,
): WorkspaceSearchMigrationPlanningSourcePageMaterial['page'] {
  const projected = projectPlanningSourceEvidencePage(page)
  if (!isWorkspaceSearchMigrationSourceEvidencePage(projected)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const cloned = parseWorkspaceSearchMigrationSourceEvidencePage(
    serializeWorkspaceSearchMigrationSourceEvidencePage(projected),
  )
  if (cloned.purpose !== 'planning' || cloned.evidenceVersion !== 3) {
    return failPlanningJoinDetach('IDENTITY_MISMATCH')
  }
  return cloned
}

/**
 * Strictly clones authoritative target pages and their bounded raw items.
 *
 * @param materials - Caller-owned target page material.
 * @param budget - Shared exact row and byte budget.
 * @returns Detached strict planning-v1 target material.
 */
function clonePlanningTargetMaterials(
  captured: PlanningJoinCapturedChain,
  budget: PlanningJoinDetachBudget,
): WorkspaceSearchMigrationPlanningTargetPageMaterial[] {
  const materials = recaptureMaterialChain(captured)
  return materials.map((material) => ({
    page: clonePlanningTargetEvidencePage(material.page),
    items: clonePlanningRawItems(material.items, budget),
  }))
}

/**
 * Strictly round-trips one target page without copying extra properties.
 *
 * @param page - Caller-owned target page candidate.
 * @returns Detached strict planning-v1 target page.
 */
function clonePlanningTargetEvidencePage(
  page: unknown,
): WorkspaceSearchMigrationTargetEvidencePage {
  const projected = projectPlanningTargetEvidencePage(page)
  if (!isWorkspaceSearchMigrationTargetEvidencePage(projected)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return parseWorkspaceSearchMigrationTargetEvidencePage(
    serializeWorkspaceSearchMigrationTargetEvidencePage(projected),
  )
}

/**
 * Clones raw items one at a time after size and cumulative-budget validation.
 *
 * @param items - Caller-owned exact raw item array.
 * @param budget - Shared exact row and byte budget.
 * @returns Detached strict low-level DynamoDB items.
 */
function clonePlanningRawItems(
  items: unknown,
  budget: PlanningJoinDetachBudget,
): DynamoAttributeMap[] {
  const itemValues = captureDenseArray(
    items,
    WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
    false,
  ).values
  const clonedItems: DynamoAttributeMap[] = []
  for (const item of itemValues) {
    const projectedItem = clonePlanningRawAttributeMap(
      item,
      createPlanningAttributeCloneBudget(),
      0,
    )
    const canonicalItem =
      serializeCanonicalAttributeMap(projectedItem)
    const clonedItem = parseCanonicalAttributeMap(canonicalItem)
    validateDynamoDbItemSize(clonedItem)
    const canonicalItemBytes = Buffer.byteLength(canonicalItem, 'utf8')
    const nextRows = addSafeCount(budget.rows, 1)
    const nextCanonicalItemBytes = addSafeCount(
      budget.canonicalItemBytes,
      canonicalItemBytes,
    )
    if (
      nextRows > budget.limits.maxTotalRows ||
      nextCanonicalItemBytes >
        budget.limits.maxTotalCanonicalItemBytes
    ) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    budget.rows = nextRows
    budget.canonicalItemBytes = nextCanonicalItemBytes
    clonedItems.push(clonedItem)
  }
  return clonedItems
}

/**
 * Creates one empty incremental AttributeValue traversal budget.
 *
 * @returns Mutable zeroed item projection budget.
 */
function createPlanningAttributeCloneBudget():
  PlanningJoinAttributeCloneBudget {
  return { nodes: 0, bytes: 0 }
}

/**
 * Projects one raw AttributeValue map through bounded own data descriptors.
 *
 * @param value - Caller-owned item, nested map, or checkpoint cursor.
 * @param budget - Shared per-item traversal budget.
 * @param depth - Number of enclosing DynamoDB document containers.
 * @returns Plain detached low-level attribute map.
 */
function clonePlanningRawAttributeMap(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
  depth: number,
): DynamoAttributeMap {
  const record = requireObjectRecord(value)
  const names = Object.keys(record)
  if (
    names.length >
      DYNAMODB_MAX_ITEM_SIZE_BYTES - budget.nodes
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const cloned: DynamoAttributeMap = {}
  for (const name of names) {
    if (
      name.length >
        planningJoinMaximumAttributeProjectionBytes - budget.bytes
    ) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    addPlanningAttributeProjectionBytes(
      budget,
      Buffer.byteLength(name, 'utf8'),
    )
    const attribute = clonePlanningRawAttributeValue(
      readOwnDataProperty(record, name),
      budget,
      depth,
    )
    Object.defineProperty(cloned, name, {
      configurable: true,
      enumerable: true,
      value: attribute,
      writable: true,
    })
  }
  return cloned
}

/**
 * Projects one exact low-level AttributeValue without invoking accessors.
 *
 * @param value - Caller-owned AttributeValue candidate.
 * @param budget - Shared per-item traversal budget.
 * @param depth - Number of enclosing DynamoDB document containers.
 * @returns Plain detached AttributeValue.
 */
function clonePlanningRawAttributeValue(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
  depth: number,
): DynamoAttributeMap[string] {
  addPlanningAttributeNode(budget)
  const record = requireObjectRecord(value)
  const tags = Object.keys(record)
  if (tags.length !== 1) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const tag = tags[0]
  if (tag === undefined) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const raw = readOwnDataProperty(record, tag)
  if (tag === 'S') {
    return { S: clonePlanningAttributeString(raw, budget) }
  }
  if (tag === 'N') {
    return { N: clonePlanningAttributeString(raw, budget) }
  }
  if (tag === 'B') {
    return { B: clonePlanningAttributeBinary(raw, budget) }
  }
  if (tag === 'SS') {
    return {
      SS: clonePlanningAttributeStringSet(raw, budget),
    }
  }
  if (tag === 'NS') {
    return {
      NS: clonePlanningAttributeStringSet(raw, budget),
    }
  }
  if (tag === 'BS') {
    return {
      BS: clonePlanningAttributeBinarySet(raw, budget),
    }
  }
  if (tag === 'M') {
    const nestedDepth = requirePlanningAttributeNestedDepth(depth)
    return {
      M: clonePlanningRawAttributeMap(raw, budget, nestedDepth),
    }
  }
  if (tag === 'L') {
    const nestedDepth = requirePlanningAttributeNestedDepth(depth)
    const members = captureDenseArray(
      raw,
      remainingPlanningAttributeNodes(budget),
      false,
    ).values
    return {
      L: members.map((member) =>
        clonePlanningRawAttributeValue(
          member,
          budget,
          nestedDepth,
        )
      ),
    }
  }
  if (tag === 'NULL') {
    if (raw !== true) {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    return { NULL: true }
  }
  if (tag === 'BOOL') {
    if (typeof raw !== 'boolean') {
      return failPlanningJoinDetach('INVALID_ARGUMENT')
    }
    return { BOOL: raw }
  }
  return failPlanningJoinDetach('INVALID_ARGUMENT')
}

/**
 * Copies one primitive AttributeValue string under the item byte budget.
 *
 * @param value - Candidate string scalar or set member.
 * @param budget - Shared per-item traversal budget.
 * @returns Exact immutable primitive string.
 */
function clonePlanningAttributeString(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
): string {
  const text = requirePrimitiveString(value)
  if (
    text.length >
      planningJoinMaximumAttributeProjectionBytes - budget.bytes
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  addPlanningAttributeProjectionBytes(
    budget,
    Buffer.byteLength(text, 'utf8'),
  )
  return text
}

/**
 * Copies one binary AttributeValue under the item byte budget.
 *
 * @param value - Candidate Uint8Array scalar or set member.
 * @param budget - Shared per-item traversal budget.
 * @returns Detached exact byte sequence.
 */
function clonePlanningAttributeBinary(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    planningJoinTypedArrayByteLengthGetter === undefined ||
    planningJoinTypedArrayBufferGetter === undefined
  ) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const buffer = Reflect.apply(
    planningJoinTypedArrayBufferGetter,
    value,
    [],
  )
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  const byteLength = Reflect.apply(
    planningJoinTypedArrayByteLengthGetter,
    value,
    [],
  )
  addPlanningAttributeProjectionBytes(budget, byteLength)
  return new Uint8Array(value)
}

/**
 * Copies one dense nonempty string or number set.
 *
 * @param value - Candidate set-member array.
 * @param budget - Shared per-item traversal budget.
 * @returns Detached member array for strict codec validation.
 */
function clonePlanningAttributeStringSet(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
): string[] {
  const members = captureDenseArray(
    value,
    remainingPlanningAttributeNodes(budget),
  ).values
  return members.map((member) => {
    addPlanningAttributeNode(budget)
    return clonePlanningAttributeString(member, budget)
  })
}

/**
 * Copies one dense nonempty binary set.
 *
 * @param value - Candidate binary-set member array.
 * @param budget - Shared per-item traversal budget.
 * @returns Detached byte sequences for strict codec validation.
 */
function clonePlanningAttributeBinarySet(
  value: unknown,
  budget: PlanningJoinAttributeCloneBudget,
): Uint8Array[] {
  const members = captureDenseArray(
    value,
    remainingPlanningAttributeNodes(budget),
  ).values
  return members.map((member) => {
    addPlanningAttributeNode(budget)
    return clonePlanningAttributeBinary(member, budget)
  })
}

/**
 * Advances and validates one AttributeValue node count.
 *
 * @param budget - Shared per-item traversal budget.
 */
function addPlanningAttributeNode(
  budget: PlanningJoinAttributeCloneBudget,
): void {
  budget.nodes = addSafeCount(budget.nodes, 1)
  if (budget.nodes > DYNAMODB_MAX_ITEM_SIZE_BYTES) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
}

/**
 * Returns the remaining bounded AttributeValue node capacity.
 *
 * @param budget - Shared per-item traversal budget.
 * @returns Nonnegative maximum number of additional nodes.
 */
function remainingPlanningAttributeNodes(
  budget: PlanningJoinAttributeCloneBudget,
): number {
  return DYNAMODB_MAX_ITEM_SIZE_BYTES - budget.nodes
}

/**
 * Advances and validates the scalar bytes inspected before canonicalization.
 *
 * @param budget - Shared per-item traversal budget.
 * @param bytes - Newly observed UTF-8 or raw-binary byte count.
 */
function addPlanningAttributeProjectionBytes(
  budget: PlanningJoinAttributeCloneBudget,
  bytes: number,
): void {
  budget.bytes = addSafeCount(budget.bytes, bytes)
  if (budget.bytes > planningJoinMaximumAttributeProjectionBytes) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
}

/**
 * Advances and validates one DynamoDB document nesting depth.
 *
 * @param depth - Current number of enclosing List or Map containers.
 * @returns Validated nested depth.
 */
function requirePlanningAttributeNestedDepth(depth: number): number {
  const nestedDepth = depth + 1
  if (nestedDepth > planningJoinMaximumAttributeDepth) {
    return failPlanningJoinDetach('INVALID_ARGUMENT')
  }
  return nestedDepth
}

/**
 * Performs one complete join after the public raw-error replacement boundary.
 *
 * @param input - Detached caller input.
 * @returns Complete joined planning evidence.
 */
function joinPlanningEvidenceUnchecked(
  input: CreateWorkspaceSearchMigrationPlanningJoinInput,
): WorkspaceSearchMigrationPlanningJoinResult {
  const runId = requireMigrationIdentifier(input.runId, 'Run ID')
  const configuration = input.configuration
  const configurationHash = input.configurationHash
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failPlanningJoin(
      'CONFIGURATION_HASH_MISMATCH',
      'Measured configuration differs from the reviewed hash.',
    )
  }
  requirePlanningJoinLimits(input.limits)
  requireExactSourcePageRecord(input.sourcePages)
  requireNonemptyPageMaterials(input.sourcePages, input.targetPages)
  const preflightRows = preflightHeadAggregates(
    input.sourcePages,
    input.targetPages,
    input.limits,
  )
  const measuredRows = measureRawMaterial(
    input.sourcePages,
    input.targetPages,
    input.limits,
  )
  if (measuredRows !== preflightRows) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Evidence head row counts differ from exact raw material.',
    )
  }

  const projectDirectory = verifySourceChain(
    runId,
    configuration,
    configurationHash,
    'project-directory',
    input.sourcePages['project-directory'],
  )
  const workItems = verifySourceChain(
    runId,
    configuration,
    configurationHash,
    'work-items',
    input.sourcePages['work-items'],
  )
  const collaboration = verifySourceChain(
    runId,
    configuration,
    configurationHash,
    'collaboration',
    input.sourcePages.collaboration,
  )
  const documents = verifySourceChain(
    runId,
    configuration,
    configurationHash,
    'documents',
    input.sourcePages.documents,
  )
  const sources = {
    'project-directory': projectDirectory,
    'work-items': workItems,
    collaboration,
    documents,
  }
  const target = verifyTargetChain(
    runId,
    configuration,
    configurationHash,
    input.targetPages,
  )
  const planningAuthorityProvenance =
    createPlanningAuthorityProvenance(
      runId,
      configurationHash,
      configuration.tables['migration-state'].tableId,
      input.sourcePages,
      input.targetPages,
      sources,
      target,
    )
  const candidates = createJoinedCandidates(
    configuration,
    configurationHash,
    sources,
    target,
  )
  if (candidates.length > input.limits.maxPlanOperations) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning evidence exceeds the configured operation limit.',
    )
  }
  candidates.sort(compareCandidatesByTargetDigest)

  const expectedSourceTargetKeyDigests = workspaceSearchMigrationSourceNames
    .flatMap((source) =>
      sources[source].sourceBindings.map(
        ({ targetKeyDigest }) => targetKeyDigest,
      )
    )
    .sort(compareDigests)
  const observedTargetKeyDigests = target.observedTargetBindings
    .map(({ targetKeyDigest }) => targetKeyDigest)
    .sort(compareDigests)
  const expectedTargets = new Set(expectedSourceTargetKeyDigests)
  const orphanTargetKeyDigests = observedTargetKeyDigests
    .filter((digest) => !expectedTargets.has(digest))

  const sourceProgress = {
    'project-directory': projectDirectory.progress,
    'work-items': workItems.progress,
    collaboration: collaboration.progress,
    documents: documents.progress,
  }
  const sourceRows = {
    'project-directory': projectDirectory.sourceRows,
    'work-items': workItems.sourceRows,
    collaboration: collaboration.sourceRows,
    documents: documents.sourceRows,
  }
  const sourceBindings = {
    'project-directory': projectDirectory.sourceBindings,
    'work-items': workItems.sourceBindings,
    collaboration: collaboration.sourceBindings,
    documents: documents.sourceBindings,
  }
  const targetOwnershipEvidence:
    WorkspaceSearchMigrationTargetOwnershipEvidence = {
      sourceRows,
      targetRows: target.targetRows,
      sourceBindings,
      observedTargetBindings: target.observedTargetBindings,
      expectedSourceTargetKeyDigests,
      observedTargetKeyDigests,
      orphanTargetKeyDigests,
    }
  const scanSnapshot: WorkspaceSearchMigrationScanSnapshot = {
    configurationHash,
    sources: {
      'project-directory': projectDirectory.progress.checkpoint.aggregate,
      'work-items': workItems.progress.checkpoint.aggregate,
      collaboration: collaboration.progress.checkpoint.aggregate,
      documents: documents.progress.checkpoint.aggregate,
    },
    target: createJoinedTargetAggregate(target, candidates),
  }
  return {
    sourceProgress,
    targetProgress: target.progress,
    planningAuthorityProvenance,
    scanSnapshot,
    targetOwnershipEvidence,
    candidates,
  }
}

/**
 * Validates positive safe integer resource bounds.
 *
 * @param limits - Caller-selected join bounds.
 */
function requirePlanningJoinLimits(
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): void {
  if (
    Object.keys(limits).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(limits, 'maxTotalRows') ||
    !Object.prototype.hasOwnProperty.call(
      limits,
      'maxTotalCanonicalItemBytes',
    ) ||
    !Object.prototype.hasOwnProperty.call(limits, 'maxPlanOperations') ||
    !isPositiveSafeInteger(limits.maxTotalRows) ||
    !isPositiveSafeInteger(limits.maxTotalCanonicalItemBytes) ||
    !isPositiveSafeInteger(limits.maxPlanOperations)
  ) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning join limits must be positive safe integers.',
    )
  }
}

/**
 * Requires all and only the four fixed source properties.
 *
 * @param sourcePages - Candidate source-material record.
 */
function requireExactSourcePageRecord(
  sourcePages: CreateWorkspaceSearchMigrationPlanningJoinInput['sourcePages'],
): void {
  const keys = Object.keys(sourcePages)
  if (
    keys.length !== workspaceSearchMigrationSourceNames.length ||
    !workspaceSearchMigrationSourceNames.every((source) =>
      Object.prototype.hasOwnProperty.call(sourcePages, source)
    )
  ) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning source material must contain exactly four source chains.',
    )
  }
}

/**
 * Requires dense nonempty material arrays for all five scans.
 *
 * @param sourcePages - Four source evidence chains.
 * @param targetPages - Target evidence chain.
 */
function requireNonemptyPageMaterials(
  sourcePages: CreateWorkspaceSearchMigrationPlanningJoinInput['sourcePages'],
  targetPages:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[],
): void {
  for (const source of workspaceSearchMigrationSourceNames) {
    const materials = sourcePages[source]
    if (
      !hasCanonicalDenseArrayShape(materials) ||
      materials.length === 0
    ) {
      return failPlanningJoin(
        'DRY_RUN_INVALID_ROWS',
        'Planning evidence requires five complete nonempty page chains.',
      )
    }
  }
  if (
    !hasCanonicalDenseArrayShape(targetPages) ||
    targetPages.length === 0
  ) {
    return failPlanningJoin(
      'DRY_RUN_INVALID_ROWS',
      'Planning evidence requires five complete nonempty page chains.',
    )
  }
}

/**
 * Rejects oversized work from evidence-head aggregates before raw reduction.
 *
 * @param sourcePages - Four source evidence chains.
 * @param targetPages - Target evidence chain.
 * @param limits - Explicit join limits.
 * @returns Combined head-declared row count.
 */
function preflightHeadAggregates(
  sourcePages: CreateWorkspaceSearchMigrationPlanningJoinInput['sourcePages'],
  targetPages:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[],
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): number {
  let totalRows = 0
  let totalSourceMapped = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    const head = sourcePages[source].at(-1)
    if (head === undefined) {
      return failPlanningJoin(
        'DRY_RUN_INVALID_ROWS',
        'Planning evidence chain has no head.',
      )
    }
    const aggregate = head.page.checkpoint.aggregate
    requireHeadCounter(aggregate.scanned)
    requireHeadCounter(aggregate.mapped)
    totalRows = addSafeCount(totalRows, aggregate.scanned)
    totalSourceMapped = addSafeCount(
      totalSourceMapped,
      aggregate.mapped,
    )
  }
  const targetHead = targetPages.at(-1)
  if (targetHead === undefined) {
    return failPlanningJoin(
      'DRY_RUN_INVALID_ROWS',
      'Planning target evidence chain has no head.',
    )
  }
  const targetAggregate = targetHead.page.checkpoint.aggregate
  requireHeadCounter(targetAggregate.scanned)
  requireHeadCounter(targetAggregate.owned)
  totalRows = addSafeCount(totalRows, targetAggregate.scanned)
  if (
    totalRows > limits.maxTotalRows ||
    Math.max(totalSourceMapped, targetAggregate.owned) >
      limits.maxPlanOperations
  ) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning evidence exceeds configured row or operation limits.',
    )
  }
  return totalRows
}

/**
 * Recounts exact raw rows and their canonical UTF-8 item bytes.
 *
 * @param sourcePages - Four source evidence chains.
 * @param targetPages - Target evidence chain.
 * @param limits - Explicit join limits.
 * @returns Exact raw item count.
 */
function measureRawMaterial(
  sourcePages: CreateWorkspaceSearchMigrationPlanningJoinInput['sourcePages'],
  targetPages:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[],
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): number {
  let rowCount = 0
  let canonicalBytes = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    for (const material of sourcePages[source]) {
      const measured = measureRawItems(material.items)
      rowCount = addSafeCount(rowCount, measured.rows)
      canonicalBytes = addSafeCount(canonicalBytes, measured.bytes)
      requireMeasuredLimits(rowCount, canonicalBytes, limits)
    }
  }
  for (const material of targetPages) {
    const measured = measureRawItems(material.items)
    rowCount = addSafeCount(rowCount, measured.rows)
    canonicalBytes = addSafeCount(canonicalBytes, measured.bytes)
    requireMeasuredLimits(rowCount, canonicalBytes, limits)
  }
  return rowCount
}

/**
 * Measures one dense ordered raw item array.
 *
 * @param items - Exact page items.
 * @returns Raw row count and canonical UTF-8 byte count.
 */
function measureRawItems(
  items: readonly DynamoAttributeMap[],
): { readonly rows: number; readonly bytes: number } {
  if (!hasCanonicalDenseArrayShape(items)) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning raw page items must form a dense array.',
    )
  }
  let bytes = 0
  for (const item of items) {
    bytes = addSafeCount(
      bytes,
      Buffer.byteLength(serializeCanonicalAttributeMap(item), 'utf8'),
    )
  }
  return { rows: items.length, bytes }
}

/**
 * Applies measured raw limits incrementally.
 *
 * @param rows - Exact rows measured so far.
 * @param bytes - Exact canonical bytes measured so far.
 * @param limits - Explicit join limits.
 */
function requireMeasuredLimits(
  rows: number,
  bytes: number,
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): void {
  if (
    rows > limits.maxTotalRows ||
    bytes > limits.maxTotalCanonicalItemBytes
  ) {
    return failPlanningJoin(
      'INVALID_ARGUMENT',
      'Planning raw material exceeds configured resource limits.',
    )
  }
}

/**
 * Re-reduces, recreates, compares, and replays one complete source chain.
 *
 * @param runId - Expected run identifier.
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param source - Logical source role.
 * @param materials - Ordered evidence and raw page pairs.
 * @returns Complete validated source chain.
 */
function verifySourceChain(
  runId: string,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  materials:
    readonly WorkspaceSearchMigrationPlanningSourcePageMaterial[],
): VerifiedSourceChain {
  const sourceTable = configuration.tables[source]
  const stateTable = configuration.tables['migration-state']
  const identity: WorkspaceSearchMigrationSourceEvidenceIdentity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: sourceTable.tableId,
    stateTableId: stateTable.tableId,
  }
  let progress =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const recreatedPages: WorkspaceSearchMigrationSourceEvidencePage[] = []
  const items: DynamoAttributeMap[] = []
  for (const material of materials) {
    const page = material.page
    requireSourcePageIdentity(
      page,
      runId,
      configurationHash,
      source,
      sourceTable.tableId,
      stateTable.tableId,
    )
    const pageResult = reduceWorkspaceSearchMigrationSourceScanPage({
      configuration,
      configurationHash,
      source,
      previousCheckpoint: progress.checkpoint,
      page: page.checkpoint.cursor === undefined
        ? { items: material.items }
        : {
            items: material.items,
            lastEvaluatedKey: page.checkpoint.cursor,
          },
    })
    const recreated = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority: page.planningAuthority,
      sourceArtifacts: page.sourceArtifacts,
      previousProgress: progress,
      pageResult,
    })
    requireEqualSourceEvidencePage(page, recreated)
    recreatedPages.push(recreated)
    progress = advanceWorkspaceSearchMigrationSourceEvidenceProgress(
      progress,
      recreated,
    )
    items.push(...material.items)
  }
  const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
    identity,
    recreatedPages,
  )
  requireCompleteSourceReplay(replay.progress, replay.invalidRows.length, materials.length)
  return {
    progress: replay.progress,
    sourceRows: replay.sourceRows,
    sourceBindings: replay.sourceBindings,
    items,
  }
}

/**
 * Requires exact immutable identity on one source page.
 *
 * @param page - Candidate version-three planning page.
 * @param runId - Expected run identifier.
 * @param configurationHash - Expected configuration digest.
 * @param source - Expected source role.
 * @param sourceTableId - Expected immutable source TableId.
 * @param stateTableId - Expected immutable state TableId.
 */
function requireSourcePageIdentity(
  page: WorkspaceSearchMigrationPlanningSourcePageMaterial['page'],
  runId: string,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  sourceTableId: string,
  stateTableId: string,
): void {
  if (page.configurationHash !== configurationHash) {
    return failPlanningJoin(
      'CONFIGURATION_HASH_MISMATCH',
      'Source evidence uses a different configuration hash.',
    )
  }
  if (
    page.purpose !== 'planning' ||
    page.evidenceVersion !== 3 ||
    page.runId !== runId ||
    page.source !== source ||
    page.sourceTableId !== sourceTableId ||
    page.stateTableId !== stateTableId
  ) {
    return failPlanningJoin(
      'IDENTITY_MISMATCH',
      'Source evidence identity differs from measured configuration.',
    )
  }
}

/**
 * Requires canonical equality between retained and recreated source pages.
 *
 * @param retained - Retained authoritative source page.
 * @param recreated - Page reproduced from its exact raw material.
 */
function requireEqualSourceEvidencePage(
  retained: WorkspaceSearchMigrationSourceEvidencePage,
  recreated: WorkspaceSearchMigrationSourceEvidencePage,
): void {
  if (
    !equalBytes(
      serializeWorkspaceSearchMigrationSourceEvidencePage(retained),
      serializeWorkspaceSearchMigrationSourceEvidencePage(recreated),
    )
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Source evidence differs from its exact raw material.',
    )
  }
}

/**
 * Requires one terminal clean source replay with exact page accounting.
 *
 * @param progress - Replayed terminal head.
 * @param invalidRowCount - Replayed invalid-row evidence count.
 * @param materialPageCount - Exact supplied material page count.
 */
function requireCompleteSourceReplay(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  invalidRowCount: number,
  materialPageCount: number,
): void {
  if (
    progress.pageSequence !== materialPageCount ||
    progress.checkpoint.aggregate.pageCount !== materialPageCount
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Source evidence page accounting is inconsistent.',
    )
  }
  if (
    !progress.checkpoint.completed ||
    progress.checkpoint.cursor !== undefined ||
    progress.checkpoint.aggregate.invalid !== 0 ||
    invalidRowCount !== 0
  ) {
    return failPlanningJoin(
      'DRY_RUN_INVALID_ROWS',
      'Source planning evidence is incomplete or contains invalid rows.',
    )
  }
}

/**
 * Re-reduces, recreates, compares, replays, and indexes the target chain.
 *
 * @param runId - Expected run identifier.
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param materials - Ordered target evidence and raw page pairs.
 * @returns Complete validated and physically indexed target chain.
 */
function verifyTargetChain(
  runId: string,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  materials:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[],
): VerifiedTargetChain {
  const targetTable = configuration.tables['workspace-search']
  const stateTable = configuration.tables['migration-state']
  const identity: WorkspaceSearchMigrationTargetEvidenceIdentity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId: targetTable.tableId,
    stateTableId: stateTable.tableId,
  }
  let progress =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
  const recreatedPages: WorkspaceSearchMigrationTargetEvidencePage[] = []
  const itemsByTargetKeyDigest = new Map<string, DynamoAttributeMap>()
  for (const material of materials) {
    const page = material.page
    requireTargetPageIdentity(
      page,
      runId,
      configurationHash,
      targetTable.tableId,
      stateTable.tableId,
    )
    const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
      configuration,
      configurationHash,
      previousCheckpoint: progress.checkpoint,
      page: page.checkpoint.cursor === undefined
        ? { items: material.items }
        : {
            items: material.items,
            lastEvaluatedKey: page.checkpoint.cursor,
          },
    })
    const recreated = createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      planningAuthority: page.planningAuthority,
      targetArtifacts: page.targetArtifacts,
      previousProgress: progress,
      pageResult,
    })
    requireEqualTargetEvidencePage(page, recreated)
    recreatedPages.push(recreated)
    progress = advanceWorkspaceSearchMigrationTargetEvidenceProgress(
      progress,
      recreated,
    )
    for (const item of material.items) {
      const keyResult =
        cloneWorkspaceSearchMigrationExactTableKeyFromItem(
          item,
          targetTable,
        )
      if (!keyResult.ok) {
        return failPlanningJoin(
          keyResult.code,
          'Target raw item has an invalid physical key.',
        )
      }
      const targetKeyDigest = createAttributeMapDigest(keyResult.key)
      if (itemsByTargetKeyDigest.has(targetKeyDigest)) {
        return failPlanningJoin(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
          'Target planning evidence contains duplicate physical keys.',
        )
      }
      itemsByTargetKeyDigest.set(targetKeyDigest, item)
    }
  }
  const replay = replayWorkspaceSearchMigrationTargetEvidencePages(
    identity,
    recreatedPages,
  )
  requireCompleteTargetReplay(replay.progress, replay.invalidRows.length, materials.length)
  if (
    itemsByTargetKeyDigest.size !==
      replay.progress.checkpoint.aggregate.scanned
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Target raw index differs from the complete target scan.',
    )
  }
  return {
    progress: replay.progress,
    targetRows: replay.targetRows,
    observedTargetBindings: replay.observedTargetBindings,
    itemsByTargetKeyDigest,
  }
}

/**
 * Requires exact immutable identity on one target page.
 *
 * @param page - Candidate version-one target evidence page.
 * @param runId - Expected run identifier.
 * @param configurationHash - Expected configuration digest.
 * @param targetTableId - Expected immutable target TableId.
 * @param stateTableId - Expected immutable state TableId.
 */
function requireTargetPageIdentity(
  page: WorkspaceSearchMigrationTargetEvidencePage,
  runId: string,
  configurationHash: string,
  targetTableId: string,
  stateTableId: string,
): void {
  if (page.configurationHash !== configurationHash) {
    return failPlanningJoin(
      'CONFIGURATION_HASH_MISMATCH',
      'Target evidence uses a different configuration hash.',
    )
  }
  if (
    page.purpose !== 'planning' ||
    page.evidenceVersion !== 1 ||
    page.runId !== runId ||
    page.targetTableId !== targetTableId ||
    page.stateTableId !== stateTableId
  ) {
    return failPlanningJoin(
      'IDENTITY_MISMATCH',
      'Target evidence identity differs from measured configuration.',
    )
  }
}

/**
 * Requires canonical equality between retained and recreated target pages.
 *
 * @param retained - Retained authoritative target page.
 * @param recreated - Page reproduced from its exact raw material.
 */
function requireEqualTargetEvidencePage(
  retained: WorkspaceSearchMigrationTargetEvidencePage,
  recreated: WorkspaceSearchMigrationTargetEvidencePage,
): void {
  if (
    !equalBytes(
      serializeWorkspaceSearchMigrationTargetEvidencePage(retained),
      serializeWorkspaceSearchMigrationTargetEvidencePage(recreated),
    )
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Target evidence differs from its exact raw material.',
    )
  }
}

/**
 * Requires one terminal clean target replay with exact page accounting.
 *
 * @param progress - Replayed terminal target head.
 * @param invalidRowCount - Replayed invalid-row evidence count.
 * @param materialPageCount - Exact supplied material page count.
 */
function requireCompleteTargetReplay(
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
  invalidRowCount: number,
  materialPageCount: number,
): void {
  if (
    progress.pageSequence !== materialPageCount ||
    progress.checkpoint.aggregate.pageCount !== materialPageCount
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Target evidence page accounting is inconsistent.',
    )
  }
  if (
    !progress.checkpoint.completed ||
    progress.checkpoint.cursor !== undefined ||
    progress.checkpoint.aggregate.invalid !== 0 ||
    invalidRowCount !== 0
  ) {
    return failPlanningJoin(
      'DRY_RUN_INVALID_ROWS',
      'Target planning evidence is incomplete or contains invalid rows.',
    )
  }
}

/**
 * Builds canonical five-chain roots and a realizable authority history.
 *
 * The pure join proves only consistency of authority bindings already
 * committed into evidence. A managed composition must still resolve each
 * historical receipt and atomically bind the current authority and five heads
 * when it persists the plan.
 *
 * @param runId - Operator-selected run shared by all evidence.
 * @param configurationHash - Reviewed measured-configuration digest.
 * @param stateTableId - Immutable migration-state table incarnation.
 * @param sourcePages - Four exact source material chains.
 * @param targetPages - Exact target material chain.
 * @param sources - Four verified source replay results.
 * @param target - Verified target replay result.
 * @returns Canonical roots, trace, transitions, and provenance digest.
 */
function createPlanningAuthorityProvenance(
  runId: string,
  configurationHash: string,
  stateTableId: string,
  sourcePages: CreateWorkspaceSearchMigrationPlanningJoinInput['sourcePages'],
  targetPages:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[],
  sources: Readonly<
    Record<WorkspaceSearchMigrationSourceName, VerifiedSourceChain>
  >,
  target: VerifiedTargetChain,
): WorkspaceSearchMigrationPlanningAuthorityProvenance {
  const chainRoots:
    WorkspaceSearchMigrationPlanningEvidenceChainRoot[] = []
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  for (const source of workspaceSearchMigrationSourceNames) {
    const progress = sources[source].progress
    chainRoots.push({
      chain: source,
      pageCount: progress.pageSequence,
      terminalEvidenceDigest: progress.evidenceDigest,
      terminalCheckpointDigest:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.checkpoint,
        ),
    })
    for (const material of sourcePages[source]) {
      authorityTrace.push(createPlanningAuthorityTraceEntry(
        source,
        material.page.pageSequence,
        createWorkspaceSearchMigrationSourceEvidencePageDigest(
          material.page,
        ),
        material.page.planningAuthority,
      ))
    }
  }
  chainRoots.push({
    chain: 'workspace-search',
    pageCount: target.progress.pageSequence,
    terminalEvidenceDigest: target.progress.evidenceDigest,
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationTargetCheckpointDigest(
        target.progress.checkpoint,
      ),
  })
  for (const material of targetPages) {
    authorityTrace.push(createPlanningAuthorityTraceEntry(
      'workspace-search',
      material.page.pageSequence,
      createWorkspaceSearchMigrationTargetEvidencePageDigest(
        material.page,
      ),
      material.page.planningAuthority,
    ))
  }
  const authorityTransitions =
    requireCompatiblePlanningAuthorityTrace(authorityTrace)
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
  return {
    ...provenance,
    provenanceDigest: createMigrationDigest(provenance),
  }
}

/**
 * Copies one strict page authority into its canonical trace entry.
 *
 * @param chain - Fixed source or target chain role.
 * @param pageSequence - One-based evidence page position.
 * @param evidenceDigest - Digest of the exact evidence page.
 * @param authority - Strict authority tuple committed by the page.
 * @returns Detached canonical trace entry.
 */
function createPlanningAuthorityTraceEntry(
  chain: WorkspaceSearchMigrationPlanningEvidenceChainRole,
  pageSequence: number,
  evidenceDigest: string,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): WorkspaceSearchMigrationPlanningAuthorityTraceEntry {
  return {
    chain,
    pageSequence,
    evidenceDigest,
    ownerId: authority.ownerId,
    fenceToken: authority.fenceToken,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Validates chain-local and global authority monotonicity.
 *
 * Same-run receipt renewal and takeover may legitimately change authority
 * between pages. The trace therefore requires a realizable monotonic history
 * instead of requiring every page to use one identical tuple.
 *
 * @param trace - Fixed-chain-order page authority entries.
 * @returns Unique authority transitions ordered by pointer revision.
 */
function requireCompatiblePlanningAuthorityTrace(
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
    if (previous !== undefined) {
      requirePlanningAuthoritySuccessor(previous, entry)
    }
    previousByChain.set(entry.chain, entry)

    const transition = createPlanningAuthorityTransition(entry)
    const existingTransition = transitionByRevision.get(
      transition.maintenanceEvidencePointerRevision,
    )
    if (
      existingTransition !== undefined &&
      !samePlanningAuthorityTransition(existingTransition, transition)
    ) {
      return failPlanningJoin(
        'INVALID_MAINTENANCE_EVIDENCE',
        'One authority pointer revision resolves to conflicting tuples.',
      )
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
      return failPlanningJoin(
        'INVALID_MAINTENANCE_EVIDENCE',
        'One authority fence resolves to conflicting owners.',
      )
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
      return failPlanningJoin(
        'INVALID_MAINTENANCE_EVIDENCE',
        'One authority receipt is reused by multiple pointer revisions.',
      )
    }
    revisionByReceipt.set(
      transition.maintenanceEvidenceReceiptDigest,
      transition.maintenanceEvidencePointerRevision,
    )
  }
  const transitions = [...transitionByRevision.values()]
    .sort(comparePlanningAuthorityTransitions)
  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1]
    const current = transitions[index]
    if (
      previous === undefined ||
      current === undefined ||
      current.fenceToken < previous.fenceToken
    ) {
      return failPlanningJoin(
        'INVALID_MAINTENANCE_EVIDENCE',
        'Authority fence history regresses across pointer revisions.',
      )
    }
  }
  return transitions
}

/**
 * Requires one later page to be a realizable same-run authority successor.
 *
 * @param previous - Prior page in the same evidence chain.
 * @param current - Candidate later page in the same evidence chain.
 */
function requirePlanningAuthoritySuccessor(
  previous: WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
  current: WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
): void {
  if (
    current.fenceToken < previous.fenceToken ||
    current.maintenanceEvidencePointerRevision <
      previous.maintenanceEvidencePointerRevision ||
    current.fenceToken === previous.fenceToken &&
      current.ownerId !== previous.ownerId ||
    current.fenceToken > previous.fenceToken &&
      current.maintenanceEvidencePointerRevision <=
        previous.maintenanceEvidencePointerRevision
  ) {
    return failPlanningJoin(
      'INVALID_MAINTENANCE_EVIDENCE',
      'Authority history is not monotonic within one evidence chain.',
    )
  }
}

/**
 * Copies one trace entry into a deduplicated authority transition.
 *
 * @param entry - Exact page authority trace entry.
 * @returns Detached authority transition.
 */
function createPlanningAuthorityTransition(
  entry: WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
): WorkspaceSearchMigrationPlanningAuthorityTransition {
  return {
    ownerId: entry.ownerId,
    fenceToken: entry.fenceToken,
    maintenanceEvidencePointerRevision:
      entry.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      entry.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Compares two transitions for exact authority identity.
 *
 * @param left - First authority transition.
 * @param right - Second authority transition.
 * @returns Whether every authority field is identical.
 */
function samePlanningAuthorityTransition(
  left: WorkspaceSearchMigrationPlanningAuthorityTransition,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest
  )
}

/**
 * Orders authority transitions by positive pointer revision.
 *
 * @param left - First authority transition.
 * @param right - Second authority transition.
 * @returns Stable numeric ordering without subtraction overflow.
 */
function comparePlanningAuthorityTransitions(
  left: WorkspaceSearchMigrationPlanningAuthorityTransition,
  right: WorkspaceSearchMigrationPlanningAuthorityTransition,
): number {
  const leftRevision = left.maintenanceEvidencePointerRevision
  const rightRevision = right.maintenanceEvidencePointerRevision
  return leftRevision < rightRevision
    ? -1
    : leftRevision > rightRevision
      ? 1
      : 0
}

/**
 * Builds source and orphan candidates from the complete target index.
 *
 * @param configuration - Exact measured table configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param sources - Four fully verified source chains.
 * @param target - Fully verified target chain and raw index.
 * @returns Complete collision-free candidate list.
 */
function createJoinedCandidates(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  sources: Readonly<Record<WorkspaceSearchMigrationSourceName, VerifiedSourceChain>>,
  target: VerifiedTargetChain,
): WorkspaceSearchMigrationPlanCandidate[] {
  const observedTargets = new Set(
    target.observedTargetBindings.map(({ targetKeyDigest }) =>
      targetKeyDigest
    ),
  )
  const sourceCandidates = new Map<
    string,
    WorkspaceSearchMigrationPlanCandidate
  >()
  for (const source of workspaceSearchMigrationSourceNames) {
    let mappedForSource = 0
    for (const sourceItem of sources[source].items) {
      const absentCandidate =
        createWorkspaceSearchMigrationSourceCandidate({
          configurationHash,
          source,
          sourceTable: configuration.tables[source],
          sourceItem,
        })
      if (absentCandidate === undefined) continue
      const targetKeyDigest = absentCandidate.operation.targetKeyDigest
      if (sourceCandidates.has(targetKeyDigest)) {
        return failPlanningJoin(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
          'Multiple source rows own the same target key.',
        )
      }
      const targetItem =
        target.itemsByTargetKeyDigest.get(targetKeyDigest)
      let candidate = absentCandidate
      if (targetItem !== undefined) {
        if (!observedTargets.has(targetKeyDigest)) {
          return failPlanningJoin(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
            'A mapped source target collides with an ignored target row.',
          )
        }
        const existingCandidate =
          createWorkspaceSearchMigrationSourceCandidate({
            configurationHash,
            source,
            sourceTable: configuration.tables[source],
            sourceItem,
            targetItem,
          })
        if (
          existingCandidate === undefined ||
          existingCandidate.operation.targetKeyDigest !== targetKeyDigest
        ) {
          return failPlanningJoin(
            'INVALID_STATE',
            'Source candidate changed while binding its target preimage.',
          )
        }
        candidate = existingCandidate
      }
      sourceCandidates.set(targetKeyDigest, candidate)
      if (candidate.operation.sourceCondition.source === source) {
        mappedForSource += 1
      }
    }
    if (
      mappedForSource !==
        sources[source].progress.checkpoint.aggregate.mapped
    ) {
      return failPlanningJoin(
        'INVALID_STATE',
        'Source candidates differ from the complete source scan.',
      )
    }
  }

  const candidates = [...sourceCandidates.values()]
  for (const binding of target.observedTargetBindings) {
    if (sourceCandidates.has(binding.targetKeyDigest)) continue
    const targetItem =
      target.itemsByTargetKeyDigest.get(binding.targetKeyDigest)
    if (targetItem === undefined) {
      return failPlanningJoin(
        'INVALID_STATE',
        'Observed target ownership has no exact raw preimage.',
      )
    }
    const classification =
      classifyWorkspaceSearchMigrationTargetRow(targetItem)
    if (classification.classification !== 'owned') {
      return failPlanningJoin(
        'INVALID_STATE',
        'Observed target ownership differs from raw classification.',
      )
    }
    const source = sourceForOwnedEntity(classification.document.entityType)
    const orphan = createWorkspaceSearchMigrationOrphanCandidate({
      configurationHash,
      sourceTable: configuration.tables[source],
      targetItem,
    })
    if (
      orphan === undefined ||
      orphan.operation.targetKeyDigest !== binding.targetKeyDigest
    ) {
      return failPlanningJoin(
        'INVALID_STATE',
        'Orphan candidate differs from observed target ownership.',
      )
    }
    candidates.push(orphan)
  }
  return candidates
}

/**
 * Selects the source table owning one migration-owned Search entity.
 *
 * @param entityType - Runtime entity family from a validated target document.
 * @returns Fixed source table role.
 */
function sourceForOwnedEntity(
  entityType: string,
): WorkspaceSearchMigrationSourceName {
  if (entityType === 'work-item') return 'work-items'
  if (entityType === 'comment' || entityType === 'context-item') return 'collaboration'
  if (entityType === 'document') return 'documents'
  if (entityType === 'team' || entityType === 'project') {
    return 'project-directory'
  }
  return failPlanningJoin(
    'INVALID_STATE',
    'Observed target entity is outside migration ownership.',
  )
}

/**
 * Converts the target-only checkpoint into the planner joined aggregate.
 *
 * @param target - Complete target evidence replay.
 * @param candidates - Complete source and orphan candidate list.
 * @returns Planner-compatible complete target aggregate.
 */
function createJoinedTargetAggregate(
  target: VerifiedTargetChain,
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): MigrationScanAggregate {
  const observedCandidates = candidates.filter(
    ({ operation }) => operation.before.exists,
  )
  const projected = observedCandidates.filter(
    ({ operation }) => operation.after.exists,
  ).length
  const aggregate = target.progress.checkpoint.aggregate
  if (observedCandidates.length !== aggregate.owned) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Joined candidates differ from observed target ownership.',
    )
  }
  return {
    scanned: aggregate.scanned,
    mapped: aggregate.owned,
    ignored: aggregate.ignored,
    invalid: aggregate.invalid,
    projected,
    deleted: observedCandidates.length - projected,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
    pageCount: aggregate.pageCount,
  }
}

/**
 * Compares candidates by lowercase target-key digest.
 *
 * @param left - First candidate.
 * @param right - Second candidate.
 * @returns Stable lexical comparison value.
 */
function compareCandidatesByTargetDigest(
  left: WorkspaceSearchMigrationPlanCandidate,
  right: WorkspaceSearchMigrationPlanCandidate,
): number {
  return compareDigests(
    left.operation.targetKeyDigest,
    right.operation.targetKeyDigest,
  )
}

/**
 * Compares two lowercase hexadecimal digests without locale dependence.
 *
 * @param left - First digest.
 * @param right - Second digest.
 * @returns Negative, zero, or positive comparison value.
 */
function compareDigests(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Compares two canonical byte arrays exactly.
 *
 * @param left - First byte sequence.
 * @param right - Second byte sequence.
 * @returns Whether both sequences are byte-for-byte equal.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Adds two validated counters without allowing unsafe integer overflow.
 *
 * @param left - Current accumulated count.
 * @param right - Nonnegative increment.
 * @returns Exact safe-integer sum.
 */
function addSafeCount(left: number, right: number): number {
  const sum = left + right
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    !Number.isSafeInteger(sum)
  ) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Planning evidence count is outside the safe integer range.',
    )
  }
  return sum
}

/**
 * Requires one nonnegative safe evidence-head counter.
 *
 * @param value - Candidate head counter.
 */
function requireHeadCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failPlanningJoin(
      'INVALID_STATE',
      'Planning evidence head contains an invalid counter.',
    )
  }
}

/**
 * Tests whether one value is a positive safe integer.
 *
 * @param value - Candidate bounded resource limit.
 * @returns Whether the value is a positive safe integer.
 */
function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Runs the public join behind a fresh fixed secret-free failure boundary.
 *
 * @param operation - Join work that may inspect untrusted runtime values.
 * @returns Exact joined result.
 */
function runPlanningJoinBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = readPlanningJoinFailureCode(error)
    return throwPlanningJoinBoundaryFailure(code)
  }
}

/**
 * Throws one fresh public failure with a fixed secret-free message.
 *
 * @param code - Trusted stable code selected inside the detached boundary.
 * @returns Never returns.
 */
function throwPlanningJoinBoundaryFailure(
  code: WorkspaceSearchMigrationPlanningJoinFailureCode,
): never {
  throw new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search migration planning join stopped safely (${code}).`,
  )
}

/**
 * Reads only an allowlisted stable failure code.
 *
 * @param error - Arbitrary thrown value.
 * @returns Preserved stable code or the fail-closed default.
 */
function readPlanningJoinFailureCode(
  error: unknown,
): WorkspaceSearchMigrationPlanningJoinFailureCode {
  try {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      if (isPlanningJoinFailureCode(code)) return code
    }
  } catch {
    return 'INVALID_STATE'
  }
  return 'INVALID_STATE'
}

/**
 * Narrows one value to the join's deliberately small failure-code allowlist.
 *
 * @param value - Candidate trusted nested failure code.
 * @returns Whether the join is permitted to preserve the code.
 */
function isPlanningJoinFailureCode(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningJoinFailureCode {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(
      planningJoinFailureCodes,
      value,
    )
}

/**
 * Throws one private bounded-projection failure.
 *
 * @param code - Trusted shape, identity, or resource-bound failure code.
 * @returns Never returns.
 */
function failPlanningJoinDetach(
  code: PlanningJoinDetachFailureCode,
): never {
  throw new PlanningJoinDetachFailure(code)
}

/**
 * Throws one deliberate secret-free migration failure inside the boundary.
 *
 * @param code - Stable operator-safe failure code.
 * @param message - Secret-free internal guidance replaced at the boundary.
 * @returns Never returns.
 */
function failPlanningJoin(
  code: WorkspaceSearchMigrationPlanningJoinFailureCode,
  message: string,
): never {
  throw new WorkspaceSearchMigrationFailure(code, message)
}
