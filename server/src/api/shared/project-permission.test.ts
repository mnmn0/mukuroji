import { afterEach, expect, test } from 'bun:test'
import type { ProjectAccessEntry } from '../../modules/directory'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { requireProjectPermission, type ProjectPrincipal } from './project-access'

const { configureFakeProjectClients, resetTestApp, runWithTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Team that owns a Project whose ID is also used by `core-team`. */
const otherTeam = {
  id: 'other-team',
  name: 'Other Team',
  projects: [{ id: 'refero', name: 'Other Refero', tone: 'green' as const }],
}

/** Team whose only Project has an ID no other Team uses. */
const soloTeam = {
  id: 'solo-team',
  name: 'Solo Team',
  projects: [{ id: 'solo', name: 'Solo', tone: 'green' as const }],
}

/**
 * Builds a principal that reads only legacy Project ACLs.
 *
 * @returns Principal without Enterprise grants.
 */
function legacyPrincipal(): ProjectPrincipal {
  return {
    directoryId: 'user#demo@example.com',
    userKey: 'demo@example.com',
    actorId: 'demo@example.com',
    isSystemAdmin: false,
    groups: [],
  }
}

/**
 * Builds an Enterprise principal whose only grant is manager on `other-team/refero`.
 *
 * @returns Principal whose legacy Project ACLs are suppressed by the Enterprise directory.
 */
function otherTeamManagerPrincipal(): ProjectPrincipal {
  return {
    ...legacyPrincipal(),
    enterpriseLegacyProjectAccessSuppressed: true,
    enterpriseProjectAccesses: [{ teamId: 'other-team', projectId: 'refero', role: 'manager' }],
  }
}

/**
 * Configures `core-team/refero`, `other-team/refero`, and `solo-team/solo`.
 *
 * @param projectAccesses - Legacy Project ACLs of the principal.
 */
function configureDirectory(projectAccesses: ProjectAccessEntry[] = []) {
  configureFakeProjectClients(true, {
    additionalTeams: [otherTeam, soloTeam],
    projectAccesses,
  })
}

test('fails closed for a legacy Project ACL whose Project ID several Teams share', async () => {
  configureDirectory([{ projectId: 'refero', role: 'manager' }])
  const principal = legacyPrincipal()

  await runWithTestAppDependencies(async () => {
    // Legacy Project membership has no Team, so it cannot tell the two `refero` Projects apart.
    await expect(requireProjectPermission(principal, 'refero', 'viewer'))
      .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
    for (const teamId of ['core-team', 'other-team']) {
      await expect(requireProjectPermission(principal, 'refero', 'viewer', teamId))
        .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
    }
  })
})

test('keeps a legacy Project ACL whose Project ID one Team owns', async () => {
  configureDirectory([{ projectId: 'solo', role: 'manager' }])
  const principal = legacyPrincipal()

  await runWithTestAppDependencies(async () => {
    await requireProjectPermission(principal, 'solo', 'manager')
    await requireProjectPermission(principal, 'solo', 'manager', 'solo-team')
    // A route that names another Team does not own the Project.
    await expect(requireProjectPermission(principal, 'solo', 'viewer', 'core-team'))
      .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
  })
})

test('keeps a Team-qualified grant inside its own Team when the route names the Team', async () => {
  configureDirectory()
  const principal = otherTeamManagerPrincipal()

  await runWithTestAppDependencies(async () => {
    await requireProjectPermission(principal, 'refero', 'manager', 'other-team')
    await expect(requireProjectPermission(principal, 'refero', 'viewer', 'core-team'))
      .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
  })
})
