import { useEffect, useRef } from 'react'
import { readAccessTokenSubject, readStoredAuthSession } from './session'
import { registerSessionDraft, takeSessionDraft } from './sessionDrafts'

/** Options of {@link useSessionDraft}. */
export type UseSessionDraftOptions<Draft> = {
  /**
   * Identifies the input across page loads, such as the Work Item it belongs to. Without a key
   * the input is neither preserved nor restored.
   */
  key: string | undefined
  /** Current unsaved value, or `undefined` when the input has nothing to keep. */
  value: Draft | undefined
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
export function useSessionDraft<Draft>({ key, value, parse, onRestore }: UseSessionDraftOptions<Draft>) {
  const valueRef = useRef(value)
  const parseRef = useRef(parse)
  const onRestoreRef = useRef(onRestore)
  const restoredKeyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    valueRef.current = value
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
    return registerSessionDraft(key, readTabAccountOwner(), () => valueRef.current)
  }, [key])
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
