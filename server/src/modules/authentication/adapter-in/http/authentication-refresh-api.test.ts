import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { CognitoServiceError } from '../..'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { InMemoryEnterpriseSessionActivityClient } from '../../../enterprise-identity/enterprise-session-activity'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Claims shared by every access token issued for one sign-in in these tests. */
const signInClaims = {
  sub: 'sub-demo',
  token_use: 'access',
  client_id: 'mukuroji-password-client',
  origin_jti: 'origin-1',
  auth_time: Math.floor(Date.now() / 1_000) - 7_200,
}

/**
 * Hashes an access token the way the API derives its session identifier.
 *
 * @param token - Access token.
 * @returns The base64url SHA-256 digest.
 */
function sessionIdOf(token: string) {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * Installs a Cognito fake whose refresh and revocation calls are recorded.
 *
 * @param refreshedAccessToken - Access token the refresh returns.
 * @param refreshError - Error the refresh throws instead.
 * @returns Recorded refresh and revocation calls.
 */
function configureRefreshingCognito(
  refreshedAccessToken: string,
  refreshError?: Error,
) {
  const calls = {
    refreshes: [] as Array<{ refreshToken: string; clientId?: string }>,
    revocations: [] as Array<{ refreshToken: string; clientId?: string }>,
  }
  setTestAppDependencies({
    cognito: {
      ...getTestAppDependencies().authentication.cognito,
      async refreshTokens(refreshToken: string, clientId?: string) {
        calls.refreshes.push({ refreshToken, ...(clientId ? { clientId } : {}) })
        if (refreshError) throw refreshError
        return {
          AuthenticationResult: {
            AccessToken: refreshedAccessToken,
            IdToken: 'refreshed-id-token',
            ExpiresIn: 3_600,
            TokenType: 'Bearer',
          },
        }
      },
      async revokeRefreshToken(refreshToken: string, clientId?: string) {
        calls.revocations.push({ refreshToken, ...(clientId ? { clientId } : {}) })
      },
    },
  })
  return calls
}

test('refreshes the access token and carries MFA assurance and idle activity to it', async () => {
  const calls = configureFakeProjectClients(true)
  const activity = new InMemoryEnterpriseSessionActivityClient()
  setTestAppDependencies({ enterpriseSessionActivity: activity })
  const previousAccessToken = createAccessToken([], { ...signInClaims, jti: 'access-1' })
  const refreshedAccessToken = createAccessToken([], { ...signInClaims, jti: 'access-2' })
  await activity.recordAuthenticationAssurance({
    workspaceId: 'user#demo@example.com',
    sessionId: sessionIdOf(previousAccessToken),
    authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    authenticatedAt: signInClaims.auth_time,
    expiresAt: signInClaims.auth_time + 3_600,
  })
  const cognito = configureRefreshingCognito(refreshedAccessToken)

  const response = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${previousAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refreshToken: 'refresh-1' }),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const body = await response.json()
  expect(body).toMatchObject({
    accessToken: refreshedAccessToken,
    idToken: 'refreshed-id-token',
    tokenType: 'Bearer',
  })
  expect(body.refreshToken).toBeUndefined()
  expect(cognito.refreshes).toEqual([{ refreshToken: 'refresh-1' }])
  expect(calls.workspaceReconciliations).toEqual(['demo@example.com'])
  expect(await activity.getAuthenticationMethods(
    'user#demo@example.com',
    sessionIdOf(refreshedAccessToken),
  )).toEqual(['SOFTWARE_TOKEN_MFA'])
  // The refresh is not user activity: the carried record keeps the sign-in time, so an idle
  // timeout shorter than the time since sign-in still applies to the refreshed token.
  await expect(activity.validateAndTouch({
    workspaceId: 'user#demo@example.com',
    sessionId: sessionIdOf(refreshedAccessToken),
    authenticatedAt: signInClaims.auth_time,
    now: Math.floor(Date.now() / 1_000),
    idleTimeoutMinutes: 60,
    sessionLifetimeMinutes: 480,
    authenticationMethods: [],
  })).rejects.toMatchObject({ code: 'EnterpriseSessionIdleTimeout' })
})

test('does not lend assurance from an access token of another sign-in', async () => {
  configureFakeProjectClients(true)
  const activity = new InMemoryEnterpriseSessionActivityClient()
  setTestAppDependencies({ enterpriseSessionActivity: activity })
  const otherSignInToken = createAccessToken([], {
    ...signInClaims,
    origin_jti: 'origin-other',
    jti: 'access-other',
  })
  const refreshedAccessToken = createAccessToken([], { ...signInClaims, jti: 'access-2' })
  await activity.recordAuthenticationAssurance({
    workspaceId: 'user#demo@example.com',
    sessionId: sessionIdOf(otherSignInToken),
    authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    authenticatedAt: signInClaims.auth_time,
    expiresAt: signInClaims.auth_time + 3_600,
  })
  configureRefreshingCognito(refreshedAccessToken)

  const response = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${otherSignInToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refreshToken: 'refresh-1' }),
  })

  expect(response.status).toBe(200)
  expect(await activity.getAuthenticationMethods(
    'user#demo@example.com',
    sessionIdOf(refreshedAccessToken),
  )).toEqual([])
})

test('refreshes an SSO session with the SSO app client', async () => {
  await withTestEnvironment({ COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client' }, async () => {
    configureFakeProjectClients(true)
    const ssoClaims = { ...signInClaims, client_id: 'mukuroji-sso-client' }
    const cognito = configureRefreshingCognito(
      createAccessToken([], { ...ssoClaims, jti: 'access-2' }),
    )

    const refresh = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAccessToken([], { ...ssoClaims, jti: 'access-1' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: 'sso-refresh' }),
    })

    expect(refresh.status).toBe(200)
    expect(cognito.refreshes).toEqual([
      { refreshToken: 'sso-refresh', clientId: 'mukuroji-sso-client' },
    ])
  })
})

test('ends a password session whose email domain now requires SSO', async () => {
  await withTestEnvironment({
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
  }, async () => {
    const calls = configureFakeProjectClients(true)
    const identity = new InMemoryEnterpriseIdentityClient()
    const discovered: string[] = []
    identity.discoverSso = async (email) => {
      discovered.push(email)
      const timestamp = new Date().toISOString()
      return {
        provider: {
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
        },
        domain: {
          workspaceId: 'user#demo@example.com',
          domainId: 'example',
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
    }
    setTestAppDependencies({ enterpriseIdentity: identity })
    configureRefreshingCognito(createAccessToken([], { ...signInClaims, jti: 'access-2' }))

    const response = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAccessToken([], { ...signInClaims, jti: 'access-1' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: 'password-refresh' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'SsoRequired' })
    expect(discovered).toEqual(['Demo@Example.com'])
    expect(calls.workspaceReconciliations).toEqual([])
  })
})

test('asks for a new sign-in when Cognito rejects the refresh token', async () => {
  configureFakeProjectClients(true)
  configureRefreshingCognito(
    'unused',
    new CognitoServiceError(400, 'NotAuthorizedException', 'Refresh Token has been revoked'),
  )

  const response = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'revoked-refresh' }),
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ code: 'RefreshTokenRejected' })
})

test('rejects a refresh request without a refresh token', async () => {
  const cognito = configureRefreshingCognito('unused')

  const response = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidRefreshRequest' })
  expect(cognito.refreshes).toEqual([])
})

test('revokes the refresh token on sign-out', async () => {
  await withTestEnvironment({ COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client' }, async () => {
    const cognito = configureRefreshingCognito('unused')

    const passwordSignOut = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAccessToken([], signInClaims)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: 'password-refresh' }),
    })
    const ssoSignOut = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAccessToken([], {
          ...signInClaims,
          client_id: 'mukuroji-sso-client',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: 'sso-refresh' }),
    })
    const missingToken = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(passwordSignOut.status).toBe(204)
    expect(ssoSignOut.status).toBe(204)
    expect(missingToken.status).toBe(400)
    expect(cognito.revocations).toEqual([
      { refreshToken: 'password-refresh' },
      { refreshToken: 'sso-refresh', clientId: 'mukuroji-sso-client' },
    ])
  })
})
