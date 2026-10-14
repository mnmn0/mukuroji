/**
 * Cache-safe routing policy for the mukuroji service worker.
 *
 * The worker only ever stores tenant-independent static build output. API responses,
 * authenticated pages, share links, and every cross-origin or non-GET request bypass it.
 */

/** Same-origin path of the static page shown when a navigation cannot reach the network. */
export const offlineFallbackPath = '/offline.html'

/**
 * Static files the offline page loads. They are precached with the page and served from the
 * cache so the offline screen keeps its style, icon, and retry script without a network.
 * Keeping them out of the HTML also lets a strict `script-src 'self'` / `style-src 'self'` CSP apply.
 */
export const offlineShellResourcePaths: readonly string[] = [
  '/offline.css',
  '/offline.js',
  '/pwa-192x192.png',
]

/** Path prefix of Vite's content-hashed build output. */
export const hashedAssetPathPrefix = '/assets/'

/** Upper bound of hashed asset responses kept across deploys. */
export const maxCachedAssetEntries = 120

/** Message type a page posts to a waiting worker after the user accepts an update. */
export const skipWaitingMessageType = 'mukuroji:skip-waiting'

/**
 * Checks whether a message posted to the worker asks it to activate immediately.
 *
 * @param data - Untrusted `MessageEvent.data` from a client.
 * @returns `true` when the message is the skip-waiting request.
 */
export function isSkipWaitingMessage(data: unknown): boolean {
  return (
    typeof data === 'object'
    && data !== null
    && 'type' in data
    && data.type === skipWaitingMessageType
  )
}

/**
 * How the service worker should answer one request.
 *
 * - `network-first-navigation`: always fetch the page, fall back to the offline page only on network failure.
 * - `cache-first-asset`: serve immutable hashed build output from the cache, filling it on first use.
 * - `cache-first-offline-resource`: serve a precached file used by the offline page.
 * - `passthrough`: do not intercept; the browser handles the request as if no worker existed.
 */
export type RequestStrategy =
  | 'network-first-navigation'
  | 'cache-first-asset'
  | 'cache-first-offline-resource'
  | 'passthrough'

/** Subset of a fetch request that decides its caching strategy. */
export type RequestDescriptor = {
  /** HTTP method in any letter case. */
  method: string
  /** Absolute request URL. */
  url: string
  /** Fetch request mode such as `navigate`, `cors`, or `no-cors`. */
  mode: string
  /** Fetch cache mode; `only-if-cached` cross-origin requests must not be intercepted. */
  cache: string
  /** Whether the request carries a `Range` header, which cached full bodies cannot satisfy. */
  hasRangeHeader: boolean
}

/**
 * Chooses how the service worker answers a request.
 *
 * @param request - Request attributes observed in the fetch event.
 * @param workerOrigin - Origin that the service worker is registered on.
 * @returns The strategy to apply, defaulting to `passthrough` for anything not explicitly safe to handle.
 */
export function selectRequestStrategy(
  request: RequestDescriptor,
  workerOrigin: string,
): RequestStrategy {
  if (request.method.toUpperCase() !== 'GET' || request.hasRangeHeader) {
    return 'passthrough'
  }

  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return 'passthrough'
  }

  const url = parseUrl(request.url)

  if (url === null || url.origin !== workerOrigin) {
    return 'passthrough'
  }

  if (request.mode === 'navigate') {
    return 'network-first-navigation'
  }

  if (url.search !== '') {
    return 'passthrough'
  }

  if (url.pathname.startsWith(hashedAssetPathPrefix)) {
    return 'cache-first-asset'
  }

  if (offlineShellResourcePaths.includes(url.pathname)) {
    return 'cache-first-offline-resource'
  }

  return 'passthrough'
}

/**
 * Decides whether a network response may be stored in the hashed asset cache.
 *
 * @param response - Status and type of the response returned by `fetch`.
 * @returns `true` only for complete same-origin successes.
 */
export function isCacheableAssetResponse(response: { status: number, type: string }): boolean {
  return response.status === 200 && response.type === 'basic'
}

/**
 * Selects the oldest cache entries that exceed the configured bound.
 *
 * Cache Storage returns keys in insertion order, so the head of the list is the oldest.
 *
 * @param keys - Cached request keys in insertion order.
 * @param maxEntries - Number of newest entries to keep.
 * @returns Keys that should be deleted, oldest first.
 */
export function selectEvictedEntries<T>(keys: readonly T[], maxEntries: number): T[] {
  const overflow = keys.length - Math.max(0, maxEntries)

  return overflow > 0 ? keys.slice(0, overflow) : []
}

/**
 * Selects caches owned by this worker that do not belong to the current version.
 *
 * @param cacheNames - Every cache name visible to the origin.
 * @param ownedPrefix - Prefix shared by all caches this worker creates.
 * @param currentNames - Cache names used by the current worker version.
 * @returns Names of stale caches to delete; caches with other prefixes are never touched.
 */
export function selectStaleCaches(
  cacheNames: readonly string[],
  ownedPrefix: string,
  currentNames: readonly string[],
): string[] {
  return cacheNames.filter(
    (name) => name.startsWith(ownedPrefix) && !currentNames.includes(name),
  )
}

/**
 * Parses a URL without throwing on malformed input.
 *
 * @param value - Absolute URL string from the request.
 * @returns The parsed URL, or `null` when it cannot be parsed.
 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
