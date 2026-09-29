import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationRule,
  type CreateAutomationRuleInput,
  type UpdateAutomationRuleInput,
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
 * Workspace の automation rule を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Rule 一覧です。
 */
export function getAutomationRules(accessToken: string) {
  return requestCollection(
    `${automationApiBaseUrl}/automation/rules`,
    accessToken,
    'rules',
    isAutomationRule,
  )
}

/**
 * Automation rule の immutable initial version を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Rule editor で作成した入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した rule です。
 */
export function createAutomationRule(
  accessToken: string,
  input: CreateAutomationRuleInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationRule>(
    `${automationApiBaseUrl}/automation/rules`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Automation rule の新 version または状態を保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param ruleId - 更新対象 rule ID です。
 * @param input - Rule の部分更新入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 更新した rule です。
 */
export function updateAutomationRule(
  accessToken: string,
  ruleId: string,
  input: UpdateAutomationRuleInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationRule>(
    `${automationApiBaseUrl}/automation/rules/${encodeURIComponent(ruleId)}`,
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
 * Returns whether a collection entry has the automation rule fields used by the Web client.
 *
 * @param value - Unknown entry from the rule collection response.
 * @returns Whether the entry is a versioned automation rule.
 */
function isAutomationRule(value: unknown): value is AutomationRule {
  return isRecord(value) &&
    value.schemaVersion === AUTOMATION_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    isNonnegativeSafeInteger(value.version) &&
    isNonnegativeSafeInteger(value.revision) &&
    isTypedRecord(value.trigger) &&
    Array.isArray(value.conditions) &&
    Array.isArray(value.actions) &&
    value.actions.every(isTypedRecord) &&
    isRecord(value.retryPolicy) &&
    isRecord(value.rateLimit) &&
    typeof value.allowReentry === 'boolean' &&
    isNonnegativeSafeInteger(value.maxChainDepth) &&
    isOptionalString(value.nextRunAt) &&
    isOptionalString(value.lastRunAt) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
}

/**
 * Returns whether a trigger or action object carries its string discriminator.
 *
 * @param value - Unknown trigger or action value.
 * @returns Whether the value is a record with a string `type`.
 */
function isTypedRecord(value: unknown) {
  return isRecord(value) && typeof value.type === 'string'
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
