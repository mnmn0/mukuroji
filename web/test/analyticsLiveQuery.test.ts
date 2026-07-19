import { describe, expect, test } from 'bun:test'
import type {
  AnalyticsQueryInput,
  AnalyticsSnapshot,
} from '@mukuroji/contracts'
import { createAnalyticsLiveQueryRunner } from '../src/analytics/liveQuery'
import {
  analyticsFilterFixture,
  analyticsSnapshotFixture,
  analyticsWidgetFixtures,
} from '../src/analytics/fixtures'

const query = {
  asOf: analyticsSnapshotFixture.asOf,
  filter: analyticsFilterFixture,
  timeZone: 'Asia/Tokyo',
  widgets: analyticsWidgetFixtures,
} satisfies AnalyticsQueryInput

describe('Analytics live query runner', () => {
  test('aborts the previous request before starting a changed query', async () => {
    const signals: AbortSignal[] = []
    const firstRequest = Promise.withResolvers<AnalyticsSnapshot>()
    const runner = createAnalyticsLiveQueryRunner((
      _accessToken,
      _input,
      signal,
    ) => {
      signals.push(signal)
      if (signals.length === 1) {
        return firstRequest.promise
      }
      return Promise.resolve(analyticsSnapshotFixture)
    })
    const firstResult = runner.run('access-token', JSON.stringify(query))

    await expect(runner.run('access-token', JSON.stringify({
      ...query,
      timeZone: 'UTC',
    }))).resolves.toEqual(analyticsSnapshotFixture)

    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBeTrue()
    expect(signals[1]?.aborted).toBeFalse()
    firstRequest.resolve(analyticsSnapshotFixture)
    await firstResult
  })

  test('supports explicit unmount cancellation', () => {
    const signals: AbortSignal[] = []
    const runner = createAnalyticsLiveQueryRunner((
      _accessToken,
      _input,
      signal,
    ) => {
      signals.push(signal)
      return new Promise(() => undefined)
    })

    void runner.run('access-token', JSON.stringify(query))
    runner.abort()

    expect(signals[0]?.aborted).toBeTrue()
  })
})
