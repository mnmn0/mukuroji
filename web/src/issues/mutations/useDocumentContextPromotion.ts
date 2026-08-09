import { useCallback, useState } from 'react'
import type { DocumentBacklink, DocumentRecord } from '../../documents/api'
import type { IssueCollaborationTab } from '../model/collaborationTabs'
import {
  createRelatedDocumentContextDraft,
  type IssueContextDraft,
} from '../model/contextDrafts'

/**
 * Shared state and actions for promoting an authorized related Document into context.
 */
export type DocumentContextPromotion = {
  /** Draft currently awaiting submission in the Decisions tab. */
  documentContextDraft?: IssueContextDraft
  /** Promotion callback exposed only while context creation is permitted. */
  onPromoteToContext?: (
    backlink: DocumentBacklink,
    document: DocumentRecord,
    returnFocusId?: string,
  ) => void
  /** Clears the consumed draft after the editor closes. */
  onContextDraftConsumed: () => void
}

/** Stores a related-document draft together with its owning Team/Work Item scope. */
type ScopedDocumentContextDraft = {
  /** Stable Team/Work Item identity that owns the draft. */
  scopeKey: string
  /** Draft values captured from the related document. */
  draft: IssueContextDraft
}

/**
 * Owns the shared related-document promotion flow used by both detail panes.
 *
 * @param canCreate - Latest curated-context create capability.
 * @param scopeKey - Stable Team/Work Item identity that owns the draft.
 * @param onTabChange - Optional route callback used to reveal the Decisions tab.
 * @returns Draft state and promotion callbacks.
 */
export function useDocumentContextPromotion(
  canCreate: boolean,
  scopeKey: string,
  onTabChange?: (tab: IssueCollaborationTab) => void,
): DocumentContextPromotion {
  const [scopedDraft, setScopedDraft] = useState<ScopedDocumentContextDraft>()
  const onPromoteToContext = useCallback(
    (
      backlink: DocumentBacklink,
      document: DocumentRecord,
      returnFocusId?: string,
    ) => {
      setScopedDraft({
        scopeKey,
        draft: {
          ...createRelatedDocumentContextDraft(backlink, document),
          returnFocusId,
        },
      })
      onTabChange?.('decisions')
    },
    [onTabChange, scopeKey],
  )

  return {
    documentContextDraft:
      scopedDraft?.scopeKey === scopeKey ? scopedDraft.draft : undefined,
    onContextDraftConsumed: useCallback(
      () => setScopedDraft(undefined),
      [],
    ),
    onPromoteToContext: canCreate ? onPromoteToContext : undefined,
  }
}
