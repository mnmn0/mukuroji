import type {
  DeveloperPlatformCapabilities as ContractDeveloperPlatformCapabilities,
  DeveloperPlatformOverview,
  PersonalCredentialAdministration,
} from '@mukuroji/contracts'
import { DeveloperPlatformApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/**
 * Developer Platform の管理画面で許可された操作です。
 */
export type DeveloperPlatformCapabilities =
  ContractDeveloperPlatformCapabilities

/**
 * Developer Platform 管理画面の aggregate response と、member の自分用 key の管理情報です。
 */
export type DeveloperPlatformResources = DeveloperPlatformOverview & {
  /** 自分用 key の発行 policy と発行済み key の ID です。 */
  personalCredentials?: PersonalCredentialAdministration
}

const developerApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Developer Platform 管理画面の aggregate resource を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns Developer Platform の resource と capabilities です。
 */
export async function getDeveloperPlatformResources(
  accessToken: string,
  signal?: AbortSignal,
): Promise<DeveloperPlatformResources> {
  const [overview, personalCredentials] = await Promise.all([
    requestJson<DeveloperPlatformOverview>('/developer', accessToken, { signal }),
    requestJson<PersonalCredentialAdministration>(
      '/developer/credential-policy',
      accessToken,
      { signal },
    ),
  ])
  return { ...overview, personalCredentials }
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
