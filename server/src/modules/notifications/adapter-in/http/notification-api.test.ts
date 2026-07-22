import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createNotificationItem,
  createNotificationVisibilityProbe,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type {
  NotificationClient,
} from '../../notifications'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('serves permission-filtered notification timeline, state, and preference contracts', async () => {
  const projectCalls = configureFakeProjectClients(true, {
    detailAssigneeUserId: 'demo@example.com',
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    title: 'Notification API',
    deepLink: '/teams/core-team/issues?issueId=notification-api',
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-api',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  const calls: {
    filter?: string
    action?: string
    savedPreferenceVersion?: number
  } = {}
  const notificationClient: NotificationClient = {
    async list(input) {
      calls.filter = input.filter
      expect(input.workspaceId).toBe('user#demo@example.com')
      expect(input.memberKey).toBe('demo@example.com')
      expect(await input.isVisible?.(notification)).toBe(true)
      expect(await input.isVisible?.({ ...notification, issueId: undefined, projectId: 'hidden-project' })).toBe(false)
      return { notifications: [notification], nextCursor: 'next-page' }
    },
    async countUnread() {
      return calls.action === 'mark-read' ? 0 : 1
    },
    async update(input) {
      calls.action = input.action
      return { ...notification, state: 'read', readAt: '2026-07-12T13:00:00.000Z' }
    },
    async markAllRead() {
      return 1
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      calls.savedPreferenceVersion = input.preferences.version
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  setTestAppDependencies({ notifications: notificationClient })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const listResponse = await app.request('/api/notifications?filter=unread&limit=20', { headers })
  expect(listResponse.status).toBe(200)
  expect(await listResponse.json()).toMatchObject({
    notifications: [{ id: 'opaque-notification-id', state: 'unread' }],
    nextCursor: 'next-page',
    unreadCount: 1,
  })
  expect(calls.filter).toBe('unread')
  expect(projectCalls.directoryReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    locale: 'ja',
    consistentRead: true,
  })

  const updateResponse = await app.request('/api/notifications/opaque-notification-id', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ action: 'mark-read' }),
  })
  expect(updateResponse.status).toBe(200)
  expect(await updateResponse.json()).toMatchObject({ state: 'read' })
  expect(calls.action).toBe('mark-read')

  const preferenceResponse = await app.request('/api/notification-preferences', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      version: 0,
      channels: { inApp: true, email: true, push: false },
      frequency: 'daily',
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Asia/Tokyo' },
    }),
  })
  expect(preferenceResponse.status).toBe(200)
  expect(await preferenceResponse.json()).toMatchObject({ version: 1, frequency: 'daily' })
  expect(calls.savedPreferenceVersion).toBe(0)
})

test('hides a notification after its Work Item moves to an inaccessible project', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'private-project',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'moved-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  let currentlyVisible = true
  const notificationClient = {
    async list(input) {
      currentlyVisible = await input.isVisible?.(notification) ?? true
      return { notifications: currentlyVisible ? [notification] : [] }
    },
    async countUnread(input) {
      return await input.isVisible?.(notification) ? 1 : 0
    },
    async update() {
      return notification
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant' as const,
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return input.preferences
    },
  } as NotificationClient
  setTestAppDependencies({ notifications: notificationClient })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(currentlyVisible).toBe(false)
  expect(notification.projectId).toBe('private-project')
  expect(await response.json()).toMatchObject({ notifications: [], unreadCount: 0 })
})

test('keeps a shared-project notification visible under every active owner Team', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'shared-launch',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'shared-launch', role: 'viewer' }],
    teamProjects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    }],
  })
  const coreNotification = createNotificationItem({
    id: 'shared-project-core-notification',
    issueId: 'shared-project-core-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
  })
  const designNotification = createNotificationItem({
    id: 'shared-project-design-notification',
    issueId: 'shared-project-design-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
    teamId: 'design-team',
  })
  const probe = createNotificationVisibilityProbe([coreNotification, designNotification])
  setTestAppDependencies({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(coreNotification.id)).toBe(true)
  expect(probe.visibility.get(designNotification.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: coreNotification.id }, { id: designNotification.id }],
    unreadCount: 2,
  })
})

test('hides stale assignee-only notifications after Work Item reassignment', async () => {
  configureFakeProjectClients(true, {
    detailAssigneeUserId: 'sato@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  const staleAssignment = createNotificationItem({
    id: 'stale-assignment',
    reasons: ['assignment'],
  })
  const staleDue = createNotificationItem({
    id: 'stale-due',
    reasons: ['due'],
  })
  const retainedMention = createNotificationItem({
    id: 'retained-mention',
    reasons: ['assignment', 'mention'],
  })
  const probe = createNotificationVisibilityProbe([staleAssignment, staleDue, retainedMention])
  setTestAppDependencies({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(staleAssignment.id)).toBe(false)
  expect(probe.visibility.get(staleDue.id)).toBe(false)
  expect(probe.visibility.get(retainedMention.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: retainedMention.id }],
    unreadCount: 1,
  })
})
