import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalRequest,
  FileAnnotation,
  FileAttachment,
  FileTypeRejection,
  FileVersion,
} from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { uploadFilesInOrder } from './fileUploadBatch'
import {
  cancelApprovalRequest,
  completeFileVersionUpload,
  completeProjectFileVersionUpload,
  createApprovalDecision,
  createApprovalRequest,
  createCommentFileUpload,
  createFileAnnotation,
  createFileVersionUpload,
  createProjectFileAnnotation,
  createProjectFileUpload,
  createProjectFileVersionUpload,
  createWorkItemFileUpload,
  deleteFileAnnotation,
  deleteProjectFile,
  deleteWorkItemFile,
  getFileAnnotations,
  getFileVersionAccess,
  getProjectFileAnnotations,
  getProjectFileVersionAccess,
  putPresignedFile,
  setFileAnnotationResolution,
  type CreateApprovalDecisionInput,
  type CreateApprovalRequestInput,
  type CreateFileAnnotationInput,
  type FileCollectionCapabilities,
  type FileVersionAccess,
  FilesApiError,
} from '../api'
import type { FileResourceScope } from '../model/fileScope'
import { useFileArtifactCollection } from '../queries/useFileArtifactCollection'

const emptyCapabilities: FileCollectionCapabilities = {
  canGrantGuestAccess: false,
  canRequestApproval: false,
  canUpload: false,
}
const emptyFiles: FileAttachment[] = []
const emptyApprovals: ApprovalRequest[] = []

/**
 * File controller が参照する resource scope です。
 */
export type FileArtifactScope = FileResourceScope

/**
 * useFileArtifacts の入力です。
 */
export type UseFileArtifactsOptions = {
  /**
   * API 認証に使う access token です。
   */
  accessToken?: string
  /**
   * file を読み書きする resource scope です。
   */
  scope?: FileArtifactScope
  /**
   * Called after the file and approval collection is reloaded, so views derived from the same
   * files (such as the Project deliverables list) can reload too. Its failure is ignored.
   */
  onRefreshed?: () => Promise<void> | void
}

/**
 * file upload mutation の補助入力です。
 */
export type FileUploadOptions = {
  /**
   * 保存済み comment へ添付する場合の comment ID です。
   */
  commentId?: string
  /**
   * 既存 file の新 version として upload する場合の file です。
   */
  replaceFile?: FileAttachment
  /**
   * 認証済み guest にも file read を許可するかどうかです。
   */
  guestAccess?: boolean
  /**
   * Called once per file after its upload is completed, with the stored file and version.
   */
  onUploaded?: (file: FileAttachment, version: FileVersion) => void
  /**
   * Called when the server refuses a file because of its type, with the reason and the types the
   * Workspace accepts. When given, the refused file is skipped and the remaining files still
   * upload; without it, the first refusal stops the batch.
   */
  onFileTypeRejected?: (rejection: FileTypeRejection) => void
}

/**
 * File/preview/annotation/approval UI が利用する controller です。
 */
export type FileArtifactsController = {
  /**
   * 現在の resource scope です。
   */
  scope?: FileArtifactScope
  /**
   * Identifies the signed-in session the controller reads as. Caches of per-viewer results,
   * such as short-lived file URLs, include it so a different account never reuses them.
   */
  viewerCacheKey?: string
  /**
   * scope に添付された file 一覧です。
   */
  files: FileAttachment[]
  /**
   * Work Item の approval request 一覧です。
   */
  approvals: ApprovalRequest[]
  /**
   * scope 全体で許可された操作です。
   */
  capabilities: FileCollectionCapabilities
  /**
   * 最初の file 一覧を読み込み中かどうかです。
   */
  isLoading: boolean
  /**
   * file mutation を実行中かどうかです。
   */
  isMutating: boolean
  /**
   * 一覧取得に失敗したかどうかです。
   */
  hasLoadError: boolean
  /**
   * 直近 mutation の HTTP status code です。
   */
  mutationErrorStatus?: number
  /**
   * 直近 mutation の安定 error code です。
   */
  mutationErrorCode?: string
  /**
   * 直近の upload が形式で拒否されたときの理由と、Workspace が受け付ける形式です。
   */
  mutationFileTypeRejection?: FileTypeRejection
  /**
   * Shell が認証 policy error を一元処理するための raw load/mutation errors です。
   */
  sessionErrors?: readonly unknown[]
  /**
   * 新規添付または version 差し替えを直接 object storage へ送信します。
   */
  uploadFiles: (files: File[], options?: FileUploadOptions) => Promise<boolean>
  /**
   * file version の短命 preview/download URL を取得します。
   */
  getVersionAccess: (
    file: FileAttachment,
    version: FileVersion,
    disposition: 'attachment' | 'inline',
  ) => Promise<FileVersionAccess | undefined>
  /**
   * file version の位置 annotation を取得します。
   */
  getAnnotations: (file: FileAttachment, version: FileVersion) => Promise<FileAnnotation[]>
  /**
   * file version に位置 annotation を作成します。
   */
  createAnnotation: (
    file: FileAttachment,
    version: FileVersion,
    input: CreateFileAnnotationInput,
  ) => Promise<FileAnnotation | undefined>
  /**
   * Annotation を解決済みにするか、未解決へ戻します。失敗時は `undefined` を返します。
   */
  setAnnotationResolution: (
    file: FileAttachment,
    version: FileVersion,
    annotation: FileAnnotation,
    resolved: boolean,
  ) => Promise<FileAnnotation | undefined>
  /**
   * 自分が書いた annotation を削除します。
   */
  deleteAnnotation: (
    file: FileAttachment,
    version: FileVersion,
    annotation: FileAnnotation,
  ) => Promise<boolean>
  /**
   * file version に approval request を作成します。
   */
  requestApproval: (input: CreateApprovalRequestInput) => Promise<boolean>
  /**
   * reviewer の approval decision を保存します。
   */
  decideApproval: (
    approval: ApprovalRequest,
    input: CreateApprovalDecisionInput,
  ) => Promise<boolean>
  /**
   * Pending approval request を optimistic concurrency 付きで取り消します。
   */
  cancelApproval: (approval: ApprovalRequest) => Promise<boolean>
  /**
   * file を soft delete します。
   */
  deleteFile: (file: FileAttachment) => Promise<boolean>
  /**
   * file/approval 一覧を再取得します。
   */
  refresh: () => Promise<void>
}

/**
 * Resource scope の file と approval を取得し、直接 upload と review mutation をまとめます。
 */
export function useFileArtifacts({
  accessToken,
  onRefreshed,
  scope,
}: UseFileArtifactsOptions): FileArtifactsController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const scopeKey = scope ? JSON.stringify(scope) : ''
  const operationToken = useMemo(
    () => Symbol(`file-artifact-operation:${scopeKey}:${accessToken ? 'authenticated' : 'anonymous'}`),
    [accessToken, scopeKey],
  )
  const currentOperationTokenRef = useRef(operationToken)

  useEffect(() => {
    currentOperationTokenRef.current = operationToken
  }, [operationToken])
  const [mutationError, setMutationError] = useState<{
    code?: string
    status?: number
    fileTypeRejection?: FileTypeRejection
    token: symbol
  }>()
  const [mutatingToken, setMutatingToken] = useState<symbol>()
  const isMutating = mutatingToken === operationToken
  const currentMutationError = mutationError?.token === operationToken
    ? mutationError
    : undefined
  const isConfigured = Boolean(accessToken && scope)
  const {
    data,
    error,
    isLoading,
    mutate,
  } = useFileArtifactCollection(accessToken, scope, isConfigured)

  const refresh = useCallback(async () => {
    await mutate()
    // A derived view reloads on its own; its failure never fails this file mutation.
    void Promise.resolve(onRefreshed?.()).catch(() => undefined)
  }, [mutate, onRefreshed])

  const runMutation = useCallback(async <T,>(
    requestToken: symbol,
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof mutationRunner.run<T>>[2],
  ) => {
    if (currentOperationTokenRef.current === requestToken) {
      setMutationError(undefined)
    }

    try {
      return await mutationRunner.run(operationKey, fingerprint, request)
    } catch (caughtError) {
      if (currentOperationTokenRef.current === requestToken) {
        setMutationError(caughtError instanceof FilesApiError
          ? {
              code: caughtError.code,
              status: caughtError.status,
              fileTypeRejection: caughtError.fileTypeRejection,
              token: requestToken,
            }
          : { status: 500, token: requestToken })
      }
      throw caughtError
    }
  }, [mutationRunner])

  const uploadFiles = useCallback(async (
    selectedFiles: File[],
    options: FileUploadOptions = {},
  ) => {
    if (!accessToken || !scope || selectedFiles.length === 0 || isMutating) {
      return false
    }

    setMutatingToken(operationToken)
    setMutationError(undefined)
    let hasCreatedUploadSession = false

    try {
      await uploadFilesInOrder(selectedFiles, async (selectedFile) => {
        const input = {
          contentType: selectedFile.type || 'application/octet-stream',
          fileName: selectedFile.name,
          guestAccess: options.guestAccess,
          sizeBytes: selectedFile.size,
        }
        const fingerprint = JSON.stringify([scope, options.commentId, options.replaceFile?.id, input])
        const session = await runMutation(
          operationToken,
          `file:upload-session:${scopeKey}:${options.commentId ?? options.replaceFile?.id ?? 'new'}`,
          fingerprint,
          (context) => {
            if (scope.kind === 'project') {
              return options.replaceFile
                ? createProjectFileVersionUpload(
                    scope.teamId,
                    scope.projectId,
                    options.replaceFile.id,
                    accessToken,
                    input,
                    context,
                  )
                : createProjectFileUpload(scope.teamId, scope.projectId, accessToken, input, context)
            }

            if (options.replaceFile) {
              return createFileVersionUpload(
                scope.teamId,
                scope.issueId,
                options.replaceFile.id,
                accessToken,
                input,
                context,
              )
            }

            return options.commentId
              ? createCommentFileUpload(
                  scope.teamId,
                  scope.issueId,
                  options.commentId,
                  accessToken,
                  input,
                  context,
                )
              : createWorkItemFileUpload(scope.teamId, scope.issueId, accessToken, input, context)
          },
        )
        hasCreatedUploadSession = true

        await putPresignedFile(session.upload, selectedFile)
        const completed = await runMutation(
          operationToken,
          `file:upload-complete:${scopeKey}:${session.file.id}:${session.version.id}`,
          JSON.stringify([session.file.id, session.version.id]),
          (context) => scope.kind === 'project'
            ? completeProjectFileVersionUpload(
                scope.teamId,
                scope.projectId,
                session.file.id,
                session.version.id,
                accessToken,
                context,
              )
            : completeFileVersionUpload(
                scope.teamId,
                scope.issueId,
                session.file.id,
                session.version.id,
                accessToken,
                context,
              ),
        )
        options.onUploaded?.(completed.file, completed.version)
      }, options.onFileTypeRejected)

      return true
    } catch (uploadError) {
      console.error('File upload failed:', uploadError)
      if (currentOperationTokenRef.current === operationToken) {
        setMutationError(uploadError instanceof FilesApiError
          ? {
              code: uploadError.code,
              status: uploadError.status,
              fileTypeRejection: uploadError.fileTypeRejection,
              token: operationToken,
            }
          : { status: 500, token: operationToken })
      }
      return false
    } finally {
      if (hasCreatedUploadSession) {
        await refresh().catch((refreshError) => {
          console.error('File refresh failed:', refreshError)
        })
      }
      setMutatingToken((current) => current === operationToken ? undefined : current)
    }
  }, [accessToken, isMutating, operationToken, refresh, runMutation, scope, scopeKey])

  const getVersionAccess = useCallback(async (
    file: FileAttachment,
    version: FileVersion,
    disposition: 'attachment' | 'inline',
  ) => {
    if (!accessToken || !scope || version.scanStatus !== 'available') {
      return undefined
    }

    try {
      return await runMutation(
        operationToken,
        `file:access:${scopeKey}:${file.id}:${version.id}:${disposition}`,
        JSON.stringify([file.id, version.id, disposition]),
        (context) => scope.kind === 'work-item'
          ? getFileVersionAccess(
              scope.teamId,
              scope.issueId,
              file.id,
              version.id,
              accessToken,
              disposition,
              context,
            )
          : getProjectFileVersionAccess(
              scope.teamId,
              scope.projectId,
              file.id,
              version.id,
              accessToken,
              disposition,
              context,
            ),
      )
    } catch (accessError) {
      if (currentOperationTokenRef.current === operationToken) {
        setMutationError(accessError instanceof FilesApiError
          ? { code: accessError.code, status: accessError.status, token: operationToken }
          : { status: 500, token: operationToken })
      }
      return undefined
    }
  }, [accessToken, operationToken, runMutation, scope, scopeKey])

  const getAnnotations = useCallback(async (file: FileAttachment, version: FileVersion) => {
    if (!accessToken || !scope) {
      return []
    }

    const response = scope.kind === 'work-item'
      ? await getFileAnnotations(scope.teamId, scope.issueId, file.id, version.id, accessToken)
      : await getProjectFileAnnotations(scope.teamId, scope.projectId, file.id, version.id, accessToken)

    return response.annotations
  }, [accessToken, scope])

  const addAnnotation = useCallback(async (
    file: FileAttachment,
    version: FileVersion,
    input: CreateFileAnnotationInput,
  ) => {
    if (!accessToken || !scope) {
      return undefined
    }

    try {
      const response = await runMutation(
        operationToken,
        `file:annotation:create:${scopeKey}:${file.id}:${version.id}`,
        JSON.stringify(input),
        (context) => scope.kind === 'work-item'
          ? createFileAnnotation(
              scope.teamId,
              scope.issueId,
              file.id,
              version.id,
              accessToken,
              input,
              context,
            )
          : createProjectFileAnnotation(
              scope.teamId,
              scope.projectId,
              file.id,
              version.id,
              accessToken,
              input,
              context,
            ),
      )
      // The new annotation is unresolved, so the file and approval counts change.
      await refresh().catch(() => undefined)
      return response.annotation
    } catch (annotationError) {
      console.error('File annotation failed:', annotationError)
      return undefined
    }
  }, [accessToken, operationToken, refresh, runMutation, scope, scopeKey])

  const changeAnnotationResolution = useCallback(async (
    file: FileAttachment,
    version: FileVersion,
    annotation: FileAnnotation,
    resolved: boolean,
  ) => {
    if (!accessToken || !scope) {
      return undefined
    }

    try {
      const response = await runMutation(
        operationToken,
        `file:annotation:resolution:${scopeKey}:${file.id}:${version.id}:${annotation.id}`,
        JSON.stringify([annotation.id, resolved]),
        (context) => setFileAnnotationResolution(
          scope,
          file.id,
          version.id,
          annotation.id,
          resolved,
          accessToken,
          context,
        ),
      )
      await refresh().catch(() => undefined)
      return response.annotation
    } catch (resolutionError) {
      console.error('File annotation resolution failed:', resolutionError)
      return undefined
    }
  }, [accessToken, operationToken, refresh, runMutation, scope, scopeKey])

  const removeAnnotation = useCallback(async (
    file: FileAttachment,
    version: FileVersion,
    annotation: FileAnnotation,
  ) => {
    if (!accessToken || !scope) {
      return false
    }

    try {
      await runMutation(
        operationToken,
        `file:annotation:delete:${scopeKey}:${file.id}:${version.id}:${annotation.id}`,
        annotation.id,
        (context) => deleteFileAnnotation(scope, file.id, version.id, annotation.id, accessToken, context),
      )
      await refresh().catch(() => undefined)
      return true
    } catch (deleteError) {
      if (isAnnotationAlreadyGone(deleteError)) {
        // The annotation no longer exists, whether an earlier attempt deleted it or someone
        // else did, so the delete reached its goal and the list must drop it.
        await refresh().catch(() => undefined)
        return true
      }
      console.error('File annotation delete failed:', deleteError)
      return false
    }
  }, [accessToken, operationToken, refresh, runMutation, scope, scopeKey])

  const requestApproval = useCallback(async (input: CreateApprovalRequestInput) => {
    if (!accessToken || !scope || isMutating) {
      return false
    }

    setMutatingToken(operationToken)

    try {
      await runMutation(
        operationToken,
        `approval:create:${scopeKey}:${input.fileId}:${input.versionId}`,
        JSON.stringify(input),
        (context) => createApprovalRequest(scope, accessToken, input, context),
      )
      await refresh()
      return true
    } catch (approvalError) {
      console.error('Approval request failed:', approvalError)
      return false
    } finally {
      setMutatingToken((current) => current === operationToken ? undefined : current)
    }
  }, [accessToken, isMutating, operationToken, refresh, runMutation, scope, scopeKey])

  const decideApproval = useCallback(async (
    approval: ApprovalRequest,
    input: CreateApprovalDecisionInput,
  ) => {
    if (!accessToken || !scope || isMutating) {
      return false
    }

    setMutatingToken(operationToken)

    try {
      await runMutation(
        operationToken,
        `approval:decision:${scopeKey}:${approval.id}`,
        JSON.stringify(input),
        (context) => createApprovalDecision(
          scope,
          approval.id,
          accessToken,
          input,
          context,
        ),
      )
      await refresh()
      return true
    } catch (decisionError) {
      console.error('Approval decision failed:', decisionError)
      if (decisionError instanceof FilesApiError && decisionError.status === 409) {
        await refresh().catch(() => undefined)
      }
      return false
    } finally {
      setMutatingToken((current) => current === operationToken ? undefined : current)
    }
  }, [accessToken, isMutating, operationToken, refresh, runMutation, scope, scopeKey])

  const cancelApproval = useCallback(async (approval: ApprovalRequest) => {
    if (!accessToken || !scope || isMutating) {
      return false
    }

    setMutatingToken(operationToken)

    try {
      await runMutation(
        operationToken,
        `approval:cancel:${scopeKey}:${approval.id}`,
        JSON.stringify([approval.id, approval.revision]),
        (context) => cancelApprovalRequest(
          scope,
          approval.id,
          accessToken,
          { expectedRevision: approval.revision },
          context,
        ),
      )
      await refresh()
      return true
    } catch (cancelError) {
      console.error('Approval cancellation failed:', cancelError)
      if (cancelError instanceof FilesApiError && cancelError.status === 409) {
        await refresh().catch(() => undefined)
      }
      return false
    } finally {
      setMutatingToken((current) => current === operationToken ? undefined : current)
    }
  }, [accessToken, isMutating, operationToken, refresh, runMutation, scope, scopeKey])

  const removeFile = useCallback(async (file: FileAttachment) => {
    if (!accessToken || !scope || isMutating) {
      return false
    }

    setMutatingToken(operationToken)

    try {
      await runMutation(
        operationToken,
        `file:delete:${scopeKey}:${file.id}`,
        file.id,
        (context) => scope.kind === 'work-item'
          ? deleteWorkItemFile(scope.teamId, scope.issueId, file.id, accessToken, context)
          : deleteProjectFile(scope.teamId, scope.projectId, file.id, accessToken, context),
      )
      await refresh()
      return true
    } catch (deleteError) {
      console.error('File delete failed:', deleteError)
      return false
    } finally {
      setMutatingToken((current) => current === operationToken ? undefined : current)
    }
  }, [accessToken, isMutating, operationToken, refresh, runMutation, scope, scopeKey])

  const files = data?.files ?? emptyFiles
  const approvals = data?.approvals ?? emptyApprovals
  const controller = useMemo<FileArtifactsController>(() => ({
    approvals,
    cancelApproval,
    capabilities: data?.capabilities ?? emptyCapabilities,
    createAnnotation: addAnnotation,
    decideApproval,
    deleteAnnotation: removeAnnotation,
    deleteFile: removeFile,
    files,
    getAnnotations,
    getVersionAccess,
    hasLoadError: Boolean(error),
    isLoading: Boolean(isConfigured && isLoading),
    isMutating,
    mutationErrorCode: currentMutationError?.code,
    mutationFileTypeRejection: currentMutationError?.fileTypeRejection,
    mutationErrorStatus: currentMutationError?.status,
    refresh,
    requestApproval,
    sessionErrors: [error, currentMutationError],
    setAnnotationResolution: changeAnnotationResolution,
    scope,
    uploadFiles,
    viewerCacheKey: accessToken,
  }), [
    accessToken,
    addAnnotation,
    approvals,
    cancelApproval,
    changeAnnotationResolution,
    data?.capabilities,
    decideApproval,
    error,
    files,
    getAnnotations,
    getVersionAccess,
    isConfigured,
    isLoading,
    isMutating,
    currentMutationError,
    refresh,
    removeAnnotation,
    removeFile,
    requestApproval,
    scope,
    uploadFiles,
  ])

  return controller
}

/**
 * Tells whether an annotation delete failed only because the annotation is already gone.
 *
 * @param error - Error thrown by the delete request.
 * @returns Whether the API answered `404 AnnotationNotFound`.
 */
function isAnnotationAlreadyGone(error: unknown): boolean {
  return error instanceof FilesApiError && error.status === 404 && error.code === 'AnnotationNotFound'
}
