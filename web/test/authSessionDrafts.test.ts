import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  clearAuthSession,
  getAuthSession,
  removeStoredAuthSession,
  resetAuthSessionTabAccount,
  saveAuthSession,
  type AuthSession,
} from '../src/auth/session'
import {
  discardSessionDrafts,
  registerSessionDraft,
  takeSessionDraft,
} from '../src/auth/sessionDrafts'
import { signOutWithPushCleanup } from '../src/notifications/mutations/usePushDevice'
import {
  createIssueCommentSessionDraftKey,
  parseCommentSessionDraft,
} from '../src/issues/model/commentSessionDraft'

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

const previousWindow = Reflect.get(globalThis, 'window')
const commentKey = createIssueCommentSessionDraftKey('core-team', 'launch-review')
/** Registrations made by a test, removed after it. */
let unregister: Array<() => void> = []

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
 * Signs a tab in to one account.
 *
 * @param accessToken - Access token of the account.
 * @returns The stored session.
 */
function signIn(accessToken: string): AuthSession {
  const session: AuthSession = {
    accessToken,
    expiresAt: Date.now() + 30 * 60_000,
    refreshToken: `refresh-${accessToken}`,
    remember: false,
    tokenType: 'Bearer',
  }
  saveAuthSession(session)
  return session
}

/**
 * Registers an input for the test.
 *
 * @param key - Input key.
 * @param read - Reads the input's value.
 */
function register(key: string, read: () => unknown) {
  unregister.push(registerSessionDraft(key, read))
}

beforeEach(() => {
  resetAuthSessionTabAccount()
  Reflect.set(globalThis, 'window', { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() })
})

afterEach(() => {
  for (const remove of unregister) remove()
  unregister = []
  // Unregistering keeps the last values for a moment; drop them so the next test starts clean.
  discardSessionDrafts()
  Reflect.set(globalThis, 'window', previousWindow)
})

test('keeps unsent input when the session ends and returns it once to the same account', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Almost done', mentionMemberKeys: ['member-b'] }))

  clearAuthSession()
  expect(getAuthSession()).toBeNull()

  signIn(token('member-a', 'access-2'))
  expect(parseCommentSessionDraft(takeSessionDraft(commentKey, 'member-a'))).toEqual({
    bodyMarkdown: 'Almost done',
    mentionMemberKeys: ['member-b'],
  })
  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
})

test('never hands one account’s input to another account and removes it', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Private note', mentionMemberKeys: [] }))
  clearAuthSession()

  expect(takeSessionDraft(commentKey, 'member-b')).toBeUndefined()
  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
})

test('signing in as another account removes the previous account’s input at once', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Private note', mentionMemberKeys: [] }))
  clearAuthSession()
  expect(window.sessionStorage.getItem('mukuroji.auth.sessionDrafts')).not.toBeNull()

  signIn(token('member-b', 'access-2'))

  expect(window.sessionStorage.getItem('mukuroji.auth.sessionDrafts')).toBeNull()
})

test('keeps input whose page unmounted just before the session was cleared', async () => {
  signIn(token('member-a', 'access-1'))
  // A route can swap the page for a loading state in the same commit that clears the session.
  registerSessionDraft(commentKey, () => ({ bodyMarkdown: 'Unmounted moments ago', mentionMemberKeys: [] }))()
  clearAuthSession()
  expect(takeSessionDraft(commentKey, 'member-a')).toEqual({
    bodyMarkdown: 'Unmounted moments ago',
    mentionMemberKeys: [],
  })

  resetAuthSessionTabAccount()
  Reflect.set(globalThis, 'window', { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() })
  signIn(token('member-a', 'access-2'))
  registerSessionDraft(commentKey, () => ({ bodyMarkdown: 'Left long ago', mentionMemberKeys: [] }))()
  await Bun.sleep(1_100)
  clearAuthSession()
  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
})

test('keeps input after a rejected refresh has already removed the stored session', () => {
  const session = signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Still here', mentionMemberKeys: [] }))

  removeStoredAuthSession(session.refreshToken ?? '')
  clearAuthSession()

  expect(takeSessionDraft(commentKey, 'member-a')).toEqual({ bodyMarkdown: 'Still here', mentionMemberKeys: [] })
})

test('keeps nothing for inputs without unsent text or tokens without an account', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => undefined)
  clearAuthSession()
  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()

  resetAuthSessionTabAccount()
  Reflect.set(globalThis, 'window', { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() })
  signIn('emulator-token')
  register('other-input', () => 'text')
  clearAuthSession()
  expect(takeSessionDraft('other-input', undefined)).toBeUndefined()
})

test('keeps drafts of other inputs until their pages restore them', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'First', mentionMemberKeys: [] }))
  register('other-input', () => 'Second')
  clearAuthSession()

  expect(takeSessionDraft(commentKey, 'member-a')).toEqual({ bodyMarkdown: 'First', mentionMemberKeys: [] })
  expect(takeSessionDraft('other-input', 'member-a')).toBe('Second')
})

test('drops preserved input that is older than a day', () => {
  const now = Date.now()
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Old', mentionMemberKeys: [] }))
  clearAuthSession()

  const realNow = Date.now
  Date.now = () => now + 25 * 60 * 60 * 1000
  try {
    expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
  } finally {
    Date.now = realNow
  }
})

test('an explicit sign-out leaves no input behind', async () => {
  const session = signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Do not keep', mentionMemberKeys: [] }))

  await signOutWithPushCleanup(session.accessToken, async () => undefined, 10, async () => undefined)

  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
})

test('discarding removes every preserved draft', () => {
  signIn(token('member-a', 'access-1'))
  register(commentKey, () => ({ bodyMarkdown: 'Text', mentionMemberKeys: [] }))
  clearAuthSession()

  discardSessionDrafts()

  expect(takeSessionDraft(commentKey, 'member-a')).toBeUndefined()
})

test('rejects preserved values that are not comment input', () => {
  expect(parseCommentSessionDraft('text')).toBeUndefined()
  expect(parseCommentSessionDraft({ bodyMarkdown: 1, mentionMemberKeys: [] })).toBeUndefined()
  expect(parseCommentSessionDraft({ bodyMarkdown: 'a', mentionMemberKeys: ['m', 2] })).toEqual({
    bodyMarkdown: 'a',
    mentionMemberKeys: ['m'],
  })
})
