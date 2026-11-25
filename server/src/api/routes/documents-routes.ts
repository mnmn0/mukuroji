import { type DocumentRelationTarget } from '@mukuroji/contracts'
import type { Hono } from 'hono'
import { Context } from 'hono'
import { isTeamIssueNotFoundError, type TeamIssueDetailResponse } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createDocumentWorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import { DocumentError, type DocumentAuthorizationFenceSnapshot } from '../../modules/documents'
import {
  registerDocumentApiRoutes,
  type DocumentApiPrincipal,
} from '../../modules/documents/adapter-in/http/document-api'
import {
  createDocumentRealtimeScopeKey,
  publishRealtimeScopeSignal,
  RealtimeTicketError,
} from '../../modules/realtime'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import {
  createAuthorizedDocumentVersionApproval,
  listAuthorizedDocumentApprovals,
} from '../shared/document-approval-access'
import { readDocumentAuthorizationSnapshot } from '../shared/document-access'
import { createDocumentEnterpriseScopeBoundary } from '../shared/project-access'
import { readRealtimeAuthenticationContext } from '../shared/realtime-authentication'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  isWorkspaceSearchProjectionEnabled,
  parseSearchWorkItemEntityId,
} from '../shared/search-access'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

/** Relation target の source read を同時実行する最大数です。 */
const DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY = 8

async function createDocumentApiPrincipal(
  accessToken: string,
  context: Context,
): Promise<DocumentApiPrincipal> {
  const principal = await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    context,
  )
  const {
    planningRevision,
    projectRoles,
  } = await readDocumentAuthorizationSnapshot(principal)

  return {
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    displayName:
      principal.workspaceMember.name ??
      principal.workspaceMember.email ??
      principal.userKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    authorizationSnapshots: [{
      workspaceId: principal.directoryId,
      ...(principal.principalKind === 'service-account'
        ? {}
        : {
            workspaceMemberKey: principal.userKey,
            workspaceMemberVersion:
              principal.workspaceMember.version,
          }),
      planningRevision,
      ...(principal.enterprisePermissions === undefined ||
          principal.enterpriseIdentityControlRevision === undefined
        ? {}
        : {
            enterpriseControlRevision:
              principal.enterpriseIdentityControlRevision,
          }),
      ...(principal.enterpriseOrgStructureRevision === undefined
        ? {}
        : { orgStructureRevision: principal.enterpriseOrgStructureRevision }),
    } satisfies DocumentAuthorizationFenceSnapshot],
    projectRoles,
    ...createDocumentEnterpriseScopeBoundary(principal),
  }
}

async function validateDocumentRelationTargets(
  principal: DocumentApiPrincipal,
  targets: readonly DocumentRelationTarget[],
) {
  const [directory, planningAuthorizationState] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.workspaceId,
      'ja',
      true,
    ),
    targets.some((target) => target.kind === 'goal')
      ? workItemDependencies.planning.getAuthorizationState(principal.workspaceId)
      : undefined,
  ])
  for (
    let offset = 0;
    offset < targets.length;
    offset += DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY
  ) {
    await Promise.all(targets.slice(
      offset,
      offset + DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY,
    ).map(async (target) => {
      if (target.kind === 'goal') {
        const entity = planningAuthorizationState?.entities.find(
          (candidate) =>
            candidate.id === target.goalId &&
            candidate.type === 'goal' &&
            candidate.archivedAt === undefined,
        )
        if (!entity) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const team = entity.teamId === undefined
          ? undefined
          : directory.teams.find((candidate) => candidate.id === entity.teamId)
        const projectTeam = entity.projectId === undefined
          ? undefined
          : directory.teams.find((candidate) =>
              (entity.teamId === undefined || candidate.id === entity.teamId) &&
              candidate.projects.some((project) => project.id === entity.projectId)
            )
        if (
          (entity.teamId !== undefined && team === undefined) ||
          (entity.projectId !== undefined && projectTeam === undefined)
        ) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const visible = principal.isSystemAdmin ||
          (entity.projectId !== undefined
            ? principal.projectRoles[entity.projectId] !== undefined
            : team !== undefined
              ? team.projects.some(
                  (project) => principal.projectRoles[project.id] !== undefined,
                )
              : true)
        if (!visible) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Goal is not visible.',
          )
        }
        return
      }
      if (target.kind === 'project') {
        const exists = directory.teams.some((team) =>
          team.projects.some((project) =>
            project.id === target.projectId
          )
        )
        if (!exists) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Project was not found.',
          )
        }
        if (
          !principal.isSystemAdmin &&
          principal.projectRoles[target.projectId] === undefined
        ) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Project is not visible.',
          )
        }
        return
      }
      const parsed = parseSearchWorkItemEntityId(target.workItemId)
      if (!parsed) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'Work Item targets must use team/<teamId>/issue/<issueId>.',
        )
      }
      const team = directory.teams.find(
        (candidate) => candidate.id === parsed.teamId,
      )
      if (!team) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'The related Team was not found.',
        )
      }
      if (
        !principal.isSystemAdmin &&
        !team.projects.some(
          (project) =>
            principal.projectRoles[project.id] !== undefined,
        )
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
      let detail: TeamIssueDetailResponse
      try {
        detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.workspaceId,
          parsed.teamId,
          parsed.issueId,
          { consistentIssueRead: true, includeEvents: false },
        )
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Work Item was not found.',
          )
        }
        throw error
      }
      if (
        detail.issue.assignedProjectId &&
        !principal.isSystemAdmin &&
        principal.projectRoles[
          detail.issue.assignedProjectId
        ] === undefined
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
    }))
  }
  return planningAuthorizationState === undefined
    ? undefined
    : [{
        workspaceId: principal.workspaceId,
        planningRevision: planningAuthorizationState.revision,
      } satisfies DocumentAuthorizationFenceSnapshot]
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
    upsertSearchDocument: async (workspaceId, document) => {
      if (!isWorkspaceSearchProjectionEnabled()) return
      await workItemDependencies.workspaceSearch.upsertDocument(
        createDocumentWorkspaceSearchDocument(workspaceId, document),
      )
    },
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
    publishChange: async (workspaceId, change) => {
      await publishRealtimeScopeSignal(
        createDocumentRealtimeScopeKey(workspaceId, change.documentId),
        {
          type: 'document.changed',
          documentId: change.documentId,
          part: change.part,
          ...(change.originClientId ? { originClientId: change.originClientId } : {}),
          occurredAt: new Date().toISOString(),
        },
      )
    },
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
