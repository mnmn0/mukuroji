import type { PlanningSnapshot } from '@mukuroji/contracts'
import { isPlanningSnapshot } from '../../shared/api/contractValidation'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * 現在 user が参照できる計画 snapshot を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Entity、dependency、Work Item link、critical path を含む snapshot です。
 */
export function getPlanningSnapshot(accessToken: string) {
  return requestPlanningSnapshot(`${planningApiBaseUrl}/planning`, accessToken)
}

/** Fetches and validates one authoritative Planning snapshot. */
async function requestPlanningSnapshot(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<PlanningSnapshot> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const errorData = isErrorResponse(data) ? data : undefined

    throw new PlanningApiError(
      response.status,
      errorData?.message?.trim() || defaultPlanningApiErrorMessage,
      errorData?.code,
    )
  }

  if (!isPlanningSnapshot(data)) {
    throw new PlanningApiError(
      response.status,
      defaultPlanningApiErrorMessage,
      'InvalidPlanningSnapshot',
    )
  }
  return data
}

function isErrorResponse(value: unknown): value is { code?: string; message?: string } {
  if (typeof value !== 'object' || value === null) return false

  const hasValidCode = !('code' in value) || typeof value.code === 'string'
  const hasValidMessage = !('message' in value) || typeof value.message === 'string'
  return hasValidCode && hasValidMessage
}

/** Reads a JSON response without trusting its runtime shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
