import type {
  DocumentBlock,
  DocumentChecklistItem,
  DocumentTableRow,
} from '@mukuroji/contracts'
import {
  DOCUMENT_MAX_BLOCK_COUNT,
  DOCUMENT_MAX_TABLE_COLUMNS,
  DOCUMENT_MAX_TABLE_ROWS,
  DOCUMENT_MAX_TEXT_LENGTH,
} from './document-limits'

/** Most characters of Markdown one page write accepts. */
export const MARKDOWN_PAGE_IMPORT_MAX_LENGTH = 300_000

/** Why a Markdown text cannot become the body of one page. */
export type MarkdownPageImportErrorCode = 'too-large' | 'too-many-blocks' | 'block-too-long'

/** Page blocks converted from Markdown, or why the Markdown cannot become a page. */
export type MarkdownPageImportResult =
  | {
      /** Discriminator of a successful conversion. */
      ok: true
      /** Blocks of the page body with fresh IDs. */
      blocks: DocumentBlock[]
      /** Text of a single leading `#` heading that the body left out, as an export writes the title. */
      leadingTitle?: string
    }
  | {
      /** Discriminator of a failed conversion. */
      ok: false
      /** Why the Markdown cannot become a page. */
      code: MarkdownPageImportErrorCode
    }

/** Heading found by the line scan, before levels are normalized. */
type RawHeading = {
  /** Discriminator of a heading that still has its Markdown level. */
  type: 'raw-heading'
  /** Number of `#` characters in the source. */
  rawLevel: number
  /** Heading text without markers. */
  text: string
}

/** Block found by the line scan, with heading levels not yet normalized. */
type ScannedBlock = DocumentBlock | RawHeading

/** Opening line of a fenced code block at the start of a line. */
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/u

/** ATX heading line at the start of a line. */
const ATX_HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u

/** Closing sequence of an ATX heading. */
const ATX_CLOSING = /[ \t]+#+[ \t]*$/u

/** Task-list item line at the start of a line. */
const TASK_ITEM = /^[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/u

/** One cell of a table delimiter row, such as `---` or `:-:`. */
const DELIMITER_CELL = /^:?-+:?$/u

/** Code-fence language identifiers the Documents store accepts. */
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u

/**
 * Characters that make heading, checklist, or table text Markdown rather than plain text. Text
 * with any of them stays in a paragraph block, which is shown as Markdown, so nothing it shows
 * changes; native blocks show their text as written.
 */
const MARKDOWN_SYNTAX = /[\\`*_[\]<>&~|!#$]/u

/**
 * Converts Markdown into the body blocks of one Document page with a linear line scan.
 *
 * At the start of a line, a fenced code block becomes a code block (a `mermaid` fence a Mermaid
 * diagram), an ATX heading of plain text a heading, a run of plain task items a checklist, and a
 * pipe table of plain cells a table. Everything else, including lists, quotes, links, and the
 * blank lines between them, stays together as paragraph Markdown, which the page shows as
 * Markdown; a reference definition is copied into each other paragraph that uses its label.
 *
 * When the body starts with the only `#` heading, as Markdown a page exports does, that heading
 * (whatever Markdown its text holds) is left out and returned as `leadingTitle`, and `##` becomes level 1, so exported Markdown
 * written back keeps its heading levels. Otherwise levels are shifted so the shallowest heading
 * is level 1. Deeper headings stop at level 3.
 *
 * @param source - Markdown text.
 * @param createId - Returns a fresh ID with the given prefix.
 * @returns The page body, or why the Markdown cannot become a page.
 */
export function convertMarkdownToPageBlocks(
  source: string,
  createId: (prefix: string) => string,
): MarkdownPageImportResult {
  if (source.length > MARKDOWN_PAGE_IMPORT_MAX_LENGTH) return { ok: false, code: 'too-large' }
  const lines = source.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u)
  const title = findLeadingTitle(lines)
  const scanned = scanBlocks(title === undefined ? lines : lines.slice(title.next), createId)
  if (!scanned.ok) return scanned
  const body = scanned.blocks
  const leadingTitle = title?.text
  const shallowest = leadingTitle !== undefined
    ? 2
    : body.reduce((lowest, block) => block.type === 'raw-heading' ? Math.min(lowest, block.rawLevel) : lowest, 6)
  const blocks = body.map((block): DocumentBlock => block.type === 'raw-heading'
    ? {
        id: createId('heading'),
        type: 'heading',
        level: toHeadingLevel(block.rawLevel - shallowest + 1),
        text: block.text,
      }
    : block)
  if (!shareReferenceDefinitions(blocks)) return { ok: false, code: 'block-too-long' }
  if (blocks.length > DOCUMENT_MAX_BLOCK_COUNT) return { ok: false, code: 'too-many-blocks' }
  return { ok: true, blocks, ...(leadingTitle === undefined ? {} : { leadingTitle }) }
}

/**
 * Finds a title heading where an export writes it: the first non-blank line is a `#` heading and
 * no other line outside a fenced code block is one. The heading text may hold any Markdown, such
 * as the backslash escapes an export adds, because it is read as the title rather than as a block.
 *
 * @param lines - Source lines.
 * @returns The unescaped title and the line after it, or undefined when there is no such heading.
 */
function findLeadingTitle(lines: readonly string[]): { text: string, next: number } | undefined {
  const first = lines.findIndex((line) => line.trim() !== '')
  const match = first < 0 ? null : ATX_HEADING.exec(lines[first] ?? '')
  const text = (match?.[2] ?? '').replace(ATX_CLOSING, '').trim()
  if (match?.[1] !== '#' || text === '') return undefined
  let fence: string | undefined
  for (let index = first + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (fence !== undefined) {
      if (closesFence(line.replace(/^ {0,3}/u, ''), fence)) fence = undefined
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open?.[1] !== undefined && !(open[1].startsWith('`') && (open[2] ?? '').includes('`'))) {
      fence = open[1]
      continue
    }
    if (ATX_HEADING.exec(line)?.[1] === '#') return undefined
  }
  return { text: text.replace(/\\([!-/:-@[-`{-~])/gu, '$1'), next: first + 1 }
}

/** Reference definition line, such as `[docs]: https://example.com`. */
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*\S/u

/**
 * Normalizes a reference label the way Markdown matches it.
 *
 * @param label - Label text between the brackets.
 * @returns Case-folded label with collapsed whitespace.
 */
function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * Copies reference definitions into each other paragraph that uses their label. Each paragraph is
 * shown as Markdown on its own, so a reference whose definition a native block separated from it
 * would otherwise show unresolved. A paragraph that already defines a label keeps its own.
 *
 * @param blocks - Page blocks; paragraphs are changed in place.
 * @returns Whether every paragraph still fits in one block.
 */
function shareReferenceDefinitions(blocks: DocumentBlock[]): boolean {
  const definitions = new Map<string, string>()
  const ownLabels = new Map<DocumentBlock, Set<string>>()
  for (const block of blocks) {
    if (block.type !== 'paragraph') continue
    const labels = new Set<string>()
    for (const line of linesOutsideFences(block.text)) {
      const label = REFERENCE_DEFINITION.exec(line)?.[1]
      if (label === undefined) continue
      const key = normalizeReferenceLabel(label)
      labels.add(key)
      if (!definitions.has(key)) definitions.set(key, line.trim())
    }
    ownLabels.set(block, labels)
  }
  if (definitions.size === 0) return true
  let fits = true
  for (const block of blocks) {
    if (block.type !== 'paragraph') continue
    const own = ownLabels.get(block) ?? new Set<string>()
    const used = [...linesOutsideFences(block.text).join('\n').matchAll(/\[([^\]]+)\]/gu)].map((match) => normalizeReferenceLabel(match[1] ?? ''))
    const missing = [...new Set(used)].filter((label) => !own.has(label) && definitions.has(label))
    if (missing.length === 0) continue
    block.text = `${block.text}\n\n${missing.map((label) => definitions.get(label) ?? '').join('\n')}`
    if (block.text.length > DOCUMENT_MAX_TEXT_LENGTH) fits = false
  }
  return fits
}

/**
 * Clamps a shifted heading level to the levels a page supports.
 *
 * @param level - Shifted level, 1 or more.
 * @returns Level 1, 2, or 3.
 */
function toHeadingLevel(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1
  return level === 2 ? 2 : 3
}

/**
 * Splits Markdown lines into blocks, keeping heading levels raw.
 *
 * @param lines - Source lines without line terminators.
 * @param createId - ID factory.
 * @returns Scanned blocks, or a paragraph too long for one block.
 */
function scanBlocks(
  lines: readonly string[],
  createId: (prefix: string) => string,
): { ok: true, blocks: ScannedBlock[] } | { ok: false, code: 'block-too-long' } {
  const blocks: ScannedBlock[] = []
  /** Lines of the paragraph Markdown that is still open. */
  let paragraph: string[] = []
  /** Whether a nested fence inside the open paragraph is still open, with its marker. */
  let paragraphFence: string | undefined
  let tooLong = false

  /** Ends the open paragraph Markdown, splitting it at blank lines when it is too long. */
  const flushParagraph = () => {
    while (paragraph.length > 0 && paragraph[0]?.trim() === '') paragraph.shift()
    while (paragraph.length > 0 && paragraph.at(-1)?.trim() === '') paragraph.pop()
    if (paragraph.length > 0) {
      for (const text of splitLongParagraph(paragraph.join('\n'))) {
        if (text.length > DOCUMENT_MAX_TEXT_LENGTH) tooLong = true
        blocks.push({ id: createId('paragraph'), type: 'paragraph', text })
      }
    }
    paragraph = []
    paragraphFence = undefined
  }

  /**
   * Tells whether the line starts a new top-level block: at the start of the file, after a blank
   * line, or right after a block that is not paragraph Markdown.
   */
  const atBlockStart = (index: number) => index === 0 || lines[index - 1]?.trim() === '' || paragraph.length === 0

  /** Whether an HTML comment in the open paragraph is still open. */
  let paragraphComment = false

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    // Nothing inside an HTML comment is shown, so its lines stay in the paragraph Markdown.
    if (paragraphComment) {
      paragraph.push(line)
      paragraphComment = opensHtmlComment(line, true)
      index += 1
      continue
    }
    // An indented fence belongs to the list or quote around it, in the paragraph Markdown.
    if (paragraphFence !== undefined) {
      paragraph.push(line)
      if (closesFence(line.replace(/^[ \t>]*/u, ''), paragraphFence)) paragraphFence = undefined
      index += 1
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const info = (fence[2] ?? '').trim()
      // A backtick fence whose info string has a backtick is not a fence.
      if (!(marker.startsWith('`') && info.includes('`'))) {
        flushParagraph()
        const code: string[] = []
        index += 1
        while (index < lines.length && !closesFence((lines[index] ?? '').replace(/^ {0,3}/u, ''), marker)) {
          code.push(lines[index] ?? '')
          index += 1
        }
        index += 1
        const source = code.join('\n')
        const language = info.split(/[ \t]/u)[0] ?? ''
        if (source.length > DOCUMENT_MAX_TEXT_LENGTH) tooLong = true
        blocks.push(language.toLowerCase() === 'mermaid'
          ? { id: createId('diagram'), type: 'diagram', format: 'mermaid', source }
          : {
              id: createId('code'),
              type: 'code',
              code: source,
              ...(SAFE_LANGUAGE.test(language) ? { language } : {}),
            })
        continue
      }
    }
    const heading = ATX_HEADING.exec(line)
    if (heading) {
      const text = (heading[2] ?? '').replace(ATX_CLOSING, '').trim()
      if (text !== '' && !MARKDOWN_SYNTAX.test(text)) {
        flushParagraph()
        blocks.push({ type: 'raw-heading', rawLevel: heading[1]?.length ?? 1, text })
        index += 1
        continue
      }
    }
    if (atBlockStart(index)) {
      const checklist = readChecklist(lines, index, createId)
      if (checklist) {
        flushParagraph()
        blocks.push(checklist.block)
        index = checklist.next
        continue
      }
      const table = readTable(lines, index, createId)
      if (table) {
        flushParagraph()
        blocks.push(table.block)
        index = table.next
        continue
      }
    }
    const nestedFence = /^[ \t>*+\-\d.)]+?(`{3,}|~{3,})/u.exec(line)
    if (nestedFence?.[1] !== undefined) paragraphFence = nestedFence[1]
    paragraphComment = opensHtmlComment(line, false)
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return tooLong ? { ok: false, code: 'block-too-long' } : { ok: true, blocks }
}

/**
 * Tells whether an HTML comment is still open after a line.
 *
 * @param line - Source line.
 * @param open - Whether a comment was open before the line.
 * @returns Whether a comment is open after the line.
 */
function opensHtmlComment(line: string, open: boolean): boolean {
  return removeHtmlComments(line, open).open
}

/**
 * Tells whether a line closes a fenced code block.
 *
 * @param line - Line to check.
 * @param marker - Opening fence marker.
 * @returns Whether the line is a closing fence of at least the marker's length.
 */
function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trimEnd()
  const character = marker[0] ?? '`'
  return trimmed.length >= marker.length && [...trimmed].every((value) => value === character)
}

/**
 * Splits paragraph Markdown longer than one block holds at blank lines outside code fences. A part
 * that still does not fit is left whole, so the caller refuses it.
 *
 * @param text - Paragraph Markdown.
 * @returns Parts of at most one block's length where blank lines allow it.
 */
function splitLongParagraph(text: string): string[] {
  if (text.length <= DOCUMENT_MAX_TEXT_LENGTH) return [text]
  const parts: string[] = []
  let current = ''
  for (const section of splitAtBlankLinesOutsideFences(text)) {
    const joined = current === '' ? section : `${current}\n\n${section}`
    if (joined.length <= DOCUMENT_MAX_TEXT_LENGTH) {
      current = joined
      continue
    }
    if (current !== '') parts.push(current)
    current = section
  }
  if (current !== '') parts.push(current)
  return parts
}

/**
 * Returns the lines of paragraph Markdown that are outside fenced code (including fences nested
 * in lists or quotes) and outside HTML comments, so text that is not shown as Markdown is never
 * read as Markdown.
 *
 * @param text - Paragraph Markdown.
 * @returns Lines outside fenced code, in order.
 */
function linesOutsideFences(text: string): string[] {
  const lines: string[] = []
  let fence: string | undefined
  let comment = false
  for (const line of text.split('\n')) {
    const content = stripContainerMarkers(line)
    if (!comment && fence !== undefined) {
      if (closesFence(content, fence)) fence = undefined
      continue
    }
    const open = comment ? null : /^(`{3,}|~{3,})/u.exec(content)
    if (open?.[1] !== undefined) {
      fence = open[1]
      continue
    }
    const visible = removeHtmlComments(line, comment)
    comment = visible.open
    if (visible.text.trim() !== '' || line.trim() === '') lines.push(visible.text)
  }
  return lines
}

/**
 * Removes the parts of a line inside HTML comments.
 *
 * @param line - Source line.
 * @param open - Whether a comment was open before the line.
 * @returns The text outside comments and whether a comment is open after the line.
 */
function removeHtmlComments(line: string, open: boolean): { text: string, open: boolean } {
  let inside = open
  let text = ''
  let position = 0
  while (position < line.length) {
    const next = inside ? line.indexOf('-->', position) : line.indexOf('<!--', position)
    if (next < 0) {
      if (!inside) text += line.slice(position)
      break
    }
    if (!inside) text += line.slice(position, next)
    position = next + (inside ? 3 : 4)
    inside = !inside
  }
  return { text, open: inside }
}

/**
 * Removes the indentation, quote markers, and list marker in front of a line's content.
 *
 * @param line - Source line.
 * @returns The line's content.
 */
function stripContainerMarkers(line: string): string {
  return line.replace(/^[ \t>]*(?:(?:[*+-]|\d+[.)])[ \t]+)?/u, '')
}

/**
 * Splits paragraph Markdown into sections at blank lines that are outside fenced code, including
 * fences nested in lists or quotes, and that are followed by an unindented line, so no section
 * starts inside a code block or a list item.
 *
 * @param text - Paragraph Markdown.
 * @returns Sections in order, without the blank lines between them.
 */
function splitAtBlankLinesOutsideFences(text: string): string[] {
  const sections: string[] = []
  let lines: string[] = []
  let fence: string | undefined
  let comment = false
  for (const line of text.split('\n')) {
    const content = stripContainerMarkers(line)
    if (comment) {
      comment = opensHtmlComment(line, true)
    } else if (fence !== undefined) {
      if (closesFence(content, fence)) fence = undefined
    } else if (line.trim() === '') {
      if (lines.length > 0) sections.push(lines.join('\n'))
      lines = []
      continue
    } else {
      const open = /^(`{3,}|~{3,})/u.exec(content)
      if (open?.[1] !== undefined) fence = open[1]
      else comment = opensHtmlComment(line, false)
    }
    lines.push(line)
  }
  if (lines.length > 0) sections.push(lines.join('\n'))
  // An indented section continues the list item or code before it, so it is never split off.
  const merged: string[] = []
  for (const section of sections) {
    const previous = merged.at(-1)
    if (previous !== undefined && /^[ \t]/u.test(section)) merged[merged.length - 1] = `${previous}\n\n${section}`
    else merged.push(section)
  }
  return merged
}

/**
 * Reads a run of plain task items that makes up one whole top-level block.
 *
 * @param lines - Source lines.
 * @param start - First line of the block.
 * @param createId - ID factory.
 * @returns The checklist and the line after it, or undefined when the block is not one.
 */
function readChecklist(
  lines: readonly string[],
  start: number,
  createId: (prefix: string) => string,
): { block: DocumentBlock, next: number } | undefined {
  const items: DocumentChecklistItem[] = []
  let index = start
  while (index < lines.length && (lines[index] ?? '').trim() !== '') {
    const match = TASK_ITEM.exec(lines[index] ?? '')
    const text = match?.[2]?.trim() ?? ''
    if (!match || text === '' || MARKDOWN_SYNTAX.test(text)) return undefined
    items.push({ id: createId('item'), text, checked: match[1] !== ' ' })
    index += 1
  }
  if (items.length === 0) return undefined
  // An indented line after the run continues its last item, which a checklist cannot hold.
  let after = index
  while (after < lines.length && (lines[after] ?? '').trim() === '') after += 1
  if (/^[ \t]/u.test(lines[after] ?? '')) return undefined
  return { block: { id: createId('checklist'), type: 'checklist', items }, next: index }
}

/**
 * Reads a pipe table of plain cells that makes up one whole top-level block.
 *
 * @param lines - Source lines.
 * @param start - Header line of the table.
 * @param createId - ID factory.
 * @returns The table and the line after it, or undefined when the block is not one.
 */
function readTable(
  lines: readonly string[],
  start: number,
  createId: (prefix: string) => string,
): { block: DocumentBlock, next: number } | undefined {
  const header = splitTableRow(lines[start] ?? '')
  const delimiter = splitTableRow(lines[start + 1] ?? '')
  if (
    header === undefined || delimiter === undefined ||
    header.length === 0 || header.length > DOCUMENT_MAX_TABLE_COLUMNS ||
    delimiter.length !== header.length || !delimiter.every((cell) => DELIMITER_CELL.test(cell))
  ) {
    return undefined
  }
  const rows: DocumentTableRow[] = []
  let index = start + 2
  while (index < lines.length && (lines[index] ?? '').trim() !== '') {
    const cells = splitTableRow(lines[index] ?? '')
    if (cells === undefined || cells.length !== header.length) return undefined
    rows.push({ id: createId('row'), cells: cells.map((text) => ({ id: createId('cell'), text })) })
    index += 1
  }
  if (rows.length > DOCUMENT_MAX_TABLE_ROWS) return undefined
  if ([...header, ...rows.flatMap((row) => row.cells.map((cell) => cell.text))].some((text) => MARKDOWN_SYNTAX.test(text))) {
    return undefined
  }
  return { block: { id: createId('table'), type: 'table', columns: header, rows }, next: index }
}

/**
 * Splits one pipe table line into trimmed cells. A line counts only when it starts and ends with
 * a pipe and is not indented as code, so ordinary text with a pipe is never read as a table.
 *
 * @param line - Source line.
 * @returns The cells, or undefined when the line is not a pipe table row.
 */
function splitTableRow(line: string): string[] | undefined {
  // Four spaces or a tab of indentation make an indented code block, not a table.
  if (/^(?: {4}|\t)/u.test(line)) return undefined
  const trimmed = line.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.includes('\\|')) {
    return undefined
  }
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}
