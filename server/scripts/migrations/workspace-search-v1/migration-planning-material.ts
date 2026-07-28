import type {
  DynamoAttributeMap,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceEvidencePage,
  WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import type {
  WorkspaceSearchMigrationTargetEvidencePage,
  WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'

/**
 * Explicit in-memory bounds for one complete planning-evidence join.
 */
export type WorkspaceSearchMigrationPlanningJoinLimits = {
  /** Maximum combined source and target rows accepted by the join. */
  readonly maxTotalRows: number
  /** Maximum combined canonical UTF-8 bytes of every exact raw item. */
  readonly maxTotalCanonicalItemBytes: number
  /** Maximum exact source and orphan operation candidates returned. */
  readonly maxPlanOperations: number
}

/**
 * Remaining in-memory budget available to one exact-version material read.
 */
export type WorkspaceSearchMigrationPlanningMaterialReadLimits = {
  /** Maximum additional raw rows that this read may retain. */
  readonly maxRows: number
  /** Maximum additional canonical UTF-8 item bytes this read may retain. */
  readonly maxCanonicalItemBytes: number
}

/**
 * One exact planning source evidence page paired with its lossless raw items.
 */
export type WorkspaceSearchMigrationPlanningSourcePageMaterial = {
  /** Authoritative version-three source evidence page. */
  readonly page: Extract<
    WorkspaceSearchMigrationSourceEvidencePage,
    { readonly purpose: 'planning'; readonly evidenceVersion: 3 }
  >
  /** Exact ordered raw DynamoDB items committed by the evidence page. */
  readonly items: readonly DynamoAttributeMap[]
}

/**
 * One exact planning target evidence page paired with its lossless raw items.
 */
export type WorkspaceSearchMigrationPlanningTargetPageMaterial = {
  /** Authoritative version-one target evidence page. */
  readonly page: WorkspaceSearchMigrationTargetEvidencePage
  /** Exact ordered raw DynamoDB items committed by the evidence page. */
  readonly items: readonly DynamoAttributeMap[]
}

/**
 * Complete bounded raw material read for one planning source evidence chain.
 */
export type WorkspaceSearchMigrationPlanningSourceChainMaterial = {
  /** Exact validated progress supplied as the fixed read boundary. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Exact verified source pages and their lossless raw items in chain order. */
  readonly materials:
    readonly WorkspaceSearchMigrationPlanningSourcePageMaterial[]
  /** Total raw rows retained across the returned source materials. */
  readonly rowCount: number
  /** Total canonical UTF-8 bytes retained across the returned source items. */
  readonly canonicalItemBytes: number
}

/**
 * Complete bounded raw material read for one planning target evidence chain.
 */
export type WorkspaceSearchMigrationPlanningTargetChainMaterial = {
  /** Exact validated progress supplied as the fixed read boundary. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Exact verified target pages and their lossless raw items in chain order. */
  readonly materials:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[]
  /** Total raw rows retained across the returned target materials. */
  readonly rowCount: number
  /** Total canonical UTF-8 bytes retained across the returned target items. */
  readonly canonicalItemBytes: number
}
