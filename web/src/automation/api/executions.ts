import type { AutomationExecution } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AutomationApiError, resolveAutomationApiBaseUrl } from './errors'

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

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)

const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

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
