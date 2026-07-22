import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const enterpriseSsoStateVersion = 2 as const
const defaultStateLifetimeSeconds = 300
const maximumStateLifetimeSeconds = 600
const minimumHmacSecretBytes = 32
const oauthCodeVerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/u
const enterpriseSsoAuthenticationMethodPrefix =
  'mukuroji:enterprise-sso-provider-sha256:'

/**
 * Enterprise SSO helper が返す、外部入力を含まない safe error です。
 */
export class EnterpriseSsoError extends Error {
  /** API response に利用できる HTTP status です。 */
  readonly status: number
  /** Client と audit が分岐に利用できる stable error code です。 */
  readonly code: string

  /**
   * Enterprise SSO error を作成します。
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnterpriseSsoError'
    this.status = status
    this.code = code
  }
}

/**
 * Server が完了を確認した enterprise SSO provider revision の opaque marker を作成します。
 */
export function createEnterpriseSsoAuthenticationMethod(
  providerId: string,
  providerRevision: number,
) {
  const normalizedProviderId = readBoundText(providerId, 'provider ID')
  const normalizedProviderRevision = readProviderRevision(providerRevision)
  return `${enterpriseSsoAuthenticationMethodPrefix}${
    createHash('sha256')
      .update(`${normalizedProviderId}\0${normalizedProviderRevision}`)
      .digest('hex')
  }`
}

/**
 * Authentication method が server 専用 enterprise SSO marker namespace か判定します。
 */
export function isEnterpriseSsoAuthenticationMethod(method: string) {
  return method.startsWith(enterpriseSsoAuthenticationMethodPrefix)
}

/**
 * Signed SSO state を作成する入力です。
 */
export type CreateEnterpriseSsoStateInput = {
  /** Login discovery で確認済みの email address です。 */
  email: string
  /** Cognito に接続された enterprise identity provider ID です。 */
  providerId: string
  /** Login discovery 時点の identity provider revision です。 */
  providerRevision: number
  /** OAuth callback に登録した完全一致の redirect URI です。 */
  redirectUri: string
  /** Login 完了後に戻る same-origin relative path です。 */
  returnTo?: string
  /** State を署名する 32 byte 以上の application secret です。 */
  hmacSecret: string
  /** Test または deterministic evaluation に使う現在 epoch seconds です。 */
  now?: number
  /** State の lifetime seconds です。最大 10 分です。 */
  lifetimeSeconds?: number
}

/**
 * Browser redirect の開始時だけ返す signed state と PKCE material です。
 */
export type EnterpriseSsoStateBundle = {
  /** HMAC 署名済み OAuth state です。 */
  state: string
  /** Callback POST まで browser session に保持する PKCE verifier です。 */
  codeVerifier: string
  /** Cognito authorize request に渡す PKCE S256 challenge です。 */
  codeChallenge: string
  /** Cognito authorize request と ID token を結び付ける nonce です。 */
  nonce: string
  /** 正規化済み same-origin return path です。 */
  returnTo: string
  /** State expiry の epoch seconds です。 */
  expiresAt: number
}

/**
 * Signed SSO state を検証する入力です。
 */
export type ValidateEnterpriseSsoStateInput = {
  /** Callback で受け取った signed state です。 */
  state: string
  /** Browser session から POST された PKCE verifier です。 */
  codeVerifier: string
  /** State 作成時と同じ application secret です。 */
  hmacSecret: string
  /** 現在設定されている完全一致の redirect URI です。 */
  expectedRedirectUri: string
  /** Login discovery で選択された provider ID です。 */
  expectedProviderId?: string
  /** Login discovery で選択された provider revision です。 */
  expectedProviderRevision?: number
  /** Test または deterministic evaluation に使う現在 epoch seconds です。 */
  now?: number
  /** Clock skew として許容する秒数です。 */
  clockSkewSeconds?: number
}

/**
 * 検証済み signed SSO state の内容です。
 */
export type ValidatedEnterpriseSsoState = {
  /** 正規化済み login email です。 */
  email: string
  /** Login discovery で選択された provider ID です。 */
  providerId: string
  /** Login discovery 時点の identity provider revision です。 */
  providerRevision: number
  /** State に完全一致で binding された redirect URI です。 */
  redirectUri: string
  /** Login 完了後に戻る same-origin relative path です。 */
  returnTo: string
  /** 検証済み PKCE S256 challenge です。 */
  codeChallenge: string
  /** ID token 検証に使う nonce です。 */
  nonce: string
  /** State 発行時刻の epoch seconds です。 */
  issuedAt: number
  /** State expiry の epoch seconds です。 */
  expiresAt: number
}

/**
 * Cognito Hosted UI authorize URL を作成する入力です。
 */
export type BuildCognitoAuthorizeUrlInput = {
  /** Cognito user-pool domain の origin または URL です。 */
  cognitoDomain: string
  /** Cognito app client ID です。 */
  clientId: string
  /** App client に登録した完全一致の redirect URI です。 */
  redirectUri: string
  /** Cognito に登録した identity provider 名です。 */
  identityProvider: string
  /** {@link createEnterpriseSsoState} が返した signed state です。 */
  state: string
  /** {@link createEnterpriseSsoState} が返した nonce です。 */
  nonce: string
  /** {@link createEnterpriseSsoState} が返した PKCE S256 challenge です。 */
  codeChallenge: string
}

/**
 * OAuth token response の検証入力です。
 */
export type ParseEnterpriseSsoTokenResponseInput = {
  /** Cognito token endpoint が返した JSON-compatible value です。 */
  response: unknown
  /** 検証済み state に binding された nonce です。 */
  expectedNonce: string
  /** 検証済み state に binding された login email です。 */
  expectedEmail: string
  /** 検証済み state に binding された return path です。 */
  returnTo: string
  /** ID token `aud` に期待する Cognito app client ID です。 */
  expectedClientId: string
  /** ID token `iss` に期待する Cognito user-pool issuer です。 */
  expectedIssuer: string
  /** Test または deterministic evaluation に使う現在 epoch seconds です。 */
  now?: number
  /** ID token expiry の clock skew として許容する秒数です。 */
  clockSkewSeconds?: number
}

/**
 * 既存 password login response と同じ token shape に return path を加えた結果です。
 */
export type EnterpriseSsoAuthenticationResult = {
  /** API authentication に利用する Cognito access token です。 */
  accessToken: string
  /** Nonce、issuer、audience、expiry を検証した Cognito ID token です。 */
  idToken: string
  /** Token refresh に利用する Cognito refresh token です。 */
  refreshToken?: string
  /** Access token expiry の epoch milliseconds です。 */
  expiresAt: number
  /** OAuth token type です。 */
  tokenType: 'Bearer'
  /** Login 完了後に遷移できる正規化済み same-origin path です。 */
  returnTo: string
}

/**
 * HMAC state 内に保存する versioned payload です。
 */
type EnterpriseSsoStatePayload = {
  /** State schema version です。 */
  v: typeof enterpriseSsoStateVersion
  /** 正規化済み login email です。 */
  email: string
  /** Identity provider ID です。 */
  providerId: string
  /** Identity provider revision です。 */
  providerRevision: number
  /** 完全一致の redirect URI です。 */
  redirectUri: string
  /** 正規化済み same-origin return path です。 */
  returnTo: string
  /** PKCE S256 challenge です。 */
  codeChallenge: string
  /** ID token nonce です。 */
  nonce: string
  /** Issued-at epoch seconds です。 */
  iat: number
  /** Expiry epoch seconds です。 */
  exp: number
}

/**
 * Cognito OAuth token endpoint response の読み取り対象です。
 */
type CognitoOAuthTokenResponse = {
  /** OAuth access token です。 */
  access_token?: unknown
  /** OpenID Connect ID token です。 */
  id_token?: unknown
  /** OAuth refresh token です。 */
  refresh_token?: unknown
  /** Access token lifetime seconds です。 */
  expires_in?: unknown
  /** OAuth token type です。 */
  token_type?: unknown
}

/**
 * ID token payload から検証する standard claims です。
 */
type EnterpriseIdTokenClaims = {
  /** Cognito user の immutable subject です。 */
  sub?: unknown
  /** Token issuer です。 */
  iss?: unknown
  /** Token audience です。 */
  aud?: unknown
  /** Cognito token use です。 */
  token_use?: unknown
  /** OAuth request nonce です。 */
  nonce?: unknown
  /** Cognito が認証した user email です。 */
  email?: unknown
  /** Email verification state です。 */
  email_verified?: unknown
  /** Token expiry epoch seconds です。 */
  exp?: unknown
  /** Token issued-at epoch seconds です。 */
  iat?: unknown
}

/**
 * Login discovery の結果から、改ざん・replay・open redirect に耐える短命 state を作成します。
 */
export function createEnterpriseSsoState(
  input: CreateEnterpriseSsoStateInput,
): EnterpriseSsoStateBundle {
  validateHmacSecret(input.hmacSecret)
  const email = normalizeEmail(input.email)
  const providerId = readBoundText(input.providerId, 'provider ID')
  const providerRevision = readProviderRevision(input.providerRevision)
  const redirectUri = validateRedirectUri(input.redirectUri)
  const returnTo = normalizeEnterpriseSsoReturnTo(input.returnTo)
  const now = readEpochSeconds(input.now)
  const lifetimeSeconds = input.lifetimeSeconds ?? defaultStateLifetimeSeconds

  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > maximumStateLifetimeSeconds
  ) {
    throw new EnterpriseSsoError(
      500,
      'InvalidSsoStateLifetime',
      'Enterprise SSO state lifetime must be between 60 and 600 seconds.',
    )
  }

  const codeVerifier = toBase64Url(randomBytes(32))
  const codeChallenge = createPkceCodeChallenge(codeVerifier)
  const nonce = toBase64Url(randomBytes(32))
  const expiresAt = now + lifetimeSeconds
  const payload: EnterpriseSsoStatePayload = {
    v: enterpriseSsoStateVersion,
    email,
    providerId,
    providerRevision,
    redirectUri,
    returnTo,
    codeChallenge,
    nonce,
    iat: now,
    exp: expiresAt,
  }
  const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = signState(encodedPayload, input.hmacSecret)

  return {
    state: `${encodedPayload}.${signature}`,
    codeVerifier,
    codeChallenge,
    nonce,
    returnTo,
    expiresAt,
  }
}

/**
 * Signed state、expiry、redirect/provider binding、PKCE verifier をまとめて検証します。
 */
export function validateEnterpriseSsoState(
  input: ValidateEnterpriseSsoStateInput,
): ValidatedEnterpriseSsoState {
  validateHmacSecret(input.hmacSecret)
  if (!oauthCodeVerifierPattern.test(input.codeVerifier)) {
    throw invalidStateError()
  }

  const stateParts = input.state.split('.')
  if (stateParts.length !== 2 || !stateParts[0] || !stateParts[1]) {
    throw invalidStateError()
  }
  const [encodedPayload, encodedSignature] = stateParts
  const expectedSignature = signState(encodedPayload, input.hmacSecret)
  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw invalidStateError()
  }

  const payload = parseStatePayload(encodedPayload)
  const now = readEpochSeconds(input.now)
  const clockSkewSeconds = readClockSkew(input.clockSkewSeconds, 0)
  if (
    payload.exp <= now - clockSkewSeconds ||
    payload.iat > now + clockSkewSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > maximumStateLifetimeSeconds
  ) {
    throw new EnterpriseSsoError(
      401,
      'ExpiredSsoState',
      'Enterprise SSO state has expired.',
    )
  }

  const expectedRedirectUri = validateRedirectUri(input.expectedRedirectUri)
  if (
    !safeEqual(payload.redirectUri, expectedRedirectUri) ||
    (input.expectedProviderId !== undefined &&
      !safeEqual(payload.providerId, readBoundText(input.expectedProviderId, 'provider ID'))) ||
    (input.expectedProviderRevision !== undefined &&
      payload.providerRevision !== readProviderRevision(input.expectedProviderRevision)) ||
    !safeEqual(createPkceCodeChallenge(input.codeVerifier), payload.codeChallenge)
  ) {
    throw invalidStateError()
  }

  return {
    email: payload.email,
    providerId: payload.providerId,
    providerRevision: payload.providerRevision,
    redirectUri: payload.redirectUri,
    returnTo: payload.returnTo,
    codeChallenge: payload.codeChallenge,
    nonce: payload.nonce,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  }
}

/**
 * Cognito Hosted UI の authorization-code + PKCE authorize URL を作成します。
 */
export function buildCognitoAuthorizeUrl(input: BuildCognitoAuthorizeUrlInput): string {
  const authorizeUrl = normalizeCognitoDomain(input.cognitoDomain)
  authorizeUrl.pathname = '/oauth2/authorize'
  authorizeUrl.search = ''
  authorizeUrl.hash = ''
  authorizeUrl.searchParams.set('client_id', readBoundText(input.clientId, 'client ID'))
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', 'openid email profile')
  authorizeUrl.searchParams.set('redirect_uri', validateRedirectUri(input.redirectUri))
  authorizeUrl.searchParams.set(
    'identity_provider',
    readBoundText(input.identityProvider, 'identity provider'),
  )
  authorizeUrl.searchParams.set('state', readBoundText(input.state, 'state'))
  authorizeUrl.searchParams.set('nonce', readBoundText(input.nonce, 'nonce'))
  authorizeUrl.searchParams.set(
    'code_challenge',
    readPkceChallenge(input.codeChallenge),
  )
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  return authorizeUrl.toString()
}

/**
 * Trusted Cognito token endpoint の JSON response と ID-token claims を検証し、
 * password login と共通の authentication response shape に変換します。
 *
 * @remarks
 * この helper は JWT signature verification を行いません。Caller は response を configured
 * Cognito HTTPS token endpoint から直接取得し、access token の通常検証も継続してください。
 */
export function parseEnterpriseSsoTokenResponse(
  input: ParseEnterpriseSsoTokenResponseInput,
): EnterpriseSsoAuthenticationResult {
  const response = readTokenResponse(input.response)
  const accessToken = readRequiredTokenText(response.access_token, 'access token')
  const idToken = readRequiredTokenText(response.id_token, 'ID token')
  const refreshToken = readOptionalTokenText(response.refresh_token, 'refresh token')
  const tokenType = readRequiredTokenText(response.token_type, 'token type')
  const expiresIn = response.expires_in

  if (
    tokenType.toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 86_400
  ) {
    throw invalidTokenResponseError()
  }

  const claims = parseIdTokenClaims(idToken)
  const expectedNonce = readBoundText(input.expectedNonce, 'nonce')
  const expectedEmail = normalizeEmail(input.expectedEmail)
  const expectedClientId = readBoundText(input.expectedClientId, 'client ID')
  const expectedIssuer = normalizeIssuer(input.expectedIssuer)
  const now = readEpochSeconds(input.now)
  const clockSkewSeconds = readClockSkew(input.clockSkewSeconds, 30)

  if (
    typeof claims.sub !== 'string' ||
    !claims.sub.trim() ||
    typeof claims.nonce !== 'string' ||
    !safeEqual(claims.nonce, expectedNonce) ||
    typeof claims.email !== 'string' ||
    !safeEqual(normalizeEmailForComparison(claims.email), expectedEmail) ||
    claims.email_verified !== true ||
    typeof claims.iss !== 'string' ||
    !safeEqual(normalizeIssuer(claims.iss), expectedIssuer) ||
    !matchesAudience(claims.aud, expectedClientId) ||
    claims.token_use !== 'id' ||
    typeof claims.exp !== 'number' ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= now - clockSkewSeconds ||
    (claims.iat !== undefined &&
      (typeof claims.iat !== 'number' ||
        !Number.isInteger(claims.iat) ||
        claims.iat > now + clockSkewSeconds))
  ) {
    throw new EnterpriseSsoError(
      401,
      'InvalidSsoIdToken',
      'Cognito returned an invalid enterprise SSO ID token.',
    )
  }

  return {
    accessToken,
    idToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: now * 1_000 + expiresIn * 1_000,
    tokenType: 'Bearer',
    returnTo: normalizeEnterpriseSsoReturnTo(input.returnTo),
  }
}

/**
 * Login 完了後の path を same-origin relative navigation に正規化します。
 */
export function normalizeEnterpriseSsoReturnTo(value: string | undefined): string {
  const candidate = value?.trim() || '/'
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    hasAsciiControl(candidate)
  ) {
    return '/'
  }

  try {
    const parsed = new URL(candidate, 'https://mukuroji.invalid')
    if (parsed.origin !== 'https://mukuroji.invalid') return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

function validateHmacSecret(secret: string) {
  if (Buffer.byteLength(secret, 'utf8') < minimumHmacSecretBytes) {
    throw new EnterpriseSsoError(
      500,
      'InvalidSsoStateSecret',
      'Enterprise SSO state secret must contain at least 32 bytes.',
    )
  }
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase()
  const atIndex = email.indexOf('@')
  if (
    !email ||
    atIndex < 1 ||
    atIndex !== email.lastIndexOf('@') ||
    atIndex === email.length - 1 ||
    email.length > 320 ||
    hasAsciiControl(email, true)
  ) {
    throw new EnterpriseSsoError(
      400,
      'InvalidSsoEmail',
      'A valid email address is required for enterprise SSO.',
    )
  }
  return email
}

function readBoundText(value: string, label: string) {
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > 2_048 ||
    hasAsciiControl(normalized)
  ) {
    throw new EnterpriseSsoError(
      400,
      'InvalidSsoConfiguration',
      `Enterprise SSO ${label} is invalid.`,
    )
  }
  return normalized
}

function readProviderRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new EnterpriseSsoError(
      400,
      'InvalidSsoConfiguration',
      'Enterprise SSO provider revision is invalid.',
    )
  }
  return value
}

function validateRedirectUri(value: string) {
  const raw = readBoundText(value, 'redirect URI')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new EnterpriseSsoError(
      400,
      'InvalidSsoRedirectUri',
      'Enterprise SSO redirect URI is invalid.',
    )
  }

  const localHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]')
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new EnterpriseSsoError(
      400,
      'InvalidSsoRedirectUri',
      'Enterprise SSO redirect URI must use HTTPS.',
    )
  }
  return raw
}

function normalizeCognitoDomain(value: string) {
  const raw = readBoundText(value, 'Cognito domain')
  const withProtocol = raw.includes('://') ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new EnterpriseSsoError(
      500,
      'InvalidCognitoDomain',
      'Configured Cognito domain is invalid.',
    )
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new EnterpriseSsoError(
      500,
      'InvalidCognitoDomain',
      'Configured Cognito domain must be an HTTPS origin.',
    )
  }
  return parsed
}

function createPkceCodeChallenge(codeVerifier: string) {
  if (!oauthCodeVerifierPattern.test(codeVerifier)) throw invalidStateError()
  return toBase64Url(createHash('sha256').update(codeVerifier, 'ascii').digest())
}

function readPkceChallenge(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new EnterpriseSsoError(
      400,
      'InvalidPkceChallenge',
      'Enterprise SSO PKCE challenge is invalid.',
    )
  }
  return value
}

function signState(encodedPayload: string, secret: string) {
  return toBase64Url(
    createHmac('sha256', secret)
      .update(`mukuroji-enterprise-sso-state-v${enterpriseSsoStateVersion}.`)
      .update(encodedPayload)
      .digest(),
  )
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function parseStatePayload(encodedPayload: string): EnterpriseSsoStatePayload {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    throw invalidStateError()
  }
  if (!isRecord(value)) throw invalidStateError()

  const payload = value as Partial<EnterpriseSsoStatePayload>
  if (
    payload.v !== enterpriseSsoStateVersion ||
    typeof payload.email !== 'string' ||
    typeof payload.providerId !== 'string' ||
    typeof payload.providerRevision !== 'number' ||
    !Number.isSafeInteger(payload.providerRevision) ||
    typeof payload.redirectUri !== 'string' ||
    typeof payload.returnTo !== 'string' ||
    typeof payload.codeChallenge !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.iat !== 'number' ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== 'number' ||
    !Number.isInteger(payload.exp)
  ) {
    throw invalidStateError()
  }

  try {
    return {
      v: enterpriseSsoStateVersion,
      email: normalizeEmail(payload.email),
      providerId: readBoundText(payload.providerId, 'provider ID'),
      providerRevision: readProviderRevision(payload.providerRevision),
      redirectUri: validateRedirectUri(payload.redirectUri),
      returnTo: normalizeEnterpriseSsoReturnTo(payload.returnTo),
      codeChallenge: readPkceChallenge(payload.codeChallenge),
      nonce: readBoundText(payload.nonce, 'nonce'),
      iat: payload.iat,
      exp: payload.exp,
    }
  } catch {
    throw invalidStateError()
  }
}

function readTokenResponse(value: unknown): CognitoOAuthTokenResponse {
  if (!isRecord(value)) throw invalidTokenResponseError()
  return value
}

function readRequiredTokenText(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 32_768 ||
    hasAsciiControl(value, true)
  ) {
    throw new EnterpriseSsoError(
      502,
      'InvalidSsoTokenResponse',
      `Cognito did not return a valid ${label}.`,
    )
  }
  return value
}

function readOptionalTokenText(value: unknown, label: string) {
  return value === undefined ? undefined : readRequiredTokenText(value, label)
}

function parseIdTokenClaims(idToken: string): EnterpriseIdTokenClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3 || !parts[1]) {
    throw invalidTokenResponseError()
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!isRecord(value)) throw new Error('ID token claims are not an object.')
    return value
  } catch (error) {
    throw invalidTokenResponseError(error)
  }
}

function matchesAudience(value: unknown, expectedClientId: string) {
  if (typeof value === 'string') return safeEqual(value, expectedClientId)
  if (!Array.isArray(value)) return false
  return value.some((audience) =>
    typeof audience === 'string' && safeEqual(audience, expectedClientId)
  )
}

function normalizeIssuer(value: string) {
  const raw = readBoundText(value, 'issuer')
  try {
    const issuer = new URL(raw)
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    ) {
      throw new Error('Issuer must be an HTTPS URL.')
    }
    return issuer.toString().replace(/\/$/u, '')
  } catch {
    throw new EnterpriseSsoError(
      500,
      'InvalidSsoIssuer',
      'Configured enterprise SSO issuer is invalid.',
    )
  }
}

function normalizeEmailForComparison(value: string) {
  try {
    return normalizeEmail(value)
  } catch {
    return ''
  }
}

function readEpochSeconds(value: number | undefined) {
  const result = value ?? Math.floor(Date.now() / 1_000)
  if (!Number.isInteger(result) || result < 0) {
    throw new EnterpriseSsoError(
      500,
      'InvalidSsoClock',
      'Enterprise SSO clock value is invalid.',
    )
  }
  return result
}

function readClockSkew(value: number | undefined, defaultValue: number) {
  const result = value ?? defaultValue
  if (!Number.isInteger(result) || result < 0 || result > 300) {
    throw new EnterpriseSsoError(
      500,
      'InvalidSsoClockSkew',
      'Enterprise SSO clock skew is invalid.',
    )
  }
  return result
}

function toBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasAsciiControl(value: string, includeSpace = false) {
  const maximumRejectedCodePoint = includeSpace ? 32 : 31
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= maximumRejectedCodePoint || codePoint === 127)
    ) {
      return true
    }
  }
  return false
}

function invalidStateError(cause?: unknown) {
  return new EnterpriseSsoError(
    401,
    'InvalidSsoState',
    'Enterprise SSO state is invalid.',
    cause === undefined ? undefined : { cause },
  )
}

function invalidTokenResponseError(cause?: unknown) {
  return new EnterpriseSsoError(
    502,
    'InvalidSsoTokenResponse',
    'Cognito returned an invalid enterprise SSO token response.',
    cause === undefined ? undefined : { cause },
  )
}
