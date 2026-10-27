import { describe, expect, test } from 'bun:test'
import { mapInOrderWithConcurrency } from './agent-run-access'

/**
 * Resolves after the given number of milliseconds.
 *
 * @param ms - Delay.
 * @returns Promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('mapInOrderWithConcurrency', () => {
  test('keeps input order, stays within the bound, and keeps undefined results', async () => {
    let inFlight = 0
    let peak = 0
    const results = await mapInOrderWithConcurrency([30, 5, 20, 1, 10], 2, async (ms) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await delay(ms)
      inFlight -= 1
      return ms === 20 ? undefined : ms * 2
    })
    expect(results).toEqual([60, 10, undefined, 2, 20])
    expect(peak).toBe(2)
    expect(await mapInOrderWithConcurrency([], 3, async (value: number) => value)).toEqual([])
  })

  test('starts no new call after one rejects', async () => {
    const started: number[] = []
    const failure = new Error('read failed')
    await expect(mapInOrderWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      started.push(value)
      await delay(value === 1 ? 1 : 20)
      if (value === 1) throw failure
      return value
    })).rejects.toBe(failure)
    // The call in flight next to the failure finishes, but no worker takes the remaining values.
    await delay(40)
    expect(started).toEqual([1, 2])
  })
})
