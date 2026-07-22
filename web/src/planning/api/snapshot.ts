import type { PlanningSnapshot } from '@mukuroji/contracts'
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
  return requestJson<PlanningSnapshot>(`${planningApiBaseUrl}/planning`, accessToken)
}

async function requestJson<T>(path: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const errorData = isErrorResponse(data) ? data : undefined

    throw new PlanningApiError(
      response.status,
      errorData?.message?.trim() || defaultPlanningApiErrorMessage,
      errorData?.code,
    )
  }

  return data as T
}

function isErrorResponse(value: unknown): value is { code?: string; message?: string } {
  if (typeof value !== 'object' || value === null) return false

  const hasValidCode = !('code' in value) || typeof value.code === 'string'
  const hasValidMessage = !('message' in value) || typeof value.message === 'string'
  return hasValidCode && hasValidMessage
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
