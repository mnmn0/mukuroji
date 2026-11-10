import type { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createTenantAdministrationRouter,
} from '../../modules/tenant-administration/adapter-in/http/tenant-administration-router'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { CognitoServiceError } from '../../modules/authentication'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workspaceDependencies } from '../shared/app-dependencies'
import { readJson, toAuthErrorResponse } from '../shared/http'
import { requireWorkspaceAdministration } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

function toTenantAdministrationErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof TenantAdministrationError)) {
    console.error(error)
    return c.json({ message: 'Tenant administration is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Registers the tenant administration HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerTenantAdministrationRoutes(routeApp: Hono): void {
  routeApp.route('/', createTenantAdministrationRouter({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    requireAdministration: requireWorkspaceAdministration,
    get client() {
      return workspaceDependencies.tenantAdministration
    },
    get tenantExportDownload() {
      return workspaceDependencies.tenantExportDownload
    },
    async resolveInitialization(principal) {
      const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(
        principal.directoryId,
      )
      const owner = activeMembers.find((member) => member.role === 'owner')
      if (!owner) {
        throw new TenantAdministrationError(
          503,
          'TenantOwnerUnavailable',
          'The Workspace owner required for tenant initialization is unavailable.',
        )
      }
      return {
        ownerMemberKey: owner.memberKey,
      }
    },
    readJson,
    mapError: (context, error) => {
      if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(context, error)
      }
      return toTenantAdministrationErrorResponse(context, error)
    },
  }))
}
