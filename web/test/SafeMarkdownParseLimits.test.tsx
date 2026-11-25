import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocumentReadOnlyBlock } from '../src/documents/ui/DocumentEditor'
import { createTranslator } from '../src/shared/i18n/i18n'
import { SafeMarkdown } from '../src/shared/ui/SafeMarkdown'

/** Paragraph dense with emphasis delimiters, which the Markdown parser takes seconds on. */
const DENSE_EMPHASIS = `start\n  ${'*a'.repeat(25_000)}`

describe('Markdown bodies the parser could take too long on', () => {
  test('are shown without the Markdown pipeline as plain text with their spacing and a note', () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown bodyMarkdown={DENSE_EMPHASIS} complexityNotice="Too complex" rawHtml="escape" />,
    )

    // Only the path that skips the parser writes the body into one pre-wrapped paragraph as is.
    expect(html).toContain(`<p class="whitespace-pre-wrap">start\n  ${'*a'.repeat(25_000)}</p>`)
    expect(html).toContain('<p class="mt-1 text-xs text-[var(--workbench-muted)]" role="note">Too complex</p>')
    expect(html).not.toContain('<em>')
  })

  test('are shown as plain text with the note in a Document paragraph', () => {
    const html = renderToStaticMarkup(
      <DocumentReadOnlyBlock
        block={{ id: 'block-1', type: 'paragraph', text: DENSE_EMPHASIS }}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Formatting was skipped because this paragraph is too complex to display as Markdown.')
    expect(html).not.toContain('<em>')
  })

  test('are parsed as Markdown when within the limits or when no note is given', () => {
    expect(renderToStaticMarkup(<SafeMarkdown bodyMarkdown="*a* b" complexityNotice="Too complex" />))
      .toContain('<em>a</em>')
    expect(renderToStaticMarkup(<SafeMarkdown bodyMarkdown={`${'- '.repeat(9)}deep`} />)).toContain('<li>')
    expect(renderToStaticMarkup(<SafeMarkdown bodyMarkdown={`${'- '.repeat(9)}deep`} complexityNotice="Too complex" />))
      .toContain('role="note"')
  })
})
