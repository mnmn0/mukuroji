import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { TeamIssueScreen } from '../src/pages/workspace/TeamIssuePage'
import { createBuiltInTaskViewDefinition } from '../src/task-views/model/taskViewSurfaceState'
import {
  teamWorkItemConfigurationFixture,
  workItemCustomFieldValueFixture,
} from '../src/work-items/fixtures'

describe('Team Issue task-view presentation', () => {
  test('renders selected columns, density, wrapping, primary groups, and subgroups', () => {
    const issues = teamIssueFixtures.slice(0, 2).map((issue, index) => ({
      ...issue,
      priority: index === 0 ? 'high' : 'low',
      statusCategory: 'started',
      workflowStatusId: index === 0 ? 'active' : 'review',
    }))
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={issues}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        taskViewPresentation={{
          columns: [
            { field: 'title', pin: 'start', width: 340 },
            { field: 'assignee', width: 180 },
            { field: 'priority', pin: 'end', width: 140 },
          ],
          density: 'compact',
          display: {
            showArchived: false,
            showAssigneeAvatars: true,
            showCompleted: true,
            showEmptyGroups: true,
            showSubtasks: true,
            wrapTitles: true,
          },
          groupBy: 'priority',
          subgroupBy: 'assignee',
        }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    expect(html).toContain('data-testid="team-issue-table-group"')
    expect(html).toContain('data-testid="team-issue-table-subgroup"')
    expect(html).toContain('whitespace-normal break-words')
    expect(html).toContain('py-2')
    expect(html).toContain('data-column-pin="start"')
    expect(html).toContain('data-column-pin="end"')
    expect(html).toContain('width:340px')
    expect(html).toContain('data-testid="work-item-assignee-avatar"')
    expect(html).not.toContain('2026-06-03')
  })

  test('renders board grouping as real card sections and hides disabled card metadata', () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={[{
          ...issue,
          priority: 'high',
          statusCategory: 'started',
          workflowStatusId: 'active',
        }]}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        taskViewPresentation={{
          columns: [{ field: 'title' }, { field: 'assignee' }],
          density: 'spacious',
          display: {
            showArchived: false,
            showAssigneeAvatars: true,
            showCompleted: true,
            showEmptyGroups: false,
            showSubtasks: true,
            wrapTitles: true,
          },
          groupBy: 'status',
          subgroupBy: 'priority',
        }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
        viewState={{
          definitionFilter: { category: 'all', customFieldId: '' },
          searchQuery: '',
          statusFilter: 'all',
          viewMode: 'board',
        }}
      />,
    )

    expect(html).toContain('高 (1)')
    expect(html).toContain('p-5')
    expect(html).toContain('whitespace-normal break-words')
    expect(html).toContain('data-testid="work-item-assignee-avatar"')
    expect(html).toContain('data-testid="team-issue-column-active"')
    expect(html).not.toContain('data-testid="team-issue-column-review"')
    expect(html).not.toContain('data-testid="team-issue-column-done"')
    expect(html).not.toContain(issue.dueDate)
  })

  test('renders Team custom-field summaries and individual saved-view columns', () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={[{
          ...issue,
          customFieldValues: workItemCustomFieldValueFixture,
        }]}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        taskViewPresentation={{
          columns: [
            { field: 'title' },
            { field: 'customFields' },
            { field: 'custom:risk-level' },
          ],
          density: 'comfortable',
          display: {
            showArchived: false,
            showAssigneeAvatars: true,
            showCompleted: true,
            showEmptyGroups: true,
            showSubtasks: true,
            wrapTitles: false,
          },
        }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    expect(html).toContain('Customer impact')
    expect(html).toContain('Risk level')
    expect(html).toContain('Moderate')
  })

  test('keeps Team display-label keyword matching under canonical task-view filtering', () => {
    const definition = {
      ...createBuiltInTaskViewDefinition(
        'team',
        { kind: 'team', teamId: 'core-team' },
        'table',
      ),
      filters: { keyword: 'Refero' },
    }
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={teamIssueFixtures}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        taskViewDefinition={definition}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    expect(html).toContain(teamIssueFixtures[0].title)
    expect(html).not.toContain(teamIssueFixtures[1].title)
  })
})
