import { expect, test } from 'bun:test'
import {
  classifyApiError,
  recordApiAccess,
  recordApiError,
  resolveApiRuntimeMetadata,
  summarizeApiMethod,
  summarizeApiRoute,
} from './api-observability'

test('writes CloudWatch EMF access records without high-cardinality request data', () => {
  const records: string[] = []
  recordApiAccess({
    correlationId: 'correlation-1',
    durationMilliseconds: 42,
    invocationId: 'lambda-invocation-1',
    method: 'POST',
    observedAtMilliseconds: 1_700_000_000_000,
    requestId: 'request-1',
    routeGroup: '/api/workspaces',
    status: 503,
    traceId: '1-65f2c4a1-0123456789abcdef01234567',
  }, (record) => records.push(record))

  expect(records).toHaveLength(1)
  expect(JSON.parse(records[0] ?? '')).toMatchObject({
    _aws: {
      Timestamp: 1_700_000_000_000,
      CloudWatchMetrics: [{
        Namespace: 'Mukuroji/API',
        Dimensions: [['Service']],
        Metrics: [
          { Name: 'RequestCount', Unit: 'Count' },
          { Name: 'Latency', Unit: 'Milliseconds' },
          { Name: 'ServerErrorCount', Unit: 'Count' },
        ],
      }],
    },
    event: 'api.request.completed',
    Service: 'mukuroji-api',
    RequestCount: 1,
    Latency: 42,
    ServerErrorCount: 1,
    correlationId: 'correlation-1',
    invocationId: 'lambda-invocation-1',
    requestId: 'request-1',
    routeGroup: '/api/workspaces',
    status: 503,
    traceId: '1-65f2c4a1-0123456789abcdef01234567',
  })
})

test('writes safe unexpected-error records without messages or stack traces', () => {
  const records: string[] = []
  recordApiError({
    correlationId: 'correlation-2',
    errorType: 'TypeError',
    invocationId: 'lambda-invocation-2',
    method: 'GET',
    observedAtMilliseconds: 1_700_000_000_000,
    requestId: 'request-2',
    routeGroup: '/api/ready',
    traceId: '1-65f2c4a1-0123456789abcdef01234567',
  }, (record) => records.push(record))

  expect(JSON.parse(records[0] ?? '')).toEqual({
    event: 'api.request.failed',
    service: 'mukuroji-api',
    correlationId: 'correlation-2',
    requestId: 'request-2',
    method: 'GET',
    routeGroup: '/api/ready',
    errorType: 'TypeError',
    invocationId: 'lambda-invocation-2',
    traceId: '1-65f2c4a1-0123456789abcdef01234567',
    observedAt: '2023-11-14T22:13:20.000Z',
  })
  expect(classifyApiError(new TypeError('secret'))).toBe('TypeError')
  expect(classifyApiError('secret')).toBe('UnknownError')
  const attackerNamedError = new Error('safe message')
  attackerNamedError.name = 'customer-secret'
  expect(classifyApiError(attackerNamedError)).toBe('Error')
})

test('summarizes methods and routes without client-controlled values', () => {
  expect(summarizeApiMethod('post')).toBe('POST')
  expect(summarizeApiMethod('SECRET-METHOD')).toBe('OTHER')
  expect(summarizeApiRoute('/api/workspaces/private-id?token=secret')).toBe(
    '/api/unmatched',
  )
  expect(summarizeApiRoute('/api/work-items/private-id')).toBe('/api/work-items')
  expect(summarizeApiRoute('/api/ready?token=secret')).toBe('/api/ready')
  expect(summarizeApiRoute('/api/customer-secret')).toBe('/api/unmatched')
  expect(summarizeApiRoute('/customer-secret')).toBe('/unmatched')
  expect(summarizeApiRoute('/')).toBe('/')
})

test('extracts only validated Lambda and X-Ray join identifiers', () => {
  expect(resolveApiRuntimeMetadata(
    {
      lambdaContext: {
        awsRequestId: 'lambda-request-123',
      },
      requestContext: {
        requestId: 'ignored-client-facing-id',
      },
    },
    {
      _X_AMZN_TRACE_ID:
        'Root=1-65f2c4a1-0123456789abcdef01234567;' +
        'Parent=89abcdef01234567;Sampled=1',
    },
  )).toEqual({
    invocationId: 'lambda-request-123',
    traceId: '1-65f2c4a1-0123456789abcdef01234567',
  })

  expect(resolveApiRuntimeMetadata(
    {
      lambdaContext: {
        awsRequestId: 'contains spaces and customer data',
      },
    },
    {
      _X_AMZN_TRACE_ID: 'Root=customer-secret;Sampled=1',
    },
  )).toEqual({})
})
