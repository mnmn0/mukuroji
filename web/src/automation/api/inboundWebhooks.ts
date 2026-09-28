import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationInboundWebhookEndpoint,
  type AutomationInboundWebhookEndpointStatus,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationInboundWebhookSecretResponse,
  type CreateAutomationInboundWebhookEndpointInput,
  type UpdateAutomationInboundWebhookEndpointInput,
} from '@mukuroji/contracts'
import {
  isNonnegativeSafeInteger,
  isOptionalString,
  isRecord,
} from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AutomationApiError, resolveAutomationApiBaseUrl } from './errors'

/** Endpoint lifecycle statuses accepted from the endpoint collection response. */
const inboundWebhookEndpointStatuses: readonly AutomationInboundWebhookEndpointStatus[] = [
  'provisioning',
  'active',
  'paused',
  'revoked',
]

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)

const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

/**
 * Workspace の inbound Webhook endpoint を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Secret を含まない endpoint 一覧です。
 */
export function getAutomationInboundWebhookEndpoints(accessToken: string) {
  return requestCollection(
    `${automationApiBaseUrl}/automation/inbound-webhooks`,
    accessToken,
    'endpoints',
    isAutomationInboundWebhookEndpoint,
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
 * Returns whether a collection entry has the secret-free endpoint fields used by the Web client.
 *
 * @param value - Unknown entry from the endpoint collection response.
 * @returns Whether the entry is an inbound Webhook endpoint.
 */
function isAutomationInboundWebhookEndpoint(
  value: unknown,
): value is AutomationInboundWebhookEndpoint {
  return isRecord(value) &&
    value.schemaVersion === AUTOMATION_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.opaqueEndpointId === 'string' &&
    typeof value.name === 'string' &&
    inboundWebhookEndpointStatuses.some((status) => status === value.status) &&
    isNonnegativeSafeInteger(value.version) &&
    isNonnegativeSafeInteger(value.secretGeneration) &&
    isNonnegativeSafeInteger(value.revision) &&
    typeof value.endpointUrl === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isOptionalString(value.rotatedAt) &&
    isOptionalString(value.revokedAt)
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
