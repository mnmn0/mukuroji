/** Browser capabilities the connectivity store reads. */
export type ConnectivityEnvironment = {
  /** Returns whether the browser reports a network connection. */
  readonly isOnline: () => boolean
  /** Receives `online` and `offline` events; absent outside the browser. */
  readonly target: EventTarget | undefined
}

/** Network connectivity state shared by the app shell. */
export type ConnectivityStore = {
  /** Registers a listener for connectivity changes and returns its unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
  /** Returns whether the browser currently reports a network connection. */
  readonly getSnapshot: () => boolean
}

/**
 * Reads connectivity from the running page.
 *
 * Browsers report `navigator.onLine === false` only when there is certainly no network, so a
 * page without `navigator` is treated as online.
 *
 * @returns The page environment.
 */
function readPageEnvironment(): ConnectivityEnvironment {
  return {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    target: typeof window === 'undefined' ? undefined : window,
  }
}

/**
 * Creates a store that follows the browser's `online` and `offline` events.
 *
 * Event listeners are attached while at least one subscriber exists.
 *
 * @param environment - Connectivity source; defaults to the running page.
 * @returns The connectivity store.
 */
export function createConnectivityStore(
  environment: ConnectivityEnvironment = readPageEnvironment(),
): ConnectivityStore {
  const listeners = new Set<() => void>()
  let online = environment.isOnline()

  /** Re-reads the connection and notifies subscribers when it changed. */
  function handleChange(): void {
    const next = environment.isOnline()
    if (next === online) return
    online = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        environment.target?.addEventListener('online', handleChange)
        environment.target?.addEventListener('offline', handleChange)
        // A change while nobody was subscribed has no event left to deliver.
        online = environment.isOnline()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          environment.target?.removeEventListener('online', handleChange)
          environment.target?.removeEventListener('offline', handleChange)
        }
      }
    },
    getSnapshot: () => online,
  }
}

/**
 * Decides which connectivity change to announce.
 *
 * Losing the connection is announced at page load too; coming back is announced only after a
 * loss was announced.
 *
 * @param announcedOnline - Connectivity last announced; `true` before anything was announced.
 * @param online - Current connectivity.
 * @returns The change to announce, or `undefined` when nothing changed.
 */
export function resolveConnectivityAnnouncement(
  announcedOnline: boolean,
  online: boolean,
): 'offline' | 'online' | undefined {
  if (announcedOnline === online) return undefined
  return online ? 'online' : 'offline'
}

/** Connectivity of the running page. */
export const appConnectivity = createConnectivityStore()
