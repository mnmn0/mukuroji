import {
  parseCycleScheduleBaselineResponse,
  type CaptureCycleScheduleBaselineRequest,
  type CycleScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = resolveApiBaseUrl()

const defaultCycleBaselineErrorMessage = 'Unable to load the Cycle baseline.'

/**
 * Reads the newest, or one saved, schedule baseline of a Cycle.
 *
 * @param accessToken - Access token sent as the bearer token.
 * @param cycleId - Cycle whose baseline is read.
 * @param baselineId - Saved baseline to read instead of the newest one.
 * @returns The baseline response; its `baseline` is `null` before the first save.
 * @throws PlanningApiError when the request fails or the response is malformed.
 */
export function getCycleScheduleBaseline(
  accessToken: string,
  cycleId: string,
  baselineId?: string,
): Promise<CycleScheduleBaselineResponse> {
  const query = baselineId === undefined ? '' : `?baselineId=${encodeURIComponent(baselineId)}`
  return requestCycleBaseline('GET', accessToken, cycleId, query)
}

/**
 * Saves the current plan of the Cycle's Work Items as a new named baseline.
 *
 * @param accessToken - Access token sent as the bearer token.
 * @param cycleId - Cycle whose baseline is saved.
 * @param name - Optional baseline name.
 * @returns The saved baseline with the updated list.
 * @throws PlanningApiError when the request fails or the response is malformed.
 */
export function captureCycleScheduleBaseline(
  accessToken: string,
  cycleId: string,
  name?: string,
): Promise<CycleScheduleBaselineResponse> {
  const body: CaptureCycleScheduleBaselineRequest = name?.trim() ? { name: name.trim() } : {}
  return requestCycleBaseline('POST', accessToken, cycleId, '', body)
}

/**
 * Sends one Cycle baseline request and validates the response.
 *
 * @param method - HTTP method.
 * @param accessToken - Access token sent as the bearer token.
 * @param cycleId - Cycle ID.
 * @param query - Query string starting with `?`, or empty.
 * @param body - JSON body of a write.
 * @returns The validated response.
 */
async function requestCycleBaseline(
  method: 'GET' | 'POST',
  accessToken: string,
  cycleId: string,
  query: string,
  body?: CaptureCycleScheduleBaselineRequest,
): Promise<CycleScheduleBaselineResponse> {
  const response = await fetch(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/schedule-baselines${query}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
  const data = await readJson(response)
  if (!response.ok) {
    throw new PlanningApiError(
      response.status,
      readStringProperty(data, 'message')?.trim() || defaultCycleBaselineErrorMessage,
      readStringProperty(data, 'code'),
    )
  }
  const parsed = parseCycleScheduleBaselineResponse(data)
  if (!parsed || parsed.cycleId !== cycleId) {
    throw new PlanningApiError(502, defaultCycleBaselineErrorMessage, 'InvalidCycleScheduleBaseline')
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
