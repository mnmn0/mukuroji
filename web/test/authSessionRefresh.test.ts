import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  getAuthSession,
  hasStoredAuthSession,
  readStoredAuthSession,
  saveAuthSession,
  type AuthSession,
} from '../src/auth/session'
import { installAuthSessionFetch, revokeStoredAuthSession } from '../src/auth/sessionRefresh'

/** In-memory Web Storage used for both localStorage and sessionStorage. */
class MemoryStorage {
  /** Stored values by key. */
  private readonly values = new Map<string, string>()

  /** Reads one value. */
  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  /** Writes one value. */
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  /** Removes one value. */
  removeItem(key: string) {
    this.values.delete(key)
  }
}

/** One request the fake server received. */
type RecordedRequest = {
  /** Request URL. */
  url: string
  /** Authorization header. */
  authorization: string | null
  /** Request body text. */
  body: string
}

const previousWindow = Reflect.get(globalThis, 'window')
const fetchTarget: { fetch: typeof fetch } = { fetch: globalThis.fetch }
let restoreFetch: () => void = () => undefined
let requests: RecordedRequest[] = []
let server: (request: RecordedRequest) => Response = () => new Response(null, { status: 404 })

/**
 * Creates an unsigned JWT-shaped access token for one account.
 *
 * @param subject - Account subject.
 * @param id - Distinguishes tokens of the same account.
 * @returns The token.
 */
function token(subject: string, id: string) {
  const payload = Buffer.from(JSON.stringify({ sub: subject, jti: id })).toString('base64url')
  return `header.${payload}.signature`
}

/**
 * Stores a session for the tests.
 *
 * @param overrides - Fields that differ from a fresh remembered session.
 * @returns The stored session.
 */
function storeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  const session: AuthSession = {
    accessToken: token('member', 'access-1'),
    expiresAt: Date.now() + 30 * 60_000,
    refreshToken: 'refresh-1',
    remember: true,
    tokenType: 'Bearer',
    ...overrides,
  }
  saveAuthSession(session)
  return session
}

/**
 * Builds a refresh endpoint response.
 *
 * @param accessToken - Renewed access token.
 * @returns The JSON response.
 */
function refreshed(accessToken: string) {
  return Response.json({
    accessToken,
    expiresAt: Date.now() + 60 * 60_000,
    idToken: 'id-2',
    tokenType: 'Bearer',
  })
}

beforeEach(() => {
  const storage = new MemoryStorage()
  Reflect.set(globalThis, 'window', { localStorage: storage, sessionStorage: new MemoryStorage() })
  requests = []
  fetchTarget.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'https://app.example'), init)
    const recorded = {
      url: new URL(request.url).pathname,
      authorization: request.headers.get('Authorization'),
      body: await request.text(),
    }
    requests.push(recorded)
    return server(recorded)
  }) as typeof fetch
  restoreFetch = installAuthSessionFetch(fetchTarget)
})

afterEach(() => {
  restoreFetch()
  Reflect.set(globalThis, 'window', previousWindow)
})

test('keeps an expired session that a refresh token can still renew', () => {
  const session = storeSession({ expiresAt: Date.now() - 1 })

  expect(getAuthSession()).toEqual(session)
  expect(hasStoredAuthSession(token('member', 'access-0'))).toBe(true)
  expect(hasStoredAuthSession(token('someone-else', 'access-0'))).toBe(false)
})

test('sends the current token of the session instead of the token a page kept', async () => {
  const session = storeSession()
  server = () => Response.json({ ok: true })

  await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${token('member', 'access-0')}` },
  })

  expect(requests).toEqual([{
    url: '/api/workspace',
    authorization: `Bearer ${session.accessToken}`,
    body: '',
  }])
})

test('refreshes an expiring token before sending the request', async () => {
  const session = storeSession({ expiresAt: Date.now() + 10_000 })
  const renewedToken = token('member', 'access-2')
  server = (request) => request.url === '/api/auth/refresh'
    ? refreshed(renewedToken)
    : Response.json({ ok: true })

  const response = await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })

  expect(response.status).toBe(200)
  expect(requests).toEqual([
    {
      url: '/api/auth/refresh',
      authorization: `Bearer ${session.accessToken}`,
      body: JSON.stringify({ refreshToken: 'refresh-1' }),
    },
    { url: '/api/workspace', authorization: `Bearer ${renewedToken}`, body: '' },
  ])
  expect(readStoredAuthSession()).toMatchObject({
    accessToken: renewedToken,
    idToken: 'id-2',
    refreshToken: 'refresh-1',
    remember: true,
  })
})

test('refreshes once on a 401 and retries the request with its body', async () => {
  const session = storeSession()
  const renewedToken = token('member', 'access-2')
  server = (request) => {
    if (request.url === '/api/auth/refresh') return refreshed(renewedToken)
    return request.authorization === `Bearer ${renewedToken}`
      ? Response.json({ saved: true })
      : Response.json({ message: 'expired' }, { status: 401 })
  }

  const [first, second] = await Promise.all([
    fetchTarget.fetch('/api/work-items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: '{"title":"draft"}',
    }),
    fetchTarget.fetch('/api/workspace', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    }),
  ])

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(requests.filter((request) => request.url === '/api/auth/refresh')).toHaveLength(1)
  expect(requests.filter((request) => request.url === '/api/work-items')).toEqual([
    { url: '/api/work-items', authorization: `Bearer ${session.accessToken}`, body: '{"title":"draft"}' },
    { url: '/api/work-items', authorization: `Bearer ${renewedToken}`, body: '{"title":"draft"}' },
  ])
})

test('leaves the 401 and clears the session when the refresh token is rejected', async () => {
  const session = storeSession()
  server = (request) => request.url === '/api/auth/refresh'
    ? Response.json({ code: 'RefreshTokenRejected' }, { status: 401 })
    : Response.json({ message: 'expired' }, { status: 401 })

  const response = await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })

  expect(response.status).toBe(401)
  expect(readStoredAuthSession()).toBeNull()
})

test('turns the 401 into a retryable 503 and keeps the session when the refresh is unavailable', async () => {
  const session = storeSession()
  server = (request) => request.url === '/api/auth/refresh'
    ? new Response(null, { status: 502 })
    : Response.json({ message: 'expired' }, { status: 401 })

  const response = await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'AuthenticationRefreshUnavailable' })
  expect(readStoredAuthSession()).toEqual(session)
})

test('passes requests of other accounts and without a bearer token through unchanged', async () => {
  storeSession()
  server = () => Response.json({ message: 'nope' }, { status: 401 })

  const other = await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${token('someone-else', 'access-9')}` },
  })
  const anonymous = await fetchTarget.fetch('/api/public')

  expect(other.status).toBe(401)
  expect(anonymous.status).toBe(401)
  expect(requests.map((request) => [request.url, request.authorization])).toEqual([
    ['/api/workspace', `Bearer ${token('someone-else', 'access-9')}`],
    ['/api/public', null],
  ])
})

test('revokes the refresh token on sign-out', async () => {
  const session = storeSession()
  server = () => new Response(null, { status: 204 })

  await revokeStoredAuthSession()

  expect(requests).toEqual([{
    url: '/api/auth/logout',
    authorization: `Bearer ${session.accessToken}`,
    body: JSON.stringify({ refreshToken: 'refresh-1' }),
  }])
})

test('refreshes and revokes the session of the account a tab uses, not the remembered one', async () => {
  const remembered = storeSession({ accessToken: token('other-account', 'access-9'), refreshToken: 'refresh-other' })
  const sessionOnly: AuthSession = {
    accessToken: token('member', 'access-1'),
    expiresAt: Date.now() + 10_000,
    refreshToken: 'refresh-1',
    remember: false,
    tokenType: 'Bearer',
  }
  window.sessionStorage.setItem('mukuroji.auth', JSON.stringify(sessionOnly))
  const renewedToken = token('member', 'access-2')
  server = (request) => {
    if (request.url === '/api/auth/refresh') return refreshed(renewedToken)
    if (request.url === '/api/auth/logout') return new Response(null, { status: 204 })
    return Response.json({ ok: true })
  }

  await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${sessionOnly.accessToken}` },
  })
  await revokeStoredAuthSession(sessionOnly.accessToken)

  expect(requests.map((request) => [request.url, request.authorization, request.body])).toEqual([
    ['/api/auth/refresh', `Bearer ${sessionOnly.accessToken}`, JSON.stringify({ refreshToken: 'refresh-1' })],
    ['/api/workspace', `Bearer ${renewedToken}`, ''],
    ['/api/auth/logout', `Bearer ${renewedToken}`, JSON.stringify({ refreshToken: 'refresh-1' })],
  ])
  // The remembered account stays signed in on this device.
  expect(JSON.parse(window.localStorage.getItem('mukuroji.auth') ?? 'null')).toEqual(remembered)
})

test('keeps the session when the refresh is throttled', async () => {
  const session = storeSession()
  server = (request) => request.url === '/api/auth/refresh'
    ? Response.json({ code: 'AuthenticationRefreshThrottled' }, { status: 429 })
    : Response.json({ message: 'expired' }, { status: 401 })

  const response = await fetchTarget.fetch('/api/workspace', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })

  expect(response.status).toBe(503)
  expect(readStoredAuthSession()).toEqual(session)
})
