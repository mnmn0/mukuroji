import { afterEach, expect, test } from 'bun:test'
import {
  NotificationError,
  type NotificationClient,
  type NotificationItem,
} from '../notifications'
import { createFileProofingScopeKey, type FileProofingScope } from '../files'
import { ProjectDataError } from '../directory'
import type { CollaborationClient } from '../collaboration'
import {
  InMemoryPlanningClient,
  type PlanningWorkItemState,
} from '../planning/planning'
import { InMemoryEnterpriseIdentityClient } from '../enterprise-identity/enterprise-identity'
import { createInMemoryDeveloperPlatformAdapters } from '../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import { InMemoryFocusStateClient } from './focus-state'
import { createApiTestHarness } from '../../api/test-support/api-test-harness'
import {
  createDefaultDueDateWorkItemSchedule,
  type EnterprisePermissionId,
} from '@mukuroji/contracts'

const {
  app,
  configureFakeAuthenticatedUser,
  configureFakeProjectClients,
  createAccessToken,
  createApprovalRequestFixture,
  createCollaborationStub,
  createCyclePlanningInput,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createNotificationItem,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

/** Monotonic per-test suffix used for default mutation idempotency keys. */
let focusMutationRequestSequence = 0

afterEach(() => {
  resetTestApp()
  focusMutationRequestSequence = 0
})

/**
 * Returns one complete watcher state used by Focus integration fixtures.
 *
 * @param subscribed - Whether the viewer currently watches the Work Item.
 * @returns Complete collaboration watcher state.
 */
function createWatcherState(subscribed: boolean) {
  return {
    subscribed,
    explicit: subscribed,
    automatic: false,
    reasons: subscribed ? ['manual'] : [],
    watcherCount: subscribed ? 1 : 0,
  }
}

/**
 * Creates one mention notification bound to the canonical fixture Work Item.
 *
 * @param eventId - Immutable notification event identifier.
 * @param state - Current Inbox presentation state.
 * @returns Render-ready notification source.
 */
function createFocusMention(
  eventId: string,
  state: NotificationItem['state'],
): NotificationItem {
  return createNotificationItem({
    id: `notification-${eventId}-${state}`,
    eventId,
    eventType: 'comment.mentioned',
    entityId: 'onboarding-friction',
    reasons: ['mention'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'onboarding-friction',
    deepLink: '/teams/core-team/issues/onboarding-friction?comment=mention',
    occurredAt: '2026-08-01T00:00:00.000Z',
    state,
  })
}

/**
 * Creates a paginated notification port spanning every Inbox state partition.
 *
 * @param calls - Mutable call log populated with filter and cursor identities.
 * @returns Notification client that applies the route-supplied visibility predicate.
 */
function createFocusNotificationClient(calls: string[]): NotificationClient {
  const unread = createFocusMention('event-unread', 'unread')
  const read = createFocusMention('event-read', 'read')
  const archived = createFocusMention('event-archived', 'archived')
  const snoozed = createFocusMention('event-snoozed', 'snoozed')

  return {
    async list(input) {
      const key = `${input.filter ?? 'all'}:${input.cursor ?? ''}`
      calls.push(key)
      const candidates = key === 'all:'
        ? [unread]
        : key === 'all:all-next'
          ? [read, unread]
          : key === 'archived:'
            ? [archived, read]
            : key === 'snoozed:'
              ? [snoozed]
              : []
      const notifications: NotificationItem[] = []
      for (const notification of candidates) {
        if (!input.isVisible || await input.isVisible(notification)) {
          notifications.push(notification)
        }
      }
      return {
        notifications,
        ...(key === 'all:' ? { nextCursor: 'all-next' } : {}),
      }
    },
    async countUnread() {
      return 0
    },
    async update() {
      throw new Error('Notification mutation is not expected in Focus API tests.')
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '07:00',
          timeZone: 'UTC',
        },
      }
    },
    async savePreferences(input) {
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-08-01T00:00:00.000Z',
      }
    },
  }
}

/**
 * Creates mention pages whose deduplicated cross-partition window exceeds the Focus limit.
 *
 * @returns Notification client exposing 201 unique recent mention events within page budgets.
 */
function createOversizedFocusNotificationClient(): NotificationClient {
  const base = createFocusNotificationClient([])
  const all = Array.from({ length: 200 }, (_, index) =>
    createFocusMention(`event-window-${index}`, 'unread')
  )
  const archived = [createFocusMention('event-window-200', 'archived')]
  return {
    ...base,
    async list(input) {
      const source = input.filter === 'all'
        ? all
        : input.filter === 'archived'
          ? archived
          : []
      const offset = input.cursor === undefined ? 0 : Number(input.cursor)
      const page = source.slice(offset, offset + 50)
      const notifications: NotificationItem[] = []
      for (const notification of page) {
        if (!input.isVisible || await input.isVisible(notification)) {
          notifications.push(notification)
        }
      }
      const nextOffset = offset + page.length
      return {
        notifications,
        ...(nextOffset < source.length ? { nextCursor: String(nextOffset) } : {}),
      }
    },
  }
}

/**
 * Configures canonical Work Item, notification, approval, and watcher Focus sources.
 *
 * @param role - Legacy Project role granted to the current viewer.
 * @param detailReadHook - Optional hook used to simulate authorization loss.
 * @param teamIssueCount - Number of visible canonical Work Items returned by the fixture.
 * @param workspaceRole - Workspace membership role used by the authorization fixture.
 * @returns Captured source calls and the isolated idempotency adapters.
 */
function configureFocusSources(
  role: 'viewer' | 'member' | 'manager' = 'member',
  detailReadHook?: (issueId: string) => Promise<void>,
  teamIssueCount = 1,
  workspaceRole: 'member' | 'guest' = 'member',
) {
  configureFakeProjectClients(true, {
    role,
    workspaceRole,
    teamIssueCount,
    ...(detailReadHook === undefined ? {} : { detailReadHook }),
  })
  const notificationCalls: string[] = []
  const watcherMutations: string[] = []
  const watcherExpectedStates: Array<boolean | undefined> = []
  let watching = false
  let watcherMutationIdentity: string | undefined
  let watcherUpdatedAt: string | undefined
  const developerPlatform = createInMemoryDeveloperPlatformAdapters()
  setTestAppDependencies({
    idempotency: developerPlatform.idempotency,
    notifications: createFocusNotificationClient(notificationCalls),
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        return { approvals: [] }
      },
    }),
    collaboration: createCollaborationStub({
      async getWatcherState() {
        return createWatcherState(watching)
      },
      async getMemberWatcherState() {
        return {
          ...createWatcherState(watching),
          ...(watcherMutationIdentity === undefined
            ? {}
            : { mutationIdentity: watcherMutationIdentity }),
          ...(watcherUpdatedAt === undefined ? {} : { updatedAt: watcherUpdatedAt }),
        }
      },
      async subscribe(input) {
        watcherMutations.push('subscribe')
        watcherExpectedStates.push(input.expectedSubscribed)
        watching = true
        watcherMutationIdentity = input.mutationIdentity
        watcherUpdatedAt = input.auditContext?.occurredAt
        return {
          ...createWatcherState(watching),
          ...(watcherMutationIdentity === undefined
            ? {}
            : { mutationIdentity: watcherMutationIdentity }),
          ...(watcherUpdatedAt === undefined ? {} : { updatedAt: watcherUpdatedAt }),
        }
      },
      async unsubscribe(input) {
        watcherMutations.push('unsubscribe')
        watcherExpectedStates.push(input.expectedSubscribed)
        watching = false
        watcherMutationIdentity = input.mutationIdentity
        watcherUpdatedAt = input.auditContext?.occurredAt
        return {
          ...createWatcherState(watching),
          ...(watcherMutationIdentity === undefined
            ? {}
            : { mutationIdentity: watcherMutationIdentity }),
          ...(watcherUpdatedAt === undefined ? {} : { updatedAt: watcherUpdatedAt }),
        }
      },
    }),
  })
  return {
    developerPlatform,
    notificationCalls,
    watcherMutations,
    watcherExpectedStates,
  }
}

/**
 * Wraps one idempotency adapter with a transient first completion failure.
 *
 * @param delegate - Durable in-memory adapter that retains reservations and receipts.
 * @returns Adapter whose first receipt completion fails before delegating later calls.
 */
function createSingleCompletionFailure(
  delegate: ReturnType<typeof createInMemoryDeveloperPlatformAdapters>['idempotency'],
) {
  let shouldFailCompletion = true
  return {
    reserveIdempotency(request: Parameters<typeof delegate.reserveIdempotency>[0]) {
      return delegate.reserveIdempotency(request)
    },
    completeIdempotency(request: Parameters<typeof delegate.completeIdempotency>[0]) {
      if (shouldFailCompletion) {
        shouldFailCompletion = false
        return Promise.reject(new Error('Simulated Focus receipt completion failure.'))
      }
      return delegate.completeIdempotency(request)
    },
    releaseIdempotency(request: Parameters<typeof delegate.releaseIdempotency>[0]) {
      return delegate.releaseIdempotency(request)
    },
  }
}

/**
 * Creates one applied Enterprise directory grant for a Focus Work Item scope.
 *
 * @param scopeKind - Whether the custom permission is granted at Team or Project scope.
 * @param permissions - Enterprise permissions carried by the mapped custom role.
 * @returns Enterprise identity client containing the applied directory mapping.
 */
async function createFocusEnterpriseIdentity(
  scopeKind: 'team' | 'project',
  permissions: readonly EnterprisePermissionId[] = ['work-items.read'],
): Promise<InMemoryEnterpriseIdentityClient> {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putIdentityProvider({
    workspaceId,
    providerId: `focus-${scopeKind}-idp`,
    kind: 'oidc',
    displayName: `Focus ${scopeKind} directory`,
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:focus-work-item-access',
    name: 'Focus Work Item access',
    permissions: [...permissions],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: `focus-${scopeKind}-idp`,
    externalId: `focus-${scopeKind}-user`,
    userName: 'sato@example.com',
    emails: ['sato@example.com'],
    active: true,
    linkedMemberKey: 'sato@example.com',
    idempotencyKey: `focus-${scopeKind}-user`,
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: `focus-${scopeKind}-idp`,
    externalId: `focus-${scopeKind}-group`,
    displayName: `Focus ${scopeKind} readers`,
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: `focus-${scopeKind}-group`,
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (desiredUser === undefined) throw new Error('Expected the Focus SCIM user to exist.')
  await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
  await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
  await identity.putGroupMapping({
    workspaceId,
    mappingId: `focus-${scopeKind}-mapping`,
    identityProviderId: `focus-${scopeKind}-idp`,
    directoryGroupId: group.groupId,
    roleId: 'custom:focus-work-item-access',
    scope: {
      workspaceId,
      kind: scopeKind,
      targetId: scopeKind === 'team' ? 'core-team' : 'refero',
    },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now,
  })
  return identity
}

/**
 * Grants the existing Focus test role to one additional Team.
 *
 * @param identity - Enterprise identity fixture created for a Team-scoped grant.
 * @param teamId - Additional Team made visible to the mapped principal.
 */
async function addFocusEnterpriseTeamMapping(
  identity: InMemoryEnterpriseIdentityClient,
  teamId: string,
): Promise<void> {
  const workspaceId = 'user#demo@example.com'
  const snapshot = await identity.getSnapshot(workspaceId)
  const group = snapshot.scimGroups.find((candidate) => candidate.active)
  if (group === undefined) throw new Error('Expected one active Focus SCIM group.')
  await identity.putGroupMapping({
    workspaceId,
    mappingId: `focus-team-mapping-${teamId}`,
    identityProviderId: 'focus-team-idp',
    directoryGroupId: group.groupId,
    roleId: 'custom:focus-work-item-access',
    scope: { workspaceId, kind: 'team', targetId: teamId },
    enabled: true,
    priority: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * Sends one authenticated Focus request with optional JSON.
 *
 * @param path - Focus route path.
 * @param method - HTTP method.
 * @param body - Optional JSON request body.
 * @param idempotencyKey - Optional stable mutation key used for retry tests.
 * @returns HTTP response from the isolated test application.
 */
function focusRequest(
  path: string,
  method = 'GET',
  body?: unknown,
  idempotencyKey?: string,
) {
  const resolvedIdempotencyKey = method === 'PUT'
    ? idempotencyKey ?? `focus-mutation-${focusMutationRequestSequence += 1}`
    : undefined
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(resolvedIdempotencyKey === undefined
        ? {}
        : { 'Idempotency-Key': resolvedIdempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Finds one projected item by its canonical Work Item identifier.
 *
 * @param value - Unknown Focus queue response.
 * @param workItemId - Canonical Work Item identifier to locate.
 * @returns Narrowed matching item record.
 */
function readFocusItem(value: unknown, workItemId: string): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.sections)) {
    throw new Error('Expected a Focus queue response.')
  }
  for (const section of value.sections) {
    if (!isRecord(section) || !Array.isArray(section.items)) continue
    for (const item of section.items) {
      if (
        isRecord(item) &&
        isRecord(item.workItem) &&
        item.workItem.id === workItemId
      ) return item
    }
  }
  throw new Error(`Expected Focus item ${workItemId}.`)
}

/** Returns whether an unknown value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads one required numeric property from a narrowed response record.
 *
 * @param value - Response record containing the numeric property.
 * @param property - Property name to read.
 * @returns Valid numeric property value.
 */
function readNumberProperty(
  value: Record<string, unknown>,
  property: string,
): number {
  const result = value[property]
  if (typeof result !== 'number') {
    throw new Error(`Expected numeric Focus property ${property}.`)
  }
  return result
}

/** Creates a valid Focus snooze wake time relative to the current test clock. */
function createFocusSnoozeTime(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString()
}

test('projects visible notifications from every Inbox state and deduplicates event IDs', async () => {
  const { notificationCalls } = configureFocusSources()

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    schemaVersion: 1,
    viewerMemberKey: 'demo@example.com',
    metrics: { blocked: 0 },
    sections: [
      { section: 'now' },
      { section: 'next' },
      { section: 'waiting' },
      { section: 'snoozed' },
      { section: 'done' },
    ],
  })
  const item = readFocusItem(body, 'onboarding-friction')
  expect(item).toMatchObject({
    version: expect.any(Number),
    snoozeRevision: 0,
    watching: false,
    workItem: {
      id: 'onboarding-friction',
      teamId: 'core-team',
    },
    capabilities: {
      complete: true,
      snooze: true,
      watch: true,
      openSource: true,
    },
  })
  if (!Array.isArray(item.signals)) throw new Error('Expected Focus signals.')
  expect(item.signals).toHaveLength(4)
  expect(item.signals.map((signal) => {
    if (!isRecord(signal) || !isRecord(signal.source)) return undefined
    return signal.source.eventId
  }).sort()).toEqual([
    'event-archived',
    'event-read',
    'event-snoozed',
    'event-unread',
  ])
  expect(item.signals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      permission: { canOpenSource: true },
    }),
  ]))
  expect(notificationCalls).toEqual([
    'all:',
    'all:all-next',
    'archived:',
    'snoozed:',
  ])
})

test('fails closed when mention history exceeds the four-page source window', async () => {
  configureFocusSources()
  const notificationCalls: string[] = []
  const currentTime = Date.now()
  const recentMentions = Array.from({ length: 15 }, (_, index) => ({
    ...createFocusMention(`bounded-event-${index}`, 'unread'),
    occurredAt: new Date(currentTime - index * 1_000).toISOString(),
  }))
  const expiredMention = {
    ...createFocusMention('expired-event', 'unread'),
    occurredAt: new Date(currentTime - 100 * 24 * 60 * 60 * 1_000).toISOString(),
  }
  const notificationClient = createFocusNotificationClient([])
  setTestAppDependencies({
    notifications: {
      ...notificationClient,
      async list(input) {
        notificationCalls.push(`${input.filter ?? 'all'}:${input.cursor ?? ''}`)
        const candidates = input.filter === 'all' && input.cursor === undefined
          ? [...recentMentions, expiredMention]
          : []
        const notifications: NotificationItem[] = []
        for (const notification of candidates) {
          if (!input.isVisible || await input.isVisible(notification)) {
            notifications.push(notification)
          }
        }
        return {
          notifications,
          nextCursor: `${input.filter ?? 'all'}:${notificationCalls.length}`,
        }
      },
    },
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    code: 'FocusNotificationReadLimitExceeded',
  })
  expect(notificationCalls.filter((call) => call.startsWith('all:'))).toHaveLength(4)
  expect(notificationCalls.filter((call) => call.startsWith('archived:'))).toHaveLength(0)
  expect(notificationCalls.filter((call) => call.startsWith('snoozed:'))).toHaveLength(0)
})

test('fails closed when deduplicated mentions exceed the cross-partition limit', async () => {
  configureFocusSources()
  setTestAppDependencies({ notifications: createOversizedFocusNotificationClient() })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    code: 'FocusNotificationReadLimitExceeded',
  })
})

test('surfaces stalled notification snooze maintenance through Focus', async () => {
  configureFocusSources()
  const notificationClient = createFocusNotificationClient([])
  setTestAppDependencies({
    notifications: {
      ...notificationClient,
      async list() {
        throw new NotificationError(
          503,
          'NotificationSnoozeWakeCursorStalled',
          'Expired notification snooze maintenance cursor stopped advancing.',
        )
      },
    },
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    code: 'NotificationSnoozeWakeCursorStalled',
  })
})

test('bounds a complete mention window by age and Work Item count', async () => {
  configureFocusSources()
  const currentTime = Date.now()
  const recentMentions = Array.from({ length: 15 }, (_, index) => ({
    ...createFocusMention(`bounded-event-${index}`, 'unread'),
    occurredAt: new Date(currentTime - index * 1_000).toISOString(),
  }))
  const expiredMention = {
    ...createFocusMention('expired-event', 'unread'),
    occurredAt: new Date(currentTime - 100 * 24 * 60 * 60 * 1_000).toISOString(),
  }
  const notificationClient = createFocusNotificationClient([])
  setTestAppDependencies({
    notifications: {
      ...notificationClient,
      async list(input) {
        const candidates = input.filter === 'all' ? [...recentMentions, expiredMention] : []
        const notifications: NotificationItem[] = []
        for (const notification of candidates) {
          if (!input.isVisible || await input.isVisible(notification)) {
            notifications.push(notification)
          }
        }
        return { notifications }
      },
    },
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  const item = readFocusItem(await response.json(), 'onboarding-friction')
  if (!Array.isArray(item.signals)) throw new Error('Expected Focus signals.')
  const mentionEventIds = item.signals.flatMap((signal) =>
    isRecord(signal) && signal.type === 'mention' &&
      isRecord(signal.source) && typeof signal.source.eventId === 'string'
      ? [signal.source.eventId]
      : []
  ).sort()
  expect(mentionEventIds).toEqual(
    Array.from({ length: 10 }, (_, index) => `bounded-event-${index}`).sort(),
  )
})

test('bounds watcher point reads to the accessible Focus item window', async () => {
  configureFocusSources('member', undefined, 200)
  configureFakeAuthenticatedUser({
    email: 'sato@example.com',
    'custom:directory_id': 'user#demo@example.com',
  })
  let watcherReads = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getMemberWatcherState() {
        watcherReads += 1
        return createWatcherState(false)
      },
    }),
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.sections)) {
    throw new Error('Expected Focus sections.')
  }
  const itemCount = body.sections.reduce((count, section) => {
    if (!isRecord(section) || !Array.isArray(section.items)) return count
    return count + section.items.length
  }, 0)
  expect(itemCount).toBe(200)
  expect(watcherReads).toBe(200)
})

test('drops Focus mention notifications whose collaboration source was removed', async () => {
  configureFocusSources()
  const notification = {
    ...createFocusMention('deleted-source-event', 'unread'),
    commentId: 'deleted-comment',
  }
  const notificationClient = createFocusNotificationClient([])
  setTestAppDependencies({
    notifications: {
      ...notificationClient,
      async list(input) {
        if (input.filter !== 'all') return { notifications: [] }
        if (input.isVisible && !(await input.isVisible(notification))) {
          return { notifications: [] }
        }
        return { notifications: [notification] }
      },
    },
    collaboration: createCollaborationStub({
      async getCommentSnapshot() {
        return undefined
      },
    }),
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.sections)) {
    throw new Error('Expected Focus sections.')
  }
  const containsDeletedSourceItem = body.sections.some((section) => {
    if (!isRecord(section) || !Array.isArray(section.items)) return false
    return section.items.some((item) =>
      isRecord(item) &&
      isRecord(item.workItem) &&
      item.workItem.id === 'onboarding-friction'
    )
  })
  expect(containsDeletedSourceItem).toBeFalse()
})

test('bounds reviewer approval pagination to the Focus source window', async () => {
  configureFocusSources()
  let approvalPageReads = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        approvalPageReads += 1
        return {
          approvals: Array.from({ length: 100 }, (_, index) =>
            createApprovalRequestFixture({
              id: `bounded-approval-${approvalPageReads}-${index}`,
              issueId: 'onboarding-friction',
              projectId: 'refero',
            })),
          nextCursor: `approval-page-${approvalPageReads}`,
        }
      },
    }),
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'FocusApprovalReadLimitExceeded' })
  expect(approvalPageReads).toBe(4)
})

test('shares the four-page approval budget across nested authorization filtering', async () => {
  configureFocusSources()
  let approvalPageReads = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        approvalPageReads += 1
        return {
          approvals: [createApprovalRequestFixture({
            id: `inaccessible-approval-${approvalPageReads}`,
            teamId: 'hidden-team',
            issueId: 'hidden-work-item',
          })],
          nextCursor: `inaccessible-page-${approvalPageReads}`,
        }
      },
    }),
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'FocusApprovalReadLimitExceeded' })
  expect(approvalPageReads).toBe(4)
})

test('hydrates owned Work Items with permission-safe approval summaries', async () => {
  await withTestEnvironment({ FILE_PROOFING_TABLE_NAME: 'focus-api-test' }, async () => {
    configureFocusSources()
    configureFakeAuthenticatedUser({
      email: 'sato@example.com',
      'custom:directory_id': 'user#demo@example.com',
    })
    const summaryScope: FileProofingScope = {
      workspaceId: 'user#demo@example.com',
      teamId: 'core-team',
      kind: 'work-item',
      issueId: 'onboarding-friction',
    }
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async getApprovalSummaries(scopes) {
          expect(scopes).toEqual([summaryScope])
          return new Map([[
            createFileProofingScopeKey(summaryScope),
            {
              pendingCount: 1,
              overdueCount: 0,
              approvedCount: 0,
              rejectedCount: 0,
              changesRequestedCount: 0,
              nextDueAt: '2099-08-15T00:00:00.000Z',
            },
          ]])
        },
        async listReviewerApprovals() {
          return { approvals: [] }
        },
      }),
    })

    const response = await focusRequest('/api/focus')

    expect(response.status).toBe(200)
    const item = readFocusItem(await response.json(), 'onboarding-friction')
    expect(item.workItem).toMatchObject({
      approvalSummary: { pendingCount: 1 },
    })
    if (!Array.isArray(item.signals)) throw new Error('Expected Focus signals.')
    expect(item.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval',
        source: expect.objectContaining({ kind: 'approval' }),
      }),
    ]))
  })
})

test('supports scoped Enterprise Focus reads while omitting unauthorized source signals', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    FILE_PROOFING_TABLE_NAME: 'focus-api-test',
  }, async () => {
    configureFocusSources()
    configureFakeAuthenticatedUser({
      email: 'sato@example.com',
      'custom:directory_id': 'user#demo@example.com',
    })
    const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
    const planningWorkItems: PlanningWorkItemState = {
      workItems: [{
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: '初回オンボーディングの離脱要因を減らす',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      }],
    }
    const planning = new InMemoryPlanningClient()
    await planning.create(
      'user#demo@example.com',
      createCyclePlanningInput('focus-private-cycle', 0),
      planningWorkItems,
    )
    await planning.putWorkItemLink('user#demo@example.com', {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'focus-private-cycle',
      goalIds: [],
      expectedRevision: 1,
    }, planningWorkItems)
    let approvalPageReads = 0
    let approvalSummaryReads = 0
    const approval = createApprovalRequestFixture({
      issueId: 'onboarding-friction',
      projectId: 'refero',
      reviewers: [{ memberKey: 'sato@example.com', status: 'pending' }],
    })
    setTestAppDependencies({
      planning,
      fileProofing: createFileProofingStub({
        async getApprovalSummaries(scopes) {
          approvalSummaryReads += 1
          return new Map(scopes.map((scope) => [
            createFileProofingScopeKey(scope),
            {
              pendingCount: 1,
              overdueCount: 0,
              approvedCount: 0,
              rejectedCount: 0,
              changesRequestedCount: 0,
            },
          ]))
        },
        async listReviewerApprovals() {
          approvalPageReads += 1
          return { approvals: [approval] }
        },
      }),
    })
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`

    const scopeKinds: Array<'team' | 'project'> = ['team', 'project']
    for (const scopeKind of scopeKinds) {
      setTestAppDependencies({
        enterpriseIdentity: await createFocusEnterpriseIdentity(scopeKind),
      })
      const response = await app.request('/api/focus', {
        headers: { Authorization: authorization },
      })

      expect(response.status).toBe(200)
      const item = readFocusItem(await response.json(), 'onboarding-friction')
      if (!Array.isArray(item.signals)) throw new Error('Expected Focus signals.')
      expect(item.signals.some((signal) =>
        isRecord(signal) &&
        isRecord(signal.source) &&
        ['approval', 'planning-cycle', 'review-request'].includes(
          String(signal.source.kind),
        )
      )).toBeFalse()
      expect(isRecord(item.workItem) && 'approvalSummary' in item.workItem).toBeFalse()
    }
    expect(approvalPageReads).toBe(0)
    expect(approvalSummaryReads).toBe(0)
  })
})

test('requires Enterprise Work Item write permission for Focus watch mutations', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    const { watcherMutations } = configureFocusSources()
    configureFakeAuthenticatedUser({
      email: 'sato@example.com',
      'custom:directory_id': 'user#demo@example.com',
    })
    setTestAppDependencies({
      enterpriseIdentity: await createFocusEnterpriseIdentity('project'),
    })
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const currentResponse = await app.request('/api/focus', {
      headers: { Authorization: authorization },
    })

    expect(currentResponse.status).toBe(200)
    const current = readFocusItem(
      await currentResponse.json(),
      'onboarding-friction',
    )
    expect(current).toMatchObject({ capabilities: { watch: false } })
    const response = await app.request(
      '/api/focus/items/core-team/onboarding-friction/watch',
      {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'focus-enterprise-watch-denied',
        },
        body: JSON.stringify({
          expectedVersion: readNumberProperty(current, 'version'),
          watching: true,
        }),
      },
    )

    expect(response.status).toBe(403)
    expect(watcherMutations).toEqual([])

    setTestAppDependencies({
      enterpriseIdentity: await createFocusEnterpriseIdentity(
        'project',
        ['work-items.read', 'work-items.write'],
      ),
    })
    const writableResponse = await app.request('/api/focus', {
      headers: { Authorization: authorization },
    })
    const writable = readFocusItem(
      await writableResponse.json(),
      'onboarding-friction',
    )
    expect(writable).toMatchObject({ capabilities: { watch: true } })

    const writableMutation = await app.request(
      '/api/focus/items/core-team/onboarding-friction/watch',
      {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'focus-enterprise-watch-allowed',
        },
        body: JSON.stringify({
          expectedVersion: readNumberProperty(writable, 'version'),
          watching: true,
        }),
      },
    )

    expect(writableMutation.status).toBe(200)
    expect(watcherMutations).toEqual(['subscribe'])
  })
})

test('does not expose Focus snooze responses to Enterprise write-only grants', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    configureFocusSources()
    configureFakeAuthenticatedUser({
      email: 'sato@example.com',
      'custom:directory_id': 'user#demo@example.com',
    })
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const scenarios: Array<{
      permissions: EnterprisePermissionId[]
      scopeKind: 'team' | 'project'
    }> = [
      { permissions: ['work-items.write'], scopeKind: 'project' },
      { permissions: ['teams.manage'], scopeKind: 'team' },
    ]

    for (const scenario of scenarios) {
      setTestAppDependencies({
        enterpriseIdentity: await createFocusEnterpriseIdentity(
          scenario.scopeKind,
          scenario.permissions,
        ),
      })
      const response = await app.request(
        '/api/focus/items/core-team/onboarding-friction/snooze',
        {
          method: 'PUT',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            'Idempotency-Key': `focus-enterprise-snooze-${scenario.scopeKind}`,
          },
          body: JSON.stringify({ expectedVersion: 0, snoozedUntil: null }),
        },
      )

      expect(response.status).toBe(403)
      expect(await response.json()).not.toHaveProperty('item')
    }
  })
})

test('reads each visible Team relation graph once and removes hidden endpoints', async () => {
  configureFocusSources('member', undefined, 2)
  configureFakeAuthenticatedUser({
    email: 'sato@example.com',
    'custom:directory_id': 'user#demo@example.com',
  })
  const relationGraphReads: string[] = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelationGraph(workspaceId, teamId) {
        relationGraphReads.push(`${workspaceId}:${teamId}`)
        return {
          graphRevision: 7,
          relations: [
            {
              sourceWorkItemId: 'onboarding-friction',
              type: 'blockedBy',
              targetWorkItemId: 'work-item-1',
              createdAt: '2026-07-31T10:00:00.000Z',
            },
            {
              sourceWorkItemId: 'onboarding-friction',
              type: 'blockedBy',
              targetWorkItemId: 'hidden-work-item',
              createdAt: '2026-07-30T10:00:00.000Z',
            },
          ],
        }
      },
    }),
  })

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ metrics: { blocked: 1 } })
  const item = readFocusItem(body, 'onboarding-friction')
  if (!Array.isArray(item.signals)) throw new Error('Expected Focus signals.')
  const blockers = item.signals.filter((signal) =>
    isRecord(signal) && signal.type === 'blocker'
  )
  expect(blockers).toHaveLength(1)
  expect(blockers[0]).toMatchObject({
    source: {
      kind: 'work-item-relation',
      occurredAt: '2026-07-31T10:00:00.000Z',
    },
    permission: { canOpenSource: true },
  })
  expect(relationGraphReads).toEqual(['user#demo@example.com:core-team'])
})

test('validates and version-checks user policy replacements', async () => {
  configureFocusSources('manager')
  const input = {
    target: { type: 'user' },
    expectedVersion: 0,
    overrides: {
      weights: { urgent: 123 },
      dueSoonDays: 4,
    },
  }

  const response = await focusRequest('/api/focus/policies', 'PUT', input)

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    policy: {
      target: { type: 'user' },
      version: 1,
      overrides: input.overrides,
    },
    effectivePolicies: [{
      teamId: 'core-team',
      settings: {
        dueSoonDays: 4,
        weights: { urgent: 123 },
      },
    }],
  })

  const conflict = await focusRequest('/api/focus/policies', 'PUT', input)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'FocusStateConflict' })

  const invalid = await focusRequest('/api/focus/policies', 'PUT', {
    target: { type: 'user', userId: 'another@example.com' },
    expectedVersion: 1,
    overrides: { dueSoonDays: 1.5 },
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidFocusInput' })
})

test('replays a lost-response policy retry and rejects key reuse with another payload', async () => {
  configureFocusSources('manager')
  const focusState = new InMemoryFocusStateClient()
  setTestAppDependencies({ focusState })
  const input = {
    target: { type: 'user' as const },
    expectedVersion: 0,
    overrides: { dueSoonDays: 6 },
  }
  const idempotencyKey = 'focus-policy-lost-response'

  const first = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(200)
  const firstBody: unknown = await first.json()

  const retry = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toEqual(firstBody)
  expect((await focusState.getState({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamIds: ['core-team'],
  })).userPolicy).toMatchObject({ version: 1, overrides: input.overrides })

  const conflict = await focusRequest(
    '/api/focus/policies',
    'PUT',
    { ...input, overrides: { dueSoonDays: 7 } },
    idempotencyKey,
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'FocusIdempotencyConflict' })
})

test('recovers a committed policy when receipt completion failed', async () => {
  const { developerPlatform } = configureFocusSources('manager')
  const focusState = new InMemoryFocusStateClient()
  setTestAppDependencies({
    focusState,
    idempotency: createSingleCompletionFailure(developerPlatform.idempotency),
  })
  const input = {
    target: { type: 'user' as const },
    expectedVersion: 0,
    overrides: { dueSoonDays: 9 },
  }
  const idempotencyKey = 'focus-policy-completion-failure'

  const first = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(503)
  expect(await first.json()).toMatchObject({ code: 'FocusIdempotencyUnavailable' })

  const retry = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toMatchObject({
    policy: { version: 1, overrides: input.overrides },
  })
  expect((await focusState.getState({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamIds: ['core-team'],
  })).userPolicy).toMatchObject({ version: 1 })
})

test('fails closed when personal policy replay loses a stored Team scope', async () => {
  configureFocusSources('manager')
  const input = {
    target: { type: 'user' as const },
    expectedVersion: 0,
    overrides: { dueSoonDays: 8 },
  }
  const idempotencyKey = 'focus-policy-access-loss'
  const first = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({
    effectivePolicies: [{ teamId: 'core-team' }],
  })

  configureFakeProjectClients(false)
  const retry = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )

  expect(retry.status).toBe(403)
  expect(await retry.json()).toMatchObject({ code: 'FocusPolicyReplayAccessChanged' })
})

test('fails closed when personal policy replay gains a new Team scope', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    configureFocusSources('manager')
    configureFakeProjectClients(false, {
      workspaceRole: 'member',
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      additionalTeams: [{ id: 'later-team', name: 'Later Team', projects: [] }],
    })
    configureFakeAuthenticatedUser({
      email: 'sato@example.com',
      'custom:directory_id': 'user#demo@example.com',
    })
    const identity = await createFocusEnterpriseIdentity('team')
    setTestAppDependencies({ enterpriseIdentity: identity })
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const input = {
      target: { type: 'user' as const },
      expectedVersion: 0,
      overrides: { dueSoonDays: 8 },
    }
    const request = () => app.request('/api/focus/policies', {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'focus-policy-access-gain',
      },
      body: JSON.stringify(input),
    })

    const first = await request()
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      effectivePolicies: [{ teamId: 'core-team' }],
    })

    await addFocusEnterpriseTeamMapping(identity, 'later-team')
    const retry = await request()

    expect(retry.status).toBe(403)
    expect(await retry.json()).toMatchObject({ code: 'FocusPolicyReplayAccessChanged' })
  })
})

test('rejects unknown fields in a compact Focus replay outcome', async () => {
  const { developerPlatform } = configureFocusSources('manager')
  const input = {
    target: { type: 'user' as const },
    expectedVersion: 0,
    overrides: { dueSoonDays: 9 },
  }
  const idempotencyKey = 'focus-policy-invalid-receipt'
  const first = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(200)

  setTestAppDependencies({
    idempotency: {
      async reserveIdempotency(request) {
        const decision = await developerPlatform.idempotency.reserveIdempotency(request)
        if (decision.status !== 'replay') return decision
        const response = decision.response
        if (
          !isRecord(response) ||
          !isRecord(response.body) ||
          !isRecord(response.body.outcome)
        ) {
          throw new Error('Expected one stored Focus receipt fixture.')
        }
        return {
          status: 'replay',
          response: {
            ...response,
            body: {
              ...response.body,
              outcome: { ...response.body.outcome, unexpected: true },
            },
          },
        }
      },
      completeIdempotency(request) {
        return developerPlatform.idempotency.completeIdempotency(request)
      },
      releaseIdempotency(request) {
        return developerPlatform.idempotency.releaseIdempotency(request)
      },
    },
  })
  const retry = await focusRequest(
    '/api/focus/policies',
    'PUT',
    input,
    idempotencyKey,
  )

  expect(retry.status).toBe(503)
  expect(await retry.json()).toMatchObject({ code: 'InvalidStoredFocusMutationReceipt' })
})

test('returns policy controls for accessible Teams without current Work Items', async () => {
  configureFocusSources('manager', undefined, 0)

  const response = await focusRequest('/api/focus')

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    effectivePolicies: [
      { teamId: 'core-team' },
    ],
    teamPolicies: [],
    policyCapabilities: {
      canEditPersonal: true,
      editableTeamIds: ['core-team'],
    },
  })
})

test('requires Team manager permission for Team policy replacements', async () => {
  configureFocusSources('member')
  const input = {
    target: { type: 'team', teamId: 'core-team' },
    expectedVersion: 0,
    overrides: { nowScoreThreshold: 90 },
  }

  const response = await focusRequest('/api/focus/policies', 'PUT', input)

  expect(response.status).toBe(403)

  configureFocusSources('manager')
  const authorized = await focusRequest('/api/focus/policies', 'PUT', input)
  expect(authorized.status).toBe(200)
  expect(await authorized.json()).toMatchObject({
    policy: {
      target: { type: 'team', teamId: 'core-team' },
      version: 1,
    },
    effectivePolicies: [{
      teamId: 'core-team',
      settings: { nowScoreThreshold: 90 },
    }],
  })
})

test('snoozes with the current projected version and rejects a stale retry', async () => {
  configureFocusSources()
  const snoozedUntil = createFocusSnoozeTime(7)
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    {
      expectedVersion: currentVersion,
      snoozedUntil,
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    item: {
      version: expect.any(Number),
      snoozeRevision: 1,
      section: 'snoozed',
      snoozedUntil,
    },
  })

  const stale = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    { expectedVersion: currentVersion, snoozedUntil: null },
  )
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ code: 'FocusItemVersionConflict' })
})

test('replays a lost-response snooze retry and rejects key reuse with another payload', async () => {
  configureFocusSources()
  const focusState = new InMemoryFocusStateClient()
  setTestAppDependencies({ focusState })
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )
  const input = {
    expectedVersion: currentVersion,
    snoozedUntil: createFocusSnoozeTime(7),
  }
  const idempotencyKey = 'focus-snooze-lost-response'

  const first = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(200)
  const firstBody: unknown = await first.json()

  const retry = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toEqual(firstBody)
  expect((await focusState.getState({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamIds: ['core-team'],
  })).snoozes).toMatchObject([{ version: 1, snoozedUntil: input.snoozedUntil }])

  const conflict = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    { ...input, snoozedUntil: null },
    idempotencyKey,
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'FocusIdempotencyConflict' })
})

test('recovers a committed snooze when receipt completion failed', async () => {
  const { developerPlatform } = configureFocusSources()
  const focusState = new InMemoryFocusStateClient()
  setTestAppDependencies({
    focusState,
    idempotency: createSingleCompletionFailure(developerPlatform.idempotency),
  })
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )
  const input = {
    expectedVersion: currentVersion,
    snoozedUntil: createFocusSnoozeTime(5),
  }
  const idempotencyKey = 'focus-snooze-completion-failure'

  const first = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(503)
  expect(await first.json()).toMatchObject({ code: 'FocusIdempotencyUnavailable' })

  const retry = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toMatchObject({
    item: { snoozedUntil: input.snoozedUntil, snoozeRevision: 1 },
  })
  expect((await focusState.getState({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamIds: ['core-team'],
  })).snoozes).toHaveLength(1)
})

test('rejects a snooze wake time beyond the bounded retention window', async () => {
  configureFocusSources()
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    {
      expectedVersion: currentVersion,
      snoozedUntil: createFocusSnoozeTime(366),
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidFocusInput' })
})

test('changes watch state with current legacy Work Item write permission', async () => {
  const { watcherMutations, watcherExpectedStates } = configureFocusSources('member')
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: currentVersion, watching: true },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    item: {
      version: expect.any(Number),
      snoozeRevision: 0,
      watching: true,
    },
  })
  expect(watcherMutations).toEqual(['subscribe'])
  expect(watcherExpectedStates).toEqual([false])

  const stale = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: currentVersion, watching: false },
  )
  expect(stale.status).toBe(409)
  expect(watcherMutations).toEqual(['subscribe'])
})

test('replays a lost-response watch retry and rejects key reuse with another payload', async () => {
  const { watcherMutations } = configureFocusSources('member')
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )
  const input = { expectedVersion: currentVersion, watching: true }
  const idempotencyKey = 'focus-watch-lost-response'

  const first = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(200)
  const firstBody: unknown = await first.json()

  const retry = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toEqual(firstBody)
  expect(watcherMutations).toEqual(['subscribe'])

  const conflict = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { ...input, watching: false },
    idempotencyKey,
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'FocusIdempotencyConflict' })
  expect(watcherMutations).toEqual(['subscribe'])
})

test('recovers a committed watch when receipt completion failed', async () => {
  const { developerPlatform, watcherMutations } = configureFocusSources('member')
  setTestAppDependencies({
    idempotency: createSingleCompletionFailure(developerPlatform.idempotency),
  })
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )
  const input = { expectedVersion: currentVersion, watching: true }
  const idempotencyKey = 'focus-watch-completion-failure'

  const first = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(first.status).toBe(503)
  expect(await first.json()).toMatchObject({ code: 'FocusIdempotencyUnavailable' })

  const retry = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    input,
    idempotencyKey,
  )
  expect(retry.status).toBe(200)
  expect(retry.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retry.json()).toMatchObject({ item: { watching: true } })
  expect(watcherMutations).toEqual(['subscribe'])
})

test('rejects a Focus watch no-op when a concurrent opposite mutation changed the row', async () => {
  configureFocusSources('member')
  let memberWatcherReads = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getMemberWatcherState() {
        memberWatcherReads += 1
        return createWatcherState(memberWatcherReads >= 3)
      },
    }),
  })
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: currentVersion, watching: false },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'FocusWatchConflict' })
  expect(memberWatcherReads).toBe(3)
})

test('rejects a Focus watch write when a concurrent opposite mutation wins before re-read', async () => {
  configureFocusSources('member')
  const writes: Parameters<CollaborationClient['subscribe']>[0][] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getMemberWatcherState() {
        return createWatcherState(false)
      },
      async subscribe(input) {
        writes.push(input)
        return createWatcherState(true)
      },
    }),
  })
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: currentVersion, watching: true },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'FocusWatchConflict' })
  expect(writes).toHaveLength(1)
  expect(writes[0]?.expectedSubscribed).toBe(false)
})

test('rejects read-only legacy Focus watch mutations', async () => {
  const readOnly = configureFocusSources('viewer')
  const currentResponse = await focusRequest('/api/focus')
  const item = readFocusItem(await currentResponse.json(), 'onboarding-friction')
  const currentVersion = readNumberProperty(item, 'version')

  expect(item).toMatchObject({ capabilities: { watch: false } })
  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: currentVersion, watching: true },
  )

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'FocusWatchAccessDenied' })
  expect(readOnly.watcherMutations).toEqual([])
})

test('rejects guest Focus watch mutations', async () => {
  const guest = configureFocusSources('viewer', undefined, 1, 'guest')
  const guestResponse = await focusRequest('/api/focus')
  const guestVersion = readNumberProperty(
    readFocusItem(await guestResponse.json(), 'onboarding-friction'),
    'version',
  )

  const guestMutation = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/watch',
    'PUT',
    { expectedVersion: guestVersion, watching: true },
  )

  expect(guestMutation.status).toBe(403)
  expect(guest.watcherMutations).toEqual([])
})

test('fails closed when source permission is lost before a snooze write', async () => {
  configureFocusSources('member')
  const snoozedUntil = createFocusSnoozeTime(7)
  const currentResponse = await focusRequest('/api/focus')
  const currentVersion = readNumberProperty(
    readFocusItem(await currentResponse.json(), 'onboarding-friction'),
    'version',
  )
  let detailReads = 0
  configureFocusSources('member', async () => {
    detailReads += 1
    if (detailReads > 1) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        'Work Item access was revoked.',
      )
    }
  })
  const focusState = new InMemoryFocusStateClient()
  setTestAppDependencies({ focusState })

  const response = await focusRequest(
    '/api/focus/items/core-team/onboarding-friction/snooze',
    'PUT',
    {
      expectedVersion: currentVersion,
      snoozedUntil,
    },
  )

  expect(response.status).toBe(403)
  expect((await focusState.getState({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamIds: ['core-team'],
  })).snoozes).toEqual([])
})
