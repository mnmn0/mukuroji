/**
 * Links to other pages in stored Document text. The page view shows them as links in table cells
 * and checklist items, the Markdown export writes them as Markdown links, and the Markdown import
 * checks against them which text a native block shows as written.
 */

/**
 * Piece of stored text: plain text, or a link to another page that a
 * Markdown import wrote as `[label](/documents/<id>)`.
 */
export type DocumentTextSegment =
  | {
      /** Discriminator of plain text. */
      type: 'text'
      /** Text shown as written. */
      text: string
    }
  | {
      /** Discriminator of a page link. */
      type: 'page-link'
      /** Link label. */
      label: string
      /** Application path of the linked page. */
      href: string
    }

/**
 * Link to a page in stored text. The label and ID are bounded and exclude
 * brackets and parentheses, so the match cannot backtrack.
 */
const PAGE_LINK = /\[([^[\]\n]{1,500})\]\((\/documents\/[A-Za-z0-9%._~-]{1,300})\)/gu

/**
 * Splits stored text into plain text and links to other pages, so a page
 * view can make links written by a Markdown import clickable, and the Markdown export and
 * import treat them alike. Only links to
 * `/documents/<id>` are recognized; every other link stays plain text.
 *
 * @param text - Stored paragraph, cell, or checklist item text.
 * @returns Segments in order; a single text segment when there is no link.
 */
export function splitDocumentPageLinks(text: string): DocumentTextSegment[] {
  const segments: DocumentTextSegment[] = []
  let last = 0
  for (const match of text.matchAll(PAGE_LINK)) {
    const [whole, label, href] = match
    if (label === undefined || href === undefined) continue
    if (match.index > last) segments.push({ type: 'text', text: text.slice(last, match.index) })
    segments.push({ type: 'page-link', label, href })
    last = match.index + whole.length
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ type: 'text', text: text.slice(last) })
  }
  return segments
}
