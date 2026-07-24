import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type {
  ApiAccessObservation,
  ApiErrorObservation,
} from '../../infrastructure/observability/api-observability'
import {
  registerCommonMiddleware,
  type CommonMiddlewareDependencies,
} from './common-middleware'

/**
 * Creates deterministic middleware dependencies and captures observations.
 *
 * @param identifiers - Identifier values returned in sequence.
 * @param timestamps - Clock values returned in sequence.
 * @returns Dependencies and mutable observation collections owned by the test.
 */
function createTestMiddlewareDependencies(
  identifiers: readonly string[],
  timestamps: readonly number[],
): {
  readonly access: ApiAccessObservation[]
  readonly dependencies: CommonMiddlewareDependencies
  readonly errors: ApiErrorObservation[]
} {
  const access: ApiAccessObservation[] = []
  const errors: ApiErrorObservation[] = []
  let identifierIndex = 0
  let timestampIndex = 0

  return {
    access,
    errors,
    dependencies: {
      auditRejectedEnterpriseSecurityMutation: async (_context, next) => next(),
      createIdentifier() {
        const identifier = identifiers[identifierIndex]
        identifierIndex += 1
        if (!identifier) throw new Error('Test identifier sequence was exhausted.')
        return identifier
      },
      getAllowedOrigins: () => ['https://app.example.com'],
      now() {
        const timestamp = timestamps[timestampIndex]
        timestampIndex += 1
        if (timestamp === undefined) {
          throw new Error('Test timestamp sequence was exhausted.')
        }
        return timestamp
      },
      recordAccess: (observation) => access.push(observation),
      recordError: (observation) => errors.push(observation),
    },
  }
}

test('replaces client identifiers with canonical server identifiers', async () => {
  const captured = createTestMiddlewareDependencies(
    ['generated-correlation', 'generated-request'],
    [1_000, 1_025],
  )
  const app = new Hono()
  registerCommonMiddleware(app, captured.dependencies)
  app.get('/api/work-items/:workItemId', (context) =>
    context.json({
      correlationId: context.req.header('X-Correlation-Id'),
      requestId: context.req.header('X-Request-Id'),
    }))

  const response = await app.request('/api/work-items/private-work-item-id', {
    headers: {
      Origin: 'https://app.example.com',
      'X-Correlation-Id': 'client-correlation-secret',
      'X-Request-Id': 'client-request-secret',
    },
  })

  expect(await response.json()).toEqual({
    correlationId: 'generated-correlation',
    requestId: 'generated-request',
  })
  expect(response.headers.get('X-Correlation-Id')).toBe(
    'generated-correlation',
  )
  expect(response.headers.get('X-Request-Id')).toBe('generated-request')
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
    'X-Correlation-Id',
  )
  expect(captured.errors).toEqual([])
  expect(captured.access).toEqual([{
    correlationId: 'generated-correlation',
    durationMilliseconds: 25,
    method: 'GET',
    observedAtMilliseconds: 1_025,
    requestId: 'generated-request',
    routeGroup: '/api/work-items',
    status: 200,
  }])
  expect(JSON.stringify(captured.access)).not.toContain('private-work-item-id')
  expect(JSON.stringify(captured.access)).not.toContain('client-request-secret')
  expect(JSON.stringify(captured.access)).not.toContain(
    'client-correlation-secret',
  )
})

test('replaces invalid untrusted request identifiers before routes consume them', async () => {
  const captured = createTestMiddlewareDependencies(
    ['generated-correlation', 'generated-request'],
    [2_000, 2_001],
  )
  const app = new Hono()
  registerCommonMiddleware(app, captured.dependencies)
  app.get('/api/example', (context) =>
    context.json({
      correlationId: context.req.header('X-Correlation-Id'),
      requestId: context.req.header('X-Request-Id'),
    }))

  const response = await app.request('/api/example', {
    headers: {
      'X-Correlation-Id': 'contains spaces',
      'X-Request-Id': 'x'.repeat(129),
    },
  })

  expect(await response.json()).toEqual({
    correlationId: 'generated-correlation',
    requestId: 'generated-request',
  })
  expect(response.headers.get('X-Correlation-Id')).toBe(
    'generated-correlation',
  )
  expect(response.headers.get('X-Request-Id')).toBe('generated-request')
})

test('maps unexpected failures to a safe correlated response and error record', async () => {
  const captured = createTestMiddlewareDependencies(
    ['generated-correlation', 'generated-request'],
    [3_000, 3_010, 3_020],
  )
  const app = new Hono()
  registerCommonMiddleware(app, captured.dependencies)
  app.get('/api/failing', () => {
    throw new Error('sensitive upstream detail')
  })

  const response = await app.request('/api/failing')
  const serializedResponse = await response.text()

  expect(response.status).toBe(500)
  expect(serializedResponse).not.toContain('sensitive upstream detail')
  expect(JSON.parse(serializedResponse)).toEqual({
    code: 'InternalError',
    correlationId: 'generated-correlation',
    message: 'The request could not be completed.',
  })
  expect(captured.errors).toEqual([{
    correlationId: 'generated-correlation',
    errorType: 'Error',
    method: 'GET',
    observedAtMilliseconds: 3_010,
    requestId: 'generated-request',
    routeGroup: '/api/unmatched',
  }])
  expect(captured.access[0]).toMatchObject({
    durationMilliseconds: 20,
    status: 500,
  })
})

test('maps non-Error thrown values to the same safe failure contract', async () => {
  const captured = createTestMiddlewareDependencies(
    ['generated-correlation', 'generated-request'],
    [4_000, 4_010, 4_020],
  )
  const app = new Hono()
  registerCommonMiddleware(app, captured.dependencies)
  app.get('/api/failing-value', () => {
    const thrownValue: unknown = {
      detail: 'sensitive non-error detail',
    }
    throw thrownValue
  })

  const response = await app.request('/api/failing-value')
  const serializedResponse = await response.text()

  expect(response.status).toBe(500)
  expect(serializedResponse).not.toContain('sensitive non-error detail')
  expect(JSON.parse(serializedResponse)).toEqual({
    code: 'InternalError',
    correlationId: 'generated-correlation',
    message: 'The request could not be completed.',
  })
  expect(captured.errors).toEqual([{
    correlationId: 'generated-correlation',
    errorType: 'UnknownError',
    method: 'GET',
    observedAtMilliseconds: 4_010,
    requestId: 'generated-request',
    routeGroup: '/api/unmatched',
  }])
  expect(captured.access[0]).toMatchObject({
    durationMilliseconds: 20,
    status: 500,
  })
})

test('preserves intentional Hono HTTPException responses', async () => {
  const captured = createTestMiddlewareDependencies(
    ['generated-correlation', 'generated-request'],
    [5_000, 5_010],
  )
  const app = new Hono()
  registerCommonMiddleware(app, captured.dependencies)
  app.get('/api/work-items/:workItemId', () => {
    throw new HTTPException(418, { message: 'Expected HTTP response.' })
  })

  const response = await app.request('/api/work-items/work-item-1')

  expect(response.status).toBe(418)
  expect(await response.text()).toBe('Expected HTTP response.')
  expect(response.headers.get('X-Correlation-Id')).toBe(
    'generated-correlation',
  )
  expect(response.headers.get('X-Request-Id')).toBe('generated-request')
  expect(captured.errors).toEqual([])
  expect(captured.access).toEqual([{
    correlationId: 'generated-correlation',
    durationMilliseconds: 10,
    method: 'GET',
    observedAtMilliseconds: 5_010,
    requestId: 'generated-request',
    routeGroup: '/api/work-items',
    status: 418,
  }])
})
