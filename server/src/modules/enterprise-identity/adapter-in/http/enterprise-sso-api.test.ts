import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
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

test('binds SSO exchange assurance to the signed provider revision', async () => {
  await withTestEnvironment({
    AWS_REGION: 'ap-northeast-1',
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
    ENTERPRISE_SSO_STATE_SECRET: '0123456789abcdef0123456789abcdef',
  }, async () => {
    const calls = configureFakeProjectClients(true)
    const workspaceId = 'user#demo@example.com'
    const providerId = 'idp-enforced'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    const provider = {
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
    }
    await identity.putIdentityProvider(provider)
    await identity.putVerifiedDomain({
      workspaceId,
      domainId: 'example-com',
      domain: 'example.com',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.example.com',
      verifiedAt: now,
      enforceSso: true,
      identityProviderId: providerId,
      createdAt: now,
      updatedAt: now,
    })
    const assurances: string[][] = []
    setTestAppDependencies({
      enterpriseIdentity: identity,
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
    const startSso = () => app.request('/api/auth/sso/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'demo@example.com',
        returnTo: '/workspace',
      }),
    })
    const firstStart = await startSso()
    expect(firstStart.status).toBe(200)
    const firstStartBody = await firstStart.json()
    let tokenNonce = new URL(firstStartBody.authorizationUrl).searchParams.get('nonce') ?? ''
    const accessToken = createAccessToken([], {
      'cognito:amr': [
        'PASSWORD',
        'mukuroji:enterprise-sso-provider-sha256:forged-access-claim',
      ],
      client_id: 'mukuroji-sso-client',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      iat: Math.floor(Date.now() / 1_000),
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
    })
    const originalFetch = globalThis.fetch
    let tokenExchangeCalls = 0
    globalThis.fetch = (async () => {
      tokenExchangeCalls += 1
      const epochSeconds = Math.floor(Date.now() / 1_000)
      return new Response(JSON.stringify({
        access_token: accessToken,
        id_token: createAccessToken([], {
          amr: [
            'upstream-mfa',
            'mukuroji:enterprise-sso-provider-sha256:forged-id-claim',
          ],
          aud: 'mukuroji-sso-client',
          email: 'demo@example.com',
          email_verified: true,
          exp: epochSeconds + 3_600,
          iat: epochSeconds,
          iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
          nonce: tokenNonce,
          sub: 'cognito-user-id',
          token_use: 'id',
        }),
        expires_in: 3_600,
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const updatedProviderRevision = provider.revision + 1
      await identity.putIdentityProvider({
        ...provider,
        revision: updatedProviderRevision,
      })
      const staleExchange = await app.request('/api/auth/sso/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'authorization-code-before-provider-update',
          codeVerifier: firstStartBody.codeVerifier,
          state: firstStartBody.state,
        }),
      })

      expect(staleExchange.status).toBe(409)
      expect(await staleExchange.json()).toMatchObject({
        code: 'EnterpriseSsoConfigurationChanged',
      })
      expect(tokenExchangeCalls).toBe(0)

      const currentStart = await startSso()
      expect(currentStart.status).toBe(200)
      const currentStartBody = await currentStart.json()
      tokenNonce = new URL(currentStartBody.authorizationUrl).searchParams.get('nonce') ?? ''
      const currentExchange = await app.request('/api/auth/sso/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'authorization-code-after-provider-update',
          codeVerifier: currentStartBody.codeVerifier,
          state: currentStartBody.state,
        }),
      })

      expect(currentExchange.status).toBe(200)
      expect(tokenExchangeCalls).toBe(1)
      const expectedSsoMethod = `mukuroji:enterprise-sso-provider-sha256:${
        createHash('sha256')
          .update(`${providerId}\0${updatedProviderRevision}`)
          .digest('hex')
      }`
      expect(assurances).toEqual([[
        'PASSWORD',
        'upstream-mfa',
        expectedSsoMethod,
      ]])
      expect(calls.cognitoIdentityProviderDescriptions).toHaveLength(3)
      expect(calls.cognitoSsoAppClientDescriptions).toHaveLength(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('rejects a Cognito SSO app client that can escape the enterprise IdP contract', async () => {
  await withTestEnvironment({
    AWS_REGION: 'ap-northeast-1',
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
    ENTERPRISE_SSO_STATE_SECRET: '0123456789abcdef0123456789abcdef',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
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
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    await identity.putVerifiedDomain({
      workspaceId,
      domainId: 'example-com',
      domain: 'example.com',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.example.com',
      verifiedAt: now,
      enforceSso: true,
      identityProviderId: 'idp-enforced',
      createdAt: now,
      updatedAt: now,
    })
    const startSso = () => app.request('/api/auth/sso/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com' }),
    })
    const invalidBindings = [
      { supportedIdentityProviders: ['EnterpriseOidc', 'COGNITO'] },
      { allowedOAuthFlows: ['implicit'] },
      { allowedOAuthScopes: ['openid', 'email'] },
      { explicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'] },
      { callbackUrls: ['https://attacker.example.com/callback'] },
      { hasClientSecret: true },
      { allowedOAuthFlowsUserPoolClient: false },
    ]

    for (const cognitoSsoClientDetails of invalidBindings) {
      configureFakeProjectClients(true, { cognitoSsoClientDetails })
      setTestAppDependencies({ enterpriseIdentity: identity })
      const response = await startSso()

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        code: 'EnterpriseCognitoSsoAppClientBindingInvalid',
      })
    }

    configureFakeProjectClients(true)
    setTestAppDependencies({ enterpriseIdentity: identity })
    await withTestEnvironment({
      COGNITO_SSO_CLIENT_ID: 'mukuroji-main-client',
    }, async () => {
      const sharedClient = await startSso()
      expect(sharedClient.status).toBe(503)
      expect(await sharedClient.json()).toMatchObject({
        code: 'EnterpriseCognitoSsoAppClientUnavailable',
      })
    })
  })
})

test('preflights a tested identity provider replacement before SSO enforcement can race', async () => {
  await withTestEnvironment({
    AWS_REGION: 'ap-northeast-1',
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
    ENTERPRISE_SSO_STATE_SECRET: '0123456789abcdef0123456789abcdef',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
      workspaceId,
      providerId: 'idp-enforced',
      kind: 'oidc',
      displayName: 'Existing enterprise SSO',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active',
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'existing-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email', 'profile'],
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    await identity.putVerifiedDomain({
      workspaceId,
      domainId: 'managed-example',
      domain: 'managed.example',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.managed.example',
      verifiedAt: now,
      enforceSso: false,
      identityProviderId: 'idp-enforced',
      createdAt: now,
      updatedAt: now,
    })
    await identity.putVerifiedDomain({
      workspaceId,
      domainId: 'example-com',
      domain: 'example.com',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji-challenge.example.com',
      verifiedAt: now,
      enforceSso: false,
      createdAt: now,
      updatedAt: now,
    })
    configureFakeProjectClients(true, {
      cognitoProviderDetails: {
        oidc_issuer: 'https://replacement.example.com',
        client_id: 'replacement-client',
      },
      cognitoSsoClientDetails: {
        supportedIdentityProviders: ['EnterpriseOidc', 'COGNITO'],
      },
    })
    let connectionTests = 0
    setTestAppDependencies({
      enterpriseIdentity: identity,
      async enterpriseIdentityProviderConnectionTester(provider) {
        connectionTests += 1
        return {
          ...provider,
          status: 'active',
          lastTestedAt: now,
        }
      },
    })
    const epochSeconds = Math.floor(Date.now() / 1_000)
    const accessToken = createAccessToken([], {
      client_id: 'mukuroji-main-client',
      exp: epochSeconds + 3_600,
      iat: epochSeconds,
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
      token_use: 'access',
    })
    expect((await identity.getSnapshot(workspaceId)).domains.some((domain) =>
      domain.status === 'verified' && domain.enforceSso
    )).toBe(false)

    const response = await app.request('/api/enterprise/security/identity-provider', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 'oidc',
        displayName: 'Replacement enterprise SSO',
        issuer: 'https://replacement.example.com',
        ssoUrl: 'https://replacement.example.com/authorize',
        clientId: 'replacement-client',
        expectedVersion: 1,
        testConnection: true,
      }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'EnterpriseCognitoSsoAppClientBindingInvalid',
    })
    expect(connectionTests).toBe(1)
    expect((await identity.getSnapshot(workspaceId)).identityProviders).toEqual([
      expect.objectContaining({
        displayName: 'Existing enterprise SSO',
        revision: 1,
      }),
    ])
  })
})
