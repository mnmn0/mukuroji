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
 * Returns this tab's usable authentication session.
 *
 * Several tabs can be signed in to different accounts: a session-only sign-in lives in this
 * tab's sessionStorage while another account may be remembered in localStorage. The tab keeps
 * the account it first read or signed in to, so a page that mounts later never picks up another
 * account's token, and an unusable session is removed only from the store that holds it.
 *
 * @returns This tab's session, or `null` when it has none that can be used.
 */
export function getAuthSession() {
  removeMalformedSessions()

  const entry = findTabSessionEntry()
  if (!entry) return null

  // An expired access token is still a live session while a refresh token can renew it; the
  // authenticated fetch refreshes it before the next API request.
  if (entry.session.expiresAt <= Date.now() && !entry.session.refreshToken) {
    entry.storage.removeItem(storageKey)
    tabAccount = 'signed-out'
    void clearAppBadgeAndNotifyTabs()
    return null
  }

  tabAccount = { accessToken: entry.session.accessToken, remember: entry.session.remember }
  return entry.session
}

/**
 * Reads the stored authentication session as it is, without expiry checks or side effects.
 *
 * @returns This tab's stored session, or `null` when nothing valid is stored.
 */
export function readStoredAuthSession(): AuthSession | null {
  if (typeof window === 'undefined') return null
  try {
    return findTabSessionEntry()?.session ?? null
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
 * ユーザーの保持設定に合わせて認証セッションを保存し、この tab の account にします。
 *
 * 反対側の storage は、同じ account の古い session か読めない値のときだけ消します。別の tab が
 * 別の account で使っている session は残します。
 */
export function saveAuthSession(session: AuthSession) {
  const targetStorage = session.remember ? window.localStorage : window.sessionStorage
  const staleStorage = session.remember ? window.sessionStorage : window.localStorage

  const stale = staleStorage.getItem(storageKey)
  if (stale !== null) {
    const staleSession = readSession(staleStorage)
    if (!staleSession || isSameAuthSessionToken(staleSession.accessToken, session.accessToken)) {
      staleStorage.removeItem(storageKey)
    }
  }
  targetStorage.setItem(storageKey, JSON.stringify(session))
  tabAccount = { accessToken: session.accessToken, remember: session.remember }
}

/**
 * この tab の account の認証セッションを削除します。
 *
 * 別の tab が別の account でログインしている session は残します。この tab がまだ session を
 * 読んでいないときは、この tab から見える session を削除します。削除後の tab は、次のログインまで
 * ほかの account の session を読みも消しもしないので、2 回目の削除が別の account を消すことはありません。
 */
export function clearAuthSession() {
  try {
    const entry = findTabSessionEntry()
    entry?.storage.removeItem(storageKey)
    // The same account may also sit in the other store from an earlier sign-in.
    const otherStorage = entry?.storage === window.localStorage ? window.sessionStorage : window.localStorage
    const other = entry ? readSession(otherStorage) : null
    if (entry && other && isSameAuthSessionToken(other.accessToken, entry.session.accessToken)) {
      otherStorage.removeItem(storageKey)
    }
  } catch {
    // Nothing more can be removed when storage access fails.
  }
  tabAccount = 'signed-out'
  // Every sign-out path destroys the session here, so the app-wide unread badge is cleared with it;
  // other tabs that are still signed in republish their own count.
  void clearAppBadgeAndNotifyTabs()
}

/**
 * Account this tab has read or signed in to, kept for the life of the page so that pages that
 * mount later read the same account as the workspace shell. `'signed-out'` means this tab's
 * account was signed out or expired: until the next sign-in the tab has no session, so it never
 * switches to, or removes, another account's session.
 */
let tabAccount: { accessToken: string, remember: boolean } | 'signed-out' | null = null

/**
 * Forgets the account this tab has read. Tests use it to start from a fresh page.
 */
export function resetAuthSessionTabAccount() {
  tabAccount = null
}

/**
 * Finds this tab's stored session and the store that holds it.
 *
 * Without an account yet, this tab's own sessionStorage wins over a remembered session that
 * every tab shares. Once the tab has an account, only a session of that account is returned,
 * and after this tab signs out, none is.
 *
 * @returns The session and its store, or `null` when this tab has no stored session.
 */
function findTabSessionEntry(): { session: AuthSession, storage: Storage } | null {
  const entries = [window.sessionStorage, window.localStorage]
    .map((storage) => ({ session: readSession(storage), storage }))
    .filter((entry): entry is { session: AuthSession, storage: Storage } => entry.session !== null)
  if (tabAccount === 'signed-out') return null
  if (!tabAccount) return entries[0] ?? null
  const account = tabAccount
  return entries.find((entry) => isTabAccountSession(entry, account)) ?? null
}

/**
 * Checks whether a stored session belongs to this tab's account.
 *
 * Tokens without a subject (the local Cognito emulator) cannot be told apart after another tab
 * refreshes them, so for those the session in the store the tab signed in with still counts.
 *
 * @param entry - Stored session and its store.
 * @param account - This tab's account.
 * @returns Whether the session belongs to the account.
 */
function isTabAccountSession(
  entry: { session: AuthSession, storage: Storage },
  account: { accessToken: string, remember: boolean },
) {
  if (isSameAuthSessionToken(entry.session.accessToken, account.accessToken)) return true
  const accountStorage = account.remember ? window.localStorage : window.sessionStorage
  return entry.storage === accountStorage &&
    readAccessTokenSubject(account.accessToken) === undefined &&
    readAccessTokenSubject(entry.session.accessToken) === undefined
}

/**
 * Removes stored session values that no longer parse. They still belong to a previous sign-in,
 * so they are destroyed the same way as an expired session, including that account's badge.
 */
function removeMalformedSessions() {
  let removed = false
  for (const storage of [window.sessionStorage, window.localStorage]) {
    if (storage.getItem(storageKey) !== null && !readSession(storage)) {
      storage.removeItem(storageKey)
      removed = true
    }
  }
  if (removed) void clearAppBadgeAndNotifyTabs()
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
