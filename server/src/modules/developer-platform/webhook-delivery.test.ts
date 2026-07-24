import { describe, expect, test } from 'bun:test'
import {
  UnsafeWebhookUrlError,
  assertSafeWebhookUrl,
  createWebhookRetryDelaySeconds,
  createWebhookSignature,
  deliverWebhookRequest,
  verifyWebhookSignature,
  type WebhookRequestTransport,
} from './webhook-delivery'

describe('webhook signature', () => {
  test('raw payload と timestamp を署名し timing-safe に検証する', () => {
    const payload = '{"id":"evt_1"}'
    const signature = createWebhookSignature('whsec_secret', 1_700_000_000, payload)
    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/)
    expect(verifyWebhookSignature({
      signingSecret: 'whsec_secret',
      timestamp: 1_700_000_000,
      payload,
      signature,
      now: 1_700_000_120,
    })).toBe(true)
    expect(verifyWebhookSignature({
      signingSecret: 'whsec_secret',
      timestamp: 1_700_000_000,
      payload: `${payload} `,
      signature,
      now: 1_700_000_120,
    })).toBe(false)
  })

  test('replay window 外の署名を拒否する', () => {
    const signature = createWebhookSignature('secret', 100, '{}')
    expect(verifyWebhookSignature({
      signingSecret: 'secret',
      timestamp: 100,
      payload: '{}',
      signature,
      now: 1_000,
    })).toBe(false)
  })
})

describe('webhook SSRF policy', () => {
  test('private hostname/IP と non-HTTPS URL を拒否する', async () => {
    await expect(assertSafeWebhookUrl(
      'https://hooks.example.com/path',
      async () => [{ address: '10.0.0.4', family: 4 }],
    )).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(assertSafeWebhookUrl(
      'http://hooks.example.com/path',
      async () => [{ address: '203.0.113.4', family: 4 }],
    )).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(assertSafeWebhookUrl(
      'https://hooks.example.com/path',
      async () => [{ address: '::ffff:7f00:1', family: 6 }],
    )).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(assertSafeWebhookUrl(
      'https://hooks.example.com/path',
      async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    )).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(assertSafeWebhookUrl(
      'https://hooks.example.com/path',
      async () => [{ address: '93.184.216.34', family: 6 }],
    )).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
  })

  test('public HTTPS endpoint を受け入れる', async () => {
    const url = await assertSafeWebhookUrl(
      'https://hooks.example.com/mukuroji',
      async () => [{ address: '93.184.216.34', family: 4 }],
    )
    expect(url.hostname).toBe('hooks.example.com')
  })
})

describe('webhook delivery policy', () => {
  test('signature headers を付けて検証済み address へ固定送信する', async () => {
    let request: Parameters<WebhookRequestTransport>[0] | undefined
    const result = await deliverWebhookRequest(
      {
        deliveryId: 'dlv_1',
        eventId: 'evt_1',
        url: 'https://hooks.example.com/hook',
        signingSecret: 'secret',
        payload: '{"ok":true}',
        timestamp: 1_700_000_000,
      },
      {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async (input) => {
          request = input
          return { status: 204, retryAfter: null }
        },
      },
    )
    expect(result).toEqual({ succeeded: true, retryable: false, responseStatus: 204 })
    expect(request?.hostname).toBe('hooks.example.com')
    expect(request?.address.address).toBe('93.184.216.34')
    expect(request?.headers['X-Mukuroji-Event-Id']).toBe('evt_1')
    expect(request?.headers['X-Mukuroji-Delivery-Id']).toBe('dlv_1')
    expect(request?.headers['X-Mukuroji-Timestamp']).toBe('1700000000')
    expect(request?.headers['X-Mukuroji-Signature']).toMatch(/^v1=/)
    expect(request?.headers['Idempotency-Key']).toBe('dlv_1')
  })

  test('DNS 検証済み address を transport に固定して再解決を防ぐ', async () => {
    const addresses: string[] = []
    await deliverWebhookRequest(
      { deliveryId: 'd1', eventId: 'e1', url: 'https://hooks.example.com', signingSecret: 's', payload: '{}' },
      {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async (input) => {
          addresses.push(input.address.address)
          return { status: 204, retryAfter: null }
        },
      },
    )
    expect(addresses).toEqual(['93.184.216.34'])
  })

  test('429 と 5xx を retryable、通常の 4xx を terminal にする', async () => {
    for (const status of [429, 500, 503]) {
      const retryable = await deliverWebhookRequest(
        { deliveryId: 'd1', eventId: 'e1', url: 'https://93.184.216.34', signingSecret: 's', payload: '{}' },
        {
          resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ status, retryAfter: '30' }),
        },
      )
      expect(retryable).toMatchObject({
        retryable: true,
        responseStatus: status,
        retryAfterSeconds: 30,
      })
    }

    for (const status of [409, 422]) {
      const terminal = await deliverWebhookRequest(
        { deliveryId: 'd2', eventId: 'e2', url: 'https://93.184.216.34', signingSecret: 's', payload: '{}' },
        {
          resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ status, retryAfter: null }),
        },
      )
      expect(terminal).toMatchObject({ retryable: false, responseStatus: status })
    }
  })

  test('full-jitter backoff と Retry-After cap を適用する', () => {
    expect(createWebhookRetryDelaySeconds(3, undefined, () => 0.5)).toBe(30)
    expect(createWebhookRetryDelaySeconds(1, 99_999)).toBe(43_200)
  })
})
