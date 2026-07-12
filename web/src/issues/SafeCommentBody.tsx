import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

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
}

/**
 * raw HTML を無効にし、GFM と sanitize を通した comment 本文を描画します。
 */
export function SafeCommentBody({ bodyMarkdown, className = '' }: SafeCommentBodyProps) {
  return (
    <div
      className={`min-w-0 break-words text-sm font-medium leading-6 text-[var(--workbench-text)]
        [&_a]:font-semibold [&_a]:text-[#16766f] [&_a]:underline [&_a]:decoration-[#99d7cf] [&_a]:underline-offset-2
        [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[#99d7cf] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--workbench-muted)]
        [&_code]:rounded [&_code]:bg-[#eef2f5] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.82rem] [&_code]:text-[#26333f]
        [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-[var(--workbench-primary)]
        [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2
        [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--workbench-border)] [&_pre]:bg-[#f7f9fa] [&_pre]:p-3
        [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5
        [&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-0 ${className}`}
    >
      <Markdown
        components={{
          a: ({ children, href }) => href ? (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {children}
            </a>
          ) : <span>{children}</span>,
          img: () => null,
        }}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={sanitizeCommentUrl}
      >
        {bodyMarkdown}
      </Markdown>
    </div>
  )
}

function sanitizeCommentUrl(value: string) {
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
