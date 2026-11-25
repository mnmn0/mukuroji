import { afterEach, describe, expect, test } from 'bun:test'
import type { MyRequestDetail } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { getMyRequest, getMyRequests, replyToMyRequest } from '../src/requests/api'
import { readMyRequestId, resolveMyRequestStatusKey } from '../src/requests/model/myRequests'
import { MyRequestsView } from '../src/requests/ui/MyRequestsView'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a stub that returns the given JSON bodies in order and records calls.
 *
 * @param bodies - JSON bodies returned one per call.
 * @returns The recorded request URLs and options.
 */
function installFetch(bodies: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(bodies.shift() ?? {}), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  return calls
}

const detail: MyRequestDetail = {
  id: 'req-1',
  receiptId: 'rcpt-1',
  formTitle: 'IT 依頼',
  status: 'converted',
  awaitingReply: false,
  workItem: { visibility: 'restricted', completed: true },
  submittedAt: '2026-07-16T08:30:00.000Z',
  updatedAt: '2026-07-16T09:00:00.000Z',
  thread: {
    status: 'closed',
    messages: [{ id: 'm1', direction: 'staff', body: 'Which laptop?', createdAt: '2026-07-16T09:00:00.000Z' }],
    updatedAt: '2026-07-16T09:00:00.000Z',
  },
}

describe('my requests model', () => {
  test('reads a converted request with a completed Work Item as completed', () => {
    expect(resolveMyRequestStatusKey(detail)).toBe('requests.mine.status.completed')
    expect(resolveMyRequestStatusKey({ status: 'converted' })).toBe('requests.mine.status.converted')
    expect(resolveMyRequestStatusKey({ status: 'needs-more-info' })).toBe('requests.mine.status.needs-more-info')
  })

  test('accepts only a short request ID from the query', () => {
    expect(readMyRequestId(' req-1 ')).toBe('req-1')
    expect(readMyRequestId(null)).toBeUndefined()
    expect(readMyRequestId('x'.repeat(201))).toBeUndefined()
  })
})

describe('my requests API', () => {
  test('drops malformed entries and keeps the cursor', async () => {
    const calls = installFetch([{
      requests: [
        { ...detail, thread: undefined },
        { id: 'bad', status: 'unknown' },
      ],
      nextCursor: 'next',
    }])
    const page = await getMyRequests('token', { cursor: 'c/1', limit: 20 })
    expect(calls[0]?.url).toEndWith('/my-requests?cursor=c%2F1&limit=20')
    expect(page.nextCursor).toBe('next')
    expect(page.requests.map((request) => request.id)).toEqual(['req-1'])
    expect(page.requests[0]?.workItem).toEqual({ visibility: 'restricted', completed: true })
  })

  test('treats a list response without requests as an error, not an empty list', async () => {
    installFetch([{ nextCursor: 'next' }, { requests: [] }])
    await expect(getMyRequests('token')).rejects.toMatchObject({ status: 502 })
    await expect(getMyRequests('token')).resolves.toEqual({ requests: [] })
  })

  test('reads the detail thread and sends replies with mutation headers', async () => {
    const calls = installFetch([detail, { replyId: 'reply-1', receivedAt: '2026-07-16T10:00:00.000Z' }])
    const loaded = await getMyRequest('token', 'req/1')
    expect(calls[0]?.url).toEndWith('/my-requests/req%2F1')
    expect(loaded.thread.messages).toHaveLength(1)
    const receipt = await replyToMyRequest('token', 'req-1', { body: 'Blue' }, {
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
    })
    expect(receipt.replyId).toBe('reply-1')
    expect(calls[1]?.init?.method).toBe('POST')
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBe('idem-1')
  })
})

describe('my requests view', () => {
  test('hides Work Item details the member cannot open and closes replies', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <MyRequestsView
          canLoadMore={false}
          hasDetailError={false}
          isDetailLoading={false}
          hasLoadError={false}
          isLoading={false}
          locale="en"
          onLoadMore={() => undefined}
          onRetryDetail={() => undefined}
          onRetryList={() => undefined}
          onReply={async () => undefined}
          onSelectRequest={() => undefined}
          requests={[detail]}
          selectedRequest={detail}
          selectedRequestId="req-1"
          t={createTranslator('en')}
        />
      </MemoryRouter>,
    )
    expect(markup).toContain('Which laptop?')
    expect(markup).not.toContain('<textarea')
    expect(markup).not.toContain('href="/teams/')
  })

  test('keeps the loaded detail beside a reload error', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <MyRequestsView
          canLoadMore={false}
          hasDetailError
          hasLoadError={false}
          isDetailLoading={false}
          isLoading={false}
          locale="en"
          onLoadMore={() => undefined}
          onRetryDetail={() => undefined}
          onRetryList={() => undefined}
          onReply={async () => undefined}
          onSelectRequest={() => undefined}
          requests={[detail]}
          selectedRequest={detail}
          selectedRequestId="req-1"
          t={createTranslator('en')}
        />
      </MemoryRouter>,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Which laptop?')
  })

  test('announces list and detail loading', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <MyRequestsView
          canLoadMore={false}
          hasDetailError={false}
          hasLoadError={false}
          isDetailLoading
          isLoading
          locale="en"
          onLoadMore={() => undefined}
          onRetryDetail={() => undefined}
          onRetryList={() => undefined}
          onReply={async () => undefined}
          onSelectRequest={() => undefined}
          requests={[]}
          selectedRequestId="req-1"
          t={createTranslator('en')}
        />
      </MemoryRouter>,
    )
    expect(markup).toContain('Loading your requests…')
    expect(markup).toContain('Loading this request…')
    expect(markup).not.toContain('No requests yet')
  })
})
