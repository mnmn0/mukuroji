import { afterEach, describe, expect, test } from 'bun:test'
import {
  createDocumentRealtimeTicket,
  parseDocumentChangeSignal,
} from '../src/documents/api/realtime'
import { DocumentsApiError } from '../src/documents/api/errors'
import {
  documentCommentsRefreshIntervals,
  documentDetailRefreshIntervals,
} from '../src/documents/queries/useDocumentQueries'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a fake that answers every request with one JSON response.
 *
 * @param body - JSON response body.
 * @param status - HTTP status.
 * @returns URLs and methods the fake received.
 */
function installFetch(body: unknown, status: number): string[] {
  const requests: string[] = []
  const fakeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return Response.json(body, { status })
  }
  globalThis.fetch = fakeFetch
  return requests
}

describe('Document change signals', () => {
  test('requests a ticket for the open Document', async () => {
    const requests = installFetch({
      ticket: 'one-time-ticket',
      websocketUrl: 'wss://realtime.example.com/production',
      expiresAt: '2026-11-21T09:01:00.000Z',
      sessionExpiresAt: '2026-11-21T09:05:00.000Z',
    }, 201)

    const ticket = await createDocumentRealtimeTicket('token', 'doc/1')

    expect(ticket).toEqual({
      ticket: 'one-time-ticket',
      websocketUrl: 'wss://realtime.example.com/production',
      sessionExpiresAt: '2026-11-21T09:05:00.000Z',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatch(/^POST .*\/documents\/doc%2F1\/realtime\/tickets$/)
  })

  test('falls back to polling when the deployment has no WebSocket', async () => {
    installFetch({ code: 'RealtimeUnavailable', message: 'use polling' }, 503)

    expect(await createDocumentRealtimeTicket('token', 'doc-1')).toBeUndefined()
  })

  test('surfaces a denied ticket as an API error', async () => {
    installFetch({ code: 'DocumentNotFound', message: 'Document was not found.' }, 404)

    await expect(createDocumentRealtimeTicket('token', 'doc-1'))
      .rejects.toBeInstanceOf(DocumentsApiError)
  })

  test('reads only well-formed change signals', () => {
    expect(parseDocumentChangeSignal(JSON.stringify({
      type: 'document.changed',
      documentId: 'doc-1',
      part: 'comments',
      originClientId: 'client-a',
    }))).toEqual({ documentId: 'doc-1', part: 'comments', originClientId: 'client-a' })
    expect(parseDocumentChangeSignal(JSON.stringify({
      type: 'collaboration.invalidated',
      documentId: 'doc-1',
      part: 'comments',
    }))).toBeUndefined()
    expect(parseDocumentChangeSignal(JSON.stringify({
      type: 'document.changed',
      documentId: 'doc-1',
      part: 'shares',
    }))).toBeUndefined()
    expect(parseDocumentChangeSignal('not json')).toBeUndefined()
  })

  test('polls slowly only while change signals arrive', () => {
    expect(documentDetailRefreshIntervals).toEqual({ polling: 3_500, realtime: 60_000 })
    expect(documentCommentsRefreshIntervals).toEqual({ polling: 4_000, realtime: 60_000 })
  })
})
