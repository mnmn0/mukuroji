/**
 * Limits of the Markdown text one parse reads. The Markdown parser takes far longer than a
 * text's length on some input: its time grows with the square of the emphasis, strikethrough,
 * closing bracket, and table delimiters and of the punctuation in each blank-line separated
 * part, and with lines, list or quote markers, and nesting. The server's Markdown export keeps
 * its own copy of these measures, since workspaces do not share code.
 */
export type MarkdownParseLimits = {
  /** Most `*`, `_`, `~`, `]`, and `|` characters of one part. */
  partDelimiters: number
  /** Most of the squares of those counts of all the parts. */
  documentDelimiterSquares: number
  /** Most ASCII punctuation characters of one part. */
  partPunctuation: number
  /** Most of the squares of those counts of all the parts. */
  documentPunctuationSquares: number
  /** Most lines of the text. */
  documentLines: number
  /** Most list and quote markers at line starts of the text. */
  documentContainers: number
  /** Most list and quote markers at the start of one line. */
  nesting: number
}

/**
 * Limits of a Markdown import file, which is parsed once as a whole: the parse stays at about a
 * second.
 */
export const MARKDOWN_IMPORT_PARSE_LIMITS: MarkdownParseLimits = {
  partDelimiters: 3_000,
  documentDelimiterSquares: 25_000_000,
  partPunctuation: 10_000,
  documentPunctuationSquares: 300_000_000,
  documentLines: 20_000,
  documentContainers: 20_000,
  nesting: 8,
}

/**
 * Limits of one Markdown body drawn on a page, such as a Document paragraph, which is parsed on
 * each render and shown next to many others: one parse stays under about a tenth of a second.
 */
export const MARKDOWN_RENDER_PARSE_LIMITS: MarkdownParseLimits = {
  partDelimiters: 1_000,
  documentDelimiterSquares: 4_000_000,
  partPunctuation: 5_000,
  documentPunctuationSquares: 100_000_000,
  documentLines: 1_000,
  documentContainers: 1_000,
  nesting: 8,
}

/** One list or quote marker at the start of a line, with the spaces before and after it. */
const MARKDOWN_CONTAINER_MARKER = /^[ \t]*(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]?/u

/** One ASCII punctuation character. */
const ASCII_PUNCTUATION_CHARACTER = /^[!-/:-@[-`{-~]$/u

/**
 * Tells, in one linear scan, whether the Markdown parser reads a text in bounded time.
 *
 * @param source - Markdown text.
 * @param limits - Limits the text must be within.
 * @returns Whether the text is within the limits.
 */
export function isMarkdownWithinParseLimits(source: string, limits: MarkdownParseLimits): boolean {
  const lines = source.split(/\r\n?|\n/u)
  if (lines.length > limits.documentLines) return false
  let containers = 0
  for (const line of lines) {
    let rest = line
    let depth = 0
    for (
      let marker = MARKDOWN_CONTAINER_MARKER.exec(rest);
      marker && marker[0] !== '';
      marker = MARKDOWN_CONTAINER_MARKER.exec(rest)
    ) {
      depth += 1
      rest = rest.slice(marker[0].length)
    }
    if (depth > limits.nesting) return false
    containers += depth
  }
  if (containers > limits.documentContainers) return false
  let delimiterSquares = 0
  let punctuationSquares = 0
  for (const part of source.split(/(?:\r\n?|\n)[ \t]*(?:\r\n?|\n)/u)) {
    let delimiters = 0
    let punctuation = 0
    for (const character of part) {
      if (character === '*' || character === '_' || character === '~' || character === ']' || character === '|') {
        delimiters += 1
      }
      if (ASCII_PUNCTUATION_CHARACTER.test(character)) punctuation += 1
    }
    if (delimiters > limits.partDelimiters || punctuation > limits.partPunctuation) return false
    delimiterSquares += delimiters ** 2
    punctuationSquares += punctuation ** 2
  }
  return delimiterSquares <= limits.documentDelimiterSquares &&
    punctuationSquares <= limits.documentPunctuationSquares
}
