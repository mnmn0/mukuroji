import { installMaintenanceFetchObserver } from '../../shared/api/maintenance'
import { recordMaintenanceObservation } from './queries/useMaintenanceStatus'

/**
 * Wraps `fetch` so every API response updates the cached maintenance status.
 *
 * @returns A function that restores the original `fetch`.
 */
export function installAppMaintenanceObserver(): () => void {
  return installMaintenanceFetchObserver(recordMaintenanceObservation)
}
