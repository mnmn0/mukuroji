import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import {
  CognitoServiceError,
  FlociCognitoClient,
  getSystemAdminGroups,
  type AuthTokenSet,
  type GetUserResponse,
} from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { type MutationAuditContext } from '../../modules/audit/audit'
import {
  authenticationDependencies,
  requireAppDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { projectDirectoryIdPrefix } from './constants'
import {
  type CognitoAccessTokenClaims,
  readCognitoAuthenticationMethods,
  readCognitoGroups,
} from './enterprise-access'
import { createWorkspaceMutationContext, type ProjectPrincipal } from './project-access'
import { getEnv } from './runtime-config'
import { decodeJwtPayload, readNumericClaim, readUserAttribute } from './token-claims'

/**
 * Builds the login response for a completed Cognito authentication.
 *
 * @param tokens - Cognito token set.
 * @param c - Hono request context.
 * @param requestBody - Login request body.
 * @param requestAuditContext - Audit context of the login request.
 * @param verifiedAuthenticationMethods - Authentication methods verified for the session.
 * @returns The HTTP response carrying the session tokens.
 */
export async function createAuthenticationResponse(
  tokens: AuthTokenSet,
  c: Context,
  requestBody: Readonly<Record<string, unknown>>,
  requestAuditContext?: MutationAuditContext,
  verifiedAuthenticationMethods: readonly string[] = [],
) {
  if (!tokens.AccessToken) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito did not return an access token.',
    )
  }

  if (
    requireAppDependencies().authentication.cognito instanceof FlociCognitoClient &&
    tokens.AccessToken.split('.').length !== 3
  ) {
    return {
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    }
  }

  const user = await authenticationDependencies.cognito.getUser(tokens.AccessToken)
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (userKey?.trim()) {
    const principal = toProjectPrincipal(user, tokens.AccessToken)
    const auditContext = requestAuditContext ?? createWorkspaceMutationContext(
      c,
      principal,
      requestBody,
    )
    await workspaceDependencies.workspaceAccess.reconcileAuthenticatedMember(principal.directoryId, {
      memberKey: principal.userKey,
      email: readUserAttribute(user, 'email') ?? principal.userKey,
      name: readUserAttribute(user, 'name'),
    }, auditContext)
    const claims = decodeJwtPayload<CognitoAccessTokenClaims>(tokens.AccessToken)
    const authenticatedAt = readNumericClaim(claims?.auth_time) ??
      readNumericClaim(claims?.iat) ??
      Math.floor(Date.now() / 1_000)
    const expiresAt = readNumericClaim(claims?.exp) ??
      Math.floor(Date.now() / 1_000) + (tokens.ExpiresIn ?? 3_600)
    const authenticationMethods = [
      ...new Set([
        ...readCognitoAuthenticationMethods(claims),
        ...verifiedAuthenticationMethods,
      ]),
    ]
    if (authenticationMethods.length > 0) {
      await workspaceDependencies.enterpriseSessionActivity.recordAuthenticationAssurance({
        workspaceId: principal.directoryId,
        sessionId: createHash('sha256').update(tokens.AccessToken).digest('base64url'),
        authenticationMethods,
        authenticatedAt,
        expiresAt,
      })
    }
  }

  return {
    accessToken: tokens.AccessToken,
    idToken: tokens.IdToken,
    refreshToken: tokens.RefreshToken,
    expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
    tokenType: tokens.TokenType ?? 'Bearer',
  }
}

/**
 * Converts a Cognito user into a project principal.
 *
 * @param user - Cognito user.
 * @param accessToken - Bearer access token from the request.
 * @returns The project principal.
 */
export function toProjectPrincipal(user: GetUserResponse, accessToken: string): ProjectPrincipal {
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (!userKey?.trim()) {
    throw new ProjectDataError(
      403,
      'ProjectPrincipalMissing',
      'Cognito user does not have a stable project access identifier.',
    )
  }

  const normalizedUserKey = userKey.trim().toLowerCase()
  const actorId = readUserAttribute(user, 'sub')?.trim() || user.Username?.trim() || normalizedUserKey
  const directoryId = readProjectDirectoryId(user) ?? `${projectDirectoryIdPrefix}${normalizedUserKey}`
  const groups = readCognitoGroups(accessToken)

  return {
    directoryId,
    userKey: normalizedUserKey,
    actorId,
    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
    groups,
  }
}

function getConfiguredWorkspaceDirectoryId() {
  return getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')?.trim() || undefined
}

function readProjectDirectoryId(user: GetUserResponse) {
  const directoryId = readUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const workspaceId = readUserAttribute(user, 'custom:workspace_id')?.trim() || undefined
  const configuredWorkspaceDirectoryId = getConfiguredWorkspaceDirectoryId()

  if (directoryId && workspaceId && directoryId !== workspaceId) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      'Cognito directory attributes do not identify the same workspace.',
    )
  }

  const claimedDirectoryId = directoryId ?? workspaceId

  if (
    configuredWorkspaceDirectoryId &&
    claimedDirectoryId !== configuredWorkspaceDirectoryId
  ) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      `Cognito workspace "${claimedDirectoryId ?? 'missing'}" does not match configured workspace "${configuredWorkspaceDirectoryId}".`,
    )
  }

  return claimedDirectoryId
}
