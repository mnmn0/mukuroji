import { useCallback, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createMarkdownAttachmentReference,
  findMarkdownAttachmentRejection,
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
   * Message for the last refused or failed file, cleared by the next attempt.
   */
  errorKey?: MessageKey
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
  const [errorKey, setErrorKey] = useState<MessageKey>()
  const canAttach = Boolean(controller?.scope?.kind === 'work-item' && controller.capabilities.canUpload) && !disabled

  const attachFiles = useCallback(async (files: readonly File[]) => {
    if (!controller || !canAttach || files.length === 0 || isUploading) return
    setErrorKey(undefined)
    const accepted: File[] = []
    let rejection: MessageKey | undefined
    for (const file of files) {
      const reason = findMarkdownAttachmentRejection(file)
      if (reason === 'tooLarge') rejection = 'files.markdown.tooLarge'
      else if (reason === 'unsupportedType') rejection ??= 'files.error.unsupportedType'
      else accepted.push(file)
    }
    if (rejection) setErrorKey(rejection)
    if (accepted.length === 0) return

    setIsUploading(true)
    onUploadingChange?.(true)
    try {
      const succeeded = await controller.uploadFiles(accepted, {
        onUploaded: (file, version) => onInsert(createMarkdownAttachmentReference(file, version)),
      })
      if (!succeeded) setErrorKey('files.error.upload')
    } finally {
      setIsUploading(false)
      onUploadingChange?.(false)
    }
  }, [canAttach, controller, isUploading, onInsert, onUploadingChange])

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

  return { attachFiles, canAttach, errorKey, handleDragOver, handleDrop, handlePaste, isUploading }
}
