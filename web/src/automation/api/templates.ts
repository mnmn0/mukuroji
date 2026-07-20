import type { ApplyAutomationTemplateInput, AutomationTemplate, AutomationTemplateApplication, CreateAutomationTemplateInput, UpdateAutomationTemplateInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AutomationApiError, resolveAutomationApiBaseUrl } from './errors'

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)

const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

/**
 * Workspace の automation template を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Template 一覧です。
 */
export function getAutomationTemplates(accessToken: string) {
  return requestCollection<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates`,
    accessToken,
    'templates',
  )
}

/**
 * Automation template を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Template editor で作成した入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した template です。
 */
export function createAutomationTemplate(
  accessToken: string,
  input: CreateAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Automation template を部分更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 更新対象 template ID です。
 * @param input - Template の部分更新入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 更新した template です。
 */
export function updateAutomationTemplate(
  accessToken: string,
  templateId: string,
  input: UpdateAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}`,
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/**
 * Automation template の複製を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 複製元 template ID です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した template です。
 */
export function duplicateAutomationTemplate(
  accessToken: string,
  templateId: string,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}/duplicate`,
    accessToken,
    'POST',
    undefined,
    mutationContext,
  )
}

/**
 * Project または Workflow template を immutable version pin 付きで適用します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 適用対象 template ID です。
 * @param input - Team または configuration scope を含む適用先です。
 * @param mutationContext - Idempotency-Key を固定する mutation context です。
 * @returns Durable application receipt です。
 */
export function applyAutomationTemplate(
  accessToken: string,
  templateId: string,
  input: ApplyAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplateApplication>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}/applications`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Durable template application の最新状態を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param applicationId - Application receipt ID です。
 * @returns 最新 application receipt です。
 */
export function getAutomationTemplateApplication(
  accessToken: string,
  applicationId: string,
) {
  return requestJson<AutomationTemplateApplication>(
    `${automationApiBaseUrl}/automation/template-applications/${encodeURIComponent(applicationId)}`,
    accessToken,
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
