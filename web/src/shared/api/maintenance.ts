import {
  isMaintenanceState,
  MAINTENANCE_STATE_HEADER,
  MAINTENANCE_STATUS_PATH,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl, type ApiBaseUrlScope } from './apiBaseUrl'

/**
 * Maintenance state the app shows: running normally, read-only, or stopped.
 *
 * An outage is not a maintenance and shows as `none`; pages report their own errors for it.
 */
export type MaintenanceNoticeState = 'none' | 'read-only' | 'stopped'

/** Maintenance state shared by the app shell and the fetch observer. */
export type MaintenanceStore = {
  /** Registers a listener for state changes and returns its unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
  /** Returns the current state. */
  readonly getSnapshot: () => MaintenanceNoticeState
  /**
   * Learns the state from one API response.
   *
   * @param url - Absolute or relative request URL.
   * @param response - Response the API returned.
   */
  readonly observe: (url: string, response: Response) => void
  /**
   * Asks the API for the current state and stores the answer. Failures leave the state as it is.
   *
   * @returns A promise that settles once the answer is stored.
   */
  readonly refresh: () => Promise<void>
}

/** Options of {@link createMaintenanceStore}. */
export type MaintenanceStoreOptions = {
  /** API base URLs whose responses count; relative ones resolve against {@link MaintenanceStoreOptions.origin}. */
  readonly apiBaseUrls: readonly string[]
  /** Page URL that relative URLs resolve against. */
  readonly origin: string
  /**
   * Requests the maintenance status. It must not pass through the observed `fetch`.
   *
   * @param url - Status URL.
   * @returns The response.
   */
  readonly fetchStatus: (url: string) => Promise<Response>
  /** How often to ask for the state while a maintenance is shown, in milliseconds. */
  readonly pollMilliseconds?: number
  /**
   * Starts a repeating timer. Defaults to `setInterval`.
   *
   * @param callback - Function to run on every tick.
   * @param milliseconds - Interval between ticks.
   * @returns A function that stops the timer.
   */
  readonly startTimer?: (callback: () => void, milliseconds: number) => () => void
}

/**
 * Starts a repeating browser timer.
 *
 * @param callback - Function to run on every tick.
 * @param milliseconds - Interval between ticks.
 * @returns A function that stops the timer.
 */
function startIntervalTimer(callback: () => void, milliseconds: number): () => void {
  const timer = globalThis.setInterval(callback, milliseconds)
  return () => globalThis.clearInterval(timer)
}

/** Default polling interval while a maintenance is shown. */
const defaultPollMilliseconds = 30_000

/** API paths that skip the maintenance gate and so never carry its header. */
const ungatedApiPaths = new Set(['/health', '/ready'])

/**
 * Creates a maintenance store.
 *
 * Every response that the API admitted during read-only maintenance, and every request it
 * rejected for maintenance, carries the maintenance header, so the store follows the header. A
 * later API answer below 500 without the header means the maintenance ended. While a maintenance
 * is shown, the store also asks `GET /api/maintenance` regularly, because a stopped API rejects
 * every other request and pages may stop sending them.
 *
 * @param options - API base URLs, status request, and timer.
 * @returns The store.
 */
export function createMaintenanceStore(options: MaintenanceStoreOptions): MaintenanceStore {
  const listeners = new Set<() => void>()
  const bases = options.apiBaseUrls.map((base) => new URL(base, options.origin).href.replace(/\/+$/u, ''))
  const statusUrl = `${bases[0] ?? new URL('/api', options.origin).href}${MAINTENANCE_STATUS_PATH}`
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds
  const startTimer = options.startTimer ?? startIntervalTimer
  let state: MaintenanceNoticeState = 'none'
  let stopTimer: (() => void) | undefined

  /**
   * Stores a new state, notifies listeners, and starts or stops polling.
   *
   * @param next - New state.
   */
  function update(next: MaintenanceNoticeState) {
    if (next === state) return
    state = next
    if (state === 'none' && stopTimer) {
      stopTimer()
      stopTimer = undefined
    } else if (state !== 'none' && !stopTimer) {
      stopTimer = startTimer(() => {
        void refresh()
      }, pollMilliseconds)
    }
    for (const listener of listeners) listener()
  }

  /**
   * Finds the API path of a request URL, when the URL targets one of the API base URLs.
   *
   * @param url - Request URL.
   * @returns The path below the base URL, or `undefined` for other URLs.
   */
  function readApiPath(url: string): string | undefined {
    let href: string
    try {
      const parsed = new URL(url, options.origin)
      href = `${parsed.origin}${parsed.pathname}`
    } catch {
      return undefined
    }
    const base = bases.find((candidate) => href.startsWith(`${candidate}/`))
    return base === undefined ? undefined : href.slice(base.length)
  }

  /** Asks the API for the current state. */
  async function refresh() {
    try {
      const response = await options.fetchStatus(statusUrl)
      if (!response.ok) return
      const body: unknown = await response.json()
      const reported = typeof body === 'object' && body !== null && 'state' in body ? body.state : undefined
      if (!isMaintenanceState(reported)) return
      update(reported === 'read-only' || reported === 'stopped' ? reported : 'none')
    } catch {
      // Offline or an unreadable answer: keep showing what is known.
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    observe(url, response) {
      const header = response.headers.get(MAINTENANCE_STATE_HEADER)
      if (header === 'read-only' || header === 'stopped') {
        update(header)
        return
      }
      if (state === 'none' || response.status >= 500 || response.type === 'opaque') return
      const path = readApiPath(url)
      if (path === undefined || ungatedApiPaths.has(path)) return
      update('none')
    },
    refresh,
  }
}

/** API scopes whose base URLs the app's requests use. */
const apiScopes: readonly ApiBaseUrlScope[] = ['shared', 'projects', 'workspace', 'workspaceWithoutProjects', 'enterpriseIdentity']

/** `fetch` before {@link installMaintenanceFetchObserver} wrapped it. */
let statusFetch: typeof fetch = (...args) => globalThis.fetch(...args)

/** Maintenance state of the running app. */
export const appMaintenance: MaintenanceStore = createMaintenanceStore({
  apiBaseUrls: [...new Set(apiScopes.map((scope) => resolveApiBaseUrl(scope)))],
  origin: typeof window === 'undefined' ? 'http://localhost/' : window.location.href,
  fetchStatus: (url) => statusFetch(url, { cache: 'no-store' }),
})

/**
 * Wraps `fetch` so every response tells the maintenance store whether a maintenance is running.
 *
 * @param target - Global object whose `fetch` is wrapped. Defaults to `globalThis`.
 * @param store - Store that learns from the responses. Defaults to the app's store.
 * @returns A function that restores the original `fetch`.
 */
export function installMaintenanceFetchObserver(
  target: { fetch: typeof fetch } = globalThis,
  store: MaintenanceStore = appMaintenance,
): () => void {
  const originalFetch = target.fetch
  const send = originalFetch.bind(target)
  if (store === appMaintenance) statusFetch = send

  /** Observed replacement of `fetch`. */
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await send(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    try {
      store.observe(url, response)
    } catch {
      // The page still receives its response.
    }
    return response
  }

  target.fetch = observedFetch
  return () => {
    target.fetch = originalFetch
    if (store === appMaintenance) statusFetch = (...args) => globalThis.fetch(...args)
  }
}
