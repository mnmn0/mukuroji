import type { Hono } from 'hono'
import type { Context } from 'hono'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { CognitoServiceError } from '../../modules/authentication'
import { type MutationAuditContext } from '../../modules/audit/audit'
import {
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceInvitation,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../../modules/workspace-access/workspace-access'
import {
  requirePrivateDocumentManagerContinuity,
} from '../../modules/workspace-access/document-manager-lifecycle'
import {
  authenticationDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { requireEnterpriseExternalAccessAllowed } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import { requireWorkspaceMemberHasNoOwnedPlanningEntities } from '../shared/planning-access'
import {
  createWorkspaceMutationContext,
  requireWorkspaceAdministration,
  requireWorkspaceMemberHasNoManagedProjects,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { readWorkspaceEmail, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Workspace invitation 作成 API の request body です。 */
type CreateWorkspaceInvitationRequestBody = {
  /** 招待先メールアドレスです。 */
  email?: unknown
  /** 招待対象の表示名です。 */
  name?: unknown
  /** 招待受諾後に付与する Workspace role です。 */
  role?: unknown
}

/** Workspace member 更新 API の request body です。 */
type UpdateWorkspaceAccessMemberRequestBody = {
  /** 更新後の Workspace role です。 */
  role?: unknown
  /** 更新後の member status です。 */
  status?: unknown
  /** optimistic locking に使う current version です。 */
  expectedVersion?: unknown
}

/** 手動 Cognito cleanup 完了確認 API の request body です。 */
type AcknowledgeWorkspaceInvitationCleanupRequestBody = {
  /** optimistic locking に使う current invitation version です。 */
  expectedVersion?: unknown
}

function readOptionalWorkspaceName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Resolves the tenant-owned invitation default from authoritative Workspace state.
 *
 * @param principal - Current active Workspace administrator.
 * @returns The member or guest role configured by tenant administration.
 */
async function resolveTenantDefaultInvitationRole(
  principal: WorkspacePrincipal,
): Promise<'member' | 'guest'> {
  try {
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
    const snapshot = await workspaceDependencies.tenantAdministration.ensureSnapshot(
      principal.directoryId,
      owner.memberKey,
    )
    return snapshot.profile.defaultPolicy.defaultMemberRole
  } catch (error) {
    if (error instanceof TenantAdministrationError) {
      throw new WorkspaceAccessError(
        error.status,
        error.code,
        error.message,
        { cause: error },
      )
    }
    throw error
  }
}

function readWorkspaceRole(value: unknown): WorkspaceRole {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'guest') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceRole', 'Workspace role is invalid.')
}

function readWorkspaceMemberStatus(value: unknown): WorkspaceMemberStatus {
  if (value === 'active' || value === 'deactivated') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceMemberStatus', 'Workspace member status is invalid.')
}

function readWorkspaceVersion(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceVersion', 'Workspace member version is required.')
  }

  return value
}

async function handleWorkspaceInvitationDeliveryAction(
  c: Context,
  action: 'resend' | 'reinvite',
) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { action, invitationId },
    )
    const preparedInvitation = action === 'resend'
      ? await workspaceDependencies.workspaceAccess.prepareResend(
          principal.directoryId,
          principal.userKey,
          invitationId,
          undefined,
          auditContext,
        )
      : await workspaceDependencies.workspaceAccess.prepareReinvite(
          principal.directoryId,
          principal.userKey,
          invitationId,
          undefined,
          auditContext,
        )

    const deliveryState = { invitation: preparedInvitation }

    try {
      const result = await deliverPreparedWorkspaceInvitation(
        principal.directoryId,
        deliveryState,
        action === 'resend' || preparedInvitation.identityOwnership !== 'ambiguous',
        auditContext,
      )
      deliveryState.invitation = {
        ...deliveryState.invitation,
        identityOwnership: result.identityOwnership,
        cognitoIdentityId: result.cognitoIdentityId,
        cognitoUsername: result.cognitoUsername,
        directoryClaimCleanupRequired: result.directoryClaimCleanupRequired || undefined,
      }
      const invitation = await workspaceDependencies.workspaceAccess.markInvitationDelivery(
        principal.directoryId,
        deliveryState.invitation.id,
        {
          expectedVersion: deliveryState.invitation.version,
          identityOwnership: result.identityOwnership,
          cognitoIdentityId: result.cognitoIdentityId,
          cognitoUsername: result.cognitoUsername,
          directoryClaimCleanupRequired: result.directoryClaimCleanupRequired,
          deliveryStatus: result.deliveryStatus,
        },
        auditContext,
      )

      return c.json({ invitation })
    } catch (error) {
      await markWorkspaceInvitationFailure(
        principal.directoryId,
        deliveryState.invitation,
        error,
        auditContext,
      )
      throw error
    }
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
}

async function deliverPreparedWorkspaceInvitation(
  directoryId: string,
  state: { invitation: WorkspaceInvitation },
  preserveIdentityOwnership = false,
  auditContext?: MutationAuditContext,
) {
  const existingUser = await authenticationDependencies.cognito.findWorkspaceUser(state.invitation.email)
  const previousCognitoIdentityId = state.invitation.cognitoIdentityId
  state.invitation = await workspaceDependencies.workspaceAccess.markInvitationIdentityMutationStarted(
    directoryId,
    state.invitation.id,
    state.invitation.version,
    existingUser?.identityId,
    existingUser?.profile.username,
    auditContext,
  )
  const markDirectoryClaimCleanupRequired = async (
    cognitoIdentityId: string,
    cognitoUsername: string,
  ) => {
    state.invitation = await workspaceDependencies.workspaceAccess.markInvitationDirectoryClaimCleanupRequired(
      directoryId,
      state.invitation.id,
      state.invitation.version,
      cognitoIdentityId,
      cognitoUsername,
      auditContext,
    )
  }

  if (existingUser?.profile.status === 'FORCE_CHANGE_PASSWORD') {
    const result = await authenticationDependencies.cognito.provisionWorkspaceUser({
      directoryId,
      email: state.invitation.email,
      name: state.invitation.name,
      existingUser,
      beforeDirectoryClaimUpdate: markDirectoryClaimCleanupRequired,
    })
    await authenticationDependencies.cognito.resendWorkspaceUserInvitation(existingUser.profile.username)
    const preservesInvitationIdentity = preserveIdentityOwnership &&
      previousCognitoIdentityId !== undefined &&
      previousCognitoIdentityId === result.cognitoIdentityId

    return {
      identityOwnership: preservesInvitationIdentity
        ? state.invitation.identityOwnership
        : result.identityOwnership,
      cognitoIdentityId: result.cognitoIdentityId,
      cognitoUsername: result.cognitoUsername,
      directoryClaimCleanupRequired: result.directoryClaimCleanupRequired ||
        (preservesInvitationIdentity && state.invitation.directoryClaimCleanupRequired === true),
      deliveryStatus: 'sent' as const,
    }
  }

  const result = await authenticationDependencies.cognito.provisionWorkspaceUser({
    directoryId,
    email: state.invitation.email,
    name: state.invitation.name,
    existingUser,
    beforeDirectoryClaimUpdate: markDirectoryClaimCleanupRequired,
  })
  const preservesInvitationIdentity = preserveIdentityOwnership &&
    previousCognitoIdentityId !== undefined &&
    previousCognitoIdentityId === result.cognitoIdentityId

  return {
    identityOwnership: preservesInvitationIdentity
      ? state.invitation.identityOwnership
      : result.identityOwnership,
    cognitoIdentityId: result.cognitoIdentityId,
    cognitoUsername: result.cognitoUsername,
    directoryClaimCleanupRequired: result.directoryClaimCleanupRequired ||
      (preservesInvitationIdentity && state.invitation.directoryClaimCleanupRequired === true),
    deliveryStatus: result.deliveryStatus,
  }
}

async function markWorkspaceInvitationFailure(
  directoryId: string,
  invitation: WorkspaceInvitation,
  error: unknown,
  auditContext?: MutationAuditContext,
) {
  console.error('Workspace invitation delivery failed:', error)

  try {
    await workspaceDependencies.workspaceAccess.markInvitationDelivery(directoryId, invitation.id, {
      expectedVersion: invitation.version,
      identityOwnership: invitation.identityOwnership,
      cognitoIdentityId: invitation.cognitoIdentityId,
      cognitoUsername: invitation.cognitoUsername,
      directoryClaimCleanupRequired: invitation.directoryClaimCleanupRequired,
      deliveryStatus: 'failed',
      failureMessage: 'Invitation delivery failed.',
    }, auditContext)
  } catch (markError) {
    console.error('Failed to persist Workspace invitation delivery failure:', markError)
  }
}

/**
 * Registers the workspace HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerWorkspaceRoutes(routeApp: Hono): void {
  /** Workspace member、invitation、capability の snapshot を返す endpoint です。 */
  routeApp.get('/api/workspace/access', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await workspaceDependencies.workspaceAccess.getAccessSnapshot(principal.directoryId, principal.userKey))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** Workspace invitation を reservation して Cognito provisioning を開始する endpoint です。 */
  routeApp.post('/api/workspace/invitations', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const body = await readJson<CreateWorkspaceInvitationRequestBody>(c.req)
      const email = readWorkspaceEmail(body?.email)
      const role = body?.role === undefined
        ? await resolveTenantDefaultInvitationRole(principal)
        : readWorkspaceRole(body.role)
      const name = readOptionalWorkspaceName(body?.name)
      const enterpriseSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      requireEnterpriseExternalAccessAllowed(enterpriseSnapshot, email, role)
      const auditContext = createWorkspaceMutationContext(c, principal, { email, name, role })
      const invitation = await workspaceDependencies.workspaceAccess.createInvitation(
        principal.directoryId,
        principal.userKey,
        {
          email,
          name,
          role,
        },
        undefined,
        auditContext,
      )

      const deliveryState = { invitation }

      try {
        const result = await deliverPreparedWorkspaceInvitation(
          principal.directoryId,
          deliveryState,
          false,
          auditContext,
        )
        deliveryState.invitation = {
          ...deliveryState.invitation,
          identityOwnership: result.identityOwnership,
          cognitoIdentityId: result.cognitoIdentityId,
          cognitoUsername: result.cognitoUsername,
          directoryClaimCleanupRequired: result.directoryClaimCleanupRequired || undefined,
        }
        const deliveredInvitation = await workspaceDependencies.workspaceAccess.markInvitationDelivery(
          principal.directoryId,
          deliveryState.invitation.id,
          {
            expectedVersion: deliveryState.invitation.version,
            identityOwnership: result.identityOwnership,
            cognitoIdentityId: result.cognitoIdentityId,
            cognitoUsername: result.cognitoUsername,
            directoryClaimCleanupRequired: result.directoryClaimCleanupRequired,
            deliveryStatus: result.deliveryStatus,
          },
          auditContext,
        )

        return c.json({ invitation: deliveredInvitation }, 201)
      } catch (error) {
        await markWorkspaceInvitationFailure(
          principal.directoryId,
          deliveryState.invitation,
          error,
          auditContext,
        )
        throw error
      }
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** Workspace invitation を再送する endpoint です。 */
  routeApp.post('/api/workspace/invitations/:invitationId/resend', async (c) => {
    return handleWorkspaceInvitationDeliveryAction(c, 'resend')
  })

  /** Workspace invitation を取り消す endpoint です。 */
  routeApp.post('/api/workspace/invitations/:invitationId/revoke', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
      const auditContext = createWorkspaceMutationContext(c, principal, { invitationId })
      let invitation = await workspaceDependencies.workspaceAccess.revokeInvitation(
        principal.directoryId,
        principal.userKey,
        invitationId,
        auditContext,
      )

      if (
        !invitation.identityCleanupCompleted &&
        (
          invitation.identityCleanupManualRequired === true ||
          isWorkspaceIdentitySafeToDelete(invitation.identityOwnership) ||
          invitation.directoryClaimCleanupRequired === true
        )
      ) {
        const cognitoIdentityId = invitation.cognitoIdentityId?.trim()
        const cognitoUsername = invitation.cognitoUsername?.trim()
        let cleanupCompleted = false
        let manualCleanupRequired = false

        try {
          if (cognitoIdentityId && cognitoUsername) {
            const cleanupInput = {
              userId: invitation.email,
              directoryId: principal.directoryId,
              cognitoIdentityId,
              cognitoUsername,
            }

            if (isWorkspaceIdentitySafeToDelete(invitation.identityOwnership)) {
              const deletionResult = await authenticationDependencies.cognito.deleteWorkspaceUser(cleanupInput)

              if (deletionResult === 'manual-required') {
                manualCleanupRequired = true
              } else if (deletionResult === 'preserved') {
                manualCleanupRequired = await authenticationDependencies.cognito.unlinkWorkspaceUser(cleanupInput) ===
                  'manual-required'
              }
            } else {
              manualCleanupRequired = await authenticationDependencies.cognito.unlinkWorkspaceUser(cleanupInput) ===
                'manual-required'
            }
            cleanupCompleted = !manualCleanupRequired
          } else {
            manualCleanupRequired = true
          }
        } catch (error) {
          try {
            await workspaceDependencies.workspaceAccess.markInvitationCleanupFailure(
              principal.directoryId,
              invitation.id,
              {
                expectedVersion: invitation.version,
                failureMessage: 'Cognito cleanup failed and can be retried safely.',
              },
              auditContext,
            )
          } catch (markError) {
            console.error('Failed to persist Workspace invitation cleanup failure:', markError)
          }

          throw error
        }

        if (manualCleanupRequired) {
          invitation = await workspaceDependencies.workspaceAccess.markInvitationManualCleanupRequired(
            principal.directoryId,
            invitation.id,
            invitation.version,
            auditContext,
          )
        } else if (cleanupCompleted) {
          invitation = await workspaceDependencies.workspaceAccess.clearInvitationCleanupFailure(
            principal.directoryId,
            invitation.id,
            invitation.version,
            auditContext,
          )
        }
      }

      return c.json({ invitation })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** 手動 Cognito cleanup の完了を管理者が明示確認する endpoint です。 */
  routeApp.post('/api/workspace/invitations/:invitationId/cleanup/acknowledge', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
      const body = await readJson<AcknowledgeWorkspaceInvitationCleanupRequestBody>(c.req)
      const expectedVersion = readWorkspaceVersion(body?.expectedVersion)
      const auditContext = createWorkspaceMutationContext(
        c,
        principal,
        { expectedVersion, invitationId },
      )
      const invitation = await workspaceDependencies.workspaceAccess.acknowledgeInvitationManualCleanup(
        principal.directoryId,
        principal.userKey,
        invitationId,
        expectedVersion,
        auditContext,
      )

      return c.json({ invitation })
    } catch (error) {
      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** revoked / expired Workspace invitation を再招待する endpoint です。 */
  routeApp.post('/api/workspace/invitations/:invitationId/reinvite', async (c) => {
    return handleWorkspaceInvitationDeliveryAction(c, 'reinvite')
  })

  /** Workspace member の role または status を version 条件付きで更新する endpoint です。 */
  routeApp.patch('/api/workspace/members/:memberKey', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
      const body = await readJson<UpdateWorkspaceAccessMemberRequestBody>(c.req)
      const role = body?.role === undefined ? undefined : readWorkspaceRole(body.role)
      const status = body?.status === undefined ? undefined : readWorkspaceMemberStatus(body.status)
      const expectedVersion = readWorkspaceVersion(body?.expectedVersion)
      if (role) {
        const existingMember = await workspaceDependencies.workspaceAccess.getMember(
          principal.directoryId,
          memberKey,
        )
        if (!existingMember) {
          throw new WorkspaceAccessError(
            404,
            'WorkspaceMemberNotFound',
            'Workspace member was not found.',
          )
        }
        requireEnterpriseExternalAccessAllowed(
          await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
          existingMember.email,
          role,
        )
      }
      const auditContext = createWorkspaceMutationContext(
        c,
        principal,
        { expectedVersion, memberKey, role, status },
      )

      let expectedPlanningRevision: number
      if (status === 'deactivated') {
        await requireWorkspaceMemberHasNoManagedProjects(principal.directoryId, memberKey)
        expectedPlanningRevision = await requireWorkspaceMemberHasNoOwnedPlanningEntities(
          principal.directoryId,
          memberKey,
        )
      } else {
        expectedPlanningRevision = (await workItemDependencies.planning.getAuthorizationState(principal.directoryId)).revision
      }
      const expectedDocumentAuthorizationRevision =
        status === 'deactivated' || role === 'guest'
          ? await requirePrivateDocumentManagerContinuity(
              {
                documents: workItemDependencies.documents,
                workspaceAccess: workspaceDependencies.workspaceAccess,
              },
              principal.directoryId,
              memberKey,
            )
          : undefined

      const member = await workspaceDependencies.workspaceAccess.updateMember(
        principal.directoryId,
        principal.userKey,
        memberKey,
        {
          role,
          status,
          expectedVersion,
          expectedPlanningRevision,
          ...(expectedDocumentAuthorizationRevision === undefined
            ? {}
            : {
                expectedDocumentAuthorizationRevision,
              }),
        },
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
