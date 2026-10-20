import { useSyncExternalStore } from 'react'
import { appServiceWorkerUpdates } from './appServiceWorker'

/**
 * Subscribes to update availability, tolerating browsers without service workers.
 *
 * @param listener - Callback invoked when availability may have changed.
 * @returns Unsubscribe function.
 */
function subscribeToUpdates(listener: () => void): () => void {
  return appServiceWorkerUpdates?.subscribe(listener) ?? (() => undefined)
}

/**
 * Reads whether an update is ready to apply.
 *
 * @returns `true` when a new version is waiting and has not been dismissed.
 */
function readUpdateReady(): boolean {
  return appServiceWorkerUpdates?.getSnapshot() ?? false
}

/**
 * Reports that no update is pending during server rendering.
 *
 * @returns Always `false`.
 */
function readServerUpdateReady(): boolean {
  return false
}

/**
 * Reports whether the app update notice is showing.
 *
 * @returns `true` while a new version waits and has not been dismissed.
 */
export function useServiceWorkerUpdateReady(): boolean {
  return useSyncExternalStore(subscribeToUpdates, readUpdateReady, readServerUpdateReady)
}
