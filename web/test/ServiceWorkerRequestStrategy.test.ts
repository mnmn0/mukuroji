import { describe, expect, test } from 'bun:test'
import {
  createSerialRunner,
  hasSharedContentCapacity,
  maxPendingSharedContent,
  createSharedContentFailurePath,
  createSharedContentRedirectPath,
  isCacheableAssetResponse,
  isSkipWaitingMessage,
  readSharedFormFields,
  selectEvictedEntries,
  selectExpiredSharedContent,
  selectRequestStrategy,
  selectStaleCaches,
  sharedContentCacheName,
  sharedContentKeyPrefix,
  sharedContentMaxAgeMilliseconds,
  sharedContentNotSavedStatus,
  skipWaitingMessageType,
  type RequestDescriptor,
} from '../src/service-worker/model/requestStrategy'
import * as sharedContentInbox from '../src/shared/lib/pwa/sharedContentInbox'

const origin = 'https://app.mukuroji.example'

/**
 * Builds a request descriptor with same-origin GET defaults.
 *
 * @param overrides - Fields that differ from the default asset request.
 * @returns A complete descriptor.
 */
function request(overrides: Partial<RequestDescriptor>): RequestDescriptor {
  return {
    method: 'GET',
    url: `${origin}/assets/index-AbC123.js`,
    mode: 'cors',
    cache: 'default',
    hasRangeHeader: false,
    ...overrides,
  }
}

describe('selectRequestStrategy', () => {
  test('serves hashed build assets cache-first', () => {
    expect(selectRequestStrategy(request({}), origin)).toBe('cache-first-asset')
    expect(selectRequestStrategy(request({ url: `${origin}/assets/index-Z9.css`, mode: 'no-cors' }), origin))
      .toBe('cache-first-asset')
  })

  test('fetches every navigation from the network first, including share and intake links', () => {
    for (const path of ['/home', '/share/documents/token-1', '/request/link-1', '/auth/sso/callback?code=x']) {
      expect(selectRequestStrategy(request({ url: `${origin}${path}`, mode: 'navigate' }), origin))
        .toBe('network-first-navigation')
    }
  })

  test('serves the offline page resources from the shell cache', () => {
    for (const path of ['/offline.css', '/offline.js', '/pwa-192x192.png']) {
      expect(selectRequestStrategy(request({ url: `${origin}${path}`, mode: 'no-cors' }), origin))
        .toBe('cache-first-offline-resource')
    }
    expect(selectRequestStrategy(request({ url: `${origin}/offline.js?v=2` }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ url: `${origin}/pwa-512x512.png` }), origin)).toBe('passthrough')
  })

  test('never intercepts API, public API, or developer platform requests', () => {
    for (const path of ['/api/auth/me', '/api/work-items?cursor=a', '/v1/work-items', '/developer/api-keys']) {
      expect(selectRequestStrategy(request({ url: `${origin}${path}` }), origin)).toBe('passthrough')
    }
  })

  test('does not intercept writes, ranges, cross-origin, or query-string assets', () => {
    expect(selectRequestStrategy(request({ method: 'POST' }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ method: 'post', mode: 'navigate' }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ hasRangeHeader: true }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ url: 'https://cdn.example/assets/a.js' }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ url: `${origin}/assets/a.js?v=2` }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ url: `${origin}/favicon.svg` }), origin)).toBe('passthrough')
  })

  test('skips only-if-cached requests outside same-origin mode and malformed URLs', () => {
    expect(selectRequestStrategy(request({ cache: 'only-if-cached', mode: 'no-cors' }), origin)).toBe('passthrough')
    expect(selectRequestStrategy(request({ cache: 'only-if-cached', mode: 'same-origin' }), origin))
      .toBe('cache-first-asset')
    expect(selectRequestStrategy(request({ url: 'not a url' }), origin)).toBe('passthrough')
  })
})

describe('cache maintenance', () => {
  test('stores only complete same-origin responses', () => {
    expect(isCacheableAssetResponse({ status: 200, type: 'basic' })).toBe(true)
    expect(isCacheableAssetResponse({ status: 206, type: 'basic' })).toBe(false)
    expect(isCacheableAssetResponse({ status: 404, type: 'basic' })).toBe(false)
    expect(isCacheableAssetResponse({ status: 0, type: 'opaque' })).toBe(false)
  })

  test('evicts the oldest entries beyond the bound', () => {
    expect(selectEvictedEntries(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
    expect(selectEvictedEntries(['a'], 2)).toEqual([])
    expect(selectEvictedEntries(['a', 'b'], -1)).toEqual(['a', 'b'])
  })

  test('deletes only stale caches owned by the worker', () => {
    expect(selectStaleCaches(
      ['mukuroji-assets-v0', 'mukuroji-assets-v1', 'mukuroji-shell-v1', 'other-app-cache'],
      'mukuroji-',
      ['mukuroji-assets-v1', 'mukuroji-shell-v1'],
    )).toEqual(['mukuroji-assets-v0'])
  })
})

describe('isSkipWaitingMessage', () => {
  test('accepts only the skip-waiting message shape', () => {
    expect(isSkipWaitingMessage({ type: skipWaitingMessageType })).toBe(true)
    expect(isSkipWaitingMessage({ type: 'other' })).toBe(false)
    expect(isSkipWaitingMessage(skipWaitingMessageType)).toBe(false)
    expect(isSkipWaitingMessage(null)).toBe(false)
  })
})

describe('share target', () => {
  test('handles only a same-origin POST /share navigation', () => {
    expect(selectRequestStrategy(request({ method: 'POST', url: `${origin}/share`, mode: 'navigate' }), origin))
      .toBe('share-target')
    expect(selectRequestStrategy(request({ method: 'post', url: `${origin}/share`, mode: 'navigate' }), origin))
      .toBe('share-target')
    expect(selectRequestStrategy(request({ method: 'POST', url: `${origin}/share`, mode: 'cors' }), origin))
      .toBe('passthrough')
    expect(selectRequestStrategy(request({ method: 'POST', url: `${origin}/share?x=1`, mode: 'navigate' }), origin))
      .toBe('passthrough')
    expect(selectRequestStrategy(request({ method: 'POST', url: `${origin}/share/x`, mode: 'navigate' }), origin))
      .toBe('passthrough')
    expect(selectRequestStrategy(request({ method: 'POST', url: 'https://evil.example/share', mode: 'navigate' }), origin))
      .toBe('passthrough')
    // A GET /share navigation is the confirmation form itself.
    expect(selectRequestStrategy(request({ url: `${origin}/share?shared=abc`, mode: 'navigate' }), origin))
      .toBe('network-first-navigation')
  })

  test('reads only text fields and bounds their length', () => {
    const values = new Map<string, unknown>([
      ['title', 'Bug'],
      ['text', 'x'.repeat(20_000)],
      ['url', new Blob(['not text'])],
    ])
    const fields = readSharedFormFields((name) => values.get(name) ?? null)
    expect(fields.title).toBe('Bug')
    expect(fields.text.length).toBe(16_000)
    expect(fields.url).toBe('')
  })

  test('passes only the opaque ID to the confirmation form', () => {
    expect(createSharedContentRedirectPath('a-b')).toBe('/share?shared=a-b')
  })

  test('sends a share the worker could not keep to an explanation', () => {
    expect(createSharedContentFailurePath()).toBe('/share?status=not-saved')
  })

  test('expires unread content after the retention window', () => {
    const now = 10 * sharedContentMaxAgeMilliseconds
    expect(selectExpiredSharedContent([
      { key: 'fresh', receivedAt: now - 1_000 },
      { key: 'edge', receivedAt: now - sharedContentMaxAgeMilliseconds },
      { key: 'old', receivedAt: now - sharedContentMaxAgeMilliseconds - 1 },
      { key: 'unknown', receivedAt: undefined },
    ], now)).toEqual(['old', 'unknown'])
  })

  test('bounds the number of pending shares', () => {
    expect(hasSharedContentCapacity(0)).toBe(true)
    expect(hasSharedContentCapacity(maxPendingSharedContent - 1)).toBe(true)
    expect(hasSharedContentCapacity(maxPendingSharedContent)).toBe(false)
  })

  test('admits concurrent shares one at a time so the capacity check cannot be raced', async () => {
    const run = createSerialRunner()
    const stored: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    /**
     * Stores a share when the inbox has room, after an optional delay between check and write.
     *
     * @param id - Share ID.
     * @param gate - Settles when the write may proceed.
     * @returns Whether the share was stored.
     */
    async function store(id: string, gate: Promise<void>): Promise<boolean> {
      const hasRoom = stored.length < 1
      await gate
      if (!hasRoom) return false
      stored.push(id)
      return true
    }

    const first = run(() => store('first', firstGate))
    const second = run(() => store('second', Promise.resolve()))
    releaseFirst()

    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(stored).toEqual(['first'])
  })

  test('keeps admitting shares after a failed write', async () => {
    const run = createSerialRunner()
    const failed = run(() => Promise.reject(new Error('quota')))
    const next = run(() => Promise.resolve('stored'))

    await expect(failed).rejects.toThrow('quota')
    expect(await next).toBe('stored')
  })

  test('shares the cache name and key prefix with the app', () => {
    expect(sharedContentInbox.sharedContentCacheName).toBe(sharedContentCacheName)
    expect(sharedContentInbox.sharedContentKeyPrefix).toBe(sharedContentKeyPrefix)
    expect(sharedContentInbox.sharedContentMaxAgeMilliseconds).toBe(sharedContentMaxAgeMilliseconds)
    expect(sharedContentInbox.sharedContentNotSavedStatus).toBe(sharedContentNotSavedStatus)
    // An earlier worker deletes the inbox on activation, so a rollback never strands shared content;
    // the current worker keeps it.
    expect(selectStaleCaches([sharedContentCacheName], 'mukuroji-', [])).toEqual([sharedContentCacheName])
    expect(selectStaleCaches([sharedContentCacheName], 'mukuroji-', [sharedContentCacheName])).toEqual([])
  })
})
