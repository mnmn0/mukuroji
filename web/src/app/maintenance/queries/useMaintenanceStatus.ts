import useSWR, { mutate as mutateGlobalCache, useSWRConfig } from 'swr'
import {
  applyMaintenanceObservation,
  normalMaintenanceStatus,
  refreshMaintenanceStatus,
  summarizeMaintenanceState,
  type ApiMaintenanceState,
  type MaintenanceNoticeState,
  type MaintenanceObservation,
  type MaintenanceStatus,
} from '../../../shared/api/maintenance'

/** SWR key of the maintenance status. */
const maintenanceStatusKey = 'app/maintenance-status'

/** How often to ask for the state while a maintenance is shown, in milliseconds. */
const maintenancePollMilliseconds = 30_000

/**
 * Stores what one API response said about maintenance in the global SWR cache.
 *
 * @param observation - What the response said.
 */
export function recordMaintenanceObservation(observation: MaintenanceObservation): void {
  void mutateGlobalCache<MaintenanceStatus>(
    maintenanceStatusKey,
    (current) => applyMaintenanceObservation(current, observation),
    { revalidate: false },
  )
}

/**
 * Reads a cached status back from the SWR cache, accepting only its expected shape.
 *
 * @param cached - Value in the SWR cache.
 * @returns The status, or the normal status when nothing valid is cached.
 */
function readCachedStatus(cached: unknown): MaintenanceStatus {
  if (typeof cached !== 'object' || cached === null || !('apis' in cached)) return normalMaintenanceStatus
  const apis: unknown = cached.apis
  if (typeof apis !== 'object' || apis === null) return normalMaintenanceStatus
  const valid: Record<string, ApiMaintenanceState> = {}
  for (const [base, state] of Object.entries(apis)) {
    if (state === 'read-only' || state === 'stopped') valid[base] = state
  }
  return { apis: valid }
}

/**
 * Reads the maintenance state to show.
 *
 * The status starts empty and changes when API responses carry the maintenance header. While any
 * API is in maintenance, SWR asks each such API every 30 seconds, because a stopped API rejects
 * every other request and pages may stop sending them.
 *
 * @returns The state to show.
 */
export function useMaintenanceStatus(): MaintenanceNoticeState {
  const { cache } = useSWRConfig()
  const { data } = useSWR<MaintenanceStatus>(
    maintenanceStatusKey,
    () => refreshMaintenanceStatus(
      readCachedStatus(cache.get(maintenanceStatusKey)?.data),
      (...args) => globalThis.fetch(...args),
    ),
    {
      fallbackData: normalMaintenanceStatus,
      refreshInterval: (latest) =>
        latest && summarizeMaintenanceState(latest) !== 'none' ? maintenancePollMilliseconds : 0,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnMount: false,
      revalidateOnReconnect: false,
    },
  )
  return summarizeMaintenanceState(data ?? normalMaintenanceStatus)
}
