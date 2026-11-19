import type {
  DocumentDetail,
  PublicDocumentContent,
  PublicWorkItemDocument,
} from '@mukuroji/contracts'
import {
  DocumentError,
  renderDocumentProjectionExport,
  type DocumentAccessContext,
} from '../../modules/documents'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicDocumentService,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import { readDocumentAuthorizationSnapshot } from './document-access'
import { createDocumentEnterpriseScopeBoundary } from './project-access'
import { loadAuthorizedTeamIssue } from './work-item-access'

/**
 * Resolves the Document viewer access of a credential owner from current Workspace, Project, and
 * Enterprise permissions, exactly as the Documents routes do for a signed-in member.
 *
 * @param credential - Authenticated developer credential.
 * @returns The owner's Workspace ID and Document access context.
 */
async function resolveCredentialDocumentAccess(
  credential: AuthenticatedDeveloperCredential,
): Promise<{
  /** Workspace that owns the Documents. */
  workspaceId: string
  /** Current Document access of the credential owner. */
  access: DocumentAccessContext
}> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
    evaluateProjectScopes: true,
  })
  const { projectRoles } = await readDocumentAuthorizationSnapshot(principal)
  return {
    workspaceId: principal.directoryId,
    access: {
      memberKey: principal.userKey,
      workspaceRole: principal.workspaceRole,
      isSystemAdmin: principal.isSystemAdmin,
      projectRoles,
      ...createDocumentEnterpriseScopeBoundary(principal),
    },
  }
}

/**
 * Reads a Document the credential owner can view, reporting a hidden Document as missing so the
 * response does not reveal that it exists.
 *
 * @param workspaceId - Workspace that owns the Document.
 * @param documentId - Document ID.
 * @param access - Credential owner's Document access.
 * @returns The permission-filtered Document.
 */
async function readVisibleDocument(
  workspaceId: string,
  documentId: string,
  access: DocumentAccessContext,
): Promise<DocumentDetail> {
  try {
    return await workItemDependencies.documents.get({ workspaceId, documentId, access })
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) {
      throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
    }
    throw error
  }
}

/**
 * Returns the relation target ID the Documents store uses for a Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns Canonical Work Item relation target ID.
 */
function toWorkItemRelationTargetId(teamId: string, workItemId: string): string {
  return `team/${teamId}/issue/${workItemId}`
}

/**
 * Checks that the credential owner can currently view the Work Item.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns A promise that resolves when the Work Item is visible.
 */
async function requireVisibleWorkItem(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  workItemId: string,
): Promise<void> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read', teamId, evaluateProjectScopes: true,
  })
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
}

/**
 * Creates the read-only Public API service for Documents linked to Work Items. Every call
 * evaluates the credential owner's current permissions; nothing is cached between calls.
 *
 * @returns Document service backed by the canonical Documents store.
 */
export function createCanonicalPublicDocumentService(): PublicDocumentService {
  return {
    /** Lists visible Documents linked to a Work Item the credential owner can view. */
    async listWorkItemDocuments(credential, teamId, workItemId, continuation, limit) {
      await requireVisibleWorkItem(credential, teamId, workItemId)
      const { workspaceId, access } = await resolveCredentialDocumentAccess(credential)
      const page = await workItemDependencies.documents.listBacklinks({
        workspaceId,
        targetKind: 'work-item',
        targetId: toWorkItemRelationTargetId(teamId, workItemId),
        access,
        limit,
        ...(continuation === undefined ? {} : { cursor: continuation }),
      })
      const items = new Map<string, PublicWorkItemDocument>()
      for (const backlink of page.backlinks) {
        if (!items.has(backlink.documentId)) {
          items.set(backlink.documentId, { id: backlink.documentId, title: backlink.documentTitle })
        }
      }
      return {
        items: [...items.values()],
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Renders a linked page or template the credential owner can view as Markdown. */
    async getWorkItemDocument(credential, teamId, workItemId, documentId) {
      await requireVisibleWorkItem(credential, teamId, workItemId)
      const { workspaceId, access } = await resolveCredentialDocumentAccess(credential)
      const document = await readVisibleDocument(workspaceId, documentId, access)
      const targetId = toWorkItemRelationTargetId(teamId, workItemId)
      if (!document.relations.some((relation) =>
        relation.target.kind === 'work-item' && relation.target.workItemId === targetId
      )) {
        throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
      }
      if (document.kind !== 'page' && document.kind !== 'template') {
        throw new PublicApiServiceError(
          422,
          'validation_failed',
          'Only page and template Documents can be read as Markdown.',
        )
      }
      const rendered = renderDocumentProjectionExport(document, 'markdown')
      return {
        schemaVersion: 1,
        id: document.id,
        kind: document.kind,
        title: document.title,
        revision: document.revision,
        updatedAt: document.updatedAt,
        format: 'markdown',
        content: rendered.content,
      } satisfies PublicDocumentContent
    },
  }
}
