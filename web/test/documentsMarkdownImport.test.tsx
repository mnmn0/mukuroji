import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocumentBlock } from '@mukuroji/contracts'
import {
  convertMarkdownToDocument,
  MARKDOWN_IMPORT_MAX_BLOCKS,
  titleFromMarkdownFileName,
} from '../src/documents/model/markdownImport'
import { DocumentHome } from '../src/documents/ui/DocumentHome'
import { SafeMarkdown } from '../src/shared/ui/SafeMarkdown'
import { createTranslator } from '../src/shared/i18n/i18n'

/**
 * Returns sequential IDs so converted blocks are deterministic.
 *
 * @returns ID factory.
 */
function createSequentialId() {
  let next = 0
  return (prefix: string) => `${prefix}-${++next}`
}

/**
 * Converts Markdown with a sequential ID factory.
 *
 * @param source - Markdown text.
 * @param fallbackTitle - Title used without a leading `#` heading.
 * @returns The conversion result.
 */
function convert(source: string, fallbackTitle = 'fallback') {
  return convertMarkdownToDocument(source, {
    createId: createSequentialId(),
    fallbackTitle,
  })
}

/**
 * Converts Markdown and returns its blocks, failing the test on an error.
 *
 * @param source - Markdown text.
 * @returns Converted blocks.
 */
function blocksOf(source: string): DocumentBlock[] {
  const result = convert(source)
  if (!result.ok) throw new Error(`conversion failed: ${result.code}`)
  return result.blocks
}

describe('Markdown import', () => {
  test('reads back a page exported as Markdown', () => {
    // Same layout as renderMarkdown in the server Document export: every
    // block, and every table line, is separated by one blank line.
    const exported = [
      '# 設計書 \\[draft\\]',
      '',
      '## 背景',
      '',
      '本文の 1 行目',
      '2 行目は \\*強調ではない\\*',
      '',
      '### 詳細',
      '',
      '| 項目 | 値 |',
      '',
      '| --- | --- |',
      '',
      '| a\\|b | 1<br>2 |',
      '',
      '| c | d |',
      '',
      '```ts',
      'const value = 1',
      '```',
      '',
      '- [ ] 宿題',
      '- [x] 済み',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
    ].join('\n')

    const result = convert(exported)
    if (!result.ok) throw new Error(result.code)
    expect(result.title).toBe('設計書 [draft]')
    expect(result.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'table',
      'code',
      'checklist',
      'diagram',
    ])
    expect(result.blocks[0]).toMatchObject({ level: 1, text: '背景' })
    // Paragraphs are shown as Markdown, so the escapes stay and the text renders literally.
    expect(result.blocks[1]).toMatchObject({ text: '本文の 1 行目\n2 行目は \\*強調ではない\\*' })
    expect(result.blocks[2]).toMatchObject({ level: 2, text: '詳細' })
    expect(result.blocks[3]).toMatchObject({
      columns: ['項目', '値'],
      rows: [
        { cells: [{ text: 'a|b' }, { text: '1\n2' }] },
        { cells: [{ text: 'c' }, { text: 'd' }] },
      ],
    })
    expect(result.blocks[4]).toMatchObject({ code: 'const value = 1', language: 'ts' })
    expect(result.blocks[5]).toMatchObject({
      items: [
        { checked: false, text: '宿題' },
        { checked: true, text: '済み' },
      ],
    })
    expect(result.blocks[6]).toMatchObject({ format: 'mermaid', source: 'graph TD; A-->B' })
    const ids = result.blocks.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('keeps several top-level headings as headings and uses the fallback title', () => {
    const result = convert('# A\n\ntext\n\n# B\n\n#### deep\n', 'notes')
    if (!result.ok) throw new Error(result.code)
    expect(result.title).toBe('notes')
    expect(result.blocks.flatMap((block) =>
      block.type === 'heading' ? [[block.level, block.text]] : [])).toEqual([
      [1, 'A'],
      [1, 'B'],
      [3, 'deep'],
    ])
  })

  test('keeps exported heading levels when the title heading is taken', () => {
    const blocks = blocksOf('# Title\n\n### Deep only\n')
    expect(blocks).toMatchObject([{ level: 2, text: 'Deep only', type: 'heading' }])
  })

  test('starts heading levels at the shallowest heading when there is no title', () => {
    const blocks = blocksOf('## Section\n\n### Sub\n')
    expect(blocks).toMatchObject([
      { level: 1, text: 'Section', type: 'heading' },
      { level: 2, text: 'Sub', type: 'heading' },
    ])
  })

  test('keeps lists, quotes, links, and HTML as plain paragraph text', () => {
    const blocks = blocksOf('- one\n- two\n\n> quote\n\n[link](javascript:alert(1)) <b>x</b>\n\n---\n')
    expect(blocks).toEqual([
      { id: 'block-1', text: '- one\n- two', type: 'paragraph' },
      { id: 'block-2', text: '> quote', type: 'paragraph' },
      { id: 'block-3', text: '[link](javascript:alert(1)) <b>x</b>', type: 'paragraph' },
    ])
  })

  test('keeps code fences verbatim and drops unsafe languages', () => {
    const blocks = blocksOf('~~~~ bad<lang>\n# not a heading\n\\*kept\\*\n~~~~\n\n```\nunterminated')
    expect(blocks).toEqual([
      { code: '# not a heading\n\\*kept\\*', id: 'block-1', type: 'code' },
      { code: 'unterminated', id: 'block-2', type: 'code' },
    ])
  })

  test('keeps two blank-separated exported tables apart', () => {
    const blocks = blocksOf([
      '| a | b |', '', '| --- | --- |', '', '| 1 | 2 |', '',
      '| x |', '', '| --- |', '', '| 9 |', '',
    ].join('\n'))
    expect(blocks).toMatchObject([
      { columns: ['a', 'b'], rows: [{ cells: [{ text: '1' }, { text: '2' }] }], type: 'table' },
      { columns: ['x'], rows: [{ cells: [{ text: '9' }] }], type: 'table' },
    ])
  })

  test('keeps dash-only cells as rows of an exported table', () => {
    const blocks = blocksOf([
      '| a | b |', '', '| --- | --- |', '', '| - | - |', '', '| 1 | 2 |', '',
    ].join('\n'))
    expect(blocks).toMatchObject([{
      columns: ['a', 'b'],
      rows: [
        { cells: [{ text: '-' }, { text: '-' }] },
        { cells: [{ text: '1' }, { text: '2' }] },
      ],
      type: 'table',
    }])
  })

  test('ends a table where a list or blockquote starts', () => {
    const blocks = blocksOf('| a |\n| --- |\n| value |\n- first | x\n- second\n> quote')
    expect(blocks).toEqual([
      {
        columns: ['a'],
        id: 'block-3',
        rows: [{ cells: [{ id: 'cell-2', text: 'value' }], id: 'row-1' }],
        type: 'table',
      },
      { id: 'block-4', text: '- first | x\n- second\n> quote', type: 'paragraph' },
    ])
  })

  test('rejects oversized tables before building every cell', () => {
    const wide = Array.from({ length: 40_000 }, () => 'c').join('|')
    const delimiter = Array.from({ length: 40_000 }, () => '-').join('|')
    const rows = Array.from({ length: 40_000 }, () => 'v').join('\n')
    const createId = (prefix: string) => `${prefix}-${++calls}`
    let calls = 0
    expect(convertMarkdownToDocument(`${wide}\n${delimiter}\n${rows}`, {
      createId,
      fallbackTitle: 'wide',
    })).toEqual({ code: 'table-too-large', ok: false })
    expect(calls).toBe(0)

    const longTable = ['| a |', '| --- |', ...Array.from({ length: 5_000 }, () => '| v |')].join('\n')
    calls = 0
    expect(convertMarkdownToDocument(longTable, { createId, fallbackTitle: 'long' }))
      .toEqual({ code: 'table-too-large', ok: false })
    expect(calls).toBeLessThanOrEqual(201 * 2)
  })

  test('keeps an inline code span with triple backticks as paragraph text', () => {
    expect(blocksOf('```example```\n\nnext')).toEqual([
      { id: 'block-1', text: '```example```', type: 'paragraph' },
      { id: 'block-2', text: 'next', type: 'paragraph' },
    ])
  })

  test('reports too many headings instead of throwing', () => {
    expect(convert('#\n'.repeat(149_999))).toEqual({ code: 'too-many-blocks', ok: false })
  })

  test('splits cells at a pipe after an escaped backslash', () => {
    const blocks = blocksOf('a | b\n--|--\npath\\\\|value\n')
    expect(blocks[0]).toMatchObject({
      rows: [{ cells: [{ text: 'path\\' }, { text: 'value' }] }],
    })
  })

  test('accepts an exported header whose cells look like dashes', () => {
    const blocks = blocksOf('| - | - |\n\n| --- | --- |\n\n| 1 | 2 |\n')
    expect(blocks).toMatchObject([{ columns: ['-', '-'], rows: [{ cells: [{ text: '1' }, { text: '2' }] }], type: 'table' }])
  })

  test('removes the opening fence indentation from code lines', () => {
    expect(blocksOf('  ```python\n  print(1)\n    nested\n  ```\n')).toEqual([
      { code: 'print(1)\n  nested', id: 'block-1', language: 'python', type: 'code' },
    ])
  })

  test('reads closing hashes and long space runs in headings quickly', () => {
    expect(blocksOf('## C# ##\n\n## Tail #\n\n## a#b')).toMatchObject([
      { text: 'C#' }, { text: 'Tail' }, { text: 'a#b' },
    ])
    const started = performance.now()
    blocksOf(`## a${' '.repeat(40_000)}x`)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('rejects a malformed delimiter row quickly', () => {
    const started = performance.now()
    const blocks = blocksOf(`| a |\n| ---${' '.repeat(40_000)}x`)
    expect(blocks[0]?.type).toBe('paragraph')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('rejects a long inline code span quickly', () => {
    const started = performance.now()
    const blocks = blocksOf(`\`\`\`${'a'.repeat(40_000)}\`\`\``)
    expect(blocks[0]?.type).toBe('paragraph')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('pads short table rows and ignores extra cells', () => {
    const blocks = blocksOf('a | b\n--|--\n1\n1 | 2 | 3\n')
    expect(blocks[0]).toMatchObject({
      columns: ['a', 'b'],
      rows: [
        { cells: [{ text: '1' }, { text: '' }] },
        { cells: [{ text: '1' }, { text: '2' }] },
      ],
    })
  })

  test('reports Markdown the server would reject', () => {
    expect(convert(' \n\n')).toEqual({ code: 'empty', ok: false })
    expect(convert(Array.from(
      { length: MARKDOWN_IMPORT_MAX_BLOCKS + 1 },
      (_, index) => `p${index}`,
    ).join('\n\n'))).toEqual({ code: 'too-many-blocks', ok: false })
    expect(convert('x'.repeat(50_001))).toEqual({ code: 'block-too-long', ok: false })
    expect(convert('a'.repeat(300_001))).toEqual({ code: 'too-large', ok: false })
    const fullTable = [
      `|${Array.from({ length: 50 }, () => 'c').join('|')}|`,
      `|${Array.from({ length: 50 }, () => '-').join('|')}|`,
      ...Array.from({ length: 200 }, () => `|${Array.from({ length: 50 }, () => 'v').join('|')}|`),
    ].join('\n')
    expect(convertMarkdownToDocument(fullTable, {
      createId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
      fallbackTitle: 'table',
    })).toEqual({ code: 'too-large', ok: false })
    const wideHeader = `|${Array.from({ length: 51 }, () => 'c').join('|')}|`
    const wideDelimiter = `|${Array.from({ length: 51 }, () => '-').join('|')}|`
    expect(convert(`${wideHeader}\n${wideDelimiter}\n`)).toEqual({
      code: 'table-too-large',
      ok: false,
    })
  })

  test('ignores a byte order mark and Windows line endings', () => {
    const result = convert('\uFEFF# Title\r\n\r\nbody\r\n')
    expect(result).toEqual({
      blocks: [{ id: 'block-1', text: 'body', type: 'paragraph' }],
      ok: true,
      title: 'Title',
    })
  })

  test('derives a title from the file name', () => {
    expect(titleFromMarkdownFileName('README.md')).toBe('README')
    expect(titleFromMarkdownFileName('議事録 11-20.markdown')).toBe('議事録 11-20')
    expect(titleFromMarkdownFileName('notes')).toBe('notes')
  })

  test('shows the import section on the Documents home only when importing is allowed', () => {
    const t = createTranslator('ja')
    const props = {
      documents: [],
      onSelectDocument: () => undefined,
      t,
      teams: [],
    }
    expect(renderToStaticMarkup(<DocumentHome {...props} />)).not.toContain('Markdown を取り込む')
    const markup = renderToStaticMarkup(
      <DocumentHome {...props} onImportMarkdown={async () => undefined} />,
    )
    expect(markup).toContain('Markdown を取り込む')
    expect(markup).toContain('type="file"')
    expect(markup).not.toContain('フォルダを取り込む')
    const withFolder = renderToStaticMarkup(
      <DocumentHome
        {...props}
        onImportMarkdown={async () => undefined}
        onImportMarkdownFolder={async () => undefined}
      />,
    )
    expect(withFolder).toContain('フォルダごと取り込む')
    expect(withFolder).toContain('フォルダを取り込む')
  })
})

/**
 * Markdown export of a page whose paragraph blocks use references, footnotes, and lists; pinned by
 * the server's block-scoped export test, which also exports {@link BLOCK_SCOPED_IMPORT} back to it.
 */
const BLOCK_SCOPED_EXPORT = [
  '# Document',
  'See [guide](<https://example.com/a>).',
  'See [guide](<https://example.com/b> "B \\& \\"t\\"").',
  '[ref](</c d>) and [ref](</c d>) and [![pic](</i.png>)](</c d>)',
  'text [nodef] here',
  'note[^5-1]\n\n[^5-1]: first',
  'other[^6-1]\n\n[^6-1]: second',
  '1. Alpha',
  '[mukuroji-block-boundary]: #',
  '1. Beta',
  '- a\n\n- b',
  '[mukuroji-block-boundary]: #',
  '- item',
  '[mukuroji-block-boundary]: #',
  '  continued',
].join('\n\n') + '\n'

/** Paragraph blocks of the exported page, as the app stores them before the export. */
const BLOCK_SCOPED_ORIGINAL = [
  'See [guide][ref].\n\n[ref]: https://example.com/a',
  'See [guide][ref].\n\n[ref]: https://example.com/b "B & \\"t\\""',
  '[ref][] and [ref] and [![pic][img]][ref]\n\n[ref]: </c d>\n[img]: /i.png',
  'text [nodef] here',
  'note[^n]\n\n[^n]: first',
  'other[^n]\n\n[^n]: second',
  '1. Alpha',
  '1. Beta',
  '- a\n\n- b',
  '- item',
  '  continued',
]

/** Paragraph blocks the import makes from {@link BLOCK_SCOPED_EXPORT}. */
const BLOCK_SCOPED_IMPORT = [
  'See [guide](<https://example.com/a>).',
  'See [guide](<https://example.com/b> "B \\& \\"t\\"").',
  '[ref](</c d>) and [ref](</c d>) and [![pic](</i.png>)](</c d>)',
  'text [nodef] here',
  'note[^5-1]\n\n[^5-1]: first',
  'other[^6-1]\n\n[^6-1]: second',
  '1. Alpha',
  '1. Beta',
  '- a\n\n- b',
  '- item',
  '  continued',
]

/**
 * Renders paragraph Markdown as a Document page does, with footnote labels left out, since a
 * label is not shown and only names the link between a footnote and its reference.
 *
 * @param markdown - Paragraph Markdown.
 * @returns The rendered HTML.
 */
function renderParagraph(markdown: string) {
  return renderToStaticMarkup(<SafeMarkdown bodyMarkdown={markdown} rawHtml="escape" />)
    .replace(/(fn(?:ref)?-)[^"#]+/gu, '$1label')
}

describe('Markdown import of a file whose blocks reference each other', () => {
  test('uses a reference definition from another part of the file as an inline link', () => {
    expect(blocksOf('[guide][ref]\n\n[ref]: https://example.com')).toEqual([
      { id: 'block-1', text: '[guide](<https://example.com>)', type: 'paragraph' },
    ])
    expect(blocksOf('![pic][img] and [x]\n\n[img]: /i.png "Pic"\n[x]: <a b>')).toEqual([
      { id: 'block-1', text: '![pic](</i.png> "Pic") and [x](<a b>)', type: 'paragraph' },
    ])
  })

  test('keeps a footnote definition with the block that uses it', () => {
    expect(blocksOf('One[^a] and two[^b].\n\nMiddle\n\n[^a]: First\n\n[^b]: Second')).toEqual([
      { id: 'block-1', text: 'One[^a] and two[^b].\n\n[^a]: First\n\n[^b]: Second', type: 'paragraph' },
      { id: 'block-2', text: 'Middle', type: 'paragraph' },
    ])
  })

  test('moves the footnotes a footnote uses along with it, once each and through cycles', () => {
    expect(blocksOf('Text[^a]\n\n[^a]: First[^b]\n\n[^b]: Second')).toEqual([
      { id: 'block-1', text: 'Text[^a]\n\n[^a]: First[^b]\n\n[^b]: Second', type: 'paragraph' },
    ])
    expect(blocksOf('One[^a]\n\nTwo[^b]\n\n[^a]: A[^b]\n\n[^b]: B[^a]')).toEqual([
      { id: 'block-1', text: 'One[^a]\n\n[^a]: A[^b]\n\n[^b]: B[^a]', type: 'paragraph' },
      { id: 'block-2', text: 'Two[^b]\n\n[^b]: B[^a]\n\n[^a]: A[^b]', type: 'paragraph' },
    ])
    const [chained] = blocksOf('Text[^a]\n\n[^a]: First[^b]\n\n[^b]: Second')
    const html = chained?.type === 'paragraph' ? renderParagraph(chained.text) : ''
    // Both notes are listed, so the reference inside the first note is a link, not literal text.
    expect(html).toContain('First<sup><a')
    expect(html).toContain('Second')
    expect(html).not.toContain('[^b]')
  })

  test('reads a file the parser could take too long on by lines only', () => {
    const dense = '*a'.repeat(3_001)
    expect(blocksOf(`[guide][ref]\n\n${dense}\n\n[ref]: https://example.com`)).toEqual([
      { id: 'block-1', text: '[guide][ref]', type: 'paragraph' },
      { id: 'block-2', text: dense, type: 'paragraph' },
      { id: 'block-3', text: '[ref]: https://example.com', type: 'paragraph' },
    ])
    expect(blocksOf(`[guide][ref]\n\n${'- '.repeat(9)}deep\n\n[ref]: /r`)[0]).toEqual(
      { id: 'block-1', text: '[guide][ref]', type: 'paragraph' },
    )
  })

  test('keeps a loose list in one block and drops the block boundary of an export', () => {
    expect(blocksOf('- a\n\n- b\n\n[mukuroji-block-boundary]: #\n\n- c')).toEqual([
      { id: 'block-1', text: '- a\n\n- b', type: 'paragraph' },
      // The second item was scanned as its own block before it was joined, so it used an ID.
      { id: 'block-3', text: '- c', type: 'paragraph' },
    ])
  })

  test('reads an exported page back into blocks that render as the page did', () => {
    const result = convert(BLOCK_SCOPED_EXPORT)
    if (!result.ok) throw new Error(`conversion failed: ${result.code}`)
    expect(result.title).toBe('Document')
    expect(result.blocks.map((block) => block.type === 'paragraph' ? block.text : block.type))
      .toEqual(BLOCK_SCOPED_IMPORT)
    expect(BLOCK_SCOPED_IMPORT.map(renderParagraph)).toEqual(BLOCK_SCOPED_ORIGINAL.map(renderParagraph))
  })
})
