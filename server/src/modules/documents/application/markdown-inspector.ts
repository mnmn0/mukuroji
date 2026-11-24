import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type {
  MarkdownHtmlFinder,
  MarkdownInspector,
  MarkdownOpenBlock,
  MarkdownSourceRange,
} from '../domain/document-content'

/** Plain paragraph placed after a text to see whether the text absorbs it. */
const MARKDOWN_BOUNDARY_PROBE = 'mukuroji-export-boundary'

/** A fence marker at the start of a fenced code block's source. */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u

/**
 * Finds the source ranges of HTML blocks and inline HTML in Markdown, parsed with the CommonMark
 * and GFM grammar (micromark) that the web app renders paragraphs with.
 *
 * @param text - Markdown text.
 * @returns Non-overlapping ranges in source order.
 * @throws TypeError when the parser returns an HTML node without a source position.
 */
const findMarkdownHtmlRanges: MarkdownHtmlFinder = (text) => {
  const ranges: MarkdownSourceRange[] = []
  const pending: unknown[] = [parseMarkdown(text)]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!isMarkdownNodeRecord(node)) continue
    if (node.type === 'html') {
      const start = readMarkdownOffset(node.position, 'start')
      const end = readMarkdownOffset(node.position, 'end')
      if (start === undefined || end === undefined || end < start) {
        throw new TypeError('A Markdown HTML node has no source position.')
      }
      ranges.push({ start, end })
      continue
    }
    if (Array.isArray(node.children)) pending.push(...node.children)
  }
  return ranges.sort((left, right) => left.start - right.start)
}

/**
 * Tells whether a parsed Markdown node is an object with a type.
 *
 * @param value - Parsed node.
 * @returns Whether the value is a node record.
 */
function isMarkdownNodeRecord(
  value: unknown,
): value is { type: unknown; position?: unknown; children?: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * Reads one source offset from a parsed node's position.
 *
 * @param position - The node's `position`.
 * @param edge - Which end of the node.
 * @returns The offset, or `undefined` when the parser gave none.
 */
function readMarkdownOffset(position: unknown, edge: 'start' | 'end'): number | undefined {
  if (typeof position !== 'object' || position === null || !(edge in position)) return undefined
  const point: unknown = Reflect.get(position, edge)
  if (typeof point !== 'object' || point === null || !('offset' in point)) return undefined
  const offset: unknown = point.offset
  return typeof offset === 'number' && Number.isSafeInteger(offset) ? offset : undefined
}

/**
 * Tells whether Markdown would absorb a plain paragraph that follows it after a blank line, as
 * an export joins blocks. A fenced code block left open at the end is reported with the fence
 * line that closes it.
 *
 * @param text - Markdown text.
 * @returns `undefined` when the following paragraph stays its own block; otherwise what is open.
 */
function findMarkdownOpenBlock(text: string): MarkdownOpenBlock | undefined {
  const probeOffset = text.length + 2
  const root = parseMarkdown(`${text}\n\n${MARKDOWN_BOUNDARY_PROBE}`)
  const children = isMarkdownNodeRecord(root) && Array.isArray(root.children) ? root.children : []
  const last: unknown = children.at(-1)
  if (!isMarkdownNodeRecord(last)) return {}
  const start = readMarkdownOffset(last.position, 'start')
  if (last.type === 'paragraph' && start === probeOffset) return undefined
  if (last.type === 'code' && start !== undefined) {
    const marker = FENCE_OPENER.exec(text.slice(start))?.[1]
    if (marker !== undefined) return { closingFence: marker }
  }
  return {}
}

/**
 * Parses Markdown with the CommonMark and GFM grammar the web app renders paragraphs with.
 *
 * @param text - Markdown text.
 * @returns The parsed tree.
 */
function parseMarkdown(text: string): unknown {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/** Reads export Markdown with the grammar the web app renders it with. */
export const markdownInspector: MarkdownInspector = {
  findHtml: findMarkdownHtmlRanges,
  findOpenBlock: findMarkdownOpenBlock,
}
