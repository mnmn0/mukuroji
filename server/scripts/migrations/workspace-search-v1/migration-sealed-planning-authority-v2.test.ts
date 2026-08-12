import { createHash } from 'node:crypto'
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
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  serializeWorkspaceSearchMigrationPlanManifestHead,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder,
  createWorkspaceSearchMigrationPlanningProvenanceSegments,
  serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  type WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder,
  type WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceManifestReference,
  type WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceStoredSegment,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES,
  WorkspaceSearchMigrationSealedPlanningAuthorityV2Error,
} from './migration-sealed-planning-authority-v2'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'

const runId = 'sealed-planning-authority-v2-run'
const ownerId = 'sealed-planning-authority-v2-owner'
const planCreatedAt = '2026-07-29T01:00:00.000Z'
const evaluatedAt = '2026-07-29T01:01:30.000Z'
const sealedAt = '2026-07-29T01:02:00.000Z'
const retainUntil = '2026-08-29T00:00:00.000Z'
const planningProvenanceBasePrefix =
  'workspace-search/v1/planning-provenance-artifacts/v1'

describe('Workspace Search sealed planning authority v2', () => {
  test('round-trips one manifest-aware authority without changing either head', () => {
    const fixture = createFixture()
    const authority =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    const bytes =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        authority,
      )

    expect(
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(bytes),
    ).toEqual(authority)
    expect(authority).toMatchObject({
      authorityVersion: 2,
      planDigest: fixture.input.planSeal.planDigest,
      planningSnapshotDigest:
        fixture.input.planSeal.planningSnapshotDigest,
      sourceOperationCount: 0,
      orphanOperationCount: 0,
      planOperationCount: 0,
      planningAuthorityProvenanceDigest:
        fixture.input.planningAuthorityProvenance.provenanceDigest,
      historicalReceiptCount: 1,
    })
    expect(authority.evidenceHeads.map(({ chain }) => chain)).toEqual([
      ...workspaceSearchMigrationSourceNames,
      'workspace-search',
    ])
  })

  test('rejects wrong roles, exact-byte digests, and byte lengths', () => {
    const fixture = createFixture()
    const wrongDigest = digest('wrong-plan-seal-bytes')
    const candidates:
      readonly CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input[] =
      [
        {
          ...fixture.input,
          planSealReference: {
            ...fixture.input.planSealReference,
            objectKey:
              `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${fixture.input.planSealReference.contentDigest}.artifact`,
          },
        },
        {
          ...fixture.input,
          planSealReference: {
            ...fixture.input.planSealReference,
            objectKey:
              `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${wrongDigest}.artifact`,
            contentDigest: wrongDigest,
          },
        },
        {
          ...fixture.input,
          planManifestHeadReference: {
            ...fixture.input.planManifestHeadReference,
            byteLength:
              fixture.input.planManifestHeadReference.byteLength + 1,
          },
        },
        {
          ...fixture.input,
          planningProvenanceManifestHeadReference: {
            ...fixture.input.planningProvenanceManifestHeadReference,
            objectKey:
              `forged-prefix/manifest-heads/${fixture.input.planningProvenanceManifestHeadReference.contentDigest}.artifact`,
          },
        },
      ]

    for (const candidate of candidates) {
      expectV2Failure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          candidate,
        )
      )
    }
  })

  test('rejects a forged provenance prefix even with a recomputed root digest', () => {
    const fixture = createFixture()
    const authority =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    const tampered = structuredClone(authority)
    Reflect.set(
      tampered.planningProvenanceManifestHeadReference,
      'objectKey',
      `forged-prefix/manifest-heads/${tampered.planningProvenanceManifestHeadReference.contentDigest}.artifact`,
    )
    const fields = { ...tampered }
    Reflect.deleteProperty(fields, 'authorityDigest')
    const bytes = encodeCanonical({
      ...fields,
      authorityDigest: createMigrationDigest(fields),
    })

    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(bytes)
    )
  })

  test('rejects unreplayable immutable version identifiers', () => {
    const fixture = createFixture()
    for (const versionId of ['null', 'v'.repeat(1_025)]) {
      expectV2Failure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2({
          ...fixture.input,
          planSealReference: {
            ...fixture.input.planSealReference,
            versionId,
          },
        })
      )
    }

    const authority =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    const tampered = structuredClone(authority)
    Reflect.set(tampered.planSealReference, 'versionId', 'null')
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        encodeAuthorityWithDigest(tampered),
      )
    )
  })

  test('bounds compact page counts and historical transitions', () => {
    const fixture = createFixture()
    const authority =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    const excessivePages = structuredClone(authority)
    for (const head of excessivePages.evidenceHeads) {
      Reflect.set(head, 'pageCount', 10_000)
    }
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        encodeAuthorityWithDigest(excessivePages),
      )
    )

    const excessiveReceipts = structuredClone(authority)
    Reflect.set(excessiveReceipts, 'historicalReceiptCount', 6)
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        encodeAuthorityWithDigest(excessiveReceipts),
      )
    )
  })

  test('rejects hostile graphs without invoking accessors', () => {
    const fixture = createFixture()
    expectV2Failure(() =>
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        new Proxy(fixture.input, {}),
      )
    )

    let getterCalls = 0
    Object.defineProperty(fixture.input.planSeal, 'planDigest', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1
        return createEmptyWorkspaceSearchPlanDigest()
      },
    })
    expectV2Failure(() =>
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    )
    expect(getterCalls).toBe(0)

    const cyclic = createFixture().input
    Reflect.set(cyclic, 'cycle', cyclic)
    expectV2Failure(() =>
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(cyclic)
    )

    const symbolKeyed = createFixture().input
    Reflect.set(symbolKeyed, Symbol('secret'), 'secret')
    expectV2Failure(() =>
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        symbolKeyed,
      )
    )

    const exotic = createFixture().input
    Reflect.set(exotic, 'exotic', new Date())
    expectV2Failure(() =>
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(exotic)
    )
  })

  test('rejects noncanonical and oversized standalone bytes', () => {
    const fixture = createFixture()
    const authority =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        fixture.input,
      )
    const canonical =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        authority,
      )
    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(canonical)}\n`,
    )

    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        noncanonical,
      )
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_SEALED_PLANNING_AUTHORITY_V2_MAX_BYTES +
            1,
        ),
      )
    )
  })

  test('rejects terminal-head, table, retention, and successor drift', () => {
    const fixture = createFixture()
    const candidates:
      readonly CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input[] =
      [
        {
          ...fixture.input,
          planManifestHeadReference: {
            ...fixture.input.planManifestHeadReference,
            retainUntil: '2026-08-30T00:00:00.000Z',
          },
        },
        {
          ...fixture.input,
          sourceProgress: {
            ...fixture.input.sourceProgress,
            'project-directory': {
              ...fixture.input.sourceProgress['project-directory'],
              sourceTableId: 'substituted-table-id',
            },
          },
        },
        {
          ...fixture.input,
          currentAuthority: {
            ...fixture.input.currentAuthority,
            maintenanceEvidencePointerRevision:
              fixture.input.currentAuthority
                .maintenanceEvidencePointerRevision + 1,
          },
        },
      ]

    for (const candidate of candidates) {
      expectV2Failure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          candidate,
        )
      )
    }
  })

  test('requires role-correct terminals for a nonempty plan head', () => {
    const valid = createSyntheticNonemptyInput()
    expect(
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(valid)
        .planOperationCount,
    ).toBe(1)

    const invalidInputs = [
      createSyntheticNonemptyInput({
        terminalSegmentRole: 'manifest-heads',
      }),
      createSyntheticNonemptyInput({
        terminalManifestPageRole: 'manifest-heads',
      }),
      createSyntheticNonemptyInput({
        terminalSegmentRetainUntil:
          '2026-08-30T00:00:00.000Z',
      }),
      createSyntheticNonemptyInput({
        terminalSegmentByteLength:
          WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES + 1,
      }),
      createSyntheticNonemptyInput({
        terminalSegmentVersionId: 'null',
      }),
      createSyntheticNonemptyInput({
        planSegmentCount: 2,
      }),
    ]
    for (const input of invalidInputs) {
      expectV2Failure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2(input)
      )
    }
  })

  test('rejects impossible or unreplayable provenance terminals', () => {
    const fixture = createFixture()
    const prefix =
      fixture.input.planningProvenanceManifestHead.summary.objectKeyPrefix
    const digestValue =
      fixture.input.planningProvenanceManifestHead
        .terminalManifestPageLocator.reference.contentDigest
    const candidates = [
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(
          head.terminalManifestPageLocator.reference,
          'objectKey',
          `${prefix}/segments/${digestValue}.artifact`,
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(
          head.terminalManifestPageLocator.reference,
          'objectKey',
          `forged-prefix/manifest-pages/${digestValue}.artifact`,
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(
          head.terminalManifestPageLocator.reference,
          'retainUntil',
          '2026-08-30T00:00:00.000Z',
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(
          head.terminalManifestPageLocator.reference,
          'byteLength',
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES +
            1,
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(
          head.terminalManifestPageLocator.reference,
          'versionId',
          'null',
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(head, 'evidenceSegmentCount', 6)
        Reflect.set(head, 'segmentCount', 7)
        Reflect.set(
          head.terminalManifestPageLocator,
          'segmentCount',
          7,
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(head, 'receiptSegmentCount', 2)
        Reflect.set(head, 'segmentCount', 3)
        Reflect.set(
          head.terminalManifestPageLocator,
          'segmentCount',
          3,
        )
      }),
      createInputWithProvenanceHeadMutation((head) => {
        Reflect.set(head, 'manifestPageCount', 3)
        Reflect.set(
          head.terminalManifestPageLocator,
          'pageIndex',
          2,
        )
        Reflect.set(
          head.terminalManifestPageLocator,
          'pageCount',
          3,
        )
      }),
    ]

    for (const candidate of candidates) {
      expectV2Failure(() =>
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          candidate,
        )
      )
    }
  })
})

/**
 * Complete factory fixture and its intermediate immutable artifact.
 */
type V2Fixture = {
  /** Strict factory input. */
  readonly input:
    CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
  /** Compatibility provenance artifact used to stage its manifest. */
  readonly provenanceArtifact:
    WorkspaceSearchMigrationPlanningProvenanceArtifact
}

/**
 * One terminal source evidence fixture.
 */
type TerminalSourceEvidence = {
  /** Exact canonical page bytes. */
  readonly bytes: Uint8Array
  /** Exact completed progress. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
}

/**
 * One terminal target evidence fixture.
 */
type TerminalTargetEvidence = {
  /** Exact canonical page bytes. */
  readonly bytes: Uint8Array
  /** Exact completed progress. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
}

/**
 * Encoded and stored provenance manifest pages.
 */
type StoredManifestPages = {
  /** Ordered locally encoded pages. */
  readonly encoded:
    readonly WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage[]
  /** Ordered exact-version stored envelopes. */
  readonly stored:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[]
}

/**
 * Optional mutations for a synthetic nonempty compact plan head.
 */
type SyntheticNonemptyPlanOptions = {
  /** Terminal segment storage role. */
  readonly terminalSegmentRole?: 'manifest-heads' | 'segments'
  /** Terminal manifest-page storage role. */
  readonly terminalManifestPageRole?:
    | 'manifest-heads'
    | 'manifest-pages'
  /** Declared complete segment count. */
  readonly planSegmentCount?: number
  /** Terminal segment byte length. */
  readonly terminalSegmentByteLength?: number
  /** Terminal segment immutable version identifier. */
  readonly terminalSegmentVersionId?: string
  /** Terminal segment retention deadline. */
  readonly terminalSegmentRetainUntil?: string
}

/**
 * Creates one internally consistent empty-plan v2 authority fixture.
 *
 * @returns Exact factory input and its staged compatibility artifact.
 */
function createFixture(): V2Fixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const tableIds = createTableIds(configuration)
  const receipt = createReceipt()
  const receiptDigest = createMigrationDigest(receipt)
  const authorityBinding: WorkspaceSearchMigrationPlanningAuthorityBinding = {
    ownerId,
    fenceToken: receipt.fenceToken,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest: receiptDigest,
  }
  const sourceEvidence = {
    'project-directory': createTerminalSourceEvidence(
      'project-directory',
      configurationHash,
      tableIds,
      authorityBinding,
    ),
    'work-items': createTerminalSourceEvidence(
      'work-items',
      configurationHash,
      tableIds,
      authorityBinding,
    ),
    collaboration: createTerminalSourceEvidence(
      'collaboration',
      configurationHash,
      tableIds,
      authorityBinding,
    ),
    documents: createTerminalSourceEvidence(
      'documents',
      configurationHash,
      tableIds,
      authorityBinding,
    ),
  }
  const targetEvidence = createTerminalTargetEvidence(
    configurationHash,
    tableIds,
    authorityBinding,
  )
  const receiptBinding:
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding = {
      configurationHash,
      stateTableId: tableIds['migration-state'],
      ownerId,
      receiptDigest,
      receipt,
    }
  const provenanceArtifact =
    createWorkspaceSearchMigrationPlanningProvenanceArtifact({
      sourceEvidencePageBytes: {
        'project-directory': [
          sourceEvidence['project-directory'].bytes,
        ],
        'work-items': [sourceEvidence['work-items'].bytes],
        collaboration: [sourceEvidence.collaboration.bytes],
        documents: [sourceEvidence.documents.bytes],
      },
      targetEvidencePageBytes: [targetEvidence.bytes],
      historicalReceiptBindings: [receiptBinding],
    })
  const planSeal = createPlanSeal(
    configurationHash,
    provenanceArtifact.planningSnapshotDigest,
  )
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const encodedPlanHead =
    serializeWorkspaceSearchMigrationPlanManifestHead({
      planSeal,
      manifestPages: [],
      segments: [],
    })
  const objectKeyPrefix =
    `${planningProvenanceBasePrefix}/${runId}/${configurationHash}`
  const storedSegments = storeSegments(
    createWorkspaceSearchMigrationPlanningProvenanceSegments({
      artifact: provenanceArtifact,
      objectKeyPrefix,
    }),
    objectKeyPrefix,
  )
  const storedPages = createStoredManifestPages(
    provenanceArtifact,
    objectKeyPrefix,
    storedSegments,
  )
  const planningProvenanceManifestHead =
    createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
      artifact: provenanceArtifact,
      objectKeyPrefix,
      storedManifestPages: storedPages.stored,
    })
  const provenanceHeadBytes =
    serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
      planningProvenanceManifestHead,
    )
  const currentAuthority = createCurrentAuthority(
    configurationHash,
    tableIds['migration-state'],
    receipt,
    receiptDigest,
  )
  const input = {
    runId,
    configuration,
    configurationHash,
    planSeal,
    planSealReference: createPlanReference(
      'plan-seals',
      planSealBytes,
    ),
    planManifestHead: encodedPlanHead.head,
    planManifestHeadReference: createPlanReference(
      'manifest-heads',
      encodedPlanHead.bytes,
    ),
    planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference:
      createProvenanceReference(
        objectKeyPrefix,
        'manifest-heads',
        provenanceHeadBytes,
        'provenance-head-version',
      ),
    planningAuthorityProvenance: provenanceArtifact.provenance,
    sourceProgress: {
      'project-directory':
        sourceEvidence['project-directory'].progress,
      'work-items': sourceEvidence['work-items'].progress,
      collaboration: sourceEvidence.collaboration.progress,
      documents: sourceEvidence.documents.progress,
    },
    targetProgress: targetEvidence.progress,
    currentAuthority,
    sealedAt,
  } satisfies CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
  return { input, provenanceArtifact }
}

/**
 * Creates one internally correlated nonempty root with a selected segment role.
 *
 * The manifest graph itself is not read by this pure fixture. It exists to
 * prove the compact v2 boundary accepts only a replayable terminal role.
 *
 * @param options - Optional role, count, length, version, or retention drift.
 * @returns Complete synthetic nonempty publication input.
 */
function createSyntheticNonemptyInput(
  options: SyntheticNonemptyPlanOptions = {},
): CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
  const fixture = createFixture()
  const planDigest = digest('synthetic-nonempty-plan')
  const planningSnapshotDigest =
    digest('synthetic-nonempty-planning-snapshot')
  const planSeal: WorkspaceSearchPlanSeal = {
    ...fixture.input.planSeal,
    planDigest,
    planningSnapshotDigest,
    sourceOperationCount: 1,
    planOperationCount: 1,
  }
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealReference = createPlanReference(
    'plan-seals',
    planSealBytes,
  )
  const terminalSegmentDigest =
    digest('synthetic-terminal-plan-segment')
  const terminalPageDigest =
    digest('synthetic-terminal-plan-manifest-page')
  const planSegmentCount = options.planSegmentCount ?? 1
  const planManifestHead = {
    ...fixture.input.planManifestHead,
    planDigest,
    planSealContentDigest: planSealReference.contentDigest,
    planOperationCount: 1,
    planSegmentCount,
    manifestPageCount: Math.ceil(planSegmentCount / 256),
    terminalSegmentReference: createPlanReferenceFromDigest(
      options.terminalSegmentRole ?? 'segments',
      terminalSegmentDigest,
      options.terminalSegmentByteLength ?? 1,
      options.terminalSegmentVersionId ??
        'synthetic-segment-version',
      options.terminalSegmentRetainUntil ?? retainUntil,
    ),
    terminalManifestPageReference: createPlanReferenceFromDigest(
      options.terminalManifestPageRole ?? 'manifest-pages',
      terminalPageDigest,
      1,
      'synthetic-page-version',
      retainUntil,
    ),
  }
  const planManifestHeadBytes = encodeCanonical(planManifestHead)

  const summaryFields = {
    ...fixture.input.planningProvenanceManifestHead.summary,
    planningSnapshotDigest,
    sourceOperationCount: 1,
    planOperationCount: 1,
  }
  Reflect.deleteProperty(summaryFields, 'summaryDigest')
  const summary = {
    ...summaryFields,
    summaryDigest: createMigrationDigest(summaryFields),
  }
  const provenanceHeadFields = {
    ...fixture.input.planningProvenanceManifestHead,
    summary,
  }
  Reflect.deleteProperty(provenanceHeadFields, 'headDigest')
  const planningProvenanceManifestHead = {
    ...provenanceHeadFields,
    headDigest: createMigrationDigest(provenanceHeadFields),
  }
  const provenanceHeadBytes =
    serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
      planningProvenanceManifestHead,
    )

  return {
    ...fixture.input,
    planSeal,
    planSealReference,
    planManifestHead,
    planManifestHeadReference: createPlanReference(
      'manifest-heads',
      planManifestHeadBytes,
    ),
    planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference:
      createProvenanceReference(
        planningProvenanceManifestHead.summary.objectKeyPrefix,
        'manifest-heads',
        provenanceHeadBytes,
        'synthetic-provenance-head-version',
      ),
  }
}

/**
 * Recomputes one provenance head after a focused terminal mutation.
 *
 * @param mutate - Descriptor-safe fixture mutation applied before redigesting.
 * @returns Complete publication input with matching top-head bytes/reference.
 */
function createInputWithProvenanceHeadMutation(
  mutate: (
    head: WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  ) => void,
): CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
  const fixture = createFixture()
  const head = structuredClone(
    fixture.input.planningProvenanceManifestHead,
  )
  mutate(head)
  const fields = { ...head }
  Reflect.deleteProperty(fields, 'headDigest')
  const planningProvenanceManifestHead = {
    ...fields,
    headDigest: createMigrationDigest(fields),
  }
  const bytes = encodeCanonical(planningProvenanceManifestHead)
  return {
    ...fixture.input,
    planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference:
      createProvenanceReference(
        planningProvenanceManifestHead.summary.objectKeyPrefix,
        'manifest-heads',
        bytes,
        'mutated-provenance-head-version',
      ),
  }
}

/**
 * Creates one completed empty source evidence page.
 *
 * @param source - Fixed source role.
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact physical table IDs.
 * @param authority - Durable authority bound into the page.
 * @returns Canonical page bytes and completed progress.
 */
function createTerminalSourceEvidence(
  source: WorkspaceSearchMigrationSourceName,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): TerminalSourceEvidence {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: tableIds[source],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
      identity,
    )
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
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      sourceRows: [],
      invalidRows: [],
      sourceBindings: [],
    },
  })
  return {
    bytes: serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates one completed empty target evidence page.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact physical table IDs.
 * @param authority - Durable authority bound into the page.
 * @returns Canonical page bytes and completed progress.
 */
function createTerminalTargetEvidence(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): TerminalTargetEvidence {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId: tableIds['workspace-search'],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
      identity,
    )
  const artifactDigest = digest('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      targetRows: [],
      invalidRows: [],
      observedTargetBindings: [],
    },
  })
  return {
    bytes: serializeWorkspaceSearchMigrationTargetEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates stored provenance segment envelopes.
 *
 * @param encoded - Ordered encoded segments.
 * @param objectKeyPrefix - Exact run-scoped provenance prefix.
 * @returns Exact-version stored segment envelopes.
 */
function storeSegments(
  encoded: ReturnType<
    typeof createWorkspaceSearchMigrationPlanningProvenanceSegments
  >,
  objectKeyPrefix: string,
): readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[] {
  return encoded.map((segment, index) => ({
    encoded: segment,
    reference: createProvenanceReferenceFromDigest(
      objectKeyPrefix,
      'segments',
      segment.contentDigest,
      segment.byteLength,
      `segment-version-${index}`,
    ),
  }))
}

/**
 * Sequentially builds exact-version provenance manifest pages.
 *
 * @param artifact - Strict provenance artifact.
 * @param objectKeyPrefix - Exact run-scoped provenance prefix.
 * @param storedSegments - Complete stored segment graph.
 * @returns Encoded and stored manifest pages.
 */
function createStoredManifestPages(
  artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact,
  objectKeyPrefix: string,
  storedSegments:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[],
): StoredManifestPages {
  const builder =
    createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder({
      artifact,
      objectKeyPrefix,
      storedSegments,
    })
  return storePages(builder, objectKeyPrefix)
}

/**
 * Stores every predecessor-linked page emitted by one builder.
 *
 * @param builder - Stateful manifest-page builder.
 * @param objectKeyPrefix - Exact run-scoped provenance prefix.
 * @returns Encoded and stored manifest pages.
 */
function storePages(
  builder: WorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder,
  objectKeyPrefix: string,
): StoredManifestPages {
  const encoded:
    WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage[] = []
  const stored:
    WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[] = []
  let previous:
    WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage | null =
      null
  for (let index = 0; index < builder.pageCount; index += 1) {
    const page = builder.createNextPage(previous)
    const envelope: WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage =
      {
        encoded: page,
        reference: createProvenanceReferenceFromDigest(
          objectKeyPrefix,
          'manifest-pages',
          page.contentDigest,
          page.byteLength,
          `manifest-page-version-${index}`,
        ),
      }
    encoded.push(page)
    stored.push(envelope)
    previous = envelope
  }
  return { encoded, stored }
}

/**
 * Creates one rich plan-graph reference from exact bytes.
 *
 * @param role - Plan-seal or manifest-head role.
 * @param bytes - Exact canonical object bytes.
 * @returns Rich exact-version reference.
 */
function createPlanReference(
  role: 'manifest-heads' | 'plan-seals',
  bytes: Uint8Array,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const contentDigest = digestBytes(bytes)
  return createPlanReferenceFromDigest(
    role,
    contentDigest,
    bytes.byteLength,
    `plan-version-${role}`,
  )
}

/**
 * Creates one rich plan reference from exact digest material.
 *
 * @param role - Fixed plan-graph storage role.
 * @param contentDigest - Exact object byte digest.
 * @param byteLength - Exact object byte length.
 * @param versionId - Exact immutable S3 version.
 * @param referenceRetainUntil - Exact immutable retention deadline.
 * @returns Rich exact-version reference.
 */
function createPlanReferenceFromDigest(
  role:
    | 'manifest-heads'
    | 'manifest-pages'
    | 'plan-seals'
    | 'segments',
  contentDigest: string,
  byteLength: number,
  versionId: string,
  referenceRetainUntil = retainUntil,
): WorkspaceSearchMigrationImmutableArtifactReference {
  return {
    objectKey:
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/${role}/${contentDigest}.artifact`,
    versionId,
    contentDigest,
    byteLength,
    retainUntil: referenceRetainUntil,
  }
}

/**
 * Creates one rich provenance reference from exact bytes.
 *
 * @param objectKeyPrefix - Exact run-scoped provenance prefix.
 * @param role - Provenance object role.
 * @param bytes - Exact canonical object bytes.
 * @param versionId - Exact immutable version identifier.
 * @returns Rich exact-version reference.
 */
function createProvenanceReference(
  objectKeyPrefix: string,
  role: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  bytes: Uint8Array,
  versionId: string,
): WorkspaceSearchMigrationPlanningProvenanceManifestReference {
  return createProvenanceReferenceFromDigest(
    objectKeyPrefix,
    role,
    digestBytes(bytes),
    bytes.byteLength,
    versionId,
  )
}

/**
 * Creates one rich provenance reference from exact digest material.
 *
 * @param objectKeyPrefix - Exact run-scoped provenance prefix.
 * @param role - Provenance object role.
 * @param contentDigest - Exact canonical byte digest.
 * @param byteLength - Exact canonical byte length.
 * @param versionId - Exact immutable version identifier.
 * @returns Rich exact-version reference.
 */
function createProvenanceReferenceFromDigest(
  objectKeyPrefix: string,
  role: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  contentDigest: string,
  byteLength: number,
  versionId: string,
): WorkspaceSearchMigrationPlanningProvenanceManifestReference {
  return {
    objectKey: `${objectKeyPrefix}/${role}/${contentDigest}.artifact`,
    versionId,
    contentDigest,
    byteLength,
    retainUntil,
  }
}

/**
 * Creates the canonical empty plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planningSnapshotDigest - Replayed five-chain snapshot digest.
 * @returns Strict plan-seal v2.
 */
function createPlanSeal(
  configurationHash: string,
  planningSnapshotDigest: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest,
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one canonical fresh maintenance receipt.
 *
 * @returns Receipt bound to the fixture run and fence.
 */
function createReceipt(): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator: 'workspace-search/v1/maintenance/v2-fixture.json',
    runtimeRevision: 3,
    fenceToken: 7,
    validatedAt: '2026-07-29T00:59:00.000Z',
    oldestObservationAt: '2026-07-29T00:58:00.000Z',
    validUntil: '2026-07-29T01:03:00.001Z',
  }
}

/**
 * Creates current authority around the exact historical receipt.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param stateTableId - Immutable migration-state TableId.
 * @param receipt - Exact fresh receipt.
 * @param receiptDigest - Digest addressing the receipt.
 * @returns Complete fresh current pre-plan authority.
 */
function createCurrentAuthority(
  configurationHash: string,
  stateTableId: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  receiptDigest: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash,
    stateTableId,
    lease: {
      runId,
      ownerId,
      fenceToken: receipt.fenceToken,
      heartbeatAt: '2026-07-29T01:01:15.000Z',
      expiresAt: '2026-07-29T01:02:15.000Z',
    },
    maintenanceEvidenceReceiptDigest: receiptDigest,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt,
  }
}

/**
 * Creates a complete measured configuration.
 *
 * @returns Stable strict configuration fixture.
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
 * Creates exact TableIds from measured configuration.
 *
 * @param configuration - Strict measured configuration.
 * @returns Six physical table IDs.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
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
 * Creates one measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source table identity.
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
 * @returns Stable supporting table identity.
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
 * @param role - Logical table role.
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
 * @returns Ordered partition and optional sort-key descriptors.
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
 * Encodes one JSON-compatible value as canonical UTF-8.
 *
 * @param value - JSON-compatible fixture value.
 * @returns Exact canonical bytes.
 */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Recomputes one tampered compact root digest and encodes canonical bytes.
 *
 * @param authority - Mutated detached authority fixture.
 * @returns Canonical bytes with a matching top-level digest.
 */
function encodeAuthorityWithDigest(
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): Uint8Array {
  const fields = { ...authority }
  Reflect.deleteProperty(fields, 'authorityDigest')
  return encodeCanonical({
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  })
}

/**
 * Computes SHA-256 over exact canonical bytes.
 *
 * @param bytes - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Creates one deterministic fixture digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}

/**
 * Requires a v2 public boundary to fail with the stable redacted error.
 *
 * @param operation - Deferred invalid invocation.
 */
function expectV2Failure(operation: () => unknown): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationSealedPlanningAuthorityV2Error,
    )
    if (
      error instanceof
        WorkspaceSearchMigrationSealedPlanningAuthorityV2Error
    ) {
      expect(error.code).toBe('INVALID_SEALED_PLANNING_AUTHORITY_V2')
      expect(error.message).toBe(
        'INVALID_SEALED_PLANNING_AUTHORITY_V2',
      )
      return
    }
  }
  throw new Error('Expected version-two authority failure.')
}
