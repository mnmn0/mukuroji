import {
  fetchMaintenanceState,
  type ApiMaintenanceState,
  type MaintenanceNoticeState,
  type MaintenanceObservation,
} from '../../../shared/api/maintenance'

/** Maintenance states of the APIs that reported one, as the SWR cache holds them. */
export type MaintenanceStatus = {
  /** State of each API in maintenance, keyed by its absolute base URL. */
  readonly apis: Readonly<Record<string, ApiMaintenanceState>>
}

/** Status shown before any API answered. */
export const normalMaintenanceStatus: MaintenanceStatus = Object.freeze({ apis: Object.freeze({}) })

/**
 * Returns a status with one API's state replaced.
 *
 * @param status - Current status.
 * @param apiBaseUrl - Absolute API base URL.
 * @param state - New state of that API; `none` removes it.
 * @returns The next status, or the same object when nothing changed.
 */
function setApiMaintenanceState(
  status: MaintenanceStatus,
  apiBaseUrl: string,
  state: MaintenanceNoticeState,
): MaintenanceStatus {
  if ((status.apis[apiBaseUrl] ?? 'none') === state) return status
  const apis: Record<string, ApiMaintenanceState> = {}
  for (const [base, value] of Object.entries(status.apis)) {
    if (base !== apiBaseUrl) apis[base] = value
  }
  if (state !== 'none') apis[apiBaseUrl] = state
  return { apis }
}

/**
 * Applies an observation to the cached status.
 *
 * Each API keeps its own state, so one API returning to normal cannot hide another API's
 * maintenance.
 *
 * @param current - Cached status.
 * @param observation - What a response said.
 * @returns The next status.
 */
export function applyMaintenanceObservation(
  current: MaintenanceStatus | undefined,
  observation: MaintenanceObservation,
): MaintenanceStatus {
  return setApiMaintenanceState(current ?? normalMaintenanceStatus, observation.apiBaseUrl, observation.state)
}

/**
 * Summarizes the status into the one state to show; a stopped API outweighs a read-only one.
 *
 * @param status - Cached status.
 * @returns The state to show.
 */
export function summarizeMaintenanceState(status: MaintenanceStatus): MaintenanceNoticeState {
  const states = Object.values(status.apis)
  if (states.includes('stopped')) return 'stopped'
  return states.includes('read-only') ? 'read-only' : 'none'
}

/**
 * Asks every API in maintenance for its state.
 *
 * @param status - Cached status.
 * @param send - `fetch` to use.
 * @returns The refreshed status. An API that could not be asked keeps its cached state.
 */
export async function refreshMaintenanceStatus(
  status: MaintenanceStatus,
  send: typeof fetch,
): Promise<MaintenanceStatus> {
  const bases = Object.keys(status.apis)
  const answers = await Promise.all(bases.map(async (base) => {
    try {
      return await fetchMaintenanceState(base, send)
    } catch {
      return undefined
    }
  }))
  let next = status
  bases.forEach((base, index) => {
    const answer = answers[index]
    if (answer !== undefined) next = setApiMaintenanceState(next, base, answer)
  })
  return next
}
