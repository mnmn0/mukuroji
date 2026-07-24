import type {
  CreateImportDryRunInput,
  CreateImportJobInput,
  CursorPage,
  ImportDryRunReport,
  ImportJob,
  WorkItem,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DeveloperPlatformApiError } from './errors'

/**
 * Compatibility alias for an import field mapping.
 */
export type DeveloperImportFieldMapping =
  ImportJob['mapping'][number]

/**
 * Compatibility alias for the import source format.
 */
export type DeveloperImportFormat = ImportJob['format']

/**
 * Compatibility alias for the import dry-run contract.
 */
export type DryRunDeveloperImportInput = CreateImportDryRunInput

/**
 * Compatibility export format accepted by the Work Item export endpoint.
 */
export type DeveloperExportFormat = 'csv' | 'json'

/**
 * Work Item export response と download metadata です。
 */
export type DeveloperExportFile = {
  /**
   * Browser download に渡す response body です。
   */
  blob: Blob
  /**
   * UI が export 日と format から生成した file 名です。
   */
  fileName: string
}

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

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
  input: DryRunDeveloperImportInput,
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
 * Work Item export file を Authorization header 付きで取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param format - CSV または JSON の export format です。
 * @returns Browser download に使う Blob と file 名です。
 */
export async function exportDeveloperWorkItems(
  accessToken: string,
  format: DeveloperExportFormat,
) {
  const workItems: WorkItem[] = []
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

  return createDeveloperExportFile(format, workItems)
}

async function requestDeveloperExportPage(
  accessToken: string,
  query: URLSearchParams,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJson<CursorPage<WorkItem>>(
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

function createDeveloperExportFile(
  format: DeveloperExportFormat,
  workItems: readonly WorkItem[],
): DeveloperExportFile {
  const suffix = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    const body = `${JSON.stringify({
      apiVersion: '2026-07-01',
      workItems: workItems.map(toExportWorkItem),
    }, null, 2)}\n`

    return {
      blob: new Blob([body], {
        type: 'application/json; charset=utf-8',
      }),
      fileName: `mukuroji-work-items-${suffix}.json`,
    }
  }

  const customFieldIds = [...new Set(
    workItems.flatMap((workItem) =>
      Object.keys(workItem.customFieldValues)
    ),
  )].sort()
  const headers = [
    'id',
    'teamId',
    'title',
    'description',
    'assignedProjectId',
    'assigneeUserId',
    'workflowStatusId',
    'statusCategory',
    'dueDate',
    'priority',
    'revision',
    'createdAt',
    'updatedAt',
    ...customFieldIds.map(
      (fieldId) => `customFieldValues.${fieldId}`,
    ),
  ]
  const lines = [
    headers.map(escapeDeveloperExportCsvValue).join(','),
    ...workItems.map((workItem) =>
      headers.map((header) => {
        const value = header.startsWith('customFieldValues.')
          ? workItem.customFieldValues[
              header.slice('customFieldValues.'.length)
            ]
          : (workItem as unknown as Record<string, unknown>)[header]

        return escapeDeveloperExportCsvValue(
          serializeDeveloperExportCell(value),
        )
      }).join(',')
    ),
  ]

  return {
    blob: new Blob(
      [`\ufeff${lines.join('\r\n')}\r\n`],
      { type: 'text/csv; charset=utf-8' },
    ),
    fileName: `mukuroji-work-items-${suffix}.csv`,
  }
}

function toExportWorkItem(workItem: WorkItem) {
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    title: workItem.title,
    ...(workItem.description
      ? { description: workItem.description }
      : {}),
    ...(workItem.assignedProjectId
      ? { assignedProjectId: workItem.assignedProjectId }
      : {}),
    assigneeUserId: workItem.assigneeUserId,
    workflowStatusId: workItem.workflowStatusId,
    statusCategory: workItem.statusCategory,
    customFieldValues: structuredClone(workItem.customFieldValues),
    relationIds: [...workItem.relationIds],
    dueDate: workItem.dueDate,
    priority: workItem.priority,
    revision: workItem.revision,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  }
}

function serializeDeveloperExportCell(value: unknown) {
  if (value === undefined || value === null) {
    return ''
  }
  if (
    Array.isArray(value) ||
    (typeof value === 'object' && value !== null)
  ) {
    return JSON.stringify(value)
  }

  return String(value)
}

function escapeDeveloperExportCsvValue(value: string) {
  const safeValue = /^[\t\r\n ]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value

  return /[",\r\n]/u.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue
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
