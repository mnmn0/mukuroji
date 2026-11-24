import type { DocumentOperation } from '@mukuroji/contracts'

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
