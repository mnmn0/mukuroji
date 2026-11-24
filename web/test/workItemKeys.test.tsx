import { describe, expect, test } from 'bun:test'
import { matchRoutes, MemoryRouter } from 'react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { appRoutes } from '../src/app/router'
import { getWorkItemByKey, getWorkItemKeyPrefixes, TeamIssuesApiError, type TeamIssue } from '../src/issues/api'
import { loadWorkItemKeyLocation } from '../src/issues/queries/useWorkItemKeyLocation'
import { selectLinkableWorkItemKeyPrefixes, WorkItemKeyPrefixesContext } from '../src/issues/queries/workItemKeyPrefixesContext'
import { findWorkItemKeys, readWorkItemKeyInput } from '../src/work-items/model/workItemKeys'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'
import { WorkItemKeyActions } from '../src/issues/ui/WorkItemKeyActions'
import { WorkItemKeyStatus } from '../src/issues/ui/WorkItemKeyStatus'
import { SearchKeyJump } from '../src/search/SearchKeyJump'
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

  test('links Document paths written as text, but not inside code or other URLs', () => {
    const html = renderToStaticMarkup(
      <SafeCommentBody bodyMarkdown={'Spec: /documents/doc_12 (see PT-12).\n\n`/documents/doc_13`\n\nhttps://example.com/documents/doc_14 and a/documents/doc_15'} />,
    )

    expect(html).toMatch(/href="\/documents\/doc_12"[^>]*>\/documents\/doc_12<\/a>/)
    expect(html).toContain('href="/browse/PT-12"')
    expect(html).not.toContain('href="/documents/doc_13"')
    expect(html).not.toContain('href="/documents/doc_14"')
    expect(html).toContain('href="https://example.com/documents/doc_14"')
    expect(html).not.toContain('href="/documents/doc_15"')
  })
})

describe('Work Item key prefixes', () => {
  test('falls back to linking every key when a reload fails after a successful load', () => {
    expect(selectLinkableWorkItemKeyPrefixes(undefined, undefined)).toBeUndefined()
    expect(selectLinkableWorkItemKeyPrefixes([], undefined)).toEqual(new Set())
    expect(selectLinkableWorkItemKeyPrefixes(['PT'], undefined)).toEqual(new Set(['PT']))
    // SWR keeps the earlier list beside the error after the Team prefix changed and the reload failed.
    expect(selectLinkableWorkItemKeyPrefixes([], new Error('503'))).toBeUndefined()
  })

  test('finds only keys whose prefix exists when prefixes are known', () => {
    const prefixes = new Set(['PT', 'BACK'])
    expect(findWorkItemKeys('UTF-8, PT-12, ISO-8601 and BACK-3', prefixes).map((match) => match.key))
      .toEqual(['PT-12', 'BACK-3'])
    expect(findWorkItemKeys('UTF-8 PT-12', new Set())).toEqual([])
  })

  test('links only known prefixes in comment text', () => {
    const html = renderToStaticMarkup(
      <WorkItemKeyPrefixesContext.Provider value={new Set(['PT'])}>
        <SafeCommentBody bodyMarkdown="Encode UTF-8 before PT-12." />
      </WorkItemKeyPrefixesContext.Provider>,
    )

    expect(html).toContain('href="/browse/PT-12"')
    expect(html).not.toContain('/browse/UTF-8')
    expect(html).toContain('UTF-8')
  })

  test('loads prefixes from the Work Item API and rejects a malformed answer', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    let body: unknown = { prefixes: ['PT', 'BACK'] }
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(typeof input === 'string' ? input : input.toString())
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }) as typeof fetch
    try {
      expect(await getWorkItemKeyPrefixes('token')).toEqual(['PT', 'BACK'])
      expect(requests[0]).toEndWith('/work-items/key-prefixes')
      body = { prefixes: [1] }
      await expect(getWorkItemKeyPrefixes('token')).rejects.toBeInstanceOf(TeamIssuesApiError)
    } finally {
      globalThis.fetch = originalFetch
    }
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

  test('reloads a cached Team list that lacks the resolved Work Item before the redirect', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      requests.push(url)
      const body = url.includes('/work-items/keys/')
        ? { key: 'PT-12', teamId: 'core-team', workItemId: 'pt-12' }
        : { issues: [{ id: 'pt-12' }] }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }) as typeof fetch
    try {
      const stored: { key: readonly unknown[], issues: TeamIssue[] }[] = []
      /**
       * Builds a cache double whose Team list holds the given Work Item IDs.
       *
       * @param cachedIds - Work Item IDs in the cached list, or undefined for no cached list.
       * @returns Cache callbacks that record each stored list.
       */
      const cacheWith = (cachedIds?: string[]) => ({
        readTeamIssues: () => cachedIds?.map((id) => ({ id }) as TeamIssue),
        storeTeamIssues: async (key: readonly unknown[], issues: Promise<TeamIssue[]>) => {
          stored.push({ key, issues: await issues })
        },
      })

      await loadWorkItemKeyLocation('PT-12', 'token', cacheWith(['pt-1']))
      expect(stored).toHaveLength(1)
      expect(stored[0]?.key).toEqual(['team-issues', 'token', 'core-team', true])
      expect(stored[0]?.issues.map((issue) => issue.id)).toEqual(['pt-12'])
      expect(requests.some((url) => url.includes('/teams/core-team/issues'))).toBe(true)

      await loadWorkItemKeyLocation('PT-12', 'token', cacheWith(['pt-12']))
      await loadWorkItemKeyLocation('PT-12', 'token', cacheWith())
      expect(stored).toHaveLength(1)
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

describe('SearchKeyJump', () => {
  /**
   * Renders the key jump for one search keyword.
   *
   * @param keyword - Search keyword as typed.
   * @returns The rendered HTML.
   */
  const renderJump = (keyword: string) => renderToStaticMarkup(
    <MemoryRouter>
      <SearchKeyJump keyword={keyword} t={createTranslator('en')} />
    </MemoryRouter>,
  )

  test('links a keyword that is exactly one key, in any case, to its key URL', () => {
    expect(renderJump('PT-12')).toContain('href="/browse/PT-12"')
    expect(renderJump(' pt-12 ')).toContain('Open PT-12')
    expect(renderJump('PT-12 login bug')).toBe('')
  })
})
