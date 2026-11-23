import { describe, expect, test } from 'bun:test'
import { DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS } from '@mukuroji/contracts'
import {
  isCurrentWeeklyReportRecipient,
  parseAuditProjectionEvent,
  readWeeklyReportReminderFence,
  type ProjectDirectoryItem,
} from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import {
  WEEKLY_REPORT_ESCALATION_EVENT_TYPE,
  WEEKLY_REPORT_REMINDER_EVENT_TYPE,
  createDynamoDbWeeklyReportRosterReader,
  type ChannelDelivery,
} from '../../modules/notifications'
import { toDeliveryProjectionEvent } from './notification-delivery-authorization'
import { createWeeklyReportReader, createWeeklyReportReminderRevalidator } from './weekly-report-reminders'

/**
 * Builds a stored week with a submission count.
 *
 * @param submissionCount - Submitted versions.
 * @returns Week record.
 */
function createWeek(submissionCount: number) {
  return {
    weekStart: '2026-11-16',
    revision: 1,
    updatedAt: '2026-11-20T00:00:00.000Z',
    notes: { issues: '', reflection: '' },
    submissionCount,
  }
}

/**
 * Parses a weekly report event the way the projection reads it from the stream.
 *
 * @param eventType - Reminder or escalation.
 * @param recipient - Recipient member key and reason.
 * @returns Parsed event.
 */
function createEvent(eventType: string, recipient: { memberKey: string; reason: string }) {
  const event = parseAuditProjectionEvent({
    eventId: 'event-1',
    eventType,
    workspaceId: 'workspace-1',
    occurredAt: '2026-11-20T08:00:00.000Z',
    outboxStatus: 'pending',
    metadata: {
      teamId: 'core',
      projectId: 'platform',
      weeklyReportWeekStart: '2026-11-16',
      weeklyReportAuthorMemberKey: 'member@example.com',
      notificationCandidates: [recipient],
    },
  })
  if (!event) throw new Error('Expected a parsed event.')
  return event
}

describe('weekly report reminder adapters', () => {
  test('fences a reminder on the unsubmitted week and drops it once submitted', async () => {
    let week: ReturnType<typeof createWeek> | null = null
    const reads: unknown[] = []
    const revalidator = createWeeklyReportReminderRevalidator({
      getWeek: async (scope, weekStart) => {
        reads.push([scope, weekStart])
        return week
      },
    }, 'PlanningTable')
    const reminder = createEvent(WEEKLY_REPORT_REMINDER_EVENT_TYPE, { memberKey: 'Member@Example.com', reason: 'weekly-report' })

    const condition = {
      ConditionCheck: {
        TableName: 'PlanningTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'WEEKLY_REPORT#core#MEMBER#member%40example.com#W#2026-11-16' },
        ConditionExpression: 'attribute_not_exists(#recordKey) OR #submissionCount = :zero',
        ExpressionAttributeNames: { '#recordKey': 'recordKey', '#submissionCount': 'submissionCount' },
        ExpressionAttributeValues: { ':zero': 0 },
      },
    }
    expect(await readWeeklyReportReminderFence(reminder, revalidator)).toEqual({ current: true, condition })
    expect(reads).toEqual([[{ workspaceId: 'workspace-1', teamId: 'core', memberKey: 'member@example.com' }, '2026-11-16']])
    week = createWeek(0)
    expect(await readWeeklyReportReminderFence(reminder, revalidator)).toEqual({ current: true, condition })
    week = createWeek(1)
    expect((await readWeeklyReportReminderFence(reminder, revalidator)).current).toBe(false)
    week = null

    // Anything the schedule would not have produced is dropped.
    expect((await readWeeklyReportReminderFence(reminder, undefined)).current).toBe(false)
    expect((await readWeeklyReportReminderFence({ ...reminder, projectId: undefined }, revalidator)).current).toBe(false)
    expect((await readWeeklyReportReminderFence({ ...reminder, weeklyReportWeekStart: undefined }, revalidator)).current).toBe(false)
    expect((await readWeeklyReportReminderFence({
      ...reminder,
      notificationCandidates: [{ memberKey: 'other@example.com', reason: 'weekly-report' }],
    }, revalidator)).current).toBe(false)
    expect((await readWeeklyReportReminderFence({
      ...reminder,
      notificationCandidates: [...reminder.notificationCandidates, { memberKey: 'other@example.com', reason: 'watcher' }],
    }, revalidator)).current).toBe(false)
    const escalation = createEvent(WEEKLY_REPORT_ESCALATION_EVENT_TYPE, { memberKey: 'manager@example.com', reason: 'weekly-report-escalation' })
    expect((await readWeeklyReportReminderFence(escalation, revalidator)).current).toBe(true)
    expect((await readWeeklyReportReminderFence({
      ...escalation,
      notificationCandidates: [{ memberKey: 'member@example.com', reason: 'weekly-report-escalation' }],
    }, revalidator)).current).toBe(false)
    expect(await readWeeklyReportReminderFence({ ...reminder, eventType: 'comment.created' }, undefined)).toEqual({ current: true })
  })

  test('delivers only while the author still writes in the Project and the manager still manages it', () => {
    const directory: ProjectDirectoryItem[] = [
      { entryType: 'project-member', projectId: 'platform', memberKey: 'Member@Example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'manager@example.com', role: 'manager' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'viewer@example.com', role: 'viewer' },
      { entryType: 'project-member', projectId: 'mobile', memberKey: 'other-manager@example.com', role: 'manager' },
    ]
    const reminder = { eventType: WEEKLY_REPORT_REMINDER_EVENT_TYPE, projectId: 'platform', weeklyReportAuthorMemberKey: 'member@example.com' }
    const escalation = { ...reminder, eventType: WEEKLY_REPORT_ESCALATION_EVENT_TYPE }
    expect(isCurrentWeeklyReportRecipient(reminder, 'member@example.com', directory)).toBe(true)
    expect(isCurrentWeeklyReportRecipient(reminder, 'member@example.com', directory.slice(1))).toBe(false)
    expect(isCurrentWeeklyReportRecipient({ ...reminder, weeklyReportAuthorMemberKey: 'viewer@example.com' }, 'viewer@example.com', directory)).toBe(false)
    expect(isCurrentWeeklyReportRecipient(escalation, 'manager@example.com', directory)).toBe(true)
    expect(isCurrentWeeklyReportRecipient(escalation, 'viewer@example.com', directory)).toBe(false)
    expect(isCurrentWeeklyReportRecipient(escalation, 'other-manager@example.com', directory)).toBe(false)
    expect(isCurrentWeeklyReportRecipient(escalation, 'manager@example.com', [
      ...directory.slice(0, 1),
      { entryType: 'project-member', projectId: 'platform', memberKey: 'manager@example.com', role: 'manager', archivedAt: '2026-11-21T00:00:00.000Z' },
    ])).toBe(false)
    expect(isCurrentWeeklyReportRecipient({ eventType: 'comment.created', projectId: 'platform' }, 'anyone@example.com', [])).toBe(true)
  })

  test('lists writers and managers per Team from the directory, leaving out ambiguous and archived scopes', async () => {
    const items = [
      { entryType: 'team', teamId: 'core' },
      { entryType: 'team', teamId: 'archived-team', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
      { entryType: 'project', teamId: 'core', projectId: 'old', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'project', teamId: 'core', projectId: 'shared' },
      { entryType: 'project', teamId: 'other', projectId: 'shared' },
      { entryType: 'project', teamId: 'archived-team', projectId: 'legacy' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'Manager@Example.com', role: 'manager', name: ' Manager ' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'member@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'viewer@example.com', role: 'viewer' },
      { entryType: 'project-member', projectId: 'platform', memberKey: 'gone@example.com', role: 'member', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'project-member', projectId: 'old', memberKey: 'member@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'shared', memberKey: 'member@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'legacy', memberKey: 'member@example.com', role: 'member' },
    ]
    const pages = [items.slice(0, 7), items.slice(7)]
    const queries: unknown[] = []
    const readRosters = createDynamoDbWeeklyReportRosterReader({
      tableName: 'ProjectDirectoryTable',
      documentClient: {
        async send(command: { input: Record<string, unknown> }) {
          queries.push(command.input)
          const page = queries.length - 1
          return { Items: pages[page], ...(page === 0 ? { LastEvaluatedKey: { entryKey: 'next' } } : {}) }
        },
      } as never,
    })
    expect(await readRosters('workspace-1')).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core',
      projects: [{
        projectId: 'platform',
        writers: [
          { memberKey: 'manager@example.com', displayName: 'Manager' },
          { memberKey: 'member@example.com' },
        ],
        managerMemberKeys: ['manager@example.com'],
      }],
    }])
    expect(queries).toHaveLength(2)

    const reader = createWeeklyReportReader({
      store: {
        getWeeks: async (_scope, memberKeys) => new Map(memberKeys.map((memberKey, index) => [memberKey, createWeek(index)])),
      },
      readProfile: async (workspaceId) => workspaceId === 'closing'
        ? { status: 'closing' }
        : workspaceId === 'sunday'
        ? {
            status: 'active',
            calendar: {
              fiscalYearStartMonth: 1,
              weekStartDay: 0,
              workingWeekdays: ['monday'],
              holidays: [],
              publicHolidays: 'none',
            },
            weeklyReportReminders: {
              enabled: false,
              reminder: { weekday: 4, hour: 9 },
              escalationEnabled: true,
              escalation: { weekday: 1, hour: 10 },
            },
          }
        : undefined,
      readTeamRosters: readRosters,
    })
    expect(await reader.readWorkspaceSettings('sunday')).toEqual({
      weekStartDay: 0,
      reminders: {
        enabled: false,
        reminder: { weekday: 4, hour: 9 },
        escalationEnabled: true,
        escalation: { weekday: 1, hour: 10 },
      },
    })
    expect(await reader.readWorkspaceSettings('workspace-1')).toEqual({
      weekStartDay: 1,
      reminders: DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
    })
    expect(await reader.readWorkspaceSettings('closing')).toEqual({
      weekStartDay: 1,
      reminders: { ...DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS, enabled: false },
    })
    expect([...await reader.readSubmittedMembers('workspace-1', 'core', ['a@example.com', 'b@example.com', 'c@example.com'], '2026-11-16')])
      .toEqual(['b@example.com', 'c@example.com'])
  })

  test('rechecks a queued Slack or Email reminder against the week right before it is sent', async () => {
    let week: ReturnType<typeof createWeek> | null = createWeek(0)
    const revalidator = createWeeklyReportReminderRevalidator({ getWeek: async () => week }, 'PlanningTable')
    const delivery: ChannelDelivery = {
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      recipientKey: 'workspace-1#member@example.com',
      notificationKey: '2026-11-20T08:00:00.000Z#event-1',
      attempts: 0,
      version: 1,
      nextAttemptAt: '2026-11-20T08:00:00.000Z',
      expiresAt: 2_000_000_000,
      weeklyReportAuthorMemberKey: 'member@example.com',
      weeklyReportWeekStart: '2026-11-16',
      notification: {
        id: 'notification-1',
        eventId: 'event-1',
        eventType: WEEKLY_REPORT_REMINDER_EVENT_TYPE,
        reasons: ['weekly-report'],
        teamId: 'core',
        projectId: 'platform',
        occurredAt: '2026-11-20T08:00:00.000Z',
        state: 'unread',
      },
    }
    const event = toDeliveryProjectionEvent(delivery)
    expect(event).toMatchObject({
      teamId: 'core',
      projectId: 'platform',
      weeklyReportWeekStart: '2026-11-16',
      weeklyReportAuthorMemberKey: 'member@example.com',
      notificationCandidates: [{ memberKey: 'member@example.com', reason: 'weekly-report' }],
    })
    expect((await readWeeklyReportReminderFence(event, revalidator)).current).toBe(true)
    // Submitted while quiet hours or a digest held the message: it is not sent.
    week = createWeek(1)
    expect((await readWeeklyReportReminderFence(event, revalidator)).current).toBe(false)
    week = null
    // A row saved before the week was kept on it, or a job that cannot reread it, never sends.
    const { weeklyReportWeekStart: _week, ...legacy } = delivery
    expect((await readWeeklyReportReminderFence(toDeliveryProjectionEvent(legacy), revalidator)).current).toBe(false)
    expect((await readWeeklyReportReminderFence(event, undefined)).current).toBe(false)
  })
})
