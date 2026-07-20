import { describe, expect, test } from 'bun:test'
import { matchRoutes } from 'react-router'
import {
  createPlanningPath,
  createPublicRequestPath,
  createProjectIssuesPath,
  createRequestsPath,
  createTeamIssuesPath,
  createWorkItemSearchPath,
} from '../src/routes/paths'
import { appRoutes } from '../src/routes/router'

describe('Work Item detail paths', () => {
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
