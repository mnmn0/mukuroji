import { describe, expect, test } from 'bun:test'
import { matchRoutes, MemoryRouter } from 'react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { appRoutes } from '../src/app/router'
import { getWorkItemByKey, TeamIssuesApiError } from '../src/issues/api'
import { findWorkItemKeys, readWorkItemKeyInput } from '../src/work-items/model/workItemKeys'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'
import { WorkItemKeyActions } from '../src/issues/ui/WorkItemKeyActions'
import { WorkItemKeyStatus } from '../src/issues/ui/WorkItemKeyStatus'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createWorkItemKeyPath } from '../src/shared/routing/paths'

describe('Work Item keys in text', () => {
  test('finds keys that stand alone and skips look-alikes inside other words', () => {
    expect(findWorkItemKeys('See PT-12, (BACK-3) and PT-12.').map((match) => match.key))
      .toEqual(['PT-12', 'BACK-3', 'PT-12'])
    expect(findWorkItemKeys('x-PT-12 PT-12a PT-0 P-1 pt-12 ＡPT-12 PT-012')).toEqual([])
    expect(findWorkItemKeys('日本語PT-7の件')).toEqual([])
    expect(findWorkItemKeys('日本語 PT-7 の件')).toEqual([{ key: 'PT-7', index: 4 }])
  })

  test('reads a typed key in any case and rejects anything else', () => {
    expect(readWorkItemKeyInput('  pt-12 ')).toBe('PT-12')
    expect(readWorkItemKeyInput('PT-12 more')).toBeUndefined()
    expect(readWorkItemKeyInput('PT-0')).toBeUndefined()
    expect(readWorkItemKeyInput(undefined)).toBeUndefined()
  })

  test('links keys in comment text but not in code or existing links', () => {
    const html = renderToStaticMarkup(
      <SafeCommentBody bodyMarkdown={'Blocked by PT-12 and `PT-13`.\n\n[PT-14](https://example.com)\n\n```\nPT-15\n```'} />,
    )

    expect(html).toContain('href="/browse/PT-12"')
    expect(html).not.toContain('/browse/PT-13')
    expect(html).not.toContain('/browse/PT-14')
    expect(html).not.toContain('/browse/PT-15')
    expect(html).toContain('href="https://example.com"')
  })
})

describe('Work Item key URLs', () => {
  test('creates the lasting key URL and registers its page', () => {
    expect(createWorkItemKeyPath('PT-12')).toBe('/browse/PT-12')
    expect(matchRoutes(appRoutes, '/browse/PT-12')?.at(-1)?.route.path).toBe('/browse/:workItemKey')
  })

  test('resolves a key through the Work Item API and rejects a malformed answer', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    let body: unknown = { key: 'PT-12', teamId: 'core-team', workItemId: 'pt-12' }
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(typeof input === 'string' ? input : input.toString())
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }) as typeof fetch
    try {
      expect(await getWorkItemByKey('PT-12', 'token')).toEqual({ key: 'PT-12', teamId: 'core-team', workItemId: 'pt-12' })
      expect(requests[0]).toEndWith('/work-items/keys/PT-12')
      body = { key: 'PT-12', teamId: 'core-team' }
      await expect(getWorkItemByKey('PT-12', 'token')).rejects.toBeInstanceOf(TeamIssuesApiError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('WorkItemKeyActions', () => {
  test('shows the key with copy buttons', () => {
    const html = renderToStaticMarkup(
      <WorkItemKeyActions t={createTranslator('en')} workItemKey="PT-12" writeText={async () => {}} />,
    )

    expect(html).toContain('PT-12')
    expect(html).toContain('Copy key')
    expect(html).toContain('Copy link')
  })
})

describe('WorkItemKeyStatus', () => {
  /**
   * Renders the key page status in English for one lookup status.
   *
   * @param status - Lookup status to show.
   * @returns The rendered HTML.
   */
  const renderStatus = (status: 'loading' | 'invalid' | 'not-found' | 'failed') => renderToStaticMarkup(
    <MemoryRouter>
      <WorkItemKeyStatus onRetry={() => {}} status={status} t={createTranslator('en')} workItemKey="PT-12" />
    </MemoryRouter>,
  )

  test('offers a retry only after a failed lookup', () => {
    expect(renderStatus('loading')).not.toContain('Try again')
    expect(renderStatus('loading')).not.toContain('Search instead')
    expect(renderStatus('not-found')).not.toContain('Try again')
    expect(renderStatus('not-found')).toContain('Search instead')
    expect(renderStatus('failed')).toContain('Try again')
  })
})
