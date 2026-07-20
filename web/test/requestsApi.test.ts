import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyRequestSubmissionAction,
  createRequestAttachmentAccess,
  getPublicRequestForm,
  getRequestForm,
  getRequestForms,
  getRequestQueue,
  getRequestThread,
  publishRequestForm,
  replyToRequestThread,
  submitPublicRequest,
  updateRequestForm,
} from '../src/requests/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'request-correlation-1',
  idempotencyKey: 'request-idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('request admin API', () => {
  test('encodes identifiers and attaches auth plus stable mutation headers', async () => {
    const requests = installFetchRecorder([
      { forms: [] },
      { id: 'form/1' },
      { id: 'form/1' },
      { submissions: [] },
      { id: 'submission/1', revision: 2 },
    ])

    await getRequestForms('access-token')
    await getRequestForm('form/1', 'access-token')
    await updateRequestForm(
      'form/1',
      { expectedRevision: 1, name: 'Form one' },
      'access-token',
      mutationContext,
    )
    await getRequestQueue('access-token', { limit: 25, status: 'received' })
    await applyRequestSubmissionAction(
      'submission/1',
      { action: 'assign', assigneeUserId: 'demo@example.com', expectedRevision: 1 },
      'access-token',
      mutationContext,
    )

    expect(requests.map((request) => request.url)).toEqual([
      '/api/request-forms',
      '/api/request-forms/form%2F1',
      '/api/request-forms/form%2F1',
      '/api/request-queue?limit=25&status=received',
      '/api/request-submissions/submission%2F1/actions',
    ])
    expect(requests.every((request) =>
      new Headers(request.init.headers).get('Authorization') === 'Bearer access-token'
    )).toBe(true)
    expect(new Headers(requests[2]?.init.headers).get('Idempotency-Key')).toBe(
      'request-idempotency-1',
    )
    expect(new Headers(requests[4]?.init.headers).get('X-Correlation-Id')).toBe(
      'request-correlation-1',
    )
  })

  test('publishes the expected form revision', async () => {
    const requests = installFetchRecorder([{ id: 'form-1' }])

    await publishRequestForm('form-1', { expectedRevision: 7 }, 'access-token', mutationContext)

    expect(requests[0]?.url).toBe('/api/request-forms/form-1/publish')
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ expectedRevision: 7 })
  })

  test('follows opaque queue cursors and creates scan-gated attachment access', async () => {
    const requests = installFetchRecorder([
      { submissions: [] },
      { expiresAt: '2026-07-16T03:00:00.000Z', url: 'https://files.example/signed' },
    ])

    await getRequestQueue('access-token', { cursor: 'opaque/cursor', limit: 50 })
    await createRequestAttachmentAccess(
      'submission/1',
      'attachment/1',
      'access-token',
      mutationContext,
    )

    expect(requests.map((request) => request.url)).toEqual([
      '/api/request-queue?cursor=opaque%2Fcursor&limit=50',
      '/api/request-submissions/submission%2F1/attachments/attachment%2F1/access',
    ])
    expect(requests[1]?.init.method).toBe('POST')
    expect(new Headers(requests[1]?.init.headers).get('Idempotency-Key')).toBe(
      'request-idempotency-1',
    )
  })
})

describe('public request API boundary', () => {
  test('does not send Authorization for a public link and supports optional auth-required links', async () => {
    const requests = installFetchRecorder([{}, {}, {}])

    await getPublicRequestForm('public/token')
    await getPublicRequestForm('member/token', 'access-token')

    expect(requests.map((request) => request.url)).toEqual([
      '/api/request-intake/public%2Ftoken',
      '/api/request-intake/member%2Ftoken',
    ])
    expect(new Headers(requests[0]?.init.headers).has('Authorization')).toBe(false)
    expect(new Headers(requests[1]?.init.headers).get('Authorization')).toBe(
      'Bearer access-token',
    )
  })

  test('submits visible answers and replies only through opaque thread tokens', async () => {
    const requests = installFetchRecorder([{}, {}])

    await submitPublicRequest(
      'public/token',
      {
        answers: { summary: 'Need help' },
        attachmentClaims: { 'attachment-old-session': 'C'.repeat(43) },
        consentAccepted: true,
        locale: 'ja',
        sessionToken: 'submission-session',
      },
      mutationContext,
    )
    await getRequestThread('thread/token')
    await replyToRequestThread('thread/token', { body: '追加情報です。' }, mutationContext)

    expect(requests.map((request) => request.url)).toEqual([
      '/api/request-intake/public%2Ftoken/submissions',
      '/api/request-threads/thread%2Ftoken',
      '/api/request-threads/thread%2Ftoken/replies',
    ])
    expect(new Headers(requests[0]?.init.headers).has('Authorization')).toBe(false)
    expect(new Headers(requests[1]?.init.headers).has('Authorization')).toBe(false)
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      attachmentClaims: { 'attachment-old-session': 'C'.repeat(43) },
    })
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({ body: '追加情報です。' })
  })
})

function installFetchRecorder(responseBodies: unknown[]) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })
    const responseBody = responseBodies.shift() ?? {}

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
