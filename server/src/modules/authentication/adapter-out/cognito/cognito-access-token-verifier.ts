import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'

/**
 * Failure to verify a Cognito access token.
 */
export class CognitoAccessTokenVerificationError extends Error {
  /** HTTP status the failure maps to: 401 for a bad token, 503 when keys cannot be read. */
  readonly status: 401 | 503
  /** Stable Cognito-style error code. */
  readonly code: 'NotAuthorizedException' | 'CognitoUnavailable'

  /**
   * Creates a verification error.
   *
   * @param status - HTTP status the failure maps to.
   * @param code - Stable error code.
   * @param message - Human-readable reason.
   * @param options - Underlying cause, if any.
   */
  constructor(
    status: 401 | 503,
    code: 'NotAuthorizedException' | 'CognitoUnavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CognitoAccessTokenVerificationError'
    this.status = status
    this.code = code
  }
}

/**
 * Claims of a Cognito access token whose signature and validity were verified locally.
 */
export type VerifiedCognitoAccessToken = {
  /** Stable Cognito user identifier (`sub`). */
  sub: string
  /** User pool username the token was issued to (`username`). */
  username: string
  /** App client that requested the token (`client_id`). */
  clientId: string
  /** Expiry of the token in epoch seconds (`exp`). */
  expiresAt: number
  /** Identifier shared by every token of one sign-in (`origin_jti`), when Cognito sets it. */
  originJti?: string
}

/**
 * Values a verified Cognito access token must carry.
 */
export type CognitoAccessTokenExpectation = {
  /** Issuer URL of the trusted user pool, without a trailing slash. */
  issuer: string
  /** App client the token must have been issued to. */
  clientId: string
  /**
   * Accepts a token past its `exp`. Only for sign-out, which must name the sign-in of an
   * expired token; never for authorizing a request.
   */
  allowExpired?: boolean
}

/**
 * Loads the JSON Web Key Set of a user pool.
 *
 * @param jwksUrl - URL of the user pool's `/.well-known/jwks.json`.
 * @returns The parsed JWKS document.
 */
export type CognitoJwksFetcher = (jwksUrl: string) => Promise<unknown>

/** How long fetched signing keys are reused before the JWKS is read again. */
const jwksCacheMilliseconds = 60 * 60 * 1_000
/** Shortest interval between two JWKS reads triggered by an unknown key ID. */
const jwksRefetchIntervalMilliseconds = 60 * 1_000
/** Allowed clock difference, in seconds, when checking `exp` and `iat`. */
const clockToleranceSeconds = 30
/** Timeout of one JWKS request. */
const jwksTimeoutMilliseconds = 5_000

/**
 * Verifies Cognito access tokens with the signing keys the user pool publishes.
 *
 * @remarks
 * Cognito `GetUser` only accepts access tokens that carry the `aws.cognito.signin.user.admin`
 * scope. Tokens from the enterprise SSO app client deliberately lack that scope, so the API checks
 * their RS256 signature, issuer, app client, `token_use` and expiry here instead. A local check
 * does not see Cognito-side revocation, so callers must pair it with a server-side session record.
 */
export class CognitoAccessTokenVerifier {
  /** URL of the user pool's JWKS document. */
  private readonly jwksUrl: string
  /** Reads the JWKS document. */
  private readonly fetchJwks: CognitoJwksFetcher
  /** Returns the current time in epoch milliseconds. */
  private readonly now: () => number
  /** Signing keys by key ID from the last successful JWKS read. */
  private keys = new Map<string, KeyObject>()
  /** Epoch milliseconds of the last successful JWKS read. */
  private keysFetchedAt = 0
  /** Epoch milliseconds of the last JWKS read attempt. */
  private lastFetchAttemptAt = 0
  /** Whether the last JWKS read attempt failed. */
  private lastFetchFailed = false
  /** In-flight JWKS read shared by concurrent verifications. */
  private pendingFetch: Promise<void> | undefined

  /**
   * Creates a verifier for one user pool.
   *
   * @param jwksUrl - URL of the user pool's `/.well-known/jwks.json`.
   * @param fetchJwks - Reads the JWKS document; defaults to an HTTPS request.
   * @param now - Clock in epoch milliseconds; defaults to `Date.now`.
   */
  constructor(
    jwksUrl: string,
    fetchJwks: CognitoJwksFetcher = fetchJwksDocument,
    now: () => number = Date.now,
  ) {
    this.jwksUrl = jwksUrl
    this.fetchJwks = fetchJwks
    this.now = now
  }

  /**
   * Verifies an access token and returns its trusted claims.
   *
   * @param accessToken - Bearer access token.
   * @param expected - Issuer and app client the token must carry.
   * @returns The verified claims; throws a 401 `NotAuthorizedException` for an invalid token.
   */
  async verify(
    accessToken: string,
    expected: CognitoAccessTokenExpectation,
  ): Promise<VerifiedCognitoAccessToken> {
    const parts = accessToken.split('.')
    if (parts.length !== 3) throw invalidAccessToken()
    const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts
    const header = readJsonSegment(encodedHeader)
    const payload = readJsonSegment(encodedPayload)
    if (!header || !payload || header.alg !== 'RS256' || !isNonEmptyText(header.kid)) {
      throw invalidAccessToken()
    }

    const key = await this.getSigningKey(header.kid)
    const signature = Buffer.from(encodedSignature, 'base64url')
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      signature,
    )
    if (!signed) throw invalidAccessToken()

    const nowSeconds = Math.floor(this.now() / 1_000)
    if (
      payload.token_use !== 'access' ||
      typeof payload.iss !== 'string' ||
      trimTrailingSlash(payload.iss) !== trimTrailingSlash(expected.issuer) ||
      payload.client_id !== expected.clientId ||
      !isNonEmptyText(payload.sub) ||
      !isNonEmptyText(payload.username) ||
      !isEpochSeconds(payload.exp) ||
      (!expected.allowExpired && payload.exp + clockToleranceSeconds <= nowSeconds) ||
      (payload.iat !== undefined &&
        (!isEpochSeconds(payload.iat) || payload.iat - clockToleranceSeconds > nowSeconds))
    ) {
      throw invalidAccessToken()
    }

    return {
      sub: payload.sub,
      username: payload.username,
      clientId: expected.clientId,
      expiresAt: payload.exp,
      ...(isNonEmptyText(payload.origin_jti) ? { originJti: payload.origin_jti } : {}),
    }
  }

  /**
   * Returns the signing key for a key ID, reading the JWKS when it is stale or the key is new.
   *
   * @param keyId - `kid` from the token header.
   * @returns The RSA public key.
   */
  private async getSigningKey(keyId: string) {
    if (this.pendingFetch && !this.keys.has(keyId)) {
      // A read already in flight may bring the key; the cooldown only limits starting another.
      await this.pendingFetch.catch(() => undefined)
    }
    const now = this.now()
    const stale = now - this.keysFetchedAt >= jwksCacheMilliseconds
    // Every read, including the hourly refresh, waits out the interval after the last attempt, so
    // an unreachable JWKS endpoint or unknown key IDs cannot make each request wait on the network.
    const mayFetch = now - this.lastFetchAttemptAt >= jwksRefetchIntervalMilliseconds
    if (mayFetch && (stale || !this.keys.has(keyId))) {
      try {
        await this.refreshKeys()
      } catch (error) {
        // Keep verifying with a key read earlier while the JWKS endpoint is briefly unreachable.
        if (!this.keys.has(keyId)) throw error
      }
    }
    const key = this.keys.get(keyId)
    if (!key) {
      if (this.lastFetchFailed) {
        throw new CognitoAccessTokenVerificationError(
          503,
          'CognitoUnavailable',
          'Cognito signing keys could not be read.',
        )
      }
      throw invalidAccessToken()
    }
    return key
  }

  /**
   * Reads the JWKS once, sharing the read between concurrent callers.
   */
  private async refreshKeys() {
    this.pendingFetch ??= this.loadKeys().finally(() => {
      this.pendingFetch = undefined
    })
    await this.pendingFetch
  }

  /**
   * Reads the JWKS and replaces the cached signing keys.
   */
  private async loadKeys() {
    this.lastFetchAttemptAt = this.now()
    this.lastFetchFailed = true
    let document: unknown
    try {
      document = await this.fetchJwks(this.jwksUrl)
    } catch (error) {
      throw new CognitoAccessTokenVerificationError(
        503,
        'CognitoUnavailable',
        'Cognito signing keys could not be read.',
        { cause: error },
      )
    }
    const keys = readSigningKeys(document)
    if (keys.size === 0) {
      throw new CognitoAccessTokenVerificationError(
        503,
        'CognitoUnavailable',
        'Cognito signing keys are missing.',
      )
    }
    this.keys = keys
    this.keysFetchedAt = this.now()
    this.lastFetchFailed = false
  }
}

/** Verifiers by JWKS URL, so the signing keys are cached for the lifetime of the process. */
const verifiers = new Map<string, CognitoAccessTokenVerifier>()

/**
 * Returns the process-wide verifier for a user pool issuer.
 *
 * @param issuer - Issuer URL of the user pool.
 * @returns The shared verifier.
 */
export function getCognitoAccessTokenVerifier(issuer: string) {
  const jwksUrl = `${trimTrailingSlash(issuer)}/.well-known/jwks.json`
  let verifier = verifiers.get(jwksUrl)
  if (!verifier) {
    verifier = new CognitoAccessTokenVerifier(jwksUrl)
    verifiers.set(jwksUrl, verifier)
  }
  return verifier
}

/**
 * Reads a JWKS document over HTTP.
 *
 * @param jwksUrl - URL of the JWKS document.
 * @returns The parsed response body.
 */
async function fetchJwksDocument(jwksUrl: string) {
  const response = await fetch(jwksUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(jwksTimeoutMilliseconds),
  })
  if (!response.ok) {
    throw new Error(`JWKS request failed with HTTP ${response.status}.`)
  }
  return await response.json()
}

/**
 * Converts the RSA signing keys of a JWKS document into public keys by key ID.
 *
 * @param document - Parsed JWKS document.
 * @returns The usable signing keys.
 */
function readSigningKeys(document: unknown) {
  const keys = new Map<string, KeyObject>()
  if (!isRecord(document) || !Array.isArray(document.keys)) return keys
  for (const candidate of document.keys) {
    if (
      !isRecord(candidate) ||
      candidate.kty !== 'RSA' ||
      !isNonEmptyText(candidate.kid) ||
      (candidate.use !== undefined && candidate.use !== 'sig') ||
      (candidate.alg !== undefined && candidate.alg !== 'RS256') ||
      !isNonEmptyText(candidate.n) ||
      !isNonEmptyText(candidate.e)
    ) {
      continue
    }
    const jwk: JsonWebKey = { kty: 'RSA', n: candidate.n, e: candidate.e }
    try {
      keys.set(candidate.kid, createPublicKey({ key: jwk, format: 'jwk' }))
    } catch {
      // A malformed key is skipped; tokens signed with it fail verification.
    }
  }
  return keys
}

/**
 * Decodes one base64url JSON segment of a JWT.
 *
 * @param segment - Encoded header or payload.
 * @returns The decoded object, or undefined when it is not a JSON object.
 */
function readJsonSegment(segment: string) {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Creates the error returned for an access token that fails verification.
 *
 * @returns The 401 Cognito error.
 */
function invalidAccessToken() {
  return new CognitoAccessTokenVerificationError(401, 'NotAuthorizedException', 'Access token is invalid.')
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a non-empty string.
 *
 * @param value - Value to check.
 * @returns Whether the value is a string with non-whitespace content.
 */
function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Checks whether a value is a whole number of epoch seconds.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-negative safe integer.
 */
function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Removes trailing slashes from a URL.
 *
 * @param value - URL to normalize.
 * @returns The URL without trailing slashes.
 */
function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '')
}
