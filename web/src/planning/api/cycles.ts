import type {
  CreateNextCycleInput,
  CreateNextCycleResponse,
  CycleRolloverInput,
  CycleWorkItemsInput,
  PlanningMutationResponse,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { PlanningApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const planningApiBaseUrl = resolveApiBaseUrl()

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * Cycle を rollover し、未完了 Work Item を carry-over policy に従って移動します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param cycleId - rollover 対象 cycle ID です。
 * @param input - revision、次 cycle、carry-over 条件です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns rollover 結果と移動された Work Item です。
 */
export function rolloverPlanningCycle(
  accessToken: string,
  cycleId: string,
  input: CycleRolloverInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningMutationResponse>(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/rollover`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Cadence に従って次の Cycle を作ります。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param cycleId - 元の Cycle ID です。
 * @param input - 読み込み時点の revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 作成した Cycle の ID と snapshot です。
 */
export function createNextPlanningCycle(
  accessToken: string,
  cycleId: string,
  input: CreateNextCycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<CreateNextCycleResponse>(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/next`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * 複数の Work Item を1回で Cycle に入れる、または Cycle から外します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param cycleId - 対象の Cycle ID です。
 * @param input - 操作、Work Item、revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 更新後の snapshot です。
 */
export function setPlanningCycleWorkItems(
  accessToken: string,
  cycleId: string,
  input: CycleWorkItemsInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/work-items`,
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
