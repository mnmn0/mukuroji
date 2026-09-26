import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { TenantAdministrationError } from '../../domain/tenant-administration'

const {
  app,
  configureFakeProjectClients,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

test('allows analytics without a commercial entitlement or usage reservation', async () => {
  configureFakeProjectClients(true)
  const workspaces: string[] = []
  setTestAppDependencies({
    tenantLifecycleEnforcement: {
      /** Records the server-resolved scope at the lifecycle boundary. */
      async assertActive(workspaceId) { workspaces.push(workspaceId) },
    },
  })
  const response = await app.request('/api/analytics/reports', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(response.status).toBe(200)
  expect(workspaces.length).toBeGreaterThan(0)
  expect(new Set(workspaces)).toEqual(new Set(['user#demo@example.com']))
})

test('still blocks normal API access to a closing Workspace', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    tenantLifecycleEnforcement: {
      async assertActive() {
        throw new TenantAdministrationError(403, 'TenantClosing', 'The Workspace is being closed.')
      },
    },
  })
  const response = await app.request('/api/analytics/reports', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'TenantClosing' })
})

test('removes the commercial entitlement administration endpoint', async () => {
  configureFakeProjectClients(true)
  const response = await app.request('/api/tenant/entitlement', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'enterprise', seatLimit: 1 }),
  })
  expect(response.status).toBe(404)
})
