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
  expect(await response.json()).toEqual({
    type: 'https://docs.mukuroji.app/problems/temporarily_unavailable',
    title: 'Service temporarily unavailable',
    status: 503,
    code: 'temporarily_unavailable',
    detail: 'The service is temporarily unavailable.',
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
