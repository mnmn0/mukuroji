import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationPlanningAuthorityProvenance,
  WorkspaceSearchMigrationPlanningAuthorityTraceEntry,
  WorkspaceSearchMigrationPlanningEvidenceChainRoot,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPlanningProvenanceArtifact,
  createWorkspaceSearchMigrationSealedPlanningAuthority,
  parseWorkspaceSearchMigrationPlanningProvenanceArtifact,
  parseWorkspaceSearchMigrationSealedPlanningAuthority,
  serializeWorkspaceSearchMigrationPlanningProvenanceArtifact,
  serializeWorkspaceSearchMigrationSealedPlanningAuthority,
  type WorkspaceSearchMigrationSealedPlanningAuthority,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES,
  WorkspaceSearchMigrationSealedPlanningAuthorityError,
} from './migration-sealed-planning-authority'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceCheckpointDigest,
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
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'

const runId = 'sealed-planning-run'
const ownerId = 'sealed-planning-owner'
const historicalFenceToken = 17
const historicalPointerRevision = 23
const planCreatedAt = '2026-07-26T01:02:00.000Z'
const sealedAt = '2026-07-26T01:03:00.000Z'

describe('Workspace Search sealed planning authority', () => {
  test(
    'round-trips canonical provenance and authority roots without changing plan-seal v2',
    () => {
      const fixture = createSealedPlanningFixture()
      const originalPlanSeal = structuredClone(fixture.planSeal)
      const originalPlanSealBytes =
        serializeWorkspaceSearchPlanSeal(fixture.planSeal)

      const provenanceBytes =
        serializeWorkspaceSearchMigrationPlanningProvenanceArtifact(
          fixture.provenanceArtifact,
        )
      expect(provenanceBytes).toEqual(
        encodeCanonical(fixture.provenanceArtifact),
      )
      expect(
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          provenanceBytes,
        ),
      ).toEqual(fixture.provenanceArtifact)
      expect(
        serializeWorkspaceSearchMigrationPlanningProvenanceArtifact(
          parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
            provenanceBytes,
          ),
        ),
      ).toEqual(provenanceBytes)

      const authority =
        createWorkspaceSearchMigrationSealedPlanningAuthority(
          fixture.authorityInput,
        )
      const authorityBytes =
        serializeWorkspaceSearchMigrationSealedPlanningAuthority(
          authority,
        )
      expect(authorityBytes).toEqual(encodeCanonical(authority))
      expect(
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          authorityBytes,
        ),
      ).toEqual(authority)
      expect(
        serializeWorkspaceSearchMigrationSealedPlanningAuthority(
          parseWorkspaceSearchMigrationSealedPlanningAuthority(
            authorityBytes,
          ),
        ),
      ).toEqual(authorityBytes)
      expect(authority).toMatchObject({
        authorityVersion: 1,
        planDigest: fixture.planSeal.planDigest,
        planOperationCount: fixture.planSeal.planOperationCount,
        planSealReference: fixture.authorityInput.planSealReference,
      })

      expect(fixture.planSeal).toEqual(originalPlanSeal)
      expect(
        serializeWorkspaceSearchPlanSeal(fixture.planSeal),
      ).toEqual(originalPlanSealBytes)
      expect(originalPlanSeal.sealVersion).toBe(2)
    },
  )

  test(
    'binds every provenance transition to historical receipt owner, run, fence, and digest',
    () => {
      const fixture = createSealedPlanningFixture()

      const wrongOwner =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(wrongOwner, 'ownerId', 'different-owner')
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongOwner],
        })
      )

      const wrongRun =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(wrongRun.receipt, 'runId', 'different-run')
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongRun],
        })
      )

      const wrongFence =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongFence.receipt,
        'fenceToken',
        historicalFenceToken + 1,
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongFence],
        })
      )

      const wrongDigest =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongDigest,
        'receiptDigest',
        digest('different-historical-receipt'),
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongDigest],
        })
      )

      const wrongConfiguration =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongConfiguration,
        'configurationHash',
        digest('different-configuration'),
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongConfiguration],
        })
      )

      const wrongStateTable =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(wrongStateTable, 'stateTableId', 'different-state-table')
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [wrongStateTable],
        })
      )

      const artifactShapedBinding =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.deleteProperty(artifactShapedBinding, 'configurationHash')
      Reflect.deleteProperty(artifactShapedBinding, 'stateTableId')
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: [artifactShapedBinding],
        })
      )
    },
  )

  test(
    'accepts only the same current authority or a monotonic successor',
    () => {
      const fixture = createSealedPlanningFixture()

      expect(
        createWorkspaceSearchMigrationSealedPlanningAuthority(
          fixture.authorityInput,
        ).currentAuthority,
      ).toEqual({
        ownerId,
        fenceToken: historicalFenceToken,
        maintenanceEvidencePointerRevision:
          historicalPointerRevision,
        maintenanceEvidenceReceiptDigest:
          fixture.historicalReceiptBinding.receiptDigest,
      })

      const renewed = createCurrentAuthority(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalFenceToken,
        historicalPointerRevision + 1,
        'renewed-current-receipt',
      )
      expect(
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: renewed,
        }).currentAuthority,
      ).toMatchObject({
        ownerId,
        fenceToken: historicalFenceToken,
        maintenanceEvidencePointerRevision:
          historicalPointerRevision + 1,
      })

      const takeover = createCurrentAuthority(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        'takeover-owner',
        historicalFenceToken + 1,
        historicalPointerRevision + 2,
        'takeover-current-receipt',
      )
      expect(
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: takeover,
        }).currentAuthority,
      ).toMatchObject({
        ownerId: 'takeover-owner',
        fenceToken: historicalFenceToken + 1,
        maintenanceEvidencePointerRevision:
          historicalPointerRevision + 2,
      })

      const lowerRevision = {
        ...fixture.currentAuthority,
        maintenanceEvidencePointerRevision:
          historicalPointerRevision - 1,
      }
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: lowerRevision,
        })
      )

      const lowerFence = createCurrentAuthority(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalFenceToken - 1,
        historicalPointerRevision + 1,
        'lower-fence-current-receipt',
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: lowerFence,
        })
      )

      const sameFenceOwnerSwap = createCurrentAuthority(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        'different-owner',
        historicalFenceToken,
        historicalPointerRevision + 1,
        'owner-swap-current-receipt',
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: sameFenceOwnerSwap,
        })
      )

      const reusedHistoricalReceipt = {
        ...fixture.currentAuthority,
        maintenanceEvidencePointerRevision:
          historicalPointerRevision + 1,
      }
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: reusedHistoricalReceipt,
        })
      )

      const changedSameRevision = createCurrentAuthority(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalFenceToken,
        historicalPointerRevision,
        'changed-same-revision-receipt',
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: changedSameRevision,
        })
      )

      const evaluatedBeforeValidationReceipt = {
        ...renewed.maintenanceEvidenceReceipt,
        validatedAt: '2026-07-26T01:02:45.000Z',
      }
      const evaluatedBeforeValidation = {
        ...renewed,
        maintenanceEvidenceReceipt: evaluatedBeforeValidationReceipt,
        maintenanceEvidenceReceiptDigest: createMigrationDigest(
          evaluatedBeforeValidationReceipt,
        ),
      }
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: evaluatedBeforeValidation,
        })
      )

      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: renewed,
          sealedAt: '2026-07-26T01:03:05.000Z',
        })
      )

      const nearExpiryReceipt = {
        ...renewed.maintenanceEvidenceReceipt,
        oldestObservationAt: '2026-07-26T00:58:09.999Z',
        validUntil: '2026-07-26T01:03:10.000Z',
      }
      const nearExpiryAuthority = createCurrentAuthorityFromReceipt(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalPointerRevision + 1,
        nearExpiryReceipt,
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: nearExpiryAuthority,
        })
      )

      const malformedWindowReceipt = {
        ...renewed.maintenanceEvidenceReceipt,
        validUntil: '2026-07-26T01:04:00.000Z',
      }
      const malformedWindowAuthority = createCurrentAuthorityFromReceipt(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalPointerRevision + 1,
        malformedWindowReceipt,
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: malformedWindowAuthority,
        })
      )

      const zeroRuntimeReceipt = {
        ...renewed.maintenanceEvidenceReceipt,
        runtimeRevision: 0,
      }
      const zeroRuntimeAuthority = createCurrentAuthorityFromReceipt(
        fixture.configurationHash,
        fixture.configuration.tables['migration-state'].tableId,
        ownerId,
        historicalPointerRevision + 1,
        zeroRuntimeReceipt,
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          currentAuthority: zeroRuntimeAuthority,
        })
      )
    },
  )

  test(
    'rejects accessor and proxy inputs before seal values can diverge',
    () => {
      const fixture = createSealedPlanningFixture()
      const accessorKeys: readonly (
        keyof Pick<
          typeof fixture.authorityInput,
          | 'configuration'
          | 'planSeal'
          | 'sourceProgress'
          | 'targetProgress'
        >
      )[] = [
        'configuration',
        'planSeal',
        'sourceProgress',
        'targetProgress',
      ]
      for (const key of accessorKeys) {
        let reads = 0
        const accessorInput = { ...fixture.authorityInput }
        Reflect.defineProperty(accessorInput, key, {
          configurable: true,
          enumerable: true,
          get() {
            reads += 1
            return fixture.authorityInput[key]
          },
        })
        expectSealedAuthorityFailure(() =>
          createWorkspaceSearchMigrationSealedPlanningAuthority(
            accessorInput,
          )
        )
        expect(reads).toBe(0)
      }

      const accessorConfiguration =
        structuredClone(fixture.configuration)
      const stateTable =
        accessorConfiguration.tables['migration-state']
      let stateTableReads = 0
      Reflect.defineProperty(
        accessorConfiguration.tables,
        'migration-state',
        {
          configurable: true,
          enumerable: true,
          get() {
            stateTableReads += 1
            return stateTableReads === 1
              ? stateTable
              : { ...stateTable, tableId: 'divergent-state-table-id' }
          },
        },
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          configuration: accessorConfiguration,
        })
      )
      expect(stateTableReads).toBe(0)

      const accessorSourceProgress =
        structuredClone(fixture.sourceProgress)
      const sourceProgress =
        accessorSourceProgress['project-directory']
      const sourceEvidenceDigest = sourceProgress.evidenceDigest
      let sourceDigestReads = 0
      Reflect.defineProperty(sourceProgress, 'evidenceDigest', {
        configurable: true,
        enumerable: true,
        get() {
          sourceDigestReads += 1
          return sourceDigestReads === 1
            ? sourceEvidenceDigest
            : digest('divergent-source-progress')
        },
      })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          sourceProgress: accessorSourceProgress,
        })
      )
      expect(sourceDigestReads).toBe(0)

      const accessorTargetProgress =
        structuredClone(fixture.targetProgress)
      const targetEvidenceDigest =
        accessorTargetProgress.evidenceDigest
      let targetDigestReads = 0
      Reflect.defineProperty(
        accessorTargetProgress,
        'evidenceDigest',
        {
          configurable: true,
          enumerable: true,
          get() {
            targetDigestReads += 1
            return targetDigestReads === 1
              ? targetEvidenceDigest
              : digest('divergent-target-progress')
          },
        },
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          targetProgress: accessorTargetProgress,
        })
      )
      expect(targetDigestReads).toBe(0)

      let proxyReads = 0
      const targetProxy = new Proxy(fixture.targetProgress, {
        get(target, key, receiver) {
          proxyReads += 1
          return Reflect.get(target, key, receiver)
        },
      })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          targetProgress: targetProxy,
        })
      )
      expect(proxyReads).toBe(0)
    },
  )

  test(
    'commits exactly five canonical heads and all measured table incarnations',
    () => {
      const fixture = createSealedPlanningFixture()
      const authority =
        createWorkspaceSearchMigrationSealedPlanningAuthority(
          fixture.authorityInput,
        )
      expect(authority.evidenceHeads.map(({ chain }) => chain))
        .toEqual([
          ...workspaceSearchMigrationSourceNames,
          'workspace-search',
        ])
      expect(authority.tableIds).toEqual({
        'project-directory':
          fixture.configuration.tables['project-directory'].tableId,
        'work-items':
          fixture.configuration.tables['work-items'].tableId,
        collaboration:
          fixture.configuration.tables.collaboration.tableId,
        documents: fixture.configuration.tables.documents.tableId,
        'workspace-search':
          fixture.configuration.tables['workspace-search'].tableId,
        'migration-state':
          fixture.configuration.tables['migration-state'].tableId,
      })

      for (const source of workspaceSearchMigrationSourceNames) {
        const wrongTableProgress =
          structuredClone(fixture.sourceProgress)
        Reflect.set(
          wrongTableProgress[source],
          'sourceTableId',
          `wrong-table-id-${source}`,
        )
        expectSealedAuthorityFailure(() =>
          createWorkspaceSearchMigrationSealedPlanningAuthority({
            ...fixture.authorityInput,
            sourceProgress: wrongTableProgress,
          })
        )

        const wrongHeadProgress =
          structuredClone(fixture.sourceProgress)
        Reflect.set(
          wrongHeadProgress[source],
          'evidenceDigest',
          digest(`wrong-head-${source}`),
        )
        expectSealedAuthorityFailure(() =>
          createWorkspaceSearchMigrationSealedPlanningAuthority({
            ...fixture.authorityInput,
            sourceProgress: wrongHeadProgress,
          })
        )
      }

      const wrongTargetTable =
        structuredClone(fixture.targetProgress)
      Reflect.set(
        wrongTargetTable,
        'targetTableId',
        'wrong-target-table-id',
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          targetProgress: wrongTargetTable,
        })
      )

      const wrongTargetHead =
        structuredClone(fixture.targetProgress)
      Reflect.set(
        wrongTargetHead,
        'evidenceDigest',
        digest('wrong-target-head'),
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          targetProgress: wrongTargetHead,
        })
      )

      const wrongStateTable =
        structuredClone(fixture.sourceProgress)
      Reflect.set(
        wrongStateTable['project-directory'],
        'stateTableId',
        'wrong-state-table-id',
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          sourceProgress: wrongStateTable,
        })
      )
    },
  )

  test(
    'rejects root and provenance tampering, extra fields, noncanonical bytes, and oversize input',
    () => {
      const fixture = createSealedPlanningFixture()
      const authority =
        createWorkspaceSearchMigrationSealedPlanningAuthority(
          fixture.authorityInput,
        )

      const tamperedAuthority = structuredClone(authority)
      Reflect.set(
        tamperedAuthority,
        'authorityDigest',
        digest('tampered-authority'),
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeCanonical(tamperedAuthority),
        )
      )

      const inconsistentEmptyPlan = structuredClone(authority)
      Reflect.set(inconsistentEmptyPlan, 'planOperationCount', 1)
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeAuthorityWithRecomputedDigest(inconsistentEmptyPlan),
        )
      )

      const emptyHistoricalReceipts = structuredClone(authority)
      Reflect.set(emptyHistoricalReceipts, 'historicalReceiptCount', 0)
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeAuthorityWithRecomputedDigest(emptyHistoricalReceipts),
        )
      )

      const missingTableRole = structuredClone(authority)
      Reflect.deleteProperty(missingTableRole.tableIds, 'documents')
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeAuthorityWithRecomputedDigest(missingTableRole),
        )
      )

      const extraTableRole = structuredClone(authority)
      Reflect.set(
        extraTableRole.tableIds,
        'unexpected-table-role',
        'unexpected-table-id',
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeAuthorityWithRecomputedDigest(extraTableRole),
        )
      )

      const authorityWithExtraField = structuredClone(authority)
      Reflect.set(
        authorityWithExtraField,
        'rawTenantTableName',
        'sensitive-table-name',
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          encodeCanonical(authorityWithExtraField),
        )
      )

      const provenanceWithExtraField =
        structuredClone(fixture.provenanceArtifact)
      Reflect.set(
        provenanceWithExtraField,
        'rawMaintenanceEvidence',
        'sensitive-evidence',
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          encodeCanonical(provenanceWithExtraField),
        )
      )

      const provenanceReceiptTamper =
        structuredClone(fixture.provenanceArtifact)
      const firstReceipt =
        provenanceReceiptTamper.historicalReceipts[0]
      if (firstReceipt === undefined) {
        throw new Error('Expected one historical receipt fixture.')
      }
      Reflect.set(firstReceipt.receipt, 'runtimeRevision', 99)
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          encodeCanonical(provenanceReceiptTamper),
        )
      )

      const canonicalAuthority =
        serializeWorkspaceSearchMigrationSealedPlanningAuthority(
          authority,
        )
      const paddedAuthority = new TextEncoder().encode(
        ` ${new TextDecoder().decode(canonicalAuthority)}`,
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          paddedAuthority,
        )
      )

      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          new Uint8Array(
            WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_MAX_BYTES +
              1,
          ),
        )
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          new Uint8Array(
            WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES +
              1,
          ),
        )
      )

      const oversizedHistoricalBindings = Array.from(
        { length: 10_001 },
        () => fixture.historicalReceiptBinding,
      )
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: fixture.provenance,
          historicalReceiptBindings: oversizedHistoricalBindings,
        })
      )

      const firstTraceEntry = fixture.provenance.authorityTrace[0]
      if (firstTraceEntry === undefined) {
        throw new Error('Expected one authority-trace fixture entry.')
      }
      const oversizedProvenance = {
        ...fixture.provenance,
        authorityTrace: Array.from(
          { length: 10_001 },
          () => firstTraceEntry,
        ),
      }
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          provenance: oversizedProvenance,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      )
    },
  )
})

/**
 * Creates one complete, internally consistent sealed-planning fixture.
 *
 * @returns Plan v2, five terminal heads, provenance, receipts, and seal input.
 */
function createSealedPlanningFixture() {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const historicalReceipt =
    createMaintenanceReceipt(
      historicalFenceToken,
      'historical-receipt',
    )
  const historicalReceiptDigest =
    createMigrationDigest(historicalReceipt)
  const authorityBinding: WorkspaceSearchMigrationPlanningAuthorityBinding = {
    ownerId,
    fenceToken: historicalFenceToken,
    maintenanceEvidencePointerRevision:
      historicalPointerRevision,
    maintenanceEvidenceReceiptDigest:
      historicalReceiptDigest,
  }
  const sourceProgress = {
    'project-directory': createTerminalSourceProgress(
      configuration,
      configurationHash,
      'project-directory',
      authorityBinding,
    ),
    'work-items': createTerminalSourceProgress(
      configuration,
      configurationHash,
      'work-items',
      authorityBinding,
    ),
    collaboration: createTerminalSourceProgress(
      configuration,
      configurationHash,
      'collaboration',
      authorityBinding,
    ),
    documents: createTerminalSourceProgress(
      configuration,
      configurationHash,
      'documents',
      authorityBinding,
    ),
  }
  const targetProgress = createTerminalTargetProgress(
    configuration,
    configurationHash,
    authorityBinding,
  )
  const provenance = createProvenance(
    configurationHash,
    configuration.tables['migration-state'].tableId,
    sourceProgress,
    targetProgress,
    authorityBinding,
  )
  const historicalReceiptBinding:
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding = {
      configurationHash,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      ownerId,
      receiptDigest: historicalReceiptDigest,
      receipt: historicalReceipt,
    }
  const provenanceArtifact =
    createWorkspaceSearchMigrationPlanningProvenanceArtifact({
      provenance,
      historicalReceiptBindings: [historicalReceiptBinding],
    })
  const planSeal = createEmptyPlanSeal(configurationHash)
  const currentAuthority = createCurrentAuthorityFromReceipt(
    configurationHash,
    configuration.tables['migration-state'].tableId,
    ownerId,
    historicalPointerRevision,
    historicalReceipt,
  )
  const authorityInput = {
    runId,
    configuration,
    configurationHash,
    planSeal,
    planSealReference: {
      objectKey:
        'workspace-search/v1/plans/sealed-planning-run/plan-seal.json',
      versionId: 'plan-seal-version-1',
      contentDigest: createMigrationDigest(planSeal),
    },
    planManifestReference: {
      objectKey:
        'workspace-search/v1/plans/sealed-planning-run/manifest.json',
      versionId: 'plan-manifest-version-1',
      contentDigest: digest('plan-manifest'),
    },
    planningProvenanceArtifact: provenanceArtifact,
    planningProvenanceArtifactReference: {
      objectKey:
        'workspace-search/v1/plans/sealed-planning-run/provenance.json',
      versionId: 'planning-provenance-version-1',
      contentDigest: createMigrationDigest(provenanceArtifact),
    },
    sourceProgress,
    targetProgress,
    currentAuthority,
    sealedAt,
  } satisfies Parameters<
    typeof createWorkspaceSearchMigrationSealedPlanningAuthority
  >[0]
  return {
    configuration,
    configurationHash,
    planSeal,
    sourceProgress,
    targetProgress,
    provenance,
    historicalReceiptBinding,
    provenanceArtifact,
    currentAuthority,
    authorityInput,
  }
}

/**
 * Creates one completed empty source evidence head through public reducers.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param source - Exact logical source chain.
 * @param authority - Durable authority bound to its single page.
 * @returns Exact one-page terminal source progress.
 */
function createTerminalSourceProgress(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: configuration.tables[source].tableId,
    stateTableId:
      configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
      identity,
    )
  const pageResult =
    reduceWorkspaceSearchMigrationSourceScanPage({
      configuration,
      configurationHash,
      source,
      previousCheckpoint: initial.checkpoint,
      page: { items: [] },
    })
  const artifactDigest = digest(`source-artifact:${source}`)
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
          artifactDigest,
        ),
      versionId: `source-version-${source}`,
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult,
  })
  return advanceWorkspaceSearchMigrationSourceEvidenceProgress(
    initial,
    page,
  )
}

/**
 * Creates one completed empty target evidence head through public reducers.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param authority - Durable authority bound to its single page.
 * @returns Exact one-page terminal target progress.
 */
function createTerminalTargetProgress(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId:
      configuration.tables['workspace-search'].tableId,
    stateTableId:
      configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
      identity,
    )
  const pageResult =
    reduceWorkspaceSearchMigrationTargetScanPage({
      configuration,
      configurationHash,
      previousCheckpoint: initial.checkpoint,
      page: { items: [] },
    })
  const artifactDigest = digest('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version-1',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult,
  })
  return advanceWorkspaceSearchMigrationTargetEvidenceProgress(
    initial,
    page,
  )
}

/**
 * Creates canonical five-chain provenance for one-page terminal heads.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param stateTableId - Immutable migration-state table incarnation.
 * @param sourceProgress - Four exact terminal source heads.
 * @param targetProgress - Exact terminal target head.
 * @param authority - Shared historical page authority.
 * @returns Canonical provenance with its self-authenticating digest.
 */
function createProvenance(
  configurationHash: string,
  stateTableId: string,
  sourceProgress: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >,
  targetProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): WorkspaceSearchMigrationPlanningAuthorityProvenance {
  const chainRoots:
    WorkspaceSearchMigrationPlanningEvidenceChainRoot[] = []
  const authorityTrace:
    WorkspaceSearchMigrationPlanningAuthorityTraceEntry[] = []
  for (const source of workspaceSearchMigrationSourceNames) {
    const progress = sourceProgress[source]
    chainRoots.push({
      chain: source,
      pageCount: progress.pageSequence,
      terminalEvidenceDigest: progress.evidenceDigest,
      terminalCheckpointDigest:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          progress.checkpoint,
        ),
    })
    authorityTrace.push({
      chain: source,
      pageSequence: progress.pageSequence,
      evidenceDigest: progress.evidenceDigest,
      ...authority,
    })
  }
  chainRoots.push({
    chain: 'workspace-search',
    pageCount: targetProgress.pageSequence,
    terminalEvidenceDigest: targetProgress.evidenceDigest,
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationTargetCheckpointDigest(
        targetProgress.checkpoint,
      ),
  })
  authorityTrace.push({
    chain: 'workspace-search',
    pageSequence: targetProgress.pageSequence,
    evidenceDigest: targetProgress.evidenceDigest,
    ...authority,
  })
  const provenanceFields = {
    kind: 'workspace-search-planning-authority-provenance',
    provenanceVersion: 1,
    runId,
    configurationHash,
    stateTableId,
    chainRoots,
    authorityTrace,
    authorityTransitions: [authority],
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAuthorityProvenance,
    'provenanceDigest'
  >
  return {
    ...provenanceFields,
    provenanceDigest: createMigrationDigest(provenanceFields),
  }
}

/**
 * Creates one canonical maintenance receipt for a selected fence.
 *
 * @param fenceToken - Positive lease fence authorizing the receipt.
 * @param label - Stable digest and locator fixture label.
 * @returns Complete fresh maintenance receipt.
 */
function createMaintenanceReceipt(
  fenceToken: number,
  label: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(`${label}:evidence`),
    evidenceLocator:
      `workspace-search/v1/maintenance/${label}.json`,
    runtimeRevision: 7,
    fenceToken,
    validatedAt: '2026-07-26T01:00:00.000Z',
    oldestObservationAt: '2026-07-26T00:59:00.000Z',
    validUntil: '2026-07-26T01:04:00.001Z',
  }
}

/**
 * Creates current authority around one exact pre-existing receipt.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param stateTableId - Immutable migration-state table incarnation.
 * @param currentOwnerId - Current lease owner.
 * @param pointerRevision - Positive current receipt-pointer revision.
 * @param receipt - Exact current maintenance receipt.
 * @returns Complete fresh current authority.
 */
function createCurrentAuthorityFromReceipt(
  configurationHash: string,
  stateTableId: string,
  currentOwnerId: string,
  pointerRevision: number,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash,
    stateTableId,
    lease: {
      runId,
      ownerId: currentOwnerId,
      fenceToken: receipt.fenceToken,
      heartbeatAt: '2026-07-26T01:02:15.000Z',
      expiresAt: '2026-07-26T01:03:15.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: '2026-07-26T01:02:30.000Z',
  }
}

/**
 * Creates fresh current authority with a distinct canonical receipt.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param stateTableId - Immutable migration-state table incarnation.
 * @param currentOwnerId - Current lease owner.
 * @param fenceToken - Positive current global fence.
 * @param pointerRevision - Positive current receipt-pointer revision.
 * @param receiptLabel - Stable unique receipt fixture label.
 * @returns Complete fresh current authority.
 */
function createCurrentAuthority(
  configurationHash: string,
  stateTableId: string,
  currentOwnerId: string,
  fenceToken: number,
  pointerRevision: number,
  receiptLabel: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  return createCurrentAuthorityFromReceipt(
    configurationHash,
    stateTableId,
    currentOwnerId,
    pointerRevision,
    createMaintenanceReceipt(fenceToken, receiptLabel),
  )
}

/**
 * Creates the canonical empty plan-seal v2 retained by the new authority root.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @returns Existing strict plan-seal v2 fixture.
 */
function createEmptyPlanSeal(
  configurationHash: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run-evidence'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Encodes one JSON-compatible value as exact canonical UTF-8 bytes.
 *
 * @param value - JSON-compatible fixture value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Recomputes the compact authority self-digest after fixture mutation.
 *
 * @param authority - Mutated compact authority fixture.
 * @returns Canonical bytes carrying the recomputed self-digest.
 */
function encodeAuthorityWithRecomputedDigest(
  authority: WorkspaceSearchMigrationSealedPlanningAuthority,
): Uint8Array {
  const authorityFields = { ...authority }
  Reflect.deleteProperty(authorityFields, 'authorityDigest')
  return encodeCanonical({
    ...authorityFields,
    authorityDigest: createMigrationDigest(authorityFields),
  })
}

/**
 * Requires one public sealed-planning boundary to fail safely.
 *
 * @param operation - Deferred invalid public invocation.
 */
function expectSealedAuthorityFailure(
  operation: () => unknown,
): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationSealedPlanningAuthorityError,
    )
    if (
      error instanceof
        WorkspaceSearchMigrationSealedPlanningAuthorityError
    ) {
      expect(error.code).toBe('INVALID_SEALED_PLANNING_AUTHORITY')
      expect(error.message).toBe(
        'INVALID_SEALED_PLANNING_AUTHORITY',
      )
      return
    }
  }
  throw new Error('Expected sealed planning authority failure.')
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable configuration fixture.
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
      'workspace-search':
        createSupportingTable('workspace-search'),
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
 * Creates one measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured target or state table identity.
 *
 * @param role - Logical supporting-table role.
 * @returns Stable supporting-table identity.
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
 * Creates one complete measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact base-table key descriptor.
 * @param deletionProtection - Measured deletion-protection state.
 * @returns Complete table identity.
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
 * Returns the measured primary-key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and sort-key descriptors.
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
 * Creates one deterministic lowercase SHA-256 fixture digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}
