import type { DocumentRelation } from '@mukuroji/contracts'

const checklistItemRelationPrefix = 'checklist-item:'

/**
 * Document checklist item a Work Item is created from.
 */
export type ChecklistItemSource = {
  /** Document that contains the item. */
  documentId: string
  /** Checklist block that contains the item. */
  blockId: string
  /** Checklist item ID inside the block. */
  itemId: string
}

/**
 * Values the author confirmed for a Work Item created from a checklist item.
 */
export type ChecklistWorkItemInput = {
  /** Team that owns the new Work Item. */
  teamId: string
  /** Project the Work Item is assigned to. */
  projectId: string
  /** Work Item title. */
  title: string
  /** Project member key of the accountable owner. */
  assigneeUserId: string
  /** Local `YYYY-MM-DD` deadline, when one was entered. */
  dueDate?: string
}

/**
 * Builds the Document relation ID that links one checklist item to its Work Item.
 *
 * The ID is derived from the block and item so the editor can tell which item
 * a block relation belongs to, and a retried link replaces the same relation.
 *
 * @param blockId - Checklist block ID.
 * @param itemId - Checklist item ID inside the block.
 * @returns Relation ID unique within the Document.
 */
export function createChecklistItemRelationId(blockId: string, itemId: string) {
  return `${checklistItemRelationPrefix}${blockId}:${itemId}`
}

/**
 * Builds the relation that links a checklist item to the Work Item created from it.
 *
 * @param blockId - Checklist block ID.
 * @param itemId - Checklist item ID inside the block.
 * @param workItemId - Canonical Work Item ID.
 * @param createdAt - Creation time of the relation.
 * @returns Block-sourced Work Item relation.
 */
export function createChecklistItemWorkItemRelation(
  blockId: string,
  itemId: string,
  workItemId: string,
  createdAt: Date,
): DocumentRelation {
  return {
    createdAt: createdAt.toISOString(),
    createdByUserId: 'current-user',
    id: createChecklistItemRelationId(blockId, itemId),
    source: { blockId, kind: 'block' },
    target: { kind: 'work-item', workItemId },
  }
}

/**
 * Finds the Work Item created from one checklist item.
 *
 * @param relations - Relations of the Document.
 * @param blockId - Checklist block ID.
 * @param itemId - Checklist item ID inside the block.
 * @returns Canonical Work Item ID, or undefined when the item has none.
 */
export function findChecklistItemWorkItemId(
  relations: readonly DocumentRelation[],
  blockId: string,
  itemId: string,
): string | undefined {
  const relationId = createChecklistItemRelationId(blockId, itemId)
  const relation = relations.find((candidate) =>
    candidate.id === relationId &&
    candidate.source.kind === 'block' &&
    candidate.source.blockId === blockId &&
    candidate.target.kind === 'work-item'
  )
  return relation?.target.kind === 'work-item'
    ? relation.target.workItemId
    : undefined
}
