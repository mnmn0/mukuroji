import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTeamFactoryAnalytics } from '../src/work-items/api/agentRuns'
import { factoryAnalyticsFixture } from '../src/features/factory-board/fixtures'
import {
  createFactoryAnalyticsPeriod,
  isFactoryAnalyticsIncomplete,
  readFactoryAnalyticsPeriodDays,
} from '../src/features/factory-board/model/factoryAnalytics'
import { FactoryAnalyticsSummary } from '../src/features/factory-board/ui/FactoryAnalyticsSummary'
import { createFactoryAnalyticsLabels } from '../src/features/factory-board/ui/factoryBoardLabels'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that returns a JSON body.
 *
 * @param body - Response body.
 * @returns Requested URLs.
 */
function respondWith(body: unknown): string[] {
  const urls: string[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return urls
}

/**
 * Renders the summary with Japanese text.
 *
 * @param analytics - Analytics to show.
 * @returns Static markup.
 */
function render(analytics = factoryAnalyticsFixture): string {
  return renderToStaticMarkup(
    <FactoryAnalyticsSummary
      analytics={analytics}
      formatNumber={(value) => String(value)}
      isLoading={false}
      labels={createFactoryAnalyticsLabels('ja')}
      onPeriodDaysChange={() => undefined}
      onRetry={() => undefined}
      periodDays={30}
    />,
  )
}

describe('Factory analytics API', () => {
  test('requests the period and returns a valid response', async () => {
    const urls = respondWith(factoryAnalyticsFixture)
    const analytics = await getTeamFactoryAnalytics('token', 'core team', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })
    expect(analytics).toEqual(factoryAnalyticsFixture)
    expect(urls[0]).toContain('/teams/core%20team/agent-runs/analytics?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-31T00%3A00%3A00.000Z')
  })

  test('rejects a response with an unknown station, runtime, or rate', async () => {
    for (const body of [
      { ...factoryAnalyticsFixture, stageLeadTimes: [{ stage: 'intake', medianHours: 1, sampleSize: 1 }] },
      { ...factoryAnalyticsFixture, runtimes: [{ ...factoryAnalyticsFixture.runtimes[0], runtime: 'cursor' }] },
      { ...factoryAnalyticsFixture, successRate: 120 },
      { ...factoryAnalyticsFixture, historyHasMore: undefined },
    ]) {
      respondWith(body)
      await expect(getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })).rejects.toMatchObject({ status: 502 })
    }
  })
})

describe('Factory analytics model', () => {
  test('builds the period ending now and reads only offered lengths', () => {
    expect(createFactoryAnalyticsPeriod(7, new Date('2026-10-31T00:00:00.000Z'))).toEqual({ from: '2026-10-24T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })
    expect(readFactoryAnalyticsPeriodDays('90')).toBe(90)
    expect(readFactoryAnalyticsPeriodDays('365')).toBeUndefined()
    expect(isFactoryAnalyticsIncomplete(factoryAnalyticsFixture)).toBe(false)
    expect(isFactoryAnalyticsIncomplete({ ...factoryAnalyticsFixture, historyHasMore: true })).toBe(true)
  })
})

describe('Factory analytics summary', () => {
  test('shows rates, interventions, station medians, and runtimes', () => {
    const markup = render()
    expect(markup).toContain('78.9%')
    expect(markup).toContain('一時停止を除く 38 Run のうち完了 30')
    expect(markup).toContain('解放 2・引き継ぎ 1')
    expect(markup).toContain('5.5 時間')
    expect(markup).toContain('Codex')
    expect(markup).not.toContain('role="note"')
  })

  test('shows a dash for a station no run entered, the empty text, and the incomplete notice', () => {
    const markup = render({
      ...factoryAnalyticsFixture,
      stageLeadTimes: factoryAnalyticsFixture.stageLeadTimes.map((stage) => stage.stage === 'decision' ? { ...stage, medianHours: null, sampleSize: 0 } : stage),
      historyHasMore: true,
    })
    expect(markup).toContain('—')
    expect(markup).toContain('role="note"')
    expect(render({ ...factoryAnalyticsFixture, finishedRuns: 0, runtimes: [] })).toContain('期間内に終了した Run はありません。')
  })
})
