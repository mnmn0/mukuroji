import useSWR, { mutate as mutateGlobalCache, useSWRConfig } from 'swr'
import {
  applyMaintenanceObservation,
  fetchMaintenanceStatus,
  installMaintenanceFetchObserver,
  normalMaintenanceStatus,
  type MaintenanceObservation,
  type MaintenanceStatus,
} from '../../shared/api/maintenance'

/** SWR key of the maintenance status. */
export const maintenanceStatusKey = 'app/maintenance-status'

/** How often to ask for the state while a maintenance is shown, in milliseconds. */
const maintenancePollMilliseconds = 30_000

/**
 * Stores an observation in the global SWR cache.
 *
 * @param observation - What an API response said.
 */
function storeObservation(observation: MaintenanceObservation) {
  void mutateGlobalCache<MaintenanceStatus>(
    maintenanceStatusKey,
    (current) => applyMaintenanceObservation(current, observation),
    { revalidate: false },
  )
}

/**
 * Wraps `fetch` so every API response updates the cached maintenance status.
 *
 * @returns A function that restores the original `fetch`.
 */
export function installAppMaintenanceObserver(): () => void {
  return installMaintenanceFetchObserver(storeObservation)
}

/**
 * Reads the API base URL that reported the cached maintenance.
 *
 * @param cached - Value in the SWR cache.
 * @returns The reporting API base URL, or `undefined` when none is cached.
 */
function readReportingApiBaseUrl(cached: unknown): string | undefined {
  if (typeof cached !== 'object' || cached === null || !('apiBaseUrl' in cached)) return undefined
  return typeof cached.apiBaseUrl === 'string' ? cached.apiBaseUrl : undefined
}

/**
 * Reads the maintenance status from SWR.
 *
 * The status starts as `none` and changes when API responses carry the maintenance header. While
 * a maintenance is shown, SWR asks the API that reported it every 30 seconds, because a stopped
 * API rejects every other request and pages may stop sending them.
 *
 * @returns The status to show.
 */
export function useMaintenanceStatus(): MaintenanceStatus {
  const { cache } = useSWRConfig()
  const { data } = useSWR<MaintenanceStatus>(
    maintenanceStatusKey,
    async (): Promise<MaintenanceStatus> => {
      const cached: unknown = cache.get(maintenanceStatusKey)?.data
      const apiBaseUrl = readReportingApiBaseUrl(cached)
      return apiBaseUrl === undefined
        ? normalMaintenanceStatus
        : fetchMaintenanceStatus(apiBaseUrl, (...args) => globalThis.fetch(...args))
    },
    {
      fallbackData: normalMaintenanceStatus,
      refreshInterval: (latest) => (latest && latest.state !== 'none' ? maintenancePollMilliseconds : 0),
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnMount: false,
      revalidateOnReconnect: false,
    },
  )
  return data ?? normalMaintenanceStatus
}
