import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  Customer,
  CustomerContact,
  CustomerDetail,
  CustomerImpactSignal,
  CustomerImpactRequestSummary,
  CustomerProjectSummary,
  CustomerListInput,
  CustomerPage,
  CustomerRequest,
  CustomerRequestSourceKind,
  CustomerRequestStatus,
  CustomerSavedView,
  CreateCustomerRequestFromTriageInput,
  CreateCustomerSavedViewInput,
  CustomerRequestImportance,
  ProjectCustomerLinkList,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { isRecord } from '../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/** Error returned by a Customer directory request. */
export class CustomerApiError extends Error {
  /** HTTP status returned by the Customer API. */
  readonly status: number
  /** Stable API error code, when provided. */
  readonly code?: string

  /** Creates one Customer API error.
   *
   * @param status HTTP status returned by the Customer API.
   * @param message Human-readable API failure message.
   * @param code Optional stable API error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'CustomerApiError'
    this.status = status
    this.code = code
  }
}

const customersApiBaseUrl = resolveApiBaseUrl()

/** Loads the Workspace Customer directory using URL-backed filters.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param input Filters, sort, pagination, and cursor state.
 * @returns The validated Customer directory page.
 */
export async function getCustomers(
  accessToken: string,
  input: CustomerListInput = {},
): Promise<CustomerPage> {
  const searchParams = new URLSearchParams()
  if (input.search?.trim()) searchParams.set('search', input.search.trim())
  if (input.tier) searchParams.set('tier', input.tier)
  if (input.size) searchParams.set('size', input.size)
  if (input.status) searchParams.set('status', input.status)
  if (input.health) searchParams.set('health', input.health)
  if (input.minBusinessValue !== undefined) searchParams.set('minBusinessValue', String(input.minBusinessValue))
  if (input.minRequestCount !== undefined) searchParams.set('minRequestCount', String(input.minRequestCount))
  if (input.sortBy) searchParams.set('sortBy', input.sortBy)
  if (input.sortDirection) searchParams.set('sortDirection', input.sortDirection)
  if (input.limit !== undefined) searchParams.set('limit', String(input.limit))
  if (input.cursor) searchParams.set('cursor', input.cursor)
  const query = searchParams.toString()
  const data = await requestJson(
    `${customersApiBaseUrl}/customers${query ? `?${query}` : ''}`,
    accessToken,
  )
  if (!isCustomerPage(data)) throw new CustomerApiError(502, 'Customer response is invalid.')
  return data
}

/** Loads the saved Customer directory views visible to the current Workspace member.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @returns The validated saved directory views.
 */
export async function getCustomerSavedViews(accessToken: string): Promise<CustomerSavedView[]> {
  const data = await requestJson(`${customersApiBaseUrl}/customers/views`, accessToken)
  if (!isRecord(data) || !Array.isArray(data.views) || !data.views.every(isCustomerSavedView)) {
    throw new CustomerApiError(502, 'Customer saved-view response is invalid.')
  }
  return data.views
}

/** Creates a saved Customer directory view.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param input Saved view name, filters, and grouping.
 * @param context Mutation identity used for safe retries.
 * @returns The created or idempotently replayed saved view.
 */
export async function createCustomerSavedView(
  accessToken: string,
  input: CreateCustomerSavedViewInput,
  context: MutationRequestContext,
): Promise<CustomerSavedView> {
  const data = await requestJson(`${customersApiBaseUrl}/customers/views`, accessToken, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(context),
    },
    body: JSON.stringify(input),
  })
  if (!isCustomerSavedView(data)) throw new CustomerApiError(502, 'Customer saved-view response is invalid.')
  return data
}

/** Loads one Customer, its Contacts, Requests, and related Work Items.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Customer to load.
 * @returns The validated Customer detail graph.
 */
export async function getCustomer(
  accessToken: string,
  customerId: string,
): Promise<CustomerDetail> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customers/${encodeURIComponent(customerId)}`,
    accessToken,
  )
  if (!isCustomerDetail(data)) throw new CustomerApiError(502, 'Customer detail response is invalid.')
  return data
}

/** Loads the aggregate Customer Request impact for one Project detail view.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param projectId Project whose Customer impact should be loaded.
 * @returns The validated aggregate impact signal.
 */
export async function getProjectCustomerImpact(
  accessToken: string,
  projectId: string,
): Promise<CustomerImpactSignal> {
  const data = await requestJson(
    `${customersApiBaseUrl}/projects/${encodeURIComponent(projectId)}/customer-impact`,
    accessToken,
  )
  if (!isCustomerImpactSignal(data)) {
    throw new CustomerApiError(502, 'Customer impact response is invalid.')
  }
  return data
}

/** Loads the Customers linked to each Project the caller can view.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @returns The validated Project to Customer links, or null when the caller may not read Customers.
 */
export async function getProjectCustomerLinks(accessToken: string): Promise<ProjectCustomerLinkList | null> {
  let data: unknown
  try {
    data = await requestJson(`${customersApiBaseUrl}/customers/project-links`, accessToken)
  } catch (error) {
    if (error instanceof CustomerApiError && error.status === 403) return null
    throw error
  }
  if (!isProjectCustomerLinkList(data)) {
    throw new CustomerApiError(502, 'Project Customer links response is invalid.')
  }
  return data
}

/** Checks a Project to Customer link list response.
 *
 * @param value Untrusted response body.
 * @returns Whether the body is a list of Projects with their linked Customers.
 */
function isProjectCustomerLinkList(value: unknown): value is ProjectCustomerLinkList {
  return isRecord(value) && Array.isArray(value.items) && value.items.every((item) =>
    isRecord(item) && typeof item.projectId === 'string' && Array.isArray(item.customers) &&
    item.customers.every((customer) =>
      isRecord(customer) && typeof customer.customerId === 'string' && typeof customer.name === 'string' &&
      typeof customer.requestCount === 'number'
    )
  )
}

/** Saves one accepted Team Triage Entry as a Customer Request.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param teamId Team owning the accepted Triage Entry.
 * @param entryId Accepted Triage Entry to convert.
 * @param input Customer association and request importance.
 * @param context Mutation identity used for safe retries.
 * @returns The created or idempotently replayed Customer Request.
 */
export async function createCustomerRequestFromTriage(
  accessToken: string,
  teamId: string,
  entryId: string,
  input: CreateCustomerRequestFromTriageInput,
  context: MutationRequestContext,
): Promise<CustomerRequest> {
  const data = await requestJson(
    `${customersApiBaseUrl}/teams/${encodeURIComponent(teamId)}/triage-entries/${encodeURIComponent(entryId)}/customer-request`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
  if (!isCustomerRequest(data)) {
    throw new CustomerApiError(502, 'Customer Request response is invalid.')
  }
  return data
}

/** Body of a manual Customer Request create. The idempotency key travels in the `Idempotency-Key` header. */
export type CreateCustomerRequestBody = {
  /** Customer organization making the request. */
  customerId: string
  /** Contact making the request, when known. */
  contactId?: string
  /** Channel the request came from. */
  source: {
    /** Source channel. */
    kind: CustomerRequestSourceKind
    /** Whether the source can be notified when the Request completes. */
    canNotify: boolean
  }
  /** Original request message. */
  originalMessage: string
  /** Received instant in ISO 8601. */
  receivedAt: string
  /** Request importance. */
  importance: CustomerRequestImportance
}

/** Work Item a Customer Request links to or unlinks from. */
export type CustomerRequestWorkItemTarget = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
}

/** Creates one Customer.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param input Customer attributes.
 * @param context Mutation identity used for safe retries.
 * @returns The created or idempotently replayed Customer.
 */
export async function createCustomer(
  accessToken: string,
  input: CreateCustomerInput,
  context: MutationRequestContext,
): Promise<Customer> {
  const data = await requestJson(`${customersApiBaseUrl}/customers`, accessToken, jsonInit('POST', input, context))
  if (!isCustomer(data)) throw new CustomerApiError(502, 'Customer response is invalid.')
  return data
}

/** Updates one Customer with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Customer to update.
 * @param input Expected revision and the changed fields.
 * @returns The updated Customer.
 */
export async function updateCustomer(
  accessToken: string,
  customerId: string,
  input: UpdateCustomerInput,
): Promise<Customer> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customers/${encodeURIComponent(customerId)}`,
    accessToken,
    jsonInit('PATCH', input),
  )
  if (!isCustomer(data)) throw new CustomerApiError(502, 'Customer response is invalid.')
  return data
}

/** Adds one contact to a Customer.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Customer that owns the contact.
 * @param input Contact attributes.
 * @param context Mutation identity used for safe retries.
 * @returns The created or idempotently replayed contact.
 */
export async function createCustomerContact(
  accessToken: string,
  customerId: string,
  input: CreateCustomerContactInput,
  context: MutationRequestContext,
): Promise<CustomerContact> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customers/${encodeURIComponent(customerId)}/contacts`,
    accessToken,
    jsonInit('POST', input, context),
  )
  if (!isCustomerContact(data)) throw new CustomerApiError(502, 'Customer contact response is invalid.')
  return data
}

/** Updates one Customer contact with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Customer that owns the contact.
 * @param contactId Contact to update.
 * @param input Expected revision and the changed fields.
 * @returns The updated contact.
 */
export async function updateCustomerContact(
  accessToken: string,
  customerId: string,
  contactId: string,
  input: UpdateCustomerContactInput,
): Promise<CustomerContact> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contactId)}`,
    accessToken,
    jsonInit('PATCH', input),
  )
  if (!isCustomerContact(data)) throw new CustomerApiError(502, 'Customer contact response is invalid.')
  return data
}

/** Deletes one Customer contact with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Customer that owns the contact.
 * @param contactId Contact to delete.
 * @param expectedRevision Contact revision observed before the delete.
 */
export async function deleteCustomerContact(
  accessToken: string,
  customerId: string,
  contactId: string,
  expectedRevision: number,
): Promise<void> {
  await requestJson(
    `${customersApiBaseUrl}/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contactId)}?expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
    accessToken,
    { method: 'DELETE' },
  )
}

/** Records one Customer Request by hand.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param input Customer, source, message, and importance.
 * @param context Mutation identity whose key the server requires for safe retries.
 * @returns The created or idempotently replayed Customer Request.
 */
export async function createCustomerRequest(
  accessToken: string,
  input: CreateCustomerRequestBody,
  context: MutationRequestContext,
): Promise<CustomerRequest> {
  const data = await requestJson(`${customersApiBaseUrl}/customer-requests`, accessToken, jsonInit('POST', input, context))
  if (!isCustomerRequest(data)) throw new CustomerApiError(502, 'Customer Request response is invalid.')
  return data
}

/** Updates one Customer Request with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param requestId Customer Request to update.
 * @param input Expected revision and the changed fields.
 * @returns The updated Customer Request.
 */
export async function updateCustomerRequest(
  accessToken: string,
  requestId: string,
  input: UpdateCustomerRequestInput,
): Promise<CustomerRequest> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customer-requests/${encodeURIComponent(requestId)}`,
    accessToken,
    jsonInit('PATCH', input),
  )
  if (!isCustomerRequest(data)) throw new CustomerApiError(502, 'Customer Request response is invalid.')
  return data
}

/** Links one Customer Request to a Work Item.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param requestId Customer Request to link.
 * @param target Work Item to link.
 * @returns The updated Customer Request.
 */
export async function linkCustomerRequestWorkItem(
  accessToken: string,
  requestId: string,
  target: CustomerRequestWorkItemTarget,
): Promise<CustomerRequest> {
  return await sendRequestLink(requestId, 'work-items', accessToken, 'POST', target)
}

/** Removes one Customer Request-to-Work-Item link with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param requestId Customer Request to unlink.
 * @param target Linked Work Item.
 * @param expectedRevision Customer Request revision observed before the unlink.
 * @returns The updated Customer Request.
 */
export async function unlinkCustomerRequestWorkItem(
  accessToken: string,
  requestId: string,
  target: CustomerRequestWorkItemTarget,
  expectedRevision: number,
): Promise<CustomerRequest> {
  return await sendRequestLink(requestId, 'work-items', accessToken, 'DELETE', { ...target, expectedRevision })
}

/** Links one Customer Request directly to a Project.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param requestId Customer Request to link.
 * @param projectId Project to link.
 * @returns The updated Customer Request.
 */
export async function linkCustomerRequestProject(
  accessToken: string,
  requestId: string,
  projectId: string,
): Promise<CustomerRequest> {
  return await sendRequestLink(requestId, 'projects', accessToken, 'POST', { projectId })
}

/** Removes one direct Customer Request-to-Project link with a revision check.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param requestId Customer Request to unlink.
 * @param projectId Linked Project.
 * @param expectedRevision Customer Request revision observed before the unlink.
 * @returns The updated Customer Request.
 */
export async function unlinkCustomerRequestProject(
  accessToken: string,
  requestId: string,
  projectId: string,
  expectedRevision: number,
): Promise<CustomerRequest> {
  return await sendRequestLink(requestId, 'projects', accessToken, 'DELETE', { projectId, expectedRevision })
}

/** Sends one Customer Request link change and validates the returned Request. */
async function sendRequestLink(
  requestId: string,
  relation: 'work-items' | 'projects',
  accessToken: string,
  method: 'POST' | 'DELETE',
  body: Record<string, unknown>,
): Promise<CustomerRequest> {
  const data = await requestJson(
    `${customersApiBaseUrl}/customer-requests/${encodeURIComponent(requestId)}/${relation}`,
    accessToken,
    jsonInit(method, body),
  )
  if (!isCustomerRequest(data)) throw new CustomerApiError(502, 'Customer Request response is invalid.')
  return data
}

/** Builds a JSON mutation request, adding retry headers when the endpoint is idempotent. */
function jsonInit(method: string, body: unknown, context?: MutationRequestContext): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(context ? createMutationHeaders(context) : {}),
    },
    body: JSON.stringify(body),
  }
}

/** Sends one authenticated Customer request and decodes its JSON body. */
async function requestJson(url: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, {
    ...init,
    headers,
  })
  const data = await readJson(response)
  if (!response.ok) {
    const error = isRecord(data) ? data : {}
    throw new CustomerApiError(
      response.status,
      typeof error.message === 'string' && error.message.trim()
        ? error.message
        : 'Customer data could not be loaded.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
  return data
}

/** Reads a response body as untrusted JSON. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Validates the response envelope of the Customer list endpoint. */
function isCustomerPage(value: unknown): value is CustomerPage {
  return isRecord(value) && Array.isArray(value.customers) && value.customers.every(isCustomer) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string')
}

/** Validates the response shape of one Customer detail endpoint. */
function isCustomerDetail(value: unknown): value is CustomerDetail {
  return isRecord(value) && isCustomer(value.customer) &&
    Array.isArray(value.contacts) && value.contacts.every(isCustomerContact) &&
    Array.isArray(value.requests) && value.requests.every(isCustomerRequest) &&
    Array.isArray(value.workItems) && value.workItems.every(isWorkItemSummary) &&
    Array.isArray(value.projects) && value.projects.every(isProjectSummary)
}

/** Validates one saved Customer directory view. */
function isCustomerSavedView(value: unknown): value is CustomerSavedView {
  return isRecord(value) && isString(value.id) && isString(value.workspaceId) && isString(value.name) &&
    isRecord(value.filters) && isOptionalString(value.filters.search) &&
    isOptionalString(value.filters.tier) && isOptionalString(value.filters.size) &&
    isOptionalString(value.filters.status) && isOptionalString(value.filters.health) &&
    isOptionalNumber(value.filters.minBusinessValue) && isOptionalNumber(value.filters.minRequestCount) &&
    isOptionalString(value.filters.sortBy) && isOptionalString(value.filters.sortDirection) &&
    (value.groupBy === undefined || isOneOf(value.groupBy, ['tier', 'size', 'status', 'health', 'owner'])) &&
    isPositiveNumber(value.revision) && isString(value.createdAt) && isString(value.updatedAt)
}

/** Validates the aggregate Customer impact response used by Project details. */
function isCustomerImpactSignal(value: unknown): value is CustomerImpactSignal {
  return isRecord(value) && isNonnegativeNumber(value.customerCount) &&
    isNonnegativeNumber(value.requestCount) && isNonnegativeNumber(value.openRequestCount) &&
    isNonnegativeNumber(value.businessValueTotal) &&
    isOptionalNonnegativeNumber(value.highestBusinessValue) &&
    (value.highestImportance === undefined || isOneOf(value.highestImportance, ['low', 'normal', 'high', 'urgent'])) &&
    Array.isArray(value.requests) && value.requests.every(isCustomerImpactRequestSummary) &&
    isOneOf(value.prioritySignal, ['none', 'watch', 'high', 'critical']) &&
    Array.isArray(value.customers) && value.customers.every(isCustomerImpactContributor)
}

/** Validates safe Customer Request metadata in an impact projection. */
function isCustomerImpactRequestSummary(
  value: unknown,
): value is CustomerImpactRequestSummary {
  return isRecord(value) && isString(value.requestId) && isString(value.customerId) &&
    isOneOf(value.status, ['requested', 'in-progress', 'completed', 'closed', 'merged']) &&
    isOneOf(value.importance, ['low', 'normal', 'high', 'urgent']) &&
    isOneOf<CustomerImpactRequestSummary['sourceKind']>(value.sourceKind, [
      'form',
      'chat',
      'email',
      'webhook',
      'manual-handoff',
      'agent-run',
      'portal',
      'phone',
      'manual',
    ]) && isString(value.receivedAt)
}

/** Validates one Customer contributing to an aggregate impact signal. */
function isCustomerImpactContributor(
  value: unknown,
): value is CustomerImpactSignal['customers'][number] {
  return isRecord(value) && isString(value.customerId) && isString(value.name) &&
    isOneOf(value.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial']) &&
    isOneOf(value.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown']) &&
    isOptionalNonnegativeNumber(value.businessValue) && isNonnegativeNumber(value.requestCount)
}

/** Validates the stable fields needed by the Customer directory UI. */
function isCustomer(value: unknown): value is Customer {
  return isRecord(value) && value.schemaVersion === 1 &&
    isString(value.id) && isString(value.workspaceId) && isString(value.name) &&
    isOptionalString(value.domain) && isOptionalString(value.ownerUserId) &&
    isOneOf(value.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial']) &&
    isOneOf(value.size, ['startup', 'small', 'mid-market', 'enterprise']) &&
    isOneOf(value.status, ['prospect', 'active', 'inactive', 'churned']) &&
    isOneOf(value.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown']) &&
    isOptionalNumber(value.businessValue) && isOptionalString(value.notes) &&
    isNonnegativeNumber(value.contactCount) && isNonnegativeNumber(value.requestCount) &&
    isNonnegativeNumber(value.openRequestCount) && isPositiveNumber(value.revision) &&
    isString(value.createdAt) && isString(value.updatedAt)
}

/** Validates one Customer Contact response. */
function isCustomerContact(value: unknown): value is CustomerContact {
  return isRecord(value) && isString(value.id) && isString(value.workspaceId) &&
    isString(value.customerId) && isString(value.name) && isOptionalString(value.email) &&
    isOptionalString(value.role) && isOptionalString(value.phone) &&
    typeof value.primary === 'boolean' && isOneOf(value.status, ['active', 'inactive']) &&
    isPositiveNumber(value.revision) && isString(value.createdAt) && isString(value.updatedAt)
}

/** Validates one Customer Request response. */
function isCustomerRequest(value: unknown): value is CustomerRequest {
  return isRecord(value) && value.schemaVersion === 1 && isString(value.id) &&
    isString(value.workspaceId) && isString(value.customerId) && isOptionalString(value.contactId) &&
    isOptionalString(value.triageEntryId) && isCustomerRequestSource(value.source) &&
    isString(value.originalMessage) && isString(value.receivedAt) &&
    isOneOf(value.importance, ['low', 'normal', 'high', 'urgent']) &&
    isOneOf(value.status, ['requested', 'in-progress', 'completed', 'closed', 'merged']) &&
    isOptionalString(value.mergedIntoRequestId) && isOptionalString(value.mergedAt) && isOptionalString(value.mergedBy) &&
    Array.isArray(value.workItemLinks) && value.workItemLinks.every(isWorkItemLink) &&
    Array.isArray(value.projectLinks) && value.projectLinks.every(isProjectLink) &&
    isPositiveNumber(value.revision) &&
    isString(value.createdAt) && isString(value.updatedAt)
}

/** Validates one Customer Request-to-Work-Item link. */
function isWorkItemLink(value: unknown): boolean {
  return isRecord(value) && isString(value.teamId) && isString(value.workItemId) &&
    isOptionalString(value.projectId) && isString(value.linkedAt) && isString(value.linkedBy)
}

/** Validates one Customer Request-to-Project link. */
function isProjectLink(value: unknown): boolean {
  return isRecord(value) && isString(value.projectId) && isString(value.linkedAt) && isString(value.linkedBy)
}

/** Validates the provider-neutral source metadata on one Customer Request. */
function isCustomerRequestSource(value: unknown): boolean {
  return isRecord(value) && isOneOf<CustomerRequestSourceKind>(value.kind, [
    'form',
    'chat',
    'email',
    'webhook',
    'manual-handoff',
    'agent-run',
    'portal',
    'phone',
    'manual',
  ]) && typeof value.canNotify === 'boolean'
}

/** Validates a Customer Work Item summary without trusting arbitrary fields. */
function isWorkItemSummary(value: unknown): boolean {
  return isRecord(value) && isString(value.teamId) && isString(value.workItemId) &&
    isOptionalString(value.projectId) && isNonnegativeNumber(value.requestCount) &&
    Array.isArray(value.requestStates) && value.requestStates.every((state) =>
      isOneOf<CustomerRequestStatus>(state, ['requested', 'in-progress', 'completed', 'closed', 'merged'])
    ) && isOneOf(value.lifecycle, ['requested', 'in-progress', 'completed', 'unknown'])
}

/** Validates one Customer Project summary without trusting arbitrary fields. */
function isProjectSummary(value: unknown): value is CustomerProjectSummary {
  return isRecord(value) && isString(value.projectId) && isNonnegativeNumber(value.requestCount) &&
    Array.isArray(value.requestStates) && value.requestStates.every((state) =>
      isOneOf<CustomerProjectSummary['requestStates'][number]>(state, ['requested', 'in-progress', 'completed', 'closed', 'merged'])
    )
}

/** Checks a required string field. */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Checks an optional string field. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Checks an optional finite number field. */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

/** Checks an optional nonnegative finite number field. */
function isOptionalNonnegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || isNonnegativeNumber(value)
}

/** Checks a nonnegative finite number field. */
function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Checks a positive safe integer field. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Checks whether a value belongs to a finite string union. */
function isOneOf<const Expected extends string>(
  value: unknown,
  values: readonly Expected[],
): value is Expected {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}
