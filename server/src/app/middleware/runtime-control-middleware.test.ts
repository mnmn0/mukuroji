import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type {
  RuntimeControlObservation,
} from '../../infrastructure/observability/runtime-control-observability'
import type {
  RuntimeControlProvider,
  RuntimeControlSnapshot,
} from '../../infrastructure/runtime/runtime-control'
import {
  registerCommonMiddleware,
  registerEnterpriseSecurityAuditMiddleware,
} from './common-middleware'
import {
  registerRuntimeControlMiddleware,
} from './runtime-control-middleware'

/**
 * Creates a provider that counts and returns one deterministic snapshot.
 *
 * @param snapshot - Snapshot returned to the gate.
 * @param onCall - Callback invoked for each provider evaluation.
 * @returns Runtime-control provider.
 */
function providerFor(
  snapshot: RuntimeControlSnapshot,
  onCall: () => void,
): RuntimeControlProvider {
  return {
    async getSnapshot() {
      onCall()
      return snapshot
    },
  }
}

/**
 * Registers deterministic correlation, CORS, and access middleware for tests.
 *
 * @param app - Hono test application.
 */
function registerTestCommonMiddleware(app: Hono): void {
  let identifier = 0
  let now = 0
  const identifiers = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ]
  registerCommonMiddleware(app, {
    createIdentifier() {
      const value = identifiers[identifier]
      identifier += 1
      if (!value) throw new Error('Test identifier sequence exhausted.')
      return value
    },
    getAllowedOrigins: () => ['https://app.example.com'],
    now() {
      now += 1
      return now
    },
    recordAccess() {},
    recordError() {},
  })
}

test('never evaluates the provider for liveness or readiness routes', async () => {
  let providerCalls = 0
  const app = new Hono()
  registerRuntimeControlMiddleware(app, {
    provider: providerFor({
      mode: 'disabled',
      status: 'current',
    }, () => {
      providerCalls += 1
    }),
    recordObservation() {},
  })
  app.get('/api/health', (context) => context.json({ ok: true }))
  app.get('/api/ready', (context) => context.json({ ok: false }, 503))

  expect((await app.request('/api/health')).status).toBe(200)
  expect((await app.request('/api/ready')).status).toBe(503)
  expect(providerCalls).toBe(0)
})

test('lets CORS preflight terminate before runtime admission', async () => {
  let providerCalls = 0
  let routeCalls = 0
  const app = new Hono()
  registerTestCommonMiddleware(app)
  registerRuntimeControlMiddleware(app, {
    provider: providerFor({
      mode: 'disabled',
      status: 'current',
    }, () => {
      providerCalls += 1
    }),
    recordObservation() {},
  })
  app.options('/api/example', (context) => {
    routeCalls += 1
    return context.body(null, 204)
  })

  const response = await app.request('/api/example', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  })

  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://app.example.com',
  )
  expect(providerCalls).toBe(0)
  expect(routeCalls).toBe(0)
})

test('admits current and bounded-stale enabled API requests', async () => {
  for (const snapshot of [
    {
      mode: 'enabled',
      revision: 1,
      status: 'current',
    },
    {
      ageMilliseconds: 10,
      mode: 'enabled',
      revision: 1,
      status: 'stale',
    },
  ] satisfies RuntimeControlSnapshot[]) {
    let routeCalls = 0
    const observations: RuntimeControlObservation[] = []
    const app = new Hono()
    registerRuntimeControlMiddleware(app, {
      now: () => 123,
      provider: providerFor(snapshot, () => {}),
      recordObservation: (observation) => observations.push(observation),
    })
    app.get('/api/example', (context) => {
      routeCalls += 1
      return context.json({ ok: true })
    })

    expect((await app.request('/api/example')).status).toBe(200)
    expect(routeCalls).toBe(1)
    expect(observations).toEqual([{
      observedAtMilliseconds: 123,
      outcome: 'allowed',
      snapshot,
      surface: 'api',
    }])
  }
})

test('returns a correlated no-store problem before audit or domain work', async () => {
  let providerCalls = 0
  let auditCalls = 0
  let routeCalls = 0
  const observations: RuntimeControlObservation[] = []
  const app = new Hono()
  registerTestCommonMiddleware(app)
  registerRuntimeControlMiddleware(app, {
    now: () => 123,
    provider: providerFor({
      mode: 'disabled',
      revision: 8,
      status: 'current',
    }, () => {
      providerCalls += 1
    }),
    recordObservation: (observation) => observations.push(observation),
  })
  registerEnterpriseSecurityAuditMiddleware(
    app,
    async (_context, next) => {
      auditCalls += 1
      await next()
    },
  )
  app.post('/api/enterprise/security/example', (context) => {
    routeCalls += 1
    return context.json({ ok: true })
  })

  const response = await app.request(
    '/api/enterprise/security/example',
    { method: 'POST' },
  )

  expect(response.status).toBe(503)
  expect(response.headers.get('Content-Type')).toContain(
    'application/problem+json',
  )
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  expect(response.headers.get('Pragma')).toBe('no-cache')
  expect(response.headers.get('Retry-After')).toBe('15')
  expect(response.headers.get('X-Correlation-Id')).toBe(
    '00000000-0000-4000-8000-000000000001',
  )
  expect(response.headers.get('Mukuroji-Maintenance')).toBe('stopped')
  expect(await response.json()).toEqual({
    type: 'https://docs.mukuroji.app/problems/maintenance',
    title: 'Service under maintenance',
    status: 503,
    code: 'maintenance',
    detail: 'The service is stopped for maintenance.',
    correlationId: '00000000-0000-4000-8000-000000000001',
    retryable: true,
  })
  expect(providerCalls).toBe(1)
  expect(auditCalls).toBe(0)
  expect(routeCalls).toBe(0)
  expect(observations).toHaveLength(1)
})

test('does not echo even a UUID-shaped client correlation identifier', async () => {
  const generatedCorrelationId =
    '00000000-0000-4000-8000-000000000099'
  const clientCorrelationId =
    '11111111-1111-4111-8111-111111111111'
  const app = new Hono()
  registerRuntimeControlMiddleware(app, {
    createIdentifier: () => generatedCorrelationId,
    provider: providerFor({
      mode: 'disabled',
      status: 'unavailable',
    }, () => {}),
    recordObservation() {},
  })

  const response = await app.request('/api/example', {
    headers: {
      'X-Correlation-Id': clientCorrelationId,
    },
  })
  const serializedResponse = await response.text()

  expect(JSON.parse(serializedResponse)).toMatchObject({
    correlationId: generatedCorrelationId,
  })
  expect(serializedResponse).not.toContain(clientCorrelationId)
})

test('normalizes provider rejection to a blocked unavailable response', async () => {
  let routeCalls = 0
  const observations: RuntimeControlObservation[] = []
  const app = new Hono()
  registerRuntimeControlMiddleware(app, {
    createIdentifier: () =>
      '00000000-0000-4000-8000-000000000099',
    provider: {
      async getSnapshot() {
        throw new Error('secret provider detail')
      },
    },
    recordObservation: (observation) => observations.push(observation),
  })
  app.get('/api/example', (context) => {
    routeCalls += 1
    return context.text('unexpected')
  })

  const response = await app.request('/api/example')

  expect(response.status).toBe(503)
  expect(routeCalls).toBe(0)
  expect(observations[0]).toMatchObject({
    outcome: 'blocked',
    snapshot: {
      mode: 'disabled',
      status: 'unavailable',
    },
  })
})

test('admits reads during read-only maintenance and rejects changes with a reason', async () => {
  const snapshot = {
    mode: 'read-only',
    revision: 9,
    status: 'current',
  } satisfies RuntimeControlSnapshot
  const routeCalls: string[] = []
  const observations: RuntimeControlObservation[] = []
  const app = new Hono()
  registerRuntimeControlMiddleware(app, {
    now: () => 123,
    provider: providerFor(snapshot, () => {}),
    recordObservation: (observation) => observations.push(observation),
  })
  app.get('/api/teams/:teamId/issues', (context) => {
    routeCalls.push('list')
    return context.json({ items: [] })
  })
  app.post('/api/teams/:teamId/issues', (context) => {
    routeCalls.push('create')
    return context.json({ ok: true }, 201)
  })
  app.delete('/api/teams/:teamId/issues/:issueId', (context) => {
    routeCalls.push('delete')
    return context.body(null, 204)
  })
  app.post('/api/auth/refresh', (context) => {
    routeCalls.push('refresh')
    return context.json({ ok: true })
  })
  app.post('/api/teams/:teamId/issues/:issueId/schedule/preview', (context) => {
    routeCalls.push('preview')
    return context.json({ ok: true })
  })
  app.get('/api/redirect', () => Response.redirect('https://app.example.com/next', 303))

  const list = await app.request('/api/teams/team-1/issues')
  expect(list.status).toBe(200)
  expect(list.headers.get('Mukuroji-Maintenance')).toBe('read-only')

  const refresh = await app.request('/api/auth/refresh', { method: 'POST' })
  expect(refresh.status).toBe(200)
  expect(refresh.headers.get('Mukuroji-Maintenance')).toBe('read-only')
  expect((await app.request(
    '/api/teams/team-1/issues/issue-1/schedule/preview',
    { method: 'POST' },
  )).status).toBe(200)

  const redirect = await app.request('/api/redirect')
  expect(redirect.status).toBe(303)
  expect(redirect.headers.get('Mukuroji-Maintenance')).toBe('read-only')

  const create = await app.request('/api/teams/team-1/issues', { method: 'POST' })
  expect(create.status).toBe(503)
  expect(create.headers.get('Retry-After')).toBe('15')
  expect(create.headers.get('Cache-Control')).toContain('no-store')
  expect(create.headers.get('Mukuroji-Maintenance')).toBe('read-only')
  expect(await create.json()).toMatchObject({
    type: 'https://docs.mukuroji.app/problems/maintenance_read_only',
    status: 503,
    code: 'maintenance_read_only',
    detail: 'The service is in read-only maintenance. Changes cannot be saved until it ends.',
    retryable: true,
  })
  expect((await app.request(
    '/api/teams/team-1/issues/issue-1',
    { method: 'DELETE' },
  )).status).toBe(503)
  // A listed POST route with an extra segment is not the same route.
  expect((await app.request(
    '/api/auth/refresh/extra',
    { method: 'POST' },
  )).status).toBe(503)

  expect(routeCalls).toEqual(['list', 'refresh', 'preview'])
  expect(observations.map((observation) => observation.outcome)).toEqual([
    'allowed',
    'allowed',
    'allowed',
    'allowed',
    'blocked',
    'blocked',
    'blocked',
  ])
})

test('answers the maintenance status without authentication for every state', async () => {
  for (const [snapshot, state] of [
    [{ mode: 'enabled', status: 'current' }, 'none'],
    [{ mode: 'enabled', status: 'stale', ageMilliseconds: 5 }, 'none'],
    [{ mode: 'read-only', status: 'current' }, 'read-only'],
    [{ mode: 'disabled', status: 'current' }, 'stopped'],
    [{ mode: 'disabled', status: 'unavailable' }, 'unavailable'],
    [{ mode: 'disabled', status: 'invalid' }, 'unavailable'],
  ] satisfies [RuntimeControlSnapshot, string][]) {
    let routeCalls = 0
    const observations: RuntimeControlObservation[] = []
    const app = new Hono()
    registerRuntimeControlMiddleware(app, {
      provider: providerFor(snapshot, () => {}),
      recordObservation: (observation) => observations.push(observation),
    })
    app.use('/api/*', async (_context, next) => {
      routeCalls += 1
      await next()
    })

    const response = await app.request('/api/maintenance')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toEqual({ state })
    expect(routeCalls).toBe(0)
    expect(observations).toHaveLength(0)
  }
})

test('keeps an outage distinct from maintenance', async () => {
  const app = new Hono()
  registerRuntimeControlMiddleware(app, {
    createIdentifier: () => 'generated',
    provider: providerFor({ mode: 'disabled', status: 'invalid' }, () => {}),
    recordObservation() {},
  })
  app.get('/api/example', (context) => context.json({ ok: true }))

  const response = await app.request('/api/example')
  expect(response.status).toBe(503)
  expect(response.headers.get('Mukuroji-Maintenance')).toBeNull()
  expect(await response.json()).toMatchObject({ code: 'temporarily_unavailable' })
})
