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
import {
  EnterpriseIdentityError,
  EnterpriseSessionActivityError,
} from '../../modules/enterprise-identity'
import { canManageAiAssistanceWorkspace } from '../shared/ai-assistance-access'
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { createAuthenticationResponse } from '../shared/authentication-session'
import { hasCustomerManagementAccess, hasCustomerReadAccess } from '../shared/customer-access'
import {
  isEnterpriseSsoConfigured,
  toEnterpriseIdentityErrorResponse,
  validateConfiguredCognitoAccessToken,
  type CognitoAccessTokenClaims,
} from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import { getEnv } from '../shared/runtime-config'
import { decodeJwtPayload, readUserAttribute } from '../shared/token-claims'
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

/**
 * Session の更新と sign-out が受け取る request body です。
 */
type RefreshTokenRequestBody = {
  /** Login または SSO 交換で受け取った Cognito refresh token です。 */
  refreshToken?: unknown
}

/** Refresh token として受け付ける最大文字数です。Cognito の token は数 KB に収まります。 */
const maxRefreshTokenLength = 16_384

/**
 * Reads a refresh token from a request body field.
 *
 * @param value - Untrusted request body value.
 * @returns The trimmed token, or an empty string when it is missing or too long.
 */
function readRefreshToken(value: unknown) {
  const token = typeof value === 'string' ? value.trim() : ''
  return token.length <= maxRefreshTokenLength ? token : ''
}

/**
 * Picks the Cognito app client that issued a session's refresh token.
 *
 * Refresh and revocation must name the issuing client. A session from enterprise SSO carries
 * the SSO client's ID in its access token; every other session belongs to the password client.
 * The access token is read without verification, so it can only choose between the two
 * configured clients, and Cognito rejects a refresh token sent with the wrong one.
 *
 * @param accessToken - Access token of the session, possibly expired.
 * @returns The SSO client ID for an SSO session, or undefined for the password client.
 */
function resolveSessionClientId(accessToken: string | undefined) {
  const ssoClientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()
  if (!ssoClientId || !accessToken) return undefined
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  return claims?.client_id === ssoClientId ? ssoClientId : undefined
}

/**
 * Maps a failed session refresh to a response the Web can act on.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the refresh.
 * @returns The HTTP error response.
 */
function toRefreshErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError && error.code === 'NotAuthorizedException') {
    return c.json({
      code: 'RefreshTokenRejected' as const,
      message: 'The session can no longer be refreshed. Sign in again.',
    }, 401)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof EnterpriseIdentityError) {
    return toEnterpriseIdentityErrorResponse(c, error)
  }
  if (error instanceof EnterpriseSessionActivityError) {
    return c.json({ code: error.code, message: error.message }, error.status === 403 ? 403 : 503)
  }
  return toAuthErrorResponse(c, error)
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
   * Refresh token で session の access token を更新する endpoint です。
   *
   * @remarks
   * Body の `refreshToken` は必須です。`Authorization: Bearer <更新前の access token>` は
   * 期限切れでもよく、SSO session の app client の判別と、idle activity・MFA/SSO assurance の
   * 引き継ぎに使います。Cognito は更新後の token にも元の `auth_time` を入れるので、
   * Enterprise policy の最大 session 時間は最初の sign-in から数えたままです。
   * 応答は login と同じ形で、Cognito が refresh token を rotate しない限り `refreshToken` は
   * 含みません。Refresh token が失効・期限切れなら 401 `RefreshTokenRejected` を返します。
   */
  routeApp.post('/api/auth/refresh', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<RefreshTokenRequestBody>(c.req)
    const refreshToken = readRefreshToken(body?.refreshToken)

    if (!refreshToken) {
      return c.json({
        code: 'InvalidRefreshRequest' as const,
        message: 'Refresh token is required.',
      }, 400)
    }

    const cognito = authenticationDependencies.cognito
    if (!cognito.refreshTokens) {
      return c.json({
        code: 'AuthenticationRefreshUnavailable' as const,
        message: 'Session refresh is not available.',
      }, 503)
    }

    const previousAccessToken = readBearerAccessToken(c)
    const ssoClientId = resolveSessionClientId(previousAccessToken)

    try {
      const response = await cognito.refreshTokens(refreshToken, ssoClientId)
      const tokens = response.AuthenticationResult

      if (!tokens?.AccessToken) {
        return c.json({
          code: 'UnsupportedAuthenticationChallenge' as const,
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        }, 409)
      }

      if (!ssoClientId && isEnterpriseSsoConfigured()) {
        // A password session must not outlive a domain switching to enforced SSO.
        const user = await cognito.getUser(tokens.AccessToken)
        const email = readUserAttribute(user, 'email')?.trim()
        const discovery = email
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
      }

      return c.json(await createAuthenticationResponse(
        tokens,
        c,
        {},
        undefined,
        [],
        previousAccessToken ? { previousAccessToken } : undefined,
      ))
    } catch (error) {
      return toRefreshErrorResponse(c, error)
    }
  })

  /**
   * Refresh token を Cognito で失効させる sign-out endpoint です。
   *
   * @remarks
   * Body の `refreshToken` は必須です。Cognito の RevokeToken は refresh token と、それから
   * 発行された access token をすべて失効させるので、sign-out 後は refresh token で session を
   * 再開できず、残った access token も API で拒否されます。SSO session は
   * `Authorization: Bearer <access token>` から SSO の app client を判別します。成功時は 204 です。
   */
  routeApp.post('/api/auth/logout', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<RefreshTokenRequestBody>(c.req)
    const refreshToken = readRefreshToken(body?.refreshToken)

    if (!refreshToken) {
      return c.json({
        code: 'InvalidRefreshRequest' as const,
        message: 'Refresh token is required.',
      }, 400)
    }

    const cognito = authenticationDependencies.cognito
    if (!cognito.revokeRefreshToken) {
      return c.json({
        code: 'AuthenticationRevocationUnavailable' as const,
        message: 'Session revocation is not available.',
      }, 503)
    }

    try {
      await cognito.revokeRefreshToken(
        refreshToken,
        resolveSessionClientId(readBearerAccessToken(c)),
      )
      return c.body(null, 204)
    } catch (error) {
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
