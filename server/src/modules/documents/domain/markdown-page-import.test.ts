import { describe, expect, test } from 'bun:test'
import type { DocumentBlock } from '@mukuroji/contracts'
import { convertMarkdownToPageBlocks, MARKDOWN_PAGE_IMPORT_MAX_LENGTH } from './markdown-page-import'
import { DOCUMENT_MAX_TEXT_LENGTH } from './document-limits'

/**
 * Converts Markdown with sequential IDs, failing the test when the conversion is refused.
 *
 * @param source - Markdown text.
 * @returns The page blocks and the left-out title.
 */
function convert(source: string): { blocks: DocumentBlock[], leadingTitle?: string } {
  let next = 0
  const result = convertMarkdownToPageBlocks(source, (prefix) => `${prefix}-${++next}`)
  if (!result.ok) throw new Error(`Conversion failed: ${result.code}`)
  return result
}

describe('convertMarkdownToPageBlocks', () => {
  test('makes headings, code, Mermaid diagrams, checklists, and tables native blocks', () => {
    const { blocks } = convert([
      '## Goals',
      '',
      '- [ ] Draft',
      '- [x] Review',
      '',
      '```ts',
      'const a = 1',
      '',
      '# not a heading',
      '```',
      '',
      '~~~mermaid',
      'graph TD; A-->B',
      '~~~',
      '',
      '| Name | Owner |',
      '| --- | --- |',
      '| API | Kai |',
      '',
      '### Notes',
    ].join('\n'))

    expect(JSON.parse(JSON.stringify(blocks, (key, value: unknown) => key === 'id' ? undefined : value))).toEqual([
      { type: 'heading', level: 1, text: 'Goals' },
      { type: 'checklist', items: [{ text: 'Draft', checked: false }, { text: 'Review', checked: true }] },
      { type: 'code', language: 'ts', code: 'const a = 1\n\n# not a heading' },
      { type: 'diagram', format: 'mermaid', source: 'graph TD; A-->B' },
      { type: 'table', columns: ['Name', 'Owner'], rows: [{ cells: [{ text: 'API' }, { text: 'Kai' }] }] },
      { type: 'heading', level: 2, text: 'Notes' },
    ])
    expect(new Set(blocks.map(({ id }) => id)).size).toBe(blocks.length)
  })

  test('leaves out a single leading # heading, as an export writes the title, and keeps the levels', () => {
    const { blocks, leadingTitle } = convert('# Plan\n\n## Scope\n\nText\n\n### Detail\n\n#### Deeper')

    expect(leadingTitle).toBe('Plan')
    expect(blocks.map((block) => block.type === 'heading' ? `h${block.level} ${block.text}` : block.type))
      .toEqual(['h1 Scope', 'paragraph', 'h2 Detail', 'h3 Deeper'])
  })

  test('leaves out an exported title with escaped Markdown, so a round trip adds no copy', () => {
    const { blocks, leadingTitle } = convert('# Plan\\_1\n\n## Scope\n\nText')

    expect(leadingTitle).toBe('Plan_1')
    expect(blocks.map((block) => block.type === 'heading' ? `h${block.level} ${block.text}` : block.type))
      .toEqual(['h1 Scope', 'paragraph'])
    expect(convert('# A\n\n```\n# inside code\n```').leadingTitle).toBe('A')
    expect(convert('# A\n\n# B_2').leadingTitle).toBeUndefined()
  })

  test('keeps Markdown with reference or footnote definitions whole in one paragraph', () => {
    const source = 'See [docs][ref] and [^note].\n\n## Details\n\n- [ ] task\n\n[ref]: https://example.com\n\n[^note]: first\n\n    second'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
    expect(convert(`# Plan\n\n${source}`)).toMatchObject({ leadingTitle: 'Plan', blocks: [{ type: 'paragraph', text: source }] })

    const inCode = convert('See [ref].\n\n## Example\n\n- item\n\n  ```text\n  [ref]: https://example.com\n  ```').blocks
    expect(inCode.map(({ type }) => type)).toEqual(['paragraph', 'heading', 'paragraph'])
    const inComment = convert('See [ref].\n\n## Example\n\n<!--\n[ref]: https://example.com\n-->').blocks
    expect(inComment.map(({ type }) => type)).toEqual(['paragraph', 'heading', 'paragraph'])
    const nextLine = 'See [docs][ref].\n\n## Details\n\n[ref]:\n  https://example.com'
    expect(convert(nextLine).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: nextLine }])
    const indented = '    literal code\n\nSee [ref].\n\n[ref]: https://example.com'
    expect(convert(`\n\n${indented}\n\n`).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: indented }])
    expect(convertMarkdownToPageBlocks(`[ref]: https://example.com\n\n${'x'.repeat(DOCUMENT_MAX_TEXT_LENGTH)}`, (prefix) => prefix))
      .toEqual({ ok: false, code: 'block-too-long' })
  })

  test('shifts levels so the shallowest heading is level 1 when there is no single title heading', () => {
    const { blocks, leadingTitle } = convert('# One\n\n# Two\n\n## Sub')

    expect(leadingTitle).toBeUndefined()
    expect(blocks.map((block) => block.type === 'heading' ? `h${block.level} ${block.text}` : block.type))
      .toEqual(['h1 One', 'h1 Two', 'h2 Sub'])
  })

  test('keeps Markdown a native block would show differently in paragraph Markdown', () => {
    const source = [
      '## Uses **bold**',
      '',
      '- [ ] Has [a link](https://example.com)',
      '',
      '| a | b |',
      '| - | - |',
      '| `code` | x |',
    ].join('\n')

    expect(convert(source).blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: '## Uses **bold**' },
      { id: expect.any(String), type: 'paragraph', text: source.split('\n').slice(2).join('\n') },
    ])
  })

  test('keeps lists, quotes, reference links, and their blank lines together in one paragraph', () => {
    const source = 'Intro [docs][1].\n\n- one\n\n  continued\n- two\n\n> quote\n\n[1]: https://example.com'

    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps a fence nested in a list inside the paragraph, with headings in it', () => {
    const source = '1. Step\n   ```sh\n   # comment\n   ```\n2. Next'

    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps an indented code block that looks like a table as paragraph Markdown', () => {
    const source = 'Intro\n\n    | Name |\n    | --- |\n    | value |'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps HTML comments and task items with continuations as paragraph Markdown', () => {
    const comment = 'Intro\n<!--\n## Internal note\n\n```\ncode\n```\n-->'
    expect(convert(comment).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: comment }])
    const continued = '- [ ] task\n\n  continuation'
    expect(convert(continued).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: continued }])
    expect(convert('<!-- note -->\n\n## Real').blocks.map(({ type }) => type)).toEqual(['paragraph', 'heading'])
  })

  test('reads a task item run only as a whole block', () => {
    expect(convert('Text\n- [ ] not a checklist').blocks.map(({ type }) => type)).toEqual(['paragraph'])
    expect(convert('- [ ] task\n- plain').blocks.map(({ type }) => type)).toEqual(['paragraph'])
  })

  test('keeps a table or task list nested in a list item in the paragraph Markdown', () => {
    const nestedTable = '- item\n\n  | Name |\n  | --- |\n  | value |'
    expect(convert(nestedTable).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: nestedTable }])
    const nestedTasks = '1. step\n\n   - [ ] task'
    expect(convert(nestedTasks).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: nestedTasks }])
    expect(convert('- item\n\n| Name |\n| --- |\n| value |').blocks.map(({ type }) => type)).toEqual(['paragraph', 'table'])
  })

  test('keeps Markdown with a raw HTML block whole in one paragraph', () => {
    const pre = 'Intro\n\n<pre>\n## Literal heading\n</pre>\n\n## Real heading'
    expect(convert(pre).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: pre }])
    expect(convert('<!-- note -->\n\n## Heading').blocks.map(({ type }) => type)).toEqual(['paragraph', 'heading'])
    expect(convert('```html\n<div>\n```\n\n## Heading').blocks.map(({ type }) => type)).toEqual(['code', 'heading'])
  })

  test('keeps Markdown whole when a definition or HTML block sits in a list item or quote', () => {
    for (const source of [
      'See [docs][ref].\n\n## Details\n\n> [ref]: https://example.com',
      'See [docs][ref].\n\n## Details\n\n- [ref]: https://example.com',
      'Intro\n\n> <pre>\n> ## Literal\n> </pre>',
    ]) {
      expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
    }
  })

  test('normalizes Markdown headings with native headings so the hierarchy stays', () => {
    expect(convert('## **Overview**\n\n### Details').blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: '## **Overview**' },
      { id: expect.any(String), type: 'heading', level: 2, text: 'Details' },
    ])
    expect(convert('# Title\n\n## `code`\n\n### Sub').blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: '## `code`' },
      { id: expect.any(String), type: 'heading', level: 2, text: 'Sub' },
    ])
  })

  test('trims many blank lines in linear time', () => {
    const started = performance.now()
    expect(convert(`${'\n'.repeat(100_000)}Text${'\n'.repeat(100_000)}`).blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: 'Text' },
    ])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test('splits at the block boundary an export writes and drops it', () => {
    expect(convert('- [ ] task\n\n[mukuroji-block-boundary]: #\n\n- plain\n\n## Heading').blocks).toEqual([
      { id: expect.any(String), type: 'checklist', items: [expect.objectContaining({ text: 'task', checked: false })] },
      { id: expect.any(String), type: 'paragraph', text: '- plain' },
      { id: expect.any(String), type: 'heading', level: 1, text: 'Heading' },
    ])
    expect(convert('- one\n\n[mukuroji-block-boundary]: #\n\n- two').blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: '- one' },
      { id: expect.any(String), type: 'paragraph', text: '- two' },
    ])
  })

  test('normalizes Setext headings with the other headings', () => {
    expect(convert('Overview\n---\n\n### Details').blocks).toEqual([
      { id: expect.any(String), type: 'heading', level: 1, text: 'Overview' },
      { id: expect.any(String), type: 'heading', level: 2, text: 'Details' },
    ])
    expect(convert('Intro\n\n**Top**\n===\n\n## Sub').blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: 'Intro' },
      { id: expect.any(String), type: 'paragraph', text: '## **Top**' },
      { id: expect.any(String), type: 'heading', level: 2, text: 'Sub' },
    ])
    const multiLine = 'Two\nlines\n---\n\n### Details'
    expect(convert(multiLine).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: multiLine }])
    expect(convert('Text\n\n---\n\n## Heading').blocks.map(({ type }) => type)).toEqual(['paragraph', 'heading'])
  })

  test('finds the exported title past an indented fence with a heading line inside', () => {
    const result = convertMarkdownToPageBlocks('# Page\n\n ```text\n# literal\n ```', (prefix) => prefix)
    expect(result).toEqual({ ok: true, leadingTitle: 'Page', blocks: [expect.objectContaining({ type: 'paragraph' })] })
  })

  test('keeps text with autolinks as paragraph Markdown', () => {
    expect(convert('- [ ] Review https://example.com').blocks.map(({ type }) => type)).toEqual(['paragraph'])
    expect(convert('| a |\n| - |\n| mail me@example.com |').blocks.map(({ type }) => type)).toEqual(['paragraph'])
    expect(convert('- [ ] Review www.example.com').blocks.map(({ type }) => type)).toEqual(['paragraph'])
  })

  test('normalizes headings indented by up to three spaces', () => {
    expect(convert('  ## Overview\n\n### Details').blocks).toEqual([
      { id: expect.any(String), type: 'heading', level: 1, text: 'Overview' },
      { id: expect.any(String), type: 'heading', level: 2, text: 'Details' },
    ])
    const nested = '- item\n\n  ## Inside\n\n### Details'
    expect(convert(nested).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: nested }])
  })

  test('parses long heading lines in linear time', () => {
    const started = performance.now()
    const result = convertMarkdownToPageBlocks(`## a${' '.repeat(200_000)}b`, (prefix) => prefix)
    expect(result.ok).toBe(false)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(convert('## Closed ##').blocks).toEqual([{ id: expect.any(String), type: 'heading', level: 1, text: 'Closed' }])
    expect(convert('## C#').blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: '## C#' }])
  })

  test('finds the exported title past a heading line inside an HTML comment', () => {
    const result = convertMarkdownToPageBlocks('# Page\n\n<!--\n# hidden\n-->', (prefix) => prefix)
    expect(result).toEqual(expect.objectContaining({ ok: true, leadingTitle: 'Page' }))
  })

  test('finds a definition after a backtick line that opens no fence', () => {
    const source = 'See [docs][ref].\n\n## Details\n\n```bad`info\n\n[ref]: https://example.com'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps a first heading when indented backticks are code, not a fence', () => {
    const result = convertMarkdownToPageBlocks('# First\n\n    ```\n\n# Second', (prefix) => prefix)
    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('leadingTitle')
  })

  test('keeps two thematic breaks as Markdown rather than a heading', () => {
    const blocks = convert('---\n---').blocks
    expect(blocks.some((block) => block.type === 'heading')).toBe(false)
    expect(blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: '---\n---' }])
  })

  test('keeps a table with column alignment as Markdown', () => {
    const source = '| Amount |\n| ---: |\n| 123 |'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps deeper indented backticks inside a nested fence as code', () => {
    const source = '- item\n  ```text\n        ```\n  ## literal\n  ```'
    const blocks = convert(source).blocks
    expect(blocks.some((block) => block.type === 'heading')).toBe(false)
    const indented = convert(' ```text\n    ```\n## literal\n ```').blocks
    expect(indented.some((block) => block.type === 'heading')).toBe(false)
  })

  test('finds a definition after a fence closed at a wide list marker indentation', () => {
    const source = 'See [docs][ref].\n\n## Details\n\n100. ```text\n     code\n     ```\n\n[ref]: https://example.com'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('ends an unclosed fence with the quote it opened in', () => {
    const source = 'See [ref].\n\n## Details\n\n> ~~~\n> example\n\n[ref]: /docs'
    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('finds the title past a # line inside a pre block', () => {
    const result = convertMarkdownToPageBlocks('# Page\n\n<pre>\n# literal\n</pre>', (prefix) => prefix)
    expect(result).toEqual(expect.objectContaining({ ok: true, leadingTitle: 'Page' }))
  })

  test('keeps an indented block boundary line as code text', () => {
    const blocks = convert('Intro\n\n    [mukuroji-block-boundary]: #').blocks
    expect(JSON.stringify(blocks)).toContain('[mukuroji-block-boundary]: #')
  })

  test('keeps a list with a plain item after a blank line as Markdown', () => {
    expect(convert('- [ ] Draft\n\n- Review').blocks).toEqual([
      { id: expect.any(String), type: 'paragraph', text: '- [ ] Draft\n\n- Review' },
    ])
    expect(convert('- [ ] Draft\n\n- [x] Review').blocks).toEqual([{
      id: expect.any(String),
      type: 'checklist',
      items: [
        { id: expect.any(String), text: 'Draft', checked: false },
        { id: expect.any(String), text: 'Review', checked: true },
      ],
    }])
  })

  test('refuses to split one long numbered list into two', () => {
    const item = 'x'.repeat(30_000)
    expect(convertMarkdownToPageBlocks(`1. ${item}\n\n2. ${item}`, (prefix) => prefix))
      .toEqual({ ok: false, code: 'block-too-long' })
  })

  test('drops an unsafe code language and runs an unclosed fence to the end', () => {
    expect(convert('```bad lang!\nx').blocks).toEqual([{ id: expect.any(String), type: 'code', code: 'x', language: 'bad' }])
    expect(convert('```{weird}\nx\n```').blocks).toEqual([{ id: expect.any(String), type: 'code', code: 'x' }])
  })

  test('returns no blocks for empty Markdown', () => {
    expect(convert('').blocks).toEqual([])
    expect(convert('\n\n  \n').blocks).toEqual([])
  })

  test('splits long paragraph Markdown at blank lines and refuses what cannot fit', () => {
    const part = 'a'.repeat(30_000)
    const split = convert(`${part}\n\n${part}`).blocks
    expect(split.map((block) => block.type === 'paragraph' ? block.text.length : 0)).toEqual([30_000, 30_000])

    const refuse = (source: string) => convertMarkdownToPageBlocks(source, (prefix) => prefix)
    const fenced = `- item\n  \`\`\`\n  ${part}\n\n  ${part}\n  \`\`\``
    expect(refuse(fenced)).toEqual({ ok: false, code: 'block-too-long' })
    expect(refuse(`- item\n\n  ${part}\n\n  ${part}`)).toEqual({ ok: false, code: 'block-too-long' })
    expect(refuse('b'.repeat(DOCUMENT_MAX_TEXT_LENGTH + 1))).toEqual({ ok: false, code: 'block-too-long' })
    expect(refuse('c'.repeat(MARKDOWN_PAGE_IMPORT_MAX_LENGTH + 1))).toEqual({ ok: false, code: 'too-large' })
    expect(refuse(Array.from({ length: 501 }, (_, index) => `## H${index}`).join('\n'))).toEqual({ ok: false, code: 'too-many-blocks' })
  })
})
