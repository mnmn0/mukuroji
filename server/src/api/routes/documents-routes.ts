import type { Hono } from 'hono'
import { Context } from 'hono'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { DocumentError } from '../../modules/documents'
import {
  registerDocumentApiRoutes,
  type DocumentApiPrincipal,
} from '../../modules/documents/adapter-in/http/document-api'
import { RealtimeTicketError } from '../../modules/realtime'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import {
  createAuthorizedDocumentVersionApproval,
  listAuthorizedDocumentApprovals,
} from '../shared/document-approval-access'
import {
  publishDocumentChange,
  toDocumentApiPrincipal,
  upsertDocumentSearchProjection,
  validateDocumentRelationTargets,
} from '../shared/document-principal'
import { readRealtimeAuthenticationContext } from '../shared/realtime-authentication'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { isWorkspaceSearchProjectionEnabled } from '../shared/search-access'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

async function createDocumentApiPrincipal(
  accessToken: string,
  context: Context,
): Promise<DocumentApiPrincipal> {
  return toDocumentApiPrincipal(await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    context,
  ))
}

/**
 * Registers the documents HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerDocumentsRoutes(routeApp: Hono): void {
  registerDocumentApiRoutes(routeApp, {
    getClient: () => workItemDependencies.documents,
    authenticate: createDocumentApiPrincipal,
    assertPublicShareEntitled: async (workspaceId) => {
      try {
        await enforceActiveTenantForWorkspace(workspaceId)
      } catch (error) {
        if (error instanceof WorkspaceAccessError) {
          throw new DocumentError(error.status, error.code, error.message)
        }
        throw error
      }
    },
    getActiveMember: (workspaceId, memberKey) =>
      workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey),
    validateRelationTargets: validateDocumentRelationTargets,
    upsertSearchDocument: upsertDocumentSearchProjection,
    deleteSearchDocument: async (workspaceId, documentId) => {
      if (!isWorkspaceSearchProjectionEnabled()) return
      await workItemDependencies.workspaceSearch.deleteDocument(workspaceId, 'document', documentId)
    },
    issueRealtimeTicket: async (principal, documentId, context) => {
      const accessToken = readBearerToken(context)
      if (!accessToken) {
        throw new DocumentError(401, 'DocumentAuthenticationRequired', 'Bearer token is required.')
      }
      try {
        return await workItemDependencies.realtimeTickets.createDocumentTicket({
          workspaceId: principal.workspaceId,
          memberKey: principal.memberKey,
          documentId,
          systemAdmin: principal.isSystemAdmin,
          ...await readRealtimeAuthenticationContext(
            accessToken,
            principal.workspaceId,
            context,
          ),
        })
      } catch (error) {
        // A runtime without the WebSocket API is expected; the page keeps polling.
        if (error instanceof RealtimeTicketError && error.code === 'RealtimeUnavailable') {
          return undefined
        }
        throw error
      }
    },
    requestVersionApproval: async (principal, request, context, access) => {
      // The edit permission and pin checked here are re-checked in the approval transaction.
      const documentConditions = await workItemDependencies.documents.prepareVersionApprovalTransactWrite({
        workspaceId: principal.workspaceId,
        documentId: request.documentId,
        versionId: request.versionId,
        access,
      })
      return createAuthorizedDocumentVersionApproval(
        context,
        // The Work Item is authorized as its own approval route would, not through the Document
        // route's scopes, so Work Item access in another Project counts.
        await reauthenticateDocumentPrincipal(
          principal,
          context,
          createWorkItemRouteContext(context, request.teamId, request.issueId, 'approvals'),
        ),
        request,
        documentConditions.conditionChecks,
      )
    },
    listVersionApprovals: async (principal, documentId, context) =>
      listAuthorizedDocumentApprovals(
        await reauthenticateDocumentPrincipal(principal, context),
        documentId,
        // Each Work Item is authorized as its file and approval list route would.
        (teamId, issueId) => reauthenticateDocumentPrincipal(
          principal,
          context,
          createWorkItemRouteContext(context, teamId, issueId, 'files'),
        ),
      ),
    publishChange: publishDocumentChange,
  })
}

/**
 * Builds a request context for one Work Item route from the Document request: the same raw
 * request (bearer token, method, and client address) and environment, at the Work Item path.
 * Enterprise authorization then resolves the Work Item's Team or Project and the permissions of
 * that route, instead of the Document route's scopes.
 *
 * @param context - Document request context.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item ID.
 * @param resource - Work Item sub-route: `approvals` to request one, `files` to read the list.
 * @returns A context whose path is the Work Item route.
 */
function createWorkItemRouteContext(
  context: Context,
  teamId: string,
  issueId: string,
  resource: 'approvals' | 'files',
): Context {
  return new Context(context.req.raw, {
    env: context.env,
    path: `/api/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/${resource}`,
  })
}

/**
 * Resolves the Workspace principal behind an authenticated Document principal, so Work Item
 * authorization runs against the same source of truth as the Work Item routes.
 *
 * @param documentPrincipal - Principal the Document route already authenticated.
 * @param context - Hono request context that carries the bearer token.
 * @param authorizationContext - Route context to evaluate Enterprise permissions for; defaults to
 *   the Document request.
 * @returns The Workspace principal of the same member.
 * @throws DocumentError when the token is missing or resolves to another Workspace member.
 */
async function reauthenticateDocumentPrincipal(
  documentPrincipal: DocumentApiPrincipal,
  context: Context,
  authorizationContext: Context = context,
) {
  const accessToken = readBearerToken(context)
  if (!accessToken) {
    throw new DocumentError(401, 'DocumentAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, authorizationContext)
  if (
    principal.directoryId !== documentPrincipal.workspaceId ||
    principal.userKey !== documentPrincipal.memberKey
  ) {
    throw new DocumentError(403, 'DocumentPrincipalMismatch', 'The request principal changed.')
  }
  return principal
}

/**
 * Reads the bearer access token that the Document route already verified.
 *
 * @param context - Hono request context.
 * @returns The access token, or undefined when the header is missing.
 */
function readBearerToken(context: Context): string | undefined {
  const authorization = context.req.header('Authorization') ?? ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}
