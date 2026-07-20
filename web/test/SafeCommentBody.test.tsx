import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'

describe('SafeCommentBody', () => {
  test('renders GFM code, links, and checklists without executable HTML or unsafe URLs', () => {
    const html = renderToStaticMarkup(
      <SafeCommentBody
        bodyMarkdown={`<script>alert('xss')</script>

- [x] reviewed

\`safe-code\`

[safe](https://example.com) [unsafe](javascript:alert('xss'))

![tracking](https://example.com/pixel.png)`}
      />,
    )

    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('<code>safe-code</code>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
})
