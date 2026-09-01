import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  CreateCustomerRequestInput,
  Customer,
  CustomerContact,
  CustomerProjectSummary,
  CustomerImpactRequestSummary,
  CustomerHealth,
  CustomerImpactSignal,
  CustomerRequest,
  CustomerRequestExternalReference,
  CustomerRequestImportance,
  CustomerRequestSource,
  CustomerRequestSourceKind,
  CustomerRequestStatus,
  CustomerRetentionResult,
  CustomerTier,
  CustomerWorkItemSummary,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
} from '@mukuroji/contracts'

/** Default customer-request retention period used by manual creation flows. */
export const CUSTOMER_DEFAULT_RETENTION_DAYS = 365

/** Maximum displayable customer directory page size. */
export const CUSTOMER_MAX_PAGE_LIMIT = 100

/** Maximum number of customer-owned rows read by one bounded operation. */
export const CUSTOMER_MAX_OPERATION_ROWS = 10_000

/** Stable application error produced by the Customer domain. */
export class CustomerError extends Error {
  /** HTTP status suitable for an adapter response. */
  readonly status: number

  /** Stable machine-readable failure code. */
  readonly code: string

  /** Creates a Customer domain error.
   *
   * @param status HTTP status suitable for an adapter response.
   * @param code Stable machine-readable failure code.
   * @param message Human-readable failure message.
   * @param options Optional native Error options.
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CustomerError'
    this.status = status
    this.code = code
  }
}

/** Creates a validated Customer record from a transport-independent input.
 *
 * @param workspaceId Workspace that owns the Customer.
 * @param id Stable Customer identifier.
 * @param input Validated Customer creation fields.
 * @param now Creation timestamp used for the record and default retention deadline.
 * @returns The newly created Customer record.
 */
export function createCustomerRecord(
  workspaceId: string,
  id: string,
  input: CreateCustomerInput,
  now: string,
): Customer {
  const createdAt = requireIsoInstant(now, 'Customer creation time')
  return {
    schemaVersion: 1,
    id: requireIdentifier(id, 'Customer ID'),
    workspaceId: requireWorkspaceId(workspaceId),
    name: requireText(input.name, 'Customer name', 300),
    ...(input.domain === undefined ? {} : { domain: requireDomain(input.domain) }),
    ...(input.ownerUserId === undefined
      ? {}
      : { ownerUserId: requireMemberKey(input.ownerUserId, 'Customer owner') }),
    tier: requireCustomerTier(input.tier),
    size: requireCustomerSize(input.size),
    status: requireCustomerStatus(input.status),
    health: requireCustomerHealth(input.health),
    ...(input.businessValue === undefined
      ? {}
      : { businessValue: requireBusinessValue(input.businessValue) }),
    ...(input.notes === undefined ? {} : { notes: requireText(input.notes, 'Customer notes', 8_000, true) }),
    retention: {
      expiresAt: input.retentionExpiresAt === undefined
        ? addDays(createdAt, CUSTOMER_DEFAULT_RETENTION_DAYS)
        : requireIsoInstant(input.retentionExpiresAt, 'Customer retention deadline'),
    },
    contactCount: 0,
    requestCount: 0,
    openRequestCount: 0,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

/** Applies a validated partial update to a Customer record.
 *
 * @param customer Existing Customer record to update.
 * @param input Validated partial fields and expected revision.
 * @param now Update timestamp stored on the result.
 * @returns The updated Customer record.
 */
export function updateCustomerRecord(
  customer: Customer,
  input: UpdateCustomerInput,
  now: string,
): Customer {
  assertRetentionMutable(customer.retention?.redactedAt, 'Customer')
  const updatedAt = requireIsoInstant(now, 'Customer update time')
  return {
    ...customer,
    ...(input.name === undefined ? {} : { name: requireText(input.name, 'Customer name', 300) }),
    ...(input.domain === undefined
      ? {}
      : input.domain === null ? { domain: undefined } : { domain: requireDomain(input.domain) }),
    ...(input.ownerUserId === undefined
      ? {}
      : input.ownerUserId === null
        ? { ownerUserId: undefined }
        : { ownerUserId: requireMemberKey(input.ownerUserId, 'Customer owner') }),
    ...(input.tier === undefined ? {} : { tier: requireCustomerTier(input.tier) }),
    ...(input.size === undefined ? {} : { size: requireCustomerSize(input.size) }),
    ...(input.status === undefined ? {} : { status: requireCustomerStatus(input.status) }),
    ...(input.health === undefined ? {} : { health: requireCustomerHealth(input.health) }),
    ...(input.businessValue === undefined
      ? {}
      : input.businessValue === null
        ? { businessValue: undefined }
        : { businessValue: requireBusinessValue(input.businessValue) }),
    ...(input.notes === undefined
      ? {}
      : input.notes === null ? { notes: undefined } : { notes: requireText(input.notes, 'Customer notes', 8_000, true) }),
    revision: customer.revision + 1,
    updatedAt,
  }
}

/** Creates a validated Customer contact record.
 *
 * @param workspaceId Workspace that owns the contact.
 * @param customerId Customer that owns the contact.
 * @param id Stable contact identifier.
 * @param input Validated contact creation fields.
 * @param now Creation timestamp used for the record and default retention deadline.
 * @returns The newly created contact record.
 */
export function createCustomerContactRecord(
  workspaceId: string,
  customerId: string,
  id: string,
  input: CreateCustomerContactInput,
  now: string,
): CustomerContact {
  const createdAt = requireIsoInstant(now, 'Contact creation time')
  return {
    id: requireIdentifier(id, 'Contact ID'),
    workspaceId: requireWorkspaceId(workspaceId),
    customerId: requireIdentifier(customerId, 'Customer ID'),
    name: requireText(input.name, 'Contact name', 300),
    ...(input.email === undefined ? {} : { email: requireEmail(input.email) }),
    ...(input.role === undefined ? {} : { role: requireText(input.role, 'Contact role', 300, true) }),
    ...(input.phone === undefined ? {} : { phone: requireText(input.phone, 'Contact phone', 100, true) }),
    primary: input.primary ?? false,
    status: 'active',
    retention: {
      expiresAt: input.retentionExpiresAt === undefined
        ? addDays(createdAt, CUSTOMER_DEFAULT_RETENTION_DAYS)
        : requireIsoInstant(input.retentionExpiresAt, 'Contact retention deadline'),
    },
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

/** Applies a validated partial update to a Customer contact.
 *
 * @param contact Existing contact record to update.
 * @param input Validated partial fields and expected revision.
 * @param now Update timestamp stored on the result.
 * @returns The updated contact record.
 */
export function updateCustomerContactRecord(
  contact: CustomerContact,
  input: UpdateCustomerContactInput,
  now: string,
): CustomerContact {
  assertRetentionMutable(contact.retention?.redactedAt, 'Customer contact')
  const updatedAt = requireIsoInstant(now, 'Contact update time')
  return {
    ...contact,
    ...(input.name === undefined ? {} : { name: requireText(input.name, 'Contact name', 300) }),
    ...(input.email === undefined
      ? {}
      : input.email === null ? { email: undefined } : { email: requireEmail(input.email) }),
    ...(input.role === undefined
      ? {}
      : input.role === null ? { role: undefined } : { role: requireText(input.role, 'Contact role', 300, true) }),
    ...(input.phone === undefined
      ? {}
      : input.phone === null ? { phone: undefined } : { phone: requireText(input.phone, 'Contact phone', 100, true) }),
    ...(input.primary === undefined ? {} : { primary: input.primary }),
    ...(input.status === undefined ? {} : { status: input.status }),
    revision: contact.revision + 1,
    updatedAt,
  }
}

/** Creates a validated Customer Request source-of-need record.
 *
 * @param workspaceId Workspace that owns the request.
 * @param id Stable Customer Request identifier.
 * @param input Validated request creation fields.
 * @param now Creation timestamp used for the record and default retention deadline.
 * @returns The newly created Customer Request record.
 */
export function createCustomerRequestRecord(
  workspaceId: string,
  id: string,
  input: CreateCustomerRequestInput,
  now: string,
): CustomerRequest {
  const createdAt = requireIsoInstant(now, 'Customer Request creation time')
  return {
    schemaVersion: 1,
    id: requireIdentifier(id, 'Customer Request ID'),
    workspaceId: requireWorkspaceId(workspaceId),
    customerId: requireIdentifier(input.customerId, 'Customer ID'),
    ...(input.contactId === undefined ? {} : { contactId: requireIdentifier(input.contactId, 'Contact ID') }),
    ...(input.triageEntryId === undefined
      ? {}
      : { triageEntryId: requireIdentifier(input.triageEntryId, 'Triage Entry ID') }),
    source: normalizeSource(input.source),
    originalMessage: requireText(input.originalMessage, 'Customer Request message', 32_000, true),
    receivedAt: requireIsoInstant(input.receivedAt, 'Customer Request received time'),
    importance: requireImportance(input.importance),
    ...(input.externalReference === undefined
      ? {}
      : { externalReference: normalizeExternalReference(input.externalReference) }),
    status: 'requested',
    workItemLinks: [],
    projectLinks: [],
    ...(input.retentionExpiresAt === undefined
      ? { retention: { expiresAt: addDays(createdAt, CUSTOMER_DEFAULT_RETENTION_DAYS) } }
      : { retention: { expiresAt: requireIsoInstant(input.retentionExpiresAt, 'Customer Request retention deadline') } }),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

/** Applies a validated partial update to a Customer Request.
 *
 * @param request Existing Customer Request to update.
 * @param input Validated partial fields and expected revision.
 * @param now Update timestamp stored on the result.
 * @returns The updated Customer Request.
 */
export function updateCustomerRequestRecord(
  request: CustomerRequest,
  input: UpdateCustomerRequestInput,
  now: string,
): CustomerRequest {
  assertRetentionMutable(request.retention?.redactedAt, 'Customer Request')
  const updatedAt = requireIsoInstant(now, 'Customer Request update time')
  return {
    ...request,
    ...(input.contactId === undefined
      ? {}
      : input.contactId === null
        ? { contactId: undefined }
        : { contactId: requireIdentifier(input.contactId, 'Contact ID') }),
    ...(input.source === undefined ? {} : { source: normalizeSource(input.source) }),
    ...(input.originalMessage === undefined
      ? {}
      : { originalMessage: requireText(input.originalMessage, 'Customer Request message', 32_000, true) }),
    ...(input.receivedAt === undefined
      ? {}
      : { receivedAt: requireIsoInstant(input.receivedAt, 'Customer Request received time') }),
    ...(input.importance === undefined ? {} : { importance: requireImportance(input.importance) }),
    ...(input.externalReference === undefined
      ? {}
      : input.externalReference === null
        ? { externalReference: undefined }
        : { externalReference: normalizeExternalReference(input.externalReference) }),
    ...(input.status === undefined ? {} : { status: requireCustomerRequestStatus(input.status) }),
    revision: request.revision + 1,
    updatedAt,
  }
}

/** Computes the explainable Customer impact signal for one Work Item or Project.
 *
 * @param customers Customers referenced by the candidate requests.
 * @param requests Requests associated with the Work Item or Project.
 * @returns The aggregate impact signal and its explainable request summaries.
 */
export function calculateCustomerImpactSignal(
  customers: readonly Customer[],
  requests: readonly CustomerRequest[],
): CustomerImpactSignal {
  const customerById = new Map(customers.map((customer) => [customer.id, customer]))
  const visibleRequests = requests.filter((request) => request.status !== 'merged')
  const requestGroups = new Map<string, CustomerRequest[]>()
  for (const request of visibleRequests) {
    const customerRequests = requestGroups.get(request.customerId) ?? []
    customerRequests.push(request)
    requestGroups.set(request.customerId, customerRequests)
  }
  const impactCustomers = [...requestGroups.entries()]
    .flatMap(([customerId, customerRequests]) => {
      const customer = customerById.get(customerId)
      if (!customer) return []
      return [{
        customerId,
        name: customer.name,
        tier: customer.tier,
        health: customer.health,
        ...(customer.businessValue === undefined ? {} : { businessValue: customer.businessValue }),
        requestCount: customerRequests.length,
      }]
    })
    .sort((left, right) => right.requestCount - left.requestCount || left.name.localeCompare(right.name))
  const openRequestCount = visibleRequests.filter((request) => isOpenRequestStatus(request.status)).length
  const businessValueTotal = impactCustomers.reduce(
    (total, customer) => total + (customer.businessValue ?? 0),
    0,
  )
  const highestBusinessValue = impactCustomers.reduce<number | undefined>(
    (highest, customer) => customer.businessValue === undefined
      ? highest
      : highest === undefined ? customer.businessValue : Math.max(highest, customer.businessValue),
    undefined,
  )
  const highestImportance = visibleRequests
    .map((request) => request.importance)
    .sort((left, right) => importanceWeight(right) - importanceWeight(left))[0]
  const impactRequests: CustomerImpactRequestSummary[] = visibleRequests
    .map((request) => ({
      requestId: request.id,
      customerId: request.customerId,
      status: request.status,
      importance: request.importance,
      sourceKind: request.source.kind,
      receivedAt: request.receivedAt,
    }))
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || left.requestId.localeCompare(right.requestId))
  const prioritySignal = resolvePrioritySignal(
    visibleRequests,
    impactCustomers.map((customer) => customer.health),
    businessValueTotal,
    openRequestCount,
  )
  return {
    customerCount: impactCustomers.length,
    requestCount: visibleRequests.length,
    openRequestCount,
    businessValueTotal,
    ...(highestBusinessValue === undefined ? {} : { highestBusinessValue }),
    ...(highestImportance === undefined ? {} : { highestImportance }),
    requests: impactRequests,
    prioritySignal,
    customers: impactCustomers,
  }
}

/** Projects a Customer impact signal for a principal without Customer management access.
 *
 * @param signal Impact signal containing the internal business-value fields.
 * @param canViewSensitiveData Whether the caller may receive Customer management data.
 * @returns A safe impact signal with business-value data and its derived priority threshold removed.
 */
export function projectCustomerImpactSignal(
  signal: CustomerImpactSignal,
  canViewSensitiveData: boolean,
): CustomerImpactSignal {
  if (canViewSensitiveData) return signal
  const projected: CustomerImpactSignal = {
    ...signal,
    businessValueTotal: 0,
    prioritySignal: resolveRestrictedPrioritySignal(signal),
    customers: signal.customers.map((customer) => {
      const projectedCustomer = { ...customer }
      delete projectedCustomer.businessValue
      return projectedCustomer
    }),
  }
  delete projected.highestBusinessValue
  return projected
}

/** Builds unique Customer Work Item summaries from request links.
 *
 * @param requests Customer Requests whose Work Item links should be aggregated.
 * @returns Deduplicated Work Item summaries sorted by canonical identity.
 */
export function deriveCustomerWorkItemSummaries(
  requests: readonly CustomerRequest[],
): CustomerWorkItemSummary[] {
  const summaries = new Map<string, CustomerWorkItemSummary>()
  for (const request of requests) {
    for (const link of request.workItemLinks) {
      const key = `${link.teamId}\u0000${link.workItemId}`
      const existing = summaries.get(key)
      if (existing) {
        const requestStates = [...new Set([...existing.requestStates, request.status])].sort()
        summaries.set(key, {
          ...existing,
          requestCount: existing.requestCount + 1,
          requestStates,
          lifecycle: deriveLifecycle(requestStates),
        })
        continue
      }
      summaries.set(key, {
        teamId: link.teamId,
        workItemId: link.workItemId,
        ...(link.projectId === undefined ? {} : { projectId: link.projectId }),
        requestCount: 1,
        requestStates: [request.status],
        lifecycle: deriveLifecycle([request.status]),
      })
    }
  }
  return [...summaries.values()].sort((left, right) =>
    `${left.teamId}:${left.workItemId}`.localeCompare(`${right.teamId}:${right.workItemId}`)
  )
}

/** Builds unique Customer Project summaries from direct and Work Item links.
 *
 * @param requests Customer Requests whose Project links should be aggregated.
 * @returns Deduplicated Project summaries sorted by Project identifier.
 */
export function deriveCustomerProjectSummaries(
  requests: readonly CustomerRequest[],
): CustomerProjectSummary[] {
  const summaries = new Map<string, { requestCount: number; requestStates: Set<CustomerRequestStatus> }>()
  for (const request of requests) {
    const projectIds = new Set<string>([
      ...request.projectLinks.map((link) => link.projectId),
      ...request.workItemLinks.flatMap((link) => link.projectId === undefined ? [] : [link.projectId]),
    ])
    for (const projectId of projectIds) {
      const existing = summaries.get(projectId)
      if (existing) {
        existing.requestCount += 1
        existing.requestStates.add(request.status)
      } else {
        summaries.set(projectId, { requestCount: 1, requestStates: new Set([request.status]) })
      }
    }
  }
  return [...summaries.entries()]
    .map(([projectId, summary]) => ({
      projectId,
      requestCount: summary.requestCount,
      requestStates: [...summary.requestStates].sort(),
    }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId))
}

/** Redacts expired Customer-owned fields while preserving relationship identifiers.
 *
 * @param customers Customers eligible for retention evaluation.
 * @param contacts Contacts eligible for retention evaluation.
 * @param requests Customer Requests eligible for retention evaluation.
 * @param now Timestamp against which retention deadlines are evaluated.
 * @returns Redacted record collections and counts for each record category.
 */
export function redactExpiredCustomerData(
  customers: readonly Customer[],
  contacts: readonly CustomerContact[],
  requests: readonly CustomerRequest[],
  now: string,
): {
  customers: Customer[]
  contacts: CustomerContact[]
  requests: CustomerRequest[]
  result: CustomerRetentionResult
} {
  const instant = Date.parse(requireIsoInstant(now, 'Retention evaluation time'))
  let customersRedacted = 0
  let contactsRedacted = 0
  let requestsRedacted = 0
  const nextCustomers = customers.map((customer) => {
    if (!isExpired(customer.retention?.expiresAt, instant) || customer.retention?.redactedAt) return customer
    customersRedacted += 1
    return {
      ...customer,
      name: '[redacted customer]',
      domain: undefined,
      ownerUserId: undefined,
      notes: undefined,
      businessValue: undefined,
      retention: { ...customer.retention, redactedAt: new Date(instant).toISOString() },
      revision: customer.revision + 1,
      updatedAt: new Date(instant).toISOString(),
    }
  })
  const nextContacts = contacts.map((contact): CustomerContact => {
    if (!isExpired(contact.retention?.expiresAt, instant) || contact.retention?.redactedAt) return contact
    contactsRedacted += 1
    return {
      ...contact,
      name: '[redacted contact]',
      email: undefined,
      role: undefined,
      phone: undefined,
      primary: false,
      status: 'inactive',
      retention: { ...contact.retention, redactedAt: new Date(instant).toISOString() },
      revision: contact.revision + 1,
      updatedAt: new Date(instant).toISOString(),
    }
  })
  const nextRequests = requests.map((request) => {
    if (!isExpired(request.retention?.expiresAt, instant) || request.retention?.redactedAt) return request
    requestsRedacted += 1
    return {
      ...request,
      originalMessage: '',
      source: {
        kind: request.source.kind,
        canNotify: false,
      },
      externalReference: undefined,
      retention: { ...request.retention, redactedAt: new Date(instant).toISOString() },
      revision: request.revision + 1,
      updatedAt: new Date(instant).toISOString(),
    }
  })
  return {
    customers: nextCustomers,
    contacts: nextContacts,
    requests: nextRequests,
    result: { customersRedacted, contactsRedacted, requestsRedacted },
  }
}

/** Tests whether an optional retention deadline has passed. */
function isExpired(value: string | undefined, nowEpochMilliseconds: number): boolean {
  return value !== undefined && Date.parse(value) <= nowEpochMilliseconds
}

/** Resolves a request's navigation lifecycle from its current states. */
function deriveLifecycle(states: readonly CustomerRequestStatus[]): CustomerWorkItemSummary['lifecycle'] {
  if (states.length === 0) return 'unknown'
  if (states.every((state) => state === 'completed' || state === 'closed' || state === 'merged')) return 'completed'
  if (states.some((state) => state === 'in-progress')) return 'in-progress'
  if (states.some((state) => state === 'requested')) return 'requested'
  return 'unknown'
}

/** Resolves an explainable priority signal without mutating Work Item priority. */
function resolvePrioritySignal(
  requests: readonly CustomerRequest[],
  healths: readonly CustomerHealth[],
  businessValueTotal: number,
  openRequestCount: number,
): CustomerImpactSignal['prioritySignal'] {
  if (requests.length === 0) return 'none'
  if (
    requests.some((request) => request.importance === 'urgent') ||
    healths.includes('critical') ||
    (openRequestCount > 0 && businessValueTotal >= 150)
  ) return 'critical'
  if (
    requests.some((request) => request.importance === 'high') ||
    healths.includes('at-risk') ||
    (openRequestCount > 0 && businessValueTotal >= 75)
  ) return 'high'
  return 'watch'
}

/** Resolves the impact signal using only fields allowed to restricted readers. */
function resolveRestrictedPrioritySignal(signal: CustomerImpactSignal): CustomerImpactSignal['prioritySignal'] {
  if (signal.requestCount === 0) return 'none'
  if (
    signal.requests.some((request) => request.importance === 'urgent') ||
    signal.customers.some((customer) => customer.health === 'critical')
  ) return 'critical'
  if (
    signal.requests.some((request) => request.importance === 'high') ||
    signal.customers.some((customer) => customer.health === 'at-risk')
  ) return 'high'
  return 'watch'
}

/** Returns whether a Customer Request remains open for impact reporting. */
function isOpenRequestStatus(status: CustomerRequestStatus): boolean {
  return status === 'requested' || status === 'in-progress'
}

/** Returns the numeric ordering of request importance. */
function importanceWeight(value: CustomerRequestImportance): number {
  return value === 'urgent' ? 4 : value === 'high' ? 3 : value === 'normal' ? 2 : 1
}

/** Normalizes and validates source metadata. */
function normalizeSource(value: CustomerRequestSource): CustomerRequestSource {
  return {
    kind: requireSourceKind(value.kind),
    ...(value.provider === undefined ? {} : { provider: requireText(value.provider, 'Request source provider', 200) }),
    ...(value.referenceId === undefined ? {} : { referenceId: requireText(value.referenceId, 'Request source reference', 500) }),
    ...(value.permalink === undefined ? {} : { permalink: requireHttpsUrl(value.permalink, 'Request source permalink') }),
    canNotify: value.canNotify,
  }
}

/** Normalizes and validates an external request reference. */
function normalizeExternalReference(value: CustomerRequestExternalReference): CustomerRequestExternalReference {
  return {
    provider: requireText(value.provider, 'External reference provider', 200),
    id: requireText(value.id, 'External reference ID', 500),
    ...(value.permalink === undefined ? {} : { permalink: requireHttpsUrl(value.permalink, 'External reference permalink') }),
  }
}

/** Adds whole UTC days to an ISO instant. */
function addDays(value: string, days: number): string {
  const date = new Date(requireIsoInstant(value, 'Retention base time'))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

/** Requires a stable identifier safe for physical record keys. */
function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  }
  return normalized
}

/** Requires a Workspace identifier while allowing Cognito-style delimiters. */
function requireWorkspaceId(value: string): string {
  const workspaceId = requireText(value, 'Workspace ID', 500)
  if ([...workspaceId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) throw new CustomerError(400, 'InvalidCustomerInput', 'Workspace ID is invalid.')
  return workspaceId
}

/** Requires a Workspace member key. */
function requireMemberKey(value: string, label: string): string {
  const normalized = requireText(value, label, 320)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(normalized)) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  }
  return normalized
}

/** Requires bounded text. */
function requireText(value: string, label: string, maximumLength: number, allowEmpty = false): string {
  const normalized = value.trim()
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximumLength) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  }
  return normalized
}

/** Prevents a retention-redacted record from being repopulated by a later update. */
function assertRetentionMutable(redactedAt: string | undefined, label: string): void {
  if (redactedAt !== undefined) {
    throw new CustomerError(
      409,
      'CustomerRetentionRedacted',
      `${label} data was redacted by retention policy and cannot be updated.`,
    )
  }
}

/** Requires a canonical ISO instant. */
function requireIsoInstant(value: string, label: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return date.toISOString()
}

/** Requires a normalized customer domain. */
function requireDomain(value: string): string {
  const domain = requireText(value, 'Customer domain', 253).toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(domain)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer domain is invalid.')
  }
  return domain
}

/** Requires a normalized email address. */
function requireEmail(value: string): string {
  const email = requireText(value, 'Contact email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Contact email is invalid.')
  }
  return email
}

/** Requires a business-value score in the reviewed range. */
function requireBusinessValue(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Business value must be between 0 and 100.')
  }
  return value
}

/** Requires a known Customer tier. */
function requireCustomerTier(value: CustomerTier): CustomerTier {
  if (!['strategic', 'enterprise', 'growth', 'standard', 'trial'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer tier is invalid.')
  }
  return value
}

/** Requires a known Customer size. */
function requireCustomerSize(value: CreateCustomerInput['size']): CreateCustomerInput['size'] {
  if (!['startup', 'small', 'mid-market', 'enterprise'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer size is invalid.')
  }
  return value
}

/** Requires a known Customer status. */
function requireCustomerStatus(value: CreateCustomerInput['status']): CreateCustomerInput['status'] {
  if (!['prospect', 'active', 'inactive', 'churned'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer status is invalid.')
  }
  return value
}

/** Requires a known Customer health. */
function requireCustomerHealth(value: CustomerHealth): CustomerHealth {
  if (!['healthy', 'watch', 'at-risk', 'critical', 'unknown'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer health is invalid.')
  }
  return value
}

/** Requires a known Customer Request status. */
function requireCustomerRequestStatus(value: CustomerRequestStatus): CustomerRequestStatus {
  if (!['requested', 'in-progress', 'completed', 'closed', 'merged'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer Request status is invalid.')
  }
  return value
}

/** Requires a known Customer Request importance. */
function requireImportance(value: CustomerRequestImportance): CustomerRequestImportance {
  if (!['low', 'normal', 'high', 'urgent'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer Request importance is invalid.')
  }
  return value
}

/** Requires a known Customer Request source kind. */
function requireSourceKind(value: CustomerRequestSourceKind): CustomerRequestSourceKind {
  if (!['form', 'chat', 'email', 'webhook', 'manual-handoff', 'portal', 'phone', 'manual'].includes(value)) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer Request source kind is invalid.')
  }
  return value
}

/** Requires an HTTPS permalink without embedded credentials. */
function requireHttpsUrl(value: string, label: string): string {
  const normalized = requireText(value, label, 2_048)
  let url: URL
  try {
    url = new URL(normalized)
  } catch (error) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`, { cause: error })
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  }
  return url.toString()
}
