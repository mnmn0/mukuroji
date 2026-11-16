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

/** Archives one entity just before a chosen commit, as a concurrent request would. */
class RacingPlanningClient extends InMemoryPlanningClient {
  commitCount = 0
  raceAtCommit = 0
  raceEntityId = ''
  /** Work Item revision conditions of every commit, in order. */
  workItemConditions: unknown[] = []

  protected override async commitState(
    ...args: Parameters<InMemoryPlanningClient['commitState']>
  ) {
    this.commitCount += 1
    this.workItemConditions.push(...args[3] ?? [])
    if (this.commitCount === this.raceAtCommit) {
      const { revision } = await this.get('workspace-1', EMPTY_WORK_ITEMS)
      await this.archive('workspace-1', this.raceEntityId, { expectedRevision: revision }, EMPTY_WORK_ITEMS)
    }
    return super.commitState(...args)
  }
}

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
 * Creates one stored entity row for large-Workspace persistence tests.
 *
 * @param id - Entity identifier.
 * @param type - Entity type.
 * @param overrides - Scope, hierarchy, and type-specific fields.
 * @returns A canonical ENTITY row.
 */
function createScaleEntityRow(
  id: string,
  type: PlanningEntityType,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspaceId: 'workspace-1',
    recordKey: `ENTITY#${id}`,
    entryType: 'planning-entity',
    id,
    type,
    title: id,
    ownerMemberKey: 'owner@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-08-01', endDate: '2026-08-14' },
    forecast: { startDate: '2026-08-01', endDate: '2026-08-14' },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

/**
 * Creates a goal hierarchy plus Work Item links so the live graph has an exact row count.
 *
 * @param rowCount - Total live graph rows, including the four hierarchy entities.
 * @returns Canonical ENTITY and LINK rows.
 */
function createGoalLinkRows(rowCount: number): Record<string, unknown>[] {
  return [
    createScaleEntityRow('portfolio-1', 'portfolio'),
    createScaleEntityRow('roadmap-1', 'roadmap', { parentId: 'portfolio-1' }),
    createScaleEntityRow('initiative-1', 'initiative', { parentId: 'roadmap-1' }),
    createScaleEntityRow('goal-1', 'goal', { parentId: 'initiative-1' }),
    ...Array.from({ length: rowCount - 4 }, (_, index) => ({
      workspaceId: 'workspace-1',
      recordKey: `LINK#team-1#item-${index}`,
      entryType: 'planning-work-item-link',
      teamId: 'team-1',
      workItemId: `item-${index}`,
      goalIds: ['goal-1'],
      createdAt: NOW.toISOString(),
    })),
  ]
}

/**
 * Returns one DynamoDB Query page over rows sorted by sort key, honoring `Limit` and
 * `ExclusiveStartKey` and reporting `LastEvaluatedKey` when rows remain.
 *
 * @param input - AWS SDK Query input.
 * @param rows - Complete physical rows available to the fake table.
 * @param pageSize - Maximum rows the fake returns per page, standing in for the 1 MB page limit.
 * @returns The page in DynamoDB response shape.
 */
function queryPlanningPage(
  input: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
  pageSize: number,
) {
  const start = input.ExclusiveStartKey
  const startKey = typeof start === 'object' && start !== null && 'recordKey' in start
    ? String(start.recordKey)
    : undefined
  const matching = rowsForPlanningRecordPrefixQuery(input, rows)
    .filter((row) => startKey === undefined || String(row.recordKey) > startKey)
    .sort((first, second) => String(first.recordKey) < String(second.recordKey) ? -1 : 1)
  const limit = typeof input.Limit === 'number' ? Math.min(input.Limit, pageSize) : pageSize
  const items = matching.slice(0, limit)
  const last = items.at(-1)
  return {
    Items: items,
    ...(matching.length > items.length && last
      ? { LastEvaluatedKey: { workspaceId: last.workspaceId, recordKey: last.recordKey } }
      : {}),
  }
}

/**
 * Creates a DynamoDB Planning client over an in-memory table stored at revision 1.
 *
 * @param rows - Rows of `workspace-1`, live graph and archive alike.
 * @param pageSize - Maximum rows one Query page returns.
 * @returns The client, its mutable rows, every Query input, and every transaction it wrote.
 */
function createFakePlanningTable(rows: Record<string, unknown>[], pageSize = 1_000_000) {
  let meta: Record<string, unknown> = {
    workspaceId: 'FENCE#workspace-1',
    recordKey: 'META',
    entryType: 'planning-meta',
    schemaVersion: 1,
    revision: 1,
    updatedAt: NOW.toISOString(),
  }
  const writes: Record<string, unknown>[] = []
  const queries: Record<string, unknown>[] = []
  const documentClient = {
    async send(command: {
      /** AWS SDK command constructor. */
      constructor: { name: string }
      /** AWS SDK command input. */
      input: Record<string, unknown>
    }) {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key
        if (typeof key !== 'object' || key === null || !('recordKey' in key)) return {}
        if ('workspaceId' in key && key.workspaceId === 'FENCE#workspace-1') return { Item: meta }
        const item = rows.find((row) => row.recordKey === key.recordKey)
        return item ? { Item: { ...item } } : {}
      }
      if (command.constructor.name === 'QueryCommand') {
        queries.push(command.input)
        return queryPlanningPage(command.input, rows, pageSize)
      }
      writes.push(command.input)
      const items = command.input.TransactItems
      if (!Array.isArray(items)) throw new Error('Expected a transaction.')
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue
        if ('Put' in item && typeof item.Put === 'object' && item.Put !== null && 'Item' in item.Put) {
          const written = item.Put.Item
          if (typeof written !== 'object' || written === null || !('recordKey' in written)) continue
          if (written.recordKey === 'META') {
            meta = { ...written }
            continue
          }
          const index = rows.findIndex((row) => row.recordKey === written.recordKey)
          if (index >= 0) rows.splice(index, 1, { ...written })
          else rows.push({ ...written })
        }
        if (
          'Delete' in item && typeof item.Delete === 'object' && item.Delete !== null &&
          'Key' in item.Delete && typeof item.Delete.Key === 'object' && item.Delete.Key !== null &&
          'recordKey' in item.Delete.Key
        ) {
          const recordKey = item.Delete.Key.recordKey
          const index = rows.findIndex((row) => row.recordKey === recordKey)
          if (index >= 0) rows.splice(index, 1)
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
  return { client, rows, writes, queries }
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

/**
 * Creates a valid stored Project update target whose latest context exceeds the safe row size.
 *
 * @param projectId - Team-local Project identifier of the update target.
 * @returns An UPDATE_TARGET row larger than the Planning row size limit.
 */
function createOversizedStoredUpdateTarget(projectId: string) {
  const target: PlanningUpdateTarget = { type: 'project', teamId: 'team-1', projectId }
  return {
    workspaceId: 'workspace-1',
    recordKey: `UPDATE_TARGET#PROJECT#team-1#${projectId}`,
    entryType: 'planning-update-target',
    target,
    latestVersion: 1,
    latestUpdate: {
      id: 'update-1',
      version: 1,
      health: 'on-track',
      risk: 'none',
      summary: 'Delivery remains on plan.',
      progressSnapshot: { percent: 0, linkedWorkItemCount: 0 },
      authorMemberKey: 'owner@example.com',
      coveredDueAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    latestContextSnapshot: {
      health: 'on-track',
      risk: 'none',
      progress: { percent: 0, linkedWorkItemCount: 0 },
      scope: { teamId: 'team-1', projectId },
      milestones: Array.from({ length: 400 }, (_, index) => ({
        entityId: `milestone-${String(index).padStart(240, '0')}`,
        title: 'm'.repeat(500),
        status: 'planned',
        forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
      })),
      dependencies: [],
    },
    updatedAt: '2026-07-01T00:00:00.000Z',
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

  test('rejects malformed patches and oversized descriptions', async () => {
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
      createEntityInput('portfolio-patch', 'portfolio', 0),
      EMPTY_WORK_ITEMS,
    )
    await expect(client.update(
      'workspace-1',
      'portfolio-patch',
      { expectedRevision: 1 } as UpdatePlanningEntityInput,
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 400, code: 'PlanningPatchInvalid' })
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
        // The archived Cycle and its link reference leave the live graph in one more revision.
        expect(archived.planning.revision).toBe(7)
        expect(archived.planning.entities.some((entity) => entity.id === 'cycle-source'))
          .toBeFalse()
        expect(archived.planning.workItemLinks.map((link) => [link.workItemId, link.cycleId]))
          .toEqual([['work-todo', 'cycle-target']])
        expect(archived.planning.capacity.liveRowCount)
          .toBe(response.planning.capacity.liveRowCount - 2)
        expect(await client.listArchivedEntities('workspace-1', {})).toEqual({
          entities: [{
            id: 'cycle-source',
            type: 'cycle',
            title: 'cycle-source',
            teamId: 'team-1',
            projectId: 'project-1',
            ownerMemberKey: 'owner@example.com',
            archivedAt: NOW.toISOString(),
          }],
        })

        const restored = await client.restore(
          'workspace-1',
          'cycle-source',
          { expectedRevision: 7 },
          workItemState,
        )
        expect(restored.restore).toEqual({
          restoredLinkCount: 1,
          droppedLinkCount: 0,
          restoredDependencyCount: 0,
          retainedDependencyCount: 0,
          droppedDependencyCount: 0,
          pendingReferenceCount: 0,
        })
        expect(getEntity(restored.planning.entities, 'cycle-source')).toMatchObject({
          status: 'completed',
        })
        expect(getEntity(restored.planning.entities, 'cycle-source').archivedAt).toBeUndefined()
        expect(restored.planning.workItemLinks.find((link) => link.workItemId === 'work-done'))
          .toMatchObject({ cycleId: 'cycle-source' })
        expect(await client.listArchivedEntities('workspace-1', {})).toEqual({ entities: [] })
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

  test('duplicates without graph edges and soft-archives the copy', async () => {
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
    await client.createDependency('workspace-1', {
      id: 'dependency-1',
      predecessorId: 'portfolio-1',
      successorId: 'roadmap-1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    const duplicated = await client.duplicate('workspace-1', 'roadmap-1', {
      targetId: 'roadmap-copy',
      title: 'Roadmap copy',
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)

    const copy = getEntity(duplicated.planning.entities, 'roadmap-copy')
    expect(duplicated.planning.dependencies.some((dependency) =>
      dependency.predecessorId === copy.id || dependency.successorId === copy.id
    )).toBe(false)

    const archived = await client.archive(
      'workspace-1',
      'roadmap-copy',
      { expectedRevision: 4 },
      EMPTY_WORK_ITEMS,
    )
    expect(archived.planning.revision).toBe(6)
    expect(archived.planning.entities.some((entity) => entity.id === 'roadmap-copy')).toBeFalse()
    expect(await client.getArchivedEntity('workspace-1', 'roadmap-copy')).toMatchObject({
      id: 'roadmap-copy',
      archivedAt: NOW.toISOString(),
    })
    // The archived entity keeps its ID so it can be restored later.
    await expect(client.duplicate('workspace-1', 'roadmap-1', {
      targetId: 'roadmap-copy',
      expectedRevision: 6,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({ status: 409, code: 'PlanningEntityExists' })
    await expect(client.create(
      'workspace-1',
      createEntityInput('roadmap-copy', 'roadmap', 6, { parentId: 'portfolio-1' }),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 409, code: 'PlanningEntityExists' })

    const archivedOriginal = await client.archive(
      'workspace-1',
      'roadmap-1',
      { expectedRevision: 6 },
      EMPTY_WORK_ITEMS,
    )
    // The dependency leaves the live graph with its archived successor.
    expect(archivedOriginal.planning.dependencies).toHaveLength(0)
    await expect(client.createDependency('workspace-1', {
      id: 'dependency-to-archived',
      predecessorId: 'portfolio-1',
      successorId: 'roadmap-1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: archivedOriginal.planning.revision,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 404,
      code: 'PlanningEntityNotFound',
    })

    const restored = await client.restore(
      'workspace-1',
      'roadmap-1',
      { expectedRevision: archivedOriginal.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(restored.restore).toMatchObject({ restoredDependencyCount: 1, pendingReferenceCount: 0 })
    expect(getEntity(restored.planning.entities, 'roadmap-1').archivedAt).toBeUndefined()
    expect(restored.planning.dependencies.map((dependency) => dependency.id))
      .toEqual(['dependency-1'])
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
      { expectedRevision: 4 },
      EMPTY_WORK_ITEMS,
    )
    expect(response.planning.entities).toEqual([])
    expect((await client.listArchivedEntities('workspace-1', {})).entities.map((entity) => entity.id))
      .toEqual(['portfolio-parent', 'roadmap-child'])

    await expect(client.restore(
      'workspace-1',
      'roadmap-child',
      { expectedRevision: response.planning.revision },
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 409, code: 'PlanningRestoreParentUnavailable' })
    const parent = await client.restore(
      'workspace-1',
      'portfolio-parent',
      { expectedRevision: response.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    const child = await client.restore(
      'workspace-1',
      'roadmap-child',
      { expectedRevision: parent.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(child.planning.entities.map((entity) => [entity.id, entity.archivedAt]))
      .toEqual([['portfolio-parent', undefined], ['roadmap-child', undefined]])
    // Restoring an active entity again only resumes leftover references; there are none.
    const again = await client.restore(
      'workspace-1',
      'roadmap-child',
      { expectedRevision: child.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(again.planning.revision).toBe(child.planning.revision)
    expect(again.restore.pendingReferenceCount).toBe(0)
    await expect(client.restore(
      'workspace-1',
      'missing-entity',
      { expectedRevision: child.planning.revision },
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 404, code: 'PlanningArchivedEntityNotFound' })
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
      expectedRevision: 4,
    }, EMPTY_WORK_ITEMS)

    expect(getEntity(response.planning.entities, 'portfolio-active').projectId).toBe('project-2')
    expect(await client.getArchivedEntity('workspace-1', 'roadmap-archived'))
      .toMatchObject({ projectId: 'project-1' })
    // Restoring under a parent whose scope changed does not silently move the entity.
    await expect(client.restore(
      'workspace-1',
      'roadmap-archived',
      { expectedRevision: response.planning.revision },
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 409, code: 'PlanningProjectScopeMismatch' })
    expect(await client.getArchivedEntity('workspace-1', 'roadmap-archived'))
      .toMatchObject({ projectId: 'project-1' })
  })
})

describe('planning structured updates', () => {
  test('rejects cadence deadlines without an explicit timezone offset', async () => {
    const client = new InMemoryPlanningClient(() => NOW)

    await expect(client.configureUpdateCadence('workspace-1', {
      target: { type: 'project', teamId: 'team-1', projectId: 'project-1' },
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-03-01T15:00:00',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      code: 'PlanningUpdateCadenceInvalid',
    })
  })

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
          type: 'file',
          fileId: 'file-1',
          url: 'https://example.com/files/file-1',
        },
        { type: 'link', url: 'https://example.com/evidence' },
      ],
    }), 'owner@example.com', EMPTY_WORK_ITEMS)
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
          const key = command.input.Key
          if (
            typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          ) {
            return {
              Item: {
                workspaceId: 'FENCE#workspace-1',
                recordKey: 'META',
                entryType: 'planning-meta',
                schemaVersion: 1,
                revision: 1,
                updatedAt: NOW.toISOString(),
              },
            }
          }
          return {
            Item: undefined,
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
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
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
      25_001,
      25_000,
      25_000,
      25_000,
      25_000,
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
    expect(commands[0]?.input.Key).toEqual({
      workspaceId: 'workspace-1',
      recordKey: 'ARCHIVE_ENTITY#portfolio-1',
    })
    expect(commands.map((command) => command.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
    const storedEntities = Array.from({ length: 201 }, (_, index) => ({
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
    const storedTarget = createOversizedStoredUpdateTarget('project-large')
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') {
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
            Items: rowsForPlanningRecordPrefixQuery(command.input, [storedTarget]),
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

    await expect(client.configureUpdateCadence('workspace-1', {
      target: storedTarget.target,
      cadence: null,
      expectedRevision: 1,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({
      status: 413,
      code: 'PlanningRowSizeLimitExceeded',
    })
    expect(transactionCalls).toBe(0)
  })

  test('does not revalidate an oversized unchanged row during another mutation', async () => {
    let transaction: Record<string, unknown> | undefined
    const storedLargeTarget = createOversizedStoredUpdateTarget('project-large')
    const storedSmallEntity = {
      workspaceId: 'workspace-1',
      recordKey: 'ENTITY#portfolio-small',
      entryType: 'planning-entity',
      id: 'portfolio-small',
      type: 'portfolio',
      title: 'portfolio-small',
      ownerMemberKey: 'owner@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'none',
      progressMode: 'automatic',
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
              [storedLargeTarget, storedSmallEntity],
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

  test('rejects only row-adding mutations once the live capacity is reached', async () => {
    const { client, rows, writes } = createFakePlanningTable(createGoalLinkRows(20_000))
    const snapshot = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(snapshot.capacity).toMatchObject({
      level: 'full',
      liveRowCount: 20_000,
      liveRowCapacity: 20_000,
      warningRowCount: 16_000,
      liveByteCapacity: 24_000_000,
      warningByteCount: 19_200_000,
    })
    expect(snapshot.capacity.liveByteCount).toBe(
      rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0),
    )

    await expect(client.create(
      'workspace-1',
      createEntityInput('portfolio-over-capacity', 'portfolio', 1),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 413, code: 'PlanningCapacityExceeded' })
    expect(writes).toHaveLength(0)

    const updated = await client.update('workspace-1', 'portfolio-1', {
      expectedRevision: 1,
      patch: { title: 'Still editable at capacity' },
    }, EMPTY_WORK_ITEMS)
    expect(updated.planning.capacity.liveRowCount).toBe(20_000)
    expect(writes).toHaveLength(1)

    const link = rows.find((row) => row.entryType === 'planning-work-item-link')
    if (typeof link?.teamId !== 'string' || typeof link.workItemId !== 'string') {
      throw new Error('Expected a stored link.')
    }
    const unlinked = await client.deleteWorkItemLink(
      'workspace-1',
      link.teamId,
      link.workItemId,
      { expectedRevision: 2 },
      EMPTY_WORK_ITEMS,
    )
    expect(unlinked.planning.capacity).toMatchObject({ level: 'warning', liveRowCount: 19_999 })
  })

  test('rejects growth beyond the byte capacity so committed graphs stay readable', async () => {
    const goalIds = Array.from({ length: 100 }, (_, index) =>
      `goal-${String(index).padStart(240, '0')}`
    )
    const rows: Record<string, unknown>[] = [
      createScaleEntityRow('portfolio-1', 'portfolio'),
      createScaleEntityRow('roadmap-1', 'roadmap', { parentId: 'portfolio-1' }),
      createScaleEntityRow('initiative-1', 'initiative', { parentId: 'roadmap-1' }),
      ...goalIds.map((id) => createScaleEntityRow(id, 'goal', { parentId: 'initiative-1' })),
    ]
    let bytes = rows.reduce<number>(
      (total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'),
      0,
    )
    for (let index = 0; bytes < 24_000_000; index += 1) {
      const link = {
        workspaceId: 'workspace-1',
        recordKey: `LINK#team-1#item-${index}`,
        entryType: 'planning-work-item-link',
        teamId: 'team-1',
        workItemId: `item-${index}`,
        goalIds,
        createdAt: NOW.toISOString(),
      }
      rows.push(link)
      bytes += Buffer.byteLength(JSON.stringify(link), 'utf8')
    }
    const { client, writes } = createFakePlanningTable(rows)

    const snapshot = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(snapshot.capacity.liveRowCount).toBeLessThan(16_000)
    expect(snapshot.capacity).toMatchObject({ level: 'full', liveByteCount: bytes })
    await expect(client.create(
      'workspace-1',
      createEntityInput('portfolio-over-bytes', 'portfolio', 1),
      EMPTY_WORK_ITEMS,
    )).rejects.toMatchObject({ status: 413, code: 'PlanningCapacityExceeded' })
    expect(writes).toHaveLength(0)

    await client.update('workspace-1', 'portfolio-1', {
      expectedRevision: 1,
      patch: { title: 'P' },
    }, EMPTY_WORK_ITEMS)
    expect(writes).toHaveLength(1)
  })

  test('caps update targets at the Update Feed projection bound', async () => {
    const rows: Record<string, unknown>[] = Array.from({ length: 2_000 }, (_, index) => {
      const target: PlanningUpdateTarget = {
        type: 'project',
        teamId: 'team-1',
        projectId: `project-${index}`,
      }
      return {
        workspaceId: 'workspace-1',
        recordKey: `UPDATE_TARGET#PROJECT#team-1#project-${index}`,
        entryType: 'planning-update-target',
        target,
        latestVersion: 0,
        updatedAt: NOW.toISOString(),
      }
    })
    const { client, writes } = createFakePlanningTable(rows)
    await expect(client.configureUpdateCadence('workspace-1', {
      target: { type: 'project', teamId: 'team-1', projectId: 'project-2000' },
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-01T00:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 1,
    }, EMPTY_WORK_ITEMS)).rejects.toMatchObject({ status: 413, code: 'PlanningCapacityExceeded' })
    expect(writes).toHaveLength(0)
  })

  test('reads a live graph across Query pages and keeps the bound on later pages', async () => {
    const paged = createFakePlanningTable(createGoalLinkRows(50), 7)
    const snapshot = await paged.client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(snapshot.capacity.liveRowCount).toBe(50)
    const linkQueries = paged.queries.filter((input) =>
      (input.ExpressionAttributeValues as Record<string, unknown>)[':recordPrefix'] === 'LINK#'
    )
    // 46 links in pages of 7 take 7 Query calls, each continuing from the previous page.
    expect(linkQueries).toHaveLength(7)
    expect(linkQueries[0]).not.toHaveProperty('ExclusiveStartKey')
    expect(linkQueries.slice(1).every((input) => input.ExclusiveStartKey !== undefined)).toBeTrue()

    const overBound = createFakePlanningTable(createGoalLinkRows(25_001), 10_000)
    await expect(overBound.client.get('workspace-1', EMPTY_WORK_ITEMS))
      .rejects.toMatchObject({ status: 413, code: 'PlanningReadLimitExceeded' })
    // The bound trips on the third LINK page, after two pages were accepted.
    expect(overBound.queries.filter((input) =>
      (input.ExpressionAttributeValues as Record<string, unknown>)[':recordPrefix'] === 'LINK#'
    )).toHaveLength(3)
  })

  test('moves an archived Goal and its links out of the live graph and restores them', async () => {
    const { client, rows, writes } = createFakePlanningTable(createGoalLinkRows(104), 30)
    const workItems: PlanningWorkItemState = {
      workItems: Array.from({ length: 100 }, (_, index) =>
        createWorkItem(`item-${index}`, 'started', { projectId: undefined })
      ),
    }
    const archived = await client.archive(
      'workspace-1',
      'goal-1',
      { expectedRevision: 1 },
      workItems,
    )
    // Archive is revision 2. 100 link references move 45 at a time, the last step with the Goal.
    expect(archived.planning.revision).toBe(5)
    expect(archived.planning.workItemLinks).toEqual([])
    expect(archived.planning.entities.map((entity) => entity.id))
      .toEqual(['initiative-1', 'portfolio-1', 'roadmap-1'])
    expect(archived.planning.capacity.liveRowCount).toBe(3)
    expect(writes).toHaveLength(4)
    for (const write of writes) {
      expect((write.TransactItems as unknown[]).length).toBeLessThanOrEqual(100)
    }
    expect(rows.filter((row) => String(row.recordKey).startsWith('LINK#'))).toHaveLength(0)
    expect(rows.filter((row) => row.entryType === 'planning-archived-link-reference'))
      .toHaveLength(100)
    expect(rows.find((row) => row.entryType === 'planning-archived-entity')).toMatchObject({
      recordKey: 'ARCHIVE_ENTITY#goal-1',
      entity: { id: 'goal-1', archivedAt: NOW.toISOString() },
    })

    // Live reads never touch the archive prefixes.
    const fresh = createFakePlanningTable(rows.map((row) => ({ ...row })))
    expect((await fresh.client.get('workspace-1', workItems)).capacity.liveRowCount).toBe(3)
    expect(fresh.queries.some((input) =>
      String((input.ExpressionAttributeValues as Record<string, unknown>)[':recordPrefix'])
        .startsWith('ARCHIVE')
    )).toBeFalse()

    const page = await client.listArchivedEntities('workspace-1', { limit: 1 })
    expect(page.entities.map((entity) => entity.id)).toEqual(['goal-1'])
    expect(page).not.toHaveProperty('nextCursor')

    const writesBeforeRestore = writes.length
    const restored = await client.restore(
      'workspace-1',
      'goal-1',
      { expectedRevision: 5 },
      workItems,
    )
    expect(restored.restore).toEqual({
      restoredLinkCount: 100,
      droppedLinkCount: 0,
      restoredDependencyCount: 0,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 0,
    })
    // One revision restores the Goal; link references return 30 per revision with Work Item guards.
    expect(restored.planning.revision).toBe(10)
    expect(writes.length - writesBeforeRestore).toBe(5)
    for (const write of writes.slice(writesBeforeRestore)) {
      const items = write.TransactItems as Array<Record<string, Record<string, unknown>>>
      expect(items.length).toBeLessThanOrEqual(100)
      // Each archive row a restore consumes must still exist, so a concurrent restore cannot
      // apply the same reference twice.
      for (const item of items) {
        const key = item.Delete?.Key as Record<string, unknown> | undefined
        if (String(key?.recordKey).startsWith('ARCHIVE')) {
          expect(item.Delete?.ConditionExpression).toBe('attribute_exists(recordKey)')
        }
      }
    }
    expect(restored.planning.workItemLinks).toHaveLength(100)
    expect(restored.planning.workItemLinks.every((link) => link.goalIds.includes('goal-1')))
      .toBeTrue()
    expect(rows.some((row) => String(row.recordKey).startsWith('ARCHIVE'))).toBeFalse()
  })

  test('keeps restored references valid and reports what could not return', async () => {
    const client = new RacingPlanningClient(() => NOW)
    const workItems: PlanningWorkItemState = {
      workItems: [
        createWorkItem('work-moved', 'completed'),
        createWorkItem('work-deleted', 'completed'),
        createWorkItem('work-kept', 'completed'),
      ],
    }
    await client.create('workspace-1', createCycleInput('cycle-old', 0, { projectId: 'project-1' }), workItems)
    await client.create('workspace-1', createCycleInput('cycle-new', 1, { projectId: 'project-1' }), workItems)
    await client.create('workspace-1', createEntityInput('portfolio-a', 'portfolio', 2), workItems)
    await client.create('workspace-1', createEntityInput('portfolio-b', 'portfolio', 3), workItems)
    await client.createDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessorId: 'portfolio-a',
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 4,
    }, workItems)
    let revision = 5
    for (const workItemId of ['work-moved', 'work-deleted', 'work-kept']) {
      await client.putWorkItemLink('workspace-1', {
        teamId: 'team-1',
        workItemId,
        projectId: 'project-1',
        cycleId: 'cycle-old',
        goalIds: [],
        expectedRevision: revision,
      }, workItems)
      revision += 1
    }
    revision = (await client.archive('workspace-1', 'cycle-old', { expectedRevision: revision }, workItems))
      .planning.revision
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-moved',
      projectId: 'project-1',
      cycleId: 'cycle-new',
      goalIds: [],
      expectedRevision: revision,
    }, workItems)
    revision += 1
    revision = (await client.archive('workspace-1', 'portfolio-a', { expectedRevision: revision }, workItems))
      .planning.revision
    revision = (await client.archive('workspace-1', 'portfolio-b', { expectedRevision: revision }, workItems))
      .planning.revision
    expect((await client.get('workspace-1', workItems)).dependencies).toEqual([])

    const withoutDeleted: PlanningWorkItemState = {
      workItems: workItems.workItems.filter((item) => item.id !== 'work-deleted'),
    }
    client.workItemConditions = []
    const cycle = await client.restore('workspace-1', 'cycle-old', { expectedRevision: revision }, withoutDeleted)
    // The dropped reference is guarded too: it was judged against the Work Item's current revision.
    expect(client.workItemConditions).toEqual([
      expect.objectContaining({ workItemId: 'work-kept' }),
      expect.objectContaining({ workItemId: 'work-moved' }),
    ])
    // work-moved now belongs to another Cycle, so its old reference is dropped. work-deleted is not
    // visible to this restore, so its reference stays archived instead of being discarded.
    expect(cycle.restore).toMatchObject({
      restoredLinkCount: 1,
      droppedLinkCount: 1,
      pendingReferenceCount: 1,
    })
    expect(cycle.planning.workItemLinks.map((link) => [link.workItemId, link.cycleId])).toEqual([
      ['work-kept', 'cycle-old'],
      ['work-moved', 'cycle-new'],
    ])

    // portfolio-a left the live graph first, so it owns the archived dependency. Restoring it
    // while portfolio-b is archived hands the dependency to portfolio-b until both are live.
    const first = await client.restore(
      'workspace-1',
      'portfolio-a',
      { expectedRevision: cycle.planning.revision },
      workItems,
    )
    expect(first.restore).toMatchObject({ retainedDependencyCount: 1, restoredDependencyCount: 0 })
    expect(first.planning.dependencies).toEqual([])
    const second = await client.restore(
      'workspace-1',
      'portfolio-b',
      { expectedRevision: first.planning.revision },
      workItems,
    )
    expect(second.restore).toMatchObject({ restoredDependencyCount: 1 })
    expect(second.planning.dependencies.map((dependency) => dependency.id)).toEqual(['dependency-a-b'])
    expect(await client.listArchivedEntities('workspace-1', {})).toEqual({ entities: [] })
  })

  test('hands a dependency to a counterpart archived while the restore is running', async () => {
    const client = new RacingPlanningClient(() => NOW)
    await client.create('workspace-1', createEntityInput('portfolio-a', 'portfolio', 0), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createEntityInput('portfolio-b', 'portfolio', 1), EMPTY_WORK_ITEMS)
    await client.createDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessorId: 'portfolio-a',
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    const archived = await client.archive('workspace-1', 'portfolio-a', { expectedRevision: 3 }, EMPTY_WORK_ITEMS)

    // The first commit restores portfolio-a; the second carries its dependency reference.
    client.raceAtCommit = client.commitCount + 2
    client.raceEntityId = 'portfolio-b'
    const first = await client.restore(
      'workspace-1',
      'portfolio-a',
      { expectedRevision: archived.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(first.restore).toMatchObject({ retainedDependencyCount: 1, droppedDependencyCount: 0 })
    const second = await client.restore(
      'workspace-1',
      'portfolio-b',
      { expectedRevision: first.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(second.restore).toMatchObject({ restoredDependencyCount: 1 })
    expect(second.planning.dependencies.map((dependency) => dependency.id)).toEqual(['dependency-a-b'])
  })

  test('keeps the references archived when the restored entity is archived again', async () => {
    const client = new RacingPlanningClient(() => NOW)
    const workItems: PlanningWorkItemState = { workItems: [createWorkItem('work-race', 'completed')] }
    await client.create('workspace-1', createCycleInput('cycle-race', 0, { projectId: 'project-1' }), workItems)
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-race',
      projectId: 'project-1',
      cycleId: 'cycle-race',
      goalIds: [],
      expectedRevision: 1,
    }, workItems)
    const archived = await client.archive('workspace-1', 'cycle-race', { expectedRevision: 2 }, workItems)

    // The first commit restores the Cycle; a concurrent archive lands before its link returns.
    client.raceAtCommit = client.commitCount + 2
    client.raceEntityId = 'cycle-race'
    const interrupted = await client.restore(
      'workspace-1',
      'cycle-race',
      { expectedRevision: archived.planning.revision },
      workItems,
    )
    expect(interrupted.restore).toMatchObject({ droppedLinkCount: 0, pendingReferenceCount: 1 })
    expect(await client.getArchivedEntity('workspace-1', 'cycle-race')).toMatchObject({ id: 'cycle-race' })

    const restored = await client.restore(
      'workspace-1',
      'cycle-race',
      { expectedRevision: interrupted.planning.revision },
      workItems,
    )
    expect(restored.restore).toMatchObject({ restoredLinkCount: 1, pendingReferenceCount: 0 })
    expect(restored.planning.workItemLinks.map((link) => [link.workItemId, link.cycleId]))
      .toEqual([['work-race', 'cycle-race']])
  })

  test('archives and restores identifiers whose combined archive key would be too long', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    // Each ID encodes to 768 bytes: it fits its live key, but not next to the other in one key.
    const entityId = '%'.repeat(256)
    const dependencyId = '#'.repeat(256)
    await client.create('workspace-1', createEntityInput(entityId, 'portfolio', 0), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createEntityInput('portfolio-b', 'portfolio', 1), EMPTY_WORK_ITEMS)
    await client.createDependency('workspace-1', {
      id: dependencyId,
      predecessorId: entityId,
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    const archived = await client.archive('workspace-1', entityId, { expectedRevision: 3 }, EMPTY_WORK_ITEMS)
    expect(archived.planning.entities.some((entity) => entity.id === entityId)).toBeFalse()
    expect(archived.planning.dependencies).toEqual([])

    const restored = await client.restore(
      'workspace-1',
      entityId,
      { expectedRevision: archived.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    expect(restored.restore).toMatchObject({ restoredDependencyCount: 1, pendingReferenceCount: 0 })
    expect(restored.planning.dependencies.map((dependency) => dependency.id)).toEqual([dependencyId])
  })

  test('splits compaction steps by transaction bytes', async () => {
    // 100 Goals whose IDs double in size when JSON-escaped, linked from 45 Work Items each.
    const goalIds = Array.from({ length: 100 }, (_, index) =>
      `${'"'.repeat(252)}${String(index).padStart(3, '0')}`
    )
    const rows: Record<string, unknown>[] = [
      createScaleEntityRow('portfolio-1', 'portfolio'),
      createScaleEntityRow('roadmap-1', 'roadmap', { parentId: 'portfolio-1' }),
      createScaleEntityRow('initiative-1', 'initiative', { parentId: 'roadmap-1' }),
      ...goalIds.map((id) => createScaleEntityRow(id, 'goal', {
        recordKey: `ENTITY#${encodeURIComponent(id)}`,
        parentId: 'initiative-1',
      })),
      ...Array.from({ length: 45 }, (_, index) => ({
        workspaceId: 'workspace-1',
        recordKey: `LINK#team-1#item-${index}`,
        entryType: 'planning-work-item-link',
        teamId: 'team-1',
        workItemId: `item-${index}`,
        goalIds,
        createdAt: NOW.toISOString(),
      })),
    ]
    const { client, writes } = createFakePlanningTable(rows)
    const workItems: PlanningWorkItemState = {
      workItems: Array.from({ length: 45 }, (_, index) =>
        createWorkItem(`item-${index}`, 'started', { projectId: undefined })
      ),
    }
    const archived = await client.archive('workspace-1', goalIds[0]!, { expectedRevision: 1 }, workItems)
    expect(archived.planning.entities.some((entity) => entity.id === goalIds[0])).toBeFalse()
    expect(archived.planning.workItemLinks.every((link) => !link.goalIds.includes(goalIds[0]!)))
      .toBeTrue()
    // One archive revision, then the 45 references in more than one size-bounded step.
    expect(writes.length).toBeGreaterThan(2)
    for (const write of writes) {
      expect(new TextEncoder().encode(JSON.stringify(write.TransactItems)).length)
        .toBeLessThanOrEqual(3_000_000)
    }
  })

  test('sizes restore steps by the merged live link rows', async () => {
    // 99 Goals whose IDs grow sixfold when JSON-escaped, added to the links after archive.
    const largeGoalIds = Array.from({ length: 99 }, (_, index) =>
      `${'\u0001'.repeat(252)}${String(index).padStart(3, '0')}`
    )
    const linkCount = 21
    const rows: Record<string, unknown>[] = [
      createScaleEntityRow('portfolio-1', 'portfolio'),
      createScaleEntityRow('roadmap-1', 'roadmap', { parentId: 'portfolio-1' }),
      createScaleEntityRow('initiative-1', 'initiative', { parentId: 'roadmap-1' }),
      createScaleEntityRow('goal-0', 'goal', { parentId: 'initiative-1' }),
      ...largeGoalIds.map((id) => createScaleEntityRow(id, 'goal', {
        recordKey: `ENTITY#${encodeURIComponent(id)}`,
        title: 'Large Goal',
        parentId: 'initiative-1',
      })),
      ...Array.from({ length: linkCount }, (_, index) => ({
        workspaceId: 'workspace-1',
        recordKey: `LINK#team-1#item-${index}`,
        entryType: 'planning-work-item-link',
        teamId: 'team-1',
        workItemId: `item-${index}`,
        goalIds: ['goal-0'],
        createdAt: NOW.toISOString(),
      })),
    ]
    const workItems: PlanningWorkItemState = {
      workItems: Array.from({ length: linkCount }, (_, index) =>
        createWorkItem(`item-${index}`, 'started', { projectId: undefined })
      ),
    }
    await createFakePlanningTable(rows).client
      .archive('workspace-1', 'goal-0', { expectedRevision: 1 }, workItems)
    for (let index = 0; index < linkCount; index += 1) {
      rows.push({
        workspaceId: 'workspace-1',
        recordKey: `LINK#team-1#item-${index}`,
        entryType: 'planning-work-item-link',
        teamId: 'team-1',
        workItemId: `item-${index}`,
        goalIds: largeGoalIds,
        createdAt: NOW.toISOString(),
      })
    }

    const { client, writes } = createFakePlanningTable(rows)
    const restored = await client.restore('workspace-1', 'goal-0', { expectedRevision: 1 }, workItems)
    expect(restored.restore).toMatchObject({ restoredLinkCount: linkCount, pendingReferenceCount: 0 })
    expect(writes.length).toBeGreaterThan(2)
    for (const write of writes) {
      expect(new TextEncoder().encode(JSON.stringify(write.TransactItems)).length)
        .toBeLessThanOrEqual(3_000_000)
    }
  })

  test('leaves links archived when the caller cannot write their Work Items', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    const workItems: PlanningWorkItemState = { workItems: [createWorkItem('work-guarded', 'completed')] }
    await client.create('workspace-1', createCycleInput('cycle-guarded', 0, { projectId: 'project-1' }), workItems)
    await client.putWorkItemLink('workspace-1', {
      teamId: 'team-1',
      workItemId: 'work-guarded',
      projectId: 'project-1',
      cycleId: 'cycle-guarded',
      goalIds: [],
      expectedRevision: 1,
    }, workItems)
    const archived = await client.archive('workspace-1', 'cycle-guarded', { expectedRevision: 2 }, workItems)
    const scopes: unknown[] = []
    const denied = await client.restore(
      'workspace-1',
      'cycle-guarded',
      { expectedRevision: archived.planning.revision },
      workItems,
      {
        canRestoreLinkTo: async (scope) => {
          scopes.push(scope)
          return false
        },
      },
    )
    expect(scopes).toEqual([{ teamId: 'team-1', projectId: 'project-1' }])
    expect(denied.restore).toMatchObject({ restoredLinkCount: 0, droppedLinkCount: 0, pendingReferenceCount: 1 })
    expect(denied.planning.workItemLinks).toEqual([])

    const allowed = await client.restore(
      'workspace-1',
      'cycle-guarded',
      { expectedRevision: denied.planning.revision },
      workItems,
      { canRestoreLinkTo: async () => true },
    )
    expect(allowed.restore).toMatchObject({ restoredLinkCount: 1, pendingReferenceCount: 0 })
  })

  test('stops restoring references once the restored entity is in a scope the caller cannot manage', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createEntityInput('portfolio-a', 'portfolio', 0), EMPTY_WORK_ITEMS)
    await client.create('workspace-1', createEntityInput('portfolio-b', 'portfolio', 1), EMPTY_WORK_ITEMS)
    await client.createDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessorId: 'portfolio-a',
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    const archived = await client.archive('workspace-1', 'portfolio-a', { expectedRevision: 3 }, EMPTY_WORK_ITEMS)
    const stopped = await client.restore(
      'workspace-1',
      'portfolio-a',
      { expectedRevision: archived.planning.revision },
      EMPTY_WORK_ITEMS,
      { canManageEntity: async () => false },
    )
    expect(stopped.restore).toMatchObject({ restoredDependencyCount: 0, pendingReferenceCount: 1 })
    expect(stopped.planning.dependencies).toEqual([])
  })

  test('keeps archived dependencies apart when a dependency ID is reused', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    for (const [index, id] of ['portfolio-a', 'portfolio-b', 'portfolio-c'].entries()) {
      await client.create('workspace-1', createEntityInput(id, 'portfolio', index), EMPTY_WORK_ITEMS)
    }
    await client.createDependency('workspace-1', {
      id: 'dependency-reused',
      predecessorId: 'portfolio-a',
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)
    let revision = (await client.archive('workspace-1', 'portfolio-a', { expectedRevision: 4 }, EMPTY_WORK_ITEMS))
      .planning.revision
    // The ID is free in the live graph again, so another edge may take it.
    await client.createDependency('workspace-1', {
      id: 'dependency-reused',
      predecessorId: 'portfolio-b',
      successorId: 'portfolio-c',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: revision,
    }, EMPTY_WORK_ITEMS)
    revision = (await client.archive('workspace-1', 'portfolio-b', { expectedRevision: revision + 1 }, EMPTY_WORK_ITEMS))
      .planning.revision
    // Restoring portfolio-a hands its edge to the archived portfolio-b without replacing B's own.
    const first = await client.restore('workspace-1', 'portfolio-a', { expectedRevision: revision }, EMPTY_WORK_ITEMS)
    expect(first.restore).toMatchObject({ retainedDependencyCount: 1 })
    const second = await client.restore(
      'workspace-1',
      'portfolio-b',
      { expectedRevision: first.planning.revision },
      EMPTY_WORK_ITEMS,
    )
    // Both edges come back to portfolio-b; the second with the same ID cannot be live at once.
    expect(second.restore).toMatchObject({
      restoredDependencyCount: 1,
      droppedDependencyCount: 1,
      pendingReferenceCount: 0,
    })
  })

  test('leaves a dependency archived when the caller cannot manage its counterpart', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createEntityInput('portfolio-a', 'portfolio', 0), EMPTY_WORK_ITEMS)
    await client.create(
      'workspace-1',
      createEntityInput('portfolio-b', 'portfolio', 1, { teamId: 'team-b' }),
      EMPTY_WORK_ITEMS,
    )
    await client.createDependency('workspace-1', {
      id: 'dependency-a-b',
      predecessorId: 'portfolio-a',
      successorId: 'portfolio-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 2,
    }, EMPTY_WORK_ITEMS)
    const archived = await client.archive('workspace-1', 'portfolio-a', { expectedRevision: 3 }, EMPTY_WORK_ITEMS)
    const checked: string[] = []
    const denied = await client.restore(
      'workspace-1',
      'portfolio-a',
      { expectedRevision: archived.planning.revision },
      EMPTY_WORK_ITEMS,
      {
        canManageEntity: async (entity) => {
          checked.push(entity.id)
          return entity.teamId !== 'team-b'
        },
      },
    )
    // The restored entity is rechecked too; each scope is decided once per request.
    expect(checked).toEqual(['portfolio-a', 'portfolio-b'])
    expect(denied.restore).toMatchObject({
      restoredDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 1,
    })
    expect(denied.planning.dependencies).toEqual([])

    // A caller who manages both endpoints brings the edge back by restoring again.
    const allowed = await client.restore(
      'workspace-1',
      'portfolio-a',
      { expectedRevision: denied.planning.revision },
      EMPTY_WORK_ITEMS,
      { canManageEntity: async () => true },
    )
    expect(allowed.restore).toMatchObject({ restoredDependencyCount: 1, pendingReferenceCount: 0 })
    expect(allowed.planning.dependencies.map((dependency) => dependency.id)).toEqual(['dependency-a-b'])
  })

  test('leaves references that exceed the live capacity archived until a later restore', async () => {
    const archivedGoal = {
      ...createScaleEntityRow('goal-2', 'goal', {
        parentId: 'initiative-1',
        archivedAt: NOW.toISOString(),
      }),
    }
    const { recordKey: _recordKey, workspaceId: _workspaceId, entryType: _entryType, ...entity } =
      archivedGoal
    const newLinks = ['item-new-0', 'item-new-1'].map((workItemId) => ({
      workspaceId: 'workspace-1',
      recordKey: `ARCHIVE_REF#goal-2#LINK#team-1#${workItemId}`,
      entryType: 'planning-archived-link-reference',
      schemaVersion: 1,
      kind: 'link',
      entityId: 'goal-2',
      reference: 'goal',
      link: { teamId: 'team-1', workItemId, goalIds: ['goal-2'], createdAt: NOW.toISOString() },
    }))
    const { client, rows } = createFakePlanningTable([
      ...createGoalLinkRows(19_999),
      {
        workspaceId: 'workspace-1',
        recordKey: 'ARCHIVE_ENTITY#goal-2',
        entryType: 'planning-archived-entity',
        schemaVersion: 1,
        entity,
      },
      ...newLinks,
    ])
    const workItems: PlanningWorkItemState = {
      workItems: ['item-new-0', 'item-new-1'].map((id) =>
        createWorkItem(id, 'started', { projectId: undefined })
      ),
    }

    const partial = await client.restore('workspace-1', 'goal-2', { expectedRevision: 1 }, workItems)
    expect(partial.restore).toMatchObject({ restoredLinkCount: 0, pendingReferenceCount: 2 })
    expect(partial.planning.capacity).toMatchObject({ level: 'full', liveRowCount: 20_000 })
    expect(getEntity(partial.planning.entities, 'goal-2').archivedAt).toBeUndefined()
    expect(rows.filter((row) => row.entryType === 'planning-archived-link-reference'))
      .toHaveLength(2)

    let revision = partial.planning.revision
    for (const workItemId of ['item-0', 'item-1']) {
      revision = (await client.deleteWorkItemLink(
        'workspace-1',
        'team-1',
        workItemId,
        { expectedRevision: revision },
        workItems,
      )).planning.revision
    }
    const resumed = await client.restore('workspace-1', 'goal-2', { expectedRevision: revision }, workItems)
    expect(resumed.restore).toMatchObject({ restoredLinkCount: 2, pendingReferenceCount: 0 })
    expect(resumed.planning.capacity.liveRowCount).toBe(20_000)
    expect(rows.some((row) => String(row.recordKey).startsWith('ARCHIVE'))).toBeFalse()
  })

  test('keeps archived Initiatives with an update target in the live graph', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    await client.create('workspace-1', createEntityInput('portfolio-1', 'portfolio', 0), EMPTY_WORK_ITEMS)
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
    await client.configureUpdateCadence('workspace-1', {
      target: { type: 'initiative', entityId: 'initiative-1' },
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-01T00:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 3,
    }, EMPTY_WORK_ITEMS)
    const initiative = await client.archive(
      'workspace-1',
      'initiative-1',
      { expectedRevision: 4 },
      EMPTY_WORK_ITEMS,
    )
    expect(initiative.planning.revision).toBe(5)
    expect(getEntity(initiative.planning.entities, 'initiative-1').archivedAt).toBe(NOW.toISOString())
    const roadmap = await client.archive(
      'workspace-1',
      'roadmap-1',
      { expectedRevision: 5 },
      EMPTY_WORK_ITEMS,
    )
    // The roadmap's archived child is still live, so the roadmap stays live too.
    expect(roadmap.planning.revision).toBe(6)
    expect(getEntity(roadmap.planning.entities, 'roadmap-1').archivedAt).toBe(NOW.toISOString())
    expect(await client.listArchivedEntities('workspace-1', {})).toEqual({ entities: [] })

    // Archived entities that stay live are restored in place, parent first.
    await expect(client.restore('workspace-1', 'initiative-1', { expectedRevision: 6 }, EMPTY_WORK_ITEMS))
      .rejects.toMatchObject({ status: 409, code: 'PlanningRestoreParentUnavailable' })
    await client.restore('workspace-1', 'roadmap-1', { expectedRevision: 6 }, EMPTY_WORK_ITEMS)
    const restored = await client.restore(
      'workspace-1',
      'initiative-1',
      { expectedRevision: 7 },
      EMPTY_WORK_ITEMS,
    )
    expect(restored.planning.revision).toBe(8)
    expect(getEntity(restored.planning.entities, 'initiative-1').archivedAt).toBeUndefined()
    expect(restored.planning.updateTargets.find((target) =>
      target.target.type === 'initiative' && target.target.entityId === 'initiative-1'
    )?.archivedAt).toBeUndefined()
  })

  test('resumes moving an archived entity that is still live', async () => {
    const rows = createGoalLinkRows(104)
    const goal = rows.find((row) => row.recordKey === 'ENTITY#goal-1')
    if (!goal) throw new Error('Expected the Goal row.')
    goal.archivedAt = NOW.toISOString()
    const { client } = createFakePlanningTable(rows)
    const resumed = await client.archive('workspace-1', 'goal-1', { expectedRevision: 1 }, EMPTY_WORK_ITEMS)
    // No new archive revision; three revisions move the 100 link references and the Goal.
    expect(resumed.planning.revision).toBe(4)
    expect(resumed.planning.capacity.liveRowCount).toBe(3)
    expect(resumed).toMatchObject({ movedWorkItemIds: [], retainedWorkItemIds: [] })
    expect(await client.getArchivedEntity('workspace-1', 'goal-1')).toMatchObject({ id: 'goal-1' })
    await expect(client.archive('workspace-1', 'goal-1', { expectedRevision: 4 }, EMPTY_WORK_ITEMS))
      .rejects.toMatchObject({ status: 404, code: 'PlanningEntityNotFound' })
  })

  test('validates archive list paging input', async () => {
    const client = new InMemoryPlanningClient(() => NOW)
    for (const id of ['portfolio-a', 'portfolio-b', 'portfolio-c']) {
      const revision = (await client.get('workspace-1', EMPTY_WORK_ITEMS)).revision
      await client.create('workspace-1', createEntityInput(id, 'portfolio', revision), EMPTY_WORK_ITEMS)
      await client.archive('workspace-1', id, { expectedRevision: revision + 1 }, EMPTY_WORK_ITEMS)
    }
    const first = await client.listArchivedEntities('workspace-1', { limit: 2 })
    expect(first.entities.map((entity) => entity.id)).toEqual(['portfolio-a', 'portfolio-b'])
    expect(typeof first.nextCursor).toBe('string')
    const second = await client.listArchivedEntities('workspace-1', {
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second).toEqual({
      entities: [expect.objectContaining({ id: 'portfolio-c' })],
    })
    await expect(client.listArchivedEntities('workspace-1', { limit: 51 }))
      .rejects.toMatchObject({ status: 400, code: 'PlanningArchivePageLimitInvalid' })
    await expect(client.listArchivedEntities('workspace-1', { cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ status: 400, code: 'PlanningArchiveCursorInvalid' })

    // Control characters JSON-escape to six bytes each, the longest cursor an accepted ID makes.
    const escaped = '\u0001'.repeat(256)
    const revision = (await client.get('workspace-1', EMPTY_WORK_ITEMS)).revision
    await client.create('workspace-1', createEntityInput(escaped, 'portfolio', revision), EMPTY_WORK_ITEMS)
    await client.archive('workspace-1', escaped, { expectedRevision: revision + 1 }, EMPTY_WORK_ITEMS)
    const head = await client.listArchivedEntities('workspace-1', { limit: 1 })
    expect(head.entities.map((entity) => entity.id)).toEqual([escaped])
    expect(head.nextCursor?.length).toBeGreaterThan(2_048)
    const rest = await client.listArchivedEntities('workspace-1', { cursor: head.nextCursor })
    expect(rest.entities.map((entity) => entity.id))
      .toEqual(['portfolio-a', 'portfolio-b', 'portfolio-c'])
  })

  test('reports the warning level from the warning threshold', async () => {
    const below = createFakePlanningTable(createGoalLinkRows(15_999)).client
    expect((await below.get('workspace-1', EMPTY_WORK_ITEMS)).capacity.level).toBe('normal')
    const at = createFakePlanningTable(createGoalLinkRows(16_000)).client
    expect((await at.get('workspace-1', EMPTY_WORK_ITEMS)).capacity.level).toBe('warning')
  })

  test('serves a Workspace with 100 Projects and 5,000 linked Work Items', async () => {
    const rows: Record<string, unknown>[] = [createScaleEntityRow('portfolio-1', 'portfolio')]
    const workItems: PlanningWorkItemSummary[] = []
    for (let teamIndex = 0; teamIndex < 10; teamIndex += 1) {
      const teamId = `team-${teamIndex}`
      rows.push(createScaleEntityRow(`roadmap-${teamIndex}`, 'roadmap', {
        teamId,
        parentId: 'portfolio-1',
      }))
      for (let cycleIndex = 0; cycleIndex < 6; cycleIndex += 1) {
        rows.push(createScaleEntityRow(`cycle-${teamIndex}-${cycleIndex}`, 'cycle', {
          teamId,
          cadence: { unit: 'week', count: 2 },
          capacity: 1_000,
          carryOverPolicy: 'move-incomplete',
        }))
      }
      for (let projectIndex = 0; projectIndex < 10; projectIndex += 1) {
        const projectId = `project-${teamIndex}-${projectIndex}`
        const initiativeId = `initiative-${teamIndex}-${projectIndex}`
        rows.push(createScaleEntityRow(initiativeId, 'initiative', {
          teamId,
          projectId,
          parentId: `roadmap-${teamIndex}`,
        }))
        for (let milestoneIndex = 0; milestoneIndex < 3; milestoneIndex += 1) {
          rows.push(createScaleEntityRow(
            `milestone-${teamIndex}-${projectIndex}-${milestoneIndex}`,
            'milestone',
            {
              teamId,
              projectId,
              parentId: initiativeId,
              baseline: { startDate: '2026-08-14', endDate: '2026-08-14' },
              forecast: { startDate: '2026-08-14', endDate: '2026-08-14' },
            },
          ))
        }
        for (let itemIndex = 0; itemIndex < 50; itemIndex += 1) {
          const workItemId = `item-${projectIndex}-${itemIndex}`
          rows.push({
            workspaceId: 'workspace-1',
            recordKey: `LINK#${teamId}#${workItemId}`,
            entryType: 'planning-work-item-link',
            teamId,
            workItemId,
            projectId,
            cycleId: `cycle-${teamIndex}-${itemIndex % 6}`,
            milestoneId: `milestone-${teamIndex}-${projectIndex}-${itemIndex % 3}`,
            goalIds: [],
            createdAt: NOW.toISOString(),
          })
          workItems.push(createWorkItem(workItemId, 'started', {
            teamId,
            projectId,
            title: `Deliver increment ${itemIndex} of ${projectId}`,
          }))
        }
      }
    }
    const { client, writes } = createFakePlanningTable(rows)

    const snapshot = await client.get('workspace-1', { workItems })
    expect(snapshot.workItemLinks).toHaveLength(5_000)
    expect(snapshot.capacity).toMatchObject({ level: 'normal', liveRowCount: 5_471 })
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(4_000_000)
    const milestone = getEntity(snapshot.entities, 'milestone-0-0-0')
    expect(milestone.linkedWorkItemCount).toBe(17)

    const relinked = await client.putWorkItemLink('workspace-1', {
      teamId: 'team-0',
      workItemId: 'item-0-0',
      projectId: 'project-0-0',
      cycleId: 'cycle-0-1',
      goalIds: [],
      expectedRevision: 1,
    }, { workItems })
    expect(relinked.planning.workItemLinks).toHaveLength(5_000)
    expect(writes).toHaveLength(1)
  })

  test('fails closed when a live graph read exceeds the hard read bound', async () => {
    const meta = {
      workspaceId: 'FENCE#workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 1,
      updatedAt: NOW.toISOString(),
    }
    const links = Array.from({ length: 25_001 }, (_, index) => ({
      workspaceId: 'workspace-1',
      recordKey: `LINK#team-1#item-${index}`,
      entryType: 'planning-work-item-link',
    }))
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') return { Item: meta }
        if (command.constructor.name === 'QueryCommand') {
          return { Items: rowsForPlanningRecordPrefixQuery(command.input, links) }
        }
        throw new Error('Unexpected write.')
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    await expect(client.get('workspace-1', EMPTY_WORK_ITEMS))
      .rejects.toMatchObject({ status: 413, code: 'PlanningReadLimitExceeded' })
  })

  test('reuses a graph read at the same META revision and re-reads update targets', async () => {
    const queriedPrefixes: string[] = []
    let meta = {
      workspaceId: 'FENCE#workspace-1',
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: 1,
      revision: 1,
      updatedAt: NOW.toISOString(),
    }
    const rows: Record<string, unknown>[] = [createStoredCycle('cycle-1')]
    const documentClient = {
      async send(command: {
        /** AWS SDK command constructor. */
        constructor: { name: string }
        /** AWS SDK command input. */
        input: Record<string, unknown>
      }) {
        if (command.constructor.name === 'GetCommand') return { Item: meta }
        if (command.constructor.name === 'QueryCommand') {
          const values = command.input.ExpressionAttributeValues
          if (
            typeof values === 'object' && values !== null &&
            ':recordPrefix' in values && typeof values[':recordPrefix'] === 'string'
          ) {
            queriedPrefixes.push(values[':recordPrefix'])
          }
          return { Items: rowsForPlanningRecordPrefixQuery(command.input, rows) }
        }
        throw new Error('Unexpected write.')
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => NOW,
    )

    const first = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(queriedPrefixes).toHaveLength(5)
    queriedPrefixes.length = 0

    rows.push({ ...createStoredCycle('cycle-2'), title: 'Written without a META change' })
    const cached = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(queriedPrefixes).toEqual(['UPDATE_TARGET#'])
    expect(cached.entities).toEqual(first.entities)
    queriedPrefixes.length = 0

    meta = { ...meta, revision: 2, updatedAt: '2026-07-16T09:05:00.000Z' }
    const refreshed = await client.get('workspace-1', EMPTY_WORK_ITEMS)
    expect(queriedPrefixes).toHaveLength(5)
    expect(refreshed.revision).toBe(2)
    expect(refreshed.entities.map((entity) => entity.id)).toEqual(['cycle-1', 'cycle-2'])
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

  test('fails closed on a malformed stored Planning entity', async () => {
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
      baseline: 'invalid',
      forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
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
          const key = command.input.Key
          const fenced = typeof key === 'object' && key !== null &&
            'workspaceId' in key && key.workspaceId === 'FENCE#workspace-1'
          if (!fenced) return {}
          return {
            Item: {
              workspaceId: 'FENCE#workspace-1',
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
