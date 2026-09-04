import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORK_ITEM_TYPE, type WorkItemConfiguration } from '@mukuroji/contracts'
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

  test('gates Board movement and selected detail controls per qualified Work Item scope', () => {
    const writableIssue = teamIssueFixtures[0]
    const readOnlyIssue = teamIssueFixtures[1]
    if (!writableIssue || !readOnlyIssue) {
      throw new Error('Expected two Team Issue fixtures.')
    }
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        canMutateIssue={(issue) => issue.id === writableIssue.id}
        issues={[writableIssue, readOnlyIssue]}
        locale="ja"
        onSelectIssue={() => undefined}
        onUpdateIssue={async () => undefined}
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        selectedIssueId={readOnlyIssue.id}
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

    expect(html.match(/draggable="true"/g)?.length).toBe(1)
    expect(html.match(/draggable="false"/g)?.length).toBe(1)
    expect(html).toContain('<fieldset class="contents" disabled="">')
    expect(html).toContain('data-testid="team-issue-detail-pane"')
  })

  test('renders Team detail fields in the configured Work Item Type order', () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')
    const configuration = {
      ...teamWorkItemConfigurationFixture,
      workItemTypes: [{
        ...DEFAULT_WORK_ITEM_TYPE,
        defaultWorkflowId: teamWorkItemConfigurationFixture.workflow.id,
        detailSections: ['workflow', 'description', 'overview'],
      }],
    } satisfies WorkItemConfiguration
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={[issue]}
        locale="ja"
        onSelectIssue={() => undefined}
        onUpdateIssue={async () => undefined}
        resolvedConfiguration={{ configuration }}
        selectedIssueId={issue.id}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    const workflowIndex = html.indexOf('name="workflowStatusId"')
    const descriptionIndex = html.indexOf('name="description"')
    const titleIndex = html.indexOf('name="title"')
    expect(workflowIndex).toBeGreaterThanOrEqual(0)
    expect(descriptionIndex).toBeGreaterThan(workflowIndex)
    expect(titleIndex).toBeGreaterThan(descriptionIndex)

    const overviewlessConfiguration = {
      ...configuration,
      workItemTypes: [{
        ...configuration.workItemTypes[0]!,
        detailSections: ['workflow', 'description'],
      }],
    } satisfies WorkItemConfiguration
    const overviewlessHtml = renderToStaticMarkup(
      <TeamIssueScreen
        issues={[issue]}
        locale="ja"
        onSelectIssue={() => undefined}
        onUpdateIssue={async () => undefined}
        resolvedConfiguration={{ configuration: overviewlessConfiguration }}
        selectedIssueId={issue.id}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    expect(overviewlessHtml).toContain('data-testid="team-issue-detail-work-item-type"')
    expect(overviewlessHtml).toContain('name="workItemTypeId"')
  })

  test('keeps Team create destinations inside server-authorized Project scopes', () => {
    const team = projectDirectoryFixtures.find((candidate) => candidate.id === 'core-team')
    const writableProject = team?.projects.find((project) => project.id === 'refero')
    if (!writableProject) throw new Error('Expected the Refero Project fixture.')
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        canCreateUnassignedIssue={false}
        createIssueProjects={[writableProject]}
        defaultCreateIssueOpen
        locale="ja"
        onCreateIssue={async () => undefined}
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
      />,
    )

    expect(html).toContain('<option value="refero" selected="">Refero</option>')
    expect(html).not.toContain('<option value="">未アサイン</option>')
    expect(html).not.toContain('<option value="product-roadmap">')
  })

  test('keeps Board columns and create actions scoped to each Work Item Type', () => {
    const typeAwareConfiguration = {
      ...teamWorkItemConfigurationFixture,
      workflows: [{
        id: 'incident-workflow',
        name: 'Incident response',
        initialStatusId: 'active',
        statuses: [
          { id: 'active', name: 'Investigating', category: 'started', sortOrder: 0 },
          { id: 'done', name: 'Resolved', category: 'completed', sortOrder: 1 },
        ],
        transitions: [
          { fromStatusId: 'active', toStatusId: 'done' },
          { fromStatusId: 'done', toStatusId: 'active' },
        ],
      }],
      workItemTypes: [
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          defaultWorkflowId: teamWorkItemConfigurationFixture.workflow.id,
        },
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          id: 'incident',
          name: 'Incident',
          iconToken: 'alert',
          defaultWorkflowId: 'incident-workflow',
          sortOrder: 1,
        },
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          id: 'archived-incident',
          name: 'Archived Incident',
          iconToken: 'archive',
          defaultWorkflowId: 'incident-workflow',
          status: 'archived',
          sortOrder: 2,
        },
      ],
    } satisfies WorkItemConfiguration
    const defaultIssue = teamIssueFixtures[0]
    const incidentIssue = teamIssueFixtures[1]
    if (!defaultIssue || !incidentIssue) throw new Error('Expected two Team Issue fixtures.')

    const html = renderToStaticMarkup(
      <TeamIssueScreen
        initialViewMode="board"
        issues={[
          { ...defaultIssue, workflowStatusId: 'active', statusCategory: 'started' },
          {
            ...incidentIssue,
            id: 'incident-issue',
            statusCategory: 'started',
            workItemTypeId: 'incident',
            workflowStatusId: 'active',
          },
        ]}
        locale="ja"
        onCreateIssue={async () => undefined}
        resolvedConfiguration={{ configuration: typeAwareConfiguration }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
        viewState={{
          definitionFilter: { category: 'all', customFieldId: '' },
          searchQuery: '',
          statusFilter: 'all',
          viewMode: 'board',
          workItemTypeFilter: 'all',
        }}
      />,
    )

    expect(html).toContain('data-testid="team-issue-column-active"')
    expect(html).toContain('data-testid="team-issue-column-incident-active"')
    expect(html).toContain('Incident')
    expect(html).toContain('data-testid="team-issue-add-active"')
    expect(html).toContain('data-testid="team-issue-add-incident-active"')
    expect(html).toContain('data-testid="team-issue-column-archived-incident-active"')
    expect(html).not.toContain('data-testid="team-issue-add-archived-incident-active"')
  })
})
