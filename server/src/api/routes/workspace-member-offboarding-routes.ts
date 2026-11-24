import type {
  WorkspaceMemberOffboarding,
  WorkspaceMemberOffboardingCredential,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  listMemberActiveCredentials,
  revokeMemberCredentials,
} from '../../modules/developer-platform'
import {
  WorkspaceAccessError,
  isMemberAccessExpired,
  readMemberAccessExpiry,
  requirePrivateDocumentManagerContinuity,
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
 * Reports whether deactivating a member would leave a private Document without a manager.
 *
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member being offboarded.
 * @returns True when a private Document still needs another manager.
 */
async function readManagesPrivateDocuments(workspaceId: string, memberKey: string) {
  try {
    await requirePrivateDocumentManagerContinuity(
      {
        documents: workItemDependencies.documents,
        workspaceAccess: workspaceDependencies.workspaceAccess,
      },
      workspaceId,
      memberKey,
    )
    return false
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.code === 'WorkspaceMemberManagesPrivateDocuments') {
      return true
    }
    throw error
  }
}

/**
 * Collects everything that needs a handover before a member is deactivated.
 *
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member being offboarded.
 * @returns The offboarding summary.
 * @throws WorkspaceAccessError 404 when the member does not exist.
 */
async function readMemberOffboarding(
  workspaceId: string,
  memberKey: string,
): Promise<WorkspaceMemberOffboarding> {
  const member = await workspaceDependencies.workspaceAccess.getMember(workspaceId, memberKey)
  if (!member) {
    throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
  }
  const [accesses, directory, planning, managesPrivateDocuments, credentials, webhooks] =
    await Promise.all([
      workspaceDependencies.projectDirectory.getProjectAccessList(workspaceId, member.memberKey),
      workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja', true),
      // Titles are read without Work Items: only the entities the member owns are shown.
      workItemDependencies.planning.get(workspaceId, { workItems: [] }),
      readManagesPrivateDocuments(workspaceId, member.memberKey),
      listMemberActiveCredentials(developerPlatformDependencies, workspaceId, member.memberKey),
      developerPlatformDependencies.webhookSubscriptions.listWebhookSubscriptions(workspaceId),
    ])
  const managedProjects = accesses
    .filter((access) => access.role === 'manager')
    .map((access) => {
      const team = directory.teams.find((candidate) =>
        (access.teamId === undefined || candidate.id === access.teamId) &&
        candidate.projects.some((project) => project.id === access.projectId)
      )
      const name = team?.projects.find((project) => project.id === access.projectId)?.name
      const teamId = access.teamId ?? team?.id
      return {
        ...(teamId === undefined ? {} : { teamId }),
        projectId: access.projectId,
        ...(name === undefined ? {} : { name }),
      }
    })
  const credentialRows: WorkspaceMemberOffboardingCredential[] = [
    ...credentials.apiKeys.map((apiKey): WorkspaceMemberOffboardingCredential => ({
      id: apiKey.id,
      kind: 'api-key',
      name: apiKey.name,
    })),
    ...credentials.oauthApps.map((oauthApp): WorkspaceMemberOffboardingCredential => ({
      id: oauthApp.id,
      kind: 'oauth-app',
      name: oauthApp.name,
    })),
  ]
  const ownedPlanningEntities = planning.entities
    .filter((entity) => !entity.archivedAt && entity.ownerMemberKey === member.memberKey)
    .map((entity) => ({ id: entity.id, type: entity.type, title: entity.title }))
  return {
    memberKey: member.memberKey,
    ...(member.accessExpiresAt === undefined ? {} : { accessExpiresAt: member.accessExpiresAt }),
    accessExpired: isMemberAccessExpired(member, new Date()),
    managedProjects,
    ownedPlanningEntities,
    planningRevision: planning.revision,
    managesPrivateDocuments,
    credentials: credentialRows,
    webhooks: webhooks
      .filter((webhook) => webhook.status === 'active' && webhook.createdByUserId === member.memberKey)
      .map((webhook) => ({ id: webhook.id, name: webhook.name })),
    canDeactivate: member.status === 'active' &&
      managedProjects.length === 0 &&
      ownedPlanningEntities.length === 0 &&
      !managesPrivateDocuments,
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
      return c.json(await readMemberOffboarding(principal.directoryId, memberKey))
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
   * it when the deactivation succeeded but the revocation did not.
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
      const member = await workspaceDependencies.workspaceAccess.getMember(principal.directoryId, memberKey)
      if (!member) {
        throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
      }
      return c.json(await revokeMemberCredentials(
        developerPlatformDependencies,
        principal.directoryId,
        member.memberKey,
        principal.userKey,
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
