import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'
import { readRecord } from '../../shared/api/jsonValidation'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

/** Short-lived ticket that opens the Document change-signal WebSocket. */
export type DocumentRealtimeTicket = {
  /** One-time ticket passed in the WebSocket `$connect` query. */
  ticket: string
  /** WebSocket URL that accepts the ticket. */
  websocketUrl: string
  /** Time the subscription expires; the client opens a new one before it. */
  sessionExpiresAt?: string
}

/** Part of a Document that a change signal says to read again. */
export type DocumentChangePart = 'document' | 'comments' | 'presence'

/** Content-free signal that a Document changed. */
export type DocumentChangeSignal = {
  /** Changed Document ID. */
  documentId: string
  /** Changed part. */
  part: DocumentChangePart
  /** Editor client that made the change, when known. */
  originClientId?: string
}

/**
 * Requests a ticket for the Document's change signals.
 *
 * @param accessToken - Documents API access token.
 * @param documentId - Document to subscribe to.
 * @returns The ticket, or undefined when the deployment has no realtime WebSocket.
 */
export async function createDocumentRealtimeTicket(
  accessToken: string,
  documentId: string,
): Promise<DocumentRealtimeTicket | undefined> {
  const response = await fetch(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/realtime/tickets`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: 'POST',
    },
  )
  const text = await response.text()
  let value: unknown
  try {
    value = text ? JSON.parse(text) : undefined
  } catch {
    value = undefined
  }
  const record = readRecord(value)
  if (response.status === 503 && record.code === 'RealtimeUnavailable') {
    return undefined
  }
  if (!response.ok) {
    throw new DocumentsApiError(
      response.status,
      typeof record.message === 'string'
        ? record.message
        : 'Unable to subscribe to document changes.',
      typeof record.code === 'string' ? record.code : undefined,
    )
  }
  if (typeof record.ticket !== 'string' || typeof record.websocketUrl !== 'string') {
    throw new DocumentsApiError(
      response.status,
      'Documents API returned an invalid realtime ticket.',
      'InvalidDocumentsResponse',
    )
  }
  return {
    ticket: record.ticket,
    websocketUrl: record.websocketUrl,
    ...(typeof record.sessionExpiresAt === 'string'
      ? { sessionExpiresAt: record.sessionExpiresAt }
      : {}),
  }
}

/**
 * Parses a WebSocket message into a Document change signal.
 *
 * @param data - Raw message data.
 * @returns The signal, or undefined for any other message.
 */
export function parseDocumentChangeSignal(data: unknown): DocumentChangeSignal | undefined {
  if (typeof data !== 'string') return undefined
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  const record = readRecord(value)
  if (
    record.type !== 'document.changed' ||
    typeof record.documentId !== 'string' ||
    (record.part !== 'document' && record.part !== 'comments' && record.part !== 'presence')
  ) {
    return undefined
  }
  return {
    documentId: record.documentId,
    part: record.part,
    ...(typeof record.originClientId === 'string'
      ? { originClientId: record.originClientId }
      : {}),
  }
}
