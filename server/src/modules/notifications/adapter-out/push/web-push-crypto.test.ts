import { describe, expect, test } from 'bun:test'
import { createECDH, createPublicKey, verify } from 'node:crypto'
import { MAX_WEB_PUSH_PLAINTEXT_BYTES, createVapidAuthorization, encryptWebPushPayload, readVapidKeys } from './web-push-crypto'
import { RFC_8291_RECIPIENT, decryptAsTestBrowser } from './web-push-test-keys'

/**
 * Creates a fresh VAPID key pair as an operator would.
 * @returns Public and private keys as unpadded base64url.
 */
function vapidPair() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }
}

describe('Web Push encryption', () => {
  test('reproduces the RFC 8291 Appendix A message', () => {
    const body = encryptWebPushPayload(Buffer.from('When I grow up, I want to be a watermelon'), RFC_8291_RECIPIENT, {
      serverPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    })
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  test('uses a fresh key and salt for every message, which the browser can decrypt', () => {
    const plaintext = Buffer.from('{"title":"こんにちは"}')
    const first = encryptWebPushPayload(plaintext, RFC_8291_RECIPIENT)
    const second = encryptWebPushPayload(plaintext, RFC_8291_RECIPIENT)
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(decryptAsTestBrowser(first).toString()).toBe(plaintext.toString())
  })

  test('refuses oversized payloads and malformed subscription keys', () => {
    expect(() => encryptWebPushPayload(Buffer.alloc(MAX_WEB_PUSH_PLAINTEXT_BYTES + 1), RFC_8291_RECIPIENT)).toThrow('too large')
    expect(() => encryptWebPushPayload(Buffer.from('x'), { ...RFC_8291_RECIPIENT, auth: 'AAAA' })).toThrow('invalid')
  })
})

describe('VAPID', () => {
  test('signs an ES256 token for the push service origin that verifies with the public key', () => {
    const pair = vapidPair()
    const keys = readVapidKeys(pair.publicKey, `${pair.privateKey}\n`)
    const header = createVapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'https://app.example.test', new Date('2026-11-24T00:00:00Z'))
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    if (!match) throw new Error('Unexpected header')
    const [, encodedHeader = '', encodedClaims = '', signature = '', key] = match
    expect(key).toBe(pair.publicKey)
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-11-24T12:00:00Z') / 1_000, sub: 'https://app.example.test',
    })
    const point = Buffer.from(pair.publicKey, 'base64url')
    const publicKey = createPublicKey({ format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
    } })
    expect(verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'))).toBe(true)
  })

  test('rejects a private key that does not belong to the deployed public key', () => {
    expect(() => readVapidKeys(vapidPair().publicKey, vapidPair().privateKey)).toThrow('does not match')
    expect(() => readVapidKeys(vapidPair().publicKey, 'A'.repeat(50))).toThrow('invalid')
    expect(() => readVapidKeys(vapidPair().publicKey, '')).toThrow('invalid')
  })
})
