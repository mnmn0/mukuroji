import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createDefaultDueDateWorkItemSchedule,
  type ProjectScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { ProjectDataError } from '../../../directory'
import type { TeamIssueResponseItem, TeamWorkItemHierarchyEntry } from '../../index'

afterEach(() => {
  resetTestApp()
})

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
 * Builds one Team Work Item entry.
 *
 * @param base - Work Item copied for the entry.
 * @param id - Work Item ID.
 * @param overrides - Fields replacing the base values.
 * @returns The entry.
 */
function entry(
  base: TeamIssueResponseItem,
  id: string,
  overrides: Partial<TeamIssueResponseItem> = {},
): TeamWorkItemHierarchyEntry {
  return { issue: { ...base, ...overrides, id }, hierarchyRank: id }
}

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

test('captures a Project baseline and returns only readable entries', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const projectId = base.assignedProjectId
  if (!projectId) throw new Error('The fake Work Item has no Project.')
  let schedule = createDefaultDueDateWorkItemSchedule('2026-12-10')
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        return [
          entry(base, 'task-1', { schedule }),
          entry(base, 'other-project', { assignedProjectId: 'secret-project' }),
        ]
      },
    }),
  })
  const path = `/api/teams/core-team/projects/${projectId}/schedule-baseline`

  const empty = await request(path)
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ teamId: 'core-team', projectId, baseline: null })

  const captured = await request(path, 'POST')
  expect(captured.status).toBe(201)
  const capturedBody = await captured.json() as ProjectScheduleBaselineResponse
  expect(capturedBody.baseline?.revision).toBe(1)
  expect(capturedBody.baseline?.entries).toEqual([{ workItemId: 'task-1', endDate: '2026-12-10' }])

  schedule = createDefaultDueDateWorkItemSchedule('2026-12-15')
  const read = await request(path)
  expect(read.status).toBe(200)
  const readBody = await read.json() as ProjectScheduleBaselineResponse
  expect(readBody.baseline?.entries).toEqual([{ workItemId: 'task-1', endDate: '2026-12-10' }])

  const again = await request(path, 'POST')
  expect((await again.json() as ProjectScheduleBaselineResponse).baseline).toMatchObject({
    revision: 2,
    entries: [{ workItemId: 'task-1', endDate: '2026-12-15' }],
  })
})

test('answers 404 for a Project outside the Team', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/projects/not-in-team/schedule-baseline', 'POST')
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ code: 'ProjectNotFound' })
})

test('answers 409 with its code when a capture conflicts', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const projectId = base.assignedProjectId ?? 'missing'
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        return [entry(base, 'task-1')]
      },
    }),
    scheduleBaselines: {
      async get() {
        return null
      },
      async capture() {
        throw new ProjectDataError(409, 'ScheduleBaselineConflict', 'The schedule baseline changed.')
      },
    },
  })
  const response = await request(`/api/teams/core-team/projects/${projectId}/schedule-baseline`, 'POST')
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'ScheduleBaselineConflict' })
})

test('refuses a capture by a reader without Team access with 403', async () => {
  configureFakeProjectClients(false)
  const base = await readBaseIssue()
  const response = await request(
    `/api/teams/core-team/projects/${base.assignedProjectId ?? 'missing'}/schedule-baseline`,
    'POST',
  )
  // Without any access to the Team, the Team check refuses before the Project is looked up.
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
})

test('refuses a capture by a Project viewer with 403', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const base = await readBaseIssue()
  const response = await request(
    `/api/teams/core-team/projects/${base.assignedProjectId ?? 'missing'}/schedule-baseline`,
    'POST',
  )
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ScheduleBaselineForbidden' })
})
