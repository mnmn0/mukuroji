import { describe, expect, test } from 'bun:test'
import {
  createWorkItemWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  completeWorkspaceSearchMigrationFullVerification,
  createEmptyWorkspaceSearchMigrationFullVerificationProgress,
  createWorkspaceSearchMigrationFullVerificationPlan,
  reduceWorkspaceSearchMigrationFullVerificationSourcePage,
  reduceWorkspaceSearchMigrationFullVerificationTargetPage,
  type WorkspaceSearchMigrationFullVerificationPlan,
  type WorkspaceSearchMigrationFullVerificationProgress,
} from './migration-full-verification'
import {
  type WorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationOrphanCandidate,
  createWorkspaceSearchMigrationSourceCandidate,
  type WorkspaceSearchMigrationPlanCandidate,
} from './migration-planner'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'
import {
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'

const runId = 'full-verification-run'
const retainUntil = '2026-09-01T00:00:00.000Z'

/** Complete plan and scan material shared by full-verification tests. */
type VerificationFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Active source item whose target must remain present. */
  readonly activeSourceItem: DynamoAttributeMap
  /** Archived source item whose target must remain absent. */
  readonly archivedSourceItem: DynamoAttributeMap
  /** Exact intended present target item. */
  readonly expectedTargetItem: DynamoAttributeMap
  /** Same logical archived entity represented as a stale residual target. */
  readonly residualDeletedTargetItem: DynamoAttributeMap
  /** Target-only Work Item projection planned for orphan deletion. */
  readonly orphanTargetItem: DynamoAttributeMap
  /** Canonical source row whose key must remain absent for the orphan. */
  readonly orphanSourceItem: DynamoAttributeMap
  /** Exact strict plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Plan-derived verification expectation. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
}

describe('Workspace Search migration full verification', () => {
  test('derives present source, present target, and absent target evidence', () => {
    const fixture = createFixture()

    expect(
      fixture.plan.sourceBindings['project-directory'].count,
    ).toBe(2)
    expect(fixture.plan.sourceBindings['work-items'].count).toBe(0)
    expect(fixture.plan.sourceAbsentKeyDigests['work-items'])
      .toHaveLength(1)
    expect(fixture.plan.targetPresentBindings.count).toBe(1)
    expect(fixture.plan.targetAbsentKeyDigests).toHaveLength(2)
    expect(fixture.plan).toMatchObject({
      planOperationCount: 3,
      sourceOperationCount: 2,
      orphanOperationCount: 1,
    })
  })

  test('passes exact five-location rescans while allowing unrelated ignored target rows', () => {
    const fixture = createFixture()
    const progress = completeTraversal(
      fixture,
      [fixture.expectedTargetItem, createIgnoredTargetItem('view')],
    )
    const authority = createAuthority(fixture, progress)
    const applySeal = createApplySeal(fixture, progress, authority)

    const result = completeWorkspaceSearchMigrationFullVerification({
      plan: fixture.plan,
      progress,
      applySeal,
      sealedPlanningAuthority: authority,
    })

    expect(result).toMatchObject({
      runId,
      configurationHash: fixture.configurationHash,
      planDigest: fixture.plan.planDigest,
      verificationPlanDigest: fixture.plan.verificationPlanDigest,
      status: 'pass',
      expectedSourceBindings: {
        'project-directory': { count: 2 },
      },
      observedSourceBindings: {
        'project-directory': { count: 2 },
      },
      expectedTargetPresentBindings: { count: 1 },
      observedTargetPresentBindings: { count: 1 },
    })
    expect(result.resultDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.targetCheckpointDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('keeps pair evidence stable across page splits and resume', () => {
    const fixture = createFixture()
    let split = completeSources(
      fixture,
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      ),
    )
    const ignored = createIgnoredTargetItem('first-page')
    split = reduceWorkspaceSearchMigrationFullVerificationTargetPage({
      plan: fixture.plan,
      progress: split,
      configuration: fixture.configuration,
      configurationHash: fixture.configurationHash,
      page: {
        items: [ignored],
        lastEvaluatedKey: targetKey(ignored),
      },
    })
    split = reduceWorkspaceSearchMigrationFullVerificationTargetPage({
      plan: fixture.plan,
      progress: split,
      configuration: fixture.configuration,
      configurationHash: fixture.configurationHash,
      page: { items: [fixture.expectedTargetItem] },
    })
    const single = completeTraversal(
      fixture,
      [fixture.expectedTargetItem, ignored],
    )

    expect(split.targetPresentBindings)
      .toEqual(single.targetPresentBindings)
    expect(split.traversal.target.aggregate).toEqual({
      ...single.traversal.target.aggregate,
      pageCount: 2,
    })
  })

  test('rejects a residual target for a planned source deletion on its page', () => {
    const fixture = createFixture()
    const progress = completeSources(
      fixture,
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      ),
    )

    expectVerifyFailure(() =>
      reduceWorkspaceSearchMigrationFullVerificationTargetPage({
        plan: fixture.plan,
        progress,
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        page: {
          items: [
            fixture.expectedTargetItem,
            fixture.residualDeletedTargetItem,
          ],
        },
      })
    )
  })

  test('rejects stale target content and tampered binding progress', () => {
    const fixture = createFixture()
    const staleTarget = {
      ...fixture.expectedTargetItem,
      title: { S: 'stale-title' },
    }
    const stale = completeTraversal(fixture, [staleTarget])
    const staleAuthority = createAuthority(fixture, stale)
    const staleSeal = createApplySeal(
      fixture,
      stale,
      staleAuthority,
    )
    expectVerifyFailure(() =>
      completeWorkspaceSearchMigrationFullVerification({
        plan: fixture.plan,
        progress: stale,
        applySeal: staleSeal,
        sealedPlanningAuthority: staleAuthority,
      })
    )

    const exact = completeTraversal(
      fixture,
      [fixture.expectedTargetItem],
    )
    const tampered = structuredClone(exact)
    tampered.targetPresentBindings.sumHex = 'f'.repeat(64)
    const authority = createAuthority(fixture, exact)
    const seal = createApplySeal(fixture, exact, authority)
    expectVerifyFailure(() =>
      completeWorkspaceSearchMigrationFullVerification({
        plan: fixture.plan,
        progress: tampered,
        applySeal: seal,
        sealedPlanningAuthority: authority,
      })
    )
  })

  test('rejects mapped or invalid rows at an orphan source key', () => {
    const fixture = createFixture()
    const initial =
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      )
    for (const item of [
      fixture.orphanSourceItem,
      {
        ...fixture.orphanSourceItem,
        schemaVersion: { N: '2' },
      },
    ]) {
      expectVerifyFailure(() =>
        reduceWorkspaceSearchMigrationFullVerificationSourcePage({
          plan: fixture.plan,
          progress: initial,
          configuration: fixture.configuration,
          configurationHash: fixture.configurationHash,
          source: 'work-items',
          page: { items: [item] },
        })
      )
    }
  })

  test('rejects missing planned source or target bindings', () => {
    const fixture = createFixture()
    const initial =
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      )
    const missingSource = completeSources(
      fixture,
      initial,
      [fixture.archivedSourceItem],
    )
    const missingSourceTraversal =
      reduceWorkspaceSearchMigrationFullVerificationTargetPage({
        plan: fixture.plan,
        progress: missingSource,
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        page: { items: [fixture.expectedTargetItem] },
      })
    expectCompletionFailure(fixture, missingSourceTraversal)

    const missingTarget = completeTraversal(fixture, [])
    expectCompletionFailure(fixture, missingTarget)
  })

  test('allows an unrelated TTL row to change after apply', () => {
    const fixture = createFixture()
    const applied = completeTraversal(
      fixture,
      [fixture.expectedTargetItem],
    )
    const authority = createAuthority(fixture, applied)
    const applySeal = createApplySeal(fixture, applied, authority)
    const verifiedSources = completeSources(
      fixture,
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      ),
      undefined,
      [],
      [createIgnoredCollaborationItem()],
    )
    const verified =
      reduceWorkspaceSearchMigrationFullVerificationTargetPage({
        plan: fixture.plan,
        progress: verifiedSources,
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        page: { items: [fixture.expectedTargetItem] },
      })

    const result = completeWorkspaceSearchMigrationFullVerification({
      plan: fixture.plan,
      progress: verified,
      applySeal,
      sealedPlanningAuthority: authority,
    })

    expect(result.status).toBe('pass')
    expect(
      result.verification.traversal.sources.collaboration.aggregate
        .ignored,
    ).toBe(1)
  })

  test('allows an unrelated target row to change after apply', () => {
    const fixture = createFixture()
    const applied = completeTraversal(
      fixture,
      [fixture.expectedTargetItem],
    )
    const authority = createAuthority(fixture, applied)
    const applySeal = createApplySeal(fixture, applied, authority)
    const verified = completeTraversal(
      fixture,
      [
        fixture.expectedTargetItem,
        createIgnoredTargetItem('post-apply'),
      ],
    )

    const result = completeWorkspaceSearchMigrationFullVerification({
      plan: fixture.plan,
      progress: verified,
      applySeal,
      sealedPlanningAuthority: authority,
    })

    expect(result.status).toBe('pass')
    expect(result.verification.traversal.target.aggregate.ignored)
      .toBe(1)
  })

  test('rejects self-consistent cardinality lies and plan switches', () => {
    const fixture = createFixture()
    const {
      verificationPlanDigest: _verificationPlanDigest,
      ...planCommon
    } = fixture.plan
    const inconsistentCommon = {
      ...planCommon,
      sourceOperationCount: 1,
      orphanOperationCount: 2,
    }
    const inconsistent = {
      ...inconsistentCommon,
      verificationPlanDigest: createMigrationDigest(
        inconsistentCommon,
      ),
    }
    expectVerifyFailure(() =>
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        inconsistent,
      )
    )

    const {
      verificationPlanDigest: _originalVerificationPlanDigest,
      ...alternateCommonBase
    } = fixture.plan
    const alternateCommon = {
      ...alternateCommonBase,
      sourceAbsentKeyDigests: {
        ...alternateCommonBase.sourceAbsentKeyDigests,
        'work-items': [digest('alternate-absent-source-key')],
      },
    }
    const switched = {
      ...alternateCommon,
      verificationPlanDigest: createMigrationDigest(alternateCommon),
    }
    const progress =
      createEmptyWorkspaceSearchMigrationFullVerificationProgress(
        fixture.plan,
      )
    expect(switched.planDigest).toBe(fixture.plan.planDigest)
    expect(switched.verificationPlanDigest)
      .not.toBe(fixture.plan.verificationPlanDigest)
    expectVerifyFailure(() =>
      reduceWorkspaceSearchMigrationFullVerificationSourcePage({
        plan: switched,
        progress,
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        source: 'project-directory',
        page: { items: [] },
      })
    )
  })

  test('rejects altered apply-seal references and extra progress state', () => {
    const fixture = createFixture()
    const progress = completeTraversal(
      fixture,
      [fixture.expectedTargetItem],
    )
    const authority = createAuthority(fixture, progress)
    const applySeal = createApplySeal(fixture, progress, authority)
    const {
      sealDigest: _sealDigest,
      ...sealCommon
    } = applySeal
    const alteredCommon = {
      ...sealCommon,
      planSealReference: {
        ...sealCommon.planSealReference,
        versionId: 'different-version',
      },
    }
    const alteredSeal = {
      ...alteredCommon,
      sealDigest: createMigrationDigest(alteredCommon),
    }
    expectVerifyFailure(() =>
      completeWorkspaceSearchMigrationFullVerification({
        plan: fixture.plan,
        progress,
        applySeal: alteredSeal,
        sealedPlanningAuthority: authority,
      })
    )

    const progressWithExtraState = {
      ...progress,
      unexpected: 'must-not-propagate',
    }
    expectVerifyFailure(() =>
      completeWorkspaceSearchMigrationFullVerification({
        plan: fixture.plan,
        progress: progressWithExtraState,
        applySeal,
        sealedPlanningAuthority: authority,
      })
    )
  })
})

/**
 * Creates the exact source-and-orphan plan used by full-verification tests.
 *
 * @returns Complete measured, source, target, and plan material.
 */
function createFixture(): VerificationFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const activeSourceItem = createTeamItem('active')
  const archivedSourceItem = createTeamItem(
    'archived',
    '2026-07-29T00:00:00.000Z',
  )
  const residualSourceItem = createTeamItem('archived')
  const orphanIssueId = 'orphan'
  const orphanSourceItem = createWorkItemSourceItem(orphanIssueId)
  const orphanTargetItem = encodeWorkspaceSearchMigrationDocument(
    createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: orphanIssueId,
      title: 'Orphan Work Item',
    }),
  )
  const orphanCandidate =
    createWorkspaceSearchMigrationOrphanCandidate({
      configurationHash,
      sourceTable: configuration.tables['work-items'],
      targetItem: orphanTargetItem,
    })
  if (orphanCandidate === undefined) {
    throw new Error('Expected one recoverable orphan candidate.')
  }
  const candidates: readonly WorkspaceSearchMigrationPlanCandidate[] = [
    createSourceCandidate(
      configuration,
      configurationHash,
      activeSourceItem,
    ),
    createSourceCandidate(
      configuration,
      configurationHash,
      archivedSourceItem,
    ),
    orphanCandidate,
  ]
  const residualCandidate = createSourceCandidate(
    configuration,
    configurationHash,
    residualSourceItem,
  )
  const { operations, planDigest } = createPlannedOperations(
    configurationHash,
    candidates,
  )
  const planSeal: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest,
    planOperationCount: operations.length,
    sourceOperationCount: 2,
    orphanOperationCount: 1,
    createdAt: '2026-07-29T01:00:00.000Z',
  }
  const activeAfter = candidates[0]?.operation.after
  const residualAfter = residualCandidate.operation.after
  if (
    activeAfter?.exists !== true ||
    residualAfter.exists !== true
  ) {
    throw new Error('Expected present target fixture states.')
  }
  return {
    configuration,
    configurationHash,
    activeSourceItem,
    archivedSourceItem,
    expectedTargetItem: activeAfter.item,
    residualDeletedTargetItem: residualAfter.item,
    orphanTargetItem,
    orphanSourceItem,
    planSeal,
    plan: createWorkspaceSearchMigrationFullVerificationPlan({
      planSeal,
      operations,
    }),
  }
}

/**
 * Creates one source-origin plan candidate from a Project Directory row.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param sourceItem - Exact Project Directory source item.
 * @returns Exact source-owned plan candidate.
 */
function createSourceCandidate(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  sourceItem: DynamoAttributeMap,
) {
  const candidate = createWorkspaceSearchMigrationSourceCandidate({
    configurationHash,
    source: 'project-directory',
    sourceTable: configuration.tables['project-directory'],
    sourceItem,
  })
  if (candidate === undefined) {
    throw new Error('Expected one mapped source candidate.')
  }
  return candidate
}

/**
 * Builds one exact Merkle plan for an ordered candidate list.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param candidates - Complete ordered source and orphan candidates.
 * @returns Exact root and membership-bound planned operations.
 */
function createPlannedOperations(
  configurationHash: string,
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): {
  /** Merkle root of the complete ordered plan. */
  readonly planDigest: string
  /** Exact operations with stable sequences and membership proofs. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
} {
  const operationDigests = candidates.map(({ operation }) =>
    createWorkspaceSearchMigrationOperationDigest(operation)
  )
  const leaves = operationDigests.map((operationDigest, index) =>
    createWorkspaceSearchPlanLeafDigest({
      planSequence: index + 1,
      operationDigest,
    })
  )
  const levels = createMerkleLevels(leaves)
  const planDigest = levels.at(-1)?.[0]
  if (planDigest === undefined) {
    throw new Error('Expected one nonempty Merkle plan.')
  }
  const operations = candidates.map((candidate, index) => {
    const operationDigest = operationDigests[index]
    if (operationDigest === undefined) {
      throw new Error('Expected one operation digest per candidate.')
    }
    return {
      runId,
      configurationHash,
      planDigest,
      planSequence: index + 1,
      operationDigest,
      membershipProof: createMembershipProof(levels, index),
      operation: candidate.operation,
    } satisfies WorkspaceSearchPlannedOperation
  })
  return { planDigest, operations }
}

/**
 * Builds duplicate-last Merkle levels for one nonempty leaf list.
 *
 * @param leaves - Ordered plan-leaf digests.
 * @returns Levels from leaves through the one-node root.
 */
function createMerkleLevels(
  leaves: readonly string[],
): readonly (readonly string[])[] {
  if (leaves.length === 0) {
    throw new Error('Expected nonempty plan leaves.')
  }
  const levels: string[][] = [[...leaves]]
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const current = levels.at(-1)
    if (current === undefined) {
      throw new Error('Expected one current Merkle level.')
    }
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]
      const right = current[index + 1] ?? left
      if (left === undefined || right === undefined) {
        throw new Error('Expected one complete Merkle pair.')
      }
      next.push(createWorkspaceSearchPlanNodeDigest(left, right))
    }
    levels.push(next)
  }
  return levels
}

/**
 * Creates one duplicate-last Merkle sibling path.
 *
 * @param levels - Complete Merkle levels from leaves to root.
 * @param leafIndex - Zero-based leaf position.
 * @returns Exact membership proof for the selected leaf.
 */
function createMembershipProof(
  levels: readonly (readonly string[])[],
  leafIndex: number,
): WorkspaceSearchPlannedOperation['membershipProof'] {
  const proof:
    WorkspaceSearchPlannedOperation['membershipProof'][number][] = []
  let currentIndex = leafIndex
  for (
    let levelIndex = 0;
    levelIndex < levels.length - 1;
    levelIndex += 1
  ) {
    const level = levels[levelIndex]
    if (level === undefined) {
      throw new Error('Expected one Merkle proof level.')
    }
    const isLeft = currentIndex % 2 === 0
    const siblingIndex = isLeft
      ? Math.min(currentIndex + 1, level.length - 1)
      : currentIndex - 1
    const sibling = level[siblingIndex]
    if (sibling === undefined) {
      throw new Error('Expected one Merkle sibling.')
    }
    proof.push({
      side: isLeft ? 'right' : 'left',
      digest: sibling,
    })
    currentIndex = Math.floor(currentIndex / 2)
  }
  return proof
}

/**
 * Completes all four source scans from fresh independent progress.
 *
 * @param fixture - Exact plan and measured scan material.
 * @param initial - Fresh or resumed verification progress.
 * @param projectDirectoryItems - Exact Project Directory rescan rows.
 * @param workItemItems - Exact Work Item rescan rows.
 * @param collaborationItems - Exact Collaboration rescan rows.
 * @returns Progress with every source terminal.
 */
function completeSources(
  fixture: VerificationFixture,
  initial: WorkspaceSearchMigrationFullVerificationProgress,
  projectDirectoryItems: readonly DynamoAttributeMap[] = [
    fixture.activeSourceItem,
    fixture.archivedSourceItem,
  ],
  workItemItems: readonly DynamoAttributeMap[] = [],
  collaborationItems: readonly DynamoAttributeMap[] = [],
): WorkspaceSearchMigrationFullVerificationProgress {
  let progress = reduceWorkspaceSearchMigrationFullVerificationSourcePage({
    plan: fixture.plan,
    progress: initial,
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    source: 'project-directory',
    page: { items: projectDirectoryItems },
  })
  progress = reduceWorkspaceSearchMigrationFullVerificationSourcePage({
    plan: fixture.plan,
    progress,
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    source: 'work-items',
    page: { items: workItemItems },
  })
  progress = reduceWorkspaceSearchMigrationFullVerificationSourcePage({
    plan: fixture.plan,
    progress,
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    source: 'collaboration',
    page: { items: collaborationItems },
  })
  progress = reduceWorkspaceSearchMigrationFullVerificationSourcePage({
    plan: fixture.plan,
    progress,
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    source: 'documents',
    page: { items: [] },
  })
  return progress
}

/**
 * Completes the five-location verification traversal.
 *
 * @param fixture - Exact plan and measured scan material.
 * @param targetItems - Exact raw target rows returned by the terminal page.
 * @returns Terminal independent verification progress.
 */
function completeTraversal(
  fixture: VerificationFixture,
  targetItems: readonly DynamoAttributeMap[],
): WorkspaceSearchMigrationFullVerificationProgress {
  const sources = completeSources(
    fixture,
    createEmptyWorkspaceSearchMigrationFullVerificationProgress(
      fixture.plan,
    ),
  )
  return reduceWorkspaceSearchMigrationFullVerificationTargetPage({
    plan: fixture.plan,
    progress: sources,
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    page: { items: targetItems },
  })
}

/**
 * Creates one strict compact sealed planning authority for terminal progress.
 *
 * @param fixture - Exact plan and measured configuration.
 * @param progress - Terminal verification progress mirrored by planning heads.
 * @returns Internally consistent compact authority.
 */
function createAuthority(
  fixture: VerificationFixture,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const evidenceHeads:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2['evidenceHeads'] = [
    ...([
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
    ] satisfies readonly WorkspaceSearchMigrationSourceName[]).map(
      (source) => ({
        chain: source,
        progressDigest: digest(`progress:${source}`),
        pageCount:
          progress.traversal.sources[source].aggregate.pageCount,
        terminalEvidenceDigest: digest(`evidence:${source}`),
        terminalCheckpointDigest:
          createWorkspaceSearchMigrationSourceCheckpointDigest(
            progress.traversal.sources[source],
          ),
      }),
    ),
    {
      chain: 'workspace-search',
      progressDigest: digest('progress:workspace-search'),
      pageCount: progress.traversal.target.aggregate.pageCount,
      terminalEvidenceDigest: digest('evidence:workspace-search'),
      terminalCheckpointDigest:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.traversal.target,
        ),
    },
  ]
  const planSealReference = createReference(
    'workspace-search/v1/plan-artifacts/v1',
    'plan-seals',
    'plan-seal',
    fixture.plan.planSealContentDigest,
  )
  const common = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds: createTableIds(fixture.configuration),
    planSealReference,
    planManifestHeadReference: createReference(
      'workspace-search/v1/plan-artifacts/v1',
      'manifest-heads',
      'plan-manifest',
    ),
    planningProvenanceManifestHeadReference: createReference(
      `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${fixture.configurationHash}`,
      'manifest-heads',
      'provenance-manifest',
    ),
    planDigest: fixture.plan.planDigest,
    planningSnapshotDigest:
      fixture.planSeal.planningSnapshotDigest,
    sourceOperationCount: fixture.planSeal.sourceOperationCount,
    orphanOperationCount: fixture.planSeal.orphanOperationCount,
    planOperationCount: fixture.planSeal.planOperationCount,
    planningAuthorityProvenanceDigest: digest('provenance'),
    historicalReceiptBindingDigest: digest('receipt-binding'),
    historicalReceiptCount: 1,
    evidenceHeads,
    currentAuthority: {
      ownerId: 'verification-owner',
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 11,
      maintenanceEvidenceReceiptDigest: digest('receipt'),
    },
    sealedAt: '2026-07-29T01:30:00.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return {
    ...common,
    authorityDigest: createMigrationDigest(common),
  }
}

/**
 * Creates one strict complete apply seal around terminal scan progress.
 *
 * @param fixture - Exact plan and measured configuration.
 * @param progress - Terminal traversal copied into the apply seal.
 * @param authority - Exact planning authority referenced by the seal.
 * @returns Internally consistent complete apply seal.
 */
function createApplySeal(
  fixture: VerificationFixture,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): WorkspaceSearchMigrationCompleteApplySeal {
  const markerAccumulator = new MigrationDigestAccumulator()
  for (
    let index = 0;
    index < fixture.plan.planOperationCount;
    index += 1
  ) {
    markerAccumulator.add(digest(`marker:${index + 1}`))
  }
  const pageCount = Object.values(
    progress.traversal.sources,
  ).reduce(
    (total, checkpoint) =>
      total + checkpoint.aggregate.pageCount,
    progress.traversal.target.aggregate.pageCount,
  )
  const common = {
    kind: 'workspace-search-migration-complete-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    scope: 'complete-plan',
    runId,
    configurationHash: fixture.configurationHash,
    executionRunDigest: digest('execution-run'),
    executionRunBindingDigest: digest('execution-binding'),
    sealedPlanningAuthorityDigest: authority.authorityDigest,
    tableIds: authority.tableIds,
    planSealReference: authority.planSealReference,
    planDigest: fixture.plan.planDigest,
    sourceOperationCount: fixture.planSeal.sourceOperationCount,
    orphanOperationCount: fixture.planSeal.orphanOperationCount,
    planOperationCount: fixture.plan.planOperationCount,
    predecessorRevision:
      1 + fixture.plan.planOperationCount + pageCount,
    predecessorExecutionStateDigest: digest('execution-state'),
    predecessorRunStateDigest: digest('run-state'),
    markerCount: fixture.plan.planOperationCount,
    applyMarkerDigestState: markerAccumulator.exportState(),
    applyMarkerAggregateDigest: markerAccumulator.digest(),
    journalSequence: 0,
    journalHeadDigest: '0'.repeat(64),
    apply: progress.traversal,
    applyTraversalDigest: createMigrationDigest(progress.traversal),
    createdAt: '2026-07-29T01:45:00.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationCompleteApplySeal,
    'sealDigest'
  >
  return {
    ...common,
    sealDigest: createMigrationDigest(common),
  }
}

/**
 * Creates one canonical rich immutable reference fixture.
 *
 * @param prefix - Exact role parent prefix.
 * @param role - Exact immutable artifact role.
 * @param label - Stable digest label.
 * @param exactContentDigest - Optional exact canonical content digest.
 * @returns Strict exact-version reference.
 */
function createReference(
  prefix: string,
  role: string,
  label: string,
  exactContentDigest = digest(label),
) {
  const contentDigest = exactContentDigest
  return {
    objectKey: `${prefix}/${role}/${contentDigest}.artifact`,
    versionId: `${label}-version`,
    contentDigest,
    byteLength: 1,
    retainUntil,
  }
}

/**
 * Projects all six immutable table IDs from measured configuration.
 *
 * @param configuration - Complete measured configuration.
 * @returns Fixed role-to-TableId record.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
) {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates a canonical active or archived Project Directory team item.
 *
 * @param identifier - Unique key and entity suffix.
 * @param archivedAt - Optional canonical archive timestamp.
 * @returns Exact low-level source item.
 */
function createTeamItem(
  identifier: string,
  archivedAt?: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `000001#000000#TEAM#${identifier}` },
    entryType: { S: 'team' },
    teamId: { S: identifier },
    teamSortOrder: { N: '1' },
    nameJa: { S: 'チーム' },
    nameEn: { S: 'Team' },
    expanded: { BOOL: true },
    ...(archivedAt === undefined
      ? {}
      : { archivedAt: { S: archivedAt } }),
  }
}

/**
 * Creates one canonical Work Item source row.
 *
 * @param issueId - Canonical Work Item identifier.
 * @returns Exact low-level Work Item item.
 */
function createWorkItemSourceItem(
  issueId: string,
): DynamoAttributeMap {
  return {
    schemaVersion: { N: '1' },
    revision: { N: '3' },
    workflowSchemaVersion: { N: '1' },
    directoryId: { S: 'workspace-1' },
    directoryTeamId: { S: 'workspace-1#team#team-1' },
    directoryProjectId: { S: 'workspace-1#project#project-1' },
    teamId: { S: 'team-1' },
    assignedProjectId: { S: 'project-1' },
    issueId: { S: issueId },
    sortOrder: { N: '10' },
    title: { S: `Work Item ${issueId}` },
    description: { S: 'Full verification fixture.' },
    assigneeUserId: { S: 'assignee@example.com' },
    creatorMemberKey: { S: 'creator@example.com' },
    workflowStatusId: { S: 'in-progress' },
    statusCategory: { S: 'started' },
    customFieldValues: { M: { estimate: { N: '3' } } },
    relationIds: { L: [] },
    dueDate: { S: '2026/07/31' },
    priority: { S: 'high' },
    createdAt: { S: '2026-07-20T01:00:00.000Z' },
    updatedAt: { S: '2026-07-25T01:00:00.000Z' },
  }
}

/**
 * Creates one recognized TTL-managed Collaboration row.
 *
 * @returns Exact low-level ignored source item.
 */
function createIgnoredCollaborationItem(): DynamoAttributeMap {
  return {
    entityKey: { S: 'workspace-1#presence' },
    recordKey: { S: 'PRESENCE#member@example.com' },
    entryType: { S: 'presence' },
    expiresAt: { N: '2000000000' },
  }
}

/**
 * Creates one recognized target row outside migration ownership.
 *
 * @param identifier - Unique saved-view key suffix.
 * @returns Exact low-level ignored target item.
 */
function createIgnoredTargetItem(
  identifier: string,
): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'fixture' },
  }
}

/**
 * Extracts one exact target key from a complete fixture row.
 *
 * @param item - Complete target item.
 * @returns Detached target primary key.
 */
function targetKey(item: DynamoAttributeMap): DynamoAttributeMap {
  const workspaceId = item.workspaceId
  const recordKey = item.recordKey
  if (workspaceId === undefined || recordKey === undefined) {
    throw new Error('Expected one complete target key.')
  }
  return structuredClone({ workspaceId, recordKey })
}

/**
 * Expects completion to reject one terminal but inexact traversal.
 *
 * @param fixture - Exact plan and measured configuration.
 * @param progress - Terminal traversal carrying missing or stale evidence.
 */
function expectCompletionFailure(
  fixture: VerificationFixture,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
): void {
  const authority = createAuthority(fixture, progress)
  const applySeal = createApplySeal(fixture, progress, authority)
  expectVerifyFailure(() =>
    completeWorkspaceSearchMigrationFullVerification({
      plan: fixture.plan,
      progress,
      applySeal,
      sealedPlanningAuthority: authority,
    })
  )
}

/**
 * Captures one stable full-verification failure.
 *
 * @param operation - Deferred failing operation.
 * @returns Secret-free migration failure.
 */
function captureFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
  }
  throw new Error('Expected full verification to fail.')
}

/**
 * Expects the fixed raw-value-free verification failure.
 *
 * @param operation - Deferred failing operation.
 */
function expectVerifyFailure(operation: () => unknown): void {
  const failure = captureFailure(operation)
  expect(failure.code).toBe('VERIFY_FAILED')
  expect(failure.message).not.toContain('workspace-1')
}

/**
 * Creates the complete measured migration configuration.
 *
 * @returns Reviewed migration configuration fixture.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role))
}

/**
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
  )
}

/**
 * Creates one stable measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact base-table key descriptor.
 * @returns Complete table identity fixture.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-29T00:00:00.000Z',
    },
  }
}

/**
 * Returns the measured key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and optional sort key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Creates one deterministic fixture digest.
 *
 * @param value - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createMigrationDigest(value)
}
