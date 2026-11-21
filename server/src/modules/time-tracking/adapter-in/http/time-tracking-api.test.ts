import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  resetTestApp,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

test('rejects time tracking mutations from a Workspace guest even with a Project manager role', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'guest',
    role: 'manager',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'manager' }],
  })
  const headers = {
    Authorization: `Bearer ${createAccessToken()}`,
    'Content-Type': 'application/json',
  }

  const created = await app.request('/api/teams/core-team/time-entries', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workItemId: 'onboarding-friction',
      startAt: '2026-08-10T09:00:00.000Z',
      endAt: '2026-08-10T10:00:00.000Z',
      billable: true,
      currency: 'USD',
    }),
  })
  expect(created.status).toBe(403)
  expect(await created.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })

  const budget = await app.request('/api/teams/core-team/projects/refero/time-budget', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ amountMinor: 100_000, currency: 'USD', expectedRevision: 0 }),
  })
  expect(budget.status).toBe(403)
  expect(await budget.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })

  const listed = await app.request('/api/teams/core-team/time-entries', { headers })
  expect(listed.status).toBe(200)
})

test('rejects a month close from a manager of only some Projects of the Team', async () => {
  configureFakeProjectClients(false, {
    role: 'manager',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'manager' }],
  })
  const response = await app.request('/api/teams/core-team/time-periods/2026-07/close', {
    method: 'POST',
    headers: { Authorization: `Bearer ${createAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeZone: 'UTC' }),
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'TimePeriodCloseDenied' })
})
