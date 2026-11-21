import { describe, expect, test } from 'bun:test'
import type { CreatePlanningEntityInput, PlanningEntityType } from '@mukuroji/contracts'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import {
  InMemoryPlanningClient,
  type PlanningEntityCreation,
  type PlanningEntityTransactionResult,
  type PlanningMutationTransaction,
  type PlanningWorkItemState,
} from './planning'

const NOW = new Date('2026-07-16T09:00:00.000Z')
const WORKSPACE_ID = 'workspace-1'

/** One started Work Item in Team 1 that Planning links can reference. */
const WORK_ITEMS: PlanningWorkItemState = {
  workItems: [{
    id: 'work-1',
    revision: 1,
    teamId: 'team-1',
    title: 'Work 1',
    statusCategory: 'started',
    dueDate: '2026-08-31',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
  }],
}

/** In-memory client that runs one concurrent write before a chosen commit. */
class RacingClient extends InMemoryPlanningClient {
  /** Commits attempted so far, including those that fail. */
  commitCount = 0
  /** Concurrent writes run before each commit whose 1-based number is listed. */
  racesAtCommit = new Map<number, () => Promise<void> | void>()

  /**
   * Runs the race for this commit, then commits.
   *
   * @param args - Arguments of the in-memory commit.
   */
  protected override async commitState(
    ...args: Parameters<InMemoryPlanningClient['commitState']>
  ) {
    this.commitCount += 1
    await this.racesAtCommit.get(this.commitCount)?.()
    return super.commitState(...args)
  }
}

/**
 * Creates a Planning entity input with valid one-day dates.
 *
 * @param id - Entity ID.
 * @param type - Entity type.
 * @param expectedRevision - Revision the caller read.
 * @param overrides - Fields replaced for the scenario.
 * @returns Create input.
 */
function createEntityInput(
  id: string,
  type: PlanningEntityType,
  expectedRevision: number,
  overrides: Partial<CreatePlanningEntityInput> = {},
): PlanningEntityCreation {
  return {
    id,
    type,
    title: id,
    ownerMemberKey: 'owner@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
    forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
    expectedRevision,
    ...overrides,
  }
}

/**
 * Seeds a portfolio, roadmap, milestone, and Cycle at revision 4.
 *
 * @param client - Client receiving the graph.
 */
async function seedPlanning(client: InMemoryPlanningClient) {
  await client.create(WORKSPACE_ID, createEntityInput('portfolio-1', 'portfolio', 0, {
    baseline: { startDate: '2026-01-01', endDate: '2026-12-31' },
    forecast: { startDate: '2026-01-01', endDate: '2026-12-31' },
  }), WORK_ITEMS)
  await client.create(WORKSPACE_ID, createEntityInput('roadmap-1', 'roadmap', 1, {
    parentId: 'portfolio-1',
    baseline: { startDate: '2026-01-01', endDate: '2026-12-31' },
    forecast: { startDate: '2026-01-01', endDate: '2026-12-31' },
  }), WORK_ITEMS)
  await client.create(WORKSPACE_ID, createEntityInput('milestone-1', 'milestone', 2, {
    parentId: 'roadmap-1',
  }), WORK_ITEMS)
  await client.create(WORKSPACE_ID, createEntityInput('cycle-1', 'cycle', 3, {
    teamId: 'team-1',
    cadence: { unit: 'week', count: 2 },
    capacity: 20,
    carryOverPolicy: 'move-incomplete',
    baseline: { startDate: '2026-08-01', endDate: '2026-08-14' },
    forecast: { startDate: '2026-08-01', endDate: '2026-08-14' },
  }), WORK_ITEMS)
}

describe('Planning edits while Work Items change', () => {
  test('changes a Milestone date and links a Cycle after other Work Item writes', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await seedPlanning(client)
    const read = await client.get(WORKSPACE_ID, WORK_ITEMS)
    expect(read.revision).toBe(4)
    client.recordWorkItemRevision(WORKSPACE_ID)
    client.recordWorkItemRevision(WORKSPACE_ID)

    const moved = await client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: read.revision,
      patch: { forecast: { startDate: '2026-08-05', endDate: '2026-08-05' } },
    }, WORK_ITEMS)
    expect(moved.planning.revision).toBe(7)
    expect(moved.planning.entities.find((entity) => entity.id === 'milestone-1')?.forecast)
      .toEqual({ startDate: '2026-08-05', endDate: '2026-08-05' })

    client.recordWorkItemRevision(WORKSPACE_ID)
    const linked = await client.putWorkItemLink(WORKSPACE_ID, {
      teamId: 'team-1',
      workItemId: 'work-1',
      cycleId: 'cycle-1',
      goalIds: [],
      expectedRevision: moved.planning.revision,
    }, WORK_ITEMS)
    expect(linked.planning.revision).toBe(9)
    expect(linked.planning.workItemLinks).toEqual([
      expect.objectContaining({ workItemId: 'work-1', cycleId: 'cycle-1' }),
    ])
    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 7, 9)).toBe(false)
  })

  test('still rejects a revision older than another Planning change', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await seedPlanning(client)
    client.recordWorkItemRevision(WORKSPACE_ID)
    await client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Renamed by someone else' },
    }, WORK_ITEMS)
    client.recordWorkItemRevision(WORKSPACE_ID)

    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 4, 7)).toBe(false)
    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 6, 7)).toBe(true)
    await expect(client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { forecast: { startDate: '2026-08-05', endDate: '2026-08-05' } },
    }, WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
  })

  test('detects two edits of the same entity from one read', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await seedPlanning(client)

    await client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'First edit' },
    }, WORK_ITEMS)
    await expect(client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Second edit' },
    }, WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
  })

  test('keeps exact revisions for edits that read Work Item state', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await seedPlanning(client)
    client.recordWorkItemRevision(WORKSPACE_ID)

    await expect(client.archive(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
    }, WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
  })

  test('treats a revision without Work Item counters as a Planning change', async () => {
    const client = new InMemoryPlanningClient(() => NOW)

    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 0, 0)).toBe(true)
    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 1, 0)).toBe(false)
    client.recordWorkItemRevision(WORKSPACE_ID)
    // No Planning commit has recorded where the Work Item advances started.
    expect(await client.isWorkItemOnlyRevisionAdvance(WORKSPACE_ID, 0, 1)).toBe(false)
  })

  test('retries a commit that a Work Item write overtook', async () => {
    const client = new RacingClient(() => NOW)
    await seedPlanning(client)
    client.commitCount = 0
    client.racesAtCommit.set(1, () => client.recordWorkItemRevision(WORKSPACE_ID))
    client.racesAtCommit.set(2, () => client.recordWorkItemRevision(WORKSPACE_ID))

    const moved = await client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Moved' },
    }, WORK_ITEMS)

    expect(client.commitCount).toBe(3)
    expect(moved.planning.revision).toBe(7)
  })

  test('stops retrying when Work Item writes keep overtaking the commit', async () => {
    const client = new RacingClient(() => NOW)
    await seedPlanning(client)
    client.commitCount = 0
    for (const commit of [1, 2, 3]) {
      client.racesAtCommit.set(commit, () => client.recordWorkItemRevision(WORKSPACE_ID))
    }

    await expect(client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Moved' },
    }, WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
    expect(client.commitCount).toBe(3)
  })

  test('does not retry over a Planning change that overtook the commit', async () => {
    const client = new RacingClient(() => NOW)
    await seedPlanning(client)
    client.commitCount = 0
    client.racesAtCommit.set(1, async () => {
      await client.update(WORKSPACE_ID, 'roadmap-1', {
        expectedRevision: 4,
        patch: { title: 'Concurrent rename' },
      }, WORK_ITEMS)
    })

    await expect(client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Moved' },
    }, WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
    // The overtaken commit and the concurrent rename; no third attempt.
    expect(client.commitCount).toBe(2)
  })

  test('rebases an audited edit and prepares its audit write again for each attempt', async () => {
    const client = new RacingClient(() => NOW)
    await seedPlanning(client)
    client.recordWorkItemRevision(WORKSPACE_ID)
    client.commitCount = 0
    client.racesAtCommit.set(1, () => client.recordWorkItemRevision(WORKSPACE_ID))
    const prepared: PlanningEntityTransactionResult[] = []
    const transaction: PlanningMutationTransaction<PlanningEntityTransactionResult> = {
      rebaseSafe: true,
      async prepare(result) {
        prepared.push(result)
        return { transactWriteItem: { Put: { TableName: 'AuditEventsTable', Item: { revision: result.revision } } } }
      },
    }

    const updated = await client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Audited' },
    }, WORK_ITEMS, transaction)

    expect(updated.planning.revision).toBe(7)
    expect(client.commitCount).toBe(2)
    expect(prepared.map((result) => result.revision)).toEqual([6, 7])
    expect(prepared[1]).toMatchObject({
      kind: 'entity',
      action: 'updated',
      entity: { id: 'milestone-1', title: 'Audited' },
      previous: { id: 'milestone-1', title: 'milestone-1' },
    })
  })

  test('keeps an exact revision for a transaction that is not rebase safe', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await seedPlanning(client)
    client.recordWorkItemRevision(WORKSPACE_ID)

    await expect(client.update(WORKSPACE_ID, 'milestone-1', {
      expectedRevision: 4,
      patch: { title: 'Receipt bound' },
    }, WORK_ITEMS, {
      async prepare() {
        return { transactWriteItem: { Put: { TableName: 'Receipts', Item: {} } } }
      },
    })).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
  })
})
