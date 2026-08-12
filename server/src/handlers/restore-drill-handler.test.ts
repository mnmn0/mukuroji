import { describe, expect, test } from 'bun:test'
import { runRestoreDrillImmediateBatch } from './restore-drill-handler'

describe('restore drill handler immediate batching', () => {
  test('advances multiple cleanup ledger pages in one invocation', async () => {
    let remainingTargets = 75
    let stepCount = 0
    const result = await runRestoreDrillImmediateBatch(async () => {
      stepCount += 1
      remainingTargets = Math.max(0, remainingTargets - 25)
      return remainingTargets === 0
        ? { drillId: 'drill-1', status: 'completed' }
        : { drillId: 'drill-1', status: 'pending', waitSeconds: 0 }
    })
    expect(result).toEqual({ drillId: 'drill-1', status: 'completed' })
    expect(stepCount).toBe(3)
  })

  test('stops immediately at an asynchronous table deletion wait boundary', async () => {
    let stepCount = 0
    const result = await runRestoreDrillImmediateBatch(async () => {
      stepCount += 1
      return { drillId: 'drill-1', status: 'pending', waitSeconds: 60 }
    })
    expect(result).toEqual({ drillId: 'drill-1', status: 'pending', waitSeconds: 60 })
    expect(stepCount).toBe(1)
  })
})
