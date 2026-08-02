import {
  createApiTestHarness,
  type ObservedWorkspaceMutationAuditContext,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createCyclePlanningInput,
  createDocumentFake,
  createFakeCognitoProfile,
  createWorkspaceAccessFake,
  expectStableWorkspaceMutationAuditContexts,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type {
  WorkspaceAccessClient,
  WorkspaceRole,
} from '../../workspace-access'
import {
  createMutationAuditContext,
} from '../../../audit/audit'
import {
  InMemoryPlanningClient,
} from '../../../planning/planning'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import { createDefaultTenantAdministrationSnapshot } from '../../../tenant-administration/domain/tenant-administration'
import type { TenantAdministrationClient } from '../../../tenant-administration/application/ports/tenant-administration-port'

/** Creates a complete tenant administration fake with one configured invite default. */
function createTenantAdministrationFake(
  defaultMemberRole: 'member' | 'guest',
  ensureCalls: Array<{
    workspaceId: string
    ownerMemberKey: string
    activeSeats: number | undefined
  }>,
): TenantAdministrationClient {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'user#demo@example.com',
    'demo@example.com',
    '2026-08-02T00:00:00.000Z',
    undefined,
    4,
  )
  snapshot.profile.defaultPolicy.defaultMemberRole = defaultMemberRole
  /** Fails when a route unexpectedly reaches an unrelated tenant capability. */
  const unavailable = (): never => {
    throw new Error('Unexpected tenant administration test call.')
  }
  return {
    async assertActive() {},
    async ensureSnapshot(workspaceId, ownerMemberKey, activeSeats) {
      ensureCalls.push({ workspaceId, ownerMemberKey, activeSeats })
      return snapshot
    },
    async getSnapshot() { return unavailable() },
    async updateProfile() { return unavailable() },
    async updateEntitlement() { return unavailable() },
    async updateGovernance() { return unavailable() },
    async assertFeature() { return unavailable() },
    async reserveUsage() { return unavailable() },
    async requestExport() { return unavailable() },
    async requestClosure() { return unavailable() },
    async getOperation() { return unavailable() },
    async advanceOperation() { return unavailable() },
    async failOperation() { return unavailable() },
    async pauseOperation() { return unavailable() },
    async resumeOperation() { return unavailable() },
    async verifyClosure() { return unavailable() },
  }
}

afterEach(() => {
  resetTestApp()
})

test('returns owner and admin Workspace capabilities from the API source of truth', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/workspace/access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    currentMember: { role: 'admin', status: 'active' },
    capabilities: {
      canInvite: true,
      canManageMembers: true,
      canManageAdmins: false,
    },
  })
})

test('serializes Workspace role updates with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        return 5
      },
      async getManagerLifecycleSnapshot() {
        return {
          authorizationRevision: 5,
        }
      },
    },
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'guest', expectedVersion: 1 }),
  })

  expect(response.status).toBe(200)
  expect(calls.workspaceMemberUpdates).toEqual([{
    expectedDocumentAuthorizationRevision: 5,
    expectedPlanningRevision: 0,
    memberKey: 'sato@example.com',
    role: 'guest',
  }])
})

test('forwards stable Workspace mutation audit headers and actor context to the state client', async () => {
  configureFakeProjectClients(true)
  let capturedAuditContext: ReturnType<typeof createMutationAuditContext> | undefined
  const owner = {
    id: 'demo@example.com',
    memberKey: 'demo@example.com',
    email: 'demo@example.com',
    role: 'owner' as const,
    status: 'active' as const,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        return 8
      },
      async getManagerLifecycleSnapshot() {
        return {
          authorizationRevision: 8,
        }
      },
    },
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async listActiveMembers() {
        return [
          owner,
          {
            ...owner,
            id: 'sato@example.com',
            memberKey: 'sato@example.com',
            email: 'sato@example.com',
            role: 'member' as const,
          },
        ]
      },
      async getActiveMember() {
        return owner
      },
      async getMember(_workspaceId: string, memberKey: string) {
        return {
          ...owner,
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'member',
        }
      },
      async updateMember(
        _workspaceId: string,
        _actorMemberKey: string,
        memberKey: string,
        input: Parameters<WorkspaceAccessClient['updateMember']>[3],
        auditContext: Parameters<WorkspaceAccessClient['updateMember']>[4],
      ) {
        capturedAuditContext = auditContext
        return {
          ...owner,
          id: memberKey,
          memberKey,
          email: memberKey,
          role: input.role ?? owner.role,
          status: input.status ?? owner.status,
          version: input.expectedVersion + 1,
        }
      },
    },
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-member-role-change-1',
      'X-Correlation-Id': 'workspace-correlation-1',
    },
    body: JSON.stringify({ expectedVersion: 1, role: 'guest' }),
  })

  expect(response.status).toBe(200)
  if (!capturedAuditContext) {
    throw new Error('Workspace mutation audit context was not captured.')
  }
  const responseCorrelationId = response.headers.get('X-Correlation-Id')
  const responseRequestId = response.headers.get('X-Request-Id')
  if (!responseCorrelationId || !responseRequestId) {
    throw new Error('Workspace mutation response identifiers were not returned.')
  }
  expect(capturedAuditContext).toMatchObject({
    workspaceId: 'user#demo@example.com',
    actor: {
      id: 'demo@example.com',
      displayName: 'demo@example.com',
      kind: 'user',
    },
    source: {
      kind: 'api',
      method: 'PATCH',
      route: '/api/workspace/members/sato%40example.com',
    },
  })
  expect(capturedAuditContext.correlationId).toBe(
    responseCorrelationId,
  )
  expect(capturedAuditContext.correlationId).not.toBe(
    'workspace-correlation-1',
  )
  expect(capturedAuditContext.source.requestId).toBe(
    responseRequestId,
  )
  expect(capturedAuditContext.idempotencyKeyHash).not.toContain(
    'workspace-member-role-change-1',
  )
})

test('rejects deactivating a Workspace member who still manages an active project', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkspaceMemberManagesProjects',
    message: 'Transfer or remove all active project manager roles before deactivating this member.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
})

test('rejects deactivating a Workspace member who owns an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('cycle-owned-by-member', 0),
    ownerMemberKey: 'SATO@EXAMPLE.COM',
  }, { workItems: [] })
  configureFakeProjectClients(true, { role: 'member' })
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkspaceMemberOwnsPlanningEntities',
    message: 'Transfer or archive all owned Planning entities before deactivating this member.',
  })
})

test('rejects changing the only active non-guest manager of a private Document to guest', async () => {
  const calls = configureFakeProjectClients(true)
  let eligibleManagerMemberKeys:
    | readonly string[]
    | undefined
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        return 12
      },
      async getManagerLifecycleSnapshot(
        _workspaceId,
        _memberKey,
        eligibleManagers,
      ) {
        eligibleManagerMemberKeys =
          eligibleManagers
        return {
          authorizationRevision: 12,
          blockingDocumentId:
            'private-document-1',
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/members/sato%40example.com',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: 1,
        role: 'guest',
      }),
    },
  )

  const responseBody =
    await response.json()
  expect(responseBody).toEqual({
    code:
      'WorkspaceMemberManagesPrivateDocuments',
    message:
      'Transfer private Document manager access before deactivating this member or changing them to guest.',
  })
  expect(response.status).toBe(409)
  expect(eligibleManagerMemberKeys).toContain(
    'sato@example.com',
  )
  expect(calls.workspaceMemberUpdates).toEqual([])
})

test('binds member deactivation after private Document manager transfer to its ACL generation', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [],
  })
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        return 13
      },
      async getManagerLifecycleSnapshot() {
        return {
          authorizationRevision: 13,
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/members/sato%40example.com',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: 1,
        status: 'deactivated',
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(calls.workspaceMemberUpdates).toEqual([{
    expectedDocumentAuthorizationRevision: 13,
    expectedPlanningRevision: 0,
    memberKey: 'sato@example.com',
    status: 'deactivated',
  }])
})

test('retries private Document manager validation when eligibility changes before the ACL snapshot', async () => {
  configureFakeProjectClients(true)
  let authorizationRevisionReads = 0
  let lifecycleSnapshotReads = 0
  let memberUpdateCalls = 0
  const createActiveMember = (
    memberKey: string,
    role: WorkspaceRole,
  ) => ({
    id: memberKey,
    memberKey,
    email: memberKey,
    role,
    status: 'active' as const,
    version: 1,
    createdAt:
      '2026-07-11T00:00:00.000Z',
    updatedAt:
      '2026-07-11T00:00:00.000Z',
  })
  const owner = createActiveMember(
    'demo@example.com',
    'owner',
  )
  const target = createActiveMember(
    'sato@example.com',
    'member',
  )
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        authorizationRevisionReads += 1
        return authorizationRevisionReads === 1
          ? 20
          : 21
      },
      async getManagerLifecycleSnapshot() {
        lifecycleSnapshotReads += 1
        return {
          authorizationRevision: 21,
          ...(lifecycleSnapshotReads === 1
            ? {}
            : {
                blockingDocumentId:
                  'private-document-after-race',
              }),
        }
      },
    },
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getMember(
        _workspaceId,
        memberKey,
      ) {
        return memberKey ===
          owner.memberKey
          ? owner
          : memberKey ===
              target.memberKey
            ? target
            : undefined
      },
      async getActiveMember(
        _workspaceId,
        memberKey,
      ) {
        return memberKey ===
          owner.memberKey
          ? owner
          : memberKey ===
              target.memberKey
            ? target
            : undefined
      },
      async listActiveMembers() {
        return [owner, target]
      },
      async updateMember() {
        memberUpdateCalls += 1
        return target
      },
    },
  })

  const response = await app.request(
    '/api/workspace/members/sato%40example.com',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: 1,
        role: 'guest',
      }),
    },
  )

  const responseBody =
    await response.json()
  expect(responseBody).toEqual({
    code:
      'WorkspaceMemberManagesPrivateDocuments',
    message:
      'Transfer private Document manager access before deactivating this member or changing them to guest.',
  })
  expect(response.status).toBe(409)
  expect(authorizationRevisionReads).toBe(2)
  expect(lifecycleSnapshotReads).toBe(2)
  expect(memberUpdateCalls).toBe(0)
})

test('resends credentials when inviting an existing unconfirmed Workspace identity', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-invitation-create-1',
      'X-Correlation-Id': 'workspace-invitation-create-correlation',
    },
    body: JSON.stringify({
      email: 'invitee@example.com',
      name: 'Invitee',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['invitee@example.com'])
  expectStableWorkspaceMutationAuditContexts(calls.workspaceMutationAuditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-invitation-create-correlation',
    idempotencyKey: 'workspace-invitation-create-1',
    method: 'POST',
    requestBody: { email: 'invitee@example.com', name: 'Invitee', role: 'member' },
    route: '/api/workspace/invitations',
    stages: [
      'createInvitation',
      'markInvitationIdentityMutationStarted',
      'markInvitationDelivery',
    ],
    workspaceId: 'user#demo@example.com',
  })
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invitee@example.com',
      identityOwnership: 'pre-existing',
      status: 'pending',
    },
  })
})

test('uses the tenant default role when an invitation omits its role', async () => {
  const calls = configureFakeProjectClients(true)
  const ensureCalls: Array<{
    workspaceId: string
    ownerMemberKey: string
    activeSeats: number | undefined
  }> = []
  setTestAppDependencies({
    tenantAdministration: createTenantAdministrationFake('guest', ensureCalls),
  })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-default-role-invitation-1',
      'X-Correlation-Id': 'workspace-default-role-correlation',
    },
    body: JSON.stringify({
      email: 'guest@example.com',
      name: 'Guest',
    }),
  })

  expect(response.status).toBe(201)
  expect(ensureCalls).toEqual([{
    workspaceId: 'user#demo@example.com',
    ownerMemberKey: 'demo@example.com',
    activeSeats: 4,
  }])
  expectStableWorkspaceMutationAuditContexts(calls.workspaceMutationAuditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-default-role-correlation',
    idempotencyKey: 'workspace-default-role-invitation-1',
    method: 'POST',
    requestBody: { email: 'guest@example.com', name: 'Guest', role: 'guest' },
    route: '/api/workspace/invitations',
    stages: [
      'createInvitation',
      'markInvitationIdentityMutationStarted',
      'markInvitationDelivery',
    ],
    workspaceId: 'user#demo@example.com',
  })
})

test('records ownership when invitation provisioning creates a new Cognito identity', async () => {
  const calls = configureFakeProjectClients(true, { workspaceUserMissing: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'new-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual([])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'new-user@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    },
  })
})

test('persists created identity provenance when the successful delivery write fails', async () => {
  configureFakeProjectClients(true, { workspaceUserMissing: true })
  const deliveryInputs: Array<Parameters<WorkspaceAccessClient['markInvitationDelivery']>[2]> = []

  setTestAppDependencies({
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async createInvitation(
        _workspaceId,
        _actorMemberKey,
        input,
      ) {
        return {
          id: input.email,
          email: input.email,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        invitationId,
        expectedVersion,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          identityLifecycleVersion: 2,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(
        _workspaceId,
        invitationId,
        input,
      ) {
        deliveryInputs.push(input)

        if (input.deliveryStatus !== 'failed') {
          throw new Error('Delivery state write failed after Cognito provisioning.')
        }

        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'delivery-failed',
          deliveryStatus: 'failed',
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
    },
  })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'new-user@example.com', role: 'member' }),
  })

  expect(response.status).toBe(502)
  expect(deliveryInputs).toEqual([
    {
      expectedVersion: 2,
      identityOwnership: 'workspace-created',
      cognitoIdentityId: 'sub-new-user@example.com',
      cognitoUsername: 'new-user@example.com',
      directoryClaimCleanupRequired: false,
      deliveryStatus: 'sent',
    },
    {
      expectedVersion: 2,
      identityOwnership: 'workspace-created',
      cognitoIdentityId: 'sub-new-user@example.com',
      cognitoUsername: 'new-user@example.com',
      directoryClaimCleanupRequired: undefined,
      deliveryStatus: 'failed',
      failureMessage: 'Invitation delivery failed.',
    },
  ])
})

test('keeps raced Cognito ownership ambiguous while resending temporary credentials', async () => {
  const calls = configureFakeProjectClients(true, { workspaceProvisionRace: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-invitation-race-1',
      'X-Correlation-Id': 'workspace-invitation-race-correlation',
    },
    body: JSON.stringify({
      email: 'raced-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['raced-user@example.com'])
  expectStableWorkspaceMutationAuditContexts(calls.workspaceMutationAuditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-invitation-race-correlation',
    idempotencyKey: 'workspace-invitation-race-1',
    method: 'POST',
    requestBody: { email: 'raced-user@example.com', role: 'member' },
    route: '/api/workspace/invitations',
    stages: [
      'createInvitation',
      'markInvitationIdentityMutationStarted',
      'markInvitationDirectoryClaimCleanupRequired',
      'markInvitationDelivery',
    ],
    workspaceId: 'user#demo@example.com',
  })
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'raced-user@example.com',
      identityOwnership: 'ambiguous',
      status: 'pending',
    },
  })
})

test('drops ownership and cleanup provenance when reinvite finds a replacement Cognito identity', async () => {
  const deliveryInputs: Array<Parameters<WorkspaceAccessClient['markInvitationDelivery']>[2]> = []
  const auditContexts: ObservedWorkspaceMutationAuditContext[] = []
  const resends: string[] = []
  const preparedInvitation = {
    id: 'replacement@example.com',
    email: 'replacement@example.com',
    role: 'member' as const,
    status: 'provisioning' as const,
    deliveryStatus: 'pending' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-original',
    directoryClaimCleanupRequired: true,
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }

  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'demo@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
            { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
          ],
        }
      },
      async isSystemAdmin() {
        return false
      },
      async getUserGroups() {
        return []
      },
      async findWorkspaceUser() {
        return {
          profile: {
            id: 'replacement@example.com',
            username: 'CaseSensitiveReplacement',
            email: 'replacement@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-replacement',
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser() {
        return {
          profile: {
            id: 'replacement@example.com',
            username: 'CaseSensitiveReplacement',
            email: 'replacement@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          cognitoIdentityId: 'sub-replacement',
          cognitoUsername: 'CaseSensitiveReplacement',
          identityOwnership: 'pre-existing',
          directoryClaimCleanupRequired: false,
          deliveryStatus: 'not-required',
        }
      },
      async resendWorkspaceUserInvitation(username: string) {
        resends.push(username)
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async prepareReinvite(
        _workspaceId,
        _actorMemberKey,
        _invitationId,
        _expiresInDays,
        auditContext,
      ) {
        auditContexts.push({ stage: 'prepareReinvite', context: auditContext })
        return preparedInvitation
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        _invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
        auditContext,
      ) {
        auditContexts.push({ stage: 'markInvitationIdentityMutationStarted', context: auditContext })
        return {
          ...preparedInvitation,
          identityOwnership: 'ambiguous',
          cognitoIdentityId,
          cognitoUsername,
          directoryClaimCleanupRequired: undefined,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
        }
      },
      async markInvitationDelivery(
        _workspaceId,
        _invitationId,
        input,
        auditContext,
      ) {
        auditContexts.push({ stage: 'markInvitationDelivery', context: auditContext })
        deliveryInputs.push(input)
        return {
          ...preparedInvitation,
          status: 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/invitations/replacement%40example.com/reinvite',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Idempotency-Key': 'workspace-reinvite-1',
        'X-Correlation-Id': 'workspace-reinvite-correlation',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(resends).toEqual(['CaseSensitiveReplacement'])
  expectStableWorkspaceMutationAuditContexts(auditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-reinvite-correlation',
    idempotencyKey: 'workspace-reinvite-1',
    method: 'POST',
    requestBody: { action: 'reinvite', invitationId: 'replacement@example.com' },
    route: '/api/workspace/invitations/replacement%40example.com/reinvite',
    stages: [
      'prepareReinvite',
      'markInvitationIdentityMutationStarted',
      'markInvitationDelivery',
    ],
    workspaceId: 'user#demo@example.com',
  })
  expect(deliveryInputs).toEqual([{
    expectedVersion: 3,
    identityOwnership: 'pre-existing',
    cognitoIdentityId: 'sub-replacement',
    cognitoUsername: 'CaseSensitiveReplacement',
    directoryClaimCleanupRequired: false,
    deliveryStatus: 'sent',
  }])
  expect(await response.json()).toMatchObject({
    invitation: {
      identityOwnership: 'pre-existing',
      cognitoIdentityId: 'sub-replacement',
      cognitoUsername: 'CaseSensitiveReplacement',
      directoryClaimCleanupRequired: false,
    },
  })
})

test('forwards one mutation audit context through every invitation resend stage', async () => {
  const auditContexts: ObservedWorkspaceMutationAuditContext[] = []
  const preparedInvitation = {
    id: 'resend@example.com',
    email: 'resend@example.com',
    role: 'member' as const,
    status: 'provisioning' as const,
    deliveryStatus: 'pending' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-resend',
    cognitoUsername: 'ResendIdentity',
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }

  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'demo@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
            { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
          ],
        }
      },
      async isSystemAdmin() {
        return false
      },
      async getUserGroups() {
        return []
      },
      async findWorkspaceUser() {
        return undefined
      },
      async provisionWorkspaceUser() {
        return {
          profile: createFakeCognitoProfile('resend@example.com'),
          cognitoIdentityId: 'sub-resend',
          cognitoUsername: 'ResendIdentity',
          identityOwnership: 'workspace-created' as const,
          directoryClaimCleanupRequired: false,
          deliveryStatus: 'sent' as const,
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId, memberKey) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async prepareResend(
        _workspaceId,
        _actorMemberKey,
        _invitationId,
        _expiresInDays,
        auditContext,
      ) {
        auditContexts.push({ stage: 'prepareResend', context: auditContext })
        return preparedInvitation
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        _invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
        auditContext,
      ) {
        auditContexts.push({ stage: 'markInvitationIdentityMutationStarted', context: auditContext })
        return {
          ...preparedInvitation,
          cognitoIdentityId,
          cognitoUsername,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
        }
      },
      async markInvitationDelivery(
        _workspaceId,
        _invitationId,
        input,
        auditContext,
      ) {
        auditContexts.push({ stage: 'markInvitationDelivery', context: auditContext })
        return {
          ...preparedInvitation,
          status: 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          version: input.expectedVersion + 1,
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/invitations/resend%40example.com/resend',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Idempotency-Key': 'workspace-resend-1',
        'X-Correlation-Id': 'workspace-resend-correlation',
      },
    },
  )

  expect(response.status).toBe(200)
  expectStableWorkspaceMutationAuditContexts(auditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-resend-correlation',
    idempotencyKey: 'workspace-resend-1',
    method: 'POST',
    requestBody: { action: 'resend', invitationId: 'resend@example.com' },
    route: '/api/workspace/invitations/resend%40example.com/resend',
    stages: [
      'prepareResend',
      'markInvitationIdentityMutationStarted',
      'markInvitationDelivery',
    ],
    workspaceId: 'user#demo@example.com',
  })
})
