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

/** Maintenance state of one API while it is in maintenance. */
export type ApiMaintenanceState = 'read-only' | 'stopped'

/**
 * What one API response says about maintenance.
 *
 * - `report`: the response carried the maintenance header for {@link MaintenanceObservation.apiBaseUrl}.
 * - `clear`: an ordinary answer from that API without the header, so its maintenance has ended.
 */
export type MaintenanceObservation = {
  /** Kind of observation. */
  readonly kind: 'report' | 'clear'
  /** Reported state; `none` for `clear`. */
  readonly state: MaintenanceNoticeState
  /** Absolute API base URL that answered. */
  readonly apiBaseUrl: string
}

/**
 * API paths whose answers never carry the maintenance header: liveness and readiness skip the
 * gate, and the status endpoint reports the state in its body instead.
 */
const ungatedApiPaths = new Set(['/health', '/ready', MAINTENANCE_STATUS_PATH])

/** How long one maintenance status request, body included, may take, in milliseconds. */
const maintenanceStatusTimeoutMilliseconds = 10_000

/** API scopes whose base URLs the app's requests use. */
const apiScopes: readonly ApiBaseUrlScope[] = ['shared', 'projects', 'workspace', 'workspaceWithoutProjects', 'enterpriseIdentity']

/**
 * Returns the page URL that relative API URLs resolve against.
 *
 * @returns The page URL, or a placeholder origin outside the browser.
 */
function readPageUrl(): string {
  return typeof window === 'undefined' ? 'http://localhost/' : window.location.href
}

/**
 * Resolves the configured API base URLs to absolute URLs without trailing slashes.
 *
 * @param pageUrl - Page URL that relative base URLs resolve against.
 * @returns The distinct absolute API base URLs.
 */
export function resolveAppApiBaseUrls(pageUrl: string = readPageUrl()): string[] {
  return [...new Set(apiScopes.map((scope) => new URL(resolveApiBaseUrl(scope), pageUrl).href.replace(/\/+$/u, '')))]
}

/**
 * Reads what one response says about maintenance.
 *
 * Every response that the API admitted during read-only maintenance, and every request it
 * rejected for maintenance, carries the maintenance header. An answer below 500 without the
 * header from the same API means its maintenance has ended.
 *
 * @param url - Absolute or relative request URL.
 * @param response - Response the API returned.
 * @param apiBaseUrls - Absolute API base URLs whose responses count.
 * @param pageUrl - Page URL that a relative request URL resolves against.
 * @returns The observation, or `undefined` when the response says nothing about maintenance.
 */
export function readMaintenanceObservation(
  url: string,
  response: Response,
  apiBaseUrls: readonly string[],
  pageUrl: string,
): MaintenanceObservation | undefined {
  let href: string
  try {
    const parsed = new URL(url, pageUrl)
    href = `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
  // Base URLs may nest, such as `/api` and `/api/workspace`; the longest match owns the request.
  const apiBaseUrl = apiBaseUrls
    .filter((base) => href.startsWith(`${base}/`))
    .reduce<string | undefined>((longest, base) => (longest === undefined || base.length > longest.length ? base : longest), undefined)
  if (apiBaseUrl === undefined) return undefined
  const header = response.headers.get(MAINTENANCE_STATE_HEADER)
  if (header === 'read-only' || header === 'stopped') return { kind: 'report', state: header, apiBaseUrl }
  if (response.status >= 500 || response.type === 'opaque') return undefined
  if (ungatedApiPaths.has(href.slice(apiBaseUrl.length))) return undefined
  return { kind: 'clear', state: 'none', apiBaseUrl }
}

/**
 * Asks an API for its maintenance state.
 *
 * @param apiBaseUrl - Absolute API base URL.
 * @param send - `fetch` to use.
 * @returns The state of that API. An outage counts as `none`.
 * @throws When the request fails, times out, or the answer is unreadable, so the cached state stays.
 */
export async function fetchMaintenanceState(
  apiBaseUrl: string,
  send: typeof fetch,
): Promise<MaintenanceNoticeState> {
  // The deadline also covers reading the body, so one silent API cannot hold back the others.
  const response = await send(`${apiBaseUrl}${MAINTENANCE_STATUS_PATH}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(maintenanceStatusTimeoutMilliseconds),
  })
  if (!response.ok) throw new Error(`Maintenance status answered ${response.status}.`)
  const body: unknown = await response.json()
  const reported = typeof body === 'object' && body !== null && 'state' in body ? body.state : undefined
  if (!isMaintenanceState(reported)) throw new Error('Maintenance status is unreadable.')
  return reported === 'read-only' || reported === 'stopped' ? reported : 'none'
}

/**
 * Wraps `fetch` so every API response reports what it says about maintenance.
 *
 * @param report - Receives each observation.
 * @param target - Global object whose `fetch` is wrapped. Defaults to `globalThis`.
 * @returns A function that restores the original `fetch`.
 */
export function installMaintenanceFetchObserver(
  report: (observation: MaintenanceObservation) => void,
  target: { fetch: typeof fetch } = globalThis,
): () => void {
  const originalFetch = target.fetch
  const send = originalFetch.bind(target)
  const apiBaseUrls = resolveAppApiBaseUrls()
  /** Number of the last request sent; later requests get larger numbers. */
  let lastRequestNumber = 0
  /** Number of the newest request whose observation was reported, per API base URL. */
  const reportedRequestNumbers = new Map<string, number>()

  /** Observed replacement of `fetch`. */
  const observedFetch: typeof fetch = async (input, init) => {
    lastRequestNumber += 1
    const requestNumber = lastRequestNumber
    const response = await send(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    try {
      const observation = readMaintenanceObservation(url, response, apiBaseUrls, readPageUrl())
      // A response to an older request than one already reported may describe a state that has
      // since changed, so it is ignored.
      if (observation && requestNumber > (reportedRequestNumbers.get(observation.apiBaseUrl) ?? 0)) {
        reportedRequestNumbers.set(observation.apiBaseUrl, requestNumber)
        report(observation)
      }
    } catch {
      // The page still receives its response.
    }
    return response
  }

  target.fetch = observedFetch
  return () => {
    target.fetch = originalFetch
  }
}
