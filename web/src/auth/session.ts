/**
 * ブラウザに保存する Cognito 認証セッションです。
 */
export type AuthSession = {
  accessToken: string
  idToken?: string
  refreshToken?: string
  expiresAt: number
  tokenType: string
  remember: boolean
}

const storageKey = 'mukuroji.auth'

/**
 * localStorage または sessionStorage から有効期限内の認証セッションを取得します。
 */
export function getAuthSession() {
  const session = readSession(window.localStorage) ?? readSession(window.sessionStorage)

  if (!session) {
    return null
  }

  if (session.expiresAt <= Date.now()) {
    clearAuthSession()
    return null
  }

  return session
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
