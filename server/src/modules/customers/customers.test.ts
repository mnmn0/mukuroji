import { expect, test } from 'bun:test'
import { InMemoryCustomerClient } from './customers'

/** Stable instant shared by Customer client fixtures. */
const NOW = new Date('2026-08-01T00:00:00.000Z')

/** Creates an isolated in-memory Customer client with deterministic IDs and time. */
function createClient() {
  let id = 0
  return new InMemoryCustomerClient({
    id: () => `record-${++id}`,
    now: () => new Date(NOW),
  })
}

/** Creates the smallest valid Customer Request input for a known Customer. */
function requestInput(customerId: string, canNotify = true) {
  return {
    customerId,
    source: { kind: 'email' as const, provider: 'mail', canNotify },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW.toISOString(),
    importance: 'normal' as const,
  }
}

test('links many Customer Requests to one Work Item and aggregates Project impact', async () => {
  const client = createClient()
  const acme = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'watch',
    businessValue: 90,
  })
  const globex = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex',
    tier: 'growth',
    size: 'mid-market',
    status: 'active',
    health: 'healthy',
    businessValue: 80,
  })
  const first = await client.createRequest('workspace-1', 'member-1', requestInput(acme.id))
  const second = await client.createRequest('workspace-1', 'member-1', requestInput(globex.id))
  const linkedFirst = await client.linkRequestToWorkItem('workspace-1', first.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-1',
  })
  await client.linkRequestToWorkItem('workspace-1', second.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-1',
  })
  await client.linkRequestToProject('workspace-1', second.id, 'member-1', {
    projectId: 'project-2',
  })

  const workItemImpact = await client.getWorkItemImpact('workspace-1', 'support', 'work-item-1')
  const projectImpact = await client.getProjectImpact('workspace-1', 'project-1')

  expect(linkedFirst.workItemLinks).toHaveLength(1)
  expect(workItemImpact).toMatchObject({
    customerCount: 2,
    requestCount: 2,
    businessValueTotal: 170,
    prioritySignal: 'critical',
  })
  expect(projectImpact).toEqual(workItemImpact)
  expect((await client.getProjectImpact('workspace-1', 'project-2')).customerCount).toBe(1)
  expect((await client.getCustomer('workspace-1', second.customerId)).projects).toEqual([
    { projectId: 'project-1', requestCount: 1, requestStates: ['requested'] },
    { projectId: 'project-2', requestCount: 1, requestStates: ['requested'] },
  ])
})

test('merges Customer identity and prepares idempotent source-capable completion candidates', async () => {
  const client = createClient()
  const target = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const source = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme duplicate',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const contact = await client.createContact('workspace-1', source.id, 'member-1', {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  })
  const request = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(source.id),
    contactId: contact.id,
    importance: 'high',
  })
  const skippedRequest = await client.createRequest(
    'workspace-1',
    'member-1',
    requestInput(source.id, false),
  )
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-1',
  })
  await client.linkRequestToWorkItem('workspace-1', skippedRequest.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-1',
  })
  await client.mergeCustomer('workspace-1', source.id, 'member-1', {
    targetCustomerId: target.id,
    sourceExpectedRevision: source.revision,
    targetExpectedRevision: target.revision,
  })

  const detail = await client.getCustomer('workspace-1', target.id)
  const candidates = await client.prepareCompletionNotifications(
    'workspace-1',
    'support',
    'work-item-1',
    'member-1',
    NOW.toISOString(),
  )
  const repeatedCandidates = await client.prepareCompletionNotifications(
    'workspace-1',
    'support',
    'work-item-1',
    'member-1',
    NOW.toISOString(),
  )

  expect(detail.contacts).toMatchObject([{ customerId: target.id, name: 'Ada Lovelace' }])
  expect(detail.requests).toHaveLength(2)
  expect(detail.requests.every((request) => request.customerId === target.id)).toBeTrue()
  expect(detail.requests.every((request) => request.contactId === undefined || request.contactId === contact.id)).toBeTrue()
  expect(candidates).toHaveLength(2)
  expect(candidates.find((candidate) => candidate.requestId === request.id)).toMatchObject({
    canNotify: true,
  })
  expect(candidates.find((candidate) => candidate.requestId === request.id)?.skipReason).toBeUndefined()
  expect(candidates.find((candidate) => candidate.requestId === skippedRequest.id)).toMatchObject({
    canNotify: false,
    skipReason: 'source-not-capable',
  })
  expect(repeatedCandidates).toEqual(candidates)
  expect((await client.getRequest('workspace-1', request.id)).status).toBe('completed')
})

test('keeps Customer references and notification candidates consistent across destructive mutations', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    domain: 'acme.example',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    primary: true,
  })
  const request = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    contactId: contact.id,
  })
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
  })
  await client.prepareCompletionNotifications('workspace-1', 'support', 'work-item-1', 'member-1')

  await client.deleteContact('workspace-1', customer.id, contact.id, 'member-1', contact.revision)
  expect((await client.getRequest('workspace-1', request.id)).contactId).toBeUndefined()

  const requestAfterContactDelete = await client.getRequest('workspace-1', request.id)
  await client.deleteRequest('workspace-1', request.id, 'member-1', requestAfterContactDelete.revision)
  expect(await client.listCompletionNotifications('workspace-1', 'support', 'work-item-1')).toEqual([])

  const duplicate = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Other',
    domain: 'other.example',
    tier: 'standard',
    size: 'small',
    status: 'prospect',
    health: 'unknown',
  })
  await expect(client.updateCustomer('workspace-1', duplicate.id, 'member-1', {
    expectedRevision: duplicate.revision,
    name: customer.name,
    domain: customer.domain,
  })).rejects.toMatchObject({ code: 'CustomerAlreadyExists' })
})
