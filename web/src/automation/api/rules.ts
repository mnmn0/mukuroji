import type { AutomationRule, CreateAutomationRuleInput, UpdateAutomationRuleInput } from '@mukuroji/contracts'
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
  return requestCollection<AutomationRule>(`${automationApiBaseUrl}/automation/rules`, accessToken, 'rules')
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

async function requestCollection<TItem>(
  url: string,
  accessToken: string,
  collectionKey: string,
) {
  const response = await requestJson<unknown>(url, accessToken)

  if (Array.isArray(response)) return response as TItem[]

  const record = toRecord(response)
  const collection = record[collectionKey] ?? record.items

  return Array.isArray(collection) ? collection as TItem[] : []
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
