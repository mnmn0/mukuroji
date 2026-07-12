import { describe, expect, test } from 'bun:test'
import {
  createDynamoBatchItemFailure,
  createNotificationProjectionKeys,
  groupNotificationCandidates,
  hasActiveNotificationScope,
  isActiveWorkspaceNotificationMember,
  hasCurrentSystemAdminMembership,
  hasEligibleProjectAccess,
  parseAuditProjectionEvent,
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
      entityKey: 'workspace-1#work-item#team/core/issue/example',
      entityId: 'team/core/issue/example',
      outboxStatus: 'suppressed',
      metadata: {
        actorMemberKey: 'author@example.com',
        issueId: 'example',
        notificationCandidates: [
          { memberKey: 'member@example.com', reason: 'mention' },
          { memberKey: 42, reason: 'invalid' },
        ],
      },
    })

    expect(event).toMatchObject({
      actorMemberKey: 'author@example.com',
      issueId: 'example',
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
      consumerName: 'collaboration-notification#member@example.com',
    })
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
