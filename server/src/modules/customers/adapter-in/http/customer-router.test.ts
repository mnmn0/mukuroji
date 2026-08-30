import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { CustomerPrincipal } from './customer-router'
import { createCustomerRouter } from './customer-router'
import { CustomerError } from '../../domain/customer'
import { InMemoryCustomerClient } from '../../customers'

/** Stable instant shared by Customer Router fixtures. */
const NOW = '2026-08-01T00:00:00.000Z'

/** Creates a router with an in-memory Customer client and deterministic authorization. */
function createTestApp(client: InMemoryCustomerClient, principal: CustomerPrincipal): Hono {
  const app = new Hono()
  app.route('/', createCustomerRouter({
    getCustomers: () => client,
    requireWorkspaceAccess: async () => principal,
    verifyTriageAccess: async () => undefined,
    verifyWorkItemAccess: async () => ({ projectId: 'project-1' }),
    verifyProjectAccess: async () => undefined,
    getTriage: () => { throw new Error('Triage is not used by this test.') },
    readJson: async (request) => await request.json(),
    mapError: (_context, error) => {
      if (error instanceof CustomerError) {
        return new Response(JSON.stringify({ code: error.code, message: error.message }), {
          status: error.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 'UnexpectedError' }), { status: 500 })
    },
  }))
  return app
}

/** Creates a Customer for Router integration tests. */
async function createCustomer(client: InMemoryCustomerClient) {
  return await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme Corporation',
    domain: 'acme.example',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'watch',
    businessValue: 80,
  })
}

/** Creates a Customer Request for Router integration tests. */
async function createRequest(client: InMemoryCustomerClient, customerId: string) {
  return await client.createRequest('workspace-1', 'member-1', {
    customerId,
    source: { kind: 'portal', canNotify: true },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW,
    importance: 'high',
  })
}

test('links a Customer Request directly to a Project through the authorized route', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await createRequest(client, customer.id)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })

  const response = await app.request(`/api/customer-requests/${request.id}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-1' }),
  })
  const body: { projectLinks: Array<{ projectId: string; linkedAt: string; linkedBy: string }> } = await response.json()

  expect(response.status).toBe(200)
  expect(body.projectLinks).toEqual([{ projectId: 'project-1', linkedAt: NOW, linkedBy: 'member-1' }])
  expect((await client.getProjectImpact('workspace-1', 'project-1')).requestCount).toBe(1)
})

test('accepts zero as the minimum Customer Request count filter', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  await createCustomer(client)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })

  const response = await app.request('/api/customers?minRequestCount=0')
  const body: { customers: Array<{ id: string }> } = await response.json()

  expect(response.status).toBe(200)
  expect(body.customers).toHaveLength(1)
})

test('projects sensitive Customer fields and request content for restricted readers', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  await createRequest(client, customer.id)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'guest-1',
    canViewSensitiveData: false,
  })

  const response = await app.request(`/api/customers/${customer.id}`)
  const body: { customer: { domain?: string }; requests: Array<{ originalMessage: string; source: { canNotify: boolean } }> } = await response.json()

  expect(response.status).toBe(200)
  expect(body.customer.domain).toBeUndefined()
  expect(body.requests[0]).toMatchObject({ originalMessage: '', source: { canNotify: false } })
})
