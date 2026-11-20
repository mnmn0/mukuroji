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
}

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

/** Opening line of a fenced code block. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/u

/** ATX heading line. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u

/** Task-list item line. */
const TASK_ITEM = /^ {0,3}[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/u

/** Thematic break line. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u

/** Table delimiter row. */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u

/** Code-fence language identifiers the server accepts. */
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u

/**
 * Converts Markdown into the title and blocks of one Document page.
 *
 * Headings, fenced code, Mermaid diagrams, task lists, and pipe tables become
 * their matching blocks; everything else stays as plain paragraph text, since
 * paragraphs store text rather than rendered Markdown. When the source starts
 * with the only `#` heading, as Markdown exported from a page does, that
 * heading becomes the title. Heading levels are shifted so the shallowest
 * remaining heading is level 1, and deeper ones stop at level 3.
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
  const scanned = scanBlocks(lines, options.createId)
  if (!scanned.ok) return scanned

  let title = options.fallbackTitle
  let body = scanned.blocks
  const first = body[0]
  const topLevelCount = body.filter(
    (block) => block.type === 'raw-heading' && block.rawLevel === 1,
  ).length
  if (first?.type === 'raw-heading' && first.rawLevel === 1 && topLevelCount === 1) {
    title = first.text.trim() || options.fallbackTitle
    body = body.slice(1)
  }

  const shallowest = Math.min(
    ...body.flatMap((block) => (block.type === 'raw-heading' ? [block.rawLevel] : [])),
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
  return {
    ok: true,
    title: title.slice(0, MAX_TITLE_LENGTH),
    blocks,
  }
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
 * @param lines - Source lines without line terminators.
 * @param createId - ID factory.
 * @returns Scanned blocks, or a table that exceeds the server limits.
 */
function scanBlocks(
  lines: readonly string[],
  createId: (prefix: string) => string,
):
  | { ok: true; blocks: ScannedBlock[] }
  | { ok: false; code: 'table-too-large' } {
  const blocks: ScannedBlock[] = []
  let paragraph: string[] = []
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        id: createId('block'),
        type: 'paragraph',
        text: unescapeMarkdown(paragraph.join('\n')),
      })
      paragraph = []
    }
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }

    const fence = FENCE_OPEN.exec(line)
    if (fence?.[1]) {
      flushParagraph()
      const marker = fence[1]
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`, 'u')
      const content: string[] = []
      index += 1
      while (index < lines.length && !close.test(lines[index] ?? '')) {
        content.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(createFencedBlock(fence[2] ?? '', content.join('\n'), createId))
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading?.[1]) {
      flushParagraph()
      blocks.push({
        type: 'raw-heading',
        rawLevel: heading[1].length,
        text: unescapeMarkdown((heading[2] ?? '').trim()),
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
          text: unescapeMarkdown((task[2] ?? '').trim()),
          checked: task[1] !== ' ',
        })
        index += 1
        task = TASK_ITEM.exec(lines[index] ?? '')
      }
      blocks.push({ id: createId('block'), type: 'checklist', items })
      continue
    }

    const delimiter = lines[index + 1] ?? ''
    if (line.includes('|') && delimiter.includes('|') && TABLE_DELIMITER.test(delimiter)) {
      const columns = splitTableRow(line)
      if (columns.length === splitTableRow(delimiter).length) {
        flushParagraph()
        index += 2
        const rows: DocumentTableRow[] = []
        while (index < lines.length && continuesTable(lines[index] ?? '')) {
          const cells = splitTableRow(lines[index] ?? '')
          rows.push({
            id: createId('row'),
            cells: columns.map((_, column) => ({
              id: createId('cell'),
              text: cells[column] ?? '',
            })),
          })
          index += 1
        }
        if (columns.length > MAX_TABLE_COLUMNS || rows.length > MAX_TABLE_ROWS) {
          return { ok: false, code: 'table-too-large' }
        }
        blocks.push({ id: createId('block'), type: 'table', columns, rows })
        continue
      }
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
 * Checks whether a line after a table's delimiter row is another row. As in
 * GitHub Flavored Markdown, rows continue until a blank line or the start of
 * another block.
 *
 * @param line - Line after the previous row.
 * @returns Whether the line is a table row.
 */
function continuesTable(line: string): boolean {
  return (
    line.trim() !== '' &&
    !FENCE_OPEN.test(line) &&
    !ATX_HEADING.test(line) &&
    !TASK_ITEM.test(line) &&
    !THEMATIC_BREAK.test(line)
  )
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
 * @returns Cell texts in column order.
 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let position = 0; position < trimmed.length; position += 1) {
    const character = trimmed[position]
    if (character === '\\' && trimmed[position + 1] === '|') {
      current += '\\|'
      position += 1
    } else if (character === '|') {
      cells.push(current)
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current)
  return cells.map((cell) =>
    unescapeMarkdown(cell.trim().replace(/<br\s*\/?>/giu, '\n')),
  )
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
