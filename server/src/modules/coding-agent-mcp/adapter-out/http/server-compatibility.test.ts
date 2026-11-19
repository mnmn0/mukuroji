import { expect, test } from 'bun:test'
import { readServerCompatibility } from './server-compatibility'

/**
 * Builds a fetcher that records requests and returns one response.
 *
 * @param response - Response to return, or an error to throw.
 * @returns The fetcher and the recorded requests.
 */
function fakeFetch(response: Response | Error) {
  const requests: { url: URL; init: RequestInit }[] = []
  /** Records the request and answers with the configured response. */
  const fetcher = async (url: URL, init: RequestInit) => {
    requests.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }
  return { fetcher, requests }
}

test('reads the served range from public liveness without a credential or redirects', async () => {
  const { fetcher, requests } = fakeFetch(Response.json({ ok: true, status: 'alive', codingAgentMcp: { apiRevision: 3, minimumApiRevision: 2 } }))
  expect(await readServerCompatibility('https://mukuroji.example.com', fetcher)).toEqual({ apiRevision: 3, minimumApiRevision: 2 })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url.href).toBe('https://mukuroji.example.com/api/health')
  expect(requests[0]?.init.redirect).toBe('error')
  expect(new Headers(requests[0]?.init.headers).has('Authorization')).toBe(false)
})

test('returns undefined for older servers, failures, and unexpected bodies', async () => {
  const responses = [
    Response.json({ ok: true, status: 'alive' }),
    Response.json({ codingAgentMcp: { apiRevision: 1, minimumApiRevision: 2 } }),
    Response.json({ codingAgentMcp: { apiRevision: '1', minimumApiRevision: 1 } }),
    Response.json({}, { status: 503 }),
    new Response('alive', { headers: { 'Content-Type': 'text/plain' } }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ padding: 'x'.repeat(20_000) }), { headers: { 'Content-Type': 'application/json' } }),
    new TypeError('fetch failed'),
  ]
  for (const response of responses) {
    expect(await readServerCompatibility('https://mukuroji.example.com', fakeFetch(response).fetcher)).toBeUndefined()
  }
})
