import { afterEach, describe, expect, test } from 'bun:test'
import type { Customer, CustomerContact, CustomerRequest } from '@mukuroji/contracts'
import {
  CustomerApiError,
  createCustomer,
  createCustomerRequest,
  deleteCustomerContact,
  linkCustomerRequestProject,
  unlinkCustomerRequestWorkItem,
  updateCustomer,
} from '../src/customers/api'
import {
  createCustomerContactDraft,
  createCustomerDraft,
  createCustomerRequestDraft,
  readCreateCustomerContactInput,
  readCreateCustomerInput,
  readCreateCustomerRequestInput,
  readUpdateCustomerContactInput,
  readUpdateCustomerInput,
  readUpdateCustomerRequestInput,
  toDateTimeLocalValue,
} from '../src/customers/model/customerDrafts'
import {
  resolveCustomerMutationErrorKey,
  shouldRefreshAfterCustomerMutationFailure,
} from '../src/customers/model/customerMutationErrors'

const originalFetch = globalThis.fetch
const mutationContext = { correlationId: 'customer-correlation-1', idempotencyKey: 'customer-key-1' }

afterEach(() => {
  globalThis.fetch = originalFetch
})

const customer: Customer = {
  schemaVersion: 1,
  id: 'customer-1',
  workspaceId: 'workspace-1',
  name: 'Acme Industries',
  domain: 'acme.example',
  tier: 'strategic',
  size: 'enterprise',
  status: 'active',
  health: 'watch',
  businessValue: 86,
  notes: 'Renewal in Q1',
  contactCount: 1,
  requestCount: 1,
  openRequestCount: 1,
  revision: 4,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const contact: CustomerContact = {
  id: 'contact-1',
  workspaceId: 'workspace-1',
  customerId: customer.id,
  name: 'Mina Example',
  email: 'mina@acme.example',
  primary: true,
  status: 'active',
  revision: 2,
  createdAt: customer.createdAt,
  updatedAt: customer.updatedAt,
}

const request: CustomerRequest = {
  schemaVersion: 1,
  id: 'request-1',
  workspaceId: 'workspace-1',
  customerId: customer.id,
  contactId: contact.id,
  source: { kind: 'portal', canNotify: true },
  originalMessage: 'Please add an export format.',
  receivedAt: '2026-08-18T00:00:00.000Z',
  importance: 'high',
  status: 'requested',
  workItemLinks: [],
  projectLinks: [],
  revision: 3,
  createdAt: customer.updatedAt,
  updatedAt: customer.updatedAt,
}

describe('Customer drafts', () => {
  test('builds a create input from trimmed fields and leaves blank optional fields out', () => {
    const result = readCreateCustomerInput({
      ...createCustomerDraft(),
      name: '  Globex  ',
      domain: ' Globex.Example ',
      businessValue: '40',
    })
    expect(result).toEqual({
      ok: true,
      input: {
        name: 'Globex',
        domain: 'globex.example',
        tier: 'standard',
        size: 'small',
        status: 'active',
        health: 'unknown',
        businessValue: 40,
      },
    })
  })

  test('reports the same problems the server would reject', () => {
    const draft = createCustomerDraft()
    expect(readCreateCustomerInput(draft)).toEqual({ ok: false, issue: 'nameRequired' })
    expect(readCreateCustomerInput({ ...draft, name: 'A', domain: 'not a domain' })).toEqual({ ok: false, issue: 'domainInvalid' })
    expect(readCreateCustomerInput({ ...draft, name: 'A', businessValue: '101' })).toEqual({ ok: false, issue: 'businessValueInvalid' })
    expect(readCreateCustomerContactInput({ ...createCustomerContactDraft(), name: 'B', email: 'nope' }))
      .toEqual({ ok: false, issue: 'emailInvalid' })
  })

  test('sends only changed Customer fields with the loaded revision, and null to clear', () => {
    const draft = { ...createCustomerDraft(customer), status: 'churned' as const, domain: '', businessValue: '' }
    expect(readUpdateCustomerInput(customer, draft)).toEqual({
      ok: true,
      input: { expectedRevision: 4, domain: null, status: 'churned', businessValue: null },
    })
    expect(readUpdateCustomerInput(customer, createCustomerDraft(customer)))
      .toEqual({ ok: true, input: { expectedRevision: 4 } })
  })

  test('sends only changed contact fields', () => {
    const draft = { ...createCustomerContactDraft(contact), role: 'Buyer', primary: false }
    expect(readUpdateCustomerContactInput(contact, draft)).toEqual({
      ok: true,
      input: { expectedRevision: 2, role: 'Buyer', primary: false },
    })
  })

  test('builds a manual Customer Request from the local received time', () => {
    const now = new Date(2026, 10, 19, 9, 30)
    const draft = { ...createCustomerRequestDraft(undefined, now), originalMessage: ' Needs SSO ', contactId: contact.id }
    expect(draft.receivedAt).toBe('2026-11-19T09:30')
    expect(readCreateCustomerRequestInput(customer.id, draft)).toEqual({
      ok: true,
      input: {
        customerId: customer.id,
        contactId: contact.id,
        source: { kind: 'manual', canNotify: false },
        originalMessage: 'Needs SSO',
        receivedAt: now.toISOString(),
        importance: 'normal',
      },
    })
    expect(readCreateCustomerRequestInput(customer.id, { ...draft, originalMessage: ' ' }))
      .toEqual({ ok: false, issue: 'messageRequired' })
    expect(readCreateCustomerRequestInput(customer.id, { ...draft, receivedAt: '' }))
      .toEqual({ ok: false, issue: 'receivedAtInvalid' })
  })

  test('keeps the recorded received time and source when a Request is edited', () => {
    const draft = { ...createCustomerRequestDraft(request), status: 'in-progress' as const, contactId: '' }
    expect(readUpdateCustomerRequestInput(request, draft)).toEqual({
      ok: true,
      input: { expectedRevision: 3, contactId: null, status: 'in-progress' },
    })
  })

  test('keeps a precise received time when the field is left untouched', () => {
    const precise = { ...request, receivedAt: '2026-08-18T00:00:42.123Z' }
    const draft = { ...createCustomerRequestDraft(precise), importance: 'urgent' as const }
    expect(readUpdateCustomerRequestInput(precise, draft)).toEqual({
      ok: true,
      input: { expectedRevision: 3, importance: 'urgent' },
    })
  })

  test('accepts names up to the server limit of 300 characters', () => {
    const long = { ...customer, name: 'A'.repeat(250) }
    expect(readUpdateCustomerInput(long, { ...createCustomerDraft(long), status: 'inactive' }))
      .toEqual({ ok: true, input: { expectedRevision: 4, status: 'inactive' } })
    expect(readCreateCustomerInput({ ...createCustomerDraft(), name: 'A'.repeat(301) }))
      .toEqual({ ok: false, issue: 'nameRequired' })
  })

  test('formats an invalid date as an empty datetime-local value', () => {
    expect(toDateTimeLocalValue(new Date('invalid'))).toBe('')
  })
})

describe('Customer mutation errors', () => {
  test('maps API failures to member-facing messages', () => {
    expect(resolveCustomerMutationErrorKey({ status: 409, code: 'CustomerRevisionConflict' })).toBe('customers.edit.error.conflict')
    expect(resolveCustomerMutationErrorKey({ status: 409, code: 'CustomerAlreadyExists' })).toBe('customers.edit.error.duplicate')
    expect(resolveCustomerMutationErrorKey({ status: 409, code: 'CustomerMergeInProgress' })).toBe('customers.edit.error.busy')
    expect(resolveCustomerMutationErrorKey({ status: 403 })).toBe('customers.edit.error.forbidden')
    expect(resolveCustomerMutationErrorKey({ status: 404 })).toBe('customers.edit.error.notFound')
    expect(resolveCustomerMutationErrorKey({ status: 400 })).toBe('customers.edit.error.invalid')
    expect(resolveCustomerMutationErrorKey({})).toBe('customers.edit.error.failed')
  })

  test('reloads stale data only after conflicts and missing records', () => {
    expect(shouldRefreshAfterCustomerMutationFailure({ status: 409 })).toBe(true)
    expect(shouldRefreshAfterCustomerMutationFailure({ status: 404 })).toBe(true)
    expect(shouldRefreshAfterCustomerMutationFailure({ status: 500 })).toBe(false)
  })
})

describe('Customer editing API boundary', () => {
  test('creates a Customer with retry headers and validates the response', async () => {
    const requests = installFetchRecorder([{ status: 201, body: customer }])
    const created = await createCustomer('token', { name: 'Acme', tier: 'standard', size: 'small', status: 'active', health: 'unknown' }, mutationContext)
    expect(created.id).toBe(customer.id)
    expect(requests[0]?.url).toBe('/api/customers')
    expect(requests[0]?.init.method).toBe('POST')
    const headers = new Headers(requests[0]?.init.headers)
    expect(headers.get('Idempotency-Key')).toBe('customer-key-1')
    expect(headers.get('Authorization')).toBe('Bearer token')
  })

  test('creates a Customer Request with the required Idempotency-Key', async () => {
    const requests = installFetchRecorder([{ status: 201, body: request }])
    await createCustomerRequest('token', {
      customerId: customer.id,
      source: { kind: 'manual', canNotify: false },
      originalMessage: 'Needs SSO',
      receivedAt: request.receivedAt,
      importance: 'normal',
    }, mutationContext)
    expect(requests[0]?.url).toBe('/api/customer-requests')
    expect(new Headers(requests[0]?.init.headers).get('Idempotency-Key')).toBe('customer-key-1')
  })

  test('patches a Customer and surfaces a revision conflict with its code', async () => {
    installFetchRecorder([{ status: 409, body: { code: 'CustomerRevisionConflict', message: 'Customer changed.' } }])
    const failure = await updateCustomer('token', 'customer/1', { expectedRevision: 4, name: 'Acme' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CustomerApiError)
    expect(failure).toMatchObject({ status: 409, code: 'CustomerRevisionConflict' })
  })

  test('deletes a contact with the expected revision in the query', async () => {
    const requests = installFetchRecorder([{ status: 204 }])
    await deleteCustomerContact('token', 'customer-1', 'contact/1', 2)
    expect(requests[0]?.url).toBe('/api/customers/customer-1/contacts/contact%2F1?expectedRevision=2')
    expect(requests[0]?.init.method).toBe('DELETE')
  })

  test('links and unlinks Customer Requests with the documented bodies', async () => {
    const requests = installFetchRecorder([{ status: 200, body: request }, { status: 200, body: request }])
    await linkCustomerRequestProject('token', 'request-1', 'project-1')
    await unlinkCustomerRequestWorkItem('token', 'request-1', { teamId: 'team-1', workItemId: 'item-1' }, 3)
    expect(requests.map((entry) => [entry.url, entry.init.method, entry.init.body])).toEqual([
      ['/api/customer-requests/request-1/projects', 'POST', JSON.stringify({ projectId: 'project-1' })],
      ['/api/customer-requests/request-1/work-items', 'DELETE', JSON.stringify({ teamId: 'team-1', workItemId: 'item-1', expectedRevision: 3 })],
    ])
  })

  test('rejects an invalid Customer response', async () => {
    installFetchRecorder([{ status: 200, body: { id: 'customer-1' } }])
    await expect(updateCustomer('token', 'customer-1', { expectedRevision: 1 })).rejects.toMatchObject({ status: 502 })
  })
})

/** Replaces fetch with a recorder that answers each call with the next queued response. */
function installFetchRecorder(responses: Array<{ status: number; body?: unknown }>) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const mockFetch: typeof fetch = async (input, init = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      headers: { 'Content-Type': 'application/json' },
      status: next.status,
    })
  }
  globalThis.fetch = mockFetch
  return requests
}
