import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import {
  createAnalyticsRouter,
  type AnalyticsRouterDependencies,
} from './analytics-router'

const principal = { directoryId: 'workspace-1', userKey: 'member-1' }

/** Builds an Analytics router fixture and records every application operation. */
function createDependencies(
  overrides: Partial<AnalyticsRouterDependencies<typeof principal>> = {},
) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const dependencies: AnalyticsRouterDependencies<typeof principal> = {
    readBearerAccessToken: (context) =>
      context.req.header('Authorization')?.replace(/^Bearer /u, ''),
    async authenticate(accessToken, context) {
      calls.push({ operation: 'authenticate', value: { accessToken, context } })
      return principal
    },
    async readJson(context) {
      const value: unknown = await context.req.json()
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('validation')
      }
      return value
    },
    async executeQuery(value, input) {
      calls.push({ operation: 'executeQuery', value: { principal: value, input } })
      return { queryHash: 'query-1' }
    },
    async executeEvidence(value, input) {
      calls.push({ operation: 'executeEvidence', value: { principal: value, input } })
      return { items: [{ id: 'item-1' }] }
    },
    async createExport(value, input) {
      calls.push({ operation: 'createExport', value: { principal: value, input } })
      return {
        body: 'csv-body',
        extension: 'csv',
        contentType: 'text/csv; charset=utf-8',
      }
    },
    async listReports(value, limit, cursor) {
      calls.push({
        operation: 'listReports',
        value: { principal: value, limit, cursor },
      })
      return { reports: [{ id: 'report-1' }], nextCursor: 'next-report' }
    },
    async createReport(value, input) {
      calls.push({ operation: 'createReport', value: { principal: value, input } })
      return { id: 'report-1' }
    },
    async updateReport(value, reportId, input) {
      calls.push({
        operation: 'updateReport',
        value: { principal: value, reportId, input },
      })
      return { id: reportId, revision: 2 }
    },
    async deleteReport(value, reportId, input) {
      calls.push({
        operation: 'deleteReport',
        value: { principal: value, reportId, input },
      })
    },
    async listSnapshots(value, reportId, cursor) {
      calls.push({
        operation: 'listSnapshots',
        value: { principal: value, reportId, cursor },
      })
      return { snapshots: [{ id: 'snapshot-1' }], inspectedCount: 1 }
    },
    async createSnapshot(value, reportId, input, idempotencyKey) {
      calls.push({
        operation: 'createSnapshot',
        value: { principal: value, reportId, input, idempotencyKey },
      })
      return { id: 'snapshot-1' }
    },
    mapError: (context) => context.json({ code: 'mapped' }, 503),
    ...overrides,
  }
  return { calls, router: createAnalyticsRouter(dependencies) }
}

describe('createAnalyticsRouter', () => {
  test('registers the complete Analytics route inventory without duplicates', () => {
    const { router } = createDependencies()
    const inventory = router.routes.map(({ method, path }) => `${method} ${path}`)

    expect(inventory).toEqual([
      'POST /api/analytics/query',
      'POST /api/analytics/evidence',
      'POST /api/analytics/export',
      'GET /api/analytics/reports',
      'POST /api/analytics/reports',
      'PATCH /api/analytics/reports/:reportId',
      'DELETE /api/analytics/reports/:reportId',
      'GET /api/analytics/reports/:reportId/snapshots',
      'POST /api/analytics/reports/:reportId/snapshots',
    ])
    expect(new Set(inventory).size).toBe(inventory.length)
  })

  test('preserves the stable missing-bearer response before application calls', async () => {
    const { calls, router } = createDependencies()
    const response = await router.request('/api/analytics/query', {
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Bearer token is required.' })
    expect(calls).toEqual([])
  })

  test('forwards query, evidence, and export requests with their response shapes', async () => {
    const { calls, router } = createDependencies()
    const headers = {
      Authorization: 'Bearer analytics-token',
      'Content-Type': 'application/json',
    }
    const query = await router.request('/api/analytics/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reportId: 'report-1' }),
    })
    const evidence = await router.request('/api/analytics/evidence', {
      method: 'POST',
      headers,
      body: JSON.stringify({ metric: 'throughput' }),
    })
    const exported = await router.request('/api/analytics/export', {
      method: 'POST',
      headers,
      body: JSON.stringify({ format: 'csv' }),
    })

    expect(query.status).toBe(200)
    expect(await query.json()).toEqual({ snapshot: { queryHash: 'query-1' } })
    expect(await evidence.json()).toEqual({ items: [{ id: 'item-1' }] })
    expect(exported.status).toBe(200)
    expect(exported.headers.get('Cache-Control')).toBe('private, no-store')
    expect(exported.headers.get('Content-Disposition'))
      .toBe('attachment; filename="mukuroji-analytics.csv"')
    expect(exported.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(await exported.text()).toBe('csv-body')
    expect(calls.map(({ operation }) => operation)).toEqual([
      'authenticate',
      'executeQuery',
      'authenticate',
      'executeEvidence',
      'authenticate',
      'createExport',
    ])
  })

  test('forwards report and snapshot transport inputs with stable statuses', async () => {
    const { calls, router } = createDependencies()
    const headers = {
      Authorization: 'Bearer analytics-token',
      'Content-Type': 'application/json',
    }
    const responses = await Promise.all([
      router.request('/api/analytics/reports?limit=10&cursor=report-page', { headers }),
      router.request('/api/analytics/reports', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'report-1' }),
      }),
      router.request('/api/analytics/reports/report-1', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
      router.request('/api/analytics/reports/report-1', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
      router.request(
        '/api/analytics/reports/report-1/snapshots?cursor=snapshot-page',
        { headers },
      ),
      router.request('/api/analytics/reports/report-1/snapshots', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'snapshot-operation' },
        body: JSON.stringify({ asOf: '2026-07-22T00:00:00.000Z' }),
      }),
    ])

    expect(responses.map(({ status }) => status)).toEqual([200, 201, 200, 200, 200, 201])
    expect(await responses[1]?.json()).toEqual({ report: { id: 'report-1' } })
    expect(await responses[3]?.json()).toEqual({ deleted: true })
    expect(await responses[5]?.json()).toEqual({
      snapshotRecord: { id: 'snapshot-1' },
    })
    expect(calls.find(({ operation }) => operation === 'listReports')?.value)
      .toMatchObject({ limit: '10', cursor: 'report-page' })
    expect(calls.find(({ operation }) => operation === 'updateReport')?.value)
      .toMatchObject({ reportId: 'report-1', input: { expectedRevision: 1 } })
    expect(calls.find(({ operation }) => operation === 'listSnapshots')?.value)
      .toMatchObject({ reportId: 'report-1', cursor: 'snapshot-page' })
    expect(calls.find(({ operation }) => operation === 'createSnapshot')?.value)
      .toMatchObject({ reportId: 'report-1', idempotencyKey: 'snapshot-operation' })
  })

  test('maps authentication, validation, authorization, and application errors', async () => {
    const authenticationError = new Error('authentication')
    const validationError = new Error('validation')
    const authorizationError = new Error('authorization')
    const applicationError = new Error('application')
    const mapError = (context: Context, error: unknown) => {
      if (error === authenticationError) return context.json({ code: 'authentication' }, 401)
      if (error === validationError) return context.json({ code: 'validation' }, 400)
      if (error === authorizationError) return context.json({ code: 'authorization' }, 403)
      expect(error).toBe(applicationError)
      return context.json({ code: 'application' }, 503)
    }
    const authRouter = createDependencies({
      async authenticate() {
        throw authenticationError
      },
      mapError,
    }).router
    const validationRouter = createDependencies({
      async readJson() {
        throw validationError
      },
      mapError,
    }).router
    const authorizationRouter = createDependencies({
      async createReport() {
        throw authorizationError
      },
      mapError,
    }).router
    const applicationRouter = createDependencies({
      async listReports() {
        throw applicationError
      },
      mapError,
    }).router
    const headers = {
      Authorization: 'Bearer analytics-token',
      'Content-Type': 'application/json',
    }

    const responses = await Promise.all([
      authRouter.request('/api/analytics/reports', { headers }),
      validationRouter.request('/api/analytics/query', {
        method: 'POST',
        headers,
        body: '{}',
      }),
      authorizationRouter.request('/api/analytics/reports', {
        method: 'POST',
        headers,
        body: '{}',
      }),
      applicationRouter.request('/api/analytics/reports', { headers }),
    ])

    expect(responses.map(({ status }) => status)).toEqual([401, 400, 403, 503])
    expect(await Promise.all(responses.map(async (response) => await response.json())))
      .toEqual([
        { code: 'authentication' },
        { code: 'validation' },
        { code: 'authorization' },
        { code: 'application' },
      ])
  })
})
