import { describe, expect, test } from 'bun:test'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
} from '../src/routes/paths'

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
})
