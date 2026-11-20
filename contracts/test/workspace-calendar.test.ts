import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY } from '../src/work-items'
import {
  DEFAULT_WORKSPACE_TIME_ZONE,
  resolveWorkspaceCalendarPeriod,
  toWorkspaceLocalDate,
  workspaceFiscalQuarterContaining,
  workspaceFiscalYearContaining,
  workspaceWeekContaining,
  type WorkspaceCalendarSettings,
} from '../src/workspace-calendar'

describe('Workspace calendar contracts', () => {
  test('uses Japan time as the Workspace and default Work Item calendar time zone', () => {
    expect(DEFAULT_WORKSPACE_TIME_ZONE).toBe('Asia/Tokyo')
    expect(DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.timeZone).toBe(DEFAULT_WORKSPACE_TIME_ZONE)
  })

  test('maps an instant to the Workspace-local date at the Japan midnight boundary', () => {
    expect(toWorkspaceLocalDate('2026-11-17T14:59:59.999Z')).toBe('2026-11-17')
    expect(toWorkspaceLocalDate('2026-11-17T15:00:00.000Z')).toBe('2026-11-18')
    expect(toWorkspaceLocalDate(Date.parse('2026-11-18T08:59:00.000Z'))).toBe('2026-11-18')
    expect(toWorkspaceLocalDate(new Date('2026-11-17T15:00:00.000Z'), 'UTC')).toBe('2026-11-17')
  })

  test('rejects an invalid instant or time zone', () => {
    expect(() => toWorkspaceLocalDate('not a date')).toThrow(RangeError)
    expect(() => toWorkspaceLocalDate(0, 'Invalid/Time_Zone')).toThrow(RangeError)
  })

  test('counts fiscal years and quarters from the fiscal year start month', () => {
    expect(workspaceFiscalYearContaining('2027-03-31', 4)).toEqual({
      fiscalYear: 2026,
      range: { from: '2026-04-01', to: '2027-03-31' },
    })
    expect(workspaceFiscalYearContaining('2026-04-01', 4).fiscalYear).toBe(2026)
    expect(workspaceFiscalYearContaining('2028-02-29', 1).range).toEqual({ from: '2028-01-01', to: '2028-12-31' })
    expect(workspaceFiscalQuarterContaining('2026-08-15', 4)).toEqual({
      fiscalYear: 2026,
      quarter: 2,
      range: { from: '2026-07-01', to: '2026-09-30' },
    })
    expect(workspaceFiscalQuarterContaining('2027-02-28', 4)).toEqual({
      fiscalYear: 2026,
      quarter: 4,
      range: { from: '2027-01-01', to: '2027-03-31' },
    })
    expect(workspaceFiscalQuarterContaining('2026-12-31', 10)).toEqual({
      fiscalYear: 2026,
      quarter: 1,
      range: { from: '2026-10-01', to: '2026-12-31' },
    })
  })

  test('finds the week from the Workspace week start day', () => {
    // 2026-11-20 is a Friday.
    expect(workspaceWeekContaining('2026-11-20', 1)).toEqual({ from: '2026-11-16', to: '2026-11-22' })
    expect(workspaceWeekContaining('2026-11-20', 0)).toEqual({ from: '2026-11-15', to: '2026-11-21' })
    expect(workspaceWeekContaining('2026-11-20', 5)).toEqual({ from: '2026-11-20', to: '2026-11-26' })
    expect(workspaceWeekContaining('2026-11-20', 6)).toEqual({ from: '2026-11-14', to: '2026-11-20' })
  })

  test('resolves period presets with the Workspace fiscal year and week start', () => {
    const settings: Pick<WorkspaceCalendarSettings, 'fiscalYearStartMonth' | 'weekStartDay'> = {
      fiscalYearStartMonth: 4,
      weekStartDay: 0,
    }
    expect(resolveWorkspaceCalendarPeriod('this-week', '2026-11-20', settings)).toEqual({ from: '2026-11-15', to: '2026-11-21' })
    expect(resolveWorkspaceCalendarPeriod('last-week', '2026-11-20', settings)).toEqual({ from: '2026-11-08', to: '2026-11-14' })
    expect(resolveWorkspaceCalendarPeriod('this-fiscal-quarter', '2026-11-20', settings)).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(resolveWorkspaceCalendarPeriod('last-fiscal-quarter', '2026-04-10', settings)).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(resolveWorkspaceCalendarPeriod('this-fiscal-year', '2026-11-20', settings)).toEqual({ from: '2026-04-01', to: '2027-03-31' })
    expect(resolveWorkspaceCalendarPeriod('last-fiscal-year', '2026-11-20', settings)).toEqual({ from: '2025-04-01', to: '2026-03-31' })
  })

  test('rejects an invalid date or fiscal year start month', () => {
    expect(() => workspaceWeekContaining('2026-02-30', 1)).toThrow(RangeError)
    expect(() => workspaceFiscalYearContaining('2026-11-20', 13)).toThrow(RangeError)
  })
})
