import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTeamFactoryAnalytics } from '../src/work-items/api/agentRuns'
import { factoryAnalyticsFixture, factoryAnalyticsWithUsageFixture } from '../src/features/factory-board/fixtures'
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
      projectNames={{ refero: 'Refero' }}
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

  test('returns the telemetry usage of the period', async () => {
    respondWith(factoryAnalyticsWithUsageFixture)
    const analytics = await getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })
    expect(analytics).toEqual(factoryAnalyticsWithUsageFixture)
  })

  test('rejects a response with an unknown station, runtime, or rate', async () => {
    for (const body of [
      { ...factoryAnalyticsFixture, stageLeadTimes: [{ stage: 'intake', medianHours: 1, sampleSize: 1 }] },
      { ...factoryAnalyticsFixture, runtimes: [{ ...factoryAnalyticsFixture.runtimes[0], runtime: 'cursor' }] },
      { ...factoryAnalyticsFixture, successRate: 120 },
      { ...factoryAnalyticsFixture, historyHasMore: undefined },
      { ...factoryAnalyticsWithUsageFixture, usage: { ...factoryAnalyticsWithUsageFixture.usage, runsHasMore: 'no' } },
      { ...factoryAnalyticsWithUsageFixture, usage: { ...factoryAnalyticsWithUsageFixture.usage, workItems: [{ workItemId: 'a', title: 'A', usage: { inputTokens: -1 } }] } },
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

  test('shows the token usage per Project and Work Item, and leaves the part out without usage', () => {
    const markup = render(factoryAnalyticsWithUsageFixture)
    expect(markup).toContain('data-testid="factory-analytics-usage"')
    expect(markup).toContain('2,776,500 トークン')
    expect(markup).toContain('Refero')
    expect(markup).toContain('Project なし')
    expect(markup).toContain('API の認証フローを整理する')
    expect(markup).toContain('$18.42')
    expect(render()).not.toContain('factory-analytics-usage')
    const { usage } = factoryAnalyticsWithUsageFixture
    if (!usage) throw new Error('The fixture has usage.')
    expect(render({ ...factoryAnalyticsWithUsageFixture, usage: { ...usage, runsHasMore: true } })).toContain('読み込み上限に達したため')
  })
})

describe('Factory analytics time breakdown and comparison', () => {
  test('reads them from the response and sends the comparison field', async () => {
    const urls = respondWith(factoryAnalyticsWithUsageFixture)
    const analytics = await getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', compareFieldId: 'points' })
    expect(analytics.activity).toEqual(factoryAnalyticsWithUsageFixture.activity)
    expect(analytics.comparison).toEqual(factoryAnalyticsWithUsageFixture.comparison)
    expect(urls[0]).toContain('compareFieldId=points')
    respondWith({ ...factoryAnalyticsWithUsageFixture, comparison: { axis: { kind: 'other' }, groups: [], outliers: [], unsizedWorkItems: 0 } })
    await expect(getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })).rejects.toMatchObject({ status: 502 })
  })

  test('shows the longest tools, the working share, the groups, and the outliers', () => {
    const html = renderToStaticMarkup(
      <FactoryAnalyticsSummary
        analytics={factoryAnalyticsWithUsageFixture}
        comparisonFields={[{ id: 'points', name: 'Story points' }]}
        formatNumber={(value) => String(value)}
        isLoading={false}
        labels={createFactoryAnalyticsLabels('ja')}
        onCompareFieldChange={() => undefined}
        onPeriodDaysChange={() => undefined}
        onRetry={() => undefined}
        periodDays={30}
        workItemTypeNames={{ task: 'タスク' }}
      />,
    )
    expect(html).toContain('data-testid="factory-analytics-activity"')
    expect(html).toContain('エージェントが作業していた割合 76.5%')
    expect(html).toContain('MCP github/get_pull_request')
    expect(html).toContain('Skill mukuroji-review')
    expect(html).toContain('タスク ・1 日以下: 9 件 ・中央値 42 分 ・310000 トークン')
    expect(html).toContain('中央値の 4.6 倍')
    expect(html).toContain('見積もりや値がないタスク 4 件は比べていません。')
    expect(html).toContain('Story points')
    expect(html).toMatch(/比べる軸<select[^>]*id="([^"]+)"/u)
  })
  test('names an option whose ID is none apart from the group without a value', () => {
    const group = factoryAnalyticsWithUsageFixture.comparison?.groups[0]
    if (!group || !factoryAnalyticsWithUsageFixture.comparison) throw new Error('fixture has no group')
    const analytics = {
      ...factoryAnalyticsWithUsageFixture,
      comparison: {
        ...factoryAnalyticsWithUsageFixture.comparison,
        axis: { kind: 'custom-field' as const, customFieldId: 'points' },
        groups: [{ ...group, value: 'none', workItemCount: 3 }, { ...group, value: 'none', missingValue: true as const, workItemCount: 2 }],
        outliers: [],
      },
    }
    const html = renderToStaticMarkup(
      <FactoryAnalyticsSummary
        analytics={analytics}
        comparisonFields={[{ id: 'points', name: 'Story points', optionNames: { none: 'ポイントなし' } }]}
        formatNumber={(value) => String(value)}
        isLoading={false}
        labels={createFactoryAnalyticsLabels('ja')}
        onCompareFieldChange={() => undefined}
        onPeriodDaysChange={() => undefined}
        onRetry={() => undefined}
        periodDays={30}
        workItemTypeNames={{ task: 'タスク' }}
      />,
    )
    expect(html).toContain('タスク ・ポイントなし: 3 件')
    expect(html).toContain('タスク ・値なし: 2 件')
    expect(html).not.toContain(`タスク ・${createFactoryAnalyticsLabels('ja').sizeBands.none}: 2 件`)
  })

  test('names the group without an estimate on the size axis', () => {
    const group = factoryAnalyticsWithUsageFixture.comparison?.groups[0]
    if (!group || !factoryAnalyticsWithUsageFixture.comparison) throw new Error('fixture has no group')
    const analytics = {
      ...factoryAnalyticsWithUsageFixture,
      comparison: {
        ...factoryAnalyticsWithUsageFixture.comparison,
        axis: { kind: 'size' as const },
        groups: [{ ...group, value: 'none', missingValue: true as const, workItemCount: 2 }],
        outliers: [],
      },
    }
    const html = renderToStaticMarkup(
      <FactoryAnalyticsSummary
        analytics={analytics}
        formatNumber={(value) => String(value)}
        isLoading={false}
        labels={createFactoryAnalyticsLabels('ja')}
        onPeriodDaysChange={() => undefined}
        onRetry={() => undefined}
        periodDays={30}
        workItemTypeNames={{ task: 'タスク' }}
      />,
    )
    expect(html).toContain(`タスク ・${createFactoryAnalyticsLabels('ja').sizeBands.none}: 2 件`)
  })

  test('lets the viewer go back to the size axis when a custom-field comparison failed to load', () => {
    const html = renderToStaticMarkup(
      <FactoryAnalyticsSummary
        compareFieldId="points"
        errorMessage="読み込めませんでした"
        formatNumber={(value) => String(value)}
        isLoading={false}
        labels={createFactoryAnalyticsLabels('ja')}
        onCompareFieldChange={() => undefined}
        onPeriodDaysChange={() => undefined}
        onRetry={() => undefined}
        periodDays={30}
        workItemTypeNames={{}}
      />,
    )
    expect(html).toContain('見積もりの規模で比べる')
  })

  test('says why the axis selector is missing when the custom fields could not be read, and reads them again', () => {
    const html = renderToStaticMarkup(
      <FactoryAnalyticsSummary
        analytics={factoryAnalyticsWithUsageFixture}
        comparisonFields={[]}
        formatNumber={(value) => String(value)}
        isLoading={false}
        labels={createFactoryAnalyticsLabels('ja')}
        onCompareFieldChange={() => undefined}
        onPeriodDaysChange={() => undefined}
        onRetry={() => undefined}
        onRetryComparisonFields={() => undefined}
        periodDays={30}
        workItemTypeNames={{ task: 'タスク' }}
      />,
    )
    expect(html).toContain('比べる軸に使う custom field を読み込めませんでした。')
    expect(html).toContain('role="alert"')
    expect(html).not.toMatch(/比べる軸<select/u)
  })
})
