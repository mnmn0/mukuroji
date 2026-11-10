import { clearAppBadgeAndNotifyTabs } from '../shared/lib/pwa/appBadge'

/**
 * ブラウザに保存する Cognito 認証セッションです。
 */
export type AuthSession = {
  /**
   * Cognito の access token です。
   */
  accessToken: string
  /**
   * Cognito の ID token です。
   */
  idToken?: string
  /**
   * Cognito の refresh token です。
   */
  refreshToken?: string
  /**
   * セッション有効期限の Unix time milliseconds です。
   */
  expiresAt: number
  /**
   * Authorization header に使う token type です。
   */
  tokenType: string
  /**
   * localStorage に保持するかどうかのユーザー選択です。
   */
  remember: boolean
}

const storageKey = 'mukuroji.auth'

/**
 * localStorage または sessionStorage から有効期限内の認証セッションを取得します。
 */
export function getAuthSession() {
  const session = readSession(window.localStorage) ?? readSession(window.sessionStorage)

  if (!session) {
    // A stored value that no longer parses still belongs to a previous sign-in, so destroy it
    // the same way as an expired one and clear that account's badge.
    if (hasStoredSessionValue()) clearAuthSession()
    return null
  }

  // An expired access token is still a live session while a refresh token can renew it; the
  // authenticated fetch refreshes it before the next API request.
  if (session.expiresAt <= Date.now() && !session.refreshToken) {
    clearAuthSession()
    return null
  }

  return session
}

/**
 * Reads the stored authentication session as it is, without expiry checks or side effects.
 *
 * @returns The stored session, or `null` when nothing valid is stored.
 */
export function readStoredAuthSession(): AuthSession | null {
  if (typeof window === 'undefined') return null
  try {
    return readSession(window.localStorage) ?? readSession(window.sessionStorage)
  } catch {
    return null
  }
}

/**
 * Finds the stored session that a token belongs to.
 *
 * A tab may hold a session-only sign-in in sessionStorage while another tab remembers a
 * different account in localStorage, so the session is matched by its account rather than
 * by which storage wins.
 *
 * @param accessToken - Access token the caller holds, possibly replaced by a refresh since.
 * @returns The matching stored session, or `null` when none matches.
 */
export function findStoredAuthSession(accessToken: string): AuthSession | null {
  if (typeof window === 'undefined') return null
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      const session = readSession(storage)
      if (session && isSameAuthSessionToken(session.accessToken, accessToken)) return session
    }
  } catch {
    // Storage access can throw in restricted contexts; the caller then has no stored session.
  }
  return null
}

/**
 * Replaces a stored session with its refreshed version, in the storage it already uses.
 *
 * Unlike {@link saveAuthSession}, this leaves the other storage alone, so a refresh of a
 * session-only sign-in never removes another account remembered in localStorage.
 *
 * @param session - Refreshed session.
 */
export function replaceStoredAuthSession(session: AuthSession) {
  try {
    const storage = session.remember ? window.localStorage : window.sessionStorage
    storage.setItem(storageKey, JSON.stringify(session))
  } catch {
    // The refreshed token still serves this tab's requests when storage refuses the write.
  }
}

/**
 * Removes the stored session that holds a refresh token, leaving any other sign-in in place.
 *
 * @param refreshToken - Refresh token of the session to remove.
 */
export function removeStoredAuthSession(refreshToken: string) {
  let removed = false
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      if (readSession(storage)?.refreshToken === refreshToken) {
        storage.removeItem(storageKey)
        removed = true
      }
    }
  } catch {
    // Nothing more can be removed when storage access fails.
  }
  if (removed) void clearAppBadgeAndNotifyTabs()
}

/**
 * Checks whether two access tokens belong to the same signed-in account on this device.
 *
 * A refresh replaces the access token, while pages keep the token they read when they
 * mounted. Tokens of one account share their subject, so either token can stand for the
 * session. Tokens that are not JWTs (the local Cognito emulator) only match themselves or
 * a token this tab replaced by refreshing.
 *
 * @param left - First access token.
 * @param right - Second access token.
 * @returns Whether both tokens stand for the same signed-in account.
 */
export function isSameAuthSessionToken(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  if (left === right) return true
  if (replacedAccessTokens.get(left) === right || replacedAccessTokens.get(right) === left) return true
  const leftSubject = readAccessTokenSubject(left)
  return leftSubject !== undefined && leftSubject === readAccessTokenSubject(right)
}

/**
 * Records that this tab replaced an access token by refreshing it.
 *
 * @param previousAccessToken - Access token before the refresh.
 * @param accessToken - Access token after the refresh.
 */
export function recordReplacedAccessToken(previousAccessToken: string, accessToken: string) {
  for (const [replaced, replacement] of replacedAccessTokens) {
    if (replacement === previousAccessToken) replacedAccessTokens.set(replaced, accessToken)
  }
  replacedAccessTokens.set(previousAccessToken, accessToken)
}

/** Access tokens this tab replaced by refreshing, mapped to their current replacement. */
const replacedAccessTokens = new Map<string, string>()

/**
 * Checks, without side effects, that storage still holds a usable session for this token.
 *
 * A tab keeps its token in memory, so another tab's sign-out of a shared remembered
 * session is visible only in storage. A refresh in any tab replaces the stored token, so a
 * session of the same account counts as the same session.
 *
 * @param accessToken - Token the caller is using.
 * @returns Whether storage still holds a usable session of that token's account.
 */
export function hasStoredAuthSession(accessToken: string): boolean {
  if (typeof window === 'undefined') return false
  // Each store is checked on its own: another tab's remembered session in localStorage must
  // not hide this tab's session-only token in sessionStorage.
  return [window.localStorage, window.sessionStorage].some((storage) => {
    const session = readSession(storage)
    return session !== null &&
      isSameAuthSessionToken(session.accessToken, accessToken) &&
      (session.expiresAt > Date.now() || Boolean(session.refreshToken))
  })
}

/**
 * ユーザーの保持設定に合わせて認証セッションを保存します。
 */
export function saveAuthSession(session: AuthSession) {
  const targetStorage = session.remember ? window.localStorage : window.sessionStorage
  const staleStorage = session.remember ? window.sessionStorage : window.localStorage

  staleStorage.removeItem(storageKey)
  targetStorage.setItem(storageKey, JSON.stringify(session))
}

/**
 * 保存済みの認証セッションをすべて削除します。
 */
export function clearAuthSession() {
  window.localStorage.removeItem(storageKey)
  window.sessionStorage.removeItem(storageKey)
  // Every sign-out path destroys the session here, so the app-wide unread badge is cleared with it;
  // other tabs that are still signed in republish their own count.
  void clearAppBadgeAndNotifyTabs()
}

/**
 * Checks whether either storage holds a session value, valid or not.
 *
 * @returns Whether a stored session value exists.
 */
function hasStoredSessionValue(): boolean {
  return [window.localStorage, window.sessionStorage].some((storage) => storage.getItem(storageKey) !== null)
}

function readSession(storage: Storage) {
  const value = storage.getItem(storageKey)

  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<AuthSession>

    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.tokenType !== 'string' ||
      typeof parsed.remember !== 'boolean'
    ) {
      return null
    }

    return parsed as AuthSession
  } catch {
    return null
  }
}

/**
 * Reads the subject (`sub`) of a JWT access token without verifying it, to tell signed-in
 * accounts apart on this device. It is never used to authorize anything.
 *
 * @param accessToken - Access token.
 * @returns The subject, or `undefined` when the token is not a JWT with a string subject.
 */
export function readAccessTokenSubject(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1]
  if (!payload) return undefined
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const data: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
    return typeof data === 'object' && data !== null && 'sub' in data && typeof data.sub === 'string' ? data.sub : undefined
  } catch {
    return undefined
  }
}
