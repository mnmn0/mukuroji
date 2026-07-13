import { describe, expect, test } from 'bun:test'
import { S3Client } from '@aws-sdk/client-s3'
import {
  cleanupDeletedFileProjection,
  createDynamoBatchItemFailure,
  createNotificationProjectionDeliveryState,
  createNotificationProjectionItem,
  createNotificationProjectionKeys,
  groupNotificationCandidates,
  hasActiveNotificationScope,
  isActiveWorkspaceNotificationMember,
  hasCurrentSystemAdminMembership,
  hasEligibleProjectAccess,
  mergeDeletedObjectTags,
  parseAuditProjectionEvent,
  processCollaborationProjectionBatch,
  refreshScheduledNotificationEvent,
  tagDeletedFileObjectVersion,
  toSubscribedWatcherCandidates,
  type AuditProjectionEvent,
  type DeletedFileCleanupDependencies,
  type DeletedFileMetadataKey,
  type DeletedFileObjectVersion,
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
        fileId: 'file-1',
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
      fileId: 'file-1',
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

  test('durably quarantines immutable versions and expires related file metadata', async () => {
    const taggedVersions: DeletedFileObjectVersion[] = []
    const expiredKeys: DeletedFileMetadataKey[] = []
    const queriedPrefixes: string[] = []
    const dependencies: DeletedFileCleanupDependencies = {
      async readFile(scopeKey, fileId) {
        return {
          scopeKey,
          recordKey: `FILE#${fileId}`,
          entryType: 'file',
          fileId,
          deletedAt: '2026-07-13T00:00:00.000Z',
          retentionUntil: '2026-08-12T00:00:00.000Z',
          expiresAt: 1_786_492_800,
          versions: [
            {
              objectKey: 'workspaces/workspace-1/files/file-1/version-1/proof.png',
              objectVersionId: 's3-version-1',
            },
            {
              objectKey: 'workspaces/workspace-1/files/file-1/version-pending/proof.png',
            },
          ],
        }
      },
      async queryRows(_scopeKey, recordPrefix) {
        queriedPrefixes.push(recordPrefix)
        if (recordPrefix.startsWith('ANNOTATION#')) {
          return [{
            scopeKey: 'WORKSPACE#workspace-1#TEAM#core#WORKITEM#example',
            recordKey: 'ANNOTATION#file-1#version-1#annotation-1',
            entryType: 'annotation',
          }]
        }
        return [
          {
            scopeKey: 'WORKSPACE#workspace-1#TEAM#core#WORKITEM#example',
            recordKey: 'FILE_APPROVAL#file-1#approval-1',
            entryType: 'file-approval-index',
            approvalId: 'approval-1',
            fileId: 'file-1',
            dueAt: '2026-07-20T00:00:00.000Z',
            reviewerMemberKeys: ['Reviewer@Example.com'],
          },
        ]
      },
      async tagDeletedObjectVersion(target) {
        taggedVersions.push(target)
      },
      async expireMetadata(keys, expiresAt, retentionUntil) {
        expiredKeys.push(...keys)
        expect(expiresAt).toBe(1_786_492_800)
        expect(retentionUntil).toBe('2026-08-12T00:00:00.000Z')
      },
    }

    await cleanupDeletedFileProjection(createProjectionEvent({
      eventType: 'file.deleted',
      workspaceId: 'workspace-1',
      teamId: 'core',
      issueId: 'example',
      fileId: 'file-1',
      targetId: 'file-1',
    }), dependencies)

    expect(taggedVersions).toEqual([{
      objectKey: 'workspaces/workspace-1/files/file-1/version-1/proof.png',
      objectVersionId: 's3-version-1',
    }])
    expect(queriedPrefixes).toEqual([
      'ANNOTATION#file-1#',
      'FILE_APPROVAL#file-1#',
    ])
    expect(expiredKeys).toEqual([
      {
        scopeKey: 'WORKSPACE#workspace-1#TEAM#core#WORKITEM#example',
        recordKey: 'ANNOTATION#file-1#version-1#annotation-1',
      },
      {
        scopeKey: 'WORKSPACE#workspace-1#TEAM#core#WORKITEM#example',
        recordKey: 'FILE_APPROVAL#file-1#approval-1',
      },
      {
        scopeKey: 'WORKSPACE#workspace-1#TEAM#core#WORKITEM#example',
        recordKey: 'APPROVAL#approval-1',
      },
      {
        scopeKey: 'WORKSPACE#workspace-1#REVIEWER#reviewer@example.com',
        recordKey: 'APPROVAL#2026-07-20T00:00:00.000Z#approval-1',
      },
    ])
  })

  test('preserves scan and completion tags while applying deleted quarantine', () => {
    expect(mergeDeletedObjectTags([
      { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
      { Key: 'mukuroji-upload', Value: 'completed' },
      { Key: 'mukuroji-deleted', Value: 'false' },
    ])).toEqual([
      { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
      { Key: 'mukuroji-upload', Value: 'completed' },
      { Key: 'mukuroji-deleted', Value: 'true' },
    ])
  })

  test('treats only missing immutable versions as completed deleted-file tagging', async () => {
    const target: DeletedFileObjectVersion = {
      objectKey: 'workspaces/workspace-1/files/file-1/version-1/proof.png',
      objectVersionId: 's3-version-1',
    }
    const s3Client = new S3Client({
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      region: 'us-east-1',
    })
    let failure = Object.assign(new Error('Object key is gone.'), { name: 'NoSuchKey' })
    let sendCount = 0
    ;(s3Client as unknown as { send(command: unknown): Promise<Record<string, unknown>> }).send =
      async () => {
        sendCount += 1
        if (failure.name === 'NoSuchVersion' && sendCount === 1) {
          return { TagSet: [] }
        }
        throw failure
      }

    await expect(tagDeletedFileObjectVersion(s3Client, 'files', target)).resolves.toBeUndefined()

    failure = Object.assign(new Error('Object version is gone.'), { name: 'NoSuchVersion' })
    sendCount = 0
    await expect(tagDeletedFileObjectVersion(s3Client, 'files', target)).resolves.toBeUndefined()

    failure = Object.assign(new Error('S3 is unavailable.'), { name: 'ServiceUnavailable' })
    sendCount = 0
    await expect(tagDeletedFileObjectVersion(s3Client, 'files', target)).rejects.toMatchObject({
      message: 'S3 is unavailable.',
      name: 'ServiceUnavailable',
    })
  })

  test('returns a partial batch failure when durable file cleanup fails', async () => {
    const failure = new Error('S3 tagging unavailable')
    const dependencies: DeletedFileCleanupDependencies = {
      async readFile() {
        throw failure
      },
      async queryRows() {
        return []
      },
      async tagDeletedObjectVersion() {},
      async expireMetadata() {},
    }
    const response = await processCollaborationProjectionBatch({
      Records: [{
        eventID: 'event-1',
        eventName: 'INSERT',
        dynamodb: {
          SequenceNumber: 'stream-sequence-1',
          NewImage: {
            eventId: { S: 'evt-file-delete' },
            eventType: { S: 'file.deleted' },
            workspaceId: { S: 'workspace-1' },
            occurredAt: { S: '2026-07-13T00:00:00.000Z' },
            targetId: { S: 'file-1' },
            outboxStatus: { S: 'suppressed' },
            metadata: {
              M: {
                teamId: { S: 'core' },
                issueId: { S: 'example' },
                fileId: { S: 'file-1' },
              },
            },
          },
        },
      }],
    }, dependencies)

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'stream-sequence-1' }],
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
