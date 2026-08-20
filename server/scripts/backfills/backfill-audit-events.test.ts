import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import { mapCurrentTeamIssue, mapWorkspaceAccessItem } from './backfill-audit-events'

const workspaceAuditPseudonymKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const mapWorkspaceAccess = (item: Record<string, unknown>) =>
  mapWorkspaceAccessItem(item, workspaceAuditPseudonymKey)

function createCanonicalWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'release-checklist',
    sortOrder: 10,
    title: 'Release checklist',
    description: 'Verify the release candidate.',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'review',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    schedule: createDefaultDueDateWorkItemSchedule('2026-07-31'),
    priority: 'high',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('audit backfill canonical Work Item mapping', () => {
  test('includes the required creator as a redacted snapshot change', () => {
    const event = mapCurrentTeamIssue(createCanonicalWorkItem())

    expect(event).toBeDefined()
    expect(event?.changes).toEqual(expect.arrayContaining([
      {
        field: 'creatorMemberKey',
        after: '[REDACTED]',
        redacted: true,
      },
      {
        field: 'schedule.mode',
        after: 'due-date',
      },
      {
        field: 'schedule.dueDate',
        after: '2026-07-31',
      },
      {
        field: 'schedule.calendarPolicy.timeZone',
        after: 'UTC',
      },
    ]))
  })

  test('fails closed on non-canonical Work Item rows', () => {
    for (const item of [
      createCanonicalWorkItem({ creatorMemberKey: undefined }),
      createCanonicalWorkItem({ relationIds: undefined }),
      createCanonicalWorkItem({ status: 'review' }),
    ]) {
      expect(() => mapCurrentTeamIssue(item)).toThrow(
        'Audit backfill encountered a non-canonical Work Item row.',
      )
    }
  })
})

describe('audit backfill Workspace access mapping', () => {
  test('maps a Workspace member snapshot with scoped IDs and redacted identity fields', () => {
    const item = {
      workspaceId: 'workspace-1',
      recordKey: 'MEMBER#sato@example.com',
      entryType: 'workspace-member',
      id: 'sato@example.com',
      memberKey: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      status: 'active',
      version: 3,
      identityOwnership: 'workspace-created',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-16T01:02:03.000Z',
    }
    const event = mapWorkspaceAccess(item)
    const retry = mapWorkspaceAccess(item)

    expect(event).toMatchObject({
      eventType: 'member.backfilled',
      occurredAt: '2026-07-16T01:02:03.000Z',
      actor: { id: 'system:backfill', kind: 'system' },
      entity: {
        type: 'member',
        id: expect.stringMatching(
          /^workspace\/wsp_v2_[a-f0-9]{48}\/member\/mbr_v2_[a-f0-9]{48}$/,
        ),
      },
      target: {
        type: 'member',
        id: expect.stringMatching(
          /^workspace\/wsp_v2_[a-f0-9]{48}\/member\/mbr_v2_[a-f0-9]{48}$/,
        ),
      },
      action: 'backfilled',
      source: 'backfill',
      outboxStatus: 'suppressed',
      metadata: {
        backfilled: true,
        kind: 'workspace-member',
      },
    })
    expect(event?.changes).toEqual(expect.arrayContaining([
      { field: 'memberKey', after: '[REDACTED]', redacted: true },
      { field: 'email', after: '[REDACTED]', redacted: true },
      { field: 'name', after: '[REDACTED]', redacted: true },
      { field: 'role', after: 'member' },
      { field: 'status', after: 'active' },
      { field: 'version', after: 3 },
    ]))
    expect(retry?.eventId).toBe(event?.eventId)
    expect(event?.entityId).not.toContain('sato@example.com')
    expect(event?.entityId).not.toContain('workspace-1')
    expect(event?.targetId).toBe(event?.entityId)

    const otherWorkspaceEvent = mapWorkspaceAccess({ ...item, workspaceId: 'workspace-2' })
    expect(otherWorkspaceEvent?.eventId).not.toBe(event?.eventId)
    expect(otherWorkspaceEvent?.entityId).toMatch(
      /^workspace\/wsp_v2_[a-f0-9]{48}\/member\/mbr_v2_[a-f0-9]{48}$/,
    )
    expect(otherWorkspaceEvent?.entityId).not.toBe(event?.entityId)
  })

  test('maps a Workspace invitation snapshot without internal Cognito identity fields', () => {
    const event = mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'INVITATION#invitee@example.com',
      entryType: 'workspace-invitation',
      id: 'invitee@example.com',
      email: 'invitee@example.com',
      name: 'Invitee',
      role: 'guest',
      status: 'delivery-failed',
      deliveryStatus: 'failed',
      identityOwnership: 'ambiguous',
      identityLifecycleVersion: 2,
      identityMutationAttempted: true,
      version: 4,
      expiresAt: '2026-07-23T00:00:00.000Z',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T01:02:03.000Z',
      acceptedAt: '2026-07-16T01:00:00.000Z',
      cognitoIdentityId: 'secret-sub',
      cognitoUsername: 'CognitoInvitee',
      acceptanceLockExpiresAt: '2026-07-16T00:05:00.000Z',
      failureMessage: 'Internal failure detail',
    })

    expect(event).toMatchObject({
      eventType: 'invitation.backfilled',
      occurredAt: '2026-07-16T01:02:03.000Z',
      actorUserId: 'system:backfill',
      entity: {
        type: 'invitation',
        id: expect.stringMatching(
          /^workspace\/wsp_v2_[a-f0-9]{48}\/invitation\/inv_v2_[a-f0-9]{48}$/,
        ),
      },
      target: {
        type: 'invitation',
        id: expect.stringMatching(
          /^workspace\/wsp_v2_[a-f0-9]{48}\/invitation\/inv_v2_[a-f0-9]{48}$/,
        ),
      },
      source: 'backfill',
      outboxStatus: 'suppressed',
      metadata: {
        backfilled: true,
        kind: 'workspace-invitation',
      },
    })
    expect(event?.changes).toEqual(expect.arrayContaining([
      { field: 'email', after: '[REDACTED]', redacted: true },
      { field: 'name', after: '[REDACTED]', redacted: true },
      { field: 'role', after: 'guest' },
      { field: 'status', after: 'delivery-failed' },
      { field: 'deliveryStatus', after: 'failed' },
      { field: 'identityMutationAttempted', after: true },
      { field: 'acceptedAt', after: '2026-07-16T01:00:00.000Z' },
      { field: 'failureMessage', after: '[REDACTED]', redacted: true },
    ]))
    expect(event?.changes.map((change) => change.field)).not.toEqual(expect.arrayContaining([
      'cognitoIdentityId',
      'cognitoUsername',
    ]))
    expect(event?.entityId).not.toContain('invitee@example.com')
    expect(event?.entityId).not.toContain('workspace-1')
    expect(event?.targetId).toBe(event?.entityId)
  })

  test('ignores only Workspace metadata and fails closed for unrecognized rows', () => {
    expect(mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'WORKSPACE',
      entryType: 'workspace-meta',
      activeOwnerCount: 1,
      version: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toBeNull()
    expect(() => mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'EMAIL_ALIAS#member@example.com',
      entryType: 'email-alias',
      memberKey: 'member@example.com',
    })).toThrow('Unrecognized row discriminator.')
  })

  test('fails closed for malformed rows recognized as Workspace lifecycle state', () => {
    expect(() => mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'MEMBER#malformed@example.com',
      entryType: 'workspace-member',
      id: 'malformed@example.com',
      memberKey: 'malformed@example.com',
      email: 'malformed@example.com',
      role: 'unknown',
      status: 'active',
      version: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toThrow('Workspace member role is invalid.')
    expect(() => mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'INVITATION#other@example.com',
      entryType: 'workspace-invitation',
      id: 'invitee@example.com',
      email: 'invitee@example.com',
      role: 'member',
      status: 'pending',
      deliveryStatus: 'sent',
      identityOwnership: 'workspace-created',
      version: 1,
      expiresAt: '2026-07-23T00:00:00.000Z',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toThrow('Workspace invitation recordKey is invalid.')
    expect(() => mapWorkspaceAccess({
      workspaceId: 'workspace-1',
      recordKey: 'MEMBER#invalid-time@example.com',
      entryType: 'workspace-member',
      id: 'invalid-time@example.com',
      memberKey: 'invalid-time@example.com',
      email: 'invalid-time@example.com',
      role: 'member',
      status: 'active',
      version: 1,
      createdAt: '2026-02-31T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toThrow('Workspace member createdAt is invalid.')
  })
})
