import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  createPlanningScheduledNotificationCandidates,
  parseUtcDateOnly,
  parsePlanningUpdateTargetScheduleRow,
  runNotificationSchedule,
  type NotificationScheduleDocumentClient,
  type NotificationScheduleRunOptions,
} from './notification-schedule'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
} from '../../../planning'

/** Creates a canonical Project update target row for schedule tests. */
function createPlanningProjectUpdateTarget(overrides: Record<string, unknown> = {}) {
  const cadence = {
    updateOwnerMemberKey: 'Owner@Example.com',
    cadence: { unit: 'week', count: 1 },
    timeZone: 'Asia/Tokyo',
    nextDueAt: '2026-07-12T09:00:00.000Z',
    reminderHoursBefore: 24,
    escalationHoursAfter: 12,
    escalationMemberKey: 'manager@example.com',
  }
  return {
    workspaceId: 'workspace-1',
    recordKey: 'UPDATE_TARGET#PROJECT#core-team#platform',
    entryType: 'planning-update-target',
    target: { type: 'project', teamId: 'core-team', projectId: 'platform' },
    cadence,
    latestVersion: 0,
    updatedAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  }
}

/** Creates a canonical Initiative update target row for schedule tests. */
function createPlanningInitiativeUpdateTarget(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace-1',
    recordKey: 'UPDATE_TARGET#INITIATIVE#launch',
    entryType: 'planning-update-target',
    target: { type: 'initiative', entityId: 'launch' },
    cadence: {
      updateOwnerMemberKey: 'owner@example.com',
      cadence: { unit: 'month', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-07-12T09:00:00.000Z',
      reminderHoursBefore: 24,
    },
    latestVersion: 2,
    updatedAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  }
}

/** Creates one KEYS_ONLY projection returned by the Planning schedule due index. */
function createPlanningDueIndexItem(row: Record<string, unknown>) {
  const workspaceId = row.workspaceId
  const recordKey = row.recordKey
  const cadence = row.cadence
  if (
    typeof workspaceId !== 'string' ||
    typeof recordKey !== 'string' ||
    typeof cadence !== 'object' ||
    cadence === null ||
    !('nextDueAt' in cadence) ||
    typeof cadence.nextDueAt !== 'string' ||
    !('reminderHoursBefore' in cadence) ||
    typeof cadence.reminderHoursBefore !== 'number'
  ) {
    throw new TypeError('Planning schedule test row is invalid.')
  }
  return {
    workspaceId,
    recordKey,
    updateScheduleShard: createPlanningUpdateScheduleShard(workspaceId, recordKey),
    nextNotificationAtRecordKey: createPlanningUpdateNextNotificationAtRecordKey(
      workspaceId,
      recordKey,
      cadence.nextDueAt,
      cadence.reminderHoursBefore,
    ),
  }
}

/** Resolves one Planning due-index query from canonical target test rows. */
function resolvePlanningDueIndexQuery(
  input: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
) {
  if (input.IndexName !== 'UpdateScheduleDueIndex') return undefined
  const values = input.ExpressionAttributeValues
  if (
    typeof values !== 'object' ||
    values === null ||
    !(':scheduleShard' in values) ||
    typeof values[':scheduleShard'] !== 'string' ||
    !(':upperBound' in values) ||
    typeof values[':upperBound'] !== 'string'
  ) {
    throw new TypeError('Planning schedule test query is invalid.')
  }
  const scheduleShard = values[':scheduleShard']
  const upperBound = values[':upperBound']
  const items = rows
    .map(createPlanningDueIndexItem)
    .filter((item) =>
      item.updateScheduleShard === scheduleShard &&
      item.nextNotificationAtRecordKey <= upperBound
    )
  return { Items: items, ScannedCount: items.length }
}

/** Resolves one strong UPDATE_TARGET base-table read from canonical target test rows. */
function resolvePlanningTargetGet(
  input: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
) {
  if (input.TableName !== 'PlanningTable') return undefined
  const key = input.Key
  if (
    typeof key !== 'object' ||
    key === null ||
    !('workspaceId' in key) ||
    typeof key.workspaceId !== 'string' ||
    !('recordKey' in key) ||
    typeof key.recordKey !== 'string' ||
    !key.recordKey.startsWith('UPDATE_TARGET#')
  ) return undefined
  return {
    Item: rows.find((row) =>
      row.workspaceId === key.workspaceId && row.recordKey === key.recordKey
    ),
  }
}

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
    maxScanPages: 100,
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

  test('decodes Planning update targets and derives reminder, overdue, and escalation stages', () => {
    const record = parsePlanningUpdateTargetScheduleRow(createPlanningProjectUpdateTarget())
    expect(record).toBeDefined()
    if (!record) throw new Error('Expected a Planning update target record.')

    expect(createPlanningScheduledNotificationCandidates(
      record,
      new Date('2026-07-11T10:00:00.000Z'),
    )).toEqual([expect.objectContaining({
      kind: 'reminder',
      recipientMemberKey: 'owner@example.com',
      nextDueAt: '2026-07-12T09:00:00.000Z',
    })])
    expect(createPlanningScheduledNotificationCandidates(
      record,
      new Date('2026-07-12T21:00:00.000Z'),
    )).toEqual([
      expect.objectContaining({
        kind: 'overdue',
        recipientMemberKey: 'owner@example.com',
      }),
      expect.objectContaining({
        kind: 'escalation',
        recipientMemberKey: 'manager@example.com',
      }),
    ])
    expect(createPlanningScheduledNotificationCandidates(
      { ...record, archivedAt: '2026-07-12T08:00:00.000Z' },
      new Date('2026-07-12T21:00:00.000Z'),
    )).toEqual([])
    expect(() => parsePlanningUpdateTargetScheduleRow(createPlanningProjectUpdateTarget({
      cadence: {
        updateOwnerMemberKey: 'owner@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-07-12T09:00:00.000Z',
        reminderHoursBefore: 24,
        escalationHoursAfter: 12,
      },
    }))).toThrow('escalation hours and member must be configured together')
  })

  test('emits one deterministic overdue event for an active current Project target', async () => {
    const eventIds: string[] = []
    let putCount = 0
    let reassigned = false
    const recording = createRecordingDocumentClient((name, input) => {
      const targetRow = createPlanningProjectUpdateTarget(reassigned
        ? {
            cadence: {
              updateOwnerMemberKey: 'new-owner@example.com',
              cadence: { unit: 'week', count: 1 },
              timeZone: 'Asia/Tokyo',
              nextDueAt: '2026-07-12T09:00:00.000Z',
              reminderHoursBefore: 24,
              escalationHoursAfter: 12,
              escalationMemberKey: 'manager@example.com',
            },
          }
        : {})
      if (name === 'ScanCommand') {
        return { ScannedCount: 0, Items: [] }
      }
      if (name === 'QueryCommand') {
        const duePage = resolvePlanningDueIndexQuery(input, [targetRow])
        if (duePage) return duePage
        return {
          Items: [{
            directoryId: 'workspace-1',
            entryType: 'project',
            teamId: 'core-team',
            projectId: 'platform',
          }],
        }
      }
      if (name === 'GetCommand') {
        const target = resolvePlanningTargetGet(input, [targetRow])
        if (target) return target
      }
      if (name === 'PutCommand') {
        putCount += 1
        const item = input.Item
        if (typeof item === 'object' && item !== null && 'eventId' in item) {
          eventIds.push(String(item.eventId))
        }
        if (putCount === 2) {
          const duplicate = new Error('The conditional request failed')
          duplicate.name = 'ConditionalCheckFailedException'
          throw duplicate
        }
      }
      return {}
    })
    const options = createRunOptions(recording.client, {
      now: new Date('2026-07-12T10:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    })

    await expect(runNotificationSchedule(options)).resolves.toMatchObject({
      duplicateEvents: 0,
      emittedEvents: 1,
      scannedItems: 1,
      scannedPages: 17,
    })
    await expect(runNotificationSchedule(options)).resolves.toMatchObject({
      duplicateEvents: 1,
      emittedEvents: 0,
    })
    reassigned = true
    await expect(runNotificationSchedule(options)).resolves.toMatchObject({
      duplicateEvents: 0,
      emittedEvents: 1,
    })
    expect(eventIds).toHaveLength(3)
    expect(eventIds[0]).toBe(eventIds[1])
    expect(eventIds[2]).not.toBe(eventIds[0])
    expect(recording.commands.find((command) => command.name === 'PutCommand')?.input.Item)
      .toMatchObject({
        eventType: 'planning-update.overdue',
        entityType: 'planning-update-target',
        entityId: 'project/core-team/platform',
        outboxStatus: 'pending',
        metadata: {
          teamId: 'core-team',
          projectId: 'platform',
          deepLink: '/planning/portfolio?targetType=project&teamId=core-team&projectId=platform',
          planningTargetType: 'project',
          planningTargetId: 'platform',
          planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core-team#platform',
          planningNextDueAt: '2026-07-12T09:00:00.000Z',
          notificationCandidates: [{
            memberKey: 'owner@example.com',
            reason: 'overdue',
          }],
        },
      })
  })

  test('uses percent-encoded public target keys for special-character watcher scopes', async () => {
    const project = createPlanningProjectUpdateTarget({
      recordKey: 'UPDATE_TARGET#PROJECT#team%2Falpha%20space#project%2Fbeta%3F',
      target: {
        type: 'project',
        teamId: 'team/alpha space',
        projectId: 'project/beta?',
      },
    })
    const initiative = createPlanningInitiativeUpdateTarget({
      recordKey: 'UPDATE_TARGET#INITIATIVE#launch%2Fphase%201',
      target: { type: 'initiative', entityId: 'launch/phase 1' },
    })
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        return { Items: [] }
      }
      if (name === 'QueryCommand') {
        const duePage = resolvePlanningDueIndexQuery(input, [project, initiative])
        if (duePage) return duePage
        return {
          Items: [{
            directoryId: 'workspace-1',
            entryType: 'project',
            teamId: 'team/alpha space',
            projectId: 'project/beta?',
          }],
        }
      }
      if (name === 'GetCommand') {
        const target = resolvePlanningTargetGet(input, [project, initiative])
        if (target) return target
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: 'ENTITY#launch%2Fphase%201',
            entryType: 'planning-entity',
            type: 'initiative',
            id: 'launch/phase 1',
          },
        }
      }
      return {}
    })

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T10:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({ emittedEvents: 2 })
    const events = recording.commands
      .filter((command) => command.name === 'PutCommand')
      .map((command) => command.input.Item)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: 'project/team%2Falpha%20space/project%2Fbeta%3F',
        metadata: expect.objectContaining({
          deepLink:
            '/planning/portfolio?targetType=project&teamId=team%2Falpha+space&projectId=project%2Fbeta%3F',
        }),
      }),
      expect.objectContaining({
        entityId: 'initiative/launch%2Fphase%201',
        metadata: expect.objectContaining({
          deepLink: '/planning/portfolio?targetType=initiative&entityId=launch%2Fphase+1',
        }),
      }),
    ]))
  })

  test('suppresses archived Projects and resolves current Initiative scope before emission', async () => {
    const projectRow = createPlanningProjectUpdateTarget()
    const projectRecording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        return { Items: [] }
      }
      if (name === 'QueryCommand') {
        const duePage = resolvePlanningDueIndexQuery(input, [projectRow])
        if (duePage) return duePage
        return {
          Items: [{
            directoryId: 'workspace-1',
            entryType: 'project',
            teamId: 'core-team',
            projectId: 'platform',
            archivedAt: '2026-07-12T09:30:00.000Z',
          }],
        }
      }
      if (name === 'GetCommand') {
        const target = resolvePlanningTargetGet(input, [projectRow])
        if (target) return target
      }
      return {}
    })
    await expect(runNotificationSchedule(createRunOptions(projectRecording.client, {
      now: new Date('2026-07-12T10:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({ emittedEvents: 0 })

    const initiativeRow = createPlanningInitiativeUpdateTarget()
    const initiativeRecording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        return { Items: [] }
      }
      if (name === 'QueryCommand') {
        const duePage = resolvePlanningDueIndexQuery(input, [initiativeRow])
        if (duePage) return duePage
      }
      if (name === 'GetCommand') {
        const target = resolvePlanningTargetGet(input, [initiativeRow])
        if (target) return target
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: 'ENTITY#launch',
            entryType: 'planning-entity',
            type: 'initiative',
            id: 'launch',
            teamId: 'core-team',
            projectId: 'platform',
          },
        }
      }
      return {}
    })
    await expect(runNotificationSchedule(createRunOptions(initiativeRecording.client, {
      now: new Date('2026-07-11T10:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({ emittedEvents: 1 })
    expect(initiativeRecording.commands.find((command) => command.name === 'PutCommand')?.input.Item)
      .toMatchObject({
        eventType: 'planning-update.reminder',
        entityId: 'initiative/launch',
        metadata: {
          teamId: 'core-team',
          projectId: 'platform',
          deepLink: '/planning/portfolio?targetType=initiative&entityId=launch',
          planningTargetType: 'initiative',
          planningTargetId: 'launch',
        },
      })
  })
})
