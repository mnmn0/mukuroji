import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
  WorkItemRelationMutationInput,
  WorkItemRelationMutationResponse,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

/**
 * Work Item configuration API が対象にする scope です。
 */
export type WorkItemConfigurationScope =
  | {
      /**
       * Workspace 全体の既定設定を表します。
       */
      kind: 'workspace'
    }
  | {
      /**
       * Team 固有設定を表します。
       */
      kind: 'team'
      /**
       * 設定を取得または更新する Team ID です。
       */
      teamId: string
    }

/**
 * Work Item configuration API の失敗を表す例外です。
 */
export class WorkItemConfigurationApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用の安定 error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const workItemsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)
const defaultApiErrorMessage = 'Unable to complete the Work Item configuration request.'

/**
 * Workspace または Team に対して解決済みの Work Item configuration を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param scope - Workspace 既定または Team 固有の取得 scope です。
 * @returns 継承と既定値を解決済みの configuration です。
 */
export async function getWorkItemConfiguration(
  accessToken: string,
  scope: WorkItemConfigurationScope,
) {
  return requestJson<ResolvedWorkItemConfiguration>(
    createConfigurationPath(scope),
    accessToken,
  )
}

/**
 * Workspace または Team の Work Item configuration 全体を保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param scope - Workspace 既定または Team 固有の保存 scope です。
 * @param configuration - revision を含む保存対象 configuration です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 保存後の解決済み configuration です。
 */
export async function putWorkItemConfiguration(
  accessToken: string,
  scope: WorkItemConfigurationScope,
  configuration: WorkItemConfiguration,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ResolvedWorkItemConfiguration>(
    createConfigurationPath(scope),
    accessToken,
    {
      body: JSON.stringify(configuration),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
  )

}

/**
 * 同一 Team 内の Work Item 間に reciprocal relation を作成します。
 *
 * @param teamId - relation を所有する Team ID です。
 * @param workItemId - relation の起点 Work Item ID です。
 * @param accessToken - Authorization header に使う access token です。
 * @param input - relation 種別と相手 Work Item ID です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns transaction 後の最新 relation 一覧です。
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
 * @returns transaction 後の最新 relation 一覧です。
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

/**
 * configuration scope に対応する API path を返します。
 *
 * @param scope - Workspace または Team scope です。
 * @returns API base URL を含む configuration endpoint です。
 */
export function createConfigurationPath(scope: WorkItemConfigurationScope) {
  return scope.kind === 'workspace'
    ? `${workItemsApiBaseUrl}/work-item-configuration`
    : `${workItemsApiBaseUrl}/teams/${encodeURIComponent(scope.teamId)}/work-item-configuration`
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
