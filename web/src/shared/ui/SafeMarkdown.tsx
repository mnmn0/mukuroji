import { useId, useMemo, type AnchorHTMLAttributes } from 'react'
import Markdown, { type Components, type Options } from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { rehypePrefixFragmentLinks, remarkNumberFootnotes } from '../lib/markdownFragmentLinks'
import { isMarkdownWithinParseLimits, MARKDOWN_RENDER_PARSE_LIMITS } from '../lib/markdownParseLimits'
import { remarkHtmlAsText } from '../lib/markdownHtmlAsText'

/**
 * Props of {@link SafeMarkdown}.
 */
export type SafeMarkdownProps = {
  /**
   * Markdown source. Raw HTML in it is never run as HTML.
   */
  bodyMarkdown: string
  /**
   * Class names added to the wrapper.
   */
  className?: string
  /**
   * How raw HTML in the body is shown: `skip` drops it, and `escape` shows it as literal text so
   * prose such as `<div>` stays readable. Neither runs it as HTML.
   */
  rawHtml?: 'skip' | 'escape'
  /**
   * Remark plugins run after GFM, such as a domain's own link syntax.
   */
  remarkPlugins?: Exclude<Options['remarkPlugins'], null | undefined>
  /**
   * Element renderers that replace the defaults, such as links and images. By default links open
   * in a new tab and images are dropped, so an external image is never loaded.
   */
  components?: Components
  /**
   * Extra URL schemes kept by the sanitizer for links and images, such as `attachment`.
   */
  extraUrlSchemes?: readonly string[]
  /**
   * Accepts a URL with an extra scheme only when it is well formed; other URLs follow the
   * default rules.
   */
  acceptExtraUrl?: (value: string) => boolean
  /**
   * Turns on the parse limits: a body the Markdown parser could take too long on, such as one
   * dense with emphasis or brackets or deeply nested, is shown as plain text with its line breaks
   * and spaces, followed by this note, so it cannot freeze the page. Without it, every body is
   * parsed.
   */
  complexityNotice?: string
}

/**
 * Props of a Markdown link after sanitizing, as react-markdown passes them to a renderer.
 */
export type SafeMarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  /** Syntax tree node of the link, which is not an element attribute. */
  node?: unknown
  /** Marks a footnote reference link. */
  'data-footnote-ref'?: boolean | string
  /** Marks a link from a footnote back to its reference. */
  'data-footnote-backref'?: boolean | string
}

/**
 * Draws a sanitized Markdown link. A link to another place on the page, such as a footnote, keeps
 * its id and footnote attributes and stays in the page; any other link opens in a new tab without
 * referrer.
 *
 * @param props - Sanitized link attributes and text.
 * @returns The link element, or the text when the link has no target.
 */
export function SafeMarkdownLink(props: SafeMarkdownLinkProps) {
  const { children, href } = props
  if (!href) return <span>{children}</span>
  const attributes = {
    'aria-describedby': props['aria-describedby'],
    'aria-label': props['aria-label'],
    className: props.className,
    'data-footnote-backref': props['data-footnote-backref'],
    'data-footnote-ref': props['data-footnote-ref'],
    id: props.id,
    title: props.title,
  }
  return href.startsWith('#') ? (
    <a {...attributes} href={href}>{children}</a>
  ) : (
    <a {...attributes} href={href} rel="noreferrer noopener" target="_blank">{children}</a>
  )
}

/**
 * Default renderers: links open in a new tab without referrer, and images are not loaded.
 */
const defaultMarkdownComponents: Components = {
  a: SafeMarkdownLink,
  img: () => null,
}

/**
 * Renders Markdown with GFM through a sanitizer, without running raw HTML or loading unsafe
 * URLs. Domains add their own syntax and renderers through the plugin and component props.
 *
 * @param props - Markdown source and the extensions of the domain that shows it.
 * @returns The rendered Markdown.
 */
export function SafeMarkdown({
  acceptExtraUrl,
  bodyMarkdown,
  className = '',
  complexityNotice,
  components,
  extraUrlSchemes,
  rawHtml = 'skip',
  remarkPlugins = [],
}: SafeMarkdownProps) {
  // Footnote ids are named per instance, so two blocks or comments on one page that both use
  // `[^1]` each link to their own footnote. The sanitizer adds its prefix to the ids, and the
  // page links get the same prefix after it.
  const footnotePrefix = `${useId().replace(/[^A-Za-z0-9]/gu, '')}-`
  const schemeKey = extraUrlSchemes?.join(' ') ?? ''
  const sanitizeSchema = useMemo(() => {
    const schemes = schemeKey ? schemeKey.split(' ') : []
    return {
      ...defaultSchema,
      protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href ?? []), ...schemes],
        src: [...(defaultSchema.protocols?.src ?? []), ...schemes],
      },
    }
  }, [schemeKey])
  const tooComplex = useMemo(
    () => complexityNotice !== undefined && !isMarkdownWithinParseLimits(bodyMarkdown, MARKDOWN_RENDER_PARSE_LIMITS),
    [bodyMarkdown, complexityNotice],
  )

  if (tooComplex) {
    return (
      <div className={`min-w-0 break-words text-sm font-medium leading-6 text-[var(--workbench-text)] ${className}`}>
        <p className="whitespace-pre-wrap">{bodyMarkdown}</p>
        <p className="mt-1 text-xs text-[var(--workbench-muted)]" role="note">{complexityNotice}</p>
      </div>
    )
  }

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
        components={components ? { ...defaultMarkdownComponents, ...components } : defaultMarkdownComponents}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
          [rehypePrefixFragmentLinks, { localPrefix: footnotePrefix, prefix: defaultSchema.clobberPrefix ?? '' }],
        ]}
        remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
        remarkPlugins={rawHtml === 'escape'
          ? [remarkGfm, remarkNumberFootnotes, remarkHtmlAsText, ...remarkPlugins]
          : [remarkGfm, remarkNumberFootnotes, ...remarkPlugins]}
        skipHtml={rawHtml === 'skip'}
        urlTransform={(value) => sanitizeMarkdownUrl(value, acceptExtraUrl)}
      >
        {bodyMarkdown}
      </Markdown>
    </div>
  )
}

/**
 * Keeps same-site paths, fragments, web and mail links, and URLs the caller accepts.
 *
 * @param value - URL written in the Markdown body.
 * @param acceptExtraUrl - Caller check for URLs with an extra scheme.
 * @returns The URL, or an empty string when it is dropped.
 */
function sanitizeMarkdownUrl(value: string, acceptExtraUrl?: (value: string) => boolean) {
  if (acceptExtraUrl?.(value)) {
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
