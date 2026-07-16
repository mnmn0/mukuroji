import type {
  CreatePlanningDependencyInput,
  CreatePlanningEntityInput,
  CycleRolloverInput,
  DuplicatePlanningEntityInput,
  MovePlanningEntityInput,
  PlanningMutationResponse,
  PlanningRevisionInput,
  PlanningSnapshot,
  PlanningStatusUpdateInput,
  PlanningWorkItemLinkInput,
  UpdatePlanningEntityInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

/**
 * Planning API が返した失敗を表す例外です。
 */
export class PlanningApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用の安定 error code です。
   */
  readonly code?: string

  /**
   * Planning API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 画面へ引き渡せる error message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const planningApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)
const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * Planning 画面に表示する locale 済み error message の翻訳 key を解決します。
 *
 * @param error - Planning の load または mutation で発生した error です。
 * @param operation - Error が発生した操作です。
 * @returns Revision conflict は競合用、それ以外は汎用 error の翻訳 key です。
 */
export function resolvePlanningErrorMessageKey(
  error: unknown,
  operation: 'load' | 'mutation' = 'load',
) {
  if (typeof error !== 'object' || error === null) {
    return operation === 'mutation' ? 'planning.mutationError' as const : 'planning.error' as const
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code === 'PlanningRevisionConflict') return 'planning.conflict' as const
  return operation === 'mutation' ? 'planning.mutationError' as const : 'planning.error' as const
}

/**
 * 現在 user が参照できる計画 snapshot を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Entity、dependency、Work Item link、critical path を含む snapshot です。
 */
export function getPlanningSnapshot(accessToken: string) {
  return requestJson<PlanningSnapshot>(`${planningApiBaseUrl}/planning`, accessToken)
}

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

/**
 * Planning entity 間の dependency を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - dependency の両端と種別です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 作成後の planning snapshot です。
 */
export function createPlanningDependency(
  accessToken: string,
  input: CreatePlanningDependencyInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    `${planningApiBaseUrl}/planning/dependencies`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Planning dependency を削除します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param dependencyId - 削除対象 dependency ID です。
 * @param input - 読み込み時点の revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 削除後の planning snapshot です。
 */
export function deletePlanningDependency(
  accessToken: string,
  dependencyId: string,
  input: PlanningRevisionInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<PlanningSnapshot>(
    `${planningApiBaseUrl}/planning/dependencies/${encodeURIComponent(dependencyId)}`,
    accessToken,
    'DELETE',
    input,
    mutationContext,
  )
}

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
