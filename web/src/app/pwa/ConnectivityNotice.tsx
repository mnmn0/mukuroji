import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import {
  createTranslator,
  getInitialLocale,
  subscribeToLocalePreference,
  type Locale,
} from '../../shared/i18n/i18n'
import { announce } from '../../shared/lib/liveAnnouncements'
import {
  appConnectivity,
  publishBottomNoticeOffset,
  resolveConnectivityAnnouncement,
  type ConnectivityStore,
} from '../../shared/lib/pwa/connectivity'
import { useServiceWorkerUpdateReady } from './useServiceWorkerUpdateReady'

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
  /** Whether the update notice occupies the bottom edge; defaults to the app's update state. */
  readonly isUpdateNoticeShown?: boolean
}

/**
 * Shows that the app is offline and announces when the connection is lost or comes back.
 *
 * The visible notice uses the same bottom-right slot as the update notice while offline, clear
 * of the headers and the Workspace sidebar's bottom navigation, and swallows taps instead of
 * passing them to the content beneath. It steps aside while the update notice uses that slot, and
 * publishes its height so other bottom-right notices stack above it. Announcements go through the app's
 * persistent live regions, so they are read even though the notice mounts at the same moment.
 *
 * @param props - Connectivity source and update notice state.
 * @returns The offline notice, or nothing while online.
 */
export function ConnectivityNotice({
  connectivity = appConnectivity,
  isUpdateNoticeShown,
}: ConnectivityNoticeProps) {
  const updateReady = useServiceWorkerUpdateReady()
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

  const visible = !online && !(isUpdateNoticeShown ?? updateReady)
  const noticeRef = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const notice = noticeRef.current
    if (!visible || !notice) return undefined
    const rootStyle = document.documentElement.style
    publishBottomNoticeOffset(rootStyle, notice.getBoundingClientRect().height)
    // The message wraps differently as the viewport or language changes.
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => publishBottomNoticeOffset(rootStyle, notice.getBoundingClientRect().height))
    observer?.observe(notice)
    return () => {
      observer?.disconnect()
      publishBottomNoticeOffset(rootStyle, undefined)
    }
  }, [visible])

  if (!visible) return null

  return (
    <p
      ref={noticeRef}
      className="workbench-panel fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 m-0 px-4 py-2 text-sm leading-6 shadow-lg sm:left-auto sm:max-w-md"
      data-testid="connectivity-notice"
    >
      {offlineMessage}
    </p>
  )
}
