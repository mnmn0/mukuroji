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

test('answers an expected directory failure with its status and code', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/order', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ teamIds: ['stale-team'] }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'DirectoryOrderConflict',
    message: 'The Team list changed.',
  })
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

test('reads the archive impact only for an active Team or Project of a Workspace administrator', async () => {
  configureFakeProjectClients(true)

  const missingTeam = await app.request('/api/teams/missing-team/archive-impact', { headers })
  const archivedProject = await app.request(
    '/api/teams/core-team/projects/old-project/archive-impact',
    { headers },
  )
  const oversizedId = await app.request(`/api/teams/${'x'.repeat(257)}/archive-impact`, { headers })

  expect(missingTeam.status).toBe(404)
  expect(archivedProject.status).toBe(404)
  expect(oversizedId.status).toBe(400)
})

test('denies the archive impact to a Workspace member', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const responses = await Promise.all([
    app.request('/api/teams/core-team/archive-impact', { headers }),
    app.request('/api/teams/core-team/projects/refero/archive-impact', { headers }),
  ])

  expect(responses.map((response) => response.status)).toEqual([403, 403])
  expect(calls.directoryAdministration).toEqual([])
})
