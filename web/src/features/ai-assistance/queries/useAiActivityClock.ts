import { useEffect, useState } from 'react'
import type { AiActivity } from '../model/aiActivity'

/**
 * Updates the board at the earliest pending retention deadline.
 * @param activities - Observed session operations.
 * @returns Browser time without polling a provider or inventing progress.
 */
export function useAiActivityClock(activities: readonly AiActivity[]): number {
  const [now, setNow] = useState(Date.now)
  const nextExpiry = Math.min(...activities
    .filter((activity) => activity.phase === 'review')
    .map((activity) => activity.expiresAt ?? Infinity)
    .filter((expiry) => expiry > now))
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return
    const timeout = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_000_000))
    return () => clearTimeout(timeout)
  }, [nextExpiry, now])
  return now
}
