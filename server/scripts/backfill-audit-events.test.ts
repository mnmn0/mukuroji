import { describe, expect, test } from 'bun:test'
import { mapCurrentTeamIssue, mapWorkspaceAccessItem } from './backfill-audit-events'

function createCanonicalWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
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
    dueDate: '2026/07/31',
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
    expect(event?.changes).toEqual(expect.arrayContaining([{
      field: 'creatorMemberKey',
      after: '[REDACTED]',
      redacted: true,
    }]))
  })

  test('rejects non-canonical Work Item rows instead of backfilling them', () => {
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ creatorMemberKey: undefined })))
      .toBeUndefined()
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ relationIds: undefined })))
      .toBeUndefined()
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ status: 'review' })))
      .toBeUndefined()
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
    const event = mapWorkspaceAccessItem(item)
    const retry = mapWorkspaceAccessItem(item)

    expect(event).toMatchObject({
      eventType: 'member.backfilled',
      occurredAt: '2026-07-16T01:02:03.000Z',
      actor: { id: 'system:backfill', kind: 'system' },
      entity: {
        type: 'member',
        id: 'workspace/workspace-1/member/sato@example.com',
      },
      target: {
        type: 'member',
        id: 'workspace/workspace-1/member/sato@example.com',
      },
      action: 'backfilled',
      source: 'backfill',
      outboxStatus: 'suppressed',
      metadata: {
        backfilled: true,
        kind: 'workspace-member',
        legacyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        legacySource: 'workspace-access',
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

    const otherWorkspaceEvent = mapWorkspaceAccessItem({ ...item, workspaceId: 'workspace-2' })
    expect(otherWorkspaceEvent?.eventId).not.toBe(event?.eventId)
    expect(otherWorkspaceEvent?.entityId).toBe(
      'workspace/workspace-2/member/sato@example.com',
    )
  })

  test('maps a Workspace invitation snapshot without internal Cognito identity fields', () => {
    const event = mapWorkspaceAccessItem({
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
        id: 'workspace/workspace-1/invitation/invitee@example.com',
      },
      target: {
        type: 'invitation',
        id: 'workspace/workspace-1/invitation/invitee@example.com',
      },
      source: 'backfill',
      outboxStatus: 'suppressed',
      metadata: {
        kind: 'workspace-invitation',
        legacyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        legacySource: 'workspace-access',
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
  })

  test('ignores only Workspace metadata and fails closed for unrecognized rows', () => {
    expect(mapWorkspaceAccessItem({
      workspaceId: 'workspace-1',
      recordKey: 'WORKSPACE',
      entryType: 'workspace-meta',
      activeOwnerCount: 1,
      version: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toBeNull()
    expect(() => mapWorkspaceAccessItem({
      workspaceId: 'workspace-1',
      recordKey: 'EMAIL_ALIAS#member@example.com',
      entryType: 'email-alias',
      memberKey: 'member@example.com',
    })).toThrow('Unrecognized row discriminator.')
  })

  test('fails closed for malformed rows recognized as Workspace lifecycle state', () => {
    expect(() => mapWorkspaceAccessItem({
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
    expect(() => mapWorkspaceAccessItem({
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
    expect(() => mapWorkspaceAccessItem({
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
