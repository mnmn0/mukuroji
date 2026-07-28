import { describe, expect, test } from 'bun:test'
import { createAttributeMapDigest } from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationObservedTargetBinding,
  WorkspaceSearchMigrationTargetScanRowEvidence,
} from './migration-planner'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  type WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
} from './migration-target-artifact'
import type {
  WorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import type {
  WorkspaceSearchMigrationInvalidTargetScanRowEvidence,
  WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  type CreateWorkspaceSearchMigrationTargetEvidencePageInput,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetCheckpointDigest,
  createWorkspaceSearchMigrationTargetEvidencePage,
  createWorkspaceSearchMigrationTargetEvidencePageDigest,
  createWorkspaceSearchMigrationTargetEvidenceProgressDigest,
  parseWorkspaceSearchMigrationTargetEvidencePage,
  replayWorkspaceSearchMigrationTargetEvidencePages,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  WorkspaceSearchMigrationTargetEvidenceError,
  type WorkspaceSearchMigrationTargetEvidenceIdentity,
  type WorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
  WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES,
} from './migration-target-evidence'

const identity: WorkspaceSearchMigrationTargetEvidenceIdentity = {
  purpose: 'planning',
  runId: 'target-evidence-run',
  configurationHash: createMigrationDigest('target-configuration'),
  targetTableId: 'workspace-search-target-table-id',
  stateTableId: 'migration-state-table-id',
}

const planningAuthority:
  WorkspaceSearchMigrationPlanningTargetArtifactAuthority = {
    ownerId: 'target-evidence-owner',
    fenceToken: 7,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest('maintenance-receipt'),
  }

/**
 * Compact target-row fixture used to derive exact cumulative checkpoints.
 */
type TargetPageRowFixture =
  | {
      /** Row classification. */
      readonly classification: 'ignored' | 'invalid'
      /** Exact target-key digest. */
      readonly targetKeyDigest: string
      /** Exact target-item digest. */
      readonly targetItemDigest: string
    }
  | {
      /** Owned-row classification. */
      readonly classification: 'owned'
      /** Exact target-key digest. */
      readonly targetKeyDigest: string
      /** Exact target-item digest. */
      readonly targetItemDigest: string
    }

/**
 * Creates one digest-only target reducer result from an exact predecessor.
 *
 * @param previous - Exact predecessor target checkpoint.
 * @param rows - Target rows consumed by this page.
 * @param cursor - Next cursor, absent only for a terminal page.
 * @returns Internally consistent target reducer result.
 */
function createPageResult(
  previous: WorkspaceSearchMigrationTargetScanCheckpoint,
  rows: readonly TargetPageRowFixture[],
  cursor?: DynamoAttributeMap,
): WorkspaceSearchMigrationTargetScanPageResult {
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  const targetRows: WorkspaceSearchMigrationTargetScanRowEvidence[] = []
  const invalidRows:
    WorkspaceSearchMigrationInvalidTargetScanRowEvidence[] = []
  const observedTargetBindings:
    WorkspaceSearchMigrationObservedTargetBinding[] = []
  let owned = 0
  let ignored = 0
  let invalid = 0
  for (const row of rows) {
    keyAccumulator.add(row.targetKeyDigest)
    contentAccumulator.add(row.targetItemDigest)
    if (row.classification === 'owned') {
      owned += 1
      targetRows.push({
        classification: 'owned',
        targetKeyDigest: row.targetKeyDigest,
        targetItemDigest: row.targetItemDigest,
      })
      observedTargetBindings.push({
        targetKeyDigest: row.targetKeyDigest,
        targetItemDigest: row.targetItemDigest,
      })
      continue
    }
    if (row.classification === 'ignored') {
      ignored += 1
      targetRows.push({
        classification: 'ignored',
        targetKeyDigest: row.targetKeyDigest,
        targetItemDigest: row.targetItemDigest,
      })
      continue
    }
    invalid += 1
    invalidRows.push({
      classification: 'invalid',
      targetKeyDigest: row.targetKeyDigest,
      targetItemDigest: row.targetItemDigest,
      reasonCode: 'INVALID_TARGET_ROW',
    })
  }
  return {
    checkpoint: {
      configurationHash: previous.configurationHash,
      completed: cursor === undefined,
      ...(cursor === undefined ? {} : { cursor }),
      aggregate: {
        scanned: previous.aggregate.scanned + rows.length,
        owned: previous.aggregate.owned + owned,
        ignored: previous.aggregate.ignored + ignored,
        invalid: previous.aggregate.invalid + invalid,
        keyDigest: keyAccumulator.digest(),
        contentDigest: contentAccumulator.digest(),
        pageCount: previous.aggregate.pageCount + 1,
      },
      keyDigestState: keyAccumulator.exportState(),
      contentDigestState: contentAccumulator.exportState(),
    },
    targetRows,
    invalidRows,
    observedTargetBindings,
  }
}

/**
 * Creates a deterministic digest used by one test fixture.
 *
 * @param label - Stable test-only label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}

/**
 * Creates one strict content-addressed target-artifact reference set.
 *
 * @param label - Stable test-only target segment label.
 * @returns One exact immutable S3-version reference.
 */
function createTargetArtifacts(
  label: string,
): readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[] {
  const contentDigest = digest(`target-artifact:${label}`)
  return [{
    objectKey:
      createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
        contentDigest,
      ),
    versionId: `version-${label}`,
    contentDigest,
  }]
}

/**
 * Creates, serializes, parses, and advances one target evidence page.
 *
 * @param progress - Exact predecessor target progress.
 * @param result - Exact target reducer result.
 * @param authority - Exact planning authority for this page.
 * @param targetArtifacts - Ordered immutable raw-target segment references.
 * @returns Parsed page and successor progress.
 */
function commitPage(
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
  result: WorkspaceSearchMigrationTargetScanPageResult,
  authority: WorkspaceSearchMigrationPlanningTargetArtifactAuthority =
    planningAuthority,
  targetArtifacts:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[] =
      createTargetArtifacts(
        `page-${progress.pageSequence + 1}-fence-${authority.fenceToken}`,
      ),
): {
  /** Parsed exact target evidence page. */
  readonly page: WorkspaceSearchMigrationTargetEvidencePage
  /** Advanced exact target progress. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
} {
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts,
    previousProgress: progress,
    pageResult: result,
  })
  const parsed = parseWorkspaceSearchMigrationTargetEvidencePage(
    serializeWorkspaceSearchMigrationTargetEvidencePage(page),
  )
  return {
    page: parsed,
    progress:
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        progress,
        parsed,
      ),
  }
}

/**
 * Decodes canonical target evidence bytes into one mutable record.
 *
 * @param bytes - Exact canonical target evidence bytes.
 * @returns Parsed non-array evidence record.
 */
function decodeEvidenceRecord(bytes: Uint8Array): object {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Expected one canonical target evidence record.')
  }
  return value
}

/**
 * Encodes one test-owned candidate through the canonical JSON serializer.
 *
 * @param value - Candidate target evidence document.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalCandidate(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Creates a complete first-page construction input.
 *
 * @param result - Exact reducer result.
 * @returns Strict target evidence page input.
 */
function createFirstPageInput(
  result: WorkspaceSearchMigrationTargetScanPageResult,
): CreateWorkspaceSearchMigrationTargetEvidencePageInput {
  return {
    identity,
    planningAuthority,
    targetArtifacts: createTargetArtifacts('first-input'),
    previousProgress:
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity),
    pageResult: result,
  }
}

describe('Workspace Search target evidence', () => {
  test('round-trips and replays a two-page chain from the durable cursor', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const firstCursor: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-1' },
      recordKey: { B: Uint8Array.from([0, 1, 255]) },
    }
    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        [
          {
            classification: 'owned',
            targetKeyDigest: digest('target-key-1'),
            targetItemDigest: digest('target-item-1'),
          },
          {
            classification: 'ignored',
            targetKeyDigest: createAttributeMapDigest(firstCursor),
            targetItemDigest: digest('target-item-2'),
          },
        ],
        firstCursor,
      ),
    )
    const renewedAuthority:
      WorkspaceSearchMigrationPlanningTargetArtifactAuthority = {
        ...planningAuthority,
        ownerId: 'takeover-owner',
        fenceToken: 8,
        maintenanceEvidencePointerRevision: 12,
        maintenanceEvidenceReceiptDigest:
          digest('renewed-maintenance-receipt'),
      }
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [
        {
          classification: 'invalid',
          targetKeyDigest: digest('target-key-3'),
          targetItemDigest: digest('target-item-3'),
        },
      ]),
      renewedAuthority,
    )

    const replay = replayWorkspaceSearchMigrationTargetEvidencePages(
      identity,
      [first.page, second.page],
    )

    expect(replay.progress).toEqual(second.progress)
    expect(replay.progress.checkpoint).toMatchObject({
      configurationHash: identity.configurationHash,
      completed: true,
      aggregate: {
        scanned: 3,
        owned: 1,
        ignored: 1,
        invalid: 1,
        pageCount: 2,
      },
    })
    expect(first.page.checkpoint.cursor).toEqual({
      workspaceId: { S: 'workspace-1' },
      recordKey: { B: Uint8Array.from([0, 1, 255]) },
    })
    expect(first.page.evidenceVersion).toBe(1)
    expect(first.page.planningAuthority).toEqual(planningAuthority)
    expect(second.page.planningAuthority).toEqual(renewedAuthority)
    expect(second.page.previousEvidenceDigest).toBe(
      createWorkspaceSearchMigrationTargetEvidencePageDigest(first.page),
    )
    expect(replay.targetRows).toHaveLength(2)
    expect(replay.invalidRows).toHaveLength(1)
    expect(replay.observedTargetBindings).toHaveLength(1)
  })

  test('completes an empty first page while requiring one artifact reference', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const terminal = commitPage(
      initial,
      createPageResult(initial.checkpoint, []),
    )

    expect(terminal.progress.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        scanned: 0,
        pageCount: 1,
      },
    })
    expect(terminal.page.targetArtifacts).toHaveLength(1)

    const input = createFirstPageInput(
      createPageResult(initial.checkpoint, []),
    )
    Reflect.set(input, 'targetArtifacts', [])
    expectTargetEvidenceFailure(
      () => createWorkspaceSearchMigrationTargetEvidencePage(input),
    )
  })

  test('binds authority and exact target artifact references into page digests', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [])
    const original = createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      previousProgress: initial,
      pageResult: result,
      planningAuthority,
      targetArtifacts: createTargetArtifacts('digest-a'),
    })
    const changedAuthority =
      createWorkspaceSearchMigrationTargetEvidencePage({
        identity,
        previousProgress: initial,
        pageResult: result,
        planningAuthority: {
          ...planningAuthority,
          fenceToken: planningAuthority.fenceToken + 1,
        },
        targetArtifacts: createTargetArtifacts('digest-a'),
      })
    const changedArtifact =
      createWorkspaceSearchMigrationTargetEvidencePage({
        identity,
        previousProgress: initial,
        pageResult: result,
        planningAuthority,
        targetArtifacts: createTargetArtifacts('digest-b'),
      })

    expect(
      createWorkspaceSearchMigrationTargetEvidencePageDigest(original),
    ).not.toBe(
      createWorkspaceSearchMigrationTargetEvidencePageDigest(
        changedAuthority,
      ),
    )
    expect(
      createWorkspaceSearchMigrationTargetEvidencePageDigest(original),
    ).not.toBe(
      createWorkspaceSearchMigrationTargetEvidencePageDigest(
        changedArtifact,
      ),
    )
    expect(
      parseWorkspaceSearchMigrationTargetEvidencePage(
        serializeWorkspaceSearchMigrationTargetEvidencePage(original),
      ),
    ).toEqual(original)
  })

  test('requires exact planning authority and page construction input fields', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [])
    const missingAuthority = createFirstPageInput(result)
    Reflect.deleteProperty(missingAuthority, 'planningAuthority')
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(missingAuthority),
    )

    const extraInput = createFirstPageInput(result)
    Reflect.set(extraInput, 'rawTargetItems', ['secret'])
    expectTargetEvidenceFailure(
      () => createWorkspaceSearchMigrationTargetEvidencePage(extraInput),
    )

    for (const authority of [
      { ...planningAuthority, ownerId: '' },
      { ...planningAuthority, fenceToken: 0 },
      { ...planningAuthority, maintenanceEvidencePointerRevision: 0 },
      {
        ...planningAuthority,
        maintenanceEvidenceReceiptDigest: 'not-a-digest',
      },
    ]) {
      const input = createFirstPageInput(result)
      Reflect.set(input, 'planningAuthority', authority)
      expectTargetEvidenceFailure(
        () => createWorkspaceSearchMigrationTargetEvidencePage(input),
      )
    }
  })

  test('rejects malformed, substituted, duplicate, sparse, or excessive artifacts', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [])
    const valid = createTargetArtifacts('strict')[0]
    if (valid === undefined) throw new Error('Expected artifact fixture.')
    const candidates: readonly unknown[] = [
      [],
      [{
        ...valid,
        objectKey:
          `workspace-search/v1/source-artifacts/v1/${valid.contentDigest}.json`,
      }],
      [{ ...valid, versionId: 'null' }],
      [{ ...valid, contentDigest: digest('wrong-content') }],
      [valid, structuredClone(valid)],
      [{ ...valid, unexpected: 'field' }],
    ]
    for (const candidate of candidates) {
      const input = createFirstPageInput(result)
      Reflect.set(input, 'targetArtifacts', candidate)
      expectTargetEvidenceFailure(
        () => createWorkspaceSearchMigrationTargetEvidencePage(input),
      )
    }

    const sparse = [structuredClone(valid)]
    delete sparse[0]
    const sparseInput = createFirstPageInput(result)
    Reflect.set(sparseInput, 'targetArtifacts', sparse)
    expectTargetEvidenceFailure(
      () => createWorkspaceSearchMigrationTargetEvidencePage(sparseInput),
    )

    const excessive = Array.from(
      { length: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE + 1 },
      (_, index) => createTargetArtifacts(`excessive-${index}`)[0],
    )
    const excessiveInput = createFirstPageInput(result)
    Reflect.set(excessiveInput, 'targetArtifacts', excessive)
    expectTargetEvidenceFailure(
      () => createWorkspaceSearchMigrationTargetEvidencePage(excessiveInput),
    )
  })

  test('rejects noncanonical bytes, schema drift, and source-specific fields', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const page = commitPage(
      initial,
      createPageResult(initial.checkpoint, []),
    ).page
    const canonical =
      serializeWorkspaceSearchMigrationTargetEvidencePage(page)
    const record = decodeEvidenceRecord(canonical)

    for (const mutation of [
      (candidate: object) => Reflect.set(candidate, 'evidenceVersion', 2),
      (candidate: object) => Reflect.set(candidate, 'purpose', 'dry-run'),
      (candidate: object) =>
        Reflect.set(candidate, 'source', 'project-directory'),
      (candidate: object) =>
        Reflect.set(candidate, 'lastEvaluatedKey', { key: 'forbidden' }),
      (candidate: object) =>
        Reflect.deleteProperty(candidate, 'targetArtifacts'),
    ]) {
      const candidate = structuredClone(record)
      mutation(candidate)
      expectTargetEvidenceFailure(
        () =>
          parseWorkspaceSearchMigrationTargetEvidencePage(
            encodeCanonicalCandidate(candidate),
          ),
      )
    }

    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(canonical)}\n`,
    )
    expectTargetEvidenceFailure(
      () => parseWorkspaceSearchMigrationTargetEvidencePage(noncanonical),
    )
    expectTargetEvidenceFailure(
      () =>
        parseWorkspaceSearchMigrationTargetEvidencePage(
          Uint8Array.from([0xc3, 0x28]),
        ),
    )
  })

  test('separates run, configuration, target, state, and purpose identities', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const page = commitPage(
      initial,
      createPageResult(initial.checkpoint, []),
    ).page
    for (const replacement of [
      { ...identity, runId: 'different-run' },
      { ...identity, configurationHash: digest('different-configuration') },
      { ...identity, targetTableId: 'different-target-table-id' },
      { ...identity, stateTableId: 'different-state-table-id' },
    ]) {
      expectTargetEvidenceFailure(
        () =>
          replayWorkspaceSearchMigrationTargetEvidencePages(
            replacement,
            [page],
          ),
      )
    }

    const invalidPurpose = structuredClone(identity)
    Reflect.set(invalidPurpose, 'purpose', 'dry-run')
    expectTargetEvidenceFailure(
      () =>
        createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
          invalidPurpose,
        ),
    )
    expectTargetEvidenceFailure(
      () =>
        createInitialWorkspaceSearchMigrationTargetEvidenceProgress({
          ...identity,
          stateTableId: identity.targetTableId,
        }),
    )
  })

  test('rejects binding, aggregate, configuration, and accumulator substitution', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [
      {
        classification: 'owned',
        targetKeyDigest: digest('bound-target-key'),
        targetItemDigest: digest('bound-target-item'),
      },
    ])

    const wrongBinding = structuredClone(result)
    const firstBinding = wrongBinding.observedTargetBindings[0]
    if (firstBinding === undefined) throw new Error('Expected binding.')
    Reflect.set(firstBinding, 'targetItemDigest', digest('substituted-item'))
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(wrongBinding),
        ),
    )

    const wrongAggregate = structuredClone(result)
    Reflect.set(wrongAggregate.checkpoint.aggregate, 'owned', 0)
    Reflect.set(wrongAggregate.checkpoint.aggregate, 'ignored', 1)
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(wrongAggregate),
        ),
    )

    const wrongConfiguration = structuredClone(result)
    Reflect.set(
      wrongConfiguration.checkpoint,
      'configurationHash',
      digest('substituted-checkpoint-config'),
    )
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(wrongConfiguration),
        ),
    )

    const wrongAccumulator = structuredClone(result)
    Reflect.set(
      wrongAccumulator.checkpoint.keyDigestState,
      'sumHex',
      digest('substituted-sum'),
    )
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(wrongAccumulator),
        ),
    )
  })

  test('binds every nonterminal cursor to one row in the same page', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const validCursor: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-cursor-binding' },
      recordKey: { S: 'row-valid' },
    }
    const firstResult = createPageResult(
      initial.checkpoint,
      [{
        classification: 'ignored',
        targetKeyDigest: createAttributeMapDigest(validCursor),
        targetItemDigest: digest('cursor-bound-item'),
      }],
      validCursor,
    )
    const substituted = structuredClone(firstResult)
    Reflect.set(substituted.checkpoint, 'cursor', {
      workspaceId: { S: 'workspace-cursor-binding' },
      recordKey: { S: 'row-substituted' },
    })
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(substituted),
        ),
    )

    const first = commitPage(initial, firstResult)
    const zeroRowContinuation = createPageResult(
      first.progress.checkpoint,
      [],
      {
        workspaceId: { S: 'workspace-cursor-binding' },
        recordKey: { S: 'row-after-empty-page' },
      },
    )
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage({
          identity,
          planningAuthority,
          targetArtifacts: createTargetArtifacts('zero-row-continuation'),
          previousProgress: first.progress,
          pageResult: zeroRowContinuation,
        }),
    )
  })

  test('rejects forks, post-completion pages, and cross-page duplicate keys', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const firstCursor: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-duplicate' },
      recordKey: { S: 'first' },
    }
    const duplicateKey = createAttributeMapDigest(firstCursor)
    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        [{
          classification: 'ignored',
          targetKeyDigest: duplicateKey,
          targetItemDigest: digest('duplicate-target-item-first'),
        }],
        firstCursor,
      ),
    )
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [{
        classification: 'invalid',
        targetKeyDigest: duplicateKey,
        targetItemDigest: digest('duplicate-target-item-second'),
      }]),
    )
    expectTargetEvidenceFailure(
      () =>
        replayWorkspaceSearchMigrationTargetEvidencePages(
          identity,
          [first.page, second.page],
        ),
    )

    const fork = structuredClone(first.page)
    Reflect.set(fork, 'previousEvidenceDigest', digest('fork'))
    expectTargetEvidenceFailure(
      () =>
        advanceWorkspaceSearchMigrationTargetEvidenceProgress(initial, fork),
    )

    const terminal = commitPage(
      initial,
      createPageResult(initial.checkpoint, []),
    )
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage({
          identity,
          planningAuthority,
          targetArtifacts: createTargetArtifacts('after-complete'),
          previousProgress: terminal.progress,
          pageResult:
            createPageResult(terminal.progress.checkpoint, []),
        }),
    )
  })

  test('retains the per-page cap while globally replaying more than one page', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const firstCursor: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-page-one' },
      recordKey: { S: 'row-99' },
    }
    const firstRows = Array.from(
      { length: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE },
      (_, index): TargetPageRowFixture => ({
        classification: 'ignored',
        targetKeyDigest: index === WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE - 1
          ? createAttributeMapDigest(firstCursor)
          : digest(`page-one-key-${index}`),
        targetItemDigest: digest(`page-one-item-${index}`),
      }),
    )
    const first = commitPage(
      initial,
      createPageResult(
        initial.checkpoint,
        firstRows,
        firstCursor,
      ),
    )
    const second = commitPage(
      first.progress,
      createPageResult(first.progress.checkpoint, [{
        classification: 'owned',
        targetKeyDigest: digest('page-two-key'),
        targetItemDigest: digest('page-two-item'),
      }]),
    )
    expect(
      replayWorkspaceSearchMigrationTargetEvidencePages(
        identity,
        [first.page, second.page],
      ).progress.checkpoint.aggregate.scanned,
    ).toBe(WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE + 1)

    const oversizedRows = [
      ...firstRows,
      {
        classification: 'ignored',
        targetKeyDigest: digest('oversized-key'),
        targetItemDigest: digest('oversized-item'),
      },
    ] satisfies readonly TargetPageRowFixture[]
    expectTargetEvidenceFailure(
      () =>
        createWorkspaceSearchMigrationTargetEvidencePage(
          createFirstPageInput(
            createPageResult(initial.checkpoint, oversizedRows),
          ),
        ),
    )
  })

  test('detaches caller-owned checkpoint, rows, authority, and artifacts', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(
      initial.checkpoint,
      [{
        classification: 'owned',
        targetKeyDigest: digest('detached-key'),
        targetItemDigest: digest('detached-item'),
      }],
    )
    const authority = structuredClone(planningAuthority)
    const artifacts = structuredClone(createTargetArtifacts('detached'))
    const page = createWorkspaceSearchMigrationTargetEvidencePage({
      identity,
      previousProgress: initial,
      pageResult: result,
      planningAuthority: authority,
      targetArtifacts: artifacts,
    })
    const expected = structuredClone(page)

    Reflect.set(result.checkpoint.aggregate, 'pageCount', 99)
    const row = result.targetRows[0]
    if (row === undefined) throw new Error('Expected row.')
    Reflect.set(row, 'targetItemDigest', digest('mutated-row'))
    Reflect.set(authority, 'fenceToken', 99)
    const artifact = artifacts[0]
    if (artifact === undefined) throw new Error('Expected artifact.')
    Reflect.set(artifact, 'versionId', 'mutated-version')

    expect(page).toEqual(expected)
  })

  test('creates stable distinct checkpoint, page, and progress digests', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const committed = commitPage(
      initial,
      createPageResult(initial.checkpoint, []),
    )
    const checkpointDigest =
      createWorkspaceSearchMigrationTargetCheckpointDigest(
        committed.progress.checkpoint,
      )
    const pageDigest =
      createWorkspaceSearchMigrationTargetEvidencePageDigest(committed.page)
    const progressDigest =
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
        committed.progress,
      )

    expect(checkpointDigest)
      .toBe('ceed78e9c87e5f315a3efb32b973522eaa8f631b9c98374cbeedf10101a3a14d')
    expect(pageDigest)
      .toBe('9d494f5d41af209fe464bcfb61c3ed99e4179b07c23d105c3cf603208c1e64c7')
    expect(progressDigest)
      .toBe('5587555986a63055fe0db6332bd88dd1108311ae363015aec98359e955787b07')
    expect(new Set([
      checkpointDigest,
      pageDigest,
      progressDigest,
    ]).size).toBe(3)
    expect(
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
        committed.progress,
      ),
    ).toBe(progressDigest)
  })

  test('replaces hostile and oversized failures without exposing raw values', () => {
    const initial =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const result = createPageResult(initial.checkpoint, [])
    const input = createFirstPageInput(result)
    const canary = 'RAW-TARGET-EVIDENCE-CANARY-DO-NOT-LEAK'
    Object.defineProperty(input, 'targetArtifacts', {
      enumerable: true,
      get() {
        throw new Error(canary)
      },
    })
    const failure = captureTargetEvidenceFailure(
      () => createWorkspaceSearchMigrationTargetEvidencePage(input),
    )
    expect(failure.code).toBe('INVALID_TARGET_EVIDENCE')
    expect(failure.message).toBe('INVALID_TARGET_EVIDENCE')
    expect(failure.message).not.toContain(canary)

    expectTargetEvidenceFailure(
      () =>
        parseWorkspaceSearchMigrationTargetEvidencePage(
          new Uint8Array(
            WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES + 1,
          ),
        ),
    )
  })
})

/**
 * Captures one expected fixed target-evidence failure.
 *
 * @param operation - Operation expected to fail safely.
 * @returns Stable target-evidence failure.
 */
function captureTargetEvidenceFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationTargetEvidenceError {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationTargetEvidenceError) {
      return error
    }
    throw error
  }
  throw new Error('Expected one target-evidence failure.')
}

/**
 * Requires one operation to raise the fixed target-evidence boundary.
 *
 * @param operation - Operation expected to fail safely.
 */
function expectTargetEvidenceFailure(operation: () => unknown): void {
  const failure = captureTargetEvidenceFailure(operation)
  expect(failure.code).toBe('INVALID_TARGET_EVIDENCE')
  expect(failure.message).toBe('INVALID_TARGET_EVIDENCE')
}
