import type { DocumentDetail, DocumentNode } from '@mukuroji/contracts'
import { findChecklistItemWorkItemId } from './checklistWorkItems'

/**
 * Most Documents read to collect a Project's open action items. Each one is a
 * separate detail request, so the overview reads only the recently updated
 * pages.
 */
export const PROJECT_ACTION_ITEM_DOCUMENT_LIMIT = 20

/**
 * One unchecked checklist item found in a Project Document.
 */
export type ProjectActionItem = {
  /** Document that contains the item. */
  documentId: string
  /** Title of that Document. */
  documentTitle: string
  /** Checklist block that contains the item. */
  blockId: string
  /** Item ID inside the block. */
  itemId: string
  /** Item text. */
  text: string
  /** Owner member key saved on the item. */
  assigneeMemberKey?: string
  /** `YYYY-MM-DD` deadline saved on the item. */
  dueDate?: string
  /** Work Item created from the item, when there is one. */
  workItemId?: string
}

/**
 * Chooses the Project Documents whose checklists are read for open action items.
 *
 * Only active pages are read: templates hold example items rather than real
 * ones, and other kinds have no checklist blocks. The most recently updated
 * pages come first so current meeting notes are not cut by the limit.
 *
 * @param documents - Documents in the Project scope that the viewer can read.
 * @param limit - Most Documents to choose.
 * @returns Chosen Documents and how many pages were left out by the limit.
 */
export function selectActionItemDocuments(
  documents: readonly DocumentNode[],
  limit = PROJECT_ACTION_ITEM_DOCUMENT_LIMIT,
): { documents: DocumentNode[], skippedCount: number } {
  const pages = documents
    .filter((document) => document.kind === 'page' && !document.archivedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return {
    documents: pages.slice(0, limit),
    skippedCount: Math.max(0, pages.length - limit),
  }
}

/**
 * Collects the unchecked, non-empty checklist items of the given Documents.
 *
 * Items with a deadline come first, earliest first, then items without one;
 * ties keep the Document and item order.
 *
 * @param documents - Document details read for the Project.
 * @returns Open action items.
 */
export function collectOpenActionItems(
  documents: readonly DocumentDetail[],
): ProjectActionItem[] {
  const items: ProjectActionItem[] = []
  for (const document of documents) {
    if (document.kind !== 'page' && document.kind !== 'template') continue
    for (const block of document.blocks) {
      if (block.type !== 'checklist') continue
      for (const item of block.items) {
        if (item.checked || item.text.trim().length === 0) continue
        const workItemId = findChecklistItemWorkItemId(document.relations, block.id, item.id)
        items.push({
          blockId: block.id,
          documentId: document.id,
          documentTitle: document.title,
          itemId: item.id,
          text: item.text,
          ...(item.assigneeMemberKey ? { assigneeMemberKey: item.assigneeMemberKey } : {}),
          ...(item.dueDate ? { dueDate: item.dueDate } : {}),
          ...(workItemId ? { workItemId } : {}),
        })
      }
    }
  }
  return items
    .map((item, index) => ({ index, item }))
    .sort((left, right) =>
      compareDueDates(left.item.dueDate, right.item.dueDate) || left.index - right.index)
    .map(({ item }) => item)
}

/**
 * Orders deadlines earliest first and items without a deadline last.
 *
 * @param left - First deadline.
 * @param right - Second deadline.
 * @returns Negative, zero, or positive like `Array.prototype.sort`.
 */
function compareDueDates(left: string | undefined, right: string | undefined) {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left.localeCompare(right)
}
