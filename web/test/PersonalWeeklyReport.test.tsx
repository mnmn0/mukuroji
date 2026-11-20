import { describe, expect, test } from 'bun:test'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createTimeEntryFixture,
  createWorkItemFixture,
  timeTrackingFixtureEntries,
  timeTrackingFixtureWeekStart,
  teamWeeklyReportFixtureMembers,
  weeklyReportFixtureSaved,
  weeklyReportFixtureSubmission,
  weeklyReportFixtureWorkItems,
} from '../src/features/time-tracking/fixtures'
import {
  buildPersonalWeeklyReport,
  formatPersonalWeeklyReportMarkdown,
  toSubmitWeeklyReportRequest,
} from '../src/features/time-tracking/model/personalWeeklyReport'
import { createWeekPeriod } from '../src/features/time-tracking/model/timePeriod'
import { reconcileWeeklyReportEditor } from '../src/features/time-tracking/model/weeklyReportNotesEditor'
import { PersonalWeeklyReport } from '../src/features/time-tracking/ui/PersonalWeeklyReport'
import { SubmittedWeeklyReport } from '../src/features/time-tracking/ui/SubmittedWeeklyReport'
import { TeamWeeklyReports } from '../src/features/time-tracking/ui/TeamWeeklyReports'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../src/shared/routing/paths'

const week = createWeekPeriod(timeTrackingFixtureWeekStart)
/** Saved report of a week nothing was saved for. */
const savedReport = { teamId: 'core-team', memberKey: 'demo@example.com', weekStart: timeTrackingFixtureWeekStart, submissionCount: 0 }

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

  test('says in the export that the recorded time is partial', () => {
    const report = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-13', workItems: [], entries: [] })

    expect(formatPersonalWeeklyReportMarkdown(report, { issues: '', reflection: '' }, en, { timeIsPartial: true }))
      .toContain(`## Recorded time\n> ${en('timeTracking.weeklyReport.partial')}\n\n- Total 0:00`)
    expect(formatPersonalWeeklyReportMarkdown(report, { issues: '', reflection: '' }, en))
      .not.toContain(en('timeTracking.weeklyReport.partial'))
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
        onOpenWeek={() => undefined}
        onSaveDraft={async () => 'done'}
        onSubmit={async () => 'done'}
        report={report}
        savedReport={savedReport}
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
        onOpenWeek={() => undefined}
        onSaveDraft={async () => 'done'}
        onSubmit={async () => 'done'}
        report={report}
        savedReport={savedReport}
        t={en}
        week={week}
      />,
    )

    expect(html).toContain(en('timeTracking.weeklyReport.loadError'))
    expect(html).not.toContain('Copy Markdown')
    expect(html).not.toContain('weekly-report-markdown')
  })

  test('starts from the saved notes and offers to submit again after a submission', () => {
    const report = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-13', workItems: [], entries: [] })
    const html = renderToStaticMarkup(
      <PersonalWeeklyReport
        formatters={createTimeTrackingFormatters('en')}
        hasLoadError={false}
        history={[{ weekStart: '2026-11-02', submissionCount: 2, lastSubmittedAt: '2026-11-06T09:00:00.000Z' }]}
        isLoading={false}
        isPartial={false}
        onCopy={async () => undefined}
        onMoveWeek={() => undefined}
        onOpenWeek={() => undefined}
        onRetry={() => undefined}
        onSaveDraft={async () => 'done'}
        onSubmit={async () => 'done'}
        report={report}
        savedReport={weeklyReportFixtureSaved}
        t={en}
        week={week}
      />,
    )

    expect(html).toContain('Onboarding shipped on time.')
    expect(html).toContain('Submitted (version 1,')
    expect(html).toContain('Submit again')
    expect(html).toContain('Submitted (version 2)')
  })

  test('waits for the saved report before showing the note fields', () => {
    const report = buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-13', workItems: [], entries: [] })
    const html = renderToStaticMarkup(
      <PersonalWeeklyReport
        formatters={createTimeTrackingFormatters('en')}
        hasLoadError={false}
        isLoading={false}
        isPartial={false}
        onCopy={async () => undefined}
        onMoveWeek={() => undefined}
        onOpenWeek={() => undefined}
        onRetry={() => undefined}
        onSaveDraft={async () => 'done'}
        onSubmit={async () => 'done'}
        report={report}
        savedReport={undefined}
        t={en}
        week={week}
      />,
    )

    expect(html).toContain(en('timeTracking.weeklyReport.loading'))
    expect(html).not.toContain('Save draft')
  })

  test('has its own time tracking URL', () => {
    expect(createTeamTimeTrackingPath('core-team', 'weekly-report', '2026-11-09'))
      .toBe('/teams/core-team/timesheet?view=weekly-report&week=2026-11-09')
  })
})

describe('reconcileWeeklyReportEditor', () => {
  /**
   * Builds a saved report with notes at a revision.
   *
   * @param revision - Saved revision.
   * @param reflection - Saved reflection.
   * @returns Saved report.
   */
  const saved = (revision: number, reflection: string) => ({
    ...savedReport,
    draft: { revision, updatedAt: '2026-11-13T09:00:00.000Z', notes: { issues: '', reflection } },
  })

  test('follows notes saved elsewhere while nothing is typed', () => {
    const first = reconcileWeeklyReportEditor(undefined, saved(1, 'Mine'))
    const next = reconcileWeeklyReportEditor(first, saved(2, 'From another tab'))
    expect(next.notes.reflection).toBe('From another tab')
    expect(next.base.revision).toBe(2)
  })

  test('keeps typed notes tied to the revision they started from when another tab saves', () => {
    const first = reconcileWeeklyReportEditor(undefined, saved(1, 'Mine'))
    const typing = { ...first, notes: { issues: '', reflection: 'Mine, edited' } }
    const next = reconcileWeeklyReportEditor(typing, saved(2, 'From another tab'))
    expect(next.notes.reflection).toBe('Mine, edited')
    expect(next.base.revision).toBe(1)
  })

  test('moves to the revision its own save produced', () => {
    const first = reconcileWeeklyReportEditor(undefined, saved(1, 'Mine'))
    const typing = { ...first, notes: { issues: '', reflection: 'Mine, edited ' } }
    const next = reconcileWeeklyReportEditor(typing, saved(2, 'Mine, edited'))
    expect(next.notes.reflection).toBe('Mine, edited ')
    expect(next.base.revision).toBe(2)
  })

  test('keeps typed notes across a reread of the same revision', () => {
    const first = reconcileWeeklyReportEditor(undefined, saved(1, 'Mine'))
    const typing = { ...first, notes: { issues: 'Blocked', reflection: 'Mine' } }
    const next = reconcileWeeklyReportEditor(typing, saved(1, 'Mine'))
    expect(next.notes.issues).toBe('Blocked')
    expect(next.base.revision).toBe(1)
  })
})

describe('toSubmitWeeklyReportRequest', () => {
  test('sends only Work Item IDs and minutes with trimmed notes', () => {
    const report = buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: timeTrackingFixtureEntries,
    })
    const request = toSubmitWeeklyReportRequest(report, { issues: ' Blocked ', reflection: '' }, {
      timeIsPartial: true,
      expectedSubmissionCount: 1,
    })

    expect(request.expectedSubmissionCount).toBe(1)
    expect(request.timeIsPartial).toBe(true)
    expect(request.notes).toEqual({ issues: 'Blocked', reflection: '' })
    expect(request.sections.completed).toEqual(report.completed.map((item) => ({ workItemId: item.id, minutes: item.minutes })))
    expect(JSON.stringify(request)).not.toContain('Reduce onboarding friction')
    expect(request.totalMinutes).toBe(report.totalMinutes)
  })
})

describe('SubmittedWeeklyReport', () => {
  test('shows a task the reader cannot view without its name', () => {
    const html = renderToStaticMarkup(
      <SubmittedWeeklyReport formatters={createTimeTrackingFormatters('ja')} submission={weeklyReportFixtureSubmission} t={ja} />,
    )

    expect(html).toContain('Reduce onboarding friction')
    expect(html).toContain('閲覧権限のないタスク')
    expect(html).toContain('Waiting for the pricing review.')
  })
})

describe('TeamWeeklyReports', () => {
  test('counts the submitted members and explains a refusal', () => {
    const props = {
      formatters: createTimeTrackingFormatters('en'),
      week,
      memberNames: { 'sato@example.com': 'Sato' },
      hasLoadError: false,
      selectedMemberKey: 'sato@example.com',
      selectedReport: { teamId: 'core-team', memberKey: 'sato@example.com', weekStart: timeTrackingFixtureWeekStart, submissionCount: 0 },
      hasSelectedReportError: false,
      onSelectMember: () => undefined,
      onMoveWeek: () => undefined,
      onRetry: () => undefined,
      t: en,
    }
    const listed = renderToStaticMarkup(<TeamWeeklyReports {...props} isForbidden={false} members={teamWeeklyReportFixtureMembers} />)
    expect(listed).toContain('1 of 2 submitted')
    expect(listed).toContain('Sato')
    expect(listed).toContain(en('timeTracking.teamWeeklyReports.notSubmitted'))

    const forbidden = renderToStaticMarkup(<TeamWeeklyReports {...props} isForbidden members={undefined} />)
    expect(forbidden).toContain('Only Team managers (Project managers)')
  })
})
