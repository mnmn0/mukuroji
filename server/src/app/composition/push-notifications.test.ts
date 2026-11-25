import { describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import { createProductionPushNotificationHandler, createVapidKeyLoader } from './push-notifications'

describe('Web Push notification composition', () => {
  test('stays idle without a configured VAPID public key', async () => {
    const previous = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    try {
      expect(await createProductionPushNotificationHandler()()).toBe(0)
    } finally {
      if (previous !== undefined) process.env.WEB_PUSH_VAPID_PUBLIC_KEY = previous
    }
  })

  test('reads the private key once, and again after a failed read', async () => {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const responses: Array<string | undefined | Error> = [new Error('throttled'), ecdh.getPrivateKey().toString('base64url')]
    let reads = 0
    const load = createVapidKeyLoader(ecdh.getPublicKey().toString('base64url'), async () => {
      const response = responses[reads]
      reads += 1
      if (response instanceof Error) throw response
      return response
    })
    await expect(load()).rejects.toThrow('throttled')
    const keys = await load()
    expect(await load()).toBe(keys)
    expect(reads).toBe(2)
  })

  test('refuses an empty or mismatched secret', async () => {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    await expect(createVapidKeyLoader(ecdh.getPublicKey().toString('base64url'), async () => '')()).rejects.toThrow('empty')
    const other = createECDH('prime256v1')
    other.generateKeys()
    await expect(createVapidKeyLoader(ecdh.getPublicKey().toString('base64url'), async () => other.getPrivateKey().toString('base64url'))())
      .rejects.toThrow('does not match')
  })
})
