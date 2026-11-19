import { describe, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  CreatePlanningEntityInput,
  PlanningEntity,
  PlanningWorkItemSummary,
} from '@mukuroji/contracts'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import {
  createCycleScheduleHandler,
  CycleScheduleIncompleteError,
} from './adapter-in/schedules/cycle-schedule'
import { createDynamoDbCycleScheduleSource } from './adapter-out/dynamodb/cycle-schedule-source'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
  PlanningError,
  type PlanningWorkItemState,
} from './planning'

const WORKSPACE = 'workspace-1'

function createCycle(
  id: string,
  expectedRevision: number,
  overrides: Partial<CreatePlanningEntityInput> = {},
): CreatePlanningEntityInput {
  return {
    id,
    type: 'cycle',
    title: 'Sprint 12',
    teamId: 'team-1',
    projectId: 'project-1',
    ownerMemberKey: 'owner@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-08-03', endDate: '2026-08-16' },
    forecast: { startDate: '2026-08-03', endDate: '2026-08-16' },
    cadence: { unit: 'week', count: 2 },
    capacity: 60,
    carryOverPolicy: 'move-incomplete',
    expectedRevision,
    ...overrides,
  }
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
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
  }
}

function getEntity(entities: readonly PlanningEntity[], id: string) {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Planning entity "${id}" was not returned.`)
  return entity
}

describe('Cycle automation', () => {
  test('creates the next Cycle from the cadence and records it on the source', async () => {
    const client = new InMemoryPlanningClient(() => new Date('2026-08-10T00:00:00.000Z'))
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      automation: { createNext: true, rolloverAtEnd: true },
    }), { workItems: [] })

    const response = await client.createNextCycle(WORKSPACE, 'cycle-1', { expectedRevision: 1 }, {
      workItems: [],
    })

    const source = getEntity(response.planning.entities, 'cycle-1')
    const next = getEntity(response.planning.entities, response.cycleId)
    expect(source.nextCycleId).toBe(response.cycleId)
    expect(next).toMatchObject({
      type: 'cycle',
      title: 'Sprint 13',
      teamId: 'team-1',
      projectId: 'project-1',
      status: 'planned',
      baseline: { startDate: '2026-08-17', endDate: '2026-08-30' },
      forecast: { startDate: '2026-08-17', endDate: '2026-08-30' },
      cadence: { unit: 'week', count: 2 },
      capacity: 60,
      carryOverPolicy: 'move-incomplete',
      automation: { createNext: true, rolloverAtEnd: true },
    })
    expect(next.nextCycleId).toBeUndefined()
    await expect(client.createNextCycle(WORKSPACE, 'cycle-1', { expectedRevision: 2 }, {
      workItems: [],
    })).rejects.toMatchObject({ status: 409, code: 'PlanningCycleNextExists' })
  })

  test('spans calendar months for a monthly cadence', async () => {
    const client = new InMemoryPlanningClient(() => new Date('2026-08-10T00:00:00.000Z'))
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      title: 'August',
      baseline: { startDate: '2026-08-01', endDate: '2026-08-31' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-31' },
      cadence: { unit: 'month', count: 1 },
    }), { workItems: [] })

    const response = await client.createNextCycle(WORKSPACE, 'cycle-1', { expectedRevision: 1 }, {
      workItems: [],
    })

    expect(getEntity(response.planning.entities, response.cycleId)).toMatchObject({
      title: 'August 2',
      baseline: { startDate: '2026-09-01', endDate: '2026-09-30' },
    })
  })

  test('rejects automation on entities other than Cycles and clears it with null', async () => {
    const client = new InMemoryPlanningClient()
    await expect(client.create(WORKSPACE, {
      ...createCycle('portfolio-1', 0),
      type: 'portfolio',
      teamId: undefined,
      projectId: undefined,
      cadence: undefined,
      capacity: undefined,
      carryOverPolicy: undefined,
      automation: { createNext: true, rolloverAtEnd: false },
    }, { workItems: [] })).rejects.toMatchObject({ code: 'PlanningCycleFieldsInvalid' })
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      automation: { createNext: true, rolloverAtEnd: false },
    }), { workItems: [] })
    await expect(client.update(WORKSPACE, 'cycle-1', {
      expectedRevision: 1,
      patch: { automation: { createNext: 'yes' } as never },
    }, { workItems: [] })).rejects.toMatchObject({ code: 'PlanningCycleAutomationInvalid' })
    const cleared = await client.update(WORKSPACE, 'cycle-1', {
      expectedRevision: 1,
      patch: { automation: null },
    }, { workItems: [] })
    expect(getEntity(cleared.planning.entities, 'cycle-1').automation).toBeUndefined()
  })

  test('adds and removes many Work Items in one call', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: Array.from({ length: 20 }, (_, index) => createWorkItem(`work-${index}`, 'unstarted')),
    }
    const client = new InMemoryPlanningClient()
    await client.create(WORKSPACE, createCycle('cycle-1', 0), workItemState)
    const workItems = workItemState.workItems.map((item) => ({ teamId: item.teamId, workItemId: item.id }))

    const added = await client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'add',
      workItems,
      expectedRevision: 1,
    }, workItemState)
    expect(added.planning.workItemLinks).toHaveLength(20)
    expect(getEntity(added.planning.entities, 'cycle-1').linkedWorkItemCount).toBe(20)

    const removed = await client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'remove',
      workItems: workItems.slice(0, 5),
      expectedRevision: 2,
    }, workItemState)
    expect(removed.planning.workItemLinks).toHaveLength(15)
  })

  test('keeps a Work Item milestone link when it leaves the Cycle and respects capacity', async () => {
    const workItemState: PlanningWorkItemState = {
      workItems: [createWorkItem('work-1', 'unstarted'), createWorkItem('work-2', 'unstarted')],
    }
    const client = new InMemoryPlanningClient()
    await client.create(WORKSPACE, createCycle('cycle-1', 0, { capacity: 1 }), workItemState)
    await expect(client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'add',
      workItems: [
        { teamId: 'team-1', workItemId: 'work-1' },
        { teamId: 'team-1', workItemId: 'work-2' },
      ],
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({ code: 'PlanningCycleCapacityExceeded' })
    await expect(client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'add',
      workItems: [
        { teamId: 'team-1', workItemId: 'work-1' },
        { teamId: 'team-1', workItemId: 'work-1' },
      ],
      expectedRevision: 1,
    }, workItemState)).rejects.toMatchObject({ code: 'PlanningCycleWorkItemsInvalid' })
  })

  test('creates the next Cycle three days before the end and rolls over after the end', async () => {
    let now = new Date('2026-08-12T23:00:00.000Z')
    const workItemState: PlanningWorkItemState = {
      workItems: [createWorkItem('open', 'started'), createWorkItem('done', 'completed')],
    }
    const client = new InMemoryPlanningClient(() => now)
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      automation: { createNext: true, rolloverAtEnd: true },
    }), workItemState)
    await client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'add',
      workItems: [
        { teamId: 'team-1', workItemId: 'open' },
        { teamId: 'team-1', workItemId: 'done' },
      ],
      expectedRevision: 1,
    }, workItemState)
    const loadWorkItems = async () => workItemState

    expect(await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', loadWorkItems))
      .toEqual({ action: 'idle' })
    now = new Date('2026-08-13T00:00:00.000Z')
    const created = await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', loadWorkItems)
    expect(created.action).toBe('created-next')
    expect(await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', loadWorkItems))
      .toEqual({ action: 'idle' })

    now = new Date('2026-08-17T00:00:00.000Z')
    expect(await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', loadWorkItems)).toEqual({
      action: 'rolled-over',
      movedCount: 1,
      remainingWorkItemCount: 0,
    })
    expect(await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', loadWorkItems))
      .toEqual({ action: 'idle' })
    const snapshot = await client.get(WORKSPACE, workItemState)
    expect(getEntity(snapshot.entities, 'cycle-1').status).toBe('completed')
    const nextCycleId = created.action === 'created-next' ? created.cycleId : ''
    expect(snapshot.workItemLinks.find((link) => link.workItemId === 'open')).toMatchObject({
      cycleId: nextCycleId,
      carriedOverFromCycleId: 'cycle-1',
    })
    expect(snapshot.workItemLinks.find((link) => link.workItemId === 'done')?.cycleId).toBe('cycle-1')
  })

  test('drops the carry-over history when the Cycle is changed by hand', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const workItemState: PlanningWorkItemState = { workItems: [createWorkItem('open', 'started')] }
    const client = new InMemoryPlanningClient(() => now)
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      automation: { createNext: false, rolloverAtEnd: true },
    }), workItemState)
    await client.setCycleWorkItems(WORKSPACE, 'cycle-1', {
      action: 'add',
      workItems: [{ teamId: 'team-1', workItemId: 'open' }],
      expectedRevision: 1,
    }, workItemState)
    const created = await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', async () => workItemState)
    expect(created.action).toBe('created-next')
    await client.runCycleAutomationStep(WORKSPACE, 'cycle-1', async () => workItemState)
    const moved = await client.get(WORKSPACE, workItemState)
    const link = moved.workItemLinks[0]!
    expect(link.carriedOverFromCycleId).toBe('cycle-1')
    const kept = await client.putWorkItemLink(WORKSPACE, {
      teamId: 'team-1',
      workItemId: 'open',
      cycleId: link.cycleId,
      goalIds: [],
      expectedRevision: moved.revision,
    }, workItemState)
    expect(kept.planning.workItemLinks[0]?.carriedOverFromCycleId).toBe('cycle-1')
    await client.create(WORKSPACE, createCycle('cycle-other', kept.planning.revision), workItemState)
    const changed = await client.setCycleWorkItems(WORKSPACE, 'cycle-other', {
      action: 'add',
      workItems: [{ teamId: 'team-1', workItemId: 'open' }],
      expectedRevision: kept.planning.revision + 1,
    }, workItemState)
    expect(changed.planning.workItemLinks[0]?.carriedOverFromCycleId).toBeUndefined()
  })
})

describe('Cycle automation due index', () => {
  test('writes sparse due-index attributes only while a step is pending', async () => {
    const rows = new Map<string, Record<string, unknown>>()
    let revision = 0
    const documentClient = {
      async send(command: { constructor: { name: string }; input: Record<string, any> }) {
        if (command.constructor.name === 'GetCommand') {
          return revision === 0 || command.input.Key.workspaceId !== `FENCE#${WORKSPACE}`
            ? {}
            : { Item: { workspaceId: `FENCE#${WORKSPACE}`, recordKey: 'META', entryType: 'planning-meta', schemaVersion: 1, revision } }
        }
        if (command.constructor.name === 'QueryCommand') {
          const prefix = String(command.input.ExpressionAttributeValues?.[':recordPrefix'] ?? '\u0000')
          return {
            Items: [...rows.values()]
              .filter((row) => String(row.recordKey).startsWith(prefix))
              .map((row) => ({ ...row })),
          }
        }
        for (const item of command.input.TransactItems as Array<Record<string, any>>) {
          if (item.Put?.Item.recordKey === 'META') revision = item.Put.Item.revision
          else if (item.Put) rows.set(item.Put.Item.recordKey, { ...item.Put.Item })
          else if (item.Delete) rows.delete(item.Delete.Key.recordKey)
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbPlanningClient(
      'PlanningTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      () => new Date('2026-08-01T00:00:00.000Z'),
      'WorkItems',
      true,
    )
    await client.create(WORKSPACE, createCycle('cycle-1', 0, {
      automation: { createNext: true, rolloverAtEnd: false },
    }), { workItems: [] })
    const pending = rows.get('ENTITY#cycle-1')!
    expect(pending.updateScheduleShard).toMatch(/^planning-cycle-\d{2}$/)
    expect(String(pending.nextNotificationAtRecordKey)).toStartWith('2026-08-13T00:00:00.000Z#')

    await client.createNextCycle(WORKSPACE, 'cycle-1', { expectedRevision: 1 }, { workItems: [] })
    const done = rows.get('ENTITY#cycle-1')!
    expect(done.updateScheduleShard).toBeUndefined()
    expect(done.nextNotificationAtRecordKey).toBeUndefined()
    expect(done.nextCycleId).toStartWith('cycle-next-')
  })
})

describe('Cycle schedule handler', () => {
  test('advances every due Cycle, then rejects the run when a Cycle failed', async () => {
    const queried: number[] = []
    const steps = new Map<string, number>()
    const handler = createCycleScheduleHandler({
      source: {
        shardCount: 16,
        async listDueCycles(shard) {
          queried.push(shard)
          if (shard !== 0) return { cycles: [] }
          return {
            cycles: [
              { workspaceId: WORKSPACE, cycleId: 'cycle-ok' },
              { workspaceId: WORKSPACE, cycleId: 'cycle-broken' },
            ],
          }
        },
        async readLinkedWorkItems() {
          return { workItems: [] }
        },
      },
      planning: {
        async runCycleAutomationStep(_workspaceId, cycleId) {
          const count = (steps.get(cycleId) ?? 0) + 1
          steps.set(cycleId, count)
          if (cycleId === 'cycle-broken') {
            throw new PlanningError(503, 'PlanningWorkItemMissing', 'missing')
          }
          if (count === 1) return { action: 'created-next', cycleId: 'next' }
          if (count === 2) return { action: 'rolled-over', movedCount: 3, remainingWorkItemCount: 0 }
          return { action: 'idle' }
        },
      },
    })

    const originalError = console.error
    console.error = () => {}
    try {
      const failure = await handler({ time: '2026-08-17T00:00:00.000Z' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CycleScheduleIncompleteError)
      expect((failure as CycleScheduleIncompleteError).result).toEqual({
        examined: 2,
        created: 1,
        rolledOver: 1,
        failed: 1,
        truncatedShards: 0,
      })
    } finally {
      console.error = originalError
    }
    expect(queried).toHaveLength(16)
    expect(steps.get('cycle-ok')).toBe(3)
  })

  test('follows page cursors and rejects a run that hits the page limit', async () => {
    const cursors: unknown[] = []
    const handler = createCycleScheduleHandler({
      maxPagesPerShard: 2,
      source: {
        shardCount: 1,
        async listDueCycles(_shard, _asOf, cursor) {
          cursors.push(cursor)
          return { cycles: [], cursor: { page: cursors.length } }
        },
        async readLinkedWorkItems() {
          return { workItems: [] }
        },
      },
      planning: { runCycleAutomationStep: async () => ({ action: 'idle' }) },
    })

    const failure = await handler({}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CycleScheduleIncompleteError)
    expect((failure as CycleScheduleIncompleteError).result.truncatedShards).toBe(1)
    expect(cursors).toEqual([undefined, { page: 1 }])
  })
})

describe('DynamoDB Cycle schedule source', () => {
  test('passes the page cursor and rejects rows that are not Planning entities', async () => {
    const inputs: Array<Record<string, any>> = []
    let items: Record<string, unknown>[] = [{ workspaceId: WORKSPACE, recordKey: 'ENTITY#cycle%201' }]
    const source = createDynamoDbCycleScheduleSource({
      documentClient: {
        async send(command: { input: Record<string, any> }) {
          inputs.push(command.input)
          return { Items: items, LastEvaluatedKey: { recordKey: 'next' } }
        },
      } as unknown as DynamoDBDocumentClient,
      planningTableName: 'PlanningTable',
      workItemsTableName: 'WorkItems',
    })

    const page = await source.listDueCycles(3, new Date('2026-08-17T00:00:00.000Z'), { recordKey: 'prev' })
    expect(page).toEqual({
      cycles: [{ workspaceId: WORKSPACE, cycleId: 'cycle 1' }],
      cursor: { recordKey: 'next' },
    })
    expect(inputs[0]).toMatchObject({
      IndexName: 'UpdateScheduleDueIndex',
      ExclusiveStartKey: { recordKey: 'prev' },
      ExpressionAttributeValues: {
        ':scheduleShard': 'planning-cycle-03',
        ':upperBound': '2026-08-17T00:00:00.000Z$',
      },
    })
    items = [{ workspaceId: WORKSPACE, recordKey: 'UPDATE_TARGET#x' }]
    await expect(source.listDueCycles(0, new Date())).rejects.toThrow(TypeError)
  })

  test('rejects a linked row that is not a canonical Work Item', async () => {
    const source = createDynamoDbCycleScheduleSource({
      documentClient: {
        async send() {
          return { Responses: { WorkItems: [{ directoryTeamId: 'x', issueId: 'y' }] } }
        },
      } as unknown as DynamoDBDocumentClient,
      planningTableName: 'PlanningTable',
      workItemsTableName: 'WorkItems',
    })
    await expect(source.readLinkedWorkItems(WORKSPACE, [{
      teamId: 'team-1',
      workItemId: 'y',
      goalIds: [],
      createdAt: '2026-08-01T00:00:00.000Z',
    }])).rejects.toThrow(TypeError)
  })
})
