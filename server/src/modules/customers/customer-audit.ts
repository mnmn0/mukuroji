import type { Customer, CustomerContact, CustomerRequest, CustomerSavedView } from '@mukuroji/contracts'
import { createAuditFieldChanges, type MutationAuditEventInput } from '../audit'
import type { CustomerWorkspaceState } from './customers'

/** Largest number of audit events written with one Customer mutation. */
export const CUSTOMER_AUDIT_EVENT_LIMIT = 3

/** Customer fields whose change is recorded without the value. */
const CUSTOMER_REDACTED_FIELDS = ['notes']

/** Contact fields whose change is recorded without the value, because they identify a person. */
const CONTACT_REDACTED_FIELDS = ['name', 'email', 'phone']

/** One audited record kind of the Customer graph. */
type CustomerAuditKind<T> = {
  /** Event type and entity type prefix, such as `customer-contact`. */
  entityType: string
  /** Fields recorded in the event's changes. */
  fields: (record: T) => Record<string, unknown>
  /** Fields whose values are redacted. */
  redactFields?: readonly string[]
  /** Customer that owns the record, used to fold cascaded changes into the Customer's event. */
  ownerCustomerId?: (record: T) => string | undefined
  /** Contact the record refers to, used to fold changes caused by a removed Contact. */
  contactId?: (record: T) => string | undefined
}

/** Customer merge that the change completes, when known from the stored merge marker. */
export type CustomerAuditMergeHint = {
  /** Customer merged away. */
  sourceCustomerId: string
  /** Customer that is kept. */
  targetCustomerId: string
}

/** Change of one record before it becomes an audit event. */
type CustomerRecordChange = {
  /** Entity type, such as `customer` or `customer-request`. */
  entityType: string
  /** Record ID. */
  entityId: string
  /** Lifecycle action. */
  action: 'created' | 'updated' | 'deleted' | 'merged'
  /** Field changes with redaction applied. */
  changes: MutationAuditEventInput['changes']
  /** Additional metadata. */
  metadata: Record<string, unknown>
}

/**
 * Builds the audit events of one Customer graph change by comparing the state before and after it.
 *
 * Customers, Contacts, Customer Requests, and saved views are compared on the fields an
 * administrator needs to see; counters, receipts, and notification candidates are not audited.
 * Contacts and Requests removed or repointed because their Customer or Contact was deleted or
 * merged are folded into that record's event, so one deletion or merge stays one event. When
 * more than `CUSTOMER_AUDIT_EVENT_LIMIT` records changed, the last event carries the number of
 * changes left out in `additionalChanges`.
 *
 * @param workspaceId - Workspace that owns the graph.
 * @param before - Graph before the change.
 * @param after - Graph after the change.
 * @param merge - Customer merge completed by the change, when known.
 * @returns Audit events in a stable order, at most `CUSTOMER_AUDIT_EVENT_LIMIT`.
 */
export function createCustomerAuditEvents(
  workspaceId: string,
  before: CustomerWorkspaceState,
  after: CustomerWorkspaceState,
  merge?: CustomerAuditMergeHint,
): MutationAuditEventInput[] {
  const customerChanges = compareRecords(before.customers, after.customers, CUSTOMER_KIND)
  const removedCustomers = new Set(customerChanges.filter((change) => change.action === 'deleted').map((change) => change.entityId))
  const contactChanges = compareRecords(before.contacts, after.contacts, CONTACT_KIND, removedCustomers)
  const removedContacts = new Set(contactChanges.filter((change) => change.action === 'deleted').map((change) => change.entityId))
  const requestChanges = compareRecords(before.requests, after.requests, REQUEST_KIND, removedCustomers, removedContacts)
  const viewChanges = compareRecords(before.views, after.views, VIEW_KIND)
  const changes = [
    ...markMerges(customerChanges, before.contacts, after.contacts, (contact) => contact.customerId).map((change) =>
      merge && change.entityId === merge.sourceCustomerId && change.action === 'deleted'
        ? { ...change, action: 'merged' as const, metadata: { ...change.metadata, mergedIntoId: merge.targetCustomerId } }
        : change),
    ...markMerges(contactChanges, before.requests, after.requests, (request) => request.contactId),
    ...requestChanges.map((change) => {
      const merged = after.requests.get(change.entityId)?.mergedIntoRequestId
      return merged && before.requests.get(change.entityId)?.mergedIntoRequestId !== merged
        ? { ...change, action: 'merged' as const, metadata: { ...change.metadata, mergedIntoRequestId: merged } }
        : change
    }),
    ...viewChanges,
  ]
  const kept = changes.slice(0, CUSTOMER_AUDIT_EVENT_LIMIT)
  const omitted = changes.length - kept.length
  return kept.map((change, index) => ({
    directoryId: workspaceId,
    eventType: `${change.entityType}.${change.action}`,
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action,
    ...(change.changes && change.changes.length > 0 ? { changes: change.changes } : {}),
    metadata: index === kept.length - 1 && omitted > 0
      ? { ...change.metadata, additionalChanges: omitted }
      : change.metadata,
  }))
}

/** Audited Customer fields. */
const CUSTOMER_KIND: CustomerAuditKind<Customer> = {
  entityType: 'customer',
  fields: (customer: Customer) => ({
    name: customer.name,
    domain: customer.domain,
    ownerUserId: customer.ownerUserId,
    tier: customer.tier,
    size: customer.size,
    status: customer.status,
    health: customer.health,
    businessValue: customer.businessValue,
    notes: customer.notes,
  }),
  redactFields: CUSTOMER_REDACTED_FIELDS,
}

/** Audited Contact fields; personal details are recorded only as changed. */
const CONTACT_KIND: CustomerAuditKind<CustomerContact> = {
  entityType: 'customer-contact',
  fields: (contact: CustomerContact) => ({
    customerId: contact.customerId,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    role: contact.role,
    primary: contact.primary,
    status: contact.status,
  }),
  redactFields: CONTACT_REDACTED_FIELDS,
  ownerCustomerId: (contact: CustomerContact) => contact.customerId,
}

/** Audited Customer Request fields; the original message is never recorded. */
const REQUEST_KIND: CustomerAuditKind<CustomerRequest> = {
  entityType: 'customer-request',
  fields: (request: CustomerRequest) => ({
    customerId: request.customerId,
    contactId: request.contactId,
    importance: request.importance,
    status: request.status,
    sourceKind: request.source.kind,
    workItemLinks: request.workItemLinks.map((link) => `${link.teamId}/${link.workItemId}`).sort(),
    projectLinks: request.projectLinks.map((link) => link.projectId).sort(),
  }),
  ownerCustomerId: (request: CustomerRequest) => request.customerId,
  contactId: (request: CustomerRequest) => request.contactId,
}

/** Audited saved view fields. */
const VIEW_KIND: CustomerAuditKind<CustomerSavedView> = {
  entityType: 'customer-view',
  fields: (view: CustomerSavedView) => ({
    name: view.name,
    groupBy: view.groupBy,
    filters: JSON.stringify(view.filters),
  }),
}

/**
 * Compares one record map and returns the changes of the audited fields.
 *
 * @param before - Records before the change.
 * @param after - Records after the change.
 * @param kind - Audited record kind.
 * @param removedCustomers - Customers deleted by the same change; their records' changes are folded.
 * @param removedContacts - Contacts deleted by the same change; their references' changes are folded.
 * @returns Changes ordered by record ID.
 */
function compareRecords<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  kind: CustomerAuditKind<T>,
  removedCustomers: ReadonlySet<string> = new Set(),
  removedContacts: ReadonlySet<string> = new Set(),
): CustomerRecordChange[] {
  const { fields, ownerCustomerId: owner, contactId: contact } = kind
  const changes: CustomerRecordChange[] = []
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(id)
    const next = after.get(id)
    const previousOwner = previous === undefined ? undefined : owner?.(previous)
    if (previousOwner !== undefined && removedCustomers.has(previousOwner)) continue
    const previousContact = previous === undefined ? undefined : contact?.(previous)
    if (previous !== undefined && next !== undefined && previousContact !== undefined && removedContacts.has(previousContact)) continue
    const beforeFields = previous === undefined ? {} : fields(previous)
    const afterFields = next === undefined ? {} : fields(next)
    const fieldChanges = createAuditFieldChanges(beforeFields, afterFields, undefined, kind.redactFields)
    if (previous !== undefined && next !== undefined && fieldChanges.length === 0) continue
    const nextOwner = next === undefined ? undefined : owner?.(next)
    changes.push({
      entityType: kind.entityType,
      entityId: id,
      action: previous === undefined ? 'created' : next === undefined ? 'deleted' : 'updated',
      changes: fieldChanges,
      metadata: nextOwner ?? previousOwner ? { customerId: nextOwner ?? previousOwner } : {},
    })
  }
  return changes
}

/**
 * Marks a deleted record as merged when its dependants moved to another record of the same kind.
 *
 * @param changes - Changes of the merged record kind.
 * @param beforeDependants - Dependent records before the change.
 * @param afterDependants - Dependent records after the change.
 * @param parentOf - Reads the dependant's parent record ID.
 * @returns Changes with merges marked and the retained record named in `mergedIntoId`.
 */
function markMerges<T>(
  changes: CustomerRecordChange[],
  beforeDependants: ReadonlyMap<string, T>,
  afterDependants: ReadonlyMap<string, T>,
  parentOf: (record: T) => string | undefined,
): CustomerRecordChange[] {
  return changes.map((change) => {
    if (change.action !== 'deleted') return change
    for (const [id, dependant] of beforeDependants) {
      if (parentOf(dependant) !== change.entityId) continue
      const moved = afterDependants.get(id)
      const target = moved === undefined ? undefined : parentOf(moved)
      if (target !== undefined && target !== change.entityId) {
        return { ...change, action: 'merged', metadata: { ...change.metadata, mergedIntoId: target } }
      }
    }
    return change
  })
}
