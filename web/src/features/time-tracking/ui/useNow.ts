import { useEffect, useState } from 'react'

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
