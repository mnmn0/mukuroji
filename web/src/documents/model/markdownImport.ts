import type {
  DocumentBlock,
  DocumentChecklistItem,
  DocumentHeadingBlock,
  DocumentTableRow,
} from '@mukuroji/contracts'

/**
 * Largest Markdown file the import accepts, in bytes. A stored page must fit
 * in one DynamoDB item of about 350 KB together with its block metadata.
 */
export const MARKDOWN_IMPORT_MAX_BYTES = 300_000

/**
 * Largest serialized title and blocks the import sends. The server stores a
 * page in one item of at most 350 KB, which also holds the page metadata.
 */
const MAX_CONTENT_BYTES = 320_000

/** Most blocks one page may hold, matching the server limit. */
export const MARKDOWN_IMPORT_MAX_BLOCKS = 500

/** Most characters one block text may hold, matching the server limit. */
const MAX_BLOCK_TEXT_LENGTH = 50_000

/** Most characters a page title may hold, matching the server limit. */
const MAX_TITLE_LENGTH = 500

/** Most table columns the server accepts. */
const MAX_TABLE_COLUMNS = 50

/** Most table rows the server accepts. */
const MAX_TABLE_ROWS = 200

/** Longest embed URL the server accepts. */
const MAX_EMBED_URL_LENGTH = 4_096

/**
 * Reason a Markdown source cannot become one page.
 */
export type MarkdownImportErrorCode =
  | 'empty'
  | 'too-large'
  | 'too-many-blocks'
  | 'block-too-long'
  | 'table-too-large'

/**
 * Markdown and destination chosen for one import.
 */
export type MarkdownDocumentImportRequest = {
  /** Markdown text pasted or read from a file. */
  source: string
  /** Title used when the Markdown has no single leading `#` heading. */
  fallbackTitle: string
  /** Project that owns the new page; omission creates it in the Workspace. */
  projectId?: string
}

/**
 * Page title and blocks converted from Markdown, or the reason it failed.
 */
export type MarkdownImportResult =
  | {
      /** Discriminator of a successful conversion. */
      ok: true
      /** Title of the new page. */
      title: string
      /** Blocks of the new page with fresh IDs. */
      blocks: DocumentBlock[]
    }
  | {
      /** Discriminator of a failed conversion. */
      ok: false
      /** Why the source cannot become one page. */
      code: MarkdownImportErrorCode
    }

/**
 * Options for converting Markdown into page blocks.
 */
export type MarkdownImportOptions = {
  /** Title used when the source has no single leading `#` heading. */
  fallbackTitle: string
  /** Returns a fresh ID with the given prefix. */
  createId: (prefix: string) => string
  /**
   * Returns the URL that replaces a link target, or undefined to keep the
   * target as written. A folder import uses it to point relative links at the
   * pages it creates.
   */
  resolveLink?: (href: string) => string | undefined
}

/**
 * Rewrites the targets of inline links in raw Markdown text.
 */
type LinkRewriter = (raw: string) => string

/**
 * Heading found while scanning, before levels are normalized.
 */
type RawHeading = {
  /** Discriminator of a heading that still has its Markdown level. */
  type: 'raw-heading'
  /** Number of `#` characters in the source. */
  rawLevel: number
  /** Heading text without markers. */
  text: string
}

/**
 * Block found while scanning, with headings not yet normalized.
 */
type ScannedBlock = DocumentBlock | RawHeading

/** Opening line of a fenced code block, before the info string is checked. */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/u

/** ATX heading line. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/u

/** Task-list item line. */
const TASK_ITEM = /^ {0,3}[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/u

/** First line of a list item or blockquote. */
const LIST_OR_QUOTE_START = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)/u

/** Thematic break line. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u

/** One cell of a table delimiter row, such as `---` or `:-:`. */
const DELIMITER_CELL = /^:?-+:?$/u

/** Code-fence language identifiers the server accepts. */
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u

/**
 * Converts Markdown into the title and blocks of one Document page.
 *
 * Headings, fenced code, Mermaid diagrams, task lists, and pipe tables become
 * their matching blocks; everything else stays as paragraph Markdown, escapes
 * included, since paragraphs are shown as Markdown. When the source starts
 * with the only `#` heading, as Markdown exported from a page does, that
 * heading becomes the title and `##` becomes level 1, so exported pages keep
 * their heading levels. Otherwise levels are shifted so the shallowest heading
 * is level 1. Deeper headings stop at level 3.
 *
 * @param source - Markdown text to convert.
 * @param options - Fallback title and ID factory.
 * @returns The page content, or why the source cannot become one page.
 */
export function convertMarkdownToDocument(
  source: string,
  options: MarkdownImportOptions,
): MarkdownImportResult {
  if (new TextEncoder().encode(source).length > MARKDOWN_IMPORT_MAX_BYTES) {
    return { ok: false, code: 'too-large' }
  }
  const lines = source.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u)
  if (lines.every((line) => line.trim() === '')) {
    return { ok: false, code: 'empty' }
  }
  const scanned = scanBlocks(lines, options.createId, options.resolveLink)
  if (!scanned.ok) return scanned

  let title = options.fallbackTitle
  let body = scanned.blocks
  let titleTaken = false
  const first = body[0]
  const topLevelCount = body.filter(
    (block) => block.type === 'raw-heading' && block.rawLevel === 1,
  ).length
  if (first?.type === 'raw-heading' && first.rawLevel === 1 && topLevelCount === 1) {
    title = first.text.trim() || options.fallbackTitle
    body = body.slice(1)
    titleTaken = true
  }

  const shallowest = titleTaken
    ? 2
    : body.reduce(
        (lowest, block) =>
          block.type === 'raw-heading' ? Math.min(lowest, block.rawLevel) : lowest,
        6,
      )
  const blocks = body.map((block): DocumentBlock =>
    block.type === 'raw-heading'
      ? createHeading(block, shallowest, options.createId)
      : block,
  )
  if (blocks.length > MARKDOWN_IMPORT_MAX_BLOCKS) {
    return { ok: false, code: 'too-many-blocks' }
  }
  if (blocks.some(exceedsTextLimit)) {
    return { ok: false, code: 'block-too-long' }
  }
  const pageTitle = title.slice(0, MAX_TITLE_LENGTH)
  const contentBytes = new TextEncoder().encode(
    JSON.stringify({ blocks, title: pageTitle }),
  ).length
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { ok: false, code: 'too-large' }
  }
  return { ok: true, title: pageTitle, blocks }
}

/**
 * Derives a page title from an imported file name.
 *
 * @param fileName - Name of the chosen file.
 * @returns The name without a Markdown extension, or an empty string.
 */
export function titleFromMarkdownFileName(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown|mdown|mkd|txt)$/iu, '').trim()
}

/**
 * Splits Markdown lines into blocks, keeping heading levels raw.
 *
 * A paragraph that is only one link to an HTTPS URL, an application path, or
 * a target the resolver rewrites becomes an embed block, which is how the
 * page Markdown export writes embeds. Other links stay in the text, with
 * their targets rewritten when the resolver returns a URL.
 *
 * @param lines - Source lines without line terminators.
 * @param createId - ID factory.
 * @param resolveLink - Optional rewriter of link targets.
 * @returns Scanned blocks, or a table that exceeds the server limits.
 */
function scanBlocks(
  lines: readonly string[],
  createId: (prefix: string) => string,
  resolveLink?: (href: string) => string | undefined,
):
  | { ok: true; blocks: ScannedBlock[] }
  | { ok: false; code: 'table-too-large' } {
  const blocks: ScannedBlock[] = []
  /** Rewrites link targets with the resolver, or keeps the text as written. */
  const rewrite: LinkRewriter = resolveLink
    ? (raw) => rewriteLinkTargets(raw, resolveLink)
    : (raw) => raw
  let paragraph: string[] = []
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const raw = paragraph.join('\n')
    paragraph = []
    const link = readStandaloneLink(raw)
    const url = link
      ? (resolveLink?.(link.href) ?? (isEmbeddableUrl(link.href) ? link.href : undefined))
      : undefined
    if (link && url) {
      const title = unescapeMarkdown(link.label).trim()
      blocks.push({
        id: createId('block'),
        type: 'embed',
        url,
        ...(title ? { title: title.slice(0, MAX_TITLE_LENGTH) } : {}),
      })
      return
    }
    blocks.push({
      id: createId('block'),
      type: 'paragraph',
      // Paragraphs are shown as Markdown, so escapes such as `\*` stay to keep text literal.
      text: rewrite(raw),
    })
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }

    const fence = readFenceOpen(line)
    if (fence) {
      flushParagraph()
      const close = new RegExp(`^ {0,3}${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}[ \\t]*$`, 'u')
      const content: string[] = []
      index += 1
      while (index < lines.length && !close.test(lines[index] ?? '')) {
        content.push(removeIndent(lines[index] ?? '', fence.indent))
        index += 1
      }
      index += 1
      blocks.push(createFencedBlock(fence.info, content.join('\n'), createId))
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading?.[1]) {
      flushParagraph()
      blocks.push({
        type: 'raw-heading',
        rawLevel: heading[1].length,
        text: unescapeMarkdown(removeClosingHashes(heading[2] ?? '')),
      })
      index += 1
      continue
    }

    if (TASK_ITEM.test(line)) {
      flushParagraph()
      const items: DocumentChecklistItem[] = []
      let task = TASK_ITEM.exec(line)
      while (task) {
        items.push({
          id: createId('item'),
          text: unescapeMarkdown(rewrite((task[2] ?? '').trim())),
          checked: task[1] !== ' ',
        })
        index += 1
        task = TASK_ITEM.exec(lines[index] ?? '')
      }
      blocks.push({ id: createId('block'), type: 'checklist', items })
      continue
    }

    const table = readTableStart(lines, index)
    if (table) {
      flushParagraph()
      const columns = splitTableRow(line, rewrite)
      if (columns.length > MAX_TABLE_COLUMNS) {
        return { ok: false, code: 'table-too-large' }
      }
      const rows: DocumentTableRow[] = []
      let rowIndex = nextTableRowIndex(lines, table.delimiterIndex + 1, table.spaced)
      while (rowIndex !== undefined) {
        if (rows.length === MAX_TABLE_ROWS) {
          return { ok: false, code: 'table-too-large' }
        }
        const cells = splitTableRow(lines[rowIndex] ?? '', rewrite)
        rows.push({
          id: createId('row'),
          cells: columns.map((_, column) => ({
            id: createId('cell'),
            text: cells[column] ?? '',
          })),
        })
        index = rowIndex + 1
        rowIndex = nextTableRowIndex(lines, index, table.spaced)
      }
      index = Math.max(index, table.delimiterIndex + 1)
      blocks.push({ id: createId('block'), type: 'table', columns, rows })
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph()
      index += 1
      continue
    }

    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return { ok: true, blocks }
}

/**
 * Detects a pipe table whose header is at the given line.
 *
 * Besides GitHub Flavored Markdown tables, this accepts the layout the page
 * Markdown export writes, which puts a blank line between the header, the
 * delimiter row, and every body row.
 *
 * @param lines - Source lines.
 * @param index - Line of the candidate header row.
 * @returns Where the delimiter row is and whether rows are blank-separated,
 *   or undefined when the line does not start a table.
 */
function readTableStart(
  lines: readonly string[],
  index: number,
): { delimiterIndex: number; spaced: boolean } | undefined {
  const header = lines[index] ?? ''
  if (!header.includes('|')) return undefined
  const columnCount = splitTableRow(header).length
  const matches = (delimiterIndex: number) => {
    const delimiter = lines[delimiterIndex] ?? ''
    return (
      isDelimiterRow(delimiter) &&
      splitTableRow(delimiter).length === columnCount
    )
  }
  if (matches(index + 1)) return { delimiterIndex: index + 1, spaced: false }
  if (
    isPipeLine(header) &&
    (lines[index + 1] ?? '').trim() === '' &&
    matches(index + 2)
  ) {
    return { delimiterIndex: index + 2, spaced: true }
  }
  return undefined
}

/**
 * Finds the next body row of a table.
 *
 * GitHub Flavored Markdown rows continue until a blank line or the start of
 * another block. Rows of an exported table are each preceded by one blank line
 * and start and end with a pipe; a row that is itself followed by a delimiter
 * row is the header of the next table instead.
 *
 * @param lines - Source lines.
 * @param index - Line after the previous row or the delimiter row.
 * @param spaced - Whether the table separates rows with blank lines.
 * @returns Line of the next row, or undefined when the table has ended.
 */
function nextTableRowIndex(
  lines: readonly string[],
  index: number,
  spaced: boolean,
): number | undefined {
  if (!spaced) {
    return index < lines.length && continuesTable(lines[index] ?? '')
      ? index
      : undefined
  }
  const candidate = lines[index + 1] ?? ''
  if ((lines[index] ?? '').trim() !== '' || !isPipeLine(candidate)) {
    return undefined
  }
  const startsNextTable =
    isExportedDelimiterRow(lines[index + 2] ?? '') ||
    ((lines[index + 2] ?? '').trim() === '' &&
      isExportedDelimiterRow(lines[index + 3] ?? ''))
  return startsNextTable ? undefined : index + 1
}

/**
 * Checks whether a line is the delimiter row the page Markdown export writes,
 * `| --- | --- |`. A body row whose cells merely look like dashes, such as
 * `| - | - |`, does not match, so it stays a row of the current table.
 *
 * @param line - Candidate line.
 * @returns Whether the line is an exported delimiter row.
 */
function isExportedDelimiterRow(line: string): boolean {
  return /^\|(?: --- \|)+$/u.test(line.trim())
}

/**
 * Checks whether a line starts and ends with a pipe.
 *
 * @param line - Candidate line.
 * @returns Whether the line can be a row of an exported table.
 */
function isPipeLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|')
}

/**
 * Checks whether a line is a table delimiter row such as `| --- | :-: |`.
 *
 * @param line - Candidate line.
 * @returns Whether the line is a delimiter row with at least one pipe.
 */
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|') || /^ {4}/u.test(line)) return false
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed
    .split('|')
    .every((cell) => DELIMITER_CELL.test(cell.trim()))
}

/**
 * Checks whether a line after a table's delimiter row is another row. As in
 * GitHub Flavored Markdown, rows continue until a blank line or the start of
 * another block such as a heading, fence, list item, or blockquote.
 *
 * @param line - Line after the previous row.
 * @returns Whether the line is a table row.
 */
function continuesTable(line: string): boolean {
  return (
    line.trim() !== '' &&
    !readFenceOpen(line) &&
    !ATX_HEADING.test(line) &&
    !TASK_ITEM.test(line) &&
    !LIST_OR_QUOTE_START.test(line) &&
    !THEMATIC_BREAK.test(line)
  )
}

/**
 * Removes an ATX heading's optional closing `#` sequence and surrounding
 * spaces without a backtracking regular expression.
 *
 * @param text - Heading text after the opening `#` sequence.
 * @returns The heading text.
 */
function removeClosingHashes(text: string): string {
  const trimmed = text.trim()
  let end = trimmed.length
  while (end > 0 && trimmed[end - 1] === '#') end -= 1
  if (end === trimmed.length) return trimmed
  if (end === 0) return ''
  const before = trimmed[end - 1]
  return before === ' ' || before === '\t' ? trimmed.slice(0, end).trim() : trimmed
}

/**
 * Reads the opening line of a fenced code block.
 *
 * @param line - Candidate line.
 * @returns The fence marker, its indentation, and the first word of the info
 *   string, or undefined when the line does not open a fence. A backtick
 *   fence whose info string contains a backtick is inline code, not a fence.
 */
function readFenceOpen(
  line: string,
): { marker: string; indent: number; info: string } | undefined {
  const match = FENCE_OPEN.exec(line)
  const indent = match?.[1]
  const marker = match?.[2]
  if (indent === undefined || !marker) return undefined
  const rest = match?.[3] ?? ''
  if (marker.startsWith('`') && rest.includes('`')) return undefined
  return { marker, indent: indent.length, info: rest.trim().split(/\s/u)[0] ?? '' }
}

/**
 * Removes the opening fence's indentation from a code line, as Markdown does.
 *
 * @param line - Line inside the fence.
 * @param indent - Number of spaces before the opening fence.
 * @returns The line with up to that many leading spaces removed.
 */
function removeIndent(line: string, indent: number): string {
  let removed = 0
  while (removed < indent && line[removed] === ' ') removed += 1
  return line.slice(removed)
}

/**
 * Builds the block for a fenced code section.
 *
 * @param info - First word of the fence info string.
 * @param content - Lines between the fences.
 * @param createId - ID factory.
 * @returns A Mermaid diagram block or a code block.
 */
function createFencedBlock(
  info: string,
  content: string,
  createId: (prefix: string) => string,
): DocumentBlock {
  if (info.toLowerCase() === 'mermaid') {
    return { id: createId('block'), type: 'diagram', format: 'mermaid', source: content }
  }
  return {
    id: createId('block'),
    type: 'code',
    code: content,
    ...(SAFE_LANGUAGE.test(info) ? { language: info } : {}),
  }
}

/**
 * Builds a heading block with its level shifted to the page's range.
 *
 * @param heading - Heading with its Markdown level.
 * @param shallowest - Smallest Markdown level among the page's headings.
 * @param createId - ID factory.
 * @returns A heading block of level 1 to 3.
 */
function createHeading(
  heading: RawHeading,
  shallowest: number,
  createId: (prefix: string) => string,
): DocumentHeadingBlock {
  const shifted = heading.rawLevel - shallowest + 1
  const level = shifted <= 1 ? 1 : shifted === 2 ? 2 : 3
  return { id: createId('block'), type: 'heading', level, text: heading.text }
}

/**
 * Splits one pipe-table row into unescaped cell texts.
 *
 * @param line - Table row line.
 * @param rewrite - Rewriter of link targets in each cell; omission keeps them.
 * @returns Cell texts in column order.
 */
function splitTableRow(line: string, rewrite: LinkRewriter = (raw) => raw): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let current = ''
  let endsWithPipe = false
  for (let position = 0; position < trimmed.length; position += 1) {
    const character = trimmed[position] ?? ''
    endsWithPipe = false
    if (character === '\\' && position + 1 < trimmed.length) {
      current += character + (trimmed[position + 1] ?? '')
      position += 1
    } else if (character === '|') {
      cells.push(current)
      current = ''
      endsWithPipe = true
    } else {
      current += character
    }
  }
  if (!endsWithPipe) cells.push(current)
  if (trimmed.startsWith('|')) cells.shift()
  return cells.map((cell) =>
    unescapeMarkdown(rewrite(cell.trim()).replace(/<br\s*\/?>/giu, '\n')),
  )
}

/**
 * Reads a paragraph that consists of exactly one inline link, `[label](href)`.
 *
 * @param raw - Raw paragraph text, before escapes are removed.
 * @returns The raw label and target, or undefined when the paragraph holds
 *   anything else, spans lines, or the link has a title.
 */
function readStandaloneLink(
  raw: string,
): { label: string; href: string } | undefined {
  const text = raw.trim()
  if (!text.startsWith('[') || !text.endsWith(')') || text.includes('\n')) {
    return undefined
  }
  let position = 1
  while (position < text.length) {
    const character = text[position]
    if (character === '\\') {
      position += 2
      continue
    }
    if (character === '[') return undefined
    if (character === ']') break
    position += 1
  }
  if (text[position] !== ']' || text[position + 1] !== '(') return undefined
  const href = text.slice(position + 2, -1)
  if (href === '' || /[\s()]/u.test(href)) return undefined
  return { label: text.slice(1, position), href }
}

/**
 * Checks whether a link target can become an embed block that opens on click:
 * an HTTPS URL or a single-slash application path, which the server accepts
 * and the page view renders.
 *
 * @param href - Link target as written.
 * @returns Whether the target is embeddable.
 */
function isEmbeddableUrl(href: string): boolean {
  if (href.length > MAX_EMBED_URL_LENGTH) return false
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\')
  try {
    return new URL(href).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Rewrites the targets of inline links, `[label](href)`, in raw Markdown text.
 * Escaped brackets and code spans are left alone. The scan is linear, so long
 * text cannot make it backtrack.
 *
 * @param raw - Raw text, before escapes are removed.
 * @param resolveLink - Returns the new target, or undefined to keep it.
 * @returns The text with resolved link targets replaced.
 */
function rewriteLinkTargets(
  raw: string,
  resolveLink: (href: string) => string | undefined,
): string {
  let result = ''
  let position = 0
  let labelOpen = false
  let codeFence = 0
  while (position < raw.length) {
    const character = raw[position] ?? ''
    if (character === '\\') {
      result += raw.slice(position, position + 2)
      position += 2
      continue
    }
    if (character === '`') {
      let end = position
      while (raw[end] === '`') end += 1
      const run = end - position
      if (codeFence === 0) codeFence = run
      else if (codeFence === run) codeFence = 0
      result += raw.slice(position, end)
      position = end
      continue
    }
    if (codeFence === 0 && character === '[') labelOpen = true
    if (codeFence === 0 && labelOpen && character === ']' && raw[position + 1] === '(') {
      labelOpen = false
      let end = position + 2
      while (end < raw.length && !/[\s()]/u.test(raw[end] ?? '')) end += 1
      if (raw[end] === ')' && end > position + 2) {
        const href = raw.slice(position + 2, end)
        result += `](${resolveLink(href) ?? href})`
        position = end + 1
        continue
      }
    }
    result += character
    position += 1
  }
  return result
}

/**
 * Removes Markdown backslash escapes so stored text reads as written.
 *
 * @param value - Markdown text.
 * @returns Text with `\` before ASCII punctuation removed.
 */
function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/gu, '$1')
}

/**
 * Checks whether any text in a block exceeds the server's length limit.
 *
 * @param block - Converted block.
 * @returns Whether the block would be rejected for its text length.
 */
function exceedsTextLimit(block: DocumentBlock): boolean {
  const tooLong = (text: string) => text.length > MAX_BLOCK_TEXT_LENGTH
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return tooLong(block.text)
    case 'code':
      return tooLong(block.code)
    case 'diagram':
      return tooLong(block.source)
    case 'checklist':
      return block.items.some((item) => tooLong(item.text))
    case 'table':
      return (
        block.columns.some(tooLong) ||
        block.rows.some((row) => row.cells.some((cell) => tooLong(cell.text)))
      )
    case 'embed':
      return false
  }
}
