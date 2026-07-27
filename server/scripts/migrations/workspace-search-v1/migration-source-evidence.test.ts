import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceOwnershipBinding,
  WorkspaceSearchMigrationSourceScanRowEvidence,
} from './migration-planner'
import type {
  WorkspaceSearchMigrationInvalidSourceScanRowEvidence,
  WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  createWorkspaceSearchMigrationSourceEvidencePage,
  createWorkspaceSearchMigrationSourceEvidencePageDigest,
  createWorkspaceSearchMigrationSourceEvidenceProgressDigest,
  parseWorkspaceSearchMigrationSourceEvidencePage,
  replayWorkspaceSearchMigrationSourceEvidencePages,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  WorkspaceSearchMigrationSourceEvidenceError,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationPlanningSourceArtifactReference,
  type WorkspaceSearchMigrationSourceEvidenceIdentity,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'

const identity: WorkspaceSearchMigrationSourceEvidenceIdentity = {
  purpose: 'planning',
  runId: 'source-evidence-run',
  configurationHash: createMigrationDigest('configuration'),
  source: 'project-directory',
  sourceTableId: 'source-table-id',
  stateTableId: 'state-table-id',
}

const planningAuthority: WorkspaceSearchMigrationPlanningAuthorityBinding = {
  ownerId: 'source-evidence-owner',
  fenceToken: 7,
  maintenanceEvidencePointerRevision: 11,
  maintenanceEvidenceReceiptDigest:
    createMigrationDigest('maintenance-receipt'),
}

const legacyPlanningV2CanonicalText = [
  '{"checkpoint":{"aggregate":{"contentDigest":"f4320c81a775668ca0854c245b5450d23a16e1514a0e21f8ace78a5ca3ed7d80",',
  '"deleted":0,"ignored":0,"invalid":0,"keyDigest":"f4320c81a775668ca0854c245b5450d23a16e1514a0e21f8ace78a5ca3ed7d80",',
  '"mapped":0,"pageCount":1,"projected":0,"scanned":0},"completed":true,',
  '"contentDigestState":{"count":0,"sumHex":"0000000000000000000000000000000000000000000000000000000000000000",',
  '"xorHex":"0000000000000000000000000000000000000000000000000000000000000000"},',
  '"keyDigestState":{"count":0,"sumHex":"0000000000000000000000000000000000000000000000000000000000000000",',
  '"xorHex":"0000000000000000000000000000000000000000000000000000000000000000"}},',
  '"configurationHash":"0e57ae90f420d845c9bc973dea8fcbab9baa3809be286830eaca40dc94266a2c",',
  '"evidenceVersion":2,"invalidRows":[],"kind":"workspace-search-source-evidence-page",',
  '"migrationId":"workspace-search-maintenance","migrationVersion":1,"pageSequence":1,',
  '"planningAuthority":{"fenceToken":7,"maintenanceEvidencePointerRevision":11,',
  '"maintenanceEvidenceReceiptDigest":"11b3c19ab1ddb613303814859ed0ee193e2489ba48ea6284c6feb4528fae0ef4",',
  '"ownerId":"source-evidence-owner"},',
  '"previousCheckpointDigest":"924199cc3c5154847924aad115a7fdc63c5041f36c7732264d2572e5bf515e34",',
  '"previousEvidenceDigest":"0000000000000000000000000000000000000000000000000000000000000000",',
  '"purpose":"planning","runId":"source-evidence-run","source":"project-directory",',
  '"sourceBindings":[],"sourceRows":[],"sourceTableId":"source-table-id","stateTableId":"state-table-id"}',
].join('')

/** Compact page row fixture used to derive exact cumulative checkpoints. */
type PageRowFixture =
  | {
      /** Row classification. */
      readonly classification: 'ignored' | 'invalid'
      /** Stable invalid reason when the row is rejected. */
      readonly reasonCode?: 'MAPPER_EXCEPTION'
      /** Exact source-key digest. */
      readonly sourceKeyDigest: string
      /** Exact source-item digest. */
      readonly sourceItemDigest: string
    }
  | {
      /** Row classification. */
      readonly classification: 'mapped'
      /** Exact source-key digest. */
      readonly sourceKeyDigest: string
      /** Exact source-item digest. */
      readonly sourceItemDigest: string
      /** Deterministic target-key digest. */
      readonly targetKeyDigest: string
      /** Intended target state. */
      readonly targetAction: 'delete' | 'put'
    }

/**
 * Creates one digest-only reducer result from an exact predecessor checkpoint.
 *
 * @param previous - Exact predecessor checkpoint.
 * @param rows - Page rows and mapped bindings.
 * @param cursor - Next cursor, absent for a terminal page.
 * @returns Internally consistent reducer result.
 */
function createPageResult(
  previous: MigrationSourceCheckpoint,
  rows: readonly PageRowFixture[],
  cursor?: DynamoAttributeMap,
): WorkspaceSearchMigrationSourceScanPageResult {
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  const sourceRows: WorkspaceSearchMigrationSourceScanRowEvidence[] = []
  const invalidRows:
    WorkspaceSearchMigrationInvalidSourceScanRowEvidence[] = []
  const sourceBindings:
    WorkspaceSearchMigrationSourceOwnershipBinding[] = []
  let mapped = 0
  let ignored = 0
  let invalid = 0
  let projected = 0
  let deleted = 0

  for (const row of rows) {
    keyAccumulator.add(row.sourceKeyDigest)
    contentAccumulator.add(row.sourceItemDigest)
    if (row.classification === 'mapped') {
      mapped += 1
      if (row.targetAction === 'put') projected += 1
      else deleted += 1
      sourceRows.push({
        classification: 'mapped',
        sourceKeyDigest: row.sourceKeyDigest,
        sourceItemDigest: row.sourceItemDigest,
      })
      sourceBindings.push({
        sourceKeyDigest: row.sourceKeyDigest,
        sourceItemDigest: row.sourceItemDigest,
        targetKeyDigest: row.targetKeyDigest,
        targetAction: row.targetAction,
      })
      continue
    }
    if (row.classification === 'ignored') {
      ignored += 1
      sourceRows.push({
        classification: 'ignored',
        sourceKeyDigest: row.sourceKeyDigest,
        sourceItemDigest: row.sourceItemDigest,
      })
      continue
    }
    invalid += 1
    invalidRows.push({
      classification: 'invalid',
      sourceKeyDigest: row.sourceKeyDigest,
      sourceItemDigest: row.sourceItemDigest,
      reasonCode: row.reasonCode ?? 'MAPPER_EXCEPTION',
    })
  }

  return {
    checkpoint: {
      completed: cursor === undefined,
      ...(cursor === undefined ? {} : { cursor }),
      aggregate: {
        scanned: previous.aggregate.scanned + rows.length,
        mapped: previous.aggregate.mapped + mapped,
        ignored: previous.aggregate.ignored + ignored,
        invalid: previous.aggregate.invalid + invalid,
        projected: previous.aggregate.projected + projected,
        deleted: previous.aggregate.deleted + deleted,
        keyDigest: keyAccumulator.digest(),
        contentDigest: contentAccumulator.digest(),
        pageCount: previous.aggregate.pageCount + 1,
      },
      keyDigestState: keyAccumulator.exportState(),
      contentDigestState: contentAccumulator.exportState(),
    },
    sourceRows,
    invalidRows,
    sourceBindings,
  }
}

/**
 * Creates a deterministic digest used by one row fixture.
 *
 * @param label - Stable test-only label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}

/**
 * Creates one strict content-addressed source-artifact reference set.
 *
 * @param label - Stable test-only source segment label.
 * @returns One exact immutable S3 version reference.
 */
function createSourceArtifacts(
  label: string,
): readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[] {
  const contentDigest = digest(`source-artifact:${label}`)
  return [{
    objectKey:
      `workspace-search/v1/source-artifacts/v1/${contentDigest}.json`,
    versionId: `version-${label}`,
    contentDigest,
  }]
}

/**
 * Decodes canonical evidence bytes into one mutable validation record.
 *
 * @param bytes - Exact canonical evidence bytes.
 * @returns Parsed non-array evidence record.
 */
function decodeEvidenceRecord(bytes: Uint8Array): object {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Expected one canonical evidence record.')
  }
  return value
}

/**
 * Encodes one test-owned candidate through the canonical JSON serializer.
 *
 * @param value - Candidate evidence document.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalCandidate(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Creates, serializes, parses, and advances one page.
 *
 * @param progress - Exact predecessor progress.
 * @param result - Exact reducer result.
 * @param authority - Exact planning authority for this page.
 * @param sourceArtifacts - Ordered immutable raw-source segment references.
 * @returns Parsed page and successor progress.
 */
function commitPage(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  result: WorkspaceSearchMigrationSourceScanPageResult,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding =
    planningAuthority,
  sourceArtifacts:
    readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[] =
      createSourceArtifacts(
        `page-${progress.pageSequence + 1}-fence-${authority.fenceToken}`,
      ),
) {
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts,
    previousProgress: progress,
    pageResult: result,
  })
  const parsed = parseWorkspaceSearchMigrationSourceEvidencePage(
    serializeWorkspaceSearchMigrationSourceEvidencePage(page),
  )
  return {
    page: parsed,
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        progress,
        parsed,
      ),
  }
}

describe('Workspace Search source evidence', () => {
  test('round-trips and replays a two-page chain from the durable cursor', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        [
          {
            classification: 'mapped',
            sourceKeyDigest: digest('key-1'),
            sourceItemDigest: digest('item-1'),
            targetKeyDigest: digest('target-1'),
            targetAction: 'put',
          },
          {
            classification: 'ignored',
            sourceKeyDigest: digest('key-2'),
            sourceItemDigest: digest('item-2'),
          },
        ],
        { partitionKey: { B: Uint8Array.from([0, 1, 255]) } },
      ),
    )
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [
        {
          classification: 'invalid',
          sourceKeyDigest: digest('key-3'),
          sourceItemDigest: digest('item-3'),
          reasonCode: 'MAPPER_EXCEPTION',
        },
      ]),
      {
        ...planningAuthority,
        ownerId: 'takeover-owner',
        fenceToken: 8,
        maintenanceEvidencePointerRevision: 12,
        maintenanceEvidenceReceiptDigest:
          digest('renewed-maintenance-receipt'),
      },
    )

    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      identity,
      [first.page, second.page],
    )

    expect(replay.progress).toEqual(second.progress)
    expect(replay.progress.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        scanned: 3,
        mapped: 1,
        ignored: 1,
        invalid: 1,
        projected: 1,
        deleted: 0,
        pageCount: 2,
      },
    })
    expect(first.page.checkpoint.cursor).toEqual({
      partitionKey: { B: Uint8Array.from([0, 1, 255]) },
    })
    expect(second.page.previousEvidenceDigest).toBe(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(first.page),
    )
    expect(replay.sourceRows).toHaveLength(2)
    expect(replay.invalidRows).toHaveLength(1)
    expect(replay.sourceBindings).toHaveLength(1)
    if (first.page.purpose !== 'planning') {
      throw new Error('Expected planning evidence.')
    }
    if (second.page.purpose !== 'planning') {
      throw new Error('Expected planning evidence.')
    }
    if (first.page.evidenceVersion !== 3) {
      throw new Error('Expected version-three planning evidence.')
    }
    if (second.page.evidenceVersion !== 3) {
      throw new Error('Expected version-three planning evidence.')
    }
    expect(first.page.planningAuthority).toEqual(planningAuthority)
    expect(first.page.sourceArtifacts).toEqual(
      createSourceArtifacts('page-1-fence-7'),
    )
    expect(second.page.planningAuthority).toEqual({
      ...planningAuthority,
      ownerId: 'takeover-owner',
      fenceToken: 8,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        digest('renewed-maintenance-receipt'),
    })
    expect(second.page.sourceArtifacts).toEqual(
      createSourceArtifacts('page-2-fence-8'),
    )
  })

  test('preserves canonical version-one dry-run page compatibility', () => {
    const dryRunIdentity: WorkspaceSearchMigrationSourceEvidenceIdentity = {
      ...identity,
      purpose: 'dry-run',
    }
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
        dryRunIdentity,
      )
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity: dryRunIdentity,
      planningAuthority: null,
      sourceArtifacts: null,
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const bytes =
      serializeWorkspaceSearchMigrationSourceEvidencePage(page)
    const parsed =
      parseWorkspaceSearchMigrationSourceEvidencePage(bytes)

    expect(page.evidenceVersion).toBe(1)
    expect('planningAuthority' in page).toBe(false)
    expect('sourceArtifacts' in page).toBe(false)
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('planningAuthority')
    expect(text).not.toContain('sourceArtifacts')
    expect(parsed).toEqual(page)
    expect(
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        parsed,
      ).checkpoint.completed,
    ).toBe(true)
  })

  test('requires planning authority and artifacts only for planning pages', () => {
    const planningInitial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const dryRunIdentity: WorkspaceSearchMigrationSourceEvidenceIdentity = {
      ...identity,
      purpose: 'dry-run',
    }
    const dryRunInitial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
        dryRunIdentity,
      )

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority: null,
        sourceArtifacts: createSourceArtifacts('missing-authority'),
        previousProgress: planningInitial,
        pageResult: createPageResult(planningInitial.checkpoint, []),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: null,
        previousProgress: planningInitial,
        pageResult: createPageResult(planningInitial.checkpoint, []),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity: dryRunIdentity,
        planningAuthority,
        sourceArtifacts: null,
        previousProgress: dryRunInitial,
        pageResult: createPageResult(dryRunInitial.checkpoint, []),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity: dryRunIdentity,
        planningAuthority: null,
        sourceArtifacts: createSourceArtifacts('dry-run-artifact'),
        previousProgress: dryRunInitial,
        pageResult: createPageResult(dryRunInitial.checkpoint, []),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects malformed or noncanonical planning authority', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const pageResult = createPageResult(initial.checkpoint, [])
    const authorities = [
      { ...planningAuthority, ownerId: ' noncanonical-owner' },
      { ...planningAuthority, fenceToken: 0 },
      { ...planningAuthority, maintenanceEvidencePointerRevision: 0 },
      { ...planningAuthority, maintenanceEvidenceReceiptDigest: 'invalid' },
      { ...planningAuthority, rawMaintenanceEvidence: 'workspace-secret' },
    ]

    for (const authority of authorities) {
      expect(() =>
        createWorkspaceSearchMigrationSourceEvidencePage({
          identity,
          planningAuthority: authority,
          sourceArtifacts: createSourceArtifacts('invalid-authority'),
          previousProgress: initial,
          pageResult,
        })
      ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    }
  })

  test('binds planning authority and artifacts into digest and round-trip', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const pageResult = createPageResult(initial.checkpoint, [])
    const sourceArtifacts = createSourceArtifacts('original')
    const original = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts,
      previousProgress: initial,
      pageResult,
    })
    const changedAuthority = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority: {
        ...planningAuthority,
        maintenanceEvidenceReceiptDigest:
          digest('substituted-maintenance-receipt'),
      },
      sourceArtifacts: createSourceArtifacts('original'),
      previousProgress: initial,
      pageResult,
    })
    const changedArtifacts = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('substituted-artifact'),
      previousProgress: initial,
      pageResult,
    })
    const parsed = parseWorkspaceSearchMigrationSourceEvidencePage(
      serializeWorkspaceSearchMigrationSourceEvidencePage(original),
    )

    expect(original.evidenceVersion).toBe(3)
    expect(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(
        changedAuthority,
      ),
    ).not.toBe(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(original),
    )
    expect(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(
        changedArtifacts,
      ),
    ).not.toBe(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(original),
    )
    expect(parsed).toEqual(original)
    if (
      parsed.purpose !== 'planning' ||
      parsed.evidenceVersion !== 3
    ) {
      throw new Error('Expected version-three planning evidence.')
    }
    expect(parsed.sourceArtifacts).toEqual(sourceArtifacts)
  })

  test('rejects legacy version-one planning evidence', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('planning-version'),
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const legacyValue = decodeEvidenceRecord(
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    )
    Reflect.deleteProperty(legacyValue, 'planningAuthority')
    Reflect.deleteProperty(legacyValue, 'sourceArtifacts')
    Reflect.set(legacyValue, 'evidenceVersion', 1)

    expect(() =>
      parseWorkspaceSearchMigrationSourceEvidencePage(
        encodeCanonicalCandidate(legacyValue),
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('preserves literal canonical legacy version-two planning evidence', () => {
    const bytes = new TextEncoder().encode(legacyPlanningV2CanonicalText)
    const page =
      parseWorkspaceSearchMigrationSourceEvidencePage(bytes)
    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      identity,
      [page],
    )

    if (
      page.purpose !== 'planning' ||
      page.evidenceVersion !== 2
    ) {
      throw new Error('Expected legacy version-two planning evidence.')
    }
    expect('sourceArtifacts' in page).toBe(false)
    expect(
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    ).toEqual(bytes)
    expect(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(page),
    ).toBe(
      'f2a3d795bb475a86ca1886910973e246fd05d3d7166f8e68aaf5669134d2b9b1',
    )
    expect(replay.progress.checkpoint.completed).toBe(true)
    expect(
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
        replay.progress,
      ),
    ).toBe(
      'dfd2f57d4b5f3c0f2163ec5ecd540e889aac482060ffabe52fcf53e9623c406e',
    )
  })

  test('rejects artifact references on version-two planning evidence', () => {
    const legacyValue = decodeEvidenceRecord(
      new TextEncoder().encode(legacyPlanningV2CanonicalText),
    )
    Reflect.set(
      legacyValue,
      'sourceArtifacts',
      createSourceArtifacts('forbidden-v2-artifact'),
    )

    expect(() =>
      parseWorkspaceSearchMigrationSourceEvidencePage(
        encodeCanonicalCandidate(legacyValue),
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects missing, extra, or malformed version-three artifacts', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('strict-v3-artifact'),
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const canonical =
      serializeWorkspaceSearchMigrationSourceEvidencePage(page)
    const validReference = createSourceArtifacts('strict-v3-artifact')[0]
    const missing = decodeEvidenceRecord(canonical)
    Reflect.deleteProperty(missing, 'sourceArtifacts')
    const extra = decodeEvidenceRecord(canonical)
    Reflect.set(extra, 'rawSourceArtifact', 'workspace-secret')
    const empty = decodeEvidenceRecord(canonical)
    Reflect.set(empty, 'sourceArtifacts', [])
    const nullArtifacts = decodeEvidenceRecord(canonical)
    Reflect.set(nullArtifacts, 'sourceArtifacts', null)
    const malformedDigest = decodeEvidenceRecord(canonical)
    Reflect.set(malformedDigest, 'sourceArtifacts', [{
      ...validReference,
      contentDigest: 'invalid',
    }])
    const mismatchedObjectKey = decodeEvidenceRecord(canonical)
    Reflect.set(mismatchedObjectKey, 'sourceArtifacts', [{
      ...validReference,
      objectKey:
        'workspace-search/v1/source-artifacts/v1/unbound.json',
    }])
    const blankVersion = decodeEvidenceRecord(canonical)
    Reflect.set(blankVersion, 'sourceArtifacts', [{
      ...validReference,
      versionId: ' ',
    }])
    const extraReferenceField = decodeEvidenceRecord(canonical)
    Reflect.set(extraReferenceField, 'sourceArtifacts', [{
      ...validReference,
      rawSourceValue: 'workspace-secret',
    }])
    const duplicate = decodeEvidenceRecord(canonical)
    Reflect.set(duplicate, 'sourceArtifacts', [
      validReference,
      validReference,
    ])

    for (const candidate of [
      missing,
      extra,
      empty,
      nullArtifacts,
      malformedDigest,
      mismatchedObjectKey,
      blankVersion,
      extraReferenceField,
      duplicate,
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationSourceEvidencePage(
          encodeCanonicalCandidate(candidate),
        )
      ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    }
  })

  test('rejects hostile artifact-reference arrays before reading elements', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const reference = createSourceArtifacts('hostile-array')[0]
    if (reference === undefined) {
      throw new Error('Expected one source-artifact reference.')
    }
    let customMapCalls = 0
    const replacedPrototype = [reference]
    Object.setPrototypeOf(replacedPrototype, {
      map() {
        customMapCalls += 1
        return [reference]
      },
    })
    let accessorReads = 0
    const accessorElement = [reference]
    Object.defineProperty(accessorElement, '0', {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1
        return reference
      },
    })

    for (const sourceArtifacts of [
      replacedPrototype,
      accessorElement,
    ]) {
      expect(() =>
        createWorkspaceSearchMigrationSourceEvidencePage({
          identity,
          planningAuthority,
          sourceArtifacts,
          previousProgress: initial,
          pageResult: createPageResult(initial.checkpoint, []),
        })
      ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    }
    expect(customMapCalls).toBe(0)
    expect(accessorReads).toBe(0)
  })

  test('replays homogeneous v2 chains and rejects mixed planning versions', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const firstV3 = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('legacy-chain-first'),
      previousProgress: initial,
      pageResult: createPageResult(
        initial.checkpoint,
        [{
          classification: 'ignored',
          sourceKeyDigest: digest('legacy-chain-key-1'),
          sourceItemDigest: digest('legacy-chain-item-1'),
        }],
        { partitionKey: { S: 'legacy-chain-cursor' } },
      ),
    })
    const legacyFirstValue = decodeEvidenceRecord(
      serializeWorkspaceSearchMigrationSourceEvidencePage(firstV3),
    )
    Reflect.set(legacyFirstValue, 'evidenceVersion', 2)
    Reflect.deleteProperty(legacyFirstValue, 'sourceArtifacts')
    const legacyFirst =
      parseWorkspaceSearchMigrationSourceEvidencePage(
        encodeCanonicalCandidate(legacyFirstValue),
      )
    const legacyProgress =
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        legacyFirst,
      )
    const secondV3 = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('legacy-chain-second'),
      previousProgress: legacyProgress,
      pageResult: createPageResult(
        legacyProgress.checkpoint,
        [{
          classification: 'ignored',
          sourceKeyDigest: digest('legacy-chain-key-2'),
          sourceItemDigest: digest('legacy-chain-item-2'),
        }],
      ),
    })
    const legacySecondValue = decodeEvidenceRecord(
      serializeWorkspaceSearchMigrationSourceEvidencePage(secondV3),
    )
    Reflect.set(legacySecondValue, 'evidenceVersion', 2)
    Reflect.deleteProperty(legacySecondValue, 'sourceArtifacts')
    const legacySecond =
      parseWorkspaceSearchMigrationSourceEvidencePage(
        encodeCanonicalCandidate(legacySecondValue),
      )
    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      identity,
      [legacyFirst, legacySecond],
    )

    expect(replay.progress.checkpoint.completed).toBe(true)
    expect(replay.progress.checkpoint.aggregate.pageCount).toBe(2)
    expect(() =>
      replayWorkspaceSearchMigrationSourceEvidencePages(
        identity,
        [legacyFirst, secondV3],
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('replays more than one page of rows while retaining the per-page cap', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const firstRows: readonly PageRowFixture[] = Array.from(
      { length: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE },
      (_, index): PageRowFixture => ({
        classification: 'ignored',
        sourceKeyDigest: digest(`large-page-key-${index}`),
        sourceItemDigest: digest(`large-page-item-${index}`),
      }),
    )
    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        firstRows,
        { partitionKey: { S: 'large-page-cursor' } },
      ),
    )
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [{
        classification: 'ignored',
        sourceKeyDigest: digest('large-page-key-terminal'),
        sourceItemDigest: digest('large-page-item-terminal'),
      }]),
    )

    const replay = replayWorkspaceSearchMigrationSourceEvidencePages(
      identity,
      [first.page, second.page],
    )

    expect(replay.sourceRows).toHaveLength(
      WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE + 1,
    )
    expect(replay.progress.checkpoint.aggregate).toMatchObject({
      scanned: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE + 1,
      ignored: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE + 1,
      pageCount: 2,
    })

    const oversizedRows: readonly PageRowFixture[] = [
      ...firstRows,
      {
        classification: 'ignored',
        sourceKeyDigest: digest('oversized-page-key'),
        sourceItemDigest: digest('oversized-page-item'),
      },
    ]
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('oversized-page'),
        previousProgress: initial,
        pageResult: createPageResult(initial.checkpoint, oversizedRows),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    const combinedOversizedRows: readonly PageRowFixture[] = [
      ...Array.from(
        { length: 60 },
        (_, index): PageRowFixture => ({
          classification: 'ignored',
          sourceKeyDigest: digest(`combined-ignored-key-${index}`),
          sourceItemDigest: digest(`combined-ignored-item-${index}`),
        }),
      ),
      ...Array.from(
        { length: 41 },
        (_, index): PageRowFixture => ({
          classification: 'invalid',
          sourceKeyDigest: digest(`combined-invalid-key-${index}`),
          sourceItemDigest: digest(`combined-invalid-item-${index}`),
          reasonCode: 'MAPPER_EXCEPTION',
        }),
      ),
    ]
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('combined-oversized-page'),
        previousProgress: initial,
        pageResult:
          createPageResult(initial.checkpoint, combinedOversizedRows),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  // These golden values are compatibility boundaries. A deliberate change must
  // evaluate digest-version or migration-version handling, not blindly replace
  // the expected values.
  test('pins versioned checkpoint, page, and progress digest vectors', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('digest-vector'),
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const progress =
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(initial, page)

    expect({
      checkpoint:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          page.checkpoint,
        ),
      page: createWorkspaceSearchMigrationSourceEvidencePageDigest(page),
      progress:
        createWorkspaceSearchMigrationSourceEvidenceProgressDigest(progress),
    }).toEqual({
      checkpoint:
        '9dea417c3fe19b288f7274274279c13ad358dcc87168dff45e2822f05bf502fb',
      page:
        '8a16129c45247c4b137c6212343a72c2c2ffa7f9c5fec0d57d7f797165752b2e',
      progress:
        'd408fca919d2e3389f38ac6081c8005cb4cbfcc18151c847f24513efd1db47b1',
    })
  })

  test('separates dry-run and planning identities before advancing a page', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('identity-separation'),
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const dryRunProgress =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress({
        ...identity,
        purpose: 'dry-run',
      })

    expect(() =>
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        dryRunProgress,
        page,
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects substituted bindings and checkpoint accumulator state', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [
      {
        classification: 'mapped',
        sourceKeyDigest: digest('key'),
        sourceItemDigest: digest('item'),
        targetKeyDigest: digest('target'),
        targetAction: 'delete',
      },
    ])

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('substituted-binding'),
        previousProgress: initial,
        pageResult: {
          ...result,
          sourceBindings: [{
            ...result.sourceBindings[0],
            sourceItemDigest: digest('substituted-item'),
          }],
        },
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('substituted-state'),
        previousProgress: initial,
        pageResult: {
          ...result,
          checkpoint: {
            ...result.checkpoint,
            keyDigestState: {
              ...result.checkpoint.keyDigestState,
              xorHex: digest('substituted-state'),
            },
          },
        },
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('unchanged-checkpoint'),
        previousProgress: initial,
        pageResult: {
          checkpoint: initial.checkpoint,
          sourceRows: [],
          invalidRows: [],
          sourceBindings: [],
        },
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects chain forks, post-completion pages, and cross-page duplicates', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const firstResult = createPageResult(
      initial.checkpoint,
      [{
        classification: 'ignored',
        sourceKeyDigest: digest('duplicate-key'),
        sourceItemDigest: digest('item-1'),
      }],
      { partitionKey: { S: 'cursor' } },
    )
    const first = commitPage(initial, firstResult)
    const duplicate = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [{
        classification: 'ignored',
        sourceKeyDigest: digest('duplicate-key'),
        sourceItemDigest: digest('item-2'),
      }]),
    )

    expect(() =>
      replayWorkspaceSearchMigrationSourceEvidencePages(
        identity,
        [first.page, duplicate.page],
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    expect(() =>
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        duplicate.page,
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('post-completion'),
        previousProgress: duplicate.progress,
        pageResult: createPageResult(
          duplicate.progress.checkpoint,
          [],
        ),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects duplicate target ownership within and across pages', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const sharedTarget = digest('shared-target')
    const firstRow: PageRowFixture = {
      classification: 'mapped',
      sourceKeyDigest: digest('first-source-key'),
      sourceItemDigest: digest('first-source-item'),
      targetKeyDigest: sharedTarget,
      targetAction: 'put',
    }
    const secondRow: PageRowFixture = {
      classification: 'mapped',
      sourceKeyDigest: digest('second-source-key'),
      sourceItemDigest: digest('second-source-item'),
      targetKeyDigest: sharedTarget,
      targetAction: 'delete',
    }

    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority,
        sourceArtifacts: createSourceArtifacts('duplicate-target'),
        previousProgress: initial,
        pageResult: createPageResult(
          initial.checkpoint,
          [firstRow, secondRow],
        ),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)

    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        [firstRow],
        { partitionKey: { S: 'target-collision-cursor' } },
      ),
    )
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [secondRow]),
    )

    expect(() =>
      replayWorkspaceSearchMigrationSourceEvidencePages(
        identity,
        [first.page, second.page],
      )
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
  })

  test('rejects noncanonical, extra-field, and raw-value-bearing failures', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      sourceArtifacts: createSourceArtifacts('raw-value-boundary'),
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, [{
        classification: 'ignored',
        sourceKeyDigest: digest('sanitized-source-key'),
        sourceItemDigest: digest('sanitized-source-item'),
      }]),
    })
    const canonical =
      serializeWorkspaceSearchMigrationSourceEvidencePage(page)
    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(canonical)}\n`,
    )
    const withExtraField = new TextEncoder().encode(
      JSON.stringify({
        ...JSON.parse(new TextDecoder().decode(canonical)),
        rawTenantValue: 'workspace-secret',
      }),
    )

    for (const bytes of [noncanonical, withExtraField]) {
      expect(() =>
        parseWorkspaceSearchMigrationSourceEvidencePage(bytes)
      ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    }

    const projectedPage = {
      ...page,
      rawTenantValue: 'workspace-secret',
      sourceRows: page.sourceRows.map((row) => ({
        ...row,
        rawEmail: 'member@example.com',
      })),
    }
    const projectedText = new TextDecoder().decode(
      serializeWorkspaceSearchMigrationSourceEvidencePage(projectedPage),
    )
    expect(projectedText).not.toContain('workspace-secret')
    expect(projectedText).not.toContain('member@example.com')
    expect(
      parseWorkspaceSearchMigrationSourceEvidencePage(
        new TextEncoder().encode(projectedText),
      ),
    ).toEqual(page)

    const hostileIdentity = Object.create(null)
    Object.defineProperty(hostileIdentity, 'runId', {
      enumerable: true,
      get() {
        throw new Error('workspace-secret')
      },
    })
    try {
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
        hostileIdentity,
      )
      throw new Error('Expected hostile identity rejection.')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(
        WorkspaceSearchMigrationSourceEvidenceError,
      )
      if (!(error instanceof Error)) {
        throw new Error('Expected Error.')
      }
      expect(error.message).not.toContain('workspace-secret')
    }
  })
})
