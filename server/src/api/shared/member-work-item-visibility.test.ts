import { type EnterpriseRoleAssignment, type EnterpriseRoleId } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { CognitoServiceError } from '../../modules/authentication'
import { type ProjectAccessEntry, type ProjectDirectoryResponse } from '../../modules/directory'
import { InMemoryEnterpriseIdentityClient } from '../../modules/enterprise-identity/enterprise-identity'
import { type WorkspaceRole } from '../../modules/workspace-access/workspace-access'
import {
  canMemberViewWorkItemScope,
  createMemberWorkItemVisibilityReads,
  type MemberWorkItemVisibilityDependencies,
  type MemberWorkItemVisibilityScope,
} from './member-work-item-visibility'

const WORKSPACE_ID = 'workspace-1'
const MEMBER_KEY = 'pmo@example.com'

/** Two Teams where `shared` is a Project ID both Teams use. */
const DIRECTORY: ProjectDirectoryResponse = {
  teams: [
    {
      id: 'core-team',
      name: 'Core',
      expanded: true,
      projects: [
        { id: 'refero', name: 'Refero', tone: 'blue', lifecycleState: 'active' },
        { id: 'shared', name: 'Shared core', tone: 'green', lifecycleState: 'active' },
      ],
    },
    {
      id: 'other-team',
      name: 'Other',
      expanded: true,
      projects: [{ id: 'shared', name: 'Shared other', tone: 'green', lifecycleState: 'active' }],
    },
  ],
}

/** Inputs for one fake dependency set. */
type FakeOptions = {
  /** Legacy Project membership rows of the member. */
  legacyAccesses?: ProjectAccessEntry[]
  /** Enterprise role assignments in the snapshot. */
  roleAssignments?: EnterpriseRoleAssignment[]
  /** Whether the member is a system administrator. */
  systemAdmin?: boolean
}

/**
 * Builds fake ports around an in-memory Enterprise snapshot.
 *
 * @param options - Legacy rows, Enterprise assignments, and system-admin state.
 * @returns Dependencies for the visibility check.
 */
function createDependencies(options: FakeOptions = {}): MemberWorkItemVisibilityDependencies {
  const identity = new InMemoryEnterpriseIdentityClient()
  return {
    cognito: {
      isSystemAdmin: async () => options.systemAdmin ?? false,
      getUserGroups: async () => [],
    },
    enterpriseIdentity: {
      getSnapshot: async (workspaceId) => ({
        ...await identity.getSnapshot(workspaceId),
        roleAssignments: options.roleAssignments ?? [],
      }),
    },
    projectDirectory: {
      getProjectDirectory: async () => DIRECTORY,
      getProjectAccessList: async () => options.legacyAccesses ?? [],
    },
  }
}

/**
 * Builds a direct personal role assignment for the member.
 *
 * @param roleId - Assigned role.
 * @param scope - Assignment scope.
 * @returns The role assignment.
 */
function assignment(
  roleId: EnterpriseRoleId,
  scope: EnterpriseRoleAssignment['scope'] = { workspaceId: WORKSPACE_ID, kind: 'workspace' },
): EnterpriseRoleAssignment {
  return {
    workspaceId: WORKSPACE_ID,
    assignmentId: `assignment-${roleId}`,
    principalKind: 'member',
    principalId: MEMBER_KEY,
    roleId,
    scope,
    source: 'direct',
  }
}

/**
 * Runs the check for the member with a given Workspace role.
 *
 * @param scope - Scope fields other than the Workspace.
 * @param options - Fake dependency inputs.
 * @param role - Workspace role of the member.
 * @returns The visibility decision.
 */
function check(
  scope: Omit<MemberWorkItemVisibilityScope, 'workspaceId' | 'permissions'> &
    Partial<Pick<MemberWorkItemVisibilityScope, 'permissions'>>,
  options: FakeOptions = {},
  role: WorkspaceRole = 'member',
) {
  return canMemberViewWorkItemScope(
    { memberKey: MEMBER_KEY, email: MEMBER_KEY, role },
    { workspaceId: WORKSPACE_ID, permissions: ['work-items.read'], ...scope },
    createDependencies(options),
  )
}

test('lets a member who can view only through a personal role assignment be picked', async () => {
  const options = { roleAssignments: [assignment('workspace:portfolio-viewer')] }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, options)).toBe(true)
  expect(await check({ teamId: 'core-team' }, options)).toBe(true)
  expect(await check(
    { teamId: 'core-team', assignedProjectId: 'refero', permissions: ['work-items.read', 'files.read'] },
    options,
  )).toBe(true)
})

test('limits a Project-scoped role assignment to its own Team and Project', async () => {
  const options = {
    roleAssignments: [assignment('project:viewer', {
      workspaceId: WORKSPACE_ID,
      kind: 'project',
      targetId: 'refero',
      parentTeamId: 'core-team',
    })],
  }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, options)).toBe(true)
  // A Team-level Work Item is visible through any Project of the Team.
  expect(await check({ teamId: 'core-team' }, options)).toBe(true)
  expect(await check({ teamId: 'core-team', assignedProjectId: 'shared' }, options)).toBe(false)
  expect(await check({ teamId: 'other-team' }, options)).toBe(false)
})

test('ignores legacy membership once Enterprise decides the member access', async () => {
  const options = {
    legacyAccesses: [{ projectId: 'refero', role: 'manager' as const, teamId: 'core-team' }],
    roleAssignments: [assignment('workspace:auditor')],
  }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, options)).toBe(false)
  expect(await check({ teamId: 'core-team' }, options)).toBe(false)
})

test('requires every requested permission', async () => {
  const options = {
    roleAssignments: [assignment('workspace:auditor'), assignment('project:viewer', {
      workspaceId: WORKSPACE_ID,
      kind: 'project',
      targetId: 'refero',
      parentTeamId: 'core-team',
    })],
  }
  expect(await check(
    { teamId: 'core-team', assignedProjectId: 'refero', permissions: ['work-items.read', 'files.approve'] },
    options,
  )).toBe(false)
})

test('uses Team-qualified legacy membership when Enterprise does not decide', async () => {
  const qualified = { legacyAccesses: [{ projectId: 'refero', role: 'viewer' as const }] }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, qualified)).toBe(true)
  expect(await check({ teamId: 'core-team' }, qualified)).toBe(true)
  expect(await check({ teamId: 'other-team' }, qualified)).toBe(false)
})

test('fails closed for a legacy membership of a Project ID several Teams share', async () => {
  const legacy = { legacyAccesses: [{ projectId: 'shared', role: 'manager' as const }] }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'shared' }, legacy)).toBe(false)
  expect(await check({ teamId: 'other-team', assignedProjectId: 'shared' }, legacy)).toBe(false)
  expect(await check({ teamId: 'other-team' }, legacy)).toBe(false)

  const qualified = {
    legacyAccesses: [{ projectId: 'shared', role: 'viewer' as const, teamId: 'other-team' }],
  }
  expect(await check({ teamId: 'other-team', assignedProjectId: 'shared' }, qualified)).toBe(true)
  expect(await check({ teamId: 'core-team', assignedProjectId: 'shared' }, qualified)).toBe(false)
})

test('rejects a Project that is not active in the owner Team', async () => {
  const options = { roleAssignments: [assignment('workspace:portfolio-viewer')] }
  expect(await check({ teamId: 'other-team', assignedProjectId: 'refero' }, options)).toBe(false)
  expect(await check({ teamId: 'missing-team' }, options)).toBe(false)
})

test('keeps Workspace-wide read roles away from a guest', async () => {
  const options = { roleAssignments: [assignment('workspace:portfolio-viewer')] }
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, options, 'guest')).toBe(false)
})

test('lets a system administrator view without any membership', async () => {
  expect(await check({ teamId: 'core-team', assignedProjectId: 'refero' }, { systemAdmin: true })).toBe(true)
})

test('reads the directory and Enterprise snapshot once for several members', async () => {
  const counts = { directory: 0, snapshot: 0 }
  const base = createDependencies({ roleAssignments: [assignment('workspace:portfolio-viewer')] })
  const dependencies: MemberWorkItemVisibilityDependencies = {
    ...base,
    enterpriseIdentity: {
      getSnapshot: async (workspaceId) => {
        counts.snapshot += 1
        return await base.enterpriseIdentity.getSnapshot(workspaceId)
      },
    },
    projectDirectory: {
      ...base.projectDirectory,
      getProjectDirectory: async (...input) => {
        counts.directory += 1
        return await base.projectDirectory.getProjectDirectory(...input)
      },
    },
  }
  const reads = createMemberWorkItemVisibilityReads(WORKSPACE_ID, dependencies)
  const results = await Promise.all([MEMBER_KEY, 'other@example.com'].map((memberKey) =>
    canMemberViewWorkItemScope(
      { memberKey, email: memberKey, role: 'member' },
      { workspaceId: WORKSPACE_ID, teamId: 'core-team', permissions: ['work-items.read'] },
      dependencies,
      reads,
    )
  ))
  expect(results).toEqual([true, false])
  expect(counts).toEqual({ directory: 1, snapshot: 1 })
})

test('treats a member without a Cognito user as having no groups', async () => {
  const base = createDependencies({
    roleAssignments: [{
      ...assignment('workspace:portfolio-viewer'),
      principalKind: 'directory-group',
      principalId: 'pmo-group',
    }],
  })
  const notFound = new CognitoServiceError(400, 'UserNotFoundException', 'User does not exist.')
  const dependencies: MemberWorkItemVisibilityDependencies = {
    ...base,
    cognito: {
      isSystemAdmin: async () => false,
      getUserGroups: async () => { throw notFound },
    },
  }
  expect(await canMemberViewWorkItemScope(
    { memberKey: MEMBER_KEY, email: MEMBER_KEY, role: 'member' },
    { workspaceId: WORKSPACE_ID, teamId: 'core-team', permissions: ['work-items.read'] },
    dependencies,
  )).toBe(false)
})
