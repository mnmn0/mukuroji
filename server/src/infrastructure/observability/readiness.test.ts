import { expect, test } from 'bun:test'
import { createDynamoDbReadinessProbe } from './readiness'

test('fails closed when any critical table configuration is missing', async () => {
  const describedTables: string[] = []
  const probe = createDynamoDbReadinessProbe({
    environment: {
      NODE_ENV: 'production',
      WORK_ITEMS_TABLE_NAME: 'work-items',
      WORKSPACE_ACCESS_TABLE_NAME: 'workspace-access',
    },
    describeTable: async (tableName) => {
      describedTables.push(tableName)
      return {
        globalSecondaryIndexesActive: true,
        tableActive: true,
      }
    },
  })

  expect(await probe.check()).toEqual({
    checks: [
      { name: 'work-items', ready: true },
      { name: 'workspace-access', ready: true },
      { name: 'audit-events', ready: false },
    ],
    ready: false,
  })
  expect(describedTables.sort()).toEqual(['work-items', 'workspace-access'])
})

test('uses adapter-compatible names and stable local table defaults', async () => {
  const compatibilityTables: string[] = []
  const compatibilityProbe = createDynamoDbReadinessProbe({
    environment: {
      AUDIT_EVENTS_TABLE_NAME: 'ignored-audit-events',
      MUKUROJI_AUDIT_EVENTS_TABLE: 'audit-events',
      MUKUROJI_TEAM_ISSUES_TABLE: 'work-items',
      MUKUROJI_WORKSPACE_ACCESS_TABLE: 'workspace-access',
      TEAM_ISSUES_TABLE_NAME: 'ignored-work-items',
      WORKSPACE_ACCESS_TABLE_NAME: 'ignored-workspace-access',
    },
    describeTable: async (tableName) => {
      compatibilityTables.push(tableName)
      return {
        globalSecondaryIndexesActive: true,
        tableActive: true,
      }
    },
  })
  const localDefaultTables: string[] = []
  const localDefaultProbe = createDynamoDbReadinessProbe({
    environment: {},
    describeTable: async (tableName) => {
      localDefaultTables.push(tableName)
      return {
        globalSecondaryIndexesActive: true,
        tableActive: true,
      }
    },
  })

  expect((await compatibilityProbe.check()).ready).toBeTrue()
  expect(compatibilityTables).toEqual([
    'work-items',
    'workspace-access',
    'audit-events',
  ])
  expect((await localDefaultProbe.check()).ready).toBeTrue()
  expect(localDefaultTables).toEqual([
    'mukuroji-team-issues-local',
    'mukuroji-workspace-access-local',
    'mukuroji-audit-events',
  ])
})

test('checks configured dependencies with a bounded timeout and caches the result', async () => {
  const calls: Array<{ tableName: string; timeoutMilliseconds: number }> = []
  let now = 1_000
  const probe = createDynamoDbReadinessProbe({
    cacheMilliseconds: 100,
    environment: {
      AUDIT_EVENTS_TABLE_NAME: 'audit-events',
      MUKUROJI_WORK_ITEMS_TABLE: 'work-items',
      WORKSPACE_ACCESS_TABLE_NAME: 'workspace-access',
    },
    now: () => now,
    timeoutMilliseconds: 321,
    describeTable: async (tableName, timeoutMilliseconds) => {
      calls.push({ tableName, timeoutMilliseconds })
      return {
        globalSecondaryIndexesActive: true,
        tableActive: true,
      }
    },
  })

  const first = await probe.check()
  const cached = await probe.check()
  now = 1_101
  const refreshed = await probe.check()

  expect(first.ready).toBeTrue()
  expect(cached).toBe(first)
  expect(refreshed.ready).toBeTrue()
  expect(calls).toHaveLength(6)
  expect(calls.every(({ timeoutMilliseconds }) =>
    timeoutMilliseconds === 321
  )).toBeTrue()
})

test('converts dependency errors to safe unavailable results', async () => {
  const probe = createDynamoDbReadinessProbe({
    environment: {
      AUDIT_EVENTS_TABLE_NAME: 'audit-events',
      WORK_ITEMS_TABLE_NAME: 'work-items',
      WORKSPACE_ACCESS_TABLE_NAME: 'workspace-access-physical-secret',
    },
    describeTable: async (tableName) => {
      if (tableName === 'workspace-access-physical-secret') {
        throw new Error('raw AWS detail')
      }
      return {
        globalSecondaryIndexesActive: true,
        tableActive: true,
      }
    },
  })

  const result = await probe.check()

  expect(result).toEqual({
    checks: [
      { name: 'work-items', ready: true },
      { name: 'workspace-access', ready: false },
      { name: 'audit-events', ready: true },
    ],
    ready: false,
  })
  expect(JSON.stringify(result)).not.toContain('raw AWS detail')
  expect(JSON.stringify(result)).not.toContain('workspace-access-physical-secret')
})

test('fails closed for non-active tables and global secondary indexes', async () => {
  const probe = createDynamoDbReadinessProbe({
    environment: {
      AUDIT_EVENTS_TABLE_NAME: 'audit-events',
      WORK_ITEMS_TABLE_NAME: 'work-items',
      WORKSPACE_ACCESS_TABLE_NAME: 'workspace-access',
    },
    describeTable: async (tableName) => ({
      globalSecondaryIndexesActive: tableName !== 'workspace-access',
      tableActive: tableName !== 'audit-events',
    }),
  })

  expect(await probe.check()).toEqual({
    checks: [
      { name: 'work-items', ready: true },
      { name: 'workspace-access', ready: false },
      { name: 'audit-events', ready: false },
    ],
    ready: false,
  })
})
