import {
  PROJECT_QUICK_ACCESS_MAX_ITEMS,
  PROJECT_QUICK_ACCESS_MAX_REVISION,
  type ProjectQuickAccessItem,
  type ProjectQuickAccessPreferences,
  type UpdateProjectQuickAccessPreferencesInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Loads the authenticated viewer's ordered Project quick-access preference.
 *
 * @param accessToken - Cognito access token.
 * @param signal - Optional request cancellation signal.
 * @returns The current versioned preference.
 */
export async function getProjectQuickAccess(
  accessToken: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`${projectsApiBaseUrl}/projects/quick-access`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  const data = await readJson(response)

  if (!response.ok) {
    throw createQuickAccessApiError(response.status, data)
  }
  if (!isProjectQuickAccessPreferences(data)) {
    throw new ProjectDirectoryApiError(
      response.status,
      'projects.quickAccess.error.loading',
    )
  }
  return data
}

/**
 * Replaces the authenticated viewer's complete Project quick-access order.
 *
 * @param accessToken - Cognito access token.
 * @param input - Complete next order and expected revision.
 * @param mutationContext - Stable mutation headers used by the authenticated client.
 * @returns The committed preference with its next revision.
 */
export async function replaceProjectQuickAccess(
  accessToken: string,
  input: UpdateProjectQuickAccessPreferencesInput,
  mutationContext: MutationRequestContext,
) {
  const response = await fetch(`${projectsApiBaseUrl}/projects/quick-access`, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'PUT',
  })
  const data = await readJson(response)

  if (!response.ok) {
    throw createQuickAccessApiError(response.status, data)
  }
  if (!isProjectQuickAccessPreferences(data)) {
    throw new ProjectDirectoryApiError(
      response.status,
      'projects.quickAccess.error.saving',
    )
  }
  return data
}

/**
 * Validates the preference response at the browser boundary.
 *
 * @param value - Unknown JSON response.
 * @returns Whether the value is a safe quick-access preference.
 */
function isProjectQuickAccessPreferences(
  value: unknown,
): value is ProjectQuickAccessPreferences {
  if (!isRecord(value)) return false
  const revision = value.revision
  const items = value.items
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > PROJECT_QUICK_ACCESS_MAX_REVISION ||
    !Array.isArray(items) ||
    items.length > PROJECT_QUICK_ACCESS_MAX_ITEMS
  ) return false

  const projectIds = new Set<string>()
  for (const item of items) {
    if (!isProjectQuickAccessItem(item) || projectIds.has(item.projectId)) {
      return false
    }
    projectIds.add(item.projectId)
  }
  return true
}

/**
 * Validates one Team-owned Project reference.
 *
 * @param value - Unknown candidate reference.
 * @returns Whether the value contains canonical Team and Project identifiers.
 */
function isProjectQuickAccessItem(value: unknown): value is ProjectQuickAccessItem {
  return isRecord(value) &&
    isProjectQuickAccessIdentifier(value.teamId) &&
    isProjectQuickAccessIdentifier(value.projectId)
}

/**
 * Validates one canonical Team or Project identifier returned by the API.
 *
 * @param value - Unknown identifier candidate.
 * @returns Whether the value satisfies the shared identifier boundary.
 */
function isProjectQuickAccessIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !value.includes('/')
}

/**
 * Creates an API error without trusting an arbitrary response payload.
 *
 * @param status - HTTP response status.
 * @param value - Unknown decoded error payload.
 * @returns A safe Project directory API error.
 */
function createQuickAccessApiError(status: number, value: unknown) {
  const message = isRecord(value) && typeof value.message === 'string'
    ? value.message
    : status === 409
      ? 'projects.quickAccess.error.conflict'
      : 'projects.quickAccess.error.saving'
  const code = isRecord(value) && typeof value.code === 'string'
    ? value.code
    : undefined
  return new ProjectDirectoryApiError(status, message, code)
}

/**
 * Reads a fetch body as unknown JSON.
 *
 * @param response - Fetch response to decode.
 * @returns The decoded JSON value, or an empty record for an invalid body.
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
 * Removes trailing slashes from an API base URL.
 *
 * @param value - Configured API base URL.
 * @returns The URL without trailing separators.
 */
function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

/**
 * Narrows an unknown value to a non-array record.
 *
 * @param value - Unknown candidate value.
 * @returns Whether the value is a non-null object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
