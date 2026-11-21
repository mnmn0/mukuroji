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

/** Maintenance state of one API, as the SWR cache holds it. */
export type MaintenanceStatus = {
  /** State to show. */
  readonly state: MaintenanceNoticeState
  /** Absolute API base URL that reported the state; its status endpoint is the one to poll. */
  readonly apiBaseUrl?: string
}

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

/** Status shown before any API answered. */
export const normalMaintenanceStatus: MaintenanceStatus = Object.freeze({ state: 'none' })

/**
 * API paths whose answers never carry the maintenance header: liveness and readiness skip the
 * gate, and the status endpoint reports the state in its body instead.
 */
const ungatedApiPaths = new Set(['/health', '/ready', MAINTENANCE_STATUS_PATH])

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
  const apiBaseUrl = apiBaseUrls.find((base) => href.startsWith(`${base}/`))
  if (apiBaseUrl === undefined) return undefined
  const header = response.headers.get(MAINTENANCE_STATE_HEADER)
  if (header === 'read-only' || header === 'stopped') return { kind: 'report', state: header, apiBaseUrl }
  if (response.status >= 500 || response.type === 'opaque') return undefined
  if (ungatedApiPaths.has(href.slice(apiBaseUrl.length))) return undefined
  return { kind: 'clear', state: 'none', apiBaseUrl }
}

/**
 * Applies an observation to the cached status.
 *
 * A `clear` only ends the maintenance that the same API reported, so an unrelated API cannot
 * hide another API's maintenance.
 *
 * @param current - Cached status.
 * @param observation - What a response said.
 * @returns The next status.
 */
export function applyMaintenanceObservation(
  current: MaintenanceStatus | undefined,
  observation: MaintenanceObservation,
): MaintenanceStatus {
  const status = current ?? normalMaintenanceStatus
  if (observation.kind === 'report') return { state: observation.state, apiBaseUrl: observation.apiBaseUrl }
  return status.apiBaseUrl === observation.apiBaseUrl ? { state: 'none' } : status
}

/**
 * Asks an API for its maintenance state.
 *
 * @param apiBaseUrl - Absolute API base URL.
 * @param send - `fetch` to use.
 * @returns The status to show. An outage counts as `none`.
 * @throws When the request fails or the answer is unreadable, so SWR keeps the cached status.
 */
export async function fetchMaintenanceStatus(
  apiBaseUrl: string,
  send: typeof fetch,
): Promise<MaintenanceStatus> {
  const response = await send(`${apiBaseUrl}${MAINTENANCE_STATUS_PATH}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Maintenance status answered ${response.status}.`)
  const body: unknown = await response.json()
  const reported = typeof body === 'object' && body !== null && 'state' in body ? body.state : undefined
  if (!isMaintenanceState(reported)) throw new Error('Maintenance status is unreadable.')
  return reported === 'read-only' || reported === 'stopped'
    ? { state: reported, apiBaseUrl }
    : { state: 'none' }
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

  /** Observed replacement of `fetch`. */
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await send(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    try {
      const observation = readMaintenanceObservation(url, response, apiBaseUrls, readPageUrl())
      if (observation) report(observation)
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
