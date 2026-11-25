import type { Hono } from 'hono'
import { createMemberOffboardingPorts } from '../../app/composition/member-offboarding'
import { CognitoServiceError } from '../../modules/authentication'
import { createManagedMemberCredentialRevocationPorts } from '../../app/composition/member-credential-revoker'
import {
  WorkspaceAccessError,
  readMemberAccessExpiry,
  readMemberOffboarding,
  revokeManagedMemberCredentials,
} from '../../modules/workspace-access'
import {
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createWorkspaceMutationContext,
  requireWorkspaceAdministration,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { readWorkspaceEmail, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Access expiry change read from a request body. */
type MemberAccessExpiryChange = {
  /** New expiry; undefined clears it. */
  accessExpiresAt?: string
  /** Member version read before the change. */
  expectedVersion: number
}

/**
 * Reads the body of an access expiry change.
 *
 * @param body - Untrusted parsed request body.
 * @param now - Current instant, which a new expiry must be after.
 * @returns The validated expiry and member version.
 * @throws WorkspaceAccessError 400 when a field is missing or invalid.
 */
function readMemberAccessExpiryChange(body: unknown, now: Date): MemberAccessExpiryChange {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceMemberAccessExpiry', 'A JSON object is required.')
  }
  const fields: Record<string, unknown> = { ...body }
  const expectedVersion = fields.expectedVersion
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceVersion', 'Workspace member version is required.')
  }
  if (!('accessExpiresAt' in fields)) {
    throw new WorkspaceAccessError(
      400,
      'InvalidWorkspaceMemberAccessExpiry',
      'accessExpiresAt is required; send null to clear it.',
    )
  }
  try {
    const accessExpiresAt = readMemberAccessExpiry(fields.accessExpiresAt, now)
    return accessExpiresAt === undefined ? { expectedVersion } : { accessExpiresAt, expectedVersion }
  } catch (error) {
    throw new WorkspaceAccessError(
      400,
      'InvalidWorkspaceMemberAccessExpiry',
      error instanceof RangeError ? error.message : 'Access expiry is invalid.',
      { cause: error },
    )
  }
}

/**
 * Registers the routes that prepare a member's departure: the handover summary and the access
 * expiry.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerWorkspaceMemberOffboardingRoutes(routeApp: Hono): void {
  /** Lists what a member manages, owns, or created, so an administrator can hand it over. */
  routeApp.get('/api/workspace/members/:memberKey/offboarding', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
      c.header('Cache-Control', 'private, no-store')
      return c.json(await readMemberOffboarding(
        createMemberOffboardingPorts({
          workspace: workspaceDependencies,
          workItems: workItemDependencies,
          developerPlatform: developerPlatformDependencies,
        }),
        principal.directoryId,
        memberKey,
      ))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }
      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /**
   * Revokes every API key and OAuth application a member created.
   *
   * Deactivation already does this; the route lets an administrator do it beforehand, or finish
   * it when the deactivation succeeded but the revocation did not. The set revoked is recorded
   * under the request's `Idempotency-Key`, so a replay revokes and returns that same set.
   */
  routeApp.post('/api/workspace/members/:memberKey/credentials/revoke', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
      const auditContext = createWorkspaceMutationContext(c, principal, { memberKey })
      return c.json(await revokeManagedMemberCredentials(
        createManagedMemberCredentialRevocationPorts({
          workspace: workspaceDependencies,
          developerPlatform: developerPlatformDependencies,
        }),
        {
          workspaceId: principal.directoryId,
          actorMemberKey: principal.userKey,
          actorRole: principal.workspaceRole,
          memberKey,
          auditContext,
        },
      ))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }
      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** Sets or clears the time a member's access ends. */
  routeApp.put('/api/workspace/members/:memberKey/access-expiry', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
      const input = readMemberAccessExpiryChange(await readJson<unknown>(c.req), new Date())
      const workspaceAccess = workspaceDependencies.workspaceAccess
      if (!workspaceAccess.updateMemberAccessExpiry) {
        throw new WorkspaceAccessError(
          503,
          'WorkspaceMemberAccessExpiryUnavailable',
          'Access expiry is not available.',
        )
      }
      const auditContext = createWorkspaceMutationContext(c, principal, {
        expectedVersion: input.expectedVersion,
        memberKey,
        accessExpiresAt: input.accessExpiresAt ?? null,
      })
      const member = await workspaceAccess.updateMemberAccessExpiry(
        principal.directoryId,
        principal.userKey,
        memberKey,
        input,
        auditContext,
      )
      return c.json({ member })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }
      return toWorkspaceAccessErrorResponse(c, error)
    }
  })
}
