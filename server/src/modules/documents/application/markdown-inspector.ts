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
 * and GFM grammar (micromark) that the web app renders paragraphs with. A node spanning several
 * lines gives one range per line, without the markers of a blockquote or list around it.
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
      ranges.push(...splitHtmlNodeLines(text, start, end, typeof node.value === 'string' ? node.value : ''))
      continue
    }
    if (Array.isArray(node.children)) pending.push(...node.children)
  }
  return ranges.sort((left, right) => left.start - right.start)
}

/**
 * Splits the source of one HTML node into the ranges of its own text on each line. A later line
 * of a node inside a blockquote or list starts with the container's markers, which belong to the
 * container and are left out, so escaping the node's text never changes the container.
 *
 * @param text - Markdown text.
 * @param start - Offset of the node's first character.
 * @param end - Offset after the node's last character.
 * @param value - The node's text without container markers.
 * @returns One range per non-empty line, in source order.
 */
function splitHtmlNodeLines(
  text: string,
  start: number,
  end: number,
  value: string,
): MarkdownSourceRange[] {
  const valueLines = value.split('\n')
  const ranges: MarkdownSourceRange[] = []
  let lineStart = start
  text.slice(start, end).split('\n').forEach((line, index) => {
    const lineEnd = lineStart + line.length
    if (index === 0) {
      ranges.push({ start: lineStart, end: lineEnd })
    } else {
      const valueLine = valueLines[index]
      // When the node's line cannot be matched, only the container markers are left out.
      const contentStart = valueLine !== undefined && line.endsWith(valueLine)
        ? lineEnd - valueLine.length
        : lineStart + (/^[ \t>]*/u.exec(line)?.[0].length ?? 0)
      ranges.push({ start: contentStart, end: lineEnd, continuesNode: true })
    }
    lineStart = lineEnd + 1
  })
  return ranges.filter((range) => range.end > range.start)
}

/**
 * Tells whether a parsed Markdown node is an object with a type.
 *
 * @param value - Parsed node.
 * @returns Whether the value is a node record.
 */
function isMarkdownNodeRecord(
  value: unknown,
): value is Record<string, unknown> & { type: unknown } {
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

/** One rewrite of a source range; nested rewrites inside the kept part are applied too. */
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

/** A reference definition: where a link or image reference points. */
type MarkdownDefinition = {
  /** Destination URL, with escapes and character references decoded. */
  url: string
  /** Title, or `null` without one. */
  title: string | null
}

/**
 * Rewrites the references of one block so they keep their meaning once blocks are joined into one
 * file. A link or image that uses a reference definition becomes an inline link or image, the
 * definitions are removed, and footnote labels become `<scope>-<n>`, numbered in order of first
 * use, so the same block always gets the same labels.
 *
 * @param text - Markdown of one block.
 * @param scope - Name of the block, unique in the file.
 * @returns The rewritten Markdown, or `undefined` when a reference's source is not as expected.
 */
function localizeMarkdownReferences(text: string, scope: string): string | undefined {
  const root = parseMarkdown(text)
  const definitions = new Map<string, MarkdownDefinition>()
  const footnoteLabels = new Map<string, string>()
  const nodes: Array<Record<string, unknown>> = []
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const node = pending.shift()
    if (!isMarkdownNodeRecord(node)) continue
    nodes.push(node)
    if (Array.isArray(node.children)) pending.unshift(...node.children)
  }
  for (const node of nodes) {
    // CommonMark uses the first definition of a label.
    if (node.type === 'definition' && typeof node.identifier === 'string' && !definitions.has(node.identifier)) {
      if (typeof node.url !== 'string' || (node.title !== null && node.title !== undefined && typeof node.title !== 'string')) {
        return undefined
      }
      definitions.set(node.identifier, { url: node.url, title: typeof node.title === 'string' ? node.title : null })
    }
    if (
      (node.type === 'footnoteReference' || node.type === 'footnoteDefinition') &&
      typeof node.identifier === 'string' &&
      !footnoteLabels.has(node.identifier)
    ) {
      footnoteLabels.set(node.identifier, `${scope}-${footnoteLabels.size + 1}`)
    }
  }
  const edits: ReferenceEdit[] = []
  for (const node of nodes) {
    const start = readMarkdownOffset(node.position, 'start')
    const end = readMarkdownOffset(node.position, 'end')
    if (start === undefined || end === undefined) {
      if (isReferenceNodeType(node.type)) return undefined
      continue
    }
    const source = text.slice(start, end)
    const label = typeof node.label === 'string' ? node.label : undefined
    const identifier = typeof node.identifier === 'string' ? node.identifier : undefined
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = identifier === undefined ? undefined : definitions.get(identifier)
      if (definition === undefined || label === undefined) return undefined
      const labelSource = node.referenceType === 'full'
        ? `[${label}]`
        : node.referenceType === 'collapsed' ? '[]' : ''
      if (!source.endsWith(labelSource)) return undefined
      edits.push({ start, end, keepEnd: end - labelSource.length, suffix: renderInlineDestination(definition) })
    } else if (node.type === 'definition') {
      edits.push({ start, end, keepEnd: start, suffix: '' })
    } else if (node.type === 'footnoteReference' || node.type === 'footnoteDefinition') {
      const renamed = identifier === undefined ? undefined : footnoteLabels.get(identifier)
      const labelSource = `[^${label ?? ''}]`
      if (renamed === undefined || label === undefined || !source.startsWith(labelSource)) return undefined
      edits.push({ start, end: start + labelSource.length, keepEnd: start, suffix: `[^${renamed}]` })
    }
  }
  const localized = applyReferenceEdits(text, 0, text.length, edits.sort((left, right) => left.start - right.start))
  // A definition removed at the end leaves its blank lines behind; they show nothing.
  return definitions.size === 0 ? localized : localized?.replace(/(?:\n[ \t]*)+$/u, '')
}

/**
 * Tells whether a parsed node type is a reference or definition the export rewrites.
 *
 * @param type - Parsed node type.
 * @returns Whether the node is rewritten.
 */
function isReferenceNodeType(type: unknown): boolean {
  return type === 'linkReference' || type === 'imageReference' || type === 'definition' ||
    type === 'footnoteReference' || type === 'footnoteDefinition'
}

/**
 * Writes the inline destination and title of a link or image that used a definition.
 *
 * @param definition - The definition the reference used.
 * @returns `(<url> "title")`, escaped so it reads back as the same destination and title.
 */
function renderInlineDestination(definition: MarkdownDefinition): string {
  const url = definition.url.replace(/[\\<>&]/gu, '\\$&')
  if (definition.title === null) return `(<${url}>)`
  const title = definition.title.replace(/[\\"&]/gu, '\\$&').replace(/\r\n?|\n/gu, ' ')
  return `(<${url}> "${title}")`
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
 * Tells whether Markdown starts a new top-level block at an offset.
 *
 * @param text - Markdown text.
 * @param offset - Offset to look at.
 * @returns Whether no top-level block starts before the offset and ends after it.
 */
function startsMarkdownBlockAt(text: string, offset: number): boolean {
  const root = parseMarkdown(text)
  const children = isMarkdownNodeRecord(root) && Array.isArray(root.children) ? root.children : []
  return children.every((child: unknown) => {
    if (!isMarkdownNodeRecord(child)) return false
    const start = readMarkdownOffset(child.position, 'start')
    const end = readMarkdownOffset(child.position, 'end')
    return start !== undefined && end !== undefined && (end <= offset || start >= offset)
  })
}

/** Reads export Markdown with the grammar the web app renders it with. */
export const markdownInspector: MarkdownInspector = {
  findHtml: findMarkdownHtmlRanges,
  findOpenBlock: findMarkdownOpenBlock,
  localizeReferences: localizeMarkdownReferences,
  startsBlockAt: startsMarkdownBlockAt,
}
