import type { ApprovalRequest, FileAttachment } from '@mukuroji/contracts'
import { FilesApiError } from './errors'

/**
 * File API が返す scope 全体の操作権限です。
 */
export type FileCollectionCapabilities = {
  /**
   * 新しい file を upload できるかどうかです。
   */
  canUpload: boolean
  /**
   * approval request を作成できるかどうかです。
   */
  canRequestApproval: boolean
  /**
   * 認証済み Workspace guest への read access を付与できるかどうかです。
   */
  canGrantGuestAccess?: boolean
}

/**
 * Work Item または Project の file/approval 一覧レスポンスです。
 */
export type FileCollection = {
  /**
   * scope に添付された file 一覧です。
   */
  files: FileAttachment[]
  /**
   * scope に紐づく approval request 一覧です。
   */
  approvals: ApprovalRequest[]
  /**
   * scope 全体で許可された操作です。
   */
  capabilities: FileCollectionCapabilities
}

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item に添付された file と approval を取得します。
 */
export function getWorkItemFiles(teamId: string, issueId: string, accessToken: string) {
  return requestJson<FileCollection>(createWorkItemFilesPath(teamId, issueId), accessToken)
}

/**
 * Team scope の Project file と approval を取得します。
 */
export function getProjectFiles(teamId: string, projectId: string, accessToken: string) {
  return requestJson<FileCollection>(createProjectFilesPath(teamId, projectId), accessToken)
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
