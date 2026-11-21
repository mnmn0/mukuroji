import { describe, expect, spyOn, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  createNotificationScheduleHandler,
  createPlanningScheduledNotificationCandidates,
  parsePlanningUpdateTargetScheduleRow,
  runNotificationSchedule,
  type NotificationScheduleDocumentClient,
  type NotificationScheduleRunOptions,
} from './notification-schedule'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
} from '../../../planning'
import { createDynamoDbProjectManagerReader } from '../../adapter-out/dynamodb/project-manager-reader'
import { createDynamoDbScheduledWorkItemSource } from '../../adapter-out/dynamodb/scheduled-work-item-source'
import {
  WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME,
  WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY,
  WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME,
  createWorkItemNotificationScheduleAttributes,
  createWorkItemNotificationScheduleShard,
  isWorkItemKeyRegistryRecord,
} from '../../../work-items'

/** Creates a canonical Project update target row for schedule tests. */
function createPlanningProjectUpdateTarget(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
  const nextNotificationAtRecordKey = Object.hasOwn(row, 'nextNotificationAtRecordKey')
    ? row.nextNotificationAtRecordKey
    : createPlanningUpdateNextNotificationAtRecordKey(
        workspaceId,
        recordKey,
        cadence.nextDueAt,
        cadence.reminderHoursBefore,
      )
  if (typeof nextNotificationAtRecordKey !== 'string') return undefined
  return {
    workspaceId,
    recordKey,
    updateScheduleShard: createPlanningUpdateScheduleShard(workspaceId, recordKey),
    nextNotificationAtRecordKey,
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
  const items = rows.flatMap((row) => {
    const item = createPlanningDueIndexItem(row)
    return item &&
      item.updateScheduleShard === scheduleShard &&
      item.nextNotificationAtRecordKey <= upperBound
      ? [item]
      : []
  })
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

/** Returns the recorded PutCommand item, failing the test when the command has none. */
function readPutItem(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const item = input?.Item
  if (!isPlainRecord(item)) {
    throw new Error('Expected a recorded PutCommand with an Item.')
  }
  return item
}

/** Narrows an unknown value to a plain object record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the notification index attributes the write path stores on a Work Item test row.
 * Rows the write path could not index (malformed rows) land in the first shard as always due, so
 * the schedule still meets them and fails closed.
 */
function readTestWorkItemIndexAttributes(row: Record<string, unknown>) {
  if (typeof row.notificationScheduleShard === 'string') {
    return {
      shard: row.notificationScheduleShard,
      dueKey: typeof row.notificationDueKey === 'string' ? row.notificationDueKey : undefined,
    }
  }
  if (
    typeof row.directoryId !== 'string' ||
    typeof row.teamId !== 'string' ||
    typeof row.issueId !== 'string' ||
    row.directoryId === '' ||
    row.teamId === '' ||
    row.issueId === ''
  ) {
    return { shard: 'work-item-schedule-00', dueKey: WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY }
  }
  const attributes = createWorkItemNotificationScheduleAttributes(
    row.directoryId,
    row.teamId,
    row.issueId,
    {
      archivedAt: row.archivedAt,
      statusCategory: row.statusCategory,
      dueDate: row.dueDate,
    },
  )
  const canonical = row.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    typeof row.title === 'string' &&
    typeof row.assigneeUserId === 'string'
  return {
    shard: attributes.notificationScheduleShard,
    dueKey: attributes.notificationDueKey ??
      (canonical ? undefined : WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY),
  }
}

/**
 * Emulates the Work Items table indexes and strong reads over the rows a test returns for a
 * `ScanCommand`, so each test can describe the table as a list of rows.
 */
async function resolveWorkItemTableRead(
  name: string,
  input: Record<string, unknown>,
  resolve: (name: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
): Promise<{ handled: true, response: unknown } | { handled: false }> {
  const isDueQuery = name === 'QueryCommand' && input.IndexName === WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME
  const isMarkerQuery = name === 'QueryCommand' &&
    input.IndexName === WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME
  const isGet = name === 'GetCommand' && input.TableName === 'WorkItemsTable'
  if (!isDueQuery && !isMarkerQuery && !isGet) return { handled: false }
  const table = await resolve('ScanCommand', { TableName: input.TableName })
  const rows = isPlainRecord(table) && Array.isArray(table.Items)
    ? table.Items.filter(isPlainRecord)
    : []
  if (isGet) {
    const key = isPlainRecord(input.Key) ? input.Key : {}
    return {
      handled: true,
      response: {
        Item: rows.find((row) =>
          row.directoryTeamId === key.directoryTeamId && row.issueId === key.issueId
        ),
      },
    }
  }
  const values = isPlainRecord(input.ExpressionAttributeValues) ? input.ExpressionAttributeValues : {}
  const items = rows.filter((row) => {
    if (isWorkItemKeyRegistryRecord(row)) return false
    const attributes = readTestWorkItemIndexAttributes(row)
    if (attributes.shard !== values[':shard']) return false
    if (isMarkerQuery) return typeof row.customerCompletionPreparationAt === 'string'
    return attributes.dueKey !== undefined &&
      typeof values[':upperBound'] === 'string' &&
      attributes.dueKey <= values[':upperBound']
  })
  return { handled: true, response: { Items: items, ScannedCount: items.length } }
}

function createRecordingDocumentClient(
  resolve: (name: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
  { emulateWorkItemTable = true }: { emulateWorkItemTable?: boolean } = {},
) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const recorded = {
        name: command.constructor.name,
        input: command.input,
      }
      commands.push(recorded)
      if (emulateWorkItemTable) {
        const workItemRead = await resolveWorkItemTableRead(recorded.name, recorded.input, resolve)
        if (workItemRead.handled) return workItemRead.response
      }
      return await resolve(recorded.name, recorded.input)
    },
  } as unknown as NotificationScheduleDocumentClient

  return { client, commands }
}

/** Returns the commands that read the Work Item notification indexes. */
function readWorkItemIndexQueries(commands: Array<{ name: string; input: Record<string, unknown> }>) {
  return commands.filter(({ name, input }) =>
    name === 'QueryCommand' &&
    (input.IndexName === WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME ||
      input.IndexName === WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME)
  )
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
    workItemSource: createDynamoDbScheduledWorkItemSource({
      documentClient,
      workItemsTableName: 'WorkItemsTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }),
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
            createWorkItem({ issueId: 'future', dueDate: '2026-07-20' }),
            createWorkItem({ issueId: 'done', statusCategory: 'completed' }),
          ],
        }
      }

      return {}
    })

    const result = await runNotificationSchedule(createRunOptions(recording.client))
    const puts = recording.commands.filter((command) => command.name === 'PutCommand')
    const dueEvent = readPutItem(puts[0]?.input)
    const overdueEvent = readPutItem(puts[1]?.input)

    // The completed Work Item is not in the due index, so only three rows are read.
    expect(result).toEqual({
      scannedItems: 3,
      emittedEvents: 2,
      duplicateEvents: 0,
      skippedItems: 1,
      scannedPages: 32,
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

  test('retries durable Customer completion preparation before clearing its Work Item marker', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          Items: [createWorkItem({
            statusCategory: 'completed',
            revision: 4,
            customerCompletionPreparationAt: '2026-07-12T08:00:00.000Z',
            customerCompletionPreparationRevision: 4,
          })],
        }
      : {})
    const preparations: unknown[] = []

    const result = await runNotificationSchedule(createRunOptions(recording.client, {
      prepareCustomerCompletionNotifications: async (preparation) => {
        preparations.push(preparation)
      },
    }))

    // Read once from the marker index; the completed Work Item is not in the due index.
    expect(result).toMatchObject({ scannedItems: 1, skippedItems: 0 })
    expect(preparations).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      workItemId: 'release-checklist',
      revision: 4,
      directoryTeamId: 'workspace-1#team#core-team',
      issueId: 'release-checklist',
    }])
    expect(recording.commands.find(({ name }) => name === 'UpdateCommand')?.input).toEqual({
      TableName: 'WorkItemsTable',
      Key: {
        directoryTeamId: 'workspace-1#team#core-team',
        issueId: 'release-checklist',
      },
      UpdateExpression: 'REMOVE #preparationAt, #preparationRevision',
      ConditionExpression: '#preparationRevision = :revision',
      ExpressionAttributeNames: {
        '#preparationAt': 'customerCompletionPreparationAt',
        '#preparationRevision': 'customerCompletionPreparationRevision',
      },
      ExpressionAttributeValues: { ':revision': 4 },
    })
  })

  test('leaves the completion marker for a later schedule retry when preparation fails', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? { Items: [createWorkItem({
          customerCompletionPreparationAt: '2026-07-12T08:00:00.000Z',
          customerCompletionPreparationRevision: 2,
        })] }
      : {})
    const failure = new Error('Customer store unavailable.')

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      prepareCustomerCompletionNotifications: async () => {
        throw failure
      },
    }))).rejects.toBe(failure)
    expect(recording.commands.some(({ name }) => name === 'UpdateCommand')).toBeFalse()
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
      emittedEvents: 1,
      skippedItems: 0,
    })
    expect(beforeBoundary.commands.find(({ name }) => name === 'PutCommand')?.input.Item)
      .toMatchObject({ eventType: 'work-item.due-soon' })
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
      emittedEvents: 2,
      skippedItems: 0,
    })
    expect(recording.commands.filter(({ name }) => name === 'PutCommand').map(({ input }) => {
      const item = readPutItem(input)
      return [item.entityId, item.eventType]
    })).toEqual([
      ['team/core-team/issue/tokyo', 'work-item.due'],
      ['team/core-team/issue/new-york', 'work-item.due-soon'],
    ])
  })

  test('notifies the owner within the due-soon window only', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          Items: [
            createWorkItem({ issueId: 'in-three-days', dueDate: '2026-07-15' }),
            createWorkItem({ issueId: 'in-four-days', dueDate: '2026-07-16' }),
          ],
        }
      : {})

    const result = await runNotificationSchedule(createRunOptions(recording.client))
    const puts = recording.commands.filter(({ name }) => name === 'PutCommand')

    expect(result).toMatchObject({ emittedEvents: 1, skippedItems: 1 })
    expect(puts[0]?.input.Item).toMatchObject({
      eventType: 'work-item.due-soon',
      entityId: 'team/core-team/issue/in-three-days',
      summary: 'Work Item "Release checklist" is due on 2026-07-15.',
      metadata: {
        dueDate: '2026-07-15',
        notificationCandidates: [{ memberKey: 'member@example.com', reason: 'due-soon' }],
      },
    })
  })

  test('keys due-soon reminders by the Work Item calendar so a time zone change can emit a fresh one', async () => {
    const run = async (timeZone: string) => {
      const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
        ? { Items: [createWorkItem({
            dueDate: '2026-07-14',
            schedule: {
              calendarPolicy: {
                holidays: [],
                timeZone,
                workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
              },
              dueDate: '2026-07-14',
              mode: 'due-date',
            },
          })] }
        : {})
      await runNotificationSchedule(createRunOptions(recording.client))
      return recording.commands
        .filter(({ name }) => name === 'PutCommand')
        .map(({ input }) => readPutItem(input))
        .find((event) => event.eventType === 'work-item.due-soon')?.eventId
    }

    const utc = await run('UTC')
    expect(utc).toBeDefined()
    expect(await run('UTC')).toBe(utc)
    // Delivery drops a stage that a calendar change moved out of its window, so the new
    // calendar must not be deduplicated against the dropped event.
    expect(await run('Asia/Tokyo')).not.toBe(utc)
  })

  test('repeats overdue reminders once per interval with a stable key inside the interval', async () => {
    const run = async (now: string) => {
      const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
        ? { Items: [createWorkItem({ assignedProjectId: undefined, directoryProjectId: undefined })] }
        : {})
      await runNotificationSchedule(createRunOptions(recording.client, { now: new Date(now) }))
      const events = recording.commands
        .filter(({ name }) => name === 'PutCommand')
        .map(({ input }) => readPutItem(input))
      return {
        overdue: events.filter((event) => event.eventType === 'work-item.overdue'),
        reminders: events.filter((event) => event.eventType === 'work-item.overdue-reminder'),
      }
    }

    const first = await run('2026-07-13T09:00:00.000Z')
    const sixDays = await run('2026-07-18T09:00:00.000Z')
    const sevenDays = await run('2026-07-19T09:00:00.000Z')
    const [firstReminder] = sevenDays.reminders
    const [sameWeek] = (await run('2026-07-25T09:00:00.000Z')).reminders
    const [secondReminder] = (await run('2026-07-26T09:00:00.000Z')).reminders

    expect(first.overdue).toHaveLength(1)
    expect(first.reminders).toHaveLength(0)
    expect(sixDays.reminders).toHaveLength(0)
    // The initial overdue event is attempted on every run with one key, so retries dedupe it.
    for (const later of [sixDays, sevenDays]) {
      expect(later.overdue.map((event) => event.eventId)).toEqual([first.overdue[0]?.eventId])
    }
    expect(firstReminder).toMatchObject({
      eventType: 'work-item.overdue-reminder',
      action: 'overdue-reminder',
      summary: 'Work Item "Release checklist" was due on 2026-07-12 and is still overdue.',
      metadata: {
        repetition: 1,
        notificationCandidates: [{ memberKey: 'member@example.com', reason: 'overdue' }],
      },
    })
    expect(sameWeek?.eventId).toBe(firstReminder?.eventId)
    expect(secondReminder?.eventId).not.toBe(firstReminder?.eventId)
    expect(secondReminder).toMatchObject({ metadata: { repetition: 2 } })
  })

  test('escalates a long-overdue Work Item once per current manager of its active Project', async () => {
    const directory = [
      { directoryId: 'workspace-1', entryType: 'project', teamId: 'core-team', projectId: 'platform' },
      { directoryId: 'workspace-1', entryType: 'project', teamId: 'core-team', projectId: 'archived', archivedAt: '2026-07-01T00:00:00.000Z' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'Lead@Example.com', role: 'manager' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'member@example.com', role: 'manager' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'second@example.com', role: 'manager' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'viewer@example.com', role: 'viewer' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'archived', memberKey: 'old@example.com', role: 'manager' },
    ]
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        return {
          Items: [
            createWorkItem({ dueDate: '2026-07-05' }),
            createWorkItem({
              issueId: 'archived-project',
              assignedProjectId: 'archived',
              directoryProjectId: 'workspace-1#project#archived',
              dueDate: '2026-07-01',
            }),
            createWorkItem({ issueId: 'six-days', dueDate: '2026-07-06' }),
          ],
        }
      }
      if (name === 'QueryCommand' && input.TableName === 'ProjectDirectoryTable') {
        return { Items: directory }
      }
      return {}
    })

    await runNotificationSchedule(createRunOptions(recording.client, {
      projectManagerReader: createDynamoDbProjectManagerReader({
        documentClient: recording.client,
        tableName: 'ProjectDirectoryTable',
      }),
    }))
    const events = recording.commands
      .filter(({ name }) => name === 'PutCommand')
      .map(({ input }) => readPutItem(input))
    const escalations = events.filter((event) => event.eventType === 'work-item.overdue-escalation')

    // Project managers are read once per Workspace, not once per escalated Work Item.
    expect(recording.commands.filter(({ name, input }) =>
      name === 'QueryCommand' && input.TableName === 'ProjectDirectoryTable'
    )).toHaveLength(1)
    // One event per manager, so each recipient is deduplicated on its own key.
    expect(escalations).toHaveLength(2)
    expect(escalations[0]).toMatchObject({
      entityId: 'team/core-team/issue/release-checklist',
      summary: 'Work Item "Release checklist" was due on 2026-07-05 and has been overdue for at least 7 days.',
      metadata: {
        projectId: 'platform',
        dueDate: '2026-07-05',
        daysUntilDue: -7,
        notificationCandidates: [{ memberKey: 'lead@example.com', reason: 'escalation' }],
      },
    })
    expect(escalations[1]).toMatchObject({
      metadata: { notificationCandidates: [{ memberKey: 'second@example.com', reason: 'escalation' }] },
    })
    expect(escalations[1]?.eventId).not.toBe(escalations[0]?.eventId)
    expect(events.filter((event) => event.eventType === 'work-item.overdue-reminder'))
      .toHaveLength(2)
    expect(events.filter((event) => event.eventType === 'work-item.overdue'))
      .toHaveLength(3)
  })

  test('starts a new escalation after the Work Item reopens while owner stages keep their keys', async () => {
    const directory = [
      { directoryId: 'workspace-1', entryType: 'project', teamId: 'core-team', projectId: 'platform' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'lead@example.com', role: 'manager' },
    ]
    const run = async (workItem: Record<string, unknown>) => {
      const recording = createRecordingDocumentClient((name, input) => {
        if (name === 'ScanCommand') return { Items: [workItem] }
        if (name === 'QueryCommand' && input.TableName === 'ProjectDirectoryTable') return { Items: directory }
        return {}
      })
      await runNotificationSchedule(createRunOptions(recording.client, {
        projectManagerReader: createDynamoDbProjectManagerReader({
          documentClient: recording.client,
          tableName: 'ProjectDirectoryTable',
        }),
      }))
      return new Map(recording.commands
        .filter(({ name }) => name === 'PutCommand')
        .map(({ input }) => readPutItem(input))
        .map((event) => [event.eventType, event]))
    }

    const beforeClose = await run(createWorkItem({ dueDate: '2026-07-05' }))
    const reopened = await run(createWorkItem({ dueDate: '2026-07-05', reopenedAt: '2026-07-10T09:00:00.000Z' }))
    const reopenedAgain = await run(createWorkItem({ dueDate: '2026-07-05', reopenedAt: '2026-07-11T09:00:00.000Z' }))

    const escalationIds = [beforeClose, reopened, reopenedAgain]
      .map((events) => events.get('work-item.overdue-escalation')?.eventId)
    expect(escalationIds.every(Boolean)).toBe(true)
    expect(new Set(escalationIds).size).toBe(3)
    // Delivery compares the captured reopen time with the current row.
    expect(beforeClose.get('work-item.overdue-escalation')?.metadata).not.toHaveProperty('workItemReopenedAt')
    expect(reopened.get('work-item.overdue-escalation')?.metadata)
      .toMatchObject({ workItemReopenedAt: '2026-07-10T09:00:00.000Z' })
    for (const eventType of ['work-item.overdue', 'work-item.overdue-reminder']) {
      expect(reopened.get(eventType)?.eventId).toBe(beforeClose.get(eventType)?.eventId)
      expect(reopened.get(eventType)?.metadata).not.toHaveProperty('workItemReopenedAt')
    }
  })

  test('emits the initial overdue event for a Work Item first scanned long after its due date', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? { Items: [createWorkItem({ assignedProjectId: undefined, directoryProjectId: undefined, dueDate: '2026-06-20' })] }
      : {})

    await runNotificationSchedule(createRunOptions(recording.client))
    const events = recording.commands
      .filter(({ name }) => name === 'PutCommand')
      .map(({ input }) => readPutItem(input))

    expect(events.map((event) => event.eventType)).toEqual([
      'work-item.overdue',
      'work-item.overdue-reminder',
    ])
    expect(events[1]).toMatchObject({ metadata: { repetition: 3 } })
  })

  test('skips archived Work Items for every scheduled stage', async () => {
    const archived = {
      archivedAt: '2026-07-05T09:00:00.000Z',
      archivedBy: 'member@example.com',
      updatedAt: '2026-07-05T09:00:00.000Z',
    }
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          Items: [
            createWorkItem({ issueId: 'archived-due', dueDate: '2026-07-12', ...archived }),
            createWorkItem({ issueId: 'archived-overdue', dueDate: '2026-06-20', ...archived }),
            createWorkItem({ issueId: 'archived-stale', dueDate: '2026-08-31', ...archived }),
          ],
        }
      : {})

    const result = await runNotificationSchedule(createRunOptions(recording.client))

    // Archived Work Items are not in the due index, so the schedule never reads them.
    expect(result).toMatchObject({ emittedEvents: 0, scannedItems: 0, skippedItems: 0 })
    expect(recording.commands.filter(({ name }) => name === 'PutCommand')).toHaveLength(0)
  })

  test('reminds the owner of a started Work Item that has not been updated', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          Items: [
            createWorkItem({ issueId: 'stale', dueDate: '2026-08-31', updatedAt: '2026-07-05T08:00:00.000Z' }),
            createWorkItem({ issueId: 'fresh', dueDate: '2026-08-31', updatedAt: '2026-07-06T10:00:00.000Z' }),
            createWorkItem({
              issueId: 'stale-and-overdue',
              assignedProjectId: undefined,
              directoryProjectId: undefined,
              dueDate: '2026-07-11',
              updatedAt: '2026-07-02T08:00:00.000Z',
            }),
            createWorkItem({
              issueId: 'not-started',
              dueDate: '2026-08-31',
              statusCategory: 'unstarted',
              workflowStatusId: 'todo',
              updatedAt: '2026-07-01T09:00:00.000Z',
            }),
          ],
        }
      : {})

    const result = await runNotificationSchedule(createRunOptions(recording.client))
    const puts = recording.commands.filter(({ name }) => name === 'PutCommand')

    expect(result).toMatchObject({ emittedEvents: 2, skippedItems: 2 })
    expect(puts.map(({ input }) => {
      const item = readPutItem(input)
      return [item.entityId, item.eventType]
    })).toEqual([
      ['team/core-team/issue/stale', 'work-item.stale'],
      ['team/core-team/issue/stale-and-overdue', 'work-item.overdue'],
    ])
    expect(puts[0]?.input.Item).toMatchObject({
      eventType: 'work-item.stale',
      entityId: 'team/core-team/issue/stale',
      summary: 'Work Item "Release checklist" is in progress and has not been updated since 2026-07-05.',
      metadata: {
        workItemUpdatedAt: '2026-07-05T08:00:00.000Z',
        repetition: 1,
        notificationCandidates: [{ memberKey: 'member@example.com', reason: 'stale' }],
      },
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

  test('skips Work Item key registry rows that share the Work Items table', async () => {
    const registryRows = [
      {
        directoryTeamId: 'workspace-1#work-item-key-registry',
        issueId: 'team#core-team',
        entryType: 'work-item-key-counter',
        directoryId: 'workspace-1',
        teamId: 'core-team',
        keyPrefix: 'CT',
        lastNumber: 3,
        registeredAt: '2026-07-01T00:00:00.000Z',
      },
      {
        directoryTeamId: 'workspace-1#work-item-key-registry',
        issueId: 'key#CT-3',
        entryType: 'work-item-key',
        directoryId: 'workspace-1',
        key: 'CT-3',
        teamId: 'core-team',
        workItemId: 'ct-3',
        registeredAt: '2026-07-01T00:00:00.000Z',
      },
    ]
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? { ScannedCount: 3, Items: [...registryRows, createWorkItem()] }
      : {})

    const result = await runNotificationSchedule(createRunOptions(recording.client))

    // Registry rows never carry the index attributes, so only the Work Item is read.
    expect(result).toMatchObject({ scannedItems: 1, emittedEvents: 1 })
  })

  test('still fails closed for a malformed row that claims to be a key registry row', async () => {
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
      ? {
          ScannedCount: 1,
          Items: [{
            directoryTeamId: 'workspace-1#work-item-key-registry',
            issueId: 'key#ct-3',
            entryType: 'work-item-key',
            directoryId: 'workspace-1',
            key: 'ct-3',
            teamId: 'core-team',
            workItemId: 'ct-3',
            registeredAt: '2026-07-01T00:00:00.000Z',
          }],
        }
      : {})

    await expect(runNotificationSchedule(createRunOptions(recording.client))).rejects.toThrow(
      'Notification schedule encountered a non-canonical Work Item row.',
    )
  })

  test('reads every page of each due-index shard up to a year ahead and re-reads due rows strongly', async () => {
    const dueToday = createWorkItem()
    const overdue = createWorkItem({ issueId: 'overdue', dueDate: '2026-07-11' })
    const shard = createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'release-checklist')
    const overdueShard = createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'overdue')
    const pages = new Map<string, number>()
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'GetCommand') {
        const key = isPlainRecord(input.Key) ? input.Key : {}
        return { Item: [dueToday, overdue].find((item) => item.issueId === key.issueId) }
      }
      if (name !== 'QueryCommand' || input.IndexName !== WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME) {
        return {}
      }
      const values = isPlainRecord(input.ExpressionAttributeValues) ? input.ExpressionAttributeValues : {}
      const shardName = String(values[':shard'])
      const page = (pages.get(shardName) ?? 0) + 1
      pages.set(shardName, page)
      const items = [
        ...(shardName === shard ? [dueToday] : []),
        ...(shardName === overdueShard ? [overdue] : []),
      ]
      // Three pages per populated shard: more than the Planning page budget below.
      if (items.length === 0) return { Items: [] }
      return page < 3
        ? { ScannedCount: 0, Items: [], LastEvaluatedKey: { page } }
        : { ScannedCount: items.length, Items: items }
    }, { emulateWorkItemTable: false })

    const result = await runNotificationSchedule(createRunOptions(recording.client, {
      scanPageSize: 1,
      maxScanPages: 1,
    }))
    const dueQueries = recording.commands.filter(({ name, input }) =>
      name === 'QueryCommand' && input.IndexName === WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME
    )

    expect(result).toMatchObject({ scannedItems: 2, emittedEvents: 2 })
    expect(recording.commands.some(({ name }) => name === 'ScanCommand')).toBeFalse()
    expect(dueQueries[0]?.input).toEqual({
      TableName: 'WorkItemsTable',
      IndexName: 'WorkItemNotificationDueIndex',
      KeyConditionExpression: '#shard = :shard AND #sortKey <= :upperBound',
      ExpressionAttributeNames: { '#shard': 'notificationScheduleShard', '#sortKey': 'notificationDueKey' },
      // 365 due-soon days plus one day of time zone slack after 2026-07-12.
      ExpressionAttributeValues: { ':shard': 'work-item-schedule-00', ':upperBound': '2027-07-13' },
      Limit: 1,
      ScanIndexForward: true,
    })
    expect(dueQueries.filter(({ input }) => input.ExclusiveStartKey !== undefined).length)
      .toBe(shard === overdueShard ? 2 : 4)
    expect(recording.commands.filter(({ name }) => name === 'GetCommand').map(({ input }) => input))
      .toEqual(expect.arrayContaining([{
        TableName: 'WorkItemsTable',
        Key: { directoryTeamId: 'workspace-1#team#core-team', issueId: 'release-checklist' },
        ConsistentRead: true,
      }]))
  })

  test('drops a stage the index copy shows when the strong read no longer qualifies', async () => {
    const indexed = createWorkItem()
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'GetCommand') {
        return { Item: { ...indexed, statusCategory: 'completed', workflowStatusId: 'done' } }
      }
      if (name === 'QueryCommand' && input.IndexName === WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME) {
        const values = isPlainRecord(input.ExpressionAttributeValues) ? input.ExpressionAttributeValues : {}
        return values[':shard'] === createWorkItemNotificationScheduleShard(
          'workspace-1',
          'core-team',
          'release-checklist',
        )
          ? { Items: [indexed], ScannedCount: 1 }
          : { Items: [] }
      }
      return {}
    }, { emulateWorkItemTable: false })

    await expect(runNotificationSchedule(createRunOptions(recording.client)))
      .resolves.toMatchObject({ emittedEvents: 0, skippedItems: 1 })
    expect(recording.commands.some(({ name }) => name === 'PutCommand')).toBeFalse()
  })

  test('uses the same event ID across schedule retries and treats the condition as dedupe', async () => {
    let assigneeUserId = 'Member@Example.com'
    let putCount = 0
    const eventIds: string[] = []
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') {
        return {
          Items: [createWorkItem({ assigneeUserId, dueDate: '2026-07-12' })],
        }
      }
      if (name !== 'PutCommand') return {}

      putCount += 1
      eventIds.push(String(readPutItem(input).eventId))
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
    assigneeUserId = 'new-owner@example.com'
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

  test('keeps the page budget for Planning queries only', async () => {
    const recording = createRecordingDocumentClient(() => ({ Items: [] }))

    await expect(
      runNotificationSchedule(createRunOptions(recording.client, {
        maxScanPages: 16,
        planningTableName: 'PlanningTable',
      })),
    ).resolves.toMatchObject({ scannedPages: 48 })
    expect(recording.commands.filter((command) => command.name === 'ScanCommand')).toHaveLength(0)
    expect(readWorkItemIndexQueries(recording.commands)).toHaveLength(32)
    expect(recording.commands.filter((command) => command.name === 'QueryCommand')).toHaveLength(48)
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

  test('logs and fails the invocation for one malformed due-index row', async () => {
    const validTarget = createPlanningProjectUpdateTarget()
    const validIndexItem = createPlanningDueIndexItem(validTarget)
    if (!validIndexItem) throw new Error('Expected a valid Planning due-index item.')
    const malformedIndexItem = {
      workspaceId: 'workspace-1',
      recordKey: '',
      updateScheduleShard: validIndexItem.updateScheduleShard,
      nextNotificationAtRecordKey: validIndexItem.nextNotificationAtRecordKey,
    }
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') return { Items: [] }
      if (name === 'QueryCommand' && input.IndexName === 'UpdateScheduleDueIndex') {
        const values = input.ExpressionAttributeValues
        const queriedShard = typeof values === 'object' && values !== null &&
            ':scheduleShard' in values
          ? values[':scheduleShard']
          : undefined
        return queriedShard === validIndexItem.updateScheduleShard
          ? { Items: [malformedIndexItem, validIndexItem], ScannedCount: 2 }
          : { Items: [], ScannedCount: 0 }
      }
      if (name === 'QueryCommand') {
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
        const target = resolvePlanningTargetGet(input, [validTarget])
        if (target) return target
      }
      return {}
    })
    const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runNotificationSchedule(createRunOptions(recording.client, {
        now: new Date('2026-07-12T10:00:00.000Z'),
        planningTableName: 'PlanningTable',
        projectDirectoryTableName: 'ProjectDirectoryTable',
      }))).rejects.toThrow('Planning update schedule row is invalid.')
      expect(errorLog).toHaveBeenCalledTimes(1)
      expect(errorLog).toHaveBeenCalledWith(
        'Planning update schedule row is invalid.',
        {
          requestId: 'schedule-event-1',
          scheduleShard: validIndexItem.updateScheduleShard,
        },
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  test('rejects malformed Initiative scope fields before emitting notifications', async () => {
    const initiativeRow = createPlanningInitiativeUpdateTarget()
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') return { Items: [] }
      if (name === 'QueryCommand') {
        return resolvePlanningDueIndexQuery(input, [initiativeRow]) ?? { Items: [] }
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
            teamId: 123,
          },
        }
      }
      return {}
    })
    const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runNotificationSchedule(createRunOptions(recording.client, {
        now: new Date('2026-07-11T10:00:00.000Z'),
        planningTableName: 'PlanningTable',
      }))).rejects.toThrow('Planning update schedule row is invalid.')
    } finally {
      errorLog.mockRestore()
    }
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
      scannedPages: 48,
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

  test('advances the sparse Planning due index after each notification stage', async () => {
    const targetRow = createPlanningProjectUpdateTarget({
      nextNotificationAtRecordKey: createPlanningUpdateNextNotificationAtRecordKey(
        'workspace-1',
        'UPDATE_TARGET#PROJECT#core-team#platform',
        '2026-07-12T09:00:00.000Z',
        24,
      ),
    })
    const eventIds = new Set<string>()
    const recording = createRecordingDocumentClient((name, input) => {
      if (name === 'ScanCommand') return { Items: [] }
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
        const item = input.Item
        if (typeof item === 'object' && item !== null && 'eventId' in item) {
          const eventId = String(item.eventId)
          if (eventIds.has(eventId)) {
            const duplicate = new Error('The conditional request failed')
            duplicate.name = 'ConditionalCheckFailedException'
            throw duplicate
          }
          eventIds.add(eventId)
        }
      }
      if (name === 'UpdateCommand') {
        const values = input.ExpressionAttributeValues
        if (
          typeof values === 'object' && values !== null &&
          ':nextNotificationAtRecordKey' in values &&
          typeof values[':nextNotificationAtRecordKey'] === 'string'
        ) {
          targetRow.nextNotificationAtRecordKey = values[':nextNotificationAtRecordKey']
        } else {
          targetRow.nextNotificationAtRecordKey = undefined
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
      emittedEvents: 1,
      duplicateEvents: 0,
    })
    expect(targetRow.nextNotificationAtRecordKey).toBe(
      createPlanningUpdateNotificationAtRecordKey(
        'workspace-1',
        'UPDATE_TARGET#PROJECT#core-team#platform',
        '2026-07-12T21:00:00.000Z',
      ),
    )

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T10:30:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({
      emittedEvents: 0,
      duplicateEvents: 0,
    })
    expect(targetRow.nextNotificationAtRecordKey).toContain('2026-07-12T21:00:00.000Z')

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T22:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({
      emittedEvents: 1,
      duplicateEvents: 1,
    })
    expect(targetRow.nextNotificationAtRecordKey).toBeUndefined()

    await expect(runNotificationSchedule(createRunOptions(recording.client, {
      now: new Date('2026-07-12T23:00:00.000Z'),
      planningTableName: 'PlanningTable',
      projectDirectoryTableName: 'ProjectDirectoryTable',
    }))).resolves.toMatchObject({
      emittedEvents: 0,
      duplicateEvents: 0,
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

test('notification schedule handler treats blank numeric environment values as unset', async () => {
  const names = [
    'WORK_ITEMS_TABLE_NAME',
    'PLANNING_TABLE_NAME',
    'PLANNING_UPDATE_SCHEDULE_INDEX_NAME',
    'PROJECT_DIRECTORY_TABLE_NAME',
    'AUDIT_EVENTS_TABLE_NAME',
    'NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE',
    'NOTIFICATION_SCHEDULE_MAX_PAGES',
    'AUDIT_RETENTION_DAYS',
  ]
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    WORK_ITEMS_TABLE_NAME: 'WorkItemsTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
    PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
    PROJECT_DIRECTORY_TABLE_NAME: 'ProjectDirectoryTable',
    AUDIT_EVENTS_TABLE_NAME: 'AuditEventsTable',
    NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '',
    NOTIFICATION_SCHEDULE_MAX_PAGES: '  ',
    AUDIT_RETENTION_DAYS: ' ',
  })
  const { client } = createRecordingDocumentClient(() => ({ Items: [], Count: 0, ScannedCount: 0 }))

  try {
    await expect(
      createNotificationScheduleHandler(
        client,
        createDynamoDbScheduledWorkItemSource({ documentClient: client, workItemsTableName: 'WorkItemsTable' }),
      )({ id: 'schedule-event-1', time: '2026-07-12T09:00:00.000Z' }),
    ).resolves.toMatchObject({ emittedEvents: 0 })
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

describe('configurable reminder days and timesheet reminders', () => {
  /** Reminder reader that returns fixed Team and per-member overrides. */
  function createReminderReader(
    team: Record<string, number> | undefined,
    personal: Record<string, Record<string, number>> = {},
  ) {
    return {
      readTeamReminderDays: async () => team,
      readPersonalReminderDays: async (_workspaceId: string, memberKey: string) => personal[memberKey],
    }
  }

  /** Returns the audit events the run stored. */
  function readEvents(commands: Array<{ name: string; input: Record<string, unknown> }>) {
    return commands
      .filter(({ name }) => name === 'PutCommand')
      .map(({ input }) => readPutItem(input))
  }

  test('uses the owner\'s own due-soon window before the Team window', async () => {
    const items = [
      createWorkItem({ issueId: 'owner-five-days', dueDate: '2026-07-17' }),
      createWorkItem({ issueId: 'other-five-days', dueDate: '2026-07-17', assigneeUserId: 'Other@Example.com' }),
      createWorkItem({ issueId: 'other-two-days', dueDate: '2026-07-14', assigneeUserId: 'Other@Example.com' }),
      createWorkItem({ issueId: 'other-three-days', dueDate: '2026-07-15', assigneeUserId: 'Other@Example.com' }),
    ]
    const recording = createRecordingDocumentClient((name) => name === 'ScanCommand' ? { Items: items } : {})

    await runNotificationSchedule(createRunOptions(recording.client, {
      reminderSettingsReader: createReminderReader(
        { dueSoonDays: 2 },
        { 'member@example.com': { dueSoonDays: 5 } },
      ),
    }))

    // Shards are read one after another, so compare without the cross-shard order.
    expect(readEvents(recording.commands).map((event) => [event.entityId, event.eventType]).sort())
      .toEqual([
        ['team/core-team/issue/other-two-days', 'work-item.due-soon'],
        ['team/core-team/issue/owner-five-days', 'work-item.due-soon'],
      ])
  })

  test('takes escalation days from the Team and keys a non-default overdue interval separately', async () => {
    const directory = [
      { directoryId: 'workspace-1', entryType: 'project', teamId: 'core-team', projectId: 'platform' },
      { directoryId: 'workspace-1', entryType: 'project-member', projectId: 'platform', memberKey: 'lead@example.com', role: 'manager' },
    ]
    const run = async (reader?: ReturnType<typeof createReminderReader>) => {
      const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
        ? { Items: [createWorkItem({ dueDate: '2026-07-08' })] }
        : name === 'QueryCommand' ? { Items: directory } : {})
      await runNotificationSchedule(createRunOptions(recording.client, {
        projectManagerReader: createDynamoDbProjectManagerReader({
          documentClient: recording.client,
          tableName: 'ProjectDirectoryTable',
        }),
        ...(reader ? { reminderSettingsReader: reader } : {}),
      }))
      return readEvents(recording.commands)
    }

    // Four days overdue: the default 7-day escalation and reminder interval are not reached.
    const defaults = await run()
    expect(defaults.map((event) => event.eventType)).toEqual(['work-item.overdue'])
    const configured = await run(createReminderReader(
      { overdueEscalationDays: 3, overdueReminderIntervalDays: 2 },
      // A member cannot change when their own work escalates.
      { 'member@example.com': { overdueReminderIntervalDays: 4 } },
    ))
    expect(configured.map((event) => event.eventType)).toEqual([
      'work-item.overdue',
      'work-item.overdue-reminder',
      'work-item.overdue-escalation',
    ])
    expect(configured[1]).toMatchObject({ metadata: { repetition: 1 } })

    // The default interval keeps the key it had before intervals were configurable.
    const later = async (reader?: ReturnType<typeof createReminderReader>) => {
      const recording = createRecordingDocumentClient((name) => name === 'ScanCommand'
        ? { Items: [createWorkItem({ dueDate: '2026-07-05', assignedProjectId: undefined, directoryProjectId: undefined })] }
        : {})
      await runNotificationSchedule(createRunOptions(recording.client, reader ? { reminderSettingsReader: reader } : {}))
      return readEvents(recording.commands).find((event) => event.eventType === 'work-item.overdue-reminder')
    }
    const unconfigured = await later()
    const explicitDefault = await later(createReminderReader({ overdueReminderIntervalDays: 7 }))
    const custom = await later(createReminderReader({ overdueReminderIntervalDays: 3 }))
    expect(explicitDefault?.eventId).toBe(unconfigured?.eventId)
    expect(custom?.eventId).toBeDefined()
    expect(custom?.eventId).not.toBe(unconfigured?.eventId)
  })

  test('reminds each member with unsubmitted time once per reminder period at the configured hour', async () => {
    const reads: Array<[string, string, string, string]> = []
    const entries = [
      { entryId: 'old-1', memberKey: 'member@example.com', projectId: 'platform', startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-01T02:00:00.000Z' },
      { entryId: 'old-2', memberKey: 'member@example.com', projectId: 'platform', startAt: '2026-07-02T00:00:00.000Z', endAt: '2026-07-02T02:00:00.000Z' },
      { entryId: 'recent', memberKey: 'other@example.com', projectId: 'platform', startAt: '2026-07-11T00:00:00.000Z', endAt: '2026-07-11T02:00:00.000Z' },
    ]
    const timesheetReader = {
      async listUnsubmittedEntries(workspaceId: string, teamId: string, from: Date, to: Date) {
        reads.push([workspaceId, teamId, from.toISOString(), to.toISOString()])
        return entries
      },
    }
    const run = async (now: string, timesheetReminderHourUtc = 0) => {
      const recording = createRecordingDocumentClient((name, input) => {
        if (name !== 'ScanCommand') return {}
        // Teams come from the Project directory, not from Work Items, so a Team whose Work
        // Items are all completed is still reminded.
        return input.TableName === 'ProjectDirectoryTable'
          ? {
              Items: [
                { directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' },
                { directoryId: 'workspace-1', entryType: 'project', teamId: 'core-team', projectId: 'platform' },
              ],
            }
          : { Items: [createWorkItem({ statusCategory: 'completed', workflowStatusId: 'done' })] }
      })
      await runNotificationSchedule(createRunOptions(recording.client, {
        now: new Date(now),
        projectDirectoryTableName: 'ProjectDirectoryTable',
        timesheetReader,
        timesheetReminderHourUtc,
      }))
      return readEvents(recording.commands).filter((event) => event.eventType === 'timesheet.submission-reminder')
    }

    expect(await run('2026-07-12T09:00:00.000Z')).toEqual([])
    expect(reads).toEqual([])
    const [reminder, ...rest] = await run('2026-07-12T00:00:00.000Z')
    expect(rest).toEqual([])
    expect(reads).toEqual([['workspace-1', 'core-team', '2026-04-11T00:00:00.000Z', '2026-07-12T00:00:00.000Z']])
    expect(reminder).toMatchObject({
      entityId: 'team/core-team/timesheet',
      summary: '2 time entries since 2026-07-01 have not been submitted.',
      metadata: {
        teamId: 'core-team',
        projectId: 'platform',
        deepLink: '/teams/core-team/timesheet?week=2026-07-01T00%3A00%3A00.000Z',
        timeEntryIds: ['old-1', 'old-2'],
        timesheetDueBefore: '2026-07-05T00:00:00.000Z',
        notificationCandidates: [{ memberKey: 'member@example.com', reason: 'timesheet' }],
      },
    })
    const sameDay = await run('2026-07-12T09:00:00.000Z', 9)
    const nextDay = await run('2026-07-13T00:00:00.000Z')
    expect(sameDay[0]?.eventId).toBe(reminder?.eventId)
    expect(nextDay[0]?.eventId).toBe(reminder?.eventId)
    const nextPeriod = await run('2026-07-23T00:00:00.000Z')
    expect(nextPeriod[0]?.eventId).not.toBe(reminder?.eventId)
  })
})

describe('weekly report reminders', () => {
  test('reminds unsubmitted authors on Friday and tells their managers on Monday, once per week', async () => {
    const submittedReads: Array<[string, string, string[], string]> = []
    let reminders = DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS
    const weeklyReportReader = {
      async readWorkspaceSettings() {
        return { weekStartDay: 1 as const, reminders }
      },
      async readTeamRosters(workspaceId: string) {
        return [{
          workspaceId,
          teamId: 'core-team',
          projects: [{
            projectId: 'platform',
            writers: [
              { memberKey: 'manager@example.com', displayName: 'Manager' },
              { memberKey: 'member@example.com', displayName: 'Member' },
              { memberKey: 'done@example.com' },
            ],
            managerMemberKeys: ['manager@example.com'],
          }],
        }]
      },
      async readSubmittedMembers(workspaceId: string, teamId: string, memberKeys: readonly string[], weekStart: string) {
        submittedReads.push([workspaceId, teamId, [...memberKeys], weekStart])
        return new Set(['done@example.com', 'manager@example.com'])
      },
    }
    const run = async (now: string) => {
      const recording = createRecordingDocumentClient((name, input) => {
        if (name !== 'ScanCommand') return {}
        return input.TableName === 'ProjectDirectoryTable'
          ? { Items: [{ directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' }] }
          : { Items: [] }
      })
      await runNotificationSchedule(createRunOptions(recording.client, {
        now: new Date(now),
        weeklyReportReader,
      }))
      return recording.commands
        .filter(({ name }) => name === 'PutCommand')
        .map(({ input }) => readPutItem(input))
        .filter((event) => String(event.eventType).startsWith('weekly-report.'))
    }

    // Thursday, and Friday outside 17:00 in Japan, send nothing and read nothing.
    expect(await run('2026-11-19T08:00:00.000Z')).toEqual([])
    expect(await run('2026-11-20T09:00:00.000Z')).toEqual([])
    expect(submittedReads).toEqual([])

    const [reminder, ...otherReminders] = await run('2026-11-20T08:00:00.000Z')
    expect(otherReminders).toEqual([])
    expect(submittedReads).toEqual([[
      'workspace-1', 'core-team', ['manager@example.com', 'member@example.com', 'done@example.com'], '2026-11-16',
    ]])
    expect(reminder).toMatchObject({
      eventType: 'weekly-report.submission-reminder',
      entityType: 'weekly-report',
      entityId: 'team/core-team/weekly-report/2026-11-16',
      summary: 'Your weekly report for the week of 2026-11-16 has not been submitted.',
      metadata: {
        teamId: 'core-team',
        projectId: 'platform',
        deepLink: '/teams/core-team/timesheet?view=weekly-report&week=2026-11-16',
        weeklyReportWeekStart: '2026-11-16',
        weeklyReportAuthorMemberKey: 'member@example.com',
        notificationCandidates: [{ memberKey: 'member@example.com', reason: 'weekly-report' }],
      },
    })
    // A retry of the same hour is the same event.
    expect((await run('2026-11-20T08:30:00.000Z'))[0]?.eventId).toBe(reminder?.eventId)

    const [escalation, ...otherEscalations] = await run('2026-11-23T01:00:00.000Z')
    expect(otherEscalations).toEqual([])
    expect(escalation).toMatchObject({
      eventType: 'weekly-report.submission-escalation',
      entityId: 'team/core-team/weekly-report/2026-11-16',
      summary: 'Member has not submitted the weekly report for the week of 2026-11-16.',
      metadata: {
        projectId: 'platform',
        deepLink: '/teams/core-team/timesheet?view=team-weekly-reports&week=2026-11-16',
        weeklyReportAuthorMemberKey: 'member@example.com',
        notificationCandidates: [{ memberKey: 'manager@example.com', reason: 'weekly-report-escalation' }],
      },
    })
    expect(escalation?.eventId).not.toBe(reminder?.eventId)

    // The Workspace owner moves the reminder to Thursday 9:00 and turns the escalation off.
    reminders = {
      ...DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
      reminder: { weekday: 4, hour: 9 },
      escalationEnabled: false,
    }
    expect(await run('2026-11-20T08:00:00.000Z')).toEqual([])
    expect(await run('2026-11-23T01:00:00.000Z')).toEqual([])
    expect((await run('2026-11-19T00:00:00.000Z')).map((event) => event.eventType)).toEqual(['weekly-report.submission-reminder'])
    reminders = { ...reminders, enabled: false }
    expect(await run('2026-11-19T00:00:00.000Z')).toEqual([])
  })
})
