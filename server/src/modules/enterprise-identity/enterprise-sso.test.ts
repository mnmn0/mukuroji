import { expect, test } from 'bun:test'
import {
  buildCognitoAuthorizeUrl,
  createEnterpriseSsoState,
  normalizeEnterpriseSsoReturnTo,
  parseEnterpriseSsoTokenResponse,
  validateEnterpriseSsoState,
} from './enterprise-sso'

const hmacSecret = '0123456789abcdef0123456789abcdef'
const now = 1_789_776_000
const redirectUri = 'https://app.example.com/api/auth/sso/callback'
const providerId = 'MicrosoftEntra'
const providerRevision = 7

test('creates and validates short-lived signed SSO state with PKCE and exact bindings', () => {
  const bundle = createEnterpriseSsoState({
    email: ' Owner@Example.com ',
    providerId,
    providerRevision,
    redirectUri,
    returnTo: '/workspace/security?tab=identity#provider',
    hmacSecret,
    now,
  })

  expect(bundle.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(bundle.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(bundle.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(bundle.state.split('.')).toHaveLength(2)
  expect(bundle.expiresAt).toBe(now + 300)

  expect(validateEnterpriseSsoState({
    state: bundle.state,
    codeVerifier: bundle.codeVerifier,
    hmacSecret,
    expectedRedirectUri: redirectUri,
    expectedProviderId: providerId,
    expectedProviderRevision: providerRevision,
    now: now + 20,
  })).toEqual({
    email: 'owner@example.com',
    providerId,
    providerRevision,
    redirectUri,
    returnTo: '/workspace/security?tab=identity#provider',
    codeChallenge: bundle.codeChallenge,
    nonce: bundle.nonce,
    issuedAt: now,
    expiresAt: now + 300,
  })
})

test('rejects state tampering, expired state, verifier substitution, and binding changes', () => {
  const bundle = createEnterpriseSsoState({
    email: 'owner@example.com',
    providerId,
    providerRevision,
    redirectUri,
    hmacSecret,
    now,
    lifetimeSeconds: 60,
  })
  const common = {
    state: bundle.state,
    codeVerifier: bundle.codeVerifier,
    hmacSecret,
    expectedRedirectUri: redirectUri,
    expectedProviderId: providerId,
    expectedProviderRevision: providerRevision,
    now: now + 10,
    clockSkewSeconds: 0,
  }

  expect(() => validateEnterpriseSsoState({
    ...common,
    state: `${bundle.state.slice(0, -1)}x`,
  })).toThrow('state is invalid')
  expect(() => validateEnterpriseSsoState({
    ...common,
    codeVerifier: createEnterpriseSsoState({
      email: 'owner@example.com',
      providerId,
      providerRevision,
      redirectUri,
      hmacSecret,
      now,
    }).codeVerifier,
  })).toThrow('state is invalid')
  expect(() => validateEnterpriseSsoState({
    ...common,
    expectedRedirectUri: 'https://app.example.com/api/auth/sso/other',
  })).toThrow('state is invalid')
  expect(() => validateEnterpriseSsoState({
    ...common,
    expectedProviderId: 'OtherProvider',
  })).toThrow('state is invalid')
  expect(() => validateEnterpriseSsoState({
    ...common,
    expectedProviderRevision: providerRevision + 1,
  })).toThrow('state is invalid')
  expect(() => validateEnterpriseSsoState({
    ...common,
    now: now + 60,
  })).toThrow('state has expired')
})

test('builds a Cognito Hosted UI authorization-code URL with OIDC and PKCE parameters', () => {
  const bundle = createEnterpriseSsoState({
    email: 'owner@example.com',
    providerId,
    providerRevision,
    redirectUri,
    hmacSecret,
    now,
  })
  const url = new URL(buildCognitoAuthorizeUrl({
    cognitoDomain: 'mukuroji.auth.ap-northeast-1.amazoncognito.com',
    clientId: 'client-id',
    redirectUri,
    identityProvider: providerId,
    state: bundle.state,
    nonce: bundle.nonce,
    codeChallenge: bundle.codeChallenge,
  }))

  expect(url.origin).toBe('https://mukuroji.auth.ap-northeast-1.amazoncognito.com')
  expect(url.pathname).toBe('/oauth2/authorize')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: 'client-id',
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
    identity_provider: providerId,
    state: bundle.state,
    nonce: bundle.nonce,
    code_challenge: bundle.codeChallenge,
    code_challenge_method: 'S256',
  })
})

test('normalizes return paths without permitting open redirects', () => {
  expect(normalizeEnterpriseSsoReturnTo('/projects/one?view=board#today'))
    .toBe('/projects/one?view=board#today')
  expect(normalizeEnterpriseSsoReturnTo('https://attacker.example/path')).toBe('/')
  expect(normalizeEnterpriseSsoReturnTo('//attacker.example/path')).toBe('/')
  expect(normalizeEnterpriseSsoReturnTo('/\\attacker.example/path')).toBe('/')
  expect(normalizeEnterpriseSsoReturnTo('/projects\u0000/one')).toBe('/')
})

test('parses a Cognito token response and validates nonce, issuer, audience, and expiry', () => {
  const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example'
  const idToken = createUnsignedJwt({
    sub: 'cognito-sub-1',
    iss: issuer,
    aud: 'client-id',
    token_use: 'id',
    nonce: 'bound-nonce',
    email: 'owner@example.com',
    email_verified: true,
    iat: now - 1,
    exp: now + 3_600,
  })

  expect(parseEnterpriseSsoTokenResponse({
    response: {
      access_token: 'access.token.value',
      id_token: idToken,
      refresh_token: 'refresh-token-value',
      expires_in: 3_600,
      token_type: 'Bearer',
    },
    expectedNonce: 'bound-nonce',
    expectedEmail: 'owner@example.com',
    returnTo: '/projects/one',
    expectedClientId: 'client-id',
    expectedIssuer: issuer,
    now,
  })).toEqual({
    accessToken: 'access.token.value',
    idToken,
    refreshToken: 'refresh-token-value',
    expiresAt: (now + 3_600) * 1_000,
    tokenType: 'Bearer',
    returnTo: '/projects/one',
  })
})

test('rejects substituted nonce and invalid Cognito token claims', () => {
  const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example'
  const validResponse = {
    access_token: 'access.token.value',
    id_token: createUnsignedJwt({
      sub: 'cognito-sub-1',
      iss: issuer,
      aud: 'client-id',
      token_use: 'id',
      nonce: 'actual-nonce',
      email: 'owner@example.com',
      email_verified: true,
      iat: now,
      exp: now + 3_600,
    }),
    expires_in: 3_600,
    token_type: 'Bearer',
  }
  const common = {
    response: validResponse,
    expectedNonce: 'actual-nonce',
    expectedEmail: 'owner@example.com',
    returnTo: '/',
    expectedClientId: 'client-id',
    expectedIssuer: issuer,
    now,
    clockSkewSeconds: 0,
  }

  expect(() => parseEnterpriseSsoTokenResponse({
    ...common,
    expectedNonce: 'substituted-nonce',
  })).toThrow('invalid enterprise SSO ID token')
  expect(() => parseEnterpriseSsoTokenResponse({
    ...common,
    expectedEmail: 'other@example.com',
  })).toThrow('invalid enterprise SSO ID token')
  expect(() => parseEnterpriseSsoTokenResponse({
    ...common,
    expectedClientId: 'other-client',
  })).toThrow('invalid enterprise SSO ID token')
  expect(() => parseEnterpriseSsoTokenResponse({
    ...common,
    expectedIssuer: 'https://issuer.example.com/pool',
  })).toThrow('invalid enterprise SSO ID token')
  for (const claims of [
    {
      iss: issuer,
      aud: 'client-id',
      token_use: 'id',
      nonce: 'actual-nonce',
      email: 'owner@example.com',
      email_verified: true,
      exp: now + 3_600,
    },
    {
      sub: 'cognito-sub-1',
      iss: issuer,
      aud: 'client-id',
      token_use: 'id',
      nonce: 'actual-nonce',
      email: 'owner@example.com',
      exp: now + 3_600,
    },
  ]) {
    expect(() => parseEnterpriseSsoTokenResponse({
      ...common,
      response: {
        ...validResponse,
        id_token: createUnsignedJwt(claims),
      },
    })).toThrow('invalid enterprise SSO ID token')
  }
  expect(() => parseEnterpriseSsoTokenResponse({
    ...common,
    response: {
      ...validResponse,
      id_token: createUnsignedJwt({
        iss: issuer,
        aud: 'client-id',
        token_use: 'id',
        nonce: 'actual-nonce',
        email: 'owner@example.com',
        email_verified: true,
        exp: now,
      }),
    },
  })).toThrow('invalid enterprise SSO ID token')
})

/**
 * Signature validation ではなく claims parser の test に使う compact JWT を作成します。
 */
function createUnsignedJwt(payload: Readonly<Record<string, unknown>>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.test-signature`
}
