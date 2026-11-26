import { useEffect, useState } from 'react'

/** Longest delay a browser timer accepts without clamping, a little below 2^31 - 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_000_000

/**
 * Re-renders the caller when a retained generation crosses its expiry time, so every part of the
 * screen that shows its content withdraws it together.
 *
 * @param generation - Generation whose retention window is shown, if any.
 */
export function useAiGenerationExpiryRerender(
  generation: { readonly expiresAt?: string, readonly id: string } | undefined,
): void {
  const [expiryTick, setExpiryTick] = useState(0)
  const expiresAt = generation?.expiresAt
  const generationId = generation?.id

  useEffect(() => {
    if (!expiresAt) return
    const delay = Date.parse(expiresAt) - Date.now()
    if (!Number.isFinite(delay) || delay <= 0) return
    // Browser timers clamp delays above a signed 32-bit integer; wake up again
    // after the safe maximum when a retention window spans more than 24 days.
    const timeoutId = setTimeout(() => {
      setExpiryTick((tick) => tick + 1)
    }, Math.min(delay, MAX_TIMER_DELAY_MS))
    return () => clearTimeout(timeoutId)
  }, [expiresAt, generationId, expiryTick])
}
