import {
  WORKSPACE_INVITATION_NAME_MAX_LENGTH,
  isWorkspaceInvitationEmail,
  MEMBER_DISPLAY_NAME_MAX_LENGTH,
  readMemberDisplayName,
  type MemberProfile,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError, readUpdateMemberPreferencesInput } from '../../modules/directory'
import { type MutationAuditContext } from '../../modules/audit/audit'
import {
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceAccessTransactWriteItem,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../../modules/workspace-access/workspace-access'
import {
  requirePrivateDocumentManagerContinuity,
} from '../../modules/workspace-access/document-manager-lifecycle'
import { updateMemberMembership } from '../../modules/workspace-access'
import { createMemberMembershipUpdatePorts } from '../../app/composition/member-membership-update'
import {
  authenticationDependencies,
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { requireEnterpriseExternalAccessAllowed } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import { requireWorkspaceMemberHasNoOwnedPlanningEntities } from '../shared/planning-access'
import {
  createEnterpriseControlRevisionConditionCheck,
  createWorkspaceMutationContext,
  requireWorkspaceAdministration,
  requireWorkspaceMemberHasNoManagedProjects,
  toProjectDataErrorResponse,
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
 * Reads the email address of a new invitation and rejects one that cannot receive an email.
 *
 * Existing invitations keep the looser {@link readWorkspaceEmail} check so that they can still
 * be resent or revoked.
 *
 * @param value - Raw `email` of the request body.
 * @returns The normalized email address.
 */
function readNewWorkspaceInvitationEmail(value: unknown) {
  const email = readWorkspaceEmail(value)
  if (!isWorkspaceInvitationEmail(email)) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceEmail', 'A valid email address is required.')
  }
  return email
}

/**
 * Reads the optional display name of a new invitation.
 *
 * @param value - Raw `name` of the request body.
 * @returns The trimmed name, or `undefined` when it is missing or blank.
 */
function readNewWorkspaceInvitationName(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceInvitationName', 'Invitation name must be a string.')
  }
  const name = readOptionalWorkspaceName(value)
  // Control characters would break the invitation email and the member CSV export.
  if (name !== undefined && (name.length > WORKSPACE_INVITATION_NAME_MAX_LENGTH || /\p{Cc}/u.test(name))) {
    throw new WorkspaceAccessError(
      400,
      'InvalidWorkspaceInvitationName',
      `Invitation name must be at most ${WORKSPACE_INVITATION_NAME_MAX_LENGTH} characters without control characters.`,
    )
  }
  return name
}

/**
 * Builds the Enterprise CONTROL fence for an owner or admin promotion, as a Workspace error.
 *
 * @param workspaceId - Workspace whose Enterprise state was read.
 * @param controlRevision - CONTROL revision of the snapshot that showed no assignments.
 * @returns The condition check, or undefined without an Enterprise identity table.
 * @throws WorkspaceAccessError 503 `EnterpriseAuthorizationUnavailable` when no revision was read.
 */
function createWorkspacePromotionEnterpriseCheck(
  workspaceId: string,
  controlRevision: number | undefined,
): WorkspaceAccessTransactWriteItem | undefined {
  try {
    return createEnterpriseControlRevisionConditionCheck(workspaceId, controlRevision)
  } catch (error) {
    if (error instanceof ProjectDataError) {
      throw new WorkspaceAccessError(error.status, error.code, error.message, { cause: error })
    }
    throw error
  }
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

/**
 * Reads the body of a display name change.
 *
 * @param body - Parsed request body.
 * @returns The trimmed name (undefined removes it) and the member version read before the change.
 * @throws WorkspaceAccessError 400 `InvalidWorkspaceMemberName` for a name that is not a string,
 *   is too long, or holds control characters.
 */
function readMemberNameChange(body: unknown) {
  const fields = typeof body === 'object' && body !== null ? body : {}
  const name = readMemberDisplayName('name' in fields ? fields.name : undefined)
  if (!name.ok) {
    throw new WorkspaceAccessError(
      400,
      'InvalidWorkspaceMemberName',
      `Member name must be a string of at most ${MEMBER_DISPLAY_NAME_MAX_LENGTH} characters without control characters.`,
    )
  }
  return {
    name: name.name,
    expectedVersion: readWorkspaceVersion('expectedVersion' in fields ? fields.expectedVersion : undefined),
  }
}

/**
 * Builds the signed-in member's profile response.
 *
 * @param member - The member's current row.
 * @returns Profile fields the Web app shows and edits.
 */
function toMemberProfile(member: WorkspaceMember): MemberProfile {
  return {
    memberKey: member.memberKey,
    email: member.email,
    ...(member.name ? { name: member.name } : {}),
    nameEditable: member.provisioningSource !== 'directory',
    version: member.version,
  }
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

  /** Returns the authenticated member's own display preferences. */
  routeApp.get('/api/me/preferences', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      c.header('Cache-Control', 'private, no-store')
      return c.json(await workspaceDependencies.projectDirectory.getMemberPreferences(
        principal.directoryId,
        principal.userKey,
        true,
      ))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Replaces the authenticated member's own complete display preferences. */
  routeApp.put('/api/me/preferences', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = readUpdateMemberPreferencesInput(await readJson<unknown>(c.req))
      if (!input) {
        throw new ProjectDataError(
          400,
          'InvalidMemberPreferencesInput',
          'Member preferences input is invalid.',
        )
      }

      return c.json(await workspaceDependencies.projectDirectory.replaceMemberPreferences(
        principal.directoryId,
        principal.userKey,
        input,
      ))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Returns the signed-in member's own profile. */
  routeApp.get('/api/me/profile', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const member = await workspaceDependencies.workspaceAccess.getActiveMember(
        principal.directoryId,
        principal.userKey,
      )
      if (!member) {
        throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
      }
      c.header('Cache-Control', 'private, no-store')
      return c.json({ profile: toMemberProfile(member) })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** Changes the signed-in member's own display name. */
  routeApp.put('/api/me/profile', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = readMemberNameChange(await readJson<unknown>(c.req))
      // The name is part of the request fingerprint, so a retry with the same key and another
      // name is refused instead of being taken for the saved rename.
      const auditContext = createWorkspaceMutationContext(c, principal, {
        expectedVersion: input.expectedVersion,
        name: input.name ?? null,
      })
      const member = await workspaceDependencies.workspaceAccess.updateMemberName(
        principal.directoryId,
        principal.userKey,
        principal.userKey,
        input,
        auditContext,
      )
      return c.json({ profile: toMemberProfile(member) })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toWorkspaceAccessErrorResponse(c, error)
    }
  })

  /** Lets a Workspace administrator correct a member's display name. */
  routeApp.put('/api/workspace/members/:memberKey/name', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
      const input = readMemberNameChange(await readJson<unknown>(c.req))
      const auditContext = createWorkspaceMutationContext(c, principal, {
        expectedVersion: input.expectedVersion,
        memberKey,
        name: input.name ?? null,
      })
      const member = await workspaceDependencies.workspaceAccess.updateMemberName(
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
      const email = readNewWorkspaceInvitationEmail(body?.email)
      const name = readNewWorkspaceInvitationName(body?.name)
      const role = body?.role === undefined
        ? await resolveTenantDefaultInvitationRole(principal)
        : readWorkspaceRole(body.role)
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
      let authorizationConditionChecks: WorkspaceAccessTransactWriteItem[] = []
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
        const enterpriseSnapshot =
          await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
        requireEnterpriseExternalAccessAllowed(
          enterpriseSnapshot,
          existingMember.email,
          role,
        )
        // Direct role assignments replace the Workspace role during authorization, so an owner
        // or admin with assignments would not get the role they were given.
        if (
          (role === 'owner' || role === 'admin') &&
          enterpriseSnapshot.roleAssignments.some((assignment) =>
            assignment.principalKind === 'member' &&
            assignment.source === 'direct' &&
            assignment.principalId === existingMember.memberKey
          )
        ) {
          throw new WorkspaceAccessError(
            409,
            'WorkspaceMemberRoleAssignmentsPresent',
            'Remove the member role assignments before making this member an owner or admin.',
          )
        }
        if (role === 'owner' || role === 'admin') {
          // Pin the Enterprise state that showed no assignments, so an assignment created
          // concurrently cancels the promotion.
          const enterpriseControlCheck = createWorkspacePromotionEnterpriseCheck(
            principal.directoryId,
            enterpriseSnapshot.controlRevision,
          )
          if (enterpriseControlCheck) authorizationConditionChecks = [enterpriseControlCheck]
        }
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

      const member = await updateMemberMembership(
        createMemberMembershipUpdatePorts({
          workspace: workspaceDependencies,
          developerPlatform: developerPlatformDependencies,
        }),
        {
          workspaceId: principal.directoryId,
          actorMemberKey: principal.userKey,
          actorRole: principal.workspaceRole,
          memberKey,
          update: {
            role,
            status,
            expectedVersion,
            expectedPlanningRevision,
            ...(authorizationConditionChecks.length === 0 ? {} : { authorizationConditionChecks }),
            ...(expectedDocumentAuthorizationRevision === undefined
              ? {}
              : {
                  expectedDocumentAuthorizationRevision,
                }),
          },
          auditContext,
        },
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
