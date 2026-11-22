import type { Context, Hono } from 'hono'
import type {
  TeamWorkItemKeyPrefixSettings,
  UpdateTeamWorkItemKeyPrefixRequest,
} from '@mukuroji/contracts'
import { createMutationAuditEventPut, getConfiguredAuditTableName } from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import {
  createWorkItemKeyPrefixCandidates,
  isWorkItemKeyPrefix,
  type TeamWorkItemKeyPrefixState,
} from '../../modules/work-items'
import { workItemDependencies } from '../shared/app-dependencies'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { createRequestMutationContext, readBearerAccessToken, readJson } from '../shared/http'
import { readRequiredRouteId } from '../shared/input-parsing'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canWorkspaceBusinessWrite,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  resolveEnterpriseAuditActorKind,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/** Path of a Team's Work Item key prefix setting. */
const TEAM_WORK_ITEM_KEY_PREFIX_PATH = '/api/teams/:teamId/work-item-key-prefix'

/**
 * Registers the routes that read and change the key prefix of a Team's new Work Items.
 *
 * Any Team viewer reads the setting; only a Team manager with Workspace write access changes it.
 * The body is validated only after the caller is authorized.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerWorkItemKeyPrefixRoutes(routeApp: Hono): void {
  routeApp.get(TEAM_WORK_ITEM_KEY_PREFIX_PATH, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const teamId = readRequiredRouteId(c.req.param('teamId'), 'Team ID')
      await requireTeamPermission(principal, teamId, 'viewer')
      const [state, canManage] = await Promise.all([
        workItemDependencies.teamIssues.getTeamWorkItemKeyPrefix(principal.directoryId, teamId),
        canManageTeam(principal, teamId),
      ])
      return c.json(toResponse(teamId, state, canManage))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  routeApp.put(TEAM_WORK_ITEM_KEY_PREFIX_PATH, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const teamId = readRequiredRouteId(c.req.param('teamId'), 'Team ID')
      requireWorkspaceBusinessWrite(principal)
      await requireTeamPermission(principal, teamId, 'manager')
      const body = await readJson(c.req)
      const request = readUpdateRequest(body)
      const before = await workItemDependencies.teamIssues.getTeamWorkItemKeyPrefix(principal.directoryId, teamId)
      const auditPut = createKeyPrefixAuditPut(c, principal, teamId, before.keyPrefix, request.keyPrefix, body)
      const saved = await workItemDependencies.teamIssues.changeTeamWorkItemKeyPrefix({
        directoryId: principal.directoryId,
        teamId,
        keyPrefix: request.keyPrefix,
        expectedKeyPrefix: request.expectedKeyPrefix,
        now: new Date().toISOString(),
        transactItems: [
          // Fences the caller's membership version and Enterprise control revision, so a manager
          // whose access changed after the check cannot save.
          ...createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
          ...(auditPut ? [auditPut] : []),
        ],
      })
      return c.json(toResponse(teamId, saved, true))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })
}

/**
 * Reports whether the principal may change the Team's prefix, without throwing.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team ID.
 * @returns Whether the principal manages the Team and may write Workspace business data.
 */
async function canManageTeam(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  try {
    await requireTeamPermission(principal, teamId, 'manager')
    return true
  } catch {
    return false
  }
}

/**
 * Builds the response body from a Team's prefix state.
 *
 * @param teamId - Team ID.
 * @param state - Stored prefix state.
 * @param canManage - Whether the caller may change the prefix.
 * @returns The settings response.
 */
function toResponse(
  teamId: string,
  state: TeamWorkItemKeyPrefixState,
  canManage: boolean,
): TeamWorkItemKeyPrefixSettings {
  return {
    teamId,
    ...(state.keyPrefix
      ? { keyPrefix: state.keyPrefix }
      : { suggestedKeyPrefix: createWorkItemKeyPrefixCandidates(teamId, 1)[0] }),
    previousPrefixes: state.previousPrefixes,
    lastNumber: state.lastNumber,
    canManage,
  }
}

/**
 * Validates the `PUT` body.
 *
 * @param value - Untrusted request body.
 * @returns The uppercase new prefix and the expected current prefix.
 * @throws ProjectDataError (400) for an invalid body.
 */
function readUpdateRequest(value: unknown): UpdateTeamWorkItemKeyPrefixRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectDataError(400, 'InvalidWorkItemKeyPrefix', 'Request body must be an object.')
  }
  const rawPrefix: unknown = Reflect.get(value, 'keyPrefix')
  const keyPrefix = typeof rawPrefix === 'string' ? rawPrefix.trim().toUpperCase() : undefined
  if (!isWorkItemKeyPrefix(keyPrefix)) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemKeyPrefix',
      'A key prefix is 2 to 10 letters or digits that start with a letter.',
    )
  }
  const expectedKeyPrefix: unknown = Reflect.get(value, 'expectedKeyPrefix')
  if (expectedKeyPrefix !== null && !isWorkItemKeyPrefix(expectedKeyPrefix)) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemKeyPrefix',
      'Expected key prefix must be the loaded prefix or null.',
    )
  }
  return { keyPrefix, expectedKeyPrefix }
}

/**
 * Builds the audit put written in the prefix change transaction.
 *
 * @param c - Request context.
 * @param principal - Team manager.
 * @param teamId - Team ID.
 * @param before - Prefix before the change, if any.
 * @param after - New prefix.
 * @param body - Request body as received, for the audit request digest.
 * @returns The transactional audit put, or undefined when auditing is not configured.
 */
function createKeyPrefixAuditPut(
  c: Context,
  principal: WorkspacePrincipal,
  teamId: string,
  before: string | undefined,
  after: string,
  body: unknown,
) {
  return createMutationAuditEventPut(
    getConfiguredAuditTableName(),
    createRequestMutationContext(
      c,
      principal.directoryId,
      principal.actorId,
      principal.userKey,
      body,
      undefined,
      // Service accounts and break-glass principals keep their Enterprise actor in the audit.
      resolveEnterpriseAuditActorKind(principal),
      principal.enterpriseBreakGlassActivationId,
    ),
    {
      directoryId: principal.directoryId,
      eventType: 'work-item-key-prefix.updated',
      entityType: 'work-item-key-prefix',
      entityId: `team/${teamId}/work-item-key-prefix`,
      action: 'updated',
      summary: 'Team Work Item key prefix was changed.',
      changes: [{ field: 'keyPrefix', before: before ?? '', after }],
      metadata: { adapter: 'work-item-key-prefix', teamId },
    },
  )
}
