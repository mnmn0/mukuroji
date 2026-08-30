import type { TriageSourceKind } from './triage'

/** Current persisted schema version for customer records. */
export const CUSTOMER_SCHEMA_VERSION = 1 as const

/** Current persisted schema version for customer request records. */
export const CUSTOMER_REQUEST_SCHEMA_VERSION = 1 as const

/** Current schema version for a Workspace customer export. */
export const CUSTOMER_EXPORT_SCHEMA_VERSION = 1 as const

/** Commercial importance tier assigned to a customer. */
export type CustomerTier = 'strategic' | 'enterprise' | 'growth' | 'standard' | 'trial'

/** Approximate organization size used for segmentation and reporting. */
export type CustomerSize = 'startup' | 'small' | 'mid-market' | 'enterprise'

/** Customer lifecycle state. */
export type CustomerStatus = 'prospect' | 'active' | 'inactive' | 'churned'

/** Current account health signal. */
export type CustomerHealth = 'healthy' | 'watch' | 'at-risk' | 'critical' | 'unknown'

/** Lifecycle state of a customer request. */
export type CustomerRequestStatus =
  | 'requested'
  | 'in-progress'
  | 'completed'
  | 'closed'
  | 'merged'

/** Importance assigned to one customer request. */
export type CustomerRequestImportance = 'low' | 'normal' | 'high' | 'urgent'

/** Provider-neutral channels from which a customer request can originate. */
export type CustomerRequestSourceKind =
  | TriageSourceKind
  | 'portal'
  | 'phone'
  | 'manual'

/** Work Item lifecycle projection used by customer navigation surfaces. */
export type CustomerWorkItemLifecycle = 'requested' | 'in-progress' | 'completed' | 'unknown'

/** Safe request metadata included in a Work Item or Project impact projection. */
export type CustomerImpactRequestSummary = {
  /** Customer Request identifier. */
  requestId: string
  /** Customer organization associated with the request. */
  customerId: string
  /** Current request lifecycle state. */
  status: CustomerRequestStatus
  /** Importance signal assigned to the request. */
  importance: CustomerRequestImportance
  /** Source channel without raw source content. */
  sourceKind: CustomerRequestSourceKind
  /** ISO instant when the request was received. */
  receivedAt: string
}

/** Retention metadata applied to customer-owned records. */
export type CustomerRetention = {
  /** ISO instant after which the record's sensitive content must be redacted. */
  expiresAt?: string
  /** ISO instant when sensitive content was redacted. */
  redactedAt?: string
}

/** A first-class organization represented in the Workspace customer directory. */
export type Customer = {
  /** Persisted customer schema version. */
  schemaVersion: typeof CUSTOMER_SCHEMA_VERSION
  /** Stable customer identifier. */
  id: string
  /** Workspace that owns the customer record. */
  workspaceId: string
  /** Customer display name. */
  name: string
  /** Primary customer domain, when known. */
  domain?: string
  /** Workspace member responsible for the account, when assigned. */
  ownerUserId?: string
  /** Commercial tier used for prioritization and reporting. */
  tier: CustomerTier
  /** Approximate organization size. */
  size: CustomerSize
  /** Customer lifecycle status. */
  status: CustomerStatus
  /** Current account health. */
  health: CustomerHealth
  /** Optional business-value score from zero through one hundred. */
  businessValue?: number
  /** Optional internal account notes. */
  notes?: string
  /** Retention state for this customer projection. */
  retention?: CustomerRetention
  /** Number of active and inactive contacts currently attached. */
  contactCount: number
  /** Number of customer requests currently attached. */
  requestCount: number
  /** Number of requests that are not completed, closed, or merged. */
  openRequestCount: number
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO creation instant. */
  createdAt: string
  /** ISO last-update instant. */
  updatedAt: string
}

/** A person who can represent or communicate for a customer organization. */
export type CustomerContact = {
  /** Stable contact identifier. */
  id: string
  /** Workspace that owns the contact. */
  workspaceId: string
  /** Customer organization owning the contact. */
  customerId: string
  /** Contact display name. */
  name: string
  /** Contact email address, when known. */
  email?: string
  /** Customer-side role or title. */
  role?: string
  /** Contact phone number, when known. */
  phone?: string
  /** Whether this is the preferred contact for the customer. */
  primary: boolean
  /** Whether the contact may be used for new requests. */
  status: 'active' | 'inactive'
  /** Retention state for this contact projection. */
  retention?: CustomerRetention
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO creation instant. */
  createdAt: string
  /** ISO last-update instant. */
  updatedAt: string
}

/** Provider-neutral source metadata kept on a customer request. */
export type CustomerRequestSource = {
  /** Source channel. */
  kind: CustomerRequestSourceKind
  /** External provider name, when applicable. */
  provider?: string
  /** Provider-stable source identifier, when available. */
  referenceId?: string
  /** Permission-filtered link to the original source, when available. */
  permalink?: string
  /** Whether the source can receive a completion notification. */
  canNotify: boolean
}

/** An external reference retained separately from customer attributes. */
export type CustomerRequestExternalReference = {
  /** Provider or system that owns the reference. */
  provider: string
  /** Provider-stable identifier. */
  id: string
  /** Permission-filtered external URL, when available. */
  permalink?: string
}

/** Link from one customer request to one canonical Work Item. */
export type CustomerRequestWorkItemLink = {
  /** Owning Team of the linked Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Assigned Project snapshot used for Work Item navigation, when available. */
  projectId?: string
  /** ISO instant when the link was created. */
  linkedAt: string
  /** Workspace member or service actor that created the link. */
  linkedBy: string
}

/** Link from one customer request to one canonical Project. */
export type CustomerRequestProjectLink = {
  /** Canonical Project identifier. */
  projectId: string
  /** ISO instant when the link was created. */
  linkedAt: string
  /** Workspace member or service actor that created the link. */
  linkedBy: string
}

/** The source-of-need record that explains why work exists. */
export type CustomerRequest = {
  /** Persisted customer request schema version. */
  schemaVersion: typeof CUSTOMER_REQUEST_SCHEMA_VERSION
  /** Stable customer request identifier. */
  id: string
  /** Workspace that owns the request. */
  workspaceId: string
  /** Customer organization making the request. */
  customerId: string
  /** Person who made the request, when known. */
  contactId?: string
  /** Linked Triage Entry, when the request originated in Triage. */
  triageEntryId?: string
  /** Provider-neutral source metadata. */
  source: CustomerRequestSource
  /** Original request message, or an empty redacted value after retention. */
  originalMessage: string
  /** ISO instant when the customer request was received. */
  receivedAt: string
  /** Importance signal used by prioritization views. */
  importance: CustomerRequestImportance
  /** Optional provider reference kept outside the Customer record. */
  externalReference?: CustomerRequestExternalReference
  /** Current request lifecycle state. */
  status: CustomerRequestStatus
  /** Work Items that represent or aggregate this request. */
  workItemLinks: CustomerRequestWorkItemLink[]
  /** Projects that represent or aggregate this request. */
  projectLinks: CustomerRequestProjectLink[]
  /** Retention state for the request content. */
  retention?: CustomerRetention
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO creation instant. */
  createdAt: string
  /** ISO last-update instant. */
  updatedAt: string
}

/** One Work Item projection shown from a Customer detail surface. */
export type CustomerWorkItemSummary = {
  /** Owning Team of the Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Project assigned to the Work Item, when known. */
  projectId?: string
  /** Customer request count aggregated onto this Work Item. */
  requestCount: number
  /** Request lifecycle states represented by this Work Item. */
  requestStates: CustomerRequestStatus[]
  /** Navigation-oriented lifecycle projection. */
  lifecycle: CustomerWorkItemLifecycle
}

/** Customer detail response with its contact, request, and Work Item graph. */
export type CustomerDetail = {
  /** Customer organization. */
  customer: Customer
  /** Contacts belonging to the customer. */
  contacts: CustomerContact[]
  /** Requests belonging to the customer. */
  requests: CustomerRequest[]
  /** Unique Work Items linked by those requests. */
  workItems: CustomerWorkItemSummary[]
  /** Unique Projects linked by those requests. */
  projects: CustomerProjectSummary[]
}

/** One Project projection shown from a Customer detail surface. */
export type CustomerProjectSummary = {
  /** Canonical Project identifier. */
  projectId: string
  /** Customer request count aggregated onto this Project. */
  requestCount: number
  /** Request lifecycle states represented by this Project. */
  requestStates: CustomerRequestStatus[]
}

/** Query filters for the customer directory. */
export type CustomerListInput = {
  /** Case-insensitive name or domain search. */
  search?: string
  /** Customer tier filter. */
  tier?: CustomerTier
  /** Organization size filter. */
  size?: CustomerSize
  /** Lifecycle status filter. */
  status?: CustomerStatus
  /** Health filter. */
  health?: CustomerHealth
  /** Minimum business-value score. */
  minBusinessValue?: number
  /** Minimum number of attached customer requests. */
  minRequestCount?: number
  /** Sort field. */
  sortBy?: CustomerSortField
  /** Sort direction. */
  sortDirection?: 'ascending' | 'descending'
  /** Maximum number of records to return. */
  limit?: number
  /** Opaque page cursor. */
  cursor?: string
}

/** Supported customer directory sort fields. */
export type CustomerSortField =
  | 'name'
  | 'tier'
  | 'size'
  | 'status'
  | 'health'
  | 'businessValue'
  | 'requestCount'
  | 'openRequestCount'
  | 'updatedAt'

/** Cursor-paginated customer directory response. */
export type CustomerPage = {
  /** Customers matching the supplied filters. */
  customers: Customer[]
  /** Opaque cursor for the next page, when present. */
  nextCursor?: string
}

/** Query filters for customer request reports. */
export type CustomerRequestListInput = {
  /** Restrict to one customer. */
  customerId?: string
  /** Restrict to one request status. */
  status?: CustomerRequestStatus
  /** Restrict to one request importance. */
  importance?: CustomerRequestImportance
  /** Restrict to one source channel. */
  sourceKind?: CustomerRequestSourceKind
  /** Case-insensitive search over safe request text and external IDs. */
  search?: string
  /** Maximum number of requests to return. */
  limit?: number
  /** Opaque page cursor. */
  cursor?: string
}

/** Cursor-paginated customer request response. */
export type CustomerRequestPage = {
  /** Requests matching the supplied filters. */
  requests: CustomerRequest[]
  /** Opaque page cursor for the next page, when present. */
  nextCursor?: string
}

/** Aggregated customer impact attached to a Work Item or Project. */
export type CustomerImpactSignal = {
  /** Number of distinct requesting customers. */
  customerCount: number
  /** Number of customer requests represented. */
  requestCount: number
  /** Number of requests that are not completed, closed, or merged. */
  openRequestCount: number
  /** Sum of known customer business-value scores. */
  businessValueTotal: number
  /** Highest known customer business-value score. */
  highestBusinessValue?: number
  /** Highest importance among the represented requests. */
  highestImportance?: CustomerRequestImportance
  /** Safe metadata for the Customer Requests represented by the signal. */
  requests: CustomerImpactRequestSummary[]
  /** Stable, explainable priority signal derived from impact. */
  prioritySignal: 'none' | 'watch' | 'high' | 'critical'
  /** Customers contributing to the signal. */
  customers: Array<{
    /** Customer identifier. */
    customerId: string
    /** Customer display name. */
    name: string
    /** Customer tier. */
    tier: CustomerTier
    /** Customer health. */
    health: CustomerHealth
    /** Optional customer business-value score. */
    businessValue?: number
    /** Number of requests from this customer in the scope. */
    requestCount: number
  }>
}

/** Query for a Work Item or Project customer-impact signal. */
export type CustomerImpactQuery = {
  /** Owning Team for a Work Item query. */
  teamId?: string
  /** Work Item identifier for a Work Item query. */
  workItemId?: string
  /** Project identifier for a Project query. */
  projectId?: string
}

/** Saved customer directory view definition. */
export type CustomerSavedView = {
  /** Stable saved-view identifier. */
  id: string
  /** Workspace that owns the saved view. */
  workspaceId: string
  /** User-facing view name. */
  name: string
  /** Customer directory filters. */
  filters: CustomerListInput
  /** Grouping dimension. */
  groupBy?: 'tier' | 'size' | 'status' | 'health' | 'owner'
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO creation instant. */
  createdAt: string
  /** ISO last-update instant. */
  updatedAt: string
}

/** Input for creating a saved customer directory view. */
export type CreateCustomerSavedViewInput = {
  /** User-facing view name. */
  name: string
  /** Customer directory filters captured by the view. */
  filters: CustomerListInput
  /** Optional grouping dimension. */
  groupBy?: 'tier' | 'size' | 'status' | 'health' | 'owner'
}

/** Input for updating a saved customer directory view. */
export type UpdateCustomerSavedViewInput = {
  /** Revision observed before the update. */
  expectedRevision: number
  /** Replacement view name. */
  name?: string
  /** Replacement customer directory filters. */
  filters?: CustomerListInput
  /** Replacement grouping dimension, or null to clear it. */
  groupBy?: 'tier' | 'size' | 'status' | 'health' | 'owner' | null
}

/** Input for creating a Customer. */
export type CreateCustomerInput = {
  /** Customer display name. */
  name: string
  /** Primary customer domain, when known. */
  domain?: string
  /** Workspace owner member key, when assigned. */
  ownerUserId?: string
  /** Commercial tier. */
  tier: CustomerTier
  /** Organization size. */
  size: CustomerSize
  /** Lifecycle status. */
  status: CustomerStatus
  /** Account health. */
  health: CustomerHealth
  /** Optional business-value score. */
  businessValue?: number
  /** Optional internal notes. */
  notes?: string
  /** Optional retention deadline. */
  retentionExpiresAt?: string
}

/** Input for revision-checked Customer updates. */
export type UpdateCustomerInput = {
  /** Revision observed before the update. */
  expectedRevision: number
  /** Replacement name. */
  name?: string
  /** Replacement domain, or null to clear it. */
  domain?: string | null
  /** Replacement owner, or null to clear it. */
  ownerUserId?: string | null
  /** Replacement tier. */
  tier?: CustomerTier
  /** Replacement size. */
  size?: CustomerSize
  /** Replacement lifecycle status. */
  status?: CustomerStatus
  /** Replacement account health. */
  health?: CustomerHealth
  /** Replacement business-value score, or null to clear it. */
  businessValue?: number | null
  /** Replacement notes, or null to clear them. */
  notes?: string | null
}

/** Input for creating a Customer contact. */
export type CreateCustomerContactInput = {
  /** Contact display name. */
  name: string
  /** Contact email address. */
  email?: string
  /** Customer-side role or title. */
  role?: string
  /** Contact phone number. */
  phone?: string
  /** Whether this is the preferred contact. */
  primary?: boolean
  /** Optional retention deadline. */
  retentionExpiresAt?: string
}

/** Input for revision-checked contact updates. */
export type UpdateCustomerContactInput = {
  /** Revision observed before the update. */
  expectedRevision: number
  /** Replacement display name. */
  name?: string
  /** Replacement email, or null to clear it. */
  email?: string | null
  /** Replacement role, or null to clear it. */
  role?: string | null
  /** Replacement phone, or null to clear it. */
  phone?: string | null
  /** Replacement preferred-contact flag. */
  primary?: boolean
  /** Replacement contact status. */
  status?: 'active' | 'inactive'
}

/** Input for creating a Customer Request. */
export type CreateCustomerRequestInput = {
  /** Customer organization making the request. */
  customerId: string
  /** Contact making the request, when known. */
  contactId?: string
  /** Triage Entry that originated this request, when applicable. */
  triageEntryId?: string
  /** Provider-neutral source metadata. */
  source: CustomerRequestSource
  /** Original request message. */
  originalMessage: string
  /** Received instant. */
  receivedAt: string
  /** Request importance. */
  importance: CustomerRequestImportance
  /** Optional external reference. */
  externalReference?: CustomerRequestExternalReference
  /** Optional retention deadline. */
  retentionExpiresAt?: string
}

/** Input for revision-checked Customer Request updates. */
export type UpdateCustomerRequestInput = {
  /** Revision observed before the update. */
  expectedRevision: number
  /** Replacement contact, or null to clear it. */
  contactId?: string | null
  /** Replacement source metadata. */
  source?: CustomerRequestSource
  /** Replacement original message. */
  originalMessage?: string
  /** Replacement received instant. */
  receivedAt?: string
  /** Replacement importance. */
  importance?: CustomerRequestImportance
  /** Replacement external reference, or null to clear it. */
  externalReference?: CustomerRequestExternalReference | null
  /** Replacement lifecycle status. */
  status?: CustomerRequestStatus
}

/** Input for linking a Customer Request to a Work Item. */
export type LinkCustomerRequestWorkItemInput = {
  /** Owning Team. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Assigned Project snapshot, when the Work Item authorization resolved one. */
  projectId?: string
}

/** Input for linking a Customer Request directly to a Project. */
export type LinkCustomerRequestProjectInput = {
  /** Canonical Project identifier. */
  projectId: string
}

/** Input for merging two customer records. */
export type MergeCustomerInput = {
  /** Customer to retain. */
  targetCustomerId: string
  /** Revision observed for the source customer. */
  sourceExpectedRevision: number
  /** Revision observed for the retained customer. */
  targetExpectedRevision: number
}

/** Input for merging two customer contacts. */
export type MergeCustomerContactInput = {
  /** Contact to retain. */
  targetContactId: string
  /** Revision observed for the source contact. */
  sourceExpectedRevision: number
  /** Revision observed for the retained contact. */
  targetExpectedRevision: number
}

/** Input for merging two customer requests. */
export type MergeCustomerRequestInput = {
  /** Request to retain. */
  targetRequestId: string
  /** Revision observed for the source request. */
  sourceExpectedRevision: number
  /** Revision observed for the retained request. */
  targetExpectedRevision: number
}

/** Candidate completion notification prepared for a source-capable request. */
export type CustomerCompletionNotification = {
  /** Stable notification identifier. */
  id: string
  /** Workspace that owns the notification candidate. */
  workspaceId: string
  /** Customer request that can receive the notification. */
  requestId: string
  /** Customer organization associated with the request. */
  customerId: string
  /** Work Item that completed. */
  teamId: string
  /** Completed Work Item identifier. */
  workItemId: string
  /** Whether the source is currently capable of receiving a notification. */
  canNotify: boolean
  /** Reason a notification was skipped, when it was not prepared. */
  skipReason?: 'source-not-capable' | 'permission-restricted' | 'retention-redacted'
  /** ISO instant when the candidate was prepared. */
  preparedAt: string
}

/** Workspace-scoped export containing the complete customer graph. */
export type CustomerWorkspaceExport = {
  /** Export schema version. */
  schemaVersion: typeof CUSTOMER_EXPORT_SCHEMA_VERSION
  /** Workspace being exported. */
  workspaceId: string
  /** ISO instant when the export was generated. */
  exportedAt: string
  /** Exported customers. */
  customers: Customer[]
  /** Exported contacts. */
  contacts: CustomerContact[]
  /** Exported customer requests. */
  requests: CustomerRequest[]
  /** Exported saved customer directory views. */
  views: CustomerSavedView[]
  /** Prepared completion notification candidates. */
  completionNotifications: CustomerCompletionNotification[]
}

/** Result of retention processing for customer-owned records. */
export type CustomerRetentionResult = {
  /** Number of customer records redacted. */
  customersRedacted: number
  /** Number of contact records redacted. */
  contactsRedacted: number
  /** Number of request records redacted. */
  requestsRedacted: number
}
