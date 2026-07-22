import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationError,
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
