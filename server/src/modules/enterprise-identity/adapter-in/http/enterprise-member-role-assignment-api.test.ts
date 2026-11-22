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
    expect(await projectScoped.json()).toMatchObject({
      assignment: { scopeType: 'project', scopeId: 'refero', scopeParentId: 'core-team' },
    })
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

    // A misspelled scope type must not widen a Project request to the whole Workspace.
    const misspelledScope = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'workspace:auditor', scopeType: 'projectt', scopeId: 'refero' },
    )
    expect(misspelledScope.status).toBe(400)
    expect(await misspelledScope.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentScopeInvalid' })

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
    const adminSnapshot = await app.request('/api/enterprise/security', {
      headers: { Authorization: createAuthorization() },
    })
    const adminAssignable = (await adminSnapshot.json() as {
      assignableRoleIds: { members: { workspace: string[] } }
    }).assignableRoleIds.members.workspace
    expect(adminAssignable).toContain('workspace:portfolio-viewer')
    expect(adminAssignable).not.toContain('workspace:admin')

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
        /** Accepts an audit event without storing it. */
        async putEvent() {},
        /**
         * Finds no stored audit event.
         *
         * @returns Always undefined.
         */
        async getEvent() {
          return undefined
        },
        /**
         * Lists no audit events.
         *
         * @returns An empty page.
         */
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

test('refuses to remove a member\'s last assignment for a caller below their Workspace role', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    // A deactivated member gets their Workspace role back when reactivated, so the rule holds too.
    configureFakeProjectClients(true, {
      workspaceRole: 'member',
      inactiveWorkspaceMemberKeys: ['former@example.com'],
    })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:member-desk',
      name: 'Member desk',
      permissions: ['workspace.read', 'members.read', 'members.manage'],
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    })
    await assignToFixtureMember(identity, 'custom:member-desk')
    const satoAssignment = {
      workspaceId,
      assignmentId: 'assignment-sato-viewer',
      principalKind: 'member' as const,
      principalId: 'sato@example.com',
      roleId: 'workspace:portfolio-viewer' as const,
      scope: { workspaceId, kind: 'workspace' as const },
      source: 'direct' as const,
    }
    await identity.putMemberRoleAssignment(satoAssignment)
    await identity.putMemberRoleAssignment({
      ...satoAssignment,
      assignmentId: 'assignment-former-viewer',
      principalId: 'former@example.com',
    })

    const formerRemoval = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments/assignment-former-viewer',
      'DELETE',
    )
    expect(formerRemoval.status).toBe(403)
    expect(await formerRemoval.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentRestoreDenied' })

    const lastRemoval = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments/assignment-sato-viewer',
      'DELETE',
    )
    expect(lastRemoval.status).toBe(403)
    expect(await lastRemoval.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentRestoreDenied' })

    await identity.putMemberRoleAssignment({
      ...satoAssignment,
      assignmentId: 'assignment-sato-auditor',
      roleId: 'workspace:auditor',
    })
    const keptOne = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments/assignment-sato-viewer',
      'DELETE',
    )
    expect(keptOne.status).toBe(204)
    expect((await identity.getSnapshot(workspaceId)).roleAssignments
      .filter((assignment) => assignment.principalId === 'sato@example.com')
      .map((assignment) => assignment.roleId)).toEqual(['workspace:auditor'])
  })
})

test('hides member assignments from a caller who may read security settings but not members', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'member' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:security-reader',
      name: 'Security reader',
      permissions: ['workspace.read', 'security.read'],
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    })
    await assignToFixtureMember(identity, 'custom:security-reader')

    const snapshot = await app.request('/api/enterprise/security', {
      headers: { Authorization: createAuthorization() },
    })
    expect(snapshot.status).toBe(200)
    const body = await snapshot.json() as { memberRoleAssignments: unknown[]; members: unknown[] }
    expect(body.memberRoleAssignments).toEqual([])
    expect(body.members).toEqual([])
  })
})

test('stops an admin from adding administrative permissions to a role assigned to a member', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'admin' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    const deskRole = {
      workspaceId,
      roleId: 'custom:desk' as const,
      name: 'Desk',
      permissions: ['workspace.read' as const, 'members.read' as const],
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    }
    await identity.putCustomRole(deskRole)
    const assigned = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      { memberKey: 'sato@example.com', roleId: 'custom:desk' },
    )
    expect(assigned.status).toBe(201)

    const permissionIds = ['workspace.read', 'members.read', 'members.manage']
    const impact = await sendAssignmentRequest(
      '/api/enterprise/security/roles/custom%3Adesk/impact',
      'POST',
      { expectedVersion: 1, permissionIds },
    )
    const { impact: { confirmationToken } } = await impact.json() as {
      impact: { confirmationToken: string }
    }
    const escalated = await sendAssignmentRequest(
      '/api/enterprise/security/roles/custom%3Adesk',
      'PUT',
      { expectedVersion: 1, name: 'Desk', permissionIds, impactConfirmationToken: confirmationToken },
    )
    expect(escalated.status).toBe(403)
    expect(await escalated.json()).toMatchObject({ code: 'EnterpriseRoleAssignmentAdminProtected' })
    expect((await identity.getSnapshot(workspaceId)).customRoles[0]?.permissions)
      .not.toContain('members.manage')

    // A role edited after the caller read it is checked again when the assignment is written.
    await expect(identity.putMemberRoleAssignment({
      workspaceId,
      assignmentId: 'assignment-suzuki',
      principalKind: 'member',
      principalId: 'suzuki@example.com',
      roleId: 'workspace:admin',
      scope: { workspaceId, kind: 'workspace' },
      source: 'direct',
    }, undefined, { forbiddenPermissions: ['members.manage'] }))
      .rejects.toMatchObject({ status: 403, code: 'EnterpriseRoleAssignmentAdminProtected' })
  })
})

test('checks the full grant ceiling against the role stored when the assignment is written', async () => {
  const identity = new InMemoryEnterpriseIdentityClient()
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:reader',
    name: 'Reader',
    permissions: ['workspace.read', 'work-items.read', 'work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  })
  const assignment = {
    workspaceId,
    assignmentId: 'assignment-reader',
    principalKind: 'member' as const,
    principalId: 'sato@example.com',
    roleId: 'custom:reader' as const,
    scope: { workspaceId, kind: 'workspace' as const },
    source: 'direct' as const,
  }

  await expect(identity.putMemberRoleAssignment(assignment, undefined, {
    callerPermissions: ['workspace.read', 'work-items.read', 'members.manage'],
  })).rejects.toMatchObject({ status: 403, code: 'EnterpriseRoleAssignmentDenied' })
  expect((await identity.getSnapshot(workspaceId)).roleAssignments).toEqual([])
  await expect(identity.putMemberRoleAssignment(assignment, undefined, {
    callerPermissions: ['workspace.read', 'work-items.read', 'work-items.write'],
    requireGuestAssignable: true,
  })).rejects.toMatchObject({ status: 409, code: 'EnterpriseRoleNotGuestAssignable' })
  await expect(identity.putMemberRoleAssignment(assignment, undefined, {
    callerPermissions: ['workspace.read', 'work-items.read', 'work-items.write'],
  })).resolves.toMatchObject({ roleId: 'custom:reader' })
})

test('rechecks administrative permissions of the stored role when an assignment is removed', async () => {
  const identity = new InMemoryEnterpriseIdentityClient()
  const role = {
    workspaceId,
    roleId: 'custom:desk' as const,
    name: 'Desk',
    permissions: ['workspace.read' as const, 'members.read' as const],
    guestAssignable: false,
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  }
  await identity.putCustomRole(role)
  const assignment = await identity.putMemberRoleAssignment({
    workspaceId,
    assignmentId: 'assignment-desk',
    principalKind: 'member',
    principalId: 'sato@example.com',
    roleId: 'custom:desk',
    scope: { workspaceId, kind: 'workspace' },
    source: 'direct',
  })
  // An owner adds an administrative permission after the caller read the role.
  await identity.putCustomRole({
    ...role,
    permissions: [...role.permissions, 'members.manage'],
    revision: 2,
  })

  await expect(identity.deleteMemberRoleAssignment(assignment, undefined, {
    forbiddenPermissions: ['members.manage'],
  })).rejects.toMatchObject({ status: 403, code: 'EnterpriseRoleAssignmentAdminProtected' })
  expect((await identity.getSnapshot(workspaceId)).roleAssignments).toHaveLength(1)
  await identity.deleteMemberRoleAssignment(assignment)
  expect((await identity.getSnapshot(workspaceId)).roleAssignments).toEqual([])
})

test('lets an admin keep maintaining an assigned role that already holds administrative permissions', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'admin' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    const permissionIds = ['workspace.read' as const, 'members.read' as const, 'members.manage' as const]
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:desk',
      name: 'Desk',
      permissions: permissionIds,
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    })
    // An owner assigned the role, so it already holds an administrative permission.
    await identity.putMemberRoleAssignment({
      workspaceId,
      assignmentId: 'assignment-desk',
      principalKind: 'member',
      principalId: 'sato@example.com',
      roleId: 'custom:desk',
      scope: { workspaceId, kind: 'workspace' },
      source: 'direct',
    })

    const impact = await sendAssignmentRequest(
      '/api/enterprise/security/roles/custom%3Adesk/impact',
      'POST',
      { expectedVersion: 1, permissionIds },
    )
    const { impact: { confirmationToken } } = await impact.json() as {
      impact: { confirmationToken: string }
    }
    const renamed = await sendAssignmentRequest(
      '/api/enterprise/security/roles/custom%3Adesk',
      'PUT',
      { expectedVersion: 1, name: 'Member desk', permissionIds, impactConfirmationToken: confirmationToken },
    )
    expect(renamed.status).toBe(200)
    expect((await identity.getSnapshot(workspaceId)).customRoles[0]?.name).toBe('Member desk')
  })
})

test('cancels an assignment write when the member changed after the route checked it', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'owner' })
    // The fixture members are read at version 1; a later version means a concurrent change.
    let storedVersion = 1
    const identity = new InMemoryEnterpriseIdentityClient(
      undefined,
      undefined,
      undefined,
      async () => storedVersion,
    )
    setTestAppDependencies({ enterpriseIdentity: identity })
    const assignBody = {
      memberKey: 'sato@example.com',
      roleId: 'workspace:portfolio-viewer',
      scopeType: 'workspace',
    }

    storedVersion = 2
    const promotedMeanwhile = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      assignBody,
      'assign-while-promoted',
    )
    expect(promotedMeanwhile.status).toBe(409)
    expect(await promotedMeanwhile.json()).toMatchObject({
      code: 'EnterpriseRoleAssignmentMemberChanged',
    })
    expect((await identity.getSnapshot(workspaceId)).roleAssignments).toEqual([])

    storedVersion = 1
    const created = await sendAssignmentRequest(
      '/api/enterprise/security/role-assignments',
      'POST',
      assignBody,
      'assign-after-reload',
    )
    expect(created.status).toBe(201)
    const { assignment } = await created.json() as { assignment: { id: string } }

    storedVersion = 2
    const roleChangedMeanwhile = await sendAssignmentRequest(
      `/api/enterprise/security/role-assignments/${encodeURIComponent(assignment.id)}`,
      'DELETE',
    )
    expect(roleChangedMeanwhile.status).toBe(409)
    expect(await roleChangedMeanwhile.json()).toMatchObject({
      code: 'EnterpriseRoleAssignmentMemberChanged',
    })
    expect((await identity.getSnapshot(workspaceId)).roleAssignments).toHaveLength(1)

    storedVersion = 1
    const removed = await sendAssignmentRequest(
      `/api/enterprise/security/role-assignments/${encodeURIComponent(assignment.id)}`,
      'DELETE',
    )
    expect(removed.status).toBe(204)
  })
})

test('pins the Enterprise state that showed no assignments when promoting a member', async () => {
  await withTestEnvironment({
    ...enterpriseEnvironment,
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
  }, async () => {
    const calls = configureFakeProjectClients(true, { workspaceRole: 'owner' })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:unrelated',
      name: 'Unrelated',
      permissions: ['workspace.read'],
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    })

    const promotion = await sendAssignmentRequest(
      '/api/workspace/members/sato@example.com',
      'PATCH',
      { role: 'admin', expectedVersion: 1 },
    )
    expect(promotion.status).toBe(200)
    const guestChange = await sendAssignmentRequest(
      '/api/workspace/members/suzuki@example.com',
      'PATCH',
      { role: 'member', expectedVersion: 1 },
    )
    expect(guestChange.status).toBe(200)
    expect(calls.workspaceMemberUpdates.map((update) => update.authorizationConditionChecks))
      .toEqual([
        [{
          ConditionCheck: expect.objectContaining({
            TableName: 'EnterpriseIdentityTable',
            Key: { scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' },
            ExpressionAttributeValues: expect.objectContaining({ ':expectedControlRevision': 1 }),
          }),
        }],
        undefined,
      ])
  })
})

test('refuses a promotion with 503 when the Enterprise revision cannot be fenced', async () => {
  await withTestEnvironment({
    ...enterpriseEnvironment,
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
  }, async () => {
    const calls = configureFakeProjectClients(true, { workspaceRole: 'owner' })
    /** Memory client whose snapshots carry no CONTROL revision. */
    class RevisionlessIdentityClient extends InMemoryEnterpriseIdentityClient {
      /**
       * Returns the snapshot without its CONTROL revision.
       *
       * @param id - Workspace ID.
       * @returns The snapshot.
       */
      override async getSnapshot(id: string) {
        const { controlRevision: _controlRevision, ...snapshot } = await super.getSnapshot(id)
        return snapshot
      }
    }
    setTestAppDependencies({ enterpriseIdentity: new RevisionlessIdentityClient() })

    const promotion = await sendAssignmentRequest(
      '/api/workspace/members/sato@example.com',
      'PATCH',
      { role: 'admin', expectedVersion: 1 },
    )
    expect(promotion.status).toBe(503)
    expect(await promotion.json()).toMatchObject({ code: 'EnterpriseAuthorizationUnavailable' })
    expect(calls.workspaceMemberUpdates).toEqual([])
  })
})
