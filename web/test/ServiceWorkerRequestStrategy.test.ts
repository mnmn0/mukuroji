import { describe, expect, test } from 'bun:test'
import {
  isCacheableAssetResponse,
  isSkipWaitingMessage,
  selectEvictedEntries,
  selectRequestStrategy,
  selectStaleCaches,
  skipWaitingMessageType,
  type RequestDescriptor,
} from '../src/service-worker/model/requestStrategy'

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
