import type {
  CanonicalWorkItem,
  CreateImportDryRunInput,
  CreateImportJobInput,
  CursorPage,
  ImportDryRunReport,
  ImportJob,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { DeveloperExportFormat } from '../model/transfers'
import { DeveloperPlatformApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const developerApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * CSV または JSON import を検証だけ実行します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Source content、format、field mapping です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Row error と sample を含む dry-run report です。
 */
export function dryRunDeveloperImport(
  accessToken: string,
  input: CreateImportDryRunInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ImportDryRunReport>(
    '/developer/imports/dry-run',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Error の無い dry-run input から import job を開始します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Dry-run 済みの source content と field mapping です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Queue に追加された import job です。
 */
export function createDeveloperImport(
  accessToken: string,
  input: CreateImportJobInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ImportJob>(
    '/developer/imports',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Export 対象の Work Item を全 page 読みます。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param format - CSV または JSON の export format です。
 * @returns Export 対象の Work Item です。
 */
export async function listDeveloperExportWorkItems(
  accessToken: string,
  format: DeveloperExportFormat,
) {
  const workItems: CanonicalWorkItem[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  do {
    const query = new URLSearchParams({
      format,
      limit: '100',
    })
    if (cursor) {
      query.set('cursor', cursor)
    }

    const page = await requestDeveloperExportPage(accessToken, query)
    workItems.push(...page.items)

    if (!page.hasMore) {
      cursor = undefined
      continue
    }
    if (!page.nextCursor || cursors.has(page.nextCursor)) {
      throw new DeveloperPlatformApiError(
        200,
        'Developer Platform API returned an invalid export cursor.',
        'InvalidDeveloperPlatformResponse',
      )
    }

    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  } while (cursor)

  return workItems
}

async function requestDeveloperExportPage(
  accessToken: string,
  query: URLSearchParams,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJson<CursorPage<CanonicalWorkItem>>(
        `/developer/exports?${query.toString()}`,
        accessToken,
      )
    } catch (error) {
      if (
        !(error instanceof DeveloperPlatformApiError) ||
        error.status !== 429 ||
        error.retryAfterSeconds === undefined ||
        attempt >= 5
      ) throw error
      await waitForDeveloperExportRetry(error.retryAfterSeconds)
    }
  }
}

function waitForDeveloperExportRetry(seconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1_000)
  })
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
