import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchMigrationScanSnapshotDigest,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
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
import {
  createWorkspaceSearchMigrationSourceCandidate,
} from './migration-planner'
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
  createWorkspaceSearchMigrationSourceEvidencePage,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
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
      const parsedProvenance =
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          provenanceBytes,
        )
      expect(parsedProvenance).toEqual(fixture.provenanceArtifact)
      expect(parsedProvenance).toMatchObject({
        sourceOperationCount: 2,
        orphanOperationCount: 1,
        planOperationCount: 3,
        tableIds: {
          'project-directory':
            fixture.configuration.tables['project-directory'].tableId,
          'workspace-search':
            fixture.configuration.tables['workspace-search'].tableId,
          'migration-state':
            fixture.configuration.tables['migration-state'].tableId,
        },
      })
      expect(
        fixture.sourceProgress['project-directory'].checkpoint.aggregate,
      ).toMatchObject({
        mapped: 2,
        projected: 1,
        deleted: 1,
      })
      expect(fixture.targetProgress.checkpoint.aggregate).toMatchObject({
        owned: 3,
      })
      const targetAggregate =
        fixture.targetProgress.checkpoint.aggregate
      expect(parsedProvenance.planningSnapshotDigest).toBe(
        createWorkspaceSearchMigrationScanSnapshotDigest({
          configurationHash: fixture.configurationHash,
          sources: {
            'project-directory':
              fixture.sourceProgress['project-directory']
                .checkpoint.aggregate,
            'work-items':
              fixture.sourceProgress['work-items'].checkpoint.aggregate,
            collaboration:
              fixture.sourceProgress.collaboration.checkpoint.aggregate,
            documents:
              fixture.sourceProgress.documents.checkpoint.aggregate,
          },
          target: {
            scanned: targetAggregate.scanned,
            mapped: targetAggregate.owned,
            ignored: targetAggregate.ignored,
            invalid: targetAggregate.invalid,
            projected: 1,
            deleted: 2,
            keyDigest: targetAggregate.keyDigest,
            contentDigest: targetAggregate.contentDigest,
            pageCount: targetAggregate.pageCount,
          },
        }),
      )
      const binaryCursorWitness =
        parsedProvenance.evidencePageWitnesses.sources[
          'project-directory'
        ][0]
      if (binaryCursorWitness === undefined) {
        throw new Error('Expected one binary-cursor page witness.')
      }
      const binaryCursorPage =
        parseWorkspaceSearchMigrationSourceEvidencePage(
          new Uint8Array(
            Buffer.from(binaryCursorWitness, 'base64'),
          ),
        )
      expect(binaryCursorPage.checkpoint.cursor).toEqual({
        partitionKey: { B: Uint8Array.from([0, 1, 255]) },
      })
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
        createProvenanceArtifactWithBindings(fixture, [wrongOwner])
      )

      const wrongRun =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(wrongRun.receipt, 'runId', 'different-run')
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [wrongRun])
      )

      const wrongFence =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongFence.receipt,
        'fenceToken',
        historicalFenceToken + 1,
      )
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [wrongFence])
      )

      const wrongDigest =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongDigest,
        'receiptDigest',
        digest('different-historical-receipt'),
      )
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [wrongDigest])
      )

      const wrongConfiguration =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(
        wrongConfiguration,
        'configurationHash',
        digest('different-configuration'),
      )
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [
          wrongConfiguration,
        ])
      )

      const wrongStateTable =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.set(wrongStateTable, 'stateTableId', 'different-state-table')
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [wrongStateTable])
      )

      const artifactShapedBinding =
        structuredClone(fixture.historicalReceiptBinding)
      Reflect.deleteProperty(artifactShapedBinding, 'configurationHash')
      Reflect.deleteProperty(artifactShapedBinding, 'stateTableId')
      expectSealedAuthorityFailure(() =>
        createProvenanceArtifactWithBindings(fixture, [
          artifactShapedBinding,
        ])
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

      const sourceBytesWithAccessor = {
        ...fixture.sourceEvidencePageBytes,
      }
      let sourceBytesReads = 0
      Reflect.defineProperty(sourceBytesWithAccessor, 'documents', {
        configurable: true,
        enumerable: true,
        get() {
          sourceBytesReads += 1
          return fixture.sourceEvidencePageBytes.documents
        },
      })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: sourceBytesWithAccessor,
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      )
      expect(sourceBytesReads).toBe(0)

      const firstDocumentPage =
        fixture.sourceEvidencePageBytes.documents[0]
      if (firstDocumentPage === undefined) {
        throw new Error('Expected one document evidence page.')
      }
      let pageByteReads = 0
      let pageBytePrototypeReads = 0
      const pageBytesProxy = new Proxy(firstDocumentPage, {
        get(target, key, receiver) {
          pageByteReads += 1
          return Reflect.get(target, key, receiver)
        },
        getPrototypeOf(target) {
          pageBytePrototypeReads += 1
          return Reflect.getPrototypeOf(target)
        },
      })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: {
            ...fixture.sourceEvidencePageBytes,
            documents: [pageBytesProxy],
          },
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      )
      expect(pageByteReads).toBe(0)
      expect(pageBytePrototypeReads).toBe(0)
    },
  )

  test(
    'snapshots byte inputs without accessors and rejects Proxy or shared memory',
    () => {
      const fixture = createSealedPlanningFixture()
      const authority =
        createWorkspaceSearchMigrationSealedPlanningAuthority(
          fixture.authorityInput,
        )
      const authorityBytes =
        serializeWorkspaceSearchMigrationSealedPlanningAuthority(
          authority,
        )
      const accessorBytes = new Uint8Array(authorityBytes)
      let byteLengthReads = 0
      Reflect.defineProperty(accessorBytes, 'byteLength', {
        configurable: true,
        enumerable: false,
        get() {
          byteLengthReads += 1
          return 0
        },
      })

      expect(
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          accessorBytes,
        ),
      ).toEqual(authority)
      expect(byteLengthReads).toBe(0)

      let proxyReads = 0
      let proxyPrototypeReads = 0
      const bytesProxy = new Proxy(authorityBytes, {
        get(target, key, receiver) {
          proxyReads += 1
          return Reflect.get(target, key, receiver)
        },
        getPrototypeOf(target) {
          proxyPrototypeReads += 1
          return Reflect.getPrototypeOf(target)
        },
      })
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(bytesProxy)
      )
      expect(proxyReads).toBe(0)
      expect(proxyPrototypeReads).toBe(0)

      const sharedAuthorityBytes = new Uint8Array(
        new SharedArrayBuffer(authorityBytes.byteLength),
      )
      sharedAuthorityBytes.set(authorityBytes)
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationSealedPlanningAuthority(
          sharedAuthorityBytes,
        )
      )

      const sourcePage =
        fixture.sourceEvidencePageBytes.documents[0]
      if (sourcePage === undefined) {
        throw new Error('Expected one document evidence page.')
      }
      const sharedSourcePage = new Uint8Array(
        new SharedArrayBuffer(sourcePage.byteLength),
      )
      sharedSourcePage.set(sourcePage)
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: {
            ...fixture.sourceEvidencePageBytes,
            documents: [sharedSourcePage],
          },
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      )
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
    'rejects foreign witness TableIds even when supplied progress identities are rewritten',
    () => {
      const fixture = createSealedPlanningFixture()
      const foreignSourceEvidence =
        createTwoPageTerminalSourceEvidence(
          fixture.configuration,
          fixture.configurationHash,
          'project-directory',
          fixture.authorityBinding,
          fixture.sourceItems,
          'foreign-project-directory-table-id',
        )
      const foreignSourceArtifact =
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: {
            ...fixture.sourceEvidencePageBytes,
            'project-directory':
              foreignSourceEvidence.pageBytes,
          },
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          planningProvenanceArtifact: foreignSourceArtifact,
          planningProvenanceArtifactReference: {
            ...fixture.authorityInput
              .planningProvenanceArtifactReference,
            contentDigest:
              createMigrationDigest(foreignSourceArtifact),
          },
          sourceProgress: {
            ...fixture.sourceProgress,
            'project-directory': {
              ...foreignSourceEvidence.progress,
              sourceTableId:
                fixture.configuration.tables['project-directory'].tableId,
            },
          },
        })
      )

      const foreignTargetEvidence = createTerminalTargetEvidence(
        fixture.configuration,
        fixture.configurationHash,
        fixture.authorityBinding,
        fixture.targetItems,
        'foreign-workspace-search-table-id',
      )
      const foreignTargetArtifact =
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes:
            fixture.sourceEvidencePageBytes,
          targetEvidencePageBytes: [
            foreignTargetEvidence.pageBytes,
          ],
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          planningProvenanceArtifact: foreignTargetArtifact,
          planningProvenanceArtifactReference: {
            ...fixture.authorityInput
              .planningProvenanceArtifactReference,
            contentDigest:
              createMigrationDigest(foreignTargetArtifact),
          },
          targetProgress: {
            ...foreignTargetEvidence.progress,
            targetTableId:
              fixture.configuration.tables['workspace-search'].tableId,
          },
        })
      )
    },
  )

  test(
    'rejects re-signed plan seals with a foreign snapshot or operation counts',
    () => {
      const fixture = createSealedPlanningFixture()
      const mismatchedPlanSeal = {
        ...fixture.planSeal,
        planningSnapshotDigest:
          digest('different-planning-snapshot'),
      }

      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthority({
          ...fixture.authorityInput,
          planSeal: mismatchedPlanSeal,
          planSealReference: {
            ...fixture.authorityInput.planSealReference,
            contentDigest: createMigrationDigest(mismatchedPlanSeal),
          },
        })
      )

      const mismatchedCountTuples = [
        {
          sourceOperationCount:
            fixture.planSeal.sourceOperationCount + 1,
          orphanOperationCount:
            fixture.planSeal.orphanOperationCount,
          planOperationCount:
            fixture.planSeal.planOperationCount + 1,
        },
        {
          sourceOperationCount:
            fixture.planSeal.sourceOperationCount,
          orphanOperationCount:
            fixture.planSeal.orphanOperationCount + 1,
          planOperationCount:
            fixture.planSeal.planOperationCount + 1,
        },
        {
          sourceOperationCount:
            fixture.planSeal.sourceOperationCount - 1,
          orphanOperationCount:
            fixture.planSeal.orphanOperationCount,
          planOperationCount:
            fixture.planSeal.planOperationCount - 1,
        },
      ] as const
      for (const counts of mismatchedCountTuples) {
        const mismatchedCountPlanSeal = {
          ...fixture.planSeal,
          ...counts,
        }
        expectSealedAuthorityFailure(() =>
          createWorkspaceSearchMigrationSealedPlanningAuthority({
            ...fixture.authorityInput,
            planSeal: mismatchedCountPlanSeal,
            planSealReference: {
              ...fixture.authorityInput.planSealReference,
              contentDigest:
                createMigrationDigest(mismatchedCountPlanSeal),
            },
          })
        )
      }
    },
  )

  test(
    'rejects a valid witness set whose complete canonical artifact exceeds 64 MiB',
    () => {
      const fixture = createSealedPlanningFixture()
      const sourceBase64Characters = workspaceSearchMigrationSourceNames
        .flatMap((source) =>
          fixture.sourceEvidencePageBytes[source]
        )
        .reduce(
          (total, bytes) =>
            total + Math.ceil(bytes.byteLength / 3) * 4,
          0,
        )
      const oversizedTargetEvidence =
        createNearLimitTargetEvidencePageBytes(
          fixture.configuration,
          fixture.configurationHash,
          fixture.authorityBinding,
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES -
            sourceBase64Characters,
        )
      const totalBase64Characters =
        sourceBase64Characters +
        oversizedTargetEvidence.base64Characters
      expect(totalBase64Characters).toBeLessThanOrEqual(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES,
      )
      expect(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_MAX_BYTES -
          totalBase64Characters,
      ).toBeLessThan(64 * 1024)

      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes:
            fixture.sourceEvidencePageBytes,
          targetEvidencePageBytes:
            oversizedTargetEvidence.pageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
      )
    },
    60_000,
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
      Reflect.set(inconsistentEmptyPlan, 'planOperationCount', 0)
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

      const resignedProvenance =
        structuredClone(fixture.provenanceArtifact)
      const firstTrace =
        resignedProvenance.provenance.authorityTrace[0]
      if (firstTrace === undefined) {
        throw new Error('Expected one evidence trace entry.')
      }
      const substitutedEvidenceDigest =
        digest('substituted-evidence-page')
      Reflect.set(
        firstTrace,
        'evidenceDigest',
        substitutedEvidenceDigest,
      )
      const resignedProvenanceFields = {
        ...resignedProvenance.provenance,
      }
      Reflect.deleteProperty(
        resignedProvenanceFields,
        'provenanceDigest',
      )
      Reflect.set(
        resignedProvenance.provenance,
        'provenanceDigest',
        createMigrationDigest(resignedProvenanceFields),
      )
      expectSealedAuthorityFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceArtifact(
          encodeCanonical(resignedProvenance),
        )
      )

      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: {
            ...fixture.sourceEvidencePageBytes,
            documents: [],
          },
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
          historicalReceiptBindings: [
            fixture.historicalReceiptBinding,
          ],
        })
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
        createProvenanceArtifactWithBindings(
          fixture,
          oversizedHistoricalBindings,
        )
      )

      const firstSourcePage =
        fixture.sourceEvidencePageBytes.documents[0]
      if (firstSourcePage === undefined) {
        throw new Error('Expected one source evidence page.')
      }
      expectSealedAuthorityFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceArtifact({
          sourceEvidencePageBytes: {
            ...fixture.sourceEvidencePageBytes,
            documents: Array.from(
              { length: 10_001 },
              () => firstSourcePage,
            ),
          },
          targetEvidencePageBytes:
            fixture.targetEvidencePageBytes,
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
  const matchedSourceItem = createTeamSourceItem('matched')
  const archivedSourceItem = createTeamSourceItem(
    'archived',
    '2026-07-25T01:00:00.000Z',
  )
  const sourceItems = [matchedSourceItem, archivedSourceItem]
  const targetItems = [
    requireTeamTargetItem(
      configuration,
      configurationHash,
      matchedSourceItem,
    ),
    requireTeamTargetItem(
      configuration,
      configurationHash,
      createTeamSourceItem('archived'),
    ),
    requireTeamTargetItem(
      configuration,
      configurationHash,
      createTeamSourceItem('orphan'),
    ),
  ]
  const sourceEvidence = {
    'project-directory': createTwoPageTerminalSourceEvidence(
      configuration,
      configurationHash,
      'project-directory',
      authorityBinding,
      sourceItems,
    ),
    'work-items': createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'work-items',
      authorityBinding,
    ),
    collaboration: createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'collaboration',
      authorityBinding,
    ),
    documents: createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'documents',
      authorityBinding,
    ),
  }
  const sourceProgress = {
    'project-directory':
      sourceEvidence['project-directory'].progress,
    'work-items': sourceEvidence['work-items'].progress,
    collaboration: sourceEvidence.collaboration.progress,
    documents: sourceEvidence.documents.progress,
  }
  const sourceEvidencePageBytes = {
    'project-directory':
      sourceEvidence['project-directory'].pageBytes,
    'work-items': sourceEvidence['work-items'].pageBytes,
    collaboration: sourceEvidence.collaboration.pageBytes,
    documents: sourceEvidence.documents.pageBytes,
  }
  const targetEvidence = createTerminalTargetEvidence(
    configuration,
    configurationHash,
    authorityBinding,
    targetItems,
  )
  const targetProgress = targetEvidence.progress
  const targetEvidencePageBytes = [targetEvidence.pageBytes]
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
      sourceEvidencePageBytes,
      targetEvidencePageBytes,
      historicalReceiptBindings: [historicalReceiptBinding],
    })
  const planSeal = createPlanSeal(
    configurationHash,
    provenanceArtifact.planningSnapshotDigest,
    provenanceArtifact.planOperationCount,
    provenanceArtifact.sourceOperationCount,
    provenanceArtifact.orphanOperationCount,
  )
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
    sourceEvidencePageBytes,
    targetEvidencePageBytes,
    authorityBinding,
    sourceItems,
    targetItems,
    historicalReceiptBinding,
    provenanceArtifact,
    currentAuthority,
    authorityInput,
  }
}

/**
 * Rebuilds a provenance artifact from the fixture's exact canonical pages.
 *
 * @param fixture - Complete canonical planning fixture.
 * @param historicalReceiptBindings - Candidate durable receipt bindings.
 * @returns Replayed provenance artifact.
 */
function createProvenanceArtifactWithBindings(
  fixture: ReturnType<typeof createSealedPlanningFixture>,
  historicalReceiptBindings:
    readonly WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding[],
) {
  return createWorkspaceSearchMigrationPlanningProvenanceArtifact({
    sourceEvidencePageBytes: fixture.sourceEvidencePageBytes,
    targetEvidencePageBytes: fixture.targetEvidencePageBytes,
    historicalReceiptBindings,
  })
}

/**
 * Creates one completed empty source evidence page through public reducers.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param source - Exact logical source chain.
 * @param authority - Durable authority bound to its single page.
 * @returns Canonical page bytes and exact one-page terminal progress.
 */
function createTerminalSourceEvidence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
) {
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
  return {
    pageBytes: [
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    ],
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates a two-page source chain with a binary durable cursor witness.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param source - Exact logical source chain.
 * @param authority - Durable authority bound to both pages.
 * @param sourceItems - Exact nonterminal-page source items.
 * @param sourceTableId - Optional witness-only physical TableId override.
 * @returns Two canonical pages and their exact terminal progress.
 */
function createTwoPageTerminalSourceEvidence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  sourceItems: readonly DynamoAttributeMap[],
  sourceTableId = configuration.tables[source].tableId,
) {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId,
    stateTableId:
      configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const cursor: DynamoAttributeMap = {
    partitionKey: { B: Uint8Array.from([0, 1, 255]) },
  }
  const firstPage = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [
      createSourceArtifactReference(`${source}:binary-cursor`),
    ],
    previousProgress: initial,
    pageResult: createBinaryCursorSourcePageResult(
      configuration,
      configurationHash,
      source,
      initial.checkpoint,
      cursor,
      sourceItems,
    ),
  })
  const firstProgress =
    advanceWorkspaceSearchMigrationSourceEvidenceProgress(
      initial,
      firstPage,
    )
  const secondPage = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [
      createSourceArtifactReference(`${source}:terminal`),
    ],
    previousProgress: firstProgress,
    pageResult:
      createEmptyTerminalSourcePageResult(firstProgress.checkpoint),
  })
  return {
    pageBytes: [
      serializeWorkspaceSearchMigrationSourceEvidencePage(firstPage),
      serializeWorkspaceSearchMigrationSourceEvidencePage(secondPage),
    ],
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        firstProgress,
        secondPage,
      ),
  }
}

/**
 * Creates one reduced nonterminal page with an exact Binary cursor witness.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param source - Exact logical source chain.
 * @param previous - Exact predecessor checkpoint.
 * @param cursor - Exact durable next-page cursor.
 * @param items - Exact source rows reduced into the page.
 * @returns Internally consistent nonterminal page result.
 */
function createBinaryCursorSourcePageResult(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  previous: MigrationSourceCheckpoint,
  cursor: DynamoAttributeMap,
  items: readonly DynamoAttributeMap[],
): WorkspaceSearchMigrationSourceScanPageResult {
  const reduced = reduceWorkspaceSearchMigrationSourceScanPage({
    configuration,
    configurationHash,
    source,
    previousCheckpoint: previous,
    page: {
      items: structuredClone(items),
      lastEvaluatedKey: createExactFixtureKey(
        items.at(-1),
        configuration.tables[source],
      ),
    },
  })
  return {
    ...reduced,
    checkpoint: {
      ...reduced.checkpoint,
      cursor,
    },
  }
}

/**
 * Extracts the exact measured primary key from one fixture item.
 *
 * @param item - Complete low-level source or target item.
 * @param table - Measured table identity selecting key attributes.
 * @returns Detached exact primary key.
 */
function createExactFixtureKey(
  item: DynamoAttributeMap | undefined,
  table: MigrationTableIdentity,
): DynamoAttributeMap {
  if (item === undefined) {
    throw new Error('Expected a non-empty continued fixture page.')
  }
  const key: DynamoAttributeMap = {}
  for (const descriptor of table.key) {
    const value = item[descriptor.name]
    if (value === undefined) {
      throw new Error('Expected every measured fixture key attribute.')
    }
    key[descriptor.name] = structuredClone(value)
  }
  return key
}

/**
 * Creates one empty terminal successor from a nonterminal checkpoint.
 *
 * @param previous - Exact nonterminal predecessor checkpoint.
 * @returns Internally consistent empty terminal page result.
 */
function createEmptyTerminalSourcePageResult(
  previous: MigrationSourceCheckpoint,
): WorkspaceSearchMigrationSourceScanPageResult {
  return {
    checkpoint: {
      completed: true,
      aggregate: {
        ...previous.aggregate,
        pageCount: previous.aggregate.pageCount + 1,
      },
      keyDigestState: { ...previous.keyDigestState },
      contentDigestState: { ...previous.contentDigestState },
    },
    sourceRows: [],
    invalidRows: [],
    sourceBindings: [],
  }
}

/**
 * Creates one strict immutable source-artifact reference.
 *
 * @param label - Stable source segment fixture label.
 * @returns Exact content-addressed source artifact.
 */
function createSourceArtifactReference(label: string) {
  const contentDigest = digest(`source-artifact:${label}`)
  return {
    objectKey:
      createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
        contentDigest,
      ),
    versionId: `source-version-${label}`,
    contentDigest,
  }
}

/**
 * Creates one completed target evidence page through public reducers.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param authority - Durable authority bound to its single page.
 * @param items - Exact target rows captured by the page.
 * @param targetTableId - Optional witness-only physical TableId override.
 * @returns Canonical page bytes and exact one-page terminal progress.
 */
function createTerminalTargetEvidence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  items: readonly DynamoAttributeMap[],
  targetTableId =
    configuration.tables['workspace-search'].tableId,
) {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId,
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
      page: { items: structuredClone(items) },
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
  return {
    pageBytes:
      serializeWorkspaceSearchMigrationTargetEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Near-limit canonical target chain used to exercise the final envelope cap.
 */
type NearLimitTargetEvidencePageBytes = {
  /** Complete canonical target evidence page chain. */
  readonly pageBytes: readonly Uint8Array[]
  /** Base64 character count retained by the provenance artifact. */
  readonly base64Characters: number
}

/**
 * Builds a valid target chain whose Base64 witnesses nearly exhaust a budget.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param authority - Durable authority bound to every page.
 * @param maximumBase64Characters - Remaining five-chain witness budget.
 * @returns Complete terminal page bytes and their exact Base64 size.
 */
function createNearLimitTargetEvidencePageBytes(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  maximumBase64Characters: number,
): NearLimitTargetEvidencePageBytes {
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
  let progress =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
      identity,
    )
  const pageBytes: Uint8Array[] = []
  let base64Characters = 0
  let pageIndex = 0
  const reservedTerminalCharacters = 32 * 1024

  while (true) {
    const item = createIgnoredTargetFixtureItem(pageIndex)
    const pageResult =
      reduceWorkspaceSearchMigrationTargetScanPage({
        configuration,
        configurationHash,
        previousCheckpoint: progress.checkpoint,
        page: {
          items: [item],
          lastEvaluatedKey: createExactFixtureKey(
            item,
            configuration.tables['workspace-search'],
          ),
        },
      })
    const page = createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      planningAuthority: authority,
      targetArtifacts: createLargeTargetArtifactReferences(
        pageIndex,
        100,
        2_048,
      ),
      previousProgress: progress,
      pageResult,
    })
    const bytes =
      serializeWorkspaceSearchMigrationTargetEvidencePage(page)
    const characters = Math.ceil(bytes.byteLength / 3) * 4
    if (
      base64Characters + characters +
        reservedTerminalCharacters >
          maximumBase64Characters
    ) {
      break
    }
    pageBytes.push(bytes)
    base64Characters += characters
    progress =
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        progress,
        page,
      )
    pageIndex += 1
  }

  const fillItem = createIgnoredTargetFixtureItem(pageIndex)
  const fillPageResult =
    reduceWorkspaceSearchMigrationTargetScanPage({
      configuration,
      configurationHash,
      previousCheckpoint: progress.checkpoint,
      page: {
        items: [fillItem],
        lastEvaluatedKey: createExactFixtureKey(
          fillItem,
          configuration.tables['workspace-search'],
        ),
      },
    })
  let selectedPage:
    ReturnType<typeof createWorkspaceSearchMigrationTargetEvidencePage> |
      undefined
  let selectedBytes: Uint8Array | undefined
  let selectedCharacters = 0
  const availableFillCharacters =
    maximumBase64Characters -
    base64Characters -
    reservedTerminalCharacters
  for (let referenceCount = 1; referenceCount <= 100; referenceCount += 1) {
    const candidate =
      createWorkspaceSearchMigrationTargetEvidencePage({
        identity,
        planningAuthority: authority,
        targetArtifacts: createLargeTargetArtifactReferences(
          pageIndex,
          referenceCount,
          2_048,
        ),
        previousProgress: progress,
        pageResult: fillPageResult,
      })
    const candidateBytes =
      serializeWorkspaceSearchMigrationTargetEvidencePage(candidate)
    const candidateCharacters =
      Math.ceil(candidateBytes.byteLength / 3) * 4
    if (candidateCharacters > availableFillCharacters) break
    selectedPage = candidate
    selectedBytes = candidateBytes
    selectedCharacters = candidateCharacters
  }
  if (selectedPage !== undefined && selectedBytes !== undefined) {
    pageBytes.push(selectedBytes)
    base64Characters += selectedCharacters
    progress =
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        progress,
        selectedPage,
      )
    pageIndex += 1
  }

  const terminalResult =
    reduceWorkspaceSearchMigrationTargetScanPage({
      configuration,
      configurationHash,
      previousCheckpoint: progress.checkpoint,
      page: { items: [] },
    })
  const terminalPage =
    createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      planningAuthority: authority,
      targetArtifacts: createLargeTargetArtifactReferences(
        pageIndex,
        1,
        32,
      ),
      previousProgress: progress,
      pageResult: terminalResult,
    })
  const terminalBytes =
    serializeWorkspaceSearchMigrationTargetEvidencePage(terminalPage)
  pageBytes.push(terminalBytes)
  base64Characters +=
    Math.ceil(terminalBytes.byteLength / 3) * 4
  if (base64Characters > maximumBase64Characters) {
    throw new Error('Near-limit target fixture exceeded its witness budget.')
  }
  return { pageBytes, base64Characters }
}

/**
 * Creates one bounded set of large immutable target-artifact references.
 *
 * @param pageIndex - Zero-based target evidence page index.
 * @param referenceCount - Number of unique references in this page.
 * @param versionIdLength - Exact repeated version-ID character count.
 * @returns Unique valid content-addressed target references.
 */
function createLargeTargetArtifactReferences(
  pageIndex: number,
  referenceCount: number,
  versionIdLength: number,
) {
  return Array.from({ length: referenceCount }, (_, referenceIndex) => {
    const contentDigest =
      digest(`near-limit-target:${pageIndex}:${referenceIndex}`)
    return {
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          contentDigest,
        ),
      versionId: 'v'.repeat(versionIdLength),
      contentDigest,
    }
  })
}

/**
 * Creates one recognized non-owned target row with a unique physical key.
 *
 * @param pageIndex - Zero-based target evidence page index.
 * @returns Exact ignored Workspace Search item.
 */
function createIgnoredTargetFixtureItem(
  pageIndex: number,
): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#near-limit-${pageIndex}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'near-limit-fixture' },
  }
}

/**
 * Creates one canonical active or archived Project Directory Team item.
 *
 * @param identifier - Unique Team key and entity suffix.
 * @param archivedAt - Optional canonical archive timestamp.
 * @returns Exact low-level source item.
 */
function createTeamSourceItem(
  identifier: string,
  archivedAt?: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `000001#000000#TEAM#${identifier}` },
    entryType: { S: 'team' },
    teamId: { S: identifier },
    teamSortOrder: { N: '1' },
    nameJa: { S: `チーム ${identifier}` },
    nameEn: { S: `Team ${identifier}` },
    expanded: { BOOL: true },
    ...(archivedAt === undefined
      ? {}
      : { archivedAt: { S: archivedAt } }),
  }
}

/**
 * Derives one exact present target item from an active Team source item.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Digest of the measured configuration.
 * @param sourceItem - Canonical active Team source item.
 * @returns Exact mapped Workspace Search target item.
 */
function requireTeamTargetItem(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  sourceItem: DynamoAttributeMap,
): DynamoAttributeMap {
  const candidate = createWorkspaceSearchMigrationSourceCandidate({
    configurationHash,
    source: 'project-directory',
    sourceTable: configuration.tables['project-directory'],
    sourceItem,
  })
  if (
    candidate === undefined ||
    !candidate.operation.after.exists
  ) {
    throw new Error('Expected one present Team target fixture.')
  }
  return structuredClone(candidate.operation.after.item)
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
 * Creates the canonical plan-seal v2 retained by the new authority root.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planningSnapshotDigest - Digest replayed from exact evidence pages.
 * @param planOperationCount - Complete joined operation count.
 * @param sourceOperationCount - Operations owned by present source rows.
 * @param orphanOperationCount - Target-orphan deletion count.
 * @returns Existing strict plan-seal v2 fixture.
 */
function createPlanSeal(
  configurationHash: string,
  planningSnapshotDigest: string,
  planOperationCount: number,
  sourceOperationCount: number,
  orphanOperationCount: number,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run-evidence'),
    planningSnapshotDigest,
    planDigest: planOperationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : digest('sealed-planning-plan'),
    planOperationCount,
    sourceOperationCount,
    orphanOperationCount,
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
