import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import type { TeamIssue } from '../src/issues/api'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import { resolveProjectTaskRouteContext } from '../src/tasks/model/taskRoute'

const sharedProjectTeams: ProjectDirectoryTeam[] = [
  {
    id: 'core-team',
    name: 'Core Team',
    projects: [
      { id: 'shared-project', name: 'Core shared Project' },
      { id: 'core-only', name: 'Core only Project' },
    ],
  },
  {
    id: 'design-team',
    name: 'Design Team',
    projects: [{ id: 'shared-project', name: 'Design shared Project' }],
  },
]

describe('Project task route context', () => {
  test('resolves an explicitly selected Team for a Project ID shared by multiple Teams', () => {
    const coreIssue = createIssue('core-issue', 'core-team')
    const designIssue = createIssue('design-issue', 'design-team')
    const context = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues: [coreIssue, designIssue],
      selectedIssueId: 'design-issue',
      selectedTeamId: 'design-team',
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(context.selectedProjectTeam).toBe(sharedProjectTeams[1])
    expect(context.projectTeams).toEqual(sharedProjectTeams)
    expect(context.aggregateProjectTeam).toBeUndefined()
    expect(context.matchingProjects.map((project) => project.name)).toEqual([
      'Core shared Project',
      'Design shared Project',
    ])
    expect(context.tasks).toEqual([designIssue])
    expect(context.hasAmbiguousIssueSelection).toBe(false)
    expect(context.requestedIssue).toBe(designIssue)
    expect(context.resolvedSelectedIssue).toBe(designIssue)
    expect(context.interactionTeamId).toBe('design-team')
    expect(context.interactionTeam).toBe(sharedProjectTeams[1])
    expect(context.activeTeam).toBe(sharedProjectTeams[1])
    expect(context.creationTeam).toBe(sharedProjectTeams[1])
    expect(context.listConfigurationTeamId).toBe('design-team')
    expect(context.activeProject).toBe(sharedProjectTeams[1]?.projects[0])
    expect(context.configurationTeamIds).toEqual(['design-team'])
    expect(context.selectedWorkItemTeamId).toBe('design-team')
  })

  test('suppresses Team interaction for an ambiguous unscoped Issue ID', () => {
    const coreIssue = createIssue('same-local-id', 'core-team')
    const designIssue = createIssue('same-local-id', 'design-team')
    const projectIssues = [coreIssue, designIssue]
    const ambiguousContext = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues,
      selectedIssueId: 'same-local-id',
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(ambiguousContext.tasks).toBe(projectIssues)
    expect(ambiguousContext.hasAmbiguousIssueSelection).toBe(true)
    expect(ambiguousContext.requestedIssue).toBeUndefined()
    expect(ambiguousContext.resolvedSelectedIssue).toBe(coreIssue)
    expect(ambiguousContext.interactionTeamId).toBeUndefined()
    expect(ambiguousContext.interactionTeam).toBeUndefined()
    expect(ambiguousContext.activeTeam).toBeUndefined()
    expect(ambiguousContext.creationTeam).toBeUndefined()
    expect(ambiguousContext.listConfigurationTeamId).toBeUndefined()
    expect(ambiguousContext.activeProject).toBeUndefined()
    expect(ambiguousContext.configurationTeamIds).toEqual(['core-team', 'design-team'])
    expect(ambiguousContext.selectedWorkItemTeamId).toBeUndefined()

    const scopedContext = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues,
      selectedIssueId: 'same-local-id',
      selectedTeamId: 'design-team',
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(scopedContext.hasAmbiguousIssueSelection).toBe(false)
    expect(scopedContext.requestedIssue).toBe(designIssue)
    expect(scopedContext.resolvedSelectedIssue).toBe(designIssue)
    expect(scopedContext.selectedWorkItemTeamId).toBe('design-team')
  })

  test('keeps task-empty Project Teams in configuration scope and honors fallback suppression', () => {
    const coreIssue = createIssue('core-only-issue', 'core-team')
    const aggregateContext = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues: [coreIssue],
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(aggregateContext.projectTeams).toEqual(sharedProjectTeams)
    expect(aggregateContext.configurationTeamIds).toEqual(['core-team', 'design-team'])
    expect(aggregateContext.selectedWorkItemTeamId).toBe('core-team')

    const suppressedContext = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues: [coreIssue],
      suppressIssueFallback: true,
      teams: sharedProjectTeams,
    })

    expect(suppressedContext.resolvedSelectedIssue).toBe(coreIssue)
    expect(suppressedContext.selectedWorkItemTeamId).toBeUndefined()

    const selectedEmptyTeamContext = resolveProjectTaskRouteContext({
      projectId: 'shared-project',
      projectIssues: [coreIssue],
      selectedTeamId: 'design-team',
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(selectedEmptyTeamContext.tasks).toEqual([])
    expect(selectedEmptyTeamContext.resolvedSelectedIssue).toBeUndefined()
    expect(selectedEmptyTeamContext.interactionTeamId).toBe('design-team')
    expect(selectedEmptyTeamContext.configurationTeamIds).toEqual(['design-team'])
    expect(selectedEmptyTeamContext.selectedWorkItemTeamId).toBe('design-team')
  })

  test('uses a sole Project Team as the aggregate interaction and creation context', () => {
    const soleTeam = sharedProjectTeams.find((team) => team.id === 'core-team')

    if (!soleTeam) {
      throw new Error('The Core Team fixture is required.')
    }

    const context = resolveProjectTaskRouteContext({
      projectId: 'core-only',
      projectIssues: [],
      suppressIssueFallback: false,
      teams: sharedProjectTeams,
    })

    expect(context.aggregateProjectTeam).toBe(soleTeam)
    expect(context.interactionTeamId).toBe('core-team')
    expect(context.interactionTeam).toBe(soleTeam)
    expect(context.activeTeam).toBe(soleTeam)
    expect(context.creationTeam).toBe(soleTeam)
    expect(context.listConfigurationTeamId).toBe('core-team')
    expect(context.activeProject).toBe(soleTeam.projects[1])
    expect(context.configurationTeamIds).toEqual(['core-team'])
    expect(context.selectedWorkItemTeamId).toBe('core-team')
  })
})

/**
 * Creates a canonical Team Issue fixture assigned to the shared Project.
 *
 * @param id - Team-local Issue ID.
 * @param teamId - Owning Team ID.
 * @returns A canonical Team Issue.
 */
function createIssue(id: string, teamId: string): TeamIssue {
  return {
    assignedProjectId: 'shared-project',
    assigneeUserId: 'member@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    creatorMemberKey: 'creator@example.com',
    customFieldValues: {},
    dueDate: '2026/07/31',
    id,
    priority: 'medium',
    relationIds: [],
    revision: 1,
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    source: 'dynamodb',
    statusCategory: 'unstarted',
    teamId,
    title: `${teamId} ${id}`,
    updatedAt: '2026-07-01T00:00:00.000Z',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
  }
}
