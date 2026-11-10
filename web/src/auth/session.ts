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

  if (session.expiresAt <= Date.now()) {
    clearAuthSession()
    return null
  }

  return session
}

/**
 * Checks, without side effects, that a stored unexpired session still holds this token.
 *
 * A tab keeps its token in memory, so another tab's sign-out of a shared remembered
 * session is visible only in storage.
 *
 * @param accessToken - Token the caller is using.
 * @returns Whether storage still holds an unexpired session with that token.
 */
export function hasStoredAuthSession(accessToken: string): boolean {
  if (typeof window === 'undefined') return false
  // Each store is checked on its own: another tab's remembered session in localStorage must
  // not hide this tab's session-only token in sessionStorage.
  return [window.localStorage, window.sessionStorage].some((storage) => {
    const session = readSession(storage)
    return session !== null && session.accessToken === accessToken && session.expiresAt > Date.now()
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
