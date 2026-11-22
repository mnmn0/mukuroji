import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { CognitoServiceError } from '../../../authentication'

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
  expect(await oversizedId.json()).toMatchObject({ code: 'InvalidProjectWrite' })
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

test('sets a Team profile with the leader resolved to an active Workspace member', async () => {
  const calls = configureFakeProjectClients(true, { inactiveWorkspaceMemberKeys: ['gone@example.com'] })
  const send = (body: unknown) => app.request('/api/teams/core-team/profile', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })

  const updated = await send({ description: '説明', leaderMemberKey: 'Sato@Example.com' })
  const inactive = await send({ description: '説明', leaderMemberKey: 'gone@example.com' })

  expect(updated.status).toBe(200)
  expect(calls.directoryAdministration).toContainEqual({
    method: 'updateTeamProfile',
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    input: { description: '説明', leaderMemberKey: 'sato@example.com' },
  })
  expect(inactive.status).toBe(409)
  expect(await inactive.json()).toMatchObject({ code: 'WorkspaceMemberInactive' })
})

test('adds a member to every active Project of a Team, keeping existing roles', async () => {
  const calls = configureFakeProjectClients(true)
  const send = (body: unknown) => app.request('/api/teams/core-team/members', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const added = await send({ memberKey: 'sato@example.com', role: 'member' })
  const existing = await send({ memberKey: 'demo@example.com', role: 'viewer' })
  const invalid = await send({ memberKey: 'sato@example.com', role: 'owner' })
  const missingTeam = await app.request('/api/teams/missing-team/members', {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberKey: 'sato@example.com', role: 'member' }),
  })

  expect(added.status).toBe(200)
  expect(await added.json()).toEqual({
    teamId: 'core-team',
    memberKey: 'sato@example.com',
    addedProjectIds: ['refero'],
    existingProjectIds: [],
  })
  expect(await existing.json()).toMatchObject({ addedProjectIds: [], existingProjectIds: ['refero'] })
  expect(calls.memberUpdates).toEqual([{
    directoryId: 'user#demo@example.com',
    memberKey: 'sato@example.com',
    projectId: 'refero',
    role: 'member',
  }])
  expect(invalid.status).toBe(400)
  expect(missingTeam.status).toBe(404)
})

test('denies the Team profile and Team member routes to a Workspace member', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })

  const responses = await Promise.all([
    app.request('/api/teams/core-team/profile', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ description: '', leaderMemberKey: null }),
    }),
    app.request('/api/teams/core-team/members', {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberKey: 'sato@example.com', role: 'member' }),
    }),
  ])

  expect(responses.map((response) => response.status)).toEqual([403, 403])
})

test('refuses an unknown member as inactive instead of a failed sign-in', async () => {
  configureFakeProjectClients(true, {
    profileError: new CognitoServiceError(400, 'UserNotFoundException', 'User does not exist.'),
  })

  const responses = await Promise.all([
    app.request('/api/teams/core-team/profile', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ description: '', leaderMemberKey: 'nobody' }),
    }),
    app.request('/api/teams/core-team/members', {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberKey: 'nobody', role: 'member' }),
    }),
  ])

  expect(responses.map((response) => response.status)).toEqual([409, 409])
  expect(await responses[1]?.json()).toMatchObject({ code: 'WorkspaceMemberInactive' })
})
