import { describe, expect, test } from 'bun:test'
import {
  parseUtcDateOnly,
  runNotificationSchedule,
  type NotificationScheduleDocumentClient,
  type NotificationScheduleRunOptions,
} from './notification-schedule-handler'

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
  return {
    directoryId: 'workspace-1',
    teamId: 'core-team',
    issueId: 'release-checklist',
    title: 'Release checklist',
    assigneeUserId: 'Member@Example.com',
    status: 'in-progress',
    dueDate: '2026/07/12',
    assignedProjectId: 'platform',
    ...overrides,
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
  test('parses only valid slash or dash UTC date-only values', () => {
    expect(parseUtcDateOnly('2026/07/12')).toBe('2026-07-12')
    expect(parseUtcDateOnly('2026-07-12')).toBe('2026-07-12')
    expect(parseUtcDateOnly('2024/02/29')).toBe('2024-02-29')
    expect(parseUtcDateOnly('2026/02/29')).toBeUndefined()
    expect(parseUtcDateOnly('2026-02/28')).toBeUndefined()
    expect(parseUtcDateOnly('2026/13/01')).toBeUndefined()
    expect(parseUtcDateOnly('2026/07/12T00:00:00Z')).toBeUndefined()
  })

  test('emits due and overdue audit outbox events and skips ineligible items', async () => {
    const recording = createRecordingDocumentClient((name) => {
      if (name === 'ScanCommand') {
        return {
          ScannedCount: 7,
          Items: [
            createWorkItem(),
            createWorkItem({
              issueId: 'security-review',
              title: 'Security review',
              dueDate: '2026-07-10',
            }),
            createWorkItem({ issueId: 'future', dueDate: '2026/07/13' }),
            createWorkItem({ issueId: 'invalid-date', dueDate: '2026/02/29' }),
            createWorkItem({ issueId: 'done', status: 'done' }),
            createWorkItem({ issueId: 'unassigned', assigneeUserId: '' }),
            createWorkItem({ issueId: 'malformed', teamId: undefined }),
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
      scannedItems: 7,
      emittedEvents: 2,
      duplicateEvents: 0,
      skippedItems: 5,
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
            Items: [createWorkItem({ issueId: 'overdue', dueDate: '2026/07/11' })],
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
            dueDate: scanCount === 1 ? '2026/07/12' : '2026-07-12',
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
            createWorkItem({ issueId: 'second', dueDate: '2026/07/11' }),
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
