import { useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
import { AppUpdateNotice } from '../../shared/ui/AppUpdateNotice'
import { appServiceWorkerUpdates } from './appServiceWorker'
import { useServiceWorkerUpdateReady } from './useServiceWorkerUpdateReady'

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
  const updateReady = useServiceWorkerUpdateReady()
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
