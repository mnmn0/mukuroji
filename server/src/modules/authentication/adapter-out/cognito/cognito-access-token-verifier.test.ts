import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  CognitoAccessTokenVerifier,
  type CognitoAccessTokenExpectation,
} from './cognito-access-token-verifier'

/** Issuer and app client every token in these tests is checked against. */
const expected: CognitoAccessTokenExpectation = {
  issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
  clientId: 'mukuroji-sso-client',
}

/** Fixed clock of these tests, in epoch milliseconds. */
const now = Date.UTC(2026, 10, 19, 3, 0, 0)

/**
 * Creates an RSA signing key and its public JWK.
 *
 * @param kid - Key ID published in the JWKS.
 * @returns The private key and the JWKS entry.
 */
function createSigningKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  }
}

/**
 * Signs a JWT with RS256.
 *
 * @param privateKey - Signing key.
 * @param header - JWT header.
 * @param claims - JWT payload.
 * @returns The compact JWT.
 */
function signToken(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(claims)}`
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`
}

/**
 * Returns the claims of a valid SSO access token at {@link now}.
 *
 * @param overrides - Claims to replace.
 * @returns The token claims.
 */
function accessClaims(overrides: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(now / 1_000) - 60
  return {
    sub: 'sub-1',
    username: 'enterpriseoidc_user-1',
    client_id: expected.clientId,
    iss: expected.issuer,
    token_use: 'access',
    scope: 'openid email profile',
    iat: issuedAt,
    auth_time: issuedAt,
    exp: issuedAt + 3_600,
    origin_jti: 'origin-1',
    ...overrides,
  }
}

test('accepts an SSO access token signed by the user pool and returns its claims', async () => {
  const key = createSigningKey('kid-1')
  const fetchedUrls: string[] = []
  const verifier = new CognitoAccessTokenVerifier(
    `${expected.issuer}/.well-known/jwks.json`,
    async (url) => {
      fetchedUrls.push(url)
      return { keys: [key.jwk] }
    },
    () => now,
  )
  const token = signToken(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, accessClaims())

  await expect(verifier.verify(token, expected)).resolves.toEqual({
    sub: 'sub-1',
    username: 'enterpriseoidc_user-1',
    clientId: expected.clientId,
    expiresAt: Math.floor(now / 1_000) - 60 + 3_600,
    originJti: 'origin-1',
  })
  await verifier.verify(token, expected)
  expect(fetchedUrls).toEqual([`${expected.issuer}/.well-known/jwks.json`])
})

test('rejects forged, foreign and expired tokens', async () => {
  const key = createSigningKey('kid-1')
  const otherKey = createSigningKey('kid-1')
  const verifier = new CognitoAccessTokenVerifier(
    'https://jwks.example.test',
    async () => ({ keys: [key.jwk] }),
    () => now,
  )
  const header = { alg: 'RS256', kid: 'kid-1' }
  const valid = signToken(key.privateKey, header, accessClaims())
  const [validHeader, , validSignature] = valid.split('.')
  const tamperedPayload = Buffer.from(JSON.stringify(accessClaims({ username: 'admin' })))
    .toString('base64url')
  const rejected = [
    // Signed by a key the user pool does not publish.
    signToken(otherKey.privateKey, header, accessClaims()),
    // Payload changed after signing.
    `${validHeader}.${tamperedPayload}.${validSignature}`,
    // Unsigned token.
    `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-1' })).toString('base64url')}.${
      Buffer.from(JSON.stringify(accessClaims())).toString('base64url')
    }.`,
    signToken(key.privateKey, header, accessClaims({ iss: 'https://issuer.example.test' })),
    signToken(key.privateKey, header, accessClaims({ client_id: 'mukuroji-password-client' })),
    signToken(key.privateKey, header, accessClaims({ token_use: 'id' })),
    signToken(key.privateKey, header, accessClaims({ exp: Math.floor(now / 1_000) - 31 })),
    signToken(key.privateKey, header, accessClaims({ iat: Math.floor(now / 1_000) + 600 })),
    signToken(key.privateKey, header, accessClaims({ username: '' })),
    'not-a-jwt',
  ]

  for (const token of rejected) {
    await expect(verifier.verify(token, expected)).rejects.toMatchObject({
      status: 401,
      code: 'NotAuthorizedException',
    })
  }
})

test('reads the JWKS again for a rotated key, but not for every unknown key ID', async () => {
  const oldKey = createSigningKey('kid-old')
  const newKey = createSigningKey('kid-new')
  let published = [oldKey.jwk]
  let fetches = 0
  let clock = now
  const verifier = new CognitoAccessTokenVerifier(
    'https://jwks.example.test',
    async () => {
      fetches += 1
      return { keys: published }
    },
    () => clock,
  )
  await verifier.verify(
    signToken(oldKey.privateKey, { alg: 'RS256', kid: 'kid-old' }, accessClaims()),
    expected,
  )
  published = [oldKey.jwk, newKey.jwk]
  const rotated = signToken(newKey.privateKey, { alg: 'RS256', kid: 'kid-new' }, accessClaims())

  await expect(verifier.verify(rotated, expected)).rejects.toMatchObject({ status: 401 })
  expect(fetches).toBe(1)

  clock += 61_000
  await expect(verifier.verify(rotated, expected)).resolves.toMatchObject({ sub: 'sub-1' })
  expect(fetches).toBe(2)

  const unknown = signToken(newKey.privateKey, { alg: 'RS256', kid: 'kid-unknown' }, accessClaims())
  await expect(verifier.verify(unknown, expected)).rejects.toMatchObject({ status: 401 })
  await expect(verifier.verify(unknown, expected)).rejects.toMatchObject({ status: 401 })
  expect(fetches).toBe(2)
})

test('fails closed with 503 when the signing keys cannot be read', async () => {
  const key = createSigningKey('kid-1')
  const token = signToken(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, accessClaims())
  const unreachable = new CognitoAccessTokenVerifier(
    'https://jwks.example.test',
    async () => {
      throw new Error('network down')
    },
    () => now,
  )
  const empty = new CognitoAccessTokenVerifier(
    'https://jwks.example.test',
    async () => ({ keys: [] }),
    () => now,
  )

  await expect(unreachable.verify(token, expected)).rejects.toMatchObject({
    status: 503,
    code: 'CognitoUnavailable',
  })
  await expect(empty.verify(token, expected)).rejects.toMatchObject({
    status: 503,
    code: 'CognitoUnavailable',
  })
})
