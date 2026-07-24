import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  configureHeadlessDeveloperCredential,
  createHeadlessWorkItem,
  HEADLESS_DEVELOPER_WORKSPACE_ID,
  putAppliedHeadlessScimUser,
  putHeadlessEnterpriseIdentityProvider,
  requestHeadlessWorkItem,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  createCanonicalPublicWorkItemService,
} from '../../../../api/api-router'
import { CognitoServiceError } from '../../../authentication'
import { WorkspaceAccessError } from '../../../workspace-access/workspace-access'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type {
  ListExternalWorkItemLinksRequest,
  PrepareWorkItemDeletionFenceRequest,
} from '../../../developer-platform'
import type {
  DocumentClient,
  PrepareDocumentWorkItemDeletionFenceRequest,
} from '../../../documents/documents'
import {
  InMemoryPlanningClient,
} from '../../../planning/planning'
import type {
  WorkItemAuthorizationSnapshot,
} from '../../../work-items'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import type {
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('denies headless API credentials after an applied SCIM deprovision', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'owner' })
  const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
  const identity = new InMemoryEnterpriseIdentityClient()
  await putHeadlessEnterpriseIdentityProvider(identity, workspaceId)
  const user = await putAppliedHeadlessScimUser(identity, workspaceId)
  const deactivated = await identity.deactivateScimUser(
    workspaceId,
    'headless-idp',
    user.userId,
    'headless-user-deactivated',
  )
  if (!deactivated) throw new Error('Expected the headless SCIM user to be deactivated.')
  await identity.markScimUserApplied(
    workspaceId,
    deactivated.userId,
    deactivated.version,
  )
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:read'],
  )

  const response = await app.request(
    'http://localhost/api/v1/work-items?teamId=core-team',
    { headers: { Authorization: `Bearer ${secret}` } },
  )
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'forbidden' })
  expect(calls.publicIssuePageReads).toHaveLength(0)
})

test('applies compatible custom SCIM group roles to only their headless Project scope', async () => {
  const calls = configureFakeProjectClients(false, {
    workspaceRole: 'owner',
    projectAccesses: [],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
    detailAssignedProjectIds: {
      'refero-work-item': 'refero',
      'private-work-item': 'private-project',
    },
  })
  const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-07-20T00:00:00.000Z'
  await putHeadlessEnterpriseIdentityProvider(identity, workspaceId)
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:headless-project-writer',
    name: 'Headless Project writer',
    permissions: ['work-items.read', 'work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await putAppliedHeadlessScimUser(identity, workspaceId)
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: 'headless-idp',
    externalId: 'headless-project-writers',
    displayName: 'Headless Project writers',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'headless-project-writers-created',
  })
  await identity.markScimGroupApplied(
    workspaceId,
    group.groupId,
    group.version,
  )
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'headless-project-writer-mapping',
    identityProviderId: 'headless-idp',
    directoryGroupId: group.groupId,
    roleId: 'custom:headless-project-writer',
    scope: { workspaceId, kind: 'project', targetId: 'refero' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now,
  })
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:read', 'work-items:write'],
  )

  const allowedRead = await requestHeadlessWorkItem(
    secret,
    'refero-work-item',
  )
  const deniedRead = await requestHeadlessWorkItem(
    secret,
    'private-work-item',
  )
  const allowedWrite = await createHeadlessWorkItem(
    secret,
    'refero',
    'headless-project-write-allowed',
  )
  const deniedWrite = await createHeadlessWorkItem(
    secret,
    'private-project',
    'headless-project-write-denied',
  )

  expect(allowedRead.status).toBe(200)
  expect(deniedRead.status).toBe(403)
  expect(allowedWrite.status).toBe(201)
  expect(deniedWrite.status).toBe(403)
  expect(calls.issueCreates.map((call) => call.assignedProjectId)).toEqual(['refero'])
})

test('suppresses legacy headless Project ACLs for directory-managed members', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'owner' })
  const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
  const identity = new InMemoryEnterpriseIdentityClient()
  await putHeadlessEnterpriseIdentityProvider(identity, workspaceId)
  await putAppliedHeadlessScimUser(identity, workspaceId)
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:read'],
  )

  const response = await requestHeadlessWorkItem(
    secret,
    'onboarding-friction',
  )

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'forbidden' })
  expect(calls.issueDetails).toHaveLength(0)
})

test('applies the Enterprise external ceiling to headless read and write operations', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })
  const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-07-20T00:00:00.000Z'
  await identity.putVerifiedDomain({
    workspaceId,
    domainId: 'managed-company-domain',
    domain: 'company.example',
    status: 'verified',
    revision: 1,
    verificationRecordName: '_mukuroji-challenge.company.example',
    verifiedAt: now,
    enforceSso: false,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putSecurityPolicy({
    workspaceId,
    loginMode: 'password-or-sso',
    mfaRequirement: 'required',
    sessionLifetimeMinutes: 480,
    idleTimeoutMinutes: 60,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'all-users',
    ipAllowlist: ['203.0.113.0/24'],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: true,
      maximumSessionLifetimeMinutes: 120,
      allowedGuestDomains: [],
      permissionCeiling: ['workspace.read', 'projects.read', 'work-items.read'],
    },
    revision: 1,
    updatedAt: now,
    updatedBy: 'owner@example.com',
  })
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:read', 'work-items:write'],
  )

  const allowedRead = await requestHeadlessWorkItem(
    secret,
    'onboarding-friction',
  )
  const deniedWrite = await createHeadlessWorkItem(
    secret,
    'refero',
    'headless-external-write-denied',
  )

  expect(allowedRead.status).toBe(200)
  expect(deniedWrite.status).toBe(403)
  expect(await deniedWrite.json()).toMatchObject({ code: 'forbidden' })
  expect(calls.issueCreates).toHaveLength(0)
})

test('uses current Cognito groups for direct Enterprise group assignments', async () => {
  for (const [cognitoUserGroups, expectedStatus] of [
    [['cognito-project-writers'], 200],
    [[], 403],
  ] as const) {
    const calls = configureFakeProjectClients(false, {
      workspaceRole: 'member',
      projectAccesses: [],
      cognitoUserGroups: [...cognitoUserGroups],
    })
    const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = '2026-07-20T00:00:00.000Z'
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:cognito-project-reader',
      name: 'Cognito Project reader',
      permissions: ['work-items.read'],
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    const identityWithDirectGroupAssignment = new Proxy(identity, {
      get(target, property) {
        if (property === 'getSnapshot') {
          return async (requestedWorkspaceId: string) => ({
            ...await target.getSnapshot(requestedWorkspaceId),
            roleAssignments: [{
              workspaceId,
              assignmentId: 'cognito-project-reader-assignment',
              principalKind: 'directory-group' as const,
              principalId: 'cognito-project-writers',
              roleId: 'custom:cognito-project-reader' as const,
              scope: {
                workspaceId,
                kind: 'project' as const,
                targetId: 'refero',
              },
              source: 'direct' as const,
            }],
          })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const platform = createInMemoryDeveloperPlatformAdapters()
    const apiKey = await platform.apiKeys.createApiKey({
      workspaceId,
      createdByUserId: 'demo@example.com',
      input: {
        name: 'Direct Cognito group assignment key',
        scopes: ['work-items:read'],
        expiresAt: '2027-07-20T00:00:00.000Z',
      },
    })
    setTestAppDependencies({
      ...platform,
      enterpriseIdentity: identityWithDirectGroupAssignment,
    })

    const response = await requestHeadlessWorkItem(
      apiKey.secret,
      'onboarding-friction',
    )

    expect(response.status).toBe(expectedStatus)
    expect(calls.issueDetails).toHaveLength(expectedStatus === 200 ? 1 : 0)
  }
})

test('fails closed before Work Item reads when current Cognito groups are unavailable', async () => {
  const calls = configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    cognitoUserGroupsError: new CognitoServiceError(
      503,
      'CognitoGroupsUnavailable',
      'Current Cognito groups are unavailable.',
    ),
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:read'],
  )

  const response = await requestHeadlessWorkItem(
    secret,
    'onboarding-friction',
  )

  expect(response.status).toBe(503)
  expect(calls.issueDetails).toHaveLength(0)
})

test('replays a completed Work Item delete using current Team write access after the item is gone', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    workspaceRole: 'member',
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const secret = await configureHeadlessDeveloperCredential(
    identity,
    ['work-items:delete'],
  )
  setTestAppDependencies({
    documents: {
      async prepareWorkItemDeletionFenceTransactWrite() {
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DocumentsTable',
              Item: {
                entryType: 'work-item-document-backlink-fence',
                activeBacklinkCount: 0,
              },
            },
          },
        }
      },
    } as unknown as DocumentClient,
  })
  const request = () => app.request(
    'http://localhost/api/v1/work-items/onboarding-friction?teamId=core-team',
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'headless-delete-replay',
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  )

  const first = await request()
  const replay = await request()

  expect(first.status).toBe(204)
  expect(replay.status).toBe(204)
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
  expect(calls.issueDeletes).toHaveLength(1)
  expect(calls.issueDetails).toHaveLength(1)
})

test('wires external and Document deletion fences through the canonical Public Work Item service', async () => {
  const externalFence = {
    Put: {
      TableName: 'DeveloperPlatformTable',
      Item: { entryType: 'work-item-link-fence', activeLinkCount: 0 },
    },
  }
  const documentFence = {
    Put: {
      TableName: 'DocumentsTable',
      Item: {
        entryType: 'work-item-document-backlink-fence',
        activeBacklinkCount: 0,
      },
    },
  }
  const externalFenceRequests:
    PrepareWorkItemDeletionFenceRequest[] = []
  const documentFenceRequests:
    PrepareDocumentWorkItemDeletionFenceRequest[] =
      []
  const deleteTransactions: Array<{
    authorizationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>
    authorizationSnapshot?: WorkItemAuthorizationSnapshot
    deletionFences: ReadonlyArray<{
      kind: string
      transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
    }>
    issueId: string
  }> = []
  let hasExternalLinks = false
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    workspaceRole: 'member',
    issueDeleteHook(input) {
      deleteTransactions.push(input)
    },
  })
  setTestAppDependencies({
    externalLinks: {
      async listExternalWorkItemLinks(
        _input: ListExternalWorkItemLinksRequest,
      ) {
        return hasExternalLinks ? [{}] : []
      },
    } as never,
    transactions: {
      async prepareWorkItemDeletionFenceTransactWrite(
        input: PrepareWorkItemDeletionFenceRequest,
      ) {
        externalFenceRequests.push(input)
        return { transactWriteItem: externalFence }
      },
    },
    documents: {
      async prepareWorkItemDeletionFenceTransactWrite(
        input:
          PrepareDocumentWorkItemDeletionFenceRequest,
      ) {
        documentFenceRequests.push(input)
        return { transactWriteItem: documentFence }
      },
    } as unknown as DocumentClient,
    planning: new InMemoryPlanningClient(),
  })
  const service = createCanonicalPublicWorkItemService()
  const credential = {
    kind: 'api-key' as const,
    workspaceId: 'user#demo@example.com',
    credentialId: 'api-key-1',
    subjectUserId: 'demo@example.com',
    scopes: ['work-items:delete' as const],
  }
  const mutationContext = {
    requestId: 'delete-request-1',
    idempotencyKey: 'delete-idempotency-1',
  }

  const deletedWorkItem = await runWithTestAppDependencies(() =>
    service.delete(
      credential,
      'core-team',
      'wiring-delete',
      1,
      mutationContext,
    )
  )
  expect(deletedWorkItem).toMatchObject({ id: 'wiring-delete' })

  expect(externalFenceRequests).toEqual([{
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    workItemId: 'wiring-delete',
  }])
  expect(documentFenceRequests).toEqual([{
    workspaceId: 'user#demo@example.com',
    workItemId: 'team/core-team/issue/wiring-delete',
  }])
  expect(deleteTransactions).toHaveLength(1)
  expect(deleteTransactions[0]?.deletionFences).toEqual([
    { kind: 'external-links', transactWriteItem: externalFence },
    { kind: 'document-backlinks', transactWriteItem: documentFence },
  ])
  expect(deleteTransactions[0]?.authorizationConditionChecks).toEqual([])
  expect(deleteTransactions[0]?.authorizationSnapshot).toMatchObject({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    workspaceMemberVersion: 1,
    planningRevision: 0,
  })

  hasExternalLinks = true
  await expect(runWithTestAppDependencies(() =>
    service.delete(
      credential,
      'core-team',
      'precheck-conflict',
      1,
      {
        requestId: 'delete-request-2',
        idempotencyKey: 'delete-idempotency-2',
      },
    )
  )).rejects.toMatchObject({
    code: 'conflict',
    status: 409,
  })
  expect(calls.issueDeletes).toHaveLength(1)
  expect(deleteTransactions).toHaveLength(1)
  expect(externalFenceRequests).toHaveLength(1)
  expect(documentFenceRequests).toHaveLength(1)
})

test('binds public Work Item writes to Workspace, Planning, and Enterprise authorization snapshots', async () => {
  await withTestEnvironment({
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
    WORKSPACE_ACCESS_TABLE_NAME: 'WorkspaceAccessTable',
  }, async () => {
    let authorizationSnapshot: WorkItemAuthorizationSnapshot | undefined
    configureFakeProjectClients(true, {
      role: 'member',
      workspaceRole: 'member',
      issueCreateHook(input) {
        authorizationSnapshot = input.authorizationSnapshot
        throw new WorkspaceAccessError(
          409,
          'WorkItemAuthorizationChanged',
          'Authorization changed between validation and commit.',
        )
      },
    })
    const secret = await configureHeadlessDeveloperCredential(
      new InMemoryEnterpriseIdentityClient(),
      ['work-items:write'],
    )

    const response = await createHeadlessWorkItem(
      secret,
      'refero',
      'authorization-snapshot-race',
    )

    expect(response.status).toBe(409)
    expect(authorizationSnapshot).toEqual({
      workspaceId: HEADLESS_DEVELOPER_WORKSPACE_ID,
      memberKey: 'demo@example.com',
      workspaceMemberVersion: 1,
      planningRevision: 0,
      enterpriseControlRevision: 0,
    })
  })
})
