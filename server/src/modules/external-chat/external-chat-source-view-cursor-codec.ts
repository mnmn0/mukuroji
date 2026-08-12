import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import type { ExternalChatProvider } from '@mukuroji/contracts'
import { ExternalChatError } from './external-chat'
import type {
  ExternalChatSyncCursorCodecPort,
  ExternalChatSyncCursorScope,
} from './external-chat-sync-service'

/** Current authenticated source-view cursor envelope version. */
const CURSOR_VERSION = 'v1'

/** AES-GCM nonce length recommended for one randomly generated envelope. */
const CURSOR_NONCE_BYTES = 12

/** AES-256 key length required by the cursor key boundary. */
const CURSOR_KEY_BYTES = 32

/** Maximum accepted encoded application cursor size. */
const MAXIMUM_CURSOR_BYTES = 32_768

/** Maximum private provider continuation retained inside one cursor. */
const MAXIMUM_PROVIDER_CURSOR_BYTES = 16_384

/** Default application cursor lifetime. */
const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1_000

/** Maximum configurable application cursor lifetime. */
const MAXIMUM_CURSOR_TTL_MS = 24 * 60 * 60 * 1_000

/** One active or retained rotation key used for authenticated cursor envelopes. */
export type ExternalChatSourceViewCursorKey = {
  /** Public rotation identifier embedded in the cursor envelope. */
  keyId: string
  /** Exactly 32 secret bytes used only for AES-256-GCM. */
  key: Uint8Array
}

/** Workspace-scoped key resolver supporting non-disruptive cursor key rotation. */
export interface ExternalChatSourceViewCursorKeyPort {
  /** Resolves the active encryption key for a newly issued cursor. */
  getActiveKey(workspaceId: string): Promise<ExternalChatSourceViewCursorKey>
  /** Resolves an active or retained decryption key by its public rotation identifier. */
  getKey(workspaceId: string, keyId: string): Promise<ExternalChatSourceViewCursorKey | undefined>
}

/** Clock boundary used for deterministic cursor expiry tests and runtime decisions. */
export interface ExternalChatSourceViewCursorClockPort {
  /** Returns the current canonical ISO 8601 UTC timestamp. */
  now(): string
}

/** Optional bounded authenticated cursor policy. */
export type AuthenticatedExternalChatSyncCursorCodecOptions = {
  /** Cursor lifetime in milliseconds, capped at 24 hours. */
  ttlMs?: number
}

/** Dependencies for the production-grade authenticated source-view cursor codec. */
export type AuthenticatedExternalChatSyncCursorCodecDependencies = {
  /** Workspace-scoped cursor key resolver. */
  keys: ExternalChatSourceViewCursorKeyPort
  /** Canonical server clock. */
  clock: ExternalChatSourceViewCursorClockPort
  /** Optional bounded expiry policy. */
  options?: AuthenticatedExternalChatSyncCursorCodecOptions
}

/** Exact encrypted cursor payload bound to viewer, owner, provider, and authorization generation. */
type ExternalChatSourceViewCursorPayload = {
  /** Payload schema version. */
  version: 1
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Internal principal that requested the source view. */
  principalId: string
  /** Link that owns the private provider continuation. */
  linkId: string
  /** Provider that produced the private continuation. */
  provider: ExternalChatProvider
  /** Link ownership revision current when the cursor was issued. */
  linkRevision: number
  /** Viewer provider authorization generation current when the cursor was issued. */
  authorizationRevision: number
  /** Private provider continuation encrypted inside the envelope. */
  providerCursor: string
  /** Canonical cursor issuance timestamp. */
  issuedAt: string
  /** Canonical exclusive cursor expiry timestamp. */
  expiresAt: string
}

/** AES-256-GCM cursor codec that never exposes or accepts a bare provider continuation. */
export class AuthenticatedExternalChatSyncCursorCodec
implements ExternalChatSyncCursorCodecPort {
  /** Workspace-scoped rotation key boundary. */
  private readonly keys: ExternalChatSourceViewCursorKeyPort

  /** Canonical server clock. */
  private readonly clock: ExternalChatSourceViewCursorClockPort

  /** Bounded cursor lifetime. */
  private readonly ttlMs: number

  /**
   * Creates an authenticated opaque source-view cursor codec.
   *
   * @param dependencies - Key resolver, clock, and optional expiry policy.
   */
  constructor(dependencies: AuthenticatedExternalChatSyncCursorCodecDependencies) {
    this.keys = dependencies.keys
    this.clock = dependencies.clock
    this.ttlMs = requireCursorTtl(
      dependencies.options?.ttlMs ?? DEFAULT_CURSOR_TTL_MS,
    )
  }

  /** Authenticates, decrypts, expires, and exact-scope checks one application cursor. */
  async decode(scope: ExternalChatSyncCursorScope, cursor: string): Promise<string> {
    validateCursorScope(scope)
    if (
      typeof cursor !== 'string' ||
      cursor.length === 0 ||
      Buffer.byteLength(cursor, 'utf8') > MAXIMUM_CURSOR_BYTES
    ) throw invalidCursor()
    const parts = cursor.split('.')
    if (parts.length !== 5 || parts[0] !== CURSOR_VERSION) throw invalidCursor()
    const keyId = requireTokenPart(parts[1])
    const nonce = decodeTokenPart(parts[2])
    const ciphertext = decodeTokenPart(parts[3])
    const authenticationTag = decodeTokenPart(parts[4])
    if (nonce.byteLength !== CURSOR_NONCE_BYTES || authenticationTag.byteLength !== 16) {
      throw invalidCursor()
    }
    const resolved = await this.keys.getKey(scope.workspaceId, keyId)
    if (!resolved || resolved.keyId !== keyId) throw invalidCursor()
    const key = validateCursorKey(resolved)
    let plaintext: Buffer
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(Buffer.from(`${CURSOR_VERSION}.${keyId}`, 'utf8'))
      decipher.setAuthTag(authenticationTag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw invalidCursor()
    }
    const payload = parseCursorPayload(plaintext)
    if (!sameCursorScope(payload, scope)) throw invalidCursor()
    const now = canonicalTimestampMilliseconds(this.clock.now())
    if (now >= canonicalTimestampMilliseconds(payload.expiresAt)) throw invalidCursor()
    return payload.providerCursor
  }

  /** Encrypts one private provider continuation for the exact authorization generation. */
  async encode(scope: ExternalChatSyncCursorScope, providerCursor: string): Promise<string> {
    validateCursorScope(scope)
    requireProviderCursor(providerCursor)
    const now = this.clock.now()
    const nowMilliseconds = canonicalTimestampMilliseconds(now)
    const resolved = await this.keys.getActiveKey(scope.workspaceId)
    const key = validateCursorKey(resolved)
    const keyId = requireTokenPart(resolved.keyId)
    const payload: ExternalChatSourceViewCursorPayload = {
      version: 1,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      linkId: scope.linkId,
      provider: scope.provider,
      linkRevision: scope.linkRevision,
      authorizationRevision: scope.authorizationRevision,
      providerCursor,
      issuedAt: now,
      expiresAt: new Date(nowMilliseconds + this.ttlMs).toISOString(),
    }
    const nonce = randomBytes(CURSOR_NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`${CURSOR_VERSION}.${keyId}`, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ])
    const authenticationTag = cipher.getAuthTag()
    return [
      CURSOR_VERSION,
      keyId,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      authenticationTag.toString('base64url'),
    ].join('.')
  }
}

/** Validates one cursor scope before it reaches key lookup or cryptography. */
function validateCursorScope(scope: ExternalChatSyncCursorScope): void {
  requireBoundedIdentifier(scope.workspaceId)
  requireBoundedIdentifier(scope.principalId)
  requireBoundedIdentifier(scope.linkId)
  if (scope.provider !== 'slack' && scope.provider !== 'microsoft-teams') throw invalidCursor()
  requirePositiveInteger(scope.linkRevision)
  requirePositiveInteger(scope.authorizationRevision)
}

/** Validates and copies one exact AES-256 rotation key. */
function validateCursorKey(resolved: ExternalChatSourceViewCursorKey): Buffer {
  requireTokenPart(resolved.keyId)
  if (!(resolved.key instanceof Uint8Array) || resolved.key.byteLength !== CURSOR_KEY_BYTES) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'The external chat cursor key is invalid.',
    )
  }
  return Buffer.from(resolved.key)
}

/** Parses and deep-validates one decrypted cursor payload. */
function parseCursorPayload(plaintext: Buffer): ExternalChatSourceViewCursorPayload {
  let value: unknown
  try {
    value = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  if (!isRecord(value)) throw invalidCursor()
  if (
    value.version !== 1 ||
    (value.provider !== 'slack' && value.provider !== 'microsoft-teams') ||
    !isBoundedIdentifier(value.workspaceId) ||
    !isBoundedIdentifier(value.principalId) ||
    !isBoundedIdentifier(value.linkId) ||
    !isPositiveInteger(value.linkRevision) ||
    !isPositiveInteger(value.authorizationRevision) ||
    !isProviderCursor(value.providerCursor) ||
    !isCanonicalTimestamp(value.issuedAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  ) throw invalidCursor()
  return {
    version: 1,
    workspaceId: value.workspaceId,
    principalId: value.principalId,
    linkId: value.linkId,
    provider: value.provider,
    linkRevision: value.linkRevision,
    authorizationRevision: value.authorizationRevision,
    providerCursor: value.providerCursor,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  }
}

/** Checks that an authenticated payload matches every current authorization generation field. */
function sameCursorScope(
  payload: ExternalChatSourceViewCursorPayload,
  scope: ExternalChatSyncCursorScope,
): boolean {
  return payload.workspaceId === scope.workspaceId &&
    payload.principalId === scope.principalId &&
    payload.linkId === scope.linkId &&
    payload.provider === scope.provider &&
    payload.linkRevision === scope.linkRevision &&
    payload.authorizationRevision === scope.authorizationRevision
}

/** Requires one bounded cursor lifetime. */
function requireCursorTtl(value: unknown): number {
  if (!isPositiveInteger(value) || value > MAXIMUM_CURSOR_TTL_MS) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The external chat cursor lifetime is invalid.',
    )
  }
  return value
}

/** Requires one positive safe integer. */
function requirePositiveInteger(value: unknown): number {
  if (!isPositiveInteger(value)) throw invalidCursor()
  return value
}

/** Checks one positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Requires one bounded nonempty tenant or principal identifier. */
function requireBoundedIdentifier(value: unknown): string {
  if (!isBoundedIdentifier(value)) throw invalidCursor()
  return value
}

/** Checks one bounded nonempty identifier without control characters. */
function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= 2_048 &&
    !/\p{Cc}/u.test(value)
}

/** Requires one URL-safe nonempty envelope component. */
function requireTokenPart(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) {
    throw invalidCursor()
  }
  return value
}

/** Decodes one canonical URL-safe base64 envelope component. */
function decodeTokenPart(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAXIMUM_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) throw invalidCursor()
  const token = value
  const decoded = Buffer.from(token, 'base64url')
  if (decoded.toString('base64url') !== token) throw invalidCursor()
  return decoded
}

/** Requires one bounded private provider continuation. */
function requireProviderCursor(value: unknown): string {
  if (!isProviderCursor(value)) throw invalidCursor()
  return value
}

/** Checks one nonempty bounded private provider continuation. */
function isProviderCursor(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAXIMUM_PROVIDER_CURSOR_BYTES
}

/** Parses one required canonical timestamp. */
function canonicalTimestampMilliseconds(value: unknown): number {
  if (!isCanonicalTimestamp(value)) throw invalidCursor()
  return Date.parse(value)
}

/** Checks one canonical millisecond-precision UTC timestamp. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

/** Narrows an unknown JSON layer to a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates one intentionally generic cursor failure that exposes no scope or key details. */
function invalidCursor(): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatValidationFailed',
    'The external chat source-view cursor is invalid or expired.',
  )
}
