import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { requireTeamPermission, type ProjectPrincipal } from './project-access'
import { requireWorkItemActualDateCorrectionPermission } from './work-item-actual-dates'

const { configureFakeProjectClients, resetTestApp, runWithTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Builds a principal whose enterprise grant gives it member rights on the whole Team.
 *
 * @returns Principal with a direct Team member grant and no system admin role.
 */
function teamMemberPrincipal(): ProjectPrincipal {
  return {
    directoryId: 'directory-1',
    userKey: 'test-user',
    actorId: 'test-user',
    isSystemAdmin: false,
    groups: [],
    enterpriseTeamAccesses: [{ teamId: 'core-team', permissions: ['teams.read', 'teams.write'] }],
  }
}

/**
 * Configures a Team with two Projects and the given legacy Project roles for the principal.
 *
 * @param projectAccesses - Legacy Project roles of the principal.
 */
function configureTeam(projectAccesses: Array<{ projectId: string, role: 'manager' | 'member' }>) {
  configureFakeProjectClients(true, {
    projectAccesses: projectAccesses.map((access) => ({ teamId: 'core-team', ...access })),
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
  })
}

test('lets a Team member who manages the assigned Project correct its actual dates', async () => {
  configureTeam([{ projectId: 'refero', role: 'manager' }])
  const principal = teamMemberPrincipal()
  await runWithTestAppDependencies(async () => {
    // The update route reads the context at member level, so the direct grant reports member roles.
    const memberContext = await requireTeamPermission(principal, 'core-team', 'member')

    await expect(requireWorkItemActualDateCorrectionPermission(principal, 'core-team', memberContext, 'refero'))
      .resolves.toBeUndefined()
  })
})

test('rejects a Team member who manages only another Project', async () => {
  configureTeam([{ projectId: 'project-2', role: 'manager' }])
  const principal = teamMemberPrincipal()
  await runWithTestAppDependencies(async () => {
    const memberContext = await requireTeamPermission(principal, 'core-team', 'member')

    await expect(requireWorkItemActualDateCorrectionPermission(principal, 'core-team', memberContext, 'refero'))
      .rejects.toMatchObject({ status: 403 })
  })
})
