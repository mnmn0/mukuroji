import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'

/** Record size written into the aes128gcm header; one record always holds the whole payload. */
const RECORD_SIZE = 4_096

/** Largest plaintext accepted, so one record plus the header stays under the 4 KiB push limit. */
export const MAX_WEB_PUSH_PLAINTEXT_BYTES = 3_000

/** Longest VAPID token lifetime allowed by RFC 8292; tokens are issued for 12 hours. */
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

/** Recipient keys a browser issued with its push subscription. */
export type WebPushRecipientKeys = {
  /** Uncompressed P-256 public key, unpadded base64url. */
  p256dh: string
  /** 16-byte authentication secret, unpadded base64url. */
  auth: string
}

/** Values RFC 8291 draws at random, injectable so the published test vector can be reproduced. */
export type WebPushEncryptionRandomness = {
  /** Ephemeral P-256 private key of the application server, 32 bytes. */
  serverPrivateKey: Buffer
  /** 16-byte salt. */
  salt: Buffer
}

/** Validated VAPID key pair of this deployment. */
export type VapidKeys = {
  /** Uncompressed P-256 public key, unpadded base64url, as browsers received it. */
  publicKey: string
  /** Private key object used for ES256 signatures. */
  privateKey: KeyObject
}

/**
 * Computes HMAC-SHA-256, which is both HKDF-Extract and a single-block HKDF-Expand here.
 * @param key - HMAC key.
 * @param data - Message parts concatenated in order.
 * @returns 32-byte digest.
 */
function hmac(key: Buffer, ...data: Buffer[]): Buffer {
  const mac = createHmac('sha256', key)
  for (const part of data) mac.update(part)
  return mac.digest()
}

/**
 * Encrypts one Web Push message body with the `aes128gcm` content coding of RFC 8188 and the key
 * derivation of RFC 8291, so only the subscribed browser can read it.
 * @param plaintext - Message bytes; at most {@link MAX_WEB_PUSH_PLAINTEXT_BYTES}.
 * @param recipient - Subscription keys issued by the browser.
 * @param randomness - Fixed ephemeral key and salt for tests; fresh random values by default.
 * @returns The request body: header (salt, record size, server public key) and one encrypted record.
 */
export function encryptWebPushPayload(
  plaintext: Buffer,
  recipient: WebPushRecipientKeys,
  randomness?: WebPushEncryptionRandomness,
): Buffer {
  if (plaintext.length > MAX_WEB_PUSH_PLAINTEXT_BYTES) throw new Error('Web Push payload is too large.')
  const recipientPublicKey = Buffer.from(recipient.p256dh, 'base64url')
  const authSecret = Buffer.from(recipient.auth, 'base64url')
  if (recipientPublicKey.length !== 65 || recipientPublicKey[0] !== 0x04 || authSecret.length !== 16) {
    throw new Error('Web Push subscription keys are invalid.')
  }
  const ecdh = createECDH('prime256v1')
  if (randomness) ecdh.setPrivateKey(randomness.serverPrivateKey)
  else ecdh.generateKeys()
  const serverPublicKey = ecdh.getPublicKey()
  const salt = randomness?.salt ?? randomBytes(16)
  const sharedSecret = ecdh.computeSecret(recipientPublicKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), recipientPublicKey, serverPublicKey])
  const inputKeyingMaterial = hmac(hmac(authSecret, sharedSecret), keyInfo, Buffer.from([1]))
  const pseudoRandomKey = hmac(salt, inputKeyingMaterial)
  const contentKey = hmac(pseudoRandomKey, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16)
  const nonce = hmac(pseudoRandomKey, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  // 0x02 marks the last (and only) record; no extra padding is added.
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(serverPublicKey.length, 20)
  return Buffer.concat([header, serverPublicKey, ciphertext])
}

/**
 * Builds the VAPID private key from its raw scalar and checks it matches the public key that
 * browsers subscribed with, so a mismatched secret fails before any push service rejects it.
 * @param publicKey - Deploy-time public key, unpadded base64url uncompressed P-256 point.
 * @param privateKey - Secret raw 32-byte private scalar, unpadded base64url.
 * @returns Validated key pair.
 */
export function readVapidKeys(publicKey: string, privateKey: string): VapidKeys {
  const point = Buffer.from(publicKey, 'base64url')
  const encoded = Buffer.from(privateKey.trim(), 'base64url')
  if (point.length !== 65 || point[0] !== 0x04 || encoded.length === 0 || encoded.length > 32) throw new Error('VAPID keys are invalid.')
  // Some tools drop leading zero bytes of the scalar; JWK needs exactly 32 bytes.
  const scalar = Buffer.concat([Buffer.alloc(32 - encoded.length), encoded])
  const ecdh = createECDH('prime256v1')
  try {
    ecdh.setPrivateKey(scalar)
  } catch {
    throw new Error('VAPID keys are invalid.')
  }
  if (!ecdh.getPublicKey().equals(point)) throw new Error('VAPID private key does not match the public key.')
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256', d: scalar.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
    },
  })
  return { publicKey, privateKey: key }
}

/**
 * Creates the RFC 8292 `Authorization` header value for one push service origin.
 * @param keys - VAPID key pair.
 * @param endpoint - Push endpoint; its origin becomes the token audience.
 * @param subject - Contact URL (`https:` or `mailto:`) push services may use to reach the operator.
 * @param now - Issue time.
 * @returns `vapid t=<JWT>, k=<public key>`.
 */
export function createVapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now: Date): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1_000) + VAPID_TOKEN_LIFETIME_SECONDS,
    sub: subject,
  })}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`
}
