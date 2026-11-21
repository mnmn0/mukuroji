import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
import type { MaintenanceNoticeState } from '../../shared/api/maintenance'
import { useMaintenanceStatus } from './queries/useMaintenanceStatus'
import { announce } from '../../shared/lib/liveAnnouncements'

/**
 * Reports the default locale during server rendering.
 *
 * @returns Always `ja`, the application default.
 */
function readServerLocale(): Locale {
  return 'ja'
}

/** Props of the maintenance banner. */
export type MaintenanceBannerProps = {
  /** Maintenance state to show. */
  readonly state: MaintenanceNoticeState
}

/**
 * Shows the app's maintenance state, read from the API responses through SWR.
 *
 * @returns The maintenance banner, or nothing while the service runs normally.
 */
export function MaintenanceNotice() {
  const state = useMaintenanceStatus()
  return <MaintenanceBanner state={state} />
}

/**
 * Shows that the service is in maintenance, so users read a rejected change as a planned
 * maintenance rather than an outage, and announces when the maintenance starts and ends.
 *
 * The banner sits at the top of the viewport above every page. It tells the user that what they
 * entered is still on the screen, because pages keep their input when a save fails.
 *
 * @param props - Maintenance state.
 * @returns The maintenance banner, or nothing while the service runs normally.
 */
export function MaintenanceBanner({ state }: MaintenanceBannerProps) {
  const locale = useSyncExternalStore(subscribeToLocalePreference, getInitialLocale, readServerLocale)
  const t = createTranslator(locale)
  const announcedRef = useRef<MaintenanceNoticeState>('none')
  const message = state === 'read-only'
    ? t('app.maintenance.readOnly')
    : state === 'stopped'
      ? t('app.maintenance.stopped')
      : undefined
  const endedMessage = t('app.maintenance.ended')

  useEffect(() => {
    const previous = announcedRef.current
    if (previous === state) return
    announcedRef.current = state
    if (message) {
      announce(message, 'polite', Date.now(), 'maintenance')
    } else if (previous !== 'none') {
      announce(endedMessage, 'polite', Date.now(), 'maintenance')
    }
  }, [endedMessage, message, state])

  if (!message) return null

  return (
    <p
      className="fixed inset-x-4 top-[max(0.5rem,env(safe-area-inset-top))] z-50 m-0 mx-auto max-w-2xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold leading-6 text-fg-amber-800 shadow-lg"
      data-maintenance-state={state}
      data-testid="maintenance-notice"
    >
      {message}
    </p>
  )
}
