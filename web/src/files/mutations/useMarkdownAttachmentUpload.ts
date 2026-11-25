import { useCallback, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { FileTypeRejection } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createMarkdownAttachmentReference,
  findMarkdownAttachmentRejection,
  readMarkdownAttachmentBatchMessages,
  readScopedMarkdownAttachmentMessages,
  type ScopedMarkdownAttachmentMessages,
} from '../model/markdownAttachments'
import type { FileArtifactsController } from './useFileArtifacts'

/**
 * Input for {@link useMarkdownAttachmentUpload}.
 */
export type UseMarkdownAttachmentUploadOptions = {
  /**
   * File controller of the Work Item the body belongs to. Without it, nothing is uploaded.
   */
  controller?: FileArtifactsController
  /**
   * Inserts the Markdown reference of one uploaded file at the editor's cursor.
   */
  onInsert: (markdown: string) => void
  /**
   * Blocks uploads, for example while the surrounding form is read-only.
   */
  disabled?: boolean
  /**
   * Tells the owner when uploads start and finish, so it can hold a save until every
   * reference has been inserted.
   */
  onUploadingChange?: (isUploading: boolean) => void
}

/**
 * Upload state and event handlers that a Markdown editor wires to its textarea.
 */
export type MarkdownAttachmentUpload = {
  /**
   * Whether the viewer may add files to this Work Item from the editor.
   */
  canAttach: boolean
  /**
   * Whether files from the last paste, drop, or pick are still uploading.
   */
  isUploading: boolean
  /**
   * Message for the last refused or failed file, cleared by the next attempt. It can be set
   * together with {@link fileTypeRejection} when one file of a batch was refused and another failed.
   */
  errorKey?: MessageKey
  /**
   * Why the server refused the last file because of its type, with the types the Workspace
   * accepts; cleared by the next attempt.
   */
  fileTypeRejection?: FileTypeRejection
  /**
   * Uploads files and inserts a reference for each one that completes.
   */
  attachFiles: (files: readonly File[]) => Promise<void>
  /**
   * Uploads pasted files, such as a screenshot, instead of pasting nothing.
   */
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /**
   * Accepts dropped files.
   */
  handleDragOver: (event: DragEvent<HTMLTextAreaElement>) => void
  /**
   * Uploads dropped files.
   */
  handleDrop: (event: DragEvent<HTMLTextAreaElement>) => void
}

/**
 * Refusal and failure messages of the last attempt in one file scope.
 */
type MarkdownAttachmentMessages = {
  /** Message for a refused or failed file. */
  errorKey?: MessageKey
  /** Why the server refused a file because of its type. */
  fileTypeRejection?: FileTypeRejection
}

/**
 * Connects paste, drop, and a file picker in a Markdown editor to the Work Item file upload.
 * Files go through the same presigned PUT and malware scan as the Files panel; the body only
 * stores an `attachment:<fileId>` reference, which is shown once the scan is clean.
 *
 * @param options - File controller, insert callback, and disabled state.
 * @returns Upload state and handlers for the editor.
 */
export function useMarkdownAttachmentUpload({
  controller,
  disabled = false,
  onInsert,
  onUploadingChange,
}: UseMarkdownAttachmentUploadOptions): MarkdownAttachmentUpload {
  const [isUploading, setIsUploading] = useState(false)
  const canAttach = Boolean(controller?.scope?.kind === 'work-item' && controller.capabilities.canUpload) && !disabled
  const scopeKey = controller?.scope ? JSON.stringify(controller.scope) : ''
  // Messages keep the scope of the upload that produced them, so another Work Item's
  // rejection or failure is hidden from the first render after the scope changes.
  const [storedMessages, setStoredMessages] = useState<ScopedMarkdownAttachmentMessages<MarkdownAttachmentMessages>>(
    () => ({ scopeKey, messages: {} }),
  )
  const { errorKey, fileTypeRejection } = readScopedMarkdownAttachmentMessages(storedMessages, scopeKey) ?? {}

  const attachFiles = useCallback(async (files: readonly File[]) => {
    if (!controller || !canAttach || files.length === 0 || isUploading) return
    const operationScopeKey = scopeKey
    const accepted: File[] = []
    let rejection: MessageKey | undefined
    for (const file of files) {
      // The server decides the type from the name and reports what the Workspace accepts.
      if (findMarkdownAttachmentRejection(file) === 'tooLarge') rejection = 'files.markdown.tooLarge'
      else accepted.push(file)
    }
    setStoredMessages({ scopeKey: operationScopeKey, messages: rejection ? { errorKey: rejection } : {} })
    if (accepted.length === 0) return

    setIsUploading(true)
    onUploadingChange?.(true)
    try {
      let rejected: FileTypeRejection | undefined
      const succeeded = await controller.uploadFiles(accepted, {
        onUploaded: (file, version) => onInsert(createMarkdownAttachmentReference(file, version)),
        onFileTypeRejected: (rejection) => {
          rejected = rejection
        },
      })
      const batchMessages = readMarkdownAttachmentBatchMessages(succeeded, rejected)
      // Keep messages that a later attempt in another scope has stored since this one started.
      setStoredMessages((current) => current.scopeKey === operationScopeKey
        ? { scopeKey: operationScopeKey, messages: { ...current.messages, ...batchMessages } }
        : current)
    } finally {
      setIsUploading(false)
      onUploadingChange?.(false)
    }
  }, [canAttach, controller, isUploading, onInsert, onUploadingChange, scopeKey])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0 || !canAttach) return
    event.preventDefault()
    void attachFiles(files)
  }, [attachFiles, canAttach])

  const handleDragOver = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    if (!canAttach || !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [canAttach])

  const handleDrop = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0 || !canAttach) return
    event.preventDefault()
    void attachFiles(files)
  }, [attachFiles, canAttach])

  return {
    attachFiles,
    canAttach,
    errorKey,
    fileTypeRejection,
    handleDragOver,
    handleDrop,
    handlePaste,
    isUploading,
  }
}
