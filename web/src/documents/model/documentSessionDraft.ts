import type { DocumentOperation } from '@mukuroji/contracts'
import type { DocumentRecord } from '../api'

/**
 * Unsaved edits of one Document, kept across an ended session.
 */
export type DocumentSessionDraft = {
  /** Revision the unsaved operations were made against. */
  baseRevision: number
  /**
   * Whether saving had already found a newer Document, so the edits wait for an explicit
   * overwrite instead of being saved again on their own.
   */
  conflicted: boolean
  /** Operations not yet saved, in the order they were made. */
  operations: DocumentOperation[]
  /** Title typed but not yet saved; absent when the title was saved. */
  title?: string
}

/** Fields each Document operation type needs besides its type and operation ID. */
const documentOperationFields: Readonly<Record<DocumentOperation['type'], readonly string[]>> = {
  'delete-block': ['blockId'],
  'delete-connector': ['connectorId'],
  'delete-frame': ['frameId'],
  'delete-object': ['objectId'],
  'delete-relation': ['relationId'],
  'insert-block': ['block', 'index'],
  'insert-object': ['object'],
  'move-block': ['blockId', 'index'],
  'update-block': ['blockId', 'block'],
  'update-object': ['objectId', 'object'],
  'upsert-connector': ['connector'],
  'upsert-frame': ['frame'],
  'upsert-relation': ['relation'],
}

/**
 * Builds the key under which a Document's unsaved edits are kept across an ended session.
 *
 * @param documentId - Document being edited.
 * @returns The draft key.
 */
export function createDocumentSessionDraftKey(documentId: string): string {
  return `document:${JSON.stringify([documentId])}`
}

/**
 * Validates a Document draft read back after an ended session.
 *
 * Operations are checked for their type and the fields each type needs; the Document API checks
 * their full shape again when they are saved.
 *
 * @param value - Value kept in this tab.
 * @returns The draft, or `undefined` when the value is not one or holds nothing to save.
 */
export function parseDocumentSessionDraft(value: unknown): DocumentSessionDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const baseRevision: unknown = Reflect.get(value, 'baseRevision')
  const operations: unknown = Reflect.get(value, 'operations')
  const title: unknown = Reflect.get(value, 'title')
  const conflicted: unknown = Reflect.get(value, 'conflicted')
  if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) return undefined
  if (!Array.isArray(operations)) return undefined
  const keptOperations = operations.filter(isKeptDocumentOperation)
  if (keptOperations.length !== operations.length) return undefined
  if (title !== undefined && typeof title !== 'string') return undefined
  if (keptOperations.length === 0 && title === undefined) return undefined
  return {
    baseRevision,
    conflicted: conflicted === true,
    operations: keptOperations,
    ...(title === undefined ? {} : { title }),
  }
}

/** Unsaved operations fitted to the Document as it is now. */
export type RecoveredDocumentSessionDraftOperations = {
  /** Operations the Document API can apply to the current Document. */
  operations: DocumentOperation[]
  /** Whether edits to blocks or objects someone else deleted were added back as new ones. */
  readdedDeletedElements: boolean
}

/**
 * Fits kept operations to the Document as it is after the same account signed in again.
 *
 * Someone else may have deleted a block or Whiteboard object while the session was over. An
 * update to it would be ignored on screen and refused by the Document API, so the edited block
 * or object is added back instead: a block at the end of the page, an object on the board.
 * Moving or deleting an element that is already gone is dropped, and a kept position past the
 * blocks that remain is moved to the end.
 *
 * @param document - Current Document the operations are restored onto.
 * @param operations - Kept operations, in the order they were made.
 * @returns Operations to restore and whether deleted elements were added back.
 */
export function recoverDocumentSessionDraftOperations(
  document: DocumentRecord,
  operations: readonly DocumentOperation[],
): RecoveredDocumentSessionDraftOperations {
  const blockIds = document.kind === 'page' || document.kind === 'template'
    ? document.blocks.map((block) => block.id)
    : []
  const objectIds = new Set(document.kind === 'whiteboard' ? document.whiteboard.objects.map((object) => object.id) : [])
  const recovered: DocumentOperation[] = []
  let readdedDeletedElements = false

  for (const operation of operations) {
    if (operation.type === 'insert-block') {
      // Blocks deleted meanwhile can leave a kept position past the end, which the API refuses.
      const index = clampIndex(operation.index, blockIds.length)
      blockIds.splice(index, 0, operation.block.id)
      recovered.push(index === operation.index ? operation : { ...operation, index })
    } else if (operation.type === 'update-block') {
      if (blockIds.includes(operation.blockId)) {
        recovered.push(operation)
        continue
      }
      recovered.push({ block: operation.block, index: blockIds.length, operationId: operation.operationId, type: 'insert-block' })
      blockIds.push(operation.block.id)
      readdedDeletedElements = true
    } else if (operation.type === 'move-block') {
      const currentIndex = blockIds.indexOf(operation.blockId)
      if (currentIndex < 0) continue
      blockIds.splice(currentIndex, 1)
      // A move names a position among the blocks that exist, so it ends at the last one at most.
      const index = clampIndex(operation.index, blockIds.length)
      blockIds.splice(index, 0, operation.blockId)
      recovered.push(index === operation.index ? operation : { ...operation, index })
    } else if (operation.type === 'delete-block') {
      const currentIndex = blockIds.indexOf(operation.blockId)
      if (currentIndex < 0) continue
      blockIds.splice(currentIndex, 1)
      recovered.push(operation)
    } else if (operation.type === 'insert-object') {
      objectIds.add(operation.object.id)
      recovered.push(operation)
    } else if (operation.type === 'update-object') {
      if (objectIds.has(operation.objectId)) {
        recovered.push(operation)
        continue
      }
      recovered.push({ object: operation.object, operationId: operation.operationId, type: 'insert-object' })
      objectIds.add(operation.object.id)
      readdedDeletedElements = true
    } else if (operation.type === 'delete-object') {
      if (!objectIds.delete(operation.objectId)) continue
      recovered.push(operation)
    } else {
      recovered.push(operation)
    }
  }
  return { operations: recovered, readdedDeletedElements }
}

/**
 * Keeps an insert position inside a list.
 *
 * @param value - Requested position.
 * @param length - Number of items in the list.
 * @returns A position from 0 to `length`.
 */
function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(length, Math.trunc(value)))
}

/**
 * Checks that a kept value is a Document operation this client made.
 *
 * @param value - One kept operation.
 * @returns Whether it has a known type, an operation ID, and the fields its type needs.
 */
function isKeptDocumentOperation(value: unknown): value is DocumentOperation {
  if (typeof value !== 'object' || value === null) return false
  const type: unknown = Reflect.get(value, 'type')
  const operationId: unknown = Reflect.get(value, 'operationId')
  if (typeof type !== 'string' || !isDocumentOperationType(type)) return false
  if (typeof operationId !== 'string' || !operationId) return false
  return documentOperationFields[type].every((field) => {
    const fieldValue: unknown = Reflect.get(value, field)
    if (field === 'index') return typeof fieldValue === 'number' && Number.isInteger(fieldValue)
    if (field.endsWith('Id')) return typeof fieldValue === 'string' && fieldValue !== ''
    return typeof fieldValue === 'object' && fieldValue !== null &&
      typeof Reflect.get(fieldValue, 'id') === 'string'
  })
}

/**
 * Narrows a string to a Document operation type.
 *
 * @param type - Kept operation type.
 * @returns Whether it is one the Document API accepts.
 */
function isDocumentOperationType(type: string): type is DocumentOperation['type'] {
  return Object.hasOwn(documentOperationFields, type)
}
