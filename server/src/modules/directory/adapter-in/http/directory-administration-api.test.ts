import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const {
  app,
  configureFakeProjectClients,
  resetTestApp,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const headers = {
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
}

test('lists Teams and Projects, archived ones included, for a Workspace administrator', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/directory', { headers })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    teams: [{
      id: 'core-team',
      projects: [
        { id: 'refero' },
        { id: 'old-project', archivedAt: '2026-06-06T00:00:00.000Z' },
      ],
    }],
  })
  expect(calls.directoryAdministration).toEqual([
    { method: 'get', directoryId: 'user#demo@example.com' },
  ])
})

test('renames, restores, and reorders Teams and Projects through the directory client', async () => {
  const calls = configureFakeProjectClients(true)
  const send = (path: string, method: string, body?: unknown) => app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const renamedTeam = await send('/api/teams/core-team', 'PATCH', { nameJa: 'リネーム' })
  const renamedProject = await send('/api/teams/core-team/projects/refero', 'PATCH', {
    nameJa: 'リネーム',
    tone: 'purple',
  })
  const restoredTeam = await send('/api/teams/core-team/restore', 'PATCH')
  const restoredProject = await send('/api/teams/core-team/projects/old-project/restore', 'PATCH')
  const teamOrder = await send('/api/teams/order', 'PUT', { teamIds: ['core-team'] })
  const projectOrder = await send('/api/teams/core-team/project-order', 'PUT', {
    projectIds: ['refero'],
  })

  expect(await renamedTeam.json()).toEqual({
    teamId: 'core-team',
    nameJa: 'リネーム',
    nameEn: 'Renamed',
  })
  expect(renamedProject.status).toBe(200)
  expect(await restoredTeam.json()).toEqual({ teamId: 'core-team' })
  expect(await restoredProject.json()).toEqual({ teamId: 'core-team', projectId: 'old-project' })
  expect(await teamOrder.json()).toEqual({ teamIds: ['core-team'] })
  expect(await projectOrder.json()).toEqual({ projectIds: ['refero'] })
  expect(calls.directoryAdministration.map((call) => call.method)).toEqual([
    'renameTeam',
    'renameProject',
    'restoreTeam',
    'get',
    'restoreProject',
    'reorderTeams',
    'reorderProjects',
  ])
  expect(calls.directoryAdministration[1]).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    input: { nameJa: 'リネーム', tone: 'purple' },
  })
})

test('denies directory administration to a Workspace member', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const responses = await Promise.all([
    app.request('/api/teams/directory', { headers }),
    app.request('/api/teams/core-team', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ nameJa: 'x' }),
    }),
    app.request('/api/teams/core-team/projects/refero/restore', { method: 'PATCH', headers }),
    app.request('/api/teams/order', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ teamIds: ['core-team'] }),
    }),
  ])

  expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403])
  expect(calls.directoryAdministration).toEqual([])
})

test('requires a bearer token', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/restore', { method: 'PATCH' })

  expect(response.status).toBe(401)
})
