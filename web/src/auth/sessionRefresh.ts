import { resolveApiBaseUrl } from '../shared/api/apiBaseUrl'
import { isRecord } from '../shared/api/jsonValidation'
import {
  clearAuthSession,
  isSameAuthSessionToken,
  readStoredAuthSession,
  recordReplacedAccessToken,
  saveAuthSession,
  type AuthSession,
} from './session'

/** Refreshes the access token when it has less than this long left. */
const refreshLeadMilliseconds = 60_000

/** Longest wait for the server-side sign-out before the local session is cleared anyway. */
const revokeTimeoutMilliseconds = 3_000

/** Outcome of one refresh attempt. */
type RefreshOutcome =
  /** The session now holds a fresh access token. */
  | { status: 'refreshed'; session: AuthSession }
  /** The refresh token no longer works; the user has to sign in again. */
  | { status: 'rejected' }
  /** The refresh could not reach a verdict, for example offline or a server failure. */
  | { status: 'unavailable' }

/** Refresh already running in this tab, shared by every request that needs it. */
let inFlightRefresh: Promise<RefreshOutcome> | undefined

/** `fetch` as it was before the authenticated fetch wrapped it. */
let baseFetch: typeof fetch = (...args) => globalThis.fetch(...args)

/**
 * Returns the API URL of an authentication endpoint.
 *
 * @param path - Endpoint path below the API base URL.
 * @returns The endpoint URL.
 */
function authenticationEndpoint(path: '/auth/refresh' | '/auth/logout') {
  return `${resolveApiBaseUrl()}${path}`
}

/**
 * Renews the stored session's access token with its refresh token.
 *
 * Concurrent callers in one tab share a single refresh. When another tab has already
 * refreshed the session, its newer token is used without asking the server again.
 *
 * @param staleAccessToken - Access token the caller found expired or rejected.
 * @returns The refresh outcome.
 */
export function refreshAuthSession(staleAccessToken: string): Promise<RefreshOutcome> {
  const stored = readStoredAuthSession()
  if (!stored?.refreshToken || !isSameAuthSessionToken(stored.accessToken, staleAccessToken)) {
    return Promise.resolve({ status: 'rejected' })
  }
  if (stored.accessToken !== staleAccessToken && !needsRefresh(stored)) {
    return Promise.resolve({ status: 'refreshed', session: stored })
  }
  inFlightRefresh ??= requestRefresh(stored).finally(() => {
    inFlightRefresh = undefined
  })
  return inFlightRefresh
}

/**
 * Checks whether a session's access token expires within the refresh lead time.
 *
 * @param session - Stored session.
 * @returns Whether the session should be refreshed before use.
 */
function needsRefresh(session: AuthSession) {
  return session.expiresAt - Date.now() <= refreshLeadMilliseconds
}

/**
 * Calls the refresh endpoint and stores the renewed session.
 *
 * @param session - Session to refresh; it must hold a refresh token.
 * @returns The refresh outcome.
 */
async function requestRefresh(session: AuthSession): Promise<RefreshOutcome> {
  let response: Response
  try {
    response = await baseFetch(authenticationEndpoint('/auth/refresh'), {
      method: 'POST',
      headers: {
        Authorization: `${session.tokenType} ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
  } catch {
    return { status: 'unavailable' }
  }

  if (response.status >= 500 || response.status === 429) {
    return { status: 'unavailable' }
  }
  const body: unknown = await response.json().catch(() => undefined)
  const renewed = response.ok ? readRefreshedSession(body, session) : undefined
  if (!renewed) {
    // Only clear the session that was refreshed: another tab may have signed in since.
    if (readStoredAuthSession()?.refreshToken === session.refreshToken) clearAuthSession()
    return { status: 'rejected' }
  }
  // Another tab may have signed out while the refresh was running.
  if (readStoredAuthSession()?.refreshToken !== session.refreshToken) {
    return { status: 'rejected' }
  }
  saveAuthSession(renewed)
  recordReplacedAccessToken(session.accessToken, renewed.accessToken)
  return { status: 'refreshed', session: renewed }
}

/**
 * Builds the renewed session from a refresh response.
 *
 * @param body - Parsed response body.
 * @param previous - Session that was refreshed.
 * @returns The renewed session, or `undefined` when the response is malformed.
 */
function readRefreshedSession(body: unknown, previous: AuthSession): AuthSession | undefined {
  if (
    !isRecord(body) ||
    typeof body.accessToken !== 'string' ||
    !body.accessToken ||
    typeof body.expiresAt !== 'number' ||
    !Number.isFinite(body.expiresAt) ||
    typeof body.tokenType !== 'string' ||
    !body.tokenType
  ) {
    return undefined
  }
  return {
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
    idToken: typeof body.idToken === 'string' ? body.idToken : previous.idToken,
    // Cognito returns a new refresh token only when rotation is on; otherwise the old one stays valid.
    refreshToken: typeof body.refreshToken === 'string' && body.refreshToken
      ? body.refreshToken
      : previous.refreshToken,
    remember: previous.remember,
    tokenType: body.tokenType,
  }
}

/**
 * Revokes the stored session's refresh token on the server, so it cannot resume after sign-out.
 *
 * Failures are ignored: the caller still clears the local session.
 *
 * @returns A promise that settles when the server answered or the wait ran out.
 */
export async function revokeStoredAuthSession(): Promise<void> {
  const session = readStoredAuthSession()
  if (!session?.refreshToken) return
  try {
    await baseFetch(authenticationEndpoint('/auth/logout'), {
      method: 'POST',
      headers: {
        Authorization: `${session.tokenType} ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      // Sign-out navigates away right after; the request must still reach the server.
      keepalive: true,
      signal: AbortSignal.timeout(revokeTimeoutMilliseconds),
    })
  } catch {
    // The local session is cleared regardless; the refresh token then expires on its own.
  }
}

/**
 * Reads the bearer token of a request.
 *
 * @param headers - Request headers.
 * @returns The bearer token, or `undefined`.
 */
function readBearerToken(headers: Headers) {
  return headers.get('Authorization')?.match(/^Bearer\s+(.+)$/iu)?.[1]
}

/**
 * Checks whether a request targets an endpoint the authenticated fetch must not wrap.
 *
 * @param url - Request URL.
 * @returns Whether the request refreshes or revokes the session itself.
 */
function isSessionEndpoint(url: string) {
  return /\/auth\/(?:refresh|logout)(?:[?#]|$)/u.test(url)
}

/**
 * Wraps `fetch` so API requests keep working past the access token's expiry.
 *
 * Pages read the session once and keep sending its access token. For a request whose bearer
 * token belongs to the stored session, the wrapper sends the current stored token instead,
 * refreshes it first when it is about to expire, and on a `401` refreshes once and retries.
 * When the refresh cannot reach a verdict, the `401` becomes a retryable `503` so the page
 * keeps the user's input instead of treating the session as ended. A rejected refresh leaves
 * the `401` as it is, and the page asks the user to sign in again.
 *
 * @param target - Global object whose `fetch` is wrapped. Defaults to `globalThis`.
 * @returns A function that restores the original `fetch`.
 */
export function installAuthSessionFetch(target: { fetch: typeof fetch } = globalThis): () => void {
  const originalFetch = target.fetch
  baseFetch = originalFetch.bind(target)
  const send = baseFetch

  /** Authenticated replacement of `fetch`. */
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const requestToken = readBearerToken(headers)
    const stored = readStoredAuthSession()
    if (
      !requestToken ||
      isSessionEndpoint(url) ||
      !stored ||
      !isSameAuthSessionToken(stored.accessToken, requestToken)
    ) {
      return send(input, init)
    }

    /**
     * Sends the request with one access token.
     *
     * @param accessToken - Token for the Authorization header.
     * @returns The response.
     */
    const sendWith = (accessToken: string) => {
      const attemptHeaders = new Headers(headers)
      attemptHeaders.set('Authorization', `Bearer ${accessToken}`)
      return send(input instanceof Request ? input.clone() : input, { ...init, headers: attemptHeaders })
    }

    let session = stored
    if (needsRefresh(session) && session.refreshToken) {
      const outcome = await refreshAuthSession(session.accessToken)
      if (outcome.status === 'refreshed') session = outcome.session
    }
    const response = await sendWith(session.accessToken)
    if (response.status !== 401 || !session.refreshToken) return response

    const outcome = await refreshAuthSession(session.accessToken)
    if (outcome.status === 'refreshed' && outcome.session.accessToken !== session.accessToken) {
      // A one-shot body stream cannot be sent twice; the caller sees the original 401.
      if (init?.body instanceof ReadableStream) return response
      return sendWith(outcome.session.accessToken)
    }
    if (outcome.status === 'unavailable') {
      return new Response(JSON.stringify({
        code: 'AuthenticationRefreshUnavailable',
        message: 'The session could not be refreshed. Check the connection and try again.',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    }
    return response
  }

  target.fetch = authenticatedFetch
  return () => {
    target.fetch = originalFetch
    baseFetch = (...args) => globalThis.fetch(...args)
  }
}
