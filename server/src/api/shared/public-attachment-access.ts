import { randomUUID } from 'node:crypto'
import type {
  FileAttachment,
  PublicWorkItemAttachment,
  PublicWorkItemAttachmentDownload,
} from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../modules/audit/audit'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicAttachmentService,
} from '../../modules/developer-platform/public-api'
import {
  FileProofingError,
  type FileProofingActor,
  type FileProofingScope,
} from '../../modules/files/file-proofing'
import { WorkspaceAccessError } from '../../modules/workspace-access'
import { workItemDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import { loadAuthorizedTeamIssue } from './work-item-access'

/** Work Item file scope and the read-only file actor of a credential owner. */
type CredentialFileAccess = {
  /** Work Item file scope. */
  scope: FileProofingScope
  /** Read-only actor for the credential owner. */
  actor: FileProofingActor
  /** Canonical actor ID of the credential owner, for the audit log. */
  actorId: string
}

/**
 * Resolves the credential owner's read access to a Work Item's files, evaluating the current
 * Work Item and file permissions on every call exactly as the Work Item file routes do.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The file scope and actor, or undefined when the owner may not read files.
 * @throws PublicApiServiceError or the Work Item access error when the Work Item is not visible.
 */
async function resolveCredentialFileAccess(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  workItemId: string,
): Promise<CredentialFileAccess | undefined> {
  const workItemPrincipal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read', teamId, evaluateProjectScopes: true,
  })
  const { detail } = await loadAuthorizedTeamIssue(workItemPrincipal, teamId, workItemId, 'viewer')
  const projectId = detail.issue.assignedProjectId
  let principal
  try {
    // The file permission is evaluated at the Work Item's own Project, or at its Team when it has none,
    // so a file grant in another Project of the Team never opens these files.
    principal = await resolveDeveloperCredentialPrincipal(credential, {
      permission: 'files.read',
      alternativePermissions: ['files.write'],
      teamId,
      ...(projectId ? { projectId } : {}),
    })
  } catch (error) {
    // Enterprise RBAC that grants no file permission hides every file, like a hidden file.
    if (error instanceof WorkspaceAccessError && error.code === 'WorkspacePermissionDenied') return undefined
    throw error
  }
  return {
    scope: {
      workspaceId: principal.directoryId,
      teamId,
      kind: 'work-item',
      issueId: workItemId,
      ...(projectId ? { projectId } : {}),
    },
    actor: {
      memberKey: principal.userKey,
      guest: principal.workspaceRole === 'guest',
      canWrite: false,
      canManage: false,
    },
    actorId: principal.actorId,
  }
}

/**
 * Projects a file whose current version passed the malware scan; other files are left out.
 *
 * @param file - File the owner can view.
 * @returns The public attachment, or undefined when the current version is not downloadable.
 */
function toPublicAttachment(file: FileAttachment): PublicWorkItemAttachment | undefined {
  const version = file.currentVersion
  if (file.deletedAt !== undefined || version.scanStatus !== 'available') return undefined
  return {
    id: file.id,
    name: file.name,
    versionId: version.id,
    versionNumber: version.number,
    contentType: version.contentType,
    sizeBytes: version.sizeBytes,
    updatedAt: file.updatedAt,
  }
}

/** Error for a file that is missing, hidden, or not downloadable, without telling which. */
function attachmentNotFound(): PublicApiServiceError {
  return new PublicApiServiceError(404, 'not_found', 'Attachment was not found.')
}

/**
 * Creates the read-only Public API service for Work Item attachments. Every call evaluates the
 * credential owner's current permissions, and only versions that passed the malware scan are
 * listed or downloadable.
 *
 * @returns Attachment service backed by the file store.
 */
export function createCanonicalPublicAttachmentService(): PublicAttachmentService {
  return {
    /** Lists the downloadable files attached to a Work Item the owner can view. */
    async listWorkItemAttachments(credential, teamId, workItemId) {
      const access = await resolveCredentialFileAccess(credential, teamId, workItemId)
      if (access === undefined) return { items: [] }
      const collection = await workItemDependencies.fileProofing.list(access.scope, access.actor)
      return {
        items: collection.files.flatMap((file) => {
          const attachment = toPublicAttachment(file)
          return attachment ? [attachment] : []
        }),
      }
    },

    /** Issues a download URL for the current version of a downloadable attachment. */
    async createWorkItemAttachmentDownload(credential, teamId, workItemId, fileId, request) {
      const access = await resolveCredentialFileAccess(credential, teamId, workItemId)
      if (access === undefined) throw attachmentNotFound()
      const collection = await workItemDependencies.fileProofing.list(access.scope, access.actor)
      const file = collection.files.find((candidate) => candidate.id === fileId)
      const attachment = file ? toPublicAttachment(file) : undefined
      if (attachment === undefined) throw attachmentNotFound()
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/attachments/${encodeURIComponent(fileId)}/download`
      const auditContext = createMutationAuditContext({
        workspaceId: access.scope.workspaceId,
        actor: { id: access.actorId, kind: 'user', displayName: access.actor.memberKey },
        // Every issuance is its own audit event: a caller can reuse X-Request-Id, so it is only tracing metadata.
        idempotencyKey: `public-attachment-download:${randomUUID()}`,
        ...(request.correlationId ? { correlationId: request.correlationId } : {}),
        request: { method: 'GET', path, body: null, query: { teamId } },
        source: { kind: 'api', requestId: request.requestId, method: 'GET', route: path },
      })
      try {
        const granted = await workItemDependencies.fileProofing.createAccess(
          access.scope,
          access.actor,
          fileId,
          attachment.versionId,
          'attachment',
          auditContext,
          // Only the current version is offered; a replacement that completed after the listing is a conflict.
          { requireCurrentVersion: true },
        )
        return {
          fileId,
          versionId: attachment.versionId,
          url: granted.url,
          expiresAt: granted.expiresAt,
        } satisfies PublicWorkItemAttachmentDownload
      } catch (error) {
        // The scan can still block the object, or it can be deleted, after the listing read it; neither is downloadable.
        if (error instanceof FileProofingError && (error.status === 403 || error.status === 404 || error.status === 410 || error.status === 423)) {
          throw attachmentNotFound()
        }
        // The file changed after it was read; the client can list the attachments again and retry.
        if (error instanceof FileProofingError && error.status === 409) {
          throw new PublicApiServiceError(409, 'conflict', 'The attachment changed. List the attachments again and retry.')
        }
        throw error
      }
    },
  }
}
