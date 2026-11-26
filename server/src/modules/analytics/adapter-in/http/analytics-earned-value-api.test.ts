import { afterEach, expect, test } from 'bun:test'
import {
  createDefaultUnscheduledWorkItemSchedule,
  type AnalyticsQueryInput,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotRecord,
  type AnalyticsWidget,
} from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import type { TeamIssueResponseItem, TeamWorkItemHierarchyEntry } from '../../../work-items'
import { InMemoryAnalyticsRepository } from '../../analytics'
import { ANALYTICS_EARNED_VALUE_AS_OF_WARNING } from '../../analytics-earned-value'

const {
  analyticsApiRequest,
  app,
  configureFakeProjectClients,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

const workspaceId = 'user#demo@example.com'
const dayMs = 86_400_000

/** Team Work Items of the seeded Project, kept so a test can change the viewer and keep them. */
let teamIssues: ReturnType<typeof createTeamIssuesFake> | undefined

/** Analytics store of the seeded Workspace. */
let repository = new InMemoryAnalyticsRepository()

afterEach(() => {
  resetTestApp()
  teamIssues = undefined
  repository = new InMemoryAnalyticsRepository()
})

/** SPI, CPI, and EAC widgets. */
const widgets: AnalyticsWidget[] = [
  { id: 'spi', title: 'SPI', type: 'metric', metric: 'evm-spi' },
  { id: 'cpi', title: 'CPI', type: 'metric', metric: 'evm-cpi' },
  { id: 'eac', title: 'EAC', type: 'table', metric: 'evm-eac', groupBy: { dimension: 'project' } },
]

/**
 * Creates a query over the last week, as of now.
 *
 * @param asOf - As-of instant; now when omitted.
 * @returns Query.
 */
function createQuery(asOf = new Date()): AnalyticsQueryInput {
  return {
    filter: { period: { from: new Date(asOf.getTime() - 7 * dayMs).toISOString(), to: asOf.toISOString() } },
    widgets,
    asOf: asOf.toISOString(),
    timeZone: 'UTC',
  }
}

/**
 * Sets up a Project with one done and one open estimated Work Item, a captured baseline, and ten
 * hours of time on the done one.
 *
 * @returns The Project ID.
 */
async function seedProject(): Promise<string> {
  configureFakeProjectClients(true)
  const { issues: baseIssues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(workspaceId, 'core-team')
  const base = baseIssues[0]
  const projectId = base?.assignedProjectId
  if (!base || !projectId) throw new Error('The fake Work Item has no Project.')
  const issues: TeamIssueResponseItem[] = [
    {
      ...base,
      id: 'task-1',
      statusCategory: 'completed',
      schedule: { ...createDefaultUnscheduledWorkItemSchedule(600), mode: 'date-range', startDate: '2026-01-05', endDate: '2026-01-06', durationDays: 2 },
    },
    {
      ...base,
      id: 'task-2',
      statusCategory: 'unstarted',
      schedule: { ...createDefaultUnscheduledWorkItemSchedule(600), mode: 'date-range', startDate: '2026-01-07', endDate: '2026-01-08', durationDays: 2 },
    },
    { ...withoutProject(base), id: 'loose' },
  ]
  teamIssues = createTeamIssuesFake({
    async getTeamHierarchyEntries(): Promise<TeamWorkItemHierarchyEntry[]> {
      return issues.map((issue) => ({ issue, hierarchyRank: issue.id }))
    },
    async getTeamIssues() {
      return { teamId: 'core-team', issues }
    },
  })
  setTestAppDependencies({
    teamIssues,
    analytics: repository,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const captured = await app.request(`/api/teams/core-team/projects/${projectId}/schedule-baseline`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(captured.status).toBe(201)
  await getTestAppDependencies().timeTracking.timeTrackingService.createEntry({
    workspaceId,
    teamId: 'core-team',
    projectId,
    workItemId: 'task-1',
    userId: 'member-a',
    startAt: '2026-01-05T01:00:00.000Z',
    endAt: '2026-01-05T11:00:00.000Z',
    billable: true,
    currency: 'JPY',
    source: 'manual',
  }, true)
  return projectId
}

/**
 * Copies a Work Item without its Project.
 *
 * @param issue - Work Item.
 * @returns The copy, assigned to no Project.
 */
function withoutProject(issue: TeamIssueResponseItem): TeamIssueResponseItem {
  const { assignedProjectId, ...rest } = issue
  void assignedProjectId
  return rest
}

/**
 * Runs a query and returns its snapshot.
 *
 * @param query - Query.
 * @returns Snapshot.
 */
async function runQuery(query: AnalyticsQueryInput): Promise<AnalyticsSnapshot> {
  const response = await analyticsApiRequest('/api/analytics/query', query)
  expect(response.status).toBe(200)
  const body: { snapshot: AnalyticsSnapshot } = await response.json()
  return body.snapshot
}

test('measures SPI, CPI, and EAC of a managed Project from its baseline, progress, and time', async () => {
  const projectId = await seedProject()

  const snapshot = await runQuery(createQuery())

  const [spi, cpi, eac] = snapshot.widgets
  // Both baseline Work Items are planned before now: PV 1200 min. The done one earned 600 min.
  expect(spi?.value).toBe(0.5)
  // 600 earned minutes over 600 recorded minutes.
  expect(cpi?.value).toBe(1)
  // 1200 baseline minutes / CPI 1 = 20 hours.
  expect(eac?.value).toBe(20)
  expect(eac?.groups).toEqual([{ key: `core-team\0${projectId}`, label: projectId, value: 20, sampleSize: 1 }])
  expect(eac?.rows[0]?.values).toMatchObject({ plannedValueHours: 20, earnedValueHours: 10, actualHours: 10 })
})

test('measures whole Projects even when the report lists Work Items', async () => {
  await seedProject()
  const query = createQuery()

  // The listed Work Item has no Project; the Project of the Team scope is still measured.
  const snapshot = await runQuery({ ...query, filter: { ...query.filter, workItems: [{ teamId: 'core-team', workItemId: 'loose' }] } })

  expect(snapshot.widgets[0]?.value).toBe(0.5)
})

test('measures nothing for an as-of time more than a day old', async () => {
  await seedProject()

  const snapshot = await runQuery(createQuery(new Date(Date.now() - 3 * dayMs)))

  expect(snapshot.widgets[0]?.value).toBeNull()
  expect(snapshot.widgets[0]?.warnings).toEqual([ANALYTICS_EARNED_VALUE_AS_OF_WARNING])
})

test('leaves out the Projects the viewer does not manage', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    projectAccesses: [{ projectId: 'refero', role: 'member', teamId: 'core-team' }],
  })
  setTestAppDependencies({
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })

  const snapshot = await runQuery(createQuery())

  expect(snapshot.widgets[0]?.value).toBeNull()
  expect(snapshot.widgets[0]?.warnings).toContain('1 Project(s) you do not manage were left out of the earned value.')
})

test('hides an earned value snapshot once its creator no longer manages the Project', async () => {
  const projectId = await seedProject()
  const query = createQuery()
  await repository.createReport(workspaceId, 'demo@example.com', {
    id: 'evm-report',
    name: 'EVM report',
    visibility: 'personal',
    timeZone: query.timeZone,
    filter: query.filter,
    widgets: query.widgets,
  })
  // A snapshot without earned value keeps the same scope after the role change.
  await repository.createReport(workspaceId, 'demo@example.com', {
    id: 'flow-report',
    name: 'Flow report',
    visibility: 'personal',
    timeZone: query.timeZone,
    filter: query.filter,
    widgets: [{ id: 'wip', title: 'WIP', type: 'metric', metric: 'wip' }],
  })
  expect((await analyticsApiRequest('/api/analytics/reports/flow-report/snapshots', { asOf: query.asOf })).status).toBe(201)
  const created = await analyticsApiRequest('/api/analytics/reports/evm-report/snapshots', { asOf: query.asOf })
  expect(created.status).toBe(201)
  const { snapshotRecord }: { snapshotRecord: AnalyticsSnapshotRecord } = await created.json()
  expect(snapshotRecord.snapshot.widgets[0]?.value).toBe(0.5)
  const list = async (reportId = 'evm-report') => {
    const response = await app.request(`/api/analytics/reports/${reportId}/snapshots`, { headers: { Authorization: 'Bearer test-token' } })
    expect(response.status).toBe(200)
    const body: { snapshots: AnalyticsSnapshotRecord[] } = await response.json()
    return body.snapshots.length
  }
  expect(await list()).toBe(1)

  // The same Work Items and Project, now only as a Project member.
  configureFakeProjectClients(true, {
    teamProjects: [{ id: projectId, name: projectId, tone: 'blue' }],
    projectAccesses: [{ projectId, role: 'member', teamId: 'core-team' }],
    workspaceRole: 'member',
  })
  setTestAppDependencies({ analytics: repository, ...(teamIssues ? { teamIssues } : {}) })
  expect(await list()).toBe(0)
  expect(await list('flow-report')).toBe(1)
})
