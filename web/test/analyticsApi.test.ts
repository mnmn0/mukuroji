import { afterEach, describe, expect, test } from 'bun:test'
import type { AnalyticsQueryInput } from '@mukuroji/contracts'
import {
  createAnalyticsReport,
  createAnalyticsExportInput,
  deleteAnalyticsReport,
  exportAnalytics,
  getAnalyticsEvidence,
  getAnalyticsReports,
  queryAnalytics,
  updateAnalyticsReport,
} from '../src/analytics/api'
import {
  analyticsFilterFixture,
  analyticsReportFixtures,
  analyticsSnapshotFixture,
  analyticsWidgetFixtures,
} from '../src/analytics/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'analytics-correlation',
  idempotencyKey: 'analytics-idempotency',
}
const query = {
  asOf: analyticsSnapshotFixture.asOf,
  filter: analyticsFilterFixture,
  timeZone: 'Asia/Tokyo',
  widgets: analyticsWidgetFixtures,
} satisfies AnalyticsQueryInput

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Analytics API', () => {
  test('posts a reproducible query and a filter-bound evidence request', async () => {
    const requests = installFetchRecorder((url) =>
      url.endsWith('/query')
        ? { snapshot: analyticsSnapshotFixture }
        : { items: [], nextCursor: undefined },
    )

    await expect(queryAnalytics('access-token', query))
      .resolves.toEqual(analyticsSnapshotFixture)
    await expect(getAnalyticsEvidence('access-token', {
      asOf: query.asOf,
      filter: query.filter,
      limit: 40,
      metric: 'throughput',
      timeZone: query.timeZone,
    })).resolves.toEqual({ items: [] })

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/analytics/query'],
      ['POST', '/api/analytics/evidence'],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      asOf: query.asOf,
      filter: analyticsFilterFixture,
      limit: 40,
      metric: 'throughput',
      timeZone: 'Asia/Tokyo',
    })
  })

  test('lists reports and sends stable mutation headers through the report lifecycle', async () => {
    const report = analyticsReportFixtures[0]
    const requests = installFetchRecorder((url, init) => {
      if (!init.method || init.method === 'GET') {
        return { reports: analyticsReportFixtures }
      }
      if (init.method === 'DELETE') return { deleted: true }
      return { report }
    })
    const createInput = {
      description: report.description,
      filter: report.filter,
      forecastBaseline: report.forecastBaseline,
      id: report.id,
      name: report.name,
      schedule: report.schedule,
      teamId: report.teamId,
      timeZone: report.timeZone,
      visibility: report.visibility,
      widgets: report.widgets,
    }

    await expect(getAnalyticsReports('access-token')).resolves.toEqual({
      reports: analyticsReportFixtures,
    })
    await createAnalyticsReport(
      'access-token',
      createInput,
      mutationContext,
    )
    await updateAnalyticsReport('access-token', 'delivery/health', {
      expectedRevision: 7,
      name: 'Updated',
    }, mutationContext)
    await deleteAnalyticsReport(
      'access-token',
      'delivery/health',
      8,
      mutationContext,
    )

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [undefined, '/api/analytics/reports'],
      ['POST', '/api/analytics/reports'],
      ['PATCH', '/api/analytics/reports/delivery%2Fhealth'],
      ['DELETE', '/api/analytics/reports/delivery%2Fhealth'],
    ])
    for (const request of requests.slice(1)) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Idempotency-Key': 'analytics-idempotency',
        'X-Correlation-Id': 'analytics-correlation',
      })
    }
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({
      expectedRevision: 7,
      name: 'Updated',
    })
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({
      expectedRevision: 8,
    })
  })

  test('returns a browser artifact using the export filename header', async () => {
    globalThis.fetch = (async () => new Response('report body', {
      headers: {
        'Content-Disposition': 'attachment; filename="delivery-health.csv"',
        'Content-Type': 'text/csv',
      },
      status: 200,
    })) as typeof fetch

    const artifact = await exportAnalytics('access-token', {
      format: 'csv',
      query,
    })

    expect(artifact.filename).toBe('delivery-health.csv')
    expect(await artifact.blob.text()).toBe('report body')
  })

  test('exports the visible immutable snapshot instead of the live query', () => {
    expect(createAnalyticsExportInput(
      'pdf',
      'ja',
      query,
      'snapshot-revision-3',
    )).toEqual({
      format: 'pdf',
      locale: 'ja',
      snapshotId: 'snapshot-revision-3',
    })
    expect(createAnalyticsExportInput('csv', 'en', query)).toEqual({
      format: 'csv',
      locale: 'en',
      query,
    })
  })
})

function installFetchRecorder(
  createBody: (url: string, init: RequestInit) => unknown,
) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    requests.push({ init, url })
    return new Response(JSON.stringify(createBody(url, init)), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch
  return requests
}
