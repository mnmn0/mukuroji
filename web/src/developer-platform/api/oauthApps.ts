import type { ApiScope, OAuthAppSummary } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DeveloperPlatformApiError } from './errors'

/**
 * 現在 Developer Platform で提供する OAuth app の grant type です。
 */
export type DeveloperOAuthGrantType = Extract<
  OAuthAppSummary['grantTypes'][number],
  'client_credentials'
>

/**
 * OAuth app 作成 API の入力です。
 */
export type CreateDeveloperOAuthAppInput = {
  /**
   * 管理画面と consent 画面に表示する app 名です。
   */
  name: string
  /** OAuth app が使用する grant type 一覧です。 */
  grantTypes: DeveloperOAuthGrantType[]
  /**
   * OAuth app に付与する API scope 一覧です。
   */
  scopes: ApiScope[]
  /**
   * OAuth app credential の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt?: string
}

/**
 * OAuth app 作成または rotation 直後だけ返す one-time client secret です。
 */
export type IssuedOAuthClientSecret = {
  /**
   * 発行後の OAuth app metadata です。
   */
  oauthApp: OAuthAppSummary
  /**
   * 一度だけ表示可能な OAuth client secret です。
   */
  clientSecret: string
}

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * OAuth app を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - App metadata、server-to-server grant、scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns OAuth app と一度だけ表示できる client secret です。
 */
export function createDeveloperOAuthApp(
  accessToken: string,
  input: CreateDeveloperOAuthAppInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedOAuthClientSecret>(
    '/developer/oauth-apps',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * OAuth client secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param oauthAppId - Rotation 対象 OAuth app ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time client secret と OAuth app metadata です。
 */
export function rotateDeveloperOAuthApp(
  accessToken: string,
  oauthAppId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedOAuthClientSecret>(
    `/developer/oauth-apps/${encodeURIComponent(oauthAppId)}/rotate-secret`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * OAuth app を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param oauthAppId - Revoke 対象 OAuth app ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の OAuth app metadata です。
 */
export function revokeDeveloperOAuthApp(
  accessToken: string,
  oauthAppId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<OAuthAppSummary>(
    `/developer/oauth-apps/${encodeURIComponent(oauthAppId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
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
