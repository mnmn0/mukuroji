import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  issueCalendarFeed,
  listCalendarFeeds,
  revokeCalendarFeed,
  toCalendarFeedUrl,
  toWebcalUrl,
} from '../src/features/calendar-feeds/api/calendarFeeds'
import {
  calendarFeedsFixture,
  calendarFeedTeamsFixture,
  issuedCalendarFeedUrlFixture,
} from '../src/features/calendar-feeds/fixtures'
import { CalendarFeedsPanel, type CalendarFeedsPanelProps } from '../src/features/calendar-feeds/ui/CalendarFeedsPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Builds panel props with every callback stubbed.
 *
 * @param overrides - Props to replace.
 * @returns Complete panel props.
 */
function panelProps(overrides: Partial<CalendarFeedsPanelProps> = {}): CalendarFeedsPanelProps {
  /** Callback that ignores its call. */
  const noop = () => undefined
  return {
    feeds: calendarFeedsFixture,
    isLoading: false,
    hasLoadError: false,
    hasOperationError: false,
    teams: calendarFeedTeamsFixture,
    formatDateTime: (value) => value.slice(0, 10),
    t: createTranslator('ja'),
    onIssueMember: noop,
    onIssueProject: noop,
    onRevoke: noop,
    onReload: noop,
    onDismissIssued: noop,
    onCopy: async () => true,
    ...overrides,
  }
}

test('joins the feed path to the API base URL', () => {
  const path = '/api/public/calendar-feeds/abc.def.ics'
  expect(toCalendarFeedUrl(path, 'https://app.example.com', '/api'))
    .toBe('https://app.example.com/api/public/calendar-feeds/abc.def.ics')
  expect(toCalendarFeedUrl(path, 'https://app.example.com', 'https://api.example.com/prod/api'))
    .toBe('https://api.example.com/prod/api/public/calendar-feeds/abc.def.ics')
  expect(toWebcalUrl('https://app.example.com/api/x.ics')).toBe('webcal://app.example.com/api/x.ics')
})

test('shows issued feeds, the Project names, and the URL issued last', () => {
  const html = renderToStaticMarkup(<CalendarFeedsPanel {...panelProps({
    issued: { feed: calendarFeedsFixture[0]!, url: issuedCalendarFeedUrlFixture },
  })} />)
  expect(html).toContain('カレンダー連携')
  expect(html).toContain('URL を再発行')
  expect(html).toContain('Core / Refero')
  expect(html).toContain('Core / 請求基盤の刷新')
  expect(html).toContain(issuedCalendarFeedUrlFixture)
  expect(html).toContain('href="webcal://mukuroji.example.com/api/public/calendar-feeds/')
})

test('offers issuing when no feed exists and names a Project that is no longer visible', () => {
  const empty = renderToStaticMarkup(<CalendarFeedsPanel {...panelProps({ feeds: [] })} />)
  expect(empty).toContain('未発行')
  expect(empty).toContain('発行した Project の予定はありません。')
  const hidden = renderToStaticMarkup(<CalendarFeedsPanel {...panelProps({ teams: [] })} />)
  expect(hidden).toContain('参照できない Project')
  const failed = renderToStaticMarkup(<CalendarFeedsPanel {...panelProps({ feeds: undefined, hasLoadError: true })} />)
  expect(failed).toContain('カレンダー連携を読み込めませんでした。')
})

test('sends the feed requests and validates their responses', async () => {
  const requests: { url: string, init?: RequestInit }[] = []
  /** Fake fetch answering each feed route. */
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, ...(init ? { init } : {}) })
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ feed: calendarFeedsFixture[0], feedPath: '/api/public/calendar-feeds/a.b.ics' }), { status: 201 })
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ feeds: calendarFeedsFixture }), { status: 200 })
  }
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect })
  const context = { idempotencyKey: 'key', correlationId: 'corr' }

  expect((await listCalendarFeeds('token')).feeds).toEqual(calendarFeedsFixture)
  expect(await issueCalendarFeed('token', { kind: 'member', locale: 'ja' }, context))
    .toEqual({ feed: calendarFeedsFixture[0]!, feedPath: '/api/public/calendar-feeds/a.b.ics' })
  await revokeCalendarFeed('token', 'feed-member', context)
  expect(requests.map((request) => `${request.init?.method ?? 'GET'} ${request.url}`)).toEqual([
    'GET /api/me/calendar-feeds',
    'POST /api/me/calendar-feeds',
    'DELETE /api/me/calendar-feeds/feed-member',
  ])

  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ feeds: [{ id: 1 }] }), { status: 200 }), {
    preconnect: originalFetch.preconnect,
  })
  expect(listCalendarFeeds('token')).rejects.toMatchObject({ status: 502 })
})
