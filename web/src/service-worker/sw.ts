/// <reference lib="webworker" />

import {
  isCacheableAssetResponse,
  isSkipWaitingMessage,
  maxCachedAssetEntries,
  offlineFallbackPath,
  offlineShellResourcePaths,
  selectEvictedEntries,
  selectRequestStrategy,
  selectStaleCaches,
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
const cacheLayoutVersion = 'v1'

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
  await self.clients.claim()
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
