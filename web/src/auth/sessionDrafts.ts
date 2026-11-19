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

/** Reads the current unsaved value of one input, or `undefined` when it has nothing to keep. */
type SessionDraftReader = () => unknown

/** One input that can be preserved when the session ends. */
type SessionDraftRegistration = {
  /** Identifies the input across page loads, such as the Work Item it belongs to. */
  key: string
  /** Reads the input's current unsaved value. */
  read: SessionDraftReader
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

/**
 * Registers an input whose unsaved value is preserved when the session ends.
 *
 * @param key - Identifies the input across page loads.
 * @param read - Reads the current unsaved value; returning `undefined` keeps nothing.
 * @returns A function that removes the registration.
 */
export function registerSessionDraft(key: string, read: SessionDraftReader): () => void {
  const registration: SessionDraftRegistration = { key, read }
  registrations.add(registration)
  return () => {
    registrations.delete(registration)
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
  if (!owner || registrations.size === 0) return
  const now = Date.now()
  const stored = readStoredDrafts()
  const drafts: Record<string, StoredSessionDraft> = stored?.owner === owner ? { ...stored.drafts } : {}
  let preserved = false
  for (const registration of registrations) {
    let value: unknown
    try {
      value = registration.read()
    } catch {
      continue
    }
    if (value === undefined) continue
    drafts[registration.key] = { savedAt: now, value }
    preserved = true
  }
  if (!preserved) return
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
    discardSessionDrafts()
    return undefined
  }
  const draft = stored.drafts[key]
  if (!draft) return undefined
  const remaining = { ...stored.drafts }
  delete remaining[key]
  if (Object.keys(remaining).length > 0) {
    writeStoredDrafts({ owner, drafts: remaining })
  } else {
    discardSessionDrafts()
  }
  return Date.now() - draft.savedAt <= maxDraftAgeMilliseconds ? draft.value : undefined
}

/**
 * Removes this tab's preserved drafts unless they belong to the account that just signed in.
 *
 * @param owner - Account now signed in to this tab, or `undefined` when it cannot be told apart.
 */
export function keepSessionDraftsOnlyFor(owner: string | undefined) {
  const stored = readStoredDrafts()
  if (stored && stored.owner !== owner) discardSessionDrafts()
}

/**
 * Removes every preserved draft of this tab, such as on an explicit sign-out.
 */
export function discardSessionDrafts() {
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
