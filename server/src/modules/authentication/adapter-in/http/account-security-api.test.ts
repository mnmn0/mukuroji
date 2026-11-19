import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { CognitoServiceError, type CognitoClient } from '../..'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { InMemoryEnterpriseSessionActivityClient } from '../../../enterprise-identity/enterprise-session-activity'
import type { MutationAuditContext } from '../../../audit'
import {
  WorkspaceAccessError,
  type WorkspaceAccessClient,
  type WorkspaceMemberCredentialAction,
} from '../../../workspace-access'

const {
  app,
  configureFakeProjectClients,
  createFakeCognitoProfile,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace that the fake Cognito user `demo@example.com` belongs to. */
const workspaceId = 'user#demo@example.com'

/**
 * Replaces Cognito methods on top of the fake configured by `configureFakeProjectClients`.
 *
 * @param overrides - Cognito methods the test needs.
 */
function overrideCognito(overrides: Partial<CognitoClient>) {
  setTestAppDependencies({
    cognito: {
      ...getTestAppDependencies().authentication.cognito,
      ...overrides,
    },
  })
}

/**
 * Replaces Workspace Access methods on top of the configured fake.
 *
 * @param overrides - Workspace Access methods the test needs.
 */
function overrideWorkspaceAccess(overrides: Partial<WorkspaceAccessClient>) {
  setTestAppDependencies({
    workspaceAccess: {
      // Spreading the store instance leaves out its class methods, so the credential reset
      // gets an applying stage unless an earlier override, such as a progress tracker, set one.
      markMemberCredentialActionApplying: async () => undefined,
      ...getTestAppDependencies().workspace.workspaceAccess,
      ...overrides,
    },
  })
}

/**
 * Installs an enterprise identity store whose security policy requires MFA or not.
 *
 * @param mfaRequirement - MFA requirement of the policy.
 * @param externalRequireMfa - Whether the external-access policy requires MFA.
 * @returns The installed store.
 */
async function installSecurityPolicy(
  mfaRequirement: 'optional' | 'required',
  externalRequireMfa = false,
) {
  const identity = new InMemoryEnterpriseIdentityClient()
  await identity.putSecurityPolicy({
    workspaceId,
    loginMode: 'password-or-sso',
    mfaRequirement,
    sessionLifetimeMinutes: 480,
    idleTimeoutMinutes: 60,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'disabled',
    ipAllowlist: [],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: externalRequireMfa,
      maximumSessionLifetimeMinutes: 120,
      allowedGuestDomains: [],
      permissionCeiling: ['workspace.read'],
    },
    revision: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'demo@example.com',
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
  return identity
}

/**
 * Sends a JSON request to the API.
 *
 * @param path - API path.
 * @param body - JSON body.
 * @param accessToken - Optional bearer access token.
 * @param method - HTTP method.
 * @returns The response.
 */
function sendJson(path: string, body: unknown, accessToken?: string, method = 'POST') {
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

test('accepts a password reset request without revealing whether the account exists', async () => {
  configureFakeProjectClients(true)
  const requested: string[] = []
  overrideCognito({
    async requestPasswordReset(email) {
      requested.push(email)
      if (email === 'missing@example.com') {
        throw new CognitoServiceError(400, 'UserNotFoundException', 'User does not exist.')
      }
    },
  })

  const existing = await sendJson('/api/auth/password-reset/request', { email: ' Demo@Example.com ' })
  const missing = await sendJson('/api/auth/password-reset/request', { email: 'missing@example.com' })
  const invalid = await sendJson('/api/auth/password-reset/request', { email: 'not-an-email' })

  expect(existing.status).toBe(202)
  expect(await existing.json()).toEqual({ accepted: true })
  expect(missing.status).toBe(202)
  expect(await missing.json()).toEqual({ accepted: true })
  expect(invalid.status).toBe(400)
  expect(requested).toEqual(['demo@example.com', 'missing@example.com'])
})

test('rate limits repeated password reset requests for one address', async () => {
  configureFakeProjectClients(true)
  overrideCognito({ async requestPasswordReset() {} })

  const statuses: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    statuses.push((await sendJson('/api/auth/password-reset/request', {
      email: 'rate-limited@example.com',
    })).status)
  }

  expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
})

test('keeps live rate-limit counters when many addresses fill the store', async () => {
  configureFakeProjectClients(true)
  overrideCognito({ async requestPasswordReset() {} })
  const startedAt = Date.now()
  setSystemTime(startedAt)
  try {
    const requestFor = async (email: string) => (await sendJson('/api/auth/password-reset/request', { email })).status
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await requestFor('flood-target@example.com')).toBe(202)
    }

    // Fill the store with distinct addresses until it refuses a new one.
    let filler = 0
    while (await requestFor(`flood-${filler}@example.com`) === 202) {
      filler += 1
      if (filler > 10_000) throw new Error('The rate-limit store never filled up.')
    }

    expect(await requestFor('flood-target@example.com')).toBe(429)
    expect(await requestFor('flood-newcomer@example.com')).toBe(429)

    // Once the window has passed, the next request sweeps the expired keys.
    setSystemTime(startedAt + 16 * 60_000)
    expect(await requestFor('flood-newcomer@example.com')).toBe(202)
  } finally {
    setSystemTime()
  }
}, 60_000)

test('sets a new password with the emailed code and reports a wrong code without detail', async () => {
  configureFakeProjectClients(true)
  const confirmations: Array<[string, string, string]> = []
  overrideCognito({
    async confirmPasswordReset(email, code, newPassword) {
      confirmations.push([email, code, newPassword])
      if (code === '000000') {
        throw new CognitoServiceError(400, 'CodeMismatchException', 'Invalid code.')
      }
      if (newPassword === 'short') {
        throw new CognitoServiceError(400, 'InvalidPasswordException', 'Too short.')
      }
    },
  })

  const accepted = await sendJson('/api/auth/password-reset/confirm', {
    email: 'demo@example.com',
    code: '123456',
    newPassword: 'NewPassword123!',
  })
  const wrongCode = await sendJson('/api/auth/password-reset/confirm', {
    email: 'demo@example.com',
    code: '000000',
    newPassword: 'NewPassword123!',
  })
  const weakPassword = await sendJson('/api/auth/password-reset/confirm', {
    email: 'demo@example.com',
    code: '123456',
    newPassword: 'short',
  })

  expect(accepted.status).toBe(204)
  expect(wrongCode.status).toBe(400)
  expect((await wrongCode.json()).code).toBe('PasswordResetCodeInvalid')
  expect(weakPassword.status).toBe(400)
  expect((await weakPassword.json()).code).toBe('InvalidNewPassword')
  expect(confirmations[0]).toEqual(['demo@example.com', '123456', 'NewPassword123!'])
})

test('tells the Web to reset the password when an administrator invalidated it', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async initiatePasswordAuth() {
      throw new CognitoServiceError(400, 'PasswordResetRequiredException', 'Password reset required.')
    },
  })

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('PasswordResetRequired')
})

test('asks a member without MFA to register an authenticator when the policy requires MFA', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthTokens: true })
  await installSecurityPolicy('required')

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'MFA_SETUP',
    email: 'demo@example.com',
    setupAccessToken: 'test-token',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('asks a guest to register when only the external-access policy requires MFA', async () => {
  configureFakeProjectClients(true, { passwordAuthTokens: true, workspaceRole: 'guest' })
  await installSecurityPolicy('optional', true)

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(200)
  expect((await response.json()).challenge).toBe('MFA_SETUP')
})

test('asks an invited guest to register on the first sign-in, before the invitation is accepted', async () => {
  configureFakeProjectClients(true, { passwordAuthTokens: true })
  await installSecurityPolicy('optional', true)
  overrideWorkspaceAccess({
    getActiveMember: async () => undefined,
    getInvitation: async (_workspaceId, invitationId) => ({
      id: invitationId,
      email: invitationId,
      role: 'guest',
      status: 'pending',
      deliveryStatus: 'sent',
      identityOwnership: 'workspace-created',
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    }),
  })

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(200)
  expect((await response.json()).challenge).toBe('MFA_SETUP')
})

test('lets a user with only SMS MFA register an authenticator app', async () => {
  configureFakeProjectClients(true)
  const getUser = getTestAppDependencies().authentication.cognito.getUser
  overrideCognito({
    async getUser(accessToken) {
      return { ...await getUser(accessToken), UserMFASettingList: ['SMS_MFA'] }
    },
    async associateSoftwareToken() {
      return { secretCode: 'JBSWY3DPEHPK3PXP' }
    },
  })

  const status = await app.request('/api/auth/account-security', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const setup = await sendJson('/api/auth/mfa/totp/associate', {}, 'test-token')

  expect((await status.json()).softwareTokenMfaEnabled).toBe(false)
  expect(setup.status).toBe(200)
})

test('completes the sign-in when the policy requires MFA and Cognito already verified it', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthTokens: true })
  await installSecurityPolicy('required')
  const getUser = getTestAppDependencies().authentication.cognito.getUser
  overrideCognito({
    async getUser(accessToken) {
      return { ...await getUser(accessToken), UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }
    },
  })

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(200)
  expect((await response.json()).accessToken).toBe('test-token')
  expect(calls.workspaceReconciliations).toEqual(['demo@example.com'])
})

test('completes a sign-in without MFA when the policy keeps MFA optional', async () => {
  configureFakeProjectClients(true, { passwordAuthTokens: true })
  await installSecurityPolicy('optional')

  const response = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })

  expect(response.status).toBe(200)
  expect((await response.json()).refreshToken).toBe('test-refresh-token')
})

test('relays Cognito MFA_SETUP and signs in after the authenticator is verified', async () => {
  const calls = configureFakeProjectClients(true)
  const activity = new InMemoryEnterpriseSessionActivityClient()
  setTestAppDependencies({ enterpriseSessionActivity: activity })
  const verifications: Array<{ target: unknown; code: string }> = []
  overrideCognito({
    async initiatePasswordAuth() {
      return { ChallengeName: 'MFA_SETUP', Session: 'setup-session-1' }
    },
    async associateSoftwareToken(target) {
      expect(target).toEqual({ session: 'setup-session-1' })
      return { secretCode: 'JBSWY3DPEHPK3PXP', session: 'setup-session-2' }
    },
    async verifySoftwareToken(target, code) {
      verifications.push({ target, code })
      return { session: 'setup-session-3' }
    },
    async respondToMfaSetupChallenge(email, session) {
      expect([email, session]).toEqual(['demo@example.com', 'setup-session-3'])
      return {
        AuthenticationResult: {
          AccessToken: 'test-token',
          RefreshToken: 'test-refresh-token',
          ExpiresIn: 3_600,
          TokenType: 'Bearer',
        },
      }
    },
  })

  const login = await sendJson('/api/auth/login', {
    email: 'demo@example.com',
    password: 'Password123!',
  })
  expect(await login.json()).toEqual({
    challenge: 'MFA_SETUP',
    email: 'demo@example.com',
    session: 'setup-session-1',
  })

  const associated = await sendJson('/api/auth/challenge/mfa-setup/associate', {
    email: 'demo@example.com',
    session: 'setup-session-1',
  })
  expect(associated.headers.get('Cache-Control')).toBe('no-store')
  expect(await associated.json()).toEqual({
    secretCode: 'JBSWY3DPEHPK3PXP',
    accountName: 'demo@example.com',
    session: 'setup-session-2',
  })

  const verified = await sendJson('/api/auth/challenge/mfa-setup/verify', {
    email: 'demo@example.com',
    session: 'setup-session-2',
    code: '123456',
  })
  expect(verified.status).toBe(200)
  expect((await verified.json()).refreshToken).toBe('test-refresh-token')
  expect(verifications).toEqual([{ target: { session: 'setup-session-2' }, code: '123456' }])
  expect(calls.workspaceReconciliations).toEqual(['demo@example.com'])
})

test('reports the account security status of the signed-in user', async () => {
  configureFakeProjectClients(true)
  await installSecurityPolicy('required')

  const response = await app.request('/api/auth/account-security', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    passwordManaged: true,
    softwareTokenMfaEnabled: false,
    mfaRequiredByPolicy: true,
  })
})

test('registers an authenticator app with the setup access token', async () => {
  configureFakeProjectClients(true)
  const preferences: Array<[string, boolean]> = []
  const verifications: Array<{ target: unknown; code: string }> = []
  overrideCognito({
    async associateSoftwareToken(target) {
      expect(target).toEqual({ accessToken: 'setup-token' })
      return { secretCode: 'JBSWY3DPEHPK3PXP' }
    },
    async verifySoftwareToken(target, code) {
      verifications.push({ target, code })
      return {}
    },
    async setSoftwareTokenMfaEnabled(accessToken, enabled) {
      preferences.push([accessToken, enabled])
    },
  })

  const associated = await sendJson('/api/auth/mfa/totp/associate', {}, 'setup-token')
  const verified = await sendJson('/api/auth/mfa/totp/verify', { code: '654321' }, 'setup-token')

  expect(associated.status).toBe(200)
  expect(await associated.json()).toEqual({
    secretCode: 'JBSWY3DPEHPK3PXP',
    accountName: 'demo@example.com',
  })
  expect(verified.status).toBe(200)
  expect(verifications).toEqual([{ target: { accessToken: 'setup-token' }, code: '654321' }])
  expect(preferences).toEqual([['setup-token', true]])
})

test('does not replace an authenticator that is already registered', async () => {
  configureFakeProjectClients(true)
  const getUser = getTestAppDependencies().authentication.cognito.getUser
  let associations = 0
  overrideCognito({
    async getUser(accessToken) {
      return { ...await getUser(accessToken), PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA' }
    },
    async associateSoftwareToken() {
      associations += 1
      return { secretCode: 'JBSWY3DPEHPK3PXP' }
    },
  })

  const response = await sendJson('/api/auth/mfa/totp/associate', {}, 'test-token')

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('MfaAlreadyEnabled')
  expect(associations).toBe(0)
})

test('rejects a wrong authenticator code', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async verifySoftwareToken() {
      throw new CognitoServiceError(400, 'CodeMismatchException', 'Invalid code.')
    },
    async setSoftwareTokenMfaEnabled() {
      throw new Error('MFA must not be enabled after a wrong code.')
    },
  })

  const response = await sendJson('/api/auth/mfa/totp/verify', { code: '111111' }, 'test-token')

  expect(response.status).toBe(400)
  expect((await response.json()).code).toBe('MfaCodeInvalid')
})

test('keeps TOTP on while the policy requires MFA and turns it off otherwise', async () => {
  configureFakeProjectClients(true)
  const preferences: boolean[] = []
  overrideCognito({
    async setSoftwareTokenMfaEnabled(_accessToken, enabled) {
      preferences.push(enabled)
    },
  })

  await installSecurityPolicy('required')
  const required = await app.request('/api/auth/mfa/totp', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  })
  // The required policy also rejects the password-only test session itself.
  expect([403, 409]).toContain(required.status)

  await installSecurityPolicy('optional')
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const stale = await app.request('/api/auth/mfa/totp', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${createAccessTokenSignedInAt(nowSeconds - 16 * 60)}` },
  })
  expect(stale.status).toBe(403)
  expect((await stale.json()).code).toBe('RecentSignInRequired')

  const optional = await app.request('/api/auth/mfa/totp', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${createAccessTokenSignedInAt(nowSeconds - 60)}` },
  })
  expect(optional.status).toBe(204)
  expect(preferences).toEqual([false])
})

test('lets a guest remove their own authenticator', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })
  const preferences: boolean[] = []
  overrideCognito({
    async setSoftwareTokenMfaEnabled(_accessToken, enabled) {
      preferences.push(enabled)
    },
  })
  await installSecurityPolicy('optional')

  const response = await app.request('/api/auth/mfa/totp', {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${createAccessTokenSignedInAt(Math.floor(Date.now() / 1_000) - 60)}`,
    },
  })

  expect(response.status).toBe(204)
  expect(preferences).toEqual([false])
})

/**
 * Builds an unsigned test access token whose sign-in happened at the given time.
 *
 * @param authTimeSeconds - Sign-in time in epoch seconds.
 * @returns The token.
 */
function createAccessTokenSignedInAt(authTimeSeconds: number) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      auth_time: authTimeSeconds,
      iat: authTimeSeconds,
      exp: authTimeSeconds + 3_600,
      token_use: 'access',
    })).toString('base64url'),
    'test-signature',
  ].join('.')
}

test('changes the password after checking the current one', async () => {
  configureFakeProjectClients(true)
  const changes: Array<[string, string, string]> = []
  overrideCognito({
    async changePassword(accessToken, previousPassword, proposedPassword) {
      changes.push([accessToken, previousPassword, proposedPassword])
      if (previousPassword !== 'Current123!') {
        throw new CognitoServiceError(400, 'NotAuthorizedException', 'Incorrect username or password.')
      }
    },
  })

  const wrong = await sendJson('/api/auth/password/change', {
    currentPassword: 'Wrong123!',
    newPassword: 'NewPassword123!',
  }, 'test-token')
  const changed = await sendJson('/api/auth/password/change', {
    currentPassword: 'Current123!',
    newPassword: 'NewPassword123!',
  }, 'test-token')

  expect(wrong.status).toBe(400)
  expect((await wrong.json()).code).toBe('CurrentPasswordIncorrect')
  expect(changed.status).toBe(204)
  expect(changes).toHaveLength(2)
})

test('refuses a password change once the email domain enforces SSO', async () => {
  await withTestEnvironment({
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
  }, async () => {
    configureFakeProjectClients(true)
    const changes: string[] = []
    overrideCognito({
      async changePassword(accessToken) {
        changes.push(accessToken)
      },
    })
    const timestamp = new Date().toISOString()
    const identity = new InMemoryEnterpriseIdentityClient()
    // The password sign-in predates the domain's SSO enforcement, so its token is not an SSO one.
    identity.discoverSso = async (email) => email.endsWith('@example.com')
      ? {
          provider: {
            workspaceId,
            providerId: 'idp-enforced',
            kind: 'oidc',
            displayName: 'Enterprise SSO',
            cognitoProviderName: 'EnterpriseOidc',
            status: 'active',
            revision: 1,
            issuer: 'https://idp.example.com',
            clientId: 'enterprise-client',
            authorizationEndpoint: 'https://idp.example.com/authorize',
            tokenEndpoint: 'https://idp.example.com/token',
            jwksUri: 'https://idp.example.com/jwks',
            scopes: ['openid', 'email'],
            createdAt: timestamp,
            updatedAt: timestamp,
            lastTestedAt: timestamp,
          },
          domain: {
            workspaceId,
            domainId: 'example-com',
            domain: 'example.com',
            status: 'verified',
            revision: 1,
            verificationRecordName: '_mukuroji-challenge.example.com',
            verifiedAt: timestamp,
            enforceSso: true,
            identityProviderId: 'idp-enforced',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }
      : undefined
    setTestAppDependencies({ enterpriseIdentity: identity })

    const response = await sendJson('/api/auth/password/change', {
      currentPassword: 'Current123!',
      newPassword: 'NewPassword123!',
    }, 'test-token')

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('PasswordManagedBySso')
    expect(changes).toEqual([])
  })
})

test('lists the MFA state of active members for administrators', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async getUserProfile(userId) {
      const profile = createFakeCognitoProfile(userId)
      if (userId === 'sato@example.com') return { ...profile, mfaConfigured: true, softwareTokenMfaConfigured: true }
      // SMS or email MFA from an existing user pool is not an authenticator app.
      if (userId === 'suzuki@example.com') return { ...profile, mfaConfigured: true, softwareTokenMfaConfigured: false }
      if (userId === 'viewer@example.com') return { ...profile, status: 'FORCE_CHANGE_PASSWORD' }
      return { ...profile, mfaConfigured: false, softwareTokenMfaConfigured: false }
    },
  })

  const response = await app.request('/api/workspace/members/sign-in-security', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    members: [
      { memberKey: 'demo@example.com', mfa: 'not-enrolled', passwordReset: 'available' },
      { memberKey: 'sato@example.com', mfa: 'enrolled', passwordReset: 'available' },
      { memberKey: 'suzuki@example.com', mfa: 'not-enrolled', passwordReset: 'available' },
      { memberKey: 'viewer@example.com', mfa: 'not-enrolled', passwordReset: 'invitation-pending' },
    ],
  })
})

test.each([
  ['workspace:member', 403],
  ['workspace:admin', 200],
] as const)('lets only administrators list sign-in security under a %s role assignment', async (roleId, status) => {
  configureFakeProjectClients(true)
  const identity = new InMemoryEnterpriseIdentityClient()
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (currentWorkspaceId) => ({
    ...await readSnapshot(currentWorkspaceId),
    // An assigned role replaces the legacy owner role, and members.read alone is not enough.
    roleAssignments: [{
      workspaceId,
      assignmentId: 'demo-workspace-role',
      principalKind: 'member',
      principalId: 'demo@example.com',
      roleId,
      scope: { workspaceId, kind: 'workspace' },
      source: 'direct',
    }],
  })
  setTestAppDependencies({ enterpriseIdentity: identity })

  const response = await app.request('/api/workspace/members/sign-in-security', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(status)
})

test('records the administrator password reset and signs the member out around the Cognito reset', async () => {
  configureFakeProjectClients(true)
  const events: string[] = []
  const recorded: Array<{
    actor: string
    target: string
    action: WorkspaceMemberCredentialAction
    auditContext?: MutationAuditContext
  }> = []
  overrideWorkspaceAccess({
    async recordMemberCredentialAction(_workspaceId, actor, target, action, auditContext) {
      events.push('audit')
      recorded.push({ actor, target, action, auditContext })
      const member = (await getTestAppDependencies().workspace.workspaceAccess.getMember(workspaceId, target))!
      return { member, alreadyRecorded: false, completed: false }
    },
    async revokeMemberSignIns(revokedWorkspaceId, memberKey) {
      events.push(`revoke:${revokedWorkspaceId}:${memberKey}`)
    },
  })
  overrideCognito({
    async adminResetUserPassword(userId) {
      events.push(`reset:${userId}`)
    },
    async globallySignOutWorkspaceUser(userId) {
      events.push(`sign-out:${userId}`)
    },
  })

  const response = await sendJson('/api/workspace/members/sato%40example.com/password-reset', {}, 'test-token')

  expect(response.status).toBe(202)
  // SSO sessions that the API verifies itself are refused from the sign-out on as well.
  expect(events).toEqual([
    'audit',
    `revoke:${workspaceId}:sato@example.com`,
    'sign-out:sato@example.com',
    'reset:sato@example.com',
    `revoke:${workspaceId}:sato@example.com`,
    'sign-out:sato@example.com',
  ])
  expect(recorded[0]).toMatchObject({
    actor: 'demo@example.com',
    target: 'sato@example.com',
    action: 'password-reset-requested',
  })
  expect(recorded[0].auditContext?.workspaceId).toBe(workspaceId)
})

test('does not reset a password when the deployment cannot sign the member out first', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async adminResetUserPassword() {
      throw new Error('The password must not be reset without signing the member out first.')
    },
    globallySignOutWorkspaceUser: undefined,
  })
  overrideWorkspaceAccess({
    async recordMemberCredentialAction() {
      throw new Error('Nothing must be recorded when the reset cannot run.')
    },
  })

  const response = await sendJson('/api/workspace/members/sato%40example.com/password-reset', {}, 'test-token')

  expect(response.status).toBe(503)
})

test('does not reset the password of a member who has not accepted the invitation', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async getUserProfile(userId) {
      return { ...createFakeCognitoProfile(userId), status: 'FORCE_CHANGE_PASSWORD' }
    },
    async adminResetUserPassword() {
      throw new Error('Cognito must not be called for a pending invitation.')
    },
    async globallySignOutWorkspaceUser() {
      throw new Error('Cognito must not be called for a pending invitation.')
    },
  })
  overrideWorkspaceAccess({
    async recordMemberCredentialAction() {
      throw new Error('Nothing must be recorded for a pending invitation.')
    },
  })

  const response = await sendJson('/api/workspace/members/sato%40example.com/password-reset', {}, 'test-token')

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('MemberInvitationPending')
})

test('resets the authenticator of a member who lost it', async () => {
  configureFakeProjectClients(true)
  const resets: string[] = []
  const actions: WorkspaceMemberCredentialAction[] = []
  overrideCognito({
    async getUserProfile(userId) {
      return { ...createFakeCognitoProfile(userId), mfaConfigured: true, softwareTokenMfaConfigured: true }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
    },
  })
  overrideWorkspaceAccess({
    async recordMemberCredentialAction(_workspaceId, _actor, target, action) {
      actions.push(action)
      const member = (await getTestAppDependencies().workspace.workspaceAccess.getMember(workspaceId, target))!
      return { member, alreadyRecorded: false, completed: false }
    },
  })

  const response = await sendJson('/api/workspace/members/sato%40example.com/mfa-reset', {}, 'test-token')

  expect(response.status).toBe(200)
  expect(actions).toEqual(['mfa-reset'])
  expect(resets).toEqual(['sato@example.com'])
})


test('refuses an authenticator reset when the store cannot mark the change as started', async () => {
  configureFakeProjectClients(true)
  const resets: string[] = []
  overrideCognito({
    async getUserProfile(userId) {
      return { ...createFakeCognitoProfile(userId), mfaConfigured: true, softwareTokenMfaConfigured: true }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
    },
  })
  trackCredentialActionProgress()
  const { markMemberCredentialActionApplying: _omitted, ...withoutApplying } =
    getTestAppDependencies().workspace.workspaceAccess
  setTestAppDependencies({ workspaceAccess: withoutApplying })

  const response = await sendMfaResetWithKey()

  expect(response.status).toBe(503)
  expect(resets).toEqual([])
})
/**
 * Replaces the credential action store with one that keeps progress per idempotency key.
 *
 * @returns The progress of each idempotency key hash.
 */
function trackCredentialActionProgress() {
  const progress = new Map<string, 'recorded' | 'applying' | 'completed'>()
  const keyOf = (auditContext?: MutationAuditContext) => auditContext?.idempotencyKeyHash ?? ''
  overrideWorkspaceAccess({
    async readMemberCredentialActionProgress(_workspaceId, _target, _action, auditContext) {
      const current = progress.get(keyOf(auditContext))
      return current === 'applying' ? 'recorded' : current ?? 'none'
    },
    async recordMemberCredentialAction(_workspaceId, _actor, target, _action, auditContext) {
      const current = progress.get(keyOf(auditContext))
      // Like the store once the lease ran out: an attempt that started changing Cognito is not
      // repeated.
      if (current === 'applying') {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceCredentialActionExpired',
          'The earlier request stopped before it finished.',
        )
      }
      if (!current) progress.set(keyOf(auditContext), 'recorded')
      const member = (await getTestAppDependencies().workspace.workspaceAccess.getMember(workspaceId, target))!
      return { member, alreadyRecorded: current !== undefined, completed: current === 'completed' }
    },
    async markMemberCredentialActionApplying(_workspaceId, _target, _action, auditContext) {
      progress.set(keyOf(auditContext), 'applying')
    },
    async completeMemberCredentialAction(_workspaceId, _target, _action, auditContext) {
      progress.set(keyOf(auditContext), 'completed')
    },
  })
  return progress
}

/**
 * Sends an administrator authenticator reset with a fixed idempotency key.
 *
 * @returns The response.
 */
function sendMfaResetWithKey() {
  return app.request('/api/workspace/members/sato%40example.com/mfa-reset', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'mfa-reset-retry-1',
    },
    body: '{}',
  })
}

test('does not repeat an authenticator reset that stopped after it started changing Cognito', async () => {
  configureFakeProjectClients(true)
  let mfaEnrolled = true
  const resets: string[] = []
  overrideCognito({
    async getUserProfile(userId) {
      return {
        ...createFakeCognitoProfile(userId),
        mfaConfigured: mfaEnrolled,
        softwareTokenMfaConfigured: mfaEnrolled,
      }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
      mfaEnrolled = false
      if (resets.length === 1) throw new Error('Connection lost after Cognito removed the app.')
    },
  })
  const progress = trackCredentialActionProgress()

  expect((await sendMfaResetWithKey()).status).toBe(500)
  // The member registers a new app before the same request arrives again.
  mfaEnrolled = true
  const retry = await sendMfaResetWithKey()

  // The first attempt may already have removed the app, so the retry asks the administrator to
  // check the member instead of removing the new app.
  expect(retry.status).toBe(409)
  expect((await retry.json()).code).toBe('WorkspaceCredentialActionExpired')
  expect(resets).toEqual(['sato@example.com'])
  expect([...progress.values()]).toEqual(['applying'])
})

test('keeps an app registered after a reset whose completion mark failed', async () => {
  configureFakeProjectClients(true)
  const resets: string[] = []
  let appRegistered = true
  overrideCognito({
    async getUserProfile(userId) {
      return {
        ...createFakeCognitoProfile(userId),
        mfaConfigured: appRegistered,
        softwareTokenMfaConfigured: appRegistered,
      }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
      appRegistered = false
    },
  })
  trackCredentialActionProgress()
  overrideWorkspaceAccess({
    async completeMemberCredentialAction() {
      throw new Error('DynamoDB is unavailable.')
    },
  })

  expect((await sendMfaResetWithKey()).status).toBe(200)
  expect(appRegistered).toBe(false)
  // The member registers a new app, and the same request arrives again.
  appRegistered = true
  const replay = await sendMfaResetWithKey()

  expect(replay.status).toBe(409)
  expect((await replay.json()).code).toBe('WorkspaceCredentialActionExpired')
  expect(resets).toEqual(['sato@example.com'])
  expect(appRegistered).toBe(true)
})

test('does not remove an authenticator registered after a completed reset when the request is replayed', async () => {
  configureFakeProjectClients(true)
  const resets: string[] = []
  let appRegistered = true
  overrideCognito({
    async getUserProfile(userId) {
      return {
        ...createFakeCognitoProfile(userId),
        mfaConfigured: appRegistered,
        softwareTokenMfaConfigured: appRegistered,
      }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
      appRegistered = false
    },
  })
  trackCredentialActionProgress()

  expect((await sendMfaResetWithKey()).status).toBe(200)
  expect(appRegistered).toBe(false)
  // The member registers a new app, and the same request arrives again.
  appRegistered = true
  const replay = await sendMfaResetWithKey()

  expect(replay.status).toBe(200)
  expect(resets).toEqual(['sato@example.com'])
  expect(appRegistered).toBe(true)
})

test('does not report SMS-only MFA as an authenticator that an administrator can reset', async () => {
  configureFakeProjectClients(true)
  const resets: string[] = []
  overrideCognito({
    async getUserProfile(userId) {
      return { ...createFakeCognitoProfile(userId), mfaConfigured: true, softwareTokenMfaConfigured: false }
    },
    async adminDisableSoftwareTokenMfa(userId) {
      resets.push(userId)
    },
  })
  trackCredentialActionProgress()

  const response = await sendMfaResetWithKey()

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('MemberMfaNotEnrolled')
  expect(resets).toEqual([])
})

test('denies member credential resets to non-administrators', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })
  overrideCognito({
    async adminResetUserPassword() {
      throw new Error('Cognito must not be called without administration rights.')
    },
  })

  const response = await sendJson('/api/workspace/members/sato%40example.com/password-reset', {}, 'test-token')

  expect(response.status).toBe(403)
})

test('previews how many active members must register an authenticator before MFA is required', async () => {
  configureFakeProjectClients(true)
  await installSecurityPolicy('optional')
  overrideCognito({
    async getUserProfile(userId) {
      return {
        ...createFakeCognitoProfile(userId),
        // Sign-in lets a member with SMS MFA through without the authenticator setup.
        mfaConfigured: userId === 'demo@example.com' || userId === 'suzuki@example.com',
        softwareTokenMfaConfigured: userId === 'demo@example.com',
      }
    },
  })

  const response = await sendJson('/api/enterprise/security/policy/preview', {
    expectedVersion: 1,
    ipAllowlist: [],
    mfaRequired: true,
  }, 'test-token')

  expect(response.status).toBe(200)
  expect((await response.json()).impact.mfaImpact).toEqual({
    activeMemberCount: 4,
    unenrolledMemberCount: 2,
    unknownMemberCount: 0,
  })
})
