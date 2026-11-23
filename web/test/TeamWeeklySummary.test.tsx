import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTeamMonthlySummary, getTeamWeeklySummary } from '../src/features/time-tracking/api/weeklyReports'
import {
  teamWeeklySummaryFixture,
  teamWeeklySummaryFixtureProjectNames,
  timeTrackingFixtureWeekStart,
} from '../src/features/time-tracking/fixtures'
import { createWeekPeriod } from '../src/features/time-tracking/model/timePeriod'
import { formatMonth } from '../src/features/time-tracking/ui/TeamMonthlySummaryContainer'
import { TeamWeeklySummary } from '../src/features/time-tracking/ui/TeamWeeklySummary'
import { formatTeamSummaryMarkdown } from '../src/features/time-tracking/ui/teamSummaryMarkdown'
import { TimeWeekNavigator } from '../src/features/time-tracking/ui/TimeWeekNavigator'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../src/shared/routing/paths'

/** Fetch before a test replaced it. */
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Renders the summary in Japanese.
 *
 * @param overrides - Props to change.
 * @returns Static markup.
 */
function render(overrides: Partial<Parameters<typeof TeamWeeklySummary>[0]> = {}) {
  return renderToStaticMarkup(
    <TeamWeeklySummary
      formatters={createTimeTrackingFormatters('ja')}
      hasLoadError={false}
      isTooLarge={false}
      onRetry={() => undefined}
      projectNames={teamWeeklySummaryFixtureProjectNames}
      summary={teamWeeklySummaryFixture}
      t={createTranslator('ja')}
      teamId="core-team"
      navigation={(
        <TimeWeekNavigator
          formatters={createTimeTrackingFormatters('ja')}
          onMove={() => undefined}
          t={createTranslator('ja')}
          week={createWeekPeriod(timeTrackingFixtureWeekStart)}
        />
      )}
      {...overrides}
    />,
  )
}

describe('TeamWeeklySummary', () => {
  test('shows the totals and each Project with its sections', () => {
    const html = render()
    expect(html).toContain('Refero')
    expect(html).toContain('Mobile app')
    expect(html).toContain('Project なし')
    expect(html).toContain('6 日遅れ')
    expect(html).toContain('ベースラインがないため遅れは測れません。')
    expect(html).toContain('/teams/core-team/issues')
  })

  test('explains a Team too large to summarize', () => {
    expect(render({ isTooLarge: true, summary: undefined })).toContain('タスクが多すぎる')
  })

  test('links the view from the time tracking page', () => {
    expect(createTeamTimeTrackingPath('core-team', 'weekly-summary', '2026-11-09')).toBe('/teams/core-team/timesheet?view=weekly-summary&week=2026-11-09')
    expect(createTeamTimeTrackingPath('core-team', 'monthly-summary', '2026-10')).toBe('/teams/core-team/timesheet?view=monthly-summary&month=2026-10')
    expect(createTeamTimeTrackingPath('core-team', 'monthly-summary')).toBe('/teams/core-team/timesheet?view=monthly-summary')
  })

  test('shows last month next to each total of a monthly summary', () => {
    const html = render({
      period: 'month',
      summary: { ...teamWeeklySummaryFixture, previousTotals: { completed: 4, delayed: 1, overdue: 0, milestonesReached: 1 } },
    })
    expect(html).toContain('Team・Project の月次まとめ')
    expect(html).toContain('前月 4')
  })

  test('offers the Markdown copy only once the summary has loaded', () => {
    expect(render({ onCopy: async () => undefined })).toContain('Markdown をコピー')
    expect(render({ onCopy: async () => undefined, summary: undefined })).not.toContain('Markdown をコピー')
  })
})

describe('formatTeamSummaryMarkdown', () => {
  test('lists the totals, each Project, and its sections', () => {
    const markdown = formatTeamSummaryMarkdown(
      { ...teamWeeklySummaryFixture, previousTotals: { completed: 4, delayed: 1, overdue: 0, milestonesReached: 1 } },
      'Core 月次まとめ 2026年11月',
      teamWeeklySummaryFixtureProjectNames,
      createTranslator('ja'),
      createTimeTrackingFormatters('ja'),
    )
    expect(markdown.startsWith('# Core 月次まとめ 2026年11月\n')).toBe(true)
    expect(markdown).toContain('(前月 4)')
    expect(markdown).toContain('## Refero')
    expect(markdown).toContain('### ベースラインからの遅れ')
    expect(markdown).toContain('6 日遅れ')
    expect(markdown).toContain('ベースラインがないため遅れは測れません。')
  })

  test('escapes Markdown in titles', () => {
    const [scope] = teamWeeklySummaryFixture.scopes
    if (!scope) throw new Error('The fixture has no scope.')
    const markdown = formatTeamSummaryMarkdown(
      {
        totals: teamWeeklySummaryFixture.totals,
        scopes: [{ ...scope, completed: { count: 1, items: [{ workItemId: 'x', title: '*bold* [link](x)\n# head' }] } }],
      },
      'Core',
      teamWeeklySummaryFixtureProjectNames,
      createTranslator('ja'),
      createTimeTrackingFormatters('ja'),
    )
    expect(markdown).toContain('- \\*bold\\* \\[link\\](x) \\# head')
  })

  test('formats months in each locale', () => {
    expect(formatMonth('2026-11', 'ja')).toBe('2026年11月')
    expect(formatMonth('2026-11', 'en')).toBe('November 2026')
  })
})

describe('getTeamWeeklySummary', () => {
  test('reads a valid response and refuses a malformed one', async () => {
    let body: unknown = teamWeeklySummaryFixture
    let requested = ''
    const fakeFetch: typeof fetch = async (input) => {
      requested = String(input)
      return Response.json(body)
    }
    globalThis.fetch = fakeFetch
    expect(await getTeamWeeklySummary('token', 'core-team', '2026-11-09')).toEqual(teamWeeklySummaryFixture)
    expect(requested).toContain('/teams/core-team/weekly-summary?weekStart=2026-11-09')

    body = { ...teamWeeklySummaryFixture, totals: { completed: 1 } }
    await expect(getTeamWeeklySummary('token', 'core-team', '2026-11-09')).rejects.toThrow('invalid response')
  })
})

describe('getTeamMonthlySummary', () => {
  test('reads a valid response and refuses a malformed one', async () => {
    const valid = {
      teamId: 'core-team',
      month: '2026-11',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      generatedAt: teamWeeklySummaryFixture.generatedAt,
      totals: teamWeeklySummaryFixture.totals,
      previousTotals: { completed: 4, delayed: 1, overdue: 0, milestonesReached: 1 },
      scopes: teamWeeklySummaryFixture.scopes,
    }
    let body: unknown = valid
    let requested = ''
    const fakeFetch: typeof fetch = async (input) => {
      requested = String(input)
      return Response.json(body)
    }
    globalThis.fetch = fakeFetch
    expect(await getTeamMonthlySummary('token', 'core-team', '2026-11')).toEqual(valid)
    expect(requested).toContain('/teams/core-team/monthly-summary?month=2026-11')

    body = { ...valid, previousTotals: undefined }
    await expect(getTeamMonthlySummary('token', 'core-team', '2026-11')).rejects.toThrow('invalid response')
    body = { ...valid, month: '2026-13' }
    await expect(getTeamMonthlySummary('token', 'core-team', '2026-11')).rejects.toThrow('invalid response')
  })
})
