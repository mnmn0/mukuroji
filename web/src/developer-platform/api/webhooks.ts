import type { ApiScope, WebhookDelivery, WebhookSubscription } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DeveloperPlatformApiError } from './errors'

/**
 * Webhook subscription が購読できる event type です。
 */
export type DeveloperWebhookEventType = WebhookSubscription['eventTypes'][number]

/**
 * Webhook subscription 作成 API の入力です。
 */
export type CreateDeveloperWebhookInput = {
  /**
   * 管理画面で識別する subscription 名です。
   */
  name: string
  /**
   * Signed webhook を送信する HTTPS URL です。
   */
  url: string
  /**
   * 作成者が現在参照でき、event payload の配信を許可する Team ID 一覧です。
   */
  teamIds: string[]
  /**
   * 配信対象 event type 一覧です。
   */
  eventTypes: DeveloperWebhookEventType[]
  /**
   * Webhook payload に許可する scope 一覧です。
   */
  scopes: ApiScope[]
}

/**
 * Webhook subscription 作成または signing secret rotation 直後の response です。
 */
export type IssuedWebhookSigningSecret = {
  /**
   * 発行後の webhook subscription metadata です。
   */
  subscription: WebhookSubscription
  /**
   * 一度だけ表示可能な webhook signing secret です。
   */
  signingSecret: string
}

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Signed webhook subscription を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - 配信先 URL、event、scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Subscription と一度だけ表示できる signing secret です。
 */
export function createDeveloperWebhook(
  accessToken: string,
  input: CreateDeveloperWebhookInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedWebhookSigningSecret>(
    '/developer/webhook-subscriptions',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Webhook signing secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param subscriptionId - Rotation 対象 subscription ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time signing secret と subscription metadata です。
 */
export function rotateDeveloperWebhook(
  accessToken: string,
  subscriptionId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedWebhookSigningSecret>(
    `/developer/webhook-subscriptions/${encodeURIComponent(subscriptionId)}/rotate-secret`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * Webhook subscription を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param subscriptionId - Revoke 対象 subscription ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の subscription metadata です。
 */
export function revokeDeveloperWebhook(
  accessToken: string,
  subscriptionId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `/developer/webhook-subscriptions/${encodeURIComponent(subscriptionId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
    true,
  )
}

/**
 * 失敗した webhook delivery を replay します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param deliveryId - Replay 対象 delivery ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Replay request 後の delivery metadata です。
 */
export function replayDeveloperWebhookDelivery(
  accessToken: string,
  deliveryId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WebhookDelivery>(
    `/developer/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

function createJsonMutation(
  method: 'PATCH' | 'POST',
  body: unknown,
  mutationContext: MutationRequestContext,
): RequestInit {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
  }
}

async function requestJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  allowEmptyResponse = false,
) {
  const response = await fetch(`${developerApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(
    response,
    allowEmptyResponse || !response.ok,
    response.ok,
  )

  if (!response.ok) {
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
      isRetryableDeveloperApiResponse(response.status, errorData),
      readRetryAfterSeconds(response),
    )
  }

  return data as T
}

function readRetryAfterSeconds(response: Response) {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return undefined
  if (/^\d+$/u.test(value)) {
    return Math.min(Number(value), 300)
  }
  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.min(Math.max(Math.ceil((retryAt - Date.now()) / 1_000), 0), 300)
}

function readErrorResponse(
  value: unknown,
): {
  code?: string
  detail?: string
  message?: string
  retryable?: boolean
} | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function isRetryableDeveloperApiResponse(
  status: number,
  error: ReturnType<typeof readErrorResponse>,
) {
  return error?.retryable === true || status === 429 || status >= 500
}

async function readJson<T>(
  response: Response,
  allowEmpty: boolean,
  rejectMalformed: boolean,
): Promise<T> {
  const text = await response.text()

  if (!text) {
    if (allowEmpty) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned an empty JSON response.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    if (!rejectMalformed) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned invalid JSON.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
