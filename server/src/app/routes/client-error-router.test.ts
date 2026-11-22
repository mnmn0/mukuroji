import { describe, expect, test } from 'bun:test'
import type { ClientErrorReport } from '@mukuroji/contracts'
import type { ClientErrorObservation } from '../../infrastructure/observability/api-observability'
import { recordClientError } from '../../infrastructure/observability/api-observability'
import { createTestAppDependencies, overrideAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'
import { CLIENT_ERROR_REPORTS_PER_CLIENT } from './client-error-admission'
import { createClientErrorRouter, parseClientErrorReport, type ClientErrorReportAdmission } from './client-error-router'

const origin = 'http://localhost:5173'
const report: ClientErrorReport = {
  reportId: '3f2a7c1e-9b4d-4e8a-8c5f-0123456789ab',
  kind: 'route-error',
  route: '/teams/:teamId/issues/:issueId',
  webCommitSha: '0123456789abcdef0123456789abcdef01234567',
  errorName: 'TypeError',
  status: 500,
}

/**
 * Builds a report request.
 *
 * @param body - Body text.
 * @param headers - Headers that replace the defaults.
 * @returns The request.
 */
function reportRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/client-errors', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body,
  })
}

/**
 * Creates the router with recorded side effects.
 *
 * @param admission - Admission answer.
 * @returns The router and what it recorded.
 */
function routerWith(admission: ClientErrorReportAdmission = { allowed: true }) {
  const recorded: ClientErrorObservation[] = []
  let admitted = 0
  const router = createClientErrorRouter({
    getAllowedOrigins: () => [origin],
    admit: async () => {
      admitted += 1
      return admission
    },
    readCorrelationId: () => 'server-correlation',
    record: (observation) => recorded.push(observation),
    now: () => Date.UTC(2026, 10, 22),
  })
  return { router, recorded, admitted: () => admitted }
}

describe('parseClientErrorReport', () => {
  test('accepts the documented fields and drops nothing', () => {
    expect(parseClientErrorReport(report)).toEqual(report)
    expect(parseClientErrorReport({ reportId: report.reportId, kind: 'error', route: '/' }))
      .toEqual({ reportId: report.reportId, kind: 'error', route: '/' })
  })

  test('rejects unknown keys and every malformed field', () => {
    for (const value of [
      null,
      [],
      'x',
      { ...report, message: 'secret text' },
      { ...report, stack: 'at foo' },
      { ...report, reportId: report.reportId.toUpperCase() },
      { ...report, kind: 'warning' },
      { ...report, route: '/teams/T-1/issues?q=secret' },
      { ...report, route: 'teams' },
      { ...report, route: `/${'a'.repeat(200)}` },
      { ...report, route: '/a b' },
      { ...report, webCommitSha: 'abc' },
      { ...report, errorName: 'Type Error: x' },
      { ...report, errorName: 1 },
      { ...report, status: 200 },
      { ...report, status: 500.5 },
      { ...report, status: '500' },
      { kind: 'error', route: '/' },
    ]) {
      expect(parseClientErrorReport(value)).toBeUndefined()
    }
  })
})

describe('POST /api/client-errors', () => {
  test('records a valid report with the server correlation ID and answers 204', async () => {
    const { router, recorded } = routerWith()
    const response = await router.request(reportRequest(JSON.stringify(report)))
    expect(response.status).toBe(204)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(recorded).toEqual([{ ...report, correlationId: 'server-correlation', observedAtMilliseconds: Date.UTC(2026, 10, 22) }])
  })

  test('refuses other origins, media types, large or invalid bodies before counting them', async () => {
    const { router, recorded, admitted } = routerWith()
    const body = JSON.stringify(report)
    const cases: [Request, number][] = [
      [reportRequest(body, { Origin: 'https://evil.example' }), 403],
      [new Request('http://localhost/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 403],
      [reportRequest(body, { 'Content-Type': 'text/plain' }), 415],
      [reportRequest(JSON.stringify({ ...report, route: `/${'a'.repeat(1100)}` })), 413],
      [reportRequest('{"reportId":'), 400],
      [reportRequest(JSON.stringify({ ...report, message: 'x' })), 400],
    ]
    for (const [request, status] of cases) {
      const response = await router.request(request)
      expect(response.status).toBe(status)
    }
    expect(admitted()).toBe(0)
    expect(recorded).toEqual([])
  })

  test('refuses a body larger than the limit even without a Content-Length header', async () => {
    const { router, recorded } = routerWith()
    const large = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"x":"${'a'.repeat(2048)}"}`))
        controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: large,
      duplex: 'half',
    }
    const request = new Request('http://localhost/api/client-errors', init)
    expect((await router.request(request)).status).toBe(413)
    expect(recorded).toEqual([])
  })

  test('answers 429 with Retry-After when a limit refuses the report', async () => {
    const { router, recorded } = routerWith({ allowed: false, retryAfterSeconds: 42.2 })
    const response = await router.request(reportRequest(JSON.stringify(report)))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('43')
    expect(recorded).toEqual([])
  })

  test('limits each client through the app and keeps the route unauthenticated', async () => {
    const recorded: ClientErrorObservation[] = []
    const app = createApp(overrideAppDependencies(createTestAppDependencies(), {
      recordClientError: (observation) => recorded.push(observation),
    }))
    const statuses: number[] = []
    for (let index = 0; index <= CLIENT_ERROR_REPORTS_PER_CLIENT; index += 1) {
      statuses.push((await app.request(reportRequest(JSON.stringify(report)))).status)
    }
    expect(statuses.slice(0, CLIENT_ERROR_REPORTS_PER_CLIENT).every((status) => status === 204)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    expect(recorded).toHaveLength(CLIENT_ERROR_REPORTS_PER_CLIENT)
    expect(recorded[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

test('writes an EMF record without client address or free text', () => {
  const lines: string[] = []
  recordClientError({
    ...report,
    correlationId: 'c-1',
    observedAtMilliseconds: Date.UTC(2026, 10, 22),
  }, (line) => lines.push(line))
  const record: unknown = JSON.parse(lines[0] ?? '{}')
  expect(record).toMatchObject({
    event: 'web.client.error',
    Service: 'mukuroji-web',
    reportId: report.reportId,
    kind: 'route-error',
    route: report.route,
    webCommitSha: report.webCommitSha,
    errorName: 'TypeError',
    status: 500,
    ClientErrorCount: 1,
    observedAt: '2026-11-22T00:00:00.000Z',
  })
})
