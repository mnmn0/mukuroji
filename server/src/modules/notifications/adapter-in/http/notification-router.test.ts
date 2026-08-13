import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationError,
  type NotificationItem,
  type NotificationClient,
} from '../../notifications'
import { createNotificationRouter } from './notification-router'

describe('createNotificationRouter', () => {
  test('keeps notification clients isolated between app instances', async () => {
    const first = createNotificationRouter(createDependencies(1))
    const second = createNotificationRouter(createDependencies(2))

    const [firstResponse, secondResponse] = await Promise.all([
      first.request('/api/notifications', {
        headers: { Authorization: 'Bearer first-token' },
      }),
      second.request('/api/notifications', {
        headers: { Authorization: 'Bearer second-token' },
      }),
    ])

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual({
      notifications: [],
      nextCursor: 'client-1',
      unreadCount: 1,
    })
    expect(await secondResponse.json()).toEqual({
      notifications: [],
      nextCursor: 'client-2',
      unreadCount: 2,
    })
  })

  test('preserves bearer authentication and action validation responses', async () => {
    const router = createNotificationRouter(createDependencies(1))
    const unauthorized = await router.request('/api/notifications')
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      message: 'Bearer token is required.',
    })

    const invalid = await router.request('/api/notifications/notification-1', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'invalid' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      code: 'InvalidNotificationAction',
      message: 'Notification action is invalid.',
    })
  })

  test('does not expose Planning table keys in list or mutation responses', async () => {
    const notification: NotificationItem = {
      id: 'notification-1',
      eventId: 'event-1',
      eventType: 'planning-update.overdue',
      reasons: ['overdue'],
      planningTargetType: 'project',
      planningTargetId: 'project-1',
      planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#team-1#project-1',
      planningNextDueAt: '2026-08-12T00:00:00.000Z',
      planningNotificationKind: 'overdue',
      occurredAt: '2026-08-12T00:00:00.000Z',
      state: 'unread',
    }
    const dependencies = createDependencies(1)
    const notifications = {
      ...dependencies.getNotifications(),
      async list() {
        return { notifications: [notification] }
      },
      async update() {
        return notification
      },
    } satisfies NotificationClient
    const router = createNotificationRouter({
      ...dependencies,
      getNotifications: () => notifications,
    })

    const listResponse = await router.request('/api/notifications', {
      headers: { Authorization: 'Bearer token' },
    })
    expect(JSON.stringify(await listResponse.json())).not.toContain(
      'planningTargetRecordKey',
    )

    const updateResponse = await router.request('/api/notifications/notification-1', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'mark-read' }),
    })
    expect(JSON.stringify(await updateResponse.json())).not.toContain(
      'planningTargetRecordKey',
    )
  })
})

function createDependencies(marker: number) {
  const notifications = {
    async list() {
      return {
        notifications: [],
        nextCursor: `client-${marker}`,
      }
    },
    async countUnread() {
      return marker
    },
    async update() {
      throw new Error('Unexpected update call.')
    },
    async markAllRead() {
      return marker
    },
    async getPreferences() {
      return DEFAULT_NOTIFICATION_PREFERENCES
    },
    async savePreferences() {
      return DEFAULT_NOTIFICATION_PREFERENCES
    },
  } satisfies NotificationClient

  return {
    getNotifications: () => notifications,
    async authenticate(accessToken: string) {
      return {
        directoryId: `workspace-${accessToken}`,
        userKey: `member-${accessToken}`,
      }
    },
    async createVisibilityFilter() {
      return async () => true
    },
    mapError(context: Context, error: unknown) {
      if (error instanceof NotificationError) {
        return context.json(
          { code: error.code, message: error.message },
          error.status === 400 ? 400 : 502,
        )
      }
      return context.json({ message: 'Notification data is unavailable.' }, 502)
    },
    async readJson(request: { json: () => Promise<unknown> }) {
      try {
        return await request.json()
      } catch {
        return undefined
      }
    },
  }
}
