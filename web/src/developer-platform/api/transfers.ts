import type {
  CanonicalWorkItem,
  CreateImportDryRunInput,
  CreateImportJobInput,
  CursorPage,
  ImportDryRunReport,
  ImportJob,
  ImportJobProgress,
  ImportJobStatus,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
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
 * Reads how many rows and links an import job has processed.
 *
 * @param accessToken - Access token for the Authorization header.
 * @param jobId - Import job.
 * @returns The job's progress.
 */
export async function getDeveloperImportProgress(accessToken: string, jobId: string): Promise<ImportJobProgress> {
  return readImportJobProgress(await requestJson<unknown>(
    `/developer/imports/${encodeURIComponent(jobId)}/progress`,
    accessToken,
  ))
}

/** Import job statuses the progress endpoint can report. */
const importJobStatuses: ReadonlySet<string> = new Set<ImportJobStatus>([
  'queued',
  'validating',
  'running',
  'completed',
  'failed',
  'cancelled',
])

/**
 * Checks an import progress response and builds its typed value.
 *
 * @param value - Parsed response body.
 * @returns The job's progress.
 * @throws DeveloperPlatformApiError with `InvalidDeveloperPlatformResponse` when the body is not a progress value.
 */
function readImportJobProgress(value: unknown): ImportJobProgress {
  if (typeof value === 'object' && value !== null) {
    const jobId: unknown = Reflect.get(value, 'jobId')
    const status: unknown = Reflect.get(value, 'status')
    const totalRows = readOptionalCount(Reflect.get(value, 'totalRows'))
    const processedRows = readOptionalCount(Reflect.get(value, 'processedRows'))
    const totalLinks = readOptionalCount(Reflect.get(value, 'totalLinks'))
    const processedLinks = readOptionalCount(Reflect.get(value, 'processedLinks'))
    if (
      typeof jobId === 'string' &&
      typeof status === 'string' &&
      isImportJobStatus(status) &&
      totalRows !== null &&
      totalLinks !== null &&
      typeof processedRows === 'number' &&
      typeof processedLinks === 'number'
    ) {
      return {
        jobId,
        status,
        processedRows,
        processedLinks,
        ...(totalRows === undefined ? {} : { totalRows }),
        ...(totalLinks === undefined ? {} : { totalLinks }),
      }
    }
  }
  throw new DeveloperPlatformApiError(
    200,
    'Developer Platform API returned an invalid import progress.',
    'InvalidDeveloperPlatformResponse',
    false,
  )
}

/**
 * Reports whether a text is an import job status.
 *
 * @param value - Status text from a response.
 * @returns Whether it is one of the import job statuses.
 */
function isImportJobStatus(value: string): value is ImportJobStatus {
  return importJobStatuses.has(value)
}

/**
 * Reads an optional count from a response field.
 *
 * @param value - Field value.
 * @returns The count, `undefined` when the field is absent, or `null` when it is not a count.
 */
function readOptionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
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
  format: 'csv' | 'json',
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
        `/developer/work-item-exports?${query.toString()}`,
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
