import type { UpdateFeedDigestState } from '@mukuroji/contracts'

/** Checks the current UTC interval without treating completed replays as retries.
 * @param state - Current persisted metadata.
 * @param now - Current UTC clock in milliseconds.
 * @returns Whether generation has exhausted this cadence's current interval.
 */
export function digestAttemptsExhausted(state: UpdateFeedDigestState, now: number): boolean {
  const date = new Date(now)
  if (state.preferences.frequency === 'weekly') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  const id = `${state.preferences.frequency}:${date.toISOString().slice(0, 10)}`
  const receipt = state.history.find((item) => item.id === id)
  return receipt !== undefined && receipt.status !== 'completed' && receipt.attempts >= 3
}
