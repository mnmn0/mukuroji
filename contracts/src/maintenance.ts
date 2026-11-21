/**
 * Maintenance states that the API reports to the Web app.
 *
 * - `none`: the service runs normally.
 * - `read-only`: an operator switched the service to read-only maintenance. Reads work, and
 *   every change is rejected with {@link MAINTENANCE_READ_ONLY_PROBLEM_CODE}.
 * - `stopped`: an operator stopped the service for maintenance. Every request except this status
 *   is rejected with {@link MAINTENANCE_STOPPED_PROBLEM_CODE}.
 * - `unavailable`: the runtime control could not be read or was invalid. This is an outage, not
 *   a planned maintenance, and the API rejects requests as temporarily unavailable.
 */
export type MaintenanceState = 'none' | 'read-only' | 'stopped' | 'unavailable'

/** Every maintenance state, in a stable order. */
export const MAINTENANCE_STATES: readonly MaintenanceState[] = Object.freeze([
  'none',
  'read-only',
  'stopped',
  'unavailable',
])

/** Path below the API base URL that reports the current maintenance state without signing in. */
export const MAINTENANCE_STATUS_PATH = '/maintenance'

/**
 * Response of `GET /api/maintenance`.
 */
export interface MaintenanceStatusResponse {
  /** Current maintenance state of the API. */
  readonly state: MaintenanceState
}

/**
 * Response header that every request admitted during read-only maintenance carries, with the
 * value `read-only`, so the Web app learns about the maintenance from ordinary reads.
 */
export const MAINTENANCE_STATE_HEADER = 'Mukuroji-Maintenance'

/** Problem `code` of a change rejected because the API is in read-only maintenance. */
export const MAINTENANCE_READ_ONLY_PROBLEM_CODE = 'maintenance_read_only'

/** Problem `code` of a request rejected because an operator stopped the API for maintenance. */
export const MAINTENANCE_STOPPED_PROBLEM_CODE = 'maintenance'

/**
 * Checks whether a value is a maintenance state.
 *
 * @param value - Value read from a response.
 * @returns Whether the value is one of {@link MAINTENANCE_STATES}.
 */
export function isMaintenanceState(value: unknown): value is MaintenanceState {
  return typeof value === 'string' && MAINTENANCE_STATES.some((state) => state === value)
}
