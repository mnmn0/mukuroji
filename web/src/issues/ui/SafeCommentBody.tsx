import Markdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { markdownAttachmentScheme, readMarkdownAttachmentFileId } from '../../files/model/markdownAttachments'
import {
  MarkdownAttachmentImage,
  MarkdownAttachmentLink,
  type MarkdownAttachmentContext,
} from '../../files/ui/MarkdownAttachment'
import { remarkWorkItemKeyLinks } from '../model/workItemKeyLinks'

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
   * Without it, attachment references are shown as placeholders.
   */
  attachments?: MarkdownAttachmentContext
}

/**
 * The default GitHub-style sanitize schema, plus the `attachment:` scheme for links and images.
 * Attachment URLs never reach the DOM as-is: the `a` and `img` components below replace them.
 */
const commentSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), markdownAttachmentScheme],
    src: [...(defaultSchema.protocols?.src ?? []), markdownAttachmentScheme],
  },
}

/**
 * raw HTML を無効にし、GFM と sanitize を通した comment 本文を描画します。
 * 本文中の Work Item key（`PT-12`）は key のページへの link にします。
 * `attachment:<fileId>` の画像と link は、閲覧者が読める scan 済みの添付だけを表示します。
 * 外部 URL の画像は読み込みません。
 */
export function SafeCommentBody({ attachments, bodyMarkdown, className = '' }: SafeCommentBodyProps) {
  return (
    <div
      className={`min-w-0 break-words text-sm font-medium leading-6 text-[var(--workbench-text)]
        [&_a]:font-semibold [&_a]:text-fg-16766f [&_a]:underline [&_a]:decoration-fg-99d7cf [&_a]:underline-offset-2
        [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-tone-99d7cf [&_blockquote]:pl-3 [&_blockquote]:text-[var(--workbench-muted)]
        [&_code]:rounded [&_code]:bg-tone-eef2f5 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.82rem] [&_code]:text-fg-26333f
        [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-[var(--workbench-primary)]
        [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2
        [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--workbench-border)] [&_pre]:bg-tone-f7f9fa [&_pre]:p-3
        [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5
        [&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-0
        [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold
        [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-semibold [&_hr]:my-3 [&_hr]:border-[var(--workbench-border)]
        [&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse
        [&_td]:border [&_td]:border-[var(--workbench-border)] [&_td]:px-2 [&_td]:py-1
        [&_th]:border [&_th]:border-[var(--workbench-border)] [&_th]:bg-[var(--workbench-surface-muted)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold
        [&>*:first-child]:mt-0 ${className}`}
    >
      <Markdown
        components={{
          a: ({ children, href }) => {
            const fileId = readMarkdownAttachmentFileId(href)
            if (fileId) {
              return <MarkdownAttachmentLink attachments={attachments} fileId={fileId}>{children}</MarkdownAttachmentLink>
            }
            return href ? (
              <a href={href} rel="noreferrer noopener" target="_blank">
                {children}
              </a>
            ) : <span>{children}</span>
          },
          img: ({ alt, src }) => {
            const fileId = readMarkdownAttachmentFileId(typeof src === 'string' ? src : undefined)
            return fileId ? <MarkdownAttachmentImage alt={alt} attachments={attachments} fileId={fileId} /> : null
          },
        }}
        rehypePlugins={[[rehypeSanitize, commentSanitizeSchema]]}
        remarkPlugins={[remarkGfm, remarkWorkItemKeyLinks]}
        skipHtml
        urlTransform={sanitizeCommentUrl}
      >
        {bodyMarkdown}
      </Markdown>
    </div>
  )
}

/**
 * Keeps same-site paths, fragments, web and mail links, and well-formed attachment references.
 *
 * @param value - URL written in the Markdown body.
 * @returns The URL, or an empty string when it is dropped.
 */
function sanitizeCommentUrl(value: string) {
  if (readMarkdownAttachmentFileId(value)) {
    return value
  }

  if ((value.startsWith('/') && !value.startsWith('//')) || value.startsWith('#')) {
    return value
  }

  try {
    const url = new URL(value)

    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
      ? value
      : ''
  } catch {
    return ''
  }
}
