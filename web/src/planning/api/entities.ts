import type {
  ArchivedPlanningEntityPage,
  ArchivedPlanningEntitySummary,
  CreatePlanningEntityInput,
  DuplicatePlanningEntityInput,
  MovePlanningEntityInput,
  PlanningRestoreSummary,
  PlanningRevisionInput,
  PlanningSnapshot,
  RestorePlanningEntityResponse,
  UpdatePlanningEntityInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { readPlanningSnapshot } from './contractValidation'
import { PlanningApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const planningApiBaseUrl = resolveApiBaseUrl()

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
 * Live graph から退避した archive 済み entity を active に戻します。
 *
 * 1 回の request で戻しきれなかった参照は `restore.pendingReferenceCount` に残り、同じ entity を
 * もう一度復元すると続きを戻します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 復元する entity ID です。
 * @param input - 読み込み時点の revision です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 復元後の planning snapshot と、戻した参照の件数です。
 */
export async function restorePlanningEntity(
  accessToken: string,
  entityId: string,
  input: PlanningRevisionInput,
  mutationContext: MutationRequestContext,
): Promise<RestorePlanningEntityResponse> {
  const response = await requestEntityAction<unknown>(
    entityId,
    'restore',
    accessToken,
    input,
    mutationContext,
  )
  const planning = isRecord(response) ? readPlanningSnapshot(response.planning) : undefined
  if (!isRecord(response) || !planning || !isPlanningRestoreSummary(response.restore)) {
    // The restore may have committed, so a malformed success is reported as a server failure.
    throw new PlanningApiError(502, defaultPlanningApiErrorMessage, 'InvalidPlanningRestoreResponse')
  }
  return { planning, restore: response.restore }
}

/**
 * 呼び出し元が復元できる archive 済み entity を ID 順の cursor page で返します。
 *
 * Server は権限のない entity を page から除くため、`nextCursor` があっても page が空のことがあります。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - 1 page の件数と、前の page が返した cursor です。
 * @returns 検証済みの archive 済み entity page です。
 */
export async function listArchivedPlanningEntities(
  accessToken: string,
  input: { limit?: number; cursor?: string } = {},
): Promise<ArchivedPlanningEntityPage> {
  const query = new URLSearchParams()
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  if (input.cursor !== undefined) query.set('cursor', input.cursor)
  const search = query.toString()
  const response = await requestJson<unknown>(
    `${planningApiBaseUrl}/planning/archived-entities${search ? `?${search}` : ''}`,
    accessToken,
  )
  if (
    !isRecord(response) ||
    !Array.isArray(response.entities) ||
    !response.entities.every(isArchivedPlanningEntitySummary) ||
    (response.nextCursor !== undefined && typeof response.nextCursor !== 'string')
  ) {
    throw new PlanningApiError(502, defaultPlanningApiErrorMessage)
  }
  return {
    entities: response.entities,
    ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}),
  }
}

/**
 * Planning entity の活動として表示する変更 1 件です。
 */
export type PlanningEntityActivityChange = {
  /** Root からの dot 区切り field path です（例: `forecast.end`）。 */
  field: string
  /** 変更前の値です。Field が新しく設定された場合は省略されます。 */
  before?: unknown
  /** 変更後の値です。Field が消された場合は省略されます。 */
  after?: unknown
  /** 閲覧者に見せられない値が伏せられているかどうかです。 */
  redacted?: boolean
}

/**
 * Planning entity の活動 event です（audit event の公開 projection）。
 */
export type PlanningEntityActivityEvent = {
  /** Audit event ID です。 */
  eventId: string
  /** `planning-entity.updated` などの event 種別です。 */
  eventType: string
  /** `updated` などの操作名です。 */
  action: string
  /** Event が起きた ISO 8601 timestamp です。 */
  occurredAt: string
  /** 操作した主体です。 */
  actor: {
    /** 主体の種別です（`user`・`system` など）。 */
    kind: string
    /** 操作時の Workspace member key などの表示用識別子です。 */
    displayName?: string
  }
  /** Field ごとの変更です。 */
  changes: PlanningEntityActivityChange[]
  /** Server が組み立てた英語の概要です。 */
  summary?: string
}

/**
 * Planning entity 活動 API の cursor page です。
 */
export type PlanningEntityActivityPage = {
  /** 新しい順の活動 event です。 */
  events: PlanningEntityActivityEvent[]
  /** 次 page の opaque cursor です。 */
  nextCursor?: string
}

/**
 * Planning entity の作成・変更・移動・archive などの活動を新しい順の cursor page で返します。
 *
 * Server は閲覧者が見られない scope の event を page から除くため、`nextCursor` があっても page が空のことがあります。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param entityId - 活動を読む entity ID です。
 * @param input - 1 page の件数と、前の page が返した cursor です。
 * @returns 検証済みの活動 page です。
 */
export async function getPlanningEntityActivity(
  accessToken: string,
  entityId: string,
  input: { limit?: number; cursor?: string } = {},
): Promise<PlanningEntityActivityPage> {
  const query = new URLSearchParams()
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  if (input.cursor !== undefined) query.set('cursor', input.cursor)
  const search = query.toString()
  const response = await requestJson<unknown>(
    `${createEntityPath(entityId)}/activity${search ? `?${search}` : ''}`,
    accessToken,
  )
  if (
    !isRecord(response) ||
    !Array.isArray(response.events) ||
    (response.nextCursor !== undefined && typeof response.nextCursor !== 'string')
  ) {
    throw new PlanningApiError(502, defaultPlanningApiErrorMessage, 'InvalidPlanningActivityResponse')
  }
  const events: PlanningEntityActivityEvent[] = []
  for (const value of response.events) {
    const event = readPlanningEntityActivityEvent(value)
    if (!event) {
      throw new PlanningApiError(502, defaultPlanningApiErrorMessage, 'InvalidPlanningActivityResponse')
    }
    events.push(event)
  }
  return {
    events,
    ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}),
  }
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
 * Posts one action to a Planning entity action sub-resource.
 *
 * @param entityId - Planning entity ID that owns the action.
 * @param action - Entity action path segment.
 * @param accessToken - Access token used for the Authorization header.
 * @param input - JSON request body for the action.
 * @param mutationContext - Mutation request context shared across retries.
 * @returns The parsed response body.
 */
function requestEntityAction<T>(
  entityId: string,
  action: 'archive' | 'duplicate' | 'move' | 'restore',
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

/**
 * Returns whether a value is a plain JSON object.
 *
 * @param value - Parsed response value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Planning entity types an archived entity summary may carry. */
const planningEntityTypes = new Set<string>([
  'cycle',
  'milestone',
  'release',
  'phase',
  'goal',
  'initiative',
  'roadmap',
  'portfolio',
])

/**
 * Returns whether an optional response field is absent or a string.
 *
 * @param value - Parsed response field.
 * @returns True when the field is undefined or a string.
 */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/**
 * Returns whether a parsed value is an archived entity summary from the archive list API.
 *
 * @param value - One element of the response `entities` array.
 * @returns True when every required field has its contract type.
 */
function isArchivedPlanningEntitySummary(value: unknown): value is ArchivedPlanningEntitySummary {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    planningEntityTypes.has(value.type) &&
    typeof value.title === 'string' &&
    typeof value.ownerMemberKey === 'string' &&
    typeof value.archivedAt === 'string' &&
    isOptionalString(value.parentId) &&
    isOptionalString(value.teamId) &&
    isOptionalString(value.projectId)
}

/**
 * Returns whether a parsed value is the restore summary of the restore API.
 *
 * @param value - The response `restore` field.
 * @returns True when every count is a non-negative safe integer.
 */
function isPlanningRestoreSummary(value: unknown): value is PlanningRestoreSummary {
  if (!isRecord(value)) return false
  const counts = [
    value.restoredLinkCount,
    value.droppedLinkCount,
    value.restoredDependencyCount,
    value.retainedDependencyCount,
    value.droppedDependencyCount,
    value.pendingReferenceCount,
  ]
  return counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
}

/**
 * Reads one activity event, keeping only the fields the activity tab shows.
 *
 * @param value - One element of the response `events` array.
 * @returns The event, or `undefined` when a required field is missing or mistyped.
 */
function readPlanningEntityActivityEvent(value: unknown): PlanningEntityActivityEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.eventId !== 'string' ||
    typeof value.eventType !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    !isRecord(value.actor) ||
    typeof value.actor.kind !== 'string' ||
    !isOptionalString(value.actor.displayName) ||
    !isOptionalString(value.action) ||
    !isOptionalString(value.summary) ||
    !Array.isArray(value.changes)
  ) {
    return undefined
  }
  const changes: PlanningEntityActivityChange[] = []
  for (const change of value.changes) {
    if (!isRecord(change) || typeof change.field !== 'string') return undefined
    if (change.redacted !== undefined && typeof change.redacted !== 'boolean') return undefined
    changes.push({
      field: change.field,
      ...('before' in change ? { before: change.before } : {}),
      ...('after' in change ? { after: change.after } : {}),
      ...(change.redacted ? { redacted: true } : {}),
    })
  }
  return {
    eventId: value.eventId,
    eventType: value.eventType,
    action: value.action ?? value.eventType.split('.').at(-1) ?? value.eventType,
    occurredAt: value.occurredAt,
    actor: {
      kind: value.actor.kind,
      ...(value.actor.displayName === undefined ? {} : { displayName: value.actor.displayName }),
    },
    changes,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  }
}
