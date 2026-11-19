import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { readWebBuildInfo } from '../src/shared/release/webBuild'
import { createTranslator } from '../src/shared/i18n/i18n'
import { HelpWorkspaceView } from '../src/workspace/ui/HelpWorkspaceView'

const commitSha = '0123456789abcdef0123456789abcdef01234567'

describe('Web build identity', () => {
  test('accepts only one full lowercase Git commit SHA', () => {
    expect(readWebBuildInfo({ VITE_WEB_BUILD_COMMIT_SHA: commitSha })).toEqual({ commitSha })
    for (const value of [undefined, '', 'abc1234', commitSha.toUpperCase(), `${commitSha}0`, '<script>', 42]) {
      expect(readWebBuildInfo({ VITE_WEB_BUILD_COMMIT_SHA: value })).toEqual({ commitSha: undefined })
    }
  })

  test.each(['en', 'ja'] as const)('shows the running build on the Help screen in %s', (locale) => {
    const t = createTranslator(locale)
    const html = renderToStaticMarkup(
      <MemoryRouter><HelpWorkspaceView t={t} webBuild={{ commitSha }} /></MemoryRouter>,
    )
    expect(html).toContain('id="web-build"')
    expect(html).toContain(t('workspace.help.buildTitle'))
    expect(html).toContain(commitSha)
    expect(html).not.toContain(t('workspace.help.buildUnknown'))
  })

  test('labels builds made without a commit SHA', () => {
    const t = createTranslator('en')
    const html = renderToStaticMarkup(
      <MemoryRouter><HelpWorkspaceView t={t} webBuild={{ commitSha: undefined }} /></MemoryRouter>,
    )
    expect(html).toContain(t('workspace.help.buildUnknown'))
  })
})
