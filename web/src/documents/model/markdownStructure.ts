import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { isMarkdownWithinParseLimits, MARKDOWN_IMPORT_PARSE_LIMITS } from '../../shared/lib/markdownParseLimits'

/** Lines of the source a Markdown node covers, counted from 0. */
export type MarkdownLineRange = {
  /** First line of the node. */
  first: number
  /** Last line of the node. */
  last: number
}

/** A footnote definition and the lines it covers. */
export type MarkdownFootnoteDefinition = MarkdownLineRange & {
  /** Normalized footnote label. */
  identifier: string
}

/** A footnote reference and the line it is on. */
export type MarkdownFootnoteReference = {
  /** Line of the reference. */
  line: number
  /** Normalized footnote label. */
  identifier: string
}

/**
 * What a Markdown import needs to know about the whole file before it splits the file into
 * blocks, read with the CommonMark and GFM grammar the app renders paragraphs with.
 */
export type MarkdownImportStructure = {
  /**
   * The file with every link and image that used a reference definition made inline and every
   * definition removed, with the same number of lines, so the line numbers below still apply.
   * The file as given when a reference could not be rewritten safely.
   */
  text: string
  /** Lines of each top-level block of the file. */
  topLevelBlocks: MarkdownLineRange[]
  /** Footnote definitions of the file. */
  footnoteDefinitions: MarkdownFootnoteDefinition[]
  /** Footnote references of the file. */
  footnoteReferences: MarkdownFootnoteReference[]
}

/** A parsed Markdown node. */
type MarkdownNode = Record<string, unknown> & {
  /** mdast node kind. */
  type: unknown
}

/** One rewrite of a source range; rewrites inside the kept part are applied too. */
type ReferenceEdit = {
  /** Offset of the first character the edit covers. */
  start: number
  /** Offset after the last character the edit covers. */
  end: number
  /** The source from `start` up to here is kept, with the edits inside it applied. */
  keepEnd: number
  /** Text written after the kept part, in place of the rest of the range. */
  suffix: string
}

/**
 * Reads the structure of a Markdown file for import: references are made inline, since a file's
 * definitions apply to all of it but each imported block is rendered on its own, and the lines of
 * its top-level blocks and footnotes are listed so split blocks can be put back together.
 *
 * @param source - Markdown file with `\n` line endings.
 * @param resolveLink - Optional rewriter of a link target, given the destination as the parser
 *   read it, with escapes and character references decoded; it returns the new target, or
 *   `undefined` to keep the target.
 * @param maxExpansionLength - Most characters the written destinations and titles of references
 *   may add up to. Every one of them stays in the page's text, so past this the page is too large;
 *   the count stops the rewrite before a large text is built.
 * @returns The rewritten text and the structure of the file, or `'too-large'` when the references
 *   would make the page too large.
 */
export function readMarkdownImportStructure(
  source: string,
  resolveLink?: (href: string) => string | undefined,
  maxExpansionLength = Number.POSITIVE_INFINITY,
): MarkdownImportStructure | 'too-large' {
  const root = parseMarkdown(source)
  const lineStarts = [0]
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1)
  }
  /**
   * Finds the line of a source offset.
   *
   * @param offset - Source offset.
   * @returns The line number, from 0.
   */
  const lineOf = (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((lineStarts[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
  const nodes = listMarkdownNodes(root)
  const topLevelBlocks: MarkdownLineRange[] = []
  for (const child of Array.isArray(root.children) ? root.children : []) {
    const range = isMarkdownNode(child) ? readNodeRange(child) : undefined
    // The end is exclusive; a block ending at a line start belongs to the line before it.
    if (range) topLevelBlocks.push({ first: lineOf(range.start), last: lineOf(Math.max(range.start, range.end - 1)) })
  }
  const footnoteDefinitions: MarkdownFootnoteDefinition[] = []
  const footnoteReferences: MarkdownFootnoteReference[] = []
  for (const node of nodes) {
    const range = readNodeRange(node)
    if (!range || typeof node.identifier !== 'string') continue
    if (node.type === 'footnoteDefinition') {
      footnoteDefinitions.push({
        identifier: node.identifier,
        first: lineOf(range.start),
        last: lineOf(Math.max(range.start, range.end - 1)),
      })
    } else if (node.type === 'footnoteReference') {
      footnoteReferences.push({ identifier: node.identifier, line: lineOf(range.start) })
    }
  }
  const text = inlineMarkdownReferences(source, nodes, maxExpansionLength, resolveLink)
  if (text === 'too-large') return text
  return {
    text: text ?? source,
    topLevelBlocks,
    footnoteDefinitions,
    footnoteReferences,
  }
}

/**
 * Tells whether the Markdown parser reads an import file in bounded time; a file past the limits
 * is imported without being parsed as a whole.
 *
 * @param source - Markdown file with `\n` line endings.
 * @returns Whether the file is within the import's parse limits.
 */
export function isMarkdownImportWithinParseLimits(source: string): boolean {
  return isMarkdownWithinParseLimits(source, MARKDOWN_IMPORT_PARSE_LIMITS)
}

/**
 * Makes every link and image that uses a reference definition inline and removes the
 * definitions, keeping the line count: a removed definition leaves its line breaks, and a label
 * that spanned lines leaves its line breaks after the link.
 *
 * @param source - Markdown file.
 * @param nodes - Every node of its parse.
 * @param maxExpansionLength - Most characters the written destinations and titles may add up to.
 * @param resolveLink - Optional rewriter of a definition's destination, which is resolved before
 *   it is written, since the written form is wrapped in `<>` and escaped.
 * @returns The rewritten file, `undefined` when a reference's source is not as expected, or
 *   `'too-large'` when the written destinations and titles pass `maxExpansionLength`.
 */
function inlineMarkdownReferences(
  source: string,
  nodes: readonly MarkdownNode[],
  maxExpansionLength: number,
  resolveLink?: (href: string) => string | undefined,
): string | undefined | 'too-large' {
  const definitions = new Map<string, { url: string; title: string | null }>()
  for (const node of nodes) {
    // CommonMark uses the first definition of a label.
    if (node.type !== 'definition' || typeof node.identifier !== 'string' || definitions.has(node.identifier)) continue
    if (typeof node.url !== 'string') return undefined
    definitions.set(node.identifier, { url: node.url, title: typeof node.title === 'string' ? node.title : null })
  }
  if (definitions.size === 0) return source
  /** Destinations the resolver rewrote, by the destination as read; only used ones are resolved. */
  const resolved = new Map<string, string | undefined>()
  /**
   * Resolves the destination of a definition a reference uses.
   *
   * @param url - Destination as the parser read it.
   * @returns The new destination, or `undefined` when the resolver keeps it.
   */
  const resolve = (url: string) => {
    if (!resolved.has(url)) resolved.set(url, resolveLink?.(url))
    return resolved.get(url)
  }
  const edits: ReferenceEdit[] = []
  /** Characters the written destinations and titles add up to so far. */
  let expansionLength = 0
  for (const node of nodes) {
    if (node.type !== 'linkReference' && node.type !== 'imageReference' && node.type !== 'definition') continue
    const range = readNodeRange(node)
    if (!range) return undefined
    const { start, end } = range
    if (node.type === 'definition') {
      edits.push({ start, end, keepEnd: start, suffix: lineBreaksOf(source.slice(start, end)) })
      continue
    }
    const definition = typeof node.identifier === 'string' ? definitions.get(node.identifier) : undefined
    if (!definition) return undefined
    // The label is read from the source: the parser's `label` has character references decoded.
    const labelLength = referenceLabelLength(source.slice(start, end), node.referenceType)
    if (labelLength === undefined) return undefined
    const destination = renderInlineDestination(definition, resolve(definition.url))
    expansionLength += destination.length
    if (expansionLength > maxExpansionLength) return 'too-large'
    edits.push({
      start,
      end,
      keepEnd: end - labelLength,
      suffix: destination + lineBreaksOf(source.slice(end - labelLength, end)),
    })
  }
  return applyReferenceEdits(source, 0, source.length, edits.sort((left, right) => left.start - right.start))
}

/**
 * Keeps only the line breaks of a text.
 *
 * @param text - Source text.
 * @returns One `\n` for each line break in the text.
 */
function lineBreaksOf(text: string): string {
  return '\n'.repeat(text.split('\n').length - 1)
}

/**
 * Finds the length of the label part that ends a reference's source: `[label]` of a full
 * reference, `[]` of a collapsed one, and nothing of a shortcut one.
 *
 * @param source - Source of the reference.
 * @param referenceType - The parser's `referenceType`.
 * @returns The length, or `undefined` when the source does not end as the type says.
 */
function referenceLabelLength(source: string, referenceType: unknown): number | undefined {
  if (referenceType === 'shortcut') return 0
  if (referenceType === 'collapsed') return source.endsWith('[]') ? 2 : undefined
  if (referenceType !== 'full' || !source.endsWith(']')) return undefined
  // A label holds no unescaped bracket, so it opens at the last `[` that is not escaped.
  for (let index = source.length - 2; index >= 0; index -= 1) {
    if (source[index] !== '[') continue
    let backslashes = 0
    while (source[index - 1 - backslashes] === '\\') backslashes += 1
    if (backslashes % 2 === 0) return source.length - index
  }
  return undefined
}

/** A destination that reads back as written without `<>` or escapes, also in a table cell. */
const PLAIN_DESTINATION = /^[^\s()<>\\&|]+$/u

/**
 * Writes the inline destination and title of a link or image that used a definition.
 *
 * @param definition - The definition the reference used.
 * @param resolved - The destination the resolver gave it, if any. It is written without `<>`
 *   when it can be, as an inline link to a page is, so the link reads the same in text that
 *   only recognizes `[label](/documents/<id>)`, such as table cells and checklist items.
 * @returns `(<url> "title")`, escaped so it reads back as the same destination and title.
 */
function renderInlineDestination(definition: { url: string; title: string | null }, resolved?: string): string {
  const url = resolved !== undefined && PLAIN_DESTINATION.test(resolved)
    ? resolved
    : `<${(resolved ?? definition.url).replace(/[\\<>&|]/gu, '\\$&')}>`
  if (definition.title === null) return `(${url})`
  // `|` is escaped, so a link in a table cell does not split the cell.
  const title = definition.title.replace(/[\\"&|]/gu, '\\$&').replace(/\r\n?|\n/gu, ' ')
  return `(${url} "${title}")`
}

/**
 * Applies non-crossing edits to a range of text; an edit may hold other edits in its kept part.
 *
 * @param text - Source text.
 * @param from - Offset where the range starts.
 * @param to - Offset where the range ends.
 * @param edits - Edits sorted by start.
 * @returns The rewritten range, or `undefined` when two edits cross.
 */
function applyReferenceEdits(
  text: string,
  from: number,
  to: number,
  edits: readonly ReferenceEdit[],
): string | undefined {
  let output = ''
  let index = from
  for (let position = 0; position < edits.length;) {
    const edit = edits[position]
    if (edit === undefined) break
    if (edit.start < index || edit.end > to) return undefined
    let next = position + 1
    while (next < edits.length && (edits[next]?.start ?? to) < edit.end) next += 1
    const inner = edits.slice(position + 1, next)
    if (inner.some((child) => child.end > edit.keepEnd)) return undefined
    const kept = applyReferenceEdits(text, edit.start, edit.keepEnd, inner)
    if (kept === undefined) return undefined
    output += text.slice(index, edit.start) + kept + edit.suffix
    index = edit.end
    position = next
  }
  return output + text.slice(index, to)
}

/**
 * Parses Markdown with the CommonMark and GFM grammar the app renders paragraphs with.
 *
 * @param text - Markdown text.
 * @returns The root node.
 */
function parseMarkdown(text: string): MarkdownNode {
  const root: unknown = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  return isMarkdownNode(root) ? root : { type: 'root', children: [] }
}

/**
 * Lists every node below and including a root, depth first.
 *
 * @param root - Root node.
 * @returns The nodes in source order.
 */
function listMarkdownNodes(root: MarkdownNode): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const node = pending.shift()
    if (!isMarkdownNode(node)) continue
    nodes.push(node)
    if (Array.isArray(node.children)) pending.unshift(...node.children)
  }
  return nodes
}

/**
 * Tells whether a parsed value is a node record.
 *
 * @param value - Parsed value.
 * @returns Whether the value is an object with a type.
 */
function isMarkdownNode(value: unknown): value is MarkdownNode {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * Reads the source offsets of a node.
 *
 * @param node - Parsed node.
 * @returns The start and exclusive end, or `undefined` without a position.
 */
function readNodeRange(node: MarkdownNode): { start: number; end: number } | undefined {
  const start = readOffset(node.position, 'start')
  const end = readOffset(node.position, 'end')
  return start === undefined || end === undefined || end < start ? undefined : { start, end }
}

/**
 * Reads one offset of a node position.
 *
 * @param position - The node's `position`.
 * @param edge - Which end of the node.
 * @returns The offset, or `undefined` when the parser gave none.
 */
function readOffset(position: unknown, edge: 'start' | 'end'): number | undefined {
  if (typeof position !== 'object' || position === null || !(edge in position)) return undefined
  const point: unknown = Reflect.get(position, edge)
  if (typeof point !== 'object' || point === null || !('offset' in point)) return undefined
  const offset: unknown = point.offset
  return typeof offset === 'number' && Number.isSafeInteger(offset) ? offset : undefined
}
