import { expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import type { TriageEntry } from '@mukuroji/contracts'
import type {
  CustomerAuthorizationScope,
  CustomerPrincipal,
  CustomerRouterDependencies,
} from './customer-router'
import { createCustomerRouter } from './customer-router'
import { CustomerError } from '../../domain/customer'
import { InMemoryCustomerClient } from '../../customers'
import type { TriageClient } from '../../../triage'

/** Stable instant shared by Customer Router fixtures. */
const NOW = '2026-08-01T00:00:00.000Z'

/**
 * Triage operations used by Customer Router integration tests.
 */
type CustomerTestTriage = Pick<TriageClient, 'getEntry' | 'associateCustomer' | 'listCustomerAssociations' | 'clearCustomerAssociations'>

/** Optional live-resource authorization replacements used by router tests. */
type CustomerTestAuthorization = Partial<Pick<
  CustomerRouterDependencies,
  'verifyCustomerOwner' | 'verifyWorkItemAccess' | 'verifyProjectAccess' | 'createTriageAuthorizationConditionChecks'
>>

/** Creates a router with an in-memory Customer client and deterministic authorization. */
function createTestApp(
  client: InMemoryCustomerClient,
  principal: CustomerPrincipal,
  triage: CustomerTestTriage = {
    getEntry: async () => {
      throw new Error('Triage is not used by this test.')
    },
    listCustomerAssociations: async () => [],
    clearCustomerAssociations: async () => undefined,
  },
  requireWorkspaceAccess: CustomerRouterDependencies['requireWorkspaceAccess'] = async () => principal,
  authorization: CustomerTestAuthorization = {},
): Hono {
  const app = new Hono()
  app.route('/', createCustomerRouter({
    getCustomers: () => client,
    requireWorkspaceAccess,
    verifyTriageAccess: async () => undefined,
    verifyCustomerOwner: authorization.verifyCustomerOwner ?? (async () => []),
    verifyWorkItemAccess: authorization.verifyWorkItemAccess ?? (async () => ({ projectId: 'project-1', isCompleted: false })),
    verifyProjectAccess: authorization.verifyProjectAccess ?? (async () => ({})),
    createTriageAuthorizationConditionChecks:
      authorization.createTriageAuthorizationConditionChecks ?? (async () => []),
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

test('fences Customer owner assignment through the authorization boundary', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const ownerChecks: Array<[string, string]> = []
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    undefined,
    undefined,
    {
      verifyCustomerOwner: async (_principal, ownerUserId) => {
        ownerChecks.push(['workspace-1', ownerUserId])
        return []
      },
    },
  )

  const response = await app.request('/api/customers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'customer-owner-1' },
    body: JSON.stringify({
      name: 'Acme Corporation',
      ownerUserId: 'owner-1',
      tier: 'enterprise',
      size: 'enterprise',
      status: 'active',
      health: 'healthy',
    }),
  })

  expect(response.status).toBe(201)
  expect(ownerChecks).toEqual([['workspace-1', 'owner-1']])
})

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

/** Creates a minimal accepted Triage Entry with a Customer reverse link. */
function createCustomerAssociationEntry(customerId: string, contactId?: string): TriageEntry {
  return {
    schemaVersion: 1,
    id: 'triage-customer-1',
    workspaceId: 'workspace-1',
    source: { kind: 'email', sourceId: 'message-customer-1', provider: 'mail' },
    sourcePreview: {
      title: 'Customer request',
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
    customerId,
    ...(contactId === undefined ? {} : { contactId }),
    revision: 1,
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
}

test('requires and replays Customer creation idempotency keys', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })
  const request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'customer-create-1',
    },
    body: JSON.stringify({
      name: 'Acme Corporation',
      domain: 'acme.example',
      tier: 'enterprise',
      size: 'enterprise',
      status: 'active',
      health: 'healthy',
    }),
  }

  const missingKey = await app.request('/api/customers', {
    method: request.method,
    headers: { 'content-type': 'application/json' },
    body: request.body,
  })
  const first = await app.request('/api/customers', request)
  const firstBody: { id: string } = await first.clone().json()
  const repeated = await app.request('/api/customers', request)
  const conflicting = await app.request('/api/customers', {
    ...request,
    body: JSON.stringify({
      name: 'Different Corporation',
      domain: 'different.example',
      tier: 'enterprise',
      size: 'enterprise',
      status: 'active',
      health: 'healthy',
    }),
  })

  expect(missingKey.status).toBe(400)
  expect(await missingKey.json()).toMatchObject({ code: 'InvalidCustomerInput' })
  expect(first.status).toBe(201)
  expect(repeated.status).toBe(201)
  expect(await repeated.json()).toEqual(firstBody)
  expect(conflicting.status).toBe(409)
  expect(await conflicting.json()).toMatchObject({ code: 'CustomerIdempotencyConflict' })
  await expect(client.listCustomers('workspace-1')).resolves.toMatchObject({ customers: [{ id: firstBody.id }] })
})

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
  expect((await client.getProjectImpact('workspace-1', 'project-1', async () => 'project-1')).requestCount).toBe(1)
})

test('prepares a completion candidate when the link route targets a completed Work Item', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await createRequest(client, customer.id)
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    undefined,
    undefined,
    { verifyWorkItemAccess: async () => ({ projectId: 'project-1', isCompleted: true }) },
  )

  const response = await app.request(`/api/customer-requests/${request.id}/work-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId: 'support', workItemId: 'work-item-1' }),
  })

  expect(response.status).toBe(200)
  await expect(client.listCompletionNotifications('workspace-1', 'support', 'work-item-1', async () => true)).resolves.toMatchObject([{
    requestId: request.id,
  }])
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

test('rejects out-of-range business-value filters before querying or saving a view', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })

  for (const value of ['-1', '101']) {
    const queryResponse = await app.request(`/api/customers?minBusinessValue=${value}`)
    expect(queryResponse.status).toBe(400)
    expect(await queryResponse.json()).toMatchObject({ code: 'InvalidCustomerInput' })

    const viewResponse = await app.request('/api/customers/views', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `out-of-range-${value}`,
      },
      body: JSON.stringify({
        name: `Invalid ${value}`,
        filters: { minBusinessValue: Number(value) },
      }),
    })
    expect(viewResponse.status).toBe(400)
    expect(await viewResponse.json()).toMatchObject({ code: 'InvalidCustomerInput' })
  }

  expect(await client.listSavedViews('workspace-1')).toEqual([])
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

test('requires an idempotency key and replays Customer Contact creation safely', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })
  const body = JSON.stringify({ name: 'Ada Lovelace' })

  const missingKey = await app.request(`/api/customers/${customer.id}/contacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(missingKey.status).toBe(400)
  expect(await missingKey.json()).toMatchObject({ code: 'InvalidCustomerInput' })

  const created = await app.request(`/api/customers/${customer.id}/contacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'contact-1' },
    body,
  })
  const repeated = await app.request(`/api/customers/${customer.id}/contacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'contact-1' },
    body,
  })
  const conflicting = await app.request(`/api/customers/${customer.id}/contacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'contact-1' },
    body: JSON.stringify({ name: 'Grace Hopper' }),
  })

  expect(created.status).toBe(201)
  expect(repeated.status).toBe(201)
  expect(await repeated.json()).toEqual(await created.clone().json())
  expect(conflicting.status).toBe(409)
  expect(await client.listContacts('workspace-1', customer.id)).toHaveLength(1)
})

test('rejects restricted Customer searches before scanning sensitive fields', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  await client.createSavedView('workspace-1', 'member-1', {
    name: 'Sensitive saved view',
    filters: { search: 'acme.example', minBusinessValue: 80, sortBy: 'businessValue' },
  })
  const request = await createRequest(client, customer.id)
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
  })
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'guest-1',
    canViewSensitiveData: false,
  })

  const customerResponse = await app.request('/api/customers?search=acme')
  const reportBusinessValueFilterResponse = await app.request('/api/customers/report?minBusinessValue=80')
  const businessValueFilterResponse = await app.request('/api/customers?minBusinessValue=80')
  const businessValueSortResponse = await app.request('/api/customers?sortBy=businessValue')
  const requestResponse = await app.request('/api/customer-requests?search=sso')
  const viewsResponse = await app.request('/api/customers/views')
  const impactResponse = await app.request('/api/teams/support/issues/work-item-1/customer-impact')

  expect(customerResponse.status).toBe(403)
  expect(await customerResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(reportBusinessValueFilterResponse.status).toBe(403)
  expect(await reportBusinessValueFilterResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(businessValueFilterResponse.status).toBe(403)
  expect(await businessValueFilterResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(businessValueSortResponse.status).toBe(403)
  expect(await businessValueSortResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(requestResponse.status).toBe(403)
  expect(await requestResponse.json()).toMatchObject({ code: 'CustomerSearchRestricted' })
  expect(viewsResponse.status).toBe(200)
  expect(await viewsResponse.json()).toMatchObject({
    views: [{ filters: { sortBy: 'name' } }],
  })
  expect(impactResponse.status).toBe(200)
  const impactBody: { highestBusinessValue?: number; customers: Array<{ customerId: string; businessValue?: number; requestCount: number }> } = await impactResponse.json()
  expect(impactBody).toMatchObject({
    businessValueTotal: 0,
    prioritySignal: 'high',
    customers: [{ customerId: customer.id, requestCount: 1 }],
  })
  expect(impactBody.highestBusinessValue).toBeUndefined()
  expect(impactBody.customers[0]?.businessValue).toBeUndefined()
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

test('projects sensitive fields from restricted Customer mutation responses', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: false,
  })

  const response = await app.request(`/api/customers/${customer.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: customer.revision,
      domain: 'updated.example',
      businessValue: 90,
      notes: 'restricted note',
    }),
  })
  const body: { domain?: string; businessValue?: number; notes?: string } = await response.json()

  expect(response.status).toBe(200)
  expect(body.domain).toBeUndefined()
  expect(body.businessValue).toBeUndefined()
  expect(body.notes).toBeUndefined()
})

test('filters Customer relationships through live Team and Project access', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await createRequest(client, customer.id)
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'hidden-team',
    workItemId: 'hidden-work-item',
    projectId: 'hidden-project',
  })
  await client.linkRequestToProject('workspace-1', request.id, 'member-1', {
    projectId: 'hidden-project',
  })
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    undefined,
    undefined,
    {
      verifyWorkItemAccess: async (_principal, teamId) => {
        if (teamId === 'hidden-team') throw { status: 403 }
        return { projectId: 'project-1', isCompleted: false }
      },
      verifyProjectAccess: async (_principal, projectId) => {
        if (projectId === 'hidden-project') throw { status: 403 }
        return {}
      },
    },
  )

  const detailResponse = await app.request(`/api/customers/${customer.id}`)
  const detail: {
    requests: Array<{ workItemLinks: unknown[]; projectLinks: unknown[] }>
    workItems: unknown[]
    projects: unknown[]
  } = await detailResponse.json()
  const workItemsResponse = await app.request(`/api/customers/${customer.id}/work-items`)

  expect(detailResponse.status).toBe(200)
  expect(detail).toMatchObject({
    requests: [{ workItemLinks: [], projectLinks: [] }],
    workItems: [],
    projects: [],
  })
  expect(workItemsResponse.status).toBe(200)
  expect(await workItemsResponse.json()).toEqual({ workItems: [] })
})

test('clears Triage Customer associations before deleting a Customer', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const calls: Array<Parameters<NonNullable<CustomerTestTriage['clearCustomerAssociations']>>> = []
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    {
      getEntry: async () => {
        throw new Error('Triage entry is not read by deletion cleanup tests.')
      },
      listCustomerAssociations: async () => [],
      clearCustomerAssociations: async (...args) => {
        calls.push(args)
      },
    },
  )

  const response = await app.request(
    `/api/customers/${customer.id}?expectedRevision=${customer.revision}`,
    { method: 'DELETE' },
  )

  expect(response.status).toBe(204)
  expect(calls.map(([workspaceId, customerId, actorId]) => [workspaceId, customerId, actorId]))
    .toEqual([['workspace-1', customer.id, 'member-1']])
  expect(calls[0]?.[3]).toEqual(expect.any(Function))
  await expect(client.getCustomer('workspace-1', customer.id)).rejects.toMatchObject({
    code: 'CustomerNotFound',
  })
})

test('rejects deleting a Contact that still has a Triage reverse link', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  }, 'delete-contact')
  const entry = createCustomerAssociationEntry(customer.id, contact.id)
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    {
      getEntry: async () => entry,
      listCustomerAssociations: async (_workspaceId, customerId) => customerId === customer.id ? [entry] : [],
    },
  )

  const response = await app.request(
    `/api/customers/${customer.id}/contacts/${contact.id}?expectedRevision=${contact.revision}`,
    { method: 'DELETE' },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerContactTriageAssociation' })
  await expect(client.getContact('workspace-1', customer.id, contact.id)).resolves.toMatchObject({ id: contact.id })
})

test('rejects merging a Contact that still has a Triage reverse link', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const source = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  }, 'merge-source-contact')
  const target = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Grace Hopper',
  }, 'merge-target-contact')
  const entry = createCustomerAssociationEntry(customer.id, source.id)
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    {
      getEntry: async () => entry,
      listCustomerAssociations: async (_workspaceId, customerId) => customerId === customer.id ? [entry] : [],
    },
  )

  const response = await app.request(`/api/customer-contacts/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetContactId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerContactTriageAssociation' })
  await expect(client.getContact('workspace-1', customer.id, source.id)).resolves.toMatchObject({ id: source.id })
})

test('cancels a Contact deletion when the locked Triage rescan finds a reverse link', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  }, 'cancel-delete-contact')
  const entry = createCustomerAssociationEntry(customer.id, contact.id)
  let listCalls = 0
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => {
      listCalls += 1
      return listCalls === 1 ? [] : [entry]
    },
  })

  const response = await app.request(
    `/api/customers/${customer.id}/contacts/${contact.id}?expectedRevision=${contact.revision}`,
    { method: 'DELETE' },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerContactTriageAssociation' })
  expect(listCalls).toBe(2)
  await expect(client.getContact('workspace-1', customer.id, contact.id)).resolves.toMatchObject({ id: contact.id })
})

test('cancels a Contact merge when the locked Triage rescan finds a reverse link', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const source = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  }, 'cancel-merge-source-contact')
  const target = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Grace Hopper',
  }, 'cancel-merge-target-contact')
  const entry = createCustomerAssociationEntry(customer.id, source.id)
  let listCalls = 0
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => {
      listCalls += 1
      return listCalls === 1 ? [] : [entry]
    },
  })

  const response = await app.request(`/api/customer-contacts/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetContactId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerContactTriageAssociation' })
  expect(listCalls).toBe(2)
  await expect(client.getContact('workspace-1', customer.id, source.id)).resolves.toMatchObject({ id: source.id })
})

test('repoints Triage Customer associations before merging Customers', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const source = await createCustomer(client)
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex Industries',
    domain: 'globex.example',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
  })
  const entry = createCustomerAssociationEntry(source.id)
  const associations: Array<{ customerId: string | null; contactId: string | null; customerRequestId: string | null }> = []
  const operations: unknown[] = []
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => [entry],
    associateCustomer: async (_workspaceId, _teamId, _entryId, _actor, input, _authorization, operation) => {
      associations.push({
        customerId: input.customerId ?? null,
        contactId: input.contactId ?? null,
        customerRequestId: input.customerRequestId ?? null,
      })
      operations.push(operation)
      return { ...entry, customerId: input.customerId ?? undefined, revision: entry.revision + 1 }
    },
  })

  const response = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetCustomerId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(200)
  expect(associations).toEqual([{ customerId: target.id, contactId: null, customerRequestId: null }])
  expect(operations).toEqual([{
    kind: 'merge',
    sourceCustomerId: source.id,
    targetCustomerId: target.id,
  }])
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })
  await expect(client.getCustomer('workspace-1', target.id)).resolves.toMatchObject({ customer: { id: target.id } })
})

test('preflights every Triage scope before starting a Customer merge', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const source = await createCustomer(client)
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex Industries',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
  })
  const entry = createCustomerAssociationEntry(source.id)
  const beginCustomerMerge = spyOn(client, 'beginCustomerMerge')
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    {
      getEntry: async () => entry,
      listCustomerAssociations: async () => [entry],
      associateCustomer: async () => entry,
    },
    undefined,
    {
      createTriageAuthorizationConditionChecks: async () => {
        throw new CustomerError(403, 'CustomerTriageAuthorizationChanged', 'Triage access is no longer available.')
      },
    },
  )

  const response = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetCustomerId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(403)
  expect(beginCustomerMerge).not.toHaveBeenCalled()
})

test('rescans Triage associations after locking a Customer merge', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const source = await createCustomer(client)
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex Industries',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
  })
  const entry = createCustomerAssociationEntry(source.id)
  let listCalls = 0
  let associationCalls = 0
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => {
      listCalls += 1
      return listCalls === 1 ? [] : [entry]
    },
    associateCustomer: async () => {
      associationCalls += 1
      return { ...entry, customerId: target.id, revision: entry.revision + 1 }
    },
  })

  const response = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetCustomerId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(200)
  expect(listCalls).toBe(2)
  expect(associationCalls).toBe(1)
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })
})

test('retains a Customer merge marker when the locked Triage rescan loses authorization', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const source = await createCustomer(client)
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex Industries',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
  })
  const entry = createCustomerAssociationEntry(source.id)
  let authorizationCalls = 0
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => [entry],
    associateCustomer: async () => entry,
  }, undefined, {
    createTriageAuthorizationConditionChecks: async () => {
      authorizationCalls += 1
      if (authorizationCalls === 2) {
        throw new CustomerError(403, 'CustomerTriageAuthorizationChanged', 'Triage access is no longer available.')
      }
      return []
    },
  })

  const response = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetCustomerId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(response.status).toBe(403)
  expect(authorizationCalls).toBe(2)
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })

  const retryResponse = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetCustomerId: target.id,
      sourceExpectedRevision: source.revision,
      targetExpectedRevision: target.revision,
    }),
  })

  expect(retryResponse.status).toBe(200)
  expect(authorizationCalls).toBe(4)
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })
})

test('retains a Customer merge marker when repointing a Triage association fails', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const source = await createCustomer(client)
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex Industries',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
  })
  const entry = createCustomerAssociationEntry(source.id)
  let associationCalls = 0
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => [entry],
    associateCustomer: async () => {
      associationCalls += 1
      if (associationCalls === 1) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage association update failed.')
      }
      return { ...entry, customerId: target.id, revision: entry.revision + 1 }
    },
  })
  const input = {
    targetCustomerId: target.id,
    sourceExpectedRevision: source.revision,
    targetExpectedRevision: target.revision,
  }

  const firstResponse = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  expect(firstResponse.status).toBe(503)
  expect(await firstResponse.json()).toMatchObject({ code: 'TriageCustomerAssociationUnavailable' })
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })

  const retryResponse = await app.request(`/api/customers/${source.id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  expect(retryResponse.status).toBe(200)
  expect(associationCalls).toBe(2)
  await expect(client.getCustomer('workspace-1', source.id)).rejects.toMatchObject({ code: 'CustomerNotFound' })
})

test('rejects deletion of a Customer Request that still points to Triage', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await client.createRequest('workspace-1', 'member-1', {
    customerId: customer.id,
    triageEntryId: 'triage-customer-1',
    source: { kind: 'email', provider: 'mail', canNotify: true },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW,
    importance: 'normal',
  })
  const entry = { ...createCustomerAssociationEntry(customer.id), customerRequestId: request.id }
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => entry,
    listCustomerAssociations: async () => [entry],
    clearCustomerAssociations: async () => undefined,
  })

  const response = await app.request(`/api/customer-requests/${request.id}?expectedRevision=${request.revision}`, {
    method: 'DELETE',
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CustomerRequestTriageAssociation' })
  await expect(client.getRequest('workspace-1', request.id)).resolves.toMatchObject({ id: request.id })
})

test('deletes a Triage Request orphan after its reverse association is gone', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await client.createRequest('workspace-1', 'member-1', {
    customerId: customer.id,
    triageEntryId: 'triage-orphan-1',
    source: { kind: 'email', provider: 'mail', canNotify: true },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW,
    importance: 'normal',
  })
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, {
    getEntry: async () => {
      throw new Error('The orphaned Triage Entry should not be read by team.')
    },
    listCustomerAssociations: async () => [],
    clearCustomerAssociations: async () => undefined,
  })

  const response = await app.request(`/api/customer-requests/${request.id}?expectedRevision=${request.revision}`, {
    method: 'DELETE',
  })

  expect(response.status).toBe(204)
  await expect(client.getRequest('workspace-1', request.id)).rejects.toMatchObject({ code: 'CustomerRequestNotFound' })
})

test('passes the Project scope into Customer impact authorization', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  let scope: CustomerAuthorizationScope | undefined
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    undefined,
    async (_context, _minimum, authorizationScope) => {
      scope = authorizationScope
      return {
        directoryId: 'workspace-1',
        userKey: 'member-1',
        canViewSensitiveData: true,
      }
    },
  )

  const response = await app.request('/api/projects/project-1/customer-impact')

  expect(response.status).toBe(200)
  expect(scope).toEqual({ projectId: 'project-1' })
})

test('uses the live Work Item Project assignment for Project impact', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  const request = await createRequest(client, customer.id)
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-old',
  })
  const app = createTestApp(
    client,
    {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    },
    undefined,
    undefined,
    { verifyWorkItemAccess: async () => ({ projectId: 'project-new', isCompleted: false }) },
  )

  const currentProjectResponse = await app.request('/api/projects/project-new/customer-impact')
  const oldProjectResponse = await app.request('/api/projects/project-old/customer-impact')
  const currentProjectBody: { requestCount: number } = await currentProjectResponse.json()
  const oldProjectBody: { requestCount: number } = await oldProjectResponse.json()

  expect(currentProjectResponse.status).toBe(200)
  expect(currentProjectBody.requestCount).toBe(1)
  expect(oldProjectResponse.status).toBe(200)
  expect(oldProjectBody.requestCount).toBe(0)
})

test('replays saved Customer view creation with the same idempotency key', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  })
  const request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'saved-view-1',
    },
    body: JSON.stringify({ name: 'Support', filters: { status: 'active' } }),
  }

  const missingKey = await app.request('/api/customers/views', {
    method: request.method,
    headers: { 'content-type': 'application/json' },
    body: request.body,
  })
  const first = await app.request('/api/customers/views', request)
  const firstBody = await first.clone().json()
  const repeated = await app.request('/api/customers/views', request)

  expect(missingKey.status).toBe(400)
  expect(await missingKey.json()).toMatchObject({ code: 'InvalidCustomerInput' })
  expect(first.status).toBe(201)
  expect(repeated.status).toBe(201)
  expect(await repeated.json()).toEqual(firstBody)
  expect((await client.listSavedViews('workspace-1'))).toHaveLength(1)
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
  let customerScope: CustomerAuthorizationScope | undefined
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, triage, async (_context, _minimum, scope) => {
    customerScope = scope
    return {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    }
  })

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
  expect(customerScope).toEqual({ teamId: 'support' })
  expect((await client.getRequest('workspace-1', body.id)).customerId).toBe(customer.id)
})

test('resumes a Triage Customer Request after the association commit fails', async () => {
  const client = new InMemoryCustomerClient({ now: () => new Date(NOW) })
  const customer = await createCustomer(client)
  let entry: TriageEntry = {
    ...createCustomerAssociationEntry(customer.id),
    id: 'triage-retry-1',
    revision: 1,
    customerRequestId: undefined,
  }
  let associationCalls = 0
  const triage: CustomerTestTriage = {
    getEntry: async () => entry,
    associateCustomer: async (_workspaceId, _teamId, _entryId, _actor, input) => {
      associationCalls += 1
      if (associationCalls === 1) {
        entry = { ...entry, revision: entry.revision + 1 }
        throw new CustomerError(409, 'TriageRevisionConflict', 'The Triage Entry changed.')
      }
      entry = {
        ...entry,
        customerId: input.customerId ?? undefined,
        contactId: input.contactId ?? undefined,
        customerRequestId: input.customerRequestId ?? undefined,
        revision: entry.revision + 1,
      }
      return entry
    },
  }
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, triage)
  const body = JSON.stringify({
    expectedRevision: 1,
    customerId: customer.id,
    importance: 'normal',
  })

  const firstResponse = await app.request('/api/teams/support/triage-entries/triage-retry-1/customer-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(firstResponse.status).toBe(409)
  expect(await firstResponse.json()).toMatchObject({ code: 'TriageRevisionConflict' })

  const savedRequests = await client.listRequests('workspace-1', { customerId: customer.id })
  expect(savedRequests.requests).toHaveLength(1)

  const retryResponse = await app.request('/api/teams/support/triage-entries/triage-retry-1/customer-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 2,
      customerId: customer.id,
      importance: 'normal',
    }),
  })

  expect(retryResponse.status).toBe(201)
  expect(associationCalls).toBe(2)
  expect((await client.listRequests('workspace-1', { customerId: customer.id })).requests).toHaveLength(1)
  expect(entry.customerRequestId).toBe(savedRequests.requests[0]?.id)
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
  }, 'triage-contact')
  const inactiveContact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Grace Hopper',
  }, 'triage-inactive-contact')
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
  let customerScope: CustomerAuthorizationScope | undefined
  const app = createTestApp(client, {
    directoryId: 'workspace-1',
    userKey: 'member-1',
    canViewSensitiveData: true,
  }, association, async (_context, _minimum, scope) => {
    customerScope = scope
    return {
      directoryId: 'workspace-1',
      userKey: 'member-1',
      canViewSensitiveData: true,
    }
  })

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
  expect(customerScope).toEqual({ teamId: 'support' })
})
