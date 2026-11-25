import { describe, expect, test } from 'bun:test'
import type { NotificationCategory } from '@mukuroji/contracts'
import { NotificationError } from './notification-error'
import {
  classifyNotificationCategory,
  normalizeNotificationCategoryChannels,
  normalizeNotificationMutes,
  resolveNotificationRouting,
} from './notification-routing'

const allChannels = { inApp: true, email: true, push: true, slack: true }

/** Event types and reasons with the category each must get. */
const classificationCases: Array<[{ eventType: string, reasons: string[] }, NotificationCategory]> = [
    [{ eventType: 'comment.created', reasons: ['mention', 'watcher'] }, 'mention'],
    [{ eventType: 'approval.requested', reasons: ['approval-requested'] }, 'approval'],
    [{ eventType: 'approval.completed', reasons: ['creator'] }, 'approval'],
    [{ eventType: 'work-item.updated', reasons: ['assignment', 'status-change'] }, 'assignment'],
    [{ eventType: 'triage.assigned', reasons: ['triage-assignment'] }, 'assignment'],
    [{ eventType: 'workload.assignment.confirmed', reasons: ['workload-assignment'] }, 'assignment'],
    [{ eventType: 'work-item.updated', reasons: ['creator', 'status-change'] }, 'status'],
    [{ eventType: 'work-item.blocker-removed', reasons: ['watcher'] }, 'status'],
    [{ eventType: 'work-item.updated', reasons: ['schedule-change'] }, 'due'],
    [{ eventType: 'work-item.overdue-escalation', reasons: ['escalation'] }, 'due'],
    [{ eventType: 'work-item.due-soon', reasons: ['due-soon'] }, 'due'],
    [{ eventType: 'comment.replied', reasons: ['reply'] }, 'comment'],
    [{ eventType: 'comment.created', reasons: ['assignee', 'watcher'] }, 'comment'],
    [{ eventType: 'document.comment.created', reasons: ['watcher'] }, 'comment'],
    [{ eventType: 'planning-update.commented', reasons: ['update-author'] }, 'comment'],
    [{ eventType: 'planning-update.escalation', reasons: ['escalation'] }, 'planning'],
    [{ eventType: 'planning-update.health-degraded', reasons: ['update-owner'] }, 'planning'],
    [{ eventType: 'timesheet.submission-reminder', reasons: ['timesheet'] }, 'reminder'],
    [{ eventType: 'weekly-report.submission-escalation', reasons: ['weekly-report-escalation'] }, 'reminder'],
    [{ eventType: 'analytics.report.delivered', reasons: ['recipient'] }, 'other'],
    [{ eventType: 'work-item.updated', reasons: ['contributor'] }, 'assignment'],
    [{ eventType: 'agent-run.reported', reasons: ['agent-run-blocker'] }, 'status'],
    [{ eventType: 'agent-run.stalled', reasons: ['agent-run-stalled'] }, 'status'],
]

describe('classifyNotificationCategory', () => {
  test.each(classificationCases)('classifies %o as %s', (subject, category) => {
    expect(classifyNotificationCategory(subject)).toBe(category)
  })
})

describe('resolveNotificationRouting', () => {
  test('turns off only the channels a category turned off, and never turns on a switched-off channel', () => {
    const preferences = {
      channels: { ...allChannels, push: false },
      categoryChannels: { status: { slack: false as const, email: false as const } },
    }
    const status = resolveNotificationRouting(preferences, { eventType: 'work-item.updated', reasons: ['status-change'] })
    expect(status.channels).toEqual({ inApp: true, email: false, push: false, slack: false })
    const due = resolveNotificationRouting(preferences, { eventType: 'work-item.due', reasons: ['due'] })
    expect(due.channels).toEqual({ inApp: true, email: true, push: false, slack: true })
  })

  test('mutes a Project or Team but keeps mentions and approval requests when the member chose to', () => {
    const mutes = { projectKeys: ['dev#noisy'], teamIds: ['ops'], keepMentions: true, keepApprovals: false }
    const preferences = { channels: allChannels, mutes }
    const muted = resolveNotificationRouting(preferences, {
      eventType: 'work-item.updated', reasons: ['status-change'], projectId: 'noisy', teamId: 'dev',
    })
    expect(muted.muted).toBe(true)
    expect(Object.values(muted.channels).some(Boolean)).toBe(false)
    expect(resolveNotificationRouting(preferences, {
      eventType: 'comment.created', reasons: ['mention'], teamId: 'ops',
    }).muted).toBe(false)
    expect(resolveNotificationRouting(preferences, {
      eventType: 'approval.requested', reasons: ['approval-requested'], teamId: 'ops',
    }).muted).toBe(true)
    expect(resolveNotificationRouting(preferences, {
      eventType: 'work-item.updated', reasons: ['status-change'], projectId: 'quiet', teamId: 'dev',
    }).muted).toBe(false)
    // Project IDs are unique only inside a Team, so another Team's `noisy` is not muted.
    expect(resolveNotificationRouting(preferences, {
      eventType: 'work-item.updated', reasons: ['status-change'], projectId: 'noisy', teamId: 'qa',
    }).muted).toBe(false)
    expect(resolveNotificationRouting(preferences, {
      eventType: 'work-item.updated', reasons: ['status-change'], projectId: 'noisy',
    }).muted).toBe(false)
  })
})

describe('routing setting validation', () => {
  test('keeps only channels turned off and rejects unknown names', () => {
    expect(normalizeNotificationCategoryChannels({
      status: { slack: false, inApp: true, email: null }, due: {}, mention: null,
    })).toEqual({ status: { slack: false } })
    for (const value of [[], { unknown: {} }, { status: { fax: false } }, { status: { slack: 'off' } }, { status: [] }]) {
      expect(() => normalizeNotificationCategoryChannels(value)).toThrow(NotificationError)
    }
  })

  test('sorts and de-duplicates muted IDs and rejects malformed mutes', () => {
    expect(normalizeNotificationMutes({ projectKeys: [' t#b ', 't#a', 't#b'] })).toEqual({
      projectKeys: ['t#a', 't#b'], teamIds: [], keepMentions: true, keepApprovals: true,
    })
    const tooMany = Array.from({ length: 101 }, (_, index) => `team#project-${index}`)
    for (const value of [
      null, { projectKeys: 't#a' }, { teamIds: [1] }, { teamIds: [''] }, { teamIds: ['a#b'] },
      { projectKeys: ['a'] }, { projectKeys: ['t#'] }, { projectKeys: ['#a'] }, { projectKeys: ['t#a#b'] },
      { projectIds: ['a'] }, { projectKeys: tooMany }, { keepMentions: 'yes' }, { other: true },
    ]) {
      expect(() => normalizeNotificationMutes(value)).toThrow(NotificationError)
    }
  })
})
