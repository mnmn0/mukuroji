import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  Customer,
  CustomerContact,
  CustomerHealth,
  CustomerRequest,
  CustomerRequestImportance,
  CustomerRequestSourceKind,
  CustomerRequestStatus,
  CustomerSize,
  CustomerStatus,
  CustomerTier,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
} from '@mukuroji/contracts'
import type { CreateCustomerRequestBody } from '../api/customers'

/** Editable Customer fields as the form holds them, before they are validated. */
export type CustomerDraft = {
  /** Customer display name. */
  name: string
  /** Primary domain, or an empty string when none is known. */
  domain: string
  /** Commercial tier. */
  tier: CustomerTier
  /** Organization size. */
  size: CustomerSize
  /** Lifecycle status. Inactive and churned archive the Customer from active work. */
  status: CustomerStatus
  /** Account health. */
  health: CustomerHealth
  /** Business-value score text, or an empty string when unset. */
  businessValue: string
  /** Internal notes. */
  notes: string
}

/** Editable Customer contact fields as the form holds them. */
export type CustomerContactDraft = {
  /** Contact display name. */
  name: string
  /** Contact email, or an empty string. */
  email: string
  /** Customer-side role, or an empty string. */
  role: string
  /** Contact phone, or an empty string. */
  phone: string
  /** Whether this is the preferred contact. */
  primary: boolean
}

/** Editable Customer Request fields as the form holds them. */
export type CustomerRequestDraft = {
  /** Original request message. */
  originalMessage: string
  /** Received time in `datetime-local` form (`YYYY-MM-DDTHH:mm`), in the viewer's time zone. */
  receivedAt: string
  /** Request importance. */
  importance: CustomerRequestImportance
  /** Channel the request came from. Only a new Request sets it; edits keep the recorded source. */
  sourceKind: CustomerRequestSourceKind
  /** Contact that made the request, or an empty string. */
  contactId: string
  /** Request lifecycle status. */
  status: CustomerRequestStatus
}

/** Validation failures a draft can report before anything is sent. */
export type CustomerDraftIssue =
  | 'nameRequired'
  | 'domainInvalid'
  | 'businessValueInvalid'
  | 'emailInvalid'
  | 'messageRequired'
  | 'receivedAtInvalid'

/** A validated API input, or the first problem that stops the draft from being sent. */
export type CustomerDraftResult<Input> =
  | { /** Whether the draft is valid. */ ok: true; /** Input ready for the API. */ input: Input }
  | { /** Whether the draft is valid. */ ok: false; /** Problem to show next to the form. */ issue: CustomerDraftIssue }

const domainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/**
 * Creates the form state for a new Customer, or for editing an existing one.
 *
 * @param customer Customer being edited, when any.
 * @returns Draft fields prefilled from the Customer or with new-Customer defaults.
 */
export function createCustomerDraft(customer?: Customer): CustomerDraft {
  return {
    name: customer?.name ?? '',
    domain: customer?.domain ?? '',
    tier: customer?.tier ?? 'standard',
    size: customer?.size ?? 'small',
    status: customer?.status ?? 'active',
    health: customer?.health ?? 'unknown',
    businessValue: customer?.businessValue === undefined ? '' : String(customer.businessValue),
    notes: customer?.notes ?? '',
  }
}

/**
 * Validates a new-Customer draft and builds the create input.
 *
 * @param draft Form state.
 * @returns The create input, or the first validation problem.
 */
export function readCreateCustomerInput(draft: CustomerDraft): CustomerDraftResult<CreateCustomerInput> {
  const fields = readCustomerFields(draft)
  if (!fields.ok) return fields
  const { name, domain, businessValue, notes } = fields.input
  return {
    ok: true,
    input: {
      name,
      tier: draft.tier,
      size: draft.size,
      status: draft.status,
      health: draft.health,
      ...(domain === undefined ? {} : { domain }),
      ...(businessValue === undefined ? {} : { businessValue }),
      ...(notes === undefined ? {} : { notes }),
    },
  }
}

/**
 * Validates an edited Customer draft and builds a revision-checked update with only the changed fields.
 *
 * @param customer Customer as last loaded, which supplies the expected revision.
 * @param draft Form state.
 * @returns The update input, or the first validation problem.
 */
export function readUpdateCustomerInput(
  customer: Customer,
  draft: CustomerDraft,
): CustomerDraftResult<UpdateCustomerInput> {
  const fields = readCustomerFields(draft)
  if (!fields.ok) return fields
  const { name, domain, businessValue, notes } = fields.input
  return {
    ok: true,
    input: {
      expectedRevision: customer.revision,
      ...(name === customer.name ? {} : { name }),
      ...(domain === customer.domain ? {} : { domain: domain ?? null }),
      ...(draft.tier === customer.tier ? {} : { tier: draft.tier }),
      ...(draft.size === customer.size ? {} : { size: draft.size }),
      ...(draft.status === customer.status ? {} : { status: draft.status }),
      ...(draft.health === customer.health ? {} : { health: draft.health }),
      ...(businessValue === customer.businessValue ? {} : { businessValue: businessValue ?? null }),
      ...(notes === (customer.notes || undefined) ? {} : { notes: notes ?? null }),
    },
  }
}

/**
 * Creates the form state for a new contact, or for editing an existing one.
 *
 * @param contact Contact being edited, when any.
 * @returns Draft fields prefilled from the contact or empty.
 */
export function createCustomerContactDraft(contact?: CustomerContact): CustomerContactDraft {
  return {
    name: contact?.name ?? '',
    email: contact?.email ?? '',
    role: contact?.role ?? '',
    phone: contact?.phone ?? '',
    primary: contact?.primary ?? false,
  }
}

/**
 * Validates a new-contact draft and builds the create input.
 *
 * @param draft Form state.
 * @returns The create input, or the first validation problem.
 */
export function readCreateCustomerContactInput(
  draft: CustomerContactDraft,
): CustomerDraftResult<CreateCustomerContactInput> {
  const fields = readContactFields(draft)
  if (!fields.ok) return fields
  const { name, email, role, phone } = fields.input
  return {
    ok: true,
    input: {
      name,
      ...(email === undefined ? {} : { email }),
      ...(role === undefined ? {} : { role }),
      ...(phone === undefined ? {} : { phone }),
      ...(draft.primary ? { primary: true } : {}),
    },
  }
}

/**
 * Validates an edited contact draft and builds a revision-checked update with only the changed fields.
 *
 * @param contact Contact as last loaded.
 * @param draft Form state.
 * @returns The update input, or the first validation problem.
 */
export function readUpdateCustomerContactInput(
  contact: CustomerContact,
  draft: CustomerContactDraft,
): CustomerDraftResult<UpdateCustomerContactInput> {
  const fields = readContactFields(draft)
  if (!fields.ok) return fields
  const { name, email, role, phone } = fields.input
  return {
    ok: true,
    input: {
      expectedRevision: contact.revision,
      ...(name === contact.name ? {} : { name }),
      ...(email === contact.email ? {} : { email: email ?? null }),
      ...(role === contact.role ? {} : { role: role ?? null }),
      ...(phone === contact.phone ? {} : { phone: phone ?? null }),
      ...(draft.primary === contact.primary ? {} : { primary: draft.primary }),
    },
  }
}

/**
 * Creates the form state for a new Customer Request, or for editing an existing one.
 *
 * @param request Request being edited, when any.
 * @param now Current time, used as the default received time of a new Request.
 * @returns Draft fields prefilled from the Request or with manual-entry defaults.
 */
export function createCustomerRequestDraft(request?: CustomerRequest, now: Date = new Date()): CustomerRequestDraft {
  return {
    originalMessage: request?.originalMessage ?? '',
    receivedAt: toDateTimeLocalValue(request ? new Date(request.receivedAt) : now),
    importance: request?.importance ?? 'normal',
    sourceKind: request?.source.kind ?? 'manual',
    contactId: request?.contactId ?? '',
    status: request?.status ?? 'requested',
  }
}

/**
 * Validates a new-Request draft and builds the create body. The server adds the idempotency key from the header.
 *
 * @param customerId Customer the Request belongs to.
 * @param draft Form state.
 * @returns The create body, or the first validation problem.
 */
export function readCreateCustomerRequestInput(
  customerId: string,
  draft: CustomerRequestDraft,
): CustomerDraftResult<CreateCustomerRequestBody> {
  const fields = readRequestFields(draft)
  if (!fields.ok) return fields
  return {
    ok: true,
    input: {
      customerId,
      ...(draft.contactId ? { contactId: draft.contactId } : {}),
      source: { kind: draft.sourceKind, canNotify: false },
      originalMessage: fields.input.originalMessage,
      receivedAt: fields.input.receivedAt,
      importance: draft.importance,
    },
  }
}

/**
 * Validates an edited Request draft and builds a revision-checked update with only the changed fields.
 *
 * @param request Request as last loaded.
 * @param draft Form state.
 * @returns The update input, or the first validation problem.
 */
export function readUpdateCustomerRequestInput(
  request: CustomerRequest,
  draft: CustomerRequestDraft,
): CustomerDraftResult<UpdateCustomerRequestInput> {
  const fields = readRequestFields(draft)
  if (!fields.ok) return fields
  const { originalMessage, receivedAt } = fields.input
  const contactId = draft.contactId || undefined
  return {
    ok: true,
    input: {
      expectedRevision: request.revision,
      ...(originalMessage === request.originalMessage ? {} : { originalMessage }),
      ...(Date.parse(receivedAt) === Date.parse(request.receivedAt) ? {} : { receivedAt }),
      ...(draft.importance === request.importance ? {} : { importance: draft.importance }),
      ...(contactId === request.contactId ? {} : { contactId: contactId ?? null }),
      ...(draft.status === request.status ? {} : { status: draft.status }),
    },
  }
}

/**
 * Formats an instant for a `datetime-local` input in the viewer's time zone.
 *
 * @param date Instant to format.
 * @returns `YYYY-MM-DDTHH:mm`, or an empty string for an invalid date.
 */
export function toDateTimeLocalValue(date: Date): string {
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Trims the shared Customer fields and checks them against the server's rules. */
function readCustomerFields(draft: CustomerDraft): CustomerDraftResult<{
  /** Trimmed name. */ name: string
  /** Lower-case domain, when set. */ domain?: string
  /** Parsed business value, when set. */ businessValue?: number
  /** Trimmed notes, when set. */ notes?: string
}> {
  const name = draft.name.trim()
  if (!name || name.length > 200) return { ok: false, issue: 'nameRequired' }
  const domain = draft.domain.trim().toLowerCase() || undefined
  if (domain !== undefined && (domain.length > 253 || !domainPattern.test(domain))) {
    return { ok: false, issue: 'domainInvalid' }
  }
  const businessValueText = draft.businessValue.trim()
  const businessValue = businessValueText ? Number(businessValueText) : undefined
  if (businessValue !== undefined && (!Number.isFinite(businessValue) || businessValue < 0 || businessValue > 100)) {
    return { ok: false, issue: 'businessValueInvalid' }
  }
  const notes = draft.notes.trim() || undefined
  return { ok: true, input: { name, domain, businessValue, notes } }
}

/** Trims the shared contact fields and checks the email shape. */
function readContactFields(draft: CustomerContactDraft): CustomerDraftResult<{
  /** Trimmed name. */ name: string
  /** Lower-case email, when set. */ email?: string
  /** Trimmed role, when set. */ role?: string
  /** Trimmed phone, when set. */ phone?: string
}> {
  const name = draft.name.trim()
  if (!name) return { ok: false, issue: 'nameRequired' }
  const email = draft.email.trim().toLowerCase() || undefined
  if (email !== undefined && !emailPattern.test(email)) return { ok: false, issue: 'emailInvalid' }
  return {
    ok: true,
    input: {
      name,
      email,
      role: draft.role.trim() || undefined,
      phone: draft.phone.trim() || undefined,
    },
  }
}

/** Trims the Request message and converts the local received time to an ISO instant. */
function readRequestFields(draft: CustomerRequestDraft): CustomerDraftResult<{
  /** Trimmed message. */ originalMessage: string
  /** Received instant in ISO 8601. */ receivedAt: string
}> {
  const originalMessage = draft.originalMessage.trim()
  if (!originalMessage) return { ok: false, issue: 'messageRequired' }
  const receivedAt = new Date(draft.receivedAt)
  if (!draft.receivedAt || !Number.isFinite(receivedAt.getTime())) return { ok: false, issue: 'receivedAtInvalid' }
  return { ok: true, input: { originalMessage, receivedAt: receivedAt.toISOString() } }
}
