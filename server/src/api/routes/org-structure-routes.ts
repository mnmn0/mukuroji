import type { Context, Hono } from 'hono'
import type { OrgStructureResponse } from '@mukuroji/contracts'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/** Authenticated principal passed to an OrgUnit structure handler. */
type OrgStructurePrincipal = Awaited<ReturnType<typeof authenticateWorkspacePrincipal>>

/**
 * Registers the endpoints that read and replace the OrgUnit structure of a Workspace (#346).
 *
 * Every non-guest member can read the structure, which only names OrgUnits and which Team
 * belongs to which. Replacing it changes which Teams an OrgUnit role reaches, so it needs
 * Workspace administration (`workspace.manage`), never an OrgUnit role.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerOrgStructureRoutes(routeApp: Hono): void {
  /** Reads the OrgUnit tree and Team memberships. */
  routeApp.get('/api/org-structure', async (c) => {
    return await handleOrgStructureRequest(c, async (principal) => {
      if (principal.workspaceRole === 'guest') {
        throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guests cannot read the OrgUnit structure.')
      }
      return {
        orgStructure: await workspaceDependencies.projectDirectory.getOrgStructure(principal.directoryId),
      } satisfies OrgStructureResponse
    })
  })

  /** Replaces the whole OrgUnit tree and Team memberships with compare-and-swap. */
  routeApp.put('/api/org-structure', async (c) => {
    return await handleOrgStructureRequest(c, async (principal) => {
      requireWorkspaceAdministration(principal)
      const body = await readJson<unknown>(c.req)
      return {
        orgStructure: await workspaceDependencies.projectDirectory.replaceOrgStructure(
          principal.directoryId,
          body,
          createApiMutationContext(c, principal, body ?? {}),
          createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
        ),
      } satisfies OrgStructureResponse
    })
  })
}

/**
 * Expected OrgUnit structure failures, answered with their status and stable code.
 */
const orgStructureErrorStatuses: Partial<Record<string, 400 | 403 | 409 | 503>> = {
  InvalidOrgStructure: 400,
  InvalidProjectWrite: 400,
  DirectoryAuthorizationChanged: 403,
  IdempotencyKeyConflict: 409,
  OrgStructureConflict: 409,
  OrgStructureTeamNotFound: 409,
  OrgStructureUnavailable: 503,
}

/**
 * Authenticates the caller, runs the handler, and maps failures to responses.
 *
 * @param c - Hono request context.
 * @param handler - Work to run for the authenticated principal.
 * @returns The JSON response.
 */
async function handleOrgStructureRequest(
  c: Context,
  handler: (principal: OrgStructurePrincipal) => Promise<object>,
) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return c.json(await handler(principal))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }
    if (error instanceof ProjectDataError) {
      const status = orgStructureErrorStatuses[error.code]
      if (status !== undefined) {
        return c.json({ code: error.code, message: error.message }, status)
      }
    }
    return toProjectDataErrorResponse(c, error)
  }
}
