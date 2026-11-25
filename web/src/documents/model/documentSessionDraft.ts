import type { DocumentOperation, DocumentRelationSource, WhiteboardConnector } from '@mukuroji/contracts'
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
 * The Document API refuses a whole batch when one operation names an element that is gone, so
 * moving or deleting an element that is already gone is dropped, a connector or relation whose
 * element is gone is dropped, a frame keeps only the objects that remain, and a kept position
 * past the blocks that remain is moved to the end.
 *
 * @param document - Current Document the operations are restored onto.
 * @param operations - Kept operations, in the order they were made.
 * @returns Operations to restore and whether deleted elements were added back.
 */
export function recoverDocumentSessionDraftOperations(
  document: DocumentRecord,
  operations: readonly DocumentOperation[],
): RecoveredDocumentSessionDraftOperations {
  const elements = createDocumentElementTracker(document)
  const recovered: DocumentOperation[] = []
  let readdedDeletedElements = false

  for (const operation of operations) {
    if (operation.type === 'insert-block') {
      // Blocks deleted meanwhile can leave a kept position past the end, which the API refuses.
      const index = clampIndex(operation.index, elements.blockIds.length)
      elements.blockIds.splice(index, 0, operation.block.id)
      recovered.push(index === operation.index ? operation : { ...operation, index })
    } else if (operation.type === 'update-block') {
      if (elements.blockIds.includes(operation.blockId)) {
        recovered.push(operation)
        continue
      }
      recovered.push({ block: operation.block, index: elements.blockIds.length, operationId: operation.operationId, type: 'insert-block' })
      elements.blockIds.push(operation.block.id)
      readdedDeletedElements = true
    } else if (operation.type === 'move-block') {
      const currentIndex = elements.blockIds.indexOf(operation.blockId)
      if (currentIndex < 0) continue
      elements.blockIds.splice(currentIndex, 1)
      // A move names a position among the blocks that exist, so it ends at the last one at most.
      const index = clampIndex(operation.index, elements.blockIds.length)
      elements.blockIds.splice(index, 0, operation.blockId)
      recovered.push(index === operation.index ? operation : { ...operation, index })
    } else if (operation.type === 'delete-block') {
      const currentIndex = elements.blockIds.indexOf(operation.blockId)
      if (currentIndex < 0) continue
      elements.blockIds.splice(currentIndex, 1)
      elements.removeRelationsFrom((source) => source.kind === 'block' && source.blockId === operation.blockId)
      recovered.push(operation)
    } else if (operation.type === 'insert-object') {
      elements.objectIds.add(operation.object.id)
      recovered.push(operation)
    } else if (operation.type === 'update-object') {
      if (elements.objectIds.has(operation.objectId)) {
        recovered.push(operation)
        continue
      }
      recovered.push({ object: operation.object, operationId: operation.operationId, type: 'insert-object' })
      elements.objectIds.add(operation.object.id)
      readdedDeletedElements = true
    } else if (operation.type === 'delete-object') {
      if (!elements.objectIds.delete(operation.objectId)) continue
      // Deleting an object also removes the connectors and relations that point at it.
      for (const [connectorId, connector] of elements.connectors) {
        if (connector.from.objectId === operation.objectId || connector.to.objectId === operation.objectId) {
          elements.connectors.delete(connectorId)
        }
      }
      elements.removeRelationsFrom((source) => source.kind === 'whiteboard-object' && source.objectId === operation.objectId)
      recovered.push(operation)
    } else if (operation.type === 'upsert-connector') {
      const { connector } = operation
      if (!elements.objectIds.has(connector.from.objectId) || !elements.objectIds.has(connector.to.objectId)) continue
      elements.connectors.set(connector.id, connector)
      recovered.push(operation)
    } else if (operation.type === 'delete-connector') {
      if (!elements.connectors.delete(operation.connectorId)) continue
      recovered.push(operation)
    } else if (operation.type === 'upsert-frame') {
      const objectIds = operation.frame.objectIds.filter((objectId) => elements.objectIds.has(objectId))
      elements.frameIds.add(operation.frame.id)
      recovered.push(objectIds.length === operation.frame.objectIds.length
        ? operation
        : { ...operation, frame: { ...operation.frame, objectIds } })
    } else if (operation.type === 'delete-frame') {
      if (!elements.frameIds.delete(operation.frameId)) continue
      recovered.push(operation)
    } else if (operation.type === 'upsert-relation') {
      if (!elements.hasRelationSource(operation.relation.source)) continue
      elements.relations.set(operation.relation.id, operation.relation.source)
      recovered.push(operation)
    } else {
      if (!elements.relations.delete(operation.relationId)) continue
      recovered.push(operation)
    }
  }
  return { operations: recovered, readdedDeletedElements }
}

/** Elements of a Document that kept operations may name, as they stand while operations are fitted. */
type DocumentElementTracker = {
  /** Block IDs in page order. */
  blockIds: string[]
  /** Whiteboard object IDs. */
  objectIds: Set<string>
  /** Whiteboard connectors by ID. */
  connectors: Map<string, WhiteboardConnector>
  /** Whiteboard frame IDs. */
  frameIds: Set<string>
  /** Relation sources by relation ID. */
  relations: Map<string, DocumentRelationSource>
  /** Removes the relations whose source matches. */
  removeRelationsFrom: (matches: (source: DocumentRelationSource) => boolean) => void
  /** Tells whether a relation's source element exists. */
  hasRelationSource: (source: DocumentRelationSource) => boolean
}

/**
 * Collects the elements of a Document that kept operations may name.
 *
 * @param document - Current Document.
 * @returns Mutable element sets.
 */
function createDocumentElementTracker(document: DocumentRecord): DocumentElementTracker {
  const whiteboard = document.kind === 'whiteboard' ? document.whiteboard : undefined
  const tracker: DocumentElementTracker = {
    blockIds: document.kind === 'page' || document.kind === 'template' ? document.blocks.map((block) => block.id) : [],
    objectIds: new Set(whiteboard?.objects.map((object) => object.id) ?? []),
    connectors: new Map((whiteboard?.connectors ?? []).map((connector) => [connector.id, connector])),
    frameIds: new Set(whiteboard?.frames.map((frame) => frame.id) ?? []),
    relations: new Map(document.relations.map((relation) => [relation.id, relation.source])),
    removeRelationsFrom: (matches) => {
      for (const [relationId, source] of tracker.relations) {
        if (matches(source)) tracker.relations.delete(relationId)
      }
    },
    hasRelationSource: (source) => {
      if (source.kind === 'block') return tracker.blockIds.includes(source.blockId)
      if (source.kind === 'whiteboard-object') return tracker.objectIds.has(source.objectId)
      return true
    },
  }
  return tracker
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
      typeof Reflect.get(fieldValue, 'id') === 'string' && hasKeptElementReferences(field, fieldValue)
  })
}

/**
 * Checks the references to other elements that fitting a draft to the current Document reads.
 *
 * @param field - Operation field holding the element.
 * @param element - Kept element.
 * @returns Whether a connector names both ends, a frame lists its objects, and a relation has a
 * source; other elements need nothing more.
 */
function hasKeptElementReferences(field: string, element: object): boolean {
  if (field === 'connector') {
    return ['from', 'to'].every((end) => {
      const endpoint: unknown = Reflect.get(element, end)
      return typeof endpoint === 'object' && endpoint !== null && typeof Reflect.get(endpoint, 'objectId') === 'string'
    })
  }
  if (field === 'frame') {
    const objectIds: unknown = Reflect.get(element, 'objectIds')
    return Array.isArray(objectIds) && objectIds.every((objectId) => typeof objectId === 'string')
  }
  if (field === 'relation') {
    const source: unknown = Reflect.get(element, 'source')
    return typeof source === 'object' && source !== null && typeof Reflect.get(source, 'kind') === 'string'
  }
  return true
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
