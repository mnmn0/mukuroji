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
  /** Notes that the member changed the form, so its input is kept from then on. */
  handleChange: (event: FormEvent<HTMLFormElement>) => void
  /** Stops keeping the input once it was saved or the form was cancelled. */
  forget: () => void
}

/**
 * Keeps a new time entry form's input when the session ends and restores it after the same
 * account signs in again.
 *
 * Only a form the member changed is kept, so an untouched form does not come back. The input is
 * read from the form when the session ends, so fields the form moves on its own, such as an end
 * date carried along with the start date, are kept as they are shown.
 *
 * @param key - Identifies the form; without one nothing is kept.
 * @param onRestore - Applies restored values the form holds in its own state, such as dates.
 * @returns The restored input and the form handlers.
 */
export function useTimeEntryFormSessionDraft(
  key: string | undefined,
  onRestore?: (draft: TimeEntryFormSessionDraft) => void,
): TimeEntryFormSessionDraftState {
  const [restored, setRestored] = useState<TimeEntryFormSessionDraft>()
  const changedFormRef = useRef<HTMLFormElement | null>(null)
  const restoredRef = useRef<TimeEntryFormSessionDraft | undefined>(undefined)
  const forgottenRef = useRef(false)

  useSessionDraft<TimeEntryFormSessionDraft>({
    key,
    read: () => {
      if (forgottenRef.current) return undefined
      return changedFormRef.current ? readTimeEntryForm(changedFormRef.current) : restoredRef.current
    },
    parse: parseTimeEntryFormSessionDraft,
    onRestore: (value) => {
      // Input typed since the form came back wins over the kept one.
      if (changedFormRef.current) return
      restoredRef.current = value
      setRestored(value)
      onRestore?.(value)
    },
  })

  return {
    formKey: restored ? 'restored' : 'initial',
    handleChange: (event) => {
      changedFormRef.current = event.currentTarget
    },
    forget: () => {
      forgottenRef.current = true
    },
    restored,
  }
}

/**
 * Reads a time entry form's input as it is shown.
 *
 * @param form - Form element.
 * @returns The input to keep.
 */
function readTimeEntryForm(form: HTMLFormElement): TimeEntryFormSessionDraft {
  const data = new FormData(form)
  return createTimeEntryFormSessionDraft(data.entries(), data.get('billable') === 'on')
}
