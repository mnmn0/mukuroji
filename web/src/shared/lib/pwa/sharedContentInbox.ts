/**
 * Cache the service worker stores shared content in. It repeats the worker's
 * `sharedContentCacheName`, because app code must not import the worker; a unit test keeps the
 * two equal.
 */
export const sharedContentCacheName = 'mukuroji-share-inbox-v1'

/** Path prefix of the cache keys for stored shared content; repeats the worker's value. */
export const sharedContentKeyPrefix = '/__mukuroji/share/'

/** Text fields another app shared. */
export type StoredSharedFields = {
  /** Shared title. */
  readonly title: string
  /** Shared text. */
  readonly text: string
  /** Shared link. */
  readonly url: string
}

/** Cache Storage operations the inbox uses. */
export type SharedContentCacheStorage = {
  /** Opens the named cache; only reads and deletes are used. */
  readonly open: (cacheName: string) => Promise<Pick<Cache, 'match' | 'delete'>>
}

/** Shape of the opaque IDs the worker issues. */
const sharedContentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Returns the page's Cache Storage, when the browser has one.
 *
 * @returns Cache Storage, or `undefined` outside a secure browser context.
 */
function readPageCacheStorage(): SharedContentCacheStorage | undefined {
  return typeof caches === 'undefined' ? undefined : caches
}

/**
 * Returns whether a value is an ID the worker could have issued.
 *
 * @param id - Value from the confirmation form URL.
 * @returns `true` for a lower-case UUID.
 */
export function isSharedContentId(id: string): boolean {
  return sharedContentIdPattern.test(id)
}

/**
 * Reads shared content the service worker stored for the confirmation form.
 *
 * @param id - Opaque ID from the form URL.
 * @param storage - Cache Storage; defaults to the page's.
 * @returns The shared fields, or `undefined` when the ID is invalid or nothing is stored.
 */
export async function readStoredSharedContent(
  id: string,
  storage: SharedContentCacheStorage | undefined = readPageCacheStorage(),
): Promise<StoredSharedFields | undefined> {
  if (!storage || !isSharedContentId(id)) return undefined
  const cache = await storage.open(sharedContentCacheName)
  const response = await cache.match(`${sharedContentKeyPrefix}${id}`)
  if (!response) return undefined
  const value: unknown = await response.json().catch(() => undefined)
  if (typeof value !== 'object' || value === null) return undefined
  const field = (name: string) => {
    const fieldValue: unknown = Reflect.get(value, name)
    return typeof fieldValue === 'string' ? fieldValue : ''
  }
  return { title: field('title'), text: field('text'), url: field('url') }
}

/**
 * Deletes shared content once it was sent or the form was left.
 *
 * @param id - Opaque ID from the form URL.
 * @param storage - Cache Storage; defaults to the page's.
 * @returns A promise that settles once the content is deleted; failures are ignored.
 */
export async function discardStoredSharedContent(
  id: string,
  storage: SharedContentCacheStorage | undefined = readPageCacheStorage(),
): Promise<void> {
  if (!storage || !isSharedContentId(id)) return
  try {
    const cache = await storage.open(sharedContentCacheName)
    await cache.delete(`${sharedContentKeyPrefix}${id}`)
  } catch {
    // Unread content expires in the worker; nothing else depends on this delete.
  }
}
