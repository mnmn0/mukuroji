import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import { getConnInfo } from 'hono/aws-lambda'
import type { Context } from 'hono'
import {
  CognitoServiceError,
  readCognitoMfaChallengeName,
  type InitiateAuthResponse,
} from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { type MutationAuditContext } from '../../modules/audit/audit'
import {
  WorkspaceAccessError,
  type WorkspaceInvitation,
} from '../../modules/workspace-access/workspace-access'
import { EnterpriseIdentityError } from '../../modules/enterprise-identity'
import { canManageAiAssistanceWorkspace } from '../shared/ai-assistance-access'
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { createAuthenticationResponse } from '../shared/authentication-session'
import { hasCustomerManagementAccess, hasCustomerReadAccess } from '../shared/customer-access'
import {
  isEnterpriseSsoConfigured,
  toEnterpriseIdentityErrorResponse,
  validateConfiguredCognitoAccessToken,
} from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  canWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createWorkspaceMutationContextForActor,
  toWorkspaceAccessErrorResponse,
} from '../shared/workspace-access'

/**
 * Cognito の NEW_PASSWORD_REQUIRED challenge を完了する入力です。
 */
type CompleteNewPasswordChallengeRequestBody = {
  /**
   * challenge を開始した Cognito user のメールアドレスです。
   */
  email?: unknown
  /**
   * Cognito が login challenge とともに返した session です。
   */
  session?: unknown
  /**
   * user が設定する恒久 password です。
   */
  newPassword?: unknown
}

/**
 * Cognito MFA challenge を完了する入力です。
 */
type CompleteMfaChallengeRequestBody = {
  /** Challenge 対象の正規化済みメールアドレスです。 */
  email?: unknown
  /** Cognito が発行した challenge session です。 */
  session?: unknown
  /** Login/challenge response が返した challenge 名です。 */
  challenge?: unknown
  /** Authenticator、SMS、または email に届いた one-time code です。 */
  code?: unknown
}

/**
 * ログイン API が受け取る request body です。
 */
type LoginRequestBody = {
  /**
   * ユーザーが入力したメールアドレスです。
   */
  email?: unknown
  /**
   * ユーザーが入力したパスワードです。
   */
  password?: unknown
}

function toSupportedMfaChallenge(response: InitiateAuthResponse, email: string) {
  const challenge = readCognitoMfaChallengeName(response.ChallengeName)
  if (!challenge || !response.Session) return undefined
  const destination = response.ChallengeParameters?.CODE_DELIVERY_DESTINATION
  const deliveryMedium = response.ChallengeParameters?.CODE_DELIVERY_DELIVERY_MEDIUM
  return {
    challenge,
    email,
    session: response.Session,
    ...(destination ? { deliveryDestination: destination } : {}),
    ...(deliveryMedium ? { deliveryMedium } : {}),
  }
}

const authenticationChallengeAttempts = new Map<string, {
  attempts: number
  resetAt: number
}>()

function consumeAuthenticationChallengeAttempt(c: Context, email: string) {
  const key = authenticationChallengeAttemptKey(c, email)
  const now = Date.now()
  for (const [candidate, state] of authenticationChallengeAttempts) {
    if (state.resetAt <= now) authenticationChallengeAttempts.delete(candidate)
  }
  const current = authenticationChallengeAttempts.get(key)
  if (current && current.resetAt > now && current.attempts >= 10) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    }
  }
  authenticationChallengeAttempts.set(key, {
    attempts: (current?.attempts ?? 0) + 1,
    resetAt: current?.resetAt && current.resetAt > now
      ? current.resetAt
      : now + 5 * 60_000,
  })
  return { allowed: true as const, retryAfterSeconds: 0 }
}

function clearAuthenticationChallengeAttempts(c: Context, email: string) {
  authenticationChallengeAttempts.delete(authenticationChallengeAttemptKey(c, email))
}

function authenticationChallengeAttemptKey(c: Context, email: string) {
  let transportSource = 'transport-unavailable'
  try {
    transportSource = getConnInfo(c).remote.address ?? transportSource
  } catch {
    // Unit tests and non-server adapters do not always expose connection metadata.
  }
  return createHash('sha256')
    .update(`${transportSource}\0${email}`)
    .digest('base64url')
}

async function acquireNewPasswordChallengeInvitationLock(c: Context, email: string) {
  const workspaceUser = await authenticationDependencies.cognito.findWorkspaceUser(email)

  if (!workspaceUser?.directoryId) {
    return undefined
  }

  const activeMember = await workspaceDependencies.workspaceAccess.getActiveMember(
    workspaceUser.directoryId,
    workspaceUser.profile.id,
  )
  const auditContext = createWorkspaceMutationContextForActor(
    c,
    workspaceUser.directoryId,
    workspaceUser.identityId ?? workspaceUser.profile.username ?? workspaceUser.profile.id,
    workspaceUser.profile.email,
    { email },
  )

  if (activeMember) {
    return { auditContext }
  }

  const invitation = await workspaceDependencies.workspaceAccess.acquireInvitationAcceptanceLock(
    workspaceUser.directoryId,
    email,
    auditContext,
  )

  return {
    auditContext,
    ...(invitation ? { directoryId: workspaceUser.directoryId, invitation } : {}),
  }
}

async function releaseNewPasswordChallengeInvitationLock(
  state: {
    auditContext: MutationAuditContext
    directoryId?: string
    invitation?: WorkspaceInvitation
  } | undefined,
) {
  if (!state?.directoryId || !state.invitation) {
    return
  }

  try {
    await workspaceDependencies.workspaceAccess.releaseInvitationAcceptanceLock(
      state.directoryId,
      state.invitation.id,
      state.invitation.version,
      state.auditContext,
    )
  } catch (error) {
    console.error('Failed to release Workspace invitation acceptance lock:', error)
  }
}

function toNewPasswordChallengeErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof CognitoServiceError &&
    (
      error.code === 'InvalidPasswordException' ||
      error.code === 'PasswordHistoryPolicyViolationException'
    )
  ) {
    return c.json(
      {
        code: 'InvalidNewPassword' as const,
        message: 'New password does not meet the password policy.',
      },
      400,
    )
  }

  return toAuthErrorResponse(c, error)
}

/** Checks whether the principal may create or update Customer saved views. */
function canManageCustomerViews(principal: WorkspacePrincipal): boolean {
  if (principal.workspaceRole === 'guest') return false
  return canWorkspaceBusinessWrite(principal) && hasCustomerManagementAccess(principal)
}

/**
 * Registers the authentication HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAuthenticationRoutes(routeApp: Hono): void {
  /**
   * メールアドレスとパスワードで Cognito 認証を実行する login endpoint です。
   *
   * @remarks
   * `LoginRequestBody` の `email` は trim し、`email` と `password` の存在を検証します。
   * 成功時は `accessToken`, `idToken`, `refreshToken`, `expiresAt`, `tokenType` を返します。
   * 未入力は 400、未対応 challenge は 409、Cognito 由来の認証失敗や upstream failure は
   * `toAuthErrorResponse` に委譲します。
   */
  routeApp.post('/api/auth/login', async (c) => {
    const body = await readJson<LoginRequestBody>(c.req)
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''

    if (!email || !password) {
      return c.json({ message: 'Email and password are required.' }, 400)
    }

    try {
      const discovery = isEnterpriseSsoConfigured()
        ? await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
        : undefined
      if (discovery) {
        return c.json({
          code: 'SsoRequired' as const,
          message: 'Single sign-on is required for this email domain.',
          provider: {
            id: discovery.provider.providerId,
            kind: discovery.provider.kind,
            displayName: discovery.provider.displayName,
          },
          ssoStartPath: '/api/auth/sso/start' as const,
        }, 409)
      }
      const response = await authenticationDependencies.cognito.initiatePasswordAuth(email, password)
      const tokens = response.AuthenticationResult

      if (!tokens?.AccessToken) {
        if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED' && response.Session) {
          return c.json({
            challenge: 'NEW_PASSWORD_REQUIRED' as const,
            email,
            session: response.Session,
          })
        }
        const mfaChallenge = toSupportedMfaChallenge(response, email)
        if (mfaChallenge) return c.json(mfaChallenge)

        return c.json(
          {
            message: response.ChallengeName
              ? `Unsupported Cognito challenge: ${response.ChallengeName}`
              : 'Cognito did not return an access token.',
          },
          409,
        )
      }

      return c.json(await createAuthenticationResponse(tokens, c, { email }))
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) {
        return toEnterpriseIdentityErrorResponse(c, error)
      }
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(c, error)
      }

      return toAuthErrorResponse(c, error)
    }
  })

  /**
   * Cognito の NEW_PASSWORD_REQUIRED challenge を完了する endpoint です。
   *
   * @remarks
   * Cognito が password 更新に成功した後の Workspace membership reconcile は通常 login と
   * 同じ処理を通ります。DynamoDB 更新だけが失敗した場合も、新 password で login し直すと
   * reconcile を再実行できます。
   */
  routeApp.post('/api/auth/challenge/new-password', async (c) => {
    const body = await readJson<CompleteNewPasswordChallengeRequestBody>(c.req)
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const session = typeof body?.session === 'string' ? body.session.trim() : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

    if (!email || !session || !newPassword) {
      return c.json({ message: 'Email, session, and new password are required.' }, 400)
    }

    try {
      const discovery = isEnterpriseSsoConfigured()
        ? await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
        : undefined
      if (discovery) {
        return c.json({
          code: 'SsoRequired' as const,
          message: 'Single sign-on is required for this email domain.',
          provider: {
            id: discovery.provider.providerId,
            kind: discovery.provider.kind,
            displayName: discovery.provider.displayName,
          },
          ssoStartPath: '/api/auth/sso/start' as const,
        }, 409)
      }
      const acceptanceState = await acquireNewPasswordChallengeInvitationLock(c, email)

      try {
        const response = await authenticationDependencies.cognito.respondToNewPasswordChallenge(email, newPassword, session)
        const tokens = response.AuthenticationResult

        if (!tokens?.AccessToken) {
          const mfaChallenge = toSupportedMfaChallenge(response, email)
          if (mfaChallenge) return c.json(mfaChallenge)
          return c.json(
            {
              message: response.ChallengeName
                ? `Unsupported Cognito challenge: ${response.ChallengeName}`
                : 'Cognito did not return an access token.',
            },
            409,
          )
        }

        return c.json(await createAuthenticationResponse(
          tokens,
          c,
          { email },
          acceptanceState?.auditContext,
        ))
      } finally {
        await releaseNewPasswordChallengeInvitationLock(acceptanceState)
      }
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(c, error)
      }

      return toNewPasswordChallengeErrorResponse(c, error)
    }
  })

  /**
   * Cognito の MFA/OTP challenge を完了する endpoint です。
   */
  routeApp.post('/api/auth/challenge/mfa', async (c) => {
    const body = await readJson<CompleteMfaChallengeRequestBody>(c.req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const session = typeof body?.session === 'string' ? body.session.trim() : ''
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    const challenge = readCognitoMfaChallengeName(body?.challenge)

    if (!email || !session || !challenge || !/^\d{6,8}$/u.test(code)) {
      return c.json({
        code: 'InvalidMfaChallenge',
        message: 'Email, challenge session, and a valid one-time code are required.',
      }, 400)
    }

    try {
      const discovery = isEnterpriseSsoConfigured()
        ? await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
        : undefined
      if (discovery) {
        return c.json({
          code: 'SsoRequired' as const,
          message: 'Single sign-on is required for this email domain.',
          provider: {
            id: discovery.provider.providerId,
            kind: discovery.provider.kind,
            displayName: discovery.provider.displayName,
          },
          ssoStartPath: '/api/auth/sso/start' as const,
        }, 409)
      }
    } catch (error) {
      return toEnterpriseIdentityErrorResponse(c, error)
    }

    const rateLimit = consumeAuthenticationChallengeAttempt(c, email)
    if (!rateLimit.allowed) {
      c.header('Retry-After', String(rateLimit.retryAfterSeconds))
      return c.json({
        code: 'AuthenticationChallengeRateLimited',
        message: 'Too many verification attempts. Try again later.',
      }, 429)
    }

    try {
      const response = await authenticationDependencies.cognito.respondToMfaChallenge(
        email,
        challenge,
        code,
        session,
      )
      const tokens = response.AuthenticationResult
      if (!tokens?.AccessToken) {
        const nextChallenge = toSupportedMfaChallenge(response, email)
        if (nextChallenge) return c.json(nextChallenge)
        return c.json({
          code: 'UnsupportedAuthenticationChallenge',
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        }, 409)
      }
      clearAuthenticationChallengeAttempts(c, email)
      return c.json(await createAuthenticationResponse(
        tokens,
        c,
        { email },
        undefined,
        [challenge],
      ))
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(c, error)
      }
      return toAuthErrorResponse(c, error)
    }
  })

  /**
   * Bearer access token から現在の Cognito ユーザー情報を返す endpoint です。
   *
   * @remarks
   * `Authorization: Bearer <accessToken>` header を要求し、形式が合わない場合は 401 を返します。
   * 成功時は `username` と Cognito user attributes の map を返します。
   * Cognito の `getUser` 失敗は `toAuthErrorResponse` に委譲します。
   */
  routeApp.get('/api/auth/me', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      validateConfiguredCognitoAccessToken(accessToken)
      const user = await authenticationDependencies.cognito.getUser(accessToken)
      const principal = await authenticateWorkspacePrincipal(accessToken, user, c)

      return c.json({
        username: user.Username ?? '',
        attributes: Object.fromEntries(
          (user.UserAttributes ?? [])
            .filter((attribute) => attribute.Name && attribute.Value !== undefined)
            .map((attribute) => [attribute.Name as string, attribute.Value]),
        ),
        groups: principal.groups,
        isSystemAdmin: principal.isSystemAdmin,
        workspaceRole: principal.workspaceRole,
        workspaceMemberStatus: principal.workspaceMemberStatus,
        canManageAiAssistance: canManageAiAssistanceWorkspace(principal),
        canReadCustomers: hasCustomerReadAccess(principal),
        canManageCustomerRequests: hasCustomerManagementAccess(principal),
        canViewCustomerSensitiveData: hasCustomerManagementAccess(principal),
        canManageCustomerViews: canManageCustomerViews(principal),
      })
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(c, error)
      }

      if (error instanceof ProjectDataError) {
        return toProjectDataErrorResponse(c, error)
      }

      return toAuthErrorResponse(c, error)
    }
  })
}
