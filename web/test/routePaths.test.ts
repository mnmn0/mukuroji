import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import { matchRoutes, type RouteObject } from 'react-router'
import { DashboardPage } from '../src/pages/workspace/DashboardPage'
import { EnterpriseSecurityPage } from '../src/pages/workspace/EnterpriseSecurityPage'
import { GoalDocumentsPage } from '../src/pages/workspace/GoalDocumentsPage'
import { HelpPage } from '../src/pages/workspace/HelpPage'
import { HomePage } from '../src/pages/workspace/HomePage'
import { FocusPage } from '../src/pages/workspace/FocusPage'
import { InboxPage } from '../src/pages/workspace/InboxPage'
import { MyTasksPage } from '../src/pages/workspace/MyTasksPage'
import { PlanningPage } from '../src/pages/workspace/PlanningPage'
import { resolvePlanningProjectNavigationPath } from '../src/planning/model/navigation'
import { ProjectsPage } from '../src/pages/workspace/ProjectsPage'
import { ReportsPage } from '../src/pages/workspace/ReportsPage'
import { SettingsPage } from '../src/pages/workspace/SettingsPage'
import { TaskPage } from '../src/pages/workspace/TaskPage'
import { TeamMembersPage } from '../src/pages/workspace/TeamMembersPage'
import { TeamIssuePage } from '../src/pages/workspace/TeamIssuePage'
import { TeamOverviewPage } from '../src/pages/workspace/TeamOverviewPage'
import { DocumentPage } from '../src/documents/DocumentPage'
import { RequestIntakePage } from '../src/requests/RequestIntakePage'
import { SearchPage } from '../src/search/SearchPage'
import {
  createFocusPath,
  createPlanningPath,
  createProjectsPath,
  createQuickAccessProjectsPath,
  createPublicRequestPath,
  createProjectIssuesPath,
  createRequestsPath,
  createTeamIssuesPath,
  createWorkItemSearchPath,
} from '../src/shared/routing/paths'
import { appRoutes } from '../src/app/router'
import { WorkspaceRoute } from '../src/workspace/ui/WorkspaceRoute'
import { WorkspaceRouteProvider } from '../src/workspace/ui/WorkspaceRouteProvider'

/** A route path and the page component expected at the end of its match. */
type WorkspaceRouteDefinition = {
  /** Page component expected to render for the route. */
  component: unknown
  /** URL path used to resolve the route. */
  path: string
}

/**
 * Asserts that every supplied path renders through one shared Workspace shell.
 *
 * @param workspaceRoutes - Route/component pairs to verify.
 * @returns Nothing; throws through the test assertions when a mapping is invalid.
 */
function expectSharedWorkspaceShell(
  workspaceRoutes: readonly WorkspaceRouteDefinition[],
) {
  const shellRoutes = new Set<RouteObject>()

  for (const { component, path } of workspaceRoutes) {
    const matches = matchRoutes(appRoutes, path)
    const providerMatch = matches?.find((match) =>
      isValidElement(match.route.element) &&
      match.route.element.type === WorkspaceRouteProvider
    )
    const shellMatch = matches?.find((match) =>
      isValidElement(match.route.element) &&
      match.route.element.type === WorkspaceRoute
    )
    const pageElement = matches?.at(-1)?.route.element

    expect(providerMatch).toBeDefined()
    expect(shellMatch).toBeDefined()
    expect(isValidElement(pageElement)).toBe(true)

    if (!shellMatch || !isValidElement(pageElement)) {
      throw new Error(`Expected ${path} to render through the Workspace shell.`)
    }

    shellRoutes.add(shellMatch.route)
    expect(pageElement.type).toBe(component)
  }

  expect(shellRoutes.size).toBe(1)
}

describe('Work Item detail paths', () => {
  test('cross-links one notification event to a selected Focus Work Item', () => {
    expect(createFocusPath('core/team', 'issue/42', 'event/9')).toBe(
      '/focus?teamId=core%2Fteam&workItemId=issue%2F42&sourceEventId=event%2F9',
    )
    expect(createFocusPath()).toBe('/focus')
  })

  test('keeps assigned Work Items scoped by project, team, and issue', () => {
    expect(createProjectIssuesPath('shared launch', 'design/team', 'issue/1')).toBe(
      '/projects/shared%20launch/issues?teamId=design%2Fteam&issueId=issue%2F1',
    )
  })

  test('opens unassigned Work Items from the owning Team issue view', () => {
    expect(createTeamIssuesPath('core/team', 'unassigned issue')).toBe(
      '/teams/core%2Fteam/issues?issueId=unassigned+issue',
    )
    expect(createTeamIssuesPath('core/team')).toBe('/teams/core%2Fteam/issues')
  })

  test('keeps a notification comment focus inside the selected Work Item', () => {
    expect(createProjectIssuesPath('project', 'team', 'issue', 'comment/1', 'root/1')).toBe(
      '/projects/project/issues?teamId=team&issueId=issue&commentId=comment%2F1&rootCommentId=root%2F1',
    )
    expect(createTeamIssuesPath('team', 'issue', 'comment/1', 'root/1')).toBe(
      '/teams/team/issues?issueId=issue&commentId=comment%2F1&rootCommentId=root%2F1',
    )
  })

  test('routes an unscoped Work Item link through real workspace search', () => {
    expect(createWorkItemSearchPath('issue/42')).toBe(
      '/search?q=issue%2F42&type=work-item',
    )
  })

  test('opens a canonical Work Item relation at its direct Team route', () => {
    expect(
      createWorkItemSearchPath(
        'team/core-team/issue/issue-42',
      ),
    ).toBe(
      '/teams/core-team/issues?issueId=issue-42',
    )
  })
})

describe('Planning paths', () => {
  test('keeps the selected view and optional entity in a canonical URL', () => {
    expect(createPlanningPath('timeline')).toBe('/planning/timeline')
    expect(createPlanningPath('roadmap', 'goal/launch')).toBe(
      '/planning/roadmap?entityId=goal%2Flaunch',
    )
  })

  test('matches only supported Planning views and sends invalid views to Not Found', () => {
    for (const view of ['timeline', 'roadmap', 'portfolio'] as const) {
      expect(matchRoutes(appRoutes, `/planning/${view}`)?.at(-1)?.route.path).toBe(
        `/planning/${view}`,
      )
    }

    expect(matchRoutes(appRoutes, '/planning/invalid')?.at(-1)?.route.path).toBe('*')
  })

  test('opens only uniquely owned Projects directly from Planning', () => {
    const teams = [
      {
        id: 'core/team',
        name: 'Core team',
        projects: [
          { id: 'unique/project', name: 'Unique Project' },
          { id: 'shared project', name: 'Shared Project' },
        ],
      },
      {
        id: 'design-team',
        name: 'Design team',
        projects: [{ id: 'shared project', name: 'Shared Project' }],
      },
    ]

    expect(resolvePlanningProjectNavigationPath(teams, 'unique/project')).toBe(
      '/projects/unique%2Fproject/tasks?teamId=core%2Fteam',
    )
    expect(resolvePlanningProjectNavigationPath(teams, 'shared project')).toBe(
      '/search?q=shared+project&type=project',
    )
    expect(resolvePlanningProjectNavigationPath(teams, 'missing-project')).toBe(
      '/search?q=missing-project&type=project',
    )
  })
})

describe('Project directory paths', () => {
  test('creates global and Team-scoped discovery URLs', () => {
    expect(createProjectsPath()).toBe('/projects')
    expect(createProjectsPath('design/team')).toBe('/teams/design%2Fteam/projects')
    expect(createQuickAccessProjectsPath()).toBe('/projects?quickAccess=1')
  })

  test('registers both discovery routes inside the shared Workspace shell', () => {
    expectSharedWorkspaceShell([
      { component: ProjectsPage, path: '/projects' },
      { component: ProjectsPage, path: '/teams/core-team/projects' },
    ])
  })
})

describe('Request intake paths', () => {
  test('keeps queue and form selections in encoded URL state', () => {
    expect(createRequestsPath()).toBe('/requests')
    expect(createRequestsPath('queue', 'request/1')).toBe(
      '/requests?submissionId=request%2F1',
    )
    expect(createRequestsPath('forms', 'form/1')).toBe(
      '/requests?view=forms&formId=form%2F1',
    )
    expect(createPublicRequestPath('opaque/token')).toBe('/request/opaque%2Ftoken')
  })

  test('registers both management and public request routes', () => {
    expect(matchRoutes(appRoutes, '/requests')?.at(-1)?.route.path).toBe('/requests')
    expect(matchRoutes(appRoutes, '/request/opaque-token')?.at(-1)?.route.path).toBe(
      '/request/:linkToken',
    )
  })
})

describe('Workspace route pages', () => {
  test('maps each split URL through one persistent shell to its direct page', () => {
    expectSharedWorkspaceShell([
      { component: DashboardPage, path: '/dashboard' },
      { component: HomePage, path: '/home' },
      { component: FocusPage, path: '/focus' },
      { component: MyTasksPage, path: '/my-tasks' },
      { component: InboxPage, path: '/inbox' },
      { component: HelpPage, path: '/help' },
      { component: SettingsPage, path: '/settings' },
      { component: EnterpriseSecurityPage, path: '/settings/security' },
      { component: TeamOverviewPage, path: '/teams/core-team/overview' },
      { component: TeamMembersPage, path: '/teams/core-team/members' },
    ])
  })

  test('maps every authenticated workspace screen through the same persistent shell', () => {
    expectSharedWorkspaceShell([
      { component: RequestIntakePage, path: '/requests' },
      { component: SearchPage, path: '/search' },
      { component: PlanningPage, path: '/planning/timeline' },
      { component: DocumentPage, path: '/documents' },
      { component: GoalDocumentsPage, path: '/goals/goal-1/documents' },
      { component: ReportsPage, path: '/reports' },
      { component: TeamIssuePage, path: '/teams/core-team/issues' },
      {
        component: TaskPage,
        path: '/projects/refero/issues?teamId=core-team',
      },
    ])
  })
})

describe('Enterprise security path', () => {
  test('registers the dedicated security management route', () => {
    expect(
      matchRoutes(appRoutes, '/settings/security')?.at(-1)?.route.path,
    ).toBe('/settings/security')
  })

  test('registers the enterprise SSO callback outside authenticated layouts', () => {
    expect(
      matchRoutes(appRoutes, '/auth/sso/callback')?.at(-1)?.route.path,
    ).toBe('/auth/sso/callback')
  })

  test('registers an explicit login path for step-up return links', () => {
    expect(
      matchRoutes(appRoutes, '/login?returnTo=%2Fsettings%2Fsecurity')
        ?.at(-1)?.route.path,
    ).toBe('/login')
  })

  test('registers recovery access outside permission-gated Workspace layouts', () => {
    expect(
      matchRoutes(appRoutes, '/security/recovery')?.at(-1)?.route.path,
    ).toBe('/security/recovery')
  })
})

describe('Analytics report path', () => {
  test('registers the dedicated reports route', () => {
    expect(matchRoutes(appRoutes, '/reports')?.at(-1)?.route.path).toBe('/reports')
  })
})
