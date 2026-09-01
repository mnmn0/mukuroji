import { expect, test } from 'bun:test'
import type {
  Customer,
  CustomerRequest,
  CreateCustomerRequestInput,
} from '@mukuroji/contracts'
import {
  calculateCustomerImpactSignal,
  createCustomerContactRecord,
  createCustomerRecord,
  createCustomerRequestRecord,
  deriveCustomerProjectSummaries,
  deriveCustomerWorkItemSummaries,
  redactExpiredCustomerData,
} from './customer'

/** Stable instant shared by Customer domain fixtures. */
const NOW = '2026-08-01T00:00:00.000Z'

/** Creates a Customer fixture with the attributes used by impact tests. */
function createCustomer(
  id: string,
  overrides: Partial<Parameters<typeof createCustomerRecord>[2]> = {},
): Customer {
  return createCustomerRecord('workspace-1', id, {
    name: id,
    tier: 'enterprise',
    size: 'enterprise',
    status: 'active',
    health: 'healthy',
    ...overrides,
  }, NOW)
}

/** Creates a Customer Request fixture linked to one canonical Work Item. */
function createRequest(
  id: string,
  customerId: string,
  overrides: Partial<CreateCustomerRequestInput> = {},
): CustomerRequest {
  return {
    ...createCustomerRequestRecord('workspace-1', id, {
      customerId,
      source: { kind: 'email', provider: 'mail', canNotify: true },
      originalMessage: `${id} message`,
      receivedAt: NOW,
      importance: 'normal',
      ...overrides,
    }, NOW),
    workItemLinks: [{
      teamId: 'support',
      workItemId: 'work-item-1',
      projectId: 'project-1',
      linkedAt: NOW,
      linkedBy: 'member-1',
    }],
  }
}

test('normalizes Customer attributes and applies the default Request retention period', () => {
  const customer = createCustomerRecord('workspace-1', 'customer-1', {
    name: '  Acme Corporation  ',
    domain: 'Example.COM',
    tier: 'strategic',
    size: 'enterprise',
    status: 'active',
    health: 'watch',
    businessValue: 85,
  }, NOW)
  const request = createCustomerRequestRecord('workspace-1', 'request-1', {
    customerId: customer.id,
    source: { kind: 'email', provider: 'mail', canNotify: true },
    originalMessage: '  Please support SSO.  ',
    receivedAt: NOW,
    importance: 'high',
  }, NOW)

  expect(customer).toMatchObject({
    name: 'Acme Corporation',
    domain: 'example.com',
    businessValue: 85,
    contactCount: 0,
    requestCount: 0,
  })
  expect(request).toMatchObject({
    originalMessage: 'Please support SSO.',
    status: 'requested',
    retention: { expiresAt: '2027-08-01T00:00:00.000Z' },
  })
})

test('calculates explainable impact across distinct Customers without changing source records', () => {
  const acme = createCustomer('acme', { businessValue: 90, health: 'watch' })
  const globex = createCustomer('globex', { businessValue: 80, tier: 'growth' })
  const requests = [
    createRequest('request-1', acme.id, { importance: 'normal' }),
    createRequest('request-2', acme.id, { importance: 'high' }),
    createRequest('request-3', globex.id, { importance: 'normal' }),
  ]
  const beforeCustomer = structuredClone(acme)
  const beforeRequests = structuredClone(requests)

  const signal = calculateCustomerImpactSignal([acme, globex], requests)

  expect(signal).toMatchObject({
    customerCount: 2,
    requestCount: 3,
    openRequestCount: 3,
    businessValueTotal: 170,
    highestBusinessValue: 90,
    highestImportance: 'high',
    prioritySignal: 'critical',
  })
  expect(signal.customers.map((customer) => customer.customerId)).toEqual(['acme', 'globex'])
  expect(acme).toEqual(beforeCustomer)
  expect(requests).toEqual(beforeRequests)
})

test('aggregates multiple Customer Requests into one Work Item summary', () => {
  const first = createRequest('request-1', 'acme')
  const second = {
    ...createRequest('request-2', 'acme'),
    status: 'completed' as const,
    workItemLinks: [
      ...first.workItemLinks,
      {
        teamId: 'support',
        workItemId: 'work-item-2',
        projectId: 'project-1',
        linkedAt: NOW,
        linkedBy: 'member-1',
      },
    ],
  }

  const summaries = deriveCustomerWorkItemSummaries([first, second])

  expect(summaries).toEqual([
    {
      teamId: 'support',
      workItemId: 'work-item-1',
      projectId: 'project-1',
      requestCount: 2,
      requestStates: ['completed', 'requested'],
      lifecycle: 'requested',
    },
    {
      teamId: 'support',
      workItemId: 'work-item-2',
      projectId: 'project-1',
      requestCount: 1,
      requestStates: ['completed'],
      lifecycle: 'completed',
    },
  ])
})

test('aggregates direct and Work Item-derived Project links once per request', () => {
  const request = createRequest('request-1', 'acme')
  const withDirectProject = {
    ...request,
    projectLinks: [{ projectId: 'project-2', linkedAt: NOW, linkedBy: 'member-1' }],
  }

  expect(deriveCustomerProjectSummaries([withDirectProject])).toEqual([
    { projectId: 'project-1', requestCount: 1, requestStates: ['requested'] },
    { projectId: 'project-2', requestCount: 1, requestStates: ['requested'] },
  ])
})

test('redacts expired Customer-owned fields while preserving relationship identity', () => {
  const customer = createCustomer('acme', { retentionExpiresAt: '2026-07-31T00:00:00.000Z' })
  const contact = createCustomerContactRecord('workspace-1', customer.id, 'contact-1', {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
  }, NOW)
  const request = createRequest('request-1', customer.id, {
    retentionExpiresAt: '2026-07-31T00:00:00.000Z',
    externalReference: { provider: 'mail', id: 'message-1' },
  })

  const redacted = redactExpiredCustomerData(
    [customer],
    [contact],
    [request],
    NOW,
  )

  expect(redacted.result).toEqual({
    customersRedacted: 1,
    contactsRedacted: 1,
    requestsRedacted: 1,
  })
  expect(redacted.customers[0]).toMatchObject({
    id: 'acme',
    name: '[redacted customer]',
    businessValue: undefined,
    retention: { redactedAt: NOW },
  })
  expect(redacted.contacts[0]).toMatchObject({
    id: 'contact-1',
    customerId: 'acme',
    name: '[redacted contact]',
    email: undefined,
    status: 'inactive',
  })
  expect(redacted.requests[0]).toMatchObject({
    id: 'request-1',
    customerId: 'acme',
    originalMessage: '',
    externalReference: undefined,
    source: { kind: 'email', canNotify: false },
  })
})
