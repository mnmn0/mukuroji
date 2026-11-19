import type {
  CreateNextCycleInput,
  CreateNextCycleResponse,
  CycleRolloverInput,
  CycleWorkItemsInput,
  PlanningMutationResponse,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { readPlanningSnapshot } from './contractValidation'
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
export async function createNextPlanningCycle(
  accessToken: string,
  cycleId: string,
  input: CreateNextCycleInput,
  mutationContext: MutationRequestContext,
): Promise<CreateNextCycleResponse> {
  const response = await requestMutation<unknown>(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/next`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
  const planning = isRecord(response) ? readPlanningSnapshot(response.planning) : undefined
  if (!isRecord(response) || !planning || typeof response.cycleId !== 'string' || !response.cycleId) {
    // The Cycle may have been created, so a malformed success is reported as a server failure.
    throw new PlanningApiError(502, defaultPlanningApiErrorMessage, 'InvalidPlanningCycleNextResponse')
  }
  return { cycleId: response.cycleId, planning }
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
export async function setPlanningCycleWorkItems(
  accessToken: string,
  cycleId: string,
  input: CycleWorkItemsInput,
  mutationContext: MutationRequestContext,
): Promise<PlanningSnapshot> {
  const response = await requestMutation<unknown>(
    `${planningApiBaseUrl}/planning/cycles/${encodeURIComponent(cycleId)}/work-items`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
  const planning = readPlanningSnapshot(response)
  if (!planning) {
    // The change may have been committed, so a malformed success is reported as a server failure.
    throw new PlanningApiError(502, defaultPlanningApiErrorMessage, 'InvalidPlanningCycleWorkItemsResponse')
  }
  return planning
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

/**
 * Checks that a response body is a plain object.
 *
 * @param value - Parsed response body.
 * @returns Whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
