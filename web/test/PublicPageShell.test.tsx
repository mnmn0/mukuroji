import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { PublicPageShell } from '../src/pages/PublicPageShell'

describe('PublicPageShell', () => {
  test('limits the locale selector to page-supported locales', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PublicPageShell
          availableLocales={['en']}
          initialLocale="en"
          locale="en"
          titleKey="requests.public.pageTitle"
        >
          {() => <p>Request form</p>}
        </PublicPageShell>
      </MemoryRouter>,
    )

    expect(html).toContain('<option value="en" selected="">English</option>')
    expect(html).not.toContain('<option value="ja"')
  })
})
