import { useSyncExternalStore } from 'react'
import {
  readLiveAnnouncements,
  subscribeToLiveAnnouncements,
} from '../lib/liveAnnouncements'

/**
 * Renders the persistent, visually hidden live regions used by `announce`.
 *
 * Mount it once at the application root. The regions exist before any message, so
 * screen readers announce text that later replaces their content. Each message
 * renders as a new keyed node, so repeating the same text is announced again.
 *
 * @returns Polite and assertive live regions.
 */
export function LiveAnnouncer() {
  const announcements = useSyncExternalStore(
    subscribeToLiveAnnouncements,
    readLiveAnnouncements,
    readLiveAnnouncements,
  )

  return (
    <div className="sr-only" data-testid="live-announcer">
      <div aria-atomic="true" aria-live="polite" data-testid="live-announcer-polite">
        {announcements.polite ? (
          <p key={announcements.polite.id}>{announcements.polite.message}</p>
        ) : null}
      </div>
      <div aria-atomic="true" aria-live="assertive" data-testid="live-announcer-assertive">
        {announcements.assertive ? (
          <p key={announcements.assertive.id}>{announcements.assertive.message}</p>
        ) : null}
      </div>
    </div>
  )
}
