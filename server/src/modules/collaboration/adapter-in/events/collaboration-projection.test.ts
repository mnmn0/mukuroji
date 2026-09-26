import { describe, expect, spyOn, test } from 'bun:test'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DocumentError, type GetDocumentRequest } from '../../../documents'
import type { ApprovalNotificationSource } from '../../../files'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../../notifications/notifications'
import { S3Client } from '@aws-sdk/client-s3'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type EnterpriseIdentitySnapshot,
  type EnterpriseSecurityPolicy,
} from '@mukuroji/contracts'
import {
  cleanupDeletedFileProjection,
  authorizeNotificationDelivery,
  createNotificationDeliveryAuthorizationCache,
  createCuratedContextSearchParentCondition,
  createDynamoBatchItemFailure,
  createNotificationProjectionDeliveryState,
  createNotificationProjectionItem,
  createNotificationProjectionKeys,
  createSubscribedWatcherScopes,
  groupNotificationCandidates,
  hasActiveNotificationScope,
  isActiveWorkspaceNotificationMember,
  hasCurrentSystemAdminMembership,
  hasEligibleEnterpriseNotificationAccess,
  hasEligibleProjectAccess,
  mergeDeletedObjectTags,
  overlayCurrentWorkItemNotificationScope,
  parseAuditProjectionEvent,
  projectCuratedContextSearchEvent,
  projectCuratedContextSearchEventWithParentFence,
  processCollaborationProjectionBatch,
  projectsSubscribedWatchers,
  publishRealtimeInvalidation,
  refreshPlanningScheduledNotificationEvent,
  refreshScheduledNotificationEvent,
  resolveEnterpriseNotificationAuthorization,
  supportsCollaborationWatcherNotifications,
  tagDeletedFileObjectVersion,
  toSubscribedWatcherCandidates,
  type AuditProjectionEvent,
  type CurrentPlanningUpdateNotificationScope,
  type CuratedContextSearchProjectionInput,
  type DeletedFileCleanupDependencies,
  type DeletedFileMetadataKey,
  type DeletedFileObjectVersion,
  type ProjectDirectoryItem,
} from './collaboration-projection'
import {
  capRealtimeSessionExpiry,
  createCachedRealtimeCognitoProviderBindingReader,
  evaluateRealtimeEnterpriseAccess,
  hasActiveRealtimeResourceScope,
  hasCurrentRealtimeEnterpriseSsoAssurance,
  hasCurrentRealtimeSystemAdminMembership,
  hasCurrentRealtimeWorkItemScope,
  hasRealtimeDirectoryAccess,
  hasRealtimeLegacyDirectoryAccess,
  hasRealtimeDirectoryWriteAccess,
  hasValidRealtimeCognitoProviderBindings,
  isRealtimeTypingAllowed,
  isRealtimeEnterpriseSessionFresh,
  type RealtimeAuthorizationDirectoryItem,
  type EvaluateRealtimeEnterpriseAccessInput,
  type RealtimeSessionItem,
  type RealtimeWorkItemRecord,
} from '../../../realtime/adapter-in/events/realtime'
import { createEnterpriseSsoAuthenticationMethod } from '../../../enterprise-identity/enterprise-sso'

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

/** Realtime scope validation で使う canonical Work Item row を作成します。 */
function createRealtimeWorkItem(
  overrides: Partial<RealtimeWorkItemRecord> = {},
): RealtimeWorkItemRecord {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core',
    directoryProjectId: 'workspace-1#project#platform',
    teamId: 'core',
    assignedProjectId: 'platform',
    issueId: 'example',
    sortOrder: 10,
    title: 'Example',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    schedule: createDefaultDueDateWorkItemSchedule('2026-07-31'),
    priority: 'medium',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-12T09:00:00.000Z',
    ...overrides,
  }
}

/**
 * Realtime enterprise authorization test 用の空 snapshot を作成します。
 */
function createRealtimeEnterpriseSnapshot(
  overrides: Partial<EnterpriseIdentitySnapshot> = {},
): EnterpriseIdentitySnapshot {
  return {
    workspaceId: 'workspace-1',
    identityProviders: [],
    domains: [],
    customRoles: [],
    groupMappings: [],
    roleAssignments: [],
    scimUsers: [],
    scimGroups: [],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
    ...overrides,
  }
}

describe('collaboration projection pure helpers', () => {
  test('preserves approval source and requires current file visibility and Files permission', async () => {
    const keys = ['WORK_ITEMS_TABLE_NAME', 'WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const memberKey = 'member@example.com'
    const event = createProjectionEvent({ eventType: 'approval.requested', teamId: 'core', projectId: 'platform', issueId: 'example',
      targetId: 'approval-1', fileId: 'file-1', notificationCandidates: [{ memberKey, reason: 'approval-requested' }] })
    const candidate = { memberKey, reasons: ['approval-requested'] }
    const row = createNotificationProjectionItem(event, candidate, createNotificationProjectionDeliveryState(
      `${event.workspaceId}#${memberKey}`, event.occurredAt, DEFAULT_NOTIFICATION_PREFERENCES,
    ))
    expect(row).toMatchObject({ targetId: 'approval-1', fileId: 'file-1' })
    const cache = createNotificationDeliveryAuthorizationCache()
    cache.expiresAt = Date.now() + 60_000
    cache.directories.set(event.workspaceId, Promise.resolve([
      { entryType: 'team', teamId: 'core' }, { entryType: 'project', teamId: 'core', projectId: 'platform' },
      { entryType: 'project-member', teamId: 'core', projectId: 'platform', memberKey, role: 'viewer' },
    ]))
    const snapshot = createRealtimeEnterpriseSnapshot({
      roleAssignments: [{ workspaceId: event.workspaceId, assignmentId: 'assignment-1', principalKind: 'member', principalId: memberKey,
        roleId: 'custom:reader', source: 'direct', scope: { workspaceId: event.workspaceId, kind: 'workspace' } }],
      customRoles: [{ workspaceId: event.workspaceId, roleId: 'custom:reader', name: 'Reader', permissions: ['work-items.read'],
        guestAssignable: true, revision: 1, createdAt: event.occurredAt, updatedAt: event.occurredAt }],
    })
    const identity = { getSnapshot: async () => snapshot }
    const reads: ApprovalNotificationSource[] = []
    let visible = true
    /** Exercises one fresh source read on every delivery. */
    const readApproval = async (source: ApprovalNotificationSource) => { reads.push(source); return visible }
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => ({ Groups: [], $metadata: {} }))
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
      return { Item: command.input.TableName === 'WORK_ITEMS_TABLE_NAME' ? createRealtimeWorkItem()
        : { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {} }
    })
    try {
      /** Reuses the directory snapshot while checking current Files permissions and visibility. */
      const authorize = () => authorizeNotificationDelivery(event, memberKey, identity, cache, undefined, undefined, readApproval)
      expect(await authorize()).toBe(false)
      snapshot.customRoles[0]!.permissions = ['files.read']
      expect(await authorize()).toBe(true)
      visible = false
      expect(await authorize()).toBe(false)
      expect(reads).toHaveLength(3)
      expect(reads[0]).toEqual({ workspaceId: event.workspaceId, teamId: 'core', issueId: 'example',
        approvalId: 'approval-1', fileId: 'file-1', guest: false })
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('rechecks all assignee-only reasons while preserving independent mention delivery', async () => {
    const keys = ['WORK_ITEMS_TABLE_NAME', 'WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const memberKey = 'member@example.com'
    const current = createRealtimeWorkItem()
    const event = createProjectionEvent({ eventType: 'work-item.updated', teamId: 'core', projectId: 'platform', issueId: 'example' })
    const cache = createNotificationDeliveryAuthorizationCache()
    cache.expiresAt = Date.now() + 60_000
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => ({ Groups: [], $metadata: {} }))
    cache.directories.set(event.workspaceId, Promise.resolve([
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
      { entryType: 'project-member', teamId: 'core', projectId: 'platform', memberKey, role: 'viewer' },
    ]))
    const identity = { getSnapshot: async () => createRealtimeEnterpriseSnapshot() }
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
      expect(command.input.ConsistentRead).toBe(true)
      return { Item: command.input.TableName === 'WORK_ITEMS_TABLE_NAME' ? current
        : { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {} }
    })
    try {
      for (const reason of ['assignee', 'assignment', 'due', 'due-date-change', 'overdue', 'schedule-change', 'status-change']) {
        event.notificationCandidates = [{ memberKey, reason }]
        current.assigneeUserId = memberKey
        expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(true)
        current.assigneeUserId = 'new-owner@example.com'
        expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
      }
      event.notificationCandidates = [{ memberKey, reason: 'assignment' }, { memberKey, reason: 'mention' }]
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(true)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('suppresses deleted Cognito recipients in both delivery paths but retries transient provider errors', async () => {
    const keys = ['WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const memberKey = 'member@example.com'
    let errorName: string | undefined
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => {
      if (errorName) throw Object.assign(new Error('Cognito unavailable'), { name: errorName })
      return { Groups: [], $metadata: {} }
    })
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async () => ({
      Item: { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {},
    }))
    try {
      for (const eventType of ['comment.created', 'document.comment.created']) {
        const event = createProjectionEvent({ eventType, entityId: 'source-1' })
        const identity = { getSnapshot: async () => createRealtimeEnterpriseSnapshot() }
        /** Starts an independent delivery check with a fresh current-user lookup. */
        const authorize = () => {
          const cache = createNotificationDeliveryAuthorizationCache()
          cache.expiresAt = Date.now() + 60_000
          cache.directories.set(event.workspaceId, Promise.resolve([]))
          return authorizeNotificationDelivery(event, memberKey, identity, cache, async () => {
            if (errorName) throw new Error('Deleted or unavailable recipient reached document access')
            return {}
          })
        }
        errorName = undefined
        expect(await authorize()).toBe(true)
        errorName = 'UserNotFoundException'
        expect(await authorize()).toBe(false)
        errorName = 'TooManyRequestsException'
        await expect(authorize()).rejects.toThrow('Cognito unavailable')
      }
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('normalizes administrator groups and rechecks revocation before every scoped and document delivery', async () => {
    const keys = ['WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID', 'SYSTEM_ADMIN_GROUPS']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    process.env.SYSTEM_ADMIN_GROUPS = 'admins, operators , '
    const memberKey = 'member@example.com'
    let isAdmin = true
    let groupReads = 0
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => {
      groupReads += 1
      return { Groups: isAdmin ? [{ GroupName: 'operators' }] : [], $metadata: {} }
    })
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async () => ({
      Item: { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {},
    }))
    try {
      for (const eventType of ['comment.created', 'document.comment.created']) {
        const event = createProjectionEvent({ eventType, entityId: 'source-1', teamId: 'core', projectId: 'platform' })
        const cache = createNotificationDeliveryAuthorizationCache()
        cache.expiresAt = Date.now() + 60_000
        cache.directories.set(event.workspaceId, Promise.resolve([
          { entryType: 'team', teamId: 'core' }, { entryType: 'project', teamId: 'core', projectId: 'platform' },
        ]))
        /** Reuses the same directory cache while requiring a fresh Cognito group read. */
        const authorize = () => authorizeNotificationDelivery(event, memberKey,
          { getSnapshot: async () => createRealtimeEnterpriseSnapshot() }, cache, async (request) => {
            if (!request.access?.isSystemAdmin) throw new DocumentError(403, 'DocumentViewDenied', 'Administrator access revoked')
            return {}
          })
        isAdmin = true
        expect(await authorize()).toBe(true)
        isAdmin = false
        expect(await authorize()).toBe(false)
      }
      expect(groupReads).toBe(4)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('evaluates workspace Planning access and preserves only currently subscribed watcher delivery', async () => {
    const keys = ['WORKSPACE_ACCESS_TABLE_NAME', 'PLANNING_TABLE_NAME', 'COLLABORATION_TABLE_NAME', 'SYSTEM_ADMIN_GROUPS', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const memberKey = 'member@example.com'
    const nextDueAt = '2026-07-12T09:00:00.000Z'
    let subscribed = true
    let role = 'member'
    let ownerMemberKey = 'owner@example.com'
    const event = createProjectionEvent({ eventType: 'planning-update.reminder', entityId: 'initiative/launch',
      planningTargetType: 'initiative', planningTargetId: 'launch', planningTargetRecordKey: 'UPDATE_TARGET#INITIATIVE#launch',
      planningNextDueAt: nextDueAt, planningNotificationKind: 'reminder',
      notificationCandidates: [{ memberKey, reason: 'watcher' }] })
    let groupReads = 0
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof AdminListGroupsForUserCommand)) throw new Error('Unexpected Cognito command')
      groupReads += 1
      expect(command.input.Username).toBe(memberKey)
      return command.input.NextToken
        ? { Groups: [{ GroupName: 'current-group' }], $metadata: {} }
        : { Groups: [{ GroupName: 'unrelated-group' }], NextToken: 'page-2', $metadata: {} }
    })
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
      expect(command.input.ConsistentRead).toBe(true)
      const key = command.input.Key
      if (key?.recordKey === event.planningTargetRecordKey) return { Item: {
        workspaceId: event.workspaceId, recordKey: event.planningTargetRecordKey, entryType: 'planning-update-target',
        target: { type: 'initiative', entityId: 'launch' }, latestVersion: 0, updatedAt: event.occurredAt,
        cadence: { updateOwnerMemberKey: ownerMemberKey, cadence: { unit: 'week', count: 1 },
          nextDueAt, reminderHoursBefore: 24, timeZone: 'UTC' },
      }, $metadata: {} }
      if (key?.recordKey === 'ENTITY#launch') return { Item: { workspaceId: event.workspaceId, recordKey: 'ENTITY#launch',
        entryType: 'planning-entity', type: 'initiative', id: 'launch' }, $metadata: {} }
      if (key?.recordKey === `WATCHER#${memberKey}`) return { Item: { ...key, entryType: 'watcher', memberKey,
        state: subscribed ? 'subscribed' : 'unsubscribed' }, $metadata: {} }
      return { Item: { entryType: 'workspace-member', memberKey, role, status: 'active' }, $metadata: {} }
    })
    try {
      const snapshot = createRealtimeEnterpriseSnapshot({
        roleAssignments: [{ workspaceId: event.workspaceId, assignmentId: 'assignment-1', principalKind: 'directory-group',
          principalId: 'current-group', roleId: 'custom:planning-reader', source: 'direct',
          scope: { workspaceId: event.workspaceId, kind: 'workspace' } }],
        customRoles: [{ workspaceId: event.workspaceId, roleId: 'custom:planning-reader', name: 'Reader',
          permissions: ['planning.read'], guestAssignable: true, revision: 1, createdAt: event.occurredAt, updatedAt: event.occurredAt }],
      })
      const cache = createNotificationDeliveryAuthorizationCache()
      cache.expiresAt = Date.now() + 60_000
      const identity = { getSnapshot: async () => snapshot }
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(true)
      subscribed = false
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
      subscribed = true
      snapshot.customRoles[0]!.permissions = ['documents.read']
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
      snapshot.roleAssignments = []
      role = 'guest'
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
      role = 'member'
      ownerMemberKey = memberKey
      event.notificationCandidates = [{ memberKey, reason: 'reminder' }]
      snapshot.roleAssignments = [{ workspaceId: event.workspaceId, assignmentId: 'assignment-2', principalKind: 'member',
        principalId: memberKey, roleId: 'custom:planning-reader', source: 'direct',
        scope: { workspaceId: event.workspaceId, kind: 'workspace' } }]
      snapshot.customRoles[0]!.permissions = ['work-items.read']
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
      snapshot.customRoles[0]!.permissions = ['work-items.write']
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(true)
      snapshot.customRoles[0]!.permissions = ['planning.write']
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(true)
      expect(groupReads).toBe(12)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('uses current Triage restrictions, owner and Project before external delivery', async () => {
    const keys = ['WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const memberKey = 'member@example.com'
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => ({ Groups: [], $metadata: {} }))
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async () => ({
      Item: { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {},
    }))
    try {
      const event = createProjectionEvent({ eventType: 'triage.assigned', teamId: 'core', triageEntryId: 'entry-1',
        projectId: 'platform', notificationCandidates: [{ memberKey, reason: 'triage-assignment' }] })
      const cache = createNotificationDeliveryAuthorizationCache()
      cache.expiresAt = Date.now() + 60_000
      cache.directories.set(event.workspaceId, Promise.resolve([
        { entryType: 'team', teamId: 'core' },
        { entryType: 'project', teamId: 'core', projectId: 'platform' },
        { entryType: 'project', teamId: 'core', projectId: 'private' },
        { entryType: 'project-member', teamId: 'core', projectId: 'platform', memberKey, role: 'viewer' },
      ]))
      const identity = { getSnapshot: async () => createRealtimeEnterpriseSnapshot() }
      const current = { permission: { visibility: 'full', canReply: false, guestVisible: false, checkedAt: event.occurredAt },
        retention: { expiresAt: '2099-01-01T00:00:00.000Z' }, projectId: 'platform', ownerUserId: memberKey,
      } satisfies NonNullable<Awaited<ReturnType<NonNullable<Parameters<typeof authorizeNotificationDelivery>[5]>>>>
      /** Authorizes the same queued event against the current mutable Triage source. */
      const authorize = () => authorizeNotificationDelivery(event, memberKey, identity, cache, undefined, async () => current)
      expect(await authorize()).toBe(true)
      current.projectId = 'private'
      expect(await authorize()).toBe(false)
      current.projectId = 'platform'
      current.ownerUserId = 'other@example.com'
      expect(await authorize()).toBe(false)
      current.ownerUserId = memberKey
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, undefined, async () => ({
        ...current, permission: { ...current.permission, visibility: 'metadata-only' },
      }))).toBe(false)
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, undefined, async () => ({
        ...current, retention: { ...current.retention, redactedAt: event.occurredAt },
      }))).toBe(false)
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, undefined, async () => ({
        permission: current.permission, retention: current.retention, ownerUserId: memberKey,
      }))).toBe(false)
      const snapshot = createRealtimeEnterpriseSnapshot({
        roleAssignments: [{ workspaceId: event.workspaceId, assignmentId: 'assignment-1', principalKind: 'member',
          principalId: memberKey, roleId: 'custom:documents-only', source: 'direct',
          scope: { workspaceId: event.workspaceId, kind: 'workspace' } }],
        customRoles: [{ workspaceId: event.workspaceId, roleId: 'custom:documents-only', name: 'Documents only',
          permissions: ['documents.read'], guestAssignable: false, revision: 1,
          createdAt: event.occurredAt, updatedAt: event.occurredAt }],
      })
      cache.enterpriseSnapshots.set(event.workspaceId, Promise.resolve(snapshot))
      expect(await authorize()).toBe(false)
      snapshot.customRoles[0]!.permissions = ['work-items.read']
      expect(await authorize()).toBe(true)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('rechecks current document visibility for a queued mention even without Work Item scope', async () => {
    const keys = ['WORKSPACE_ACCESS_TABLE_NAME', 'COGNITO_USER_POOL_ID']
    const previous = keys.map((key) => process.env[key])
    keys.forEach((key) => { process.env[key] = key })
    const reads: GetDocumentRequest[] = []
    const commands: unknown[] = []
    const memberKey = 'member@example.com'
    const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => ({ Groups: [], $metadata: {} }))
    const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      commands.push(command)
      return { Item: { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {} }
    })
    try {
      const event = createProjectionEvent({ eventType: 'document.comment.created', entityId: 'private-document' })
      const cache = createNotificationDeliveryAuthorizationCache()
      cache.expiresAt = Date.now() + 60_000
      cache.directories.set(event.workspaceId, Promise.resolve([]))
      const identity = { getSnapshot: async () => createRealtimeEnterpriseSnapshot() }
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, async (request) => {
        reads.push(request)
        throw new DocumentError(403, 'DocumentViewDenied', 'Denied')
      })).toBe(false)
      expect(reads).toEqual([{ workspaceId: event.workspaceId, documentId: 'private-document', access: {
        memberKey, workspaceRole: 'member', isSystemAdmin: false, projectRoles: {},
      } }])
      expect(commands[0]).toBeInstanceOf(GetCommand)
      if (commands[0] instanceof GetCommand) expect(commands[0].input.ConsistentRead).toBe(true)
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, async () => ({}))).toBe(true)
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache, async () => {
        throw new DocumentError(403, 'DocumentViewDenied', 'Grant revoked')
      })).toBe(false)
      expect(await authorizeNotificationDelivery(event, memberKey, identity, cache)).toBe(false)
    } finally {
      send.mockRestore()
      groups.mockRestore()
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })
  test('queues only opted-in Slack notifications at the planned delivery time', () => {
    const event = createProjectionEvent()
    for (const slack of [true, false]) {
      const state = createNotificationProjectionDeliveryState('workspace-1#member@example.com', event.occurredAt, {
        version: 0, channels: { inApp: false, email: false, push: false, slack },
        frequency: 'hourly', quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      })
      const item = createNotificationProjectionItem(event, { memberKey: 'member@example.com', reasons: ['mention'] }, state)
      expect(item.slackNextAttemptAt).toBe(slack ? state.deliveryAfter : undefined)
      expect(item.slackDeliveryStatus).toBe(slack ? 'pending' : undefined)
      expect(item.slackQueueShard !== undefined).toBe(slack)
      expect(item.inAppVisible).toBe(false)
    }
  })
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

  test('fans scheduled Planning update events out only to the qualified target watcher', () => {
    expect(projectsSubscribedWatchers('planning-update.reminder')).toBe(true)
    expect(projectsSubscribedWatchers('planning-update.overdue')).toBe(true)
    expect(projectsSubscribedWatchers('planning-update.escalation')).toBe(true)
    expect(projectsSubscribedWatchers('planning-update.published')).toBe(false)
    expect(createSubscribedWatcherScopes(createProjectionEvent({
      eventType: 'planning-update.overdue',
      workspaceId: 'workspace/one',
      entityId: 'project/team%2Falpha%20space/project%2Fbeta%3F',
      projectId: 'project/beta?',
    }))).toEqual([
      {
        entityKey:
          'workspace/one#planning-update#project/team%2Falpha%20space/project%2Fbeta%3F',
        reason: 'watcher',
      },
    ])
  })

  test('resolves watchers for curated context and accepted-resolution audit events', () => {
    for (const eventType of [
      'planning-update.reminder',
      'planning-update.overdue',
      'planning-update.escalation',
      'context-item.created',
      'context-item.updated',
      'accepted-resolution.selected',
      'accepted-resolution.replaced',
      'accepted-resolution.edited',
    ]) {
      expect(supportsCollaborationWatcherNotifications(eventType)).toBeTrue()
    }
    expect(supportsCollaborationWatcherNotifications('context-item.superseded')).toBeFalse()
    expect(supportsCollaborationWatcherNotifications('context-item.read')).toBeFalse()
  })

  test('dispatches created and updated context items to upsert and superseded items to delete', async () => {
    const upserts: CuratedContextSearchProjectionInput[] = []
    const deletions: CuratedContextSearchProjectionInput[] = []
    const dependencies = {
      async upsertCurrent(input: CuratedContextSearchProjectionInput) {
        upserts.push(input)
      },
      async deleteCurrent(input: CuratedContextSearchProjectionInput) {
        deletions.push(input)
      },
    }
    const contextEventScope = {
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      contextItemId: 'context-1',
      targetId: 'team/core/issue/example/context-item/context-1',
    }

    await projectCuratedContextSearchEvent(
      createProjectionEvent({ ...contextEventScope, eventType: 'context-item.created' }),
      dependencies,
    )
    await projectCuratedContextSearchEvent(
      createProjectionEvent({ ...contextEventScope, eventType: 'context-item.updated' }),
      dependencies,
    )
    await projectCuratedContextSearchEvent(
      createProjectionEvent({ ...contextEventScope, eventType: 'context-item.superseded' }),
      dependencies,
    )

    expect(upserts).toEqual([
      {
        workspaceId: 'workspace-1',
        teamId: 'core',
        issueId: 'example',
        projectId: 'platform',
        contextItemId: 'context-1',
      },
      {
        workspaceId: 'workspace-1',
        teamId: 'core',
        issueId: 'example',
        projectId: 'platform',
        contextItemId: 'context-1',
      },
    ])
    expect(deletions).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      contextItemId: 'context-1',
    }])
  })

  test('converges orphaned created and updated context projections by deleting them', async () => {
    const upserts: CuratedContextSearchProjectionInput[] = []
    const deletions: CuratedContextSearchProjectionInput[] = []
    const dependencies = {
      async upsertCurrent(input: CuratedContextSearchProjectionInput) {
        upserts.push(input)
      },
      async deleteCurrent(input: CuratedContextSearchProjectionInput) {
        deletions.push(input)
      },
    }
    const contextEventScope = {
      teamId: 'core',
      issueId: 'example',
      contextItemId: 'context-1',
      targetId: 'team/core/issue/example/context-item/context-1',
    }

    await projectCuratedContextSearchEvent(
      createProjectionEvent({ ...contextEventScope, eventType: 'context-item.created' }),
      dependencies,
      false,
    )
    await projectCuratedContextSearchEvent(
      createProjectionEvent({ ...contextEventScope, eventType: 'context-item.updated' }),
      dependencies,
      false,
    )

    expect(upserts).toEqual([])
    expect(deletions).toEqual([
      {
        workspaceId: 'workspace-1',
        teamId: 'core',
        issueId: 'example',
        contextItemId: 'context-1',
      },
      {
        workspaceId: 'workspace-1',
        teamId: 'core',
        issueId: 'example',
        contextItemId: 'context-1',
      },
    ])
  })

  test('isolates duplicate Project IDs in different Teams when resolving Planning watchers', () => {
    const coreScopes = createSubscribedWatcherScopes(createProjectionEvent({
      eventType: 'planning-update.overdue',
      workspaceId: 'workspace-1',
      entityId: 'project/core-team/shared-launch',
      projectId: 'shared-launch',
    }))
    const designScopes = createSubscribedWatcherScopes(createProjectionEvent({
      eventType: 'planning-update.overdue',
      workspaceId: 'workspace-1',
      entityId: 'project/design-team/shared-launch',
      projectId: 'shared-launch',
    }))

    expect(coreScopes).toEqual([{
      entityKey: 'workspace-1#planning-update#project/core-team/shared-launch',
      reason: 'watcher',
    }])
    expect(designScopes).toEqual([{
      entityKey: 'workspace-1#planning-update#project/design-team/shared-launch',
      reason: 'watcher',
    }])
    expect(coreScopes[0]?.entityKey).not.toBe(designScopes[0]?.entityKey)
  })

  test('propagates context search failures so the stream record remains retryable', async () => {
    const projectionFailure = new Error('Workspace search is unavailable.')
    const event = createProjectionEvent({
      eventType: 'context-item.created',
      teamId: 'core',
      issueId: 'example',
      contextItemId: 'context-1',
      targetId: 'team/core/issue/example/context-item/context-1',
    })

    await expect(projectCuratedContextSearchEvent(event, {
      async upsertCurrent() {
        throw projectionFailure
      },
      async deleteCurrent() {},
    })).rejects.toBe(projectionFailure)

    await expect(projectCuratedContextSearchEvent(
      { ...event, eventType: 'context-item.superseded' },
      {
        async upsertCurrent() {},
        async deleteCurrent() {
          throw projectionFailure
        },
      },
    )).rejects.toBe(projectionFailure)
  })

  test('does not acknowledge a context search projection when the parent assignment changes', async () => {
    const upserts: CuratedContextSearchProjectionInput[] = []
    const deletions: CuratedContextSearchProjectionInput[] = []
    const scopes = [
      { checked: true, exists: true, projectId: 'platform' },
      { checked: true, exists: true, projectId: 'product' },
    ]
    let readCount = 0
    const event = createProjectionEvent({
      eventType: 'context-item.created',
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      contextItemId: 'context-1',
      targetId: 'team/core/issue/example/context-item/context-1',
    })

    await expect(projectCuratedContextSearchEventWithParentFence(event, {
      async upsertCurrent(input) {
        upserts.push(input)
      },
      async deleteCurrent(input) {
        deletions.push(input)
      },
    }, async () => scopes[readCount++] ?? scopes.at(-1)!)).rejects.toThrow(
      'parent scope changed during projection',
    )

    expect(upserts).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      contextItemId: 'context-1',
    }])
    expect(deletions).toEqual([{
      workspaceId: 'workspace-1',
      teamId: 'core',
      issueId: 'example',
      projectId: 'platform',
      contextItemId: 'context-1',
    }])
  })

  test('fences the Search receipt to the parent Work Item scope', () => {
    const event = createProjectionEvent({
      teamId: 'core',
      issueId: 'example',
    })

    expect(createCuratedContextSearchParentCondition('team-issues', event, {
      checked: true,
      exists: true,
      projectId: 'platform',
    })).toEqual({
      ConditionCheck: {
        TableName: 'team-issues',
        Key: {
          directoryTeamId: 'workspace-1#team#core',
          issueId: 'example',
        },
        ConditionExpression:
          'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #assignedProjectId = :assignedProjectId',
        ExpressionAttributeNames: { '#assignedProjectId': 'assignedProjectId' },
        ExpressionAttributeValues: { ':assignedProjectId': 'platform' },
      },
    })

    expect(createCuratedContextSearchParentCondition('team-issues', event, {
      checked: true,
      exists: false,
    })).toEqual({
      ConditionCheck: {
        TableName: 'team-issues',
        Key: {
          directoryTeamId: 'workspace-1#team#core',
          issueId: 'example',
        },
        ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
      },
    })
  })

  test('fails closed when curated context audit scope metadata is incomplete', async () => {
    await expect(projectCuratedContextSearchEvent(createProjectionEvent({
      eventType: 'context-item.updated',
      teamId: 'core',
      issueId: 'example',
      targetId: 'team/core/issue/example/context-item/context-1',
    }), {
      async upsertCurrent() {},
      async deleteCurrent() {},
    })).rejects.toThrow('context item ID is missing')
  })

  test('parses curated context item identity from audit metadata', () => {
    expect(parseAuditProjectionEvent({
      eventId: 'evt-context-1',
      eventType: 'context-item.created',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T12:00:00.000Z',
      entityType: 'work-item',
      entityId: 'team/core/issue/example',
      target: {
        type: 'context-item',
        id: 'team/core/issue/example/context-item/context-1',
      },
      metadata: {
        teamId: 'core',
        issueId: 'example',
        contextItemId: 'context-1',
        sourceRevision: 4,
      },
    })).toMatchObject({ contextItemId: 'context-1', sourceRevision: 4 })
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
    }, {
      deletedFileCleanup: dependencies,
      curatedContextSearch: {
        async upsertCurrent() {},
        async deleteCurrent() {},
      },
      realtime: { async publish() {} },
    })

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'stream-sequence-1' }],
    })
  })

  test('publishes the stable collaboration invalidation payload to its exact scope', async () => {
    const publications: Array<{
      scopeKey: string
      payload: Readonly<Record<string, unknown>>
    }> = []
    const event = createProjectionEvent({
      eventId: 'evt-realtime-1',
      eventType: 'comment.updated',
      entityId: 'team/core/issue/example',
      targetId: 'comment-1',
      occurredAt: '2026-07-12T12:30:00.000Z',
    })

    await publishRealtimeInvalidation(event, {
      async publish(scopeKey, payload) {
        publications.push({ scopeKey, payload })
      },
    })

    expect(publications).toEqual([{
      scopeKey: 'workspace-1#work-item#team/core/issue/example',
      payload: {
        type: 'collaboration.invalidated',
        eventId: 'evt-realtime-1',
        eventType: 'comment.updated',
        scopeKey: 'workspace-1#work-item#team/core/issue/example',
        entityId: 'team/core/issue/example',
        targetId: 'comment-1',
        occurredAt: '2026-07-12T12:30:00.000Z',
      },
    }])
  })

  test('propagates realtime publisher rejection for partial batch retry handling', async () => {
    const failure = new Error('Realtime delivery unavailable')

    await expect(publishRealtimeInvalidation(createProjectionEvent(), {
      async publish() {
        throw failure
      },
    })).rejects.toBe(failure)
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

  test('preserves a structured Triage target from audit metadata into notification rows', () => {
    const event = parseAuditProjectionEvent({
      eventId: 'triage-sla-breached-1',
      eventType: 'triage.sla-breached',
      workspaceId: 'workspace-1',
      occurredAt: '2026-08-09T12:00:00.000Z',
      actorUserId: 'system:triage-schedule',
      entityType: 'triage-entry',
      entityId: 'triage_20260809_sla',
      summary: 'Triage response SLA was breached.',
      metadata: {
        actorMemberKey: 'system:triage-schedule',
        deepLink: '/teams/core-team/triage?entryId=triage_20260809_sla',
        notificationCandidates: [{
          memberKey: 'triager@example.com',
          reason: 'triage-sla',
        }],
        notificationTitle: 'Triage SLA breached',
        teamId: 'core-team',
        triageEntryId: 'triage_20260809_sla',
      },
    })
    expect(event).toBeDefined()
    if (!event) throw new Error('Triage audit event was not parsed.')
    const deliveryState = createNotificationProjectionDeliveryState(
      'workspace-1#triager@example.com',
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
      { memberKey: 'triager@example.com', reasons: ['triage-sla'] },
      deliveryState,
      1_800_000_000,
    )).toMatchObject({
      deepLink: '/teams/core-team/triage?entryId=triage_20260809_sla',
      entityId: 'triage_20260809_sla',
      teamId: 'core-team',
      triageEntryId: 'triage_20260809_sla',
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
      statusCategory: 'started',
    })).toBeUndefined()
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'old-owner@example.com',
      checked: true,
      dueDate: '2026-07-12',
      exists: true,
      statusCategory: 'started',
    })?.notificationCandidates).toEqual([{
      memberKey: 'old-owner@example.com',
      reason: 'due',
    }])
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'new-owner@example.com',
      checked: true,
      dueDate: '2026-07-13',
      exists: true,
      statusCategory: 'started',
    })).toBeUndefined()
    expect(refreshScheduledNotificationEvent(scheduledEvent, {
      assigneeMemberKey: 'new-owner@example.com',
      checked: true,
      dueDate: '2026-07-12',
      exists: true,
      statusCategory: 'completed',
    })).toBeUndefined()
  })

  test('parses and revalidates scheduled Planning notifications against current cadence state', () => {
    const parsed = parseAuditProjectionEvent({
      eventId: 'evt-planning-overdue',
      eventType: 'planning-update.overdue',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T10:00:00.000Z',
      entity: { type: 'planning-update-target', id: 'project/core/platform' },
      metadata: {
        teamId: 'core',
        projectId: 'platform',
        planningTargetType: 'project',
        planningTargetId: 'platform',
        planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
        planningNextDueAt: '2026-07-12T09:00:00.000Z',
        planningNotificationKind: 'overdue',
        notificationCandidates: [{
          memberKey: 'owner@example.com',
          reason: 'overdue',
        }],
      },
    })
    expect(parsed).toMatchObject({
      planningTargetType: 'project',
      planningTargetId: 'platform',
      planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
      planningNextDueAt: '2026-07-12T09:00:00.000Z',
      planningNotificationKind: 'overdue',
    })
    if (!parsed) throw new Error('Expected a parsed Planning notification event.')
    const deliveryState = createNotificationProjectionDeliveryState(
      'workspace-1#owner@example.com',
      parsed.occurredAt,
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
      parsed,
      { memberKey: 'owner@example.com', reasons: ['overdue'] },
      deliveryState,
      1_800_000_000,
    )).toMatchObject({
      planningTargetType: 'project',
      planningTargetId: 'platform',
      planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
      planningNextDueAt: '2026-07-12T09:00:00.000Z',
      planningNotificationKind: 'overdue',
    })

    const current: CurrentPlanningUpdateNotificationScope = {
      checked: true,
      exists: true,
      archived: false,
      targetType: 'project',
      targetId: 'platform',
      targetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
      ownerMemberKey: 'owner@example.com',
      escalationMemberKey: 'manager@example.com',
      nextDueAt: '2026-07-12T09:00:00.000Z',
      teamId: 'core',
      projectId: 'platform',
    }
    expect(refreshPlanningScheduledNotificationEvent(parsed, current))
      .toMatchObject({
        notificationCandidates: [{
          memberKey: 'owner@example.com',
          reason: 'overdue',
        }],
      })
    expect(refreshPlanningScheduledNotificationEvent(parsed, {
      ...current,
      ownerMemberKey: 'new-owner@example.com',
    })).toBeUndefined()
    expect(refreshPlanningScheduledNotificationEvent(parsed, {
      ...current,
      nextDueAt: '2026-07-19T09:00:00.000Z',
    })).toBeUndefined()
    expect(refreshPlanningScheduledNotificationEvent(parsed, {
      ...current,
      archived: true,
    })).toBeUndefined()
  })

  test('requires the current explicit escalation recipient for Planning escalation events', () => {
    const event = createProjectionEvent({
      eventType: 'planning-update.escalation',
      planningTargetType: 'initiative',
      planningTargetId: 'launch',
      planningTargetRecordKey: 'UPDATE_TARGET#INITIATIVE#launch',
      planningNextDueAt: '2026-07-12T09:00:00.000Z',
      planningNotificationKind: 'escalation',
      notificationCandidates: [{
        memberKey: 'manager@example.com',
        reason: 'escalation',
      }],
    })
    const current: CurrentPlanningUpdateNotificationScope = {
      checked: true,
      exists: true,
      archived: false,
      targetType: 'initiative',
      targetId: 'launch',
      targetRecordKey: 'UPDATE_TARGET#INITIATIVE#launch',
      ownerMemberKey: 'owner@example.com',
      escalationMemberKey: 'manager@example.com',
      nextDueAt: '2026-07-12T09:00:00.000Z',
      teamId: 'core',
      projectId: 'platform',
    }

    expect(refreshPlanningScheduledNotificationEvent(event, current))
      .toBeDefined()
    expect(refreshPlanningScheduledNotificationEvent(event, {
      ...current,
      escalationMemberKey: 'director@example.com',
    })).toBeUndefined()
    expect(refreshPlanningScheduledNotificationEvent(event, {
      ...current,
      escalationMemberKey: undefined,
    })).toBeUndefined()
  })

  test('overlays the current assigned Project on every checked Work Item notification', () => {
    const event = createProjectionEvent({
      eventType: 'comment.created',
      issueId: 'context-issue',
      projectId: 'project-a',
      teamId: 'core-team',
    })

    expect(overlayCurrentWorkItemNotificationScope(event, {
      checked: true,
      exists: true,
      projectId: 'project-b',
    })).toMatchObject({ projectId: 'project-b' })
    expect(overlayCurrentWorkItemNotificationScope(event, {
      checked: true,
      exists: true,
    })).not.toHaveProperty('projectId')
  })

  test('accepts only canonical ISO Work Item due dates from audit metadata', () => {
    const event = {
      eventId: 'evt-due-date',
      eventType: 'work-item.due',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-12T12:00:00.000Z',
      entityType: 'work-item',
      entityId: 'team/core/issue/example',
    }

    expect(parseAuditProjectionEvent({
      ...event,
      metadata: { dueDate: '2026-07-12' },
    })?.dueDate).toBe('2026-07-12')
    expect(parseAuditProjectionEvent({
      ...event,
      metadata: { dueDate: '2026/07/12' },
    })?.dueDate).toBeUndefined()
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

  test('fails closed for duplicate Project IDs unless membership is Team-qualified', () => {
    const directory: ProjectDirectoryItem[] = [
      { entryType: 'team', teamId: 'design' },
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'design', projectId: 'shared-launch' },
      { entryType: 'project', teamId: 'core', projectId: 'shared-launch' },
      {
        entryType: 'project-member',
        projectId: 'shared-launch',
        memberKey: 'member@example.com',
        role: 'viewer',
      },
    ]

    expect(hasEligibleProjectAccess(
      { teamId: 'core', projectId: 'shared-launch' },
      'member@example.com',
      directory,
    )).toBe(false)
    expect(hasEligibleProjectAccess(
      { teamId: 'design', projectId: 'shared-launch' },
      'member@example.com',
      directory,
    )).toBe(false)

    const qualifiedDirectory = directory.map((item) =>
      item.entryType === 'project-member' ? { ...item, teamId: 'core' } : item
    )
    expect(hasEligibleProjectAccess(
      { teamId: 'core', projectId: 'shared-launch' },
      'member@example.com',
      qualifiedDirectory,
    )).toBe(true)
    expect(hasEligibleProjectAccess(
      { teamId: 'design', projectId: 'shared-launch' },
      'member@example.com',
      qualifiedDirectory,
    )).toBe(false)
  })

  test('uses authoritative Enterprise role assignments for cadence notifications', () => {
    const event = {
      workspaceId: 'workspace-1',
      teamId: 'core',
      projectId: 'platform',
      planningNotificationKind: 'overdue',
    } satisfies Pick<
      AuditProjectionEvent,
      'workspaceId' | 'projectId' | 'teamId' | 'planningNotificationKind'
    >
    const snapshot = createRealtimeEnterpriseSnapshot({
      roleAssignments: [{
        workspaceId: 'workspace-1',
        assignmentId: 'assignment-1',
        principalKind: 'member',
        principalId: 'member@example.com',
        roleId: 'project:member',
        scope: {
          workspaceId: 'workspace-1',
          kind: 'project',
          targetId: 'platform',
        },
        source: 'direct',
      }],
    })

    expect(hasEligibleEnterpriseNotificationAccess(
      event,
      'MEMBER@example.com',
      'member',
      snapshot,
      'core',
    )).toBe(true)
    expect(hasEligibleEnterpriseNotificationAccess(
      event,
      'other@example.com',
      'member',
      snapshot,
      'core',
    )).toBe(false)
  })

  test('does not fall back to a legacy project ACL after an authoritative Enterprise denial', () => {
    const event = {
      workspaceId: 'workspace-1',
      teamId: 'core',
      projectId: 'platform',
      planningNotificationKind: 'overdue',
    } satisfies Pick<
      AuditProjectionEvent,
      'workspaceId' | 'projectId' | 'teamId' | 'planningNotificationKind'
    >
    const snapshot = createRealtimeEnterpriseSnapshot({
      roleAssignments: [{
        workspaceId: 'workspace-1',
        assignmentId: 'assignment-viewer',
        principalKind: 'member',
        principalId: 'member@example.com',
        roleId: 'project:viewer',
        scope: {
          workspaceId: 'workspace-1',
          kind: 'project',
          targetId: 'platform',
        },
        source: 'direct',
      }],
    })
    const legacyDirectory: ProjectDirectoryItem[] = [
      { entryType: 'team', teamId: 'core' },
      { entryType: 'project', teamId: 'core', projectId: 'platform' },
      {
        entryType: 'project-member',
        teamId: 'core',
        projectId: 'platform',
        memberKey: 'member@example.com',
        role: 'viewer',
      },
    ]

    expect(hasEligibleProjectAccess(event, 'member@example.com', legacyDirectory)).toBe(true)
    expect(resolveEnterpriseNotificationAuthorization(
      event,
      'member@example.com',
      'member',
      snapshot,
      'core',
    )).toEqual({ authoritative: true, allowed: false })
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

  test('realtime separates active resource existence from legacy project membership', () => {
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
      authenticatedAt: 1_999_999_000,
      tokenExpiresAt: 2_000_000_000,
      authenticationSessionId: 'authentication-session-1',
      authenticationMethods: ['pwd'],
      clientIp: '203.0.113.10',
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
    const directoryWithoutLegacyMember = activeDirectory.filter((item) =>
      item.entryType !== 'project-member'
    )
    expect(hasActiveRealtimeResourceScope(session, directoryWithoutLegacyMember)).toBe(true)
    expect(hasRealtimeLegacyDirectoryAccess(session, directoryWithoutLegacyMember)).toBe(false)
    expect(hasRealtimeDirectoryAccess(session, directoryWithoutLegacyMember)).toBe(false)
    expect(hasRealtimeDirectoryAccess(session, [
      { entryType: 'team', teamId: 'core', archivedAt: '2026-07-12T12:00:00.000Z' },
      ...activeDirectory.slice(1),
    ])).toBe(false)
    expect(hasCurrentRealtimeWorkItemScope(session, createRealtimeWorkItem())).toBe(true)
    expect(hasCurrentRealtimeWorkItemScope(session, createRealtimeWorkItem({
      directoryProjectId: 'workspace-1#project#replacement-project',
      assignedProjectId: 'replacement-project',
    }))).toBe(false)
    expect(hasCurrentRealtimeWorkItemScope(session, {
      ...createRealtimeWorkItem(),
      status: 'started',
    })).toBe(false)
  })

  test('realtime enterprise access combines live SCIM/Cognito groups and authoritative roles', async () => {
    const updatedAt = '2026-07-18T00:00:00.000Z'
    const snapshot = createRealtimeEnterpriseSnapshot({
      identityProviders: [{
        workspaceId: 'workspace-1',
        providerId: 'provider-1',
        kind: 'oidc',
        displayName: 'Enterprise OIDC',
        cognitoProviderName: 'EnterpriseOidc',
        status: 'active',
        revision: 1,
        issuer: 'https://idp.example.com',
        clientId: 'enterprise-client',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
        scopes: ['openid', 'email'],
        createdAt: updatedAt,
        updatedAt,
        lastTestedAt: updatedAt,
      }],
      customRoles: [{
        workspaceId: 'workspace-1',
        roleId: 'custom:realtime-reader',
        name: 'Realtime reader',
        permissions: ['work-items.read'],
        guestAssignable: true,
        revision: 1,
        createdAt: updatedAt,
        updatedAt,
      }],
      groupMappings: [{
        workspaceId: 'workspace-1',
        mappingId: 'mapping-1',
        identityProviderId: 'provider-1',
        directoryGroupId: 'entra-readers',
        roleId: 'custom:realtime-reader',
        scope: { workspaceId: 'workspace-1', kind: 'workspace' },
        enabled: true,
        priority: 10,
        revision: 1,
        updatedAt,
      }],
      scimUsers: [{
        workspaceId: 'workspace-1',
        userId: 'scim-user-1',
        externalId: 'external-user-1',
        identityProviderId: 'provider-1',
        userName: 'member@example.com',
        emails: ['member@example.com'],
        active: true,
        linkedMemberKey: 'member@example.com',
        groupIds: ['scim-group-1'],
        version: 1,
        appliedVersion: 1,
        appliedAt: updatedAt,
        createdAt: updatedAt,
        updatedAt,
      }],
      scimGroups: [{
        workspaceId: 'workspace-1',
        groupId: 'scim-group-1',
        externalId: 'entra-readers',
        identityProviderId: 'provider-1',
        displayName: 'Realtime readers',
        active: true,
        memberUserIds: ['scim-user-1'],
        version: 1,
        appliedVersion: 1,
        appliedAt: updatedAt,
        createdAt: updatedAt,
        updatedAt,
      }],
    })

    const access = evaluateRealtimeEnterpriseAccess({
      snapshot,
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: ['cognito-current-group'],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: false,
      legacyWriteAllowed: false,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })

    expect(access).toMatchObject({
      allowed: true,
      canWrite: false,
      external: false,
      workspaceRoleSuppressed: true,
    })
    expect(access.directoryGroupIds).toEqual(['cognito-current-group'])
    expect(await hasValidRealtimeCognitoProviderBindings(
      snapshot,
      'member@example.com',
      'member@example.com',
      'EnterpriseOidc',
      async () => ({
        providerName: 'EnterpriseOidc',
        providerType: 'OIDC',
        providerDetails: {
          oidc_issuer: 'https://idp.example.com',
          client_id: 'enterprise-client',
        },
      }),
    )).toBe(true)
    expect(await hasValidRealtimeCognitoProviderBindings(
      snapshot,
      'member@example.com',
      'member@example.com',
      'EnterpriseOidc',
      async () => ({
        providerName: 'EnterpriseOidc',
        providerType: 'OIDC',
        providerDetails: {
          oidc_issuer: 'https://replacement.example.com',
          client_id: 'enterprise-client',
        },
      }),
    )).toBe(false)

    const unqualifiedCognitoMappingAccess = evaluateRealtimeEnterpriseAccess({
      snapshot: {
        ...snapshot,
        groupMappings: snapshot.groupMappings.map((mapping) => ({
          ...mapping,
          directoryGroupId: 'cognito-current-group',
        })),
        scimUsers: [],
        scimGroups: [],
      },
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: ['cognito-current-group'],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: true,
      legacyWriteAllowed: true,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })
    expect(unqualifiedCognitoMappingAccess).toMatchObject({
      allowed: true,
      canWrite: true,
      workspaceRoleSuppressed: false,
    })

    const mismatchedProviderAccess = evaluateRealtimeEnterpriseAccess({
      snapshot: {
        ...snapshot,
        groupMappings: snapshot.groupMappings.map((mapping) => ({
          ...mapping,
          identityProviderId: 'provider-2',
        })),
      },
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: [],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: true,
      legacyWriteAllowed: true,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })
    expect(mismatchedProviderAccess).toMatchObject({
      allowed: false,
      canWrite: false,
      workspaceRoleSuppressed: true,
    })

    const directMemberAssignmentAccess = evaluateRealtimeEnterpriseAccess({
      snapshot: {
        ...snapshot,
        groupMappings: [],
        scimUsers: [],
        scimGroups: [],
        roleAssignments: [{
          workspaceId: 'workspace-1',
          assignmentId: 'assignment-member-1',
          principalKind: 'member',
          principalId: 'member@example.com',
          roleId: 'custom:realtime-reader',
          scope: {
            workspaceId: 'workspace-1',
            kind: 'project',
            targetId: 'platform',
          },
          source: 'direct',
        }],
      },
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: [],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: false,
      legacyWriteAllowed: false,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })
    expect(directMemberAssignmentAccess).toMatchObject({
      allowed: true,
      canWrite: false,
      workspaceRoleSuppressed: true,
    })

    const directGroupAssignmentAccess = evaluateRealtimeEnterpriseAccess({
      snapshot: {
        ...snapshot,
        groupMappings: [],
        scimUsers: [],
        scimGroups: [],
        roleAssignments: [{
          workspaceId: 'workspace-1',
          assignmentId: 'assignment-group-1',
          principalKind: 'directory-group',
          principalId: 'cognito-current-group',
          roleId: 'custom:realtime-reader',
          scope: { workspaceId: 'workspace-1', kind: 'workspace' },
          source: 'direct',
        }],
      },
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: ['cognito-current-group'],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: false,
      legacyWriteAllowed: false,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })
    expect(directGroupAssignmentAccess).toMatchObject({
      allowed: true,
      canWrite: false,
      workspaceRoleSuppressed: true,
    })

    const projectScopedAccess = evaluateRealtimeEnterpriseAccess({
      snapshot: {
        ...snapshot,
        groupMappings: snapshot.groupMappings.map((mapping) => ({
          ...mapping,
          scope: {
            workspaceId: 'workspace-1',
            kind: 'project' as const,
            targetId: 'platform',
          },
        })),
      },
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'member',
      cognitoGroupIds: [],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: false,
      legacyWriteAllowed: false,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    })
    expect(projectScopedAccess).toMatchObject({
      allowed: true,
      canWrite: false,
      workspaceRoleSuppressed: true,
    })

    const teamScopedAuthoritativeDenial = evaluateRealtimeEnterpriseAccess({
      snapshot: createRealtimeEnterpriseSnapshot({
        customRoles: [{
          workspaceId: 'workspace-1',
          roleId: 'custom:file-only',
          name: 'File only',
          permissions: ['files.read'],
          guestAssignable: true,
          revision: 1,
          createdAt: updatedAt,
          updatedAt,
        }],
        roleAssignments: [{
          workspaceId: 'workspace-1',
          assignmentId: 'assignment-team-1',
          principalKind: 'member',
          principalId: 'member@example.com',
          roleId: 'custom:file-only',
          scope: {
            workspaceId: 'workspace-1',
            kind: 'team',
            targetId: 'core',
          },
          source: 'direct',
        }],
      }),
      memberKey: 'member@example.com',
      memberEmail: 'member@example.com',
      workspaceRole: 'owner',
      cognitoGroupIds: [],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: true,
      legacyWriteAllowed: true,
      teamId: 'core',
    })
    expect(teamScopedAuthoritativeDenial).toMatchObject({
      allowed: false,
      canWrite: false,
      workspaceRoleSuppressed: true,
    })
  })

  test('realtime shares raw Cognito provider reads only within the short cache TTL', async () => {
    let currentTime = 0
    let reads = 0
    const readBinding = createCachedRealtimeCognitoProviderBindingReader(
      async (providerName) => {
        reads += 1
        return {
          providerName,
          providerType: 'OIDC',
          providerDetails: {
            oidc_issuer: 'https://idp.example.com',
            client_id: 'enterprise-client',
          },
        }
      },
      () => currentTime,
    )

    const [first, second] = await Promise.all([
      readBinding('EnterpriseOidc'),
      readBinding('EnterpriseOidc'),
    ])
    expect(first).toEqual(second)
    expect(reads).toBe(1)

    currentTime = 29_999
    await readBinding('EnterpriseOidc')
    expect(reads).toBe(1)

    currentTime = 30_000
    await readBinding('EnterpriseOidc')
    expect(reads).toBe(2)
  })

  test('realtime SSO assurance rejects password and stale provider-revision tickets', () => {
    const updatedAt = '2026-07-18T00:00:00.000Z'
    const provider = {
      workspaceId: 'workspace-1',
      providerId: 'provider-1',
      kind: 'oidc' as const,
      displayName: 'Enterprise OIDC',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active' as const,
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'enterprise-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: updatedAt,
      updatedAt,
      lastTestedAt: updatedAt,
    }
    const snapshot = createRealtimeEnterpriseSnapshot({
      identityProviders: [provider],
      domains: [{
        workspaceId: 'workspace-1',
        domainId: 'domain-1',
        domain: 'example.com',
        status: 'verified',
        verificationRecordName: '_mukuroji.example.com',
        enforceSso: true,
        identityProviderId: provider.providerId,
        revision: 1,
        createdAt: updatedAt,
        updatedAt,
        verifiedAt: updatedAt,
      }],
    })
    const currentMarker = createEnterpriseSsoAuthenticationMethod(
      provider.providerId,
      provider.revision,
    )

    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      snapshot,
      'member@example.com',
      ['PASSWORD'],
    )).toBe(false)
    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      snapshot,
      'member@example.com',
      [currentMarker],
    )).toBe(true)

    const revisedSnapshot = {
      ...snapshot,
      identityProviders: [{ ...provider, revision: provider.revision + 1 }],
    }
    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      revisedSnapshot,
      'member@example.com',
      [currentMarker],
    )).toBe(false)
    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      revisedSnapshot,
      'member@example.com',
      [createEnterpriseSsoAuthenticationMethod(provider.providerId, provider.revision + 1)],
    )).toBe(true)
    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      snapshot,
      'external@other.example',
      ['PASSWORD'],
    )).toBe(true)
    expect(hasCurrentRealtimeEnterpriseSsoAssurance(
      { ...snapshot, identityProviders: [] },
      'member@example.com',
      [currentMarker],
    )).toBe(false)
  })

  test('realtime selects legacy ACL without weakening external ceilings or SCIM deactivation', () => {
    const updatedAt = '2026-07-18T00:00:00.000Z'
    const policy = {
      workspaceId: 'workspace-1',
      loginMode: 'password-or-sso',
      mfaRequirement: 'optional',
      sessionLifetimeMinutes: 480,
      idleTimeoutMinutes: 60,
      reauthenticationIntervalMinutes: 120,
      sensitiveActionReauthenticationMinutes: 15,
      ipAllowlistMode: 'disabled',
      ipAllowlist: [],
      externalAccess: {
        allowGuests: true,
        allowExternalCollaborators: true,
        requireMfa: false,
        maximumSessionLifetimeMinutes: 120,
        allowedGuestDomains: [],
        permissionCeiling: ['work-items.read'],
      },
      revision: 1,
      updatedAt,
      updatedBy: 'owner@example.com',
    } satisfies EnterpriseSecurityPolicy
    const snapshot = createRealtimeEnterpriseSnapshot({
      policy,
      domains: [{
        workspaceId: 'workspace-1',
        domainId: 'domain-1',
        domain: 'managed.example',
        status: 'verified',
        verificationRecordName: '_mukuroji.managed.example',
        enforceSso: false,
        revision: 1,
        createdAt: updatedAt,
        updatedAt,
      }],
    })
    const baseInput = {
      snapshot,
      memberKey: 'external@example.net',
      memberEmail: 'external@example.net',
      workspaceRole: 'member',
      cognitoGroupIds: [],
      currentSystemAdministrator: false,
      breakGlass: false,
      legacyReadAllowed: true,
      legacyWriteAllowed: true,
      teamId: 'core',
      projectId: 'platform',
      projectScopeOwnerTeamId: 'core',
    } satisfies EvaluateRealtimeEnterpriseAccessInput

    expect(evaluateRealtimeEnterpriseAccess(baseInput)).toMatchObject({
      allowed: true,
      canWrite: false,
      external: true,
    })
    expect(evaluateRealtimeEnterpriseAccess({
      ...baseInput,
      legacyReadAllowed: false,
    })).toMatchObject({ allowed: false, canWrite: false })
    expect(evaluateRealtimeEnterpriseAccess({
      ...baseInput,
      workspaceRole: 'guest',
      snapshot: {
        ...snapshot,
        policy: {
          ...policy,
          externalAccess: {
            ...policy.externalAccess,
            allowGuests: false,
          },
        },
      },
    })).toMatchObject({ allowed: false, canWrite: false, external: true })
    expect(evaluateRealtimeEnterpriseAccess({
      ...baseInput,
      snapshot: {
        ...snapshot,
        identityProviders: [{
          workspaceId: 'workspace-1',
          providerId: 'provider-1',
          kind: 'oidc',
          displayName: 'Enterprise OIDC',
          cognitoProviderName: 'EnterpriseOidc',
          status: 'active',
          revision: 1,
          issuer: 'https://idp.example.com',
          clientId: 'enterprise-client',
          authorizationEndpoint: 'https://idp.example.com/authorize',
          tokenEndpoint: 'https://idp.example.com/token',
          jwksUri: 'https://idp.example.com/jwks',
          scopes: ['openid', 'email'],
          createdAt: updatedAt,
          updatedAt,
          lastTestedAt: updatedAt,
        }],
        scimUsers: [{
          workspaceId: 'workspace-1',
          userId: 'scim-user-1',
          externalId: 'external-user-1',
          identityProviderId: 'provider-1',
          userName: 'external@example.net',
          emails: ['external@example.net'],
          active: false,
          linkedMemberKey: 'external@example.net',
          groupIds: [],
          version: 2,
          appliedVersion: 1,
          appliedAt: updatedAt,
          createdAt: updatedAt,
          updatedAt,
        }],
      },
    })).toMatchObject({ allowed: false, canWrite: false })
  })

  test('realtime enterprise session obeys current policy reductions and idle deadlines', () => {
    const now = 2_000_000_000
    const policy = {
      workspaceId: 'workspace-1',
      loginMode: 'password-or-sso',
      mfaRequirement: 'optional',
      sessionLifetimeMinutes: 60,
      idleTimeoutMinutes: 10,
      reauthenticationIntervalMinutes: 5,
      sensitiveActionReauthenticationMinutes: 1,
      ipAllowlistMode: 'disabled',
      ipAllowlist: [],
      externalAccess: {
        allowGuests: true,
        allowExternalCollaborators: true,
        requireMfa: false,
        maximumSessionLifetimeMinutes: 2,
        allowedGuestDomains: [],
        permissionCeiling: ['work-items.read'],
      },
      revision: 1,
      updatedAt: '2026-07-18T00:00:00.000Z',
      updatedBy: 'owner@example.com',
    } satisfies EnterpriseSecurityPolicy
    const toTimestamp = (epochSeconds: number) => new Date(epochSeconds * 1_000).toISOString()
    const session = {
      authorizationExpiresAt: now + 3_600,
      authenticatedAt: now - 30,
      tokenExpiresAt: now + 3_600,
      authenticationMethods: ['pwd', 'software_token_mfa'],
      clientIp: '203.0.113.10',
      createdAt: toTimestamp(now - 300),
      connectedAt: toTimestamp(now - 300),
      lastSeenAt: toTimestamp(now - 60),
    }

    expect(isRealtimeEnterpriseSessionFresh(policy, session, false, false, false, now)).toBe(true)
    expect(isRealtimeEnterpriseSessionFresh(policy, {
      ...session,
      createdAt: toTimestamp(now - 301),
    }, false, false, false, now)).toBe(false)
    expect(isRealtimeEnterpriseSessionFresh(policy, {
      ...session,
      lastSeenAt: toTimestamp(now - 601),
    }, false, false, false, now)).toBe(false)
    expect(isRealtimeEnterpriseSessionFresh(policy, {
      ...session,
      createdAt: toTimestamp(now - 121),
    }, true, false, false, now)).toBe(false)
    expect(isRealtimeEnterpriseSessionFresh(policy, {
      ...session,
      createdAt: toTimestamp(now - 61),
    }, false, true, false, now)).toBe(false)
    expect(isRealtimeEnterpriseSessionFresh(undefined, {
      ...session,
      authorizationExpiresAt: now,
    }, false, false, false, now)).toBe(false)
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
