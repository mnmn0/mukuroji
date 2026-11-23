import {
  createApiTestHarness,
  type ObservedWorkspaceMutationAuditContext,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createFakeAuthTokenSet,
  createWorkspaceAccessFake,
  expectStableWorkspaceMutationAuditContexts,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  CognitoServiceError,
} from '../..'
import {
  WorkspaceAccessError,
  type WorkspaceAccessClient,
} from '../../../workspace-access/workspace-access'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../../enterprise-identity/enterprise-identity'
import type { AuditEventV1 } from '../../../audit'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('returns a NEW_PASSWORD_REQUIRED challenge without creating a session', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthChallenge: true })

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Temporary123!' }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'NEW_PASSWORD_REQUIRED',
    email: 'demo@example.com',
    session: 'new-password-session',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('returns a supported MFA challenge without attempting Workspace reconciliation', async () => {
  const calls = configureFakeProjectClients(true, {
    passwordMfaChallenge: 'SMS_MFA',
  })

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mfa-login@example.com', password: 'Password123!' }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'SMS_MFA',
    deliveryDestination: '***-***-1234',
    deliveryMedium: 'SMS',
    email: 'mfa-login@example.com',
    session: 'mfa-session',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('rechecks enforced SSO before completing password and MFA challenges', async () => {
  await withTestEnvironment({
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
  }, async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeTokens: true,
    mfaChallengeTokens: true,
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const timestamp = new Date().toISOString()
  const provider = {
    workspaceId: 'user#demo@example.com',
    providerId: 'idp-enforced',
    kind: 'oidc' as const,
    displayName: 'Enterprise SSO',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active' as const,
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
  }
  identity.discoverSso = async (email) =>
    email.toLowerCase().endsWith('@managed.example')
      ? {
          provider,
          domain: {
            workspaceId: 'user#demo@example.com',
            domainId: 'managed-example',
            domain: 'managed.example',
            status: 'verified',
            revision: 1,
            verificationRecordName: '_mukuroji-challenge.managed.example',
            verifiedAt: timestamp,
            enforceSso: true,
            identityProviderId: provider.providerId,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }
      : undefined
  setTestAppDependencies({
    enterpriseIdentity: identity,
    enterpriseSessionActivity: {
      async getAuthenticationMethods() {
        return []
      },
      async recordAuthenticationAssurance() {
        return undefined
      },
      async validateAndTouch(input) {
        return [...input.authenticationMethods]
      },
    },
  })

  const newPassword = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'person@managed.example',
      newPassword: 'NewPassword123!',
      session: 'challenge-before-enforcement',
    }),
  })
  const managedMfa = await app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'person@managed.example',
      challenge: 'SOFTWARE_TOKEN_MFA',
      code: '123456',
      session: 'challenge-before-enforcement',
    }),
  })
  const recoveryMfa = await app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'recovery@outside.example',
      challenge: 'SOFTWARE_TOKEN_MFA',
      code: '123456',
      session: 'local-recovery-session',
    }),
  })

  expect(newPassword.status).toBe(409)
  expect(await newPassword.json()).toMatchObject({ code: 'SsoRequired' })
  expect(managedMfa.status).toBe(409)
  expect(await managedMfa.json()).toMatchObject({ code: 'SsoRequired' })
  expect(recoveryMfa.status).toBe(200)
  expect(calls.mfaChallenges).toEqual([{
    challenge: 'SOFTWARE_TOKEN_MFA',
    code: '123456',
    email: 'recovery@outside.example',
    session: 'local-recovery-session',
  }])
  })
})

test('completes an MFA challenge and binds server-verified assurance to the access token', async () => {
  const calls = configureFakeProjectClients(true, { mfaChallengeTokens: true })
  const assurances: string[][] = []
  setTestAppDependencies({
    enterpriseSessionActivity: {
      async getAuthenticationMethods() {
        return []
      },
      async recordAuthenticationAssurance(input) {
        assurances.push([...input.authenticationMethods])
      },
      async validateAndTouch(input) {
        return [...input.authenticationMethods]
      },
    },
  })

  const response = await app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      challenge: 'SOFTWARE_TOKEN_MFA',
      code: '123456',
      session: 'mfa-session',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.mfaChallenges).toEqual([{
    challenge: 'SOFTWARE_TOKEN_MFA',
    code: '123456',
    email: 'demo@example.com',
    session: 'mfa-session',
  }])
  expect(assurances).toEqual([['SOFTWARE_TOKEN_MFA']])
})

test('rejects malformed MFA codes before calling Cognito', async () => {
  const calls = configureFakeProjectClients(true, { mfaChallengeTokens: true })

  const response = await app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'invalid-mfa@example.com',
      challenge: 'SMS_OTP',
      code: '12-ab',
      session: 'mfa-session',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidMfaChallenge' })
  expect(calls.mfaChallenges).toEqual([])
})

test('rate limits repeated MFA verification attempts by transport and email', async () => {
  configureFakeProjectClients(true)
  const createRequest = () => app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'rate-limit-mfa@example.com',
      challenge: 'EMAIL_OTP',
      code: '123456',
      session: 'mfa-session',
    }),
  })

  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await createRequest()).status).toBe(409)
  }
  const limited = await createRequest()
  expect(limited.status).toBe(429)
  expect(limited.headers.get('Retry-After')).toBeTruthy()
  expect(await limited.json()).toMatchObject({
    code: 'AuthenticationChallengeRateLimited',
  })
})

test('counts MFA verification attempts per CloudFront viewer address, not per edge', async () => {
  configureFakeProjectClients(true)
  const edgeSecret = 'edge-secret-0123456789abcdef0123456789abcdef'
  await withTestEnvironment({ MUKUROJI_EDGE_ORIGIN_SECRET: edgeSecret }, async () => {
    const createRequest = (viewerAddress: string) => app.request('/api/auth/challenge/mfa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mukuroji-edge-secret': edgeSecret,
        'x-mukuroji-viewer-address': viewerAddress,
      },
      body: JSON.stringify({
        email: 'edge-rate-limit-mfa@example.com',
        challenge: 'EMAIL_OTP',
        code: '123456',
        session: 'mfa-session',
      }),
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await createRequest('203.0.113.20')).status).toBe(409)
    }
    expect((await createRequest('203.0.113.20')).status).toBe(429)
    // Spoofing a forwarded header without the origin secret does not reset the count.
    expect((await app.request('/api/auth/challenge/mfa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mukuroji-edge-secret': edgeSecret,
        'x-mukuroji-viewer-address': '203.0.113.20',
        'X-Forwarded-For': '198.51.100.99',
      },
      body: JSON.stringify({
        email: 'edge-rate-limit-mfa@example.com',
        challenge: 'EMAIL_OTP',
        code: '123456',
        session: 'mfa-session',
      }),
    })).status).toBe(429)
    // Another viewer behind the same CloudFront edge keeps its own count.
    expect((await createRequest('203.0.113.21')).status).toBe(409)
  })
})

test('returns a stable error when a new password violates the Cognito policy', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeError: new CognitoServiceError(
      400,
      'InvalidPasswordException',
      'Password did not conform with policy.',
    ),
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'weak',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidNewPassword',
    message: 'New password does not meet the password policy.',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('holds the invitation acceptance lock across the Cognito password challenge', async () => {
  const sequence: string[] = []
  const auditContexts: ObservedWorkspaceMutationAuditContext[] = []
  const lockArgumentCounts: number[] = []
  const invitation = {
    id: 'invitee@example.com',
    email: 'invitee@example.com',
    role: 'member' as const,
    status: 'pending' as const,
    deliveryStatus: 'sent' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-invitee',
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    acceptanceLockExpiresAt: '2026-07-11T00:01:00.000Z',
  }
  setTestAppDependencies({
    cognito: {
      async findWorkspaceUser() {
        sequence.push('find-user')
        return {
          profile: {
            id: 'invitee@example.com',
            username: 'InviteeIdentity',
            email: 'invitee@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-invitee',
          directoryId: 'workspace#production',
        }
      },
      async respondToNewPasswordChallenge() {
        sequence.push('complete-challenge')
        return { AuthenticationResult: createFakeAuthTokenSet() }
      },
      async getUser() {
        sequence.push('get-user')
        return {
          Username: 'InviteeIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'invitee@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember() {
        sequence.push('get-active-member')
        return undefined
      },
      async acquireInvitationAcceptanceLock(...args: unknown[]) {
        sequence.push('acquire-lock')
        lockArgumentCounts.push(args.length)
        return invitation
      },
      async releaseInvitationAcceptanceLock(...args: unknown[]) {
        sequence.push('release-lock')
        lockArgumentCounts.push(args.length)
        return {
          ...invitation,
          acceptanceLockExpiresAt: undefined,
          version: 3,
        }
      },
      async reconcileAuthenticatedMember(
        _workspaceId,
        input,
        auditContext,
      ) {
        sequence.push('reconcile-member')
        auditContexts.push({ stage: 'reconcileAuthenticatedMember', context: auditContext })
        return {
          id: input.memberKey,
          memberKey: input.memberKey,
          email: 'invitee@example.com',
          role: 'member',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    },
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-challenge-1',
      'X-Correlation-Id': 'workspace-challenge-correlation',
    },
    body: JSON.stringify({
      email: 'invitee@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(200)
  expect(sequence).toEqual([
    'find-user',
    'get-active-member',
    'acquire-lock',
    'complete-challenge',
    'get-user',
    'reconcile-member',
    'release-lock',
  ])
  expectStableWorkspaceMutationAuditContexts(auditContexts, {
    actorId: 'sub-invitee',
    clientCorrelationId: 'workspace-challenge-correlation',
    idempotencyKey: 'workspace-challenge-1',
    method: 'POST',
    requestBody: { email: 'invitee@example.com' },
    route: '/api/auth/challenge/new-password',
    stages: ['reconcileAuthenticatedMember'],
    workspaceId: 'workspace#production',
  })
  // The lock runs before Cognito proves the session, so the route passes no audit context to it.
  expect(lockArgumentCounts).toEqual([2, 3])
})

test('lets an active Workspace member complete a new password challenge without an invitation lock', async () => {
  const sequence: string[] = []
  const activeMember = {
    id: 'member@example.com',
    memberKey: 'member@example.com',
    email: 'member@example.com',
    role: 'member' as const,
    status: 'active' as const,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  setTestAppDependencies({
    cognito: {
      async findWorkspaceUser() {
        sequence.push('find-user')
        return {
          profile: {
            id: 'member@example.com',
            username: 'ExistingMemberIdentity',
            email: 'member@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-existing-member',
          directoryId: 'workspace#production',
        }
      },
      async respondToNewPasswordChallenge() {
        sequence.push('complete-challenge')
        return { AuthenticationResult: createFakeAuthTokenSet() }
      },
      async getUser() {
        sequence.push('get-user')
        return {
          Username: 'ExistingMemberIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'member@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember() {
        sequence.push('get-active-member')
        return activeMember
      },
      async acquireInvitationAcceptanceLock() {
        sequence.push('acquire-lock')
        throw new Error('Active members must not acquire an invitation acceptance lock.')
      },
      async releaseInvitationAcceptanceLock() {
        sequence.push('release-lock')
        throw new Error('No invitation acceptance lock should be released.')
      },
      async reconcileAuthenticatedMember() {
        sequence.push('reconcile-member')
        return activeMember
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'member@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(200)
  expect(sequence).toEqual([
    'find-user',
    'get-active-member',
    'complete-challenge',
    'get-user',
    'reconcile-member',
  ])
})

/**
 * Wires a pending invitee whose Cognito challenge fails, recording each dependency call in order.
 *
 * @param options - Invitee email, call log, and the errors the lock or Cognito should throw.
 */
function configureNewPasswordChallengeInvitee(options: {
  email: string
  sequence: string[]
  acquireError?: Error
  challengeError?: Error
}) {
  const invitation = {
    id: options.email,
    email: options.email,
    role: 'member' as const,
    status: 'pending' as const,
    deliveryStatus: 'sent' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-invitee',
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    acceptanceLockExpiresAt: '2026-07-11T00:01:00.000Z',
  }
  setTestAppDependencies({
    cognito: {
      async findWorkspaceUser() {
        options.sequence.push('find-user')
        return {
          profile: {
            id: options.email,
            username: 'InviteeIdentity',
            email: options.email,
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-invitee',
          directoryId: 'workspace#production',
        }
      },
      async respondToNewPasswordChallenge() {
        options.sequence.push('complete-challenge')
        throw options.challengeError ??
          new CognitoServiceError(400, 'NotAuthorizedException', 'Invalid session for the user.')
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember() {
        options.sequence.push('get-active-member')
        return undefined
      },
      async acquireInvitationAcceptanceLock() {
        options.sequence.push('acquire-lock')
        if (options.acquireError) throw options.acquireError
        return invitation
      },
      async releaseInvitationAcceptanceLock() {
        options.sequence.push('release-lock')
        return { ...invitation, acceptanceLockExpiresAt: undefined, version: 3 }
      },
    },
  })
}

/**
 * Sends a new-password challenge request for the given email.
 *
 * @param email - Email address to send.
 * @param session - Challenge session to send; defaults to a forged value.
 * @returns The HTTP response.
 */
function requestNewPasswordChallenge(email: string, session = 'forged-session') {
  return app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, newPassword: 'Permanent123!', session }),
  })
}

test('releases the invitation lock when Cognito rejects a forged session', async () => {
  const sequence: string[] = []
  configureNewPasswordChallengeInvitee({
    email: 'forged-session@example.com',
    sequence,
  })

  const response = await requestNewPasswordChallenge('forged-session@example.com')

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ message: 'Invalid email or password.' })
  expect(sequence).toEqual([
    'find-user',
    'get-active-member',
    'acquire-lock',
    'complete-challenge',
    'release-lock',
  ])
})

test('answers a revoked or busy invitation like a rejected session before calling Cognito', async () => {
  for (const [email, code] of [
    ['revoked-invitee@example.com', 'WorkspaceInvitationNotAcceptable'],
    ['busy-invitee@example.com', 'WorkspaceInvitationAcceptanceInProgress'],
  ] as const) {
    const sequence: string[] = []
    configureNewPasswordChallengeInvitee({
      email,
      sequence,
      acquireError: new WorkspaceAccessError(409, code, 'Hidden invitation state.'),
    })

    const response = await requestNewPasswordChallenge(email)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Invalid email or password.' })
    expect(sequence).toEqual(['find-user', 'get-active-member', 'acquire-lock'])
  }
})

test('rate limits new password attempts before touching the invitation', async () => {
  const sequence: string[] = []
  configureNewPasswordChallengeInvitee({ email: 'rate-limit-invitee@example.com', sequence })

  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await requestNewPasswordChallenge('Rate-Limit-Invitee@example.com')).status).toBe(401)
  }
  sequence.length = 0
  const limited = await requestNewPasswordChallenge('rate-limit-invitee@example.com')

  expect(limited.status).toBe(429)
  expect(limited.headers.get('Retry-After')).toBeTruthy()
  expect(await limited.json()).toMatchObject({ code: 'AuthenticationChallengeRateLimited' })
  expect(sequence).toEqual([])
})

test('retries membership reconcile on normal login after password completion succeeded alone', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeTokens: true,
    passwordAuthTokens: true,
    workspaceReconcileFailures: 1,
  })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-challenge-reconcile-1',
      'X-Correlation-Id': 'workspace-challenge-reconcile-correlation',
    },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(503)

  const loginResponse = await app.request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-login-reconcile-1',
      'X-Correlation-Id': 'workspace-login-reconcile-correlation',
    },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Permanent123!' }),
  })

  expect(loginResponse.status).toBe(200)
  expect(await loginResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual([
    'demo@example.com',
    'demo@example.com',
  ])
  expectStableWorkspaceMutationAuditContexts(
    calls.workspaceMutationAuditContexts.slice(0, 1),
    {
      actorId: 'sub-demo@example.com',
      clientCorrelationId: 'workspace-challenge-reconcile-correlation',
      idempotencyKey: 'workspace-challenge-reconcile-1',
      method: 'POST',
      requestBody: { email: 'demo@example.com' },
      route: '/api/auth/challenge/new-password',
      stages: ['reconcileAuthenticatedMember'],
      workspaceId: 'user#demo@example.com',
    },
  )
  expectStableWorkspaceMutationAuditContexts(
    calls.workspaceMutationAuditContexts.slice(1),
    {
      actorId: 'demo@example.com',
      clientCorrelationId: 'workspace-login-reconcile-correlation',
      idempotencyKey: 'workspace-login-reconcile-1',
      method: 'POST',
      requestBody: { email: 'demo@example.com' },
      route: '/api/auth/login',
      stages: ['reconcileAuthenticatedMember'],
      workspaceId: 'user#demo@example.com',
    },
  )
})

/**
 * Replaces the audit event store with one that keeps written events in memory.
 *
 * @returns Events written during the test.
 */
function captureAuditEvents(): AuditEventV1[] {
  const written: AuditEventV1[] = []
  setTestAppDependencies({
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async putEvent(event) {
        written.push(event)
      },
      async query() {
        return { events: [] }
      },
    },
  })
  return written
}

test('records a completed sign-in in the Workspace audit log', async () => {
  configureFakeProjectClients(true, { mfaChallengeTokens: true })
  const written = captureAuditEvents()

  const response = await app.request('/api/auth/challenge/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', challenge: 'SOFTWARE_TOKEN_MFA', code: '123456', session: 'mfa-session' }),
  })

  expect(response.status).toBe(200)
  const signIns = written.filter((event) => event.eventType === 'auth.signed-in')
  expect(signIns).toHaveLength(1)
  expect(signIns[0]).toMatchObject({ entity: { type: 'sign-in' }, metadata: { authenticationMethods: ['SOFTWARE_TOKEN_MFA'] } })
  expect(JSON.stringify(signIns[0])).not.toContain('123456')
})

test('records repeated rejected sign-ins once per window without the address or password', async () => {
  configureFakeProjectClients(true)
  const written = captureAuditEvents()
  getTestAppDependencies().authentication.cognito.initiatePasswordAuth = async () => {
    throw new CognitoServiceError(400, 'NotAuthorizedException', 'Incorrect username or password.')
  }

  await withTestEnvironment({ MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production' }, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Guess@Example.com', password: `Wrong-${attempt}` }),
      })
      expect(response.status).toBe(401)
    }
  })

  const failures = written.filter((event) => event.eventType === 'auth.sign-in-failed')
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({
    workspaceId: 'workspace#production',
    actor: { kind: 'system' },
    metadata: { signInFailure: 'invalid-credentials', emailDomain: 'example.com' },
  })
  const serialized = JSON.stringify(failures[0])
  expect(serialized).not.toContain('guess@example.com')
  expect(serialized).not.toContain('Wrong-')
})
