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

test('makes Triage-originated Customer Request retries idempotent and conflict on another Customer', async () => {
  const client = createClient()
  const firstCustomer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const secondCustomer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex',
    tier: 'growth',
    size: 'small',
    status: 'prospect',
    health: 'unknown',
  })
  const input = {
    ...requestInput(firstCustomer.id),
    triageEntryId: 'triage-entry-1',
  }

  const first = await client.createRequest('workspace-1', 'member-1', input)
  const repeated = await client.createRequest('workspace-1', 'member-1', input)

  expect(repeated).toEqual(first)
  expect((await client.listRequests('workspace-1')).requests).toHaveLength(1)
  await expect(client.createRequest('workspace-1', 'member-1', {
    ...input,
    customerId: secondCustomer.id,
  })).rejects.toMatchObject({ code: 'CustomerRequestAlreadyExists' })
})

test('makes generic Customer Request retries idempotent when the caller supplies a retry key', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const input = {
    ...requestInput(customer.id),
    idempotencyKey: 'support-request-1',
  }

  const first = await client.createRequest('workspace-1', 'member-1', input)
  const repeated = await client.createRequest('workspace-1', 'member-1', input)

  expect(repeated).toEqual(first)
  expect((await client.listRequests('workspace-1')).requests).toHaveLength(1)
  await expect(client.createRequest('workspace-1', 'member-1', {
    ...input,
    originalMessage: 'A different request must not reuse the retry key.',
  })).rejects.toMatchObject({ code: 'CustomerRequestAlreadyExists' })
})

test('does not let an omitted retention deadline reuse a key created with an explicit deadline', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const firstInput = {
    ...requestInput(customer.id),
    idempotencyKey: 'explicit-retention-1',
    retentionExpiresAt: '2030-08-01T00:00:00.000Z',
  }
  const retryInput = {
    ...requestInput(customer.id),
    idempotencyKey: firstInput.idempotencyKey,
  }

  await client.createRequest('workspace-1', 'member-1', firstInput)
  await expect(client.createRequest('workspace-1', 'member-1', retryInput)).rejects.toMatchObject({
    code: 'CustomerRequestAlreadyExists',
  })
})

test('replays a keyed Customer Request when an omitted retention deadline is recomputed after a response loss', async () => {
  let now = new Date(NOW)
  const client = new InMemoryCustomerClient({
    id: () => 'request-record',
    now: () => new Date(now),
  })
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const input = {
    ...requestInput(customer.id),
    idempotencyKey: 'response-loss-1',
  }

  const first = await client.createRequest('workspace-1', 'member-1', input)
  now = new Date(NOW.getTime() + 60_000)
  const repeated = await client.createRequest('workspace-1', 'member-1', input)

  expect(repeated).toEqual(first)
  expect((await client.listRequests('workspace-1')).requests).toHaveLength(1)
})

test('makes saved Customer view retries idempotent when the caller supplies a retry key', async () => {
  const client = createClient()
  const input = {
    name: 'Support accounts',
    filters: { status: 'active' as const },
    groupBy: 'tier' as const,
  }

  const first = await client.createSavedView('workspace-1', 'member-1', input, 'saved-view-1')
  const repeated = await client.createSavedView('workspace-1', 'member-1', input, 'saved-view-1')

  expect(repeated).toEqual(first)
  expect(await client.listSavedViews('workspace-1')).toHaveLength(1)
  await expect(client.createSavedView('workspace-1', 'member-1', {
    ...input,
    name: 'A different view must not reuse the retry key.',
  }, 'saved-view-1')).rejects.toMatchObject({ code: 'CustomerSavedViewAlreadyExists' })
})

test('rejects inactive contacts for new Customer Requests and contact assignment updates', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
  })
  const request = await client.createRequest('workspace-1', 'member-1', requestInput(customer.id))
  const retryInput = {
    ...requestInput(customer.id),
    contactId: contact.id,
    idempotencyKey: 'request-with-contact',
  }
  const keyedRequest = await client.createRequest('workspace-1', 'member-1', retryInput)
  await client.updateContact('workspace-1', customer.id, contact.id, 'member-1', {
    expectedRevision: contact.revision,
    status: 'inactive',
  })

  await expect(client.createRequest('workspace-1', 'member-1', retryInput)).resolves.toEqual(keyedRequest)
  await expect(client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    contactId: contact.id,
  })).rejects.toMatchObject({ code: 'CustomerContactInactive' })
  await expect(client.updateRequest('workspace-1', request.id, 'member-1', {
    expectedRevision: request.revision,
    contactId: contact.id,
  })).rejects.toMatchObject({ code: 'CustomerContactInactive' })
})

test('rejects Customer merges that would collide on normalized contact email addresses', async () => {
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
  await client.createContact('workspace-1', target.id, 'member-1', {
    name: 'Target contact',
    email: 'Ada@Example.com',
  })
  await client.createContact('workspace-1', source.id, 'member-1', {
    name: 'Source contact',
    email: ' ada@example.com ',
  })

  await expect(client.mergeCustomer('workspace-1', source.id, 'member-1', {
    targetCustomerId: target.id,
    sourceExpectedRevision: source.revision,
    targetExpectedRevision: target.revision,
  })).rejects.toMatchObject({ code: 'CustomerContactAlreadyExists' })
})

test('binds Customer list cursors to their query and dataset revision', async () => {
  const client = createClient()
  await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  await client.createCustomer('workspace-1', 'member-1', {
    name: 'Globex',
    tier: 'growth',
    size: 'small',
    status: 'prospect',
    health: 'unknown',
  })
  const page = await client.listCustomers('workspace-1', { limit: 1 })
  const cursor = page.nextCursor
  expect(cursor).toBeDefined()
  if (!cursor) throw new Error('Expected a next Customer cursor.')

  await expect(client.listCustomers('workspace-1', {
    limit: 1,
    status: 'active',
    cursor,
  })).rejects.toMatchObject({ code: 'InvalidCustomerCursor' })

  await client.createCustomer('workspace-1', 'member-1', {
    name: 'Initech',
    tier: 'standard',
    size: 'small',
    status: 'active',
    health: 'healthy',
  })
  await expect(client.listCustomers('workspace-1', { limit: 1, cursor })).rejects.toMatchObject({
    code: 'InvalidCustomerCursor',
  })
})

test('binds Customer Request cursors to searchable and sortable dataset changes', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  await client.createRequest('workspace-1', 'member-1', requestInput(customer.id))
  const second = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    originalMessage: 'A second request with a searchable marker.',
  })
  const page = await client.listRequests('workspace-1', { limit: 1 })
  const cursor = page.nextCursor
  expect(cursor).toBeDefined()
  if (!cursor) throw new Error('Expected a next Customer Request cursor.')

  await client.updateRequest('workspace-1', second.id, 'member-1', {
    expectedRevision: second.revision,
    originalMessage: 'The searchable marker changed after page one.',
  })

  await expect(client.listRequests('workspace-1', { limit: 1, cursor })).rejects.toMatchObject({
    code: 'InvalidCustomerCursor',
  })
})

test('removes a Work Item-derived Project from Customer navigation when its Work Item link is removed', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const request = await client.createRequest('workspace-1', 'member-1', requestInput(customer.id))
  const linked = await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    projectId: 'project-1',
  })

  const unlinked = await client.unlinkRequestFromWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
    expectedRevision: linked.revision,
  })

  expect(unlinked.projectLinks).toEqual([])
  expect((await client.getCustomer('workspace-1', customer.id)).projects).toEqual([])
  expect((await client.getProjectImpact('workspace-1', 'project-1')).requestCount).toBe(0)
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
  expect((await client.getRequest('workspace-1', request.id)).status).toBe('requested')
})

test('does not close a Customer Request when one of several linked Work Items completes', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const request = await client.createRequest('workspace-1', 'member-1', requestInput(customer.id))
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
  })
  await client.linkRequestToWorkItem('workspace-1', request.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-2',
  })

  await client.prepareCompletionNotifications('workspace-1', 'support', 'work-item-1', 'member-1')

  expect((await client.getRequest('workspace-1', request.id)).status).toBe('requested')
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

test('retains Customer Request provenance when duplicate requests are merged', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const target = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    originalMessage: 'Target request',
  })
  const source = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    source: { kind: 'webhook', provider: 'crm', referenceId: 'source-42', canNotify: true },
    originalMessage: 'Source request with provenance',
    externalReference: { provider: 'crm', id: 'source-42', permalink: 'https://crm.example/requests/source-42' },
    importance: 'urgent',
  })
  await client.linkRequestToWorkItem('workspace-1', source.id, 'member-1', {
    teamId: 'support',
    workItemId: 'work-item-1',
  })
  await client.prepareCompletionNotifications('workspace-1', 'support', 'work-item-1', 'member-1')

  const merged = await client.mergeRequest('workspace-1', source.id, 'member-1', {
    targetRequestId: target.id,
    sourceExpectedRevision: source.revision + 1,
    targetExpectedRevision: target.revision,
  })
  const retainedSource = await client.getRequest('workspace-1', source.id)
  const notificationsAfterMerge = await client.listCompletionNotifications(
    'workspace-1',
    'support',
    'work-item-1',
  )

  expect(merged.workItemLinks).toEqual([
    {
      teamId: 'support',
      workItemId: 'work-item-1',
      linkedAt: NOW.toISOString(),
      linkedBy: 'member-1',
    },
  ])
  expect(retainedSource).toMatchObject({
    id: source.id,
    status: 'merged',
    mergedIntoRequestId: target.id,
    mergedAt: NOW.toISOString(),
    mergedBy: 'member-1',
    source: { kind: 'webhook', provider: 'crm', referenceId: 'source-42', canNotify: true },
    originalMessage: 'Source request with provenance',
    externalReference: { provider: 'crm', id: 'source-42' },
    importance: 'urgent',
  })
  expect(notificationsAfterMerge).toEqual([])
  await expect(client.updateRequest('workspace-1', source.id, 'member-1', {
    expectedRevision: retainedSource.revision,
    originalMessage: 'should not change',
  })).rejects.toMatchObject({ code: 'CustomerRequestMerged' })
})

test('applies retention before returning Customer-owned records', async () => {
  const client = createClient()
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
  })
  const request = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
  })

  const read = await client.getRequest('workspace-1', request.id)

  expect(read).toMatchObject({
    originalMessage: '',
    source: { kind: 'email', canNotify: false },
    retention: { redactedAt: NOW.toISOString() },
  })
})

test('does not repopulate records after retention redaction', async () => {
  let currentTime = new Date('2026-07-01T00:00:00.000Z')
  const client = new InMemoryCustomerClient({
    now: () => new Date(currentTime),
  })
  const customer = await client.createCustomer('workspace-1', 'member-1', {
    name: 'Acme',
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
  })
  const contact = await client.createContact('workspace-1', customer.id, 'member-1', {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
  })
  const request = await client.createRequest('workspace-1', 'member-1', {
    ...requestInput(customer.id),
    contactId: contact.id,
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
  })

  currentTime = new Date(NOW)
  await client.redactExpired('workspace-1', NOW.toISOString())
  const redactedCustomer = await client.getCustomer('workspace-1', customer.id)
  const redactedContact = redactedCustomer.contacts.find((candidate) => candidate.id === contact.id)
  const redactedRequest = redactedCustomer.requests.find((candidate) => candidate.id === request.id)

  await expect(client.updateCustomer('workspace-1', customer.id, 'member-1', {
    expectedRevision: redactedCustomer.customer.revision,
    name: 'Repopulated customer',
  })).rejects.toMatchObject({ code: 'CustomerRetentionRedacted' })
  await expect(client.updateContact('workspace-1', customer.id, contact.id, 'member-1', {
    expectedRevision: redactedContact?.revision ?? 0,
    name: 'Repopulated contact',
  })).rejects.toMatchObject({ code: 'CustomerRetentionRedacted' })
  await expect(client.updateRequest('workspace-1', request.id, 'member-1', {
    expectedRevision: redactedRequest?.revision ?? 0,
    originalMessage: 'Repopulated request',
  })).rejects.toMatchObject({ code: 'CustomerRetentionRedacted' })
})
