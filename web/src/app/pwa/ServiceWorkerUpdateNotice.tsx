import { useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
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
 * Reports the default locale during server rendering.
 *
 * @returns Always `ja`, the application default.
 */
function readServerLocale(): Locale {
  return 'ja'
}

/**
 * Shows the app update notice once a new service worker version is waiting.
 *
 * The notice sits outside the routes that own locale state, so it follows the saved locale
 * preference directly and re-renders when the user switches language.
 *
 * @returns The localized notice, or nothing while no update is pending.
 */
export function ServiceWorkerUpdateNotice() {
  const updateReady = useSyncExternalStore(subscribeToUpdates, readUpdateReady, readServerUpdateReady)
  const locale = useSyncExternalStore(subscribeToLocalePreference, getInitialLocale, readServerLocale)

  if (!updateReady || appServiceWorkerUpdates === null) {
    return null
  }

  const t = createTranslator(locale)
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
