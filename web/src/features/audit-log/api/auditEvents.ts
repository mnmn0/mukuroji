import {
  AUDIT_ACTOR_KINDS,
  type AuditActorKind,
  type AuditEventFilters,
  type AuditEventPageView,
  type AuditEventResourceView,
  type AuditEventView,
  type AuditFieldChangeView,
  type AuditSourceKind,
  type AuditValue,
} from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import { invalidAuditLogResponse, sendAuditLogRequest } from './auditLogRequest'

/** Events requested per page of the audit search. */
export const AUDIT_EVENT_PAGE_SIZE = 50

/** Source kinds an audit event may report. */
const auditSourceKinds: readonly AuditSourceKind[] = ['api', 'backfill', 'migration', 'system']

/**
 * Searches the Workspace audit log, newest first.
 *
 * The server records each search as an `audit.viewed` event.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param filters - Search filters; `actorKind` is ignored because the search does not support it.
 * @param cursor - Cursor of the page to read, absent for the first page.
 * @param signal - Optional cancellation signal.
 * @returns One validated page of events.
 * @throws AuditLogApiError When the server rejects the search or the response is malformed.
 */
export async function listAuditEvents(
  accessToken: string,
  filters: AuditEventFilters,
  cursor?: string,
  signal?: AbortSignal,
): Promise<AuditEventPageView> {
  const params = new URLSearchParams()
  if (filters.actorId) params.set('actorId', filters.actorId)
  if (filters.targetType) params.set('targetType', filters.targetType)
  if (filters.targetId) params.set('targetId', filters.targetId)
  if (filters.eventTypes?.length) params.set('eventType', filters.eventTypes.join(','))
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  params.set('limit', String(AUDIT_EVENT_PAGE_SIZE))
  if (cursor) params.set('cursor', cursor)
  return readAuditEventPage(await sendAuditLogRequest(`/audit/events?${params.toString()}`, accessToken, { signal }))
}

/**
 * Validates an audit event page response.
 *
 * @param value - Parsed JSON body.
 * @returns The validated page.
 * @throws AuditLogApiError When the body does not match the contract.
 */
export function readAuditEventPage(value: unknown): AuditEventPageView {
  if (!isRecord(value) || !Array.isArray(value.events)) throw invalidAuditLogResponse()
  const events = value.events.map(readAuditEvent)
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') throw invalidAuditLogResponse()
  return {
    events,
    ...(typeof value.nextCursor === 'string' && value.nextCursor ? { nextCursor: value.nextCursor } : {}),
  }
}

/**
 * Validates one audit event view.
 *
 * @param value - Candidate event.
 * @returns The validated event.
 * @throws AuditLogApiError When a required field is missing or malformed.
 */
function readAuditEvent(value: unknown): AuditEventView {
  if (
    !isRecord(value) ||
    typeof value.eventId !== 'string' ||
    typeof value.eventType !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    typeof value.action !== 'string' ||
    typeof value.correlationId !== 'string' ||
    !Array.isArray(value.changes) ||
    (value.summary !== undefined && typeof value.summary !== 'string')
  ) {
    throw invalidAuditLogResponse()
  }
  const metadata = value.metadata === undefined ? undefined : readAuditObject(value.metadata)
  return {
    eventId: value.eventId,
    eventType: value.eventType,
    occurredAt: value.occurredAt,
    actor: readActor(value.actor),
    entity: readResource(value.entity),
    target: readResource(value.target),
    changes: value.changes.map(readChange),
    action: value.action,
    correlationId: value.correlationId,
    source: readSource(value.source),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

/**
 * Validates the actor snapshot of an event.
 *
 * @param value - Candidate actor.
 * @returns The validated actor.
 */
function readActor(value: unknown) {
  if (!isRecord(value) || typeof value.id !== 'string' || !isAuditActorKind(value.kind)) {
    throw invalidAuditLogResponse()
  }
  if (value.displayName !== undefined && typeof value.displayName !== 'string') throw invalidAuditLogResponse()
  return {
    id: value.id,
    kind: value.kind,
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
  }
}

/**
 * Returns whether a value is a supported actor kind.
 *
 * @param value - Candidate kind.
 * @returns Whether the value is an actor kind.
 */
function isAuditActorKind(value: unknown): value is AuditActorKind {
  return AUDIT_ACTOR_KINDS.some((kind) => kind === value)
}

/**
 * Validates an entity or target reference.
 *
 * @param value - Candidate resource.
 * @returns The validated resource.
 */
function readResource(value: unknown): AuditEventResourceView {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw invalidAuditLogResponse()
  }
  return { type: value.type, id: value.id }
}

/**
 * Validates one field change.
 *
 * @param value - Candidate change.
 * @returns The validated change.
 */
function readChange(value: unknown): AuditFieldChangeView {
  if (!isRecord(value) || typeof value.field !== 'string') throw invalidAuditLogResponse()
  if (value.redacted !== undefined && typeof value.redacted !== 'boolean') throw invalidAuditLogResponse()
  return {
    field: value.field,
    ...(Object.hasOwn(value, 'before') ? { before: readAuditValue(value.before) } : {}),
    ...(Object.hasOwn(value, 'after') ? { after: readAuditValue(value.after) } : {}),
    ...(value.redacted === true ? { redacted: true } : {}),
  }
}

/**
 * Validates the source kind of an event.
 *
 * @param value - Candidate source kind.
 * @returns The validated source kind.
 */
function readSource(value: unknown): AuditSourceKind {
  const kind = auditSourceKinds.find((candidate) => candidate === value)
  if (!kind) throw invalidAuditLogResponse()
  return kind
}

/**
 * Validates a JSON value stored in an event.
 *
 * @param value - Candidate value.
 * @returns The value typed as an audit value.
 */
function readAuditValue(value: unknown): AuditValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(readAuditValue)
  return readAuditObject(value)
}

/**
 * Validates a JSON object stored in an event.
 *
 * @param value - Candidate object.
 * @returns The object with every value validated.
 */
function readAuditObject(value: unknown): { [key: string]: AuditValue } {
  if (!isRecord(value)) throw invalidAuditLogResponse()
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, readAuditValue(entry)]))
}
