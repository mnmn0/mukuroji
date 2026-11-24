import { expect, test } from 'bun:test'
import type { EnterpriseRoleAssignment } from '@mukuroji/contracts'
import {
  canAssignEnterpriseRole,
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
} from '../../modules/enterprise-identity'
import {
  hasDirectoryDependentEnterpriseScope,
  resolveEnterpriseDirectoryScopes,
  type EnterpriseScopeDirectory,
} from './enterprise-access'

const workspaceId = 'workspace-1'

/** Sales > Sales East owns `east-team`; Engineering owns `platform`; `loose` has no OrgUnit. */
const directory: EnterpriseScopeDirectory = {
  teams: [
    { id: 'east-team', name: 'East', expanded: true, projects: [{ id: 'east-app', name: 'East App', lifecycleState: 'active' }] },
    { id: 'platform', name: 'Platform', expanded: true, projects: [{ id: 'core', name: 'Core', lifecycleState: 'active' }] },
    { id: 'loose', name: 'Loose', expanded: true, projects: [] },
  ],
  orgStructure: {
    orgUnits: [
      { id: 'sales', name: 'Sales' },
      { id: 'sales-east', name: 'Sales East', parentId: 'sales' },
      { id: 'engineering', name: 'Engineering' },
    ],
    teamAssignments: [
      { teamId: 'east-team', orgUnitId: 'sales-east' },
      { teamId: 'platform', orgUnitId: 'engineering' },
      // An archived Team keeps its membership but is not in the active directory.
      { teamId: 'archived-team', orgUnitId: 'sales' },
    ],
  },
}

const salesManager: EnterpriseRoleAssignment = {
  workspaceId,
  assignmentId: 'sales-manager',
  principalKind: 'member',
  principalId: 'member-1',
  roleId: 'org-unit:manager',
  scope: { workspaceId, kind: 'org-unit', targetId: 'sales' },
  source: 'direct',
}

/**
 * Evaluates one permission for the Sales manager on a resource.
 *
 * @param assignments - Assignments after or before scope resolution.
 * @param resource - Resource to evaluate.
 * @param permission - Permission requested.
 * @returns Whether access is allowed.
 */
function allows(
  assignments: EnterpriseRoleAssignment[],
  resource: EnterpriseAuthorizationResource,
  permission: 'teams.manage' | 'work-items.write' | 'workspace.manage' = 'teams.manage',
) {
  return evaluateEnterpriseAccess({
    permission,
    principal: {
      kind: 'member',
      principalId: 'member-1',
      directoryGroupIds: [],
      workspaceRole: 'member',
      includeWorkspaceRolePermissions: false,
    },
    assignments,
    customRoles: [],
    groupMappings: [],
    resource,
  }).allowed
}

test('expands an OrgUnit scope into the active Teams of its subtree', () => {
  expect(hasDirectoryDependentEnterpriseScope([salesManager])).toBe(true)
  expect(resolveEnterpriseDirectoryScopes([salesManager], directory)).toEqual([{
    ...salesManager,
    scope: { workspaceId, kind: 'team', targetId: 'east-team' },
  }])
})

test('lets an OrgUnit manager act on its Teams and their Projects and denies everything else', () => {
  const resolved = resolveEnterpriseDirectoryScopes([salesManager], directory)

  expect(allows(resolved, { workspaceId, kind: 'team', targetId: 'east-team' })).toBe(true)
  expect(allows(
    resolved,
    { workspaceId, kind: 'project', targetId: 'east-app', parentTeamId: 'east-team' },
    'work-items.write',
  )).toBe(true)
  expect(allows(resolved, { workspaceId, kind: 'team', targetId: 'platform' })).toBe(false)
  expect(allows(resolved, { workspaceId, kind: 'team', targetId: 'loose' })).toBe(false)
  expect(allows(
    resolved,
    { workspaceId, kind: 'project', targetId: 'core', parentTeamId: 'platform' },
    'work-items.write',
  )).toBe(false)
  expect(allows(resolved, { workspaceId, kind: 'workspace' }, 'workspace.manage')).toBe(false)
  expect(allows(resolved, { workspaceId: 'workspace-2', kind: 'team', targetId: 'east-team' })).toBe(false)
})

test('denies by default when an OrgUnit scope cannot be resolved', () => {
  // Unexpanded, the evaluator never matches an OrgUnit scope.
  expect(allows([salesManager], { workspaceId, kind: 'team', targetId: 'east-team' })).toBe(false)
  // Without a structure, for an unknown OrgUnit, or for an OrgUnit without Teams, nothing remains.
  expect(resolveEnterpriseDirectoryScopes([salesManager], { teams: directory.teams })).toEqual([])
  expect(resolveEnterpriseDirectoryScopes([{
    ...salesManager,
    scope: { workspaceId, kind: 'org-unit', targetId: 'deleted-unit' },
  }], directory)).toEqual([])
  expect(resolveEnterpriseDirectoryScopes([{
    ...salesManager,
    scope: { workspaceId, kind: 'org-unit' },
  }], directory)).toEqual([])
})

test('leaves Workspace and Team scopes untouched and needs no directory for them', () => {
  const teamScoped = {
    ...salesManager,
    roleId: 'team:manager',
    scope: { workspaceId, kind: 'team', targetId: 'platform' },
  } satisfies EnterpriseRoleAssignment
  expect(hasDirectoryDependentEnterpriseScope([teamScoped])).toBe(false)
  expect(resolveEnterpriseDirectoryScopes([teamScoped], directory)).toEqual([teamScoped])
})

test('assigns only OrgUnit and custom roles at an OrgUnit scope, within the caller permissions', () => {
  const allPermissions = [
    'teams.read', 'teams.write', 'teams.manage', 'projects.read', 'projects.write',
    'projects.manage', 'work-items.read', 'work-items.write', 'documents.read', 'documents.write',
    'documents.manage', 'files.read', 'files.write', 'files.approve', 'planning.read',
    'planning.write', 'planning.manage',
  ] as const
  expect(canAssignEnterpriseRole([], allPermissions, 'org-unit:manager', 'org-unit')).toBe(true)
  expect(canAssignEnterpriseRole([], allPermissions, 'team:manager', 'org-unit')).toBe(false)
  expect(canAssignEnterpriseRole([], allPermissions, 'org-unit:manager', 'team')).toBe(false)
  expect(canAssignEnterpriseRole([], ['teams.read'], 'org-unit:viewer', 'org-unit')).toBe(false)
})
