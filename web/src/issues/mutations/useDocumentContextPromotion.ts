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

/**
 * Owns the shared related-document promotion flow used by both detail panes.
 *
 * @param canCreate - Latest curated-context create capability.
 * @param onTabChange - Optional route callback used to reveal the Decisions tab.
 * @returns Draft state and promotion callbacks.
 */
export function useDocumentContextPromotion(
  canCreate: boolean,
  onTabChange?: (tab: IssueCollaborationTab) => void,
): DocumentContextPromotion {
  const [documentContextDraft, setDocumentContextDraft] =
    useState<IssueContextDraft>()
  const onPromoteToContext = useCallback(
    (
      backlink: DocumentBacklink,
      document: DocumentRecord,
      returnFocusId?: string,
    ) => {
      setDocumentContextDraft({
        ...createRelatedDocumentContextDraft(backlink, document),
        returnFocusId,
      })
      onTabChange?.('decisions')
    },
    [onTabChange],
  )

  return {
    documentContextDraft,
    onContextDraftConsumed: useCallback(
      () => setDocumentContextDraft(undefined),
      [],
    ),
    onPromoteToContext: canCreate ? onPromoteToContext : undefined,
  }
}
