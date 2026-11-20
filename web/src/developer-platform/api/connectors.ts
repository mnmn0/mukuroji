import type {
  CompleteConnectorOAuthInput,
  CompleteConnectorOAuthOutput,
  ConnectorAuthorizationOutput,
  ConnectorInstallation,
  ConnectorProvider,
  CreateConnectorInstallationInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { ConnectDeveloperConnectorInput } from '../model/connectors'
import { DeveloperPlatformApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const developerApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

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
  provider: ConnectorProvider,
  input: ConnectDeveloperConnectorInput,
  mutationContext: MutationRequestContext,
) {
  const requestBody: CreateConnectorInstallationInput = {
    ...input,
    provider,
    returnUrl: input.returnUrl ?? '/',
  }

  return requestJson<ConnectorAuthorizationOutput>(
    '/developer/connector-installations',
    accessToken,
    createJsonMutation(
      'POST',
      requestBody,
      mutationContext,
    ),
  )
}

/**
 * Lists the connector providers configured in this environment.
 *
 * The server returns only providers that can start a new connection, so the connector list does not
 * offer providers the environment cannot connect.
 *
 * @param accessToken - Access token used for the Authorization header.
 * @returns Provider identifiers of the configured connectors.
 * @throws {DeveloperPlatformApiError} When the request fails or the response is not a catalog.
 */
export async function listAvailableDeveloperConnectorProviders(
  accessToken: string,
): Promise<string[]> {
  const data = await requestJson<unknown>('/developer/connectors', accessToken)
  if (Array.isArray(data)) {
    const providers = data.map((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'provider' in entry &&
      typeof entry.provider === 'string'
        ? entry.provider
        : undefined
    )
    if (providers.every((provider) => provider !== undefined)) {
      return providers
    }
  }
  throw new DeveloperPlatformApiError(
    200,
    'Developer Platform API returned an invalid connector catalog.',
    'InvalidDeveloperPlatformResponse',
    false,
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
 * Provider callback の値で connector OAuth flow を完了します。
 *
 * Server は flow を開始した user の access token でだけ完了させます。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Provider が返した signed state と authorization code、または取り消しです。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 結果と、結果を付けた application-relative の戻り先です。
 */
export async function completeDeveloperConnectorOAuth(
  accessToken: string,
  input: CompleteConnectorOAuthInput,
  mutationContext: MutationRequestContext,
): Promise<CompleteConnectorOAuthOutput> {
  const data = await requestJson<unknown>(
    '/developer/connector-oauth/complete',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
  return readCompleteConnectorOAuthOutput(data)
}

/**
 * Connector OAuth 完了 response を検証します。
 *
 * 戻り先はそのまま画面遷移に使うため、application-relative な path だけを受け付けます。
 *
 * @param value - Response body を JSON として読んだ値です。
 * @returns 検証済みの完了結果です。
 * @throws {DeveloperPlatformApiError} Response の形が契約と一致しない場合に投げます。
 */
function readCompleteConnectorOAuthOutput(value: unknown): CompleteConnectorOAuthOutput {
  if (typeof value === 'object' && value !== null) {
    const outcome = 'outcome' in value ? value.outcome : undefined
    const returnUrl = 'returnUrl' in value ? value.returnUrl : undefined
    if (
      (outcome === 'connected' || outcome === 'cancelled') &&
      typeof returnUrl === 'string' &&
      returnUrl.startsWith('/') &&
      !returnUrl.startsWith('//') &&
      !returnUrl.includes('\\')
    ) {
      return { outcome, returnUrl }
    }
  }
  throw new DeveloperPlatformApiError(
    200,
    'Developer Platform API returned an invalid connector OAuth completion.',
    'InvalidDeveloperPlatformResponse',
    false,
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
