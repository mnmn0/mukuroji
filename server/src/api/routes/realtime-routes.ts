import type { Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { createRealtimeTicketRouter } from '../../modules/realtime'
import { createWorkItemCollaborationEntityKey } from '../../modules/collaboration/collaboration'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import {
  type CognitoAccessTokenClaims,
  createEnterpriseAuthenticationSessionId,
  readCognitoAuthenticationMethods,
  resolveEnterpriseClientIp,
  toCognitoDirectoryErrorResponse,
} from '../shared/enterprise-access'
import { readJson } from '../shared/http'
import {
  requireAssignedProjectPermission,
  requireTeamPermission,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { decodeJwtPayload, readNumericClaim } from '../shared/token-claims'
import { canWriteTeamIssue } from '../shared/work-item-access'

/**
 * Registers the realtime HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerRealtimeRoutes(routeApp: Hono): void {
  routeApp.route('/', createRealtimeTicketRouter<WorkspacePrincipal>({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    issueTicket: async ({ accessToken, principal, teamId, issueId, context }) => {
      const permissionContext = await requireTeamPermission(principal, teamId, 'viewer')
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
      requireAssignedProjectPermission(
        principal,
        permissionContext,
        detail.issue.assignedProjectId,
        'viewer',
      )
      const tokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
      const issuedAt = readNumericClaim(tokenClaims?.iat) ?? Math.floor(Date.now() / 1_000)
      const authenticatedAt = readNumericClaim(tokenClaims?.auth_time) ?? issuedAt
      const tokenExpiresAt = readNumericClaim(tokenClaims?.exp) ?? issuedAt + 60 * 60
      const authenticationSessionId = createEnterpriseAuthenticationSessionId(accessToken)
      const verifiedAuthenticationMethods =
        await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
          principal.directoryId,
          authenticationSessionId,
        )

      return await workItemDependencies.realtimeTickets.createTicket({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        teamId,
        issueId,
        projectId: detail.issue.assignedProjectId,
        systemAdmin: principal.isSystemAdmin,
        canWrite: canWriteTeamIssue(
          principal,
          permissionContext,
          detail.issue.assignedProjectId,
        ),
        scopeKey: createWorkItemCollaborationEntityKey(
          principal.directoryId,
          teamId,
          issueId,
        ),
        authenticatedAt,
        tokenExpiresAt,
        authenticationSessionId,
        authenticationMethods: [
          ...new Set([
            ...readCognitoAuthenticationMethods(tokenClaims),
            ...verifiedAuthenticationMethods,
          ]),
        ],
        clientIp: resolveEnterpriseClientIp(context),
      })
    },
    mapError: (context, error) => {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(context, error)
      }

      return toProjectDataErrorResponse(context, error)
    },
    readJson,
  }))
}
