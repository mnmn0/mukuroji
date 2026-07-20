import type { CreatePlanningEntityInput, DuplicatePlanningEntityInput, MovePlanningEntityInput, PlanningRevisionInput, PlanningSnapshot, PlanningStatusUpdateInput, UpdatePlanningEntityInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * Planning entity を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - 作成する entity の値です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 作成後の planning snapshot です。
 */
export function createPlanningEntity(
  accessToken: string,
  input: CreatePlanningEntityInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    `${planningApiBaseUrl}/planning/entities`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Planning entity を更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 更新対象 entity ID です。
 * @param input - revision を含む変更内容です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 更新後の planning snapshot です。
 */
export function updatePlanningEntity(
  accessToken: string,
  entityId: string,
  input: UpdatePlanningEntityInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    createEntityPath(entityId),
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/**
 * Planning entity を archive します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - archive 対象 entity ID です。
 * @param input - 読み込み時点の revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns archive 後の planning snapshot です。
 */
export function archivePlanningEntity(
  accessToken: string,
  entityId: string,
  input: PlanningRevisionInput,
  mutationContext: MutationRequestContext,
) {
  return requestEntityAction<PlanningSnapshot>(
    entityId,
    'archive',
    accessToken,
    input,
    mutationContext,
  )
}

/**
 * Planning entity を複製します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 複製元 entity ID です。
 * @param input - revision と複製先の値です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 複製後の planning snapshot です。
 */
export function duplicatePlanningEntity(
  accessToken: string,
  entityId: string,
  input: DuplicatePlanningEntityInput,
  mutationContext: MutationRequestContext,
) {
  return requestEntityAction<PlanningSnapshot>(
    entityId,
    'duplicate',
    accessToken,
    input,
    mutationContext,
  )
}

/**
 * Planning entity を別の親へ移動します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 移動対象 entity ID です。
 * @param input - revision と移動先です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 移動後の planning snapshot です。
 */
export function movePlanningEntity(
  accessToken: string,
  entityId: string,
  input: MovePlanningEntityInput,
  mutationContext: MutationRequestContext,
) {
  return requestEntityAction<PlanningSnapshot>(
    entityId,
    'move',
    accessToken,
    input,
    mutationContext,
  )
}

/**
 * Planning entity に status update を追加します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 更新対象 entity ID です。
 * @param input - revision と status update の内容です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns status update 追加後の planning snapshot です。
 */
export function addPlanningStatusUpdate(
  accessToken: string,
  entityId: string,
  input: PlanningStatusUpdateInput,
  mutationContext: MutationRequestContext,
) {
  return requestEntityAction<PlanningSnapshot>(
    entityId,
    'status-updates',
    accessToken,
    input,
    mutationContext,
  )
}

function requestEntityAction<T>(
  entityId: string,
  action: 'archive' | 'duplicate' | 'move' | 'status-updates',
  accessToken: string,
  input: unknown,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<T>(
    `${createEntityPath(entityId)}/${action}`,
    accessToken,
    'POST',
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

function createEntityPath(entityId: string) {
  return `${planningApiBaseUrl}/planning/entities/${encodeURIComponent(entityId)}`
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
