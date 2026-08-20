import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { FilesApiError } from './errors'

/**
 * preview または download 用の短命 URL です。
 */
export type FileVersionAccess = {
  /**
   * object storage の短命 read URL です。
   */
  url: string
  /**
   * URL の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt: string
}

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * file version の preview/download URL を取得します。
 */
export function getFileVersionAccess(
  teamId: string,
  issueId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  disposition: 'attachment' | 'inline',
  context?: MutationRequestContext,
) {
  const query = new URLSearchParams({ disposition })

  return requestJson<FileVersionAccess>(
    `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/access?${query}`,
    accessToken,
    { headers: context ? createMutationHeaders(context) : undefined },
  )
}

/**
 * Team scope の Project file version 用 preview/download URL を取得します。
 */
export function getProjectFileVersionAccess(
  teamId: string,
  projectId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  disposition: 'attachment' | 'inline',
  context?: MutationRequestContext,
) {
  const query = new URLSearchParams({ disposition })

  return requestJson<FileVersionAccess>(
    `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/access?${query}`,
    accessToken,
    { headers: context ? createMutationHeaders(context) : undefined },
  )
}

function createWorkItemPath(teamId: string, issueId: string) {
  return `${filesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`
}

function createWorkItemFilesPath(teamId: string, issueId: string) {
  return `${createWorkItemPath(teamId, issueId)}/files`
}

function createProjectFilesPath(teamId: string, projectId: string) {
  return `${filesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/files`
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
    const message = typeof data === 'object' && data !== null &&
      'message' in data && typeof data.message === 'string'
      ? data.message
      : 'files.error.request'
    const code = typeof data === 'object' && data !== null &&
      'code' in data && typeof data.code === 'string'
      ? data.code
      : undefined

    throw new FilesApiError(response.status, message, code)
  }

  return data as TResponse
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
