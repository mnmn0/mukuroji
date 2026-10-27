import type { ComponentType } from 'react'

/** Session storage key set while a reload to recover a failed page load is in progress. */
const reloadAttemptedStorageKey = 'mukuroji.pageChunkReloadAttempted'

/**
 * Browser facilities a page load needs to recover by reloading.
 */
export type PageReloadEnvironment = {
  /** Session storage that remembers a reload across it; reading or writing may throw. */
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>
  /** Reloads the application. */
  reload: () => void
}

/**
 * Returns the browser's session storage and full page reload.
 *
 * @returns The environment of the current window.
 */
function getWindowReloadEnvironment(): PageReloadEnvironment {
  return { storage: window.sessionStorage, reload: () => window.location.reload() }
}

/**
 * Loads a route's page component and reloads the application once when the load fails.
 *
 * A deploy replaces the content-hashed chunks that an open tab still references, so the next page
 * it opens can fail to load; reloading fetches the current `index.html` and its chunks. The attempt
 * is remembered until a page loads, so a load that fails again after the reload, however long it
 * takes, reaches the route error page instead of reloading in a loop. Only route page loads use
 * this; other lazy imports, such as the PDF runtime, keep handling their own failures.
 *
 * @param load - Imports the page module and returns its component.
 * @param environment - Storage and reload; the current window when omitted, read only when needed.
 * @returns The page component, or a promise that stays pending while the page reloads.
 */
export async function loadPageWithReload(
  load: () => Promise<ComponentType>,
  environment?: PageReloadEnvironment,
): Promise<ComponentType> {
  try {
    const component = await load()
    try {
      (environment ?? getWindowReloadEnvironment()).storage.removeItem(reloadAttemptedStorageKey)
    } catch {
      // Without storage a later failure simply reaches the route error page.
    }
    return component
  } catch (error) {
    let attempted: boolean
    let reload: () => void
    try {
      const current = environment ?? getWindowReloadEnvironment()
      reload = current.reload
      attempted = current.storage.getItem(reloadAttemptedStorageKey) !== null
      if (!attempted) current.storage.setItem(reloadAttemptedStorageKey, '1')
    } catch {
      // Without storage nothing would stop a reload loop.
      throw error
    }
    // A reload already failed to help.
    if (attempted) throw error
    reload()
    return new Promise<never>(() => undefined)
  }
}
