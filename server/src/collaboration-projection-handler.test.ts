import { describe, expect, test } from 'bun:test'
import {
  createDynamoBatchItemFailure,
  createNotificationProjectionDeliveryState,
  createNotificationProjectionItem,
  createNotificationProjectionKeys,
  groupNotificationCandidates,
  hasActiveNotificationScope,
  isActiveWorkspaceNotificationMember,
  hasCurrentSystemAdminMembership,
  hasEligibleProjectAccess,
  parseAuditProjectionEvent,
  refreshScheduledNotificationEvent,
  toSubscribedWatcherCandidates,
  type AuditProjectionEvent,
  type ProjectDirectoryItem,
} from './collaboration-projection-handler'
import {
  capRealtimeSessionExpiry,
  hasCurrentRealtimeSystemAdminMembership,
  hasCurrentRealtimeWorkItemScope,
  hasRealtimeDirectoryAccess,
  hasRealtimeDirectoryWriteAccess,
  isRealtimeTypingAllowed,
  type RealtimeAuthorizationDirectoryItem,
  type RealtimeSessionItem,
} from './realtime-handler'

/**
 * Pure projection helper tests で使う最小 audit event を作成します。
 */
function createProjectionEvent(
  overrides: Partial<AuditProjectionEvent> = {},
): AuditProjectionEvent {
  return {
    eventId: 'evt-1',
    eventType: 'comment.created',
    workspaceId: 'workspace-1',
    actorUserId: 'cognito-sub-1',
    actorMemberKey: 'author@example.com',
    scopeKey: 'workspace-1#work-item#team/core/issue/example',
    entityId: 'team/core/issue/example',
    occurredAt: '2026-07-12T12:00:00.000Z',
    notificationCandidates: [],
    outboxStatus: 'pending',
    ...overrides,
  }
}

describe('collaboration projection pure helpers', () => {
  test('deduplicates recipients and excludes actor by Workspace member key', () => {
    const grouped = groupNotificationCandidates(createProjectionEvent({
      notificationCandidates: [
        { memberKey: 'AUTHOR@example.com', reason: 'watcher' },
        { memberKey: 'member@example.com', reason: 'watcher' },
        { memberKey: 'MEMBER@example.com', reason: 'mention' },
        { memberKey: 'member@example.com', reason: 'watcher' },
      ],
    }))

    expect(grouped).toEqual([
      {
        memberKey: 'member@example.com',
        reasons: ['mention', 'watcher'],
      },
    ])
  })

  test('projects only currently subscribed watcher rows into notification candidates', () => {
    expect(toSubscribedWatcherCandidates([
      {
        entryType: 'watcher',
        state: 'subscribed',
        memberKey: 'watcher@example.com',
      },
      {
        entryType: 'watcher',
        state: 'unsubscribed',
        memberKey: 'departed@example.com',
      },
    ], 'watcher')).toEqual([
      { memberKey: 'watcher@example.com', reason: 'watcher' },
    ])
  })

  test('parses actor member metadata and preserves suppressed outbox events', () => {
    const event = parseAuditProjectionEvent({
      eventId: 'evt-suppressed',
      eventType: 'comment.created',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T12:00:00.000Z',
      actorUserId: 'cognito-sub-1',
      actor: { displayName: 'Author Example' },
      entityKey: 'workspace-1#work-item#team/core/issue/example',
      entityId: 'team/core/issue/example',
      summary: 'A reply mentioned you.',
      outboxStatus: 'suppressed',
      metadata: {
        actorMemberKey: 'author@example.com',
        issueId: 'example',
        commentId: 'reply-1',
        rootCommentId: 'root-1',
        notificationTitle: 'Inbox foundations',
        notificationCandidates: [
          { memberKey: 'member@example.com', reason: 'mention' },
          { memberKey: 42, reason: 'invalid' },
        ],
      },
    })

    expect(event).toMatchObject({
      actorMemberKey: 'author@example.com',
      actorLabel: 'Author Example',
      issueId: 'example',
      commentId: 'reply-1',
      rootCommentId: 'root-1',
      notificationTitle: 'Inbox foundations',
      summary: 'A reply mentioned you.',
      outboxStatus: 'suppressed',
      notificationCandidates: [
        { memberKey: 'member@example.com', reason: 'mention' },
      ],
    })
  })

  test('builds deterministic recipient notification and receipt keys', () => {
    const event = createProjectionEvent()
    const first = createNotificationProjectionKeys(event, 'Member@Example.com')
    const retry = createNotificationProjectionKeys(event, 'member@example.com')

    expect(first).toEqual(retry)
    expect(first).toEqual({
      recipientKey: 'workspace-1#member@example.com',
      notificationKey: '2026-07-12T12:00:00.000Z#evt-1',
      recipientStatusKey: 'workspace-1#member@example.com#unread',
      consumerName: 'collaboration-notification#member@example.com',
    })
  })

  test('applies in-app channel, digest frequency, and quiet hours to projection state', () => {
    const state = createNotificationProjectionDeliveryState(
      'workspace-1#member@example.com',
      '2026-07-12T23:00:00.000Z',
      {
        version: 1,
        channels: { inApp: false, email: true, push: false },
        frequency: 'instant',
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timeZone: 'UTC',
        },
      },
    )

    expect(state).toEqual({
      inAppVisible: false,
      inboxState: 'archived',
      recipientStatusKey: 'workspace-1#member@example.com#archived',
      archivedAt: '2026-07-12T23:00:00.000Z',
      deliveryChannels: ['email'],
      deliveryAfter: '2026-07-13T07:00:00.000Z',
      deliveryFrequency: 'instant',
    })
  })

  test('persists the Work Item identity required by current-permission reads', () => {
    const event = createProjectionEvent({
      issueId: 'notification-api',
      projectId: 'refero',
      teamId: 'core-team',
    })
    const deliveryState = createNotificationProjectionDeliveryState(
      'workspace-1#member@example.com',
      event.occurredAt,
      {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '07:00',
          timeZone: 'UTC',
        },
      },
    )

    expect(createNotificationProjectionItem(
      event,
      { memberKey: 'member@example.com', reasons: ['status-change'] },
      deliveryState,
      1_800_000_000,
    )).toMatchObject({
      issueId: 'notification-api',
      projectId: 'refero',
      recipientKey: 'workspace-1#member@example.com',
      recipientStatusKey: 'workspace-1#member@example.com#unread',
      teamId: 'core-team',
    })
  })

  test('refreshes scheduled candidates from the current assignee and suppresses stale due state', () => {
    const scheduledEvent = createProjectionEvent({
      dueDate: '2026-07-12',
      eventType: 'work-item.due',
      issueId: 'release-checklist',
      notificationCandidates: [{ memberKey: 'old-owner@example.com', reason: 'due' }],
      teamId: 'core-team',
    })

    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'new-owner@example.com',
      checked: true,
      dueDate: '2026-07-12',
      exists: true,
      status: 'in-progress',
    })).toBeUndefined()
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'old-owner@example.com',
      checked: true,
      dueDate: '2026-07-12',
      exists: true,
      status: 'in-progress',
    })?.notificationCandidates).toEqual([{
      memberKey: 'old-owner@example.com',
      reason: 'due',
    }])
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'new-owner@example.com',
      checked: true,
      dueDate: '2026-07-13',
      exists: true,
      status: 'in-progress',
    })).toBeUndefined()
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'new-owner@example.com',
      checked: true,
      dueDate: '2026-07-12',
      exists: true,
      status: 'done',
    })).toBeUndefined()
  })

  test('tolerates legacy events without collaboration metadata', () => {
    const event = parseAuditProjectionEvent({
      eventId: 'evt-legacy',
      eventType: 'work-item.updated',
      directoryId: 'workspace-1',
      occurredAt: '2026-07-12T12:00:00.000Z',
      entityType: 'work-item',
      entityId: 'team/core/issue/example',
    })

    expect(event).toMatchObject({
      notificationCandidates: [],
      outboxStatus: 'pending',
      scopeKey: 'workspace-1#work-item#team/core/issue/example',
    })
  })

  test('accepts future approval and automation notification producers through the generic contract', () => {
    for (const [eventType, reason] of [
      ['approval.decided', 'approval'],
      ['automation.failed', 'automation-failure'],
    ] as const) {
      const event = parseAuditProjectionEvent({
        eventId: `${eventType}-1`,
        eventType,
        workspaceId: 'workspace-1',
        occurredAt: '2026-07-12T12:00:00.000Z',
        actorUserId: 'system',
        entityType: 'work-item',
        entityId: 'team/core/issue/example',
        metadata: {
          teamId: 'core',
          issueId: 'example',
          deepLink: '/teams/core/issues?issueId=example',
          notificationCandidates: [{ memberKey: 'owner@example.com', reason }],
        },
      })

      expect(event).toBeDefined()
      expect(groupNotificationCandidates(event as AuditProjectionEvent)).toEqual([
        { memberKey: 'owner@example.com', reasons: [reason] },
      ])
    }
  })

  test('uses the DynamoDB sequence number for partial batch failures', () => {
    expect(createDynamoBatchItemFailure({
      eventID: 'diagnostic-event-id',
      dynamodb: { SequenceNumber: '1234567890' },
    })).toEqual({ itemIdentifier: '1234567890' })
    expect(() => createDynamoBatchItemFailure({ eventID: 'diagnostic-event-id' })).toThrow(
      'DynamoDB Streams sequence number is required',
    )
  })

  test('rejects notification access when the parent team is archived', () => {
    const activeDirectory: ProjectDirectoryItem[] = [
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
      {
        entryType: 'project-member',
        projectId: 'platform',
        memberKey: 'member@example.com',
        role: 'viewer',
      },
    ]
    const event = { teamId: 'core', projectId: 'platform' }

    expect(hasEligibleProjectAccess(event, 'member@example.com', activeDirectory)).toBe(true)
    expect(hasEligibleProjectAccess(event, 'member@example.com', [
      { entryType: 'team', teamId: 'core', archivedAt: '2026-07-12T12:00:00.000Z' },
      ...activeDirectory.slice(1),
    ])).toBe(false)
  })

  test('excludes deactivated Workspace members from notification recipients', () => {
    expect(isActiveWorkspaceNotificationMember('departed@example.com', {
      entryType: 'workspace-member',
      memberKey: 'departed@example.com',
      status: 'deactivated',
    })).toBe(false)
    expect(isActiveWorkspaceNotificationMember('active@example.com', {
      entryType: 'workspace-member',
      memberKey: 'active@example.com',
      status: 'active',
    })).toBe(true)
  })

  test('checks every current Cognito group page for the system-admin fallback', async () => {
    const activeDirectory: ProjectDirectoryItem[] = [
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
    ]
    const event = { teamId: 'core', projectId: 'platform' }
    const requestedTokens: Array<string | undefined> = []
    const currentSystemAdmin = await hasCurrentSystemAdminMembership(
      ['mukuroji-system-admins'],
      async (nextToken) => {
        requestedTokens.push(nextToken)
        return nextToken
          ? { groupNames: ['mukuroji-system-admins'] }
          : { groupNames: ['ordinary-members'], nextToken: 'page-2' }
      },
    )
    const ordinaryMember = await hasCurrentSystemAdminMembership(
      ['mukuroji-system-admins'],
      async () => ({ groupNames: ['ordinary-members'] }),
    )

    expect(hasEligibleProjectAccess(event, 'admin@example.com', activeDirectory)).toBe(false)
    expect(hasActiveNotificationScope(event, activeDirectory)).toBe(true)
    expect(currentSystemAdmin).toBe(true)
    expect(ordinaryMember).toBe(false)
    expect(requestedTokens).toEqual([undefined, 'page-2'])
    expect(hasActiveNotificationScope(event, [
      { entryType: 'team', teamId: 'core', archivedAt: '2026-07-12T12:00:00.000Z' },
      ...activeDirectory.slice(1),
    ])).toBe(false)
  })

  test('realtime access requires an active team and the assigned project membership', () => {
    const session: RealtimeSessionItem = {
      connectionId: 'connection-1',
      itemType: 'connection',
      workspaceId: 'workspace-1',
      memberKey: 'member@example.com',
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      systemAdmin: false,
      canWrite: true,
      scopeKey: 'workspace-1#work-item#team/core/issue/example',
      expiresAt: 2_000_000_000,
      authorizationExpiresAt: 2_000_000_000,
    }
    const activeDirectory: RealtimeAuthorizationDirectoryItem[] = [
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
      {
        entryType: 'project-member',
        projectId: 'platform',
        memberKey: 'member@example.com',
        role: 'viewer',
      },
    ]

    expect(hasRealtimeDirectoryAccess(session, activeDirectory)).toBe(true)
    expect(hasRealtimeDirectoryWriteAccess(session, activeDirectory, 'member')).toBe(false)
    const memberDirectory = activeDirectory.map((item) =>
      item.entryType === 'project-member' ? { ...item, role: 'member' } : item
    )
    expect(hasRealtimeDirectoryWriteAccess(session, memberDirectory, 'member')).toBe(true)
    expect(hasRealtimeDirectoryWriteAccess(session, memberDirectory, 'guest')).toBe(false)
    expect(hasRealtimeDirectoryAccess(session, activeDirectory.filter((item) =>
      item.entryType !== 'project-member'
    ))).toBe(false)
    expect(hasRealtimeDirectoryAccess(session, [
      { entryType: 'team', teamId: 'core', archivedAt: '2026-07-12T12:00:00.000Z' },
      ...activeDirectory.slice(1),
    ])).toBe(false)
    expect(hasCurrentRealtimeWorkItemScope(session, {
      directoryTeamId: 'workspace-1#team#core',
      issueId: 'example',
      assignedProjectId: 'platform',
    })).toBe(true)
    expect(hasCurrentRealtimeWorkItemScope(session, {
      directoryTeamId: 'workspace-1#team#core',
      issueId: 'example',
      assignedProjectId: 'replacement-project',
    })).toBe(false)
  })

  test('realtime system-admin authorization checks every current Cognito group page', async () => {
    const requestedTokens: Array<string | undefined> = []
    const authorized = await hasCurrentRealtimeSystemAdminMembership(
      ['mukuroji-system-admins'],
      async (nextToken) => {
        requestedTokens.push(nextToken)
        return nextToken
          ? { groupNames: ['mukuroji-system-admins'] }
          : { groupNames: ['ordinary-members'], nextToken: 'page-2' }
      },
    )

    expect(authorized).toBe(true)
    expect(requestedTokens).toEqual([undefined, 'page-2'])
    expect(await hasCurrentRealtimeSystemAdminMembership(
      ['mukuroji-system-admins'],
      async () => ({ groupNames: ['ordinary-members'] }),
    )).toBe(false)
  })

  test('realtime typing requires write access and session refresh cannot extend authorization', () => {
    expect(isRealtimeTypingAllowed(false, true)).toBe(false)
    expect(isRealtimeTypingAllowed(false, false)).toBe(true)
    expect(isRealtimeTypingAllowed(true, true)).toBe(true)
    expect(capRealtimeSessionExpiry(2_000_003_600, 2_000_000_900)).toBe(2_000_000_900)
  })
})
