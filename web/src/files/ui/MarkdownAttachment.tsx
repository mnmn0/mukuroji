import { useEffect, useState, type ReactNode } from 'react'
import type { FileAttachment } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { FileArtifactsController } from '../mutations/useFileArtifacts'
import { findInlineImageVersion } from '../model/markdownAttachments'

/**
 * What a Markdown body needs to resolve `attachment:` references for the current viewer.
 */
export type MarkdownAttachmentContext = {
  /**
   * File controller of the Work Item whose description or comments are shown.
   */
  controller: FileArtifactsController
  /**
   * Translator for placeholder and button labels.
   */
  t: (key: MessageKey) => string
}

/**
 * Props for {@link MarkdownAttachmentImage}.
 */
export type MarkdownAttachmentImageProps = {
  /**
   * Referenced file id from the Markdown body.
   */
  fileId: string
  /**
   * Alt text written in the Markdown body.
   */
  alt?: string
  /**
   * Viewer's file controller and translator, or nothing where files cannot be read.
   */
  attachments?: MarkdownAttachmentContext
}

/**
 * Draws an attached image only when the viewer can read the file and its scan is clean.
 * Any other state shows a short placeholder, so a pending, blocked, or hidden file never
 * reaches an `<img>` element.
 *
 * @param props - File id, alt text, and the viewer's attachment context.
 * @returns The image, or a placeholder naming why it is not shown.
 */
export function MarkdownAttachmentImage({ alt, attachments, fileId }: MarkdownAttachmentImageProps) {
  const file = attachments?.controller.files.find((candidate) => candidate.id === fileId)
  const version = file ? findInlineImageVersion(file) : undefined
  const versionKey = file && version ? `${file.id}:${version.id}` : undefined
  const [access, setAccess] = useState<{ key: string; url?: string; failed: boolean }>()
  const getVersionAccess = attachments?.controller.getVersionAccess

  useEffect(() => {
    if (!file || !version || !versionKey || !getVersionAccess) return
    let cancelled = false
    void getVersionAccess(file, version, 'inline').then((result) => {
      if (!cancelled) setAccess({ failed: !result, key: versionKey, url: result?.url })
    }, () => {
      if (!cancelled) setAccess({ failed: true, key: versionKey })
    })
    return () => {
      cancelled = true
    }
    // The file object changes on every list refresh; the version key is what decides a new URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey, getVersionAccess])

  const t = attachments?.t
  const currentAccess = access?.key === versionKey ? access : undefined
  if (!t) return <AttachmentPlaceholder>{alt || fileId}</AttachmentPlaceholder>
  if (!file || file.deletedAt || !file.capabilities.canDownload) {
    return <AttachmentPlaceholder>{t('files.markdown.unavailable')}</AttachmentPlaceholder>
  }
  if (!version) {
    return <AttachmentPlaceholder>{describeHiddenVersion(file, t)}</AttachmentPlaceholder>
  }
  if (!currentAccess) {
    return <AttachmentPlaceholder>{t('files.preview.loading')}</AttachmentPlaceholder>
  }
  if (currentAccess.failed || !currentAccess.url) {
    return <AttachmentPlaceholder>{t('files.markdown.unavailable')}</AttachmentPlaceholder>
  }
  return (
    <img
      alt={alt || file.name}
      className="my-2 block h-auto max-h-[32rem] max-w-full rounded-md border border-[var(--workbench-border)]"
      data-testid={`markdown-attachment-image-${file.id}`}
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={currentAccess.url}
    />
  )
}

/**
 * Props for {@link MarkdownAttachmentLink}.
 */
export type MarkdownAttachmentLinkProps = {
  /**
   * Referenced file id from the Markdown body.
   */
  fileId: string
  /**
   * Link text written in the Markdown body.
   */
  children?: ReactNode
  /**
   * Viewer's file controller and translator, or nothing where files cannot be read.
   */
  attachments?: MarkdownAttachmentContext
}

/**
 * Shows a non-image attachment as a download button that asks for a fresh short-lived URL.
 * The button is disabled until the file is readable and its current version is clean.
 *
 * @param props - File id, link text, and the viewer's attachment context.
 * @returns The download button.
 */
export function MarkdownAttachmentLink({ attachments, children, fileId }: MarkdownAttachmentLinkProps) {
  const file = attachments?.controller.files.find((candidate) => candidate.id === fileId)
  const version = file?.currentVersion
  const canDownload = Boolean(
    attachments && file && version && !file.deletedAt &&
    file.capabilities.canDownload && version.scanStatus === 'available',
  )
  const status = attachments && file && version && !canDownload && !file.deletedAt && file.capabilities.canDownload
    ? describeHiddenVersion(file, attachments.t)
    : undefined

  return (
    <button
      className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-1.5 py-0.5 align-baseline text-[0.8rem] font-semibold text-[var(--workbench-text)] disabled:opacity-60"
      data-testid={`markdown-attachment-link-${fileId}`}
      disabled={!canDownload}
      onClick={() => {
        if (!attachments || !file || !version || !canDownload) return
        void attachments.controller.getVersionAccess(file, version, 'attachment').then((access) => {
          if (!access) return
          const link = document.createElement('a')
          link.href = access.url
          link.download = version.fileName
          link.rel = 'noopener noreferrer'
          link.click()
        })
      }}
      title={status}
      type="button"
    >
      <span aria-hidden="true">↓</span>
      <span className="truncate">{children}</span>
      {status ? <span className="text-[var(--workbench-muted)]">({status})</span> : null}
    </button>
  )
}

/**
 * Names the scan state that keeps the current version out of the body.
 *
 * @param file - Readable file whose current version is not shown.
 * @param t - Translator.
 * @returns A short status label.
 */
function describeHiddenVersion(file: FileAttachment, t: (key: MessageKey) => string): string {
  switch (file.currentVersion.scanStatus) {
    case 'pending':
    case 'scanning':
      return t('files.scan.processing')
    case 'blocked':
      return t('files.scan.blocked')
    case 'failed':
      return t('files.scan.failed')
    default:
      return t('files.markdown.unavailable')
  }
}

/**
 * Inline box that stands in for an attachment the body does not show.
 *
 * @param props - Placeholder text.
 * @returns The placeholder element.
 */
function AttachmentPlaceholder({ children }: { children: ReactNode }) {
  return (
    <span
      className="my-1 inline-flex max-w-full items-center gap-1.5 rounded border border-dashed border-[var(--workbench-border)] px-2 py-1 text-xs font-semibold text-[var(--workbench-muted)]"
      data-testid="markdown-attachment-placeholder"
      role="img"
      aria-label={typeof children === 'string' ? children : undefined}
    >
      <span aria-hidden="true">▢</span>
      {children}
    </span>
  )
}
