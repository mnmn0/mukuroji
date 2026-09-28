import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationActionExecution,
  type AutomationActionExecutionStatus,
  type AutomationExecution,
  type AutomationExecutionStatus,
} from '@mukuroji/contracts'
import {
  isNonnegativeSafeInteger,
  isOptionalString,
  isRecord,
} from '../../shared/api/jsonValidation'
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

/** Execution statuses accepted from the execution history response. */
const automationExecutionStatuses: readonly AutomationExecutionStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead-letter',
  'skipped',
]

/** Action result statuses accepted from the execution history response. */
const automationActionExecutionStatuses: readonly AutomationActionExecutionStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
]

/**
 * Loads one page of automation execution history.
 *
 * @param accessToken - Access token used for the Authorization header.
 * @param query - Rule, status, and cursor filters.
 * @returns Validated executions and the optional next-page cursor.
 * @throws AutomationApiError when the response is not a valid execution page.
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

  if (
    !isRecord(response) ||
    !Array.isArray(response.executions) ||
    !response.executions.every(isAutomationExecution) ||
    !isOptionalString(response.nextCursor)
  ) {
    throw new AutomationApiError(
      502,
      'Automation API returned an invalid response.',
      'InvalidAutomationResponse',
    )
  }

  return {
    executions: response.executions,
    nextCursor: response.nextCursor,
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

/**
 * Returns whether a history entry has the execution fields used by the Web client.
 *
 * @param value - Unknown entry from the execution history response.
 * @returns Whether the entry is an automation execution.
 */
function isAutomationExecution(value: unknown): value is AutomationExecution {
  return isRecord(value) &&
    value.schemaVersion === AUTOMATION_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.ruleId === 'string' &&
    isNonnegativeSafeInteger(value.ruleVersion) &&
    typeof value.triggerEventId === 'string' &&
    automationExecutionStatuses.some((status) => status === value.status) &&
    isNonnegativeSafeInteger(value.attempts) &&
    Array.isArray(value.actions) &&
    value.actions.every(isAutomationActionExecution) &&
    typeof value.startedAt === 'string' &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.nextRetryAt) &&
    isOptionalString(value.errorCode) &&
    isOptionalString(value.errorMessage) &&
    typeof value.retryable === 'boolean'
}

/**
 * Returns whether an execution entry has the per-action result fields used by the Web client.
 *
 * @param value - Unknown action result from an execution entry.
 * @returns Whether the value is an automation action execution.
 */
function isAutomationActionExecution(value: unknown): value is AutomationActionExecution {
  return isRecord(value) &&
    isNonnegativeSafeInteger(value.actionIndex) &&
    typeof value.actionId === 'string' &&
    automationActionExecutionStatuses.some((status) => status === value.status) &&
    isNonnegativeSafeInteger(value.attempts) &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.errorCode) &&
    isOptionalString(value.errorMessage)
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
