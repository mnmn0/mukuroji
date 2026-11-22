import {
  createApiTestHarness,
} from '../test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createWorkspaceWorkItemCalendarPolicy,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeResult,
  type WorkCalendarResponse,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { ProjectDataError } from '../../modules/directory'
import type {
  TeamIssueResponseItem,
  TeamWorkItemHierarchyEntry,
  WorkItemScheduleCascadeUpdate,
} from '../../modules/work-items'
import { runWithAppDependencies } from '../shared/app-dependencies'
import { applySharedCalendarToNewSchedule } from '../shared/workspace-calendar'

afterEach(() => {
  resetTestApp()
})

/** Workspace calendar a Work Item created from the default settings takes, without a source. */
const legacyPolicy: WorkItemScheduleCalendarPolicy = createWorkspaceWorkItemCalendarPolicy(
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
)

/** The same rules marked as following the shared calendar. */
const sharedPolicy: WorkItemScheduleCalendarPolicy = { ...legacyPolicy, calendarSource: 'shared' }

/**
 * Builds a Monday-to-Friday date-range schedule in the first week of December 2026.
 *
 * @param calendarPolicy - Calendar policy of the schedule.
 * @returns The schedule.
 */
function weekSchedule(calendarPolicy: WorkItemScheduleCalendarPolicy): WorkItemSchedule {
  return { mode: 'date-range', calendarPolicy, startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 }
}

/**
 * Reads one fake Team Work Item to copy into fixtures.
 *
 * @returns The first fake Work Item of the Team.
 */
async function readBaseIssue(): Promise<TeamIssueResponseItem> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const issue = issues[0]
  if (!issue) throw new Error('The fake Team has no Work Item.')
  return issue
}

/**
 * Installs Team Work Items and records the schedule rewrites.
 *
 * @param issues - Work Items the Team returns.
 * @returns The recorded rewrite batches.
 */
function installWorkItems(issues: TeamIssueResponseItem[]): WorkItemScheduleCascadeUpdate[][] {
  const batches: WorkItemScheduleCascadeUpdate[][] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        return issues.map((issue): TeamWorkItemHierarchyEntry => ({ issue, hierarchyRank: issue.id }))
      },
      async updateTeamIssueSchedules(_directoryId, updates) {
        batches.push([...updates])
        return { issues: [], confirmedSchedules: [] }
      },
    }),
  })
  return batches
}

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('reads the Workspace calendar as the Team default until the Team saves its own', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/work-calendar')
  expect(response.status).toBe(200)
  const body = await response.json() as WorkCalendarResponse
  expect(body).toEqual({
    scope: { kind: 'team', teamId: 'core-team' },
    changeAdjustment: 'keep-duration',
    resolvedPolicy: sharedPolicy,
    inheritedPolicy: sharedPolicy,
    canManage: true,
  })
})

test('previews a Team holiday with either adjustment and skips Work Items with their own calendar', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  installWorkItems([
    { ...base, id: 'shared', schedule: weekSchedule(sharedPolicy) },
    { ...base, id: 'legacy', schedule: weekSchedule(legacyPolicy) },
    {
      ...base,
      id: 'custom',
      schedule: weekSchedule({ ...legacyPolicy, workingWeekdays: ['monday', 'tuesday'] }),
    },
  ])
  const overrides = { additionalHolidays: ['2026-12-09'] }

  const keepDuration = await request('/api/teams/core-team/work-calendar/preview', 'POST', {
    overrides,
    adjustment: 'keep-duration',
  })
  expect(keepDuration.status).toBe(200)
  const keepDurationBody = await keepDuration.json() as WorkCalendarChangeImpact
  expect(keepDurationBody).toMatchObject({ followingCount: 2, changedCount: 2, fallbackToKeepDurationCount: 0 })
  expect(keepDurationBody.examples.map((example) => [example.workItemId, example.after])).toEqual([
    ['legacy', { startDate: '2026-12-07', endDate: '2026-12-14', durationDays: 5 }],
    ['shared', { startDate: '2026-12-07', endDate: '2026-12-14', durationDays: 5 }],
  ])

  const keepEndDate = await request('/api/teams/core-team/work-calendar/preview', 'POST', {
    overrides,
    adjustment: 'keep-end-date',
  })
  const keepEndDateBody = await keepEndDate.json() as WorkCalendarChangeImpact
  expect(keepEndDateBody.examples[0]?.after).toEqual({
    startDate: '2026-12-07',
    endDate: '2026-12-11',
    durationDays: 4,
  })
})

test('saves a Team calendar, rewrites the following Work Items, and refuses a stale revision', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const batches = installWorkItems([
    { ...base, id: 'shared', revision: 3, schedule: weekSchedule(sharedPolicy) },
    { ...base, id: 'legacy', revision: 4, schedule: weekSchedule(legacyPolicy) },
  ])
  const saved = await request('/api/teams/core-team/work-calendar', 'PUT', {
    overrides: { additionalHolidays: ['2026-12-09'] },
    adjustment: 'keep-end-date',
    expectedRevision: 0,
  })
  expect(saved.status).toBe(200)
  const result = await saved.json() as WorkCalendarChangeResult
  expect(result).toMatchObject({
    calendar: {
      scope: { kind: 'team', teamId: 'core-team' },
      additionalHolidays: ['2026-12-09'],
      changeAdjustment: 'keep-end-date',
      revision: 1,
    },
    updatedCount: 2,
    conflictCount: 0,
  })
  const updates = batches.flat()
  expect(updates.map((update) => [update.workItemId, update.expectedRevision])).toEqual([
    ['legacy', 4],
    ['shared', 3],
  ])
  for (const update of updates) {
    expect(update.schedule).toMatchObject({ durationDays: 4, endDate: '2026-12-11' })
    expect(update.schedule.calendarPolicy.calendarSource).toBe('shared')
    expect(update.schedule.calendarPolicy.holidays).toContain('2026-12-09')
  }

  const read = await request('/api/teams/core-team/work-calendar')
  expect(await read.json()).toMatchObject({ changeAdjustment: 'keep-end-date', calendar: { revision: 1 } })

  // A retry of the same save resumes it instead of failing on the revision it already took.
  const resumed = await request('/api/teams/core-team/work-calendar', 'PUT', {
    overrides: { additionalHolidays: ['2026-12-09'] },
    adjustment: 'keep-end-date',
    expectedRevision: 0,
  })
  expect(resumed.status).toBe(200)
  // The fake store keeps the old schedules, so the shared Work Item still needs its rewrite.
  expect(await resumed.json()).toMatchObject({ calendar: { revision: 1 }, updatedCount: 1, conflictCount: 0 })

  const stale = await request('/api/teams/core-team/work-calendar', 'PUT', {
    overrides: { additionalHolidays: [] },
    adjustment: 'keep-duration',
    expectedRevision: 0,
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ code: 'WorkCalendarConflict' })
})

test('changes only the Work Items of a Project when its calendar changes', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const projectId = base.assignedProjectId
  if (!projectId) throw new Error('The fake Work Item has no Project.')
  installWorkItems([
    { ...base, id: 'in-project', schedule: weekSchedule(sharedPolicy) },
    { ...base, id: 'no-project', assignedProjectId: undefined, schedule: weekSchedule(sharedPolicy) },
    // A shared Work Item of another Project with outdated rules is not this Project's to rewrite.
    {
      ...base,
      id: 'other-project',
      assignedProjectId: `${projectId}-other`,
      schedule: weekSchedule({ ...sharedPolicy, workingWeekdays: ['monday', 'tuesday', 'wednesday'] }),
    },
  ])
  const response = await request('/api/teams/core-team/work-calendar/preview', 'POST', {
    projectId,
    overrides: { workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday'], additionalHolidays: [] },
    adjustment: 'keep-duration',
  })
  expect(response.status).toBe(200)
  const impact = await response.json() as WorkCalendarChangeImpact
  expect(impact.changedCount).toBe(1)
  expect(impact.examples.map((example) => [example.workItemId, example.after.endDate])).toEqual([
    ['in-project', '2026-12-14'],
  ])
})

test('refuses a calendar change from a member who manages neither the Team nor the Project', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', role: 'viewer' })
  const response = await request('/api/teams/core-team/work-calendar/preview', 'POST', {
    overrides: { additionalHolidays: [] },
    adjustment: 'keep-duration',
  })
  expect(response.status).toBe(403)
  const read = await request('/api/teams/core-team/work-calendar')
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ canManage: false })
})

test('rejects calendar rules that are not valid', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/work-calendar/preview', 'POST', {
    overrides: { additionalHolidays: ['2026-02-30'] },
    adjustment: 'keep-duration',
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidWorkCalendarRequest' })
})

test('gives a new Work Item that follows the shared calendar the Team calendar the server resolves', async () => {
  configureFakeProjectClients(true)
  installWorkItems([])
  const saved = await request('/api/teams/core-team/work-calendar', 'PUT', {
    overrides: { additionalHolidays: ['2026-12-09'] },
    adjustment: 'keep-duration',
    expectedRevision: 0,
  })
  expect(saved.status).toBe(200)
  const created = await runWithAppDependencies(getTestAppDependencies(), () => applySharedCalendarToNewSchedule(
    'user#demo@example.com',
    { teamId: 'core-team' },
    weekSchedule(sharedPolicy),
  ))
  expect(created).toMatchObject({
    startDate: '2026-12-07',
    endDate: '2026-12-11',
    durationDays: 4,
    calendarPolicy: { calendarSource: 'shared' },
  })
  const custom = weekSchedule(legacyPolicy)
  expect(await runWithAppDependencies(getTestAppDependencies(), () =>
    applySharedCalendarToNewSchedule('user#demo@example.com', { teamId: 'core-team' }, custom))).toBe(custom)
})

test('applies the saved Workspace calendar only to Work Items whose rules differ from it', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const batches = installWorkItems([
    { ...base, id: 'legacy', revision: 2, schedule: weekSchedule(legacyPolicy) },
    { ...base, id: 'current', revision: 3, schedule: weekSchedule(sharedPolicy) },
    {
      ...base,
      id: 'stale',
      revision: 4,
      schedule: {
        mode: 'date-range',
        calendarPolicy: { ...sharedPolicy, holidays: [...sharedPolicy.holidays, '2026-12-09'] },
        startDate: '2026-12-07',
        endDate: '2026-12-11',
        durationDays: 4,
      },
    },
  ])
  const response = await request('/api/workspace/work-calendar/apply', 'POST', { adjustment: 'keep-duration' })
  expect(response.status).toBe(200)
  const result = await response.json() as WorkCalendarChangeResult
  // A Workspace change leaves rows without a calendar source alone.
  expect(result).toMatchObject({ impact: { followingCount: 2, changedCount: 1 }, updatedCount: 1, conflictCount: 0 })
  const updates = batches.flat()
  expect(updates.map((update) => [update.workItemId, update.expectedRevision])).toEqual([['stale', 4]])
  expect(updates[0]?.schedule).toMatchObject({ endDate: '2026-12-10', durationDays: 4 })
  expect(updates[0]?.schedule.calendarPolicy.holidays).not.toContain('2026-12-09')
})

test('retries a conflicting rewrite from a fresh read so an adopted older Work Item still follows', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  let revision = 4
  const writes: WorkItemScheduleCascadeUpdate[][] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        const issue: TeamIssueResponseItem = { ...base, id: 'legacy', revision, schedule: weekSchedule(legacyPolicy) }
        return [{ issue, hierarchyRank: issue.id }]
      },
      async updateTeamIssueSchedules(_directoryId, updates) {
        writes.push([...updates])
        // Someone else edits the Work Item between the plan and the first write.
        if (writes.length === 1) {
          revision = 5
          throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'The Work Item changed.')
        }
        return { issues: [], confirmedSchedules: [] }
      },
    }),
  })
  const saved = await request('/api/teams/core-team/work-calendar', 'PUT', {
    overrides: { additionalHolidays: ['2026-12-09'] },
    adjustment: 'keep-end-date',
    expectedRevision: 0,
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ updatedCount: 1, conflictCount: 0 })
  expect(writes.map((batch) => batch.map((update) => update.expectedRevision))).toEqual([[4], [5]])
  expect(writes[1]?.[0]?.schedule.calendarPolicy.calendarSource).toBe('shared')
})
