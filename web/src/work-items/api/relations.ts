import type { WorkItemRelationMutationInput, WorkItemRelationMutationResponse } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { WorkItemConfigurationApiError } from './errors'

const workItemsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultApiErrorMessage = 'Unable to complete the Work Item configuration request.'

/**
 * 同一 Team 内の Work Item 間に reciprocal relation を作成します。
 *
 * @param teamId - relation を所有する Team ID です。
 * @param workItemId - relation の起点 Work Item ID です。
 * @param accessToken - Authorization header に使う access token です。
 * @param input - relation 種別と相手 Work Item ID です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 作成した relation、reciprocal relation、更新後 graph revision です。
 */
export function createWorkItemRelation(
  teamId: string,
  workItemId: string,
  accessToken: string,
  input: WorkItemRelationMutationInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WorkItemRelationMutationResponse>(
    createRelationsPath(teamId, workItemId),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )
}

/**
 * 同一 Team 内の reciprocal relation を削除します。
 *
 * @param teamId - relation を所有する Team ID です。
 * @param workItemId - relation の起点 Work Item ID です。
 * @param input - relation 種別、相手 Work Item ID、graph revision です。
 * @param accessToken - Authorization header に使う access token です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 削除した relation、reciprocal relation、更新後 graph revision です。
 */
export function deleteWorkItemRelation(
  teamId: string,
  workItemId: string,
  accessToken: string,
  input: WorkItemRelationMutationInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WorkItemRelationMutationResponse>(
    `${createRelationsPath(teamId, workItemId)}/${encodeURIComponent(input.targetWorkItemId)}/${encodeURIComponent(input.type)}`,
    accessToken,
    {
      body: JSON.stringify({ expectedGraphRevision: input.expectedGraphRevision }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'DELETE',
    },
  )
}

function createRelationsPath(teamId: string, workItemId: string) {
  return `${workItemsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(workItemId)}/relations`
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

    throw new WorkItemConfigurationApiError(
      response.status,
      errorData?.message?.trim() || defaultApiErrorMessage,
      errorData?.code,
    )
  }

  return data as T
}

function isErrorResponse(value: unknown): value is { code?: string; message?: string } {
  return typeof value === 'object' && value !== null
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
