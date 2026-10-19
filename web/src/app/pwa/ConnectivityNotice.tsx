import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
import { announce } from '../../shared/lib/liveAnnouncements'
import {
  appConnectivity,
  resolveConnectivityAnnouncement,
  type ConnectivityStore,
} from '../../shared/lib/pwa/connectivity'

/**
 * Reports the default locale during server rendering.
 *
 * @returns Always `ja`, the application default.
 */
function readServerLocale(): Locale {
  return 'ja'
}

/** Props of the connectivity notice. */
export type ConnectivityNoticeProps = {
  /** Connectivity source; defaults to the running page. */
  readonly connectivity?: ConnectivityStore
}

/**
 * Shows that the app is offline and announces when the connection is lost or comes back.
 *
 * The visible bar stays while offline. Announcements go through the app's persistent live
 * regions, so they are read even though the bar mounts at the same moment.
 *
 * @param props - Connectivity source.
 * @returns The offline bar, or nothing while online.
 */
export function ConnectivityNotice({ connectivity = appConnectivity }: ConnectivityNoticeProps) {
  const online = useSyncExternalStore(connectivity.subscribe, connectivity.getSnapshot, connectivity.getSnapshot)
  const locale = useSyncExternalStore(subscribeToLocalePreference, getInitialLocale, readServerLocale)
  const t = createTranslator(locale)
  const announcedOnlineRef = useRef(true)
  const offlineMessage = t('app.connectivity.offline')
  const onlineMessage = t('app.connectivity.online')

  useEffect(() => {
    const change = resolveConnectivityAnnouncement(announcedOnlineRef.current, online)
    if (!change) return
    announcedOnlineRef.current = online
    announce(change === 'online' ? onlineMessage : offlineMessage, 'polite', Date.now(), 'connectivity')
  }, [offlineMessage, online, onlineMessage])

  if (online) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[max(0.5rem,env(safe-area-inset-top))]"
      data-testid="connectivity-notice"
    >
      <p className="workbench-panel m-0 max-w-xl px-4 py-2 text-sm leading-6 shadow-lg">{offlineMessage}</p>
    </div>
  )
}
