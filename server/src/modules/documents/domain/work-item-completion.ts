import type {
  DocumentDetail,
  DocumentOperation,
  DocumentRelation,
} from '@mukuroji/contracts'

/** Relation ID prefix of a checklist item turned into a Work Item. */
const CHECKLIST_ITEM_RELATION_PREFIX = 'checklist-item:'

/** Relation ID prefix of a Whiteboard note turned into a Work Item. */
const WHITEBOARD_NOTE_RELATION_PREFIX = 'whiteboard-note:'

/**
 * Tells whether a relation ID is one that completion reflects: a checklist
 * item or Whiteboard note turned into a Work Item.
 *
 * @param relationId - Document relation ID.
 * @returns True for checklist item and Whiteboard note relations.
 */
export function isWorkItemCompletionRelationId(relationId: string): boolean {
  return relationId.startsWith(CHECKLIST_ITEM_RELATION_PREFIX) ||
    relationId.startsWith(WHITEBOARD_NOTE_RELATION_PREFIX)
}

/**
 * Plans the operations that mark the elements linked to a completed Work Item
 * as done.
 *
 * Only elements a Document editor explicitly turned into the Work Item are
 * changed: checklist items linked by a `checklist-item:<blockId>:<itemId>`
 * relation and Whiteboard notes linked by a `whiteboard-note:<objectId>`
 * relation. Other relations to the Work Item, such as plain links, embedded
 * Work Item cards, or relations a viewer typed by hand with another ID, are
 * left alone. Elements that are already done produce no operation, so a
 * replayed completion event changes nothing.
 *
 * @param document - Current Document.
 * @param workItemId - Canonical ID of the completed Work Item.
 * @param operationIdPrefix - Prefix that makes operation IDs unique to one completion event.
 * @returns Operations to apply; empty when nothing needs to change.
 */
export function planWorkItemCompletionOperations(
  document: DocumentDetail,
  workItemId: string,
  operationIdPrefix: string,
): DocumentOperation[] {
  const relations = document.relations.filter((relation) =>
    relation.target.kind === 'work-item' && relation.target.workItemId === workItemId)
  if (relations.length === 0) return []
  if (document.kind === 'page' || document.kind === 'template') {
    return planChecklistOperations(document, relations, operationIdPrefix)
  }
  if (document.kind === 'whiteboard') {
    return planNoteOperations(document, relations, operationIdPrefix)
  }
  return []
}

/**
 * Checks the checklist items linked to the Work Item, one operation per block.
 *
 * @param document - Page or template.
 * @param relations - Relations of the Document that target the Work Item.
 * @param operationIdPrefix - Operation ID prefix of the completion event.
 * @returns Block update operations.
 */
function planChecklistOperations(
  document: Extract<DocumentDetail, { kind: 'page' | 'template' }>,
  relations: readonly DocumentRelation[],
  operationIdPrefix: string,
): DocumentOperation[] {
  const itemIdsByBlock = new Map<string, Set<string>>()
  for (const relation of relations) {
    if (relation.source.kind !== 'block') continue
    const prefix = `${CHECKLIST_ITEM_RELATION_PREFIX}${relation.source.blockId}:`
    if (!relation.id.startsWith(prefix)) continue
    const itemId = relation.id.slice(prefix.length)
    if (!itemId) continue
    const itemIds = itemIdsByBlock.get(relation.source.blockId) ?? new Set<string>()
    itemIds.add(itemId)
    itemIdsByBlock.set(relation.source.blockId, itemIds)
  }
  const operations: DocumentOperation[] = []
  for (const block of document.blocks) {
    if (block.type !== 'checklist') continue
    const itemIds = itemIdsByBlock.get(block.id)
    if (!itemIds) continue
    if (!block.items.some((item) => itemIds.has(item.id) && !item.checked)) continue
    operations.push({
      block: {
        ...block,
        items: block.items.map((item) =>
          itemIds.has(item.id) ? { ...item, checked: true } : item),
      },
      blockId: block.id,
      operationId: `${operationIdPrefix}:block:${block.id}`,
      type: 'update-block',
    })
  }
  return operations
}

/**
 * Marks the Whiteboard notes linked to the Work Item as done.
 *
 * @param document - Whiteboard.
 * @param relations - Relations of the Document that target the Work Item.
 * @param operationIdPrefix - Operation ID prefix of the completion event.
 * @returns Object update operations.
 */
function planNoteOperations(
  document: Extract<DocumentDetail, { kind: 'whiteboard' }>,
  relations: readonly DocumentRelation[],
  operationIdPrefix: string,
): DocumentOperation[] {
  const objectIds = new Set<string>()
  for (const relation of relations) {
    if (relation.source.kind !== 'whiteboard-object') continue
    if (relation.id !== `${WHITEBOARD_NOTE_RELATION_PREFIX}${relation.source.objectId}`) continue
    objectIds.add(relation.source.objectId)
  }
  const operations: DocumentOperation[] = []
  for (const object of document.whiteboard.objects) {
    if (object.type !== 'note' || !objectIds.has(object.id) || object.done === true) continue
    operations.push({
      object: { ...object, done: true },
      objectId: object.id,
      operationId: `${operationIdPrefix}:object:${object.id}`,
      type: 'update-object',
    })
  }
  return operations
}
