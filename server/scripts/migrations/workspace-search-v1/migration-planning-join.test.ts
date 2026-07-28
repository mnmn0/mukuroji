import { describe, expect, test } from 'bun:test'
import {
  createWorkItemWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  DYNAMODB_MAX_ITEM_SIZE_BYTES,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  type CreateWorkspaceSearchMigrationPlanningJoinInput,
  joinWorkspaceSearchMigrationPlanningEvidence,
  type WorkspaceSearchMigrationPlanningJoinLimits,
  type WorkspaceSearchMigrationPlanningJoinResult,
  type WorkspaceSearchMigrationPlanningSourcePageMaterial,
  type WorkspaceSearchMigrationPlanningTargetPageMaterial,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationSourceCandidate,
} from './migration-planner'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
} from './migration-source-scan-page'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  type WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
} from './migration-target-artifact'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

const runId = 'planning-join-run'

const sourceAuthority: WorkspaceSearchMigrationPlanningAuthorityBinding = {
  ownerId: 'planning-join-owner',
  fenceToken: 17,
  maintenanceEvidencePointerRevision: 23,
  maintenanceEvidenceReceiptDigest: digest('maintenance-receipt'),
}

const targetAuthority:
  WorkspaceSearchMigrationPlanningTargetArtifactAuthority = {
    ownerId: 'planning-join-owner',
    fenceToken: 17,
    maintenanceEvidencePointerRevision: 23,
    maintenanceEvidenceReceiptDigest: digest('maintenance-receipt'),
  }

const generousLimits: WorkspaceSearchMigrationPlanningJoinLimits = {
  maxTotalRows: 100,
  maxTotalCanonicalItemBytes: 1024 * 1024,
  maxPlanOperations: 100,
}

/** Controls construction of one internally consistent join fixture. */
type JoinFixtureOptions = {
  /** Project Directory item order and page boundaries. */
  readonly projectDirectoryPages?: readonly (
    readonly DynamoAttributeMap[]
  )[]
  /** Target item order and page boundaries. */
  readonly targetPages?: readonly (readonly DynamoAttributeMap[])[]
  /** Whether the Project Directory chain ends without a cursor. */
  readonly sourceTerminal?: boolean
  /** Evidence version emitted for Project Directory planning pages. */
  readonly projectDirectoryEvidenceVersion?: 2 | 3
  /** Explicit resource ceilings used by the public join. */
  readonly limits?: WorkspaceSearchMigrationPlanningJoinLimits
}

/** Canonical values retained beside one complete join input. */
type JoinFixture = {
  /** Fully measured configuration shared by all evidence. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Complete public join input. */
  readonly input: CreateWorkspaceSearchMigrationPlanningJoinInput
  /** Source row whose existing target is observed. */
  readonly matchedSourceItem: DynamoAttributeMap
  /** Source row whose target is absent. */
  readonly absentSourceItem: DynamoAttributeMap
  /** Recognized non-target source row. */
  readonly ignoredSourceItem: DynamoAttributeMap
  /** Existing target owned by the matched source row. */
  readonly matchedTargetItem: DynamoAttributeMap
  /** Recoverable target row with no source owner. */
  readonly orphanTargetItem: DynamoAttributeMap
  /** Recognized non-target target row. */
  readonly ignoredTargetItem: DynamoAttributeMap
}

/** Page construction output used to create an exact evidence chain. */
type SourceChain = {
  /** Page plus raw-item material consumed by the join. */
  readonly materials:
    readonly WorkspaceSearchMigrationPlanningSourcePageMaterial[]
  /** Exact head reached after the final material. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
}

/** Target page construction output used to create an exact evidence chain. */
type TargetChain = {
  /** Page plus raw-item material consumed by the join. */
  readonly materials:
    readonly WorkspaceSearchMigrationPlanningTargetPageMaterial[]
  /** Exact head reached after the final material. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
}

describe('Workspace Search migration planning evidence join', () => {
  test(
    'joins four terminal source chains and one target chain into exact planning inputs',
    () => {
      const fixture = createJoinFixture()
      const result =
        joinWorkspaceSearchMigrationPlanningEvidence(fixture.input)
      const matchedDigest = requireSourceCandidate(
        fixture,
        fixture.matchedSourceItem,
      ).operation.targetKeyDigest
      const absentDigest = requireSourceCandidate(
        fixture,
        fixture.absentSourceItem,
      ).operation.targetKeyDigest

      expect(Object.keys(result.sourceProgress).sort())
        .toEqual([...workspaceSearchMigrationSourceNames].sort())
      for (const source of workspaceSearchMigrationSourceNames) {
        expect(result.sourceProgress[source]).toMatchObject({
          purpose: 'planning',
          runId,
          configurationHash: fixture.configurationHash,
          source,
          sourceTableId: fixture.configuration.tables[source].tableId,
          stateTableId:
            fixture.configuration.tables['migration-state'].tableId,
          pageSequence: 1,
          checkpoint: {
            completed: true,
            aggregate: { pageCount: 1, invalid: 0 },
          },
        })
      }
      expect(result.targetProgress).toMatchObject({
        purpose: 'planning',
        runId,
        configurationHash: fixture.configurationHash,
        targetTableId:
          fixture.configuration.tables['workspace-search'].tableId,
        stateTableId:
          fixture.configuration.tables['migration-state'].tableId,
        pageSequence: 1,
        checkpoint: {
          completed: true,
          aggregate: {
            scanned: 3,
            owned: 2,
            ignored: 1,
            invalid: 0,
            pageCount: 1,
          },
        },
      })
      const {
        provenanceDigest,
        ...provenanceFields
      } = result.planningAuthorityProvenance
      expect(provenanceDigest)
        .toBe(createMigrationDigest(provenanceFields))
      expect(result.planningAuthorityProvenance).toMatchObject({
        kind: 'workspace-search-planning-authority-provenance',
        provenanceVersion: 1,
        runId,
        configurationHash: fixture.configurationHash,
        stateTableId:
          fixture.configuration.tables['migration-state'].tableId,
      })
      expect(result.planningAuthorityProvenance.chainRoots).toHaveLength(5)
      expect(result.planningAuthorityProvenance.authorityTrace)
        .toHaveLength(5)
      expect(result.planningAuthorityProvenance.authorityTransitions)
        .toEqual([sourceAuthority])
      expect(result.scanSnapshot.sources['project-directory']).toMatchObject({
        scanned: 3,
        mapped: 2,
        ignored: 1,
        invalid: 0,
        projected: 2,
        deleted: 0,
        pageCount: 1,
      })
      expect(result.scanSnapshot.sources['work-items']).toMatchObject({
        scanned: 0,
        mapped: 0,
        ignored: 0,
        invalid: 0,
        projected: 0,
        deleted: 0,
        pageCount: 1,
      })
      expect(result.scanSnapshot.target).toMatchObject({
        scanned: 3,
        mapped: 2,
        ignored: 1,
        invalid: 0,
        projected: 1,
        deleted: 1,
        pageCount: 1,
      })
      expect(
        [...result.targetOwnershipEvidence.expectedSourceTargetKeyDigests]
          .sort(),
      ).toEqual([matchedDigest, absentDigest].sort())
      expect(
        result.targetOwnershipEvidence.observedTargetKeyDigests,
      ).toHaveLength(2)
      expect(
        result.targetOwnershipEvidence.orphanTargetKeyDigests,
      ).toHaveLength(1)

      expect(result.candidates).toHaveLength(3)
      expect(result.candidates.map(({ operation }) =>
        operation.targetKeyDigest
      )).toEqual(
        result.candidates
          .map(({ operation }) => operation.targetKeyDigest)
          .toSorted(),
      )
      const matched = requireCandidateByTarget(result, matchedDigest)
      expect(matched).toMatchObject({
        origin: 'source',
        operation: {
          before: { exists: true },
          after: { exists: true },
        },
      })
      const absent = requireCandidateByTarget(result, absentDigest)
      expect(absent).toMatchObject({
        origin: 'source',
        operation: {
          before: { exists: false },
          after: { exists: true },
        },
      })
      const orphan = result.candidates.find(({ origin }) =>
        origin === 'orphan'
      )
      expect(orphan).toMatchObject({
        origin: 'orphan',
        operation: {
          sourceCondition: { exists: false, source: 'work-items' },
          before: { exists: true },
          after: { exists: false },
        },
      })
    },
  )

  test(
    'orders candidates independently of raw row order and page boundaries',
    () => {
      const baseline = createJoinFixture()
      const reversed = createJoinFixture({
        projectDirectoryPages: [[
          baseline.ignoredSourceItem,
          baseline.absentSourceItem,
          baseline.matchedSourceItem,
        ]],
        targetPages: [
          [baseline.ignoredTargetItem],
          [baseline.orphanTargetItem, baseline.matchedTargetItem],
        ],
      })

      const baselineResult =
        joinWorkspaceSearchMigrationPlanningEvidence(baseline.input)
      const reversedResult =
        joinWorkspaceSearchMigrationPlanningEvidence(reversed.input)
      expect(candidateIdentity(reversedResult))
        .toEqual(candidateIdentity(baselineResult))
      expect({
        expected:
          [...reversedResult.targetOwnershipEvidence
            .expectedSourceTargetKeyDigests].sort(),
        observed:
          [...reversedResult.targetOwnershipEvidence
            .observedTargetKeyDigests].sort(),
        orphan:
          [...reversedResult.targetOwnershipEvidence
            .orphanTargetKeyDigests].sort(),
      }).toEqual({
        expected:
          [...baselineResult.targetOwnershipEvidence
            .expectedSourceTargetKeyDigests].sort(),
        observed:
          [...baselineResult.targetOwnershipEvidence
            .observedTargetKeyDigests].sort(),
        orphan:
          [...baselineResult.targetOwnershipEvidence
            .orphanTargetKeyDigests].sort(),
      })
      expect(reversedResult.scanSnapshot).toEqual({
        ...baselineResult.scanSnapshot,
        target: {
          ...baselineResult.scanSnapshot.target,
          pageCount: 2,
        },
      })
    },
  )

  test(
    'returns canonical monotonic authority provenance and rejects impossible histories',
    () => {
      const renewedAuthority = {
        ...sourceAuthority,
        maintenanceEvidencePointerRevision: 24,
        maintenanceEvidenceReceiptDigest: digest('renewed-receipt'),
      } satisfies WorkspaceSearchMigrationPlanningAuthorityBinding
      const takeoverAuthority = {
        ...renewedAuthority,
        ownerId: 'planning-join-takeover-owner',
        fenceToken: 19,
        maintenanceEvidencePointerRevision: 31,
        maintenanceEvidenceReceiptDigest: digest('takeover-receipt'),
      } satisfies WorkspaceSearchMigrationPlanningAuthorityBinding
      const valid = createJoinFixture()
      const validSourceChain = createSourceChain(
        valid.configuration,
        valid.configurationHash,
        'project-directory',
        [
          [valid.matchedSourceItem],
          [valid.absentSourceItem],
          [valid.ignoredSourceItem],
        ],
        true,
        3,
        [sourceAuthority, renewedAuthority, takeoverAuthority],
      )
      Reflect.set(
        valid.input.sourcePages,
        'project-directory',
        validSourceChain.materials,
      )

      const validResult =
        joinWorkspaceSearchMigrationPlanningEvidence(valid.input)

      expect(
        validResult.planningAuthorityProvenance.authorityTransitions,
      ).toEqual([
        sourceAuthority,
        renewedAuthority,
        takeoverAuthority,
      ])
      expect(
        validResult.planningAuthorityProvenance.authorityTrace
          .filter(({ chain }) => chain === 'project-directory')
          .map((entry) => ({
            pageSequence: entry.pageSequence,
            fenceToken: entry.fenceToken,
            pointerRevision:
              entry.maintenanceEvidencePointerRevision,
          })),
      ).toEqual([
        { pageSequence: 1, fenceToken: 17, pointerRevision: 23 },
        { pageSequence: 2, fenceToken: 17, pointerRevision: 24 },
        { pageSequence: 3, fenceToken: 19, pointerRevision: 31 },
      ])

      const perChainRegression = createJoinFixture()
      const regressingChain = createSourceChain(
        perChainRegression.configuration,
        perChainRegression.configurationHash,
        'project-directory',
        [
          [perChainRegression.matchedSourceItem],
          [
            perChainRegression.absentSourceItem,
            perChainRegression.ignoredSourceItem,
          ],
        ],
        true,
        3,
        [renewedAuthority, sourceAuthority],
      )
      Reflect.set(
        perChainRegression.input.sourcePages,
        'project-directory',
        regressingChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            perChainRegression.input,
          ),
        'INVALID_MAINTENANCE_EVIDENCE',
      )

      const revisionConflict = createJoinFixture()
      const conflictingTargetAuthority = {
        ...targetAuthority,
        maintenanceEvidenceReceiptDigest:
          digest('same-revision-conflict'),
      } satisfies WorkspaceSearchMigrationPlanningTargetArtifactAuthority
      const conflictingTargetChain = createTargetChain(
        revisionConflict.configuration,
        revisionConflict.configurationHash,
        [[
          revisionConflict.matchedTargetItem,
          revisionConflict.orphanTargetItem,
          revisionConflict.ignoredTargetItem,
        ]],
        true,
        [conflictingTargetAuthority],
      )
      Reflect.set(
        revisionConflict.input,
        'targetPages',
        conflictingTargetChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            revisionConflict.input,
          ),
        'INVALID_MAINTENANCE_EVIDENCE',
      )

      const ownerDrift = createJoinFixture()
      const ownerDriftAuthority = {
        ...targetAuthority,
        ownerId: 'same-fence-other-owner',
        maintenanceEvidencePointerRevision: 24,
        maintenanceEvidenceReceiptDigest: digest('owner-drift-receipt'),
      } satisfies WorkspaceSearchMigrationPlanningTargetArtifactAuthority
      const ownerDriftTargetChain = createTargetChain(
        ownerDrift.configuration,
        ownerDrift.configurationHash,
        [[
          ownerDrift.matchedTargetItem,
          ownerDrift.orphanTargetItem,
          ownerDrift.ignoredTargetItem,
        ]],
        true,
        [ownerDriftAuthority],
      )
      Reflect.set(
        ownerDrift.input,
        'targetPages',
        ownerDriftTargetChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(ownerDrift.input),
        'INVALID_MAINTENANCE_EVIDENCE',
      )

      const stationaryPointer = createJoinFixture()
      const stationaryTakeover = {
        ...sourceAuthority,
        ownerId: 'stationary-pointer-owner',
        fenceToken: 18,
        maintenanceEvidenceReceiptDigest:
          digest('stationary-pointer-receipt'),
      } satisfies WorkspaceSearchMigrationPlanningAuthorityBinding
      const stationaryChain = createSourceChain(
        stationaryPointer.configuration,
        stationaryPointer.configurationHash,
        'project-directory',
        [
          [stationaryPointer.matchedSourceItem],
          [
            stationaryPointer.absentSourceItem,
            stationaryPointer.ignoredSourceItem,
          ],
        ],
        true,
        3,
        [sourceAuthority, stationaryTakeover],
      )
      Reflect.set(
        stationaryPointer.input.sourcePages,
        'project-directory',
        stationaryChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            stationaryPointer.input,
          ),
        'INVALID_MAINTENANCE_EVIDENCE',
      )

      const receiptReuse = createJoinFixture()
      const reusedReceiptAuthority = {
        ...targetAuthority,
        maintenanceEvidencePointerRevision: 24,
      } satisfies WorkspaceSearchMigrationPlanningTargetArtifactAuthority
      const receiptReuseTargetChain = createTargetChain(
        receiptReuse.configuration,
        receiptReuse.configurationHash,
        [[
          receiptReuse.matchedTargetItem,
          receiptReuse.orphanTargetItem,
          receiptReuse.ignoredTargetItem,
        ]],
        true,
        [reusedReceiptAuthority],
      )
      Reflect.set(
        receiptReuse.input,
        'targetPages',
        receiptReuseTargetChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            receiptReuse.input,
          ),
        'INVALID_MAINTENANCE_EVIDENCE',
      )

      const globalFenceRegression = createJoinFixture()
      const lowerFenceLaterRevision = {
        ...targetAuthority,
        fenceToken: 16,
        maintenanceEvidencePointerRevision: 24,
        maintenanceEvidenceReceiptDigest:
          digest('lower-fence-later-revision'),
      } satisfies WorkspaceSearchMigrationPlanningTargetArtifactAuthority
      const globalRegressionTargetChain = createTargetChain(
        globalFenceRegression.configuration,
        globalFenceRegression.configurationHash,
        [[
          globalFenceRegression.matchedTargetItem,
          globalFenceRegression.orphanTargetItem,
          globalFenceRegression.ignoredTargetItem,
        ]],
        true,
        [lowerFenceLaterRevision],
      )
      Reflect.set(
        globalFenceRegression.input,
        'targetPages',
        globalRegressionTargetChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            globalFenceRegression.input,
          ),
        'INVALID_MAINTENANCE_EVIDENCE',
      )
    },
  )

  test(
    'rejects missing, extra, empty, incomplete, and legacy source chains',
    () => {
      const missing = createJoinFixture()
      Reflect.deleteProperty(missing.input.sourcePages, 'documents')
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(missing.input)
      )

      const extra = createJoinFixture()
      Reflect.set(extra.input.sourcePages, 'unexpected-source', [])
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(extra.input)
      )

      const empty = createJoinFixture()
      Reflect.set(empty.input.sourcePages, 'collaboration', [])
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(empty.input)
      )

      const emptyTarget = createJoinFixture()
      Reflect.set(emptyTarget.input, 'targetPages', [])
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(emptyTarget.input)
      )

      const incomplete = createJoinFixture({ sourceTerminal: false })
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(incomplete.input)
      )

      const incompleteTarget = createJoinFixture()
      const incompleteTargetChain = createTargetChain(
        incompleteTarget.configuration,
        incompleteTarget.configurationHash,
        [[incompleteTarget.ignoredTargetItem]],
        false,
      )
      Reflect.set(
        incompleteTarget.input,
        'targetPages',
        incompleteTargetChain.materials,
      )
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(incompleteTarget.input)
      )

      const legacy = createJoinFixture({
        projectDirectoryEvidenceVersion: 2,
      })
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(legacy.input)
      )
    },
  )

  test(
    'rejects invalid rows and run, configuration, table, or state identity drift',
    () => {
      const invalidRow = createJoinFixture()
      const invalidItem = createInvalidProjectDirectoryItem('invalid')
      const invalidChain = createSourceChain(
        invalidRow.configuration,
        invalidRow.configurationHash,
        'project-directory',
        [[invalidItem]],
      )
      Reflect.set(
        invalidRow.input.sourcePages,
        'project-directory',
        invalidChain.materials,
      )
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(invalidRow.input)
      )

      const invalidTarget = createJoinFixture()
      const invalidTargetChain = createTargetChain(
        invalidTarget.configuration,
        invalidTarget.configurationHash,
        [[createInvalidTargetItem('invalid')]],
      )
      Reflect.set(
        invalidTarget.input,
        'targetPages',
        invalidTargetChain.materials,
      )
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(invalidTarget.input)
      )

      const mutations: readonly (
        (fixture: JoinFixture) => void
      )[] = [
        (fixture) => {
          Reflect.set(fixture.input, 'runId', 'different-run')
        },
        (fixture) => {
          Reflect.set(
            fixture.input,
            'configurationHash',
            digest('different-configuration'),
          )
        },
        (fixture) => {
          const material =
            fixture.input.sourcePages['project-directory'][0]
          if (!material) throw new Error('Expected source material.')
          Reflect.set(material.page, 'sourceTableId', 'different-source-table')
        },
        (fixture) => {
          const material = fixture.input.targetPages[0]
          if (!material) throw new Error('Expected target material.')
          Reflect.set(material.page, 'targetTableId', 'different-target-table')
        },
        (fixture) => {
          const material = fixture.input.targetPages[0]
          if (!material) throw new Error('Expected target material.')
          Reflect.set(material.page, 'stateTableId', 'different-state-table')
        },
      ]
      for (const mutate of mutations) {
        const fixture = createJoinFixture()
        mutate(fixture)
        expectJoinFailure(() =>
          joinWorkspaceSearchMigrationPlanningEvidence(fixture.input)
        )
      }
    },
  )

  test(
    'rejects conflicting ownership evidence, duplicate targets, and ambiguous directory orphans',
    () => {
      const sourceCollision = createJoinFixture()
      const workItem = createWorkItemSourceItem('collision')
      const workItemChain = createSourceChain(
        sourceCollision.configuration,
        sourceCollision.configurationHash,
        'work-items',
        [[workItem]],
      )
      const projectMaterial =
        sourceCollision.input.sourcePages['project-directory'][0]
      const projectBinding = projectMaterial?.page.sourceBindings[0]
      const workItemBinding =
        workItemChain.materials[0]?.page.sourceBindings[0]
      if (!projectBinding || !workItemBinding) {
        throw new Error('Expected mapped source bindings.')
      }
      Reflect.set(
        workItemBinding,
        'targetKeyDigest',
        projectBinding.targetKeyDigest,
      )
      Reflect.set(
        sourceCollision.input.sourcePages,
        'work-items',
        workItemChain.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            sourceCollision.input,
          ),
        'INVALID_STATE',
      )

      const duplicateTarget = createJoinFixture()
      const duplicateChain = createTargetChain(
        duplicateTarget.configuration,
        duplicateTarget.configurationHash,
        [
          [duplicateTarget.matchedTargetItem],
          [duplicateTarget.matchedTargetItem],
        ],
      )
      Reflect.set(
        duplicateTarget.input,
        'targetPages',
        duplicateChain.materials,
      )
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(duplicateTarget.input)
      )

      const ignoredCollision = createJoinFixture()
      const ignoredMaterial = ignoredCollision.input.targetPages[0]
      const ignoredRow = ignoredMaterial?.page.targetRows.find(
        ({ classification }) => classification === 'ignored',
      )
      const expectedBinding =
        ignoredCollision.input.sourcePages['project-directory'][0]
          ?.page.sourceBindings[0]
      if (!ignoredRow || !expectedBinding) {
        throw new Error('Expected ignored and mapped fixture evidence.')
      }
      Reflect.set(
        ignoredRow,
        'targetKeyDigest',
        expectedBinding.targetKeyDigest,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            ignoredCollision.input,
          ),
        'INVALID_STATE',
      )

      const ambiguousTeamOrphan = createJoinFixture()
      const teamSourceWithoutMatchedOwner = createSourceChain(
        ambiguousTeamOrphan.configuration,
        ambiguousTeamOrphan.configurationHash,
        'project-directory',
        [[
          ambiguousTeamOrphan.absentSourceItem,
          ambiguousTeamOrphan.ignoredSourceItem,
        ]],
      )
      Reflect.set(
        ambiguousTeamOrphan.input.sourcePages,
        'project-directory',
        teamSourceWithoutMatchedOwner.materials,
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            ambiguousTeamOrphan.input,
          ),
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    },
  )

  test(
    'rejects missing, extra, and substituted raw page items',
    () => {
      const missing = createJoinFixture()
      const missingMaterial =
        missing.input.sourcePages['project-directory'][0]
      if (!missingMaterial) throw new Error('Expected source material.')
      Reflect.set(missingMaterial, 'items', missingMaterial.items.slice(1))
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(missing.input)
      )

      const extra = createJoinFixture()
      const extraMaterial =
        extra.input.sourcePages['project-directory'][0]
      if (!extraMaterial) throw new Error('Expected source material.')
      Reflect.set(extraMaterial, 'items', [
        ...extraMaterial.items,
        createIgnoredProjectDirectoryItem('uncommitted-extra'),
      ])
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(extra.input)
      )

      const substitution = createJoinFixture()
      const substitutionMaterial =
        substitution.input.targetPages[0]
      if (!substitutionMaterial) throw new Error('Expected target material.')
      const substitutedItems = substitutionMaterial.items.map(
        (item, index) =>
          index === 0
            ? { ...item, uncommittedPayload: { S: 'substitution' } }
            : item,
      )
      Reflect.set(substitutionMaterial, 'items', substitutedItems)
      expectJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(substitution.input)
      )
    },
  )

  test(
    'accepts exact row, byte, and operation ceilings and rejects one beyond each',
    () => {
      const exactFixture = createJoinFixture()
      const exactLimits = measureFixtureLimits(exactFixture)
      Reflect.set(exactFixture.input, 'limits', exactLimits)
      expect(
        joinWorkspaceSearchMigrationPlanningEvidence(exactFixture.input)
          .candidates,
      ).toHaveLength(exactLimits.maxPlanOperations)

      const rowLimited = createJoinFixture({
        limits: {
          ...exactLimits,
          maxTotalRows: exactLimits.maxTotalRows - 1,
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(rowLimited.input),
        'INVALID_ARGUMENT',
      )

      const byteLimited = createJoinFixture({
        limits: {
          ...exactLimits,
          maxTotalCanonicalItemBytes:
            exactLimits.maxTotalCanonicalItemBytes - 1,
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(byteLimited.input),
        'INVALID_ARGUMENT',
      )

      const operationLimited = createJoinFixture({
        limits: {
          ...exactLimits,
          maxPlanOperations: exactLimits.maxPlanOperations - 1,
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            operationLimited.input,
          ),
        'INVALID_ARGUMENT',
      )
    },
  )

  test(
    'bounds raw envelopes before projection and rejects forged failure codes',
    () => {
      const pageFlood = createJoinFixture()
      const emptyMaterial =
        pageFlood.input.sourcePages.collaboration[0]
      if (!emptyMaterial) {
        throw new Error('Expected empty terminal source material.')
      }
      Reflect.set(
        pageFlood.input.sourcePages,
        'collaboration',
        Array.from(
          { length: 10_001 },
          () => emptyMaterial,
        ),
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(pageFlood.input),
        'INVALID_ARGUMENT',
      )

      let postEnvelopePageRead = false
      const postEnvelopeMutation = createJoinFixture()
      const originalAccount = postEnvelopeMutation.configuration.account
      const delayedMaterial =
        postEnvelopeMutation.input.sourcePages.documents[0]
      if (!delayedMaterial) {
        throw new Error('Expected delayed source material.')
      }
      const originalKind = delayedMaterial.page.kind
      Object.defineProperty(delayedMaterial.page, 'kind', {
        configurable: true,
        enumerable: true,
        get() {
          postEnvelopePageRead = true
          return originalKind
        },
      })
      Object.defineProperty(postEnvelopeMutation.configuration, 'account', {
        configurable: true,
        enumerable: true,
        get() {
          Reflect.set(
            postEnvelopeMutation.input.sourcePages,
            'documents',
            Array.from(
              { length: 10_001 },
              () => delayedMaterial,
            ),
          )
          return originalAccount
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            postEnvelopeMutation.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(postEnvelopePageRead).toBe(false)

      let oversizedRowsReadPage = false
      const oversizedRows = createJoinFixture({
        limits: {
          ...generousLimits,
          maxTotalRows: 1,
        },
      })
      const oversizedRowsMaterial =
        oversizedRows.input.sourcePages['project-directory'][0]
      if (!oversizedRowsMaterial) {
        throw new Error('Expected bounded source material.')
      }
      Object.defineProperty(oversizedRowsMaterial.page, 'cloneMarker', {
        configurable: true,
        enumerable: true,
        get() {
          oversizedRowsReadPage = true
          return 'must-not-be-read'
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            oversizedRows.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(oversizedRowsReadPage).toBe(false)

      let extraValueRead = false
      const extra = createJoinFixture()
      Object.defineProperty(extra.input, 'unrecognized', {
        configurable: true,
        enumerable: true,
        get() {
          extraValueRead = true
          return 'must-not-be-read'
        },
      })
      expectJoinFailure(
        () => joinWorkspaceSearchMigrationPlanningEvidence(extra.input),
        'INVALID_ARGUMENT',
      )
      expect(extraValueRead).toBe(false)

      const oversizedItem = createJoinFixture()
      const oversizedItemMaterial =
        oversizedItem.input.sourcePages['project-directory'][0]
      const firstItem = oversizedItemMaterial?.items[0]
      if (!firstItem) throw new Error('Expected one source item.')
      Reflect.set(firstItem, 'oversizedPayload', {
        S: 'x'.repeat(400 * 1024),
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            oversizedItem.input,
          ),
        'INVALID_STATE',
      )

      let alternatingGetterReads = 0
      const alternatingItem = createJoinFixture()
      const alternatingRawItem =
        alternatingItem.input.sourcePages['project-directory'][0]
          ?.items[0]
      if (!alternatingRawItem) {
        throw new Error('Expected one alternating source item.')
      }
      Object.defineProperty(alternatingRawItem, 'alternatingPayload', {
        configurable: true,
        enumerable: true,
        get() {
          alternatingGetterReads += 1
          return alternatingGetterReads === 1
            ? { S: 'small' }
            : { S: 'x'.repeat(DYNAMODB_MAX_ITEM_SIZE_BYTES + 1) }
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            alternatingItem.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(alternatingGetterReads).toBe(0)

      let oversizedNestedMemberRead = false
      const oversizedNested = createJoinFixture()
      const oversizedNestedItem =
        oversizedNested.input.sourcePages['project-directory'][0]
          ?.items[0]
      if (!oversizedNestedItem) {
        throw new Error('Expected one nested source item.')
      }
      const nestedMember = {}
      Object.defineProperty(nestedMember, 'NULL', {
        configurable: true,
        enumerable: true,
        get() {
          oversizedNestedMemberRead = true
          return true
        },
      })
      Reflect.set(oversizedNestedItem, 'oversizedList', {
        L: Array.from(
          { length: DYNAMODB_MAX_ITEM_SIZE_BYTES + 1 },
          () => nestedMember,
        ),
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            oversizedNested.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(oversizedNestedMemberRead).toBe(false)

      let binaryByteLengthReads = 0
      let binaryIteratorCalls = 0
      const hostileBinary = createJoinFixture()
      const hostileBinaryItem =
        hostileBinary.input.sourcePages['project-directory'][0]
          ?.items[0]
      if (!hostileBinaryItem) {
        throw new Error('Expected one binary source item.')
      }
      const scalarBinary = new Uint8Array([1, 2, 3])
      const setBinary = new Uint8Array([4, 5, 6])
      for (const bytes of [scalarBinary, setBinary]) {
        Object.defineProperty(bytes, 'byteLength', {
          configurable: true,
          get() {
            binaryByteLengthReads += 1
            return 0
          },
        })
        Object.defineProperty(bytes, Symbol.iterator, {
          configurable: true,
          value() {
            binaryIteratorCalls += 1
            return [7, 8, 9][Symbol.iterator]()
          },
        })
      }
      Reflect.set(hostileBinaryItem, 'binaryPayload', {
        B: scalarBinary,
      })
      Reflect.set(hostileBinaryItem, 'binarySetPayload', {
        BS: [setBinary],
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            hostileBinary.input,
          ),
        'INVALID_STATE',
      )
      expect(binaryByteLengthReads).toBe(0)
      expect(binaryIteratorCalls).toBe(0)

      for (const attribute of [
        { B: new Uint8Array(new SharedArrayBuffer(1)) },
        { BS: [new Uint8Array(new SharedArrayBuffer(1))] },
      ]) {
        const sharedBinary = createJoinFixture()
        const sharedBinaryItem =
          sharedBinary.input.sourcePages['project-directory'][0]
            ?.items[0]
        if (!sharedBinaryItem) {
          throw new Error('Expected one shared-binary source item.')
        }
        Reflect.set(
          sharedBinaryItem,
          'sharedBinaryPayload',
          attribute,
        )
        expectJoinFailure(
          () =>
            joinWorkspaceSearchMigrationPlanningEvidence(
              sharedBinary.input,
            ),
          'INVALID_ARGUMENT',
        )
      }

      let customPageMapCalled = false
      const customPageCollection = createJoinFixture()
      const customPageMaterial =
        customPageCollection.input.sourcePages['project-directory'][0]
      if (!customPageMaterial) {
        throw new Error('Expected one source evidence page.')
      }
      Reflect.set(customPageMaterial.page, 'sourceRows', {
        map() {
          customPageMapCalled = true
          return []
        },
      })
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            customPageCollection.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(customPageMapCalled).toBe(false)

      let oversizedEvidenceRowRead = false
      const oversizedEvidence = createJoinFixture()
      const oversizedEvidenceMaterial =
        oversizedEvidence.input.sourcePages['project-directory'][0]
      const oversizedEvidenceRow =
        oversizedEvidenceMaterial?.page.sourceRows[0]
      if (!oversizedEvidenceMaterial || !oversizedEvidenceRow) {
        throw new Error('Expected one source evidence row.')
      }
      Object.defineProperty(oversizedEvidenceRow, 'classification', {
        configurable: true,
        enumerable: true,
        get() {
          oversizedEvidenceRowRead = true
          return 'mapped'
        },
      })
      Reflect.set(
        oversizedEvidenceMaterial.page,
        'sourceRows',
        Array.from(
          { length: 101 },
          () => oversizedEvidenceRow,
        ),
      )
      expectJoinFailure(
        () =>
          joinWorkspaceSearchMigrationPlanningEvidence(
            oversizedEvidence.input,
          ),
        'INVALID_ARGUMENT',
      )
      expect(oversizedEvidenceRowRead).toBe(false)

      const canary = 'FORGED-JOIN-FAILURE-CANARY-DO-NOT-LEAK'
      let forgedGetterRead = false
      const forged = createJoinFixture()
      const material =
        forged.input.sourcePages['project-directory'][0]
      if (!material) throw new Error('Expected source material.')
      const forgedItem = material.items[0]
      if (!forgedItem) throw new Error('Expected one source item.')
      Object.defineProperty(forgedItem, 'forgedAttribute', {
        configurable: true,
        enumerable: true,
        get() {
          forgedGetterRead = true
          throw new WorkspaceSearchMigrationFailure(
            'LEASE_LOST',
            canary,
          )
        },
      })
      const failure = captureJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(forged.input)
      )
      expect(failure.code).toBe('INVALID_ARGUMENT')
      expect(failure.message).not.toContain(canary)
      expect(failure.message).not.toContain('LEASE_LOST')
      expect(forgedGetterRead).toBe(false)

      const proxyCanary = 'THROWN-PROXY-CANARY-DO-NOT-LEAK'
      let hostileGetterRead = false
      const hostileProxy = createJoinFixture()
      const proxyItem =
        hostileProxy.input.sourcePages['project-directory'][0]?.items[0]
      if (!proxyItem) throw new Error('Expected one source item.')
      Object.defineProperty(proxyItem, 'hostileAttribute', {
        configurable: true,
        enumerable: true,
        get() {
          hostileGetterRead = true
          throw new Proxy({}, {
            getPrototypeOf() {
              throw new Error(proxyCanary)
            },
          })
        },
      })
      const proxyFailure = captureJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(hostileProxy.input)
      )
      expect(proxyFailure.code).toBe('INVALID_ARGUMENT')
      expect(proxyFailure.message).not.toContain(proxyCanary)
      expect(hostileGetterRead).toBe(false)

      const allowedCodeCanary =
        'FORGED-ALLOWED-JOIN-CODE-CANARY-DO-NOT-LEAK'
      let runIdCoercionCalled = false
      const forgedRunId = createJoinFixture()
      const callerRunId = {}
      Object.defineProperty(callerRunId, Symbol.toPrimitive, {
        configurable: true,
        value: () => {
          runIdCoercionCalled = true
          throw new WorkspaceSearchMigrationFailure(
            'TABLE_SCHEMA_MISMATCH',
            allowedCodeCanary,
          )
        },
      })
      Reflect.set(forgedRunId.input, 'runId', callerRunId)
      const forgedRunIdFailure = captureJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(forgedRunId.input)
      )
      expect(
        forgedRunIdFailure.code === 'INVALID_ARGUMENT' ||
        forgedRunIdFailure.code === 'INVALID_STATE',
      ).toBe(true)
      expect(forgedRunIdFailure.code)
        .not.toBe('TABLE_SCHEMA_MISMATCH')
      expect(forgedRunIdFailure.message)
        .not.toContain(allowedCodeCanary)
      expect(runIdCoercionCalled).toBe(false)

      let configurationProxyRead = false
      const forgedConfiguration = createJoinFixture()
      const callerConfigurationScalar = new Proxy({}, {
        ownKeys() {
          configurationProxyRead = true
          throw new WorkspaceSearchMigrationFailure(
            'TABLE_SCHEMA_MISMATCH',
            allowedCodeCanary,
          )
        },
      })
      Reflect.set(
        forgedConfiguration.configuration,
        'account',
        callerConfigurationScalar,
      )
      const forgedConfigurationFailure = captureJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(
          forgedConfiguration.input,
        )
      )
      expect(
        forgedConfigurationFailure.code === 'INVALID_ARGUMENT' ||
        forgedConfigurationFailure.code === 'INVALID_STATE',
      ).toBe(true)
      expect(forgedConfigurationFailure.code)
        .not.toBe('TABLE_SCHEMA_MISMATCH')
      expect(forgedConfigurationFailure.message)
        .not.toContain(allowedCodeCanary)
      expect(configurationProxyRead).toBe(false)
    },
  )

  test(
    'redacts hostile raw getter failures and detaches caller-owned input',
    () => {
      const canary = 'RAW-PLANNING-JOIN-CANARY-DO-NOT-LEAK'
      const hostile = createJoinFixture()
      const material =
        hostile.input.sourcePages['project-directory'][0]
      if (!material) throw new Error('Expected source material.')
      Object.defineProperty(material, 'items', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(canary)
        },
      })
      const hostileFailure = captureJoinFailure(() =>
        joinWorkspaceSearchMigrationPlanningEvidence(hostile.input)
      )
      expect(hostileFailure.message).not.toContain(canary)
      expect(hostileFailure.message).not.toContain('workspace-1')

      const detached = createJoinFixture()
      const result =
        joinWorkspaceSearchMigrationPlanningEvidence(detached.input)
      const expected = structuredClone(result)
      const sourceMaterial =
        detached.input.sourcePages['project-directory'][0]
      const targetMaterial = detached.input.targetPages[0]
      if (!sourceMaterial || !targetMaterial) {
        throw new Error('Expected complete planning material.')
      }
      Reflect.set(detached.configuration, 'account', 'mutated-account')
      Reflect.set(sourceMaterial.items[0] ?? {}, 'mutated', { S: 'source' })
      Reflect.set(targetMaterial.items[0] ?? {}, 'mutated', { S: 'target' })
      Reflect.set(
        sourceMaterial.page.sourceRows[0] ?? {},
        'sourceItemDigest',
        digest('mutated-source-evidence'),
      )
      Reflect.set(
        targetMaterial.page.targetRows[0] ?? {},
        'targetItemDigest',
        digest('mutated-target-evidence'),
      )

      expect(result).toEqual(expected)
    },
  )
})

/**
 * Creates one complete source/target material fixture.
 *
 * @param options - Optional page layouts, completion state, and limits.
 * @returns Complete public input and retained raw fixtures.
 */
function createJoinFixture(options: JoinFixtureOptions = {}): JoinFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const matchedSourceItem = createTeamSourceItem('matched', 1)
  const absentSourceItem = createTeamSourceItem('absent', 2)
  const ignoredSourceItem =
    createIgnoredProjectDirectoryItem('recognized')
  const matchedTargetItem = requireAfterItem(
    createWorkspaceSearchMigrationSourceCandidate({
      configurationHash,
      source: 'project-directory',
      sourceTable: configuration.tables['project-directory'],
      sourceItem: matchedSourceItem,
    }),
  )
  const orphanTargetItem = encodeWorkspaceSearchMigrationDocument(
    createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'orphan',
      title: 'Recoverable orphan',
    }),
  )
  const ignoredTargetItem = createIgnoredTargetItem('recognized')
  const projectDirectoryPages =
    options.projectDirectoryPages ?? [[
      matchedSourceItem,
      absentSourceItem,
      ignoredSourceItem,
    ]]
  const targetItemPages = options.targetPages ?? [[
    matchedTargetItem,
    orphanTargetItem,
    ignoredTargetItem,
  ]]
  const sourcePages = {
    'project-directory': createSourceChain(
      configuration,
      configurationHash,
      'project-directory',
      projectDirectoryPages,
      options.sourceTerminal ?? true,
      options.projectDirectoryEvidenceVersion ?? 3,
    ).materials,
    'work-items': createSourceChain(
      configuration,
      configurationHash,
      'work-items',
      [[]],
    ).materials,
    collaboration: createSourceChain(
      configuration,
      configurationHash,
      'collaboration',
      [[]],
    ).materials,
    documents: createSourceChain(
      configuration,
      configurationHash,
      'documents',
      [[]],
    ).materials,
  }
  const targetPages = createTargetChain(
    configuration,
    configurationHash,
    targetItemPages,
  ).materials
  const input: CreateWorkspaceSearchMigrationPlanningJoinInput = {
    runId,
    configuration,
    configurationHash,
    limits: options.limits ?? generousLimits,
    sourcePages,
    targetPages,
  }
  return {
    configuration,
    configurationHash,
    input,
    matchedSourceItem,
    absentSourceItem,
    ignoredSourceItem,
    matchedTargetItem,
    orphanTargetItem,
    ignoredTargetItem,
  }
}

/**
 * Builds one exact source evidence chain and its raw page materials.
 *
 * @param configuration - Measured configuration bound to every page.
 * @param configurationHash - Reviewed digest of the configuration.
 * @param source - Logical source table scanned by this chain.
 * @param itemPages - Exact raw item pages in Scan order.
 * @param terminal - Whether the final page omits its continuation cursor.
 * @param evidenceVersion - Planning evidence schema emitted at runtime.
 * @param authorities - Optional exact authority tuple for every page.
 * @returns Materials and exact final progress.
 */
function createSourceChain(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  itemPages: readonly (readonly DynamoAttributeMap[])[],
  terminal = true,
  evidenceVersion: 2 | 3 = 3,
  authorities?:
    readonly WorkspaceSearchMigrationPlanningAuthorityBinding[],
): SourceChain {
  if (
    authorities !== undefined &&
    authorities.length !== itemPages.length
  ) {
    throw new Error('Expected one source authority per page.')
  }
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: configuration.tables[source].tableId,
    stateTableId: configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  let progress =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const materials: WorkspaceSearchMigrationPlanningSourcePageMaterial[] = []
  for (const [index, rawItems] of itemPages.entries()) {
    const items = structuredClone(rawItems)
    const hasNext = index < itemPages.length - 1 || !terminal
    const lastEvaluatedKey = hasNext
      ? exactItemKey(
          items[items.length - 1],
          configuration.tables[source],
        )
      : undefined
    const pageResult = reduceWorkspaceSearchMigrationSourceScanPage({
      configuration,
      configurationHash,
      source,
      previousCheckpoint: progress.checkpoint,
      page: {
        items,
        ...(lastEvaluatedKey === undefined
          ? {}
          : { lastEvaluatedKey }),
      },
    })
    const artifactDigest =
      digest(`source-artifact:${source}:${index}:${evidenceVersion}`)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority: authorities?.[index] ?? sourceAuthority,
      sourceArtifacts: [{
        objectKey:
          createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
            artifactDigest,
          ),
        versionId: `source-version-${source}-${index}`,
        contentDigest: artifactDigest,
      }],
      previousProgress: progress,
      pageResult,
    })
    if (page.purpose !== 'planning' || page.evidenceVersion !== 3) {
      throw new Error('Expected one version-three planning source page.')
    }
    const material = {
      page,
      items: structuredClone(items),
    } satisfies WorkspaceSearchMigrationPlanningSourcePageMaterial
    if (evidenceVersion === 2) {
      Reflect.set(material.page, 'evidenceVersion', 2)
      Reflect.deleteProperty(material.page, 'sourceArtifacts')
    }
    materials.push(material)
    progress =
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(progress, page)
  }
  return { materials, progress }
}

/**
 * Builds one exact target evidence chain and its raw page materials.
 *
 * @param configuration - Measured configuration bound to every page.
 * @param configurationHash - Reviewed configuration digest.
 * @param itemPages - Exact raw target item pages in Scan order.
 * @param terminal - Whether the final page omits its continuation cursor.
 * @param authorities - Optional exact authority tuple for every page.
 * @returns Materials and exact final progress.
 */
function createTargetChain(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  itemPages: readonly (readonly DynamoAttributeMap[])[],
  terminal = true,
  authorities?:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactAuthority[],
): TargetChain {
  if (
    authorities !== undefined &&
    authorities.length !== itemPages.length
  ) {
    throw new Error('Expected one target authority per page.')
  }
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId: configuration.tables['workspace-search'].tableId,
    stateTableId: configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  let progress =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
  const materials: WorkspaceSearchMigrationPlanningTargetPageMaterial[] = []
  for (const [index, rawItems] of itemPages.entries()) {
    const items = structuredClone(rawItems)
    const hasNext = index < itemPages.length - 1 || !terminal
    const lastEvaluatedKey = hasNext
      ? exactItemKey(
          items[items.length - 1],
          configuration.tables['workspace-search'],
        )
      : undefined
    const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
      configuration,
      configurationHash,
      previousCheckpoint: progress.checkpoint,
      page: {
        items,
        ...(lastEvaluatedKey === undefined
          ? {}
          : { lastEvaluatedKey }),
      },
    })
    const artifactDigest = digest(`target-artifact:${index}`)
    const page = createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      planningAuthority: authorities?.[index] ?? targetAuthority,
      targetArtifacts: [{
        objectKey:
          createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
            artifactDigest,
          ),
        versionId: `target-version-${index}`,
        contentDigest: artifactDigest,
      }],
      previousProgress: progress,
      pageResult,
    })
    const material = {
      page,
      items: structuredClone(items),
    } satisfies WorkspaceSearchMigrationPlanningTargetPageMaterial
    materials.push(material)
    progress =
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(progress, page)
  }
  return { materials, progress }
}

/**
 * Extracts the exact measured primary key from one complete fixture item.
 *
 * @param item - Exact source or target item.
 * @param table - Measured table identity selecting key attributes.
 * @returns Detached low-level primary key.
 */
function exactItemKey(
  item: DynamoAttributeMap | undefined,
  table: MigrationTableIdentity,
): DynamoAttributeMap {
  if (!item) throw new Error('Expected a non-empty continued page.')
  const key: DynamoAttributeMap = {}
  for (const descriptor of table.key) {
    const value = item[descriptor.name]
    if (value === undefined) {
      throw new Error('Expected every measured key attribute.')
    }
    key[descriptor.name] = structuredClone(value)
  }
  return key
}

/**
 * Requires one mapped candidate's exact present target state.
 *
 * @param candidate - Candidate derived from a canonical source fixture.
 * @returns Exact low-level target item selected by the source mapper.
 */
function requireAfterItem(
  candidate: ReturnType<
    typeof createWorkspaceSearchMigrationSourceCandidate
  >,
): DynamoAttributeMap {
  if (!candidate || !candidate.operation.after.exists) {
    throw new Error('Expected one mapped target put fixture.')
  }
  return structuredClone(candidate.operation.after.item)
}

/**
 * Creates and requires a source candidate for one Project Directory item.
 *
 * @param fixture - Configuration and digest owning the candidate.
 * @param sourceItem - Exact Project Directory source item.
 * @returns Required mapped source candidate.
 */
function requireSourceCandidate(
  fixture: JoinFixture,
  sourceItem: DynamoAttributeMap,
): NonNullable<
  ReturnType<typeof createWorkspaceSearchMigrationSourceCandidate>
> {
  const candidate = createWorkspaceSearchMigrationSourceCandidate({
    configurationHash: fixture.configurationHash,
    source: 'project-directory',
    sourceTable: fixture.configuration.tables['project-directory'],
    sourceItem,
  })
  if (!candidate) throw new Error('Expected a mapped source candidate.')
  return candidate
}

/**
 * Finds one required joined candidate by target digest.
 *
 * @param result - Complete joined planning material.
 * @param targetKeyDigest - Deterministic target key digest.
 * @returns Exact matching candidate.
 */
function requireCandidateByTarget(
  result: WorkspaceSearchMigrationPlanningJoinResult,
  targetKeyDigest: string,
): WorkspaceSearchMigrationPlanningJoinResult['candidates'][number] {
  const candidate = result.candidates.find(
    ({ operation }) => operation.targetKeyDigest === targetKeyDigest,
  )
  if (!candidate) throw new Error('Expected one joined target candidate.')
  return candidate
}

/**
 * Returns the stable target and operation identity of all joined candidates.
 *
 * @param result - Complete planning join result.
 * @returns Deterministically ordered digest-only candidate identity.
 */
function candidateIdentity(
  result: WorkspaceSearchMigrationPlanningJoinResult,
): readonly object[] {
  return result.candidates.map((candidate) => ({
    origin: candidate.origin,
    operationDigest: candidate.operationDigest,
    targetKeyDigest: candidate.operation.targetKeyDigest,
  }))
}

/**
 * Computes the exact limits consumed by one fixture.
 *
 * @param fixture - Complete valid planning material.
 * @returns Exact row, canonical-byte, and candidate counts.
 */
function measureFixtureLimits(
  fixture: JoinFixture,
): WorkspaceSearchMigrationPlanningJoinLimits {
  const items = [
    ...workspaceSearchMigrationSourceNames.flatMap((source) =>
      fixture.input.sourcePages[source].flatMap(({ items: pageItems }) =>
        pageItems
      )
    ),
    ...fixture.input.targetPages.flatMap(({ items: pageItems }) => pageItems),
  ]
  const encoder = new TextEncoder()
  return {
    maxTotalRows: items.length,
    maxTotalCanonicalItemBytes: items.reduce(
      (total, item) =>
        total +
        encoder.encode(serializeCanonicalAttributeMap(item)).byteLength,
      0,
    ),
    maxPlanOperations:
      joinWorkspaceSearchMigrationPlanningEvidence(fixture.input)
        .candidates.length,
  }
}

/**
 * Creates one canonical active Team row.
 *
 * @param teamId - Canonical Team identifier.
 * @param sortOrder - Physical directory display order.
 * @returns Exact low-level Project Directory item.
 */
function createTeamSourceItem(
  teamId: string,
  sortOrder: number,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: {
      S: `${String(sortOrder).padStart(6, '0')}#000000#TEAM#${teamId}`,
    },
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(sortOrder) },
    nameJa: { S: `チーム ${teamId}` },
    nameEn: { S: `Team ${teamId}` },
    expanded: { BOOL: true },
  }
}

/**
 * Creates one recognized non-target Project Directory row.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored source item.
 */
function createIgnoredProjectDirectoryItem(
  identifier: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
    entryType: { S: 'workspace-member' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one key-valid Project Directory row rejected by the mapper.
 *
 * @param identifier - Unique physical key and entity suffix.
 * @returns Exact low-level invalid source item.
 */
function createInvalidProjectDirectoryItem(
  identifier: string,
): DynamoAttributeMap {
  return {
    ...createTeamSourceItem(identifier, 9),
    nameEn: { N: '1' },
  }
}

/**
 * Creates one canonical Work Item source row.
 *
 * @param issueId - Canonical Work Item identifier.
 * @returns Exact low-level Work Item item.
 */
function createWorkItemSourceItem(issueId: string): DynamoAttributeMap {
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
    description: { S: 'Planning join fixture.' },
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
 * Creates one recognized saved-view target row.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level ignored target item.
 */
function createIgnoredTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one key-valid target row rejected by target classification.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level invalid target item.
 */
function createInvalidTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'search-document' },
  }
}

/**
 * Creates one deterministic test digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}

/**
 * Captures one safe public join failure.
 *
 * @param operation - Deferred public join invocation.
 * @returns Exact stable migration failure.
 */
function captureJoinFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected Workspace Search planning join failure.')
}

/**
 * Requires one public join invocation to fail without tenant values.
 *
 * @param operation - Deferred join invocation.
 * @param code - Optional exact stable failure code.
 */
function expectJoinFailure(
  operation: () => unknown,
  code?: WorkspaceSearchMigrationFailureCode,
): void {
  const failure = captureJoinFailure(operation)
  if (code !== undefined) expect(failure.code).toBe(code)
  expect(failure.message).not.toContain('workspace-1')
}

/**
 * Creates the complete measured configuration bound to all fixtures.
 *
 * @returns Reviewed migration configuration.
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
      'workspace-search': createSupportingTable('workspace-search'),
      'migration-state': createSupportingTable('migration-state'),
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
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportingTable(
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
    true,
  )
}

/**
 * Creates one stable measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact base-table key descriptor.
 * @param deletionProtection - Measured deletion protection state.
 * @returns Complete table identity fixture.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
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
    deletionProtection,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? digest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the measured primary key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and sort key descriptors.
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
