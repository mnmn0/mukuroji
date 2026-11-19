import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearAuthSession,
  getAuthSession,
  readStoredAuthSession,
  resetAuthSessionTabAccount,
  saveAuthSession,
  type AuthSession,
} from '../src/auth/session'

/** In-memory Web Storage. */
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

const storageKey = 'mukuroji.auth'
const previousWindow = Reflect.get(globalThis, 'window')
const previousNavigator = Reflect.get(globalThis, 'navigator')
let localStorage: MemoryStorage
let sessionStorage: MemoryStorage

/**
 * Creates an unsigned JWT-shaped access token for one account.
 *
 * @param subject - Account subject.
 * @param id - Distinguishes tokens of the same account.
 * @returns The token.
 */
function token(subject: string, id = '1') {
  const payload = Buffer.from(JSON.stringify({ sub: subject, jti: id })).toString('base64url')
  return `header.${payload}.signature`
}

/**
 * Builds a session for one account.
 *
 * @param accessToken - Access token.
 * @param remember - Whether the session is remembered in localStorage.
 * @param overrides - Fields that differ from a fresh session.
 * @returns The session.
 */
function session(accessToken: string, remember: boolean, overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken,
    expiresAt: Date.now() + 30 * 60_000,
    refreshToken: `refresh-${accessToken}`,
    remember,
    tokenType: 'Bearer',
    ...overrides,
  }
}

/**
 * Writes a session the way another tab would, without touching this tab's account.
 *
 * @param storage - Store to write.
 * @param value - Session to store.
 */
function storeFromAnotherTab(storage: MemoryStorage, value: AuthSession) {
  storage.setItem(storageKey, JSON.stringify(value))
}

/**
 * Reads the session a store holds.
 *
 * @param storage - Store to read.
 * @returns The stored session, or `null`.
 */
function stored(storage: MemoryStorage): AuthSession | null {
  return JSON.parse(storage.getItem(storageKey) ?? 'null') as AuthSession | null
}

beforeEach(() => {
  resetAuthSessionTabAccount()
  localStorage = new MemoryStorage()
  sessionStorage = new MemoryStorage()
  Reflect.set(globalThis, 'window', { localStorage, sessionStorage })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
})

afterEach(() => {
  Reflect.set(globalThis, 'window', previousWindow)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
})

describe('sessions of different accounts in different tabs', () => {
  test("reads this tab's session-only sign-in before another account remembered on the device", () => {
    const remembered = session(token('account-a'), true)
    const tabOnly = session(token('account-b'), false)
    storeFromAnotherTab(localStorage, remembered)
    storeFromAnotherTab(sessionStorage, tabOnly)

    expect(getAuthSession()).toEqual(tabOnly)
    expect(readStoredAuthSession()).toEqual(tabOnly)
  })

  test('keeps reading the account the tab started with after another tab remembers a different account', () => {
    const first = session(token('account-a'), true)
    storeFromAnotherTab(localStorage, first)
    expect(getAuthSession()).toEqual(first)

    const other = session(token('account-c'), true)
    storeFromAnotherTab(localStorage, other)

    // A page that mounts now must not act as the other account behind this tab's shell.
    expect(getAuthSession()).toBeNull()
    expect(readStoredAuthSession()).toBeNull()
    // Signing this tab out leaves the other account signed in.
    clearAuthSession()
    expect(stored(localStorage)).toEqual(other)
  })

  test("follows a refresh of the tab's account made in another tab", () => {
    storeFromAnotherTab(localStorage, session(token('account-a', '1'), true))
    getAuthSession()

    const refreshed = session(token('account-a', '2'), true)
    storeFromAnotherTab(localStorage, refreshed)

    expect(getAuthSession()).toEqual(refreshed)
  })

  test('follows a refresh of a non-JWT emulator token in the store the tab signed in with', () => {
    storeFromAnotherTab(localStorage, session('emulator-token-1', true))
    getAuthSession()

    const refreshed = session('emulator-token-2', true)
    storeFromAnotherTab(localStorage, refreshed)

    expect(getAuthSession()).toEqual(refreshed)
  })

  test("an expired remembered session of another account leaves this tab's session alone", () => {
    const expired = session(token('account-a'), true, { expiresAt: Date.now() - 1, refreshToken: undefined })
    const tabOnly = session(token('account-b'), false)
    storeFromAnotherTab(localStorage, expired)
    storeFromAnotherTab(sessionStorage, tabOnly)

    expect(getAuthSession()).toEqual(tabOnly)
    expect(stored(sessionStorage)).toEqual(tabOnly)
  })

  test('an expired session is removed only from the store that holds it', () => {
    const remembered = session(token('account-a'), true)
    const expired = session(token('account-b'), false, { expiresAt: Date.now() - 1, refreshToken: undefined })
    storeFromAnotherTab(localStorage, remembered)
    storeFromAnotherTab(sessionStorage, expired)

    expect(getAuthSession()).toBeNull()
    expect(stored(sessionStorage)).toBeNull()
    expect(stored(localStorage)).toEqual(remembered)
  })

  test("signing out after a 401 removes only this tab's account", () => {
    const remembered = session(token('account-a'), true)
    const tabOnly = session(token('account-b'), false)
    storeFromAnotherTab(localStorage, remembered)
    storeFromAnotherTab(sessionStorage, tabOnly)
    getAuthSession()

    clearAuthSession()

    expect(stored(sessionStorage)).toBeNull()
    expect(stored(localStorage)).toEqual(remembered)
    // The cleared tab now reads nothing of its own and falls back to the remembered account.
    expect(getAuthSession()).toEqual(remembered)
  })

  test('signing out removes both stores when they hold the same account', () => {
    storeFromAnotherTab(localStorage, session(token('account-a', '1'), true))
    storeFromAnotherTab(sessionStorage, session(token('account-a', '2'), false))
    getAuthSession()

    clearAuthSession()

    expect(stored(sessionStorage)).toBeNull()
    expect(stored(localStorage)).toBeNull()
  })

  test('a session-only sign-in keeps another account remembered on the device', () => {
    const remembered = session(token('account-a'), true)
    storeFromAnotherTab(localStorage, remembered)

    const tabOnly = session(token('account-b'), false)
    saveAuthSession(tabOnly)

    expect(stored(localStorage)).toEqual(remembered)
    expect(getAuthSession()).toEqual(tabOnly)
  })

  test('a sign-in replaces the same account kept in the other store', () => {
    storeFromAnotherTab(sessionStorage, session(token('account-a', '1'), false))

    const remembered = session(token('account-a', '2'), true)
    saveAuthSession(remembered)

    expect(stored(sessionStorage)).toBeNull()
    expect(getAuthSession()).toEqual(remembered)
  })

  test('a sign-in makes the new account the tab account', () => {
    storeFromAnotherTab(localStorage, session(token('account-a'), true))
    getAuthSession()

    const tabOnly = session(token('account-b'), false)
    saveAuthSession(tabOnly)

    expect(getAuthSession()).toEqual(tabOnly)
  })
})
