import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  resetTestApp,
} = createApiTestHarness()
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'

afterEach(() => {
  resetTestApp()
})

test('returns Workspace role and active status for the current user', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/auth/me', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    workspaceRole: 'admin',
    workspaceMemberStatus: 'active',
  })
})

test('blocks a deactivated Workspace member before any business API read', async () => {
  const calls = configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })

  const response = await app.request('/api/teams/projects', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'WorkspaceAccessDenied',
    message: 'Workspace access is denied.',
  })
  expect(calls.directoryReads).toEqual([])
})

test('keeps guest Workspace members read-only even when they have a project role', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'guest' })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Guest must not create this task',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('limits Workspace structure changes to owners and admins', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Unauthorized team' }),
  })

  expect(response.status).toBe(403)
  expect(calls.teamCreates).toEqual([])
})

test('rejects inactive Workspace members as task assignment candidates', async () => {
  const calls = configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['sato@example.com'],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Inactive assignee task',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(409)
  expect(calls.issueCreates).toEqual([])
})
