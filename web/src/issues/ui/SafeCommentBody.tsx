import { useMemo, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { markdownAttachmentScheme, readMarkdownAttachmentFileId } from '../../files/model/markdownAttachments'
import {
  MarkdownAttachmentImage,
  MarkdownAttachmentLink,
  type MarkdownAttachmentContext,
} from '../../files/ui/MarkdownAttachment'
import {
  MarkdownAttachmentReactContext,
  useMarkdownAttachmentContext,
} from '../../files/ui/markdownAttachmentContext'
import { SafeMarkdown } from '../../shared/ui/SafeMarkdown'
import { remarkWorkItemKeyLinks } from '../model/workItemKeyLinks'
import { useWorkItemKeyPrefixes } from '../queries/workItemKeyPrefixesContext'

/**
 * SafeCommentBody の props です。
 */
export type SafeCommentBodyProps = {
  /**
   * HTML としては実行せず、Markdown として解釈する本文です。
   */
  bodyMarkdown: string
  /**
   * 追加する class name です。
   */
  className?: string
  /**
   * File controller used to show `attachment:` images and links to this viewer.
   * Defaults to the nearest `MarkdownAttachmentReactContext`; without either, attachment
   * references are shown as placeholders.
   */
  attachments?: MarkdownAttachmentContext
  /**
   * How raw HTML in the body is shown: `skip` drops it (the default for comments), and `escape`
   * shows it as literal text so prose such as `<div>` stays readable. Neither runs it as HTML.
   */
  rawHtml?: 'skip' | 'escape'
}

/**
 * URL schemes kept for links and images besides the defaults. Attachment URLs never reach the
 * DOM as-is: the `a` and `img` components below replace them.
 */
const attachmentUrlSchemes = [markdownAttachmentScheme]

/**
 * Draws a Markdown link: an `attachment:` link becomes a download button resolved from the
 * nearest attachment context, and any other link opens in a new tab.
 *
 * @param props - Link target and text from the Markdown body.
 * @returns The link element.
 */
function CommentMarkdownLink({ children, href }: { children?: ReactNode; href?: string }) {
  const attachments = useMarkdownAttachmentContext()
  const fileId = readMarkdownAttachmentFileId(href)
  if (fileId) {
    return <MarkdownAttachmentLink attachments={attachments} fileId={fileId}>{children}</MarkdownAttachmentLink>
  }
  return href ? (
    <a href={href} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  ) : <span>{children}</span>
}

/**
 * Draws a Markdown image only for an `attachment:` reference; external images are dropped.
 *
 * @param props - Image source and alt text from the Markdown body.
 * @returns The attachment image, or nothing.
 */
function CommentMarkdownImage({ alt, src }: { alt?: string; src?: unknown }) {
  const attachments = useMarkdownAttachmentContext()
  const fileId = readMarkdownAttachmentFileId(typeof src === 'string' ? src : undefined)
  return fileId ? <MarkdownAttachmentImage alt={alt} attachments={attachments} fileId={fileId} /> : null
}

/**
 * Renderers shared by every comment body. They stay the same element types across renders.
 */
const commentMarkdownComponents: Components = {
  a: ({ children, href }) => <CommentMarkdownLink href={href}>{children}</CommentMarkdownLink>,
  img: ({ alt, src }) => <CommentMarkdownImage alt={alt} src={src} />,
}

/**
 * raw HTML を無効にし、GFM と sanitize を通した comment 本文を描画します。
 * 本文中の Work Item key（`PT-12`）は、Workspace に存在する prefix のものだけ key のページへの link にします。
 * `attachment:<fileId>` の画像と link は、閲覧者が読める scan 済みの添付だけを表示します。
 * 外部 URL の画像は読み込みません。
 */
export function SafeCommentBody({
  attachments,
  bodyMarkdown,
  className = '',
  rawHtml = 'skip',
}: SafeCommentBodyProps) {
  const prefixes = useWorkItemKeyPrefixes()
  const inheritedAttachments = useMarkdownAttachmentContext()
  const attachmentController = (attachments ?? inheritedAttachments)?.controller
  const attachmentTranslator = (attachments ?? inheritedAttachments)?.t
  // The renderers are fixed at module scope and read this context, so a new controller only
  // re-renders attachment components instead of remounting them and losing their retry state.
  const resolvedAttachments = useMemo<MarkdownAttachmentContext | undefined>(
    () => attachmentController && attachmentTranslator
      ? { controller: attachmentController, t: attachmentTranslator }
      : undefined,
    [attachmentController, attachmentTranslator],
  )

  return (
    <MarkdownAttachmentReactContext.Provider value={resolvedAttachments}>
      <SafeMarkdown
        acceptExtraUrl={isMarkdownAttachmentUrl}
        bodyMarkdown={bodyMarkdown}
        className={className}
        components={commentMarkdownComponents}
        extraUrlSchemes={attachmentUrlSchemes}
        rawHtml={rawHtml}
        remarkPlugins={[[remarkWorkItemKeyLinks, { prefixes }]]}
      />
    </MarkdownAttachmentReactContext.Provider>
  )
}

/**
 * Accepts a well-formed `attachment:` reference as a link or image URL.
 *
 * @param value - URL written in the Markdown body.
 * @returns Whether the URL names an attachment.
 */
function isMarkdownAttachmentUrl(value: string) {
  return readMarkdownAttachmentFileId(value) !== undefined
}
