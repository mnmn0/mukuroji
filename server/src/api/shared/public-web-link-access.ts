import { createMutationAuditContext } from '../../modules/audit/audit'
import type { AuthenticatedDeveloperCredential, IdempotencyMutationToken } from '../../modules/developer-platform/application/ports'
import type {
  PublicMutationContext,
  PublicWorkItemWebLinkService,
} from '../../modules/developer-platform/public-api'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import type { WorkspacePrincipal } from './project-access'
import { createWorkItemIdempotencyTransaction } from './work-item-access'
import {
  authorizeWorkItemWebLinkChange,
  createWorkItemWebLink,
  deleteWorkItemWebLink,
  listWorkItemWebLinks,
  type WorkItemWebLinkCoWrites,
} from './work-item-web-link-access'

/**
 * Builds the audit context of a Public API link change.
 *
 * @param principal - Credential owner.
 * @param context - Request, correlation, and idempotency identifiers.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param body - Request fields recorded with the audit event; never the URL or title.
 * @returns The audit context.
 */
function createWebLinkAudit(
  principal: WorkspacePrincipal,
  context: PublicMutationContext,
  method: string,
  path: string,
  body: Record<string, string>,
) {
  return createMutationAuditContext({
    workspaceId: principal.directoryId,
    actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
    idempotencyKey: context.idempotencyKey,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request: { method, path, body },
    source: { kind: 'api', requestId: context.requestId, method, route: path },
  })
}

/**
 * Builds the idempotency receipt committed with a link change, so a retry after a lost response
 * replays it instead of adding the link again or failing as a missing link.
 *
 * @param principal - Credential owner.
 * @param status - Response status the receipt replays.
 * @param idempotency - Idempotency token of the request, if any.
 * @returns The receipt builder.
 */
function createReceiptWrites(
  principal: WorkspacePrincipal,
  status: 200 | 201,
  idempotency: IdempotencyMutationToken | undefined,
): WorkItemWebLinkCoWrites {
  const transaction = createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
  return async (response) => {
    const receipt = await transaction?.prepare({ status, body: response })
    return receipt ? [receipt.transactWriteItem] : []
  }
}

/**
 * Resolves the credential owner with current permissions for a Work Item permission.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param permission - Work Item permission the call needs.
 * @returns The owner.
 */
function resolveOwner(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  permission: 'work-items.read' | 'work-items.write',
) {
  return resolveDeveloperCredentialPrincipal(credential, { permission, teamId, evaluateProjectScopes: true })
}

/**
 * Creates the Public API adapter of Work Item web links on top of the shared link access.
 *
 * @returns The web link service.
 */
export function createCanonicalPublicWebLinkService(): PublicWorkItemWebLinkService {
  return {
    async listWebLinks(credential, teamId, workItemId) {
      return listWorkItemWebLinks(await resolveOwner(credential, teamId, 'work-items.read'), teamId, workItemId)
    },
    async authorizeWebLinkChange(credential, teamId, workItemId) {
      await authorizeWorkItemWebLinkChange(await resolveOwner(credential, teamId, 'work-items.write'), teamId, workItemId)
    },
    async createWebLink(credential, teamId, workItemId, input, context, idempotency) {
      const principal = await resolveOwner(credential, teamId, 'work-items.write')
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/web-links`
      return createWorkItemWebLink(
        principal,
        teamId,
        workItemId,
        input,
        createWebLinkAudit(principal, context, 'POST', path, { teamId }),
        createReceiptWrites(principal, 201, idempotency),
      )
    },
    async deleteWebLink(credential, teamId, workItemId, linkId, context, idempotency) {
      const principal = await resolveOwner(credential, teamId, 'work-items.write')
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/web-links/${encodeURIComponent(linkId)}`
      return deleteWorkItemWebLink(
        principal,
        teamId,
        workItemId,
        linkId,
        createWebLinkAudit(principal, context, 'DELETE', path, { teamId, linkId }),
        createReceiptWrites(principal, 200, idempotency),
      )
    },
  }
}
