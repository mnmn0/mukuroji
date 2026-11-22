import { useState, useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
import type { BuildDriftState } from '../../shared/release/buildDrift'
import { AppUpdateNotice } from '../../shared/ui/AppUpdateNotice'
import { useServiceWorkerUpdateReady } from '../pwa/useServiceWorkerUpdateReady'
import { useBuildDrift } from './queries/useBuildDrift'

/**
 * Reports the default locale during server rendering.
 *
 * @returns Always `ja`, the application default.
 */
function readServerLocale(): Locale {
  return 'ja'
}

/**
 * Offers a reload when the API runs another commit than the Web build in this tab.
 *
 * The service worker's update notice already offers the same reload, so this notice stays hidden
 * while that one shows. "Later" hides it for the current pair of builds; a later API commit shows it
 * again.
 *
 * @returns The notice, or nothing while the builds match.
 */
export function BuildDriftNotice() {
  const drift = useBuildDrift()
  const serviceWorkerUpdateReady = useServiceWorkerUpdateReady()
  const [dismissedPair, setDismissedPair] = useState<string | undefined>(undefined)
  if (serviceWorkerUpdateReady || drift.pair === undefined || drift.pair === dismissedPair) return null
  const { pair } = drift
  return <BuildDriftBanner state={drift.state} onReload={drift.reload} onDismiss={() => setDismissedPair(pair)} />
}

/** Props of the build drift banner. */
export type BuildDriftBannerProps = {
  /** What to tell the user. */
  readonly state: BuildDriftState
  /** Reloads the page. */
  readonly onReload: () => void
  /** Hides the notice. */
  readonly onDismiss: () => void
}

/**
 * Shows that the screen is older or newer than the server, in the app's update notice.
 *
 * When the builds still differ after a reload, it says the update may still be in progress
 * instead of asking for the same reload again.
 *
 * @param props - Drift state and actions.
 * @returns The notice, or nothing for `none`.
 */
export function BuildDriftBanner({ state, onReload, onDismiss }: BuildDriftBannerProps) {
  const locale = useSyncExternalStore(subscribeToLocalePreference, getInitialLocale, readServerLocale)
  if (state === 'none') return null
  const t = createTranslator(locale)
  return (
    <AppUpdateNotice
      message={t(state === 'drift' ? 'app.buildDrift.available' : 'app.buildDrift.persisting')}
      reloadLabel={t('app.update.reload')}
      dismissLabel={t('app.update.dismiss')}
      onReload={onReload}
      onDismiss={onDismiss}
    />
  )
}
