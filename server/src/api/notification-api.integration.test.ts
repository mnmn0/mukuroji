import {
  createApiTestHarness,
} from './test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createNotificationItem,
  createNotificationVisibilityProbe,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageEntry,
} from '@mukuroji/contracts'
import type { TriageCompositionClient } from '../app/composition/app-dependencies'
import type {
  NotificationClient,
} from '../modules/notifications'
import { createTriageCapabilities } from '../modules/triage'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Stable instant used by Triage notification visibility fixtures. */
const TRIAGE_NOW = '2026-08-09T00:00:00.000Z'

/**
 * Creates a canonical Triage Entry for current-scope notification checks.
 *
 * @param id - Stable entry identifier.
 * @param overrides - Fields changed for the focused visibility scenario.
 * @returns A complete canonical Triage Entry.
 */
function createNotificationTriageEntry(
  id: string,
  overrides: Partial<TriageEntry> = {},
): TriageEntry {
  const permission = overrides.permission ?? {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: TRIAGE_NOW,
  }
  const state = overrides.state ?? 'pending'
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id,
    workspaceId: 'user#demo@example.com',
    source: {
      kind: 'chat',
      sourceId: `source-${id}`,
      provider: 'slack',
      containerId: 'channel-1',
      messageId: `message-${id}`,
    },
    sourcePreview: {
      title: `Triage ${id}`,
      body: 'Sensitive source body.',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Requester', guest: true },
    receivedAt: TRIAGE_NOW,
    lastActivityAt: TRIAGE_NOW,
    state,
    routing: { reason: 'Matched a Team rule.', candidates: [] },
    teamId: 'core-team',
    projectId: 'project-a',
    ownerUserId: 'demo@example.com',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state, permission }),
    events: [],
    revision: 1,
    createdAt: TRIAGE_NOW,
    updatedAt: TRIAGE_NOW,
    ...overrides,
  }
}

/**
 * Creates a read-focused Triage composition client for notification checks.
 *
 * @param entries - Canonical entries addressable by ID.
 * @returns A complete client whose unrelated operations fail fast.
 */
function createNotificationTriageClient(
  entries: ReadonlyMap<string, TriageEntry>,
): TriageCompositionClient {
  const unsupported = async () => {
    throw new Error('Unexpected Triage client call in notification visibility test.')
  }
  const getEntry = async (_workspaceId: string, _teamId: string, entryId: string) => {
    const entry = entries.get(entryId)
    if (!entry) {
      throw new Error(`Missing Triage notification fixture: ${entryId}`)
    }
    return entry
  }
  return {
    listEntries: unsupported,
    getEntry,
    getEntryForMutation: getEntry,
    applyAction: unsupported,
    getActionReceipt: unsupported,
    applyBulkAction: unsupported,
    getConfiguration: unsupported,
    getConfigurationUpdateReceipt: unsupported,
    updateConfiguration: unsupported,
    createManualHandoff: unsupported,
    listWorkItemSources: unsupported,
  }
}

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

test('rechecks Triage Project scope and redacts denied or retained source content', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'project-a', role: 'viewer' }],
    teamProjects: [
      { id: 'project-a', name: 'Project A', tone: 'blue' },
      { id: 'project-b', name: 'Project B', tone: 'purple' },
    ],
  })
  const moved = createNotificationTriageEntry('triage-moved', {
    projectId: 'project-b',
    sourcePreview: {
      title: 'CURRENT_PRIVATE_TRIAGE_TITLE',
      body: 'CURRENT_PRIVATE_TRIAGE_BODY',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
  })
  const deniedPermission = {
    visibility: 'denied',
    canReply: false,
    guestVisible: false,
    checkedAt: TRIAGE_NOW,
  } satisfies TriageEntry['permission']
  const denied = createNotificationTriageEntry('triage-denied', {
    permission: deniedPermission,
    sourcePreview: {
      title: 'CURRENT_DENIED_TRIAGE_TITLE',
      body: 'CURRENT_DENIED_TRIAGE_BODY',
      attachmentCount: 1,
      commentCount: 1,
      watcherCount: 1,
      sanitized: true,
      truncated: false,
    },
    capabilities: createTriageCapabilities({
      state: 'pending',
      permission: deniedPermission,
    }),
  })
  const retained = createNotificationTriageEntry('triage-retained', {
    ownerUserId: 'DEMO@EXAMPLE.COM',
    sourcePreview: {
      title: 'CURRENT_RETAINED_TRIAGE_TITLE',
      body: 'CURRENT_RETAINED_TRIAGE_BODY',
      attachmentCount: 1,
      commentCount: 1,
      watcherCount: 1,
      sanitized: true,
      truncated: false,
    },
    retention: {
      expiresAt: '2026-08-08T00:00:00.000Z',
      redactedAt: TRIAGE_NOW,
    },
  })
  const staleOwner = createNotificationTriageEntry('triage-stale-owner', {
    ownerUserId: 'new-owner@example.com',
  })
  const movedNotification = createNotificationItem({
    id: 'triage-moved-notification',
    issueId: undefined,
    triageEntryId: moved.id,
    projectId: 'project-a',
    reasons: ['triage-sla'],
    title: 'HISTORICAL_MOVED_TRIAGE_TITLE',
    summary: 'HISTORICAL_MOVED_TRIAGE_SUMMARY',
  })
  const deniedNotification = createNotificationItem({
    id: 'triage-denied-notification',
    issueId: undefined,
    triageEntryId: denied.id,
    projectId: 'project-a',
    reasons: ['triage-sla'],
    title: 'HISTORICAL_DENIED_TRIAGE_TITLE',
    summary: 'HISTORICAL_DENIED_TRIAGE_SUMMARY',
  })
  const retainedNotification = createNotificationItem({
    id: 'triage-retained-notification',
    issueId: undefined,
    triageEntryId: retained.id,
    projectId: 'project-a',
    reasons: ['triage-sla'],
    title: 'HISTORICAL_RETAINED_TRIAGE_TITLE',
    summary: 'HISTORICAL_RETAINED_TRIAGE_SUMMARY',
  })
  const staleOwnerNotification = createNotificationItem({
    id: 'triage-stale-owner-notification',
    issueId: undefined,
    triageEntryId: staleOwner.id,
    projectId: 'project-a',
    reasons: ['triage-sla'],
  })
  const probe = createNotificationVisibilityProbe([
    movedNotification,
    deniedNotification,
    retainedNotification,
    staleOwnerNotification,
  ])
  setTestAppDependencies({
    notifications: probe.client,
    triage: createNotificationTriageClient(new Map([
      [moved.id, moved],
      [denied.id, denied],
      [retained.id, retained],
      [staleOwner.id, staleOwner],
    ])),
  })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const body: unknown = await response.json()
  const serializedBody = JSON.stringify(body)

  expect(response.status).toBe(200)
  expect(probe.visibility.get(movedNotification.id)).toBe(false)
  expect(probe.visibility.get(deniedNotification.id)).toBe(true)
  expect(probe.visibility.get(retainedNotification.id)).toBe(true)
  expect(probe.visibility.get(staleOwnerNotification.id)).toBe(false)
  expect(body).toMatchObject({
    notifications: [
      { id: deniedNotification.id, title: 'Restricted source' },
      { id: retainedNotification.id, title: 'Restricted source' },
    ],
    unreadCount: 2,
  })
  for (const secretMarker of [
    'CURRENT_PRIVATE_TRIAGE',
    'HISTORICAL_MOVED_TRIAGE',
    'CURRENT_DENIED_TRIAGE',
    'HISTORICAL_DENIED_TRIAGE',
    'CURRENT_RETAINED_TRIAGE',
    'HISTORICAL_RETAINED_TRIAGE',
  ]) {
    expect(serializedBody).not.toContain(secretMarker)
  }
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
