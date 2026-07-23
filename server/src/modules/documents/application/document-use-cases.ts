import type {
  ApplyDocumentOperationsInput,
  CreateDocumentInput,
  DocumentDetail,
  DocumentPermission,
  PublicDocument,
} from '@mukuroji/contracts'
import { DOCUMENT_SCHEMA_VERSION } from '@mukuroji/contracts'
import type {
  DocumentExportFormat,
  RenderedDocumentExport,
  ResolvedDocumentPublicShare,
} from '../document-types'
import {
  reduceDocumentOperations,
  renderPublicDocumentExport,
  validateDocumentPayload,
} from '../domain/document-content'
import { DocumentError } from '../errors'
export {
  DOCUMENT_BACKLINK_MAX_PAGE_LIMIT,
  DOCUMENT_COMMENT_MAX_PAGE_LIMIT,
  DOCUMENT_MAX_BACKLINK_COUNT,
  DOCUMENT_MAX_ITEM_BYTES,
  DOCUMENT_MAX_OPERATION_COUNT,
} from '../domain/document-limits'
export { DocumentError }

/**
 * Validates a create request against the canonical Document content invariants.
 *
 * @param input - Parsed create request from an inbound adapter.
 * @returns Nothing when the prospective Document is valid.
 */
export function validateCreateDocumentPayload(
  input: CreateDocumentInput,
): void {
  const defaultPermission: DocumentPermission = {
    mode: 'inherit',
    memberGrants: [],
  }
  const inputPermission = input.permission ?? defaultPermission
  const permission: DocumentPermission =
    inputPermission.mode === 'private'
      ? {
          ...inputPermission,
          memberGrants: [
            ...inputPermission.memberGrants.filter(
              ({ memberKey }) =>
                memberKey !== 'document-input-validation',
            ),
            {
              memberKey: 'document-input-validation',
              role: 'manager',
            },
          ],
        }
      : inputPermission
  const base = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: 'document-input-validation',
    scope: input.scope,
    ...(input.parentId === undefined
      ? {}
      : { parentId: input.parentId }),
    title: input.title,
    position: input.position ?? 'document-input-validation',
    revision: 1,
    permission,
    relations: [],
    favorite: false,
    capabilities: {
      canView: false,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: false,
    },
    createdByUserId: 'document-input-validation',
    updatedByUserId: 'document-input-validation',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
  }
  let document: DocumentDetail
  switch (input.kind) {
    case 'folder':
      document = {
        ...base,
        kind: 'folder',
        childCount: 0,
      }
      break
    case 'page':
    case 'template':
      document = {
        ...base,
        kind: input.kind,
        blocks: input.blocks,
      }
      break
    case 'whiteboard':
      document = {
        ...base,
        kind: 'whiteboard',
        whiteboard: input.whiteboard,
      }
  }
  validateDocumentPayload(document)
}

/**
 * Applies an operation batch to a sanitized clone for application preflight validation.
 *
 * @param current - Current permission-filtered Document snapshot.
 * @param input - Parsed operation batch.
 * @param actorMemberKey - Active actor used to preserve the private-manager invariant.
 * @returns Nothing when the prospective content is valid.
 */
export function validateDocumentOperationPayload(
  current: DocumentDetail,
  input: ApplyDocumentOperationsInput,
  actorMemberKey: string,
): void {
  const validationDocument = structuredClone(current)
  validationDocument.favorite = false
  delete validationDocument.lastOpenedAt
  validationDocument.capabilities = {
    canView: false,
    canEdit: false,
    canComment: false,
    canShare: false,
    canManagePermissions: false,
    canArchive: false,
    canRestore: false,
    canExport: false,
  }
  if (
    validationDocument.permission.mode === 'private' &&
    !validationDocument.permission.memberGrants.some(
      ({ role }) => role === 'manager',
    )
  ) {
    validationDocument.permission.memberGrants.push({
      memberKey: actorMemberKey,
      role: 'manager',
    })
  }
  reduceDocumentOperations({
    document: validationDocument,
    elementRevisions: {},
    baseRevision: input.baseRevision,
    nextRevision: current.revision + 1,
    operations: input.operations,
  })
}

/**
 * Enforces the share capability and renders a public Document export.
 *
 * @param resolved - Current public-share resolution from the share port.
 * @param document - Redacted public projection to render.
 * @param format - Requested export format.
 * @returns Safe rendered export content.
 */
export function renderAuthorizedPublicDocumentExport(
  resolved: ResolvedDocumentPublicShare,
  document: PublicDocument,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  if (!resolved.share.allowExport) {
    throw new DocumentError(
      403,
      'DocumentPublicExportDenied',
      'This public link does not allow export.',
    )
  }
  return renderPublicDocumentExport(document, format)
}
