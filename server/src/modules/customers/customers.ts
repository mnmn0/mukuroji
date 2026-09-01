import { createHash, randomUUID } from 'node:crypto'
import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  CreateCustomerRequestInput,
  CreateCustomerSavedViewInput,
  Customer,
  CustomerCompletionNotification,
  CustomerContact,
  CustomerDetail,
  CustomerImpactSignal,
  CustomerListInput,
  CustomerPage,
  LinkCustomerRequestProjectInput,
  CustomerRequest,
  CustomerRequestListInput,
  CustomerRequestPage,
  CustomerSavedView,
  CustomerWorkspaceExport,
  CustomerWorkItemSummary,
  LinkCustomerRequestWorkItemInput,
  MergeCustomerContactInput,
  MergeCustomerInput,
  MergeCustomerRequestInput,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
  UpdateCustomerSavedViewInput,
} from '@mukuroji/contracts'
import {
  calculateCustomerImpactSignal,
  createCustomerContactRecord,
  createCustomerRecord,
  createCustomerRequestRecord,
  deriveCustomerProjectSummaries,
  deriveCustomerWorkItemSummaries,
  redactExpiredCustomerData,
  updateCustomerContactRecord,
  updateCustomerRecord,
  updateCustomerRequestRecord,
} from './domain/customer'
import { CustomerError } from './domain/customer'

/** Complete mutable Customer state for one Workspace. */
export type CustomerWorkspaceState = {
  /** Customer records keyed by ID. */
  customers: Map<string, Customer>
  /** Contact records keyed by ID. */
  contacts: Map<string, CustomerContact>
  /** Customer Request records keyed by ID. */
  requests: Map<string, CustomerRequest>
  /** Saved Customer views keyed by ID. */
  views: Map<string, CustomerSavedView>
  /** Prepared completion notification candidates keyed by deterministic ID. */
  notifications: Map<string, CustomerCompletionNotification>
}

/** Public Customer persistence and application surface. */
export interface CustomerClient {
  /** Lists customers within one Workspace boundary. */
  listCustomers(workspaceId: string, input?: CustomerListInput): Promise<CustomerPage>
  /** Reads a customer and its related graph. */
  getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail>
  /** Creates a customer. */
  createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer>
  /** Updates a customer under an optimistic revision fence. */
  updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer>
  /** Deletes a customer and its owned contacts and requests. */
  deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Merges a source customer into a retained customer. */
  mergeCustomer(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail>
  /** Lists contacts belonging to a customer. */
  listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]>
  /** Reads one contact under its customer boundary. */
  getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact>
  /** Creates a customer contact. */
  createContact(workspaceId: string, customerId: string, actorId: string, input: CreateCustomerContactInput): Promise<CustomerContact>
  /** Updates a customer contact under an optimistic revision fence. */
  updateContact(workspaceId: string, customerId: string, contactId: string, actorId: string, input: UpdateCustomerContactInput): Promise<CustomerContact>
  /** Deletes a customer contact. */
  deleteContact(workspaceId: string, customerId: string, contactId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Merges a source contact into a retained contact. */
  mergeContact(workspaceId: string, sourceContactId: string, actorId: string, input: MergeCustomerContactInput): Promise<CustomerContact>
  /** Lists customer requests within a Workspace boundary. */
  listRequests(workspaceId: string, input?: CustomerRequestListInput): Promise<CustomerRequestPage>
  /** Reads one Customer Request. */
  getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest>
  /** Creates a Customer Request. */
  createRequest(workspaceId: string, actorId: string, input: CreateCustomerRequestInput): Promise<CustomerRequest>
  /** Updates a Customer Request under an optimistic revision fence. */
  updateRequest(workspaceId: string, requestId: string, actorId: string, input: UpdateCustomerRequestInput): Promise<CustomerRequest>
  /** Deletes a Customer Request. */
  deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Merges a source request into a retained request. */
  mergeRequest(workspaceId: string, sourceRequestId: string, actorId: string, input: MergeCustomerRequestInput): Promise<CustomerRequest>
  /** Links a request to a Work Item, allowing many requests per Work Item. */
  linkRequestToWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput): Promise<CustomerRequest>
  /** Removes a request-to-Work-Item link under a revision fence. */
  unlinkRequestFromWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput & { expectedRevision: number }): Promise<CustomerRequest>
  /** Links a request directly to a Project, allowing many requests per Project. */
  linkRequestToProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput): Promise<CustomerRequest>
  /** Removes a request-to-Project link under a revision fence. */
  unlinkRequestFromProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput & { expectedRevision: number }): Promise<CustomerRequest>
  /** Returns customer impact for one canonical Work Item. */
  getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal>
  /** Returns customer impact for one Project. */
  getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal>
  /** Returns Work Items associated with a Customer. */
  listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]>
  /** Lists saved customer directory views. */
  listSavedViews(workspaceId: string): Promise<CustomerSavedView[]>
  /** Creates a saved customer directory view. */
  createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput): Promise<CustomerSavedView>
  /** Updates a saved customer directory view. */
  updateSavedView(workspaceId: string, viewId: string, actorId: string, input: UpdateCustomerSavedViewInput): Promise<CustomerSavedView>
  /** Deletes a saved customer directory view. */
  deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Exports all Customer-owned records for one Workspace. */
  exportWorkspace(workspaceId: string): Promise<CustomerWorkspaceExport>
  /** Applies retention redaction to expired Customer-owned records. */
  redactExpired(workspaceId: string, now?: string): Promise<import('@mukuroji/contracts').CustomerRetentionResult>
  /** Prepares idempotent completion notification candidates for a Work Item. */
  prepareCompletionNotifications(workspaceId: string, teamId: string, workItemId: string, actorId: string, now?: string): Promise<CustomerCompletionNotification[]>
  /** Lists previously prepared completion notification candidates. */
  listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]>
}

/** In-memory Customer client used by API tests and local isolated composition. */
export class InMemoryCustomerClient implements CustomerClient {
  /** Per-Workspace Customer state. */
  private readonly workspaces = new Map<string, CustomerWorkspaceState>()

  /** Test-replaceable clock. */
  private readonly now: () => Date

  /** Test-replaceable ID generator. */
  private readonly id: () => string

  /** Creates an in-memory Customer client. */
  constructor(options: { now?: () => Date; id?: () => string } = {}) {
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
  }

  /** Returns a deep-cloned Workspace state for a durable adapter bridge. */
  readWorkspaceState(workspaceId: string): CustomerWorkspaceState {
    const state = this.state(workspaceId)
    return {
      customers: new Map([...state.customers].map(([id, customer]) => [id, clone(customer)])),
      contacts: new Map([...state.contacts].map(([id, contact]) => [id, clone(contact)])),
      requests: new Map([...state.requests].map(([id, request]) => [id, clone(request)])),
      views: new Map([...state.views].map(([id, view]) => [id, clone(view)])),
      notifications: new Map([...state.notifications].map(([id, notification]) => [id, clone(notification)])),
    }
  }

  /** Replaces a Workspace state after a durable adapter has loaded it. */
  replaceWorkspaceState(workspaceId: string, state: CustomerWorkspaceState): void {
    this.workspaces.set(workspaceId, {
      customers: new Map([...state.customers].map(([id, customer]) => [id, clone(customer)])),
      contacts: new Map([...state.contacts].map(([id, contact]) => [id, clone(contact)])),
      requests: new Map([...state.requests].map(([id, request]) => [id, clone(request)])),
      views: new Map([...state.views].map(([id, view]) => [id, clone(view)])),
      notifications: new Map([...state.notifications].map(([id, notification]) => [id, clone(notification)])),
    })
  }

  /** Lists customers within one Workspace boundary.
   *
   * @param workspaceId Workspace containing the customers.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered customer page.
   */
  async listCustomers(workspaceId: string, input: CustomerListInput = {}): Promise<CustomerPage> {
    const state = this.state(workspaceId)
    const limit = normalizeLimit(input.limit)
    const normalizedInput = { ...input, limit }
    const queryFingerprint = createListQueryFingerprint(normalizedInput)
    const datasetRevision = createCustomerDatasetRevision(state)
    const filtered = [...state.customers.values()]
      .map((customer) => this.withCustomerCounts(state, customer))
      .filter((customer) => matchesCustomer(customer, normalizedInput))
      .sort((left, right) => compareCustomers(left, right, normalizedInput))
    const offset = decodeOffset(
      input.cursor,
      workspaceId,
      'customers',
      queryFingerprint,
      datasetRevision,
    )
    const page = filtered.slice(offset, offset + limit).map(clone)
    return {
      customers: page,
      ...(offset + page.length < filtered.length
        ? {
            nextCursor: encodeOffset(
              workspaceId,
              'customers',
              offset + page.length,
              queryFingerprint,
              datasetRevision,
            ),
          }
        : {}),
    }
  }

  /** Reads a customer and its related graph. */
  async getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail> {
    const state = this.state(workspaceId)
    const customer = this.requireCustomer(state, customerId)
    const contacts = [...state.contacts.values()]
      .filter((contact) => contact.customerId === customer.id)
      .sort(compareByName)
    const requests = [...state.requests.values()]
      .filter((request) => request.customerId === customer.id)
      .sort(compareByReceivedAt)
    const activeRequests = requests.filter((request) => request.status !== 'merged')
    return {
      customer: clone(this.withCustomerCounts(state, customer)),
      contacts: contacts.map(clone),
      requests: requests.map(clone),
      workItems: deriveCustomerWorkItemSummaries(activeRequests),
      projects: deriveCustomerProjectSummaries(activeRequests),
    }
  }

  /** Creates a customer. */
  async createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const customer = createCustomerRecord(workspaceId, this.id(), input, this.now().toISOString())
    if ([...state.customers.values()].some((candidate) =>
      customerIdentityKey(candidate.name, candidate.domain) === customerIdentityKey(customer.name, customer.domain)
    )) throw new CustomerError(409, 'CustomerAlreadyExists', 'A customer with the same name and domain already exists.')
    state.customers.set(customer.id, customer)
    return clone(this.state(workspaceId).customers.get(customer.id) ?? customer)
  }

  /** Updates a customer under an optimistic revision fence. */
  async updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const current = this.requireCustomer(state, customerId)
    assertRevision(current.revision, input.expectedRevision, 'Customer')
    const updated = updateCustomerRecord(current, input, this.now().toISOString())
    if ([...state.customers.values()].some((customer) =>
      customer.id !== customerId && customerIdentityKey(customer.name, customer.domain) === customerIdentityKey(updated.name, updated.domain)
    )) throw new CustomerError(409, 'CustomerAlreadyExists', 'A customer with the same name and domain already exists.')
    state.customers.set(customerId, updated)
    return clone(this.withCustomerCounts(state, updated))
  }

  /** Deletes a customer and its owned contacts and requests. */
  async deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const current = this.requireCustomer(state, customerId)
    assertRevision(current.revision, expectedRevision, 'Customer')
    state.customers.delete(customerId)
    for (const [contactId, contact] of state.contacts) if (contact.customerId === customerId) state.contacts.delete(contactId)
    for (const [requestId, request] of state.requests) {
      if (request.customerId !== customerId) continue
      state.requests.delete(requestId)
      this.deleteRequestNotifications(state, requestId)
    }
    for (const [notificationId, notification] of state.notifications) {
      if (notification.customerId === customerId) state.notifications.delete(notificationId)
    }
  }

  /** Merges a source customer into a retained customer.
   *
   * @param workspaceId Workspace containing both customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target customer and revision fences.
   * @returns The retained customer's updated detail graph.
   */
  async mergeCustomer(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    if (sourceCustomerId === input.targetCustomerId) throw new CustomerError(400, 'InvalidCustomerMerge', 'A customer cannot be merged into itself.')
    const source = this.requireCustomer(state, sourceCustomerId)
    const target = this.requireCustomer(state, input.targetCustomerId)
    assertRevision(source.revision, input.sourceExpectedRevision, 'Source customer')
    assertRevision(target.revision, input.targetExpectedRevision, 'Target customer')
    const existingContactEmails = new Set(
      [...state.contacts.values()]
        .filter((contact) => contact.customerId === target.id)
        .map((contact) => normalizeContactEmail(contact.email))
        .filter((email): email is string => email !== undefined),
    )
    for (const contact of state.contacts.values()) {
      if (contact.customerId !== source.id) continue
      const email = normalizeContactEmail(contact.email)
      if (email === undefined) continue
      if (existingContactEmails.has(email)) {
        throw new CustomerError(
          409,
          'CustomerContactAlreadyExists',
          'Customer merge would create duplicate contact email addresses.',
        )
      }
      existingContactEmails.add(email)
    }
    const mergedAt = this.now().toISOString()
    for (const contact of state.contacts.values()) {
      if (contact.customerId !== source.id) continue
      state.contacts.set(contact.id, { ...contact, customerId: target.id, revision: contact.revision + 1, updatedAt: mergedAt })
    }
    for (const request of state.requests.values()) {
      if (request.customerId !== source.id) continue
      state.requests.set(request.id, { ...request, customerId: target.id, revision: request.revision + 1, updatedAt: mergedAt })
    }
    const retainedPrimaryContact = [...state.contacts.values()]
      .find((contact) => contact.customerId === target.id && contact.primary)
    if (retainedPrimaryContact) this.clearPrimaryContacts(state, target.id, retainedPrimaryContact.id)
    for (const [notificationId, notification] of state.notifications) {
      if (notification.customerId === source.id) {
        state.notifications.set(notificationId, { ...notification, customerId: target.id })
      }
    }
    state.customers.delete(source.id)
    const mergedTarget = {
      ...target,
      revision: target.revision + 1,
      updatedAt: mergedAt,
    }
    state.customers.set(target.id, mergedTarget)
    return await this.getCustomer(workspaceId, target.id)
  }

  /** Lists contacts belonging to a customer. */
  async listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]> {
    const state = this.state(workspaceId)
    this.requireCustomer(state, customerId)
    return [...state.contacts.values()]
      .filter((contact) => contact.customerId === customerId)
      .sort(compareByName)
      .map(clone)
  }

  /** Reads one contact under its customer boundary. */
  async getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact> {
    const state = this.state(workspaceId)
    this.requireCustomer(state, customerId)
    const contact = state.contacts.get(contactId)
    if (!contact || contact.customerId !== customerId) throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    return clone(contact)
  }

  /** Creates a customer contact.
   *
   * @param workspaceId Workspace containing the customer.
   * @param customerId Owning customer identifier.
   * @param actorId Authenticated actor creating the contact.
   * @param input Contact fields and retention settings.
   * @returns The created contact.
   */
  async createContact(workspaceId: string, customerId: string, actorId: string, input: CreateCustomerContactInput): Promise<CustomerContact> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    this.requireCustomer(state, customerId)
    const contact = createCustomerContactRecord(workspaceId, customerId, this.id(), input, this.now().toISOString())
    const normalizedEmail = normalizeContactEmail(input.email)
    if (normalizedEmail && [...state.contacts.values()].some((candidate) =>
      candidate.customerId === customerId && normalizeContactEmail(candidate.email) === normalizedEmail
    )) {
      throw new CustomerError(409, 'CustomerContactAlreadyExists', 'A contact with the same email already exists for this customer.')
    }
    if (input.primary) this.clearPrimaryContacts(state, customerId)
    state.contacts.set(contact.id, contact)
    return clone(this.state(workspaceId).contacts.get(contact.id) ?? contact)
  }

  /** Updates a customer contact under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the customer.
   * @param customerId Owning customer identifier.
   * @param contactId Contact being updated.
   * @param actorId Authenticated actor performing the update.
   * @param input Contact changes and the expected revision.
   * @returns The updated contact.
   */
  async updateContact(workspaceId: string, customerId: string, contactId: string, actorId: string, input: UpdateCustomerContactInput): Promise<CustomerContact> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const current = await this.getContact(workspaceId, customerId, contactId)
    assertRevision(current.revision, input.expectedRevision, 'Customer contact')
    const updated = updateCustomerContactRecord(current, input, this.now().toISOString())
    const normalizedEmail = normalizeContactEmail(updated.email)
    if (normalizedEmail && [...state.contacts.values()].some((contact) =>
      contact.id !== contactId && contact.customerId === customerId && normalizeContactEmail(contact.email) === normalizedEmail
    )) throw new CustomerError(409, 'CustomerContactAlreadyExists', 'A contact with the same email already exists for this customer.')
    if (updated.primary) this.clearPrimaryContacts(state, customerId, contactId)
    state.contacts.set(contactId, updated)
    return clone(updated)
  }

  /** Deletes a customer contact. */
  async deleteContact(workspaceId: string, customerId: string, contactId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const current = await this.getContact(workspaceId, customerId, contactId)
    assertRevision(current.revision, expectedRevision, 'Customer contact')
    const state = this.state(workspaceId)
    state.contacts.delete(contactId)
    for (const [requestId, request] of state.requests) {
      if (request.contactId !== contactId) continue
      state.requests.set(requestId, {
        ...request,
        contactId: undefined,
        revision: request.revision + 1,
        updatedAt: this.now().toISOString(),
      })
    }
  }

  /** Merges a source contact into a retained contact. */
  async mergeContact(workspaceId: string, sourceContactId: string, actorId: string, input: MergeCustomerContactInput): Promise<CustomerContact> {
    requireActor(actorId)
    if (sourceContactId === input.targetContactId) throw new CustomerError(400, 'InvalidCustomerMerge', 'A contact cannot be merged into itself.')
    const state = this.state(workspaceId)
    const source = this.requireContact(state, sourceContactId)
    const target = this.requireContact(state, input.targetContactId)
    if (source.customerId !== target.customerId) {
      throw new CustomerError(400, 'InvalidCustomerMerge', 'Contacts from different Customers cannot be merged.')
    }
    assertRevision(source.revision, input.sourceExpectedRevision, 'Source contact')
    assertRevision(target.revision, input.targetExpectedRevision, 'Target contact')
    for (const request of state.requests.values()) {
      if (request.contactId !== source.id) continue
      state.requests.set(request.id, { ...request, contactId: target.id, revision: request.revision + 1, updatedAt: this.now().toISOString() })
    }
    state.contacts.delete(source.id)
    const mergedTarget = {
      ...target,
      primary: target.primary || source.primary,
      revision: target.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    if (mergedTarget.primary) this.clearPrimaryContacts(state, target.customerId, target.id)
    state.contacts.set(target.id, mergedTarget)
    return clone(mergedTarget)
  }

  /** Lists customer requests within a Workspace boundary.
   *
   * @param workspaceId Workspace containing the requests.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered Customer Request page.
   */
  async listRequests(workspaceId: string, input: CustomerRequestListInput = {}): Promise<CustomerRequestPage> {
    const state = this.state(workspaceId)
    const limit = normalizeLimit(input.limit)
    const normalizedInput = { ...input, limit }
    const queryFingerprint = createListQueryFingerprint(normalizedInput)
    const datasetRevision = createRequestDatasetRevision(state)
    const filtered = [...state.requests.values()]
      .filter((request) => matchesRequest(request, normalizedInput))
      .sort(compareByReceivedAt)
    const offset = decodeOffset(
      input.cursor,
      workspaceId,
      'requests',
      queryFingerprint,
      datasetRevision,
    )
    const page = filtered.slice(offset, offset + limit).map(clone)
    return {
      requests: page,
      ...(offset + page.length < filtered.length
        ? {
            nextCursor: encodeOffset(
              workspaceId,
              'requests',
              offset + page.length,
              queryFingerprint,
              datasetRevision,
            ),
          }
        : {}),
    }
  }

  /** Reads one Customer Request. */
  async getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest> {
    const request = this.state(workspaceId).requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    return clone(request)
  }

  /** Creates a Customer Request.
   *
   * @param workspaceId Workspace containing the request.
   * @param actorId Authenticated actor creating the request.
   * @param input Request source, customer association, and retry identity.
   * @returns The created or idempotently replayed request.
   */
  async createRequest(workspaceId: string, actorId: string, input: CreateCustomerRequestInput): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    this.requireCustomer(state, input.customerId)
    const requestId = input.triageEntryId === undefined
      ? input.idempotencyKey === undefined
        ? this.id()
        : createIdempotentRequestId(workspaceId, input.idempotencyKey)
      : createTriageRequestId(workspaceId, input.triageEntryId)
    const request = createCustomerRequestRecord(workspaceId, requestId, input, this.now().toISOString())
    const existing = state.requests.get(request.id)
    if (existing) {
      if (!sameRequestOrigin(existing, request)) {
        throw new CustomerError(409, 'CustomerRequestAlreadyExists', 'A Customer Request already exists for this retry key or Triage Entry.')
      }
      if (existing.status === 'merged') {
        throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be reused.')
      }
      return clone(existing)
    }
    if (input.contactId) {
      const contact = this.requireContactForCustomer(state, input.contactId, input.customerId)
      if (contact.status !== 'active') {
        throw new CustomerError(409, 'CustomerContactInactive', 'An inactive contact cannot be assigned to a new Customer Request.')
      }
    }
    state.requests.set(request.id, request)
    return clone(this.state(workspaceId).requests.get(request.id) ?? request)
  }

  /** Updates a Customer Request under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request being updated.
   * @param actorId Authenticated actor performing the update.
   * @param input Request changes and the expected revision.
   * @returns The updated request.
   */
  async updateRequest(workspaceId: string, requestId: string, actorId: string, input: UpdateCustomerRequestInput): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const current = state.requests.get(requestId)
    if (!current) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (current.status === 'merged') throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be updated.')
    assertRevision(current.revision, input.expectedRevision, 'Customer Request')
    if (input.status === 'merged') throw new CustomerError(400, 'InvalidCustomerInput', 'A Customer Request can only become merged through a merge operation.')
    if (input.contactId && !state.contacts.has(input.contactId)) throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    if (input.contactId) {
      const contact = this.requireContactForCustomer(state, input.contactId, current.customerId)
      if (contact.status !== 'active') {
        throw new CustomerError(409, 'CustomerContactInactive', 'An inactive contact cannot be assigned to a Customer Request.')
      }
    }
    const updated = updateCustomerRequestRecord(current, input, this.now().toISOString())
    state.requests.set(requestId, updated)
    return clone(updated)
  }

  /** Deletes a Customer Request. */
  async deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    assertRevision(request.revision, expectedRevision, 'Customer Request')
    state.requests.delete(requestId)
    this.deleteRequestNotifications(state, requestId)
  }

  /** Merges a source request into a retained request.
   *
   * @param workspaceId Workspace containing both requests.
   * @param sourceRequestId Request being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target request and revision fences.
   * @returns The retained request after links are combined.
   */
  async mergeRequest(workspaceId: string, sourceRequestId: string, actorId: string, input: MergeCustomerRequestInput): Promise<CustomerRequest> {
    requireActor(actorId)
    if (sourceRequestId === input.targetRequestId) throw new CustomerError(400, 'InvalidCustomerMerge', 'A request cannot be merged into itself.')
    const state = this.state(workspaceId)
    const source = state.requests.get(sourceRequestId)
    const target = state.requests.get(input.targetRequestId)
    if (!source || !target) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (source.customerId !== target.customerId) {
      throw new CustomerError(400, 'InvalidCustomerMerge', 'Requests from different Customers cannot be merged.')
    }
    if (source.status === 'merged' || target.status === 'merged') {
      throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot participate in another merge.')
    }
    assertRevision(source.revision, input.sourceExpectedRevision, 'Source Customer Request')
    assertRevision(target.revision, input.targetExpectedRevision, 'Target Customer Request')
    const mergedAt = this.now().toISOString()
    const workItemLinks = mergeLinks(target.workItemLinks, source.workItemLinks)
    const projectLinks = mergeProjectLinks(target.projectLinks, source.projectLinks)
    const mergedTarget = {
      ...target,
      workItemLinks,
      projectLinks,
      revision: target.revision + 1,
      updatedAt: mergedAt,
    }
    const mergedSource: CustomerRequest = {
      ...source,
      status: 'merged',
      mergedIntoRequestId: target.id,
      mergedAt,
      mergedBy: actorId,
      revision: source.revision + 1,
      updatedAt: mergedAt,
    }
    state.requests.set(target.id, mergedTarget)
    state.requests.set(source.id, mergedSource)
    this.deleteRequestNotifications(state, source.id)
    return clone(mergedTarget)
  }

  /** Links a request to a Work Item, allowing many requests per Work Item. */
  async linkRequestToWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (request.status === 'merged') throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be linked.')
    const existingLink = request.workItemLinks.find((link) => link.teamId === input.teamId && link.workItemId === input.workItemId)
    const linkedAt = this.now().toISOString()
    const workItemLinks = existingLink && input.projectId !== undefined && existingLink.projectId !== input.projectId
      ? request.workItemLinks.map((link) => link === existingLink ? { ...link, projectId: input.projectId } : link)
      : existingLink ? request.workItemLinks : [...request.workItemLinks, { ...input, linkedAt, linkedBy: actorId }]
    if (workItemLinks === request.workItemLinks) return clone(request)
    const next = {
      ...request,
      workItemLinks,
      revision: request.revision + 1,
      updatedAt: linkedAt,
    }
    state.requests.set(requestId, next)
    return clone(next)
  }

  /** Removes a request-to-Work-Item link under a revision fence. */
  async unlinkRequestFromWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput & { expectedRevision: number }): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (request.status === 'merged') throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be unlinked.')
    assertRevision(request.revision, input.expectedRevision, 'Customer Request')
    const next = {
      ...request,
      workItemLinks: request.workItemLinks.filter((link) => !(link.teamId === input.teamId && link.workItemId === input.workItemId)),
      revision: request.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    state.requests.set(requestId, next)
    return clone(next)
  }

  /** Links a request directly to a Project, idempotently. */
  async linkRequestToProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (request.status === 'merged') throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be linked.')
    if (request.projectLinks.some((link) => link.projectId === input.projectId)) return clone(request)
    const next = {
      ...request,
      projectLinks: [...request.projectLinks, { ...input, linkedAt: this.now().toISOString(), linkedBy: actorId }],
      revision: request.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    state.requests.set(requestId, next)
    return clone(next)
  }

  /** Removes a request-to-Project link under a revision fence. */
  async unlinkRequestFromProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput & { expectedRevision: number }): Promise<CustomerRequest> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    if (request.status === 'merged') throw new CustomerError(409, 'CustomerRequestMerged', 'A merged Customer Request cannot be unlinked.')
    assertRevision(request.revision, input.expectedRevision, 'Customer Request')
    if (!request.projectLinks.some((link) => link.projectId === input.projectId)) return clone(request)
    const next = {
      ...request,
      projectLinks: request.projectLinks.filter((link) => link.projectId !== input.projectId),
      revision: request.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    state.requests.set(requestId, next)
    return clone(next)
  }

  /** Returns customer impact for one canonical Work Item. */
  async getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal> {
    const state = this.state(workspaceId)
    const requests = [...state.requests.values()].filter((request) => request.workItemLinks.some((link) => link.teamId === teamId && link.workItemId === workItemId))
    return calculateCustomerImpactSignal(
      [...state.customers.values()].map((customer) => this.withCustomerCounts(state, customer)),
      requests,
    )
  }

  /** Returns customer impact for one Project. */
  async getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal> {
    const state = this.state(workspaceId)
    const requests = [...state.requests.values()].filter((request) => request.projectLinks.some((link) => link.projectId === projectId) || request.workItemLinks.some((link) => link.projectId === projectId))
    return calculateCustomerImpactSignal(
      [...state.customers.values()].map((customer) => this.withCustomerCounts(state, customer)),
      requests,
    )
  }

  /** Returns Work Items associated with a Customer. */
  async listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]> {
    const detail = await this.getCustomer(workspaceId, customerId)
    return detail.workItems
  }

  /** Lists saved customer directory views. */
  async listSavedViews(workspaceId: string): Promise<CustomerSavedView[]> {
    return [...this.state(workspaceId).views.values()].sort(compareByName).map(clone)
  }

  /** Creates a saved customer directory view. */
  async createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput): Promise<CustomerSavedView> {
    requireActor(actorId)
    const now = this.now().toISOString()
    const view: CustomerSavedView = {
      id: this.id(),
      workspaceId,
      name: requireViewName(input.name),
      filters: clone(input.filters),
      ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.state(workspaceId).views.set(view.id, view)
    return clone(view)
  }

  /** Updates a saved customer directory view. */
  async updateSavedView(workspaceId: string, viewId: string, actorId: string, input: UpdateCustomerSavedViewInput): Promise<CustomerSavedView> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const current = state.views.get(viewId)
    if (!current) throw notFound('CustomerSavedViewNotFound', 'The saved customer view was not found.')
    assertRevision(current.revision, input.expectedRevision, 'Customer saved view')
    const updated: CustomerSavedView = {
      ...current,
      ...(input.name === undefined ? {} : { name: requireViewName(input.name) }),
      ...(input.filters === undefined ? {} : { filters: clone(input.filters) }),
      ...(input.groupBy === undefined ? {} : input.groupBy === null ? { groupBy: undefined } : { groupBy: input.groupBy }),
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    state.views.set(viewId, updated)
    return clone(updated)
  }

  /** Deletes a saved customer directory view. */
  async deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const view = state.views.get(viewId)
    if (!view) throw notFound('CustomerSavedViewNotFound', 'The saved customer view was not found.')
    assertRevision(view.revision, expectedRevision, 'Customer saved view')
    state.views.delete(viewId)
  }

  /** Exports all Customer-owned records for one Workspace. */
  async exportWorkspace(workspaceId: string): Promise<CustomerWorkspaceExport> {
    const state = this.state(workspaceId)
    return {
      schemaVersion: 1,
      workspaceId,
      exportedAt: this.now().toISOString(),
      customers: [...state.customers.values()].map((customer) => clone(this.withCustomerCounts(state, customer))),
      contacts: [...state.contacts.values()].map(clone),
      requests: [...state.requests.values()].map(clone),
      views: [...state.views.values()].map(clone),
      completionNotifications: [...state.notifications.values()].map(clone),
    }
  }

  /** Applies retention redaction to expired Customer-owned records. */
  async redactExpired(workspaceId: string, now = this.now().toISOString()) {
    const state = this.rawState(workspaceId)
    const redacted = redactExpiredCustomerData(
      [...state.customers.values()],
      [...state.contacts.values()],
      [...state.requests.values()],
      now,
    )
    for (const customer of redacted.customers) state.customers.set(customer.id, customer)
    for (const contact of redacted.contacts) state.contacts.set(contact.id, contact)
    for (const request of redacted.requests) state.requests.set(request.id, request)
    return redacted.result
  }

  /** Prepares idempotent completion notification candidates for a Work Item. */
  async prepareCompletionNotifications(workspaceId: string, teamId: string, workItemId: string, actorId: string, now = this.now().toISOString()): Promise<CustomerCompletionNotification[]> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const requests = [...state.requests.values()].filter((request) =>
      request.status !== 'merged' && request.workItemLinks.some((link) => link.teamId === teamId && link.workItemId === workItemId)
    )
    const candidates: CustomerCompletionNotification[] = []
    for (const request of requests) {
      const id = `completion:${teamId}:${workItemId}:${request.id}`
      const existing = state.notifications.get(id)
      if (existing) {
        candidates.push(clone(existing))
        continue
      }
      const notification: CustomerCompletionNotification = {
        id,
        workspaceId,
        requestId: request.id,
        customerId: request.customerId,
        teamId,
        workItemId,
        canNotify: request.source.canNotify && request.retention?.redactedAt === undefined,
        ...(request.retention?.redactedAt
          ? { skipReason: 'retention-redacted' as const }
          : request.source.canNotify ? {} : { skipReason: 'source-not-capable' as const }),
        preparedAt: now,
      }
      state.notifications.set(id, notification)
      candidates.push(clone(notification))
    }
    return candidates
  }

  /** Lists previously prepared completion notification candidates. */
  async listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]> {
    return [...this.state(workspaceId).notifications.values()]
      .filter((notification) => notification.teamId === teamId && notification.workItemId === workItemId)
      .map(clone)
  }

  /** Returns or creates one isolated Workspace state container. */
  private state(workspaceId: string): CustomerWorkspaceState {
    const state = this.rawState(workspaceId)
    const redacted = redactExpiredCustomerData(
      [...state.customers.values()],
      [...state.contacts.values()],
      [...state.requests.values()],
      this.now().toISOString(),
    )
    for (const customer of redacted.customers) state.customers.set(customer.id, customer)
    for (const contact of redacted.contacts) state.contacts.set(contact.id, contact)
    for (const request of redacted.requests) state.requests.set(request.id, request)
    return state
  }

  /** Returns or creates one Workspace state container without applying retention. */
  private rawState(workspaceId: string): CustomerWorkspaceState {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return existing
    const state: CustomerWorkspaceState = {
      customers: new Map(),
      contacts: new Map(),
      requests: new Map(),
      views: new Map(),
      notifications: new Map(),
    }
    this.workspaces.set(workspaceId, state)
    return state
  }

  /** Reads one customer or throws a stable not-found error. */
  private requireCustomer(state: CustomerWorkspaceState, customerId: string): Customer {
    const customer = state.customers.get(customerId)
    if (!customer) throw notFound('CustomerNotFound', 'The customer was not found.')
    return customer
  }

  /** Reads one contact or throws a stable not-found error. */
  private requireContact(state: CustomerWorkspaceState, contactId: string): CustomerContact {
    const contact = state.contacts.get(contactId)
    if (!contact) throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    return contact
  }

  /** Reads one contact and checks its Customer boundary. */
  private requireContactForCustomer(state: CustomerWorkspaceState, contactId: string, customerId: string): CustomerContact {
    const contact = this.requireContact(state, contactId)
    if (contact.customerId !== customerId) throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    return contact
  }

  /** Recomputes derived counts on a Customer response. */
  private withCustomerCounts(state: CustomerWorkspaceState, customer: Customer): Customer {
    return {
      ...customer,
      contactCount: [...state.contacts.values()].filter((contact) => contact.customerId === customer.id).length,
      requestCount: [...state.requests.values()].filter((request) => request.customerId === customer.id && request.status !== 'merged').length,
      openRequestCount: [...state.requests.values()].filter((request) => request.customerId === customer.id && isOpenRequest(request.status)).length,
    }
  }

  /** Clears the preferred flag from other contacts in one Customer. */
  private clearPrimaryContacts(state: CustomerWorkspaceState, customerId: string, exceptContactId?: string): void {
    for (const contact of state.contacts.values()) {
      if (contact.customerId !== customerId || !contact.primary || contact.id === exceptContactId) continue
      state.contacts.set(contact.id, { ...contact, primary: false, revision: contact.revision + 1, updatedAt: this.now().toISOString() })
    }
  }

  /** Removes completion candidates that reference a deleted or merged request. */
  private deleteRequestNotifications(state: CustomerWorkspaceState, requestId: string): void {
    for (const [notificationId, notification] of state.notifications) {
      if (notification.requestId === requestId) state.notifications.delete(notificationId)
    }
  }
}

/** Ensures a mutation has a stable actor identity. */
function requireActor(actorId: string): void {
  if (!actorId.trim()) throw new CustomerError(400, 'InvalidCustomerInput', 'Customer mutation actor is required.')
}

/** Throws a revision conflict when the observed value is stale. */
function assertRevision(current: number, expected: number, label: string): void {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new CustomerError(400, 'InvalidCustomerInput', `${label} revision is invalid.`)
  if (current !== expected) throw new CustomerError(409, 'CustomerRevisionConflict', `${label} changed. Reload and try again.`)
}

/** Creates a stable not-found Customer error. */
function notFound(code: string, message: string): CustomerError {
  return new CustomerError(404, code, message)
}

/** Builds the duplicate-detection key for a Customer's mutable identity fields. */
function customerIdentityKey(name: string, domain: string | undefined): string {
  return `${name.trim().toLocaleLowerCase('en-US')}\u0000${domain?.trim().toLowerCase() ?? ''}`
}

/** Normalizes a Contact email for duplicate detection and merge validation.
 *
 * @param email Optional Contact email.
 * @returns A case- and whitespace-normalized email, or undefined when empty.
 */
function normalizeContactEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase()
  return normalized || undefined
}

/** Matches one Customer directory query. */
function matchesCustomer(customer: Customer, input: CustomerListInput): boolean {
  const search = input.search?.trim().toLocaleLowerCase('en-US')
  return (!search || customer.name.toLocaleLowerCase('en-US').includes(search) || customer.domain?.includes(search) === true) &&
    (input.tier === undefined || customer.tier === input.tier) &&
    (input.size === undefined || customer.size === input.size) &&
    (input.status === undefined || customer.status === input.status) &&
    (input.health === undefined || customer.health === input.health) &&
    (input.minBusinessValue === undefined || (customer.businessValue ?? 0) >= input.minBusinessValue) &&
    (input.minRequestCount === undefined || customer.requestCount >= input.minRequestCount)
}

/** Orders two customers according to a directory query. */
function compareCustomers(left: Customer, right: Customer, input: CustomerListInput): number {
  const field = input.sortBy ?? 'updatedAt'
  const direction = input.sortDirection === 'ascending' ? 1 : -1
  const leftValue = field === 'businessValue' ? left.businessValue ?? -1 : field === 'requestCount' ? left.requestCount : field === 'openRequestCount' ? left.openRequestCount : left[field]
  const rightValue = field === 'businessValue' ? right.businessValue ?? -1 : field === 'requestCount' ? right.requestCount : field === 'openRequestCount' ? right.openRequestCount : right[field]
  const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
    ? leftValue - rightValue
    : String(leftValue).localeCompare(String(rightValue))
  return comparison * direction || left.id.localeCompare(right.id)
}

/** Matches one Customer Request query. */
function matchesRequest(request: CustomerRequest, input: CustomerRequestListInput): boolean {
  const search = input.search?.trim().toLocaleLowerCase('en-US')
  const searchable = `${request.originalMessage}\n${request.externalReference?.id ?? ''}\n${request.source.referenceId ?? ''}`.toLocaleLowerCase('en-US')
  return (input.customerId === undefined || request.customerId === input.customerId) &&
    (input.status === undefined || request.status === input.status) &&
    (input.importance === undefined || request.importance === input.importance) &&
    (input.sourceKind === undefined || request.source.kind === input.sourceKind) &&
    (!search || searchable.includes(search))
}

/** Orders requests by newest received time. */
function compareByReceivedAt(left: CustomerRequest, right: CustomerRequest): number {
  return right.receivedAt.localeCompare(left.receivedAt) || right.id.localeCompare(left.id)
}

/** Orders named records. */
function compareByName(left: { name: string; id: string }, right: { name: string; id: string }): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

/** Returns whether one request remains open. */
function isOpenRequest(status: CustomerRequest['status']): boolean {
  return status === 'requested' || status === 'in-progress'
}

/** Creates the deterministic ID used to make Triage-originated Request retries safe. */
function createTriageRequestId(workspaceId: string, triageEntryId: string): string {
  return `triage-${createHash('sha256').update(`${workspaceId}\u0000${triageEntryId}`, 'utf8').digest('hex')}`
}

/** Creates the deterministic ID used to make keyed Customer Request retries safe.
 *
 * @param workspaceId Workspace scope for the retry key.
 * @param idempotencyKey Caller-selected retry key.
 * @returns A deterministic physical-safe request identifier.
 */
function createIdempotentRequestId(workspaceId: string, idempotencyKey: string): string {
  const normalizedKey = idempotencyKey.trim()
  if (!normalizedKey) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Customer Request idempotency key is invalid.')
  }
  return `request-${createHash('sha256').update(`${workspaceId}\u0000${normalizedKey}`, 'utf8').digest('hex')}`
}

/** Compares immutable origin fields for a deterministic Customer Request retry. */
function sameRequestOrigin(left: CustomerRequest, right: CustomerRequest): boolean {
  return left.workspaceId === right.workspaceId &&
    left.customerId === right.customerId &&
    left.contactId === right.contactId &&
    left.triageEntryId === right.triageEntryId &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.originalMessage === right.originalMessage &&
    left.receivedAt === right.receivedAt &&
    left.importance === right.importance &&
    left.retention?.expiresAt === right.retention?.expiresAt &&
    JSON.stringify(left.externalReference) === JSON.stringify(right.externalReference)
}

/** Merges link arrays without duplicating a Work Item relation. */
function mergeLinks(left: CustomerRequest['workItemLinks'], right: CustomerRequest['workItemLinks']): CustomerRequest['workItemLinks'] {
  const links = new Map(left.map((link) => [`${link.teamId}\u0000${link.workItemId}`, link]))
  for (const link of right) links.set(`${link.teamId}\u0000${link.workItemId}`, link)
  return [...links.values()].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt))
}

/** Merges project link arrays without duplicating a Project relation. */
function mergeProjectLinks(left: CustomerRequest['projectLinks'], right: CustomerRequest['projectLinks']): CustomerRequest['projectLinks'] {
  const links = new Map(left.map((link) => [link.projectId, link]))
  for (const link of right) links.set(link.projectId, link)
  return [...links.values()].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt))
}

/** Validates a saved view name. */
function requireViewName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 200) throw new CustomerError(400, 'InvalidCustomerInput', 'Saved view name is invalid.')
  return name
}

/** Returns a bounded page limit. */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new CustomerError(400, 'InvalidCustomerInput', 'Customer page limit is invalid.')
  return value
}

/** Normalizes the query fields that determine one Customer list result.
 *
 * @param input Customer or Customer Request list input.
 * @returns A query object without the cursor position.
 */
function normalizeListQuery(input: CustomerListInput | CustomerRequestListInput): Record<string, unknown> {
  const query = { ...input }
  delete query.cursor
  return query
}

/** Creates a digest for the normalized list query embedded in a cursor.
 *
 * @param input Customer or Customer Request list input.
 * @returns A stable SHA-256 query fingerprint.
 */
function createListQueryFingerprint(input: CustomerListInput | CustomerRequestListInput): string {
  return createHash('sha256').update(JSON.stringify(normalizeListQuery(input)), 'utf8').digest('hex')
}

/** Creates a revision digest for Customer rows that affect directory counts and sorting.
 *
 * @param state Current Customer workspace state.
 * @returns A stable digest of Customer, Contact, and Request revisions.
 */
function createCustomerDatasetRevision(state: CustomerWorkspaceState): string {
  return createHash('sha256').update(JSON.stringify([
    ...[...state.customers.values()].map((customer) => [customer.id, customer.revision, customer.updatedAt]),
    ...[...state.contacts.values()].map((contact) => [contact.id, contact.customerId, contact.revision, contact.updatedAt]),
    ...[...state.requests.values()].map((request) => [request.id, request.customerId, request.status, request.revision, request.updatedAt]),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))), 'utf8').digest('hex')
}

/** Creates a revision digest for Customer Request list rows.
 *
 * @param state Current Customer workspace state.
 * @returns A stable digest of Request list revisions and sort fields.
 */
function createRequestDatasetRevision(state: CustomerWorkspaceState): string {
  return createHash('sha256').update(JSON.stringify(
    [...state.requests.values()]
      .map((request) => [
        request.id,
        request.customerId,
        request.status,
        request.importance,
        request.source,
        request.originalMessage,
        request.receivedAt,
        request.externalReference,
        request.revision,
        request.updatedAt,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ), 'utf8').digest('hex')
}

/** Encodes a Workspace-bound in-memory page offset with query and dataset fences.
 *
 * @param workspaceId Workspace scope bound to the cursor.
 * @param kind List resource kind bound to the cursor.
 * @param offset Next result offset.
 * @param queryFingerprint Fingerprint of the normalized list query.
 * @param datasetRevision Digest of the result dataset revision.
 * @returns An opaque base64url cursor.
 */
function encodeOffset(
  workspaceId: string,
  kind: string,
  offset: number,
  queryFingerprint: string,
  datasetRevision: string,
): string {
  return Buffer.from(JSON.stringify({ workspaceId, kind, offset, queryFingerprint, datasetRevision }), 'utf8').toString('base64url')
}

/** Decodes a Workspace-bound in-memory page offset and its query fences.
 *
 * @param value Opaque cursor supplied by the caller.
 * @param workspaceId Expected Workspace scope.
 * @param kind Expected list resource kind.
 * @param queryFingerprint Current normalized query fingerprint.
 * @param datasetRevision Current result dataset digest.
 * @returns The next result offset.
 * @throws CustomerError when the cursor is malformed or stale.
 */
function decodeOffset(
  value: string | undefined,
  workspaceId: string,
  kind: string,
  queryFingerprint: string,
  datasetRevision: string,
): number {
  if (value === undefined) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || parsed.workspaceId !== workspaceId || parsed.kind !== kind ||
      parsed.queryFingerprint !== queryFingerprint || parsed.datasetRevision !== datasetRevision ||
      typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error('invalid')
    return parsed.offset
  } catch (error) {
    throw new CustomerError(400, 'InvalidCustomerCursor', 'The customer cursor is invalid.', { cause: error })
  }
}

/** Deep-clones a JSON-compatible Customer value. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Checks whether an untrusted value is an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
