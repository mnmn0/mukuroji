import { useState, type Dispatch, type SetStateAction } from 'react'
import type { ContributorDraftError, ContributorDraftRow } from '../model/contributorAssignments'

/**
 * Draft problem shown next to the contributor rows.
 */
export type ContributorDraftSubmitError = {
  /** Why the draft cannot be saved. */
  error: ContributorDraftError
  /** Row that caused the problem, when one row is at fault. */
  rowKey?: string
}

/** Unsaved contributor rows of one Work Item editor. */
export type ContributorDraft = {
  /** Rows being edited; absent while the stored list is only shown. */
  rows?: ContributorDraftRow[]
  /** Number used for the key of the next added row. */
  nextRowNumber: number
  /** Problem reported by the owning form's last submit; cleared with the draft. */
  submitError?: ContributorDraftSubmitError
}

/** Contributor draft state that can live above the editor that shows it. */
export type ContributorDraftState = {
  /** Current draft. */
  draft: ContributorDraft
  /** Replaces or updates the draft. */
  setDraft: Dispatch<SetStateAction<ContributorDraft>>
}

/** Draft with no open edit. */
const emptyContributorDraft: ContributorDraft = { nextRowNumber: 1 }

/**
 * Keeps a contributor draft that survives the editor moving in the tree.
 *
 * The owner of a Work Item editor can hold the draft so that a layout change, such as a
 * Work Item Type without an overview section, does not discard unsaved contributors.
 *
 * @param resetKey - Identity of the edited Work Item state; a new key starts a fresh draft.
 * @returns The draft and its setter.
 */
export function useContributorDraft(resetKey: string): ContributorDraftState {
  const [state, setState] = useState<{ resetKey: string; draft: ContributorDraft }>({ resetKey, draft: emptyContributorDraft })
  if (state.resetKey !== resetKey) {
    // Adjust during render so a new Work Item never shows the previous draft.
    setState({ resetKey, draft: emptyContributorDraft })
  }
  /**
   * Updates the draft of the current key.
   *
   * @param action - Next draft or an updater of the current one.
   */
  const setDraft: Dispatch<SetStateAction<ContributorDraft>> = (action) => {
    setState((current) => ({
      resetKey: current.resetKey,
      draft: typeof action === 'function' ? action(current.draft) : action,
    }))
  }
  return { draft: state.resetKey === resetKey ? state.draft : emptyContributorDraft, setDraft }
}
