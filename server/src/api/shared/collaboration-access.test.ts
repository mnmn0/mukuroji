import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { createCollaborationCommentAuthorizationConditionChecks } from './collaboration-access'
import type { WorkspacePrincipal } from './project-access'
import type { TeamPermissionContext } from './workspace-access'

const {
  configureFakeProjectClients,
  resetTestApp,
  runWithTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'workspace-1'

/** Team context of `east-team`, which the caller reaches only through an OrgUnit role. */
const context: TeamPermissionContext = {
  team: { id: 'east-team', name: 'East Team', expanded: true, projects: [] },
  directory: { teams: [{ id: 'east-team', name: 'East Team', expanded: true, projects: [] }] },
  projectAccesses: [],
}

/**
 * Builds a member authorized on `east-team` by an OrgUnit role resolved at a structure revision.
 *
 * @returns The principal.
 */
function createOrgUnitManager(): WorkspacePrincipal {
  return {
    directoryId: workspaceId,
    userKey: 'member@example.com',
    actorId: 'member-1',
    isSystemAdmin: false,
    groups: [],
    principalKind: 'member',
    enterpriseOrgStructureRevision: 4,
    enterpriseTeamAccesses: [{ teamId: 'east-team', permissions: ['teams.read', 'teams.write'] }],
    workspaceMember: {
      id: 'member-1',
      memberKey: 'member@example.com',
      email: 'member@example.com',
      role: 'member',
      status: 'active',
      version: 3,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    workspaceRole: 'member',
    workspaceMemberStatus: 'active',
  }
}

/**
 * Tells whether a transaction item is the OrgUnit structure revision fence.
 *
 * @param check - Transaction item.
 * @returns Whether it conditions the Workspace's structure row.
 */
function isOrgStructureFence(check: unknown): boolean {
  return typeof check === 'object' && check !== null && 'ConditionCheck' in check &&
    typeof check.ConditionCheck === 'object' && check.ConditionCheck !== null &&
    'Key' in check.ConditionCheck &&
    JSON.stringify(check.ConditionCheck.Key) === JSON.stringify({
      directoryId: `ORG_STRUCTURE#${workspaceId}`,
      entryKey: 'STRUCTURE',
    })
}

test('fences a comment on a Work Item without a Project on the OrgUnit structure that granted it', async () => {
  configureFakeProjectClients(true, { directoryId: workspaceId, workspaceRole: 'member' })

  const checks = await runWithTestAppDependencies(() => createCollaborationCommentAuthorizationConditionChecks(
    createOrgUnitManager(),
    context,
    'east-team',
    undefined,
  ))

  // Taking the Team out of the OrgUnit after authorization must fail the comment at commit.
  const fences = checks.filter(isOrgStructureFence)
  expect(fences).toHaveLength(1)
  expect(fences[0]).toMatchObject({
    ConditionCheck: { ExpressionAttributeValues: { ':expectedOrgStructureRevision': 4 } },
  })
})

test('adds no OrgUnit fence to a comment authorized without an Enterprise grant', async () => {
  configureFakeProjectClients(true, { directoryId: workspaceId, workspaceRole: 'member' })
  const { enterpriseTeamAccesses: _granted, ...principal } = createOrgUnitManager()

  const checks = await runWithTestAppDependencies(() => createCollaborationCommentAuthorizationConditionChecks(
    principal,
    context,
    'east-team',
    undefined,
  ))

  expect(checks.filter(isOrgStructureFence)).toHaveLength(0)
})
