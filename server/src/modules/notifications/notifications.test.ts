import { describe, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DynamoDbNotificationsClient,
  NOTIFICATION_PREFERENCES_KEY,
  NotificationError,
  createNotificationDeliveryPlan,
  createNotificationRecipientKey,
  parseStoredNotificationPreferences,
  type NotificationItem,
  type NotificationAction,
  type NotificationState,
} from './notifications'

function createNotificationRow(overrides: Record<string, unknown> = {}) {
  return {
    recipientKey: 'workspace-1#member@example.com',
    notificationKey: '2026-07-12T12:00:00.000Z#evt-1',
    recipientStatusKey: 'workspace-1#member@example.com#unread',
    itemType: 'notification',
    inboxState: 'unread',
    version: 1,
    notificationId: 'evt-1',
    eventId: 'evt-1',
    eventType: 'comment.replied',
    entityId: 'team/core/issue/notification-foundations',
    actorLabel: 'Author Example',
    title: 'Notification foundations',
    summary: 'A reply mentioned you.',
    reasons: ['reply', 'mention'],
    deepLink:
      '/teams/core/issues?issueId=notification-foundations&commentId=reply-1&rootCommentId=root-1',
    teamId: 'core',
    projectId: 'platform',
    issueId: 'notification-foundations',
    commentId: 'reply-1',
    rootCommentId: 'root-1',
    occurredAt: '2026-07-12T12:00:00.000Z',
    ...overrides,
  }
}

function createClient(
  send: (command: {
    constructor: { name: string }
    input: Record<string, unknown>
  }) => unknown | Promise<unknown>,
) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input })
      return await send(command)
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbNotificationsClient(
    'NotificationsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'RecipientStatusIndex',
  )
  return { client, commands }
}

describe('notification store', () => {
  test('builds normalized recipient keys and returns safe default preferences', () => {
    expect(createNotificationRecipientKey('workspace-1', 'Member@Example.com')).toBe(
      'workspace-1#member@example.com',
    )
    expect(parseStoredNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    const first = parseStoredNotificationPreferences(undefined)
    first.channels.inApp = false
    expect(parseStoredNotificationPreferences(undefined).channels.inApp).toBe(true)
  })

  test('preserves Planning target metadata for current-visibility checks', async () => {
    let queryCount = 0
    const recording = createClient(({ constructor }) => {
      if (constructor.name !== 'QueryCommand') return {}
      queryCount += 1
      return queryCount === 1
        ? { Items: [] }
        : {
          Items: [createNotificationRow({
            eventType: 'planning-update.overdue',
            planningTargetType: 'project',
            planningTargetId: 'platform',
            planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
            planningNextDueAt: '2026-07-12T09:00:00.000Z',
            planningNotificationKind: 'overdue',
          })],
        }
    })

    const page = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
      now: new Date('2026-07-12T13:00:00.000Z'),
    })

    expect(page.notifications[0]).toMatchObject({
      planningTargetType: 'project',
      planningTargetId: 'platform',
      planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
      planningNextDueAt: '2026-07-12T09:00:00.000Z',
      planningNotificationKind: 'overdue',
    })
  })

  test('fails closed when notification rows do not have the current row schema', async () => {
    const invalidRows: Array<Record<string, unknown>> = [
      createNotificationRow({ itemType: undefined }),
      createNotificationRow({ recipientStatusKey: undefined }),
      createNotificationRow({ version: undefined }),
    ]

    for (const row of invalidRows) {
      const recording = createClient(({ constructor, input }) => {
        if (constructor.name !== 'QueryCommand') {
          return {}
        }
        if (input.IndexName) {
          return { Items: [] }
        }
        return { Items: [row] }
      })

      await expect(recording.client.list({
        workspaceId: 'workspace-1',
        memberKey: 'member@example.com',
        limit: 10,
        now: new Date('2026-07-12T13:00:00.000Z'),
      })).rejects.toMatchObject({
        code: 'InvalidNotificationData',
        status: 503,
      })
    }
  })

  test('ignores retired notification migration marker rows', async () => {
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name !== 'QueryCommand') {
        return {}
      }
      if (input.IndexName) {
        return { Items: [] }
      }
      return {
        Items: [
          createNotificationRow({
            notificationKey: '!MIGRATION#STATUS-V1',
            itemType: 'migration',
            recipientStatusKey: undefined,
            version: undefined,
          }),
          createNotificationRow(),
        ],
      }
    })

    const page = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 10,
      now: new Date('2026-07-12T13:00:00.000Z'),
    })

    expect(page.notifications).toHaveLength(1)
    expect(page.notifications[0]?.eventId).toBe('evt-1')
  })

  test('lists only currently visible active notifications and binds cursors to filters', async () => {
    let queryCount = 0
    const recording = createClient(({ constructor }) => {
      if (constructor.name !== 'QueryCommand') {
        return {}
      }
      queryCount += 1
      if (queryCount === 1) {
        return { Items: [] }
      }
      if (queryCount === 2) {
        return {
          Items: [
            createNotificationRow({
              deepLink: '/teams/core/triage?entryId=triage_20260809_sla',
              triageEntryId: 'triage_20260809_sla',
            }),
            createNotificationRow({
              notificationKey: '2026-07-12T11:30:00.000Z#evt-in-app-disabled',
              eventId: 'evt-in-app-disabled',
              notificationId: 'evt-in-app-disabled',
              inAppVisible: false,
            }),
            createNotificationRow({
              notificationKey: '2026-07-12T11:00:00.000Z#evt-hidden',
              eventId: 'evt-hidden',
              notificationId: 'evt-hidden',
              projectId: 'hidden',
            }),
          ],
          LastEvaluatedKey: {
            recipientKey: 'workspace-1#member@example.com',
            notificationKey: '2026-07-12T11:00:00.000Z#evt-hidden',
          },
        }
      }
      return { Items: [] }
    })

    const page = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 2,
      isVisible: (notification) => notification.projectId === 'platform',
      now: new Date('2026-07-12T13:00:00.000Z'),
    })

    expect(page.notifications).toHaveLength(1)
    expect(page.notifications[0]).toMatchObject({
      eventId: 'evt-1',
      entityId: 'team/core/issue/notification-foundations',
      state: 'unread',
      title: 'Notification foundations',
      actorLabel: 'Author Example',
      rootCommentId: 'root-1',
      triageEntryId: 'triage_20260809_sla',
    })
    expect(page.nextCursor).toBeUndefined()
    expect(recording.commands.find((command) =>
      command.name === 'QueryCommand' && command.input.ConsistentRead === true
    )?.input).toMatchObject({
      TableName: 'NotificationsTable',
      ConsistentRead: true,
      ScanIndexForward: false,
    })

    const cursorRecording = createClient(({ constructor }) =>
      constructor.name === 'QueryCommand'
        ? queryCount++ % 2 === 0
          ? { Items: [] }
          : {
              Items: [createNotificationRow()],
              LastEvaluatedKey: {
                recipientKey: 'workspace-1#member@example.com',
                notificationKey: '2026-07-12T12:00:00.000Z#evt-1',
              },
            }
        : {},
    )
    const firstPage = await cursorRecording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
    })
    expect(firstPage.nextCursor).toBeString()
    await expect(cursorRecording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      filter: 'archived',
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ code: 'InvalidNotificationCursor', status: 400 })
  })

  test('persists snooze state with optimistic concurrency', async () => {
    let queryCount = 0
    let savedRow: Record<string, unknown> | undefined
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name === 'QueryCommand') {
        queryCount += 1
        return queryCount === 1 ? { Items: [] } : { Items: [createNotificationRow()] }
      }
      if (constructor.name === 'GetCommand') {
        return { Item: createNotificationRow() }
      }
      if (constructor.name === 'PutCommand') {
        savedRow = input.Item as Record<string, unknown>
      }
      return {}
    })
    const listed = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
      now: new Date('2026-07-12T13:00:00.000Z'),
    })

    const updated = await recording.client.update({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      notificationId: listed.notifications[0]?.id ?? '',
      action: 'snooze',
      snoozedUntil: '2026-07-13T09:00:00.000Z',
      now: new Date('2026-07-12T13:00:00.000Z'),
      isVisible: (notification) => {
        notification.projectId = 'current-project'
        return true
      },
    })

    expect(updated).toMatchObject({
      state: 'snoozed',
      snoozedUntil: '2026-07-13T09:00:00.000Z',
    })
    expect(savedRow).toMatchObject({
      inboxState: 'snoozed',
      recipientStatusKey: 'workspace-1#member@example.com#snoozed',
      projectId: 'current-project',
      version: 2,
    })
    const put = recording.commands.find((command) => command.name === 'PutCommand')
    expect(put?.input.ConditionExpression).toBe(
      'attribute_exists(recipientKey) AND attribute_exists(notificationKey) AND #version = :version',
    )
    expect(put?.input.ExpressionAttributeValues).toEqual({ ':version': 1 })
  })

  test('reapplies the current visibility projection to an updated notification response', async () => {
    const row = createNotificationRow({
      issueId: undefined,
      summary: 'HISTORICAL_TRIAGE_SUMMARY',
      title: 'HISTORICAL_TRIAGE_TITLE',
      triageEntryId: 'triage-1',
    })
    let queryCount = 0
    const recording = createClient(({ constructor }) => {
      if (constructor.name === 'QueryCommand') {
        queryCount += 1
        return queryCount === 1 ? { Items: [] } : { Items: [row] }
      }
      if (constructor.name === 'GetCommand') return { Item: row }
      return {}
    })
    const listed = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
    })

    const updated = await recording.client.update({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      notificationId: listed.notifications[0]?.id ?? '',
      action: 'mark-read',
      isVisible: (notification) => {
        notification.title = 'Restricted source'
        delete notification.summary
        return true
      },
    })

    expect(updated).toMatchObject({ state: 'read', title: 'Restricted source' })
    expect(updated.summary).toBeUndefined()
    expect(JSON.stringify(updated)).not.toContain('HISTORICAL_TRIAGE')
  })

  test('persists read, unread, archive, and restore transitions', async () => {
    const cases: ReadonlyArray<{
      action: NotificationAction
      row: ReturnType<typeof createNotificationRow>
      expectedState: NotificationState
    }> = [
      {
        action: 'mark-read' as const,
        row: createNotificationRow(),
        expectedState: 'read',
      },
      {
        action: 'mark-unread' as const,
        row: createNotificationRow({ readAt: '2026-07-12T12:30:00.000Z' }),
        expectedState: 'unread',
      },
      {
        action: 'archive' as const,
        row: createNotificationRow(),
        expectedState: 'archived',
      },
      {
        action: 'restore' as const,
        row: createNotificationRow({
          archivedAt: '2026-07-12T12:30:00.000Z',
          inboxState: 'archived',
          readAt: '2026-07-12T12:20:00.000Z',
          recipientStatusKey: 'workspace-1#member@example.com#archived',
        }),
        expectedState: 'read',
      },
    ]

    for (const transition of cases) {
      let savedRow: Record<string, unknown> | undefined
      const recording = createClient(({ constructor, input }) => {
        if (constructor.name === 'GetCommand') {
          return { Item: transition.row }
        }
        if (constructor.name === 'PutCommand') {
          savedRow = input.Item as Record<string, unknown>
        }
        return {}
      })
      const listed = await recording.client.list({
        workspaceId: 'workspace-1',
        memberKey: 'member@example.com',
        limit: 1,
      })
      const notificationId = listed.notifications[0]?.id ?? Buffer.from(JSON.stringify({
        version: 1,
        recipientKey: 'workspace-1#member@example.com',
        notificationKey: transition.row.notificationKey,
      })).toString('base64url')
      const updated = await recording.client.update({
        workspaceId: 'workspace-1',
        memberKey: 'member@example.com',
        notificationId,
        action: transition.action,
        now: new Date('2026-07-12T13:00:00.000Z'),
      })

      expect(updated.state).toBe(transition.expectedState)
      expect(savedRow?.recipientStatusKey).toBe(
        `workspace-1#member@example.com#${transition.expectedState}`,
      )
    }
  })

  test('marks every visible unread row read', async () => {
    const row = createNotificationRow()
    let savedRow: Record<string, unknown> | undefined
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name === 'QueryCommand') {
        const statusKey = (input.ExpressionAttributeValues as Record<string, unknown>)
          [':recipientStatusKey']
        return statusKey === 'workspace-1#member@example.com#unread'
          ? { Items: [row] }
          : { Items: [] }
      }
      if (constructor.name === 'GetCommand') {
        return { Item: row }
      }
      if (constructor.name === 'PutCommand') {
        savedRow = input.Item as Record<string, unknown>
      }
      return {}
    })

    await expect(recording.client.markAllRead({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      isVisible: () => true,
      now: new Date('2026-07-12T13:00:00.000Z'),
    })).resolves.toBe(1)
    expect(savedRow).toMatchObject({
      inboxState: 'read',
      recipientStatusKey: 'workspace-1#member@example.com#read',
    })
    expect(recording.commands.some(({ input, name }) =>
      name === 'GetCommand' &&
      (input.Key as Record<string, unknown> | undefined)?.notificationKey === '!MIGRATION#STATUS-V1'
    )).toBeFalse()
  })

  test('wakes an expired snooze back into the unread timeline', async () => {
    const snoozedRow = createNotificationRow({
      inboxState: 'snoozed',
      recipientStatusKey: 'workspace-1#member@example.com#snoozed',
      snoozedUntil: '2026-07-12T12:00:00.000Z',
    })
    let wokenRow: Record<string, unknown> | undefined
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name === 'QueryCommand') {
        if (input.IndexName) {
          return { Items: [snoozedRow] }
        }
        return { Items: wokenRow ? [wokenRow] : [] }
      }
      if (constructor.name === 'PutCommand') {
        wokenRow = input.Item as Record<string, unknown>
      }
      return {}
    })

    const page = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
      now: new Date('2026-07-12T13:00:00.000Z'),
    })

    expect(page.notifications[0]?.state).toBe('unread')
    expect(wokenRow).toMatchObject({
      inboxState: 'unread',
      recipientStatusKey: 'workspace-1#member@example.com#unread',
    })
    expect(wokenRow?.snoozedUntil).toBeUndefined()
    expect(recording.commands.find(({ input, name }) =>
      name === 'QueryCommand' &&
      (input.ExpressionAttributeValues as Record<string, unknown> | undefined)
        ?.[':recipientStatusKey'] === 'workspace-1#member@example.com#snoozed'
    )?.input).toMatchObject({
      Limit: 250,
      IndexName: 'RecipientStatusIndex',
    })
  })

  test('fails closed when expired-snooze maintenance reaches its page cap', async () => {
    let wakeQueries = 0
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name !== 'QueryCommand') return {}
      const statusKey = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)
        ?.[':recipientStatusKey']
      if (statusKey !== 'workspace-1#member@example.com#snoozed') {
        return { Items: [] }
      }
      wakeQueries += 1
      return {
        Items: Array.from({ length: 250 }, (_, index) => createNotificationRow({
          notificationKey: `future-snooze-${wakeQueries}-${index}`,
          snoozedUntil: '2099-07-12T13:00:00.000Z',
          inboxState: 'snoozed',
          recipientStatusKey: 'workspace-1#member@example.com#snoozed',
        })),
        LastEvaluatedKey: {
          recipientStatusKey: statusKey,
          notificationKey: `wake-page-${wakeQueries}`,
        },
      }
    })

    await expect(recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      now: new Date('2026-07-12T13:00:00.000Z'),
    })).rejects.toMatchObject({
      status: 503,
      code: 'NotificationSnoozeWakeLimitExceeded',
    })
    expect(wakeQueries).toBe(4)
    expect(recording.commands.filter(({ input, name }) =>
      name === 'QueryCommand' &&
      (input.ExpressionAttributeValues as Record<string, unknown> | undefined)
        ?.[':recipientStatusKey'] === 'workspace-1#member@example.com#snoozed'
    ).every(({ input }) => input.Limit === 250)).toBeTrue()
  })

  test('fails closed when the expired-snooze wake cursor stalls', async () => {
    let wakeQueries = 0
    const stalledCursor = {
      recipientStatusKey: 'workspace-1#member@example.com#snoozed',
      notificationKey: 'stalled-wake-page',
    }
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name !== 'QueryCommand') return {}
      const statusKey = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)
        ?.[':recipientStatusKey']
      if (statusKey !== 'workspace-1#member@example.com#snoozed') {
        return { Items: [] }
      }
      wakeQueries += 1
      return { Items: [], LastEvaluatedKey: stalledCursor }
    })

    await expect(recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      now: new Date('2026-07-12T13:00:00.000Z'),
    })).rejects.toMatchObject({
      status: 503,
      code: 'NotificationSnoozeWakeCursorStalled',
    })
    expect(wakeQueries).toBe(2)
  })

  test('counts only permission-visible unread notifications', async () => {
    let queryCount = 0
    const recording = createClient(({ constructor }) => {
      if (constructor.name !== 'QueryCommand') {
        return {}
      }
      queryCount += 1
      return queryCount === 1
        ? { Items: [] }
        : {
            Items: [
              createNotificationRow(),
              createNotificationRow({
                notificationKey: '2026-07-12T11:30:00.000Z#in-app-disabled',
                eventId: 'in-app-disabled',
                inAppVisible: false,
              }),
              createNotificationRow({
                notificationKey: '2026-07-12T11:00:00.000Z#hidden',
                eventId: 'hidden',
                projectId: 'hidden',
              }),
            ],
          }
    })

    await expect(recording.client.countUnread({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      isVisible: (notification) => notification.projectId === 'platform',
    })).resolves.toBe(1)
    expect(recording.commands.find((command) =>
      command.name === 'QueryCommand' &&
      (command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)
        ?.[':recipientStatusKey'] === 'workspace-1#member@example.com#unread'
    )?.input).toMatchObject({
      IndexName: 'RecipientStatusIndex',
      ExpressionAttributeValues: {
        ':recipientStatusKey': 'workspace-1#member@example.com#unread',
      },
    })
  })

  test('saves versioned channel, frequency, and quiet-hour preferences', async () => {
    let saved: Record<string, unknown> | undefined
    const recording = createClient(({ constructor, input }) => {
      if (constructor.name === 'GetCommand') {
        return {}
      }
      if (constructor.name === 'PutCommand') {
        saved = input.Item as Record<string, unknown>
      }
      return {}
    })

    await expect(recording.client.getPreferences({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
    })).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    const preferences = await recording.client.savePreferences({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      now: new Date('2026-07-12T13:00:00.000Z'),
      preferences: {
        version: 0,
        channels: { inApp: true, email: true, push: false },
        frequency: 'daily',
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timeZone: 'Asia/Tokyo',
        },
      },
    })

    expect(preferences).toMatchObject({ version: 1, frequency: 'daily' })
    expect(saved).toMatchObject({
      notificationKey: '!PREFERENCES',
      itemType: 'preferences',
      version: 1,
    })
    await expect(recording.client.savePreferences({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      preferences: {
        version: 1,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timeZone: 'Not/AZone',
        },
      },
    })).rejects.toBeInstanceOf(NotificationError)
  })

  test('returns an identical version-plus-one preference row for a response-loss retry', async () => {
    const storedPreferences = {
      recipientKey: 'workspace-1#member@example.com',
      notificationKey: NOTIFICATION_PREFERENCES_KEY,
      itemType: 'preferences',
      version: 1,
      channels: { inApp: true, email: true, push: false },
      frequency: 'daily',
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        timeZone: 'Asia/Tokyo',
      },
      updatedAt: '2026-07-12T13:00:00.000Z',
    }
    const recording = createClient(({ constructor }) => {
      if (constructor.name === 'PutCommand') {
        const conflict = new Error('The conditional request failed')
        conflict.name = 'ConditionalCheckFailedException'
        throw conflict
      }
      if (constructor.name === 'GetCommand') {
        return { Item: storedPreferences }
      }
      return {}
    })

    await expect(recording.client.savePreferences({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      preferences: {
        version: 0,
        channels: { inApp: true, email: true, push: false },
        frequency: 'daily',
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timeZone: 'Asia/Tokyo',
        },
      },
    })).resolves.toEqual({
      version: 1,
      channels: storedPreferences.channels,
      frequency: 'daily',
      quietHours: storedPreferences.quietHours,
      updatedAt: '2026-07-12T13:00:00.000Z',
    })
    expect(recording.commands.at(-1)?.input).toMatchObject({
      ConsistentRead: true,
      Key: {
        recipientKey: 'workspace-1#member@example.com',
        notificationKey: NOTIFICATION_PREFERENCES_KEY,
      },
    })
  })

  test('delays digest delivery until quiet hours end in the configured time zone', () => {
    const plan = createNotificationDeliveryPlan({
      version: 1,
      channels: { inApp: true, email: true, push: false },
      frequency: 'instant',
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        timeZone: 'UTC',
      },
    }, '2026-07-12T23:00:00.000Z')

    expect(plan).toEqual({
      channels: ['inApp', 'email'],
      deliveryAfter: '2026-07-13T07:00:00.000Z',
      frequency: 'instant',
    })
  })

  test('rejects a notification ID that belongs to another recipient', async () => {
    let queryCount = 0
    const recording = createClient(({ constructor }) => {
      if (constructor.name === 'QueryCommand') {
        queryCount += 1
        return queryCount === 1 ? { Items: [] } : { Items: [createNotificationRow()] }
      }
      return {}
    })
    const page = await recording.client.list({
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      limit: 1,
    })

    await expect(recording.client.update({
      workspaceId: 'workspace-1',
      memberKey: 'other@example.com',
      notificationId: (page.notifications[0] as NotificationItem).id,
      action: 'mark-read',
    })).rejects.toMatchObject({ code: 'InvalidNotificationId', status: 400 })
  })
})
