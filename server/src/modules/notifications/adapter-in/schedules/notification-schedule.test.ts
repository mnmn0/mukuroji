import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  parseUtcDateOnly,
  runNotificationSchedule,
  type NotificationScheduleDocumentClient,
  type NotificationScheduleRunOptions,
} from './notification-schedule'

function createRecordingDocumentClient(
  resolve: (name: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const recorded = {
        name: command.constructor.name,
        input: command.input,
      }
      commands.push(recorded)
      return await resolve(recorded.name, recorded.input)
    },
  } as unknown as NotificationScheduleDocumentClient

  return { client, commands }
}

function createWorkItem(overrides: Record<string, unknown> = {}) {
  const {
    dueDate: dueDateOverride,
    schedule: scheduleOverride,
    ...remainingOverrides
  } = overrides
  const rawDueDate = typeof dueDateOverride === 'string'
    ? dueDateOverride
    : '2026-07-12'
  const dueDate = rawDueDate
  const schedule = scheduleOverride ?? {
    calendarPolicy: {
      holidays: [],
      timeZone: 'UTC',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dueDate,
    mode: 'due-date',
  }
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#platform',
    teamId: 'core-team',
    assignedProjectId: 'platform',
    issueId: 'release-checklist',
    sortOrder: 10,
    title: 'Release checklist',
    assigneeUserId: 'Member@Example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate,
    schedule,
    priority: 'medium',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-11T09:00:00.000Z',
    ...remainingOverrides,
  }
}

function createRunOptions(
  documentClient: NotificationScheduleDocumentClient,
  overrides: Partial<NotificationScheduleRunOptions> = {},
): NotificationScheduleRunOptions {
  return {
    documentClient,
    workItemsTableName: 'WorkItemsTable',
    auditEventsTableName: 'AuditEventsTable',
    now: new Date('2026-07-12T09:00:00.000Z'),
    scanPageSize: 25,
    maxScanPages: 10,
    auditRetentionDays: 30,
    requestId: 'schedule-event-1',
    ...overrides,
  }
}

describe('notification schedule handler', () => {
  test('parses only valid canonical UTC date-only values', () => {
    expect(parseUtcDateOnly('2026/07/12')).toBeUndefined()
    expect(parseUtcDateOnly('2026-07-12')).toBe('2026-07-12')
    expect(parseUtcDateOnly('2024-02-29')).toBe('2024-02-29')
    expect(parseUtcDateOnly('1000-01-01')).toBe('1000-01-01')
    expect(parseUtcDateOnly('0999-12-31')).toBeUndefined()
    expect(parseUtcDateOnly('2026-02-29')).toBeUndefined()
    expect(parseUtcDateOnly('2026-02/28')).toBeUndefined()
    expect(parseUtcDateOnly('2026/13/01')).toBeUndefined()
    expect(parseUtcDateOnly('2026/07/12T00:00:00Z')).toBeUndefined()
  })

  test('emits due and overdue audit outbox events and skips ineligible items', async () => {
    const recording = createRecordingDocumentClient((name) => {
      if (name === 'ScanCommand') {
        return {
          ScannedCount: 4,
          Items: [
            createWorkItem(),
            createWorkItem({
              issueId: 'security-review',
              title: 'Security review',
              dueDate: '2026-07-10',
            }),
            createWorkItem({ issueId: 'future', dueDate: '2026-07-13' }),
            createWorkItem({ issueId: 'done', statusCategory: 'completed' }),
          ],
        }
      }

      return {}
    })

    const result = await runNotificationSchedule(createRunOptions(recording.client))
    const puts = recording.commands.filter((command) => command.name === 'PutCommand')
    const dueEvent = puts[0]?.input.Item as Record<string, unknown>
    const overdueEvent = puts[1]?.input.Item as Record<string, unknown>

    expect(result).toEqual({
      scannedItems: 4,
      emittedEvents: 2,
      duplicateEvents: 0,
      skippedItems: 2,
      scannedPages: 1,
    })
    expect(puts).toHaveLength(2)
    expect(dueEvent).toMatchObject({
      schemaVersion: 1,
      directoryId: 'workspace-1',
      eventType: 'work-item.due',
      entityType: 'work-item',
      entityId: 'team/core-team/issue/release-checklist',
      action: 'due',
      outboxStatus: 'pending',
      actor: {
        id: 'system:notification-schedule',
        kind: 'system',
      },
      source: 'system',
      metadata: {
        actorMemberKey: 'system',
        teamId: 'core-team',
        projectId: 'platform',
        issueId: 'release-checklist',
        deepLink: '/teams/core-team/issues?issueId=release-checklist',
        title: 'Release checklist',
        dueDate: '2026-07-12',
        notificationCandidates: [{
          memberKey: 'member@example.com',
          reason: 'due',
        }],
      },
    })
    expect(dueEvent.summary).toBe('Work Item "Release checklist" is due today.')
    expect(overdueEvent).toMatchObject({
      eventType: 'work-item.overdue',
      action: 'overdue',
      metadata: {
        issueId: 'security-review',
        dueDate: '2026-07-10',
        notificationCandidates: [{
          memberKey: 'member@example.com',
          reason: 'overdue',
        }],
      },
    })
  })

  test('changes a date-only Work Item from future to due at the UTC day boundary', async () => {
    const beforeBoundary = createRecordingDocumentClient((name) =>
      name === 'ScanCommand' ? { Items: [createWorkItem()] } : {},
    )
    const atBoundary = createRecordingDocumentClient((name) =>
      name === 'ScanCommand' ? { Items: [createWorkItem()] } : {},
    )

    await expect(runNotificationSchedule(createRunOptions(beforeBoundary.client, {
      now: new Date('2026-07-11T23:59:59.999Z'),
    }))).resolves.toMatchObject({
      emittedEvents: 0,
      skippedItems: 1,
    })
    await expect(runNotificationSchedule(createRunOptions(atBoundary.client, {
      now: new Date('2026-07-12T00:00:00.000Z'),
    }))).resolves.toMatchObject({
      emittedEvents: 1,
      skippedItems: 0,
    })
    expect(atBoundary.commands.find(({ name }) => name === 'PutCommand')?.input.Item)
      .toMatchObject({ eventType: 'work-item.due' })
  })

  test('evaluates each due date in its canonical schedule timezone', async () => {
    const tokyoSchedule = {
      ...createDefaultDueDateWorkItemSchedule('2026-07-12'),
      calendarPolicy: {
        timeZone: 'Asia/Tokyo',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        holidays: [],
      },
    }
    const newYorkSchedule = {
      ...createDefaultDueDateWorkItemSchedule('2026-07-12'),
      calendarPolicy: {
        timeZone: 'America/New_York',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        holidays: [],
      },
    }
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          Items: [
            createWorkItem({ issueId: 'tokyo', schedule: tokyoSchedule }),
            createWorkItem({ issueId: 'new-york', schedule: newYorkSchedule }),
          ],
        }
      : {})

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-11T15:00:00.000Z'),
    }))).resolves.toMatchObject({
      emittedEvents: 1,
      skippedItems: 1,
    })
    expect(recording.commands.find(({ name }) => name === 'PutCommand')?.input.Item)
      .toMatchObject({
        entityId: 'team/core-team/issue/tokyo',
        eventType: 'work-item.due',
      })
  })

  test('fails closed for non-canonical Work Item rows', async () => {
    const invalidRows = [
      createWorkItem({ issueId: 'invalid-date', dueDate: '2026-02-29' }),
      createWorkItem({ issueId: 'unassigned', assigneeUserId: '' }),
      createWorkItem({ issueId: 'missing-relations', relationIds: undefined }),
      createWorkItem({ issueId: 'legacy-status', status: 'started' }),
      createWorkItem({ issueId: 'missing-creator', creatorMemberKey: undefined }),
      createWorkItem({
        issueId: 'wrong-project-key',
        directoryProjectId: 'workspace-1#project#other',
      }),
      createWorkItem({
        issueId: 'stray-project-key',
        assignedProjectId: undefined,
      }),
    ]

    for (const invalidRow of invalidRows) {
      const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
        ? { ScannedCount: 1, Items: [invalidRow] }
        : {})
      await expect(runNotificationSchedule(createRunOptions(recording.client))).rejects.toThrow(
        'Notification schedule encountered a non-canonical Work Item row.',
      )
    }
  })

  test('paginates a bounded strongly consistent Work Item scan', async () => {
    let scanCount = 0
    const recording = createRecordingDocumentClient((name) => {
      if (name !== 'ScanCommand') {
        return {}
      }

      scanCount += 1
      return scanCount === 1
        ? {
            ScannedCount: 1,
            Items: [createWorkItem()],
            LastEvaluatedKey: {
              directoryTeamId: 'workspace-1#team#core-team',
              issueId: 'release-checklist',
            },
          }
        : {
            ScannedCount: 1,
            Items: [createWorkItem({ issueId: 'overdue', dueDate: '2026-07-11' })],
          }
    })

    const result = await runNotificationSchedule(createRunOptions(recording.client, {
      scanPageSize: 1,
    }))
    const scans = recording.commands.filter((command) => command.name === 'ScanCommand')

    expect(result).toMatchObject({
      scannedItems: 2,
      emittedEvents: 2,
      scannedPages: 2,
    })
    expect(scans).toHaveLength(2)
    expect(scans[0]?.input).toMatchObject({
      TableName: 'WorkItemsTable',
      ConsistentRead: true,
      Limit: 1,
    })
    expect(scans[0]?.input.ProjectionExpression).toBeUndefined()
    expect(scans[0]?.input.FilterExpression).toBeUndefined()
    expect(scans[1]?.input.ExclusiveStartKey).toEqual({
      directoryTeamId: 'workspace-1#team#core-team',
      issueId: 'release-checklist',
    })
  })

  test('uses the same event ID across schedule retries and treats the condition as dedupe', async () => {
    let scanCount = 0
    let putCount = 0
    const eventIds: string[] = []
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        scanCount += 1
        return {
          Items: [createWorkItem({
            assigneeUserId: scanCount === 3 ? 'new-owner@example.com' : 'Member@Example.com',
            dueDate: '2026-07-12',
          })],
        }
      }

      putCount += 1
      eventIds.push(String((input.Item as Record<string, unknown>).eventId))
      if (putCount === 2) {
        const duplicate = new Error('The conditional request failed')
        duplicate.name = 'ConditionalCheckFailedException'
        throw duplicate
      }

      return {}
    })

    const first = await runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T00:01:00.000Z'),
    }))
    const retry = await runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T23:59:00.000Z'),
    }))
    const reassigned = await runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T23:59:30.000Z'),
    }))

    expect(first).toMatchObject({ emittedEvents: 1, duplicateEvents: 0 })
    expect(retry).toMatchObject({ emittedEvents: 0, duplicateEvents: 1 })
    expect(reassigned).toMatchObject({ emittedEvents: 1, duplicateEvents: 0 })
    expect(eventIds).toHaveLength(3)
    expect(eventIds[0]).toBe(eventIds[1])
    expect(eventIds[2]).not.toBe(eventIds[0])
  })

  test('throws after a partial write when DynamoDB returns a transient failure', async () => {
    let putCount = 0
    const recording = createRecordingDocumentClient((name) => {
      if (name === 'ScanCommand') {
        return {
          Items: [
            createWorkItem(),
            createWorkItem({ issueId: 'second', dueDate: '2026-07-11' }),
          ],
        }
      }

      putCount += 1
      if (putCount === 2) {
        const transient = new Error('DynamoDB throttled the write')
        transient.name = 'ProvisionedThroughputExceededException'
        throw transient
      }

      return {}
    })

    await expect(
      runNotificationSchedule(createRunOptions(recording.client)),
    ).rejects.toMatchObject({
      name: 'ProvisionedThroughputExceededException',
    })
    expect(putCount).toBe(2)
  })

  test('fails visibly instead of silently dropping pages beyond the configured bound', async () => {
    const recording = createRecordingDocumentClient((name) =>
      name === 'ScanCommand'
        ? {
            Items: [],
            LastEvaluatedKey: { directoryTeamId: 'next', issueId: 'next' },
          }
        : {},
    )

    await expect(
      runNotificationSchedule(createRunOptions(recording.client, { maxScanPages: 1 })),
    ).rejects.toThrow('exceeded the configured 1 scan page limit')
  })
})
