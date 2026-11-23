import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  WEEKLY_SUMMARY_SECTION_ITEM_LIMIT,
  type ProjectScheduleBaseline,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import { buildTeamMonthlySummary, buildTeamWeeklySummary, type WeeklySummaryWorkItem } from './weekly-summary'

/** Week used by the tests, Monday to Sunday. */
const WEEK = '2026-11-16'

/**
 * Builds a milestone schedule on one date.
 *
 * @param date - Milestone date.
 * @returns The schedule.
 */
function milestone(date: string): WorkItemSchedule {
  const { calendarPolicy } = createDefaultDueDateWorkItemSchedule(date)
  return { mode: 'milestone', startDate: date, endDate: date, durationDays: 0, calendarPolicy }
}

/**
 * Builds a Work Item with a deadline.
 *
 * @param id - Work Item ID.
 * @param fields - Fields to override.
 * @returns The Work Item.
 */
function item(id: string, fields: Partial<WeeklySummaryWorkItem> = {}): WeeklySummaryWorkItem {
  return {
    id,
    key: `REF-${id}`,
    title: `Title ${id}`,
    schedule: createDefaultDueDateWorkItemSchedule('2026-11-30'),
    statusCategory: 'started',
    assignedProjectId: 'refero',
    ...fields,
  }
}

/**
 * Builds a baseline holding planned ends.
 *
 * @param ends - Baseline end date per Work Item ID.
 * @returns The baseline.
 */
function baseline(ends: Record<string, string>): ProjectScheduleBaseline {
  return {
    revision: 2,
    capturedAt: '2026-11-01T00:00:00.000Z',
    entries: Object.entries(ends).map(([workItemId, endDate]) => ({ workItemId, endDate })),
  }
}

/**
 * Builds the summary of the test week with the given Work Items.
 *
 * @param workItems - Readable Work Items.
 * @param options - Today, readable Projects, and baselines.
 * @returns The summary.
 */
function summarize(
  workItems: WeeklySummaryWorkItem[],
  options: { today?: string; projectIds?: string[]; baselines?: Map<string, ProjectScheduleBaseline | null> } = {},
) {
  const today = options.today ?? '2026-11-25'
  return buildTeamWeeklySummary({
    teamId: 'core-team',
    weekStart: WEEK,
    now: new Date(`${today}T03:00:00.000Z`),
    projectIds: options.projectIds ?? ['refero'],
    baselines: options.baselines ?? new Map(),
    workItems,
    localToday: () => today,
  })
}

describe('buildTeamWeeklySummary', () => {
  test('counts Work Items completed in the week and the milestones among them', () => {
    const summary = summarize([
      item('done', { statusCategory: 'completed', actualEndDate: '2026-11-18' }),
      item('reached', { statusCategory: 'completed', actualEndDate: '2026-11-22', schedule: milestone('2026-11-20') }),
      item('before', { statusCategory: 'completed', actualEndDate: '2026-11-15' }),
      item('reopened', { statusCategory: 'started', actualEndDate: '2026-11-18' }),
      item('archived', { statusCategory: 'completed', actualEndDate: '2026-11-18', archivedAt: '2026-11-19T00:00:00.000Z' }),
    ])
    expect(summary.weekEnd).toBe('2026-11-22')
    const [refero] = summary.scopes
    expect(refero?.completed.items.map((entry) => entry.workItemId)).toEqual(['done', 'reached'])
    expect(refero?.milestonesReached.items).toEqual([
      { workItemId: 'reached', key: 'REF-reached', title: 'Title reached', plannedEndDate: '2026-11-20', actualEndDate: '2026-11-22' },
    ])
    expect(summary.totals).toEqual({ completed: 2, delayed: 0, overdue: 0, milestonesReached: 1 })
  })

  test('lists open Work Items due before the day after the week, or before today in the current week', () => {
    const workItems = [
      item('late', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-20') }),
      item('sunday', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-22') }),
      item('next-week', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-23') }),
      item('canceled', { statusCategory: 'canceled', schedule: createDefaultDueDateWorkItemSchedule('2026-11-10') }),
      item('unscheduled', { schedule: createDefaultUnscheduledWorkItemSchedule() }),
    ]
    expect(summarize(workItems).scopes[0]?.overdue.items.map((entry) => entry.workItemId)).toEqual(['late', 'sunday'])
    // On Thursday of the current week, only what was due before Thursday is overdue.
    expect(summarize(workItems, { today: '2026-11-19' }).scopes[0]?.overdue.count).toBe(0)
    expect(summarize(workItems, { today: '2026-11-21' }).scopes[0]?.overdue.items.map((entry) => entry.workItemId)).toEqual(['late'])
  })

  test('measures delays against the Project baseline, most delayed first', () => {
    const summary = summarize([
      item('slipped', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-30') }),
      item('slipped-more', { schedule: createDefaultDueDateWorkItemSchedule('2026-12-10') }),
      item('late-finish', { statusCategory: 'completed', actualEndDate: '2026-11-20', schedule: createDefaultDueDateWorkItemSchedule('2026-11-20') }),
      item('on-time', { statusCategory: 'completed', actualEndDate: '2026-11-17' }),
      item('earlier', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-20') }),
      item('old-finish', { statusCategory: 'completed', actualEndDate: '2026-11-10' }),
      item('new'),
    ], {
      baselines: new Map([['refero', baseline({
        slipped: '2026-11-27',
        'slipped-more': '2026-11-27',
        'late-finish': '2026-11-18',
        'on-time': '2026-11-18',
        earlier: '2026-11-25',
        'old-finish': '2026-11-01',
      })]]),
    })
    const [refero] = summary.scopes
    expect(refero?.baseline).toEqual({ revision: 2, capturedAt: '2026-11-01T00:00:00.000Z' })
    expect(refero?.delayed.items.map((entry) => [entry.workItemId, entry.delayDays, entry.baselineEndDate])).toEqual([
      ['slipped-more', 13, '2026-11-27'],
      ['slipped', 3, '2026-11-27'],
      ['late-finish', 2, '2026-11-18'],
    ])
  })

  test('reports Projects without a baseline, and Work Items outside any Project after the Projects', () => {
    const { assignedProjectId: _project, ...teamLevel } = item('team-level', { statusCategory: 'completed', actualEndDate: '2026-11-18' })
    const summary = summarize([teamLevel], { projectIds: ['refero', 'empty'] })
    expect(summary.scopes.map((scope) => [scope.projectId, scope.baseline])).toEqual([
      ['refero', null],
      ['empty', null],
      [undefined, undefined],
    ])
    expect(summary.scopes[2]?.completed.count).toBe(1)
  })

  test('never counts Work Items of a Project the reader cannot read', () => {
    const summary = summarize([
      item('secret', { assignedProjectId: 'secret', statusCategory: 'completed', actualEndDate: '2026-11-18' }),
    ])
    expect(summary.totals.completed).toBe(0)
    expect(JSON.stringify(summary)).not.toContain('Title secret')
  })

  test('lists at most the section limit but counts every match', () => {
    const workItems = Array.from({ length: WEEKLY_SUMMARY_SECTION_ITEM_LIMIT + 5 }, (_, index) =>
      item(String(index).padStart(3, '0'), { statusCategory: 'completed', actualEndDate: '2026-11-18' }))
    const completed = summarize(workItems).scopes[0]?.completed
    expect(completed?.count).toBe(WEEKLY_SUMMARY_SECTION_ITEM_LIMIT + 5)
    expect(completed?.items).toHaveLength(WEEKLY_SUMMARY_SECTION_ITEM_LIMIT)
  })
})

describe('buildTeamMonthlySummary', () => {
  /**
   * Builds the November 2026 summary with the given Work Items.
   *
   * @param workItems - Readable Work Items.
   * @param today - Local date of the computation.
   * @returns The summary.
   */
  const summarizeMonth = (workItems: WeeklySummaryWorkItem[], today = '2026-11-25') => buildTeamMonthlySummary({
    teamId: 'core-team',
    month: '2026-11',
    now: new Date(`${today}T03:00:00.000Z`),
    projectIds: ['refero'],
    baselines: new Map([['refero', baseline({ late: '2026-11-10', octLate: '2026-10-01' })]]),
    workItems,
    localToday: () => today,
  })

  test('counts the whole calendar month and the month before', () => {
    const summary = summarizeMonth([
      item('first', { statusCategory: 'completed', actualEndDate: '2026-11-01' }),
      item('last', { statusCategory: 'completed', actualEndDate: '2026-11-30', schedule: milestone('2026-11-30') }),
      item('october', { statusCategory: 'completed', actualEndDate: '2026-10-31' }),
      item('december', { statusCategory: 'completed', actualEndDate: '2026-12-01' }),
      item('late', { schedule: createDefaultDueDateWorkItemSchedule('2026-11-20') }),
    ])
    expect(summary).toMatchObject({ month: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30' })
    expect(summary.totals).toEqual({ completed: 2, delayed: 1, overdue: 1, milestonesReached: 1 })
    // October: one completion; the open late Work Item was not yet due, but is behind its baseline.
    expect(summary.previousTotals).toEqual({ completed: 1, delayed: 1, overdue: 0, milestonesReached: 0 })
    expect(summary.scopes[0]?.completed.items.map((entry) => entry.workItemId)).toEqual(['first', 'last'])
  })

  test('judges overdue by the end of a past month, not by today', () => {
    const summary = summarizeMonth([
      item('dueOctober', { schedule: createDefaultDueDateWorkItemSchedule('2026-10-15') }),
      item('dueDecember', { schedule: createDefaultDueDateWorkItemSchedule('2026-12-15') }),
    ])
    expect(summary.totals.overdue).toBe(1)
    expect(summary.previousTotals.overdue).toBe(1)
  })
})
