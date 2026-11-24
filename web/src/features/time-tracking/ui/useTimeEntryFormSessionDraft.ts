import { useRef, useState, type FormEvent } from 'react'
import { useSessionDraft } from '../../../auth/useSessionDraft'
import {
  createTimeEntryFormSessionDraft,
  parseTimeEntryFormSessionDraft,
  type TimeEntryFormSessionDraft,
} from '../model/timeEntryFormSessionDraft'

/** What a time entry form needs to keep its input across an ended session. */
export type TimeEntryFormSessionDraftState = {
  /** Input brought back from an ended session, used as the fields' starting values. */
  restored: TimeEntryFormSessionDraft | undefined
  /** Changes when input is restored, so the form's uncontrolled fields start again from it. */
  formKey: string
  /** Records the form's input after the member changes a field. */
  handleChange: (event: FormEvent<HTMLFormElement>) => void
  /** Stops keeping the input once it was saved or the form was cancelled. */
  forget: () => void
}

/**
 * Keeps a new time entry form's input when the session ends and restores it after the same
 * account signs in again.
 *
 * Only input the member changed is kept, so an untouched form does not come back.
 *
 * @param key - Identifies the form; without one nothing is kept.
 * @param onRestore - Applies restored values the form holds in its own state, such as dates.
 * @returns The restored input and the form handlers.
 */
export function useTimeEntryFormSessionDraft(
  key: string | undefined,
  onRestore?: (draft: TimeEntryFormSessionDraft) => void,
): TimeEntryFormSessionDraftState {
  const [draft, setDraft] = useState<TimeEntryFormSessionDraft>()
  const [restored, setRestored] = useState<TimeEntryFormSessionDraft>()
  const forgottenRef = useRef(false)

  useSessionDraft<TimeEntryFormSessionDraft>({
    key,
    read: () => forgottenRef.current ? undefined : draft,
    parse: parseTimeEntryFormSessionDraft,
    onRestore: (value) => {
      // Input typed since the form came back wins over the kept one.
      if (draft) return
      setRestored(value)
      setDraft(value)
      onRestore?.(value)
    },
  })

  return {
    formKey: restored ? 'restored' : 'initial',
    handleChange: (event) => {
      const data = new FormData(event.currentTarget)
      setDraft(createTimeEntryFormSessionDraft(data.entries(), data.get('billable') === 'on'))
    },
    forget: () => {
      forgottenRef.current = true
    },
    restored,
  }
}
