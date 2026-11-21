import {
  parseProjectScheduleBaselineResponse,
  type ActivateProjectScheduleBaselineRequest,
  type CaptureProjectScheduleBaselineRequest,
  type ProjectScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { WorkItemConfigurationApiError } from './errors'

const workItemsApiBaseUrl = resolveApiBaseUrl()

const defaultBaselineErrorMessage = 'Unable to load the schedule baseline.'

/**
 * Reads the active schedule baseline of a Project, or one saved baseline by ID.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose baseline is read.
 * @param accessToken - Access token sent as the bearer token.
 * @param baselineId - Saved baseline to read instead of the active one.
 * @returns The baseline response; its `baseline` is `null` when none was saved.
 * @throws WorkItemConfigurationApiError when the request fails or the response is malformed.
 */
export async function getProjectScheduleBaseline(
  teamId: string,
  projectId: string,
  accessToken: string,
  baselineId?: string,
): Promise<ProjectScheduleBaselineResponse> {
  return requestBaseline(
    'GET',
    teamId,
    projectId,
    accessToken,
    baselineId === undefined ? {} : { query: `?baselineId=${encodeURIComponent(baselineId)}` },
  )
}

/**
 * Saves the current plan of every Work Item in a Project as a new baseline and makes it active.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose baseline is saved.
 * @param accessToken - Access token sent as the bearer token.
 * @param name - Optional baseline name.
 * @returns The saved baseline.
 * @throws WorkItemConfigurationApiError when the request fails or the response is malformed.
 */
export async function captureProjectScheduleBaseline(
  teamId: string,
  projectId: string,
  accessToken: string,
  name?: string,
): Promise<ProjectScheduleBaselineResponse> {
  const body: CaptureProjectScheduleBaselineRequest = name?.trim() ? { name: name.trim() } : {}
  return requestBaseline('POST', teamId, projectId, accessToken, { body })
}

/**
 * Makes a saved baseline the active one that every view compares against.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose baseline is switched.
 * @param accessToken - Access token sent as the bearer token.
 * @param request - Saved baseline ID and the active revision that was read.
 * @returns The new active baseline.
 * @throws WorkItemConfigurationApiError when the request fails or the response is malformed.
 */
export async function activateProjectScheduleBaseline(
  teamId: string,
  projectId: string,
  accessToken: string,
  request: ActivateProjectScheduleBaselineRequest,
): Promise<ProjectScheduleBaselineResponse> {
  return requestBaseline('PUT', teamId, projectId, accessToken, { path: '/active', body: request })
}

/** Optional parts of one baseline request. */
type BaselineRequestOptions = {
  /** Path after `/schedule-baseline`. */
  path?: string
  /** Query string starting with `?`. */
  query?: string
  /** JSON body. */
  body?: unknown
}

/**
 * Sends one baseline request and validates the response.
 *
 * @param method - HTTP method.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param accessToken - Access token sent as the bearer token.
 * @param options - Sub-path, query, and body.
 * @returns The validated response.
 */
async function requestBaseline(
  method: 'GET' | 'POST' | 'PUT',
  teamId: string,
  projectId: string,
  accessToken: string,
  options: BaselineRequestOptions = {},
): Promise<ProjectScheduleBaselineResponse> {
  const response = await fetch(
    `${workItemsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/schedule-baseline${options.path ?? ''}${options.query ?? ''}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  )
  const data = await readJson(response)
  if (!response.ok) {
    const message = readStringProperty(data, 'message')?.trim()
    throw new WorkItemConfigurationApiError(
      response.status,
      message || defaultBaselineErrorMessage,
      readStringProperty(data, 'code'),
    )
  }
  const parsed = parseProjectScheduleBaselineResponse(data)
  if (!parsed || parsed.teamId !== teamId || parsed.projectId !== projectId) {
    throw new WorkItemConfigurationApiError(502, defaultBaselineErrorMessage, 'InvalidScheduleBaseline')
  }
  return parsed
}

/**
 * Reads a JSON body, returning `undefined` for an empty or malformed body.
 *
 * @param response - Fetch response.
 * @returns The parsed body.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Reads a string property of an untrusted value.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns The string value, or `undefined`.
 */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const property: unknown = Reflect.get(value, key)
  return typeof property === 'string' ? property : undefined
}
