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
} from './application/timesheet-reminders'
import type {
  SaveTeamReminderSettingsInput,
  TeamReminderSettingsReceipt,
  TeamReminderSettingsRecord,
} from './application/ports/reminder-settings-reader'

/** Command recorded by the fake DocumentClient. */
type RecordedCommand = {
  /** AWS SDK command class name. */
  name: string
  /** Command input as sent to the client. */
  input: Record<string, unknown>
}

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
  /**
   * Creates a NotificationsTable fake that applies transactions atomically and evaluates each
   * item's condition: `attribute_not_exists`, the revision match, and ConditionChecks marked as
   * failing.
   */
  function createTransactionalStore() {
    const rows = new Map<string, Record<string, unknown>>()
    const keyOf = (key: unknown) => {
      const recipientKey: unknown = Reflect.get(key ?? {}, 'recipientKey')
      const notificationKey: unknown = Reflect.get(key ?? {}, 'notificationKey')
      return `${String(recipientKey)}|${String(notificationKey)}`
    }
    const failingChecks = new Set<string>()
    const transactions: unknown[][] = []
    const recording = createRecordingClient(({ name, input }) => {
      if (name === 'GetCommand') return { Item: rows.get(keyOf(input.Key)) }
      if (name !== 'TransactWriteCommand') return {}
      const items = input.TransactItems
      if (!Array.isArray(items)) throw new Error('Missing transaction.')
      transactions.push(items)
      const reasons = items.map((item: unknown) => {
        const check: unknown = Reflect.get(item ?? {}, 'ConditionCheck')
        if (check) {
          const table: unknown = Reflect.get(check, 'TableName')
          return { Code: typeof table === 'string' && failingChecks.has(table) ? 'ConditionalCheckFailed' : 'None' }
        }
        const put: unknown = Reflect.get(item ?? {}, 'Put')
        if (Reflect.get(put ?? {}, 'TableName') !== 'NotificationsTable') return { Code: 'None' }
        const existing = rows.get(keyOf(Reflect.get(put ?? {}, 'Item')))
        const condition = Reflect.get(put ?? {}, 'ConditionExpression')
        const expected = Reflect.get(Reflect.get(put ?? {}, 'ExpressionAttributeValues') ?? {}, ':revision')
        const holds = condition === 'attribute_not_exists(recipientKey)'
          ? existing === undefined
          : existing?.revision === expected
        return { Code: holds ? 'None' : 'ConditionalCheckFailed' }
      })
      if (reasons.some((reason) => reason.Code !== 'None')) {
        throw Object.assign(new Error('Cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: reasons,
        })
      }
      for (const item of items) {
        const put: unknown = Reflect.get(item ?? {}, 'Put')
        const row: unknown = Reflect.get(put ?? {}, 'Item')
        if (Reflect.get(put ?? {}, 'TableName') === 'NotificationsTable' && typeof row === 'object' && row !== null) {
          rows.set(keyOf(row), { ...row })
        }
      }
      return {}
    })
    const store = new DynamoDbReminderSettingsStore(recording.documentClient, 'NotificationsTable')
    return { store, rows, failingChecks, transactions }
  }

  const save = (expectedRevision: number, overrides: Partial<SaveTeamReminderSettingsInput> = {}) => ({
    workspaceId: 'workspace-1',
    teamId: 'core-team',
    days: {},
    expectedRevision,
    now: new Date('2026-07-12T00:00:00.000Z'),
    ...overrides,
  })

  test('creates, updates with the revision condition, and reports a lost race as a conflict', async () => {
    const { store, rows } = createTransactionalStore()

    expect(await store.getTeamSettings('workspace-1', 'core-team')).toEqual({ days: {}, revision: 0 })
    expect(await store.readTeamReminderDays('workspace-1', 'core-team')).toBeUndefined()
    await store.saveTeamSettings(save(0, { days: { dueSoonDays: 2, overdueEscalationDays: 14 } }))
    expect(rows.get('workspace-1#!team-reminder-settings|TEAM#core-team')).toMatchObject({
      itemType: 'team-reminder-settings',
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      revision: 1,
    })
    expect(await store.readTeamReminderDays('workspace-1', 'core-team')).toEqual({ dueSoonDays: 2, overdueEscalationDays: 14 })
    await expect(store.saveTeamSettings(save(0))).rejects.toMatchObject({
      status: 409,
      code: 'NotificationReminderSettingsConflict',
    })
    await store.saveTeamSettings(save(1, { now: new Date('2026-07-13T00:00:00.000Z') }))
    expect(await store.getTeamSettings('workspace-1', 'core-team')).toEqual({
      days: {},
      revision: 2,
      updatedAt: '2026-07-13T00:00:00.000Z',
    })
  })

  test('keeps a receipt per idempotency key that later updates do not replace', async () => {
    const { store } = createTransactionalStore()
    await store.saveTeamSettings(save(0, {
      days: { dueSoonDays: 2 },
      mutation: { idempotencyKey: 'key-1', requestFingerprint: 'fingerprint-1' },
    }))
    await store.saveTeamSettings(save(1, {
      days: { dueSoonDays: 4 },
      mutation: { idempotencyKey: 'key-2', requestFingerprint: 'fingerprint-2' },
    }))
    expect(await store.getMutationReceipt('workspace-1', 'core-team', 'key-1')).toEqual({
      requestFingerprint: 'fingerprint-1',
      record: { days: { dueSoonDays: 2 }, revision: 1, updatedAt: '2026-07-12T00:00:00.000Z' },
    })
    expect(await store.getMutationReceipt('workspace-1', 'core-team', 'unused')).toBeUndefined()
    expect(await store.getMutationReceipt('workspace-1', 'other-team', 'key-1')).toBeUndefined()
    // A key can only be used once, even with the current revision.
    await expect(store.saveTeamSettings(save(2, {
      mutation: { idempotencyKey: 'key-1', requestFingerprint: 'fingerprint-3' },
    }))).rejects.toMatchObject({ status: 409, code: 'NotificationReminderSettingsConflict' })
  })

  test('commits the caller authorization checks and reports their failure apart from a conflict', async () => {
    const { store, failingChecks, transactions } = createTransactionalStore()
    const authorizationConditionChecks = [{
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#manager@example.com' },
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 3 },
      },
    }]
    await store.saveTeamSettings(save(0, { authorizationConditionChecks }))
    expect(transactions[0]).toContainEqual(authorizationConditionChecks[0])

    failingChecks.add('WorkspaceAccessTable')
    await expect(store.saveTeamSettings(save(1, { authorizationConditionChecks }))).rejects.toMatchObject({
      status: 409,
      code: 'TeamReminderSettingsAuthorizationChanged',
    })
    expect((await store.getTeamSettings('workspace-1', 'core-team')).revision).toBe(1)
  })

  test('fails instead of falling back to defaults for a corrupt or misplaced row', async () => {
    const { store, rows } = createTransactionalStore()
    await store.saveTeamSettings(save(0, { days: { dueSoonDays: 2 } }))
    expect(await store.readTeamReminderDays('workspace-1', 'core-team')).toEqual({ dueSoonDays: 2 })
    const key = 'workspace-1#!team-reminder-settings|TEAM#core-team'
    const valid = { ...rows.get(key) }

    rows.set(key, { ...valid, days: { dueSoonDays: 366 } })
    await expect(store.readTeamReminderDays('workspace-1', 'core-team')).rejects.toThrow('invalid')
    rows.set(key, { ...valid, teamId: 'other-team' })
    await expect(store.getTeamSettings('workspace-1', 'core-team')).rejects.toThrow('invalid')
    rows.set(key, { ...valid, workspaceId: 'workspace-2' })
    await expect(store.getTeamSettings('workspace-1', 'core-team')).rejects.toThrow('invalid')
  })

  test('fails instead of falling back for a corrupt personal row and uses nothing for a missing one', async () => {
    const preferences = createPreferenceStore()
    const reader = new DynamoDbReminderSettingsStore(preferences.documentClient, 'NotificationsTable')
    expect(await reader.readPersonalReminderDays('workspace-1', 'member@example.com')).toBeUndefined()
    await preferences.client.savePreferences({
      ...recipient,
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, reminderDays: { dueSoonDays: 5 } },
    })
    expect(await reader.readPersonalReminderDays('workspace-1', 'member@example.com')).toEqual({ dueSoonDays: 5 })

    const [key, row] = [...preferences.rows.entries()][0] ?? []
    if (!key || !row) throw new Error('Missing saved preferences.')
    preferences.rows.set(key, { ...row, reminderDays: { dueSoonDays: 366 } })
    await expect(reader.readPersonalReminderDays('workspace-1', 'member@example.com')).rejects.toThrow()
    // A non-strict read and an inheriting save fail too instead of writing defaults back.
    await expect(preferences.client.getPreferences(recipient)).rejects.toThrow()
    await expect(preferences.client.savePreferences({
      ...recipient,
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, version: 1 },
    })).rejects.toThrow()
    expect(preferences.rows.get(key)?.reminderDays).toEqual({ dueSoonDays: 366 })
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
        { entryId: 'b-old', memberKey: 'b@example.com', projectId: 'platform', startAt: '2026-07-10T09:00:00.000Z', endAt: '2026-07-10T10:00:00.000Z' },
        { entryId: 'a-new', memberKey: 'a@example.com', projectId: 'platform', startAt: '2026-07-18T09:00:00.000Z', endAt: '2026-07-18T10:00:00.000Z' },
        { entryId: 'a-old', memberKey: 'a@example.com', projectId: 'platform', startAt: '2026-07-06T09:00:00.000Z', endAt: '2026-07-06T10:00:00.000Z' },
        { entryId: 'a-mid', memberKey: 'a@example.com', projectId: 'platform', startAt: '2026-07-12T09:00:00.000Z', endAt: '2026-07-12T10:00:00.000Z' },
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
      projectId: 'platform',
      dueBefore: '2026-07-13T00:00:00.000Z',
      reminderDays: 7,
      cycle: Math.floor(now.getTime() / (7 * 86_400_000)),
    }])
  })

  test('sends one reminder per Project so an unreadable Project cannot hold back another', async () => {
    const reminders = await evaluateTimesheetReminders(
      'workspace-1',
      'core',
      [
        { entryId: 'old-a', memberKey: 'a@example.com', projectId: 'archive', startAt: '2026-07-01T09:00:00.000Z', endAt: '2026-07-01T10:00:00.000Z' },
        { entryId: 'b-1', memberKey: 'a@example.com', projectId: 'platform', startAt: '2026-07-08T09:00:00.000Z', endAt: '2026-07-08T10:00:00.000Z' },
        { entryId: 'b-2', memberKey: 'a@example.com', projectId: 'platform', startAt: '2026-07-09T09:00:00.000Z', endAt: '2026-07-09T10:00:00.000Z' },
      ],
      now,
      async () => 7,
    )
    expect(reminders.map((reminder) => [reminder.projectId, reminder.entryIds, reminder.oldestStartAt])).toEqual([
      ['archive', ['old-a'], '2026-07-01T09:00:00.000Z'],
      ['platform', ['b-1', 'b-2'], '2026-07-08T09:00:00.000Z'],
    ])
  })
})

describe('Team reminder settings routes', () => {
  /** Creates the router with an in-memory store and recorded authorization calls. */
  function createRouter(options: { manager: boolean }) {
    let record: TeamReminderSettingsRecord = { days: {}, revision: 0 }
    const accessChecks: string[] = []
    const audits: unknown[] = []
    let saves = 0
    const receipts = new Map<string, TeamReminderSettingsReceipt>()
    const authorizationChecks: unknown[] = []
    const router = createTeamReminderSettingsRouter({
      authenticate: async () => ({ directoryId: 'workspace-1' }),
      async requireTeamAccess(_principal, teamId, access) {
        accessChecks.push(`${teamId}:${access}`)
        if (access === 'manage' && !options.manager) {
          throw new NotificationError(403, 'TeamRoleDenied', 'Team manager access is required.')
        }
      },
      canManageTeam: async () => options.manager,
      createAuthorizationConditionChecks: () => [{
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#manager@example.com' },
          ConditionExpression: 'attribute_exists(workspaceId)',
        },
      }],
      getStore: () => ({
        getTeamSettings: async () => record,
        getMutationReceipt: async (_workspaceId, _teamId, key) => receipts.get(key),
        async saveTeamSettings(input) {
          if (
            input.expectedRevision !== record.revision ||
            (input.mutation && receipts.has(input.mutation.idempotencyKey))
          ) {
            throw new NotificationError(409, 'NotificationReminderSettingsConflict', 'Conflict.')
          }
          saves += 1
          authorizationChecks.push(...(input.authorizationConditionChecks ?? []))
          record = {
            days: input.days,
            revision: input.expectedRevision + 1,
            updatedAt: input.now.toISOString(),
          }
          if (input.mutation) {
            receipts.set(input.mutation.idempotencyKey, {
              requestFingerprint: input.mutation.requestFingerprint,
              record,
            })
          }
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
    return { router, accessChecks, audits, authorizationChecks, saveCount: () => saves }
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
      { expectedRevision: 0, days: { timesheetReminderDays: 32 } },
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
    const { router, audits, authorizationChecks } = createRouter({ manager: true })
    const saved = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRevision: 0, days: { dueSoonDays: 2, overdueEscalationDays: null } }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ days: { dueSoonDays: 2 }, revision: 1, canManage: true })
    expect(audits).toMatchObject([{ teamId: 'core', before: {}, after: { dueSoonDays: 2 }, beforeRevision: 0 }])
    expect(authorizationChecks).toMatchObject([{ ConditionCheck: { TableName: 'WorkspaceAccessTable' } }])

    const stale = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRevision: 0, days: {} }),
    })
    expect(stale.status).toBe(409)
  })

  test('replays a retried save after a lost response and rejects a reused key with another body', async () => {
    const { router, audits, saveCount } = createRouter({ manager: true })
    const retryHeaders = { ...headers, 'Idempotency-Key': 'save-1' }
    const body = JSON.stringify({ expectedRevision: 0, days: { dueSoonDays: 2 } })
    const first = await router.request('/api/teams/core/notification-reminders', { method: 'PUT', headers: retryHeaders, body })
    expect(first.status).toBe(200)

    const retried = await router.request('/api/teams/core/notification-reminders', { method: 'PUT', headers: retryHeaders, body })
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ days: { dueSoonDays: 2 }, revision: 1 })
    expect(saveCount()).toBe(1)
    expect(audits).toHaveLength(1)

    const reused = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers: retryHeaders,
      body: JSON.stringify({ expectedRevision: 0, days: { dueSoonDays: 3 } }),
    })
    expect(reused.status).toBe(409)
    expect(await reused.json()).toEqual({ code: 'IdempotencyKeyReused' })

    const otherKey = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': 'save-2' },
      body,
    })
    expect(otherKey.status).toBe(409)
    expect(await otherKey.json()).toEqual({ code: 'NotificationReminderSettingsConflict' })

    // After another key updates the settings, the first key still replays and still rejects a new
    // body, even one sent with the current revision.
    const later = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': 'save-3' },
      body: JSON.stringify({ expectedRevision: 1, days: { dueSoonDays: 4 } }),
    })
    expect(later.status).toBe(200)
    const replayedAfterLater = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers: retryHeaders,
      body,
    })
    expect(replayedAfterLater.status).toBe(200)
    expect(await replayedAfterLater.json()).toMatchObject({ days: { dueSoonDays: 2 }, revision: 1 })
    const reusedAtCurrentRevision = await router.request('/api/teams/core/notification-reminders', {
      method: 'PUT',
      headers: retryHeaders,
      body: JSON.stringify({ expectedRevision: 2, days: { dueSoonDays: 9 } }),
    })
    expect(reusedAtCurrentRevision.status).toBe(409)
    expect(await reusedAtCurrentRevision.json()).toEqual({ code: 'IdempotencyKeyReused' })
    expect(saveCount()).toBe(2)
  })
})
