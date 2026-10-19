/// <reference lib="webworker" />

import {
  createSharedContentRedirectPath,
  isCacheableAssetResponse,
  isSkipWaitingMessage,
  maxCachedAssetEntries,
  offlineFallbackPath,
  offlineShellResourcePaths,
  readSharedFormFields,
  selectEvictedEntries,
  selectExpiredSharedContent,
  selectRequestStrategy,
  selectStaleCaches,
  sharedContentCacheName,
  sharedContentKeyPrefix,
  type StoredSharedContent,
} from './model/requestStrategy'

/**
 * Service worker global scope; the module-level declaration narrows the generic worker `self`.
 */
declare const self: ServiceWorkerGlobalScope

/** Prefix shared by every cache this worker owns, so unrelated origin caches are never deleted. */
const cachePrefix = 'mukuroji-'

/**
 * Version of the cache layout. Bump it whenever cached content or naming changes so the
 * activate step discards caches written by older workers.
 */
const cacheLayoutVersion = 'v2'

/** Cache holding the static offline fallback page and the files it loads. */
const shellCacheName = `${cachePrefix}shell-${cacheLayoutVersion}`

/** Cache holding content-hashed build assets. */
const assetCacheName = `${cachePrefix}assets-${cacheLayoutVersion}`

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOfflineFallback())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(activateCurrentVersion())
})

self.addEventListener('message', (event) => {
  if (isSkipWaitingMessage(event.data)) {
    event.waitUntil(self.skipWaiting())
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const strategy = selectRequestStrategy(
    {
      method: request.method,
      url: request.url,
      mode: request.mode,
      cache: request.cache,
      hasRangeHeader: request.headers.has('range'),
    },
    self.location.origin,
  )

  if (strategy === 'share-target') {
    event.respondWith(receiveSharedContent(request))
    return
  }

  if (strategy === 'network-first-navigation') {
    event.respondWith(fetchNavigation(request))
    return
  }

  if (strategy === 'cache-first-asset') {
    event.respondWith(fetchHashedAsset(event, request))
    return
  }

  if (strategy === 'cache-first-offline-resource') {
    event.respondWith(fetchOfflineResource(request))
  }
})

/**
 * Stores the offline fallback page and the files it loads, fetched directly from the network.
 *
 * @returns A promise that settles once every file is cached.
 */
async function precacheOfflineFallback(): Promise<void> {
  const cache = await caches.open(shellCacheName)

  await cache.addAll(
    [offlineFallbackPath, ...offlineShellResourcePaths].map(
      (path) => new Request(path, { cache: 'reload' }),
    ),
  )
}

/**
 * Removes caches from previous layouts and takes control of already-open pages.
 *
 * @returns A promise that settles once activation housekeeping finishes.
 */
async function activateCurrentVersion(): Promise<void> {
  const staleNames = selectStaleCaches(await caches.keys(), cachePrefix, [
    shellCacheName,
    assetCacheName,
  ])

  await Promise.all(staleNames.map((name) => caches.delete(name)))
  await discardExpiredSharedContent(await caches.open(sharedContentCacheName), Date.now())
  await self.clients.claim()
}

/**
 * Stores content another app shared and redirects to the confirmation form.
 *
 * The content stays on the device in a dedicated cache, so it never appears in a URL, browser
 * history, or a server log; only an opaque ID is passed to the form. Files are ignored.
 *
 * @param request - `POST /share` navigation from the share sheet.
 * @returns A redirect to the confirmation form.
 */
async function receiveSharedContent(request: Request): Promise<Response> {
  const form = await request.formData()
  const content: StoredSharedContent = {
    ...readSharedFormFields((name) => form.get(name)),
    receivedAt: Date.now(),
  }
  const id = self.crypto.randomUUID()
  const cache = await caches.open(sharedContentCacheName)

  await discardExpiredSharedContent(cache, content.receivedAt)
  await cache.put(
    new Request(`${sharedContentKeyPrefix}${id}`),
    new Response(JSON.stringify(content), { headers: { 'Content-Type': 'application/json' } }),
  )

  return Response.redirect(new URL(createSharedContentRedirectPath(id), self.location.origin).href, 303)
}

/**
 * Deletes shared content that was never sent or discarded within the retention window.
 *
 * Runs on activation and before each new share; the form also refuses expired content.
 *
 * @param cache - Shared content cache.
 * @param now - Current time in epoch milliseconds.
 * @returns A promise that settles once expired entries are deleted.
 */
async function discardExpiredSharedContent(cache: Cache, now: number): Promise<void> {
  const keys = await cache.keys()
  const entries = await Promise.all(keys.map(async (key) => {
    const response = await cache.match(key)
    const value: unknown = response ? await response.json().catch(() => undefined) : undefined
    return { key, receivedAt: readReceivedAt(value) }
  }))

  await Promise.all(selectExpiredSharedContent(entries, now).map((key) => cache.delete(key)))
}

/**
 * Reads the receive time of stored shared content.
 *
 * @param value - Parsed stored content.
 * @returns Receive time in epoch milliseconds, or `undefined` when missing.
 */
function readReceivedAt(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('receivedAt' in value)) return undefined
  return typeof value.receivedAt === 'number' ? value.receivedAt : undefined
}

/**
 * Fetches a page from the network and only falls back to the static offline page on network failure.
 *
 * Navigation responses are never cached because they may belong to a signed-in tenant or a share link.
 *
 * @param request - Navigation request from the fetch event.
 * @returns The network response, or the offline page when the network is unreachable.
 */
async function fetchNavigation(request: Request): Promise<Response> {
  try {
    return await fetch(request)
  } catch (error) {
    const fallback = await caches.match(offlineFallbackPath, { cacheName: shellCacheName })

    if (fallback) {
      return fallback
    }

    throw error
  }
}

/**
 * Serves a file used by the offline page from the shell cache, falling back to the network.
 *
 * @param request - Same-origin GET request for an offline page resource.
 * @returns The precached response, or the network response when the cache misses.
 */
async function fetchOfflineResource(request: Request): Promise<Response> {
  const cached = await caches.match(request, { cacheName: shellCacheName })

  return cached ?? fetch(request)
}

/**
 * Serves a content-hashed build asset from the cache, filling the cache from the network on a miss.
 *
 * @param event - Fetch event used to extend the worker lifetime for cache writes.
 * @param request - Same-origin GET request for a hashed asset.
 * @returns The cached or freshly fetched response.
 */
async function fetchHashedAsset(event: FetchEvent, request: Request): Promise<Response> {
  const cache = await caches.open(assetCacheName)
  const cached = await cache.match(request)

  if (cached) {
    return cached
  }

  const response = await fetch(request)

  if (isCacheableAssetResponse(response)) {
    event.waitUntil(storeHashedAsset(cache, request, response.clone()))
  }

  return response
}

/**
 * Writes one asset response and trims the cache to its bounded size.
 *
 * @param cache - Hashed asset cache.
 * @param request - Request key for the asset.
 * @param response - Cloned response body to store.
 * @returns A promise that settles once the write and eviction finish.
 */
async function storeHashedAsset(cache: Cache, request: Request, response: Response): Promise<void> {
  await cache.put(request, response)

  const evicted = selectEvictedEntries(await cache.keys(), maxCachedAssetEntries)

  await Promise.all(evicted.map((key) => cache.delete(key)))
}
