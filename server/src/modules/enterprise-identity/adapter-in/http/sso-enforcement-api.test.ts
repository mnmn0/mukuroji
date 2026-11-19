import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  createHash,
} from 'node:crypto'

afterEach(() => {
  resetTestApp()
})

test('rejects partial SSO configuration instead of falling back to password login', async () => {
  await withTestEnvironment({
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: '',
    COGNITO_ENTERPRISE_IDP_NAME: '',
    COGNITO_HOSTED_UI_DOMAIN: '',
    ENTERPRISE_SSO_STATE_SECRET: '',
  }, async () => {
    configureFakeProjectClients(true, { passwordAuthTokens: true })
    const discovery = await app.request('/api/auth/sso/discovery?email=demo%40example.com')
    expect(discovery.status).toBe(503)
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'Password123!' }),
    })
    expect(login.status).toBe(503)
    expect(await login.json()).toMatchObject({ code: 'EnterpriseSsoConfigurationIncomplete' })
  })
})

test('requires server-attested SSO for a user in an enforced domain', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
  }, async () => {
    const calls = configureFakeProjectClients(true)
    const workspaceId = 'user#demo@example.com'
    const providerId = 'idp-enforced'
    const providerRevision = 1
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    const provider = {
      workspaceId,
      providerId,
      kind: 'oidc' as const,
      displayName: 'Enterprise SSO',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active' as const,
      revision: providerRevision,
      issuer: 'https://idp.example.com',
      clientId: 'enterprise-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    }
    await identity.putIdentityProvider(provider)
    const domain = {
      workspaceId,
      domainId: 'example-com',
      domain: 'example.com',
      status: 'verified' as const,
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.example.com',
      verifiedAt: now,
      enforceSso: false,
      createdAt: now,
      updatedAt: now,
    }
    await identity.putVerifiedDomain(domain)
    const ssoAuthenticationMethod =
      `mukuroji:enterprise-sso-provider-sha256:${
        createHash('sha256').update(`${providerId}\0${providerRevision}`).digest('hex')
      }`
    let verifiedAuthenticationMethods: string[] = []
    setTestAppDependencies({
      enterpriseIdentity: identity,
      enterpriseSessionActivity: {
        async getAuthenticationMethods() {
          return [...verifiedAuthenticationMethods]
        },
        async recordAuthenticationAssurance() {
          return undefined
        },
        async validateAndTouch(input) {
          return [...input.authenticationMethods]
        },
        async isSignInRevoked() {
          return false
        },
      },
    })
    const mainAccessToken = createAccessToken([], {
      'cognito:amr': [ssoAuthenticationMethod],
      client_id: 'mukuroji-main-client',
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
    })
    const ssoAccessToken = createAccessToken([], {
      client_id: 'mukuroji-sso-client',
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
    })
    const requestCurrentUser = (accessToken: string) => app.request('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    const nonEnforced = await requestCurrentUser(mainAccessToken)
    expect(nonEnforced.status).toBe(200)

    await identity.putVerifiedDomain({
      ...domain,
      revision: 2,
      enforceSso: true,
      identityProviderId: providerId,
    })

    const discoveries = await Promise.all([
      app.request('/api/auth/sso/discovery?email=demo%40example.com'),
      app.request('/api/auth/sso/discovery?email=demo%40example.com'),
    ])
    expect(discoveries.map((response) => response.status)).toEqual([200, 200])

    const forgedClaim = await requestCurrentUser(mainAccessToken)
    expect(forgedClaim.status).toBe(403)
    expect(await forgedClaim.json()).toEqual({
      code: 'EnterpriseSsoSessionRequired',
      message: 'Single sign-on is required for this Workspace account.',
    })

    verifiedAuthenticationMethods = [ssoAuthenticationMethod]
    const wrongClient = await requestCurrentUser(mainAccessToken)
    expect(wrongClient.status).toBe(403)
    const serverAttested = await requestCurrentUser(ssoAccessToken)
    expect(serverAttested.status).toBe(200)

    await identity.putIdentityProvider({
      ...provider,
      revision: providerRevision + 1,
    })
    const staleProviderRevision = await requestCurrentUser(ssoAccessToken)
    expect(staleProviderRevision.status).toBe(403)
    expect(await staleProviderRevision.json()).toMatchObject({
      code: 'EnterpriseSsoSessionRequired',
    })
    expect(calls.cognitoIdentityProviderDescriptions).toEqual(['EnterpriseOidc'])
    expect(calls.cognitoSsoAppClientDescriptions).toEqual(['mukuroji-sso-client'])
  })
})

test('accepts an SSO token only for an attested sign-in of its SSO domain, even where SSO is optional', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
  }, async () => {
    const calls = configureFakeProjectClients(true)
    const workspaceId = 'user#demo@example.com'
    const providerId = 'idp-optional'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
      workspaceId,
      providerId,
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
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    const domain = {
      workspaceId,
      domainId: 'example-com',
      domain: 'example.com',
      status: 'verified' as const,
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.example.com',
      verifiedAt: now,
      enforceSso: false,
      createdAt: now,
      updatedAt: now,
    }
    await identity.putVerifiedDomain(domain)
    const ssoAuthenticationMethod =
      `mukuroji:enterprise-sso-provider-sha256:${
        createHash('sha256').update(`${providerId}\0${1}`).digest('hex')
      }`
    let verifiedAuthenticationMethods: string[] = []
    setTestAppDependencies({
      enterpriseIdentity: identity,
      enterpriseSessionActivity: {
        async getAuthenticationMethods() {
          return [...verifiedAuthenticationMethods]
        },
        async recordAuthenticationAssurance() {
          return undefined
        },
        async validateAndTouch(input) {
          return [...input.authenticationMethods]
        },
        async isSignInRevoked() {
          return false
        },
      },
    })
    const ssoAccessToken = createAccessToken([], {
      client_id: 'mukuroji-sso-client',
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
    })
    const requestCurrentUser = (accessToken: string) => app.request('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    // A token straight from Cognito /oauth2/token never went through the exchange (#514).
    const unattested = await requestCurrentUser(ssoAccessToken)
    expect(unattested.status).toBe(401)
    expect(await unattested.json()).toMatchObject({ code: 'EnterpriseSsoSessionRequired' })

    verifiedAuthenticationMethods = [ssoAuthenticationMethod]
    // The member's domain is not bound to any SSO provider.
    const unboundDomain = await requestCurrentUser(ssoAccessToken)
    expect(unboundDomain.status).toBe(403)
    expect(await unboundDomain.json()).toMatchObject({ code: 'EnterpriseSsoSessionRequired' })

    await identity.putVerifiedDomain({ ...domain, revision: 2, identityProviderId: providerId })
    const attested = await requestCurrentUser(ssoAccessToken)
    expect(attested.status).toBe(200)

    const forgedSignature = await requestCurrentUser(
      `${ssoAccessToken.split('.').slice(0, 2).join('.')}.invalid-signature`,
    )
    expect(forgedSignature.status).toBe(401)
    expect(calls.verifiedAccessTokenReads.length).toBeGreaterThan(0)
    expect(new Set(calls.verifiedAccessTokenReads)).toEqual(new Set(['mukuroji-sso-client']))

    // Directory deprovisioning signed the member out; reactivation must not revive older sign-ins.
    const signInsRevokedAt = new Date(Date.now() - 60_000).toISOString()
    const workspaceAccess = getTestAppDependencies().workspace.workspaceAccess
    setTestAppDependencies({
      workspaceAccess: {
        ...workspaceAccess,
        async getActiveMember(workspaceIdToRead, memberKey) {
          const member = await workspaceAccess.getActiveMember(workspaceIdToRead, memberKey)
          return member ? { ...member, signInsRevokedAt } : undefined
        },
      },
    })
    const signedInBeforeSignOut = createAccessToken([], {
      client_id: 'mukuroji-sso-client',
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
      auth_time: Math.floor(Date.now() / 1_000) - 600,
    })
    const signedInAfterReactivation = createAccessToken([], {
      client_id: 'mukuroji-sso-client',
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
      auth_time: Math.floor(Date.now() / 1_000) - 5,
    })
    const revivedSession = await requestCurrentUser(signedInBeforeSignOut)
    expect(revivedSession.status).toBe(401)
    expect(await revivedSession.json()).toMatchObject({ code: 'EnterpriseSsoSessionRequired' })
    expect((await requestCurrentUser(signedInAfterReactivation)).status).toBe(200)
  })
})

test('disables SSO discovery and saved SSO enforcement when deployment settings are omitted', async () => {
  await withTestEnvironment({
    COGNITO_SSO_CLIENT_ID: '',
    COGNITO_SSO_REDIRECT_URI: '',
    COGNITO_ENTERPRISE_IDP_NAME: '',
    COGNITO_HOSTED_UI_DOMAIN: '',
    ENTERPRISE_SSO_STATE_SECRET: '',
  }, async () => {
    configureFakeProjectClients(true, { passwordAuthTokens: true })
    const identity = new InMemoryEnterpriseIdentityClient()
    let discoveryCalls = 0
    identity.discoverSso = async () => {
      discoveryCalls += 1
      throw new Error('Disabled deployment must not consult saved SSO policy.')
    }
    setTestAppDependencies({ enterpriseIdentity: identity })
    const discovery = await app.request('/api/auth/sso/discovery?email=demo%40example.com')
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toMatchObject({ ssoRequired: false })
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'Password123!' }),
    })
    expect(login.status).toBe(200)
    const profile = await app.request('/api/auth/me', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(profile.status).toBe(200)
    expect(discoveryCalls).toBe(0)
  })
})
