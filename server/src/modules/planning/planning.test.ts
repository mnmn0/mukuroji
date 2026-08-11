import { describe, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  CreatePlanningEntityInput,
  PlanningEntity,
  PlanningEntityType,
  PlanningUpdateCadence,
  PlanningUpdateTarget,
  PlanningWorkItemSummary,
  PublishPlanningUpdateInput,
  UpdatePlanningEntityInput,
  WorkItemSchedule,
  WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import {
  PLANNING_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
  PLANNING_STORAGE_SCHEMA_VERSION,
  PlanningError,
  createPlanningWorkItemDependencySummary,
  requirePlanningWorkItemHasNoScheduleDependencies,
  type PlanningCallerAuthorizationConditionCheck,
  type PlanningMutationTransaction,
  type PlanningWorkItemState,
} from './planning'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
} from './planning-update-schedule-index'

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

/**
 * Creates one complete human-authored structured update input.
 *
 * @param expectedRevision - Planning revision observed by the caller.
 * @param overrides - Structured fields replaced for the scenario.
 * @returns Publish input for the default Project target.
 */
function createPlanningUpdateInput(
  expectedRevision: number,
  overrides: Partial<PublishPlanningUpdateInput> = {},
): PublishPlanningUpdateInput {
  return {
    target: { type: 'project', teamId: 'team-1', projectId: 'project-1' },
    id: `update-${expectedRevision}`,
    health: 'on-track',
    risk: 'none',
    summary: 'Delivery remains on plan.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: 'Ship the next increment.',
    evidence: [],
    expectedRevision,
    ...overrides,
  }
}

function getEntity(entities: readonly PlanningEntity[], id: string) {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Planning entity "${id}" was not returned.`)
  return entity
}

/**
 * Creates a canonical Work Item summary for Planning domain tests.
 *
 * @param id - Team-local Work Item identifier.
 * @param statusCategory - Canonical workflow status category.
 * @param overrides - Fields replaced for the scenario under test.
 * @returns A complete Planning Work Item summary.
 */
function createWorkItem(
  id: string,
  statusCategory: PlanningWorkItemSummary['statusCategory'],
  overrides: Partial<PlanningWorkItemSummary> = {},
): PlanningWorkItemSummary {
  return {
    id,
    revision: 1,
    teamId: 'team-1',
    title: id,
    projectId: 'project-1',
    statusCategory,
    dueDate: '2026-08-31',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    ...overrides,
  }
}

/**
 * Applies the record-key prefix used by a mocked DynamoDB Query command.
 *
 * @param input - AWS SDK Query input captured by the test double.
 * @param rows - Complete physical rows available to the fake table.
 * @returns Rows whose sort keys match the requested prefix.
 */
function rowsForPlanningRecordPrefixQuery(
  input: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
) {
  const values = input.ExpressionAttributeValues
  if (
    typeof values !== 'object' || values === null ||
    !(':recordPrefix' in values) || typeof values[':recordPrefix'] !== 'string'
  ) return []
  const recordPrefix = values[':recordPrefix']
  return rows.filter((row) =>
    typeof row.recordKey === 'string' && row.recordKey.startsWith(recordPrefix)
  )
}

/**
 * Creates an inclusive date-range schedule for dependency graph tests.
 *
 * @param startDate - Inclusive local start date.
 * @param endDate - Inclusive local finish date.
 * @returns A canonical date-range schedule using the default calendar policy.
 */
function createDateRangeSchedule(startDate: string, endDate: string): WorkItemSchedule {
  const calendarPolicy = createDefaultDueDateWorkItemSchedule(endDate).calendarPolicy
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  return {
    mode: 'date-range',
    startDate,
    endDate,
    durationDays: Math.floor((end - start) / 86_400_000) + 1,
    calendarPolicy,
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
    expect(await client.getAuthorizationRevision('workspace-1')).toBe(1)
    expect(await client.getAuthorizationState('workspace-1')).toMatchObject({
      revision: 1,
      entities: [{
        id: 'portfolio-1',
        type: 'portfolio',
      }],
    })

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

  test('uses inclusive finish arithmetic for a binding start-to-finish dependency', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createCycleInput('sf-predecessor', 0, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('sf-successor', 1, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
    }), EMPTY_WORK_ITEMS)

    const response = await client.createDependency('workspace-1', {
      id: 'dependency-sf',
      predecessorId: 'sf-predecessor',
      successorId: 'sf-successor',
      type: 'start-to-finish',
      lagDays: 5,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)

    expect(response.planning.criticalPath).toEqual({
      entityIds: ['sf-predecessor', 'sf-successor'],
      totalDurationDays: 6,
      slackByEntityId: {
        'sf-predecessor': 0,
        'sf-successor': 0,
      },
    })
  })

  test('enforces Planning dependency constraints across creation and forecast updates', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createCycleInput('constraint-predecessor', 0, {
      baseline: { startDate: '2026-08-01', endDate: '2026-08-02' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-02' },
    }), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createCycleInput('constraint-successor', 1, {
      baseline: { startDate: '2026-08-03', endDate: '2026-08-05' },
      forecast: { startDate: '2026-08-03', endDate: '2026-08-05' },
    }), EMPTY_WORK_ITEMS)

    await expect(client.createDependency('workspace-1', {
      id: 'invalid-successor-constraint',
      predecessorId: 'constraint-predecessor',
      successorId: 'constraint-successor',
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'start', kind: 'not-before', date: '2026-08-04' },
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningDependencyConstraintViolation',
    })

    await client.createDependency('workspace-1', {
      id: 'valid-successor-constraint',
      predecessorId: 'constraint-predecessor',
      successorId: 'constraint-successor',
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'start', kind: 'not-before', date: '2026-08-03' },
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)

    await expect(client.update('workspace-1', 'constraint-successor', {
      expectedRevision: 3,
      patch: {
        forecast: { startDate: '2026-08-02', endDate: '2026-08-05' },
      },
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningDependencyConstraintViolation',
    })
  })

  test('manages canonical cross-Team Work Item dependencies and derived summary', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'started', {
          teamId: 'team-a',
          projectId: 'shared-project',
          dueDate: '2026-08-03',
          schedule: createDateRangeSchedule('2026-08-01', '2026-08-03'),
        }),
        createWorkItem('work-b', 'unstarted', {
          teamId: 'team-b',
          projectId: 'shared-project',
          dueDate: '2026-08-06',
          schedule: createDateRangeSchedule('2026-08-05', '2026-08-06'),
        }),
        createWorkItem('work-c', 'completed', {
          teamId: 'team-b',
          projectId: 'shared-project',
          dueDate: '2026-08-08',
          schedule: {
            mode: 'milestone',
            startDate: '2026-08-08',
            endDate: '2026-08-08',
            durationDays: 0,
            calendarPolicy: createDefaultDueDateWorkItemSchedule('2026-08-08').calendarPolicy,
          },
        }),
      ],
    }

    await client.createWorkItemDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-start',
      lagDays: -1,
      constraint: { anchor: 'finish', kind: 'not-after', date: '2026-08-06' },
      expectedRevision: 0,
    }, workItemState)
    const authorizationState = await client.getAuthorizationState('workspace-1')
    expect(() => requirePlanningWorkItemHasNoScheduleDependencies(
      authorizationState.workItemDependencies,
      'team-a',
      'work-a',
    )).toThrow('Remove all incoming and outgoing schedule dependencies')
    expect(() => requirePlanningWorkItemHasNoScheduleDependencies(
      authorizationState.workItemDependencies,
      'team-c',
      'unrelated',
    )).not.toThrow()
    await client.updateWorkItemDependency('workspace-1', 'dependency-a-b', {
      expectedRevision: 1,
      patch: { type: 'start-to-finish', lagDays: 5 },
    }, workItemState)
    const response = await client.createWorkItemDependency('workspace-1', {
      id: 'dependency-b-c',
      predecessor: { teamId: 'team-b', workItemId: 'work-b' },
      successor: { teamId: 'team-b', workItemId: 'work-c' },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, workItemState)

    expect(response.planning.schemaVersion).toBe(PLANNING_SCHEMA_VERSION)
    expect(response.planning.workItemDependencies).toEqual([
      expect.objectContaining({
        id: 'dependency-a-b',
        type: 'start-to-finish',
        lagDays: 5,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }),
      expect.objectContaining({ id: 'dependency-b-c' }),
    ])
    expect(response.planning.workItemDependencySummary).toEqual({
      criticalPath: {
        workItems: [
          { teamId: 'team-a', workItemId: 'work-a' },
          { teamId: 'team-b', workItemId: 'work-b' },
          { teamId: 'team-b', workItemId: 'work-c' },
        ],
        totalDurationDays: 6,
        slackByWorkItemKey: {
          'team-a/work-a': 0,
          'team-b/work-b': 0,
          'team-b/work-c': 0,
        },
      },
      conflicts: [],
      unresolvedBlockerCount: 2,
      affectedProjects: [
        { teamId: 'team-a', projectId: 'shared-project' },
        { teamId: 'team-b', projectId: 'shared-project' },
      ],
      affectedProjectIds: ['shared-project'],
      affectedMilestoneIds: [],
    })

    const partiallyVisible = await client.get('workspace-1', {
      workItems: workItemState.workItems.slice(0, 2),
    })
    expect(partiallyVisible.workItemDependencies.map((dependency) => dependency.id)).toEqual([
      'dependency-a-b',
    ])
    expect(partiallyVisible.workItemDependencySummary.criticalPath.workItems).toEqual([
      { teamId: 'team-a', workItemId: 'work-a' },
      { teamId: 'team-b', workItemId: 'work-b' },
    ])

    const hidden = await client.get('workspace-1', {
      workItems: workItemState.workItems.slice(0, 1),
    })
    expect(hidden.workItemDependencies).toEqual([])
    expect(hidden.workItemDependencySummary).toEqual({
      criticalPath: { workItems: [], totalDurationDays: 0, slackByWorkItemKey: {} },
      conflicts: [],
      unresolvedBlockerCount: 0,
      affectedProjects: [],
      affectedProjectIds: [],
      affectedMilestoneIds: [],
    })

    const deleted = await client.deleteWorkItemDependency(
      'workspace-1',
      'dependency-a-b',
      { expectedRevision: 3 },
      workItemState,
    )
    expect(deleted.planning.workItemDependencies.map((dependency) => dependency.id)).toEqual([
      'dependency-b-c',
    ])
  })

  test('prepares minimal durable results for Work Item dependency mutations', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'unstarted', {
          teamId: 'team-a',
          dueDate: '2026-08-03',
          schedule: createDefaultDueDateWorkItemSchedule('2026-08-03'),
        }),
        createWorkItem('work-b', 'unstarted', {
          teamId: 'team-b',
          dueDate: '2026-08-06',
          schedule: createDefaultDueDateWorkItemSchedule('2026-08-06'),
        }),
      ],
    }
    const preparedResults: unknown[] = []
    const transaction = {
      async prepare(result) {
        preparedResults.push(structuredClone(result))
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { workspaceId: 'workspace-1', recordKey: `RECEIPT#${result.revision}` },
              ConditionExpression: 'attribute_not_exists(workspaceId)',
            },
          },
        }
      },
    } satisfies PlanningMutationTransaction

    await client.createWorkItemDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: 0,
    }, workItemState, [], transaction)
    await client.updateWorkItemDependency('workspace-1', 'dependency-a-b', {
      expectedRevision: 1,
      patch: { lagDays: 2 },
    }, workItemState, [], transaction)
    await client.deleteWorkItemDependency(
      'workspace-1',
      'dependency-a-b',
      { expectedRevision: 2 },
      workItemState,
      [],
      transaction,
    )

    const createdDependency = {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }
    const updatedDependency = {
      ...createdDependency,
      lagDays: 2,
    }
    expect(preparedResults).toEqual([
      { kind: 'upsert', revision: 1, dependency: createdDependency },
      { kind: 'upsert', revision: 2, dependency: updatedDependency },
      { kind: 'delete', revision: 3, dependency: updatedDependency },
    ])
  })

  test('fails closed before an in-memory dependency mutation when receipt preparation is unavailable', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'unstarted', { teamId: 'team-a' }),
        createWorkItem('work-b', 'unstarted', { teamId: 'team-b' }),
      ],
    }
    const transaction = {
      async prepare() {
        return undefined
      },
    } satisfies PlanningMutationTransaction

    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: 0,
    }, workItemState, [], transaction)).rejects.toMatchObject({
      status: 503,
      code: 'PlanningIdempotencyUnavailable',
    })
    expect(await client.getAuthorizationRevision('workspace-1')).toBe(0)
  })

  test('preserves a classified Planning receipt preparation error', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'unstarted', { teamId: 'team-a' }),
        createWorkItem('work-b', 'unstarted', { teamId: 'team-b' }),
      ],
    }
    const transaction = {
      async prepare() {
        throw new PlanningError(
          409,
          'PlanningIdempotencyConflict',
          'The idempotency key belongs to a different dependency mutation.',
        )
      },
    } satisfies PlanningMutationTransaction

    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: 0,
    }, workItemState, [], transaction)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningIdempotencyConflict',
    })
    expect(await client.getAuthorizationRevision('workspace-1')).toBe(0)
  })

  test('keeps critical-path slack keys distinct when endpoint IDs contain slashes', () => {
    const workItems = [
      createWorkItem('c', 'started', {
        teamId: 'a/b',
        schedule: createDateRangeSchedule('2026-08-01', '2026-08-01'),
      }),
      createWorkItem('b/c', 'started', {
        teamId: 'a',
        schedule: createDateRangeSchedule('2026-08-01', '2026-08-01'),
      }),
      createWorkItem('successor-one', 'unstarted', {
        teamId: 'team-one',
        schedule: createDateRangeSchedule('2026-08-02', '2026-08-02'),
      }),
      createWorkItem('successor-two', 'unstarted', {
        teamId: 'team-two',
        schedule: createDateRangeSchedule('2026-08-02', '2026-08-02'),
      }),
    ]
    const dependencies: WorkItemScheduleDependency[] = [
      {
        id: 'dependency-one',
        predecessor: { teamId: 'a/b', workItemId: 'c' },
        successor: { teamId: 'team-one', workItemId: 'successor-one' },
        type: 'finish-to-start',
        lagDays: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'dependency-two',
        predecessor: { teamId: 'a', workItemId: 'b/c' },
        successor: { teamId: 'team-two', workItemId: 'successor-two' },
        type: 'finish-to-start',
        lagDays: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]

    const summary = createPlanningWorkItemDependencySummary(dependencies, workItems, [])

    expect(summary.criticalPath.slackByWorkItemKey).toEqual({
      'a%2Fb/c': 0,
      'a/b%2Fc': 0,
      'team-one/successor-one': 0,
      'team-two/successor-two': 0,
    })
  })

  test('rejects self, duplicate, cycle, and invalid Work Item dependency fields', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('shared', 'unstarted', {
          teamId: 'team-a',
          dueDate: '2026-08-02',
          schedule: createDateRangeSchedule('2026-08-01', '2026-08-02'),
        }),
        createWorkItem('shared', 'unstarted', {
          teamId: 'team-b',
          dueDate: '2026-08-02',
          schedule: createDateRangeSchedule('2026-08-01', '2026-08-02'),
        }),
      ],
    }

    await client.createWorkItemDependency('workspace-1', {
      id: 'cross-team',
      predecessor: { teamId: 'team-a', workItemId: 'shared' },
      successor: { teamId: 'team-b', workItemId: 'shared' },
      type: 'start-to-finish',
      lagDays: -2,
      expectedRevision: 0,
    }, workItemState)
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'duplicate',
      predecessor: { teamId: 'team-a', workItemId: 'shared' },
      successor: { teamId: 'team-b', workItemId: 'shared' },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyDuplicate',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'self',
      predecessor: { teamId: 'team-a', workItemId: 'shared' },
      successor: { teamId: 'team-a', workItemId: 'shared' },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningWorkItemDependencySelf',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'cycle',
      predecessor: { teamId: 'team-b', workItemId: 'shared' },
      successor: { teamId: 'team-a', workItemId: 'shared' },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyCycle',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'invalid-lag',
      predecessor: { teamId: 'team-b', workItemId: 'shared' },
      successor: { teamId: 'team-a', workItemId: 'shared' },
      type: 'finish-to-start',
      lagDays: 36_601,
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningDependencyLagInvalid',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'invalid-constraint',
      predecessor: { teamId: 'team-b', workItemId: 'shared' },
      successor: { teamId: 'team-a', workItemId: 'shared' },
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'start', kind: 'on', date: '2026-02-30' },
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({ status: 400 })
    await expect(client.updateWorkItemDependency('workspace-1', 'cross-team', {
      expectedRevision: 1,
      patch: {},
    }, workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningWorkItemDependencyPatchInvalid',
    })
  })

  test('rejects candidate schedule conflicts while reporting conflicts caused by later drift', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('predecessor', 'started', {
          teamId: 'team-a',
          dueDate: '2026-08-03',
          schedule: createDateRangeSchedule('2026-08-01', '2026-08-03'),
        }),
        createWorkItem('successor', 'unstarted', {
          teamId: 'team-b',
          dueDate: '2026-08-06',
          schedule: createDateRangeSchedule('2026-08-05', '2026-08-06'),
        }),
      ],
    }
    const endpoints = {
      predecessor: { teamId: 'team-a', workItemId: 'predecessor' },
      successor: { teamId: 'team-b', workItemId: 'successor' },
    }

    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'dependency-violation',
      ...endpoints,
      type: 'finish-to-start',
      lagDays: 2,
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyConflict',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'constraint-violation',
      ...endpoints,
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'finish', kind: 'not-after', date: '2026-08-05' },
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyConflict',
    })

    await client.createWorkItemDependency('workspace-1', {
      id: 'valid-dependency',
      ...endpoints,
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'finish', kind: 'not-after', date: '2026-08-06' },
      expectedRevision: 0,
    }, workItemState)
    await expect(client.updateWorkItemDependency('workspace-1', 'valid-dependency', {
      expectedRevision: 1,
      patch: { lagDays: 2 },
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyConflict',
    })

    const unchanged = await client.get('workspace-1', workItemState)
    expect(unchanged.revision).toBe(1)
    expect(unchanged.workItemDependencies).toEqual([
      expect.objectContaining({ id: 'valid-dependency', lagDays: 0 }),
    ])

    const drifted = await client.get('workspace-1', {
      workItems: workItemState.workItems.map((workItem) =>
        workItem.id === 'predecessor'
          ? {
              ...workItem,
              dueDate: '2026-08-06',
              schedule: createDateRangeSchedule('2026-08-04', '2026-08-06'),
            }
          : workItem
      ),
    })
    expect(drifted.workItemDependencySummary.conflicts).toEqual([{
      code: 'dependency-violation',
      dependencyId: 'valid-dependency',
      workItem: { teamId: 'team-b', workItemId: 'successor' },
      requiredDate: '2026-08-07',
      actualDate: '2026-08-05',
    }])
  })

  test('rejects dependencies whose lead or lag leaves the supported schedule date range', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('maximum-predecessor', 'started', {
          teamId: 'maximum-team',
          dueDate: '9999-12-31',
          schedule: createDateRangeSchedule('9999-12-31', '9999-12-31'),
        }),
        createWorkItem('maximum-successor', 'unstarted', {
          teamId: 'maximum-team',
          dueDate: '9999-12-31',
          schedule: createDateRangeSchedule('9999-12-31', '9999-12-31'),
        }),
        createWorkItem('minimum-predecessor', 'started', {
          teamId: 'minimum-team',
          dueDate: '1000-01-01',
          schedule: createDateRangeSchedule('1000-01-01', '1000-01-01'),
        }),
        createWorkItem('minimum-successor', 'unstarted', {
          teamId: 'minimum-team',
          dueDate: '1000-01-01',
          schedule: createDateRangeSchedule('1000-01-01', '1000-01-01'),
        }),
      ],
    }

    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'overflowing-fs',
      predecessor: { teamId: 'maximum-team', workItemId: 'maximum-predecessor' },
      successor: { teamId: 'maximum-team', workItemId: 'maximum-successor' },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyConflict',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'underflowing-ss',
      predecessor: { teamId: 'minimum-team', workItemId: 'minimum-predecessor' },
      successor: { teamId: 'minimum-team', workItemId: 'minimum-successor' },
      type: 'start-to-start',
      lagDays: -1,
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningWorkItemDependencyConflict',
    })
    await expect(client.createWorkItemDependency('workspace-1', {
      id: 'underflowing-constraint',
      predecessor: { teamId: 'minimum-team', workItemId: 'minimum-predecessor' },
      successor: { teamId: 'minimum-team', workItemId: 'minimum-successor' },
      type: 'start-to-start',
      lagDays: 0,
      constraint: {
        anchor: 'start',
        kind: 'not-before',
        date: '0999-12-31',
      },
      expectedRevision: 0,
    }, workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningDependencyConstraintInvalid',
    })

    expect((await client.get('workspace-1', workItemState)).workItemDependencies).toEqual([])
  })

  test('does not infer due-date starts for dependency conflict checks', () => {
    const dueDateItems = ['due-predecessor-ss', 'due-predecessor-sf', 'due-successor-fs',
      'due-successor-ss'].map((id) => createWorkItem(id, 'unstarted', {
        teamId: 'team-due',
        dueDate: '2026-08-10',
        schedule: createDefaultDueDateWorkItemSchedule('2026-08-10'),
      }))
    const rangedItems = ['range-successor-ss', 'range-successor-sf', 'range-predecessor-fs',
      'range-predecessor-ss'].map((id) => createWorkItem(id, 'unstarted', {
        teamId: 'team-range',
        dueDate: '2026-08-12',
        schedule: createDateRangeSchedule('2026-08-11', '2026-08-12'),
      }))
    const dependencyDefinitions: Array<Pick<
      WorkItemScheduleDependency,
      'id' | 'predecessor' | 'successor' | 'type'
    >> = [
      {
        id: 'ss-predecessor',
        predecessor: { teamId: 'team-due', workItemId: 'due-predecessor-ss' },
        successor: { teamId: 'team-range', workItemId: 'range-successor-ss' },
        type: 'start-to-start',
      },
      {
        id: 'sf-predecessor',
        predecessor: { teamId: 'team-due', workItemId: 'due-predecessor-sf' },
        successor: { teamId: 'team-range', workItemId: 'range-successor-sf' },
        type: 'start-to-finish',
      },
      {
        id: 'fs-successor',
        predecessor: { teamId: 'team-range', workItemId: 'range-predecessor-fs' },
        successor: { teamId: 'team-due', workItemId: 'due-successor-fs' },
        type: 'finish-to-start',
      },
      {
        id: 'ss-successor',
        predecessor: { teamId: 'team-range', workItemId: 'range-predecessor-ss' },
        successor: { teamId: 'team-due', workItemId: 'due-successor-ss' },
        type: 'start-to-start',
      },
    ]
    const dependencies = dependencyDefinitions.map((dependency) => ({
      ...dependency,
      lagDays: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }))

    const summary = createPlanningWorkItemDependencySummary(
      dependencies,
      [...dueDateItems, ...rangedItems],
      [],
    )

    expect(summary.conflicts).toHaveLength(4)
    expect(summary.conflicts.map((conflict) => [conflict.dependencyId, conflict.code])).toEqual([
      ['fs-successor', 'missing-schedule'],
      ['sf-predecessor', 'missing-schedule'],
      ['ss-predecessor', 'missing-schedule'],
      ['ss-successor', 'missing-schedule'],
    ])
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

describe('planning structured updates', () => {
  test('keeps freshness separate from health and advances weekly cadence through DST', async () => {
    let current = new Date('2026-02-28T12:00:00.000Z')
    const client = new InMemoryPlanningClient(() => current)
    const target: PlanningUpdateTarget = {
      type: 'project', teamId: 'team-1', projectId: 'project-1',
    }
    const cadence: PlanningUpdateCadence = {
      updateOwnerMemberKey: 'owner@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'America/New_York',
      nextDueAt: '2026-03-01T15:00:00.000Z',
      reminderHoursBefore: 24,
    }

    const configured = await client.configureUpdateCadence('workspace-1', {
      target,
      cadence,
      expectedRevision: 0,
    }, EMPTY_WORK_ITEMS)
    expect(configured.updateTarget.updateState).toBe('missing')

    const first = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'update-1', health: 'off-track' }),
      'AUTHOR@EXAMPLE.COM',
      EMPTY_WORK_ITEMS,
    )
    expect(first.update).toMatchObject({
      version: 1,
      origin: 'manual',
      health: 'off-track',
      authorMemberKey: 'author@example.com',
      coveredDueAt: '2026-03-01T15:00:00.000Z',
    })
    expect(first.planning.updateTargets[0]).toMatchObject({
      updateState: 'current',
      cadence: { nextDueAt: '2026-03-08T14:00:00.000Z' },
      latestUpdate: { health: 'off-track' },
    })

    current = new Date('2026-03-07T14:00:00.000Z')
    expect((await client.get('workspace-1', EMPTY_WORK_ITEMS)).updateTargets[0]?.updateState)
      .toBe('stale')
    current = new Date('2026-03-08T14:00:00.000Z')
    expect((await client.get('workspace-1', EMPTY_WORK_ITEMS)).updateTargets[0]?.updateState)
      .toBe('overdue')

    await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(2, { target, id: 'update-2', health: 'on-track' }),
      'author@example.com',
      EMPTY_WORK_ITEMS,
    )
    const firstPage = await client.listUpdates('workspace-1', { target, limit: 1 })
    expect(firstPage.updates.map((update) => update.version)).toEqual([2])
    expect(firstPage.nextCursor).toBeString()
    const secondPage = await client.listUpdates('workspace-1', {
      target,
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.updates.map((update) => update.version)).toEqual([1])
    expect(secondPage.nextCursor).toBeUndefined()
  })

  test('retains the original monthly day across shorter calendar months', async () => {
    for (const scenario of [
      {
        initialDueAt: '2027-01-31T09:00:00.000Z',
        februaryDueAt: '2027-02-28T09:00:00.000Z',
        marchDueAt: '2027-03-31T09:00:00.000Z',
      },
      {
        initialDueAt: '2027-01-30T09:00:00.000Z',
        februaryDueAt: '2027-02-28T09:00:00.000Z',
        marchDueAt: '2027-03-30T09:00:00.000Z',
      },
    ]) {
      let current = new Date('2027-01-01T09:00:00.000Z')
      const client = new InMemoryPlanningClient(() => current)
      const target: PlanningUpdateTarget = {
        type: 'project', teamId: 'team-1', projectId: 'project-1',
      }
      await client.configureUpdateCadence('workspace-1', {
        target,
        cadence: {
          updateOwnerMemberKey: 'owner@example.com',
          cadence: { unit: 'month', count: 1 },
          timeZone: 'UTC',
          nextDueAt: scenario.initialDueAt,
          reminderHoursBefore: 0,
        },
        expectedRevision: 0,
      }, EMPTY_WORK_ITEMS)
      const first = await client.publishUpdate(
        'workspace-1',
        createPlanningUpdateInput(1, { target, id: 'update-1' }),
        'owner@example.com',
        EMPTY_WORK_ITEMS,
      )
      expect(first.planning.updateTargets[0]?.cadence?.nextDueAt)
        .toBe(scenario.februaryDueAt)
      current = new Date('2027-02-01T09:00:00.000Z')
      const second = await client.publishUpdate(
        'workspace-1',
        createPlanningUpdateInput(2, { target, id: 'update-2' }),
        'owner@example.com',
        EMPTY_WORK_ITEMS,
      )
      expect(second.planning.updateTargets[0]?.cadence?.nextDueAt)
        .toBe(scenario.marchDueAt)
    }
  })

  test('retains the monthly anchor when editing an already-clamped occurrence', async () => {
    const client = new InMemoryPlanningClient(() => new Date('2027-02-01T09:00:00.000Z'))
    const target: PlanningUpdateTarget = {
      type: 'project', teamId: 'team-1', projectId: 'project-1',
    }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'month', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2027-01-31T09:00:00.000Z',
        reminderHoursBefore: 0,
      },
      expectedRevision: 0,
    }, EMPTY_WORK_ITEMS)
    const first = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'update-1' }),
      'owner@example.com',
      EMPTY_WORK_ITEMS,
    )
    expect(first.planning.updateTargets[0]?.cadence?.nextDueAt)
      .toBe('2027-02-28T09:00:00.000Z')

    const edited = await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'new-owner@example.com',
        cadence: { unit: 'month', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2027-02-28T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    expect(edited.updateTarget.cadence?.nextDueAt).toBe('2027-02-28T09:00:00.000Z')

    const second = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(3, { target, id: 'update-2' }),
      'new-owner@example.com',
      EMPTY_WORK_ITEMS,
    )
    expect(second.planning.updateTargets[0]?.cadence?.nextDueAt)
      .toBe('2027-03-31T09:00:00.000Z')
  })

  test('captures immutable Initiative context and diffs canonical changes', async () => {
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
      createEntityInput('initiative-1', 'initiative', 2, {
        parentId: 'roadmap-1',
        teamId: 'team-1',
        projectId: 'project-1',
        progressMode: 'manual',
        manualProgress: 20,
        forecast: { startDate: '2026-08-01', endDate: '2026-09-01' },
      }),
      EMPTY_WORK_ITEMS,
    )
    const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'initiative-1' }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'month', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-31T09:00:00.000Z',
        reminderHoursBefore: 48,
      },
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)
    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(4, {
      target,
      id: 'initiative-update-invalid-evidence',
      evidence: [{
        type: 'decision',
        decisionId: 'decision-1',
        url: 'http://example.com/decisions/decision-1',
      }],
    }), 'owner@example.com', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      code: 'PlanningUpdateEvidenceInvalid',
    })
    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(4, {
      target,
      id: 'initiative-update-credentialed-evidence',
      evidence: [{
        type: 'file',
        fileId: 'file-1',
        url: 'https://example.com/files/file-1?X-Amz-Signature=secret',
      }],
    }), 'owner@example.com', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      code: 'PlanningUpdateEvidenceInvalid',
    })
    const first = await client.publishUpdate('workspace-1', createPlanningUpdateInput(4, {
      target,
      id: 'initiative-update-1',
      evidence: [
        { type: 'planning-entity', entityId: 'initiative-1' },
        {
          type: 'decision',
          decisionId: 'decision-1',
          url: 'https://example.com/decisions/decision-1',
        },
        {
          type: 'file',
          fileId: 'file-1',
          url: 'https://example.com/files/file-1',
        },
        { type: 'link', url: 'https://example.com/evidence' },
      ],
    }), 'owner@example.com', EMPTY_WORK_ITEMS)
    expect(first.update.evidence).toContainEqual({
      type: 'decision',
      decisionId: 'decision-1',
      url: 'https://example.com/decisions/decision-1',
    })
    expect(first.update.evidence).toContainEqual({
      type: 'file',
      fileId: 'file-1',
      url: 'https://example.com/files/file-1',
    })
    expect(first.update.contextSnapshot).toMatchObject({
      health: 'on-track',
      risk: 'none',
      progress: { percent: 20, linkedWorkItemCount: 0 },
      scope: { teamId: 'team-1', projectId: 'project-1' },
      targetDate: '2026-09-01',
    })

    await client.update('workspace-1', 'initiative-1', {
      expectedRevision: 5,
      patch: {
        manualProgress: 60,
        forecast: { startDate: '2026-08-01', endDate: '2026-10-15' },
      },
    }, EMPTY_WORK_ITEMS)
    const second = await client.publishUpdate('workspace-1', createPlanningUpdateInput(6, {
      target,
      id: 'initiative-update-2',
      health: 'at-risk',
      risk: 'medium',
    }), 'owner@example.com', EMPTY_WORK_ITEMS)
    expect(second.update.changes).toEqual([
      { type: 'health', before: 'on-track', after: 'at-risk' },
      { type: 'risk', before: 'none', after: 'medium' },
      { type: 'progress', before: 20, after: 60 },
      { type: 'target-date', before: '2026-09-01', after: '2026-10-15' },
    ])
    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(7, {
      target,
      id: 'initiative-update-1',
    }), 'owner@example.com', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningUpdateExists',
    })
    const history = await client.listUpdates('workspace-1', { target })
    expect(history.updates).toHaveLength(2)
    expect(history.updates[1]?.contextSnapshot.progress.percent).toBe(20)
  })

  test('bounds a Team Initiative context and evidence to its common visibility envelope', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-visible', 'completed', { projectId: undefined }),
        createWorkItem('work-hidden', 'completed', { projectId: 'project-hidden' }),
      ],
    }
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-1', 'portfolio', 0),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('roadmap-1', 'roadmap', 1, { parentId: 'portfolio-1' }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('initiative-team', 'initiative', 2, {
        parentId: 'roadmap-1',
        teamId: 'team-1',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('phase-visible', 'phase', 3, {
        parentId: 'initiative-team',
        teamId: 'team-1',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('milestone-visible', 'milestone', 4, {
        parentId: 'phase-visible',
        teamId: 'team-1',
        status: 'completed',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('phase-hidden', 'phase', 5, {
        parentId: 'initiative-team',
        teamId: 'team-1',
        projectId: 'project-hidden',
      }),
      workItemState,
    )
    await client.create(
      'workspace-1',
      createEntityInput('milestone-hidden', 'milestone', 6, {
        parentId: 'phase-hidden',
        teamId: 'team-1',
        projectId: 'project-hidden',
      }),
      workItemState,
    )
    await client.createDependency('workspace-1', {
      id: 'dependency-visible',
      predecessorId: 'phase-visible',
      successorId: 'milestone-visible',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 7,
    }, workItemState)
    await client.createDependency('workspace-1', {
      id: 'dependency-hidden',
      predecessorId: 'milestone-visible',
      successorId: 'milestone-hidden',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 8,
    }, workItemState)
    const target: PlanningUpdateTarget = {
      type: 'initiative',
      entityId: 'initiative-team',
    }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 9,
    }, workItemState)

    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(10, {
      target,
      id: 'hidden-entity-evidence',
      evidence: [{ type: 'planning-entity', entityId: 'phase-hidden' }],
    }), 'owner@example.com', workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningUpdateEvidenceInvalid',
    })
    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(10, {
      target,
      id: 'hidden-work-item-evidence',
      evidence: [{ type: 'work-item', teamId: 'team-1', workItemId: 'work-hidden' }],
    }), 'owner@example.com', workItemState)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningUpdateEvidenceInvalid',
    })

    const published = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(10, {
        target,
        id: 'team-update-1',
        evidence: [
          { type: 'planning-entity', entityId: 'milestone-visible' },
          { type: 'work-item', teamId: 'team-1', workItemId: 'work-visible' },
        ],
      }),
      'owner@example.com',
      workItemState,
    )
    expect(published.update.contextSnapshot).toMatchObject({
      scope: { teamId: 'team-1' },
      progress: { percent: 100, linkedWorkItemCount: 0 },
    })
    expect(published.update.contextSnapshot.milestones.map((milestone) => milestone.entityId))
      .toEqual(['milestone-visible'])
    expect(published.update.contextSnapshot.dependencies.map((dependency) => dependency.dependencyId))
      .toEqual(['dependency-visible'])
    expect(JSON.stringify(published.update.contextSnapshot)).not.toContain('hidden')
    expect(published.update.evidence).toEqual([
      { type: 'planning-entity', entityId: 'milestone-visible' },
      { type: 'work-item', teamId: 'team-1', workItemId: 'work-visible' },
    ])
  })

  test('calculates Project progress from every assigned canonical Work Item without Planning links', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const target: PlanningUpdateTarget = {
      type: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    }
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-unstarted', 'unstarted'),
        createWorkItem('work-completed', 'completed'),
        createWorkItem('work-other-project', 'completed', { projectId: 'project-2' }),
        createWorkItem('work-other-team', 'completed', { teamId: 'team-2' }),
      ],
    }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    }, workItemState)

    const published = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'project-update-1' }),
      'owner@example.com',
      workItemState,
    )
    expect(published.planning.workItemLinks).toEqual([])
    expect(published.update.contextSnapshot.progress).toEqual({
      percent: 50,
      linkedWorkItemCount: 2,
    })
    expect(published.update.progressSnapshot).toEqual({
      percent: 50,
      linkedWorkItemCount: 2,
    })
  })

  test('archives an Initiative update target atomically and rejects further publishing', async () => {
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
    const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'initiative-1' }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)

    const archived = await client.archive(
      'workspace-1',
      'initiative-1',
      { expectedRevision: 4 },
      EMPTY_WORK_ITEMS,
    )
    expect(archived.planning.updateTargets[0]?.archivedAt).toBe(NOW.toISOString())
    await expect(client.publishUpdate('workspace-1', createPlanningUpdateInput(5, {
      target,
    }), 'owner@example.com', EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 409,
      code: 'PlanningEntityArchived',
    })
  })

  test('requires escalation hours and member to be configured together', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await expect(client.configureUpdateCadence('workspace-1', {
      target: { type: 'project', teamId: 'team-1', projectId: 'project-1' },
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
        escalationHoursAfter: 12,
      },
      expectedRevision: 0,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 400,
      code: 'PlanningUpdateEscalationInvalid',
    })
  })

  test('stores comments and reactions outside the immutable update body', async () => {
    let current = new Date('2026-07-16T09:00:00.000Z')
    const client = new InMemoryPlanningClient(() => current)
    const target: PlanningUpdateTarget = {
      type: 'project', teamId: 'team-1', projectId: 'project-1',
    }
    await client.configureUpdateCadence('workspace-1', {
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    }, EMPTY_WORK_ITEMS)
    const published = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'update-1' }),
      'owner@example.com',
      EMPTY_WORK_ITEMS,
    )

    await client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 1,
      id: 'comment-1',
      body: 'First observation',
    }, 'member-a@example.com')
    current = new Date('2026-07-16T10:00:00.000Z')
    await client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 1,
      id: 'comment-2',
      body: 'Second observation',
    }, 'member-b@example.com')
    const firstComments = await client.listUpdateComments('workspace-1', {
      target,
      updateVersion: 1,
      limit: 1,
    })
    expect(firstComments.comments.map((comment) => comment.id)).toEqual(['comment-2'])
    if (!firstComments.nextCursor) throw new Error('Expected a second comment page.')
    const secondComments = await client.listUpdateComments('workspace-1', {
      target,
      updateVersion: 1,
      limit: 1,
      cursor: firstComments.nextCursor,
    })
    expect(secondComments.comments.map((comment) => comment.id)).toEqual(['comment-1'])
    current = new Date('2026-07-16T11:00:00.000Z')
    await expect(client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 1,
      id: 'comment-1',
      body: 'Retried later',
    }, 'member-a@example.com')).rejects.toMatchObject({
      status: 409,
      code: 'PlanningUpdateCommentExists',
    })

    await client.addUpdateReaction('workspace-1', {
      target, updateVersion: 1, emoji: '👍',
    }, 'member-a@example.com')
    await client.addUpdateReaction('workspace-1', {
      target, updateVersion: 1, emoji: '👍',
    }, 'member-b@example.com')
    await expect(client.addUpdateReaction('workspace-1', {
      target, updateVersion: 1, emoji: '👍',
    }, 'member-a@example.com')).rejects.toMatchObject({
      status: 409,
      code: 'PlanningUpdateReactionExists',
    })
    await client.removeUpdateReaction('workspace-1', {
      target, updateVersion: 1, emoji: '👍',
    }, 'member-a@example.com')
    const reactions = await client.listUpdateReactions('workspace-1', {
      target,
      updateVersion: 1,
    })
    expect(reactions.reactions).toEqual([
      expect.objectContaining({ emoji: '👍', memberKey: 'member-b@example.com' }),
    ])
    expect(await client.listUpdates('workspace-1', { target })).toMatchObject({
      updates: [published.update],
    })
    await expect(client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 999,
      id: 'missing-comment',
      body: 'No parent',
    }, 'member@example.com')).rejects.toMatchObject({
      status: 404,
      code: 'PlanningUpdateNotFound',
    })
  })
})

describe('planning persistence', () => {
  test('reads the authorization revision from only the strong META row', async () => {
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
        commands.push({
          name: command.constructor.name,
          input: command.input,
        })
        const key = command.input.Key
        if (
          typeof key === 'object' && key !== null &&
          'workspaceId' in key && key.workspaceId !== 'FENCE#workspace-1'
        ) {
          return {}
        }
        return {
          Item: {
            workspaceId: 'FENCE#workspace-1',
            recordKey: 'META',
            entryType: 'planning-meta',
            schemaVersion: 1,
            revision: 7,
            updatedAt: NOW.toISOString(),
          },
        }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    expect(await client.getAuthorizationRevision('workspace-1')).toBe(7)
    expect(commands).toEqual([
      {
        name: 'GetCommand',
        input: expect.objectContaining({
          TableName: 'PlanningTable',
          Key: { workspaceId: 'FENCE#workspace-1', recordKey: 'META' },
          ConsistentRead: true,
        }),
      },
      {
        name: 'GetCommand',
        input: expect.objectContaining({
          TableName: 'PlanningTable',
          Key: { workspaceId: 'workspace-1', recordKey: 'META' },
          ConsistentRead: true,
        }),
      },
    ])
  })

  test('migrates a legacy META row before exposing the isolated revision fence', async () => {
    const commands: Array<{
      /** AWS SDK command class name. */
      name: string
      /** AWS SDK command input. */
      input: Record<string, unknown>
    }> = []
    let fencedMeta: Record<string, unknown> | undefined
    const legacyMeta = {
      workspaceId: 'workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 7,
      updatedAt: NOW.toISOString(),
    }
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        commands.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'GetCommand') {
          const key = command.input.Key
          if (
            typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          ) {
            return { Item: fencedMeta }
          }
          return { Item: legacyMeta }
        }
        if (command.constructor.name === 'TransactWriteCommand') {
          const items = command.input.TransactItems
          if (!Array.isArray(items)) throw new Error('Expected migration transaction items.')
          const put = items.find((item) =>
            typeof item === 'object' && item !== null && 'Put' in item
          )
          if (
            typeof put !== 'object' || put === null ||
            !('Put' in put) || typeof put.Put !== 'object' || put.Put === null ||
            !('Item' in put.Put) || typeof put.Put.Item !== 'object' || put.Put.Item === null
          ) {
            throw new Error('Expected fenced META Put.')
          }
          const item = put.Put.Item
          if (Array.isArray(item)) throw new Error('Expected a fenced META object.')
          fencedMeta = Object.fromEntries(Object.entries(item))
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

    expect(await client.getAuthorizationRevision('workspace-1')).toBe(7)
    expect(fencedMeta).toMatchObject({
      workspaceId: 'FENCE#workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 7,
      updatedAt: NOW.toISOString(),
    })
    expect(commands.map((command) => command.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'TransactWriteCommand',
    ])
    expect(commands[2]?.input.TransactItems).toEqual([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: { workspaceId: 'workspace-1', recordKey: 'META' },
          ConditionExpression:
            '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #revision = :revision',
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }),
      }),
    ])
  })

  test('raises a source-initialized fence to the legacy revision before returning it', async () => {
    const commands: Array<{
      /** AWS SDK command class name. */
      name: string
      /** AWS SDK command input. */
      input: Record<string, unknown>
    }> = []
    const fencedMeta = {
      workspaceId: 'FENCE#workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 2,
      updatedAt: '2026-08-11T00:00:00.000Z',
    }
    const legacyMeta = {
      workspaceId: 'workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 7,
      updatedAt: NOW.toISOString(),
    }
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        commands.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'GetCommand') {
          const key = command.input.Key
          if (
            typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          ) {
            return { Item: fencedMeta }
          }
          return { Item: legacyMeta }
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

    expect(await client.getAuthorizationRevision('workspace-1')).toBe(7)
    expect(commands.map((command) => command.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'TransactWriteCommand',
    ])
    expect(commands[2]?.input.TransactItems).toEqual([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: { workspaceId: 'workspace-1', recordKey: 'META' },
          ExpressionAttributeValues: expect.objectContaining({ ':revision': 7 }),
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: { workspaceId: 'FENCE#workspace-1', recordKey: 'META' },
          UpdateExpression: 'SET #revision = :revision, #updatedAt = :updatedAt',
          ExpressionAttributeValues: expect.objectContaining({
            ':fencedRevision': 2,
            ':revision': 7,
          }),
        }),
      }),
    ])
  })

  test('reads only bounded graph prefixes between strong META barriers', async () => {
    const commands: Array<{
      /** AWS SDK command class name. */
      name: string
      /** AWS SDK command input. */
      input: Record<string, unknown>
    }> = []
    const physicalRows: Record<string, unknown>[] = [
      createStoredCycle('cycle-1'),
      {
        workspaceId: 'workspace-1',
        recordKey: 'UPDATE#PROJECT#team-1#project-1#0000000000000001',
        entryType: 'planning-update',
      },
      {
        workspaceId: 'workspace-1',
        recordKey: 'UPDATE_ID#PROJECT#team-1#project-1#update-1',
        entryType: 'planning-update-id',
      },
      {
        workspaceId: 'workspace-1',
        recordKey: 'UPDATE_COMMENT#PROJECT#team-1#project-1#0000000000000001#comment-1',
        entryType: 'planning-update-comment',
      },
      {
        workspaceId: 'workspace-1',
        recordKey: 'UPDATE_COMMENT_ID#PROJECT#team-1#project-1#0000000000000001#comment-1',
        entryType: 'planning-update-comment-id',
      },
      {
        workspaceId: 'workspace-1',
        recordKey: 'UPDATE_REACTION#PROJECT#team-1#project-1#0000000000000001#reaction-1',
        entryType: 'planning-update-reaction',
      },
    ]
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        commands.push({ name: command.constructor.name, input: command.input })
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
          return { Items: rowsForPlanningRecordPrefixQuery(command.input, physicalRows) }
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

    const snapshot = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(snapshot.entities.map((entity) => entity.id)).toEqual(['cycle-1'])
    expect(commands.map((command) => command.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'GetCommand',
      'GetCommand',
    ])
    const fenceBarriers = commands.filter((command) => {
      if (command.name !== 'GetCommand') return false
      const key = command.input.Key
      return typeof key === 'object' && key !== null &&
        'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
    })
    for (const barrier of fenceBarriers) {
      expect(barrier).toMatchObject({
        name: 'GetCommand',
        input: {
          Key: { workspaceId: 'FENCE#workspace-1', recordKey: 'META' },
          ConsistentRead: true,
        },
      })
    }
    const graphQueries = commands.filter((command) => command.name === 'QueryCommand')
    const graphPrefixes = graphQueries.map((command) => {
      const values = command.input.ExpressionAttributeValues
      if (
        typeof values !== 'object' || values === null ||
        !(':recordPrefix' in values) || typeof values[':recordPrefix'] !== 'string'
      ) throw new Error('Expected a graph record prefix.')
      return values[':recordPrefix']
    })
    expect(graphPrefixes).toEqual([
      'ENTITY#',
      'DEPENDENCY#',
      'WORK_ITEM_DEPENDENCY#',
      'LINK#',
      'UPDATE_TARGET#',
    ])
    expect(graphPrefixes.every((prefix) =>
      !prefix.startsWith('UPDATE#') &&
      !prefix.startsWith('UPDATE_ID#') &&
      !prefix.startsWith('UPDATE_COMMENT#') &&
      !prefix.startsWith('UPDATE_REACTION#')
    )).toBeTrue()
    expect(graphQueries.map((command) => command.input.Limit)).toEqual([
      2_000,
      1_999,
      1_999,
      1_999,
      1_999,
    ])
    for (const command of graphQueries) {
      expect(command.input).toMatchObject({
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ConsistentRead: true,
      })
      expect(command.input).not.toHaveProperty('FilterExpression')
    }
  })

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
      'GetCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'GetCommand',
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
        workspaceId: 'FENCE#workspace-1',
        recordKey: 'META',
        schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
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

  test('uses one global Planning revision fence while publishing an immutable UPDATE row', async () => {
    const target: PlanningUpdateTarget = {
      type: 'project', teamId: 'team-1', projectId: 'project-1',
    }
    const storedTarget = {
      workspaceId: 'workspace-1',
      recordKey: 'UPDATE_TARGET#PROJECT#team-1#project-1',
      entryType: 'planning-update-target',
      target,
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-20T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      latestVersion: 0,
      updatedAt: NOW.toISOString(),
    }
    let transaction: Record<string, unknown> | undefined
    let immutableRow: Record<string, unknown> | undefined
    let rejectSourceRevision = true
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
          return {
            Items: rowsForPlanningRecordPrefixQuery(command.input, [
              storedTarget,
              ...(immutableRow === undefined ? [] : [immutableRow]),
            ]),
          }
        }
        transaction = command.input
        if (rejectSourceRevision) {
          rejectSourceRevision = false
          throw {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'None' },
            ],
          }
        }
        const items = command.input.TransactItems
        if (Array.isArray(items)) {
          for (const item of items) {
            if (
              typeof item === 'object' && item !== null &&
              'Put' in item && typeof item.Put === 'object' && item.Put !== null &&
              'Item' in item.Put && typeof item.Put.Item === 'object' && item.Put.Item !== null &&
              'entryType' in item.Put.Item && item.Put.Item.entryType === 'planning-update'
            ) {
              immutableRow = item.Put.Item
            }
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
      'WorkItemsTable',
    )
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-source', 'started', { revision: 7 }),
        createWorkItem('work-other-project', 'completed', {
          projectId: 'project-2',
          revision: 8,
        }),
        createWorkItem('work-other-team', 'completed', {
          teamId: 'team-2',
          revision: 9,
        }),
      ],
    }

    await expect(client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'update-1' }),
      'owner@example.com',
      workItemState,
    )).rejects.toMatchObject({
      status: 409,
      code: 'PlanningRevisionConflict',
    })
    const response = await client.publishUpdate(
      'workspace-1',
      createPlanningUpdateInput(1, { target, id: 'update-1' }),
      'owner@example.com',
      workItemState,
    )
    expect(response.update.progressSnapshot).toEqual({
      percent: 50,
      linkedWorkItemCount: 1,
    })
    expect(response.planning.updateTargets[0]).not.toHaveProperty('latestContextSnapshot')
    const transactionItems = transaction?.TransactItems as Array<{
      /** DynamoDB Put operation. */
      Put?: {
        /** Row written by the operation. */
        Item: Record<string, unknown>
        /** Optional immutability condition. */
        ConditionExpression?: string
      }
      /** Optional canonical Work Item revision condition. */
      ConditionCheck?: {
        /** Canonical Work Item table. */
        TableName: string
        /** Qualified canonical Work Item key. */
        Key: Record<string, unknown>
        /** Canonical existence and revision condition. */
        ConditionExpression: string
        /** Revision attribute alias. */
        ExpressionAttributeNames: Record<string, unknown>
        /** Expected revision value. */
        ExpressionAttributeValues: Record<string, unknown>
      }
    }>
    expect(transactionItems.map((item) => item.Put?.Item.recordKey)).toEqual([
      'META',
      'UPDATE_TARGET#PROJECT#team-1#project-1',
      'UPDATE_ID#PROJECT#team-1#project-1#update-1',
      'UPDATE#PROJECT#team-1#project-1#0000000000000001',
    ])
    expect(transactionItems.filter((item) => item.ConditionCheck?.TableName === 'WorkItemsTable'))
      .toHaveLength(0)
    const targetRow = transactionItems[1]?.Put?.Item
    const persistedCadence = targetRow?.cadence
    if (
      !targetRow ||
      typeof persistedCadence !== 'object' ||
      persistedCadence === null ||
      !('nextDueAt' in persistedCadence) ||
      typeof persistedCadence.nextDueAt !== 'string' ||
      !('reminderHoursBefore' in persistedCadence) ||
      typeof persistedCadence.reminderHoursBefore !== 'number'
    ) {
      throw new Error('Expected a persisted Planning update cadence.')
    }
    expect(targetRow).toMatchObject({
      updateScheduleShard: createPlanningUpdateScheduleShard(
        'workspace-1',
        'UPDATE_TARGET#PROJECT#team-1#project-1',
      ),
      nextNotificationAtRecordKey: createPlanningUpdateNextNotificationAtRecordKey(
        'workspace-1',
        'UPDATE_TARGET#PROJECT#team-1#project-1',
        persistedCadence.nextDueAt,
        persistedCadence.reminderHoursBefore,
      ),
    })
    expect(transactionItems[2]?.Put?.ConditionExpression).toBe(
      'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    )
    expect(transactionItems[3]?.Put?.ConditionExpression).toBe(
      'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    )
    const history = await client.listUpdates('workspace-1', { target })
    expect(history.updates).toEqual([response.update])
  })

  test('reserves comment IDs atomically across retries with different creation times', async () => {
    let current = new Date('2026-07-16T09:00:00.000Z')
    let preparedKind: string | undefined
    const attemptedKeys: string[][] = []
    const reservedCommentIds = new Set<string>()
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name !== 'TransactWriteCommand') return {}
        const items = command.input.TransactItems as Array<{
          /** Optional annotation put. */
          Put?: { Item: { recordKey: string } }
        }>
        const keys = items
          .map((item) => item.Put?.Item.recordKey)
          .filter((recordKey) => recordKey !== undefined)
        attemptedKeys.push(keys)
        const markerKey = keys.find((recordKey) => recordKey.startsWith('UPDATE_COMMENT_ID#'))
        if (!markerKey) throw new Error('Expected a comment identity marker.')
        if (reservedCommentIds.has(markerKey)) {
          throw {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'None' },
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' },
            ],
          }
        }
        reservedCommentIds.add(markerKey)
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => current,
    )
    const target: PlanningUpdateTarget = {
      type: 'project', teamId: 'team-1', projectId: 'project-1',
    }

    await client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 1,
      id: 'comment-1',
      body: 'First attempt',
    }, 'member@example.com', {
      async prepare(result) {
        preparedKind = result.kind
        return {
          transactWriteItem: {
            Put: {
              TableName: 'IdempotencyTable',
              Item: { recordKey: 'RECEIPT#comment-1' },
            },
          },
        }
      },
    })
    current = new Date('2026-07-16T10:00:00.000Z')
    await expect(client.createUpdateComment('workspace-1', {
      target,
      updateVersion: 1,
      id: 'comment-1',
      body: 'Retried later',
    }, 'member@example.com')).rejects.toMatchObject({
      status: 409,
      code: 'PlanningUpdateCommentExists',
    })

    expect(attemptedKeys).toHaveLength(2)
    expect(preparedKind).toBe('comment-create')
    expect(attemptedKeys[0]).toContain('RECEIPT#comment-1')
    expect(attemptedKeys[0]?.[0]).toBe(
      'UPDATE_COMMENT_ID#PROJECT#team-1#project-1#0000000000000001#comment-1',
    )
    expect(attemptedKeys[1]?.[0]).toBe(attemptedKeys[0]?.[0])
    expect(attemptedKeys[1]?.[1]).not.toBe(attemptedKeys[0]?.[1])
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
        if (command.constructor.name === 'QueryCommand') {
          return {
            Items: rowsForPlanningRecordPrefixQuery(command.input, [storedCycle]),
          }
        }
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

  test('persists Work Item dependency rows with both endpoint revision conditions', async () => {
    let transaction: Record<string, unknown> | undefined
    let transactionCalls = 0
    const preparedResults: unknown[] = []
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        if (command.constructor.name === 'TransactWriteCommand') {
          transactionCalls += 1
          transaction = command.input
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
      'WorkItemsTable',
    )
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'unstarted', { teamId: 'team-a', revision: 7 }),
        createWorkItem('work-b', 'unstarted', { teamId: 'team-b', revision: 9 }),
      ],
    }
    const workspaceAuthorizationCheck: PlanningCallerAuthorizationConditionCheck = {
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#manager@example.com' },
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 4 },
      },
    }
    const enterpriseAuthorizationCheck: PlanningCallerAuthorizationConditionCheck = {
      ConditionCheck: {
        TableName: 'EnterpriseIdentityTable',
        Key: { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'CONTROL' },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'controlRevision' },
        ExpressionAttributeValues: { ':expectedRevision': 6 },
      },
    }
    const authorizationConditionChecks = [
      workspaceAuthorizationCheck,
      enterpriseAuthorizationCheck,
    ]
    const mutationTransaction = {
      async prepare(result) {
        preparedResults.push(structuredClone(result))
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: {
                workspaceId: 'workspace-1',
                recordKey: 'COMPLETION#request-1',
                revision: result.revision,
              },
              ConditionExpression: 'attribute_not_exists(workspaceId)',
            },
          },
        }
      },
    } satisfies PlanningMutationTransaction

    const response = await client.createWorkItemDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: -3,
      expectedRevision: 0,
    }, workItemState, authorizationConditionChecks, mutationTransaction)

    expect(response.planning.revision).toBe(1)
    expect(transaction?.TransactItems).toEqual([
      expect.objectContaining({ Put: expect.any(Object) }),
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkItemsTable',
          Key: {
            directoryTeamId: 'workspace-1#team#team-a',
            issueId: 'work-a',
          },
          ExpressionAttributeValues: { ':expectedRevision': 7 },
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkItemsTable',
          Key: {
            directoryTeamId: 'workspace-1#team#team-b',
            issueId: 'work-b',
          },
          ExpressionAttributeValues: { ':expectedRevision': 9 },
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'workspace-1',
            recordKey: 'MEMBER#manager@example.com',
          },
          ExpressionAttributeValues: { ':expectedVersion': 4 },
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'EnterpriseIdentityTable',
          Key: { scopeKey: 'WORKSPACE#workspace-1', recordKey: 'CONTROL' },
          ExpressionAttributeValues: { ':expectedRevision': 6 },
        }),
      },
      {
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            recordKey: 'WORK_ITEM_DEPENDENCY#dependency-a-b',
            entryType: 'planning-work-item-dependency',
            lagDays: -3,
          }),
        }),
      },
      {
        Put: {
          TableName: 'DeveloperPlatformTable',
          Item: {
            workspaceId: 'workspace-1',
            recordKey: 'COMPLETION#request-1',
            revision: 1,
          },
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      },
    ])
    expect(preparedResults).toEqual([{
      kind: 'upsert',
      revision: 1,
      dependency: expect.objectContaining({
        id: 'dependency-a-b',
        predecessor: { teamId: 'team-a', workItemId: 'work-a' },
        successor: { teamId: 'team-b', workItemId: 'work-b' },
      }),
    }])

    const authorizationLimitChecks = Array.from({ length: 96 }, (_, index) => ({
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-limit', recordKey: `GUARD#${index}` },
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 1 },
      },
    })) satisfies PlanningCallerAuthorizationConditionCheck[]
    await expect(client.createWorkItemDependency('workspace-limit', {
      id: 'dependency-limit',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: -3,
      expectedRevision: 0,
    }, workItemState, authorizationLimitChecks, mutationTransaction)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningMutationLimitExceeded',
    })
    expect(transactionCalls).toBe(1)

    const oversizedTransaction = {
      async prepare(result) {
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: {
                workspaceId: 'workspace-size',
                recordKey: 'COMPLETION#request-size',
                revision: result.revision,
                payload: 'x'.repeat(3_000_000),
              },
            },
          },
        }
      },
    } satisfies PlanningMutationTransaction
    await expect(client.createWorkItemDependency('workspace-size', {
      id: 'dependency-size',
      predecessor: { teamId: 'team-a', workItemId: 'work-a' },
      successor: { teamId: 'team-b', workItemId: 'work-b' },
      type: 'finish-to-finish',
      lagDays: -3,
      expectedRevision: 0,
    }, workItemState, [], oversizedTransaction)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningMutationSizeLimitExceeded',
    })
    expect(transactionCalls).toBe(1)
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
        if (command.constructor.name === 'QueryCommand') {
          return {
            Items: rowsForPlanningRecordPrefixQuery(command.input, [storedCycle, storedLink]),
          }
        }
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

  test('classifies authorization, revision, endpoint, and receipt cancellations by priority', async () => {
    const authorizationConditionChecks = [{
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#manager@example.com' },
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 4 },
      },
    }] satisfies PlanningCallerAuthorizationConditionCheck[]
    const workItemState: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-a', 'unstarted', { teamId: 'team-a', revision: 7 }),
        createWorkItem('work-b', 'unstarted', { teamId: 'team-b', revision: 9 }),
      ],
    }
    const transaction = {
      async prepare(result) {
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: {
                workspaceId: 'workspace-1',
                recordKey: 'COMPLETION#request-1',
                revision: result.revision,
              },
              ConditionExpression: 'attribute_not_exists(workspaceId)',
            },
          },
        }
      },
    } satisfies PlanningMutationTransaction

    for (const scenario of [
      {
        reasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
        code: 'PlanningAuthorizationChanged',
      },
      {
        reasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
        code: 'PlanningRevisionConflict',
      },
      {
        reasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
        code: 'PlanningWorkItemChanged',
      },
      {
        reasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
        code: 'PlanningIdempotencyConflict',
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
        'WorkItemsTable',
      )

      await expect(client.createWorkItemDependency('workspace-1', {
        id: 'dependency-a-b',
        predecessor: { teamId: 'team-a', workItemId: 'work-a' },
        successor: { teamId: 'team-b', workItemId: 'work-b' },
        type: 'finish-to-finish',
        lagDays: -3,
        expectedRevision: 0,
      }, workItemState, authorizationConditionChecks, transaction)).rejects.toMatchObject({
        status: 409,
        code: scenario.code,
      })
    }
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
          return {
            Items: rowsForPlanningRecordPrefixQuery(command.input, storedEntities),
          }
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
          return {
            Items: rowsForPlanningRecordPrefixQuery(command.input, [storedEntity]),
          }
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
          return {
            Items: rowsForPlanningRecordPrefixQuery(
              command.input,
              [storedLargeEntity, storedSmallEntity],
            ),
          }
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
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') {
          return { Item: storedAtLimit[0] }
        }
        if (command.constructor.name === 'QueryCommand') {
          return { Items: rowsForPlanningRecordPrefixQuery(command.input, storedAtLimit) }
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
        /** AWS SDK command input. */
        input: Record<string, unknown>
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
        return {
          Items: rowsForPlanningRecordPrefixQuery(command.input, [storedEntity]),
        }
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
