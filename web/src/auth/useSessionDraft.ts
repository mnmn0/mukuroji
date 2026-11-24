import { useEffect, useRef } from 'react'
import { readAccessTokenSubject, readStoredAuthSession } from './session'
import { hasSessionDraft, registerSessionDraft, takeSessionDraft } from './sessionDrafts'

/** Options of {@link useSessionDraft}. */
export type UseSessionDraftOptions<Draft> = {
  /**
   * Identifies the input across page loads, such as the Work Item it belongs to. Without a key
   * the input is neither preserved nor restored.
   */
  key: string | undefined
  /** Current unsaved value, or `undefined` when the input has nothing to keep. */
  value?: Draft
  /**
   * Reads the current unsaved value at the moment the session ends, in place of `value`, for an
   * input whose unsaved state lives outside React state.
   */
  read?: () => Draft | undefined
  /** Validates a preserved value read back from storage. */
  parse: (value: unknown) => Draft | undefined
  /** Puts a preserved value back into the input after the same account signed in again. */
  onRestore: (draft: Draft) => void
}

/**
 * Keeps an input's unsaved value when the session ends and restores it after sign-in.
 *
 * The value is written only at the moment the session is cleared, so ordinary navigation and
 * reloads behave as before. It is restored once, when the input mounts again for the account
 * that typed it.
 *
 * @param options - Input key, current value, and how to validate and restore a preserved value.
 */
export function useSessionDraft<Draft>({ key, value, read, parse, onRestore }: UseSessionDraftOptions<Draft>) {
  const valueRef = useRef(value)
  const readRef = useRef(read)
  const parseRef = useRef(parse)
  const onRestoreRef = useRef(onRestore)
  const restoredKeyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    valueRef.current = value
    readRef.current = read
    parseRef.current = parse
    onRestoreRef.current = onRestore
  })

  useEffect(() => {
    if (!key || restoredKeyRef.current === key) return
    restoredKeyRef.current = key
    const preserved = takeSessionDraft(key, readTabAccountOwner())
    if (preserved === undefined) return
    const draft = parseRef.current(preserved)
    if (draft !== undefined) onRestoreRef.current(draft)
  }, [key])

  useEffect(() => {
    if (!key) return undefined
    return registerSessionDraft(key, readTabAccountOwner(), () => readRef.current ? readRef.current() : valueRef.current)
  }, [key])
}

/**
 * Tells whether an input's value from an ended session waits to be restored for the account
 * signed in to this tab, so a page can open the form that restores it.
 *
 * @param key - Identifies the input.
 * @returns Whether mounting the input would restore a value.
 */
export function hasPendingSessionDraft(key: string): boolean {
  return hasSessionDraft(key, readTabAccountOwner())
}

/**
 * Reads the account signed in to this tab, as the owner of its drafts.
 *
 * @returns The account's token subject, or `undefined` when the tab has no account it can name.
 */
function readTabAccountOwner(): string | undefined {
  const session = readStoredAuthSession()
  return session ? readAccessTokenSubject(session.accessToken) : undefined
}
