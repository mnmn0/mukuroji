import { describe, expect, test } from 'bun:test'
import type { ClientErrorReport } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { RouteErrorPage } from '../src/pages/public/RouteErrorPage'
import {
  createClientErrorReporter,
  readErrorName,
  routePatternFromMatches,
  sendClientErrorReport,
} from '../src/shared/observability/clientErrorReports'

const commit = '0123456789abcdef0123456789abcdef01234567'

/**
 * Creates a reporter that records what it sends.
 *
 * @returns The reporter and the sent reports.
 */
function recordingReporter() {
  const sent: ClientErrorReport[] = []
  let next = 0
  const reporter = createClientErrorReporter({
    webCommitSha: commit,
    send: (report) => sent.push(report),
    createReportId: () => {
      next += 1
      return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`
    },
  })
  return { reporter, sent }
}

describe('client error reports', () => {
  test('sends only the route pattern, build, error name, and status', () => {
    const { reporter, sent } = recordingReporter()
    const secret = new TypeError('customer Acme Corp is over budget')
    const id = reporter.report({ kind: 'route-error', route: '/teams/:teamId', error: secret, status: 503 })
    expect(sent).toEqual([{
      reportId: id,
      kind: 'route-error',
      route: '/teams/:teamId',
      webCommitSha: commit,
      errorName: 'TypeError',
      status: 503,
    }])
    expect(JSON.stringify(sent)).not.toContain('Acme')
  })

  test('replaces an unreportable route and drops unusual names and statuses', () => {
    const { reporter, sent } = recordingReporter()
    const weird = new Error('x')
    weird.name = 'Bad name <script>'
    reporter.report({ kind: 'error', route: '/teams/a b?q=1', error: weird, status: 200 })
    reporter.report({ kind: 'unhandledrejection', route: '/', error: 'plain string' })
    expect(sent.map(({ route, errorName, status }) => ({ route, errorName, status }))).toEqual([
      { route: '/unknown', errorName: undefined, status: undefined },
      { route: '/', errorName: undefined, status: undefined },
    ])
  })

  test('sends a repeated error once and at most five reports per page load', () => {
    const { reporter, sent } = recordingReporter()
    const first = reporter.report({ kind: 'error', route: '/a', error: new Error('1') })
    expect(reporter.report({ kind: 'error', route: '/a', error: new Error('2') })).toBe(first)
    for (const route of ['/b', '/c', '/d', '/e', '/f', '/g']) reporter.report({ kind: 'error', route, error: undefined })
    expect(sent).toHaveLength(5)
    expect(reporter.report({ kind: 'error', route: '/h', error: undefined })).toBeUndefined()
  })

  test('joins route definitions into one pattern', () => {
    expect(routePatternFromMatches([])).toBe('/')
    expect(routePatternFromMatches([
      { route: {} },
      { route: { path: '/teams/:teamId' } },
      { route: { path: 'issues/:issueId' } },
    ])).toBe('/teams/:teamId/issues/:issueId')
  })

  test('reads only well-formed error names', () => {
    expect(readErrorName(new RangeError('x'))).toBe('RangeError')
    expect(readErrorName({ name: 'TypeError' })).toBeUndefined()
  })

  test('posts JSON without credentials and survives a failing transport', async () => {
    const calls: { url: string, init: RequestInit | undefined }[] = []
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      throw new Error('offline')
    }) satisfies typeof fetch
    const report: ClientErrorReport = { reportId: '00000000-0000-4000-8000-000000000001', kind: 'error', route: '/' }
    sendClientErrorReport('/api', report, send)
    await Promise.resolve()
    expect(calls[0]?.url).toBe('/api/client-errors')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true, body: JSON.stringify(report) })
  })

  test('shows the report ID on the route error page only when one was sent', () => {
    const withId = renderToStaticMarkup(
      <MemoryRouter><RouteErrorPage initialLocale="ja" reportId="00000000-0000-4000-8000-000000000001" /></MemoryRouter>,
    )
    expect(withId).toContain('00000000-0000-4000-8000-000000000001')
    const without = renderToStaticMarkup(<MemoryRouter><RouteErrorPage initialLocale="ja" /></MemoryRouter>)
    expect(without).not.toContain('route-error-report-id')
  })
})
