import type {
  AuditEventFilters,
  AuditExportDownloadPartView,
  AuditExportDownloadView,
  AuditExportStatus,
  AuditExportView,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isRecord, isStringArray } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import { invalidAuditLogResponse, sendAuditLogRequest } from './auditLogRequest'

/** States an export job may report. */
const auditExportStatuses: readonly AuditExportStatus[] = ['queued', 'running', 'completed', 'failed']

/** String filters an export may echo back. */
const auditExportStringFilterFields = ['actorId', 'targetType', 'targetId', 'from', 'to'] as const

/**
 * Requests an asynchronous export of the audit events that match the filters.
 *
 * Empty filters export every retained event. The idempotency key makes a retry reuse the same export.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param filters - Filters of the export.
 * @param mutationContext - Idempotency key and correlation ID shared by retries.
 * @returns The created or reused export.
 * @throws AuditLogApiError When the server rejects the request or the response is malformed.
 */
export async function requestAuditExport(
  accessToken: string,
  filters: AuditEventFilters,
  mutationContext: MutationRequestContext,
): Promise<AuditExportView> {
  const body = await sendAuditLogRequest('/audit/exports', accessToken, {
    method: 'POST',
    headers: createMutationHeaders(mutationContext),
    body: JSON.stringify({ filters }),
  })
  if (!isRecord(body)) throw invalidAuditLogResponse()
  return readAuditExport(body.export)
}

/**
 * Lists the Workspace's most recent audit exports that have not expired.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param signal - Optional cancellation signal.
 * @returns Exports, newest first as the server orders them.
 * @throws AuditLogApiError When the server rejects the request or the response is malformed.
 */
export async function listAuditExports(accessToken: string, signal?: AbortSignal): Promise<AuditExportView[]> {
  const body = await sendAuditLogRequest('/audit/exports', accessToken, { signal })
  if (!isRecord(body) || !Array.isArray(body.exports)) throw invalidAuditLogResponse()
  return body.exports.map(readAuditExport)
}

/**
 * Issues short-lived download links for the parts of a completed export.
 *
 * The server records each issuance as an `audit.export-downloaded` event.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param exportId - Completed export.
 * @param fromPart - First part of the page, 0 for the first page.
 * @returns Links of up to 100 parts and the start of the next page.
 * @throws AuditLogApiError When the server rejects the request or the response is malformed.
 */
export async function getAuditExportDownload(
  accessToken: string,
  exportId: string,
  fromPart = 0,
): Promise<AuditExportDownloadView> {
  const query = fromPart > 0 ? `?fromPart=${fromPart}` : ''
  const body = await sendAuditLogRequest(`/audit/exports/${encodeURIComponent(exportId)}/download${query}`, accessToken)
  if (!isRecord(body) || !Array.isArray(body.parts)) throw invalidAuditLogResponse()
  if (body.nextPart !== undefined && !isNonnegativeSafeInteger(body.nextPart)) throw invalidAuditLogResponse()
  return {
    export: readAuditExport(body.export),
    parts: body.parts.map(readDownloadPart),
    ...(isNonnegativeSafeInteger(body.nextPart) ? { nextPart: body.nextPart } : {}),
  }
}

/**
 * Validates an export view.
 *
 * @param value - Candidate export.
 * @returns The validated export.
 * @throws AuditLogApiError When a field is missing or malformed.
 */
export function readAuditExport(value: unknown): AuditExportView {
  if (
    !isRecord(value) ||
    typeof value.exportId !== 'string' ||
    typeof value.snapshotAt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !isNonnegativeSafeInteger(value.eventCount) ||
    !isNonnegativeSafeInteger(value.partCount) ||
    !isRecord(value.requestedBy) ||
    typeof value.requestedBy.displayName !== 'string'
  ) {
    throw invalidAuditLogResponse()
  }
  const status = auditExportStatuses.find((candidate) => candidate === value.status)
  if (!status) throw invalidAuditLogResponse()
  const failure = value.failure
  if (failure !== undefined && (!isRecord(failure) || typeof failure.code !== 'string' || typeof failure.message !== 'string')) {
    throw invalidAuditLogResponse()
  }
  return {
    exportId: value.exportId,
    status,
    filters: readExportFilters(value.filters),
    snapshotAt: value.snapshotAt,
    requestedBy: { displayName: value.requestedBy.displayName },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    eventCount: value.eventCount,
    partCount: value.partCount,
    ...(isRecord(failure) && typeof failure.code === 'string' && typeof failure.message === 'string'
      ? { failure: { code: failure.code, message: failure.message } }
      : {}),
  }
}

/**
 * Reads the filters an export echoes back, keeping only the fields the Web shows.
 *
 * @param value - Candidate filters.
 * @returns The known filters.
 */
function readExportFilters(value: unknown): AuditEventFilters {
  if (!isRecord(value)) throw invalidAuditLogResponse()
  const filters: AuditEventFilters = {}
  for (const field of auditExportStringFilterFields) {
    const fieldValue = value[field]
    if (typeof fieldValue === 'string') filters[field] = fieldValue
  }
  if (isStringArray(value.eventTypes)) filters.eventTypes = value.eventTypes
  return filters
}

/**
 * Validates one download link.
 *
 * @param value - Candidate part.
 * @returns The validated part.
 * @throws AuditLogApiError When a field is missing, or the URL is not an HTTPS or HTTP URL.
 */
function readDownloadPart(value: unknown): AuditExportDownloadPartView {
  if (
    !isRecord(value) ||
    !isNonnegativeSafeInteger(value.index) ||
    !isNonnegativeSafeInteger(value.eventCount) ||
    !isNonnegativeSafeInteger(value.byteLength) ||
    typeof value.sha256 !== 'string' ||
    typeof value.url !== 'string' ||
    !isHttpUrl(value.url)
  ) {
    throw invalidAuditLogResponse()
  }
  return {
    index: value.index,
    eventCount: value.eventCount,
    byteLength: value.byteLength,
    sha256: value.sha256,
    url: value.url,
  }
}

/**
 * Returns whether a link is safe to render as a download anchor.
 *
 * @param value - Candidate URL.
 * @returns Whether the URL uses HTTPS, or HTTP for local development.
 */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
