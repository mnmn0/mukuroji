import { describe, expect, test } from 'bun:test'
import { TIME_TRACKING_SCHEMA_VERSION, type TimeEntry } from '@mukuroji/contracts'
import {
  readTimesheetReminderFence,
  parseAuditProjectionEvent,
} from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { TIMESHEET_REMINDER_EVENT_TYPE } from '../../modules/notifications'
import type { ChannelDelivery } from '../../modules/notifications'
import { toDeliveryProjectionEvent } from './notification-delivery-authorization'
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
    projectId: 'project-1',
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
  test('lists only draft and rejected Project entries with lower-case owners', async () => {
    const reader = createTimesheetReader({
      listEntries: async () => [
        createEntry({ id: 'draft' }),
        createEntry({ id: 'rejected', status: 'rejected' }),
        createEntry({ id: 'submitted', status: 'submitted' }),
        createEntry({ id: 'approved', status: 'approved' }),
        createEntry({ id: 'no-project', projectId: undefined }),
      ],
    })
    expect(await reader.listUnsubmittedEntries(
      'workspace-1',
      'core',
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-07-12T00:00:00.000Z'),
    )).toEqual([
      { entryId: 'draft', memberKey: 'member@example.com', projectId: 'project-1', startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-01T01:00:00.000Z' },
      { entryId: 'rejected', memberKey: 'member@example.com', projectId: 'project-1', startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-01T01:00:00.000Z' },
    ])
  })

  test('drops a reminder once every named entry is submitted, gone, moved, or owned by someone else', async () => {
    const stored = new Map<string, TimeEntry>([
      ['submitted', createEntry({ id: 'submitted', status: 'submitted' })],
      ['other-owner', createEntry({ id: 'other-owner', userId: 'other@example.com' })],
      ['no-project', createEntry({ id: 'no-project', projectId: undefined })],
      ['moved', createEntry({ id: 'moved', endAt: '2026-07-11T01:00:00.000Z' })],
      ['other-project', createEntry({ id: 'other-project', projectId: 'project-2' })],
      ['rejected', createEntry({ id: 'rejected', status: 'rejected', revision: 4 })],
    ])
    const revalidator = createTimesheetReminderRevalidator({
      getEntry: async (_workspaceId, _teamId, entryId) => stored.get(entryId),
    }, 'AnalyticsTable')
    const event = parseAuditProjectionEvent({
      eventId: 'event-1',
      eventType: TIMESHEET_REMINDER_EVENT_TYPE,
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      outboxStatus: 'pending',
      metadata: {
        teamId: 'core',
        projectId: 'project-1',
        timeEntryIds: ['submitted', 'missing', 'other-owner', 'no-project', 'moved', 'other-project', 'rejected'],
        timesheetDueBefore: '2026-07-05T00:00:00.000Z',
        notificationCandidates: [{ memberKey: 'Member@Example.com', reason: 'timesheet' }],
      },
    })
    if (!event) throw new Error('Expected a parsed event.')

    expect(event.timeEntryIds).toEqual(['submitted', 'missing', 'other-owner', 'no-project', 'moved', 'other-project', 'rejected'])
    expect(event.timesheetDueBefore).toBe('2026-07-05T00:00:00.000Z')
    // The notification save is fenced on the revision of the entry that is still unsubmitted.
    expect(await readTimesheetReminderFence(event, revalidator)).toEqual({
      current: true,
      condition: {
        ConditionCheck: {
          TableName: 'AnalyticsTable',
          Key: { workspaceId: 'workspace-1', recordKey: 'TIME_ENTRY#core#rejected' },
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': 4 },
        },
      },
    })
    stored.set('rejected', createEntry({ id: 'rejected', status: 'submitted' }))
    expect((await readTimesheetReminderFence(event, revalidator)).current).toBe(false)
    // An entry whose dates were corrected to end after the due instant no longer qualifies.
    stored.set('rejected', createEntry({ id: 'rejected', status: 'rejected', endAt: '2026-07-05T00:00:00.001Z' }))
    expect((await readTimesheetReminderFence(event, revalidator)).current).toBe(false)
    stored.set('rejected', createEntry({ id: 'rejected', status: 'rejected' }))
    expect((await readTimesheetReminderFence({ ...event, timesheetDueBefore: undefined }, revalidator)).current).toBe(false)
    expect((await readTimesheetReminderFence({ ...event, projectId: undefined }, revalidator)).current).toBe(false)
    // An entry moved to another Project after the scan does not keep this Project's reminder.
    stored.set('rejected', createEntry({ id: 'rejected', status: 'rejected', projectId: 'project-2' }))
    expect((await readTimesheetReminderFence(event, revalidator)).current).toBe(false)
    stored.set('rejected', createEntry({ id: 'rejected', status: 'rejected' }))
    // Without a revalidator, or without entry IDs, a reminder is never delivered.
    expect((await readTimesheetReminderFence(event, undefined)).current).toBe(false)
    expect((await readTimesheetReminderFence({ ...event, timeEntryIds: [] }, revalidator)).current).toBe(false)
    // A reminder that names someone else as well is not one the schedule produced.
    expect((await readTimesheetReminderFence({
      ...event,
      notificationCandidates: [...event.notificationCandidates, { memberKey: 'other@example.com', reason: 'watcher' }],
    }, revalidator)).current).toBe(false)
    expect(await readTimesheetReminderFence({ ...event, eventType: 'comment.created' }, undefined)).toEqual({ current: true })
  })

  test('rechecks a queued Slack or Email reminder against the entries right before it is sent', async () => {
    const stored = new Map<string, TimeEntry>([['entry-1', createEntry()]])
    const revalidator = createTimesheetReminderRevalidator({
      getEntry: async (_workspaceId, _teamId, entryId) => stored.get(entryId),
    }, 'AnalyticsTable')
    const delivery: ChannelDelivery = {
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      recipientKey: 'workspace-1#member@example.com',
      notificationKey: '2026-07-12T00:00:00.000Z#event-1',
      attempts: 0,
      version: 1,
      nextAttemptAt: '2026-07-12T00:00:00.000Z',
      expiresAt: 2_000_000_000,
      timeEntryIds: ['entry-1'],
      timesheetDueBefore: '2026-07-05T00:00:00.000Z',
      notification: {
        id: 'notification-1',
        eventId: 'event-1',
        eventType: TIMESHEET_REMINDER_EVENT_TYPE,
        reasons: ['timesheet'],
        teamId: 'core',
        projectId: 'project-1',
        occurredAt: '2026-07-12T00:00:00.000Z',
        state: 'unread',
      },
    }
    const event = toDeliveryProjectionEvent(delivery)
    expect(event).toMatchObject({
      workspaceId: 'workspace-1',
      teamId: 'core',
      projectId: 'project-1',
      timeEntryIds: ['entry-1'],
      timesheetDueBefore: '2026-07-05T00:00:00.000Z',
      notificationCandidates: [{ memberKey: 'member@example.com', reason: 'timesheet' }],
    })
    expect((await readTimesheetReminderFence(event, revalidator)).current).toBe(true)
    // Submitted while quiet hours held the message: it is not sent.
    stored.set('entry-1', createEntry({ status: 'submitted' }))
    expect((await readTimesheetReminderFence(event, revalidator)).current).toBe(false)
    stored.set('entry-1', createEntry())
    // A row saved before the entries were kept on it, or a job that cannot reread them, never sends.
    const { timeEntryIds: _ids, ...legacy } = delivery
    expect((await readTimesheetReminderFence(toDeliveryProjectionEvent(legacy), revalidator)).current).toBe(false)
    expect((await readTimesheetReminderFence(event, undefined)).current).toBe(false)
  })
})
