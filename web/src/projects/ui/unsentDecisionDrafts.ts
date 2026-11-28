import { readAccessTokenSubject } from '../../auth/session'
import { onSessionDraftsDiscarded } from '../../auth/sessionDrafts'
import type { RecordDecisionUnsentDraft } from './RecordDecisionDialog'

/**
 * Forms whose save failed, by signed-in account and draft key, kept while another item is shown.
 * Another account never sees them, and signing out drops them.
 */
const unsentDrafts = new Map<string, RecordDecisionUnsentDraft>()

/** Counts sign-outs, so a save that started before one does not keep its form afterwards. */
let discardGeneration = 0

onSessionDraftsDiscarded(() => {
  discardGeneration += 1
  unsentDrafts.clear()
})

/**
 * Builds the key a failed form is kept under.
 *
 * @param accessToken - Token of the signed-in account.
 * @param draftKey - Item the decision is recorded from.
 * @returns The key, or `undefined` when the account or the item is unknown and nothing is kept.
 */
export function unsentDecisionDraftKey(accessToken: string | undefined, draftKey: string | undefined): string | undefined {
  const owner = accessToken ? readAccessTokenSubject(accessToken) : undefined
  return owner && draftKey !== undefined ? JSON.stringify([owner, draftKey]) : undefined
}

/**
 * Tells which sign-out period it is, so a dialog can remember the one it was opened in.
 *
 * @returns The number of sign-outs so far in this tab.
 */
export function currentUnsentDecisionDraftGeneration(): number {
  return discardGeneration
}

/**
 * Reads a kept failed form.
 *
 * @param key - Key from {@link unsentDecisionDraftKey}.
 * @returns The form, or `undefined` when none is kept.
 */
export function readUnsentDecisionDraft(key: string): RecordDecisionUnsentDraft | undefined {
  return unsentDrafts.get(key)
}

/**
 * Keeps a failed form, unless the dialog that sent it was opened before a later sign-out.
 *
 * @param key - Key from {@link unsentDecisionDraftKey}.
 * @param draft - Form of the failed save.
 * @param openedGeneration - Generation the sending dialog was opened in.
 * @returns Whether the form was kept.
 */
export function keepUnsentDecisionDraft(key: string, draft: RecordDecisionUnsentDraft, openedGeneration: number): boolean {
  if (openedGeneration !== discardGeneration) return false
  unsentDrafts.set(key, draft)
  return true
}

/**
 * Drops a kept failed form, such as once it was saved or discarded.
 *
 * @param key - Key from {@link unsentDecisionDraftKey}.
 */
export function dropUnsentDecisionDraft(key: string) {
  unsentDrafts.delete(key)
}
