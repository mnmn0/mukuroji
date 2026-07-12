import { afterEach, describe, expect, test } from 'bun:test'
import {
  getNotificationPreferences,
  getNotifications,
  getNotificationUnreadCount,
  markAllNotificationsRead,
  updateNotification,
  updateNotificationPreferences,
} from '../src/notifications/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-1',
  idempotencyKey: 'idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('notifications API', () => {
  test('forwards filter, event type, limit, and opaque cursor', async () => {
    const requests = installFetchRecorder({ notifications: [], unreadCount: 4 })

    await getNotifications('access-token', {
      cursor: 'next/a+b',
      filter: 'unread',
      limit: 30,
      type: 'comment.replied',
    })

    expect(requests[0]?.url).toBe(
      '/api/notifications?filter=unread&type=comment.replied&limit=30&cursor=next%2Fa%2Bb',
    )
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('loads the global unread count from the lightweight endpoint', async () => {
    const requests = installFetchRecorder({ unreadCount: 7 })

    await expect(getNotificationUnreadCount('access-token')).resolves.toBe(7)
    expect(requests[0]?.url).toBe('/api/notifications/unread-count')
  })

  test('uses stable mutation headers for state changes and mark-all-read', async () => {
    const requests = installFetchRecorder({ unreadCount: 0, updatedCount: 3 })

    await updateNotification(
      'notification/1',
      'access-token',
      { action: 'snooze', snoozedUntil: '2026-07-13T00:00:00.000Z' },
      mutationContext,
    )
    await expect(markAllNotificationsRead('access-token', mutationContext)).resolves.toEqual({
      unreadCount: 0,
      updatedCount: 3,
    })

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['PATCH', '/api/notifications/notification%2F1'],
      ['POST', '/api/notifications/mark-all-read'],
    ])
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'idempotency-1',
      'X-Correlation-Id': 'correlation-1',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      action: 'snooze',
      snoozedUntil: '2026-07-13T00:00:00.000Z',
    })
  })

  test('gets and saves channel, frequency, and quiet-hours preferences', async () => {
    const preferences = {
      channels: { email: true, inApp: true, push: false },
      frequency: 'daily' as const,
      quietHours: {
        enabled: true,
        end: '08:00',
        start: '22:00',
        timeZone: 'Asia/Tokyo',
      },
      version: 4,
    }
    const requests = installFetchRecorder(preferences)

    await expect(getNotificationPreferences('access-token')).resolves.toEqual(preferences)
    await updateNotificationPreferences('access-token', preferences, mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [undefined, '/api/notification-preferences'],
      ['PUT', '/api/notification-preferences'],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(preferences)
  })
})

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
