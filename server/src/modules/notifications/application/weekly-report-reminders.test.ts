import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WEEKLY_REPORT_REMINDER_TIMING,
  evaluateWeeklyReportReminders,
  readWeeklyReportReminderTiming,
  resolveWeeklyReportReminderRun,
  weeklyReportWeekStart,
  type WeeklyReportTeamRoster,
} from './weekly-report-reminders'

/** A Team with two Projects: alice manages platform, bob manages mobile, carol writes in both. */
const roster: WeeklyReportTeamRoster = {
  workspaceId: 'workspace-1',
  teamId: 'core',
  projects: [
    {
      projectId: 'platform',
      writers: [
        { memberKey: 'alice@example.com', displayName: 'Alice' },
        { memberKey: 'carol@example.com', displayName: 'Carol' },
      ],
      managerMemberKeys: ['alice@example.com'],
    },
    {
      projectId: 'mobile',
      writers: [
        { memberKey: 'bob@example.com' },
        { memberKey: 'carol@example.com' },
      ],
      managerMemberKeys: ['alice@example.com', 'bob@example.com'],
    },
  ],
}

describe('weekly report reminder timing', () => {
  test('defaults to Friday 17:00 and Monday 10:00 in Japan, and reads overrides', () => {
    expect(readWeeklyReportReminderTiming({})).toEqual(DEFAULT_WEEKLY_REPORT_REMINDER_TIMING)
    expect(readWeeklyReportReminderTiming({ reminder: 'THU@9', escalation: 'off', timeZone: 'UTC' })).toEqual({
      timeZone: 'UTC',
      reminder: { weekday: 4, hour: 9 },
    })
    expect(readWeeklyReportReminderTiming({ reminder: 'off', escalation: 'mon@10' })).toBeUndefined()
    expect(() => readWeeklyReportReminderTiming({ reminder: 'friday@17' })).toThrow(RangeError)
    expect(() => readWeeklyReportReminderTiming({ reminder: 'fri@24' })).toThrow(RangeError)
    expect(() => readWeeklyReportReminderTiming({ timeZone: 'Mars/Olympus' })).toThrow(RangeError)
    expect(() => readWeeklyReportReminderTiming({ reminder: 'fri@17', escalation: 'fri@17' })).toThrow(RangeError)
  })

  test('acts only in the configured local hours and points the escalation at the reminded week', () => {
    const timing = DEFAULT_WEEKLY_REPORT_REMINDER_TIMING
    // Friday 2026-11-20 17:00 in Japan is 08:00 UTC.
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-20T08:00:00.000Z'), timing)).toEqual({ kind: 'reminder', date: '2026-11-20' })
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-20T08:59:59.000Z'), timing)).toEqual({ kind: 'reminder', date: '2026-11-20' })
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-20T09:00:00.000Z'), timing)).toBeUndefined()
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-20T17:00:00.000Z'), timing)).toBeUndefined()
    // Monday 2026-11-23 10:00 in Japan is 01:00 UTC; the week reminded on Friday the 20th.
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-23T01:00:00.000Z'), timing)).toEqual({ kind: 'escalation', date: '2026-11-20' })
    // Same weekday: a later hour is the same day, an earlier one is a week later.
    const sameDayLater = { timeZone: 'UTC', reminder: { weekday: 5, hour: 9 }, escalation: { weekday: 5, hour: 18 } }
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-20T18:00:00.000Z'), sameDayLater)).toEqual({ kind: 'escalation', date: '2026-11-20' })
    const sameDayEarlier = { timeZone: 'UTC', reminder: { weekday: 5, hour: 18 }, escalation: { weekday: 5, hour: 9 } }
    expect(resolveWeeklyReportReminderRun(new Date('2026-11-27T09:00:00.000Z'), sameDayEarlier)).toEqual({ kind: 'escalation', date: '2026-11-20' })
  })

  test('maps the date to the Workspace week', () => {
    expect(weeklyReportWeekStart('2026-11-20', 1)).toBe('2026-11-16')
    expect(weeklyReportWeekStart('2026-11-20', 0)).toBe('2026-11-15')
    expect(weeklyReportWeekStart('2026-11-20', 5)).toBe('2026-11-20')
  })
})

describe('weekly report reminder candidates', () => {
  test('reminds every writer who has not submitted once, against their first Project', () => {
    expect(evaluateWeeklyReportReminders(roster, 'reminder', '2026-11-16', new Set(['alice@example.com']))).toEqual([
      {
        kind: 'reminder', workspaceId: 'workspace-1', teamId: 'core', weekStart: '2026-11-16',
        authorMemberKey: 'bob@example.com', recipientMemberKey: 'bob@example.com', projectId: 'mobile',
      },
      {
        kind: 'reminder', workspaceId: 'workspace-1', teamId: 'core', weekStart: '2026-11-16',
        authorMemberKey: 'carol@example.com', authorDisplayName: 'Carol', recipientMemberKey: 'carol@example.com', projectId: 'mobile',
      },
    ])
  })

  test('tells each manager of the author once, never the author', () => {
    const candidates = evaluateWeeklyReportReminders(roster, 'escalation', '2026-11-16', new Set())
    expect(candidates.map((candidate) => [candidate.authorMemberKey, candidate.recipientMemberKey, candidate.projectId])).toEqual([
      // Alice writes only in platform, which she alone manages, so nobody is told about her.
      ['bob@example.com', 'alice@example.com', 'mobile'],
      // Carol writes in both; Alice is told once, through the first Project.
      ['carol@example.com', 'alice@example.com', 'mobile'],
      ['carol@example.com', 'bob@example.com', 'mobile'],
    ])
    expect(evaluateWeeklyReportReminders(roster, 'escalation', '2026-11-16', new Set(['carol@example.com', 'alice@example.com', 'bob@example.com']))).toEqual([])
  })
})
