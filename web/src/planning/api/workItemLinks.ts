import type { PlanningRevisionInput, PlanningSnapshot, PlanningWorkItemLinkInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * Work Item と cycle、milestone、goal の link を保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param workItemId - link 対象 Work Item ID です。
 * @param input - 保存する planning link です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 保存後の planning snapshot です。
 */
export function putPlanningWorkItemLink(
  accessToken: string,
  teamId: string,
  workItemId: string,
  input: PlanningWorkItemLinkInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    createWorkItemLinkPath(teamId, workItemId),
    accessToken,
    'PUT',
    input,
    mutationContext,
  )
}

/**
 * Work Item の planning link を削除します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param workItemId - link 対象 Work Item ID です。
 * @param input - 読み込み時点の revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 削除後の planning snapshot です。
 */
export function deletePlanningWorkItemLink(
  accessToken: string,
  teamId: string,
  workItemId: string,
  input: PlanningRevisionInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    createWorkItemLinkPath(teamId, workItemId),
    accessToken,
    'DELETE',
    input,
    mutationContext,
  )
}

function requestMutation<T>(
  path: string,
  accessToken: string,
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
  input: unknown,
  mutationContext: MutationRequestContext,
) {
  return requestJson<T>(path, accessToken, {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
  })
}

function createWorkItemLinkPath(teamId: string, workItemId: string) {
  return `${planningApiBaseUrl}/planning/work-item-links/${encodeURIComponent(teamId)}/${encodeURIComponent(workItemId)}`
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
