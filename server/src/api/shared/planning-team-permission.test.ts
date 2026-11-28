import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { listPlanningViewerTeamGrants, requirePlanningUpdateTeamPermission } from './planning-access'
import type { WorkspacePrincipal } from './project-access'

const { configureFakeProjectClients, resetTestApp, runWithTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Builds an Enterprise principal with permissions granted at `core-team` itself and no Project role.
 *
 * @param permissions - Enterprise permissions granted at the Team.
 * @returns The principal.
 */
function teamGrantPrincipal(permissions: Array<'planning.read' | 'planning.write' | 'teams.write' | 'teams.manage'>): WorkspacePrincipal {
  return {
    directoryId: 'user#demo@example.com',
    userKey: 'reviewer@example.com',
    actorId: 'reviewer@example.com',
    isSystemAdmin: false,
    groups: [],
    principalKind: 'member',
    enterprisePermissions: ['planning.read', 'planning.write'],
    enterpriseLegacyProjectAccessSuppressed: true,
    enterpriseProjectAccesses: [],
    enterpriseProjectScopeAccesses: [],
    enterpriseTeamAccesses: [{ teamId: 'core-team', permissions }],
    workspaceMember: {
      id: 'reviewer@example.com',
      memberKey: 'reviewer@example.com',
      email: 'reviewer@example.com',
      role: 'member',
      status: 'active',
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    workspaceRole: 'member',
    workspaceMemberStatus: 'active',
  }
}

test('lets planning.write at the Team act as a member on its update target', async () => {
  configureFakeProjectClients(true, { projectAccesses: [] })
  await runWithTestAppDependencies(async () => {
    // A reviewer accepted for planning.write at the Team can acknowledge (ADR 0123).
    await requirePlanningUpdateTeamPermission(teamGrantPrincipal(['planning.read', 'planning.write']), 'core-team', 'member')
    await expect(requirePlanningUpdateTeamPermission(teamGrantPrincipal(['planning.read', 'planning.write']), 'missing-team', 'member'))
      .rejects.toMatchObject({ status: 404 })
    // Planning read alone does not, and planning.write never manages the Team's cadence.
    await expect(requirePlanningUpdateTeamPermission(teamGrantPrincipal(['planning.read']), 'core-team', 'member'))
      .rejects.toMatchObject({ status: 403 })
    await expect(requirePlanningUpdateTeamPermission(teamGrantPrincipal(['planning.read', 'planning.write']), 'core-team', 'manager'))
      .rejects.toMatchObject({ status: 403 })
  })
})

test('reports the Team grants the Web may offer Team update actions for', async () => {
  configureFakeProjectClients(true, { projectAccesses: [] })
  await runWithTestAppDependencies(async () => {
    await expect(listPlanningViewerTeamGrants(teamGrantPrincipal(['planning.read', 'planning.write'])))
      .resolves.toEqual([{ teamId: 'core-team', role: 'member' }])
    await expect(listPlanningViewerTeamGrants(teamGrantPrincipal(['planning.read', 'teams.write', 'teams.manage'])))
      .resolves.toEqual([{ teamId: 'core-team', role: 'manager' }])
    await expect(listPlanningViewerTeamGrants(teamGrantPrincipal(['planning.read']))).resolves.toEqual([])
    await expect(listPlanningViewerTeamGrants({ ...teamGrantPrincipal(['teams.manage']), isSystemAdmin: true })).resolves.toEqual([])
  })
})
