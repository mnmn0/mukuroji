import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY } from '../src/work-items'
import { DEFAULT_WORKSPACE_TIME_ZONE, toWorkspaceLocalDate } from '../src/workspace-calendar'

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
})
