import type {
  ApplyAutomationTemplateInput,
  AutomationExecution,
  AutomationInboundWebhookEndpoint,
  AutomationInboundWebhookLifecycleInput,
  AutomationInboundWebhookSecretResponse,
  AutomationRule,
  AutomationTemplate,
  AutomationTemplateApplication,
  CreateAutomationRuleInput,
  CreateAutomationInboundWebhookEndpointInput,
  CreateAutomationTemplateInput,
  CreateRecurringWorkInput,
  RecurringWork,
  UpdateAutomationRuleInput,
  UpdateAutomationInboundWebhookEndpointInput,
  UpdateAutomationTemplateInput,
  UpdateRecurringWorkInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

/** Automation execution 一覧の取得条件です。 */
export type AutomationExecutionQuery = {
  /** Rule ID の完全一致 filter です。 */
  ruleId?: string
  /** Execution status の完全一致 filter です。 */
  status?: string
  /** API が返した opaque cursor です。 */
  cursor?: string
}

/** Automation execution API の cursor page です。 */
export type AutomationExecutionPage = {
  /** Page に含まれる execution です。 */
  executions: AutomationExecution[]
  /** 次 page を取得する opaque cursor です。 */
  nextCursor?: string
}

/** Automation API の失敗を表す error です。 */
export class AutomationApiError extends Error {
  /** HTTP status code です。 */
  readonly status: number

  /** API が返した安定 error code です。 */
  readonly code?: string

  /**
   * Automation API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 利用者向け error message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AutomationApiError'
    this.status = status
    this.code = code
  }
}

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)
const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

/**
 * Automation API の base URL を既存 Workspace API と同じ優先順で解決します。
 *
 * @param environment - Vite から渡される環境変数です。
 * @returns 末尾の slash を除いた API base URL です。
 */
export function resolveAutomationApiBaseUrl(
  environment: Record<string, string | boolean | undefined>,
) {
  return trimTrailingSlash(
    typeof environment.VITE_WORKSPACE_API_BASE_URL === 'string'
      ? environment.VITE_WORKSPACE_API_BASE_URL
      : typeof environment.VITE_PROJECTS_API_BASE_URL === 'string'
        ? environment.VITE_PROJECTS_API_BASE_URL
        : typeof environment.VITE_TASKS_API_BASE_URL === 'string'
          ? environment.VITE_TASKS_API_BASE_URL
          : typeof environment.VITE_API_BASE_URL === 'string'
            ? environment.VITE_API_BASE_URL
            : '/api',
  )
}

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

/**
 * Workspace の inbound Webhook endpoint を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Secret を含まない endpoint 一覧です。
 */
export function getAutomationInboundWebhookEndpoints(accessToken: string) {
  return requestCollection<AutomationInboundWebhookEndpoint>(
    `${automationApiBaseUrl}/automation/inbound-webhooks`,
    accessToken,
    'endpoints',
  )
}

/**
 * Inbound Webhook endpoint と一回限りの signing secret を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Endpoint 表示名です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した endpoint と一回限りの signing secret です。
 */
export function createAutomationInboundWebhookEndpoint(
  accessToken: string,
  input: CreateAutomationInboundWebhookEndpointInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationInboundWebhookSecretResponse>(
    `${automationApiBaseUrl}/automation/inbound-webhooks`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Inbound Webhook endpoint の durable metadata を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param endpointId - Workspace 内 endpoint ID です。
 * @returns Secret を含まない endpoint です。
 */
export function getAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
) {
  return requestJson<AutomationInboundWebhookEndpoint>(
    `${automationApiBaseUrl}/automation/inbound-webhooks/${encodeURIComponent(endpointId)}`,
    accessToken,
  )
}

/**
 * Inbound Webhook endpoint の表示名を更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param endpointId - Workspace 内 endpoint ID です。
 * @param input - Optimistic revision と新しい名前です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 更新した endpoint です。
 */
export function updateAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
  input: UpdateAutomationInboundWebhookEndpointInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationInboundWebhookEndpoint>(
    `${automationApiBaseUrl}/automation/inbound-webhooks/${encodeURIComponent(endpointId)}`,
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/** Inbound Webhook endpoint を停止します。 */
export function pauseAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
  input: AutomationInboundWebhookLifecycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestInboundWebhookLifecycle<AutomationInboundWebhookEndpoint>(
    accessToken,
    endpointId,
    'pause',
    input,
    mutationContext,
  )
}

/** Inbound Webhook endpoint を再開します。 */
export function resumeAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
  input: AutomationInboundWebhookLifecycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestInboundWebhookLifecycle<AutomationInboundWebhookEndpoint>(
    accessToken,
    endpointId,
    'resume',
    input,
    mutationContext,
  )
}

/** Inbound Webhook signing secret を rotate して一回だけ返します。 */
export function rotateAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
  input: AutomationInboundWebhookLifecycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestInboundWebhookLifecycle<AutomationInboundWebhookSecretResponse>(
    accessToken,
    endpointId,
    'rotate',
    input,
    mutationContext,
  )
}

/**
 * Inbound Webhook endpoint を不可逆に revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param endpointId - Workspace 内 endpoint ID です。
 * @param input - Optimistic revision です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns Revoke 済み endpoint です。
 */
export function revokeAutomationInboundWebhookEndpoint(
  accessToken: string,
  endpointId: string,
  input: AutomationInboundWebhookLifecycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationInboundWebhookEndpoint>(
    `${automationApiBaseUrl}/automation/inbound-webhooks/${encodeURIComponent(endpointId)}`,
    accessToken,
    'DELETE',
    input,
    mutationContext,
  )
}

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

/**
 * Workspace の recurring Work 定義を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Recurring Work 一覧です。
 */
export function getRecurringWork(accessToken: string) {
  return requestCollection<RecurringWork>(`${automationApiBaseUrl}/recurring-work`, accessToken, 'recurringWorks')
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
 * Automation execution history を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param query - Rule、status、cursor の filter です。
 * @returns Execution の cursor page です。
 */
export async function getAutomationExecutions(
  accessToken: string,
  query: AutomationExecutionQuery = {},
) {
  const search = new URLSearchParams()

  if (query.ruleId) search.set('ruleId', query.ruleId)
  if (query.status) search.set('status', query.status)
  if (query.cursor) search.set('cursor', query.cursor)

  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  const response = await requestJson<unknown>(
    `${automationApiBaseUrl}/automation/executions${suffix}`,
    accessToken,
  )

  if (Array.isArray(response)) {
    return { executions: response as AutomationExecution[] } satisfies AutomationExecutionPage
  }

  const record = toRecord(response)

  return {
    executions: Array.isArray(record.executions)
      ? record.executions as AutomationExecution[]
      : Array.isArray(record.items)
        ? record.items as AutomationExecution[]
        : [],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
  } satisfies AutomationExecutionPage
}

/**
 * Retryable な automation execution を同じ入力で再実行します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param executionId - Retry 対象 execution ID です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 新しい execution です。
 */
export function retryAutomationExecution(
  accessToken: string,
  executionId: string,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationExecution>(
    `${automationApiBaseUrl}/automation/executions/${encodeURIComponent(executionId)}/retry`,
    accessToken,
    'POST',
    undefined,
    mutationContext,
  )
}

function requestInboundWebhookLifecycle<TResponse>(
  accessToken: string,
  endpointId: string,
  action: 'pause' | 'resume' | 'rotate',
  input: AutomationInboundWebhookLifecycleInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<TResponse>(
    `${automationApiBaseUrl}/automation/inbound-webhooks/${encodeURIComponent(endpointId)}/${action}`,
    accessToken,
    'POST',
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
    return {} as TResponse
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
