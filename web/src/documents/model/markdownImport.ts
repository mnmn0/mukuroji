import type {
  DocumentBlock,
  DocumentChecklistItem,
  DocumentHeadingBlock,
  DocumentTableRow,
} from '@mukuroji/contracts'
import {
  isMarkdownImportWithinParseLimits,
  readMarkdownImportStructure,
  type MarkdownImportStructure,
  type MarkdownLineRange,
} from './markdownStructure'

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

/**
 * Markdown that can tie blank-separated parts of a file together: a reference or footnote
 * definition, a footnote reference, or a list item, also inside a quote or a list.
 */
const MAY_SPAN_BLOCKS = /^[ \t>]*\[|\[\^|^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/mu

/** A link destination that reads back as written without `<>` or escapes. */
const PLAIN_DESTINATION = /^[^\s()<>\\&]+$/u

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
  const sourceLines = source.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u)
  if (sourceLines.every((line) => line.trim() === '')) {
    return { ok: false, code: 'empty' }
  }
  const text = sourceLines.join('\n')
  // Each block is rendered on its own, so the file's reference definitions are applied before it
  // is split, and blocks the file joins, such as a loose list or a footnote, are put back together.
  // The file is parsed only when it has a definition, a footnote, or a list item, is within the
  // parse limits, and a line scan with throwaway IDs has not rejected an oversized table.
  // A file the parser could take too long on is split by lines only, as before references were
  // made inline.
  const spans = MAY_SPAN_BLOCKS.test(text) && isMarkdownImportWithinParseLimits(text)
  if (spans) {
    const checked = scanBlocks(sourceLines, () => 'unused', options.resolveLink)
    if (!checked.ok) return checked
  }
  // Every destination a reference is written with stays in the page's text, so references that
  // add more than the page can hold are refused before the long text is built.
  const structure = spans ? readMarkdownImportStructure(text, options.resolveLink, MAX_CONTENT_BYTES) : undefined
  if (structure === 'too-large') return { ok: false, code: 'too-large' }
  const scanned = scanBlocks(
    structure?.text.split('\n') ?? sourceLines,
    options.createId,
    options.resolveLink,
    structure?.topLevelBlocks,
  )
  if (!scanned.ok) return scanned
  let body = structure === undefined
    ? scanned.blocks
    : keepFileBlocksTogether(scanned.blocks, scanned.paragraphLines, structure)

  let title = options.fallbackTitle
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
 * @param topLevelBlocks - Lines of each top-level block of the parsed file, when it was parsed.
 *   A task item becomes a checklist only in a top-level list of task items alone; one nested in
 *   another list, or next to other items, stays in that list's paragraph Markdown.
 * @returns Scanned blocks, or a table that exceeds the server limits.
 */
function scanBlocks(
  lines: readonly string[],
  createId: (prefix: string) => string,
  resolveLink?: (href: string) => string | undefined,
  topLevelBlocks?: readonly MarkdownLineRange[],
):
  | { ok: true; blocks: ScannedBlock[]; paragraphLines: Map<string, MarkdownLineRange> }
  | { ok: false; code: 'table-too-large' } {
  const blocks: ScannedBlock[] = []
  /** Source lines of each paragraph block, by block ID. */
  const paragraphLines = new Map<string, MarkdownLineRange>()
  /** Rewrites link targets with the resolver, or keeps the text as written. */
  const rewrite: LinkRewriter = resolveLink
    ? (raw) => rewriteLinkTargets(raw, resolveLink)
    : (raw) => raw
  /** Whether each top-level block is a list of task items alone, once worked out. */
  const checklistBlocks = new Map<MarkdownLineRange, boolean>()
  let paragraph: string[] = []
  let paragraphFirstLine = 0
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const raw = paragraph.join('\n')
    const range = { first: paragraphFirstLine, last: paragraphFirstLine + paragraph.length - 1 }
    paragraph = []
    const link = readStandaloneLink(raw)
    // A target in `<>` may hold spaces, so only a target the resolver rewrites becomes an embed.
    const url = link
      ? (resolveLink?.(link.href) ?? (!link.angle && isEmbeddableUrl(link.href) ? link.href : undefined))
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
    const id = createId('block')
    paragraphLines.set(id, range)
    blocks.push({
      id,
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

    if (TASK_ITEM.test(line) && startsChecklist(lines, index, topLevelBlocks, checklistBlocks)) {
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
        task = startsChecklist(lines, index, topLevelBlocks, checklistBlocks) ? TASK_ITEM.exec(lines[index] ?? '') : null
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

    if (paragraph.length === 0) paragraphFirstLine = index
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return { ok: true, blocks, paragraphLines }
}

/**
 * Tells whether a task item line may be read as a checklist item. Without a parsed file, every
 * task item line may. Otherwise the line's top-level block must be a list of task items alone,
 * all at the indent of its first line, as the export writes a checklist; a task item nested in
 * another item, or in a list with other items, would lose its place in that list as a checklist.
 *
 * @param lines - Source lines.
 * @param index - Line of the task item.
 * @param topLevelBlocks - Lines of each top-level block of the parsed file.
 * @param cache - Answers already worked out, by top-level block.
 * @returns Whether the line may start or continue a checklist.
 */
function startsChecklist(
  lines: readonly string[],
  index: number,
  topLevelBlocks: readonly MarkdownLineRange[] | undefined,
  cache: Map<MarkdownLineRange, boolean>,
): boolean {
  if (topLevelBlocks === undefined) return true
  const range = topLevelBlocks.find(({ first, last }) => first <= index && index <= last)
  if (range === undefined) return true
  const known = cache.get(range)
  if (known !== undefined) return known
  const answer = isTaskItemList(lines, range)
  cache.set(range, answer)
  return answer
}

/**
 * Tells whether a top-level block is a list of task items alone, all at its first line's indent.
 *
 * @param lines - Source lines.
 * @param range - Lines of the block.
 * @returns Whether every non-blank line is such a task item.
 */
function isTaskItemList(lines: readonly string[], range: MarkdownLineRange): boolean {
  const indent = /^[ \t]*/u.exec(lines[range.first] ?? '')?.[0] ?? ''
  for (let line = range.first; line <= range.last; line += 1) {
    const text = lines[line] ?? ''
    if (text.trim() === '') continue
    if (!TASK_ITEM.test(text) || /^[ \t]*/u.exec(text)?.[0] !== indent) return false
  }
  return true
}

/**
 * Puts back together the paragraph blocks that the file joins but blank lines split: paragraphs
 * of one top-level block, such as the items of a loose list, become one block, and a footnote
 * definition is added to each block that uses it, since each block is rendered on its own.
 *
 * @param blocks - Scanned blocks, in order.
 * @param paragraphLines - Source lines of each paragraph block, by block ID.
 * @param structure - Structure of the whole file.
 * @returns The blocks with split paragraphs joined and footnotes moved to their use.
 */
function keepFileBlocksTogether(
  blocks: readonly ScannedBlock[],
  paragraphLines: ReadonlyMap<string, MarkdownLineRange>,
  structure: MarkdownImportStructure,
): ScannedBlock[] {
  const lines = new Map(paragraphLines)
  const joined: ScannedBlock[] = []
  for (const block of blocks) {
    const previous = joined.at(-1)
    const previousLines = previous?.type === 'paragraph' ? lines.get(previous.id) : undefined
    const blockLines = block.type === 'paragraph' ? lines.get(block.id) : undefined
    if (
      previous?.type === 'paragraph' && block.type === 'paragraph' && previousLines && blockLines &&
      structure.topLevelBlocks.some((range) => range.first <= previousLines.last && range.last >= blockLines.first)
    ) {
      joined[joined.length - 1] = {
        ...previous,
        text: `${previous.text}${'\n'.repeat(blockLines.first - previousLines.last)}${block.text}`,
      }
      lines.set(previous.id, { first: previousLines.first, last: blockLines.last })
      continue
    }
    joined.push(block)
  }

  const paragraphs = joined.filter(isScannedParagraph)
  /**
   * Finds the paragraph block that holds a source line.
   *
   * @param line - Source line.
   * @returns The block, or `undefined` when no paragraph block holds the line.
   */
  const paragraphAt = (line: number) => paragraphs.find((block) => {
    const range = lines.get(block.id)
    return range !== undefined && range.first <= line && line <= range.last
  })
  /**
   * Finds the definition of a footnote; as with the renderer, the first one counts.
   *
   * @param identifier - Normalized footnote label.
   * @returns The definition, or `undefined` when the file has none.
   */
  const definitionOf = (identifier: string) =>
    structure.footnoteDefinitions.find((candidate) => candidate.identifier === identifier)
  /** Whether a block starts with a footnote definition, so it moves to the blocks that use it. */
  const holdsDefinition = (range: MarkdownLineRange) =>
    structure.footnoteDefinitions.some(({ first }) => first === range.first)
  /** Text added to the end of each block, by block ID, each kept once by its key. */
  const attachments = new Map<string, Array<{ key: string; text: string }>>()
  const moved = new Set<string>()
  const sourceLines = structure.text.split('\n')
  for (const block of paragraphs) {
    const range = lines.get(block.id)
    if (!range || holdsDefinition(range)) continue
    // A definition may use other footnotes, so every definition the block reaches through its
    // references moves with it; each label is followed once, so a cycle ends.
    const pending = structure.footnoteReferences
      .filter(({ line }) => range.first <= line && line <= range.last)
      .map(({ identifier }) => identifier)
    const followed = new Set<string>()
    while (pending.length > 0) {
      const identifier = pending.shift() ?? ''
      if (followed.has(identifier)) continue
      followed.add(identifier)
      const definition = definitionOf(identifier)
      if (!definition) continue
      pending.push(...structure.footnoteReferences
        .filter(({ line }) => definition.first <= line && line <= definition.last)
        .map((reference) => reference.identifier))
      const holder = paragraphAt(definition.first)
      if (!holder || holder === block) continue
      const attached = attachments.get(block.id) ?? []
      // A block that starts with the definition moves whole. A definition inside another block,
      // such as a quote, is copied without the text around it, which stays where it is.
      const holderStart = lines.get(holder.id)?.first
      const nested = holderStart !== definition.first || !FOOTNOTE_DEFINITION_START.test(sourceLines[definition.first] ?? '')
      const attachment = nested
        ? { key: `footnote:${identifier}`, text: extractNestedDefinition(sourceLines, definition) }
        : { key: `block:${holder.id}`, text: holder.text }
      if (!attached.some(({ key }) => key === attachment.key)) attachments.set(block.id, [...attached, attachment])
      if (!nested) moved.add(holder.id)
    }
  }
  return joined.flatMap((block): ScannedBlock[] => {
    if (block.type !== 'paragraph') return [block]
    if (moved.has(block.id)) return []
    const attached = (attachments.get(block.id) ?? []).map(({ text }) => text)
    return [{ ...block, text: [block.text, ...attached].join('\n\n') }]
  })
}

/** A footnote definition at the start of a line, outside any container. */
const FOOTNOTE_DEFINITION_START = /^ {0,3}\[\^/u

/**
 * Copies a footnote definition that sits inside another block, such as a quote or a list item,
 * without that block's markers: the markers before `[^` on its first line are removed from every
 * line of the definition that starts with them.
 *
 * @param lines - Source lines of the file.
 * @param definition - Lines of the definition.
 * @returns The definition's Markdown.
 */
function extractNestedDefinition(lines: readonly string[], definition: MarkdownLineRange): string {
  const first = lines[definition.first] ?? ''
  const prefix = first.slice(0, Math.max(0, first.indexOf('[^')))
  // A quote marker may be written without its space on a blank line of the definition.
  const barePrefix = prefix.trimEnd()
  return lines.slice(definition.first, definition.last + 1)
    .map((line) => line.startsWith(prefix)
      ? line.slice(prefix.length)
      : line.trimEnd() === barePrefix ? '' : line)
    .join('\n')
}

/**
 * Tells whether a scanned block is a paragraph.
 *
 * @param block - Scanned block.
 * @returns Whether the block is a paragraph block.
 */
function isScannedParagraph(block: ScannedBlock): block is Extract<ScannedBlock, { type: 'paragraph' }> {
  return block.type === 'paragraph'
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
 * Reads a paragraph that consists of exactly one inline link, `[label](href)` or
 * `[label](<href>)`.
 *
 * @param raw - Raw paragraph text, before escapes are removed.
 * @returns The raw label, the target with its escapes removed, and whether it was written in
 *   `<>`, or undefined when the paragraph holds anything else, spans lines, or the link has a
 *   title.
 */
function readStandaloneLink(
  raw: string,
): { label: string; href: string; angle: boolean } | undefined {
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
  const destination = readLinkDestination(text, position + 2)
  if (!destination || destination.titled || destination.close !== text.length - 1) return undefined
  return { label: text.slice(1, position), href: destination.href, angle: destination.angle }
}

/** Where the destination of an inline link is and what it says. */
type LinkDestination = {
  /** Offset of the destination, including its `<` when it has one. */
  start: number
  /** Offset after the destination, including its `>` when it has one. */
  end: number
  /** Offset of the `)` that closes the link. */
  close: number
  /** The destination with its `<>` and backslash escapes removed. */
  href: string
  /** Whether the destination is written in `<>`. */
  angle: boolean
  /** Whether a title follows the destination. */
  titled: boolean
}

/**
 * Reads the destination and optional title of an inline link, from just after its `(` up to the
 * closing `)`. A destination is either written in `<>`, which may hold spaces, or is a run
 * without spaces or parentheses. Each part stops at a character that every following link also
 * has, so rescanning after a failed read does not grow with the text.
 *
 * @param text - Raw Markdown text.
 * @param open - Offset just after the `(`.
 * @returns The destination, or undefined when the text there is not a destination this import
 *   rewrites.
 */
function readLinkDestination(text: string, open: number): LinkDestination | undefined {
  /**
   * Skips spaces and tabs.
   *
   * @param from - Offset to start at.
   * @returns The offset of the next other character.
   */
  const skipSpace = (from: number) => {
    let index = from
    while (text[index] === ' ' || text[index] === '\t') index += 1
    return index
  }
  const start = skipSpace(open)
  let end = start
  const angle = text[start] === '<'
  if (angle) {
    end += 1
    while (end < text.length && text[end] !== '>') {
      const character = text[end]
      if (character === '\n' || character === '<') return undefined
      end += character === '\\' ? 2 : 1
    }
    if (text[end] !== '>') return undefined
    end += 1
  } else {
    while (end < text.length && !/[\s()]/u.test(text[end] ?? '')) end += text[end] === '\\' ? 2 : 1
    if (end === start) return undefined
  }
  const href = unescapeMarkdown(angle ? text.slice(start + 1, end - 1) : text.slice(start, end))
  let close = skipSpace(end)
  let titled = false
  const quote = text[close]
  if (close > end && (quote === '"' || quote === "'" || quote === '(')) {
    const closing = quote === '(' ? ')' : quote
    // A title in parentheses holds no unescaped `(`, so the scan stops at the next link's `(`;
    // a quoted title stops at the next same quote. Each scan ends where the next could start.
    let index = close + 1
    while (index < text.length && text[index] !== closing && !(quote === '(' && text[index] === '(')) {
      index += text[index] === '\\' ? 2 : 1
    }
    if (text[index] !== closing) return undefined
    titled = true
    close = skipSpace(index + 1)
  }
  return text[close] === ')' ? { start, end, close, href, angle, titled } : undefined
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
 * Rewrites the targets of inline links, `[label](href)`, `[label](<href>)`, and either with a
 * title, in raw Markdown text. Escaped brackets and code spans are left alone. The scan is linear, so long
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
      const destination = readLinkDestination(raw, position + 2)
      const target = destination ? resolveLink(destination.href) : undefined
      if (destination && target !== undefined) {
        // A page link is written without `<>`, as the text of table cells and checklist items only
        // recognizes `[label](/documents/<id>)`.
        result += raw.slice(position, destination.start) +
          (PLAIN_DESTINATION.test(target) ? target : `<${target.replace(/[\\<>&]/gu, '\\$&')}>`) +
          raw.slice(destination.end, destination.close + 1)
        position = destination.close + 1
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
