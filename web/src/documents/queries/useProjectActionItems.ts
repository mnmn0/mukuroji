import useSWR from 'swr'
import type { DocumentDetail, DocumentNode } from '@mukuroji/contracts'
import { getDocument } from '../api'
import {
  collectOpenActionItems,
  selectActionItemDocuments,
  type ProjectActionItem,
} from '../model/projectActionItems'

/**
 * Open action items of one Project and how completely they were read.
 */
export type ProjectActionItemsResult = {
  /** Unchecked checklist items, earliest deadline first. */
  items: ProjectActionItem[]
  /** Pages that could not be read, so their items are missing. */
  failedCount: number
  /** Pages left out by the read limit. */
  skippedCount: number
}

/**
 * Reads the open action items in a Project's recently updated pages.
 *
 * Each chosen page is read through the Document detail API, which applies the
 * viewer's permissions, so the list never shows an item the viewer could not
 * open. A page that fails to load is counted rather than failing the list.
 *
 * @param accessToken - Workspace API token; omission disables the query.
 * @param documents - Project Documents read so far, or undefined while they load.
 * @returns SWR state of the action items.
 */
export function useProjectActionItems(
  accessToken: string | undefined,
  documents: readonly DocumentNode[] | undefined,
) {
  const selection = documents ? selectActionItemDocuments(documents) : undefined
  // Revisions are part of the key so an edited page is read again.
  const documentKey = selection?.documents
    .map((document) => `${document.id}@${document.revision}`)
    .join('\n')
  const key = accessToken && selection
    ? ['project-action-items', accessToken, documentKey ?? ''] as const
    : null
  return useSWR(
    key,
    async ([, token]): Promise<ProjectActionItemsResult> => {
      const chosen = selection?.documents ?? []
      const results = await Promise.allSettled(
        chosen.map((document) => getDocument(token, document.id)),
      )
      const details: DocumentDetail[] = []
      let failedCount = 0
      for (const result of results) {
        if (result.status === 'fulfilled') details.push(result.value)
        else failedCount += 1
      }
      // Every page failing is a load failure the viewer can retry, not an
      // empty list.
      if (chosen.length > 0 && details.length === 0) {
        const failure = results.find((result) => result.status === 'rejected')
        throw failure?.reason instanceof Error
          ? failure.reason
          : new Error('Project action items could not be read.')
      }
      return {
        failedCount,
        items: collectOpenActionItems(details),
        skippedCount: selection?.skippedCount ?? 0,
      }
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
