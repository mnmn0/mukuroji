/** Default message used when an Issues API error does not include one. */
export const defaultIssuesApiErrorMessage =
  'Unable to complete the Work Item request.'

/**
 * Builds the canonical URL path for a Team-owned Work Item.
 *
 * @param apiBaseUrl - Configured Issues API base URL.
 * @param teamId - Owning Team identifier.
 * @param issueId - Work Item identifier.
 * @returns Encoded Work Item API path.
 */
export function createTeamIssuePath(
  apiBaseUrl: string,
  teamId: string,
  issueId: string,
): string {
  return `${apiBaseUrl}/teams/${encodeURIComponent(
    teamId,
  )}/issues/${encodeURIComponent(issueId)}`
}

/**
 * Reads a stable error shape from an untrusted Issues API response.
 *
 * @param data - Untrusted decoded response payload.
 * @returns Optional error code and a safe human-readable message.
 */
export function readApiError(data: unknown): { code?: string; message: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { message: defaultIssuesApiErrorMessage }
  }

  const record = data as Record<string, unknown>
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message:
      typeof record.message === 'string' && record.message.trim()
        ? record.message
        : defaultIssuesApiErrorMessage,
  }
}

/**
 * Decodes a JSON response body without trusting its shape.
 *
 * @param response - Fetch response to decode.
 * @returns Parsed JSON value, or an empty object for empty/malformed bodies.
 */
export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

/**
 * Removes trailing slashes from a configured API base URL.
 *
 * @param value - Configured API base URL.
 * @returns URL without trailing slash characters.
 */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
