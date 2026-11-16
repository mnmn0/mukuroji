import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { getConnInfo } from 'hono/aws-lambda'
import type {
  AccountSecurityStatus,
  SoftwareTokenSetupStart,
  WorkspaceMembersSignInSecurityResponse,
} from '@mukuroji/contracts'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import {
  EnterpriseIdentityError,
} from '../../modules/enterprise-identity'
import {
  WorkspaceAccessError,
  type WorkspaceMemberCredentialAction,
} from '../../modules/workspace-access/workspace-access'
import {
  hasEnabledMfa,
  isMfaRequiredByWorkspacePolicy,
  isSsoSessionAccessToken,
} from '../shared/account-security'
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { createAuthenticationResponse } from '../shared/authentication-session'
import {
  isEnterpriseSsoConfigured,
  toEnterpriseIdentityErrorResponse,
  validateConfiguredCognitoAccessToken,
} from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  inspectMembersSignInSecurity,
  isSsoManagedEmail,
} from '../shared/member-sign-in-security'
import {
  createWorkspaceMutationContext,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { readUserAttribute } from '../shared/token-claims'
import { readWorkspaceEmail, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Longest password the API forwards to Cognito, which accepts at most 256 characters. */
const maxPasswordLength = 256

/** Longest Cognito challenge session the API accepts. */
const maxSessionLength = 4_096

/** Requests allowed per client and email address in one rate-limit window. */
const attemptLimits = {
  'password-reset-request': { attempts: 5, windowMs: 15 * 60_000 },
  'password-reset-confirm': { attempts: 10, windowMs: 15 * 60_000 },
  'mfa-setup-verify': { attempts: 10, windowMs: 5 * 60_000 },
} as const

/** Kind of request that the in-process rate limit counts separately. */
type AttemptScope = keyof typeof attemptLimits

/** Attempts counted per hashed client and email key. */
const attemptCounters = new Map<string, { attempts: number; resetAt: number }>()

/**
 * Counts one attempt and reports whether it is still within the limit.
 *
 * The count lives in this process only, like the MFA challenge limit; Cognito applies its own
 * per-user limits behind it.
 *
 * @param c - Hono request context.
 * @param scope - Kind of request.
 * @param subject - Email address or user the attempt targets.
 * @returns Whether the attempt is allowed and, if not, when to retry.
 */
function consumeAttempt(c: Context, scope: AttemptScope, subject: string) {
  const { attempts, windowMs } = attemptLimits[scope]
  let transportSource = 'transport-unavailable'
  try {
    transportSource = getConnInfo(c).remote.address ?? transportSource
  } catch {
    // Unit tests and non-server adapters do not always expose connection metadata.
  }
  const key = createHash('sha256')
    .update(`${scope}\0${transportSource}\0${subject}`)
    .digest('base64url')
  const now = Date.now()
  for (const [candidate, state] of attemptCounters) {
    if (state.resetAt <= now) attemptCounters.delete(candidate)
  }
  const current = attemptCounters.get(key)
  if (current && current.attempts >= attempts) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    }
  }
  attemptCounters.set(key, {
    attempts: (current?.attempts ?? 0) + 1,
    resetAt: current?.resetAt ?? now + windowMs,
  })
  return { allowed: true as const, retryAfterSeconds: 0 }
}

/**
 * Returns the response for a request over the rate limit.
 *
 * @param c - Hono request context.
 * @param retryAfterSeconds - Seconds until the window resets.
 * @returns The 429 response.
 */
function rateLimitedResponse(c: Context, retryAfterSeconds: number) {
  c.header('Retry-After', String(retryAfterSeconds))
  return c.json({
    code: 'AccountSecurityRateLimited' as const,
    message: 'Too many attempts. Try again later.',
  }, 429)
}

/**
 * Reads a normalized email address from an untrusted body field.
 *
 * @param value - Untrusted body value.
 * @returns The lowercase email address, or an empty string when it is not one.
 */
function readEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(email) ? email : ''
}

/**
 * Reads a password from an untrusted body field without trimming it.
 *
 * @param value - Untrusted body value.
 * @returns The password, or an empty string when it is missing or too long.
 */
function readPassword(value: unknown) {
  return typeof value === 'string' && value.length <= maxPasswordLength ? value : ''
}

/**
 * Reads a Cognito challenge session from an untrusted body field.
 *
 * @param value - Untrusted body value.
 * @returns The session, or an empty string when it is missing or too long.
 */
function readSession(value: unknown) {
  const session = typeof value === 'string' ? value.trim() : ''
  return session.length <= maxSessionLength ? session : ''
}

/**
 * Reads a one-time code made of digits.
 *
 * @param value - Untrusted body value.
 * @returns The code, or an empty string when it is not 6 to 8 digits.
 */
function readOneTimeCode(value: unknown) {
  const code = typeof value === 'string' ? value.trim() : ''
  return /^\d{6,8}$/u.test(code) ? code : ''
}

/**
 * Returns the response telling the Web to continue with enterprise SSO for this email.
 *
 * @param c - Hono request context.
 * @param email - Email address of the request.
 * @returns The 409 response when the domain enforces SSO, otherwise undefined.
 */
async function ssoRequiredResponse(c: Context, email: string) {
  if (!isEnterpriseSsoConfigured()) return undefined
  const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
  if (!discovery) return undefined
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

/**
 * Maps a failed account security request to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the request.
 * @returns The HTTP error response.
 */
function toAccountSecurityErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    if (
      error.code === 'InvalidPasswordException' ||
      error.code === 'PasswordHistoryPolicyViolationException'
    ) {
      return c.json({
        code: 'InvalidNewPassword' as const,
        message: 'New password does not meet the password policy.',
      }, 400)
    }
    if (
      error.code === 'CodeMismatchException' ||
      error.code === 'EnableSoftwareTokenMFAException'
    ) {
      return c.json({
        code: 'MfaCodeInvalid' as const,
        message: 'The authenticator code is invalid. Enter the current code.',
      }, 400)
    }
    if (
      error.code === 'LimitExceededException' ||
      error.code === 'TooManyRequestsException' ||
      error.code === 'TooManyFailedAttemptsException'
    ) {
      return rateLimitedResponse(c, 60)
    }
  }
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError) return toProjectDataErrorResponse(c, error)
  if (error instanceof EnterpriseIdentityError) return toEnterpriseIdentityErrorResponse(c, error)
  return toAuthErrorResponse(c, error)
}

/**
 * Reads and validates the Cognito user behind the bearer access token.
 *
 * These endpoints only need a valid Cognito sign-in, not a Workspace session, because a user
 * whose Workspace requires MFA must reach them before the session is usable.
 *
 * @param c - Hono request context.
 * @returns The access token and the Cognito user, or undefined without a bearer token.
 */
async function readCognitoCaller(c: Context) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return undefined
  validateConfiguredCognitoAccessToken(accessToken)
  const user = await authenticationDependencies.cognito.getUser(accessToken)
  return { accessToken, user }
}

/**
 * Returns the 503 response for a Cognito operation the configured client does not provide.
 *
 * @param c - Hono request context.
 * @returns The 503 response.
 */
function unavailableResponse(c: Context) {
  return c.json({
    code: 'AccountSecurityUnavailable' as const,
    message: 'This sign-in operation is not available.',
  }, 503)
}

/**
 * Registers password reset, password change, authenticator (TOTP), and administrator
 * credential routes.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAccountSecurityRoutes(routeApp: Hono): void {
  /**
   * Sends a password reset code to the email address.
   *
   * @remarks
   * Always answers 202 for a well-formed address, whether or not an account exists, so the
   * response cannot reveal accounts. Cognito sends the code only to an existing confirmed user
   * with a verified email. An email domain that enforces SSO gets 409 `SsoRequired`, like login.
   */
  routeApp.post('/api/auth/password-reset/request', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readEmail(body?.email)
    if (!email) {
      return c.json({ code: 'InvalidPasswordResetRequest' as const, message: 'A valid email address is required.' }, 400)
    }
    const limit = consumeAttempt(c, 'password-reset-request', email)
    if (!limit.allowed) return rateLimitedResponse(c, limit.retryAfterSeconds)

    try {
      const sso = await ssoRequiredResponse(c, email)
      if (sso) return sso
      const cognito = authenticationDependencies.cognito
      if (!cognito.requestPasswordReset) return unavailableResponse(c)
      try {
        await cognito.requestPasswordReset(email)
      } catch (error) {
        if (
          !(error instanceof CognitoServiceError) ||
          !isUndisclosedResetFailure(error.code)
        ) {
          throw error
        }
        if (error.code === 'CodeDeliveryFailureException') {
          console.error('Password reset code delivery failed:', error)
        }
      }
      return c.json({ accepted: true as const }, 202)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Sets a new password with the emailed reset code.
   *
   * @remarks
   * A wrong, expired, or unknown code, and an unknown account, all answer 400
   * `PasswordResetCodeInvalid`. Success answers 204; the user then signs in with the new password.
   */
  routeApp.post('/api/auth/password-reset/confirm', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readEmail(body?.email)
    const code = readOneTimeCode(body?.code)
    const newPassword = readPassword(body?.newPassword)
    if (!email || !code || !newPassword) {
      return c.json({
        code: 'InvalidPasswordResetRequest' as const,
        message: 'Email, the emailed code, and a new password are required.',
      }, 400)
    }
    const limit = consumeAttempt(c, 'password-reset-confirm', email)
    if (!limit.allowed) return rateLimitedResponse(c, limit.retryAfterSeconds)

    try {
      const sso = await ssoRequiredResponse(c, email)
      if (sso) return sso
      const cognito = authenticationDependencies.cognito
      if (!cognito.confirmPasswordReset) return unavailableResponse(c)
      await cognito.confirmPasswordReset(email, code, newPassword)
      return c.body(null, 204)
    } catch (error) {
      if (
        error instanceof CognitoServiceError &&
        (
          error.code === 'CodeMismatchException' ||
          error.code === 'ExpiredCodeException' ||
          error.code === 'UserNotFoundException' ||
          error.code === 'NotAuthorizedException'
        )
      ) {
        return c.json({
          code: 'PasswordResetCodeInvalid' as const,
          message: 'The code is invalid or expired. Request a new code.',
        }, 400)
      }
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Returns how the signed-in user signs in: password or SSO, and whether TOTP is on.
   */
  routeApp.get('/api/auth/account-security', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const caller = await readCognitoCaller(c)
      if (!caller) return c.json({ message: 'Bearer token is required.' }, 401)
      const status: AccountSecurityStatus = {
        passwordManaged: !isSsoSessionAccessToken(caller.accessToken),
        softwareTokenMfaEnabled: hasEnabledMfa(caller.user),
        mfaRequiredByPolicy: await isMfaRequiredByWorkspacePolicy(caller.user, caller.accessToken),
      }
      return c.json(status)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Changes the signed-in user's password after checking the current one.
   *
   * @remarks
   * A wrong current password answers 400 `CurrentPasswordIncorrect`. An SSO session answers
   * 409 `PasswordManagedBySso`. Success answers 204.
   */
  routeApp.post('/api/auth/password/change', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const currentPassword = readPassword(body?.currentPassword)
    const newPassword = readPassword(body?.newPassword)
    if (!currentPassword || !newPassword) {
      return c.json({
        code: 'InvalidPasswordChangeRequest' as const,
        message: 'Current and new passwords are required.',
      }, 400)
    }

    try {
      const caller = await readCognitoCaller(c)
      if (!caller) return c.json({ message: 'Bearer token is required.' }, 401)
      if (isSsoSessionAccessToken(caller.accessToken)) {
        return c.json({
          code: 'PasswordManagedBySso' as const,
          message: 'Your identity provider manages this password.',
        }, 409)
      }
      const cognito = authenticationDependencies.cognito
      if (!cognito.changePassword) return unavailableResponse(c)
      try {
        await cognito.changePassword(caller.accessToken, currentPassword, newPassword)
      } catch (error) {
        // The access token was just accepted by GetUser, so a rejection here is the password.
        if (error instanceof CognitoServiceError && error.code === 'NotAuthorizedException') {
          return c.json({
            code: 'CurrentPasswordIncorrect' as const,
            message: 'The current password is incorrect.',
          }, 400)
        }
        throw error
      }
      return c.body(null, 204)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Starts authenticator app (TOTP) registration for the signed-in user.
   *
   * @remarks
   * Accepts the access token of any valid sign-in, including the `setupAccessToken` of an
   * MFA_SETUP challenge. A user who already has TOTP gets 409 `MfaAlreadyEnabled`: replacing
   * it takes turning it off first, or an administrator reset.
   */
  routeApp.post('/api/auth/mfa/totp/associate', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const caller = await readCognitoCaller(c)
      if (!caller) return c.json({ message: 'Bearer token is required.' }, 401)
      const blocked = rejectSoftwareTokenSetup(c, caller.accessToken, caller.user)
      if (blocked) return blocked
      const cognito = authenticationDependencies.cognito
      if (!cognito.associateSoftwareToken) return unavailableResponse(c)
      const association = await cognito.associateSoftwareToken({ accessToken: caller.accessToken })
      const response: SoftwareTokenSetupStart = {
        secretCode: association.secretCode,
        accountName: readUserAttribute(caller.user, 'email')?.trim().toLowerCase() ||
          caller.user.Username ||
          'mukuroji',
      }
      return c.json(response)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Finishes authenticator app (TOTP) registration with a code from the app and turns TOTP on.
   */
  routeApp.post('/api/auth/mfa/totp/verify', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const code = readOneTimeCode(body?.code)
    if (!code) {
      return c.json({ code: 'MfaCodeInvalid' as const, message: 'Enter the 6-digit code.' }, 400)
    }

    try {
      const caller = await readCognitoCaller(c)
      if (!caller) return c.json({ message: 'Bearer token is required.' }, 401)
      const limit = consumeAttempt(c, 'mfa-setup-verify', caller.user.Username ?? caller.accessToken)
      if (!limit.allowed) return rateLimitedResponse(c, limit.retryAfterSeconds)
      const blocked = rejectSoftwareTokenSetup(c, caller.accessToken, caller.user)
      if (blocked) return blocked
      const cognito = authenticationDependencies.cognito
      if (!cognito.verifySoftwareToken || !cognito.setSoftwareTokenMfaEnabled) {
        return unavailableResponse(c)
      }
      await cognito.verifySoftwareToken({ accessToken: caller.accessToken }, code)
      await cognito.setSoftwareTokenMfaEnabled(caller.accessToken, true)
      return c.json({ softwareTokenMfaEnabled: true as const })
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Turns the signed-in user's authenticator app (TOTP) off.
   *
   * @remarks
   * Needs a usable Workspace session, so a session the security policy rejects cannot remove
   * MFA. A policy that requires MFA answers 409 `MfaRequiredByPolicy`.
   */
  routeApp.delete('/api/auth/mfa/totp', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

    try {
      validateConfiguredCognitoAccessToken(accessToken)
      const user = await authenticationDependencies.cognito.getUser(accessToken)
      await authenticateWorkspacePrincipal(accessToken, user, c)
      if (await isMfaRequiredByWorkspacePolicy(user, accessToken)) {
        return c.json({
          code: 'MfaRequiredByPolicy' as const,
          message: 'The Workspace security policy requires MFA.',
        }, 409)
      }
      const cognito = authenticationDependencies.cognito
      if (!cognito.setSoftwareTokenMfaEnabled) return unavailableResponse(c)
      await cognito.setSoftwareTokenMfaEnabled(accessToken, false)
      return c.body(null, 204)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Starts authenticator registration inside Cognito's sign-in MFA_SETUP challenge.
   */
  routeApp.post('/api/auth/challenge/mfa-setup/associate', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readEmail(body?.email)
    const session = readSession(body?.session)
    if (!email || !session) {
      return c.json({
        code: 'InvalidMfaSetupChallenge' as const,
        message: 'Email and challenge session are required.',
      }, 400)
    }

    try {
      const sso = await ssoRequiredResponse(c, email)
      if (sso) return sso
      const cognito = authenticationDependencies.cognito
      if (!cognito.associateSoftwareToken) return unavailableResponse(c)
      const association = await cognito.associateSoftwareToken({ session })
      const response: SoftwareTokenSetupStart = {
        secretCode: association.secretCode,
        accountName: email,
        session: association.session ?? session,
      }
      return c.json(response)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Finishes authenticator registration inside Cognito's MFA_SETUP challenge and signs in.
   *
   * @remarks
   * The response has the same shape as login. The session counts as MFA-verified, because the
   * user just proved the code of the registered authenticator.
   */
  routeApp.post('/api/auth/challenge/mfa-setup/verify', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readEmail(body?.email)
    const session = readSession(body?.session)
    const code = readOneTimeCode(body?.code)
    if (!email || !session || !code) {
      return c.json({
        code: 'InvalidMfaSetupChallenge' as const,
        message: 'Email, challenge session, and the 6-digit code are required.',
      }, 400)
    }
    const limit = consumeAttempt(c, 'mfa-setup-verify', email)
    if (!limit.allowed) return rateLimitedResponse(c, limit.retryAfterSeconds)

    try {
      const sso = await ssoRequiredResponse(c, email)
      if (sso) return sso
      const cognito = authenticationDependencies.cognito
      if (!cognito.verifySoftwareToken || !cognito.respondToMfaSetupChallenge) {
        return unavailableResponse(c)
      }
      const verified = await cognito.verifySoftwareToken({ session }, code)
      const response = await cognito.respondToMfaSetupChallenge(email, verified.session ?? session)
      const tokens = response.AuthenticationResult
      if (!tokens?.AccessToken) {
        return c.json({
          code: 'UnsupportedAuthenticationChallenge' as const,
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        }, 409)
      }
      return c.json(await createAuthenticationResponse(
        tokens,
        c,
        { email },
        undefined,
        ['SOFTWARE_TOKEN_MFA'],
      ))
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Lists the MFA state of active members and whether a password reset can be sent.
   *
   * @remarks
   * Owners and admins only. Each member is one Cognito lookup.
   */
  routeApp.get('/api/workspace/members/sign-in-security', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const members = await workspaceDependencies.workspaceAccess.listActiveMembers(
        principal.directoryId,
      )
      const response: WorkspaceMembersSignInSecurityResponse = {
        members: await inspectMembersSignInSecurity(members),
      }
      return c.json(response)
    } catch (error) {
      return toAccountSecurityErrorResponse(c, error)
    }
  })

  /**
   * Resets a member's password: Cognito invalidates it and emails a reset code.
   *
   * @remarks
   * Owners reset anyone, admins reset members and guests; nobody resets themselves. The action
   * is written to the audit log before Cognito changes. The member's refresh tokens are revoked.
   * Members of an SSO domain and members who have not accepted their invitation answer 409.
   */
  routeApp.post('/api/workspace/members/:memberKey/password-reset', async (c) => {
    return handleMemberCredentialAction(c, 'password-reset-requested')
  })

  /**
   * Removes a member's authenticator app (TOTP), for a member who lost it.
   *
   * @remarks
   * Same permissions and audit as the password reset. If the policy requires MFA, the member
   * registers a new authenticator at the next sign-in.
   */
  routeApp.post('/api/workspace/members/:memberKey/mfa-reset', async (c) => {
    return handleMemberCredentialAction(c, 'mfa-reset')
  })
}

/**
 * Cognito errors of a reset request that must not reveal whether the account exists.
 *
 * @param code - Cognito error code.
 * @returns Whether the request still answers 202.
 */
function isUndisclosedResetFailure(code: string) {
  return code === 'UserNotFoundException' ||
    code === 'NotAuthorizedException' ||
    code === 'InvalidParameterException' ||
    code === 'CodeDeliveryFailureException'
}

/**
 * Rejects authenticator registration for an SSO session or a user who already has TOTP.
 *
 * @param c - Hono request context.
 * @param accessToken - Access token of the caller.
 * @param user - Cognito user of the caller.
 * @returns The 409 response, or undefined when registration may continue.
 */
function rejectSoftwareTokenSetup(
  c: Context,
  accessToken: string,
  user: Parameters<typeof hasEnabledMfa>[0],
) {
  if (isSsoSessionAccessToken(accessToken)) {
    return c.json({
      code: 'MfaManagedBySso' as const,
      message: 'Your identity provider manages MFA for this account.',
    }, 409)
  }
  if (hasEnabledMfa(user)) {
    return c.json({
      code: 'MfaAlreadyEnabled' as const,
      message: 'An authenticator app is already registered. Turn it off first.',
    }, 409)
  }
  return undefined
}

/**
 * Runs an administrator password or MFA reset for one member.
 *
 * @param c - Hono request context.
 * @param action - Credential action to perform.
 * @returns The HTTP response.
 */
async function handleMemberCredentialAction(
  c: Context,
  action: WorkspaceMemberCredentialAction,
) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
    const member = await workspaceDependencies.workspaceAccess.getActiveMember(
      principal.directoryId,
      memberKey,
    )
    if (!member) {
      throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
    }
    if (await isSsoManagedEmail(member.email)) {
      return c.json({
        code: 'MemberSignInManagedBySso' as const,
        message: 'The identity provider manages this member\'s password and MFA.',
      }, 409)
    }
    const cognito = authenticationDependencies.cognito
    const resetCredential = action === 'password-reset-requested'
      ? cognito.adminResetUserPassword
      : cognito.adminDisableSoftwareTokenMfa
    const recordAction = workspaceDependencies.workspaceAccess.recordMemberCredentialAction
    if (!resetCredential || !recordAction) return unavailableResponse(c)

    const profile = await cognito.getUserProfile(member.memberKey)
    if (action === 'password-reset-requested' && profile.status === 'FORCE_CHANGE_PASSWORD') {
      return c.json({
        code: 'MemberInvitationPending' as const,
        message: 'The member has not accepted the invitation. Resend the invitation instead.',
      }, 409)
    }
    if (action === 'mfa-reset' && profile.mfaConfigured !== true) {
      return c.json({
        code: 'MemberMfaNotEnrolled' as const,
        message: 'The member has no authenticator app to reset.',
      }, 409)
    }

    await recordAction.call(
      workspaceDependencies.workspaceAccess,
      principal.directoryId,
      principal.userKey,
      member.memberKey,
      action,
      createWorkspaceMutationContext(c, principal, { action, memberKey: member.memberKey }),
    )
    await resetCredential.call(cognito, member.memberKey)

    if (action === 'password-reset-requested') {
      try {
        await cognito.globallySignOutWorkspaceUser?.(member.memberKey)
      } catch (error) {
        console.error('Failed to sign the member out after a password reset:', error)
      }
      return c.json({ sent: true as const }, 202)
    }
    return c.json({ reset: true as const })
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      if (error.code === 'UserNotFoundException') {
        return c.json({
          code: 'MemberSignInUnavailable' as const,
          message: 'The member has no password sign-in account.',
        }, 404)
      }
      if (error.code === 'InvalidParameterException' || error.code === 'NotAuthorizedException') {
        return c.json({
          code: 'MemberPasswordResetUnavailable' as const,
          message: 'Cognito cannot reset this member now. Check that the member\'s email is verified.',
        }, 409)
      }
    }
    return toAccountSecurityErrorResponse(c, error)
  }
}
