import { useEffect, useState } from 'react'
import { readLocalDayRange, toLocalDateKey } from '../model/timePeriod'

/**
 * Returns the current time, refreshed every second while `ticking` is true, so a running timer
 * shows its elapsed time. The interval is cleared when ticking stops or the component unmounts.
 *
 * @param ticking - Whether the clock should advance.
 * @returns Current time.
 */
export function useNow(ticking: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!ticking) return undefined
    const interval = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(interval)
  }, [ticking])
  return now
}

/**
 * Returns today's local date and moves to the next date at local midnight, so windows that end
 * at the next midnight keep covering new entries while a screen stays open overnight.
 *
 * @returns Local `YYYY-MM-DD` date of today.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => toLocalDateKey(new Date()))
  useEffect(() => {
    const nextMidnight = readLocalDayRange(today)?.to ?? Date.now() + 60_000
    // Re-check a moment after midnight; the date is re-read so a sleeping device catches up.
    const timeout = window.setTimeout(() => setToday(toLocalDateKey(new Date())), Math.max(1_000, nextMidnight - Date.now() + 1_000))
    return () => window.clearTimeout(timeout)
  }, [today])
  return today
}
