/**
 * Keeps unsaved input across an ended session.
 *
 * When a session can no longer be renewed, pages clear it and send the member to sign in again.
 * Inputs that registered here are written to this tab's sessionStorage at that moment, tagged
 * with the account they belong to, and handed back once the same account is signed in again.
 * Another account never receives them: its first read removes them instead.
 */

/** sessionStorage key that holds the preserved drafts of this tab. */
const storageKey = 'mukuroji.auth.sessionDrafts'

/** Preserved drafts older than this are dropped instead of restored. */
const maxDraftAgeMilliseconds = 24 * 60 * 60 * 1000

/**
 * How long an input's last value outlives its unmount. A session error can make a route render
 * a loading state in place of the page in the same commit whose effect then clears the session,
 * so the input unregisters just before the session is cleared.
 */
const unmountRetentionMilliseconds = 1_000

/** Reads the current unsaved value of one input, or `undefined` when it has nothing to keep. */
type SessionDraftReader = () => unknown

/** One input that can be preserved when the session ends. */
type SessionDraftRegistration = {
  /** Identifies the input across page loads, such as the Work Item it belongs to. */
  key: string
  /** Account that was signed in when the input mounted; only its drafts are kept for it. */
  owner: string | undefined
  /** Reads the input's current unsaved value. */
  read: SessionDraftReader
  /**
   * Set when the drafts were discarded while the input was mounted, such as on an explicit
   * sign-out, so its value is not kept again when it unmounts.
   */
  discarded: boolean
}

/** Drafts preserved in this tab, as stored in sessionStorage. */
type StoredSessionDrafts = {
  /** Account the drafts belong to. */
  owner: string
  /** Drafts by input key. */
  drafts: Record<string, StoredSessionDraft>
}

/** One preserved draft. */
type StoredSessionDraft = {
  /** Unix time in milliseconds when the draft was preserved. */
  savedAt: number
  /** JSON value the input reported. */
  value: unknown
}

/** Inputs of the mounted pages that currently have something to keep. */
const registrations = new Set<SessionDraftRegistration>()

/** Last values of inputs that unmounted moments ago, kept for {@link unmountRetentionMilliseconds}. */
const retainedRegistrations = new Set<SessionDraftRegistration>()

/**
 * Registers an input whose unsaved value is preserved when the session ends.
 *
 * @param key - Identifies the input across page loads.
 * @param owner - Account signed in when the input mounted. The input is kept only when that
 * account's session ends, so its text never moves to an account that signs in later.
 * @param read - Reads the current unsaved value; returning `undefined` keeps nothing.
 * @returns A function that removes the registration.
 */
export function registerSessionDraft(
  key: string,
  owner: string | undefined,
  read: SessionDraftReader,
): () => void {
  const registration: SessionDraftRegistration = { key, owner, read, discarded: false }
  registrations.add(registration)
  return () => {
    registrations.delete(registration)
    // Input discarded by an explicit sign-out must not come back through the unmount window.
    if (registration.discarded) return
    let value: unknown
    try {
      value = read()
    } catch {
      return
    }
    if (value === undefined) return
    const retained: SessionDraftRegistration = { key, owner, read: () => value, discarded: false }
    retainedRegistrations.add(retained)
    setTimeout(() => {
      retainedRegistrations.delete(retained)
    }, unmountRetentionMilliseconds)
  }
}

/**
 * Writes every registered input's unsaved value to this tab's sessionStorage.
 *
 * Drafts preserved earlier for the same account and not yet restored are kept; drafts of
 * another account are replaced.
 *
 * @param owner - Account the drafts belong to. Without one nothing is kept, because the drafts
 * could not be withheld from another account later.
 */
export function preserveSessionDrafts(owner: string | undefined) {
  const retained = [...retainedRegistrations]
  retainedRegistrations.clear()
  if (!owner) return
  // Inputs that unmounted moments ago come first, so a mounted input of the same key wins,
  // even when it is empty now.
  const values = new Map<string, unknown>()
  for (const registration of [...retained, ...registrations]) {
    if (registration.owner !== owner) continue
    let value: unknown
    try {
      value = registration.read()
    } catch {
      continue
    }
    values.set(registration.key, value)
  }
  if (values.size === 0) return
  const now = Date.now()
  const stored = readStoredDrafts()
  const drafts: Record<string, StoredSessionDraft> = stored?.owner === owner ? { ...stored.drafts } : {}
  for (const [key, value] of values) {
    if (value === undefined) {
      delete drafts[key]
    } else {
      drafts[key] = { savedAt: now, value }
    }
  }
  if (Object.keys(drafts).length === 0) {
    if (stored?.owner === owner) discardStoredDrafts()
    return
  }
  writeStoredDrafts({ owner, drafts })
}

/**
 * Hands back one preserved draft and removes it, so it is restored once.
 *
 * Drafts of another account are removed without being returned, so signing in as someone else
 * never shows the previous account's input.
 *
 * @param key - Identifies the input.
 * @param owner - Account now signed in to this tab.
 * @returns The preserved value, or `undefined` when there is none for this account.
 */
export function takeSessionDraft(key: string, owner: string | undefined): unknown {
  const stored = readStoredDrafts()
  if (!stored) return undefined
  if (!owner) return undefined
  if (stored.owner !== owner) {
    discardStoredDrafts()
    return undefined
  }
  const draft = stored.drafts[key]
  if (!draft) return undefined
  const remaining = { ...stored.drafts }
  delete remaining[key]
  if (Object.keys(remaining).length > 0) {
    writeStoredDrafts({ owner, drafts: remaining })
  } else {
    // Only the stored drafts go: other inputs of this account stay ready to be kept.
    discardStoredDrafts()
  }
  return Date.now() - draft.savedAt <= maxDraftAgeMilliseconds ? draft.value : undefined
}

/**
 * Tells whether a preserved draft waits for an input, without handing it back.
 *
 * A page uses it to open the form that restores the draft, such as a form that is closed until
 * the member opens it.
 *
 * @param key - Identifies the input.
 * @param owner - Account now signed in to this tab.
 * @returns Whether {@link takeSessionDraft} would return a value for this account.
 */
export function hasSessionDraft(key: string, owner: string | undefined): boolean {
  if (!owner) return false
  const stored = readStoredDrafts()
  if (stored?.owner !== owner) return false
  const draft = stored.drafts[key]
  return draft !== undefined && Date.now() - draft.savedAt <= maxDraftAgeMilliseconds
}

/**
 * Removes this tab's preserved drafts, and the values of inputs that unmounted moments ago,
 * unless they belong to the account that just signed in.
 *
 * @param owner - Account now signed in to this tab, or `undefined` when it cannot be told apart.
 */
export function keepSessionDraftsOnlyFor(owner: string | undefined) {
  for (const registration of retainedRegistrations) {
    if (registration.owner !== owner) retainedRegistrations.delete(registration)
  }
  const stored = readStoredDrafts()
  if (stored && stored.owner !== owner) discardStoredDrafts()
}

/** Callbacks that drop drafts kept in memory elsewhere when this tab's drafts are discarded. */
const discardListeners = new Set<() => void>()

/**
 * Runs a callback whenever this tab's drafts are discarded, such as on an explicit sign-out, so
 * input kept in memory outside this module goes with them.
 *
 * @param listener - Drops the caller's own kept input.
 * @returns A function that removes the callback.
 */
export function onSessionDraftsDiscarded(listener: () => void): () => void {
  discardListeners.add(listener)
  return () => {
    discardListeners.delete(listener)
  }
}

/**
 * Removes every preserved draft of this tab, such as on an explicit sign-out.
 *
 * Inputs still mounted are marked so that unmounting them afterwards does not keep their value
 * again, and input kept in memory by {@link onSessionDraftsDiscarded} callers is dropped too.
 */
export function discardSessionDrafts() {
  for (const listener of discardListeners) listener()
  for (const registration of registrations) registration.discarded = true
  retainedRegistrations.clear()
  discardStoredDrafts()
}

/**
 * Removes the preserved drafts from this tab's sessionStorage.
 */
function discardStoredDrafts() {
  try {
    window.sessionStorage.removeItem(storageKey)
  } catch {
    // Nothing more can be removed when storage access fails.
  }
}

/**
 * Reads the preserved drafts of this tab.
 *
 * @returns The stored drafts, or `null` when there are none or they cannot be read.
 */
function readStoredDrafts(): StoredSessionDrafts | null {
  let value: string | null
  try {
    value = window.sessionStorage.getItem(storageKey)
  } catch {
    return null
  }
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const owner: unknown = Reflect.get(parsed, 'owner')
    const drafts: unknown = Reflect.get(parsed, 'drafts')
    if (typeof owner !== 'string' || typeof drafts !== 'object' || drafts === null) return null
    const entries: Record<string, StoredSessionDraft> = {}
    for (const [key, draft] of Object.entries(drafts)) {
      if (typeof draft !== 'object' || draft === null) continue
      const savedAt: unknown = Reflect.get(draft, 'savedAt')
      if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) continue
      entries[key] = { savedAt, value: Reflect.get(draft, 'value') }
    }
    return { owner, drafts: entries }
  } catch {
    return null
  }
}

/**
 * Writes the preserved drafts of this tab.
 *
 * @param stored - Drafts to keep.
 */
function writeStoredDrafts(stored: StoredSessionDrafts) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(stored))
  } catch {
    // The input is lost only when storage refuses the write, as it was before drafts were kept.
  }
}
