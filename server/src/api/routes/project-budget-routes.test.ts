import { createApiTestHarness } from '../test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createDefaultUnscheduledWorkItemSchedule,
  type ProjectBudgetReport,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import type { TeamIssueResponseItem, TeamWorkItemHierarchyEntry } from '../../modules/work-items'

const workspaceId = 'user#demo@example.com'

afterEach(() => {
  resetTestApp()
})

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @returns The response.
 */
function request(path: string, method = 'GET') {
  return app.request(path, { method, headers: { Authorization: 'Bearer test-token' } })
}

/**
 * Reads one fake Team Work Item to copy into fixtures.
 *
 * @returns The first fake Work Item of the Team.
 */
async function readBaseIssue(): Promise<TeamIssueResponseItem> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(workspaceId, 'core-team')
  const issue = issues[0]
  if (!issue) throw new Error('The fake Team has no Work Item.')
  return issue
}

/**
 * Sets up a Project with two estimated Work Items, a captured baseline, a budget, and time.
 *
 * @returns The Project ID.
 */
async function seedProject(): Promise<string> {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const projectId = base.assignedProjectId
  if (!projectId) throw new Error('The fake Work Item has no Project.')
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
  ]
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries(): Promise<TeamWorkItemHierarchyEntry[]> {
        return issues.map((issue) => ({ issue, hierarchyRank: issue.id }))
      },
      async getTeamIssues() {
        return { teamId: 'core-team', issues }
      },
    }),
  })
  const captured = await request(`/api/teams/core-team/projects/${projectId}/schedule-baseline`, 'POST')
  expect(captured.status).toBe(201)
  const service = getTestAppDependencies().timeTracking.timeTrackingService
  await service.saveBudget({
    workspaceId,
    teamId: 'core-team',
    scopeType: 'project',
    scopeId: projectId,
    amountMinor: 120_000,
    currency: 'JPY',
    expectedRevision: 0,
    updatedBy: 'manager',
  })
  // The same Project ID in another Team must not lend its budget to this Project.
  await service.saveBudget({
    workspaceId,
    teamId: 'other-team',
    scopeType: 'project',
    scopeId: projectId,
    amountMinor: 1,
    currency: 'USD',
    expectedRevision: 0,
    updatedBy: 'manager',
  })
  await service.createEntry({
    workspaceId,
    teamId: 'core-team',
    projectId,
    workItemId: 'task-1',
    userId: 'member-a',
    startAt: '2026-01-05T01:00:00.000Z',
    endAt: '2026-01-05T11:00:00.000Z',
    billable: true,
    currency: 'JPY',
    hourlyRateMinor: 6_000,
    source: 'manual',
  }, true)
  await service.createEntry({
    workspaceId,
    teamId: 'core-team',
    projectId: 'another-project',
    workItemId: 'task-9',
    userId: 'member-a',
    startAt: '2026-01-05T01:00:00.000Z',
    endAt: '2026-01-05T02:00:00.000Z',
    billable: true,
    currency: 'JPY',
    source: 'manual',
  }, true)
  return projectId
}

test('returns the budget, actuals, and earned value of a Project to its manager', async () => {
  const projectId = await seedProject()

  const response = await request(
    `/api/teams/core-team/projects/${projectId}/budget-report?from=2026-01-05&to=2026-01-08&timeZone=Asia/Tokyo&interval=day`,
  )

  expect(response.status).toBe(200)
  const report = await response.json() as ProjectBudgetReport
  expect(report.budget).toMatchObject({ teamId: 'core-team', amountMinor: 120_000, currency: 'JPY' })
  expect(report.actualMinutes).toBe(600)
  expect(report.actualCostByCurrency).toEqual({ JPY: 60_000 })
  expect(report.budgetConsumedPercent).toBe(50)
  expect(report.earnedValue).toMatchObject({
    budgetAtCompletionMinutes: 1200,
    plannedValueMinutes: 1200,
    earnedValueMinutes: 600,
    actualMinutes: 600,
    schedulePerformanceIndex: 0.5,
    costPerformanceIndex: 1,
    money: { currency: 'JPY', earnedValueMinor: 60_000, actualCostMinor: 60_000, costPerformanceIndex: 1 },
  })
  expect(report.points.map((point) => point.plannedValueMinutes)).toEqual([300, 600, 900, 1200])
  expect(report.points[0]).toMatchObject({ actualMinutes: 600, actualCostMinor: 60_000 })
})

test('exports the series as CSV', async () => {
  const projectId = await seedProject()

  const response = await request(
    `/api/teams/core-team/projects/${projectId}/budget-report/export?from=2026-01-05&to=2026-01-06&timeZone=Asia/Tokyo`,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/csv')
  const lines = (await response.text()).trimEnd().split('\n')
  expect(lines[0]).toStartWith('From,To,Time zone,As of,Budget,Currency')
  expect(lines[3]).toBe('Period start,Period end,Planned value minutes,Actual minutes,Planned value,Actual cost,Currency')
  expect(lines[4]).toBe('2026-01-05,2026-01-05,300,600,30000,60000,JPY')
})

test('refuses a Project member who does not manage the Project', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    projectAccesses: [{ projectId: 'refero', role: 'member', teamId: 'core-team' }],
  })

  const response = await request('/api/teams/core-team/projects/refero/budget-report?from=2026-01-05&to=2026-01-08')

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ProjectBudgetForbidden' })
})

test('rejects an invalid range', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const path = `/api/teams/core-team/projects/${base.assignedProjectId ?? ''}/budget-report`

  for (const query of ['?from=2026-01-05', '?from=2026-02-30&to=2026-03-01', '?from=2026-01-05&to=2026-01-01', '?from=2025-01-01&to=2026-12-31', '?from=2026-01-01&to=2026-01-02&timeZone=Mars/Base', '?from=2026-01-01&to=2026-01-02&interval=month']) {
    const response = await request(`${path}${query}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidProjectBudgetReportRequest' })
  }
})

test('does not let a manager of the same Project ID in another Team change this Team\'s Project budget', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'other-project', name: 'Other', tone: 'green' },
    ],
    projectAccesses: [
      { projectId: 'other-project', role: 'manager', teamId: 'core-team' },
      { projectId: 'refero', role: 'manager', teamId: 'other-team' },
    ],
  })

  const response = await app.request('/api/teams/core-team/projects/refero/time-budget', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountMinor: 1, currency: 'JPY', expectedRevision: 0 }),
  })

  expect(response.status).toBe(403)
  expect(await getTestAppDependencies().timeTracking.timeTrackingService.getBudget(workspaceId, 'core-team', 'project', 'refero')).toBeUndefined()
})
