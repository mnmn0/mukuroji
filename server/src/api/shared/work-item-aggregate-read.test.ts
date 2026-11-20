import { afterEach, expect, test } from 'bun:test'
import type { ProjectAccessEntry } from '../../modules/directory'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { requireTeamPermission, type ProjectPrincipal } from './project-access'
import { filterAccessibleTeamIssues } from './work-item-access'
import {
  readAllAccessibleWorkItems,
  resolveAccessibleWorkItemTeamContexts,
} from './work-item-aggregate-read'

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

/**
 * Builds an Enterprise principal whose only grant is viewer on `other-team/refero`.
 *
 * @returns Principal whose legacy Project ACLs are suppressed by the Enterprise directory.
 */
function otherTeamViewerPrincipal(): ProjectPrincipal {
  return {
    directoryId: 'user#demo@example.com',
    userKey: 'demo@example.com',
    actorId: 'demo@example.com',
    isSystemAdmin: false,
    groups: [],
    enterpriseLegacyProjectAccessSuppressed: true,
    enterpriseProjectAccesses: [{ teamId: 'other-team', projectId: 'refero', role: 'viewer' }],
  }
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
 * Configures `core-team/refero` and `other-team/refero` with the given legacy ACLs.
 *
 * @param projectAccesses - Legacy Project ACLs of the principal.
 */
function configureDuplicateProjectIds(projectAccesses: ProjectAccessEntry[] = []) {
  configureFakeProjectClients(true, {
    additionalTeams: [otherTeam],
    projectAccesses,
  })
}

test('keeps a Team-qualified Project grant inside its own Team when another Team reuses the Project ID', async () => {
  configureDuplicateProjectIds()
  const principal = otherTeamViewerPrincipal()

  await runWithTestAppDependencies(async () => {
    const contexts = await resolveAccessibleWorkItemTeamContexts(principal)
    expect(contexts.map((context) => context.team.id)).toEqual(['other-team'])
    expect(contexts[0]?.projectAccesses).toEqual([
      { teamId: 'other-team', projectId: 'refero', role: 'viewer' },
    ])

    const workItems = await readAllAccessibleWorkItems(principal, contexts, { includeArchived: false })
    expect(workItems.map((workItem) => workItem.teamId)).toEqual(['other-team'])

    expect(await resolveAccessibleWorkItemTeamContexts(principal, { teamId: 'core-team' })).toEqual([])
  })
})

test('does not let a Team-qualified grant of another Team open the Team or its Work Items', async () => {
  configureDuplicateProjectIds()
  const principal = otherTeamViewerPrincipal()

  await runWithTestAppDependencies(async () => {
    await expect(requireTeamPermission(principal, 'core-team', 'viewer'))
      .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })

    const otherContext = await requireTeamPermission(principal, 'other-team', 'viewer')
    // A context that still carries another Team's grant must not authorize this Team's Work Items.
    const mixedContext = { ...otherContext, team: { ...otherContext.team, id: 'core-team' } }
    const coreWorkItems = await readAllAccessibleWorkItems(
      { ...principal, isSystemAdmin: true },
      [{ team: mixedContext.team, directory: mixedContext.directory }],
      { includeArchived: false },
    )
    expect(coreWorkItems.map((workItem) => workItem.assignedProjectId)).toEqual(['refero'])
    expect(filterAccessibleTeamIssues(coreWorkItems, principal, mixedContext)).toEqual([])
  })
})

test('fails closed for a legacy Project ACL whose Project ID several Teams share', async () => {
  configureDuplicateProjectIds([{ projectId: 'refero', role: 'manager' }])
  const principal = legacyPrincipal()

  await runWithTestAppDependencies(async () => {
    // Legacy Project membership has no Team, so it cannot tell the two `refero` Projects apart.
    expect(await resolveAccessibleWorkItemTeamContexts(principal)).toEqual([])
    for (const teamId of ['core-team', 'other-team']) {
      await expect(requireTeamPermission(principal, teamId, 'viewer'))
        .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
    }
  })
})

test('does not raise a Team-qualified grant with a legacy role whose Project ID several Teams share', async () => {
  configureDuplicateProjectIds([{ projectId: 'refero', role: 'manager' }])
  const principal: ProjectPrincipal = {
    ...otherTeamViewerPrincipal(),
    enterpriseLegacyProjectAccessSuppressed: false,
  }

  await runWithTestAppDependencies(async () => {
    const contexts = await resolveAccessibleWorkItemTeamContexts(principal)
    expect(contexts.map((context) => context.team.id)).toEqual(['other-team'])
    expect(contexts[0]?.projectAccesses).toEqual([
      { teamId: 'other-team', projectId: 'refero', role: 'viewer' },
    ])
    await expect(requireTeamPermission(principal, 'other-team', 'member'))
      .rejects.toMatchObject({ status: 403, code: 'ProjectAccessDenied' })
  })
})

test('keeps a legacy Project ACL whose Project ID belongs to exactly one Team', async () => {
  configureFakeProjectClients(true, { projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const principal = legacyPrincipal()

  await runWithTestAppDependencies(async () => {
    const contexts = await resolveAccessibleWorkItemTeamContexts(principal)
    expect(contexts.map((context) => context.team.id)).toEqual(['core-team'])
    expect(contexts[0]?.projectAccesses).toEqual([
      { teamId: 'core-team', projectId: 'refero', role: 'viewer' },
    ])
  })
})
