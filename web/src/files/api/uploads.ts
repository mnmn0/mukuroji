import type { FileAttachment, FileVersion } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { FilesApiError } from './errors'

/**
 * 署名付き PUT upload を作成する入力です。
 */
export type CreateFileUploadInput = {
  /**
   * ユーザーが選択した file 名です。
   */
  fileName: string
  /**
   * browser が判定した MIME type です。
   */
  contentType: string
  /**
   * upload する byte 数です。
   */
  sizeBytes: number
  /**
   * 認証済み guest にも read を許可するかどうかです。
   */
  guestAccess?: boolean
}

/**
 * 署名付き PUT upload の接続情報です。
 */
export type PresignedPutUpload = {
  /**
   * object storage の短命 upload URL です。
   */
  url: string
  /**
   * upload に使う HTTP method です。
   */
  method: 'PUT'
  /**
   * object storage へ送る allowlist 済み header です。
   */
  headers: Record<string, string>
  /**
   * URL の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt: string
  /**
   * この upload session が許可する最大 byte 数です。
   */
  maxSizeBytes: number
}

/**
 * file metadata と署名付き PUT 情報をまとめた upload session です。
 */
export type FileUploadSession = {
  /**
   * upload 後に表示する file metadata です。
   */
  file: FileAttachment
  /**
   * 今回 upload する version です。
   */
  version: FileVersion
  /**
   * object storage へ直接送信する接続情報です。
   */
  upload: PresignedPutUpload
}

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item に新しい file upload session を作成します。
 */
export function createWorkItemFileUpload(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return createUploadSession(
    `${createWorkItemFilesPath(teamId, issueId)}/uploads`,
    accessToken,
    input,
    context,
  )
}

/**
 * 保存済み comment に新しい file upload session を作成します。
 */
export function createCommentFileUpload(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return createUploadSession(
    `${createWorkItemPath(teamId, issueId)}/comments/${encodeURIComponent(commentId)}/files/uploads`,
    accessToken,
    input,
    context,
  )
}

/**
 * Team scope の Project に新しい file upload session を作成します。
 */
export function createProjectFileUpload(
  teamId: string,
  projectId: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return createUploadSession(
    `${createProjectFilesPath(teamId, projectId)}/uploads`,
    accessToken,
    input,
    context,
  )
}

/**
 * 既存 file を差し替える新 version upload session を作成します。
 */
export function createFileVersionUpload(
  teamId: string,
  issueId: string,
  fileId: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return createUploadSession(
    `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}/versions`,
    accessToken,
    input,
    context,
  )
}

/**
 * Team scope の Project file を差し替える新 version upload session を作成します。
 */
export function createProjectFileVersionUpload(
  teamId: string,
  projectId: string,
  fileId: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return createUploadSession(
    `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}/versions`,
    accessToken,
    input,
    context,
  )
}

/**
 * object storage への PUT 完了を API に通知します。
 */
export function completeFileVersionUpload(
  teamId: string,
  issueId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<{ file: FileAttachment; version: FileVersion }>(
    `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/complete`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'POST',
    },
  )
}

/**
 * Team scope の Project file version PUT 完了を API に通知します。
 */
export function completeProjectFileVersionUpload(
  teamId: string,
  projectId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<{ file: FileAttachment; version: FileVersion }>(
    `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/complete`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'POST',
    },
  )
}

/**
 * browser から object storage へ file body を直接 PUT します。
 */
export async function putPresignedFile(upload: PresignedPutUpload, file: File) {
  if (file.size > upload.maxSizeBytes) {
    throw new FilesApiError(413, 'files.error.tooLarge', 'FileTooLarge')
  }

  const response = await fetch(upload.url, {
    body: file,
    headers: upload.headers,
    method: upload.method,
  })

  if (!response.ok) {
    throw new FilesApiError(response.status, 'files.error.upload')
  }
}

function createUploadSession(
  url: string,
  accessToken: string,
  input: CreateFileUploadInput,
  context: MutationRequestContext,
) {
  return requestJson<FileUploadSession>(url, accessToken, {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(context),
    },
    method: 'POST',
  })
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
