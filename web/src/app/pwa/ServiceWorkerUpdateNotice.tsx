import { useSyncExternalStore } from 'react'
import { createTranslator, getInitialLocale } from '../../shared/i18n/i18n'
import { AppUpdateNotice } from '../../shared/ui/AppUpdateNotice'
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
 * Shows the app update notice once a new service worker version is waiting.
 *
 * @returns The localized notice, or nothing while no update is pending.
 */
export function ServiceWorkerUpdateNotice() {
  const updateReady = useSyncExternalStore(subscribeToUpdates, readUpdateReady, readServerUpdateReady)

  if (!updateReady || appServiceWorkerUpdates === null) {
    return null
  }

  const t = createTranslator(getInitialLocale())
  const controller = appServiceWorkerUpdates

  return (
    <AppUpdateNotice
      message={t('app.update.available')}
      reloadLabel={t('app.update.reload')}
      dismissLabel={t('app.update.dismiss')}
      onReload={() => controller.applyUpdate()}
      onDismiss={() => controller.dismiss()}
    />
  )
}
