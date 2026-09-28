import {
  AUTOMATION_SCHEMA_VERSION,
  type CreateRecurringWorkInput,
  type RecurringWork,
  type UpdateRecurringWorkInput,
} from '@mukuroji/contracts'
import {
  isNonnegativeSafeInteger,
  isOptionalString,
  isRecord,
} from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AutomationApiError, resolveAutomationApiBaseUrl } from './errors'

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)

const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

/**
 * Workspace の recurring Work 定義を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Recurring Work 一覧です。
 */
export function getRecurringWork(accessToken: string) {
  return requestCollection(
    `${automationApiBaseUrl}/recurring-work`,
    accessToken,
    'recurringWorks',
    isRecurringWork,
  )
}

/**
 * Recurring Work 定義を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Schedule editor で作成した入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した recurring Work 定義です。
 */
export function createRecurringWork(
  accessToken: string,
  input: CreateRecurringWorkInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<RecurringWork>(
    `${automationApiBaseUrl}/recurring-work`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Recurring Work 定義を部分更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param recurringWorkId - 更新対象 recurring Work ID です。
 * @param input - Schedule または状態の部分更新入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 更新した recurring Work 定義です。
 */
export function updateRecurringWork(
  accessToken: string,
  recurringWorkId: string,
  input: UpdateRecurringWorkInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<RecurringWork>(
    `${automationApiBaseUrl}/recurring-work/${encodeURIComponent(recurringWorkId)}`,
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/**
 * Loads the canonical collection property returned by an automation list endpoint.
 *
 * @param url - Collection endpoint URL.
 * @param accessToken - Access token used for the Authorization header.
 * @param collectionKey - Response property that owns the collection.
 * @param isItem - Runtime guard for one collection entry.
 * @returns Validated collection entries.
 * @throws AutomationApiError when the response does not contain a valid collection.
 */
async function requestCollection<TItem>(
  url: string,
  accessToken: string,
  collectionKey: string,
  isItem: (value: unknown) => value is TItem,
): Promise<TItem[]> {
  const response = await requestJson<unknown>(url, accessToken)
  const collection = isRecord(response) ? response[collectionKey] : undefined

  if (!Array.isArray(collection) || !collection.every(isItem)) {
    throw new AutomationApiError(
      502,
      'Automation API returned an invalid response.',
      'InvalidAutomationResponse',
    )
  }

  return collection
}

/**
 * Returns whether a collection entry has the recurring Work fields used by the Web client.
 *
 * @param value - Unknown entry from the recurring Work collection response.
 * @returns Whether the entry is a recurring Work definition.
 */
function isRecurringWork(value: unknown): value is RecurringWork {
  return isRecord(value) &&
    value.schemaVersion === AUTOMATION_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    isNonnegativeSafeInteger(value.version) &&
    isNonnegativeSafeInteger(value.revision) &&
    typeof value.templateId === 'string' &&
    isNonnegativeSafeInteger(value.templateVersion) &&
    isRecord(value.schedule) &&
    typeof value.schedule.timeZone === 'string' &&
    typeof value.nextRunAt === 'string' &&
    isOptionalString(value.lastRunAt) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
}

function requestMutation<TResponse>(
  url: string,
  accessToken: string,
  method: 'DELETE' | 'PATCH' | 'POST',
  input: unknown,
  mutationContext: MutationRequestContext,
) {
  return requestJson<TResponse>(url, accessToken, {
    body: input === undefined ? undefined : JSON.stringify(input),
    headers: {
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...createMutationHeaders(mutationContext),
    },
    method,
  })
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const error = toRecord(data)
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message
      : defaultAutomationApiErrorMessage
    const code = typeof error.code === 'string' ? error.code : undefined

    throw new AutomationApiError(response.status, message, code)
  }

  return data as TResponse
}

async function readJson<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text()

  if (!text) return {} as TResponse

  try {
    return JSON.parse(text) as TResponse
  } catch {
    throw new AutomationApiError(
      response.status,
      'Automation API returned invalid JSON.',
      'InvalidAutomationResponse',
    )
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}
