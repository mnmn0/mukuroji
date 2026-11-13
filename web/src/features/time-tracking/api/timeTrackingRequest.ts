import { isRecord } from '../../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'

/** Base URL shared by every time tracking endpoint. */
export const timeTrackingApiBaseUrl = resolveApiBaseUrl()

/** Error returned by a time tracking request. */
export class TimeTrackingApiError extends Error {
  /** HTTP status returned by the API, or 0 when the request did not reach it. */
  readonly status: number
  /** Stable API error code, when provided. */
  readonly code?: string

  /**
   * Creates one time tracking API error.
   *
   * @param status - HTTP status returned by the API, or 0 for a network failure.
   * @param message - Human-readable failure message.
   * @param code - Optional stable API error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'TimeTrackingApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Builds the URL of a Team-scoped time tracking endpoint.
 *
 * @param teamId - Team that owns the resource.
 * @param path - Path below the Team, starting with a slash.
 * @returns Absolute or same-origin URL.
 */
export function createTeamTimeTrackingUrl(teamId: string, path: string): string {
  return `${timeTrackingApiBaseUrl}/teams/${encodeURIComponent(teamId)}${path}`
}

/**
 * Sends an authenticated request and returns its untrusted JSON body.
 *
 * A request that never reaches the API is reported with status 0 so callers can keep the
 * idempotency key and retry quietly once the connection returns.
 *
 * @param url - Request URL.
 * @param accessToken - Bearer token of the signed-in member.
 * @param init - Fetch options.
 * @returns Parsed JSON body, or an empty object for an empty body.
 */
export async function requestTimeTrackingJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  let response: Response
  try {
    response = await fetch(url, { ...init, headers })
  } catch {
    throw new TimeTrackingApiError(0, 'The time tracking API could not be reached.', 'NetworkUnavailable')
  }
  const data = await readJson(response)
  if (!response.ok) {
    const error = isRecord(data) ? data : {}
    throw new TimeTrackingApiError(
      response.status,
      typeof error.message === 'string' && error.message.trim()
        ? error.message
        : 'Time tracking is unavailable.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
  return data
}

/**
 * Reads a response body as untrusted JSON.
 *
 * @param response - Fetch response.
 * @returns Parsed body, or an empty object for an empty or invalid body.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Creates the error used when a response does not match its contract.
 *
 * @param subject - Endpoint subject named in the message.
 * @returns Error with a 502 status.
 */
export function createInvalidTimeTrackingResponseError(subject: string): TimeTrackingApiError {
  return new TimeTrackingApiError(502, `${subject} returned an unexpected response.`)
}
