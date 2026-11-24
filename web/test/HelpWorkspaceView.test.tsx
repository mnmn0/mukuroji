import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../src/shared/i18n/i18n'
import { HelpWorkspaceView } from '../src/workspace/ui/HelpWorkspaceView'

const guideBaseUrl = 'https://github.com/mnmn0/mukuroji/blob/main/docs/guide/'

/**
 * Builds the heading anchor GitHub generates for a Markdown heading.
 *
 * @param heading - Heading text without the leading `#` marks.
 * @returns The lowercase anchor with punctuation removed and spaces turned into hyphens.
 */
function githubHeadingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/**
 * Lists the heading anchors of one guide page.
 *
 * @param fileName - Guide file name inside `docs/guide/`.
 * @returns Anchors of every Markdown heading in the page.
 */
function readGuideAnchors(fileName: string): Set<string> {
  const markdown = readFileSync(new URL(`../../docs/guide/${fileName}`, import.meta.url), 'utf8')
  const anchors = new Set<string>()
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6} (.+)$/.exec(line)
    if (match?.[1] !== undefined) anchors.add(githubHeadingAnchor(match[1]))
  }
  return anchors
}

/**
 * Renders the Help view to static HTML for one locale.
 *
 * @param locale - UI language to render.
 * @returns The rendered markup.
 */
function renderHelp(locale: 'en' | 'ja'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HelpWorkspaceView t={createTranslator(locale)} webBuild={{ commitSha: undefined }} />
    </MemoryRouter>,
  )
}

describe('Help feature guides', () => {
  test.each(['en', 'ja'] as const)('summarizes each feature with its screen in %s', (locale) => {
    const t = createTranslator(locale)
    const html = renderHelp(locale)
    expect(html).toContain('id="feature-guides"')
    expect(html).toContain(t('workspace.help.featureGuidesTitle'))
    for (const route of ['/projects', '/planning', '/updates', '/reports', '/my-tasks', '/focus', '/inbox', '/settings']) {
      expect(html).toContain(`href="${route}"`)
    }
    expect(html).toContain(t('workspace.help.featureFocusDescription'))
  })

  test('links every feature to an existing heading of the user guide', () => {
    const html = renderHelp('ja')
    const links = [...html.matchAll(/href="https:\/\/github\.com\/mnmn0\/mukuroji\/blob\/main\/docs\/guide\/([^"#]+)#([^"]+)"/g)]
    expect(links.length).toBe(8)
    for (const [, fileName, anchor] of links) {
      if (fileName === undefined || anchor === undefined) throw new Error('Unexpected guide link shape')
      expect(readGuideAnchors(fileName)).toContain(anchor)
    }
    expect(html).toContain(`href="${guideBaseUrl}pm.md"`)
  })
})
