import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  createProjectScheduleBaselineEntry,
  deriveWorkItemScheduleSlip,
  parseProjectScheduleBaselineResponse,
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

  test('validates untrusted responses', () => {
    expect(parseProjectScheduleBaselineResponse({ teamId: 't', projectId: 'p', baseline: null })).toEqual({
      teamId: 't',
      projectId: 'p',
      baseline: null,
    })
    const valid = {
      teamId: 't',
      projectId: 'p',
      baseline: { revision: 1, capturedAt: '2026-11-19T00:00:00.000Z', entries: [{ workItemId: 'a', endDate: '2026-12-05' }] },
    }
    expect(parseProjectScheduleBaselineResponse(valid)).toEqual(valid)
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
})
