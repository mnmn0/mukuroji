import { useId, useRef } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { MarkdownAttachmentUpload } from '../mutations/useMarkdownAttachmentUpload'

/**
 * Props for {@link MarkdownAttachmentControls}.
 */
export type MarkdownAttachmentControlsProps = {
  /**
   * Upload state and actions from `useMarkdownAttachmentUpload`.
   */
  upload: MarkdownAttachmentUpload
  /**
   * Translator for the button and status labels.
   */
  t: (key: MessageKey) => string
}

/**
 * File picker button and upload status shown under a Markdown editor.
 * Renders nothing when the viewer cannot add files to the Work Item.
 *
 * @param props - Upload state and translator.
 * @returns The controls, or nothing.
 */
export function MarkdownAttachmentControls({ t, upload }: MarkdownAttachmentControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  if (!upload.canAttach) return null

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.68rem] font-medium text-[var(--workbench-muted)]">
      <button
        aria-controls={inputId}
        className="min-h-7 rounded-md px-2 font-semibold text-[var(--workbench-primary-text)] hover:bg-tone-e5f7f4 disabled:opacity-50"
        disabled={upload.isUploading}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        + {t('files.markdown.attach')}
      </button>
      <input
        aria-label={t('files.markdown.attach')}
        disabled={upload.isUploading}
        hidden
        id={inputId}
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void upload.attachFiles(files)
        }}
        ref={inputRef}
        type="file"
      />
      <span aria-live="polite" role="status">
        {upload.isUploading
          ? t('files.markdown.uploading')
          : upload.errorKey
            ? <span className="font-semibold text-fg-red-700">{t(upload.errorKey)}</span>
            : t('files.markdown.hint')}
      </span>
    </div>
  )
}
