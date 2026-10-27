import { useState, type Dispatch, type SetStateAction } from 'react'
import type { AcceptanceCriteriaDraftError, AcceptanceCriterionDraftRow } from '../model/acceptanceCriteria'

/**
 * Draft problem shown next to the acceptance criterion rows.
 */
export type AcceptanceCriteriaDraftSubmitError = {
  /** Why the draft cannot be saved. */
  error: AcceptanceCriteriaDraftError
  /** Row that caused the problem, when one row is at fault. */
  rowKey?: string
}

/** Unsaved acceptance criterion rows of one Work Item editor. */
export type AcceptanceCriteriaDraft = {
  /** Rows being edited; absent while the stored list is only shown. */
  rows?: AcceptanceCriterionDraftRow[]
  /** Number used for the key of the next added row. */
  nextRowNumber: number
  /** Problem reported by the owning form's last submit; cleared with the draft. */
  submitError?: AcceptanceCriteriaDraftSubmitError
}

/** Acceptance criteria draft state that lives above the editor that shows it. */
export type AcceptanceCriteriaDraftState = {
  /** Current draft. */
  draft: AcceptanceCriteriaDraft
  /** Replaces or updates the draft. */
  setDraft: Dispatch<SetStateAction<AcceptanceCriteriaDraft>>
}

/** Draft with no open edit. */
const emptyAcceptanceCriteriaDraft: AcceptanceCriteriaDraft = { nextRowNumber: 1 }

/**
 * Keeps an acceptance criteria draft that survives the editor moving in the tree.
 *
 * @param resetKey - Identity of the edited Work Item state; a new key starts a fresh draft.
 * @returns The draft and its setter.
 */
export function useAcceptanceCriteriaDraft(resetKey: string): AcceptanceCriteriaDraftState {
  const [state, setState] = useState<{ resetKey: string; draft: AcceptanceCriteriaDraft }>({
    resetKey,
    draft: emptyAcceptanceCriteriaDraft,
  })
  if (state.resetKey !== resetKey) {
    // Adjust during render so a new Work Item never shows the previous draft.
    setState({ resetKey, draft: emptyAcceptanceCriteriaDraft })
  }
  /**
   * Updates the draft of the current key.
   *
   * @param action - Next draft or an updater of the current one.
   */
  const setDraft: Dispatch<SetStateAction<AcceptanceCriteriaDraft>> = (action) => {
    setState((current) => ({
      resetKey: current.resetKey,
      draft: typeof action === 'function' ? action(current.draft) : action,
    }))
  }
  return { draft: state.resetKey === resetKey ? state.draft : emptyAcceptanceCriteriaDraft, setDraft }
}
