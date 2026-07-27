import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
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
 * @returns Parsed page and successor progress.
 */
function commitPage(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  result: WorkspaceSearchMigrationSourceScanPageResult,
) {
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
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
  })

  test('pins versioned checkpoint, page, and progress digest vectors', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
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
        'f533c5e30d4c3ef0812594a72888c3e53902868effc8cd9ee9604c41de2e0ee3',
      progress:
        'c7ee32dc216abf9f9f14d8f3ba24fb4a99eb6bf3e1d6d0616fd95e09c9c12d7a',
    })
  })

  test('separates dry-run and planning identities before advancing a page', () => {
    const initial =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
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
