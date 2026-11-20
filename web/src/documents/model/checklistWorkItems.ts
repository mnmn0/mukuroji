import type { DocumentRelation } from '@mukuroji/contracts'

const checklistItemRelationPrefix = 'checklist-item:'
const whiteboardNoteRelationPrefix = 'whiteboard-note:'

/**
 * Document checklist item a Work Item is created from.
 */
export type ChecklistItemSource = {
  /** Discriminates checklist items from Whiteboard notes. */
  kind: 'checklist-item'
  /** Document that contains the item. */
  documentId: string
  /** Checklist block that contains the item. */
  blockId: string
  /** Checklist item ID inside the block. */
  itemId: string
}

/**
 * Whiteboard sticky note a Work Item is created from.
 */
export type WhiteboardNoteSource = {
  /** Discriminates Whiteboard notes from checklist items. */
  kind: 'whiteboard-note'
  /** Whiteboard Document that contains the note. */
  documentId: string
  /** Note object ID inside the Whiteboard. */
  objectId: string
}

/**
 * Document element a Work Item is created from and linked back to.
 */
export type DocumentWorkItemSource = ChecklistItemSource | WhiteboardNoteSource

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

/**
 * Builds the Document relation ID that links one Whiteboard note to its Work Item.
 *
 * The ID is derived from the note so a retried link replaces the same
 * relation, and it stays outside the reserved `system:` namespace.
 *
 * @param objectId - Note object ID.
 * @returns Relation ID unique within the Document.
 */
export function createWhiteboardNoteRelationId(objectId: string) {
  return `${whiteboardNoteRelationPrefix}${objectId}`
}

/**
 * Builds the relation that links a Whiteboard note to the Work Item created from it.
 *
 * @param objectId - Note object ID.
 * @param workItemId - Canonical Work Item ID.
 * @param createdAt - Creation time of the relation.
 * @returns Whiteboard-object-sourced Work Item relation.
 */
export function createWhiteboardNoteWorkItemRelation(
  objectId: string,
  workItemId: string,
  createdAt: Date,
): DocumentRelation {
  return {
    createdAt: createdAt.toISOString(),
    createdByUserId: 'current-user',
    id: createWhiteboardNoteRelationId(objectId),
    source: { kind: 'whiteboard-object', objectId },
    target: { kind: 'work-item', workItemId },
  }
}

/**
 * Finds the Work Item created from one Whiteboard note.
 *
 * @param relations - Relations of the Document.
 * @param objectId - Note object ID.
 * @returns Canonical Work Item ID, or undefined when the note has none.
 */
export function findWhiteboardNoteWorkItemId(
  relations: readonly DocumentRelation[],
  objectId: string,
): string | undefined {
  const relationId = createWhiteboardNoteRelationId(objectId)
  const relation = relations.find((candidate) =>
    candidate.id === relationId &&
    candidate.source.kind === 'whiteboard-object' &&
    candidate.source.objectId === objectId &&
    candidate.target.kind === 'work-item'
  )
  return relation?.target.kind === 'work-item'
    ? relation.target.workItemId
    : undefined
}

/**
 * Builds the relation that links a Document element to its Work Item.
 *
 * @param source - Checklist item or Whiteboard note.
 * @param workItemId - Canonical Work Item ID.
 * @param createdAt - Creation time of the relation.
 * @returns Relation sourced at the element.
 */
export function createDocumentWorkItemRelation(
  source: DocumentWorkItemSource,
  workItemId: string,
  createdAt: Date,
): DocumentRelation {
  return source.kind === 'checklist-item'
    ? createChecklistItemWorkItemRelation(
        source.blockId,
        source.itemId,
        workItemId,
        createdAt,
      )
    : createWhiteboardNoteWorkItemRelation(
        source.objectId,
        workItemId,
        createdAt,
      )
}

/**
 * Finds the Work Item already linked to a Document element.
 *
 * @param relations - Relations of the Document.
 * @param source - Checklist item or Whiteboard note.
 * @returns Canonical Work Item ID, or undefined when the element has none.
 */
export function findDocumentWorkItemId(
  relations: readonly DocumentRelation[],
  source: DocumentWorkItemSource,
): string | undefined {
  return source.kind === 'checklist-item'
    ? findChecklistItemWorkItemId(relations, source.blockId, source.itemId)
    : findWhiteboardNoteWorkItemId(relations, source.objectId)
}

/**
 * Builds the key that identifies one Document element across Documents.
 *
 * Checklist items keep the key shape used before notes were supported, so an
 * in-flight retry keeps its idempotency context.
 *
 * @param source - Checklist item or Whiteboard note.
 * @returns Key unique to the Document and element.
 */
export function createDocumentWorkItemSourceKey(
  source: DocumentWorkItemSource,
) {
  return source.kind === 'checklist-item'
    ? JSON.stringify([source.documentId, source.blockId, source.itemId])
    : JSON.stringify(['whiteboard-note', source.documentId, source.objectId])
}
