import { describe, expect, test } from 'bun:test'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createTimeEntryFixture,
  createWorkItemFixture,
  timeTrackingFixtureEntries,
  timeTrackingFixtureWeekStart,
  weeklyReportFixtureWorkItems,
} from '../src/features/time-tracking/fixtures'
import {
  buildPersonalWeeklyReport,
  formatPersonalWeeklyReportMarkdown,
} from '../src/features/time-tracking/model/personalWeeklyReport'
import { createWeekPeriod } from '../src/features/time-tracking/model/timePeriod'
import { PersonalWeeklyReport } from '../src/features/time-tracking/ui/PersonalWeeklyReport'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../src/shared/routing/paths'

const week = createWeekPeriod(timeTrackingFixtureWeekStart)

/**
 * Returns an ISO instant at a whole local hour of a date.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param hour - Local hour.
 * @returns ISO instant.
 */
function readLocalHourIso(date: string, hour: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour).toISOString()
}
const en = createTranslator('en')
const ja = createTranslator('ja')

/**
 * Creates a timed entry that starts at a whole local hour.
 *
 * @param id - Entry identifier.
 * @param workItemId - Work Item the time was recorded against.
 * @param date - Local `YYYY-MM-DD` date.
 * @param hour - Local start hour.
 * @param minutes - Duration in minutes.
 * @returns Time entry.
 */
function createLocalEntry(id: string, workItemId: string, date: string, hour: number, minutes: number) {
  const startAt = readLocalHourIso(date, hour)
  return createTimeEntryFixture({
    id,
    workItemId,
    startAt,
    endAt: new Date(Date.parse(startAt) + minutes * 60_000).toISOString(),
    durationMinutes: minutes,
  })
}

describe('buildPersonalWeeklyReport', () => {
  test('sorts the member Work Items into completed, started, overdue, and upcoming', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: timeTrackingFixtureEntries,
    })

    expect(report.weekStart).toBe('2026-11-09')
    expect(report.weekEnd).toBe('2026-11-15')
    expect(report.completed.map((item) => item.id)).toEqual(['onboarding'])
    expect(report.started.map((item) => item.id)).toEqual(['pricing'])
    expect(report.overdue.map((item) => item.id)).toEqual(['invoice'])
    expect(report.upcoming.map((item) => item.id)).toEqual(['survey', 'pricing'])
  })

  test('totals the recorded minutes per Work Item and attaches them to the items', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: [
        createLocalEntry('a', 'onboarding', '2026-11-10', 9, 90),
        createLocalEntry('b', 'onboarding', '2026-11-11', 9, 30),
        createLocalEntry('c', 'other-team-item', '2026-11-12', 9, 45),
      ],
      workItemTitles: { 'other-team-item': 'Review a teammate task' },
    })

    expect(report.totalMinutes).toBe(165)
    expect(report.completed[0]?.minutes).toBe(120)
    expect(report.time).toEqual([
      { workItemId: 'onboarding', title: 'Reduce onboarding friction', minutes: 120 },
      { workItemId: 'other-team-item', title: 'Review a teammate task', minutes: 45 },
    ])
  })

  test('counts only the minutes inside the week, like the timesheet', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: [],
      entries: [
        // Starts on the previous Sunday and runs into Monday, so only Monday's part is counted.
        createTimeEntryFixture({
          id: 'overnight',
          startAt: readLocalHourIso('2026-11-08', 23),
          endAt: readLocalHourIso('2026-11-09', 1),
          durationMinutes: 120,
        }),
      ],
    })

    expect(report.totalMinutes).toBe(60)
    expect(report.time).toEqual([{ workItemId: 'onboarding', title: 'onboarding', minutes: 60 }])
  })

  test('counts a due date as overdue only once it is before today in the current week', () => {
    const dueToday = createWorkItemFixture({
      id: 'due-today',
      title: 'Due today',
      dueDate: '2026-11-11',
      schedule: createDefaultDueDateWorkItemSchedule('2026-11-11'),
    })
    const current = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-11', workItems: [dueToday], entries: [] })
    expect(current.overdue).toEqual([])
    expect(current.upcoming.map((item) => item.id)).toEqual(['due-today'])

    // A past week is judged at its end, so an item due inside it and still open is overdue.
    const past = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-12-01', workItems: [dueToday], entries: [] })
    expect(past.overdue.map((item) => item.id)).toEqual(['due-today'])
  })

  test('leaves out completed, canceled, archived, and far-future items from the open sections', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: [
        createWorkItemFixture({ id: 'canceled', title: 'Canceled', statusCategory: 'canceled', dueDate: '2026-11-01', schedule: createDefaultDueDateWorkItemSchedule('2026-11-01') }),
        createWorkItemFixture({ id: 'old-done', title: 'Done earlier', statusCategory: 'completed', actualEndDate: '2026-11-02' }),
        createWorkItemFixture({ id: 'archived', title: 'Archived', archivedAt: '2026-11-10T00:00:00.000Z', statusCategory: 'started' }),
        createWorkItemFixture({ id: 'later', title: 'Later', dueDate: '2026-12-20', schedule: createDefaultDueDateWorkItemSchedule('2026-12-20') }),
      ],
      entries: [],
    })

    expect(report.completed).toEqual([])
    expect(report.started).toEqual([])
    expect(report.overdue).toEqual([])
    expect(report.upcoming).toEqual([])
  })
})

describe('formatPersonalWeeklyReportMarkdown', () => {
  test('writes the Japanese weekly layout with the member notes', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: [createLocalEntry('a', 'onboarding', '2026-11-10', 9, 90)],
    })
    const markdown = formatPersonalWeeklyReportMarkdown(report, { issues: '請求の丸めは仕様確認待ち', reflection: '順調' }, ja)

    expect(markdown).toBe([
      '# 週報 2026-11-09 – 2026-11-15',
      '',
      '## 今週やったこと',
      '',
      '### 完了',
      '- CORE-12 Reduce onboarding friction (期限 2026-11-12, 実績 1:30)',
      '',
      '### 着手',
      '- CORE-15 Update the pricing page (期限 2026-11-20)',
      '',
      '## 来週やること',
      '- CORE-21 Send the customer survey (期限 2026-11-18)',
      '- CORE-15 Update the pricing page (期限 2026-11-20)',
      '',
      '## 課題',
      '',
      '### 期限を過ぎた未完了のタスク',
      '- CORE-9 Fix invoice rounding (期限 2026-11-06)',
      '',
      '請求の丸めは仕様確認待ち',
      '',
      '## 実績工数',
      '- 合計 1:30',
      '- Reduce onboarding friction 1:30',
      '',
      '## 所感',
      '順調',
      '',
    ].join('\n'))
  })

  test('keeps each title on one line and marks empty sections', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: [createWorkItemFixture({ id: 'x', title: 'Line one\n# injected', statusCategory: 'started', actualStartDate: '2026-11-10' })],
      entries: [],
    })
    const markdown = formatPersonalWeeklyReportMarkdown(report, { issues: '', reflection: '' }, en)

    expect(markdown).toContain('- Line one # injected')
    expect(markdown).not.toContain('\n# injected')
    expect(markdown).toContain('### Completed\n- None')
    expect(markdown).not.toContain('## Reflection')
  })
})

describe('PersonalWeeklyReport', () => {
  test('renders the facts, the note fields, and the Markdown preview', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: timeTrackingFixtureEntries,
    })
    const html = renderToStaticMarkup(
      <PersonalWeeklyReport
        formatters={createTimeTrackingFormatters('en')}
        hasLoadError={false}
        isLoading={false}
        isPartial
        onCopy={async () => undefined}
        onMoveWeek={() => undefined}
        onRetry={() => undefined}
        report={report}
        t={en}
        week={week}
      />,
    )

    expect(html).toContain('Reduce onboarding friction')
    expect(html).toContain('Issues and requests for help')
    expect(html).toContain('Copy Markdown')
    expect(html).toContain('data-testid="weekly-report-markdown"')
    expect(html).toContain(en('timeTracking.weeklyReport.partial'))
  })

  test('hides the facts and the copy action when a read failed', () => {
    const report = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-13', workItems: [], entries: [] })
    const html = renderToStaticMarkup(
      <PersonalWeeklyReport
        formatters={createTimeTrackingFormatters('en')}
        hasLoadError
        isLoading={false}
        isPartial={false}
        onCopy={async () => undefined}
        onMoveWeek={() => undefined}
        onRetry={() => undefined}
        report={report}
        t={en}
        week={week}
      />,
    )

    expect(html).toContain(en('timeTracking.weeklyReport.loadError'))
    expect(html).not.toContain('Copy Markdown')
    expect(html).not.toContain('weekly-report-markdown')
  })

  test('has its own time tracking URL', () => {
    expect(createTeamTimeTrackingPath('core-team', 'weekly-report', '2026-11-09'))
      .toBe('/teams/core-team/timesheet?view=weekly-report&week=2026-11-09')
  })
})
