import { expect, test } from 'bun:test'
import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import type { ProjectDirectoryTeamResponse } from '../../modules/directory'
import type { EnterpriseAuthorizationEvaluationSnapshot } from './enterprise-access'
import type { ProjectPrincipal } from './project-access'
import type { TeamPermissionContext } from './workspace-access'
import { createPersonWorkflowRulePrincipal, resolveWorkflowRuleActor } from './work-item-configuration'

const team: ProjectDirectoryTeamResponse = {
  id: 'team-1',
  name: 'Core',
  expanded: true,
  projects: [
    { id: 'project-1', name: 'Alpha', lifecycleState: 'active' },
    { id: 'project-2', name: 'Beta', lifecycleState: 'active' },
  ],
}

/**
 * Builds a Team context whose Project roles came from a `work-items.write` route grant.
 *
 * @returns A context that lists both Projects with the member role only.
 */
function memberRouteContext(): TeamPermissionContext {
  return {
    team,
    directory: { teams: [team] },
    projectAccesses: team.projects.map((project) => ({ teamId: team.id, projectId: project.id, role: 'member' })),
  }
}

/**
 * Builds an enterprise evaluation in which the member holds `project:manager` on one Project.
 *
 * @param projectId - Project the member manages.
 * @returns Evaluation snapshot with one direct Project role assignment.
 */
function projectManagerEvaluation(projectId: string): EnterpriseAuthorizationEvaluationSnapshot {
  const assignments: EnterpriseIdentitySnapshot['roleAssignments'] = [{
    workspaceId: 'workspace-1',
    assignmentId: 'assignment-1',
    principalKind: 'member',
    principalId: 'member-1',
    roleId: 'project:manager',
    scope: { kind: 'project', workspaceId: 'workspace-1', targetId: projectId, parentTeamId: team.id },
    source: 'direct',
  }]
  return {
    principal: { kind: 'member', principalId: 'member-1', directoryGroupIds: [], workspaceRole: 'member' },
    snapshot: {
      workspaceId: 'workspace-1',
      identityProviders: [],
      domains: [],
      customRoles: [],
      groupMappings: [],
      roleAssignments: assignments,
      scimUsers: [],
      scimGroups: [],
      scimCredentials: [],
      serviceAccounts: [],
      breakGlassAccounts: [],
      provisioningRuns: [],
      provisioningLogs: [],
    },
    assignments,
    groupMappings: [],
  }
}

/**
 * Builds a signed-in principal.
 *
 * @param overrides - Fields that differ from an interactive member.
 * @returns The principal.
 */
function principal(overrides: Partial<ProjectPrincipal> = {}): ProjectPrincipal {
  return {
    directoryId: 'workspace-1',
    userKey: 'member@example.com',
    actorId: 'member-1',
    isSystemAdmin: false,
    groups: [],
    principalKind: 'member',
    ...overrides,
  }
}

test('judges an enterprise service account like a developer credential, never as a person', () => {
  const rulePrincipal = createPersonWorkflowRulePrincipal(
    principal({ principalKind: 'service-account', isSystemAdmin: false }),
    memberRouteContext(),
  )

  expect(rulePrincipal).toEqual({ kind: 'credential' })
  expect(resolveWorkflowRuleActor(rulePrincipal, { assigneeUserId: 'member@example.com' }, undefined))
    .toEqual({ interactive: false, projectManager: false, assignee: false })
})

test('reads an enterprise Project manager from the role assignments, not from the route grant', () => {
  const rulePrincipal = createPersonWorkflowRulePrincipal(
    principal({ enterpriseAuthorizationEvaluation: projectManagerEvaluation('project-1') }),
    memberRouteContext(),
  )

  expect(resolveWorkflowRuleActor(rulePrincipal, { assignedProjectId: 'project-1' }, 'project-1').projectManager)
    .toBe(true)
  // A Work Item without a Project needs a Team manager, which a manager of any Project of the Team is.
  expect(resolveWorkflowRuleActor(rulePrincipal, {}, undefined).projectManager).toBe(true)
  // Moving into a Project the member does not manage borrows no role from the source Project.
  expect(resolveWorkflowRuleActor(rulePrincipal, { assignedProjectId: 'project-1' }, 'project-2').projectManager)
    .toBe(false)
})

test('treats a principal without a Team context as a manager only when it is a system admin', () => {
  expect(resolveWorkflowRuleActor(createPersonWorkflowRulePrincipal(principal(), undefined), {}, undefined))
    .toEqual({ interactive: true, projectManager: false, assignee: false })
  expect(resolveWorkflowRuleActor(
    createPersonWorkflowRulePrincipal(principal({ isSystemAdmin: true }), undefined),
    {},
    undefined,
  ).projectManager).toBe(true)
})
