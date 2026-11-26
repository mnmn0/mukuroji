/**
 * Whether a native block shows imported Markdown exactly as a paragraph block would render it.
 *
 * A paragraph block renders its text as Markdown, but a heading, a checklist item, a table cell,
 * and an embed title show their text as written: only a table cell and a checklist item make a
 * link to another page, `[label](/documents/<id>)`, a link. Import makes such a block only when
 * the Markdown it comes from renders to that same text, so emphasis, code spans, links to other
 * places, images, HTML, and footnotes stay in paragraph Markdown. A bare URL or e-mail address is
 * taken as its text, since the native block shows the same characters, only not as a link; the
 * export has no way to write such text without it.
 */

import { splitDocumentPageLinks } from '@mukuroji/contracts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { isMarkdownWithinParseLimits, MARKDOWN_IMPORT_PARSE_LIMITS } from '../../shared/lib/markdownParseLimits'

/** A parsed Markdown node. */
type MarkdownNode = Record<string, unknown> & {
  /** mdast node kind. */
  type: unknown
}

/** One piece of what a block shows: text, or a link to another page. */
type ShownSegment =
  | {
      /** Discriminator of text. */
      type: 'text'
      /** Text shown. */
      text: string
    }
  | {
      /** Discriminator of a page link. */
      type: 'page-link'
      /** Text of the link. */
      label: string
      /** Application path of the linked page. */
      href: string
    }

/** What a native block's text may show besides plain text. */
type NativeTextKind = {
  /** Whether a link to another page is shown as a link, as in table cells and checklist items. */
  pageLinks: boolean
  /** Whether a `<br>` stands for a line break, as the export writes one in a table cell. */
  lineBreaks: boolean
}

/** Plain text, which a heading or an embed title shows. */
const PLAIN_TEXT: NativeTextKind = { pageLinks: false, lineBreaks: false }

/** Text of a checklist item. */
const CHECKLIST_TEXT: NativeTextKind = { pageLinks: true, lineBreaks: false }

/** Text of a table cell. */
const TABLE_CELL_TEXT: NativeTextKind = { pageLinks: true, lineBreaks: true }

/**
 * Characters and sequences that can make Markdown render other than as written. Text without
 * them renders as its own characters, so it needs no parse.
 */
const MAY_RENDER_DIFFERENTLY = /[\\`*_~[\]<&@]|www\.|:\/\//iu

/** Kinds of single-line Markdown that may become a native block. */
export type NativeLineKind = 'heading' | 'task' | 'embed'

/**
 * Tells, for one file, whether a heading, a checklist item, a table, or an embed would show its
 * Markdown exactly as it renders. Lines that need a parse are parsed many at a time, since a
 * parse costs far more to start than a short line costs to read, and each line is parsed once.
 * Past a total parse length, what still needs a parse is kept in paragraph Markdown, which
 * always renders as written, so a large file cannot hold the page for long.
 */
export type NativeBlockChecker = {
  /**
   * Tells whether a line renders as the native block read from it would show it.
   *
   * @param kind - What the line would become: an ATX heading, a task item, or a paragraph of one
   *   link.
   * @param index - Line in the file.
   * @param text - Text the block would show: the heading text, the item text, or the embed title.
   * @returns Whether the block shows the line exactly.
   */
  shows(kind: NativeLineKind, index: number, text: string): boolean
  /**
   * Tells whether table lines render as a table with exactly the given header and cells; a
   * table cell shows plain text, links to other pages, and the `<br>` line breaks the export
   * writes.
   *
   * @param lines - The header row, the delimiter row, and each body row, with link targets
   *   already rewritten.
   * @param columns - Header texts the table block would show.
   * @param rows - Cell texts of each body row the table block would show.
   * @returns Whether a table block shows the lines exactly.
   */
  showsTable(lines: readonly string[], columns: readonly string[], rows: readonly (readonly string[])[]): boolean
}

/** Most lines one parse reads together. */
const LINE_BATCH_SIZE = 256

/**
 * Most characters the checks of one file parse in all, which the parser reads in about a quarter
 * of a second at worst; blocks with plain text, the usual case, need no parse.
 */
const NATIVE_CHECK_MAX_PARSED_LENGTH = 30_000

/**
 * Creates a checker for the lines of one file.
 *
 * @param lineCount - Number of lines in the file.
 * @param sourceAt - Reads a line of the file, with link targets rewritten as its block's text is.
 * @param readText - Reads the text a line of a kind would show, or `undefined` when the line is not
 *   of that kind; lines of the kind after the one asked about that need a parse are parsed with it.
 * @returns The checker.
 */
export function createNativeBlockChecker(
  lineCount: number,
  sourceAt: (index: number) => string,
  readText: (kind: NativeLineKind, line: string) => string | undefined,
): NativeBlockChecker {
  /** Characters the checks may still parse. */
  let budget = NATIVE_CHECK_MAX_PARSED_LENGTH
  /**
   * Parses Markdown within what is left of the budget.
   *
   * @param source - Markdown to parse.
   * @returns The top-level blocks, or `undefined` past the budget or the parse limits.
   */
  const parse = (source: string) => {
    if (source.length > budget) return undefined
    budget -= source.length
    return parseBlocks(source)
  }
  /** Parsed node of each line that needed a parse, by kind and line; `null` when none fits. */
  const parsed: Record<NativeLineKind, Map<number, MarkdownNode | null>> = {
    heading: new Map(),
    task: new Map(),
    embed: new Map(),
  }
  /**
   * Parses a line and the lines of the same shape after it that are not parsed yet.
   *
   * @param kind - Kind of line.
   * @param index - Line asked about.
   */
  const parseFrom = (kind: NativeLineKind, index: number) => {
    const batch = [index]
    for (let line = index + 1; line < lineCount && batch.length < LINE_BATCH_SIZE; line += 1) {
      if (parsed[kind].has(line)) continue
      const source = sourceAt(line)
      const text = readText(kind, source)
      if (text !== undefined && needsParse(kind, source, text)) batch.push(line)
    }
    parseLineBatch(kind, batch.map((line) => ({ line, source: sourceAt(line).trim() })), parsed[kind], parse)
  }
  return {
    shows(kind, index, text) {
      if (!needsParse(kind, sourceAt(index), text)) return true
      if (!parsed[kind].has(index)) parseFrom(kind, index)
      const node = parsed[kind].get(index)
      return node != null && SHOWS_LINE[kind](node, text)
    },
    showsTable(tableLines, columns, rows) {
      const source = tableLines.join('\n')
      if (!MAY_RENDER_DIFFERENTLY.test(source)) return true
      const [table, ...rest] = parse(source) ?? []
      if (table?.type !== 'table' || rest.length > 0) return false
      const parsedRows = childrenOf(table)
      if (parsedRows.length !== rows.length + 1) return false
      return [columns, ...rows].every((cells, rowIndex) => {
        const parsedCells = childrenOf(parsedRows[rowIndex] ?? { type: 'tableRow' })
        // A short row shows empty cells; cells past the header are not shown.
        return cells.every((text, column) => {
          const cell = parsedCells[column]
          return cell === undefined ? text === '' : showsSameSegments(cell, text, TABLE_CELL_TEXT)
        })
      })
    },
  }
}

/**
 * Tells whether a line needs a parse to tell whether its native block shows it exactly. A line
 * whose shown text has no character Markdown could render otherwise renders as that text, as long
 * as the rest of the line is only the block's marker: escapes in it render as the characters the
 * text holds, and a link's destination does not show.
 *
 * @param kind - Kind of the line.
 * @param source - The line.
 * @param text - Text the block would show.
 * @returns Whether the line needs a parse.
 */
function needsParse(kind: NativeLineKind, source: string, text: string): boolean {
  if (MAY_RENDER_DIFFERENTLY.test(text)) return true
  if (kind === 'heading') return MAY_RENDER_DIFFERENTLY.test(source)
  // Five or more spaces after a list marker start indented code in the item instead.
  return kind === 'task' && !SIMPLE_TASK_MARKER.test(source)
}

/** The marker of a task item whose text follows as a paragraph of the item. */
const SIMPLE_TASK_MARKER = /^ {0,3}[-*+] {1,4}\[[ xX]\][ \t]/u

/**
 * Parses single lines together, each as its own block, and keeps the node each line becomes.
 * Lines are put apart by blank lines, which no line here can join across; a batch past the parse
 * limits is split, and a single line past them gets no node.
 *
 * @param kind - Kind of the lines.
 * @param batch - The lines and their trimmed sources.
 * @param into - Where to keep each line's node.
 * @param parse - Parser, which gives no blocks past its budget or the parse limits.
 */
function parseLineBatch(
  kind: NativeLineKind,
  batch: ReadonlyArray<{ line: number; source: string }>,
  into: Map<number, MarkdownNode | null>,
  parse: (source: string) => MarkdownNode[] | undefined,
): void {
  const source = batch.map((entry) => entry.source).join('\n\n')
  const blocks = parse(source)
  if (blocks === undefined) {
    if (batch.length === 1) {
      into.set(batch[0]?.line ?? -1, null)
      return
    }
    const half = Math.ceil(batch.length / 2)
    parseLineBatch(kind, batch.slice(0, half), into, parse)
    parseLineBatch(kind, batch.slice(half), into, parse)
    return
  }
  // A task item becomes an item of a list that may hold the items of the lines around it.
  const nodes = kind === 'task' ? blocks.flatMap((block) => block.type === 'list' ? childrenOf(block) : [block]) : blocks
  /** Node of each source line, by its line in the joined source, counted from 1. */
  const byLine = new Map<number, MarkdownNode[]>()
  for (const node of nodes) {
    const line = readStartLine(node)
    if (line !== undefined) byLine.set(line, [...(byLine.get(line) ?? []), node])
  }
  batch.forEach((entry, position) => {
    const found = byLine.get(position * 2 + 1) ?? []
    into.set(entry.line, found.length === 1 ? (found[0] ?? null) : null)
  })
}

/** Checks of each kind of line against the node it parsed into and the text its block shows. */
const SHOWS_LINE: Record<NativeLineKind, (node: MarkdownNode, text: string) => boolean> = {
  /**
   * A heading shows plain text.
   *
   * @param node - Parsed block.
   * @param text - Heading text.
   * @returns Whether the heading shows the line exactly.
   */
  heading: (node, text) => node.type === 'heading' && showsSameSegments(node, text, PLAIN_TEXT),
  /**
   * A checklist item shows plain text and links to other pages.
   *
   * @param node - Parsed list item.
   * @param text - Item text.
   * @returns Whether the checklist item shows the line exactly.
   */
  task: (node, text) => {
    if (node.type !== 'listItem' || typeof node.checked !== 'boolean') return false
    const [paragraph, ...after] = childrenOf(node)
    if (paragraph === undefined) return text === ''
    return paragraph.type === 'paragraph' && after.length === 0 &&
      showsSameSegments(paragraph, text, CHECKLIST_TEXT)
  },
  /**
   * An embed shows its title as plain text; a link title, which the embed does not show, does
   * not fit.
   *
   * @param node - Parsed paragraph.
   * @param title - Embed title.
   * @returns Whether the embed shows the link's text exactly.
   */
  embed: (node, title) => {
    const [link, ...more] = node.type === 'paragraph' ? childrenOf(node) : []
    if (link?.type !== 'link' || more.length > 0 || link.title != null) return false
    const shown = readSegments(childrenOf(link), PLAIN_TEXT)
    return shown !== undefined && sameSegments(shown, [{ type: 'text', text: title }])
  },
}

/**
 * Tells whether a parsed block renders the same as a native block's text shows.
 *
 * @param node - Parsed block whose content is compared.
 * @param text - Text of the native block.
 * @param kind - What the native block's text may show besides plain text.
 * @returns Whether both show the same.
 */
function showsSameSegments(node: MarkdownNode, text: string, kind: NativeTextKind): boolean {
  const rendered = readSegments(childrenOf(node), kind)
  return rendered !== undefined && sameSegments(rendered, nativeSegments(text, kind))
}

/**
 * Reads what parsed inline content renders as, when a native block can show it.
 *
 * @param nodes - Parsed inline nodes.
 * @param kind - What the native block's text may show besides plain text.
 * @returns The segments, or `undefined` when the content renders something a native block does
 *   not show, such as emphasis or a link to another place.
 */
function readSegments(
  nodes: readonly MarkdownNode[],
  kind: NativeTextKind,
): ShownSegment[] | undefined {
  const segments: ShownSegment[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string') {
      segments.push({ type: 'text', text: node.value })
      continue
    }
    if (kind.lineBreaks && node.type === 'html' && typeof node.value === 'string' && /^<br\s*\/?>$/iu.test(node.value)) {
      segments.push({ type: 'text', text: '\n' })
      continue
    }
    if (node.type !== 'link' || typeof node.url !== 'string' || node.title != null) return undefined
    const label = readSegments(childrenOf(node), PLAIN_TEXT)
    const text = label?.map((segment) => segment.type === 'text' ? segment.text : '').join('')
    if (text === undefined) return undefined
    if (isLiteralAutolink(node, text)) {
      segments.push({ type: 'text', text })
      continue
    }
    if (!kind.pageLinks) return undefined
    segments.push({ type: 'page-link', label: text, href: node.url })
  }
  return segments
}

/**
 * Tells whether a link may be a bare URL or e-mail address, which shows its own text. A link
 * written another way, such as `<url>` or `[url](url)`, has more in its source than its text,
 * which the comparison with the native block's text then finds.
 *
 * @param node - Parsed link.
 * @param text - Text of the link.
 * @returns Whether the link's destination is its text as a bare URL or address makes it.
 */
function isLiteralAutolink(node: MarkdownNode, text: string): boolean {
  return node.url === text || node.url === `http://${text}` || node.url === `mailto:${text}`
}

/**
 * Splits a native block's text into what it shows.
 *
 * @param text - Stored text.
 * @param kind - What the native block's text may show besides plain text.
 * @returns The segments.
 */
function nativeSegments(text: string, kind: NativeTextKind): ShownSegment[] {
  return kind.pageLinks ? splitDocumentPageLinks(text) : [{ type: 'text', text }]
}

/**
 * Compares two lists of segments, with adjacent text joined and the ends trimmed, as a block
 * shows them.
 *
 * @param left - Segments.
 * @param right - Other segments.
 * @returns Whether both show the same.
 */
function sameSegments(left: readonly ShownSegment[], right: readonly ShownSegment[]): boolean {
  const a = normalizeSegments(left)
  const b = normalizeSegments(right)
  return a.length === b.length && a.every((segment, index) => {
    const other = b[index]
    if (segment.type === 'text') return other?.type === 'text' && other.text === segment.text
    return other?.type === 'page-link' && other.label === segment.label && other.href === segment.href
  })
}

/**
 * Joins adjacent text segments, trims the text at both ends, and drops empty text.
 *
 * @param segments - Segments in order.
 * @returns The normalized segments.
 */
function normalizeSegments(segments: readonly ShownSegment[]): ShownSegment[] {
  const joined: ShownSegment[] = []
  for (const segment of segments) {
    const previous = joined.at(-1)
    if (segment.type === 'text' && previous?.type === 'text') {
      joined[joined.length - 1] = { type: 'text', text: previous.text + segment.text }
    } else {
      joined.push(segment)
    }
  }
  const first = joined[0]
  if (first?.type === 'text') joined[0] = { type: 'text', text: first.text.trimStart() }
  const last = joined.at(-1)
  if (last?.type === 'text') joined[joined.length - 1] = { type: 'text', text: last.text.trimEnd() }
  return joined.filter((segment) => segment.type !== 'text' || segment.text !== '')
}

/** Parser options, built once since building the GFM extensions costs more than a short parse. */
const PARSE_OPTIONS = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }

/**
 * Parses Markdown with the grammar paragraph blocks render with.
 *
 * @param source - Markdown to parse.
 * @returns The top-level blocks, or `undefined` when the source is past the import's parse limits.
 */
function parseBlocks(source: string): MarkdownNode[] | undefined {
  if (!isMarkdownWithinParseLimits(source, MARKDOWN_IMPORT_PARSE_LIMITS)) return undefined
  const root: unknown = fromMarkdown(source, PARSE_OPTIONS)
  return isMarkdownNode(root) ? childrenOf(root) : undefined
}

/**
 * Lists the children of a node.
 *
 * @param node - Parsed node.
 * @returns Its child nodes.
 */
function childrenOf(node: MarkdownNode): MarkdownNode[] {
  return Array.isArray(node.children) ? node.children.filter(isMarkdownNode) : []
}

/**
 * Tells whether a value is a parsed Markdown node.
 *
 * @param value - Value to check.
 * @returns Whether it has a node kind.
 */
function isMarkdownNode(value: unknown): value is MarkdownNode {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * Reads the line a node starts on.
 *
 * @param node - Parsed node.
 * @returns The line, counted from 1, or `undefined` without a position.
 */
function readStartLine(node: MarkdownNode): number | undefined {
  const position = node.position
  if (typeof position !== 'object' || position === null) return undefined
  const start: unknown = Reflect.get(position, 'start')
  if (typeof start !== 'object' || start === null) return undefined
  const line: unknown = Reflect.get(start, 'line')
  return typeof line === 'number' ? line : undefined
}
