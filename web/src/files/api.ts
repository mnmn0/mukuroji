import type {
  AnnotationAnchor,
  ApprovalRequest,
  FileAnnotation,
  FileAttachment,
  FileVersion,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

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

/**
 * file annotation 一覧レスポンスです。
 */
export type FileAnnotationsResponse = {
  /**
   * 選択 version に付いた位置 annotation 一覧です。
   */
  annotations: FileAnnotation[]
}

/**
 * file annotation 作成入力です。
 */
export type CreateFileAnnotationInput = {
  /**
   * preview 内の正規化済み位置情報です。
   */
  anchor: AnnotationAnchor
  /**
   * annotation の Markdown 本文です。
   */
  bodyMarkdown: string
}

/**
 * approval request 作成入力です。
 */
export type CreateApprovalRequestInput = {
  /**
   * approval 対象 file ID です。
   */
  fileId: string
  /**
   * approval 対象 version ID です。
   */
  versionId: string
  /**
   * reviewer の Workspace member key 一覧です。
   */
  reviewerMemberKeys: string[]
  /**
   * 判断期限の ISO 8601 timestamp です。
   */
  dueAt: string
  /**
   * 全 reviewer 承認後に適用する Work Item transition です。
   */
  completionTransition?: string
}

/**
 * reviewer が選択できる approval decision です。
 */
export type ApprovalDecision = 'approve' | 'reject' | 'request-changes'

/**
 * approval decision 作成入力です。
 */
export type CreateApprovalDecisionInput = {
  /**
   * reviewer の判断です。
   */
  decision: ApprovalDecision
  /**
   * 判断理由として残す任意の本文です。
   */
  comment?: string
  /**
   * 読み込み時点の approval revision です。
   */
  expectedRevision: number
}

/**
 * Approval request を cancel する入力です。
 */
export type CancelApprovalRequestInput = {
  /**
   * 読み込み時点の approval revision です。
   */
  expectedRevision: number
}

/**
 * file API エラーです。
 */
export class FilesApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
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

/**
 * file version の位置 annotation を取得します。
 */
export function getFileAnnotations(
  teamId: string,
  issueId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
) {
  return requestJson<FileAnnotationsResponse>(
    createFileAnnotationsPath(teamId, issueId, fileId, versionId),
    accessToken,
  )
}

/**
 * Team scope の Project file version に付いた位置 annotation を取得します。
 */
export function getProjectFileAnnotations(
  teamId: string,
  projectId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
) {
  return requestJson<FileAnnotationsResponse>(
    createProjectFileAnnotationsPath(teamId, projectId, fileId, versionId),
    accessToken,
  )
}

/**
 * file version の preview 上へ位置 annotation を作成します。
 */
export function createFileAnnotation(
  teamId: string,
  issueId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  input: CreateFileAnnotationInput,
  context: MutationRequestContext,
) {
  return requestJson<{ annotation: FileAnnotation }>(
    createFileAnnotationsPath(teamId, issueId, fileId, versionId),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * Team scope の Project file preview 上へ位置 annotation を作成します。
 */
export function createProjectFileAnnotation(
  teamId: string,
  projectId: string,
  fileId: string,
  versionId: string,
  accessToken: string,
  input: CreateFileAnnotationInput,
  context: MutationRequestContext,
) {
  return requestJson<{ annotation: FileAnnotation }>(
    createProjectFileAnnotationsPath(teamId, projectId, fileId, versionId),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * Work Item の file version に approval request を作成します。
 */
export function createApprovalRequest(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: CreateApprovalRequestInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * reviewer の approval decision を保存します。
 */
export function createApprovalDecision(
  teamId: string,
  issueId: string,
  approvalId: string,
  accessToken: string,
  input: CreateApprovalDecisionInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals/${encodeURIComponent(approvalId)}/decisions`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * Requester または cancel 権限を持つ user が approval request を取り消します。
 */
export function cancelApprovalRequest(
  teamId: string,
  issueId: string,
  approvalId: string,
  accessToken: string,
  input: CancelApprovalRequestInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals/${encodeURIComponent(approvalId)}/cancel`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * Work Item から file を soft delete します。
 */
export function deleteWorkItemFile(
  teamId: string,
  issueId: string,
  fileId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'DELETE',
    },
  )
}

/**
 * Team scope の Project から file を soft delete します。
 */
export function deleteProjectFile(
  teamId: string,
  projectId: string,
  fileId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'DELETE',
    },
  )
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

function createFileAnnotationsPath(
  teamId: string,
  issueId: string,
  fileId: string,
  versionId: string,
) {
  return `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/annotations`
}

function createProjectFileAnnotationsPath(
  teamId: string,
  projectId: string,
  fileId: string,
  versionId: string,
) {
  return `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/annotations`
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
