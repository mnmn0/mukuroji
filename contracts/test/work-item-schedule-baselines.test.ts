import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  createProjectScheduleBaselineEntry,
  crossesWorkItemBaselineSlipThreshold,
  deriveWorkItemBaselineEndDelayDays,
  deriveWorkItemBaselineSlipChange,
  parseWorkItemBaselineSlipChange,
  deriveWorkItemScheduleSlip,
  normalizeProjectScheduleBaselineName,
  parseProjectScheduleBaselineResponse,
  parseSavedProjectScheduleBaselines,
  PROJECT_SCHEDULE_BASELINE_MAX_SAVED,
  type WorkItemBaselineDelaySource,
  type WorkItemSchedule,
} from '../src/index'

/**
 * Builds a date-range schedule.
 *
 * @param startDate - Planned start.
 * @param endDate - Planned end.
 * @returns The schedule.
 */
function range(startDate: string, endDate: string): WorkItemSchedule {
  return {
    mode: 'date-range',
    calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] },
    startDate,
    endDate,
    durationDays: 5,
  }
}

describe('schedule baseline', () => {
  test('freezes the planned dates a schedule has', () => {
    expect(createProjectScheduleBaselineEntry('a', range('2026-12-01', '2026-12-05'))).toEqual({
      workItemId: 'a',
      startDate: '2026-12-01',
      endDate: '2026-12-05',
    })
    expect(createProjectScheduleBaselineEntry('b', createDefaultDueDateWorkItemSchedule('2026-12-05'))).toEqual({
      workItemId: 'b',
      endDate: '2026-12-05',
    })
    expect(createProjectScheduleBaselineEntry('c', createDefaultUnscheduledWorkItemSchedule())).toEqual({ workItemId: 'c' })
  })

  test('derives signed slips from the baseline to the current plan', () => {
    const baseline = createProjectScheduleBaselineEntry('a', range('2026-12-01', '2026-12-05'))
    expect(deriveWorkItemScheduleSlip(baseline, range('2026-12-03', '2026-12-10'))).toEqual({
      startSlipDays: 2,
      endSlipDays: 5,
    })
    expect(deriveWorkItemScheduleSlip(baseline, createDefaultDueDateWorkItemSchedule('2026-12-04'))).toEqual({
      endSlipDays: -1,
    })
    expect(deriveWorkItemScheduleSlip(baseline, createDefaultUnscheduledWorkItemSchedule())).toEqual({})
  })

  test('measures the end delay like the weekly summary: actual end once completed, plan while open', () => {
    const baseline = createProjectScheduleBaselineEntry('a', range('2026-12-01', '2026-12-05'))
    const open = { schedule: range('2026-12-01', '2026-12-08'), statusCategory: 'started' as const }
    expect(deriveWorkItemBaselineEndDelayDays(baseline, open)).toBe(3)
    expect(deriveWorkItemBaselineEndDelayDays(baseline, {
      ...open,
      statusCategory: 'completed',
      actualEndDate: '2026-12-04',
    })).toBe(-1)
    // Completed without a recorded end, or canceled, has nothing to measure.
    expect(deriveWorkItemBaselineEndDelayDays(baseline, { ...open, statusCategory: 'completed' })).toBeUndefined()
    expect(deriveWorkItemBaselineEndDelayDays(baseline, { ...open, statusCategory: 'canceled' })).toBeUndefined()
    expect(deriveWorkItemBaselineEndDelayDays({ workItemId: 'a' }, open)).toBeUndefined()
    expect(deriveWorkItemBaselineEndDelayDays(baseline, {
      schedule: createDefaultUnscheduledWorkItemSchedule(),
      statusCategory: 'unstarted',
    })).toBeUndefined()
  })

  test('validates untrusted responses', () => {
    expect(parseProjectScheduleBaselineResponse({ teamId: 't', projectId: 'p', baseline: null })).toEqual({
      teamId: 't',
      projectId: 'p',
      baseline: null,
      savedBaselines: [],
    })
    const valid = {
      teamId: 't',
      projectId: 'p',
      baseline: { revision: 1, capturedAt: '2026-11-19T00:00:00.000Z', entries: [{ workItemId: 'a', endDate: '2026-12-05' }] },
    }
    expect(parseProjectScheduleBaselineResponse(valid)).toEqual({ ...valid, savedBaselines: [] })
    expect(parseProjectScheduleBaselineResponse({ ...valid, baseline: { ...valid.baseline, revision: 0 } })).toBeUndefined()
    expect(parseProjectScheduleBaselineResponse({
      ...valid,
      baseline: { ...valid.baseline, entries: [{ workItemId: 'a', endDate: 'soon' }] },
    })).toBeUndefined()
    for (const endDate of ['2026-02-30', '2026-13-01']) {
      expect(parseProjectScheduleBaselineResponse({
        ...valid,
        baseline: { ...valid.baseline, entries: [{ workItemId: 'a', endDate }] },
      })).toBeUndefined()
    }
    for (const capturedAt of ['broken', '2026-11-19', '2026-02-30T00:00:00.000Z', '2026-11-19T00:00:00Z']) {
      expect(parseProjectScheduleBaselineResponse({ ...valid, baseline: { ...valid.baseline, capturedAt } })).toBeUndefined()
    }
  })

  test('freezes the planned effort and derives the effort change', () => {
    const schedule = { ...createDefaultDueDateWorkItemSchedule('2026-12-05'), plannedEffortMinutes: 480 }
    const entry = createProjectScheduleBaselineEntry('a', schedule)
    expect(entry).toEqual({ workItemId: 'a', endDate: '2026-12-05', plannedEffortMinutes: 480 })
    expect(deriveWorkItemScheduleSlip(entry, { ...schedule, plannedEffortMinutes: 600 })).toEqual({
      endSlipDays: 0,
      effortDeltaMinutes: 120,
    })
    // Without an estimate on either side there is no effort change.
    expect(deriveWorkItemScheduleSlip({ workItemId: 'a', endDate: '2026-12-05' }, schedule)).toEqual({ endSlipDays: 0 })
  })

  test('validates named baselines and the saved list', () => {
    const saved = { id: 'b1', name: '計画承認', capturedAt: '2026-11-19T00:00:00.000Z', entryCount: 1 }
    const valid = {
      teamId: 't',
      projectId: 'p',
      activeBaselineId: 'b1',
      savedBaselines: [saved],
      baseline: {
        revision: 1,
        id: 'b1',
        name: '計画承認',
        capturedAt: '2026-11-19T00:00:00.000Z',
        entries: [{ workItemId: 'a', endDate: '2026-12-05', plannedEffortMinutes: 60 }],
      },
    }
    expect(parseProjectScheduleBaselineResponse(valid)).toEqual(valid)
    expect(parseProjectScheduleBaselineResponse({ ...valid, savedBaselines: [saved, saved] })).toBeUndefined()
    expect(parseProjectScheduleBaselineResponse({ ...valid, activeBaselineId: 'bad id' })).toBeUndefined()
    expect(parseProjectScheduleBaselineResponse({ ...valid, baseline: { ...valid.baseline, name: ' padded ' } })).toBeUndefined()
    expect(parseProjectScheduleBaselineResponse({
      ...valid,
      baseline: { ...valid.baseline, entries: [{ workItemId: 'a', plannedEffortMinutes: -1 }] },
    })).toBeUndefined()
    expect(parseSavedProjectScheduleBaselines(
      Array.from({ length: PROJECT_SCHEDULE_BASELINE_MAX_SAVED + 2 }, (_, index) => ({ ...saved, id: `b${index}` })),
    )).toBeUndefined()
  })

  test('normalizes requested names', () => {
    expect(normalizeProjectScheduleBaselineName(undefined)).toBeUndefined()
    expect(normalizeProjectScheduleBaselineName('   ')).toBeUndefined()
    expect(normalizeProjectScheduleBaselineName('  Q4 承認 ')).toBe('Q4 承認')
    expect(normalizeProjectScheduleBaselineName('a'.repeat(81))).toBeNull()
    expect(normalizeProjectScheduleBaselineName('line\nbreak')).toBeNull()
    expect(normalizeProjectScheduleBaselineName(3)).toBeNull()
  })
})

describe('baseline slip changes', () => {
  const entry = { workItemId: 'a', endDate: '2026-12-10' }
  /**
   * Builds an open Work Item due on the given date.
   *
   * @param dueDate - Planned end.
   * @returns The delay source.
   */
  const open = (dueDate: string): WorkItemBaselineDelaySource => ({
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
    statusCategory: 'started',
  })

  test('records a change that leaves an open Work Item later behind its baseline', () => {
    expect(deriveWorkItemBaselineSlipChange(2, entry, open('2026-12-11'), open('2026-12-14'))).toEqual({
      baselineRevision: 2,
      baselineEndDate: '2026-12-10',
      previousDelayDays: 1,
      delayDays: 4,
    })
    expect(deriveWorkItemBaselineSlipChange(2, entry, undefined, open('2026-12-12'))).toEqual({
      baselineRevision: 2,
      baselineEndDate: '2026-12-10',
      delayDays: 2,
    })
  })

  test('ignores changes that do not make the Work Item later behind its baseline', () => {
    expect(deriveWorkItemBaselineSlipChange(2, entry, open('2026-12-14'), open('2026-12-12'))).toBeUndefined()
    expect(deriveWorkItemBaselineSlipChange(2, entry, open('2026-12-01'), open('2026-12-10'))).toBeUndefined()
    expect(deriveWorkItemBaselineSlipChange(2, { workItemId: 'a' }, open('2026-12-01'), open('2026-12-20'))).toBeUndefined()
    expect(deriveWorkItemBaselineSlipChange(2, entry, open('2026-12-01'), {
      schedule: createDefaultDueDateWorkItemSchedule('2026-12-20'),
      statusCategory: 'completed',
      actualEndDate: '2026-12-20',
    })).toBeUndefined()
  })

  test('crosses a threshold only from below', () => {
    expect(crossesWorkItemBaselineSlipThreshold({ previousDelayDays: 2, delayDays: 3 }, 3)).toBe(true)
    expect(crossesWorkItemBaselineSlipThreshold({ delayDays: 3 }, 3)).toBe(true)
    expect(crossesWorkItemBaselineSlipThreshold({ previousDelayDays: 3, delayDays: 5 }, 3)).toBe(false)
    expect(crossesWorkItemBaselineSlipThreshold({ previousDelayDays: 0, delayDays: 2 }, 3)).toBe(false)
  })

  test('parses only well-formed recorded slips', () => {
    const slip = { baselineRevision: 2, baselineEndDate: '2026-12-10', previousDelayDays: 1, delayDays: 4 }
    expect(parseWorkItemBaselineSlipChange(slip)).toEqual(slip)
    expect(parseWorkItemBaselineSlipChange({ ...slip, delayDays: 0 })).toBeUndefined()
    expect(parseWorkItemBaselineSlipChange({ ...slip, previousDelayDays: 4 })).toBeUndefined()
    expect(parseWorkItemBaselineSlipChange({ ...slip, baselineEndDate: '12/10' })).toBeUndefined()
    expect(parseWorkItemBaselineSlipChange({ ...slip, baselineRevision: 0 })).toBeUndefined()
    expect(parseWorkItemBaselineSlipChange('slip')).toBeUndefined()
  })
})
