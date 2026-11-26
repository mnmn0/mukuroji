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
import { MARKDOWN_BLOCK_BOUNDARY } from './document-content'

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

/**
 * Heading whose text holds Markdown, so it stays paragraph Markdown, found by the line scan before
 * levels are normalized. It takes part in level normalization so its level matches native headings.
 */
type RawMarkdownHeading = {
  /** Discriminator of a Markdown heading that still has its source level. */
  type: 'raw-markdown-heading'
  /** Number of `#` characters in the source. */
  rawLevel: number
  /** Heading text without markers, as Markdown. */
  text: string
}

/** Block found by the line scan, with heading levels not yet normalized. */
type ScannedBlock = DocumentBlock | RawHeading | RawMarkdownHeading

/** Opening line of a fenced code block at the start of a line. */
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/u


/** Setext heading underline, which makes the paragraph line above it a heading. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/u

/** Thematic break, such as `---` or `* * *`, which is never the text of a Setext heading. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u


/** Task-list item line at the start of a line. */
const TASK_ITEM = /^[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/u

/**
 * One cell of a table delimiter row without alignment, such as `---`. A native table has no column
 * alignment, so a table with `:` alignment markers stays Markdown.
 */
const DELIMITER_CELL = /^-+$/u

/** Code-fence language identifiers the Documents store accepts. */
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u

/**
 * Characters that make heading, checklist, or table text Markdown rather than plain text. Text
 * with any of them stays in a paragraph block, which is shown as Markdown, so nothing it shows
 * changes; native blocks show their text as written.
 */
const MARKDOWN_SYNTAX = /[\\`*_[\]<>&~|!#$]/u

/**
 * Start of a URL or email address that GFM shows as a link, which a native block shows as plain
 * text. Each part stops at the next `@`, so a line costs linear time.
 */
const AUTOLINK = /(?:https?:\/\/|www\.|[^\s@]@[^\s@]*\.)/iu

/**
 * Tells whether text shows differently as Markdown than as the plain text of a native block.
 *
 * @param text - Heading, checklist, or table text.
 * @returns Whether the text holds Markdown syntax or an autolink.
 */
function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SYNTAX.test(text) || AUTOLINK.test(text)
}

/**
 * Reads an ATX heading at the start of a line with linear scans.
 *
 * @param line - Source line, without indentation.
 * @returns The heading level and text without markers, or undefined when the line is not one.
 */
function parseAtxHeading(line: string): { level: number, text: string } | undefined {
  let level = 0
  while (level < line.length && line[level] === '#') level += 1
  if (level < 1 || level > 6) return undefined
  const after = line[level]
  if (after !== undefined && after !== ' ' && after !== '\t') return undefined
  const text = line.slice(level).trim()
  // A closing run of `#` after a space or tab is not part of the text.
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end -= 1
  const closed = end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')
  return { level, text: closed ? text.slice(0, end).trimEnd() : text }
}

/**
 * Converts Markdown into the body blocks of one Document page with a linear line scan.
 *
 * At the start of a line, a fenced code block becomes a code block (a `mermaid` fence a Mermaid
 * diagram), an ATX heading of plain text a heading, a run of plain task items a checklist, and a
 * pipe table of plain cells a table. Everything else, including lists, quotes, links, and the
 * blank lines between them, stays together as paragraph Markdown, which the page shows as
 * Markdown. Markdown with a reference or footnote definition, or with a raw HTML block, stays
 * whole in one paragraph, so every reference keeps its definition and an HTML block keeps its
 * contents.
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
  const bodyLines = title === undefined ? lines : lines.slice(title.next)
  // Only blank lines are trimmed, so the first line keeps indentation that makes it code.
  const bodyText = trimBlankLines(bodyLines).join('\n')
  // A reference or footnote definition resolves anywhere in the document, but each paragraph
  // block is shown on its own; such Markdown stays whole in one paragraph so every reference
  // keeps its definition. A raw HTML block is shown literally up to its end, so Markdown with one
  // stays whole too and nothing inside it becomes a native block.
  // A definition or HTML block may sit inside a list item or quote, so container markers are
  // removed first; a false match only keeps more Markdown together.
  const keepsWhole = linesOutsideFences(bodyText).some((line) => {
    if (isBlockBoundary(line)) return false
    const content = stripContainerMarkers(line)
    return REFERENCE_DEFINITION.test(content) || HTML_BLOCK_START.test(content)
  })
  /** Keeps the whole body in one paragraph, which shows it as the Markdown it is. */
  const whole = (): MarkdownPageImportResult => {
    if (bodyText.length > DOCUMENT_MAX_TEXT_LENGTH) return { ok: false, code: 'block-too-long' }
    return {
      ok: true,
      blocks: [{ id: createId('paragraph'), type: 'paragraph', text: bodyText }],
      ...(title === undefined ? {} : { leadingTitle: title.text }),
    }
  }
  if (keepsWhole) return whole()
  const scanned = scanBlocks(bodyLines, createId)
  if (!scanned.ok) return scanned.code === 'keep-whole' ? whole() : { ok: false, code: scanned.code }
  const body = scanned.blocks
  const leadingTitle = title?.text
  const shallowest = leadingTitle !== undefined
    ? 2
    : body.reduce((lowest, block) => block.type === 'raw-heading' || block.type === 'raw-markdown-heading'
      ? Math.min(lowest, block.rawLevel)
      : lowest, 6)
  const blocks = body.map((block): DocumentBlock => {
    if (block.type === 'raw-heading') {
      return {
        id: createId('heading'),
        type: 'heading',
        level: toHeadingLevel(block.rawLevel - shallowest + 1),
        text: block.text,
      }
    }
    if (block.type === 'raw-markdown-heading') {
      // Written with as many `#` as an export writes for a native heading of the same level.
      const level = toHeadingLevel(block.rawLevel - shallowest + 1)
      return { id: createId('paragraph'), type: 'paragraph', text: `${'#'.repeat(level + 1)} ${block.text}` }
    }
    return block
  })
  // A heading, kept as a block or as a Markdown line, holds at most one block's text.
  if (blocks.some((block) => (block.type === 'heading' || block.type === 'paragraph') && block.text.length > DOCUMENT_MAX_TEXT_LENGTH)) {
    return { ok: false, code: 'block-too-long' }
  }
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
  const match = first < 0 ? undefined : parseAtxHeading(lines[first] ?? '')
  const text = match?.text ?? ''
  if (match?.level !== 1 || text === '') return undefined
  // Another `#` heading, outside fenced code and HTML comments and indented by up to three
  // spaces, means the first one is not a title.
  const rest = linesOutsideFences(lines.slice(first + 1).join('\n'), true)
  if (rest.some((line) => parseAtxHeading(line.replace(/^ {0,3}/u, ''))?.level === 1)) return undefined
  return { text: text.replace(/\\([!-/:-@[-`{-~])/gu, '$1'), next: first + 1 }
}

/** Opening tag of a raw HTML block that ends at its closing tag rather than at a blank line. */
const HTML_RAW_BLOCK_START = /^ {0,3}<(pre|script|style|textarea)(?:[\s>]|$)/iu

/**
 * Start of a reference or footnote definition, such as `[docs]: https://example.com`. Its content
 * may start on the next line, so nothing after the colon is required; a false match only keeps
 * more Markdown together.
 */
const REFERENCE_DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:/u

/**
 * Start of a raw HTML block, such as `<pre>`, `<div>`, `</p>`, `<?php`, or `<![CDATA[`. Its lines
 * up to its end are shown as one literal block, so nothing inside may become a native block; a
 * false match, such as a line that starts with inline HTML, only keeps more Markdown together.
 */
const HTML_BLOCK_START = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|\/[A-Za-z]|[?!])/u

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
): { ok: true, blocks: ScannedBlock[] } | { ok: false, code: 'block-too-long' | 'keep-whole' } {
  const blocks: ScannedBlock[] = []
  /** Lines of the paragraph Markdown that is still open. */
  let paragraph: string[] = []
  /** Whether a nested fence inside the open paragraph is still open, with its marker. */
  let paragraphFence: string | undefined
  /** Quotes and list items around the open paragraph fence. */
  let paragraphFenceContainer: FenceContainer = { quoted: false, column: 0 }
  let tooLong = false

  /** Ends the open paragraph Markdown, splitting it at blank lines when it is too long. */
  const flushParagraph = () => {
    paragraph = trimBlankLines(paragraph)
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
   * line, or right after a block that is not paragraph Markdown. An indented line after paragraph
   * Markdown may continue a list item or quote there, so it stays in that paragraph.
   */
  const atBlockStart = (index: number) => {
    if (paragraph.length === 0) return true
    if (/^[ \t]/u.test(lines[index] ?? '')) return false
    return index === 0 || lines[index - 1]?.trim() === ''
  }

  /** Whether an HTML comment in the open paragraph is still open. */
  let paragraphComment = false
  /** Whether a Setext heading the scan cannot take apart needs the whole body kept together. */
  let keepWhole = false

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
    // An unclosed fence ends with the quote or list item it opened in.
    if (paragraphFence !== undefined && leavesFenceContainer(line, paragraphFenceContainer)) paragraphFence = undefined
    if (paragraphFence !== undefined) {
      paragraph.push(line)
      if (closesNestedFence(line, paragraphFence, paragraphFenceContainer)) paragraphFence = undefined
      index += 1
      continue
    }
    // The definition an export writes between two blocks only keeps them apart, so it ends the
    // open paragraph and is dropped.
    // An export writes it after a blank line, so right after text it is that text's continuation.
    if (isBlockBoundary(line) && (index === 0 || (lines[index - 1] ?? '').trim() === '')) {
      flushParagraph()
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
    // A Setext underline makes the paragraph text above it a heading. A single plain line becomes a
    // heading block so its level is normalized with the others; any other text is kept whole with
    // the body, so the hierarchy does not change. A thematic break above is not paragraph text, so
    // the line is a thematic break too and stays Markdown.
    const underline = SETEXT_UNDERLINE.exec(line)
    if (underline && paragraph.length > 0 && index > 0 && (lines[index - 1] ?? '').trim() !== ''
      && !THEMATIC_BREAK.test(paragraph.at(-1) ?? '')) {
      const above = paragraph.at(-1) ?? ''
      const before = paragraph.at(-2)
      const plain = !/^(?: {4}|\t)/u.test(above) && stripContainerMarkers(above) === above.trimStart()
      if ((before === undefined || before.trim() === '') && plain) {
        paragraph.pop()
        flushParagraph()
        const text = above.trim()
        const rawLevel = underline[1]?.startsWith('=') ? 1 : 2
        blocks.push(hasMarkdownSyntax(text)
          ? { type: 'raw-markdown-heading', rawLevel, text }
          : { type: 'raw-heading', rawLevel, text })
        index += 1
        continue
      }
      keepWhole = true
    }
    // A heading may be indented by up to three spaces. After paragraph Markdown such a line may
    // belong to a list item there, so the body is kept whole to keep the hierarchy.
    const indentedHeading = /^ {1,3}#/u.test(line)
    const heading = indentedHeading && paragraph.length > 0 ? undefined : parseAtxHeading(line.replace(/^ {1,3}/u, ''))
    if (indentedHeading && paragraph.length > 0 && parseAtxHeading(line.trimStart()) !== undefined) keepWhole = true
    if (heading) {
      const text = heading.text
      if (text !== '') {
        // A heading always ends the paragraph before it, so it can stand as its own block. One
        // whose text holds Markdown stays Markdown but still takes part in level normalization.
        flushParagraph()
        const rawLevel = heading.level
        blocks.push(hasMarkdownSyntax(text)
          ? { type: 'raw-markdown-heading', rawLevel, text }
          : { type: 'raw-heading', rawLevel, text })
        index += 1
        continue
      }
    }
    if (atBlockStart(index)) {
      // An item after a blank line continues a list of the open paragraph that has the same bullet,
      // so it cannot start a checklist of its own.
      const isTask = TASK_ITEM.test(line)
      const lastText = isTask ? paragraph.findLast((text) => text.trim() !== '') : undefined
      const continuesList = lastText !== undefined && /^[-*+][ \t]/u.test(lastText) && lastText[0] === line[0]
      const checklist = !isTask || continuesList ? undefined : readChecklist(lines, index, createId)
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
    if (nestedFence?.[1] !== undefined) {
      paragraphFence = nestedFence[1]
      paragraphFenceContainer = readFenceContainer(line)
    }
    paragraphComment = opensHtmlComment(line, false)
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  if (keepWhole) return { ok: false, code: 'keep-whole' }
  return tooLong ? { ok: false, code: 'block-too-long' } : { ok: true, blocks }
}

/**
 * Tells whether a line is the definition an export writes between two blocks that Markdown would
 * otherwise read as one.
 *
 * @param line - Source line.
 * @returns Whether the line is that block boundary.
 */
function isBlockBoundary(line: string): boolean {
  // Only an unindented line is the boundary an export writes; an indented one is code or list text.
  return line.trimEnd() === MARKDOWN_BLOCK_BOUNDARY
}

/**
 * Drops the blank lines at the start and end of a run of lines in one pass, so many blank lines
 * cost linear time.
 *
 * @param lines - Source lines.
 * @returns The lines from the first to the last line that is not blank.
 */
function trimBlankLines(lines: readonly string[]): string[] {
  const blank = (line: string | undefined) => line === undefined || /^[ \t]*$/u.test(line)
  let start = 0
  while (start < lines.length && blank(lines[start])) start += 1
  let end = lines.length
  while (end > start && blank(lines[end - 1])) end -= 1
  return lines.slice(start, end)
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
 * Reads the marker of a line that opens a fenced code block. A backtick fence whose info string
 * holds a backtick is not a fence.
 *
 * @param content - Line without indentation or container markers.
 * @returns The fence marker, or undefined when the line opens no fence.
 */
function readFenceOpening(content: string): string | undefined {
  const open = FENCE_OPEN.exec(content)
  const marker = open?.[1]
  if (marker === undefined || (marker.startsWith('`') && (open?.[2] ?? '').includes('`'))) return undefined
  return marker
}

/** Lists and quotes around a fence, which decide where it closes or ends. */
interface FenceContainer {
  /** Whether the fence opened inside a quote, so a line without a quote marker ends it. */
  quoted: boolean
  /**
   * List content column, counted after quote markers. A non-blank line indented less ends the
   * list item and the fence with it; infinite when the opening line was not taken apart.
   */
  column: number
}

/**
 * Reads the quotes and list items in front of a line that opens a fence, in one linear pass.
 *
 * @param line - Line that opens the fence.
 * @returns The fence's container.
 */
function readFenceContainer(line: string): FenceContainer {
  let position = 0
  let column = 0
  let quoted = false
  for (;;) {
    let next = position
    while (line[next] === ' ' || line[next] === '\t') next += 1
    const character = line[next] ?? ''
    if (character === '>') {
      quoted = true
      column = 0
      position = next + 1
      if (line[position] === ' ' || line[position] === '\t') position += 1
      continue
    }
    let marker = next
    if (character === '*' || character === '+' || character === '-') {
      marker += 1
    } else {
      while (marker < line.length && /\d/u.test(line[marker] ?? '')) marker += 1
      if (marker === next || (line[marker] !== '.' && line[marker] !== ')')) break
      marker += 1
    }
    if (line[marker] !== ' ' && line[marker] !== '\t') break
    let content = marker
    while (line[content] === ' ' || line[content] === '\t') content += 1
    column += content - position
    position = content
  }
  if (!/^ {0,3}(?:`{3}|~{3})/u.test(line.slice(position))) return { quoted, column: Number.POSITIVE_INFINITY }
  return { quoted, column }
}

/**
 * Removes the quote markers in front of a line in one linear pass.
 *
 * @param line - Source line.
 * @returns The line after its quote markers.
 */
function stripQuoteMarkers(line: string): string {
  let position = 0
  for (;;) {
    let next = position
    while (line[next] === ' ' || line[next] === '\t') next += 1
    if (line[next] !== '>') return line.slice(position)
    position = next + 1
    if (line[position] === ' ' || line[position] === '\t') position += 1
  }
}

/**
 * Tells whether a line ends the quote or list item a fence opened in, which ends an unclosed fence
 * too. A false answer only keeps more lines inside the fence.
 *
 * @param line - Source line.
 * @param container - The fence's container.
 * @returns Whether the line is outside the container.
 */
function leavesFenceContainer(line: string, container: FenceContainer): boolean {
  if (container.quoted && !/^ {0,3}>/u.test(line)) return true
  const content = stripQuoteMarkers(line)
  if (content.trim() === '' || !Number.isFinite(container.column) || container.column === 0) return false
  const indent = /^ */u.exec(content)?.[0].length ?? 0
  return indent < container.column
}

/**
 * Tells whether a line closes a fence that may sit in a list or quote: after quote markers, it is
 * indented at most three spaces past the list content column. Deeper lines are code inside it.
 *
 * @param line - Source line.
 * @param marker - Opening fence marker.
 * @param container - The fence's container.
 * @returns Whether the line closes the fence.
 */
function closesNestedFence(line: string, marker: string, container: FenceContainer): boolean {
  const unquoted = stripQuoteMarkers(line)
  const indent = /^ */u.exec(unquoted)?.[0].length ?? 0
  return indent <= container.column + 3 && closesFence(unquoted.slice(indent), marker)
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
  for (const section of joinListSections(splitAtBlankLinesOutsideFences(text))) {
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

/** List item marker at the start of a section. */
const LIST_ITEM_START = /^(?:[*+-]|\d{1,9}[.)])[ \t]/u

/**
 * Joins sections that are items of one list, so a split never makes two lists that number or
 * space their items differently from the one written.
 *
 * @param sections - Sections split at blank lines.
 * @returns Sections with each list in one piece.
 */
function joinListSections(sections: readonly string[]): string[] {
  const joined: string[] = []
  let previousIsList = false
  for (const section of sections) {
    const isList = LIST_ITEM_START.test(section)
    const previous = joined.at(-1)
    if (isList && previousIsList && previous !== undefined) joined[joined.length - 1] = `${previous}\n\n${section}`
    else joined.push(section)
    previousIsList = isList
  }
  return joined
}

/**
 * Returns the lines of paragraph Markdown that are outside fenced code (including fences nested
 * in lists or quotes) and outside HTML comments, so text that is not shown as Markdown is never
 * read as Markdown. With `skipHtmlBlocks`, the lines of raw HTML blocks are left out too, in the
 * same pass, so a fence line inside `<pre>` opens no fence and a `<pre>` line inside a fence
 * opens no HTML block.
 *
 * @param text - Paragraph Markdown.
 * @param skipHtmlBlocks - Whether to leave out raw HTML blocks, start line included.
 * @returns Lines outside fenced code, in order.
 */
function linesOutsideFences(text: string, skipHtmlBlocks = false): string[] {
  const lines: string[] = []
  let fence: string | undefined
  let container: FenceContainer = { quoted: false, column: 0 }
  let comment = false
  /** Closing tag of the open raw HTML block, '' for one that ends at a blank line. */
  let html: string | undefined
  for (const line of text.split('\n')) {
    if (html !== undefined) {
      if (html === '' ? line.trim() === '' : line.toLowerCase().includes(html)) html = undefined
      continue
    }
    if (!comment && fence !== undefined && leavesFenceContainer(line, container)) fence = undefined
    if (!comment && fence !== undefined) {
      if (closesNestedFence(line, fence, container)) fence = undefined
      continue
    }
    const open = comment ? undefined : readFenceOpening(fenceContent(line))
    if (open !== undefined) {
      fence = open
      container = readFenceContainer(line)
      continue
    }
    if (skipHtmlBlocks && !comment) {
      const raw = HTML_RAW_BLOCK_START.exec(line)
      if (raw !== null || HTML_BLOCK_START.test(line)) {
        const closing = raw === null ? '' : `</${(raw[1] ?? '').toLowerCase()}>`
        // A raw block whose closing tag is on its first line ends there.
        if (closing === '' || !line.toLowerCase().includes(closing)) html = closing
        continue
      }
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
 * Returns the part of a line that may open or close a fenced code block. A line indented by four
 * spaces or a tab is indented code, so it is returned as it is and opens no fence.
 *
 * @param line - Source line.
 * @returns The line's content without container markers, or the indented code line.
 */
function fenceContent(line: string): string {
  if (/^(?: {4}|\t)/u.test(line)) return line
  return stripContainerMarkers(line)
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
  let container: FenceContainer = { quoted: false, column: 0 }
  let comment = false
  for (const line of text.split('\n')) {
    if (!comment && fence !== undefined && leavesFenceContainer(line, container)) fence = undefined
    if (comment) {
      comment = opensHtmlComment(line, true)
    } else if (fence !== undefined) {
      if (closesNestedFence(line, fence, container)) fence = undefined
    } else if (line.trim() === '') {
      if (lines.length > 0) sections.push(lines.join('\n'))
      lines = []
      continue
    } else {
      const open = readFenceOpening(fenceContent(line))
      if (open !== undefined) {
        fence = open
        container = readFenceContainer(line)
      } else {
        comment = opensHtmlComment(line, false)
      }
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
  const bullet = (lines[start] ?? '')[0]
  let index = start
  for (;;) {
    while (index < lines.length && (lines[index] ?? '').trim() !== '') {
      const match = TASK_ITEM.exec(lines[index] ?? '')
      const text = match?.[2]?.trim() ?? ''
      if (!match || text === '' || hasMarkdownSyntax(text)) return undefined
      items.push({ id: createId('item'), text, checked: match[1] !== ' ' })
      index += 1
    }
    if (items.length === 0) return undefined
    let after = index
    while (after < lines.length && (lines[after] ?? '').trim() === '') after += 1
    const next = lines[after] ?? ''
    // An indented line after the run continues its last item, which a checklist cannot hold.
    if (/^[ \t]/u.test(next)) return undefined
    // An item with the same bullet after blank lines belongs to the same list: the list is a
    // checklist only when every item in it is a plain task.
    if (after === index || next[0] !== bullet || !/^[-*+][ \t]/u.test(next)) break
    index = after
  }
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
  if ([...header, ...rows.flatMap((row) => row.cells.map((cell) => cell.text))].some((text) => hasMarkdownSyntax(text))) {
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
