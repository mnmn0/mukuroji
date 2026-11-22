import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import { isRecord } from '../../../shared/api/jsonValidation'

/** Base URL of the Workspace audit API. */
const auditLogApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

/**
 * Failure of an audit API request, with the HTTP status and the server's error code.
 */
export class AuditLogApiError extends Error {
  /** HTTP status of the response; 502 when the response could not be read. */
  readonly status: number
  /** Stable error code returned by the server, when it sent one. */
  readonly code?: string

  /**
   * Creates an audit API error.
   *
   * @param status - HTTP status of the response.
   * @param message - Server message, or a fallback description.
   * @param code - Stable error code returned by the server.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AuditLogApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Sends one authenticated request to the audit API and reads its JSON body.
 *
 * @param path - Path below the API base URL, starting with `/audit/`.
 * @param accessToken - Bearer token of the signed-in member.
 * @param init - Fetch options such as method, body, extra headers, and signal.
 * @returns The parsed JSON body.
 * @throws AuditLogApiError When the server rejects the request or returns invalid JSON.
 */
export async function sendAuditLogRequest(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${auditLogApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const text = await response.text()
  let body: unknown = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new AuditLogApiError(response.ok ? 502 : response.status, 'Audit API returned invalid JSON.')
    }
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : `Audit API request failed (${response.status}).`
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
    throw new AuditLogApiError(response.status, message, code)
  }
  return body
}

/**
 * Creates the error for a response whose shape does not match the audit contract.
 *
 * @returns A 502 audit API error.
 */
export function invalidAuditLogResponse(): AuditLogApiError {
  return new AuditLogApiError(502, 'Audit API returned an unexpected response.', 'InvalidAuditResponse')
}
