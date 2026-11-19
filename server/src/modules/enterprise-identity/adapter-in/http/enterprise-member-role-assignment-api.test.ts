import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import type { EnterpriseRoleId } from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

const workspaceId = 'user#demo@example.com'

const enterpriseEnvironment = {
  COGNITO_CLIENT_ID: 'mukuroji-main-client',
}

afterEach(() => {
  resetTestApp()
})

/**
 * Builds the bearer header that the fake Cognito resolves to `demo@example.com`.
 *
 * @returns Authorization header value.
 */
function createAuthorization(): string {
  return `Bearer ${createAccessToken([], {
    client_id: 'mukuroji-main-client',
    token_use: 'access',
  })}`
}

/**
 * Sends one JSON request to the role assignment routes as the fixture member.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body.
 * @param idempotencyKey - Optional idempotency key.
 * @returns The HTTP response.
 */
function sendAssignmentRequest(
  path: string,
  method: string,
  body: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: createAuthorization(),
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  })
}

/**
 * Stores a direct assignment for the fixture member, as an owner would through the API.
 *
 * @param identity - Enterprise identity client used by the app.
 * @param roleId - Role to assign.
 */
async function assignToFixtureMember(
  identity: InMemoryEnterpriseIdentityClient,
  roleId: EnterpriseRoleId,
) {
  await identity.putMemberRoleAssignment({
    workspaceId,
    assignmentId: `assignment-${roleId}`,
    principalKind: 'member',
    principalId: 'demo@example.com',
    roleId,
    scope: { workspaceId, kind: 'workspace' },
    source: 'direct',
  })
}

test('lets an owner assign and remove a role on one member, and lists it with the members', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'owner' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })

    const created = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:portfolio-viewer', scopeType: 'workspace' },
      'assign-sato',
    )
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { assignment: { id: string } }
    expect(createdBody).toMatchObject({
      assignment: {
        memberKey: 'sato@example.com',
        roleId: 'workspace:portfolio-viewer',
        scopeType: 'workspace',
      },
    })

    const retried = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:portfolio-viewer', scopeType: 'workspace' },
      'assign-sato',
    )
    expect(retried.status).toBe(201)
    const duplicate = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:portfolio-viewer', scopeType: 'workspace' },
      'assign-sato-again',
    )
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentDuplicate' })

    const projectScoped = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'project:manager', scopeType: 'project', scopeId: 'refero' },
      'assign-sato-project',
    )
    expect(projectScoped.status).toBe(201)
    const stored = (await identity.getSnapshot(workspaceId)).roleAssignments
    expect(stored.find((assignment) => assignment.roleId === 'project:manager')?.scope)
      .toEqual({ workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' })

    const snapshot = await app.request('/api/enterprise/security', {
      headers: { Authorization: createAuthorization() },
    })
    expect(snapshot.status).toBe(200)
    const snapshotBody = await snapshot.json() as {
      memberRoleAssignments: unknown[]
      members: Array<{ memberKey: string }>
      roles: Array<{ id: string; guestAssignable: boolean }>
      assignableRoleIds: { members: { workspace: string[] } }
    }
    expect(snapshotBody.memberRoleAssignments).toHaveLength(2)
    expect(snapshotBody.members.map((member) => member.memberKey)).toContain('sato@example.com')
    expect(snapshotBody.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workspace:portfolio-viewer', guestAssignable: false }),
      expect.objectContaining({ id: 'workspace:auditor', guestAssignable: false }),
    ]))
    expect(snapshotBody.assignableRoleIds.members.workspace).toEqual(
      expect.arrayContaining(['workspace:portfolio-viewer', 'workspace:auditor']),
    )

    const removed = await sendAssignmentRequest(
      `/api/enterprise/security/role-assignments/${encodeURIComponent(createdBody.assignment.id)}`,
      'DELETE',
    )
    expect(removed.status).toBe(204)
    expect((await identity.getSnapshot(workspaceId)).roleAssignments.map((assignment) =>
      assignment.roleId
    )).toEqual(['project:manager'])
  })
})

test('rejects assignments to oneself, to a guest beyond guest roles, and from a plain member', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, {
      workspaceRole: 'owner',
      guestWorkspaceMemberKeys: ['guest@example.com'],
      inactiveWorkspaceMemberKeys: ['former@example.com'],
    })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })

    const self = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'demo@example.com', roleId: 'workspace:auditor' },
    )
    expect(self.status).toBe(409)
    expect(await self.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentSelfDenied' })

    const guest = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'guest@example.com', roleId: 'workspace:portfolio-viewer' },
    )
    expect(guest.status).toBe(409)
    expect(await guest.json()).toMatchObject({ code: 'EnterpriseRoleNotGuestAssignable' })

    const guestViewer = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'guest@example.com', roleId: 'project:viewer', scopeType: 'project', scopeId: 'refero' },
    )
    expect(guestViewer.status).toBe(201)

    const inactive = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'former@example.com', roleId: 'workspace:auditor' },
    )
    expect(inactive.status).toBe(404)

    const unknownScope = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'project:viewer', scopeType: 'project', scopeId: 'missing' },
    )
    expect(unknownScope.status).toBe(409)

    configureFakeProjectClients(true, { workspaceRole: 'member' })
    setTestAppDependencies({ enterpriseIdentity: identity })
    const denied = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:auditor' },
    )
    expect(denied.status).toBe(403)
    expect((await identity.getSnapshot(workspaceId)).roleAssignments).toHaveLength(1)
  })
})

test('lets only an owner grant administrative roles or promote a member who has assignments', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'admin' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })

    const administrative = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:admin' },
    )
    expect(administrative.status).toBe(403)
    expect(await administrative.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentAdminProtected' })
    const viewer = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:portfolio-viewer' },
    )
    expect(viewer.status).toBe(201)

    configureFakeProjectClients(true, { workspaceRole: 'owner' })
    setTestAppDependencies({ enterpriseIdentity: identity })
    const ownerGrant = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:admin' },
    )
    expect(ownerGrant.status).toBe(201)
    const promotion = await sendAssignmentRequest(
      '/api/workspace/members/sato@example.com',
      'PATCH',
      { role: 'admin', expectedVersion: 1 },
    )
    expect(promotion.status).toBe(409)
    expect(await promotion.json()).toMatchObject({ code: 'WorkspaceMemberRoleAssignmentsPresent' })
  })
})

test('lets an All Projects viewer read a Project it is not a member of, without editing', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(false, { workspaceRole: 'member' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })

    const beforeAssignment = await app.request('/api/projects/refero/issues', {
      headers: { Authorization: createAuthorization() },
    })
    expect(beforeAssignment.status).toBe(403)

    await assignToFixtureMember(identity, 'workspace:portfolio-viewer')

    const read = await app.request('/api/projects/refero/issues', {
      headers: { Authorization: createAuthorization() },
    })
    expect(read.status).toBe(200)
    const write = await sendAssignmentRequest('/api/teams/core-team/issues', 'POST', {
      title: 'PMO must not create this task',
      assignedProjectId: 'refero',
    })
    expect(write.status).toBe(403)
    const auditLog = await app.request('/api/audit/events', {
      headers: { Authorization: createAuthorization() },
    })
    expect(auditLog.status).toBe(403)
  })
})

test('ignores Workspace-wide read roles once the member is a guest', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(false, { workspaceRole: 'guest' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    await assignToFixtureMember(identity, 'workspace:portfolio-viewer')

    const read = await app.request('/api/projects/refero/issues', {
      headers: { Authorization: createAuthorization() },
    })
    expect(read.status).toBe(403)
  })
})

test('lets an auditor read the audit log but not export it or read Projects', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(false, { workspaceRole: 'member' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({
      enterpriseIdentity: identity,
      auditEvents: {
        async putEvent() {},
        async getEvent() {
          return undefined
        },
        async query() {
          return { events: [] }
        },
      },
    })
    await assignToFixtureMember(identity, 'workspace:auditor')

    const auditLog = await app.request('/api/audit/events', {
      headers: { Authorization: createAuthorization() },
    })
    expect(auditLog.status).toBe(200)
    const auditExport = await app.request('/api/audit/events/export', {
      headers: { Authorization: createAuthorization() },
    })
    expect(auditExport.status).toBe(403)
    const project = await app.request('/api/projects/refero/issues', {
      headers: { Authorization: createAuthorization() },
    })
    expect(project.status).toBe(403)
  })
})
