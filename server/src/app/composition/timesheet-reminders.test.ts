import { describe, expect, test } from 'bun:test'
import { TIME_TRACKING_SCHEMA_VERSION, type TimeEntry } from '@mukuroji/contracts'
import {
  isTimesheetReminderCurrent,
  parseAuditProjectionEvent,
} from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { TIMESHEET_REMINDER_EVENT_TYPE } from '../../modules/notifications'
import {
  createTimesheetReader,
  createTimesheetReminderRevalidator,
} from './timesheet-reminders'

/**
 * Creates a stored time entry for the adapters.
 *
 * @param overrides - Fields that differ from a draft entry of member@example.com.
 * @returns Time entry.
 */
function createEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: 'entry-1',
    workspaceId: 'workspace-1',
    teamId: 'core',
    workItemId: 'task-1',
    userId: 'Member@Example.com',
    startAt: '2026-07-01T00:00:00.000Z',
    endAt: '2026-07-01T01:00:00.000Z',
    durationMinutes: 60,
    billable: false,
    currency: 'JPY',
    status: 'draft',
    source: 'manual',
    revision: 1,
    createdAt: '2026-07-01T01:00:00.000Z',
    updatedAt: '2026-07-01T01:00:00.000Z',
    ...overrides,
  }
}

describe('timesheet reminder adapters', () => {
  test('lists only draft and rejected entries with lower-case owners', async () => {
    const reader = createTimesheetReader({
      listEntries: async () => [
        createEntry({ id: 'draft' }),
        createEntry({ id: 'rejected', status: 'rejected' }),
        createEntry({ id: 'submitted', status: 'submitted' }),
        createEntry({ id: 'approved', status: 'approved' }),
      ],
    })
    expect(await reader.listUnsubmittedEntries(
      'workspace-1',
      'core',
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-07-12T00:00:00.000Z'),
    )).toEqual([
      { entryId: 'draft', memberKey: 'member@example.com', startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-01T01:00:00.000Z' },
      { entryId: 'rejected', memberKey: 'member@example.com', startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-01T01:00:00.000Z' },
    ])
  })

  test('drops a reminder once every named entry is submitted, gone, or owned by someone else', async () => {
    const stored = new Map<string, TimeEntry>([
      ['submitted', createEntry({ id: 'submitted', status: 'submitted' })],
      ['other-owner', createEntry({ id: 'other-owner', userId: 'other@example.com' })],
      ['rejected', createEntry({ id: 'rejected', status: 'rejected' })],
    ])
    const revalidator = createTimesheetReminderRevalidator({
      getEntry: async (_workspaceId, _teamId, entryId) => stored.get(entryId),
    })
    const event = parseAuditProjectionEvent({
      eventId: 'event-1',
      eventType: TIMESHEET_REMINDER_EVENT_TYPE,
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      outboxStatus: 'pending',
      metadata: {
        teamId: 'core',
        timeEntryIds: ['submitted', 'missing', 'other-owner', 'rejected'],
        notificationCandidates: [{ memberKey: 'Member@Example.com', reason: 'timesheet' }],
      },
    })
    if (!event) throw new Error('Expected a parsed event.')

    expect(event.timeEntryIds).toEqual(['submitted', 'missing', 'other-owner', 'rejected'])
    expect(await isTimesheetReminderCurrent(event, revalidator)).toBe(true)
    stored.set('rejected', createEntry({ id: 'rejected', status: 'submitted' }))
    expect(await isTimesheetReminderCurrent(event, revalidator)).toBe(false)
    stored.set('rejected', createEntry({ id: 'rejected', status: 'rejected' }))
    // Without a revalidator, or without entry IDs, a reminder is never delivered.
    expect(await isTimesheetReminderCurrent(event, undefined)).toBe(false)
    expect(await isTimesheetReminderCurrent({ ...event, timeEntryIds: [] }, revalidator)).toBe(false)
    // A reminder that names someone else as well is not one the schedule produced.
    expect(await isTimesheetReminderCurrent({
      ...event,
      notificationCandidates: [...event.notificationCandidates, { memberKey: 'other@example.com', reason: 'watcher' }],
    }, revalidator)).toBe(false)
    expect(await isTimesheetReminderCurrent({ ...event, eventType: 'comment.created' }, undefined)).toBe(true)
  })
})
