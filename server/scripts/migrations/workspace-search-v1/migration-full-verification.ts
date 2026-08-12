import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchPlanSeal,
  workspaceSearchMigrationSourceNames,
  WorkspaceSearchMigrationFailure,
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
  parseWorkspaceSearchMigrationCompleteApplySeal,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationApplyTargetScanPredecessor,
  reduceWorkspaceSearchMigrationApplyTargetScanPage,
} from './migration-apply-target-scan-page'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationObservedTargetBinding,
  WorkspaceSearchMigrationSourceOwnershipBinding,
} from './migration-planner'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPage,
} from './migration-source-scan-page'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  type WorkspaceSearchPlannedOperation,
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/** Schema version of the plan-derived full verification kernel. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION = 1

/** Maximum ordinary-object nodes accepted at a plan/progress trust boundary. */
const maximumFullVerificationGraphNodes = 4_096

/** Mutable budget used while rejecting active behavior and cyclic graphs. */
type FullVerificationGraphBudget = {
  /** Number of distinct object nodes inspected. */
  nodes: number
  /** Nodes on the active traversal path. */
  readonly active: WeakSet<object>
  /** Nodes whose complete descendants were already inspected. */
  readonly visited: WeakSet<object>
}

/**
 * Order-independent binding evidence retained across verification pages.
 */
export type WorkspaceSearchMigrationVerificationBindingAggregate = {
  /** Exact number of bindings accumulated. */
  readonly count: number
  /** Resumable accumulator state for every domain-separated binding digest. */
  readonly digestState: MigrationDigestState
  /** Digest of the exact accumulator state. */
  readonly digest: string
}

/**
 * Plan-derived expectations required by an independent full verification.
 */
export type WorkspaceSearchMigrationFullVerificationPlan = {
  /** Verification-plan discriminator. */
  readonly kind: 'workspace-search-migration-full-verification-plan'
  /** Verification-plan schema version. */
  readonly verificationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** SHA-256 digest of the exact canonical replayed plan-seal bytes. */
  readonly planSealContentDigest: string
  /** Exact number of replayed plan operations. */
  readonly planOperationCount: number
  /** Exact number of operations derived from present source rows. */
  readonly sourceOperationCount: number
  /** Exact number of operations derived from absent-source orphans. */
  readonly orphanOperationCount: number
  /** Expected present-source bindings grouped by source table. */
  readonly sourceBindings: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationVerificationBindingAggregate
    >
  >
  /** Sorted source-key digests that must remain absent for orphan operations. */
  readonly sourceAbsentKeyDigests: Readonly<
    Record<WorkspaceSearchMigrationSourceName, readonly string[]>
  >
  /** Expected present target key/item pairs after apply. */
  readonly targetPresentBindings:
    WorkspaceSearchMigrationVerificationBindingAggregate
  /** Sorted target-key digests that must remain absent after apply. */
  readonly targetAbsentKeyDigests: readonly string[]
  /** Digest of every preceding canonical verification-plan field. */
  readonly verificationPlanDigest: string
}

/**
 * Resumable independent source-and-target verification progress.
 */
export type WorkspaceSearchMigrationFullVerificationProgress = {
  /** Verification-progress discriminator. */
  readonly kind: 'workspace-search-migration-full-verification-progress'
  /** Verification-progress schema version. */
  readonly verificationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Independent full traversal over all four sources and the target. */
  readonly traversal: WorkspaceSearchMigrationTraversalProgress
  /** Observed present-source binding accumulators. */
  readonly sourceBindings: Readonly<
    Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
  >
  /** Observed migration-owned target key/item pair accumulator. */
  readonly targetPresentBindings: MigrationDigestState
}

/**
 * Non-authoritative terminal comparison produced by the pure kernel.
 *
 * A persistence adapter must bind this result to an immutable applied root
 * before publishing authoritative verified evidence.
 */
export type WorkspaceSearchMigrationFullVerificationResult = {
  /** Full-verification result discriminator. */
  readonly kind: 'workspace-search-migration-full-verification-result'
  /** Full-verification result schema version. */
  readonly verificationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Exact number of replayed plan operations. */
  readonly planOperationCount: number
  /** Exact number of operations derived from present source rows. */
  readonly sourceOperationCount: number
  /** Exact number of operations derived from absent-source orphans. */
  readonly orphanOperationCount: number
  /** Digest of the exact complete apply seal used as the predecessor. */
  readonly applySealDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Terminal checkpoint digests for the four source rescans. */
  readonly sourceCheckpointDigests: Readonly<
    Record<WorkspaceSearchMigrationSourceName, string>
  >
  /** Terminal target checkpoint digest retained as clean scan evidence. */
  readonly targetCheckpointDigest: string
  /** Lossless terminal progress consumed by verified-phase publication. */
  readonly verification: WorkspaceSearchMigrationFullVerificationProgress
  /** Plan-derived present-source binding aggregates. */
  readonly expectedSourceBindings: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationVerificationBindingAggregate
    >
  >
  /** Independently observed present-source binding aggregates. */
  readonly observedSourceBindings: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationVerificationBindingAggregate
    >
  >
  /** Exact expected present target binding aggregate. */
  readonly expectedTargetPresentBindings:
    WorkspaceSearchMigrationVerificationBindingAggregate
  /** Exact observed present target binding aggregate. */
  readonly observedTargetPresentBindings:
    WorkspaceSearchMigrationVerificationBindingAggregate
  /** Stable successful verification outcome. */
  readonly status: 'pass'
  /** Digest of every preceding canonical result field. */
  readonly resultDigest: string
}

/**
 * Input for creating one plan-derived full-verification expectation.
 */
export type CreateWorkspaceSearchMigrationFullVerificationPlanInput = {
  /** Exact replayed plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Complete ordered plan operations returned by exact artifact replay. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
}

/**
 * Input for reducing one independent source verification page.
 */
export type ReduceWorkspaceSearchMigrationFullVerificationSourcePageInput = {
  /** Plan-derived expectation that owns this traversal. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
  /** Previously persisted full-verification progress. */
  readonly progress: WorkspaceSearchMigrationFullVerificationProgress
  /** Complete measured configuration that owns the source table. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Logical source selected for this page. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Exact raw source page returned by the bounded strong Scan. */
  readonly page: WorkspaceSearchMigrationSourceScanPage
}

/**
 * Input for reducing one independent target verification page.
 */
export type ReduceWorkspaceSearchMigrationFullVerificationTargetPageInput = {
  /** Plan-derived expectation that owns this traversal. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
  /** Previously persisted full-verification progress. */
  readonly progress: WorkspaceSearchMigrationFullVerificationProgress
  /** Complete measured configuration that owns the target table. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact raw target page returned by the bounded strong Scan. */
  readonly page: WorkspaceSearchMigrationTargetScanPage
}

/**
 * Input for completing independent full verification.
 */
export type CompleteWorkspaceSearchMigrationFullVerificationInput = {
  /** Plan-derived expectation used by every page. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
  /** Terminal independently accumulated progress. */
  readonly progress: WorkspaceSearchMigrationFullVerificationProgress
  /** Exact complete apply seal compared with the predecessor phase. */
  readonly applySeal: WorkspaceSearchMigrationCompleteApplySeal
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
}

/**
 * Creates a domain-separated digest for one source-to-target ownership binding.
 *
 * @param source - Logical source table.
 * @param binding - Exact mapped source binding emitted by the scan reducer.
 * @returns Lowercase SHA-256 binding digest.
 */
export function createWorkspaceSearchMigrationVerificationSourceBindingDigest(
  source: WorkspaceSearchMigrationSourceName,
  binding: WorkspaceSearchMigrationSourceOwnershipBinding,
): string {
  return atFullVerificationBoundary(() => {
    requireSourceName(source)
    requireSourceBinding(binding)
    return createMigrationDigest({
      domain: 'workspace-search-migration-verification-source-binding-v1',
      source,
      sourceItemDigest: binding.sourceItemDigest,
      sourceKeyDigest: binding.sourceKeyDigest,
      targetAction: binding.targetAction,
      targetKeyDigest: binding.targetKeyDigest,
    })
  })
}

/**
 * Creates a domain-separated digest for one expected or observed target pair.
 *
 * @param binding - Exact target key and full-item digest pair.
 * @returns Lowercase SHA-256 binding digest.
 */
export function createWorkspaceSearchMigrationVerificationTargetBindingDigest(
  binding: WorkspaceSearchMigrationObservedTargetBinding,
): string {
  return atFullVerificationBoundary(() => {
    requireTargetBinding(binding)
    return createMigrationDigest({
      domain: 'workspace-search-migration-verification-target-binding-v1',
      targetItemDigest: binding.targetItemDigest,
      targetKeyDigest: binding.targetKeyDigest,
    })
  })
}

/**
 * Derives bounded source and target expectations from an exact replayed plan.
 *
 * @param input - Strict plan seal and complete ordered operation replay.
 * @returns Detached verification expectation without raw tenant values.
 */
export function createWorkspaceSearchMigrationFullVerificationPlan(
  input: CreateWorkspaceSearchMigrationFullVerificationPlanInput,
): WorkspaceSearchMigrationFullVerificationPlan {
  return atFullVerificationBoundary(() => {
    requireExactOwnDataKeys(input, ['operations', 'planSeal'])
    const planSealBytes = serializeWorkspaceSearchPlanSeal(input.planSeal)
    const planSeal = parseWorkspaceSearchPlanSeal(planSealBytes)
    const operations = detachPlanOperations(input.operations)
    if (operations.length !== planSeal.planOperationCount) {
      return failFullVerification()
    }

    const sourceAccumulators = createSourceAccumulators()
    const sourceAbsentKeyDigests = createSourceDigestLists()
    const targetAccumulator = new MigrationDigestAccumulator()
    const targetKeys = new Set<string>()
    const targetAbsentKeyDigests: string[] = []

    for (let index = 0; index < operations.length; index += 1) {
      const planned = operations[index]
      if (
        planned === undefined ||
        planned.runId !== planSeal.runId ||
        planned.configurationHash !== planSeal.configurationHash ||
        planned.planDigest !== planSeal.planDigest ||
        planned.planSequence !== index + 1
      ) {
        return failFullVerification()
      }
      const operation = planned.operation
      if (targetKeys.has(operation.targetKeyDigest)) {
        return failFullVerification()
      }
      targetKeys.add(operation.targetKeyDigest)

      if (operation.sourceCondition.exists) {
        const source = operation.sourceCondition.source
        sourceAccumulators[source].add(
          createWorkspaceSearchMigrationVerificationSourceBindingDigest(
            source,
            {
              sourceKeyDigest: operation.sourceCondition.keyDigest,
              sourceItemDigest: operation.sourceCondition.itemDigest,
              targetKeyDigest: operation.targetKeyDigest,
              targetAction: operation.after.exists ? 'put' : 'delete',
            },
          ),
        )
      } else {
        sourceAbsentKeyDigests[
          operation.sourceCondition.source
        ].push(operation.sourceCondition.keyDigest)
      }
      if (operation.after.exists) {
        targetAccumulator.add(
          createWorkspaceSearchMigrationVerificationTargetBindingDigest({
            targetKeyDigest: operation.targetKeyDigest,
            targetItemDigest: operation.after.digest,
          }),
        )
      } else {
        targetAbsentKeyDigests.push(operation.targetKeyDigest)
      }
    }
    for (const source of workspaceSearchMigrationSourceNames) {
      sourceAbsentKeyDigests[source].sort(compareUtf8Ordinal)
    }
    targetAbsentKeyDigests.sort(compareUtf8Ordinal)

    const common = {
      kind: 'workspace-search-migration-full-verification-plan',
      verificationVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: planSeal.runId,
      configurationHash: planSeal.configurationHash,
      planDigest: planSeal.planDigest,
      planSealContentDigest: createHash('sha256')
        .update(planSealBytes)
        .digest('hex'),
      planOperationCount: planSeal.planOperationCount,
      sourceOperationCount: planSeal.sourceOperationCount,
      orphanOperationCount: planSeal.orphanOperationCount,
      sourceBindings: createSourceAggregates(sourceAccumulators),
      sourceAbsentKeyDigests,
      targetPresentBindings: createBindingAggregate(targetAccumulator),
      targetAbsentKeyDigests,
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationPlan,
      'verificationPlanDigest'
    >
    return requireVerificationPlan({
      ...common,
      verificationPlanDigest: createMigrationDigest(common),
    })
  })
}

/**
 * Creates fresh independent verification progress from one expectation.
 *
 * @param plan - Plan-derived expectation that owns the traversal.
 * @returns Empty five-location traversal and binding accumulators.
 */
export function createEmptyWorkspaceSearchMigrationFullVerificationProgress(
  plan: WorkspaceSearchMigrationFullVerificationPlan,
): WorkspaceSearchMigrationFullVerificationProgress {
  return atFullVerificationBoundary(() => {
    const verifiedPlan = requireVerificationPlan(plan)
    return {
      kind: 'workspace-search-migration-full-verification-progress',
      verificationVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
      runId: verifiedPlan.runId,
      configurationHash: verifiedPlan.configurationHash,
      planDigest: verifiedPlan.planDigest,
      verificationPlanDigest: verifiedPlan.verificationPlanDigest,
      traversal: createEmptyWorkspaceSearchMigrationTraversal(),
      sourceBindings: {
        'project-directory': createEmptyDigestState(),
        'work-items': createEmptyDigestState(),
        collaboration: createEmptyDigestState(),
        documents: createEmptyDigestState(),
      },
      targetPresentBindings: createEmptyDigestState(),
    }
  })
}

/**
 * Reduces one raw source page and advances resumable binding evidence.
 *
 * @param input - Plan, previous progress, measured configuration, and raw page.
 * @returns Detached exact successor progress.
 */
export function reduceWorkspaceSearchMigrationFullVerificationSourcePage(
  input: ReduceWorkspaceSearchMigrationFullVerificationSourcePageInput,
): WorkspaceSearchMigrationFullVerificationProgress {
  return atFullVerificationBoundary(() => {
    requireExactOwnDataKeys(input, [
      'configuration',
      'configurationHash',
      'page',
      'plan',
      'progress',
      'source',
    ])
    const plan = requireVerificationPlan(input.plan)
    const progress = requireVerificationProgress(input.progress, plan)
    requireIdentity(plan, input.configurationHash)
    const previousCheckpoint =
      progress.traversal.sources[input.source]
    const reduced = reduceWorkspaceSearchMigrationSourceScanPage({
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      source: input.source,
      previousCheckpoint,
      page: input.page,
    })
    for (const row of reduced.sourceRows) {
      if (
        includesSortedDigest(
          plan.sourceAbsentKeyDigests[input.source],
          row.sourceKeyDigest,
        )
      ) {
        return failFullVerification()
      }
    }
    for (const row of reduced.invalidRows) {
      if (
        includesSortedDigest(
          plan.sourceAbsentKeyDigests[input.source],
          row.sourceKeyDigest,
        )
      ) {
        return failFullVerification()
      }
    }
    const accumulator = MigrationDigestAccumulator.fromState(
      progress.sourceBindings[input.source],
    )
    for (const binding of reduced.sourceBindings) {
      accumulator.add(
        createWorkspaceSearchMigrationVerificationSourceBindingDigest(
          input.source,
          binding,
        ),
      )
    }
    if (accumulator.size() !== reduced.checkpoint.aggregate.mapped) {
      return failFullVerification()
    }
    return {
      ...progress,
      traversal: {
        sources: replaceSourceCheckpoint(
          progress.traversal.sources,
          input.source,
          reduced.checkpoint,
        ),
        target: progress.traversal.target,
      },
      sourceBindings: replaceSourceDigestState(
        progress.sourceBindings,
        input.source,
        accumulator.exportState(),
      ),
    }
  })
}

/**
 * Reduces one raw target page and advances resumable owned-pair evidence.
 *
 * Planned absent keys are rejected regardless of whether a hostile residual
 * row would otherwise classify as owned, ignored, or invalid. Valid unrelated
 * ignored rows remain allowed and are retained only in the raw checkpoint.
 *
 * @param input - Plan, previous progress, measured configuration, and raw page.
 * @returns Detached exact successor progress.
 */
export function reduceWorkspaceSearchMigrationFullVerificationTargetPage(
  input: ReduceWorkspaceSearchMigrationFullVerificationTargetPageInput,
): WorkspaceSearchMigrationFullVerificationProgress {
  return atFullVerificationBoundary(() => {
    requireExactOwnDataKeys(input, [
      'configuration',
      'configurationHash',
      'page',
      'plan',
      'progress',
    ])
    const plan = requireVerificationPlan(input.plan)
    const progress = requireVerificationProgress(input.progress, plan)
    requireIdentity(plan, input.configurationHash)
    const previousCheckpoint = progress.traversal.target
    const targetPredecessor =
      createWorkspaceSearchMigrationApplyTargetScanPredecessor({
        configuration: input.configuration,
        configurationHash: input.configurationHash,
        previousCheckpoint,
      })
    const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      previousCheckpoint: targetPredecessor,
      page: input.page,
    })
    for (const row of pageResult.targetRows) {
      if (
        includesSortedDigest(
          plan.targetAbsentKeyDigests,
          row.targetKeyDigest,
        )
      ) {
        return failFullVerification()
      }
    }
    for (const row of pageResult.invalidRows) {
      if (
        includesSortedDigest(
          plan.targetAbsentKeyDigests,
          row.targetKeyDigest,
        )
      ) {
        return failFullVerification()
      }
    }
    const reduced = reduceWorkspaceSearchMigrationApplyTargetScanPage({
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      previousCheckpoint,
      pageResult,
    })
    const accumulator = MigrationDigestAccumulator.fromState(
      progress.targetPresentBindings,
    )
    for (const binding of pageResult.observedTargetBindings) {
      accumulator.add(
        createWorkspaceSearchMigrationVerificationTargetBindingDigest(
          binding,
        ),
      )
    }
    if (accumulator.size() !== reduced.checkpoint.aggregate.mapped) {
      return failFullVerification()
    }
    return {
      ...progress,
      traversal: {
        sources: progress.traversal.sources,
        target: reduced.checkpoint,
      },
      targetPresentBindings: accumulator.exportState(),
    }
  })
}

/**
 * Completes verification only when every source and owned target is exact.
 *
 * @param input - Terminal progress, exact plan, apply seal, and planning root.
 * @returns Canonical successful full-verification result.
 */
export function completeWorkspaceSearchMigrationFullVerification(
  input: CompleteWorkspaceSearchMigrationFullVerificationInput,
): WorkspaceSearchMigrationFullVerificationResult {
  return atFullVerificationBoundary(() => {
    requireExactOwnDataKeys(input, [
      'applySeal',
      'plan',
      'progress',
      'sealedPlanningAuthority',
    ])
    const plan = requireVerificationPlan(input.plan)
    const progress = requireVerificationProgress(input.progress, plan)
    const applySeal = parseWorkspaceSearchMigrationCompleteApplySeal(
      serializeWorkspaceSearchMigrationCompleteApplySeal(input.applySeal),
    )
    const sealedPlanningAuthority =
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          input.sealedPlanningAuthority,
        ),
      )
    requireAuthorityBindings(plan, applySeal, sealedPlanningAuthority)

    const sourceCheckpointDigests = {
      'project-directory': completeSource(
        'project-directory',
        plan,
        progress,
        applySeal,
        sealedPlanningAuthority,
      ),
      'work-items': completeSource(
        'work-items',
        plan,
        progress,
        applySeal,
        sealedPlanningAuthority,
      ),
      collaboration: completeSource(
        'collaboration',
        plan,
        progress,
        applySeal,
        sealedPlanningAuthority,
      ),
      documents: completeSource(
        'documents',
        plan,
        progress,
        applySeal,
        sealedPlanningAuthority,
      ),
    }
    const target = progress.traversal.target
    requireCleanTerminalCheckpoint(target)
    const observedTargetPresentBindings = createBindingAggregate(
      MigrationDigestAccumulator.fromState(
        progress.targetPresentBindings,
      ),
    )
    if (
      target.aggregate.mapped !==
        plan.targetPresentBindings.count ||
      target.aggregate.projected !==
        plan.targetPresentBindings.count ||
      target.aggregate.deleted !== 0 ||
      target.aggregate.mapped !==
        applySeal.apply.target.aggregate.mapped ||
      target.aggregate.projected !==
        applySeal.apply.target.aggregate.projected ||
      !sameBindingAggregate(
        observedTargetPresentBindings,
        plan.targetPresentBindings,
      )
    ) {
      return failFullVerification()
    }
    const targetCheckpointDigest =
      createWorkspaceSearchMigrationSourceCheckpointDigest(target)
    const common = {
      kind: 'workspace-search-migration-full-verification-result',
      verificationVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: plan.runId,
      configurationHash: plan.configurationHash,
      planDigest: plan.planDigest,
      planOperationCount: plan.planOperationCount,
      sourceOperationCount: plan.sourceOperationCount,
      orphanOperationCount: plan.orphanOperationCount,
      verificationPlanDigest: plan.verificationPlanDigest,
      applySealDigest: applySeal.sealDigest,
      sealedPlanningAuthorityDigest:
        sealedPlanningAuthority.authorityDigest,
      sourceCheckpointDigests,
      targetCheckpointDigest,
      verification: structuredClone(progress),
      expectedSourceBindings: cloneSourceAggregates(
        plan.sourceBindings,
      ),
      observedSourceBindings: createSourceAggregatesFromStates(
        progress.sourceBindings,
      ),
      expectedTargetPresentBindings: createBindingAggregate(
        MigrationDigestAccumulator.fromState(
          plan.targetPresentBindings.digestState,
        ),
      ),
      observedTargetPresentBindings,
      status: 'pass',
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationResult,
      'resultDigest'
    >
    return {
      ...common,
      resultDigest: createMigrationDigest(common),
    }
  })
}

/**
 * Completes and cross-checks one source chain.
 *
 * @param source - Logical source selected for the comparison.
 * @param plan - Exact plan-derived expectation.
 * @param progress - Terminal independent traversal.
 * @param applySeal - Exact complete apply seal.
 * @param authority - Exact immutable planning authority.
 * @returns Terminal independent checkpoint digest.
 */
function completeSource(
  source: WorkspaceSearchMigrationSourceName,
  plan: WorkspaceSearchMigrationFullVerificationPlan,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  applySeal: WorkspaceSearchMigrationCompleteApplySeal,
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): string {
  const checkpoint = progress.traversal.sources[source]
  requireCleanTerminalCheckpoint(checkpoint)
  const digest = createWorkspaceSearchMigrationSourceCheckpointDigest(
    checkpoint,
  )
  const head = authority.evidenceHeads.find(
    (candidate) => candidate.chain === source,
  )
  if (
    head === undefined ||
    checkpoint.aggregate.mapped !==
      plan.sourceBindings[source].count ||
    checkpoint.aggregate.mapped !==
      applySeal.apply.sources[source].aggregate.mapped ||
    checkpoint.aggregate.projected !==
      applySeal.apply.sources[source].aggregate.projected ||
    checkpoint.aggregate.deleted !==
      applySeal.apply.sources[source].aggregate.deleted ||
    !sameDigestState(
      progress.sourceBindings[source],
      plan.sourceBindings[source].digestState,
    )
  ) {
    return failFullVerification()
  }
  return digest
}

/**
 * Requires a terminal, cursor-free, invalid-free checkpoint.
 *
 * @param checkpoint - Candidate terminal checkpoint.
 */
function requireCleanTerminalCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): void {
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  if (
    !checkpoint.completed ||
    checkpoint.cursor !== undefined ||
    checkpoint.aggregate.invalid !== 0
  ) {
    return failFullVerification()
  }
}

/**
 * Requires the plan, apply seal, and planning authority to identify one run.
 *
 * @param plan - Exact plan-derived expectation.
 * @param applySeal - Exact complete apply seal.
 * @param authority - Exact immutable planning authority.
 */
function requireAuthorityBindings(
  plan: WorkspaceSearchMigrationFullVerificationPlan,
  applySeal: WorkspaceSearchMigrationCompleteApplySeal,
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): void {
  if (
    applySeal.runId !== plan.runId ||
    applySeal.configurationHash !== plan.configurationHash ||
    applySeal.planDigest !== plan.planDigest ||
    applySeal.planOperationCount !== plan.planOperationCount ||
    applySeal.sourceOperationCount !== plan.sourceOperationCount ||
    applySeal.orphanOperationCount !== plan.orphanOperationCount ||
    applySeal.planSealReference.contentDigest !==
      plan.planSealContentDigest ||
    applySeal.sealedPlanningAuthorityDigest !== authority.authorityDigest ||
    authority.runId !== plan.runId ||
    authority.configurationHash !== plan.configurationHash ||
    authority.planDigest !== plan.planDigest ||
    authority.planOperationCount !== plan.planOperationCount ||
    authority.sourceOperationCount !== plan.sourceOperationCount ||
    authority.orphanOperationCount !== plan.orphanOperationCount ||
    authority.planSealReference.contentDigest !==
      plan.planSealContentDigest ||
    serializeCanonicalJson(applySeal.planSealReference) !==
      serializeCanonicalJson(authority.planSealReference) ||
    serializeCanonicalJson(applySeal.tableIds) !==
      serializeCanonicalJson(authority.tableIds)
  ) {
    return failFullVerification()
  }
}

/**
 * Detaches and validates one complete ordered operation list.
 *
 * @param value - Candidate ordered plan operations.
 * @returns Detached strict operations.
 */
function detachPlanOperations(
  value: readonly WorkspaceSearchPlannedOperation[],
): WorkspaceSearchPlannedOperation[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS
  ) {
    return failFullVerification()
  }
  return value.map((planned) =>
    parseWorkspaceSearchPlannedOperation(
      serializeWorkspaceSearchPlannedOperation(planned),
    )
  )
}

/**
 * Requires one canonical verification plan and returns it unchanged.
 *
 * @param plan - Candidate plan-derived expectation.
 * @returns Validated expectation.
 */
function requireVerificationPlan(
  plan: WorkspaceSearchMigrationFullVerificationPlan,
): WorkspaceSearchMigrationFullVerificationPlan {
  const detached = detachFullVerificationGraph(plan)
  requireExactOwnDataKeys(detached, [
    'configurationHash',
    'kind',
    'migrationId',
    'migrationVersion',
    'orphanOperationCount',
    'planDigest',
    'planOperationCount',
    'planSealContentDigest',
    'runId',
    'sourceAbsentKeyDigests',
    'sourceBindings',
    'sourceOperationCount',
    'targetAbsentKeyDigests',
    'targetPresentBindings',
    'verificationPlanDigest',
    'verificationVersion',
  ])
  requireExactOwnDataKeys(
    detached.sourceBindings,
    workspaceSearchMigrationSourceNames,
  )
  requireExactOwnDataKeys(
    detached.sourceAbsentKeyDigests,
    workspaceSearchMigrationSourceNames,
  )
  if (
    detached.kind !==
      'workspace-search-migration-full-verification-plan' ||
    detached.verificationVersion !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION ||
    detached.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    detached.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION ||
    !isHexDigest(detached.configurationHash) ||
    !isHexDigest(detached.planDigest) ||
    !isHexDigest(detached.planSealContentDigest) ||
    !Number.isSafeInteger(detached.planOperationCount) ||
    detached.planOperationCount < 0 ||
    detached.planOperationCount >
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS ||
    !Number.isSafeInteger(detached.sourceOperationCount) ||
    detached.sourceOperationCount < 0 ||
    !Number.isSafeInteger(detached.orphanOperationCount) ||
    detached.orphanOperationCount < 0 ||
    detached.sourceOperationCount + detached.orphanOperationCount !==
      detached.planOperationCount ||
    !hasCanonicalDenseArrayShape(detached.targetAbsentKeyDigests) ||
    detached.targetAbsentKeyDigests.length >
      WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS ||
    !detached.targetAbsentKeyDigests.every(isHexDigest) ||
    !isStrictlySorted(detached.targetAbsentKeyDigests) ||
    !isHexDigest(detached.verificationPlanDigest)
  ) {
    return failFullVerification()
  }
  requireMigrationIdentifier(detached.runId, 'verification run ID')
  let expectedPresentSourceOperationCount = 0
  let expectedAbsentSourceOperationCount = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    const aggregate = detached.sourceBindings[source]
    requireBindingAggregate(aggregate)
    const absentKeys = detached.sourceAbsentKeyDigests[source]
    if (
      !hasCanonicalDenseArrayShape(absentKeys) ||
      absentKeys.length >
        WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS ||
      !absentKeys.every(isHexDigest) ||
      !isStrictlySorted(absentKeys)
    ) {
      return failFullVerification()
    }
    expectedPresentSourceOperationCount += aggregate.count
    expectedAbsentSourceOperationCount += absentKeys.length
  }
  requireBindingAggregate(detached.targetPresentBindings)
  if (
    expectedPresentSourceOperationCount !==
      detached.sourceOperationCount ||
    expectedAbsentSourceOperationCount !==
      detached.orphanOperationCount ||
    detached.targetPresentBindings.count +
      detached.targetAbsentKeyDigests.length !==
      detached.planOperationCount
  ) {
    return failFullVerification()
  }
  const {
    verificationPlanDigest: _verificationPlanDigest,
    ...common
  } = detached
  if (
    createMigrationDigest(common) !== detached.verificationPlanDigest
  ) {
    return failFullVerification()
  }
  return detached
}

/**
 * Requires progress to remain bound to one plan and valid checkpoints.
 *
 * @param progress - Candidate resumable progress.
 * @param plan - Exact plan-derived expectation.
 * @returns Validated progress.
 */
function requireVerificationProgress(
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  plan: WorkspaceSearchMigrationFullVerificationPlan,
): WorkspaceSearchMigrationFullVerificationProgress {
  const detached = detachFullVerificationGraph(progress)
  requireExactOwnDataKeys(detached, [
    'configurationHash',
    'kind',
    'planDigest',
    'runId',
    'sourceBindings',
    'targetPresentBindings',
    'traversal',
    'verificationPlanDigest',
    'verificationVersion',
  ])
  requireExactOwnDataKeys(
    detached.sourceBindings,
    workspaceSearchMigrationSourceNames,
  )
  requireExactOwnDataKeys(detached.traversal, ['sources', 'target'])
  requireExactOwnDataKeys(
    detached.traversal.sources,
    workspaceSearchMigrationSourceNames,
  )
  if (
    detached.kind !==
      'workspace-search-migration-full-verification-progress' ||
    detached.verificationVersion !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION ||
    detached.runId !== plan.runId ||
    detached.configurationHash !== plan.configurationHash ||
    detached.planDigest !== plan.planDigest ||
    detached.verificationPlanDigest !== plan.verificationPlanDigest
  ) {
    return failFullVerification()
  }
  for (const source of workspaceSearchMigrationSourceNames) {
    const checkpoint = detached.traversal.sources[source]
    requireCheckpointShape(checkpoint)
    validateWorkspaceSearchMigrationCheckpoint(checkpoint)
    const accumulator = MigrationDigestAccumulator.fromState(
      detached.sourceBindings[source],
    )
    requireDigestStateShape(detached.sourceBindings[source])
    if (accumulator.size() !== checkpoint.aggregate.mapped) {
      return failFullVerification()
    }
  }
  requireCheckpointShape(detached.traversal.target)
  validateWorkspaceSearchMigrationCheckpoint(detached.traversal.target)
  requireDigestStateShape(detached.targetPresentBindings)
  const targetAccumulator = MigrationDigestAccumulator.fromState(
    detached.targetPresentBindings,
  )
  if (
    targetAccumulator.size() !==
      detached.traversal.target.aggregate.mapped
  ) {
    return failFullVerification()
  }
  return detached
}

/**
 * Requires the caller configuration digest to match the verification plan.
 *
 * @param plan - Exact plan-derived expectation.
 * @param configurationHash - Caller-supplied measured configuration digest.
 */
function requireIdentity(
  plan: WorkspaceSearchMigrationFullVerificationPlan,
  configurationHash: string,
): void {
  if (configurationHash !== plan.configurationHash) {
    return failFullVerification()
  }
}

/**
 * Creates fresh source accumulators in the fixed source order.
 *
 * @returns Mutable accumulator record owned by plan construction.
 */
function createSourceAccumulators(): Record<
  WorkspaceSearchMigrationSourceName,
  MigrationDigestAccumulator
> {
  return {
    'project-directory': new MigrationDigestAccumulator(),
    'work-items': new MigrationDigestAccumulator(),
    collaboration: new MigrationDigestAccumulator(),
    documents: new MigrationDigestAccumulator(),
  }
}

/**
 * Creates one independently owned empty accumulator state.
 *
 * @returns Fresh zero-count digest state.
 */
function createEmptyDigestState(): MigrationDigestState {
  return new MigrationDigestAccumulator().exportState()
}

/**
 * Creates mutable absent-source key lists in the fixed source order.
 *
 * @returns Empty digest lists owned by plan construction.
 */
function createSourceDigestLists(): Record<
  WorkspaceSearchMigrationSourceName,
  string[]
> {
  return {
    'project-directory': [],
    'work-items': [],
    collaboration: [],
    documents: [],
  }
}

/**
 * Freezes the exact aggregate view of every source accumulator.
 *
 * @param accumulators - Mutable plan-construction accumulators.
 * @returns Detached immutable source aggregate record.
 */
function createSourceAggregates(
  accumulators: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      MigrationDigestAccumulator
    >
  >,
): Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    WorkspaceSearchMigrationVerificationBindingAggregate
  >
> {
  return {
    'project-directory': createBindingAggregate(
      accumulators['project-directory'],
    ),
    'work-items': createBindingAggregate(accumulators['work-items']),
    collaboration: createBindingAggregate(accumulators.collaboration),
    documents: createBindingAggregate(accumulators.documents),
  }
}

/**
 * Reconstructs canonical source aggregates from resumable digest states.
 *
 * @param states - Exact digest states grouped by source.
 * @returns Detached immutable source aggregate record.
 */
function createSourceAggregatesFromStates(
  states: Readonly<
    Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
  >,
): Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    WorkspaceSearchMigrationVerificationBindingAggregate
  >
> {
  return {
    'project-directory': createBindingAggregate(
      MigrationDigestAccumulator.fromState(
        states['project-directory'],
      ),
    ),
    'work-items': createBindingAggregate(
      MigrationDigestAccumulator.fromState(states['work-items']),
    ),
    collaboration: createBindingAggregate(
      MigrationDigestAccumulator.fromState(states.collaboration),
    ),
    documents: createBindingAggregate(
      MigrationDigestAccumulator.fromState(states.documents),
    ),
  }
}

/**
 * Clones and revalidates canonical source binding aggregates.
 *
 * @param aggregates - Candidate aggregates grouped by source.
 * @returns Detached immutable source aggregate record.
 */
function cloneSourceAggregates(
  aggregates: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationVerificationBindingAggregate
    >
  >,
): Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    WorkspaceSearchMigrationVerificationBindingAggregate
  >
> {
  for (const source of workspaceSearchMigrationSourceNames) {
    requireBindingAggregate(aggregates[source])
  }
  return createSourceAggregatesFromStates({
    'project-directory': aggregates['project-directory'].digestState,
    'work-items': aggregates['work-items'].digestState,
    collaboration: aggregates.collaboration.digestState,
    documents: aggregates.documents.digestState,
  })
}

/**
 * Creates one canonical binding aggregate.
 *
 * @param accumulator - Exact resumable accumulator.
 * @returns Count, state, and derived digest.
 */
function createBindingAggregate(
  accumulator: MigrationDigestAccumulator,
): WorkspaceSearchMigrationVerificationBindingAggregate {
  return {
    count: accumulator.size(),
    digestState: accumulator.exportState(),
    digest: accumulator.digest(),
  }
}

/**
 * Requires one binding aggregate to be internally consistent.
 *
 * @param aggregate - Candidate aggregate.
 */
function requireBindingAggregate(
  aggregate: WorkspaceSearchMigrationVerificationBindingAggregate,
): void {
  requireExactOwnDataKeys(aggregate, [
    'count',
    'digest',
    'digestState',
  ])
  requireDigestStateShape(aggregate.digestState)
  const accumulator = MigrationDigestAccumulator.fromState(
    aggregate.digestState,
  )
  if (
    aggregate.count !== accumulator.size() ||
    aggregate.digest !== accumulator.digest()
  ) {
    return failFullVerification()
  }
}

/**
 * Requires one source name from the fixed allowlist.
 *
 * @param source - Candidate source name.
 */
function requireSourceName(
  source: WorkspaceSearchMigrationSourceName,
): void {
  if (!workspaceSearchMigrationSourceNames.includes(source)) {
    return failFullVerification()
  }
}

/**
 * Requires exact digest-only source binding fields.
 *
 * @param binding - Candidate source binding.
 */
function requireSourceBinding(
  binding: WorkspaceSearchMigrationSourceOwnershipBinding,
): void {
  requireExactOwnDataKeys(binding, [
    'sourceItemDigest',
    'sourceKeyDigest',
    'targetAction',
    'targetKeyDigest',
  ])
  if (
    !isHexDigest(binding.sourceKeyDigest) ||
    !isHexDigest(binding.sourceItemDigest) ||
    !isHexDigest(binding.targetKeyDigest) ||
    (binding.targetAction !== 'put' &&
      binding.targetAction !== 'delete')
  ) {
    return failFullVerification()
  }
}

/**
 * Requires exact digest-only target binding fields.
 *
 * @param binding - Candidate target binding.
 */
function requireTargetBinding(
  binding: WorkspaceSearchMigrationObservedTargetBinding,
): void {
  requireExactOwnDataKeys(binding, [
    'targetItemDigest',
    'targetKeyDigest',
  ])
  if (
    !isHexDigest(binding.targetKeyDigest) ||
    !isHexDigest(binding.targetItemDigest)
  ) {
    return failFullVerification()
  }
}

/**
 * Replaces one source checkpoint without an unsafe indexed assertion.
 *
 * @param sources - Previous fixed source checkpoint record.
 * @param source - Source whose checkpoint advances.
 * @param checkpoint - Exact successor checkpoint.
 * @returns Detached fixed source checkpoint record.
 */
function replaceSourceCheckpoint(
  sources: WorkspaceSearchMigrationTraversalProgress['sources'],
  source: WorkspaceSearchMigrationSourceName,
  checkpoint: MigrationSourceCheckpoint,
): WorkspaceSearchMigrationTraversalProgress['sources'] {
  return {
    'project-directory': source === 'project-directory'
      ? checkpoint
      : sources['project-directory'],
    'work-items': source === 'work-items'
      ? checkpoint
      : sources['work-items'],
    collaboration: source === 'collaboration'
      ? checkpoint
      : sources.collaboration,
    documents: source === 'documents'
      ? checkpoint
      : sources.documents,
  }
}

/**
 * Replaces one source binding state without an unsafe indexed assertion.
 *
 * @param states - Previous fixed source binding states.
 * @param source - Source whose accumulator advances.
 * @param state - Exact successor accumulator state.
 * @returns Detached fixed source binding state record.
 */
function replaceSourceDigestState(
  states: Readonly<
    Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
  >,
  source: WorkspaceSearchMigrationSourceName,
  state: MigrationDigestState,
): Readonly<
  Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
> {
  return {
    'project-directory': source === 'project-directory'
      ? state
      : states['project-directory'],
    'work-items': source === 'work-items'
      ? state
      : states['work-items'],
    collaboration: source === 'collaboration'
      ? state
      : states.collaboration,
    documents: source === 'documents'
      ? state
      : states.documents,
  }
}

/**
 * Compares two complete resumable digest states.
 *
 * @param left - First exact digest state.
 * @param right - Second exact digest state.
 * @returns Whether count, sum, and XOR are identical.
 */
function sameDigestState(
  left: MigrationDigestState,
  right: MigrationDigestState,
): boolean {
  return (
    left.count === right.count &&
    left.sumHex === right.sumHex &&
    left.xorHex === right.xorHex
  )
}

/**
 * Compares two exact binding aggregates.
 *
 * @param left - First canonical aggregate.
 * @param right - Second canonical aggregate.
 * @returns Whether count, state, and digest are identical.
 */
function sameBindingAggregate(
  left: WorkspaceSearchMigrationVerificationBindingAggregate,
  right: WorkspaceSearchMigrationVerificationBindingAggregate,
): boolean {
  return (
    left.count === right.count &&
    left.digest === right.digest &&
    sameDigestState(left.digestState, right.digestState)
  )
}

/**
 * Checks one digest against a strictly sorted digest list without allocation.
 *
 * @param values - Strictly UTF-8-ordinal-sorted lowercase digests.
 * @param candidate - Digest being located.
 * @returns Whether the exact digest occurs in the list.
 */
function includesSortedDigest(
  values: readonly string[],
  candidate: string,
): boolean {
  let lower = 0
  let upper = values.length - 1
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    const current = values[middle]
    if (current === undefined) return false
    const order = compareUtf8Ordinal(candidate, current)
    if (order === 0) return true
    if (order < 0) {
      upper = middle - 1
    } else {
      lower = middle + 1
    }
  }
  return false
}

/**
 * Checks strict UTF-8 ordinal ordering without duplicates.
 *
 * @param values - Candidate sorted digest list.
 * @returns Whether every value follows its predecessor.
 */
function isStrictlySorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (
      previous === undefined ||
      current === undefined ||
      compareUtf8Ordinal(previous, current) >= 0
    ) {
      return false
    }
  }
  return true
}

/**
 * Compares strings by their UTF-8 bytes.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive ordering value.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Requires the exact shape of one resumable verification checkpoint.
 *
 * @param checkpoint - Detached checkpoint being validated.
 */
function requireCheckpointShape(
  checkpoint: MigrationSourceCheckpoint,
): void {
  const hasCursor = Object.prototype.hasOwnProperty.call(
    checkpoint,
    'cursor',
  )
  if (hasCursor && checkpoint.cursor === undefined) {
    return failFullVerification()
  }
  requireExactOwnDataKeys(
    checkpoint,
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
  requireExactOwnDataKeys(checkpoint.aggregate, [
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
  requireDigestStateShape(checkpoint.keyDigestState)
  requireDigestStateShape(checkpoint.contentDigestState)
}

/**
 * Requires the exact structural keys of one accumulator state.
 *
 * @param state - Detached restorable digest state.
 */
function requireDigestStateShape(state: MigrationDigestState): void {
  requireExactOwnDataKeys(state, ['count', 'sumHex', 'xorHex'])
}

/**
 * Requires an ordinary object to contain exactly the expected enumerable data
 * properties.
 *
 * @param value - Object being checked.
 * @param expected - Complete expected own-string-key set.
 */
function requireExactOwnDataKeys(
  value: object,
  expected: readonly string[],
): void {
  if (
    nodeUtilTypes.isProxy(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    return failFullVerification()
  }
  const actual = Reflect.ownKeys(value)
  if (
    actual.length !== expected.length ||
    actual.some((key) =>
      typeof key !== 'string' || !expected.includes(key)
    )
  ) {
    return failFullVerification()
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failFullVerification()
    }
  }
}

/**
 * Copies a caller-owned plan or progress after rejecting active behavior.
 *
 * @param value - Caller-owned typed graph.
 * @returns Detached graph of the same static type.
 */
function detachFullVerificationGraph<Value>(value: Value): Value {
  inspectFullVerificationGraph(value, {
    nodes: 0,
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
  })
  return structuredClone(value)
}

/**
 * Proves one bounded graph contains only ordinary data objects and dense
 * arrays, rejecting proxies, accessors, symbols, cycles, and exotic objects.
 *
 * @param value - Current graph value.
 * @param budget - Shared graph traversal budget.
 */
function inspectFullVerificationGraph(
  value: unknown,
  budget: FullVerificationGraphBudget,
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failFullVerification()
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value)
  ) {
    return failFullVerification()
  }
  if (budget.visited.has(value)) return
  budget.nodes += 1
  if (budget.nodes > maximumFullVerificationGraphNodes) {
    return failFullVerification()
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (
      value.length > WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_OPERATIONS ||
      !hasCanonicalDenseArrayShape(value)
    ) {
      return failFullVerification()
    }
    for (const candidate of value) {
      inspectFullVerificationGraph(candidate, budget)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return failFullVerification()
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return failFullVerification()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return failFullVerification()
      }
      inspectFullVerificationGraph(descriptor.value, budget)
    }
  }
  budget.active.delete(value)
  budget.visited.add(value)
}

/**
 * Executes one public operation behind a fixed secret-free failure boundary.
 *
 * @param operation - Trusted implementation callback.
 * @returns Callback result.
 */
function atFullVerificationBoundary<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    return failFullVerification()
  }
}

/**
 * Raises the stable full-verification failure.
 *
 * @returns Never returns.
 */
function failFullVerification(): never {
  throw new WorkspaceSearchMigrationFailure(
    'VERIFY_FAILED',
    'Workspace Search full verification failed.',
  )
}
