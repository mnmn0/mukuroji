import type { Hono } from 'hono'
import type { UpdateTeamWorkItemKeyPrefixRequest } from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import { isWorkItemKeyPrefix } from '../../modules/work-items'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { createRequestMutationContext, readBearerAccessToken, readJson } from '../shared/http'
import { readRequiredRouteId } from '../shared/input-parsing'
import {
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  resolveEnterpriseAuditActorKind,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { changeTeamWorkItemKeyPrefix, readTeamWorkItemKeyPrefixSettings } from './work-item-key-prefix-service'

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
      return c.json(await readTeamWorkItemKeyPrefixSettings(principal, teamId))
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
      const mutationContext = createRequestMutationContext(
        c,
        principal.directoryId,
        principal.actorId,
        principal.userKey,
        body,
        undefined,
        // Service accounts and break-glass principals keep their Enterprise actor in the audit.
        resolveEnterpriseAuditActorKind(principal),
        principal.enterpriseBreakGlassActivationId,
      )
      return c.json(await changeTeamWorkItemKeyPrefix(principal, teamId, request, mutationContext))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })
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

