import { expect, test } from 'bun:test'
import type { EnterpriseRoleAssignment } from '@mukuroji/contracts'
import { listEnterpriseProjectManagerKeys } from './enterprise-project-managers'

/**
 * Builds a role assignment of the test Workspace.
 *
 * @param principalId - Member or group receiving the role.
 * @param overrides - Fields to change.
 * @returns The assignment.
 */
function assignment(principalId: string, overrides: Partial<EnterpriseRoleAssignment> = {}): EnterpriseRoleAssignment {
  return {
    workspaceId: 'w',
    assignmentId: `${principalId}-${overrides.roleId ?? 'project:manager'}`,
    principalKind: 'member',
    principalId,
    roleId: 'project:manager',
    scope: { workspaceId: 'w', kind: 'project', targetId: 'p', parentTeamId: 't' },
    source: 'direct',
    ...overrides,
  }
}

test('lists members whose role manages the Project or its Team, once each', () => {
  const keys = listEnterpriseProjectManagerKeys({
    customRoles: [{
      workspaceId: 'w',
      roleId: 'custom:budget-owner',
      name: 'Budget owner',
      permissions: ['projects.read', 'projects.manage'],
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    roleAssignments: [
      assignment('manager@example.com'),
      assignment('manager@example.com', { assignmentId: 'again' }),
      assignment('custom@example.com', { roleId: 'custom:budget-owner', scope: { workspaceId: 'w', kind: 'team', targetId: 't' } }),
      assignment('member@example.com', { roleId: 'project:member' }),
      assignment('group', { principalKind: 'directory-group' }),
      assignment('other-team@example.com', { scope: { workspaceId: 'w', kind: 'project', targetId: 'p', parentTeamId: 'other' } }),
      assignment('other-project@example.com', { scope: { workspaceId: 'w', kind: 'project', targetId: 'q', parentTeamId: 't' } }),
    ],
  }, 't', 'p')
  expect(keys).toEqual(['manager@example.com', 'custom@example.com'])
})
