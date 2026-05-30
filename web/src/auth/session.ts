export type AuthSession = {
  accessToken: string
  idToken?: string
  refreshToken?: string
  expiresAt: number
  tokenType: string
  remember: boolean
}

const storageKey = 'mukuroji.auth'

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

export function saveAuthSession(session: AuthSession) {
  const targetStorage = session.remember ? window.localStorage : window.sessionStorage
  const staleStorage = session.remember ? window.sessionStorage : window.localStorage

  staleStorage.removeItem(storageKey)
  targetStorage.setItem(storageKey, JSON.stringify(session))
}

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
