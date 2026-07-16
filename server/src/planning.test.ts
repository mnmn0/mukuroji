import { describe, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  CreatePlanningEntityInput,
  PlanningEntity,
  PlanningEntityType,
  PlanningWorkItemSummary,
  UpdatePlanningEntityInput,
} from '@mukuroji/contracts'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
  type PlanningWorkItemState,
} from './planning'

const NOW = new Date('2026-07-16T09:00:00.000Z')
const EMPTY_WORK_ITEMS: PlanningWorkItemState = { workItems: [] }
const NEXT_CYCLE_RANGE = { startDate: '2026-08-15', endDate: '2026-08-28' }

function createEntityInput(
  id: string,
  type: PlanningEntityType,
  expectedRevision: number,
  overrides: Partial<CreatePlanningEntityInput> = {},
): CreatePlanningEntityInput {
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

function createCycleInput(
  id: string,
  expectedRevision: number,
  overrides: Partial<CreatePlanningEntityInput> = {},
): CreatePlanningEntityInput {
  return createEntityInput(id, 'cycle', expectedRevision, {
    teamId: 'team-1',
    cadence: { unit: 'week', count: 2 },
    capacity: 20,
    carryOverPolicy: 'move-incomplete',
    ...overrides,
  })
}

function createStoredCycle(id: string) {
  return {
    workspaceId: 'workspace-1',
    recordKey: `ENTITY#${id}`,
    entryType: 'planning-entity',
    id,
    type: 'cycle',
    title: id,
    teamId: 'team-1',
    projectId: 'project-1',
    ownerMemberKey: 'owner@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-08-01', endDate: '2026-08-14' },
    forecast: { startDate: '2026-08-01', endDate: '2026-08-14' },
    cadence: { unit: 'week', count: 2 },
    capacity: 10,
    carryOverPolicy: 'move-incomplete',
    statusUpdates: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }
}

function getEntity(entities: readonly PlanningEntity[], id: string) {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Planning entity "${id}" was not returned.`)
  return entity
}

function createWorkItem(
  id: string,
  statusCategory: PlanningWorkItemSummary['statusCategory'],
): PlanningWorkItemSummary {
  return {
    id,
    revision: 1,
    teamId: 'team-1',
    title: id,
    projectId: 'project-1',
    statusCategory,
    dueDate: '2026-08-31',
  }
}

function createOversizedStoredEntity(id: string) {
  return {
    workspaceId: 'workspace-1',
    recordKey: `ENTITY#${id}`,
    entryType: 'planning-entity',
    id,
    type: 'portfolio',
    title: id,
    description: 'd'.repeat(20_000),
    ownerMemberKey: 'owner@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
    forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
    statusUpdates: Array.from({ length: 32 }, (_, index) => ({
      id: `${String(index).padStart(2, '0')}${'😀'.repeat(127)}`,
      message: 'x'.repeat(8_000),
      authorMemberKey: '😀'.repeat(128),
      createdAt: NOW.toISOString(),
    })),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }
}

describe('planning domain', () => {
  test('enforces hierarchy, date, and global revision invariants', async () => {
    const client = new InMemoryPlanningClient(() => NOW)

    await expect(client.create(
      'workspace-1',
      createEntityInput('invalid-dates', 'portfolio', 0, {
        baseline: { startDate: '2026-08-02', endDate: '2026-08-01' },
      }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningDateRangeInvalid' })

    await expect(client.create(
      'workspace-1',
      createEntityInput('project-without-team', 'portfolio', 0, {
        projectId: 'project-1',
      }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningProjectTeamRequired' })

    const created = await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    expect(created.planning.revision).toBe(1)

    await expect(client.create(
      'workspace-1',
      createEntityInput('roadmap-without-parent', 'roadmap', 1),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningParentRequired' })

    await expect(client.create(
      'workspace-1',
      createEntityInput('milestone-under-portfolio', 'milestone', 1, {
        parentId: 'portfolio-1',
      }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningHierarchyInvalid' })

    await expect(client.create(
      'workspace-1',
      createEntityInput('stale-portfolio', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })

    expect((await client.get('workspace-1', EMPTY_WORK_ITEMS)).revision).toBe(1)
  })

  test('models OKR key results as children of objective goals', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-1', 'roadmap', 1, { parentId: 'portfolio-1' }),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('initiative-1', 'initiative', 2, { parentId: 'roadmap-1' }),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('objective-1', 'goal', 3, {
        parentId: 'initiative-1',
        goalFramework: 'objective',
      }),
      EMPTY_WORK_ITEMS,
    )

    await expect(client.create(
      'workspace-1',
      createEntityInput('invalid-key-result', 'goal', 4, {
        parentId: 'initiative-1',
        goalFramework: 'key-result',
      }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningHierarchyInvalid' })

    const response = await client.create(
      'workspace-1',
      createEntityInput('key-result-1', 'goal', 4, {
        parentId: 'objective-1',
        goalFramework: 'key-result',
      }),
      EMPTY_WORK_ITEMS,
    )
    expect(getEntity(response.planning.entities, 'key-result-1')).toMatchObject({
      parentId: 'objective-1',
      goalFramework: 'key-result',
    })
  })

  test('rejects malformed patches, oversized descriptions, and full status history', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await expect(client.create(
      'workspace-1',
      createEntityInput('invalid-description', 'portfolio', 0, {
        description: 42 as unknown as string,
      }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningDescriptionInvalid' })

    await client.create(
      'workspace-1',
      createEntityInput('portfolio-history', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    await expect(client.update(
      'workspace-1',
      'portfolio-history',
      { expectedRevision: 1 } as UpdatePlanningEntityInput,
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningPatchInvalid' })

    for (let index = 0; index < 32; index += 1) {
      await client.addStatusUpdate('workspace-1', 'portfolio-history', {
        id: `status-${index}`,
        message: `Update ${index}`,
        expectedRevision: index + 1,
      }, 'author@example.com', EMPTY_WORK_ITEMS)
    }
    await expect(client.addStatusUpdate('workspace-1', 'portfolio-history', {
      id: 'status-over-limit',
      message: 'This update exceeds the retained history.',
      expectedRevision: 33,
    }, 'author@example.com', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningStatusUpdateLimitExceeded',
    })
  })

  test('rejects a Work Item link without a Cycle, Milestone, or Goal', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [createWorkItem('work-unlinked', 'unstarted')],
    }

    await expect(client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-unlinked',
      goalIds: [],
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningWorkItemLinkTargetRequired',
    })

    const snapshot = await client.get('workspace-1', workItemState)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.workItemLinks).toEqual([])
  })

  test('rolls up unique Work Items and the worst descendant health', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-started', 'started'),
        createWorkItem('work-canceled', 'canceled'),
      ],
    }
    const client = new InMemoryPlanningClient(() => NOW)
    const scope = { teamId: 'team-1', projectId: 'project-1' }

    await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0, scope),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-1', 'roadmap', 1, {
        ...scope,
        parentId: 'portfolio-1',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('initiative-1', 'initiative', 2, {
        ...scope,
        parentId: 'roadmap-1',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('goal-1', 'goal', 3, {
        ...scope,
        parentId: 'initiative-1',
        goalFramework: 'objective',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('phase-1', 'phase', 4, {
        ...scope,
        parentId: 'goal-1',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('milestone-1', 'milestone', 5, {
        ...scope,
        parentId: 'phase-1',
        risk: 'high',
      }),
      workItemState,
    )
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-started',
      milestoneId: 'milestone-1',
      goalIds: ['goal-1'],
      expectedRevision: 6,
    }, workItemState)
    const response = await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-canceled',
      goalIds: ['goal-1'],
      expectedRevision: 7,
    }, workItemState)

    const portfolio = getEntity(response.planning.entities, 'portfolio-1')
    expect(portfolio.progress).toBe(50)
    expect(portfolio.linkedWorkItemCount).toBe(2)
    expect(portfolio.rollupHealth).toBe('off-track')
    expect(response.planning.workItemLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workItemId: 'work-started',
        projectId: 'project-1',
      }),
    ]))
  })

  test('calculates a dependency critical path and rejects a transitive cycle', async () => {
    const client = new InMemoryPlanningClient(() => NOW)

    await client.create('workspace-1', createEntityInput('portfolio-long', 'portfolio', 0, {
      baseline: { startDate: '2026-01-01', endDate: '2026-12-31' },
      forecast: { startDate: '2026-01-01', endDate: '2026-12-31' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('cycle-a', 1, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-02' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-02' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('cycle-b', 2, {
      baseline: { startDate: '2026-08-03', endDate: '2026-08-05' },
      forecast: { startDate: '2026-08-03', endDate: '2026-08-05' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('cycle-c', 3, {
      baseline: { startDate: '2026-08-06', endDate: '2026-08-06' },
      forecast: { startDate: '2026-08-06', endDate: '2026-08-06' },
    }), EMPTY_WORK_ITEMS)
    await client.createDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessorId: 'cycle-a',
      successorId: 'cycle-b',
      type: 'finish-to-start',
      lagDays: 1,
      expectedRevision: 4,
    }, EMPTY_WORK_ITEMS)
    await expect(client.createDependency('workspace-1', {
      id: 'dependency-a-b-duplicate',
      predecessorId: 'cycle-a',
      successorId: 'cycle-b',
      type: 'start-to-start',
      lagDays: 0,
      expectedRevision: 5,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningDependencyDuplicate',
    })
    const response = await client.createDependency('workspace-1', {
      id: 'dependency-b-c',
      predecessorId: 'cycle-b',
      successorId: 'cycle-c',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 5,
    }, EMPTY_WORK_ITEMS)

    expect(response.planning.criticalPath).toMatchObject({
      entityIds: ['cycle-a', 'cycle-b', 'cycle-c'],
      totalDurationDays: 7,
      slackByEntityId: {
        'cycle-a': 0,
        'cycle-b': 0,
        'cycle-c': 0,
      },
    })

    await expect(client.createDependency('workspace-1', {
      id: 'dependency-c-a',
      predecessorId: 'cycle-c',
      successorId: 'cycle-a',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 6,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningDependencyCycle',
    })
  })

  test('keeps a zero-lag start-to-start predecessor on the critical path', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createCycleInput('cycle-short', 0, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-05' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-05' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('cycle-long', 1, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-10' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-10' },
    }), EMPTY_WORK_ITEMS)

    const response = await client.createDependency('workspace-1', {
      id: 'dependency-same-start',
      predecessorId: 'cycle-short',
      successorId: 'cycle-long',
      type: 'start-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)

    expect(response.planning.criticalPath).toEqual({
      entityIds: ['cycle-short', 'cycle-long'],
      totalDurationDays: 10,
      slackByEntityId: {
        'cycle-long': 0,
        'cycle-short': 0,
      },
    })
  })

  test('keeps a binding finish-to-finish successor when endpoint finishes tie', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createCycleInput('a-predecessor', 0, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-10' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-10' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('b-successor', 1, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
    }), EMPTY_WORK_ITEMS)

    const response = await client.createDependency('workspace-1', {
      id: 'dependency-same-finish',
      predecessorId: 'a-predecessor',
      successorId: 'b-successor',
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)

    expect(response.planning.criticalPath).toEqual({
      entityIds: ['a-predecessor', 'b-successor'],
      totalDurationDays: 10,
      slackByEntityId: {
        'a-predecessor': 0,
        'b-successor': 0,
      },
    })
  })

  test('rolls over only incomplete Work Items according to the Cycle policy', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-todo', 'unstarted'),
        createWorkItem('work-done', 'completed'),
      ],
    }

    for (const carryOverPolicy of ['move-incomplete', 'keep-incomplete'] as const) {
      const client = new InMemoryPlanningClient(() => NOW)
      await client.create('workspace-1', createCycleInput('cycle-source', 0, {
        projectId: 'project-1',
        carryOverPolicy,
      }), workItemState)
      await client.create('workspace-1', createCycleInput('cycle-target', 1, {
        projectId: 'project-1',
        baseline: NEXT_CYCLE_RANGE,
        forecast: NEXT_CYCLE_RANGE,
      }), workItemState)
      await client.putWorkItemLink('workspace-1', {
        teamId: 'team-1',
        workItemId: 'work-todo',
        cycleId: 'cycle-source',
        goalIds: [],
        expectedRevision: 2,
      }, workItemState)
      await client.putWorkItemLink('workspace-1', {
        teamId: 'team-1',
        workItemId: 'work-done',
        cycleId: 'cycle-source',
        goalIds: [],
        expectedRevision: 3,
      }, workItemState)

      const response = await client.rolloverCycle('workspace-1', 'cycle-source', {
        targetCycleId: 'cycle-target',
        expectedRevision: 4,
      }, workItemState)
      const todoLink = response.planning.workItemLinks.find((link) =>
        link.workItemId === 'work-todo'
      )
      const doneLink = response.planning.workItemLinks.find((link) =>
        link.workItemId === 'work-done'
      )

      expect(getEntity(response.planning.entities, 'cycle-source').status).toBe('completed')
      expect(doneLink?.cycleId).toBe('cycle-source')
      if (carryOverPolicy === 'move-incomplete') {
        expect(response.movedWorkItemIds).toEqual(['work-todo'])
        expect(response.retainedWorkItemIds).toEqual([])
        expect(todoLink?.cycleId).toBe('cycle-target')
      } else {
        expect(response.movedWorkItemIds).toEqual([])
        expect(response.retainedWorkItemIds).toEqual(['work-todo'])
        expect(todoLink?.cycleId).toBe('cycle-source')
      }

      await expect(client.rolloverCycle('workspace-1', 'cycle-source', {
        targetCycleId: 'cycle-target',
        expectedRevision: 5,
      }, workItemState)).rejects.toMatchObject({
        status: 409,
        code: 'PlanningCycleRolloverSourceClosed',
      })

      if (carryOverPolicy === 'move-incomplete') {
        const archived = await client.archive(
          'workspace-1',
          'cycle-source',
          { expectedRevision: 5 },
          workItemState,
        )
        expect(getEntity(archived.planning.entities, 'cycle-source').archivedAt)
          .toBe(NOW.toISOString())
        expect(archived.planning.workItemLinks).toHaveLength(2)
      } else {
        await expect(client.archive(
          'workspace-1',
          'cycle-source',
          { expectedRevision: 5 },
          workItemState,
        )).rejects.toMatchObject({
          status: 409,
          code: 'PlanningCycleHasIncompleteWorkItems',
        })
        const unchanged = await client.get('workspace-1', workItemState)
        expect(unchanged.revision).toBe(5)
        expect(getEntity(unchanged.entities, 'cycle-source').archivedAt).toBeUndefined()
      }
    }

    const closedTargetClient = new InMemoryPlanningClient(() => NOW)
    await closedTargetClient.create(
      'workspace-1',
      createCycleInput('cycle-source', 0),
      EMPTY_WORK_ITEMS,
    )
    await closedTargetClient.create(
      'workspace-1',
      createCycleInput('cycle-target', 1, { status: 'completed' }),
      EMPTY_WORK_ITEMS,
    )
    await expect(closedTargetClient.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleRolloverTargetClosed',
    })

    const cadenceClient = new InMemoryPlanningClient(() => NOW)
    await cadenceClient.create(
      'workspace-1',
      createCycleInput('cycle-source', 0),
      EMPTY_WORK_ITEMS,
    )
    await cadenceClient.create(
      'workspace-1',
      createCycleInput('cycle-target', 1, {
        baseline: NEXT_CYCLE_RANGE,
        forecast: NEXT_CYCLE_RANGE,
        cadence: { unit: 'month', count: 1 },
      }),
      EMPTY_WORK_ITEMS,
    )
    await expect(cadenceClient.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleCadenceMismatch',
    })

    const dateOrderClient = new InMemoryPlanningClient(() => NOW)
    await dateOrderClient.create(
      'workspace-1',
      createCycleInput('cycle-source', 0),
      EMPTY_WORK_ITEMS,
    )
    await dateOrderClient.create(
      'workspace-1',
      createCycleInput('cycle-target', 1),
      EMPTY_WORK_ITEMS,
    )
    await expect(dateOrderClient.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleDateOrderInvalid',
    })
  })

  test('rejects an oversized atomic Cycle rollover before changing the source', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: Array.from({ length: 50 }, (_, index) =>
        createWorkItem(`work-${index}`, 'unstarted')
      ),
    }
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createCycleInput('cycle-source', 0, { projectId: 'project-1', capacity: 50 }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createCycleInput('cycle-target', 1, { projectId: 'project-1', capacity: 50 }),
      workItemState,
    )
    await client.update('workspace-1', 'cycle-target', {
      expectedRevision: 2,
      patch: { baseline: NEXT_CYCLE_RANGE, forecast: NEXT_CYCLE_RANGE },
    }, workItemState)
    for (let index = 0; index < workItemState.workItems.length; index += 1) {
      await client.putWorkItemLink('workspace-1', {
        teamId: 'team-1',
        workItemId: `work-${index}`,
        cycleId: 'cycle-source',
        goalIds: [],
        expectedRevision: index + 3,
      }, workItemState)
    }

    await expect(client.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 53,
    }, workItemState)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningCycleRolloverLimitExceeded',
    })
    expect(getEntity(
      (await client.get('workspace-1', workItemState)).entities,
      'cycle-source',
    ).status).not.toBe('completed')
  })

  test('enforces count-based Cycle capacity for links and rollover', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-one', 'unstarted'),
        createWorkItem('work-two', 'unstarted'),
      ],
    }
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createCycleInput('cycle-source', 0, { projectId: 'project-1', capacity: 1 }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createCycleInput('cycle-target', 1, {
        projectId: 'project-1',
        capacity: 0,
        baseline: NEXT_CYCLE_RANGE,
        forecast: NEXT_CYCLE_RANGE,
      }),
      workItemState,
    )
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-one',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 2,
    }, workItemState)
    await expect(client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-two',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 3,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleCapacityExceeded',
    })
    await expect(client.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 3,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleCapacityExceeded',
    })
  })

  test('hides inaccessible Work Item links while rollover remains fail-closed', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const fullWorkItemState: PlanningWorkItemState = {
      workItems: [createWorkItem('work-private', 'unstarted')],
    }
    await client.create(
      'workspace-1',
      createCycleInput('cycle-source', 0, { projectId: 'project-1' }),
      fullWorkItemState,
    )
    await client.create(
      'workspace-1',
      createCycleInput('cycle-target', 1, {
        projectId: 'project-1',
        baseline: NEXT_CYCLE_RANGE,
        forecast: NEXT_CYCLE_RANGE,
      }),
      fullWorkItemState,
    )
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-private',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 2,
    }, fullWorkItemState)

    const restricted = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(restricted.workItemLinks).toEqual([])
    expect(restricted.workItems).toEqual([])
    expect(getEntity(restricted.entities, 'cycle-source').linkedWorkItemCount).toBe(0)
    expect(restricted.entities.map((entity) => entity.id)).toEqual([
      'cycle-source',
      'cycle-target',
    ])

    await expect(client.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 503,
      code: 'PlanningWorkItemMissing',
    })

    const cleaned = await client.deleteWorkItemLink(
      'workspace-1',
      'team-1',
      'work-private',
      { expectedRevision: 3 },
      EMPTY_WORK_ITEMS,
    )
    expect(cleaned.planning.revision).toBe(4)
    const rolledOver = await client.rolloverCycle('workspace-1', 'cycle-source', {
      targetCycleId: 'cycle-target',
      expectedRevision: 4,
    }, EMPTY_WORK_ITEMS)
    expect(rolledOver.movedWorkItemIds).toEqual([])
  })

  test('hides stale Project links and requires explicit re-linking before rollover', async () => {
    const originalWorkItem = createWorkItem('work-reassigned', 'unstarted')
    const originalState: PlanningWorkItemState = { workItems: [originalWorkItem] }
    const reassignedState: PlanningWorkItemState = {
      workItems: [{ ...originalWorkItem, projectId: 'project-2' }],
    }
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createCycleInput('cycle-source', 0, { projectId: 'project-1' }),
      originalState,
    )
    await client.create(
      'workspace-1',
      createCycleInput('cycle-target-old-project', 1, {
        projectId: 'project-1',
        baseline: NEXT_CYCLE_RANGE,
        forecast: NEXT_CYCLE_RANGE,
      }),
      originalState,
    )
    await client.create(
      'workspace-1',
      createCycleInput('cycle-target-new-project', 2, { projectId: 'project-2' }),
      originalState,
    )
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-reassigned',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 3,
    }, originalState)

    const staleSnapshot = await client.get('workspace-1', reassignedState)
    expect(staleSnapshot.workItemLinks).toEqual([])
    expect(getEntity(staleSnapshot.entities, 'cycle-source').linkedWorkItemCount).toBe(0)
    await expect(client.rolloverCycle(
      'workspace-1',
      'cycle-source',
      { targetCycleId: 'cycle-target-old-project', expectedRevision: 4 },
      reassignedState,
    )).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemProjectMismatch',
    })

    const relinked = await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-reassigned',
      cycleId: 'cycle-target-new-project',
      goalIds: [],
      expectedRevision: 4,
    }, reassignedState)
    expect(relinked.planning.workItemLinks).toEqual([
      expect.objectContaining({
        workItemId: 'work-reassigned',
        projectId: 'project-2',
        cycleId: 'cycle-target-new-project',
      }),
    ])
  })

  test('duplicates without status history or graph edges and soft-archives the copy', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-1', 'roadmap', 1, { parentId: 'portfolio-1' }),
      EMPTY_WORK_ITEMS,
    )
    await client.addStatusUpdate('workspace-1', 'roadmap-1', {
      id: 'update-1',
      message: 'At risk this week',
      health: 'at-risk',
      expectedRevision: 2,
    }, 'author@example.com', EMPTY_WORK_ITEMS)
    await client.createDependency('workspace-1', {
      id: 'dependency-1',
      predecessorId: 'portfolio-1',
      successorId: 'roadmap-1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)
    const duplicated = await client.duplicate('workspace-1', 'roadmap-1', {
      targetId: 'roadmap-copy',
      title: 'Roadmap copy',
      expectedRevision: 4,
    }, EMPTY_WORK_ITEMS)

    const copy = getEntity(duplicated.planning.entities, 'roadmap-copy')
    expect(copy.statusUpdates).toEqual([])
    expect(duplicated.planning.dependencies.some((dependency) =>
      dependency.predecessorId === copy.id || dependency.successorId === copy.id
    )).toBe(false)

    const archived = await client.archive(
      'workspace-1',
      'roadmap-copy',
      { expectedRevision: 5 },
      EMPTY_WORK_ITEMS,
    )
    expect(getEntity(archived.planning.entities, 'roadmap-copy').archivedAt)
      .toBe(NOW.toISOString())

    const archivedOriginal = await client.archive(
      'workspace-1',
      'roadmap-1',
      { expectedRevision: 6 },
      EMPTY_WORK_ITEMS,
    )
    expect(archivedOriginal.planning.dependencies).toHaveLength(1)
    await expect(client.createDependency('workspace-1', {
      id: 'dependency-to-archived',
      predecessorId: 'portfolio-1',
      successorId: 'roadmap-1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 7,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningEntityArchived',
    })
  })

  test('rejects archiving a parent until all active children are archived', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-parent', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-child', 'roadmap', 1, { parentId: 'portfolio-parent' }),
      EMPTY_WORK_ITEMS,
    )

    await expect(client.archive(
      'workspace-1',
      'portfolio-parent',
      { expectedRevision: 2 },
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({
      status: 409,
      code: 'PlanningEntityHasActiveChildren',
    })
    await client.archive(
      'workspace-1',
      'roadmap-child',
      { expectedRevision: 2 },
      EMPTY_WORK_ITEMS,
    )
    const response = await client.archive(
      'workspace-1',
      'portfolio-parent',
      { expectedRevision: 3 },
      EMPTY_WORK_ITEMS,
    )
    expect(getEntity(response.planning.entities, 'portfolio-parent').archivedAt)
      .toBe(NOW.toISOString())
  })

  test('rejects archiving a Cycle while it has an incomplete Work Item link', async () => {
    const incompleteWorkItems: PlanningWorkItemState = {
      workItems: [createWorkItem('work-incomplete', 'started')],
    }
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create(
      'workspace-1',
      createCycleInput('cycle-incomplete', 0, { projectId: 'project-1' }),
      incompleteWorkItems,
    )
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-incomplete',
      projectId: 'project-1',
      cycleId: 'cycle-incomplete',
      goalIds: [],
      expectedRevision: 1,
    }, incompleteWorkItems)

    await expect(client.archive(
      'workspace-1',
      'cycle-incomplete',
      { expectedRevision: 2 },
      incompleteWorkItems,
    )).rejects.toMatchObject({
      status: 409,
      code: 'PlanningCycleHasIncompleteWorkItems',
    })

    const unchanged = await client.get('workspace-1', incompleteWorkItems)
    expect(unchanged.revision).toBe(2)
    expect(getEntity(unchanged.entities, 'cycle-incomplete').archivedAt).toBeUndefined()
  })

  test('moves a scoped hierarchy subtree atomically', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const originalScope = { teamId: 'team-1', projectId: 'project-1' }
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-subtree', 'portfolio', 0, originalScope),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-subtree', 'roadmap', 1, {
        ...originalScope,
        parentId: 'portfolio-subtree',
      }),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('initiative-subtree', 'initiative', 2, {
        ...originalScope,
        parentId: 'roadmap-subtree',
      }),
      EMPTY_WORK_ITEMS,
    )

    const response = await client.move('workspace-1', 'portfolio-subtree', {
      teamId: 'team-1',
      projectId: 'project-2',
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)
    expect(response.planning.entities.map((entity) => ({
      id: entity.id,
      projectId: entity.projectId,
    }))).toEqual([
      { id: 'initiative-subtree', projectId: 'project-2' },
      { id: 'portfolio-subtree', projectId: 'project-2' },
      { id: 'roadmap-subtree', projectId: 'project-2' },
    ])
  })

  test('preserves archived descendant scope when moving an active subtree', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const originalScope = { teamId: 'team-1', projectId: 'project-1' }
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-active', 'portfolio', 0, originalScope),
      EMPTY_WORK_ITEMS,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-archived', 'roadmap', 1, {
        ...originalScope,
        parentId: 'portfolio-active',
      }),
      EMPTY_WORK_ITEMS,
    )
    await client.archive(
      'workspace-1',
      'roadmap-archived',
      { expectedRevision: 2 },
      EMPTY_WORK_ITEMS,
    )

    const response = await client.move('workspace-1', 'portfolio-active', {
      teamId: 'team-1',
      projectId: 'project-2',
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)

    expect(getEntity(response.planning.entities, 'portfolio-active').projectId).toBe('project-2')
    expect(getEntity(response.planning.entities, 'roadmap-archived').projectId).toBe('project-1')
  })
})

describe('planning persistence', () => {
  test('writes META revision CAS and changed rows in one DynamoDB transaction', async () => {
    const commands: Array<{
      /** AWS SDK command class name. */
      name: string
      /** AWS SDK command input. */
      input: Record<string, unknown>
    }> = []
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        commands.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    const response = await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )

    expect(response.planning.revision).toBe(1)
    expect(commands.map((command) => command.name)).toEqual([
      'GetCommand',
      'QueryCommand',
      'GetCommand',
      'TransactWriteCommand',
    ])
    const transaction = commands.at(-1)?.input.TransactItems as Array<{
      /** DynamoDB Put operation. */
      Put: {
        /** Row written by the operation. */
        Item: Record<string, unknown>
        /** Optional optimistic concurrency expression. */
        ConditionExpression?: string
      }
    }>
    expect(transaction).toHaveLength(2)
    expect(transaction[0]?.Put).toMatchObject({
      Item: {
        workspaceId: 'workspace-1',
        recordKey: 'META',
        revision: 1,
      },
      ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    })
    expect(transaction[1]?.Put.Item).toMatchObject({
      workspaceId: 'workspace-1',
      recordKey: 'ENTITY#portfolio-1',
      id: 'portfolio-1',
    })
  })

  test('condition-checks canonical Work Item revision in link transactions', async () => {
    let transaction: Record<string, unknown> | undefined
    const storedCycle = createStoredCycle('cycle-1')
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        if (command.constructor.name === 'QueryCommand') return { Items: [storedCycle] }
        transaction = command.input
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
      'WorkItemsTable',
    )

    await expect(client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-1',
      projectId: 'project-1',
      cycleId: 'cycle-1',
      goalIds: [],
      expectedRevision: 1,
    }, {
      workItems: [{ ...createWorkItem('work-1', 'unstarted'), revision: 7 }],
    })).rejects.toMatchObject({ status: 409, code: 'PlanningWorkItemChanged' })

    expect(transaction?.TransactItems).toEqual([
      expect.objectContaining({ Put: expect.any(Object) }),
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkItemsTable',
          Key: {
            directoryTeamId: 'workspace-1#team#team-1',
            issueId: 'work-1',
          },
          ExpressionAttributeValues: { ':expectedRevision': 7 },
        }),
      },
      expect.objectContaining({ Put: expect.any(Object) }),
    ])
  })

  test('condition-checks completed Work Item revisions when archiving a Cycle', async () => {
    let transaction: Record<string, unknown> | undefined
    const storedCycle = createStoredCycle('cycle-1')
    const storedLink = {
      workspaceId: 'workspace-1',
      recordKey: 'LINK#team-1#work-1',
      entryType: 'planning-work-item-link',
      teamId: 'team-1',
      workItemId: 'work-1',
      projectId: 'project-1',
      cycleId: 'cycle-1',
      goalIds: [],
      createdAt: NOW.toISOString(),
    }
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        if (command.constructor.name === 'QueryCommand') return { Items: [storedCycle, storedLink] }
        transaction = command.input
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
      'WorkItemsTable',
    )

    await expect(client.archive(
      'workspace-1',
      'cycle-1',
      { expectedRevision: 1 },
      { workItems: [{ ...createWorkItem('work-1', 'completed'), revision: 7 }] },
    )).rejects.toMatchObject({ status: 409, code: 'PlanningWorkItemChanged' })

    expect(transaction?.TransactItems).toEqual([
      expect.objectContaining({ Put: expect.any(Object) }),
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkItemsTable',
          Key: {
            directoryTeamId: 'workspace-1#team#team-1',
            issueId: 'work-1',
          },
          ExpressionAttributeValues: { ':expectedRevision': 7 },
        }),
      },
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            recordKey: 'ENTITY#cycle-1',
            archivedAt: NOW.toISOString(),
          }),
        }),
      }),
    ])
  })

  test('rejects an oversized mutation response before committing it', async () => {
    let transactionCalls = 0
    const statusUpdates = Array.from({ length: 32 }, (_, index) => ({
      id: `status-${index}`,
      message: 'x'.repeat(8_000),
      authorMemberKey: 'owner@example.com',
      createdAt: NOW.toISOString(),
    }))
    const storedEntities = Array.from({ length: 16 }, (_, index) => ({
      workspaceId: 'workspace-1',
      recordKey: `ENTITY#portfolio-${index}`,
      entryType: 'planning-entity',
      id: `portfolio-${index}`,
      type: 'portfolio',
      title: `Portfolio ${index}`,
      description: 'd'.repeat(20_000),
      ownerMemberKey: 'owner@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'none',
      progressMode: 'automatic',
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
      statusUpdates,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }))
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        if (command.constructor.name === 'QueryCommand') return { Items: storedEntities }
        transactionCalls += 1
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.update('workspace-1', 'portfolio-0', {
      expectedRevision: 1,
      patch: { title: 'Updated portfolio' },
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningSnapshotSizeLimitExceeded',
    })
    expect(transactionCalls).toBe(0)
  })

  test('rejects an oversized changed row before committing it', async () => {
    let transactionCalls = 0
    const storedEntity = createOversizedStoredEntity('portfolio-large')
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        if (command.constructor.name === 'QueryCommand') return { Items: [storedEntity] }
        transactionCalls += 1
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.update('workspace-1', 'portfolio-large', {
      expectedRevision: 1,
      patch: { title: 'Updated portfolio' },
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningRowSizeLimitExceeded',
    })
    expect(transactionCalls).toBe(0)
  })

  test('does not revalidate an oversized unchanged row during another mutation', async () => {
    let transaction: Record<string, unknown> | undefined
    const storedLargeEntity = createOversizedStoredEntity('portfolio-large')
    const storedSmallEntity = {
      ...createOversizedStoredEntity('portfolio-small'),
      description: undefined,
      statusUpdates: [],
    }
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        if (command.constructor.name === 'QueryCommand') {
          return { Items: [storedLargeEntity, storedSmallEntity] }
        }
        transaction = command.input
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    const response = await client.update('workspace-1', 'portfolio-small', {
      expectedRevision: 1,
      patch: { title: 'Updated small portfolio' },
    }, EMPTY_WORK_ITEMS)

    expect(response.planning.revision).toBe(2)
    const transactionItems = transaction?.TransactItems as Array<{
      /** DynamoDB Put operation. */
      Put?: { Item: Record<string, unknown> }
    }>
    expect(transactionItems.map((item) => item.Put?.Item.recordKey)).toEqual([
      'META',
      'ENTITY#portfolio-small',
    ])
  })

  test('rejects a mutation that would make a Workspace unreadable', async () => {
    let transactionCalls = 0
    const storedAtLimit = [
      {
        workspaceId: 'workspace-1',
        recordKey: 'META',
        entryType: 'planning-meta',
        schemaVersion: 1,
        revision: 1,
        updatedAt: NOW.toISOString(),
      },
      ...Array.from({ length: 1_999 }, (_, index) => ({
        workspaceId: 'workspace-1',
        recordKey: `ENTITY#portfolio-${index}`,
        entryType: 'planning-entity',
        id: `portfolio-${index}`,
        type: 'portfolio',
        title: `Portfolio ${index}`,
        ownerMemberKey: 'owner@example.com',
        status: 'planned',
        health: 'on-track',
        risk: 'none',
        progressMode: 'automatic',
        baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
        forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
        statusUpdates: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })),
    ]
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
      }) {
        if (command.constructor.name === 'GetCommand') {
          return { Item: storedAtLimit[0] }
        }
        if (command.constructor.name === 'QueryCommand') {
          return { Items: storedAtLimit }
        }
        transactionCalls += 1
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.create(
      'workspace-1',
      createEntityInput('portfolio-over-limit', 'portfolio', 1),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 413, code: 'PlanningReadLimitExceeded' })
    expect(transactionCalls).toBe(0)
  })

  test('rejects a multibyte identifier that exceeds the DynamoDB record key limit', async () => {
    let transactionCalls = 0
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
      }) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        if (command.constructor.name === 'TransactWriteCommand') transactionCalls += 1
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.create(
      'workspace-1',
      createEntityInput('😀'.repeat(100), 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningRecordKeyInvalid' })
    expect(transactionCalls).toBe(0)
  })

  test('fails closed on malformed stored status history', async () => {
    const storedEntity = {
      workspaceId: 'workspace-1',
      recordKey: 'ENTITY#portfolio-1',
      entryType: 'planning-entity',
      id: 'portfolio-1',
      type: 'portfolio',
      title: 'Portfolio',
      ownerMemberKey: 'owner@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'none',
      progressMode: 'automatic',
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
      statusUpdates: 'invalid',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
      }) {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
              entryType: 'planning-meta',
              schemaVersion: 1,
              revision: 1,
              updatedAt: NOW.toISOString(),
            },
          }
        }
        return { Items: [storedEntity] }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.get('workspace-1', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 503,
      code: 'InvalidPlanningData',
      message: 'Stored Planning data is invalid.',
    })
  })

  test('distinguishes revision cancellation from DynamoDB infrastructure failure', async () => {
    for (const scenario of [
      {
        reasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        status: 409,
        code: 'PlanningRevisionConflict',
      },
      {
        reasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        status: 503,
        code: 'TransactionCanceledException',
      },
    ]) {
      const documentClient = {
        async send(command: {
          /** AWS SDK command constructor. */
          constructor: { name: string }
        }) {
          if (command.constructor.name === 'QueryCommand') return { Items: [] }
          if (command.constructor.name === 'TransactWriteCommand') {
            throw {
              name: 'TransactionCanceledException',
              CancellationReasons: scenario.reasons,
            }
          }
          return {}
        },
      } as unknown as DynamoDBDocumentClient
      const client = new DynamoDbPlanningClient(
        'PlanningTable',
        documentClient,
        {} as DynamoDBClient,
        false,
        () => NOW,
      )

      await expect(client.create(
        'workspace-1',
        createEntityInput('portfolio-1', 'portfolio', 0),
        EMPTY_WORK_ITEMS,
      )).rejects.toMatchObject({ status: scenario.status, code: scenario.code })
    }
  })
})
