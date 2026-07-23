import type { ConnectorAuthorizationOutput, ConnectorInstallation } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type {
  ConnectDeveloperConnectorInput,
  DeveloperConnectorProvider,
} from '../model/connectors'
import { DeveloperPlatformApiError } from './errors'

export type {
  ConnectDeveloperConnectorInput,
  DeveloperConnectorProvider,
} from '../model/connectors'

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Provider connector を新規接続します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param provider - 接続対象 provider identifier です。
 * @param input - Installation 名と許可 scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Provider authorization URL と短命 state です。
 */
export function connectDeveloperConnector(
  accessToken: string,
  provider: DeveloperConnectorProvider,
  input: ConnectDeveloperConnectorInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorAuthorizationOutput>(
    '/developer/connector-installations',
    accessToken,
    createJsonMutation(
      'POST',
      {
        ...input,
        provider,
        returnUrl: input.returnUrl ?? '/',
      },
      mutationContext,
    ),
  )
}

/**
 * Connector の再認証 flow を開始します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param installationId - 再認証対象 installation ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Provider authorization URL と短命 state です。
 */
export function reauthorizeDeveloperConnector(
  accessToken: string,
  installationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorAuthorizationOutput>(
    `/developer/connector-installations/${encodeURIComponent(installationId)}/reauthorize`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * Connector installation を切断します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param installationId - 切断対象 installation ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 切断状態を反映した connector installation です。
 */
export function disconnectDeveloperConnector(
  accessToken: string,
  installationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorInstallation>(
    `/developer/connector-installations/${encodeURIComponent(installationId)}`,
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
