import type {
  DocumentBlock,
  DocumentDetail,
  DocumentOperation,
  DocumentPermission,
  DocumentRelation,
  DocumentRelationTarget,
  DocumentScope,
  PublicDocument,
  WhiteboardConnector,
  WhiteboardContent,
  WhiteboardFrame,
  WhiteboardObject,
} from '@mukuroji/contracts'
import type {
  DocumentExportFormat,
  DocumentOperationConflictDetail,
  ReduceDocumentOperationsInput,
  ReduceDocumentOperationsResult,
  RenderedDocumentExport,
} from '../document-types'
import { DocumentError } from '../errors'
import {
  DOCUMENT_MAX_BACKLINK_COUNT,
  DOCUMENT_MAX_BLOCK_COUNT,
  DOCUMENT_MAX_ITEM_BYTES,
  DOCUMENT_MAX_OPERATION_COUNT,
  DOCUMENT_MAX_TABLE_COLUMNS,
  DOCUMENT_MAX_TABLE_ROWS,
  DOCUMENT_MAX_TEXT_LENGTH,
  DOCUMENT_MAX_TITLE_LENGTH,
  DOCUMENT_MAX_WHITEBOARD_CONNECTOR_COUNT,
  DOCUMENT_MAX_WHITEBOARD_FRAME_COUNT,
  DOCUMENT_MAX_WHITEBOARD_OBJECT_COUNT,
} from './document-limits'

/** Canonical whiteboard bound fields accepted by domain validation. */
const WHITEBOARD_BOUND_FIELDS = new Set([
  'x',
  'y',
  'width',
  'height',
  'rotation',
])

/**
 * Element targeted by an operation during conflict detection.
 */
type DocumentOperationTarget = {
  /** Stable revision-map key. */
  key: string
  /** Element category. */
  elementType: DocumentOperationConflictDetail['elementType']
  /** Canonical element ID. */
  elementId: string
}

/**
 * Applies an operation batch to a cloned canonical document snapshot.
 *
 * A stale batch is merged when none of its target elements changed after the
 * base revision. Any conflict rejects the complete batch without mutating the
 * input snapshot.
 *
 * @param input - Current snapshot, element revisions, and operation batch.
 * @returns Reduced snapshot, updated element revisions, and applied IDs.
 */
export function reduceDocumentOperations(
  input: ReduceDocumentOperationsInput,
): ReduceDocumentOperationsResult {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new DocumentError(400, 'InvalidDocumentBaseRevision', 'baseRevision must be a positive integer.')
  }
  if (
    !Number.isSafeInteger(input.nextRevision) ||
    input.nextRevision <= input.document.revision
  ) {
    throw new DocumentError(400, 'InvalidDocumentRevision', 'nextRevision must be newer than the document revision.')
  }
  const conflictFloorRevision =
    input.conflictFloorRevision ?? 1
  if (
    !Number.isSafeInteger(conflictFloorRevision) ||
    conflictFloorRevision < 1
  ) {
    throw new DocumentError(
      500,
      'InvalidDocumentConflictFloor',
      'The stored operation conflict floor is invalid.',
    )
  }
  if (input.baseRevision < conflictFloorRevision) {
    throw new DocumentError(
      409,
      'DocumentOperationHistoryCompacted',
      'The operation base revision is older than retained conflict history.',
      {
        baseRevision: input.baseRevision,
        conflictFloorRevision,
      },
    )
  }
  if (
    !Array.isArray(input.operations) ||
    input.operations.length === 0 ||
    input.operations.length > DOCUMENT_MAX_OPERATION_COUNT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentOperationCount',
      `operations must contain between 1 and ${DOCUMENT_MAX_OPERATION_COUNT} entries.`,
    )
  }

  const operationIds = new Set<string>()
  for (const operation of input.operations) {
    if (!isObjectLike(operation)) {
      throw invalidPayload('Every document operation must be an object.')
    }
    assertIdentifier(operation.operationId, 'operationId')
    if (operationIds.has(operation.operationId)) {
      throw new DocumentError(
        400,
        'DuplicateDocumentOperationId',
        `operationId "${operation.operationId}" appears more than once in the batch.`,
      )
    }
    operationIds.add(operation.operationId)
  }

  const conflicts: DocumentOperationConflictDetail[] = []
  for (const operation of input.operations) {
    for (const target of getOperationTargets(operation, input.document)) {
      const updatedRevision = input.elementRevisions[target.key] ?? 0
      if (updatedRevision > input.baseRevision) {
        conflicts.push({
          operationId: operation.operationId,
          elementType: target.elementType,
          elementId: target.elementId,
          updatedRevision,
          baseRevision: input.baseRevision,
        })
      }
    }
  }
  if (conflicts.length > 0) {
    throw new DocumentError(
      409,
      'DocumentOperationConflict',
      'One or more document elements changed after the supplied base revision.',
      { conflicts },
    )
  }

  const document = structuredClone(input.document)
  const elementRevisions = { ...input.elementRevisions }
  for (const operation of input.operations) {
    const targets = getOperationTargets(operation, document)
    applyDocumentOperation(document, operation)
    for (const target of targets) {
      elementRevisions[target.key] = input.nextRevision
    }
  }
  document.revision = input.nextRevision
  validateDocumentPayload(document)

  return {
    document,
    elementRevisions,
    appliedOperationIds: input.operations.map(({ operationId }) => operationId),
  }
}

/**
 * Validates a canonical document snapshot, internal references, and item size.
 *
 * @param document - Canonical document snapshot to validate.
 */
export function validateDocumentPayload(document: DocumentDetail): void {
  if (!isRecord(document)) throw invalidPayload('Document must be an object.')
  assertIdentifier(document.id, 'document.id')
  assertText(document.title, 'document.title', DOCUMENT_MAX_TITLE_LENGTH, false)
  assertIdentifier(document.createdByUserId, 'document.createdByUserId')
  assertIdentifier(document.updatedByUserId, 'document.updatedByUserId')
  assertIsoTimestamp(document.createdAt, 'document.createdAt')
  assertIsoTimestamp(document.updatedAt, 'document.updatedAt')
  if (!Number.isSafeInteger(document.revision) || document.revision < 1) {
    throw new DocumentError(400, 'InvalidDocumentRevision', 'document.revision must be a positive integer.')
  }
  validateDocumentScope(document.scope)
  validateDocumentPermission(document.permission)
  if (document.parentId !== undefined) assertIdentifier(document.parentId, 'document.parentId')

  if (!Array.isArray(document.relations)) {
    throw invalidPayload('document.relations must be an array.')
  }
  const relationIds = new Set<string>()
  for (const relation of document.relations) {
    validateRelation(relation, document)
    assertUniqueId(relationIds, relation.id, 'relation')
  }

  if (document.kind === 'page' || document.kind === 'template') {
    if (!Array.isArray(document.blocks)) {
      throw invalidPayload('document.blocks must be an array.')
    }
    if (document.blocks.length > DOCUMENT_MAX_BLOCK_COUNT) {
      throw new DocumentError(
        413,
        'DocumentBlockLimitExceeded',
        `A document can contain at most ${DOCUMENT_MAX_BLOCK_COUNT} blocks.`,
      )
    }
    const blockIds = new Set<string>()
    for (const block of document.blocks) {
      validateBlock(block)
      assertUniqueId(blockIds, block.id, 'block')
    }
  } else if (document.kind === 'whiteboard') {
    validateWhiteboard(document.whiteboard)
  } else if (document.kind !== 'folder') {
    throw invalidPayload('document.kind is invalid.')
  }

  const itemBytes = Buffer.byteLength(JSON.stringify(document), 'utf8')
  if (itemBytes > DOCUMENT_MAX_ITEM_BYTES) {
    throw new DocumentError(
      413,
      'DocumentPayloadTooLarge',
      `The document payload is ${itemBytes} bytes; the limit is ${DOCUMENT_MAX_ITEM_BYTES} bytes.`,
      { itemBytes, maxItemBytes: DOCUMENT_MAX_ITEM_BYTES },
    )
  }
  const backlinkCount = document.relations.length +
    (document.kind === 'whiteboard'
      ? document.whiteboard.objects.filter(({ type }) => type === 'work-item').length
      : 0)
  if (backlinkCount > DOCUMENT_MAX_BACKLINK_COUNT) {
    throw new DocumentError(
      413,
      'DocumentBacklinkLimitExceeded',
      `A document can index at most ${DOCUMENT_MAX_BACKLINK_COUNT} backlinks.`,
    )
  }
}

/**
 * Validates and renders a canonical document as a safe text artifact.
 *
 * @param document - Canonical document snapshot to render.
 * @param format - Requested export format.
 * @returns Safe rendered artifact.
 */
export function renderDocumentExport(
  document: DocumentDetail,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  validateDocumentPayload(document)
  return renderDocumentArtifact(
    document,
    format,
    document.id,
  )
}

/**
 * Renders a public-safe document projection without reintroducing metadata.
 *
 * @param document - Public document projection to render.
 * @param format - Requested export format.
 * @returns Safe rendered artifact.
 */
export function renderPublicDocumentExport(
  document: PublicDocument,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  return renderDocumentArtifact(
    document,
    format,
    'document',
  )
}

/**
 * Renders an access-projected document whose canonical source was already validated.
 *
 * @param document - Permission-filtered document projection.
 * @param format - Requested text export format.
 * @returns Safe rendered artifact.
 */
export function renderDocumentProjectionExport(
  document: DocumentDetail,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  return renderDocumentArtifact(document, format, document.id)
}

/**
 * Renders a canonical or public document as a downloadable text artifact.
 *
 * @param document - Document projection to render.
 * @param format - Requested export format.
 * @param fallbackFileName - File name to use when the document title is empty.
 * @returns Rendered export content and metadata.
 */
function renderDocumentArtifact(
  document: DocumentDetail | PublicDocument,
  format: DocumentExportFormat,
  fallbackFileName: string,
): RenderedDocumentExport {
  const safeBaseName = sanitizeFileName(
    document.title || fallbackFileName,
  )
  if (format === 'json') {
    return {
      format,
      contentType: 'application/json; charset=utf-8',
      fileName: `${safeBaseName}.json`,
      content: `${JSON.stringify(document, null, 2)}\n`,
    }
  }
  if (format === 'svg') {
    if (document.kind !== 'whiteboard') {
      throw new DocumentError(400, 'UnsupportedDocumentExport', 'SVG export is only available for whiteboards.')
    }
    return {
      format,
      contentType: 'image/svg+xml; charset=utf-8',
      fileName: `${safeBaseName}.svg`,
      content: renderWhiteboardSvg(document),
    }
  }
  if (document.kind !== 'page' && document.kind !== 'template') {
    throw new DocumentError(
      400,
      'UnsupportedDocumentExport',
      `${format.toUpperCase()} export is only available for pages and templates.`,
    )
  }
  if (format === 'markdown') {
    return {
      format,
      contentType: 'text/markdown; charset=utf-8',
      fileName: `${safeBaseName}.md`,
      content: renderMarkdown(document.title, document.blocks),
    }
  }
  throw new DocumentError(400, 'UnsupportedDocumentExport', `Unsupported export format: ${String(format)}.`)
}

/**
 * Collects every element revision target affected by an operation.
 *
 * @param operation - Operation to inspect.
 * @param document - Current document snapshot.
 * @returns Conflict targets affected by the operation.
 */
function getOperationTargets(
  operation: DocumentOperation,
  document: DocumentDetail,
): DocumentOperationTarget[] {
  switch (operation.type) {
    case 'insert-block':
      return [elementTarget('block', operation.block.id)]
    case 'update-block':
    case 'move-block':
      return [elementTarget('block', operation.blockId)]
    case 'delete-block':
      return [
        elementTarget('block', operation.blockId),
        ...document.relations
          .filter(
            ({ source }) =>
              source.kind === 'block' && source.blockId === operation.blockId,
          )
          .map(({ id }) => elementTarget('relation', id)),
      ]
    case 'insert-object':
      return [elementTarget('object', operation.object.id)]
    case 'update-object':
      return [elementTarget('object', operation.objectId)]
    case 'delete-object': {
      const targets = [elementTarget('object', operation.objectId)]
      if (document.kind !== 'whiteboard') return targets
      for (const connector of document.whiteboard.connectors) {
        if (
          connector.from.objectId === operation.objectId ||
          connector.to.objectId === operation.objectId
        ) {
          targets.push(elementTarget('connector', connector.id))
        }
      }
      for (const frame of document.whiteboard.frames) {
        if (frame.objectIds.includes(operation.objectId)) {
          targets.push(elementTarget('frame', frame.id))
        }
      }
      for (const relation of document.relations) {
        if (
          relation.source.kind === 'whiteboard-object' &&
          relation.source.objectId === operation.objectId
        ) {
          targets.push(elementTarget('relation', relation.id))
        }
      }
      return targets
    }
    case 'upsert-connector':
      return [elementTarget('connector', operation.connector.id)]
    case 'delete-connector':
      return [elementTarget('connector', operation.connectorId)]
    case 'upsert-frame':
      return [elementTarget('frame', operation.frame.id)]
    case 'delete-frame':
      return [elementTarget('frame', operation.frameId)]
    case 'upsert-relation':
      return [elementTarget('relation', operation.relation.id)]
    case 'delete-relation':
      return [elementTarget('relation', operation.relationId)]
    default:
      throw invalidPayload('Document operation type is invalid.')
  }
}

/**
 * Creates a normalized element revision target.
 *
 * @param elementType - Kind of document element.
 * @param elementId - Stable element identifier.
 * @returns Normalized operation target.
 */
function elementTarget(
  elementType: DocumentOperationConflictDetail['elementType'],
  elementId: string,
): DocumentOperationTarget {
  return { key: `${elementType}:${elementId}`, elementType, elementId }
}

/**
 * Applies one validated document operation to a mutable snapshot clone.
 *
 * @param document - Mutable document snapshot.
 * @param operation - Operation to apply.
 */
function applyDocumentOperation(document: DocumentDetail, operation: DocumentOperation): void {
  switch (operation.type) {
    case 'insert-block': {
      const blocks = requireBlocks(document)
      validateBlock(operation.block)
      assertIndex(operation.index, blocks.length, true)
      if (blocks.some(({ id }) => id === operation.block.id)) {
        throw new DocumentError(409, 'DocumentElementAlreadyExists', `Block "${operation.block.id}" already exists.`)
      }
      blocks.splice(operation.index, 0, structuredClone(operation.block))
      return
    }
    case 'update-block': {
      const blocks = requireBlocks(document)
      validateBlock(operation.block)
      if (operation.block.id !== operation.blockId) {
        throw new DocumentError(400, 'DocumentElementIdMismatch', 'block.id must match blockId.')
      }
      const index = findElementIndex(blocks, operation.blockId, 'block')
      blocks[index] = structuredClone(operation.block)
      return
    }
    case 'move-block': {
      const blocks = requireBlocks(document)
      assertIndex(operation.index, blocks.length, false)
      const index = findElementIndex(blocks, operation.blockId, 'block')
      const [block] = blocks.splice(index, 1)
      if (block === undefined) throw new DocumentError(404, 'DocumentElementNotFound', 'Block was not found.')
      blocks.splice(operation.index, 0, block)
      return
    }
    case 'delete-block': {
      const blocks = requireBlocks(document)
      const index = findElementIndex(blocks, operation.blockId, 'block')
      blocks.splice(index, 1)
      document.relations = document.relations.filter(
        ({ source }) => source.kind !== 'block' || source.blockId !== operation.blockId,
      )
      return
    }
    case 'insert-object': {
      const whiteboard = requireWhiteboard(document)
      validateWhiteboardObject(operation.object)
      if (whiteboard.objects.some(({ id }) => id === operation.object.id)) {
        throw new DocumentError(409, 'DocumentElementAlreadyExists', `Object "${operation.object.id}" already exists.`)
      }
      whiteboard.objects.push(structuredClone(operation.object))
      return
    }
    case 'update-object': {
      const whiteboard = requireWhiteboard(document)
      validateWhiteboardObject(operation.object)
      if (operation.object.id !== operation.objectId) {
        throw new DocumentError(400, 'DocumentElementIdMismatch', 'object.id must match objectId.')
      }
      const index = findElementIndex(whiteboard.objects, operation.objectId, 'object')
      whiteboard.objects[index] = structuredClone(operation.object)
      return
    }
    case 'delete-object': {
      const whiteboard = requireWhiteboard(document)
      const index = findElementIndex(whiteboard.objects, operation.objectId, 'object')
      whiteboard.objects.splice(index, 1)
      whiteboard.connectors = whiteboard.connectors.filter(
        ({ from, to }) => from.objectId !== operation.objectId && to.objectId !== operation.objectId,
      )
      whiteboard.frames = whiteboard.frames.map((frame) => ({
        ...frame,
        objectIds: frame.objectIds.filter((id) => id !== operation.objectId),
      }))
      document.relations = document.relations.filter(
        ({ source }) =>
          source.kind !== 'whiteboard-object' || source.objectId !== operation.objectId,
      )
      return
    }
    case 'upsert-connector': {
      const whiteboard = requireWhiteboard(document)
      validateConnector(operation.connector, new Set(whiteboard.objects.map(({ id }) => id)))
      upsertById(whiteboard.connectors, operation.connector)
      return
    }
    case 'delete-connector': {
      const whiteboard = requireWhiteboard(document)
      whiteboard.connectors.splice(
        findElementIndex(whiteboard.connectors, operation.connectorId, 'connector'),
        1,
      )
      return
    }
    case 'upsert-frame': {
      const whiteboard = requireWhiteboard(document)
      validateFrame(operation.frame, new Set(whiteboard.objects.map(({ id }) => id)))
      upsertById(whiteboard.frames, operation.frame)
      return
    }
    case 'delete-frame': {
      const whiteboard = requireWhiteboard(document)
      whiteboard.frames.splice(findElementIndex(whiteboard.frames, operation.frameId, 'frame'), 1)
      return
    }
    case 'upsert-relation':
      validateRelation(operation.relation, document)
      upsertById(document.relations, operation.relation)
      return
    case 'delete-relation':
      document.relations.splice(
        findElementIndex(document.relations, operation.relationId, 'relation'),
        1,
      )
      return
    default:
      throw invalidPayload('Document operation type is invalid.')
  }
}

/**
 * Returns the block collection for a page-like document.
 *
 * @param document - Document expected to contain blocks.
 * @returns Mutable block collection.
 */
function requireBlocks(document: DocumentDetail): DocumentBlock[] {
  if (document.kind !== 'page' && document.kind !== 'template') {
    throw new DocumentError(400, 'InvalidDocumentOperation', 'Block operations require a page or template.')
  }
  return document.blocks
}

/**
 * Returns whiteboard content from a whiteboard document.
 *
 * @param document - Document expected to be a whiteboard.
 * @returns Mutable whiteboard content.
 */
function requireWhiteboard(document: DocumentDetail): WhiteboardContent {
  if (document.kind !== 'whiteboard') {
    throw new DocumentError(400, 'InvalidDocumentOperation', 'Whiteboard operations require a whiteboard.')
  }
  return document.whiteboard
}

/**
 * Finds an element index or raises the canonical missing-element error.
 *
 * @param values - Elements to search.
 * @param id - Element identifier to find.
 * @param type - Element type used in validation errors.
 * @returns Matching array index.
 */
function findElementIndex<T extends { id: string }>(
  values: readonly T[],
  id: string,
  type: string,
): number {
  assertIdentifier(id, `${type}Id`)
  const index = values.findIndex((value) => value.id === id)
  if (index < 0) {
    throw new DocumentError(404, 'DocumentElementNotFound', `${capitalize(type)} "${id}" was not found.`)
  }
  return index
}

/**
 * Inserts or replaces a structured clone by stable identifier.
 *
 * @param values - Mutable element collection.
 * @param value - Element to insert or replace.
 */
function upsertById<T extends { id: string }>(values: T[], value: T): void {
  const index = values.findIndex(({ id }) => id === value.id)
  if (index < 0) values.push(structuredClone(value))
  else values[index] = structuredClone(value)
}

/**
 * Validates a canonical document scope.
 *
 * @param scope - Scope to validate.
 */
export function validateDocumentScope(scope: DocumentScope): void {
  if (!isRecord(scope) || (scope.type !== 'workspace' && scope.type !== 'project')) {
    throw invalidPayload('Document scope is invalid.')
  }
  if (scope.type === 'project') assertIdentifier(scope.projectId, 'scope.projectId')
}

/**
 * Validates canonical document permission state.
 *
 * @param permission - Permission state to validate.
 * @param requirePrivateManager - Whether private permissions must retain a manager.
 */
export function validateDocumentPermission(
  permission: DocumentPermission,
  requirePrivateManager = true,
): void {
  if (!isRecord(permission) || (permission.mode !== 'inherit' && permission.mode !== 'private')) {
    throw new DocumentError(400, 'InvalidDocumentPermission', 'Document permission mode is invalid.')
  }
  if (!Array.isArray(permission.memberGrants)) {
    throw new DocumentError(400, 'InvalidDocumentPermission', 'Document member grants must be an array.')
  }
  const members = new Set<string>()
  for (const grant of permission.memberGrants) {
    if (!isRecord(grant)) {
      throw new DocumentError(400, 'InvalidDocumentPermission', 'Document member grant is invalid.')
    }
    assertIdentifier(grant.memberKey, 'permission.memberGrants.memberKey')
    if (grant.role !== 'viewer' && grant.role !== 'editor' && grant.role !== 'manager') {
      throw new DocumentError(400, 'InvalidDocumentPermission', 'Document grant role is invalid.')
    }
    assertUniqueId(members, grant.memberKey, 'member grant')
  }
  if (
    requirePrivateManager &&
    permission.mode === 'private' &&
    !permission.memberGrants.some(({ role }) => role === 'manager')
  ) {
    throw new DocumentError(
      400,
      'DocumentPrivateManagerRequired',
      'Private documents must retain at least one manager grant.',
    )
  }
}

/**
 * Replaces the actor's grant with a manager grant.
 *
 * @param permission - Permission state to normalize.
 * @param memberKey - Actor who must remain a manager.
 * @returns Permission state containing the manager grant.
 */
function ensureManagerGrant(
  permission: DocumentPermission,
  memberKey: string,
): DocumentPermission {
  const memberGrants = permission.memberGrants.filter(
    (grant) => grant.memberKey !== memberKey,
  )
  return {
    ...structuredClone(permission),
    memberGrants: [
      ...memberGrants,
      { memberKey, role: 'manager' },
    ],
  }
}

/**
 * Normalizes a requested permission while retaining the creating actor as manager.
 *
 * @param permission - Requested document permission.
 * @param memberKey - Current actor member key.
 * @returns A validated permission safe to store.
 */
export function normalizeDocumentPermissionForActor(
  permission: DocumentPermission,
  memberKey: string,
): DocumentPermission {
  validateDocumentPermission(permission, false)
  const normalized = permission.mode === 'private'
    ? ensureManagerGrant(permission, memberKey)
    : structuredClone(permission)
  validateDocumentPermission(normalized)
  return normalized
}

/**
 * Validates one page or template block.
 *
 * @param block - Block payload to validate.
 */
function validateBlock(block: DocumentBlock): void {
  if (
    !isRecord(block) ||
    !['paragraph', 'heading', 'table', 'code', 'checklist', 'embed', 'diagram']
      .includes(String(block.type))
  ) {
    throw invalidPayload('Document block is invalid.')
  }
  assertIdentifier(block.id, 'block.id')
  switch (block.type) {
    case 'paragraph':
      assertText(block.text, 'block.text', DOCUMENT_MAX_TEXT_LENGTH, true)
      return
    case 'heading':
      assertText(block.text, 'block.text', DOCUMENT_MAX_TEXT_LENGTH, true)
      if (![1, 2, 3].includes(block.level)) {
        throw new DocumentError(400, 'InvalidDocumentBlock', 'Heading level must be 1, 2, or 3.')
      }
      return
    case 'table':
      if (!Array.isArray(block.columns) || !Array.isArray(block.rows)) {
        throw invalidPayload('Table columns and rows must be arrays.')
      }
      if (block.columns.length > DOCUMENT_MAX_TABLE_COLUMNS) {
        throw new DocumentError(413, 'DocumentTableLimitExceeded', 'Table column limit exceeded.')
      }
      if (block.rows.length > DOCUMENT_MAX_TABLE_ROWS) {
        throw new DocumentError(413, 'DocumentTableLimitExceeded', 'Table row limit exceeded.')
      }
      block.columns.forEach((column) =>
        assertText(column, 'block.columns[]', DOCUMENT_MAX_TEXT_LENGTH, true),
      )
      for (const row of block.rows) {
        if (!isRecord(row) || !Array.isArray(row.cells)) {
          throw invalidPayload('Table row is invalid.')
        }
        assertIdentifier(row.id, 'block.rows[].id')
        if (row.cells.length !== block.columns.length) {
          throw new DocumentError(400, 'InvalidDocumentTable', 'Every table row must match the column count.')
        }
        for (const cell of row.cells) {
          if (!isRecord(cell)) throw invalidPayload('Table cell is invalid.')
          assertIdentifier(cell.id, 'block.rows[].cells[].id')
          assertText(cell.text, 'block.rows[].cells[].text', DOCUMENT_MAX_TEXT_LENGTH, true)
        }
      }
      return
    case 'code':
      assertText(block.code, 'block.code', DOCUMENT_MAX_TEXT_LENGTH, true)
      if (block.language !== undefined) {
        assertCodeFenceInfoString(
          block.language,
          'block.language',
        )
      }
      return
    case 'checklist': {
      if (!Array.isArray(block.items)) {
        throw invalidPayload('Checklist items must be an array.')
      }
      const itemIds = new Set<string>()
      for (const item of block.items) {
        if (!isRecord(item)) throw invalidPayload('Checklist item is invalid.')
        assertIdentifier(item.id, 'block.items[].id')
        assertUniqueId(itemIds, item.id, 'checklist item')
        assertText(item.text, 'block.items[].text', DOCUMENT_MAX_TEXT_LENGTH, true)
        if (typeof item.checked !== 'boolean') {
          throw new DocumentError(
            400,
            'InvalidDocumentBlock',
            'Checklist item checked must be a boolean.',
          )
        }
        if (item.assigneeMemberKey !== undefined) {
          assertIdentifier(item.assigneeMemberKey, 'block.items[].assigneeMemberKey')
        }
      }
      return
    }
    case 'embed':
      assertSafeUrl(block.url, 'block.url')
      if (block.title !== undefined) assertText(block.title, 'block.title', DOCUMENT_MAX_TITLE_LENGTH, true)
      if (block.provider !== undefined) assertText(block.provider, 'block.provider', 100, true)
      return
    case 'diagram':
      if (block.format !== 'mermaid' && block.format !== 'text') {
        throw new DocumentError(
          400,
          'InvalidDocumentBlock',
          'Diagram format must be mermaid or text.',
        )
      }
      assertText(block.source, 'block.source', DOCUMENT_MAX_TEXT_LENGTH, true)
      return
    default:
      throw invalidPayload('Document block type is invalid.')
  }
}

/**
 * Validates whiteboard collections and their internal references.
 *
 * @param whiteboard - Whiteboard payload to validate.
 */
function validateWhiteboard(whiteboard: WhiteboardContent): void {
  if (
    !isRecord(whiteboard) ||
    !Array.isArray(whiteboard.objects) ||
    !Array.isArray(whiteboard.connectors) ||
    !Array.isArray(whiteboard.frames)
  ) {
    throw invalidPayload('Whiteboard content is invalid.')
  }
  if (whiteboard.objects.length > DOCUMENT_MAX_WHITEBOARD_OBJECT_COUNT) {
    throw new DocumentError(413, 'WhiteboardObjectLimitExceeded', 'Whiteboard object limit exceeded.')
  }
  if (whiteboard.connectors.length > DOCUMENT_MAX_WHITEBOARD_CONNECTOR_COUNT) {
    throw new DocumentError(413, 'WhiteboardConnectorLimitExceeded', 'Whiteboard connector limit exceeded.')
  }
  if (whiteboard.frames.length > DOCUMENT_MAX_WHITEBOARD_FRAME_COUNT) {
    throw new DocumentError(413, 'WhiteboardFrameLimitExceeded', 'Whiteboard frame limit exceeded.')
  }
  const objectIds = new Set<string>()
  for (const object of whiteboard.objects) {
    validateWhiteboardObject(object)
    assertUniqueId(objectIds, object.id, 'whiteboard object')
  }
  const connectorIds = new Set<string>()
  for (const connector of whiteboard.connectors) {
    validateConnector(connector, objectIds)
    assertUniqueId(connectorIds, connector.id, 'whiteboard connector')
  }
  const frameIds = new Set<string>()
  for (const frame of whiteboard.frames) {
    validateFrame(frame, objectIds)
    assertUniqueId(frameIds, frame.id, 'whiteboard frame')
  }
}

/**
 * Validates one whiteboard object and its style.
 *
 * @param object - Whiteboard object to validate.
 */
function validateWhiteboardObject(object: WhiteboardObject): void {
  if (
    !isRecord(object) ||
    !['note', 'shape', 'text', 'work-item'].includes(String(object.type))
  ) {
    throw invalidPayload('Whiteboard object is invalid.')
  }
  assertIdentifier(object.id, 'whiteboard.object.id')
  validateBounds(object.bounds)
  if (!Number.isSafeInteger(object.zIndex)) {
    throw new DocumentError(400, 'InvalidWhiteboardObject', 'Whiteboard object zIndex must be an integer.')
  }
  if (object.type === 'note' || object.type === 'text') {
    assertText(object.text, 'whiteboard.object.text', DOCUMENT_MAX_TEXT_LENGTH, true)
  } else if (object.type === 'shape') {
    if (
      object.shape !== 'rectangle' &&
      object.shape !== 'ellipse' &&
      object.shape !== 'diamond' &&
      object.shape !== 'triangle'
    ) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardObject',
        'Whiteboard shape is invalid.',
      )
    }
    if (object.text !== undefined) {
      assertText(
        object.text,
        'whiteboard.object.text',
        DOCUMENT_MAX_TEXT_LENGTH,
        true,
      )
    }
  } else if (object.type === 'work-item') {
    validateCanonicalDocumentWorkItemId(
      object.workItemId,
      'whiteboard.object.workItemId',
    )
  }
  if (object.style !== undefined && !isRecord(object.style)) {
    throw invalidPayload('Whiteboard object style is invalid.')
  }
  if (object.style !== undefined) {
    for (const color of [object.style.fill, object.style.stroke, object.style.textColor]) {
      if (color !== undefined && !isSafeCssColor(color)) {
        throw new DocumentError(400, 'InvalidWhiteboardColor', 'Whiteboard colors must use a safe CSS color value.')
      }
    }
  }
}

/**
 * Validates a whiteboard connector against available objects.
 *
 * @param connector - Connector to validate.
 * @param objectIds - Identifiers available as connector endpoints.
 */
function validateConnector(connector: WhiteboardConnector, objectIds: ReadonlySet<string>): void {
  if (
    !isRecord(connector) ||
    !isRecord(connector.from) ||
    !isRecord(connector.to)
  ) {
    throw invalidPayload('Whiteboard connector is invalid.')
  }
  assertIdentifier(connector.id, 'whiteboard.connector.id')
  for (const endpoint of [connector.from, connector.to]) {
    assertIdentifier(endpoint.objectId, 'whiteboard.connector.objectId')
    if (
      endpoint.anchor !== undefined &&
      endpoint.anchor !== 'top' &&
      endpoint.anchor !== 'right' &&
      endpoint.anchor !== 'bottom' &&
      endpoint.anchor !== 'left' &&
      endpoint.anchor !== 'center'
    ) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardConnector',
        'Whiteboard connector anchor is invalid.',
      )
    }
    if (!objectIds.has(endpoint.objectId)) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardReference',
        `Connector "${connector.id}" references a missing object.`,
      )
    }
  }
  if (connector.label !== undefined) {
    assertText(connector.label, 'whiteboard.connector.label', DOCUMENT_MAX_TEXT_LENGTH, true)
  }
  if (
    connector.lineStyle !== undefined &&
    connector.lineStyle !== 'solid' &&
    connector.lineStyle !== 'dashed'
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardConnector',
      'Whiteboard connector lineStyle is invalid.',
    )
  }
}

/**
 * Validates a whiteboard frame and its object references.
 *
 * @param frame - Frame to validate.
 * @param objectIds - Identifiers available as frame members.
 */
function validateFrame(frame: WhiteboardFrame, objectIds: ReadonlySet<string>): void {
  if (!isRecord(frame) || !Array.isArray(frame.objectIds)) {
    throw invalidPayload('Whiteboard frame is invalid.')
  }
  assertIdentifier(frame.id, 'whiteboard.frame.id')
  assertText(frame.title, 'whiteboard.frame.title', DOCUMENT_MAX_TITLE_LENGTH, true)
  validateBounds(frame.bounds)
  const members = new Set<string>()
  for (const objectId of frame.objectIds) {
    assertIdentifier(objectId, 'whiteboard.frame.objectIds[]')
    if (!objectIds.has(objectId)) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardReference',
        `Frame "${frame.id}" references a missing object.`,
      )
    }
    assertUniqueId(members, objectId, 'frame object')
  }
}

/**
 * Validates finite, positive whiteboard bounds.
 *
 * @param bounds - Bounds payload to validate.
 */
function validateBounds(bounds: WhiteboardObject['bounds']): void {
  if (!isRecord(bounds)) throw invalidPayload('Whiteboard bounds are invalid.')
  if (
    Object.keys(bounds).some(
      (field) =>
        !WHITEBOARD_BOUND_FIELDS.has(field),
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardBounds',
      'Whiteboard bounds contain an unsupported field.',
    )
  }
  for (const name of ['x', 'y', 'width', 'height'] as const) {
    const value = bounds[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DocumentError(400, 'InvalidWhiteboardBounds', `${name} must be a finite number.`)
    }
  }
  if (
    bounds.rotation !== undefined &&
    (
      typeof bounds.rotation !== 'number' ||
      !Number.isFinite(bounds.rotation)
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardBounds',
      'rotation must be a finite number.',
    )
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new DocumentError(400, 'InvalidWhiteboardBounds', 'Whiteboard width and height must be positive.')
  }
}

/**
 * Validates a document relation and its local source reference.
 *
 * @param relation - Relation payload to validate.
 * @param document - Document containing the relation source.
 */
function validateRelation(relation: DocumentRelation, document: DocumentDetail): void {
  if (
    !isRecord(relation) ||
    !isRecord(relation.source) ||
    !isRecord(relation.target) ||
    !['document', 'block', 'whiteboard-object'].includes(String(relation.source.kind)) ||
    !['work-item', 'project', 'goal'].includes(String(relation.target.kind))
  ) {
    throw invalidPayload('Document relation is invalid.')
  }
  assertIdentifier(relation.id, 'relation.id')
  if (relation.id.startsWith('system:whiteboard-work-item:')) {
    throw new DocumentError(
      400,
      'InvalidDocumentRelation',
      'The relation ID uses a reserved namespace.',
    )
  }
  assertIdentifier(relation.createdByUserId, 'relation.createdByUserId')
  assertIsoTimestamp(relation.createdAt, 'relation.createdAt')
  if (relation.source.kind === 'block') {
    const blockId = relation.source.blockId
    const blocks = document.kind === 'page' || document.kind === 'template' ? document.blocks : []
    if (!blocks.some(({ id }) => id === blockId)) {
      throw new DocumentError(400, 'InvalidDocumentRelation', 'Relation references a missing block.')
    }
  } else if (relation.source.kind === 'whiteboard-object') {
    const objectId = relation.source.objectId
    const objects = document.kind === 'whiteboard' ? document.whiteboard.objects : []
    if (!objects.some(({ id }) => id === objectId)) {
      throw new DocumentError(400, 'InvalidDocumentRelation', 'Relation references a missing whiteboard object.')
    }
  }
  if (relation.target.kind === 'work-item') {
    validateCanonicalDocumentWorkItemId(
      relation.target.workItemId,
      'relation.target.id',
    )
  } else {
    assertIdentifier(relationTargetId(relation), 'relation.target.id')
  }
}

/**
 * Validates a canonical Work Item relation target ID.
 *
 * @param value - Work Item ID to validate.
 * @param fieldName - Field name used in stable validation errors.
 */
export function validateCanonicalDocumentWorkItemId(
  value: string,
  fieldName: string,
): void {
  assertIdentifier(value, fieldName)
  const parts = value.split('/')
  if (
    parts.length !== 4 ||
    parts[0] !== 'team' ||
    !parts[1] ||
    parts[2] !== 'issue' ||
    !parts[3]
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentRelationTarget',
      `${fieldName} must use team/<teamId>/issue/<issueId>.`,
    )
  }
}

/**
 * Renders page blocks as escaped Markdown.
 *
 * @param title - Document title.
 * @param blocks - Blocks to render.
 * @returns Markdown document text.
 */
function renderMarkdown(title: string, blocks: readonly DocumentBlock[]): string {
  const parts = [`# ${escapeMarkdownText(title)}`]
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        parts.push(escapeMarkdownText(block.text))
        break
      case 'heading':
        parts.push(`${'#'.repeat(block.level + 1)} ${escapeMarkdownText(block.text)}`)
        break
      case 'table': {
        parts.push(
          `| ${block.columns.map(escapeMarkdownTableCell).join(' | ')} |`,
          `| ${block.columns.map(() => '---').join(' | ')} |`,
          ...block.rows.map(
            (row) => `| ${row.cells.map(({ text }) => escapeMarkdownTableCell(text)).join(' | ')} |`,
          ),
        )
        break
      }
      case 'code':
        parts.push(
          renderMarkdownCodeFence(
            block.code,
            block.language,
          ),
        )
        break
      case 'checklist':
        parts.push(
          block.items
            .map((item) => `- [${item.checked ? 'x' : ' '}] ${escapeMarkdownText(item.text)}`)
            .join('\n'),
        )
        break
      case 'embed':
        parts.push(`[${escapeMarkdownText(block.title ?? block.url)}](${escapeMarkdownUrl(block.url)})`)
        break
      case 'diagram':
        parts.push(
          renderMarkdownCodeFence(
            block.source,
            block.format,
          ),
        )
    }
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * Renders source text inside a collision-safe Markdown code fence.
 *
 * @param source - Source text to wrap.
 * @param infoString - Optional validated fence language.
 * @returns Markdown code fence.
 */
function renderMarkdownCodeFence(
  source: string,
  infoString?: string,
): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...source.matchAll(/`+/gu)].map(
      ([run]) => run.length,
    ),
  )
  const fence = '`'.repeat(
    Math.max(3, longestBacktickRun + 1),
  )
  const safeInfoString =
    infoString !== undefined &&
      isSafeCodeFenceInfoString(infoString)
      ? infoString
      : ''
  return `${fence}${safeInfoString}\n${source}\n${fence}`
}

/**
 * Renders a whiteboard projection as escaped standalone SVG.
 *
 * @param document - Whiteboard projection to render.
 * @returns Standalone SVG text.
 */
function renderWhiteboardSvg(
  document:
    | Extract<DocumentDetail, { kind: 'whiteboard' }>
    | Extract<PublicDocument, { kind: 'whiteboard' }>,
): string {
  const bounds = [
    ...document.whiteboard.objects.map((object) => object.bounds),
    ...document.whiteboard.frames.map((frame) => frame.bounds),
  ]
  const xValues = bounds.flatMap((value) => [value.x, value.x + value.width])
  const yValues = bounds.flatMap((value) => [value.y, value.y + value.height])
  const minX = xValues.length > 0 ? Math.min(...xValues) : 0
  const minY = yValues.length > 0 ? Math.min(...yValues) : 0
  const maxX = xValues.length > 0 ? Math.max(...xValues) : 1024
  const maxY = yValues.length > 0 ? Math.max(...yValues) : 768
  const objectMap = new Map(document.whiteboard.objects.map((object) => [object.id, object]))
  const connectors = document.whiteboard.connectors.map((connector) => {
    const from = objectMap.get(connector.from.objectId)
    const to = objectMap.get(connector.to.objectId)
    if (from === undefined || to === undefined) return ''
    const fromX = from.bounds.x + from.bounds.width / 2
    const fromY = from.bounds.y + from.bounds.height / 2
    const toX = to.bounds.x + to.bounds.width / 2
    const toY = to.bounds.y + to.bounds.height / 2
    return `<g><line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="#64748b"${connector.lineStyle === 'dashed' ? ' stroke-dasharray="8 6"' : ''}/>${connector.label ? `<text x="${(fromX + toX) / 2}" y="${(fromY + toY) / 2}" text-anchor="middle">${escapeXml(connector.label)}</text>` : ''}</g>`
  }).join('')
  const frames = document.whiteboard.frames.map((frame) =>
    `<g><rect x="${frame.bounds.x}" y="${frame.bounds.y}" width="${frame.bounds.width}" height="${frame.bounds.height}" fill="none" stroke="#94a3b8" stroke-dasharray="6 4"/><text x="${frame.bounds.x + 8}" y="${frame.bounds.y + 20}">${escapeXml(frame.title)}</text></g>`,
  ).join('')
  const objects = [...document.whiteboard.objects].sort((a, b) => a.zIndex - b.zIndex).map((object) => {
    const fill = safeSvgColor(object.style?.fill, object.type === 'note' ? '#fef08a' : '#ffffff')
    const stroke = safeSvgColor(object.style?.stroke, '#334155')
    const textColor = safeSvgColor(object.style?.textColor, '#0f172a')
    const transform = object.bounds.rotation
      ? ` transform="rotate(${object.bounds.rotation} ${object.bounds.x + object.bounds.width / 2} ${object.bounds.y + object.bounds.height / 2})"`
      : ''
    const shape = object.type === 'shape' && object.shape === 'ellipse'
      ? `<ellipse cx="${object.bounds.x + object.bounds.width / 2}" cy="${object.bounds.y + object.bounds.height / 2}" rx="${object.bounds.width / 2}" ry="${object.bounds.height / 2}" fill="${fill}" stroke="${stroke}"/>`
      : `<rect x="${object.bounds.x}" y="${object.bounds.y}" width="${object.bounds.width}" height="${object.bounds.height}" rx="${object.type === 'note' ? 6 : 2}" fill="${fill}" stroke="${stroke}"/>`
    const label = object.type === 'work-item'
      ? 'workItemId' in object
        ? `Work item: ${object.workItemId}`
        : 'Work item'
      : object.type === 'shape'
        ? object.text ?? ''
        : object.text
    return `<g${transform}>${shape}<text x="${object.bounds.x + 10}" y="${object.bounds.y + 24}" fill="${textColor}">${escapeXml(label)}</text></g>`
  }).join('')
  const width = Math.max(1, maxX - minX + 40)
  const height = Math.max(1, maxY - minY + 40)
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(document.title)}" viewBox="${minX - 20} ${minY - 20} ${width} ${height}"><rect x="${minX - 20}" y="${minY - 20}" width="${width}" height="${height}" fill="#ffffff"/>${frames}${connectors}${objects}</svg>\n`
}

/**
 * Asserts that a value is a bounded, non-empty document identifier.
 *
 * @param value - Identifier candidate.
 * @param field - Field name used in validation errors.
 */
function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new DocumentError(400, 'InvalidDocumentIdentifier', `${field} is invalid.`)
  }
}

/**
 * Asserts that text satisfies the configured length and emptiness rules.
 *
 * @param value - Text candidate.
 * @param field - Field name used in validation errors.
 * @param maxLength - Maximum number of characters.
 * @param allowEmpty - Whether blank text is accepted.
 */
function assertText(
  value: string,
  field: string,
  maxLength: number,
  allowEmpty: boolean,
): void {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentText',
      `${field} must ${allowEmpty ? '' : 'not be empty and '}contain at most ${maxLength} characters.`,
    )
  }
}

/**
 * Asserts that a Markdown code-fence info string is safe.
 *
 * @param value - Info string candidate.
 * @param field - Field name used in validation errors.
 */
function assertCodeFenceInfoString(
  value: string,
  field: string,
): void {
  if (
    typeof value !== 'string' ||
    !isSafeCodeFenceInfoString(value)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCodeLanguage',
      `${field} must be a single safe language identifier.`,
    )
  }
}

/**
 * Checks whether a Markdown code-fence info string is a single safe token.
 *
 * @param value - Info string candidate.
 * @returns Whether the value is safe.
 */
function isSafeCodeFenceInfoString(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u.test(value)
}

/**
 * Asserts that a timestamp is canonical ISO-8601 text.
 *
 * @param value - Timestamp candidate.
 * @param field - Field name used in validation errors.
 */
function assertIsoTimestamp(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new DocumentError(400, 'InvalidDocumentTimestamp', `${field} must be an ISO-8601 timestamp.`)
  }
}

/**
 * Records an identifier after asserting it is unique in its collection.
 *
 * @param values - Previously observed identifiers.
 * @param id - Identifier to record.
 * @param type - Element type used in validation errors.
 */
function assertUniqueId(values: Set<string>, id: string, type: string): void {
  if (values.has(id)) {
    throw new DocumentError(400, 'DuplicateDocumentElementId', `Duplicate ${type} ID "${id}".`)
  }
  values.add(id)
}

/**
 * Asserts that an operation index is within collection bounds.
 *
 * @param index - Requested index.
 * @param length - Current collection length.
 * @param allowEnd - Whether insertion at the end is allowed.
 */
function assertIndex(index: number, length: number, allowEnd: boolean): void {
  const maximum = allowEnd ? length : Math.max(0, length - 1)
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new DocumentError(400, 'InvalidDocumentElementIndex', 'The element index is out of range.')
  }
}

/**
 * Asserts that a URL is HTTP(S) or a single-slash application-relative path.
 *
 * @param value - URL candidate.
 * @param field - Field name used in validation errors.
 */
function assertSafeUrl(value: string, field: string): void {
  assertText(value, field, 4_096, false)
  if (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\')
  ) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsafe scheme')
  } catch {
    throw new DocumentError(400, 'InvalidDocumentUrl', `${field} must be an HTTP(S) or application-relative URL.`)
  }
}

/**
 * Checks whether a color uses the supported restricted CSS syntax.
 *
 * @param value - CSS color candidate.
 * @returns Whether the color is safe for SVG output.
 */
function isSafeCssColor(value: string): boolean {
  return (
    /^#[\da-f]{3,8}$/iu.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/iu.test(value) ||
    /^(?:transparent|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|teal|navy)$/iu.test(value)
  )
}

/**
 * Selects and escapes a safe SVG color value.
 *
 * @param value - Optional requested color.
 * @param fallback - Trusted fallback color.
 * @returns Escaped safe color.
 */
function safeSvgColor(value: string | undefined, fallback: string): string {
  return value !== undefined && isSafeCssColor(value) ? escapeXml(value) : fallback
}

/**
 * Escapes Markdown punctuation in plain text.
 *
 * @param value - Plain text to escape.
 * @returns Escaped Markdown text.
 */
function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, '\\$1')
}

/**
 * Escapes text for a Markdown table cell.
 *
 * @param value - Cell text to escape.
 * @returns Escaped table-cell text.
 */
function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownText(value).replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>')
}

/**
 * Encodes a validated URL for a Markdown link destination.
 *
 * @param value - Validated URL.
 * @returns Encoded Markdown destination.
 */
function escapeMarkdownUrl(value: string): string {
  return encodeURI(value).replaceAll('(', '%28').replaceAll(')', '%29')
}

/**
 * Escapes XML metacharacters for SVG text and attributes.
 *
 * @param value - Text to escape.
 * @returns XML-safe text.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Normalizes user text into a bounded export file name.
 *
 * @param value - File-name candidate.
 * @returns Safe base file name.
 */
function sanitizeFileName(value: string): string {
  const safe = value
    .normalize('NFKC')
    .replace(/[/\\?%*:|"<>.\p{Cc}]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120)
  return safe.length > 0 ? safe : 'document'
}

/**
 * Capitalizes the first character of a label.
 *
 * @param value - Label to capitalize.
 * @returns Capitalized label.
 */
function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`
}

/**
 * Returns the canonical identifier carried by a relation target.
 *
 * @param relation - Relation whose target to inspect.
 * @returns Target identifier.
 */
function relationTargetId(relation: DocumentRelation): string {
  switch (relation.target.kind) {
    case 'work-item':
      return relation.target.workItemId
    case 'project':
      return relation.target.projectId
    case 'goal':
      return relation.target.goalId
  }
}

/**
 * Checks whether a value is a non-array record.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a non-null, non-array object.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is object-like.
 */
function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the canonical invalid document payload error.
 *
 * @param message - Stable validation detail.
 * @returns Invalid payload error.
 */
function invalidPayload(message: string): DocumentError {
  return new DocumentError(400, 'InvalidDocumentPayload', message)
}

/**
 * Collects external domain targets referenced by a document snapshot.
 *
 * @param document - Document snapshot to inspect.
 * @returns Cloned relation and whiteboard Work Item targets.
 */
export function collectDocumentRelationTargets(
  document: DocumentDetail,
): DocumentRelationTarget[] {
  return [
    ...document.relations.map(({ target }) =>
      structuredClone(target)
    ),
    ...(document.kind === 'whiteboard'
      ? document.whiteboard.objects.flatMap((object) =>
          object.type === 'work-item'
            ? [{
                kind: 'work-item' as const,
                workItemId: object.workItemId,
              }]
            : []
        )
      : []),
  ]
}
