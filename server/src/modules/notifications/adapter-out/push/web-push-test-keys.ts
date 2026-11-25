import { createDecipheriv, createECDH, createHmac } from 'node:crypto'

/** Browser key pair and secret from RFC 8291 Appendix A, used as a test subscription. */
export const RFC_8291_RECIPIENT = {
  privateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}

/**
 * Computes HMAC-SHA-256 over concatenated parts.
 * @param key - HMAC key.
 * @param parts - Message parts.
 * @returns Digest.
 */
function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

/**
 * Decrypts an `aes128gcm` Web Push body as the RFC 8291 test browser would.
 * @param body - Encrypted request body.
 * @returns Plaintext without the record delimiter.
 */
export function decryptAsTestBrowser(body: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const keyLength = body.readUInt8(20)
  const serverPublicKey = body.subarray(21, 21 + keyLength)
  const record = body.subarray(21 + keyLength)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(RFC_8291_RECIPIENT.privateKey, 'base64url'))
  const recipientPublicKey = Buffer.from(RFC_8291_RECIPIENT.p256dh, 'base64url')
  const ikm = hmac(hmac(Buffer.from(RFC_8291_RECIPIENT.auth, 'base64url'), ecdh.computeSecret(serverPublicKey)),
    Buffer.from('WebPush: info\0'), recipientPublicKey, serverPublicKey, Buffer.from([1]))
  const prk = hmac(salt, ikm)
  const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
  return padded.subarray(0, padded.lastIndexOf(2))
}
