import { expect, test } from 'bun:test'
import type {
  EnterpriseIdentitySnapshot,
  EnterpriseScimGroup,
  EnterpriseScimUser,
} from '@mukuroji/contracts'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { EnterpriseScimGroupJobApplyInput } from '../../enterprise-identity'
import {
  createEnterpriseScimGroupJobWorkerHandler,
} from './scim-group-job-worker'
import {
  DynamoDbEnterpriseScimProjectManagerGuard,
} from '../../adapter-out/dynamodb/enterprise-scim-project-manager-guard'
import {
  applyEnterpriseScimGroupJobUser,
  createEnterpriseScimGroupJobProcessor,
  type EnterpriseScimGroupJobWorkerDependencies,
} from '../../enterprise-scim-group-job-worker'

const now = '2026-07-19T00:00:00.000Z'

function createApplyInput(active = true): EnterpriseScimGroupJobApplyInput {
  const user = {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    identityProviderId: 'idp-1',
    externalId: 'external-user-1',
    userName: 'Managed@Example.com',
    displayName: 'Managed User',
    emails: ['managed@example.com'],
    active,
    groupIds: ['group-1'],
    version: 2,
    appliedVersion: 1,
    createdAt: now,
    updatedAt: now,
  } as EnterpriseScimUser
  const group = {
    workspaceId: 'workspace-1',
    groupId: 'group-1',
    identityProviderId: 'idp-1',
    externalId: 'directory-group-1',
    displayName: 'Workspace guests',
    active: true,
    memberUserIds: ['user-1'],
    version: 3,
    appliedVersion: 2,
    createdAt: now,
    updatedAt: now,
  } as EnterpriseScimGroup
  const snapshot = {
    scimUsers: [user],
    scimGroups: [group],
    groupMappings: [{
      workspaceId: 'workspace-1',
      mappingId: 'mapping-1',
      identityProviderId: 'idp-1',
      directoryGroupId: 'directory-group-1',
      scope: { kind: 'workspace' },
      roleId: 'workspace:guest',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }],
    domains: [],
  } as unknown as EnterpriseIdentitySnapshot
  return {
    snapshot,
    snapshotRevision: 7,
    group,
    user,
    phase: 'apply',
    reference: {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      revision: 4,
    },
    jobUpdatedAt: now,
  }
}

function createDependencies(
  overrides: Partial<EnterpriseScimGroupJobWorkerDependencies> = {},
) {
  const calls = {
    enabled: [] as string[],
    disabled: [] as string[],
    signedOut: [] as string[],
    reconciled: [] as unknown[],
    deprovisioned: [] as unknown[],
  }
  const dependencies = {
    enterpriseIdentity: {
      async processScimGroupJob() {
        return { status: 'stale' as const }
      },
    },
    workspaceAccess: {
      async getMember() {
        return {
          id: 'managed@example.com',
          memberKey: 'managed@example.com',
          email: 'managed@example.com',
          name: 'Managed User',
          role: 'member' as const,
          status: 'active' as const,
          provisioningSource: 'directory' as const,
          externalIdentityId: 'user-1',
          version: 5,
          createdAt: now,
          updatedAt: now,
        }
      },
      async listActiveMembers() {
        return [{
          id: 'managed@example.com',
          memberKey: 'managed@example.com',
          email: 'managed@example.com',
          name: 'Managed User',
          role: 'member' as const,
          status: 'active' as const,
          provisioningSource: 'directory' as const,
          externalIdentityId: 'user-1',
          version: 5,
          createdAt: now,
          updatedAt: now,
        }]
      },
      async reconcileDirectoryMember(
        _workspaceId: string,
        input: unknown,
        auditContext: unknown,
      ) {
        calls.reconciled.push({ input, auditContext })
        return {} as never
      },
      async deprovisionDirectoryMember(
        _workspaceId: string,
        _memberKey: string,
        input: unknown,
        auditContext: unknown,
      ) {
        calls.deprovisioned.push({ input, auditContext })
        return undefined
      },
    },
    documents: {
      async getAuthorizationRevision() {
        return 13
      },
      async getManagerLifecycleSnapshot() {
        return {
          authorizationRevision: 13,
        }
      },
    },
    planning: {
      async getAuthorizationState() {
        return { revision: 11, entities: [], workItemLinks: [] }
      },
    },
    projectManagerGuard: {
      async hasManagedProject() {
        return false
      },
    },
    cognito: {
      async enableWorkspaceUser(userId: string) {
        calls.enabled.push(userId)
      },
      async disableWorkspaceUser(userId: string) {
        calls.disabled.push(userId)
      },
      async globallySignOutWorkspaceUser(userId: string) {
        calls.signedOut.push(userId)
      },
    },
    ...overrides,
  } as unknown as EnterpriseScimGroupJobWorkerDependencies
  return { calls, dependencies }
}

test('applies an active group member with guest role, revision fence, audit, and Cognito enable', async () => {
  const { calls, dependencies } = createDependencies()

  await applyEnterpriseScimGroupJobUser(createApplyInput(), dependencies)

  expect(calls.enabled).toEqual(['managed@example.com'])
  expect(calls.disabled).toEqual([])
  expect(calls.reconciled).toHaveLength(1)
  expect(calls.reconciled[0]).toMatchObject({
    input: {
      memberKey: 'managed@example.com',
      role: 'guest',
      externalIdentityId: 'user-1',
      expectedVersion: 5,
      expectedPlanningRevision: 11,
      expectedDocumentAuthorizationRevision: 13,
    },
    auditContext: {
      workspaceId: 'workspace-1',
      actor: {
        id: 'scim-directory:idp-1',
        kind: 'service',
      },
      occurredAt: now,
    },
  })
})

test('guards inactive users before deprovisioning and signs out only after success', async () => {
  const managed = createDependencies({
    projectManagerGuard: {
      async hasManagedProject() {
        return true
      },
    },
  })
  await expect(
    applyEnterpriseScimGroupJobUser(createApplyInput(false), managed.dependencies),
  ).rejects.toMatchObject({ code: 'WorkspaceMemberManagesProjects' })
  expect(managed.calls.deprovisioned).toEqual([])
  expect(managed.calls.disabled).toEqual([])

  const owned = createDependencies({
    planning: {
      async getAuthorizationState() {
        return {
          revision: 12,
          entities: [{
            id: 'roadmap-1',
            ownerMemberKey: 'managed@example.com',
          }],
          workItemLinks: [],
        }
      },
    },
  })
  await expect(
    applyEnterpriseScimGroupJobUser(createApplyInput(false), owned.dependencies),
  ).rejects.toMatchObject({ code: 'WorkspaceMemberOwnsPlanningEntities' })
  expect(owned.calls.deprovisioned).toEqual([])

  const allowed = createDependencies()
  await applyEnterpriseScimGroupJobUser(
    createApplyInput(false),
    allowed.dependencies,
  )
  expect(allowed.calls.deprovisioned).toHaveLength(1)
  expect(allowed.calls.deprovisioned[0]).toMatchObject({
    input: {
      expectedDocumentAuthorizationRevision: 13,
    },
  })
  expect(allowed.calls.disabled).toEqual(['managed@example.com'])
  expect(allowed.calls.signedOut).toEqual(['managed@example.com'])
})

for (
  const lifecycleCase of [
    { name: 'active member guest downgrade', active: true },
    { name: 'inactive member deprovision', active: false },
  ] as const
) {
  test(`blocks ${lifecycleCase.name} before Workspace and Cognito mutations when a private Document would lose its manager`, async () => {
    const blocked = createDependencies({
      documents: {
        async getAuthorizationRevision() {
          return 13
        },
        async getManagerLifecycleSnapshot() {
          return {
            authorizationRevision: 13,
            blockingDocumentId: 'private-document-1',
          }
        },
      },
    })

    await expect(
      applyEnterpriseScimGroupJobUser(
        createApplyInput(lifecycleCase.active),
        blocked.dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'WorkspaceMemberManagesPrivateDocuments',
      status: 409,
    })
    expect(blocked.calls.reconciled).toEqual([])
    expect(blocked.calls.deprovisioned).toEqual([])
    expect(blocked.calls.enabled).toEqual([])
    expect(blocked.calls.disabled).toEqual([])
    expect(blocked.calls.signedOut).toEqual([])
  })
}

test('dedicated stream handler invokes the injected bounded processor', async () => {
  const references: unknown[] = []
  const workerHandler = createEnterpriseScimGroupJobWorkerHandler({
    async processJob(reference) {
      references.push(reference)
    },
  })

  await expect(workerHandler({
    Records: [{
      eventSource: 'aws:dynamodb',
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'sequence-1',
        NewImage: {
          scopeKey: { S: 'WORKSPACE#workspace-1' },
          recordKey: { S: 'SCIM_GROUP_JOB#job-1' },
          entryType: { S: 'enterprise-scim-group-job' },
          workspaceId: { S: 'workspace-1' },
          jobId: { S: 'job-1' },
          revision: { N: '4' },
        },
      },
    }],
  })).resolves.toEqual({ batchItemFailures: [] })
  expect(references).toEqual([{
    workspaceId: 'workspace-1',
    jobId: 'job-1',
    revision: 4,
  }])
})

test('processor keeps checkpoint and user audit identities separate', async () => {
  const input = createApplyInput()
  const auditContexts: unknown[] = []
  const userAuditContexts: unknown[] = []
  const base = createDependencies()
  const processor = createEnterpriseScimGroupJobProcessor({
    ...base.dependencies,
    enterpriseIdentity: {
      async processScimGroupJob(reference, applyUser, auditContext) {
        auditContexts.push(auditContext)
        await applyUser(input)
        return {
          status: 'continued',
          nextReference: {
            ...reference,
            revision: reference.revision + 1,
          },
          processedUserIds: ['user-1'],
        }
      },
    },
    workspaceAccess: {
      ...base.dependencies.workspaceAccess,
      async reconcileDirectoryMember(
        _workspaceId,
        _input,
        auditContext,
      ) {
        userAuditContexts.push(auditContext)
        return {} as never
      },
    },
  })

  await processor.processJob(input.reference)

  expect(auditContexts).toHaveLength(1)
  expect(userAuditContexts).toHaveLength(1)
  expect(auditContexts[0]).toMatchObject({
    actor: { id: 'scim-group-job:job-1' },
  })
  expect(userAuditContexts[0]).toMatchObject({
    actor: { id: 'scim-directory:idp-1' },
  })
})

test('project manager guard follows paginated active team and project relationships', async () => {
  const requests: unknown[] = []
  const responses = [{
    Items: [
      {
        directoryId: 'workspace-1',
        entryKey: 'TEAM#team-1',
        entryType: 'team',
        teamId: 'team-1',
        teamSortOrder: 10,
        nameJa: 'Team 1',
        nameEn: 'Team 1',
      },
      {
        directoryId: 'workspace-1',
        entryKey: 'PROJECT#project-1',
        entryType: 'project',
        teamId: 'team-1',
        projectId: 'project-1',
        teamSortOrder: 10,
        projectSortOrder: 10,
        nameJa: 'Project 1',
        nameEn: 'Project 1',
        tone: 'blue',
      },
      {
        directoryId: 'workspace-1',
        entryKey: 'PROJECT#archived-project',
        entryType: 'project',
        teamId: 'team-1',
        projectId: 'archived-project',
        teamSortOrder: 10,
        projectSortOrder: 20,
        nameJa: 'Archived project',
        nameEn: 'Archived project',
        tone: 'purple',
        archivedAt: now,
      },
    ],
    LastEvaluatedKey: { directoryId: 'workspace-1', entryKey: 'cursor' },
  }, {
    Items: [
      {
        directoryId: 'workspace-1',
        entryKey: 'PROJECT#project-1#MEMBER#managed@example.com',
        entryType: 'project-member',
        projectId: 'project-1',
        memberKey: ' Managed@Example.COM ',
        role: 'manager',
        createdAt: now,
        updatedAt: now,
      },
      {
        directoryId: 'workspace-1',
        entryKey: 'PROJECT#archived-project#MEMBER#archived-manager@example.com',
        entryType: 'project-member',
        projectId: 'archived-project',
        memberKey: 'archived-manager@example.com',
        role: 'manager',
        createdAt: now,
        updatedAt: now,
      },
    ],
  }]
  const documentClient = {
    async send(request: unknown) {
      requests.push(request)
      return responses.shift() ?? {}
    },
  } as unknown as DynamoDBDocumentClient
  const guard = new DynamoDbEnterpriseScimProjectManagerGuard(
    'project-directory',
    documentClient,
  )

  await expect(
    guard.hasManagedProject('workspace-1', ' MANAGED@example.com '),
  ).resolves.toBe(true)
  expect(requests).toHaveLength(2)
})

test('project manager guard fails closed for unrecognized directory rows', async () => {
  const documentClient = {
    async send() {
      return {
        Items: [{
          directoryId: 'workspace-1',
          entryKey: 'UNKNOWN#1',
          entryType: 'unexpected-directory-row',
        }],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const guard = new DynamoDbEnterpriseScimProjectManagerGuard(
    'project-directory',
    documentClient,
  )

  await expect(
    guard.hasManagedProject('workspace-1', 'managed@example.com'),
  ).rejects.toMatchObject({
    code: 'InvalidProjectDirectory',
    status: 503,
  })
})
