import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  EDGE_ORIGIN_SECRET_HEADER,
  EDGE_VIEWER_ADDRESS_HEADER,
  resolveEdgeViewerAddress,
  resolveTrustedRequestSource,
} from './request-source'

const edgeSecret = 'edge-secret-0123456789abcdef0123456789abcdef'
const originalEdgeSecret = process.env.MUKUROJI_EDGE_ORIGIN_SECRET

afterEach(() => {
  if (originalEdgeSecret === undefined) {
    delete process.env.MUKUROJI_EDGE_ORIGIN_SECRET
  } else {
    process.env.MUKUROJI_EDGE_ORIGIN_SECRET = originalEdgeSecret
  }
})

/**
 * Resolves the request source of one request through a minimal Hono app.
 *
 * @param headers - Request headers sent to the app.
 * @returns The resolved request source.
 */
async function resolveSourceFor(headers: Record<string, string>) {
  const app = new Hono()
  app.get('/source', (c) => c.text(resolveTrustedRequestSource(c)))
  const response = await app.request('/source', { headers })
  return response.text()
}

test('trusts the CloudFront viewer address only with the matching origin secret', () => {
  expect(resolveEdgeViewerAddress(edgeSecret, '203.0.113.7', edgeSecret)).toBe('203.0.113.7')
  expect(resolveEdgeViewerAddress(edgeSecret, ' 2001:db8::1 ', edgeSecret)).toBe('2001:db8::1')

  expect(resolveEdgeViewerAddress(`${edgeSecret}x`, '203.0.113.7', edgeSecret)).toBeUndefined()
  expect(resolveEdgeViewerAddress('wrong', '203.0.113.7', edgeSecret)).toBeUndefined()
  expect(resolveEdgeViewerAddress(undefined, '203.0.113.7', edgeSecret)).toBeUndefined()
  expect(resolveEdgeViewerAddress(edgeSecret, '203.0.113.7', undefined)).toBeUndefined()
  expect(resolveEdgeViewerAddress(edgeSecret, '203.0.113.7', '')).toBeUndefined()
})

test('rejects a forwarded viewer address that is not an IP literal', () => {
  for (const viewerAddress of ['', 'localhost', '203.0.113.7, 198.51.100.1', '203.0.113.7:443']) {
    expect(resolveEdgeViewerAddress(edgeSecret, viewerAddress, edgeSecret)).toBeUndefined()
  }
  expect(resolveEdgeViewerAddress(edgeSecret, undefined, edgeSecret)).toBeUndefined()
})

test('uses the CloudFront viewer address for requests that carry the origin secret', async () => {
  process.env.MUKUROJI_EDGE_ORIGIN_SECRET = edgeSecret

  expect(await resolveSourceFor({
    [EDGE_ORIGIN_SECRET_HEADER]: edgeSecret,
    [EDGE_VIEWER_ADDRESS_HEADER]: '203.0.113.7',
  })).toBe('203.0.113.7')
})

test('ignores forged viewer headers on direct HTTP API requests', async () => {
  process.env.MUKUROJI_EDGE_ORIGIN_SECRET = edgeSecret

  expect(await resolveSourceFor({
    [EDGE_ORIGIN_SECRET_HEADER]: 'guessed-secret',
    [EDGE_VIEWER_ADDRESS_HEADER]: '203.0.113.7',
    'X-Forwarded-For': '198.51.100.1',
  })).toBe('transport-unavailable')

  delete process.env.MUKUROJI_EDGE_ORIGIN_SECRET
  expect(await resolveSourceFor({
    [EDGE_ORIGIN_SECRET_HEADER]: edgeSecret,
    [EDGE_VIEWER_ADDRESS_HEADER]: '203.0.113.7',
  })).toBe('transport-unavailable')
})
