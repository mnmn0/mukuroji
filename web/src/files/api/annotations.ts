import type { AnnotationAnchor, FileAnnotation } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { FileResourceScope } from '../model/fileScope'
import { FilesApiError } from './errors'
import { createFileOwnerPath } from './fileScopePath'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

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

const filesApiBaseUrl = resolveApiBaseUrl()

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
 * Resolves an annotation, or reopens a resolved one.
 *
 * @param scope - Work Item or Project that owns the file.
 * @param fileId - Annotated file.
 * @param versionId - Annotated version.
 * @param annotationId - Annotation to change.
 * @param resolved - `true` to resolve, `false` to reopen.
 * @param accessToken - Files API access token.
 * @param context - Mutation idempotency context.
 * @returns The changed annotation.
 */
export function setFileAnnotationResolution(
  scope: FileResourceScope,
  fileId: string,
  versionId: string,
  annotationId: string,
  resolved: boolean,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<{ annotation: FileAnnotation }>(
    `${createAnnotationPath(scope, fileId, versionId, annotationId)}/${resolved ? 'resolve' : 'reopen'}`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'POST',
    },
  )
}

/**
 * Deletes an annotation the current user wrote.
 *
 * @param scope - Work Item or Project that owns the file.
 * @param fileId - Annotated file.
 * @param versionId - Annotated version.
 * @param annotationId - Annotation to delete.
 * @param accessToken - Files API access token.
 * @param context - Mutation idempotency context.
 * @returns A promise that settles when the annotation is deleted.
 */
export async function deleteFileAnnotation(
  scope: FileResourceScope,
  fileId: string,
  versionId: string,
  annotationId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  await requestJson<unknown>(
    createAnnotationPath(scope, fileId, versionId, annotationId),
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'DELETE',
    },
  )
}

/**
 * Builds the API path of one annotation.
 *
 * @param scope - Work Item or Project that owns the file.
 * @param fileId - Annotated file.
 * @param versionId - Annotated version.
 * @param annotationId - Annotation ID.
 * @returns The encoded annotation path.
 */
function createAnnotationPath(
  scope: FileResourceScope,
  fileId: string,
  versionId: string,
  annotationId: string,
) {
  return `${createFileOwnerPath(scope)}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/annotations/${encodeURIComponent(annotationId)}`
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
