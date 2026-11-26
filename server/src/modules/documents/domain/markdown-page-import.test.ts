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
      '| --- | :-: |',
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

    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps lists, quotes, reference links, and their blank lines together in one paragraph', () => {
    const source = 'Intro [docs][1].\n\n- one\n\n  continued\n- two\n\n> quote\n\n[1]: https://example.com'

    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('keeps a fence nested in a list inside the paragraph, with headings in it', () => {
    const source = '1. Step\n   ```sh\n   # comment\n   ```\n2. Next'

    expect(convert(source).blocks).toEqual([{ id: expect.any(String), type: 'paragraph', text: source }])
  })

  test('reads a task item run only as a whole block', () => {
    expect(convert('Text\n- [ ] not a checklist').blocks.map(({ type }) => type)).toEqual(['paragraph'])
    expect(convert('- [ ] task\n- plain').blocks.map(({ type }) => type)).toEqual(['paragraph'])
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
    expect(refuse('b'.repeat(DOCUMENT_MAX_TEXT_LENGTH + 1))).toEqual({ ok: false, code: 'block-too-long' })
    expect(refuse('c'.repeat(MARKDOWN_PAGE_IMPORT_MAX_LENGTH + 1))).toEqual({ ok: false, code: 'too-large' })
    expect(refuse(Array.from({ length: 501 }, (_, index) => `## H${index}`).join('\n'))).toEqual({ ok: false, code: 'too-many-blocks' })
  })
})
