import { describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import type { ChannelDelivery } from '../../application/channel-delivery'
import type { PushDevice } from '../../application/ports/push-device-directory'
import { readVapidKeys } from './web-push-crypto'
import { createWebPushNotificationSender, renderPushNotification, type WebPushHttpClient } from './web-push-sender'
import { RFC_8291_RECIPIENT, decryptAsTestBrowser } from './web-push-test-keys'

const delivery: ChannelDelivery = {
  workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
  notificationKey: 'key', attempts: 0, version: 1, nextAttemptAt: '2026-11-24T00:00:00.000Z', expiresAt: 2_000_000_000,
  notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created', reasons: ['mention'],
    title: 'Review\nplease', summary: 'Please review', deepLink: '/teams/core/issues/CORE-1?tab=activity',
    occurredAt: '2026-11-23T23:00:00.000Z', state: 'unread' },
}

const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
const keys = readVapidKeys(ecdh.getPublicKey().toString('base64url'), ecdh.getPrivateKey().toString('base64url'))

/**
 * Creates a test device on an allowlisted push host.
 * @param name - Endpoint suffix.
 * @returns Device with the RFC 8291 browser keys.
 */
function device(name: string): PushDevice {
  return {
    subscriptionId: name, endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: RFC_8291_RECIPIENT.p256dh, auth: RFC_8291_RECIPIENT.auth }, updatedAt: '2026-11-20T00:00:00.000Z',
  }
}

/**
 * Creates a sender over fixed devices and push service statuses.
 * @param devices - Registered devices, or an error to throw on lookup.
 * @param statuses - Status per endpoint, or an error to throw.
 * @returns Sender, recorded requests, and removed device IDs.
 */
function sender(devices: PushDevice[] | Error, statuses: Record<string, number | Error>) {
  const requests: Array<{ endpoint: string, headers: Record<string, string>, body: Buffer }> = []
  const removed: string[] = []
  const post: WebPushHttpClient = async (endpoint, request) => {
    requests.push({ endpoint, headers: request.headers, body: request.body })
    const status = statuses[endpoint] ?? 201
    if (status instanceof Error) throw status
    return { status, headers: { get: (name: string) => name === 'retry-after' && status === 429 ? '120' : null } }
  }
  const send = createWebPushNotificationSender({
    appOrigin: 'https://app.example.test', loadKeys: async () => keys, post,
    devices: {
      listDevices: async (workspaceId, memberKey) => {
        expect([workspaceId, memberKey]).toEqual([delivery.workspaceId, delivery.memberKey])
        if (devices instanceof Error) throw devices
        return devices
      },
      removeGoneDevice: async (_workspaceId, _memberKey, gone) => { removed.push(gone.subscriptionId) },
    },
    now: () => new Date('2026-11-24T00:00:00Z'),
  })
  return { send, requests, removed }
}

describe('Web Push notification sender', () => {
  test('sends an encrypted, VAPID-signed message with the Inbox path to every owned device', async () => {
    const f = sender([device('a'), device('b')], {})
    expect(await f.send(delivery)).toEqual({ succeeded: true, retryable: false })
    expect(f.requests.map((request) => request.endpoint)).toEqual([device('a').endpoint, device('b').endpoint])
    expect(f.requests[0]?.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '86400', Urgency: 'normal' })
    expect(f.requests[0]?.headers.Authorization).toStartWith('vapid t=')
    expect(JSON.parse(decryptAsTestBrowser(f.requests[0]?.body ?? Buffer.alloc(0)).toString())).toEqual({
      title: 'Review please', body: 'Please review', path: '/teams/core/issues/CORE-1?tab=activity', tag: 'notification-1',
    })
  })

  test('deletes devices the push service reports as gone and suppresses when none remain', async () => {
    const f = sender([device('a'), device('b')], { [device('a').endpoint]: 410, [device('b').endpoint]: 404 })
    expect(await f.send(delivery)).toEqual({ succeeded: false, retryable: false, suppressed: true, code: 'PushNoDevices' })
    expect(f.removed).toEqual(['a', 'b'])
    expect(await sender([], {}).send(delivery)).toMatchObject({ suppressed: true, code: 'PushNoDevices' })
  })

  test('counts the notification as sent once any device accepts it', async () => {
    const f = sender([device('a'), device('b')], { [device('a').endpoint]: 503 })
    expect(await f.send(delivery)).toEqual({ succeeded: true, retryable: false })
  })

  test('retries throttling and outages with the requested delay, and stops on VAPID rejections', async () => {
    expect(await sender([device('a')], { [device('a').endpoint]: 429 }).send(delivery))
      .toEqual({ succeeded: false, retryable: true, code: 'PushDeliveryUnavailable', retryAfterMs: 120_000 })
    expect(await sender([device('a')], { [device('a').endpoint]: new Error('reset') }).send(delivery))
      .toMatchObject({ retryable: true, code: 'PushDeliveryUnavailable' })
    expect(await sender([device('a')], { [device('a').endpoint]: 403 }).send(delivery))
      .toEqual({ succeeded: false, retryable: false, code: 'PushDeliveryRejected' })
    expect(await sender(new Error('DynamoDB down'), {}).send(delivery))
      .toMatchObject({ retryable: true, code: 'PushDevicesUnavailable' })
  })

  test('never posts to an endpoint outside the push service allowlist', async () => {
    const f = sender([{ ...device('a'), endpoint: 'https://attacker.example.test/push' }], {})
    expect(await f.send(delivery)).toMatchObject({ suppressed: true })
    expect(f.requests).toEqual([])
    expect(f.removed).toEqual(['a'])
  })

  test('keeps the payload within one record and links only to the app origin', () => {
    const long = { ...delivery, notification: { ...delivery.notification, summary: '長'.repeat(5_000), deepLink: 'https://evil.example.test/' } }
    const payload = renderPushNotification(long, 'https://app.example.test')
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(3_000)
    expect(payload.path).toBe('/')
  })
})
