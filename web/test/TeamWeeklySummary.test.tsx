import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTeamWeeklySummary } from '../src/features/time-tracking/api/weeklyReports'
import {
  teamWeeklySummaryFixture,
  teamWeeklySummaryFixtureProjectNames,
  timeTrackingFixtureWeekStart,
} from '../src/features/time-tracking/fixtures'
import { createWeekPeriod } from '../src/features/time-tracking/model/timePeriod'
import { TeamWeeklySummary } from '../src/features/time-tracking/ui/TeamWeeklySummary'
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
      onMoveWeek={() => undefined}
      onRetry={() => undefined}
      projectNames={teamWeeklySummaryFixtureProjectNames}
      summary={teamWeeklySummaryFixture}
      t={createTranslator('ja')}
      teamId="core-team"
      week={createWeekPeriod(timeTrackingFixtureWeekStart)}
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
