import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import type { EnterpriseRoleId, OrgStructure } from '@mukuroji/contracts'
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

/** Sales has a child East unit; Engineering is a separate top-level unit. */
const orgStructure: OrgStructure = {
  orgUnits: [
    { id: 'sales', name: 'Sales' },
    { id: 'sales-east', name: 'Sales East', parentId: 'sales' },
    { id: 'engineering', name: 'Engineering' },
  ],
  teamAssignments: [
    { teamId: 'east-team', orgUnitId: 'sales-east' },
    { teamId: 'core-team', orgUnitId: 'engineering' },
  ],
  revision: 1,
  updatedAt: '2026-11-20T00:00:00.000Z',
}

/** Teams beside the harness's `core-team`: one in Sales East and one in no OrgUnit. */
const additionalTeams = [
  {
    id: 'east-team',
    name: 'East Team',
    projects: [{ id: 'east-app', name: 'East App', tone: 'green' as const }],
  },
  {
    id: 'west-team',
    name: 'West Team',
    projects: [{ id: 'west-app', name: 'West App', tone: 'yellow' as const }],
  },
]

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
 * Sends one request as the fixture member.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, when the request has one.
 * @returns The HTTP response.
 */
function send(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: createAuthorization(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Configures the fixture member as a Workspace member with one direct OrgUnit role on Sales.
 *
 * @param roleId - Role assigned at the Sales OrgUnit.
 * @param structure - OrgUnit structure the directory returns.
 * @param beforeTeamRenameCommit - Change to the stored structure between authorization and commit.
 */
async function configureOrgUnitRole(
  roleId: EnterpriseRoleId,
  structure: OrgStructure = orgStructure,
  beforeTeamRenameCommit?: (setOrgStructure: (next: OrgStructure) => void) => void,
) {
  configureFakeProjectClients(false, {
    workspaceRole: 'member',
    additionalTeams,
    orgStructure: structure,
    ...(beforeTeamRenameCommit ? { beforeTeamRenameCommit } : {}),
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  await identity.putMemberRoleAssignment({
    workspaceId,
    assignmentId: `assignment-${roleId}`,
    principalKind: 'member',
    principalId: 'demo@example.com',
    roleId,
    scope: { workspaceId, kind: 'org-unit', targetId: 'sales' },
    source: 'direct',
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
}

test('lets an OrgUnit role read the Teams of its subtree only, denying every other Team', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    await configureOrgUnitRole('org-unit:viewer')

    const east = await send('/api/teams/east-team/issues')
    expect(east.status).toBe(200)
    expect(await east.json()).toMatchObject({ teamId: 'east-team' })

    // Engineering is another OrgUnit, and West Team belongs to none: both stay denied.
    expect((await send('/api/teams/core-team/issues')).status).toBe(403)
    expect((await send('/api/teams/west-team/issues')).status).toBe(403)
  })
})

test('keeps an OrgUnit viewer read-only on the Teams it can read', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    await configureOrgUnitRole('org-unit:viewer')

    const renamed = await send('/api/teams/east-team', 'PATCH', { nameJa: '東チーム', nameEn: 'East' })
    expect(renamed.status).toBe(403)
  })
})

test('lets an OrgUnit manager write on the Teams of its subtree only', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    await configureOrgUnitRole('org-unit:manager')
    const rename = { nameJa: '東チーム', nameEn: 'East' }

    // Renaming is Team administration (`teams.manage`), held on the subtree's Teams only.
    expect((await send('/api/teams/east-team', 'PATCH', rename)).status).toBe(200)
    expect((await send('/api/teams/core-team', 'PATCH', rename)).status).toBe(403)
    expect((await send('/api/teams/west-team', 'PATCH', rename)).status).toBe(403)
    // The structure itself stays Workspace administration, so a manager cannot widen its reach.
    const widened = await send('/api/org-structure', 'PUT', {
      expectedRevision: 1,
      orgUnits: orgStructure.orgUnits,
      teamAssignments: [{ teamId: 'core-team', orgUnitId: 'sales' }],
    })
    expect(widened.status).toBe(403)
  })
})

test('rejects an OrgUnit manager write when the structure changes between authorization and commit', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    // An administrator takes East Team out of Sales after the manager was authorized.
    await configureOrgUnitRole('org-unit:manager', orgStructure, (setOrgStructure) => setOrgStructure({
      ...orgStructure,
      teamAssignments: orgStructure.teamAssignments.filter((assignment) => assignment.teamId !== 'east-team'),
      revision: orgStructure.revision + 1,
    }))

    const renamed = await send('/api/teams/east-team', 'PATCH', { nameJa: '東チーム', nameEn: 'East' })
    expect(renamed.status).toBe(403)
    expect(await renamed.json()).toMatchObject({ code: 'DirectoryAuthorizationChanged' })
  })
})

test('grants nothing through an OrgUnit role when the Workspace has no OrgUnit structure', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    await configureOrgUnitRole('org-unit:manager', { orgUnits: [], teamAssignments: [], revision: 0 })

    expect((await send('/api/teams/east-team/issues')).status).toBe(403)
    expect((await send('/api/teams/core-team/issues')).status).toBe(403)
    // The unresolved assignment still replaces the legacy member role, so the member listing that
    // a plain member may read (`members.read`) stays denied instead of falling back to it.
    expect((await send('/api/workspace/access')).status).toBe(403)
  })
})

test('does not fall back to the legacy Workspace role when an OrgUnit has no active Team', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    await configureOrgUnitRole('org-unit:manager', {
      ...orgStructure,
      teamAssignments: orgStructure.teamAssignments.filter((assignment) => assignment.orgUnitId === 'engineering'),
    })

    expect((await send('/api/teams/east-team/issues')).status).toBe(403)
    expect((await send('/api/workspace/access')).status).toBe(403)
  })
})

test('assigns an OrgUnit role only to an existing OrgUnit and only OrgUnit or custom roles', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'owner', additionalTeams, orgStructure })
    const identity = new InMemoryEnterpriseIdentityClient()
    setTestAppDependencies({ enterpriseIdentity: identity })

    const unknown = await send('/api/enterprise/security/role-assignments', 'POST', {
      memberKey: 'sato@example.com',
      roleId: 'org-unit:manager',
      scopeType: 'org-unit',
      scopeId: 'marketing',
    })
    expect(unknown.status).toBe(409)
    expect(await unknown.json()).toMatchObject({ code: 'EnterpriseResourceScopeNotFound' })

    const teamRole = await send('/api/enterprise/security/role-assignments', 'POST', {
      memberKey: 'sato@example.com',
      roleId: 'team:manager',
      scopeType: 'org-unit',
      scopeId: 'sales',
    })
    expect(teamRole.status).toBe(403)

    const created = await send('/api/enterprise/security/role-assignments', 'POST', {
      memberKey: 'sato@example.com',
      roleId: 'org-unit:manager',
      scopeType: 'org-unit',
      scopeId: 'sales',
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      assignment: { roleId: 'org-unit:manager', scopeType: 'org-unit', scopeId: 'sales' },
    })
  })
})

test('lets members read the OrgUnit structure and only administrators replace it', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'member', additionalTeams, orgStructure })

    const read = await send('/api/org-structure')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ orgStructure })

    const denied = await send('/api/org-structure', 'PUT', {
      expectedRevision: 1,
      orgUnits: [],
      teamAssignments: [],
    })
    expect(denied.status).toBe(403)
  })
})

test('refuses the OrgUnit structure to guests', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'guest', additionalTeams, orgStructure })

    expect((await send('/api/org-structure')).status).toBe(403)
  })
})

test('replaces the OrgUnit structure with compare-and-swap and validates it', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, { workspaceRole: 'owner', additionalTeams })

    const empty = await send('/api/org-structure')
    expect(await empty.json()).toEqual({
      orgStructure: { orgUnits: [], teamAssignments: [], revision: 0 },
    })

    const cyclic = await send('/api/org-structure', 'PUT', {
      expectedRevision: 0,
      orgUnits: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
      teamAssignments: [],
    })
    expect(cyclic.status).toBe(400)
    expect(await cyclic.json()).toMatchObject({ code: 'InvalidOrgStructure' })

    const saved = await send('/api/org-structure', 'PUT', {
      expectedRevision: 0,
      orgUnits: orgStructure.orgUnits,
      teamAssignments: orgStructure.teamAssignments,
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ orgStructure: { revision: 1 } })

    const stale = await send('/api/org-structure', 'PUT', {
      expectedRevision: 0,
      orgUnits: [],
      teamAssignments: [],
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'OrgStructureConflict' })
  })
})
