import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

/** Creates an internal identifier with a random UUID payload. */
export function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

/** Creates a public opaque identifier with 144 bits of entropy. */
export function createPublicIdentifier(prefix: string) {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

/** Creates a one-time secret with 256 bits of entropy. */
export function createSecret(prefix: string) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

/** Creates a stable SHA-256 digest for non-secret text. */
export function digestText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Creates a version-separated digest for Developer Platform secrets. */
export function digestSecret(value: string) {
  return digestText(`developer-secret-v1\0${value}`)
}

/** Creates a version-separated digest for connector credentials. */
export function digestConnectorCredential(value: string) {
  return digestText(`connector-credential-v1\0${value}`)
}

/** Creates a version-separated digest for connector refresh claims. */
export function digestConnectorCredentialRefreshClaim(value: string) {
  return digestText(`connector-credential-refresh-claim-v1\0${value}`)
}

/** Creates a version-separated digest for connector OAuth state identifiers. */
export function digestConnectorOAuthState(value: string) {
  return digestText(`connector-oauth-state-v1\0${value}`)
}

/** Compares two strings without leaking matching-prefix timing. */
export function safeTextEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

/** Compares two stored secret digests without leaking matching-prefix timing. */
export function secretDigestsEqual(left: string, right: string) {
  return safeTextEqual(left, right)
}
