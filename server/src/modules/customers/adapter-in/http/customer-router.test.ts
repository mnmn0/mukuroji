import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { TriageEntry } from '@mukuroji/contracts'
import type { CustomerPrincipal } from './customer-router'
import { createCustomerRouter } from './customer-router'
import { CustomerError } from '../../domain/customer'
import { InMemoryCustomerClient } from '../../customers'
import type { TriageClient } from '../../../triage'

/** Stable instant shared by Customer Router fixtures. */
const NOW = '2026-08-01T00:00:00.000Z'

/** Triage operations used by Customer Router integration tests. */
type CustomerTestTriage = Pick<TriageClient, 'getEntry' | 'associateCustomer'>

/** Creates a router with an in-memory Customer client and deterministic authorization. */
function createTestApp(
  client: InMemoryCustomerClient,
  principal: CustomerPrincipal,
  triage: CustomerTestTriage = {
    getEntry: async () => {
      throw new Error('Triage is not used by this test.')
    },
  },
): Hono {
  const app = new Hono()
  app.route('/', createCustomerRouter({
    getCustomers: () => client,
    requireWorkspaceAccess: async () => principal,
    verifyTriageAccess: async () => undefined,
    verifyWorkItemAccess: async () => ({ projectId: 'project-1' }),
    verifyProjectAccess: async () => undefined,
    getTriage: () => triage,
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

test('requires an idempotency key and validates optional Customer Request fields', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })
  const requestBody = {
    customerId: customer.id,
    source: { kind: 'portal', canNotify: true },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW,
    importance: 'high',
  }

  const missingKey = await app.request('/api/customer-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  expect(missingKey.status).toBe(400)
  expect(await missingKey.json()).toMatchObject({ code: 'InvalidCustomerInput' })

  const malformedOptionalField = await app.request('/api/customer-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'request-1',
    },
    body: JSON.stringify({ ...requestBody, contactId: 42 }),
  })
  expect(malformedOptionalField.status).toBe(400)
  expect(await malformedOptionalField.json()).toMatchObject({ code: 'InvalidCustomerInput' })

  const forgedTriageAssociation = await app.request('/api/customer-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'request-2',
    },
    body: JSON.stringify({ ...requestBody, triageEntryId: 'triage-forged' }),
  })
  expect(forgedTriageAssociation.status).toBe(400)
  expect(await forgedTriageAssociation.json()).toMatchObject({
    code: 'CustomerTriageAssociationForbidden',
  })

  const created = await app.request('/api/customer-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'request-3',
    },
    body: JSON.stringify(requestBody),
  })
  expect(created.status).toBe(201)
  const repeated = await app.request('/api/customer-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'request-3',
    },
    body: JSON.stringify(requestBody),
  })
  expect(repeated.status).toBe(201)
  expect(await repeated.json()).toEqual(await created.clone().json())
})

test('rejects restricted Customer searches before scanning sensitive fields', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  await createCustomer(client)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'guest-1',
    canViewSensitiveData: false,
  })

  const customerResponse = await app.request('/api/customers?search=acme')
  const requestResponse = await app.request('/api/customer-requests?search=sso')

  expect(customerResponse.status).toBe(403)
  expect(await customerResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(requestResponse.status).toBe(403)
  expect(await requestResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
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

test('saves an accepted Triage Entry as a Customer Request and preserves its source trace', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const entry: TriageEntry = {
    canonicalWorkItem: {
      projectId: 'project-stale',
      teamId: 'support',
      workItemId: 'work-item-1',
    },
    schemaVersion: 1,
    id: 'triage-1',
    workspaceId: 'workspace-1',
    source: { kind: 'email', sourceId: 'message-1', provider: 'mail' },
    sourcePreview: {
      title: 'SSO request',
      body: 'Please support SSO.',
      permalink: 'https://mail.example/messages/message-1',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: false,
      truncated: false,
    },
    requester: { displayName: 'Ada Lovelace', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'accepted',
    routing: { reason: 'Support', candidates: [] },
    teamId: 'support',
    permission: { visibility: 'full', canReply: true, guestVisible: true, checkedAt: NOW },
    retention: { expiresAt: '2027-08-01T00:00:00.000Z' },
    capabilities: {
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: true,
      canViewInternalContext: false,
    },
    events: [],
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const triage: CustomerTestTriage = {
    getEntry: async () => entry,
    associateCustomer: async (_workspaceId, _teamId, _entryId, _actor, input) => ({
      ...entry,
      customerId: input.customerId ?? undefined,
      contactId: input.contactId ?? undefined,
      customerRequestId: input.customerRequestId ?? undefined,
      revision: entry.revision + 1,
    }),
  }
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, triage)

  const response = await app.request('/api/teams/support/triage-entries/triage-1/customer-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: entry.revision,
      customerId: customer.id,
      importance: 'high',
    }),
  })
  const body: {
    id: string
    triageEntryId?: string
    source: { kind: string; referenceId?: string; permalink?: string }
    originalMessage: string
    workItemLinks: Array<{ teamId: string; workItemId: string; projectId?: string }>
  } = await response.json()

  expect(response.status).toBe(201)
  expect(body).toMatchObject({
    triageEntryId: entry.id,
    source: {
      kind: 'email',
      referenceId: 'message-1',
      permalink: 'https://mail.example/messages/message-1',
    },
    originalMessage: 'Please support SSO.',
    workItemLinks: [{ teamId: 'support', workItemId: 'work-item-1', projectId: 'project-1' }],
  })
  expect((await client.getRequest('workspace-1', body.id)).customerId).toBe(customer.id)
})

test('rejects an accepted Triage retry when its existing request points to another Triage Entry', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const existing = await client.createRequest('workspace-1', 'member-1', {
    customerId: customer.id,
    triageEntryId: 'different-triage-entry',
    source: { kind: 'email', provider: 'mail', referenceId: 'message-2', canNotify: true },
    originalMessage: 'Already saved elsewhere.',
    receivedAt: NOW,
    importance: 'normal',
  })
  const entry: TriageEntry = {
    schemaVersion: 1,
    id: 'triage-2',
    workspaceId: 'workspace-1',
    source: { kind: 'email', sourceId: 'message-1', provider: 'mail' },
    sourcePreview: {
      title: 'Request',
      body: 'Please support SSO.',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: false,
      truncated: false,
    },
    requester: { displayName: 'Ada Lovelace', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'accepted',
    routing: { reason: 'Support', candidates: [] },
    teamId: 'support',
    permission: { visibility: 'full', canReply: true, guestVisible: true, checkedAt: NOW },
    retention: { expiresAt: '2027-08-01T00:00:00.000Z' },
    customerRequestId: existing.id,
    capabilities: {
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: true,
      canViewInternalContext: false,
    },
    events: [],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    associateCustomer: async () => entry,
  })

  const response = await app.request('/api/teams/support/triage-entries/triage-2/customer-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: entry.revision,
      customerId: customer.id,
      importance: 'normal',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerRequestTriageMismatch' })
})

test('validates partial Triage Customer associations against the current Customer', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  })
  const inactiveContact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Grace Hopper',
  })
  await client.updateContact('workspace-1', customer.id, inactiveContact.id, 'member-1', {
    expectedRevision: inactiveContact.revision,
    status: 'inactive',
  })
  const entry: TriageEntry = {
    schemaVersion: 1,
    id: 'triage-3',
    workspaceId: 'workspace-1',
    source: { kind: 'email', sourceId: 'message-3', provider: 'mail' },
    sourcePreview: {
      title: 'Request',
      body: 'Please support SSO.',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: false,
      truncated: false,
    },
    requester: { displayName: 'Ada Lovelace', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'accepted',
    routing: { reason: 'Support', candidates: [] },
    teamId: 'support',
    permission: { visibility: 'full', canReply: true, guestVisible: true, checkedAt: NOW },
    retention: { expiresAt: '2027-08-01T00:00:00.000Z' },
    customerId: customer.id,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: {
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: true,
      canViewInternalContext: false,
    },
    events: [],
  }
  const association: CustomerTestTriage = {
    getEntry: async () => entry,
    associateCustomer: async (_workspaceId, _teamId, _entryId, _actor, input) => ({
      ...entry,
      ...(input.customerId === null ? { customerId: undefined } : {}),
      ...(input.contactId === null ? { contactId: undefined } : input.contactId === undefined ? {} : { contactId: input.contactId }),
      ...(input.customerRequestId === null ? { customerRequestId: undefined } : input.customerRequestId === undefined ? {} : { customerRequestId: input.customerRequestId }),
      revision: entry.revision + 1,
    }),
  }
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, association)

  const inactiveResponse = await app.request('/api/teams/support/triage-entries/triage-3/customer', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: entry.revision, contactId: inactiveContact.id }),
  })

  expect(inactiveResponse.status).toBe(409)
  expect(await inactiveResponse.json()).toMatchObject({ code: 'CustomerContactInactive' })

  const response = await app.request('/api/teams/support/triage-entries/triage-3/customer', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: entry.revision, contactId: contact.id }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ contactId: contact.id })

  const clearedResponse = await app.request('/api/teams/support/triage-entries/triage-3/customer', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: entry.revision,
      customerId: null,
      contactId: null,
      customerRequestId: null,
    }),
  })

  const clearedBody: { id: string; revision: number; customerId?: string } = await clearedResponse.json()
  expect(clearedResponse.status).toBe(200)
  expect(clearedBody).toMatchObject({
    id: entry.id,
    revision: entry.revision + 1,
  })
  expect(clearedBody).not.toHaveProperty('customerId')
})
