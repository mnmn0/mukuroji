import { describe, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { Context } from 'hono'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DynamoDbNotificationsClient,
  NotificationError,
} from './notifications'
import { DynamoDbReminderSettingsStore } from './adapter-out/dynamodb/reminder-settings-store'
import { createTeamReminderSettingsRouter } from './adapter-in/http/team-reminder-settings-router'
import {
  DEFAULT_WORK_ITEM_REMINDER_POLICY,
  createReminderPolicyResolver,
  resolveWorkItemReminderPolicy,
} from './application/work-item-reminders'
import {
  evaluateTimesheetReminders,
  utcWeekStartDate,
} from './application/timesheet-reminders'
import type { TeamReminderSettingsRecord } from './application/ports/reminder-settings-reader'

/** Command recorded by the fake DocumentClient. */
type RecordedCommand = { name: string; input: Record<string, unknown> }

/**
 * Creates a fake DocumentClient that records each command and answers it with `resolve`.
 *
 * @param resolve - Response factory for one command.
 * @returns The client and the recorded commands.
 */
function createRecordingClient(resolve: (command: RecordedCommand) => unknown) {
  const commands: RecordedCommand[] = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const recorded = { name: command.constructor.name, input: command.input }
      commands.push(recorded)
      return await resolve(recorded)
    },
  }
  return { documentClient, commands }
}

/**
 * Creates a NotificationsTable fake that stores Put items by key.
 *
 * @returns A notifications client bound to the fake and the stored rows.
 */
function createPreferenceStore() {
  const rows = new Map<string, Record<string, unknown>>()
  const keyOf = (key: unknown) => JSON.stringify(key)
  const recording = createRecordingClient(({ name, input }) => {
    if (name === 'GetCommand') return { Item: rows.get(keyOf(input.Key)) }
    if (name === 'PutCommand') {
      const item = input.Item
      if (typeof item !== 'object' || item === null) throw new Error('Missing item.')
      const record = { ...item }
      rows.set(keyOf({ recipientKey: Reflect.get(record, 'recipientKey'), notificationKey: Reflect.get(record, 'notificationKey') }), record)
    }
    return {}
  })
  const client = new DynamoDbNotificationsClient(
    'NotificationsTable',
    recording.documentClient as unknown as DynamoDBDocumentClient,
    {} as DynamoDBClient,
    false,
    'RecipientStatusIndex',
  )
  return { client, rows, documentClient: recording.documentClient }
}

const recipient = { workspaceId: 'workspace-1', memberKey: 'Member@Example.com' }

describe('personal reminder days', () => {
  test('saves overrides, keeps them for a client that omits the field, and clears them with an empty object', async () => {
    const store = createPreferenceStore()
    const saved = await store.client.savePreferences({
      ...recipient,
      now: new Date('2026-07-12T00:00:00.000Z'),
      preferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        reminderDays: { dueSoonDays: 5, timesheetReminderDays: 3 },
      },
    })
    expect(saved.reminderDays).toEqual({ dueSoonDays: 5, timesheetReminderDays: 3 })

    const { reminderDays: _omitted, ...withoutReminderDays } = saved
    const kept = await store.client.savePreferences({
      ...recipient,
      preferences: { ...withoutReminderDays, frequency: 'daily' },
    })
    expect(kept).toMatchObject({ version: 2, frequency: 'daily', reminderDays: { dueSoonDays: 5, timesheetReminderDays: 3 } })

    const cleared = await store.client.savePreferences({
      ...recipient,
      preferences: { ...kept, reminderDays: {} },
    })
    expect(cleared.reminderDays).toBeUndefined()
    expect(await store.client.getPreferences(recipient)).toEqual(cleared)

    const reader = new DynamoDbReminderSettingsStore(store.documentClient, 'NotificationsTable')
    await store.client.savePreferences({
      ...recipient,
      preferences: { ...cleared, reminderDays: { staleStartedDays: 14 } },
    })
    expect(await reader.readPersonalReminderDays('workspace-1', 'member@example.com')).toEqual({ staleStartedDays: 14 })
  })

  test('rejects escalation, unknown fields, and out-of-range day counts', async () => {
    const store = createPreferenceStore()
    for (const reminderDays of [
      { overdueEscalationDays: 3 },
      { unknownDays: 3 },
      { dueSoonDays: 0 },
      { dueSoonDays: 366 },
      { dueSoonDays: 1.5 },
    ]) {
      await expect(store.client.savePreferences({
        ...recipient,
        preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, reminderDays },
      })).rejects.toBeInstanceOf(NotificationError)
    }
  })
})

describe('Team reminder settings store', () => {
  test('creates, updates with the revision condition, and reports a lost race as a conflict', async () => {
    let stored: Record<string, unknown> | undefined
    const recording = createRecordingClient(({ name, input }) => {
      if (name === 'GetCommand') return { Item: stored }
      if (name === 'TransactWriteCommand') {
        const items = input.TransactItems
        if (!Array.isArray(items)) throw new Error('Missing transaction.')
        const put: unknown = Reflect.get(items[0] ?? {}, 'Put')
        const condition = Reflect.get(put ?? {}, 'ConditionExpression')
        const expected = Reflect.get(Reflect.get(put ?? {}, 'ExpressionAttributeValues') ?? {}, ':revision')
        if (
          condition === 'attribute_not_exists(recipientKey)' ? stored !== undefined : stored?.revision !== expected
        ) {
          throw Object.assign(new Error('Cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          })
        }
        stored = { ...Reflect.get(put ?? {}, 'Item') }
      }
      return {}
    })
    const store = new DynamoDbReminderSettingsStore(recording.documentClient, 'NotificationsTable')

    expect(await store.getTeamSettings('workspace-1', 'core-team')).toEqual({ days: {}, revision: 0 })
    expect(await store.readTeamReminderDays('workspace-1', 'core-team')).toBeUndefined()
    await store.saveTeamSettings({
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      days: { dueSoonDays: 2, overdueEscalationDays: 14 },
      expectedRevision: 0,
      now: new Date('2026-07-12T00:00:00.000Z'),
    })
    expect(stored).toMatchObject({
      recipientKey: 'workspace-1#!team-reminder-settings',
      notificationKey: 'TEAM#core-team',
      itemType: 'team-reminder-settings',
      revision: 1,
    })
    expect(await store.readTeamReminderDays('workspace-1', 'core-team')).toEqual({ dueSoonDays: 2, overdueEscalationDays: 14 })
    await expect(store.saveTeamSettings({
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      days: {},
      expectedRevision: 0,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).rejects.toMatchObject({ status: 409, code: 'NotificationReminderSettingsConflict' })
    await store.saveTeamSettings({
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      days: {},
      expectedRevision: 1,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })
    expect(await store.getTeamSettings('workspace-1', 'core-team')).toEqual({
      days: {},
      revision: 2,
      updatedAt: '2026-07-13T00:00:00.000Z',
    })
  })

  test('fails instead of falling back to defaults for a corrupt row', async () => {
    const recording = createRecordingClient(() => ({
      Item: { itemType: 'team-reminder-settings', revision: 1, days: { dueSoonDays: 'soon' } },
    }))
    const store = new DynamoDbReminderSettingsStore(recording.documentClient, 'NotificationsTable')
    await expect(store.readTeamReminderDays('workspace-1', 'core-team')).rejects.toThrow('invalid')
  })
})

describe('reminder policy resolution', () => {
  test('prefers personal over Team over default, and never takes escalation from a member', () => {
    expect(resolveWorkItemReminderPolicy(
      DEFAULT_WORK_ITEM_REMINDER_POLICY,
      { dueSoonDays: 2, overdueEscalationDays: 14, staleStartedDays: 10 },
      { dueSoonDays: 5, timesheetReminderDays: 1 },
    )).toEqual({
      dueSoonDays: 5,
      overdueReminderIntervalDays: 7,
      overdueEscalationDays: 14,
      staleStartedDays: 10,
      timesheetReminderDays: 1,
    })
  })

  test('reads each Team and member once per run', async () => {
    const reads: string[] = []
    const resolve = createReminderPolicyResolver(DEFAULT_WORK_ITEM_REMINDER_POLICY, {
      async readTeamReminderDays(workspaceId, teamId) {
        reads.push(`team:${workspaceId}:${teamId}`)
        return { dueSoonDays: 2 }
      },
      async readPersonalReminderDays(workspaceId, memberKey) {
        reads.push(`member:${workspaceId}:${memberKey}`)
        return memberKey === 'a@example.com' ? { dueSoonDays: 4 } : undefined
      },
    })
    expect((await resolve('workspace-1', 'core', 'a@example.com')).dueSoonDays).toBe(4)
    expect((await resolve('workspace-1', 'core', 'b@example.com')).dueSoonDays).toBe(2)
    expect((await resolve('workspace-1', 'core', 'a@example.com')).dueSoonDays).toBe(4)
    expect(reads).toEqual([
      'team:workspace-1:core',
      'member:workspace-1:a@example.com',
      'member:workspace-1:b@example.com',
    ])
  })
})

describe('timesheet reminder evaluation', () => {
  const now = new Date('2026-07-20T00:00:00.000Z')

  test('groups entries past each member threshold into one reminder per member', async () => {
    const reminders = await evaluateTimesheetReminders(
      'workspace-1',
      'core',
      [
        { entryId: 'b-old', memberKey: 'b@example.com', startAt: '2026-07-10T09:00:00.000Z', endAt: '2026-07-10T10:00:00.000Z' },
        { entryId: 'a-new', memberKey: 'a@example.com', startAt: '2026-07-18T09:00:00.000Z', endAt: '2026-07-18T10:00:00.000Z' },
        { entryId: 'a-old', memberKey: 'a@example.com', startAt: '2026-07-06T09:00:00.000Z', endAt: '2026-07-06T10:00:00.000Z' },
        { entryId: 'a-mid', memberKey: 'a@example.com', startAt: '2026-07-12T09:00:00.000Z', endAt: '2026-07-12T10:00:00.000Z' },
      ],
      now,
      async (memberKey) => memberKey === 'b@example.com' ? 14 : 7,
    )
    expect(reminders).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core',
      memberKey: 'a@example.com',
      entryIds: ['a-old', 'a-mid'],
      unsubmittedCount: 2,
      oldestStartAt: '2026-07-06T09:00:00.000Z',
      reminderDays: 7,
      cycle: Math.floor(now.getTime() / (7 * 86_400_000)),
    }])
    expect(utcWeekStartDate('2026-07-06T09:00:00.000Z')).toBe('2026-07-06')
    expect(utcWeekStartDate('2026-07-12T23:00:00.000Z')).toBe('2026-07-06')
  })
})

describe('Team reminder settings routes', () => {
  /** Creates the router with an in-memory store and recorded authorization calls. */
  function createRouter(options: { manager: boolean }) {
    let record: TeamReminderSettingsRecord = { days: {}, revision: 0 }
    const accessChecks: string[] = []
    const audits: unknown[] = []
    const router = createTeamReminderSettingsRouter({
      authenticate: async () => ({ directoryId: 'workspace-1' }),
      async requireTeamAccess(_principal, teamId, access) {
        accessChecks.push(`${teamId}:${access}`)
        if (access === 'manage' && !options.manager) {
          throw new NotificationError(403, 'TeamRoleDenied', 'Team manager access is required.')
        }
      },
      canManageTeam: async () => options.manager,
      getStore: () => ({
        getTeamSettings: async () => record,
        async saveTeamSettings(input) {
          if (input.expectedRevision !== record.revision) {
            throw new NotificationError(409, 'NotificationReminderSettingsConflict', 'Conflict.')
          }
          record = { days: input.days, revision: input.expectedRevision + 1, updatedAt: input.now.toISOString() }
          return record
        },
      }),
      getDefaults: () => DEFAULT_WORK_ITEM_REMINDER_POLICY,
      createAuditPut(_context, _principal, input) {
        audits.push(input)
        return undefined
      },
      mapError(context: Context, error: unknown) {
        return error instanceof NotificationError
          ? context.json({ code: error.code }, error.status === 403 ? 403 : error.status === 409 ? 409 : 400)
          : context.json({ code: 'Unexpected' }, 500)
      },
      readJson: async (request) => await request.json().catch(() => undefined),
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })
    return { router, accessChecks, audits }
  }

  const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }

  test('lets a Team member read the settings with the defaults and the manage flag', async () => {
    const { router, accessChecks } = createRouter({ manager: false })
    const response = await router.request('/api/teams/core/notification-reminders', { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      teamId: 'core',
      days: {},
      defaults: DEFAULT_WORK_ITEM_REMINDER_POLICY,
      revision: 0,
      canManage: false,
    })
    expect(accessChecks).toEqual(['core:read'])
    expect((await router.request('/api/teams/core/notification-reminders')).status).toBe(401)
  })

  test('requires a Team manager before reading the body and rejects invalid values', async () => {
    const member = createRouter({ manager: false })
    const denied = await member.router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers,
      body: 'not json',
    })
    expect(denied.status).toBe(403)
    expect(member.accessChecks).toEqual(['core:manage'])

    const manager = createRouter({ manager: true })
    for (const body of [
      { expectedRevision: 0, days: { dueSoonDays: 0 } },
      { expectedRevision: 0, days: { unknownDays: 1 } },
      { expectedRevision: -1, days: {} },
      { days: {} },
    ]) {
      const response = await manager.router.request('/api/teams/core/notification-reminders', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(manager.audits).toEqual([])
  })

  test('saves with the expected revision, audits the change, and rejects a stale revision', async () => {
    const { router, audits } = createRouter({ manager: true })
    const saved = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRevision: 0, days: { dueSoonDays: 2, overdueEscalationDays: null } }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ days: { dueSoonDays: 2 }, revision: 1, canManage: true })
    expect(audits).toMatchObject([{ teamId: 'core', before: {}, after: { dueSoonDays: 2 }, beforeRevision: 0 }])

    const stale = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRevision: 0, days: {} }),
    })
    expect(stale.status).toBe(409)
  })
})
