import { describe, expect, test } from 'bun:test'
import { createLatestRequestTracker } from '../src/workspace/model/latestRequest'

describe('createLatestRequestTracker', () => {
  test('keeps only the latest request current', () => {
    const tracker = createLatestRequestTracker()
    const first = tracker.begin()
    expect(first.isCurrent()).toBe(true)
    // A later choice makes the earlier read stale even when the later one ends at once, as an
    // oversized file does.
    const second = tracker.begin()
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
  })
})
