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
  CUSTOMER_DEFAULT_RETENTION_DAYS,
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
import type { TriageAuthorizationConditionChecks } from '../triage'

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

/** DynamoDB conditions supplied by an already-authorized live-resource boundary. */
export type CustomerAuthorizationConditionChecks = TriageAuthorizationConditionChecks

/** Public Customer persistence and application surface. */
export interface CustomerClient {
  /** Lists customers within one Workspace boundary.
   *
   * @param workspaceId Workspace containing the customers.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered customer page.
   */
  listCustomers(workspaceId: string, input?: CustomerListInput): Promise<CustomerPage>
  /** Reads a customer and its related graph.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to read.
   * @returns The Customer detail graph.
   */
  getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail>
  /** Creates a customer.
   *
   * @param workspaceId Workspace that will own the Customer.
   * @param actorId Authenticated actor creating the Customer.
   * @param input Customer creation fields.
   * @returns The created Customer.
   */
  createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer>
  /** Updates a customer under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to update.
   * @param actorId Authenticated actor performing the update.
   * @param input Customer changes and the expected revision.
   * @returns The updated Customer.
   */
  updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer>
  /** Deletes a customer and its owned contacts and requests.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Customer revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Records the first phase of a cross-store Customer deletion.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose external associations will be cleared.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Customer revision required to start deletion.
   * @returns A promise that resolves after the deletion marker is durable.
   */
  beginCustomerDeletion(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Completes a cross-store Customer deletion after external links are cleared.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer being deleted.
   * @param actorId Authenticated actor performing the deletion.
   * @returns A promise that resolves after the Customer graph is deleted.
   */
  completeCustomerDeletion(workspaceId: string, customerId: string, actorId: string): Promise<void>
  /** Merges a source customer into a retained customer.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target Customer and revision fences.
   * @returns The retained Customer detail graph.
   */
  mergeCustomer(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail>
  /** Records a resumable cross-store Customer merge.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target Customer and revision fences.
   * @returns A promise that resolves after the merge marker is durable.
   */
  beginCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<void>
  /** Cancels a cross-store Customer merge before the source graph is retired.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor cancelling the merge.
   * @param input Target Customer and revision fences.
   * @returns A promise that resolves after the durable merge marker is removed.
   */
  cancelCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<void>
  /** Completes a cross-store Customer merge after external links are repointed.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target Customer and revision fences.
   * @returns The retained Customer detail graph.
   */
  completeCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail>
  /** Lists contacts belonging to a customer.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose contacts should be listed.
   * @returns Contacts owned by the Customer.
   */
  listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]>
  /** Reads one contact under its customer boundary.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param contactId Contact to read.
   * @returns The requested contact.
   */
  getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact>
  /** Reads one contact by ID before its owning Customer is known.
   *
   * @param workspaceId Workspace containing the contact.
   * @param contactId Contact to read.
   * @returns The requested contact.
   */
  getContactById(workspaceId: string, contactId: string): Promise<CustomerContact>
  /** Creates a customer contact.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param actorId Authenticated actor creating the contact.
   * @param input Contact creation fields.
   * @returns The created contact.
   */
  createContact(workspaceId: string, customerId: string, actorId: string, input: CreateCustomerContactInput): Promise<CustomerContact>
  /** Updates a customer contact under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param contactId Contact to update.
   * @param actorId Authenticated actor performing the update.
   * @param input Contact changes and the expected revision.
   * @returns The updated contact.
   */
  updateContact(workspaceId: string, customerId: string, contactId: string, actorId: string, input: UpdateCustomerContactInput): Promise<CustomerContact>
  /** Deletes a customer contact.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param contactId Contact to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Contact revision required for deletion.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns A promise that resolves after deletion completes.
   */
  deleteContact(
    workspaceId: string,
    customerId: string,
    contactId: string,
    actorId: string,
    expectedRevision: number,
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<void>
  /** Merges a source contact into a retained contact.
   *
   * @param workspaceId Workspace containing both contacts.
   * @param sourceContactId Contact being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target contact and revision fences.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns The retained contact.
   */
  mergeContact(
    workspaceId: string,
    sourceContactId: string,
    actorId: string,
    input: MergeCustomerContactInput,
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerContact>
  /** Lists customer requests within a Workspace boundary.
   *
   * @param workspaceId Workspace containing the requests.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered Customer Request page.
   */
  listRequests(workspaceId: string, input?: CustomerRequestListInput): Promise<CustomerRequestPage>
  /** Reads one Customer Request.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to read.
   * @returns The requested Customer Request.
   */
  getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest>
  /** Creates a Customer Request.
   *
   * @param workspaceId Workspace that will own the request.
   * @param actorId Authenticated actor creating the request.
   * @param input Request creation fields.
   * @returns The created or idempotently replayed request.
   */
  createRequest(workspaceId: string, actorId: string, input: CreateCustomerRequestInput): Promise<CustomerRequest>
  /** Updates a Customer Request under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to update.
   * @param actorId Authenticated actor performing the update.
   * @param input Request changes and the expected revision.
   * @returns The updated Customer Request.
   */
  updateRequest(workspaceId: string, requestId: string, actorId: string, input: UpdateCustomerRequestInput): Promise<CustomerRequest>
  /** Deletes a Customer Request.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Request revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Merges a source request into a retained request.
   *
   * @param workspaceId Workspace containing both requests.
   * @param sourceRequestId Request being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target request and revision fences.
   * @returns The retained request.
   */
  mergeRequest(workspaceId: string, sourceRequestId: string, actorId: string, input: MergeCustomerRequestInput): Promise<CustomerRequest>
  /** Links a request to a Work Item, allowing many requests per Work Item.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to link.
   * @param actorId Authenticated actor creating the link.
   * @param input Work Item link fields.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns The updated Customer Request.
   */
  linkRequestToWorkItem(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestWorkItemInput,
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest>
  /** Removes a request-to-Work-Item link under a revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to unlink.
   * @param actorId Authenticated actor removing the link.
   * @param input Work Item link and expected request revision.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns The updated Customer Request.
   */
  unlinkRequestFromWorkItem(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestWorkItemInput & { expectedRevision: number },
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest>
  /** Links a request directly to a Project, allowing many requests per Project.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to link.
   * @param actorId Authenticated actor creating the link.
   * @param input Project link fields.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns The updated Customer Request.
   */
  linkRequestToProject(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestProjectInput,
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest>
  /** Removes a request-to-Project link under a revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to unlink.
   * @param actorId Authenticated actor removing the link.
   * @param input Project link and expected request revision.
   * @param authorizationConditionChecks Live-resource conditions to evaluate with the durable mutation.
   * @returns The updated Customer Request.
   */
  unlinkRequestFromProject(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestProjectInput & { expectedRevision: number },
    authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest>
  /** Returns customer impact for one canonical Work Item.
   *
   * @param workspaceId Workspace containing the Work Item links.
   * @param teamId Work Item Team.
   * @param workItemId Work Item to aggregate.
   * @returns The aggregate Customer impact signal.
   */
  getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal>
  /** Returns customer impact for one Project.
   *
   * @param workspaceId Workspace containing the Project links.
   * @param projectId Project to aggregate.
   * @returns The aggregate Customer impact signal.
   */
  getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal>
  /** Returns Work Items associated with a Customer.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose Work Items should be listed.
   * @returns Work Item summaries linked to the Customer.
   */
  listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]>
  /** Lists saved customer directory views.
   *
   * @param workspaceId Workspace containing the saved views.
   * @returns Saved views belonging to the Workspace.
   */
  listSavedViews(workspaceId: string): Promise<CustomerSavedView[]>
  /** Creates a saved customer directory view.
   *
   * @param workspaceId Workspace that owns the view.
   * @param actorId Authenticated actor creating the view.
   * @param input View name, filters, and grouping.
   * @param idempotencyKey Optional caller-selected retry key.
   * @returns The created or idempotently replayed view.
   */
  createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput, idempotencyKey?: string): Promise<CustomerSavedView>
  /** Updates a saved customer directory view.
   *
   * @param workspaceId Workspace containing the saved view.
   * @param viewId View to update.
   * @param actorId Authenticated actor performing the update.
   * @param input View changes and the expected revision.
   * @returns The updated saved view.
   */
  updateSavedView(workspaceId: string, viewId: string, actorId: string, input: UpdateCustomerSavedViewInput): Promise<CustomerSavedView>
  /** Deletes a saved customer directory view.
   *
   * @param workspaceId Workspace containing the saved view.
   * @param viewId View to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision View revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void>
  /** Exports all Customer-owned records for one Workspace.
   *
   * @param workspaceId Workspace to export.
   * @returns A point-in-time Customer data export.
   */
  exportWorkspace(workspaceId: string): Promise<CustomerWorkspaceExport>
  /** Applies retention redaction to expired Customer-owned records.
   *
   * @param workspaceId Workspace whose records should be evaluated.
   * @param now Optional evaluation timestamp.
   * @returns Counts of redacted records by category.
   */
  redactExpired(workspaceId: string, now?: string): Promise<import('@mukuroji/contracts').CustomerRetentionResult>
  /** Prepares idempotent completion notification candidates for a Work Item.
   *
   * @param workspaceId Workspace containing the Work Item links.
   * @param teamId Work Item Team.
   * @param workItemId Completed Work Item.
   * @param actorId Authenticated or service actor preparing candidates.
   * @param now Optional preparation timestamp.
   * @returns Deterministic notification candidates.
   */
  prepareCompletionNotifications(workspaceId: string, teamId: string, workItemId: string, actorId: string, now?: string): Promise<CustomerCompletionNotification[]>
  /** Lists previously prepared completion notification candidates.
   *
   * @param workspaceId Workspace containing the candidates.
   * @param teamId Work Item Team.
   * @param workItemId Work Item whose candidates should be listed.
   * @returns Previously prepared notification candidates.
   */
  listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]>
}

/** In-memory Customer client used by API tests and local isolated composition. */
export class InMemoryCustomerClient implements CustomerClient {
  /** Per-Workspace Customer state. */
  private readonly workspaces = new Map<string, CustomerWorkspaceState>()

  /** Cross-store Customer deletions waiting for Triage association cleanup. */
  private readonly pendingDeletions = new Map<string, CustomerDeletionMarker>()

  /** Cross-store Customer merges waiting for Triage association repointing. */
  private readonly pendingMerges = new Map<string, CustomerMergeMarker>()

  /** Test-replaceable clock. */
  private readonly now: () => Date

  /** Test-replaceable ID generator. */
  private readonly id: () => string

  /** Creates an in-memory Customer client.
   *
   * @param options Optional clock and identifier-generator replacements.
   */
  constructor(options: { now?: () => Date; id?: () => string } = {}) {
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
  }

  /** Returns a deep-cloned Workspace state for a durable adapter bridge.
   *
   * @param workspaceId Workspace whose state should be copied.
   * @returns A detached mutable state snapshot.
   */
  readWorkspaceState(workspaceId: string): CustomerWorkspaceState {
    return this.snapshotState(this.state(workspaceId))
  }

  /** Returns a deep-cloned Workspace state without applying retention.
   *
   * This bridge is used by destructive persistence operations that must not
   * introduce unrelated retention writes into the same mutation.
   *
   * @param workspaceId Workspace whose state should be copied.
   * @returns A detached mutable state snapshot without an implicit redaction pass.
   */
  readWorkspaceStateWithoutRetention(workspaceId: string): CustomerWorkspaceState {
    return this.snapshotState(this.rawState(workspaceId))
  }

  /** Copies every collection in a Customer Workspace state.
   *
   * @param state State to clone.
   * @returns A detached copy of the supplied state.
   */
  private snapshotState(state: CustomerWorkspaceState): CustomerWorkspaceState {
    return {
      customers: new Map([...state.customers].map(([id, customer]) => [id, clone(customer)])),
      contacts: new Map([...state.contacts].map(([id, contact]) => [id, clone(contact)])),
      requests: new Map([...state.requests].map(([id, request]) => [id, clone(request)])),
      views: new Map([...state.views].map(([id, view]) => [id, clone(view)])),
      notifications: new Map([...state.notifications].map(([id, notification]) => [id, clone(notification)])),
    }
  }

  /** Replaces a Workspace state after a durable adapter has loaded it.
   *
   * @param workspaceId Workspace whose state should be replaced.
   * @param state Detached state snapshot to install.
   */
  replaceWorkspaceState(workspaceId: string, state: CustomerWorkspaceState): void {
    this.workspaces.set(workspaceId, {
      customers: new Map([...state.customers].map(([id, customer]) => [id, clone(customer)])),
      contacts: new Map([...state.contacts].map(([id, contact]) => [id, clone(contact)])),
      requests: new Map([...state.requests].map(([id, request]) => [id, clone(request)])),
      views: new Map([...state.views].map(([id, view]) => [id, clone(view)])),
      notifications: new Map([...state.notifications].map(([id, notification]) => [id, clone(notification)])),
    })
  }

  /** Hides Customer-owned records from a read snapshot while an external operation is pending.
   *
   * @param workspaceId Workspace whose snapshot should be masked.
   * @param customerIds Customers hidden from the snapshot.
   * @returns Nothing; the supplied snapshot is mutated in place.
   */
  maskCustomerOperation(workspaceId: string, customerIds: readonly string[]): void {
    const state = this.rawState(workspaceId)
    const hiddenCustomerIds = new Set(customerIds)
    for (const customerId of hiddenCustomerIds) state.customers.delete(customerId)
    for (const [contactId, contact] of state.contacts) {
      if (hiddenCustomerIds.has(contact.customerId)) state.contacts.delete(contactId)
    }
    for (const [requestId, request] of state.requests) {
      if (hiddenCustomerIds.has(request.customerId)) state.requests.delete(requestId)
    }
    for (const [notificationId, notification] of state.notifications) {
      if (hiddenCustomerIds.has(notification.customerId)) state.notifications.delete(notificationId)
    }
  }

  /** Lists customers within one Workspace boundary.
   *
   * @param workspaceId Workspace containing the customers.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered customer page.
   */
  async listCustomers(workspaceId: string, input: CustomerListInput = {}): Promise<CustomerPage> {
    return await this.listCustomersFromState(workspaceId, this.state(workspaceId), input, false)
  }

  /** Lists customers using denormalized counts from a Customer-only persistence read.
   *
   * @param workspaceId Workspace containing the customers.
   * @param input Optional filters and a query-bound cursor.
   * @returns The filtered customer page.
   */
  async listCustomersUsingStoredCounts(workspaceId: string, input: CustomerListInput = {}): Promise<CustomerPage> {
    return await this.listCustomersFromState(workspaceId, this.state(workspaceId), input, true)
  }

  /** Recomputes Customer list counts in a complete mutable Workspace graph.
   *
   * @param workspaceId Workspace whose Customer roots should be synchronized.
   * @returns Nothing; changed roots are updated in place without advancing their revisions.
   */
  synchronizeCustomerCounts(workspaceId: string): void {
    const state = this.rawState(workspaceId)
    for (const customer of state.customers.values()) {
      const nextCounts = {
        contactCount: [...state.contacts.values()].filter((contact) => contact.customerId === customer.id).length,
        requestCount: [...state.requests.values()].filter((request) => request.customerId === customer.id && request.status !== 'merged').length,
        openRequestCount: [...state.requests.values()].filter((request) => request.customerId === customer.id && isOpenRequest(request.status)).length,
      }
      if (
        customer.contactCount === nextCounts.contactCount &&
        customer.requestCount === nextCounts.requestCount &&
        customer.openRequestCount === nextCounts.openRequestCount
      ) continue
      state.customers.set(customer.id, { ...customer, ...nextCounts })
    }
  }

  /** Applies one customer list query to a supplied state snapshot.
   *
   * @param workspaceId Workspace containing the supplied state.
   * @param state State snapshot to query.
   * @param input Optional filters and a query-bound cursor.
   * @param useStoredCounts Whether persisted root counts are already authoritative.
   * @returns The filtered customer page.
   */
  private async listCustomersFromState(
    workspaceId: string,
    state: CustomerWorkspaceState,
    input: CustomerListInput,
    useStoredCounts: boolean,
  ): Promise<CustomerPage> {
    const limit = normalizeLimit(input.limit)
    const normalizedInput = { ...input, limit }
    const queryFingerprint = createListQueryFingerprint(normalizedInput)
    const datasetRevision = createCustomerDatasetRevision(state)
    const filtered = [...state.customers.values()]
      .filter((customer) => !this.isCustomerUnavailable(workspaceId, customer.id))
      .map((customer) => useStoredCounts ? clone(customer) : this.withCustomerCounts(state, customer))
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

  /** Reads a customer and its related graph.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to read.
   * @returns The Customer detail graph.
   */
  async getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail> {
    this.assertCustomerAvailable(workspaceId, customerId)
    const state = this.state(workspaceId)
    return this.createCustomerDetail(state, customerId)
  }

  /** Creates a customer.
   *
   * @param workspaceId Workspace that will own the Customer.
   * @param actorId Authenticated actor creating the Customer.
   * @param input Customer creation fields.
   * @returns The created Customer.
   */
  async createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer> {
    requireActor(actorId)
    this.assertNoCustomerOperation(workspaceId)
    const state = this.state(workspaceId)
    const customer = createCustomerRecord(workspaceId, this.id(), input, this.now().toISOString())
    if ([...state.customers.values()].some((candidate) =>
      customerIdentityKey(candidate.name, candidate.domain) === customerIdentityKey(customer.name, customer.domain)
    )) throw new CustomerError(409, 'CustomerAlreadyExists', 'A customer with the same name and domain already exists.')
    state.customers.set(customer.id, customer)
    return clone(this.state(workspaceId).customers.get(customer.id) ?? customer)
  }

  /** Updates a customer under an optimistic revision fence.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to update.
   * @param actorId Authenticated actor performing the update.
   * @param input Customer changes and the expected revision.
   * @returns The updated Customer.
   */
  async updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer> {
    requireActor(actorId)
    this.assertCustomerAvailable(workspaceId, customerId)
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

  /** Deletes a customer and its owned contacts and requests.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Customer revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  async deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const pendingDeletion = this.pendingDeletions.get(workspaceId)
    if (pendingDeletion) {
      if (pendingDeletion.customerId !== customerId) {
        throw new CustomerError(409, 'CustomerDeletionInProgress', 'Another Customer deletion is still being completed.')
      }
      throw new CustomerError(409, 'CustomerDeletionInProgress', 'Clear the Customer Triage associations before completing deletion.')
    }
    if (this.pendingMerges.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'A Customer merge is still being completed.')
    }
    const state = this.rawState(workspaceId)
    const current = this.requireCustomer(state, customerId)
    assertRevision(current.revision, expectedRevision, 'Customer')
    this.deleteCustomerState(state, customerId)
  }

  /** Records the first phase of a cross-store Customer deletion.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose external associations will be cleared.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Customer revision required to start deletion.
   * @returns A promise that resolves after the deletion marker is durable.
   */
  async beginCustomerDeletion(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const pendingDeletion = this.pendingDeletions.get(workspaceId)
    if (pendingDeletion) {
      if (pendingDeletion.customerId !== customerId || pendingDeletion.expectedRevision !== expectedRevision) {
        throw new CustomerError(409, 'CustomerDeletionInProgress', 'Another Customer deletion is still being completed.')
      }
      return
    }
    if (this.pendingMerges.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'A Customer merge is still being completed.')
    }
    const current = this.requireCustomer(this.rawState(workspaceId), customerId)
    assertRevision(current.revision, expectedRevision, 'Customer')
    this.pendingDeletions.set(workspaceId, { customerId, expectedRevision })
  }

  /** Completes a cross-store Customer deletion after external links are cleared.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer being deleted.
   * @param actorId Authenticated actor performing the deletion.
   * @returns A promise that resolves after the Customer graph is deleted.
   */
  async completeCustomerDeletion(workspaceId: string, customerId: string, actorId: string): Promise<void> {
    requireActor(actorId)
    const pendingDeletion = this.pendingDeletions.get(workspaceId)
    if (!pendingDeletion || pendingDeletion.customerId !== customerId) {
      throw new CustomerError(409, 'CustomerDeletionInProgress', 'The Customer deletion marker is missing or does not match.')
    }
    const state = this.rawState(workspaceId)
    const current = this.requireCustomer(state, customerId)
    assertRevision(current.revision, pendingDeletion.expectedRevision, 'Customer')
    this.deleteCustomerState(state, customerId)
    this.pendingDeletions.delete(workspaceId)
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
    const pendingMerge = this.pendingMerges.get(workspaceId)
    if (pendingMerge) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'Complete the cross-store Customer merge before starting another merge.')
    }
    if (this.pendingDeletions.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerDeletionInProgress', 'A Customer deletion is still being completed.')
    }
    return await this.mergeCustomerState(workspaceId, sourceCustomerId, input)
  }

  /** Records a resumable cross-store Customer merge.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target Customer and revision fences.
   * @returns A promise that resolves after the merge marker is durable.
   */
  async beginCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<void> {
    requireActor(actorId)
    const pendingMerge = this.pendingMerges.get(workspaceId)
    if (pendingMerge) {
      if (!sameCustomerMergeMarker(pendingMerge, sourceCustomerId, input)) {
        throw new CustomerError(409, 'CustomerMergeInProgress', 'Another Customer merge is still being completed.')
      }
      return
    }
    if (this.pendingDeletions.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerDeletionInProgress', 'A Customer deletion is still being completed.')
    }
    const state = this.state(workspaceId)
    this.assertCustomerMergePreconditions(state, sourceCustomerId, input)
    this.pendingMerges.set(workspaceId, {
      sourceCustomerId,
      targetCustomerId: input.targetCustomerId,
      sourceExpectedRevision: input.sourceExpectedRevision,
      targetExpectedRevision: input.targetExpectedRevision,
    })
  }

  /** Cancels a cross-store Customer merge without changing either Customer graph. */
  async cancelCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<void> {
    requireActor(actorId)
    const pendingMerge = this.pendingMerges.get(workspaceId)
    if (!pendingMerge) return
    if (!sameCustomerMergeMarker(pendingMerge, sourceCustomerId, input)) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'Another Customer merge is still being completed.')
    }
    this.pendingMerges.delete(workspaceId)
  }

  /** Completes a cross-store Customer merge after external links are repointed.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target Customer and revision fences.
   * @returns The retained Customer detail graph.
   */
  async completeCustomerMerge(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail> {
    requireActor(actorId)
    const pendingMerge = this.pendingMerges.get(workspaceId)
    if (!pendingMerge || !sameCustomerMergeMarker(pendingMerge, sourceCustomerId, input)) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'The Customer merge marker is missing or does not match.')
    }
    const detail = await this.mergeCustomerState(workspaceId, sourceCustomerId, input)
    this.pendingMerges.delete(workspaceId)
    return detail
  }

  /** Lists contacts belonging to a customer.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose contacts should be listed.
   * @returns Contacts owned by the Customer.
   */
  async listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]> {
    this.assertCustomerAvailable(workspaceId, customerId)
    const state = this.state(workspaceId)
    this.requireCustomer(state, customerId)
    return [...state.contacts.values()]
      .filter((contact) => contact.customerId === customerId)
      .sort(compareByName)
      .map(clone)
  }

  /** Reads one contact under its customer boundary.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param contactId Contact to read.
   * @returns The requested contact.
   */
  async getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact> {
    this.assertCustomerAvailable(workspaceId, customerId)
    const state = this.state(workspaceId)
    this.requireCustomer(state, customerId)
    const contact = state.contacts.get(contactId)
    if (!contact || contact.customerId !== customerId) throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    return clone(contact)
  }

  /** Reads one contact by ID before its owning Customer is known.
   *
   * @param workspaceId Workspace containing the contact.
   * @param contactId Contact to read.
   * @returns The requested contact.
   */
  async getContactById(workspaceId: string, contactId: string): Promise<CustomerContact> {
    const state = this.state(workspaceId)
    const contact = state.contacts.get(contactId)
    if (!contact || this.isCustomerUnavailable(workspaceId, contact.customerId)) {
      throw notFound('CustomerContactNotFound', 'The customer contact was not found.')
    }
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
    this.assertCustomerAvailable(workspaceId, customerId)
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

  /** Deletes a customer contact.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Contact owner.
   * @param contactId Contact to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Contact revision required for deletion.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns A promise that resolves after deletion completes.
   */
  async deleteContact(
    workspaceId: string,
    customerId: string,
    contactId: string,
    actorId: string,
    expectedRevision: number,
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<void> {
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

  /** Merges a source contact into a retained contact.
   *
   * @param workspaceId Workspace containing both contacts.
   * @param sourceContactId Contact being merged away.
   * @param actorId Authenticated actor performing the merge.
   * @param input Target contact and revision fences.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns The retained contact.
   */
  async mergeContact(
    workspaceId: string,
    sourceContactId: string,
    actorId: string,
    input: MergeCustomerContactInput,
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerContact> {
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
      .filter((request) => !this.isCustomerUnavailable(workspaceId, request.customerId))
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

  /** Reads one Customer Request.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to read.
   * @returns The requested Customer Request.
   */
  async getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest> {
    const request = this.state(workspaceId).requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    this.assertCustomerAvailable(workspaceId, request.customerId)
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
    this.assertCustomerAvailable(workspaceId, input.customerId)
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
      if (!sameRequestOrigin(existing, request, input)) {
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

  /** Deletes a Customer Request.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision Request revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  async deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const request = state.requests.get(requestId)
    if (!request) throw notFound('CustomerRequestNotFound', 'The customer request was not found.')
    this.assertCustomerAvailable(workspaceId, request.customerId)
    assertRevision(request.revision, expectedRevision, 'Customer Request')
    if (request.triageEntryId !== undefined) {
      throw new CustomerError(
        409,
        'CustomerRequestTriageAssociation',
        'A Customer Request associated with a Triage Entry cannot be deleted.',
      )
    }
    if ([...state.requests.values()].some((candidate) => candidate.mergedIntoRequestId === requestId)) {
      throw new CustomerError(
        409,
        'CustomerRequestMergeDependency',
        'A Customer Request retained by a merge cannot be deleted.',
      )
    }
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
    if (source.triageEntryId !== undefined) {
      throw new CustomerError(
        409,
        'CustomerRequestTriageAssociation',
        'A Customer Request associated with a Triage Entry cannot be merged.',
      )
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

  /** Links a request to a Work Item, allowing many requests per Work Item.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to link.
   * @param actorId Authenticated actor creating the link.
   * @param input Work Item link fields.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns The updated Customer Request.
   */
  async linkRequestToWorkItem(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestWorkItemInput,
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest> {
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

  /** Removes a request-to-Work-Item link under a revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to unlink.
   * @param actorId Authenticated actor removing the link.
   * @param input Work Item link and expected request revision.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns The updated Customer Request.
   */
  async unlinkRequestFromWorkItem(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestWorkItemInput & { expectedRevision: number },
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest> {
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

  /** Links a request directly to a Project, idempotently.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to link.
   * @param actorId Authenticated actor creating the link.
   * @param input Project link fields.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns The updated Customer Request.
   */
  async linkRequestToProject(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestProjectInput,
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest> {
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

  /** Removes a request-to-Project link under a revision fence.
   *
   * @param workspaceId Workspace containing the request.
   * @param requestId Request to unlink.
   * @param actorId Authenticated actor removing the link.
   * @param input Project link and expected request revision.
   * @param _authorizationConditionChecks Live-resource conditions ignored by the in-memory implementation.
   * @returns The updated Customer Request.
   */
  async unlinkRequestFromProject(
    workspaceId: string,
    requestId: string,
    actorId: string,
    input: LinkCustomerRequestProjectInput & { expectedRevision: number },
    _authorizationConditionChecks?: CustomerAuthorizationConditionChecks,
  ): Promise<CustomerRequest> {
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

  /** Returns customer impact for one canonical Work Item.
   *
   * @param workspaceId Workspace containing the Work Item links.
   * @param teamId Work Item Team.
   * @param workItemId Work Item to aggregate.
   * @returns The aggregate Customer impact signal.
   */
  async getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal> {
    const state = this.state(workspaceId)
    const requests = [...state.requests.values()].filter((request) =>
      !this.isCustomerUnavailable(workspaceId, request.customerId) &&
      request.workItemLinks.some((link) => link.teamId === teamId && link.workItemId === workItemId)
    )
    return calculateCustomerImpactSignal(
      [...state.customers.values()]
        .filter((customer) => !this.isCustomerUnavailable(workspaceId, customer.id))
        .map((customer) => this.withCustomerCounts(state, customer)),
      requests,
    )
  }

  /** Returns customer impact for one Project.
   *
   * @param workspaceId Workspace containing the Project links.
   * @param projectId Project to aggregate.
   * @returns The aggregate Customer impact signal.
   */
  async getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal> {
    const state = this.state(workspaceId)
    const requests = [...state.requests.values()].filter((request) =>
      !this.isCustomerUnavailable(workspaceId, request.customerId) &&
      (request.projectLinks.some((link) => link.projectId === projectId) || request.workItemLinks.some((link) => link.projectId === projectId))
    )
    return calculateCustomerImpactSignal(
      [...state.customers.values()]
        .filter((customer) => !this.isCustomerUnavailable(workspaceId, customer.id))
        .map((customer) => this.withCustomerCounts(state, customer)),
      requests,
    )
  }

  /** Returns Work Items associated with a Customer.
   *
   * @param workspaceId Workspace containing the Customer.
   * @param customerId Customer whose Work Items should be listed.
   * @returns Work Item summaries linked to the Customer.
   */
  async listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]> {
    const detail = await this.getCustomer(workspaceId, customerId)
    return detail.workItems
  }

  /** Lists saved customer directory views.
   *
   * @param workspaceId Workspace containing the saved views.
   * @returns Saved views belonging to the Workspace.
   */
  async listSavedViews(workspaceId: string): Promise<CustomerSavedView[]> {
    return [...this.state(workspaceId).views.values()].sort(compareByName).map(clone)
  }

  /** Creates a saved customer directory view. */
  async createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput, idempotencyKey?: string): Promise<CustomerSavedView> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const name = requireViewName(input.name)
    const viewId = idempotencyKey === undefined
      ? this.id()
      : createIdempotentSavedViewId(workspaceId, idempotencyKey)
    const existing = state.views.get(viewId)
    if (existing) {
      if (!sameSavedViewOrigin(existing, name, input)) {
        throw new CustomerError(409, 'CustomerSavedViewAlreadyExists', 'A saved Customer view already exists for this retry key.')
      }
      return clone(existing)
    }
    const now = this.now().toISOString()
    const view: CustomerSavedView = {
      id: viewId,
      workspaceId,
      name,
      filters: clone(input.filters),
      ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.state(workspaceId).views.set(view.id, view)
    return clone(view)
  }

  /** Updates a saved customer directory view.
   *
   * @param workspaceId Workspace containing the saved view.
   * @param viewId View to update.
   * @param actorId Authenticated actor performing the update.
   * @param input View changes and the expected revision.
   * @returns The updated saved view.
   */
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

  /** Deletes a saved customer directory view.
   *
   * @param workspaceId Workspace containing the saved view.
   * @param viewId View to delete.
   * @param actorId Authenticated actor performing the deletion.
   * @param expectedRevision View revision required for deletion.
   * @returns A promise that resolves after deletion completes.
   */
  async deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void> {
    requireActor(actorId)
    const state = this.state(workspaceId)
    const view = state.views.get(viewId)
    if (!view) throw notFound('CustomerSavedViewNotFound', 'The saved customer view was not found.')
    assertRevision(view.revision, expectedRevision, 'Customer saved view')
    state.views.delete(viewId)
  }

  /** Exports all Customer-owned records for one Workspace.
   *
   * @param workspaceId Workspace to export.
   * @returns A point-in-time Customer data export.
   */
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

  /** Applies retention redaction to expired Customer-owned records.
   *
   * @param workspaceId Workspace whose records should be evaluated.
   * @param now Optional evaluation timestamp.
   * @returns Counts of redacted records by category.
   */
  async redactExpired(workspaceId: string, now = this.now().toISOString()): Promise<import('@mukuroji/contracts').CustomerRetentionResult> {
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

  /** Prepares idempotent completion notification candidates for a Work Item.
   *
   * @param workspaceId Workspace containing the Work Item links.
   * @param teamId Work Item Team.
   * @param workItemId Completed Work Item.
   * @param actorId Authenticated or service actor preparing candidates.
   * @param now Optional preparation timestamp.
   * @returns Deterministic notification candidates.
   */
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
      const notification = refreshCompletionNotification(existing, {
        id,
        workspaceId,
        requestId: request.id,
        teamId,
        workItemId,
        request,
        now,
      })
      if (!existing || JSON.stringify(existing) !== JSON.stringify(notification)) state.notifications.set(id, notification)
      candidates.push(clone(notification))
    }
    return candidates
  }

  /** Lists previously prepared completion notification candidates.
   *
   * @param workspaceId Workspace containing the candidates.
   * @param teamId Work Item Team.
   * @param workItemId Work Item whose candidates should be listed.
   * @returns Previously prepared notification candidates.
   */
  async listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]> {
    const state = this.state(workspaceId)
    const candidates: CustomerCompletionNotification[] = []
    for (const [notificationId, existing] of state.notifications) {
      if (existing.teamId !== teamId || existing.workItemId !== workItemId) continue
      const request = state.requests.get(existing.requestId)
      if (!request || request.status === 'merged' || !request.workItemLinks.some((link) => link.teamId === teamId && link.workItemId === workItemId)) {
        state.notifications.delete(notificationId)
        continue
      }
      const notification = refreshCompletionNotification(existing, {
        id: existing.id,
        workspaceId,
        requestId: request.id,
        teamId,
        workItemId,
        request,
        now: this.now().toISOString(),
      })
      if (JSON.stringify(existing) !== JSON.stringify(notification)) state.notifications.set(notificationId, notification)
      candidates.push(clone(notification))
    }
    return candidates
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

  /** Applies the Customer-side half of a merge to one mutable graph.
   *
   * @param workspaceId Workspace containing both Customers.
   * @param sourceCustomerId Customer being merged away.
   * @param input Target Customer and revision fences.
   * @returns The retained Customer detail graph.
   */
  private async mergeCustomerState(
    workspaceId: string,
    sourceCustomerId: string,
    input: MergeCustomerInput,
  ): Promise<CustomerDetail> {
    const state = this.state(workspaceId)
    this.assertCustomerMergePreconditions(state, sourceCustomerId, input)
    const source = this.requireCustomer(state, sourceCustomerId)
    const target = this.requireCustomer(state, input.targetCustomerId)
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
    return this.createCustomerDetail(state, target.id)
  }

  /** Validates Customer identity and revision constraints before a merge marker is written.
   *
   * @param state Customer graph to inspect.
   * @param sourceCustomerId Customer being merged away.
   * @param input Target Customer and revision fences.
   * @returns Nothing; throws when the merge cannot begin.
   */
  private assertCustomerMergePreconditions(
    state: CustomerWorkspaceState,
    sourceCustomerId: string,
    input: MergeCustomerInput,
  ): void {
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
  }

  /** Removes a Customer and every Customer-owned record from an in-memory graph.
   *
   * @param state Customer graph to mutate.
   * @param customerId Customer and owned records to remove.
   * @returns Nothing; the supplied graph is mutated in place.
   */
  private deleteCustomerState(state: CustomerWorkspaceState, customerId: string): void {
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

  /** Builds a Customer detail graph from an already loaded mutable state.
   *
   * @param state Customer graph to inspect.
   * @param customerId Customer whose detail graph should be built.
   * @returns The Customer detail graph.
   */
  private createCustomerDetail(state: CustomerWorkspaceState, customerId: string): CustomerDetail {
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

  /** Checks whether a Customer is hidden by a pending cross-store operation.
   *
   * @param workspaceId Workspace containing the operation.
   * @param customerId Customer to inspect.
   * @returns Whether the Customer must be hidden from reads.
   */
  private isCustomerUnavailable(workspaceId: string, customerId: string): boolean {
    const pendingDeletion = this.pendingDeletions.get(workspaceId)
    if (pendingDeletion?.customerId === customerId) return true
    const pendingMerge = this.pendingMerges.get(workspaceId)
    return pendingMerge?.sourceCustomerId === customerId || pendingMerge?.targetCustomerId === customerId
  }

  /** Throws a not-found error for a Customer hidden by a pending operation.
   *
   * @param workspaceId Workspace containing the operation.
   * @param customerId Customer to inspect.
   * @returns Nothing; throws when the Customer is unavailable.
   */
  private assertCustomerAvailable(workspaceId: string, customerId: string): void {
    if (this.isCustomerUnavailable(workspaceId, customerId)) {
      throw notFound('CustomerNotFound', 'The customer was not found.')
    }
  }

  /** Rejects a new operation while another cross-store operation owns the Workspace.
   *
   * @param workspaceId Workspace to inspect.
   * @returns Nothing; throws when another operation is pending.
   */
  private assertNoCustomerOperation(workspaceId: string): void {
    if (this.pendingDeletions.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerDeletionInProgress', 'A Customer deletion is still being completed.')
    }
    if (this.pendingMerges.has(workspaceId)) {
      throw new CustomerError(409, 'CustomerMergeInProgress', 'A Customer merge is still being completed.')
    }
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

/** In-memory marker for a deletion whose external associations are being cleared. */
type CustomerDeletionMarker = {
  /** Customer whose external associations are being cleared. */
  customerId: string
  /** Customer revision captured when the operation started. */
  expectedRevision: number
}

/** In-memory marker for a merge whose external associations are being repointed. */
type CustomerMergeMarker = {
  /** Customer being merged away. */
  sourceCustomerId: string
  /** Customer that will remain after the merge. */
  targetCustomerId: string
  /** Source revision captured when the operation started. */
  sourceExpectedRevision: number
  /** Target revision captured when the operation started. */
  targetExpectedRevision: number
}

/** Inputs needed to derive one completion notification candidate. */
type CompletionNotificationSeed = {
  /** Deterministic notification identifier. */
  id: string
  /** Workspace that owns the notification candidate. */
  workspaceId: string
  /** Customer Request represented by the candidate. */
  requestId: string
  /** Team containing the completed Work Item. */
  teamId: string
  /** Completed Work Item represented by the candidate. */
  workItemId: string
  /** Current Customer Request state used to derive notification capability. */
  request: CustomerRequest
  /** Timestamp to record when capability-bearing state changed. */
  now: string
}

/** Recomputes notification capability while preserving an unchanged candidate timestamp.
 *
 * @param existing Previously persisted candidate, when present.
 * @param seed Current request and operation context.
 * @returns A current notification candidate.
 */
function refreshCompletionNotification(
  existing: CustomerCompletionNotification | undefined,
  seed: CompletionNotificationSeed,
): CustomerCompletionNotification {
  const canNotify = seed.request.source.canNotify && seed.request.retention?.redactedAt === undefined
  const skipReason = seed.request.retention?.redactedAt
    ? 'retention-redacted' as const
    : seed.request.source.canNotify ? undefined : 'source-not-capable' as const
  if (
    existing &&
    existing.id === seed.id &&
    existing.workspaceId === seed.workspaceId &&
    existing.requestId === seed.requestId &&
    existing.customerId === seed.request.customerId &&
    existing.teamId === seed.teamId &&
    existing.workItemId === seed.workItemId &&
    existing.canNotify === canNotify &&
    existing.skipReason === skipReason
  ) return existing
  return {
    id: seed.id,
    workspaceId: seed.workspaceId,
    requestId: seed.requestId,
    customerId: seed.request.customerId,
    teamId: seed.teamId,
    workItemId: seed.workItemId,
    canNotify,
    ...(skipReason === undefined ? {} : { skipReason }),
    preparedAt: seed.now,
  }
}

/** Compares an in-memory merge marker with a requested retry.
 *
 * @param marker Persisted in-memory merge marker.
 * @param sourceCustomerId Requested source Customer.
 * @param input Requested target and revision fences.
 * @returns Whether the retry describes the same merge.
 */
function sameCustomerMergeMarker(
  marker: CustomerMergeMarker,
  sourceCustomerId: string,
  input: MergeCustomerInput,
): boolean {
  return marker.sourceCustomerId === sourceCustomerId &&
    marker.targetCustomerId === input.targetCustomerId &&
    marker.sourceExpectedRevision === input.sourceExpectedRevision &&
    marker.targetExpectedRevision === input.targetExpectedRevision
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

/** Creates the deterministic ID used to make saved Customer view retries safe. */
function createIdempotentSavedViewId(workspaceId: string, idempotencyKey: string): string {
  const normalizedKey = idempotencyKey.trim()
  if (!normalizedKey) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Saved Customer view idempotency key is invalid.')
  }
  return `view-${createHash('sha256').update(`${workspaceId}\u0000${normalizedKey}`, 'utf8').digest('hex')}`
}

/** Compares immutable origin fields for a deterministic Customer Request retry.
 *
 * @param left Previously persisted request.
 * @param right Request reconstructed for the retry.
 * @param input Original request input, used to distinguish omitted defaults from explicit values.
 * @returns Whether the retry represents the same request origin.
 */
function sameRequestOrigin(left: CustomerRequest, right: CustomerRequest, input: CreateCustomerRequestInput): boolean {
  const retentionMatches = input.retentionExpiresAt === undefined
    ? left.retention?.expiresAt === defaultRequestRetentionExpiresAt(left.createdAt)
    : left.retention?.expiresAt === right.retention?.expiresAt
  return left.workspaceId === right.workspaceId &&
    left.customerId === right.customerId &&
    left.contactId === right.contactId &&
    left.triageEntryId === right.triageEntryId &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.originalMessage === right.originalMessage &&
    left.receivedAt === right.receivedAt &&
    left.importance === right.importance &&
    retentionMatches &&
    JSON.stringify(left.externalReference) === JSON.stringify(right.externalReference)
}

/** Computes the retention deadline that an omitted Customer Request input would have produced. */
function defaultRequestRetentionExpiresAt(createdAt: string): string {
  const expiresAt = new Date(createdAt)
  expiresAt.setUTCDate(expiresAt.getUTCDate() + CUSTOMER_DEFAULT_RETENTION_DAYS)
  return expiresAt.toISOString()
}

/** Compares immutable origin fields for a deterministic saved Customer view retry. */
function sameSavedViewOrigin(
  existing: CustomerSavedView,
  name: string,
  input: CreateCustomerSavedViewInput,
): boolean {
  return existing.name === name &&
    JSON.stringify(existing.filters) === JSON.stringify(input.filters) &&
    existing.groupBy === input.groupBy
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
