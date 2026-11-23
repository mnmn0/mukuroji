import {
  parseTeamPortfolioResponse,
  parseTeamPortfolioSnapshotResponse,
  type TeamPortfolioResponse,
  type TeamPortfolioSnapshotResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'

const portfolioApiBaseUrl = resolveApiBaseUrl('projects')

/** Failure of a Team portfolio request, with the server's status and stable error code. */
export class PortfolioApiError extends Error {
  /** HTTP status of the response; 502 for a malformed response. */
  readonly status: number
  /** Stable error code returned by the server, when any. */
  readonly code?: string

  /**
   * Creates the error.
   *
   * @param status - HTTP status.
   * @param message - Server message or fallback text.
   * @param code - Stable error code, when any.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code !== undefined) this.code = code
  }
}

/**
 * Builds the API path of one Team's portfolio.
 *
 * @param teamId - Team ID.
 * @returns The path below the API base URL.
 */
function createPortfolioPath(teamId: string) {
  return `/teams/${encodeURIComponent(teamId)}/portfolio`
}

/**
 * Reads the current portfolio metrics of one Team.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team ID.
 * @param timeZone - IANA timezone of budget periods.
 * @returns The validated response.
 * @throws PortfolioApiError when the request fails or the response is malformed.
 */
export async function getTeamPortfolio(
  accessToken: string,
  teamId: string,
  timeZone: string,
): Promise<TeamPortfolioResponse> {
  const query = new URLSearchParams({ timeZone })
  const response = await fetch(`${portfolioApiBaseUrl}${createPortfolioPath(teamId)}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseTeamPortfolioResponse(await readResponse(response))
  if (!parsed || parsed.teamId !== teamId) throw new PortfolioApiError(502, 'The portfolio response is malformed.')
  return parsed
}

/**
 * Reads one month's saved portfolio snapshot of a Team.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team ID.
 * @param month - Month as `YYYY-MM`.
 * @returns The snapshot response; its snapshot is `null` when none was saved.
 * @throws PortfolioApiError when the request fails or the response is malformed.
 */
export async function getTeamPortfolioSnapshot(
  accessToken: string,
  teamId: string,
  month: string,
): Promise<TeamPortfolioSnapshotResponse> {
  const response = await fetch(
    `${portfolioApiBaseUrl}${createPortfolioPath(teamId)}/snapshots/${encodeURIComponent(month)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const parsed = parseTeamPortfolioSnapshotResponse(await readResponse(response))
  if (!parsed || (parsed.snapshot !== null && (parsed.snapshot.teamId !== teamId || parsed.snapshot.month !== month))) {
    throw new PortfolioApiError(502, 'The portfolio snapshot response is malformed.')
  }
  return parsed
}

/**
 * Saves the current month's portfolio snapshot of a Team.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team ID.
 * @param month - Current month as `YYYY-MM` in `timeZone`.
 * @param timeZone - IANA timezone of the month and budget periods.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The saved snapshot as the caller may see it.
 * @throws PortfolioApiError when the request fails or the response is malformed.
 */
export async function saveTeamPortfolioSnapshot(
  accessToken: string,
  teamId: string,
  month: string,
  timeZone: string,
  mutationContext: MutationRequestContext,
): Promise<TeamPortfolioSnapshotResponse> {
  const query = new URLSearchParams({ timeZone })
  const response = await fetch(
    `${portfolioApiBaseUrl}${createPortfolioPath(teamId)}/snapshots/${encodeURIComponent(month)}?${query.toString()}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      body: '{}',
    },
  )
  const parsed = parseTeamPortfolioSnapshotResponse(await readResponse(response))
  if (!parsed?.snapshot) throw new PortfolioApiError(502, 'The portfolio snapshot response is malformed.')
  return parsed
}

/**
 * Reads a response body, throwing the API error of a failed response.
 *
 * @param response - Fetch response.
 * @returns The parsed body of a successful response, or `undefined` when it is not JSON.
 * @throws PortfolioApiError when the response failed.
 */
async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    throw new PortfolioApiError(
      response.status,
      readStringField(data, 'message') ?? 'The portfolio request failed.',
      readStringField(data, 'code'),
    )
  }
  return data
}

/**
 * Reads one optional string field from an untrusted object.
 *
 * @param value - Untrusted value.
 * @param key - Field name.
 * @returns The string value, if present.
 */
function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}
