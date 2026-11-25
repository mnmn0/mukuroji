import { expect, test } from 'bun:test'
import { createCustomerAuditEvents } from './customer-audit'
import { InMemoryCustomerClient } from './customers'

/** Stable instant shared by the fixtures. */
const NOW = new Date('2026-08-01T00:00:00.000Z')

/** Creates an isolated in-memory Customer client with deterministic IDs and time. */
function createClient(): InMemoryCustomerClient {
  let id = 0
  return new InMemoryCustomerClient({ id: () => `record-${++id}`, now: () => new Date(NOW) })
}

/** Customer creation fields shared by the fixtures. */
const customerInput = { tier: 'enterprise', size: 'enterprise', status: 'active', health: 'healthy' } as const

test('records created and updated records without personal details or the original message', async () => {
  const client = createClient()
  const empty = client.readWorkspaceState('w')
  const customer = await client.createCustomer('w', 'member-1', { ...customerInput, name: 'Acme', notes: 'Secret plan' })
  const contact = await client.createContact('w', customer.id, 'member-1', { name: 'Ada Lovelace', email: 'ada@example.com' }, 'contact-key-1')
  await client.createRequest('w', 'member-1', {
    customerId: customer.id,
    contactId: contact.id,
    source: { kind: 'email', canNotify: true },
    originalMessage: 'Please support SSO.',
    receivedAt: NOW.toISOString(),
    importance: 'high',
  })
  const created = client.readWorkspaceState('w')

  const events = createCustomerAuditEvents('w', empty, created)
  expect(events.map((event) => event.eventType)).toEqual([
    'customer.created',
    'customer-contact.created',
    'customer-request.created',
  ])
  const serialized = JSON.stringify(events)
  expect(serialized).not.toContain('Secret plan')
  expect(serialized).not.toContain('Ada Lovelace')
  expect(serialized).not.toContain('ada@example.com')
  expect(serialized).not.toContain('Please support SSO.')
  expect(events[1]?.metadata).toEqual({ customerId: customer.id })

  await client.updateCustomer('w', customer.id, 'member-1', { expectedRevision: customer.revision, health: 'at-risk' })
  const updated = createCustomerAuditEvents('w', created, client.readWorkspaceState('w'))
  expect(updated).toEqual([expect.objectContaining({
    eventType: 'customer.updated',
    entityId: customer.id,
    changes: [{ field: 'health', before: 'healthy', after: 'at-risk' }],
  })])
})

test('folds a deletion or merge into one Customer event', async () => {
  const client = createClient()
  const source = await client.createCustomer('w', 'member-1', { ...customerInput, name: 'Source' })
  const target = await client.createCustomer('w', 'member-1', { ...customerInput, name: 'Target' })
  await client.createContact('w', source.id, 'member-1', { name: 'Grace', email: 'grace@example.com' }, 'contact-key-2')
  await client.createRequest('w', 'member-1', {
    customerId: source.id,
    source: { kind: 'email', canNotify: false },
    originalMessage: 'Help',
    receivedAt: NOW.toISOString(),
    importance: 'normal',
  })
  const before = client.readWorkspaceState('w')
  const currentSource = await client.getCustomer('w', source.id)
  const currentTarget = await client.getCustomer('w', target.id)
  await client.mergeCustomer('w', source.id, 'member-1', {
    targetCustomerId: target.id,
    sourceExpectedRevision: currentSource.customer.revision,
    targetExpectedRevision: currentTarget.customer.revision,
  })
  const merged = createCustomerAuditEvents('w', before, client.readWorkspaceState('w'))
  expect(merged).toEqual([expect.objectContaining({
    eventType: 'customer.merged',
    entityId: source.id,
    metadata: { mergedIntoId: target.id },
  })])

  const other = createClient()
  const deleted = await other.createCustomer('w', 'member-1', { ...customerInput, name: 'Deleted' })
  await other.createContact('w', deleted.id, 'member-1', { name: 'Linus' }, 'contact-key-3')
  const beforeDeletion = other.readWorkspaceState('w')
  const stored = await other.getCustomer('w', deleted.id)
  await other.deleteCustomer('w', deleted.id, 'member-1', stored.customer.revision)
  expect(createCustomerAuditEvents('w', beforeDeletion, other.readWorkspaceState('w')).map((event) => event.eventType))
    .toEqual(['customer.deleted'])
})

test('caps the events of one write and counts the rest', async () => {
  const client = createClient()
  const empty = client.readWorkspaceState('w')
  for (const name of ['A', 'B', 'C', 'D', 'E']) {
    await client.createCustomer('w', 'member-1', { ...customerInput, name })
  }
  const events = createCustomerAuditEvents('w', empty, client.readWorkspaceState('w'))
  expect(events).toHaveLength(3)
  expect(events[2]?.metadata).toEqual({ additionalChanges: 2 })
})

test('marks a Contact merge from its operation marker even when no Request moved', async () => {
  const client = createClient()
  const customer = await client.createCustomer('w', 'member-1', { ...customerInput, name: 'Acme' })
  const source = await client.createContact('w', customer.id, 'member-1', { name: 'Old' }, 'contact-key-4')
  const target = await client.createContact('w', customer.id, 'member-1', { name: 'New' }, 'contact-key-5')
  const before = client.readWorkspaceState('w')
  const after = client.readWorkspaceState('w')
  after.contacts.delete(source.id)
  const events = createCustomerAuditEvents('w', before, after, { sourceContactId: source.id, targetContactId: target.id })
  expect(events).toEqual([expect.objectContaining({
    eventType: 'customer-contact.merged',
    entityId: source.id,
    metadata: { customerId: customer.id, mergedIntoId: target.id },
  })])
})

test('records a Request message edit and a Request merge without the message', async () => {
  const client = createClient()
  const customer = await client.createCustomer('w', 'member-1', { ...customerInput, name: 'Acme' })
  const first = await client.createRequest('w', 'member-1', {
    customerId: customer.id,
    source: { kind: 'email', canNotify: true },
    originalMessage: 'First message',
    receivedAt: NOW.toISOString(),
    importance: 'normal',
  })
  const second = await client.createRequest('w', 'member-1', {
    customerId: customer.id,
    source: { kind: 'email', canNotify: true },
    originalMessage: 'Second message',
    receivedAt: NOW.toISOString(),
    importance: 'normal',
  })
  const before = client.readWorkspaceState('w')
  await client.updateRequest('w', first.id, 'member-1', { expectedRevision: first.revision, originalMessage: 'Edited message' })
  const edited = client.readWorkspaceState('w')
  const editEvents = createCustomerAuditEvents('w', before, edited)
  expect(editEvents).toEqual([expect.objectContaining({
    eventType: 'customer-request.updated',
    entityId: first.id,
    changes: [{ field: 'originalMessage', before: '[REDACTED]', after: '[REDACTED]', redacted: true }],
  })])
  expect(JSON.stringify(editEvents)).not.toContain('message')

  const source = await client.getRequest('w', first.id)
  const target = await client.getRequest('w', second.id)
  await client.mergeRequest('w', first.id, 'member-1', {
    targetRequestId: second.id,
    sourceExpectedRevision: source.revision,
    targetExpectedRevision: target.revision,
  })
  const mergeEvents = createCustomerAuditEvents('w', edited, client.readWorkspaceState('w'))
  expect(mergeEvents).toContainEqual(expect.objectContaining({
    eventType: 'customer-request.merged',
    entityId: first.id,
    metadata: expect.objectContaining({ mergedIntoId: second.id }),
  }))
})
