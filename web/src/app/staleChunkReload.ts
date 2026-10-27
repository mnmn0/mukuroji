/** Session storage key holding when a failed chunk load last reloaded the page. */
const reloadedAtStorageKey = 'mukuroji.staleChunkReloadAt'

/** Minimum time between reloads, so a chunk that keeps failing, such as while offline, cannot loop. */
export const STALE_CHUNK_RELOAD_INTERVAL_MS = 10_000

/**
 * Decides whether a failed chunk load should reload the page.
 *
 * @param lastReloadAt - Stored time of the previous reload in milliseconds, or null when none is stored.
 * @param now - Current time in milliseconds.
 * @returns True when no reload happened within {@link STALE_CHUNK_RELOAD_INTERVAL_MS}.
 */
export function shouldReloadForFailedChunk(lastReloadAt: string | null, now: number): boolean {
  const last = lastReloadAt === null ? Number.NaN : Number(lastReloadAt)
  return !Number.isFinite(last) || now - last >= STALE_CHUNK_RELOAD_INTERVAL_MS || now < last
}

/**
 * Reloads the page when a lazily loaded page chunk fails to load.
 *
 * A deploy replaces the content-hashed chunks that an open tab still references, so the next page
 * it opens can fail to load. Reloading fetches the current `index.html` and its chunks. When a
 * reload already happened moments ago, the error is left to the route instead of reloading again.
 *
 * @param target - Window to watch; the global window by default.
 */
export function startStaleChunkReload(target: Window = window): void {
  target.addEventListener('vite:preloadError', (event) => {
    const now = Date.now()
    let lastReloadAt: string | null
    try {
      lastReloadAt = target.sessionStorage.getItem(reloadedAtStorageKey)
    } catch {
      // Without storage there is no loop guard, so leave the error to the route.
      return
    }
    if (!shouldReloadForFailedChunk(lastReloadAt, now)) return
    try {
      target.sessionStorage.setItem(reloadedAtStorageKey, String(now))
    } catch {
      return
    }
    event.preventDefault()
    target.location.reload()
  })
}
