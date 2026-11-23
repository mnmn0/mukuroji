import { useCallback, useRef, useState } from 'react'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { useMarkdownAttachmentUpload } from '../../files/mutations/useMarkdownAttachmentUpload'
import { MarkdownAttachmentControls } from '../../files/ui/MarkdownAttachmentControls'
import type { MessageKey } from '../../shared/i18n/i18n'
import { SafeCommentBody } from './SafeCommentBody'

/**
 * Props for {@link MarkdownDescriptionField}.
 */
export type MarkdownDescriptionFieldProps = {
  /**
   * Visible field label.
   */
  label: string
  /**
   * Form control name submitted with the Work Item editor form.
   */
  name: string
  /**
   * Id of the editor form the textarea belongs to.
   */
  form: string
  /**
   * Saved description text.
   */
  defaultValue?: string
  /**
   * Shows only the rendered description, without the edit toggle.
   */
  readOnly?: boolean
  /**
   * Disables editing and uploads while the surrounding form is busy.
   */
  disabled?: boolean
  /**
   * File controller of the Work Item, used for attachments in the description.
   */
  artifacts?: FileArtifactsController
  /**
   * Translator.
   */
  t: (key: MessageKey) => string
}

/**
 * Work Item description shown as sanitized Markdown, with a write mode that accepts pasted
 * or dropped images and files.
 * The textarea stays in the form while the rendered view is shown, so saving the form always
 * sends the current text.
 *
 * @param props - Field label, form binding, saved text, and the Work Item file controller.
 * @returns The description field.
 */
export function MarkdownDescriptionField({
  artifacts,
  defaultValue = '',
  disabled = false,
  form,
  label,
  name,
  readOnly = false,
  t,
}: MarkdownDescriptionFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isWriting, setIsWriting] = useState(() => !readOnly && !defaultValue.trim())
  const [previewValue, setPreviewValue] = useState(defaultValue)
  const showsWriteMode = isWriting && !readOnly

  const insertAtCursor = useCallback((markdown: string) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? start
    const before = textarea.value.slice(0, start)
    const prefix = before && !before.endsWith('\n') ? '\n' : ''
    textarea.setRangeText(`${prefix}${markdown}\n`, start, end, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    setPreviewValue(textarea.value)
  }, [])
  const upload = useMarkdownAttachmentUpload({
    controller: artifacts,
    disabled: disabled || readOnly,
    onInsert: insertAtCursor,
  })
  const attachments = artifacts ? { controller: artifacts, t } : undefined

  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${form}:${name}`}>
          {label}
        </label>
        {readOnly ? null : (
          <button
            aria-pressed={showsWriteMode}
            className="min-h-7 rounded px-2 text-[0.68rem] font-semibold text-[var(--workbench-muted)] transition hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)] disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              if (showsWriteMode) setPreviewValue(textareaRef.current?.value ?? previewValue)
              setIsWriting(!showsWriteMode)
              if (!showsWriteMode) requestAnimationFrame(() => textareaRef.current?.focus())
            }}
            type="button"
          >
            {t(showsWriteMode ? 'collaboration.composer.preview' : 'files.markdown.edit')}
          </button>
        )}
      </div>
      <textarea
        className="workbench-input w-full min-w-0 resize-y px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)] min-h-40"
        defaultValue={defaultValue}
        form={form}
        hidden={!showsWriteMode}
        id={`${form}:${name}`}
        name={name}
        onDragOver={upload.handleDragOver}
        onDrop={upload.handleDrop}
        onPaste={upload.handlePaste}
        readOnly={readOnly}
        ref={textareaRef}
        rows={10}
      />
      {showsWriteMode ? (
        <MarkdownAttachmentControls t={t} upload={upload} />
      ) : (
        <div
          className="min-h-12 min-w-0 rounded-md border border-[var(--workbench-border)] bg-surface px-3 py-2"
          data-testid={`markdown-description-${name}`}
          onDoubleClick={() => {
            if (!readOnly && !disabled) {
              setIsWriting(true)
              requestAnimationFrame(() => textareaRef.current?.focus())
            }
          }}
        >
          {previewValue.trim() ? (
            <SafeCommentBody attachments={attachments} bodyMarkdown={previewValue} />
          ) : (
            <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('files.markdown.empty')}</p>
          )}
        </div>
      )}
    </div>
  )
}
