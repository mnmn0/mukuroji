import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyBulkOperation,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from '../src/bulk-operations/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'bulk-correlation-1',
  idempotencyKey: 'bulk-idempotency-1',
}
const request = {
  action: { archived: true, type: 'archive' as const },
  items: [{ expectedRevision: 3, teamId: 'core/team', workItemId: 'release/item' }],
  workspaceId: 'workspace-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('bulk operations API', () => {
  test('uses the preview/apply paths and stable mutation headers', async () => {
    const requests = installFetchRecorder({
      action: request.action,
      canApply: true,
      items: [],
      operationToken: 'preview-token',
    })

    await previewBulkOperation('access-token', request, mutationContext)
    await applyBulkOperation(
      'access-token',
      { ...request, operationToken: 'preview-token' },
      mutationContext,
    )

    expect(requests.map(({ init, url }) => [init.method, url])).toEqual([
      ['POST', '/api/bulk-operations/preview'],
      ['POST', '/api/bulk-operations'],
    ])
    for (const recorded of requests) {
      expect(recorded.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Idempotency-Key': 'bulk-idempotency-1',
        'X-Correlation-Id': 'bulk-correlation-1',
      })
    }
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(request)
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      ...request,
      operationToken: 'preview-token',
    })
  })

  test('encodes operation IDs for failed-only retry and undo', async () => {
    const requests = installFetchRecorder({})

    await retryBulkOperation('access-token', 'operation/a+b', mutationContext)
    await undoBulkOperation('access-token', 'operation/a+b', mutationContext)

    expect(requests.map(({ init, url }) => [init.method, url])).toEqual([
      ['POST', '/api/bulk-operations/operation%2Fa%2Bb/retry'],
      ['POST', '/api/bulk-operations/operation%2Fa%2Bb/undo'],
    ])
    expect(requests[0]?.init.body).toBeUndefined()
    expect(requests[1]?.init.body).toBeUndefined()
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'bulk-idempotency-1',
      'X-Correlation-Id': 'bulk-correlation-1',
    })
  })
})

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
