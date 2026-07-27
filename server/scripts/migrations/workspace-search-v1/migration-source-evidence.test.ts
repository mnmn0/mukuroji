import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
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
 * Creates, serializes, parses, and advances one page.
 *
 * @param progress - Exact predecessor progress.
 * @param result - Exact reducer result.
 * @param authority - Exact planning authority for this page.
 * @returns Parsed page and successor progress.
 */
function commitPage(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  result: WorkspaceSearchMigrationSourceScanPageResult,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding =
    planningAuthority,
) {
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
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
    expect(first.page.planningAuthority).toEqual(planningAuthority)
    expect(second.page.planningAuthority).toEqual({
      ...planningAuthority,
      ownerId: 'takeover-owner',
      fenceToken: 8,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        digest('renewed-maintenance-receipt'),
    })
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
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const bytes =
      serializeWorkspaceSearchMigrationSourceEvidencePage(page)
    const parsed =
      parseWorkspaceSearchMigrationSourceEvidencePage(bytes)

    expect(page.evidenceVersion).toBe(1)
    expect('planningAuthority' in page).toBe(false)
    expect(new TextDecoder().decode(bytes)).not.toContain(
      'planningAuthority',
    )
    expect(parsed).toEqual(page)
    expect(
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        parsed,
      ).checkpoint.completed,
    ).toBe(true)
  })

  test('requires planning authority only for planning pages', () => {
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
        previousProgress: planningInitial,
        pageResult: createPageResult(planningInitial.checkpoint, []),
      })
    ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    expect(() =>
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity: dryRunIdentity,
        planningAuthority,
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
          previousProgress: initial,
          pageResult,
        })
      ).toThrow(WorkspaceSearchMigrationSourceEvidenceError)
    }
  })

  test('binds planning authority into the page digest and round-trip', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const pageResult = createPageResult(initial.checkpoint, [])
    const original = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      previousProgress: initial,
      pageResult,
    })
    const changed = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority: {
        ...planningAuthority,
        maintenanceEvidenceReceiptDigest:
          digest('substituted-maintenance-receipt'),
      },
      previousProgress: initial,
      pageResult,
    })
    const parsed = parseWorkspaceSearchMigrationSourceEvidencePage(
      serializeWorkspaceSearchMigrationSourceEvidencePage(original),
    )

    expect(original.evidenceVersion).toBe(2)
    expect(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(changed),
    ).not.toBe(
      createWorkspaceSearchMigrationSourceEvidencePageDigest(original),
    )
    expect(parsed).toEqual(original)
  })

  test('rejects legacy version-one planning evidence', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
      previousProgress: initial,
      pageResult: createPageResult(initial.checkpoint, []),
    })
    const legacyValue: unknown = JSON.parse(
      new TextDecoder().decode(
        serializeWorkspaceSearchMigrationSourceEvidencePage(page),
      ),
    )
    if (
      typeof legacyValue !== 'object' ||
      legacyValue === null ||
      Array.isArray(legacyValue)
    ) {
      throw new Error('Expected encoded evidence object.')
    }
    Reflect.deleteProperty(legacyValue, 'planningAuthority')
    Reflect.set(legacyValue, 'evidenceVersion', 1)

    expect(() =>
      parseWorkspaceSearchMigrationSourceEvidencePage(
        new TextEncoder().encode(JSON.stringify(legacyValue)),
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
        'f2a3d795bb475a86ca1886910973e246fd05d3d7166f8e68aaf5669134d2b9b1',
      progress:
        'dfd2f57d4b5f3c0f2163ec5ecd540e889aac482060ffabe52fcf53e9623c406e',
    })
  })

  test('separates dry-run and planning identities before advancing a page', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority,
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
