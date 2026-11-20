import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createDefaultDueDateWorkItemSchedule,
  type CanonicalWorkItem,
  type WorkItemScheduleCalendarPolicy,
  type TeamWorkItemHierarchyNode,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { TeamIssueScreen } from '../src/issues/ui/TeamIssueScreen'
import { SearchResultCollection } from '../src/search/ui/SearchResultCollection'
import { readSearchWorkItemIdentity } from '../src/search/model/searchWbsNumbers'
import { createTaskGanttRows, listTaskGanttRowTasks } from '../src/tasks/model/taskGanttRows'
import {
  createDefaultDateRangeTaskSchedule,
  createWorkspaceTaskScheduleCalendarPolicy,
} from '../src/tasks/model/taskSchedule'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { TaskTableView } from '../src/tasks/ui/TaskTableView'
import { createTranslator } from '../src/shared/i18n/i18n'
import type { TaskViewPresentationSettings } from '../src/task-views/model/taskViewPresentation'
import {
  createMultiTeamWorkItemOutlineRows,
  createWorkItemOutlineKey,
  createWorkItemWbsNumberIndex,
} from '../src/work-items/model/workItemHierarchy'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { withHierarchyRevalidation } from '../src/work-items/mutations/hierarchyRevalidation'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'

const [baseFixture] = teamIssueFixtures
if (!baseFixture) throw new Error('Expected a Team Issue fixture.')

/**
 * Builds a Work Item due on a date.
 *
 * @param id - Work Item ID.
 * @param dueDate - Due date.
 * @param overrides - Fields replacing the fixture's.
 * @returns The Work Item.
 */
function createItem(id: string, dueDate: string, overrides: Partial<CanonicalWorkItem> = {}): CanonicalWorkItem {
  return {
    ...baseFixture,
    id,
    title: `Title ${id}`,
    dueDate,
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
    ...overrides,
  }
}

/**
 * Builds one hierarchy node.
 *
 * @param workItemId - Work Item ID.
 * @param parentWorkItemId - Parent ID, or `null` at the top.
 * @param depth - Readable depth.
 * @param wbsNumber - WBS number.
 * @param childWorkItemIds - Readable children.
 * @param rollupSpan - Descendants' date span, for a parent.
 * @returns The node.
 */
function createNode(
  workItemId: string,
  parentWorkItemId: string | null,
  depth: number,
  wbsNumber: string,
  childWorkItemIds: string[] = [],
  rollupSpan?: { startDate: string, endDate: string },
): TeamWorkItemHierarchyNode {
  return {
    workItemId,
    parentWorkItemId,
    depth,
    wbsNumber,
    hierarchyRank: 'i',
    childWorkItemIds,
    ...(rollupSpan
      ? {
          rollup: {
            childCount: childWorkItemIds.length,
            descendantCount: 2,
            statusCategoryCounts: { backlog: 0, unstarted: 2, started: 0, completed: 0, canceled: 0 },
            openDescendantCount: 2,
            plannedEffortMinutes: 0,
            estimatedDescendantCount: 0,
            remainingEffortMinutes: 0,
            ...rollupSpan,
          },
        }
      : {}),
  }
}

// Three levels in core-team: phase > deliverable > task; the task is due first.
const phase = createItem('phase', '2026-12-20', { assignedProjectId: 'refero' })
const deliverable = createItem('deliverable', '2026-12-15', { assignedProjectId: 'refero' })
const task = createItem('task', '2026-12-02', { assignedProjectId: 'other-project' })
const otherTeamItem = createItem('other-team-item', '2026-12-01', { teamId: 'growth-team' })
const coreNodes = [
  createNode('phase', null, 0, '1', ['deliverable'], { startDate: '2026-12-02', endDate: '2026-12-15' }),
  createNode('deliverable', 'phase', 1, '1.1', ['task'], { startDate: '2026-12-02', endDate: '2026-12-02' }),
  createNode('task', 'deliverable', 2, '1.1.1'),
]
const hierarchies = new Map([['core-team', coreNodes]])
const t = createTranslator('ja')

describe('cross-Team outline rows', () => {
  test('nests each Team by its hierarchy and keeps a Team without one flat', () => {
    const rows = createMultiTeamWorkItemOutlineRows(
      [task, otherTeamItem, deliverable, phase],
      hierarchies,
      new Set(),
    )

    expect(rows.map((row) => [row.item.id, row.depth, row.hasChildren])).toEqual([
      ['phase', 0, true],
      ['deliverable', 1, true],
      ['task', 2, false],
      ['other-team-item', 0, false],
    ])
  })

  test('hides the rows under a collapsed parent of the right Team', () => {
    const rows = createMultiTeamWorkItemOutlineRows(
      [task, deliverable, phase],
      hierarchies,
      new Set([createWorkItemOutlineKey('core-team', 'deliverable'), createWorkItemOutlineKey('growth-team', 'phase')]),
    )

    expect(rows.map((row) => [row.item.id, row.collapsed])).toEqual([
      ['phase', false],
      ['deliverable', true],
    ])
  })

  test('indexes WBS numbers by Team and Work Item', () => {
    const index = createWorkItemWbsNumberIndex(hierarchies)

    expect(index.get(createWorkItemOutlineKey('core-team', 'task'))).toBe('1.1.1')
    expect(index.get(createWorkItemOutlineKey('growth-team', 'task'))).toBeUndefined()
  })
})

describe('Gantt rows', () => {
  test('follow the schedule without an outline', () => {
    const rows = createTaskGanttRows([phase, deliverable, task])

    expect(rows.map((row) => row.kind === 'task' ? row.task.id : row.key)).toEqual(['task', 'deliverable', 'phase'])
  })

  test('follow the hierarchy within each group and count hidden rows in the group', () => {
    const rows = createTaskGanttRows([phase, deliverable, task], {
      outline: { hierarchies, collapsedKeys: new Set([createWorkItemOutlineKey('core-team', 'phase')]) },
      group: {
        direction: 'asc',
        resolve: (item) => ({ key: item.assignedProjectId ?? '', label: item.assignedProjectId ?? '—' }),
      },
    })

    expect(rows.map((row) => row.kind === 'group'
      ? `group:${row.label}:${row.count}`
      : `${row.task.id}:${row.outline?.depth}:${row.outline?.collapsed}`)).toEqual([
      // The task sits in another Project, so it is the top row of its own group.
      'group:other-project:1',
      'task:0:false',
      'group:refero:2',
      'phase:0:true',
    ])
  })

  test('list the shown Work Items in row order for keyboard navigation', () => {
    const tasks = listTaskGanttRowTasks([phase, deliverable, task], {
      outline: { hierarchies, collapsedKeys: new Set([createWorkItemOutlineKey('core-team', 'phase')]) },
      group: {
        direction: 'asc',
        resolve: (item) => ({ key: item.assignedProjectId ?? '', label: item.assignedProjectId ?? '—' }),
      },
    })

    // The deliverable is under the collapsed phase, so it is skipped.
    expect(tasks.map((item) => item.id)).toEqual(['task', 'phase'])
  })
})

describe('Gantt chart outline', () => {
  test('shows WBS numbers, collapse toggles, and a summary bar over the children', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
        outline={{ hierarchies, collapsedKeys: new Set(), onToggleCollapsed: () => undefined }}
        t={t}
        tasks={[task, deliverable, phase]}
      />,
    )

    expect(html.indexOf('task-gantt-wbs-phase')).toBeLessThan(html.indexOf('task-gantt-wbs-task'))
    expect(html).toContain('1.1.1</p>')
    expect(html).toContain('data-testid="task-gantt-outline-toggle-phase"')
    expect(html).not.toContain('task-gantt-outline-toggle-task"')
    expect(html).toContain('data-testid="task-gantt-summary-phase"')
    expect(html).toContain('子 Work Item の期間: 2026-12-02 – 2026-12-15')
    expect(html).not.toContain('task-gantt-summary-task"')
    expect(html).toContain('階層 3')
  })

  test('puts the rows under Project headings', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
        group={{
          direction: 'asc',
          resolve: (item) => ({ key: item.assignedProjectId ?? '', label: `Project ${item.assignedProjectId ?? '—'}` }),
        }}
        t={t}
        tasks={[task, deliverable, phase]}
      />,
    )

    expect(html).toContain('data-testid="task-gantt-group-other-project"')
    expect(html).toContain('Project refero')
    expect(html.indexOf('task-gantt-group-other-project')).toBeLessThan(html.indexOf('task-gantt-group-refero'))
  })
})

/**
 * Renders the Project table as an outline.
 *
 * @param tasks - Project Work Items in list order.
 * @param collapsedKeys - Outline keys of collapsed parents.
 * @returns The rendered markup.
 */
function renderProjectTableOutline(tasks: CanonicalWorkItem[], collapsedKeys: ReadonlySet<string> = new Set()) {
  return renderToStaticMarkup(
    <TaskTableView
      bulkProjectOptions={[]}
      bulkWorkspaceId=""
      configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
      locale="ja"
      onBulkOperationComplete={() => undefined}
      onSelectTask={() => undefined}
      onTaskSelectionChange={() => undefined}
      onVisibleTaskSelectionChange={() => undefined}
      outline={{
        rows: createMultiTeamWorkItemOutlineRows(tasks, hierarchies, collapsedKeys),
        onToggleCollapsed: () => undefined,
      }}
      personLabels={{}}
      projectId="refero"
      selectedBulkItems={[]}
      selectedTaskKeys={[]}
      t={t}
      tasks={tasks}
      visibleBulkItems={[]}
    />,
  )
}

describe('Project table outline', () => {
  test('nests the Project rows with WBS numbers and roll-ups', () => {
    const html = renderProjectTableOutline([task, deliverable, phase])

    expect(html.indexOf('task-row-phase"')).toBeLessThan(html.indexOf('task-row-task"'))
    expect(html).toContain('data-testid="task-row-wbs-deliverable"')
    expect(html).toContain('data-testid="task-outline-toggle-phase"')
    expect(html).toContain('padding-inline-start:2.5rem')
    expect(html).toContain('data-testid="work-item-hierarchy-rollup"')
  })

  test('numbers the rows a paste fills in the order shown, skipping collapsed children', () => {
    const html = renderProjectTableOutline(
      [otherTeamItem, task, deliverable, phase],
      new Set([createWorkItemOutlineKey('core-team', 'deliverable')]),
    )
    /** Reads the paste index of one rendered row. */
    const readRowIndex = (id: string) =>
      new RegExp(`data-row-index="(-?\\d+)"[^>]*data-testid="task-row-${id}"`, 'u').exec(html)?.[1]

    expect(html).not.toContain('task-row-task"')
    expect(readRowIndex('other-team-item')).toBe('0')
    expect(readRowIndex('phase')).toBe('1')
    expect(readRowIndex('deliverable')).toBe('2')
  })
})

/**
 * Builds Team presentation settings for the Gantt layout.
 *
 * @param overrides - Settings replacing the defaults.
 * @returns The presentation settings.
 */
function ganttPresentation(overrides: Partial<TaskViewPresentationSettings> = {}): TaskViewPresentationSettings {
  return {
    columns: [{ field: 'title' }],
    density: 'comfortable',
    display: {
      showArchived: false,
      showAssigneeAvatars: false,
      showCompleted: true,
      showEmptyGroups: true,
      showSubtasks: true,
      wrapTitles: false,
      showOutline: true,
    },
    ...overrides,
  }
}

describe('Team Issue Gantt', () => {
  test('shows the Team Work Items as an outlined Gantt chart grouped by Project', () => {
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issueOutline={{ nodes: coreNodes, onMove: async () => undefined }}
        issues={[task, deliverable, phase]}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        taskViewPresentation={ganttPresentation({ groupBy: 'project', groupDirection: 'asc' })}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
        viewState={{
          definitionFilter: { category: 'all', customFieldId: '' },
          searchQuery: '',
          statusFilter: 'all',
          viewMode: 'gantt',
          workItemTypeFilter: 'all',
        }}
      />,
    )

    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('ガント</button>')
    expect(html).toContain('data-testid="task-gantt-summary-phase"')
    expect(html).toContain('data-testid="task-gantt-group-')
    expect(html).not.toContain('data-testid="team-issue-table-group"')
  })
})

describe('My Tasks Gantt', () => {
  test('switches to an outlined Gantt chart across Teams', () => {
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
        ganttOutline={{ hierarchies, collapsedKeys: new Set(), onToggleCollapsed: () => undefined }}
        onViewModeChange={() => undefined}
        t={t}
        tasks={[otherTeamItem, task, deliverable, phase]}
        teams={projectDirectoryFixtures}
        viewMode="gantt"
      />,
    )

    expect(html).toContain('data-testid="my-tasks-view-gantt"')
    expect(html).not.toContain('data-testid="my-tasks-kanban"')
    expect(html).toContain('data-testid="task-gantt-summary-phase"')
    // Teams follow their earliest Work Item; the Team without a hierarchy stays flat.
    expect(html.indexOf('task-gantt-timeline-other-team-item')).toBeLessThan(html.indexOf('task-gantt-wbs-phase'))
    expect(html.indexOf('task-gantt-wbs-phase')).toBeLessThan(html.indexOf('task-gantt-wbs-task'))
    expect(html).not.toContain('task-gantt-wbs-other-team-item')
  })
})

describe('My Tasks Gantt working calendar', () => {
  test('shades the Workspace days off, including Japanese national holidays', () => {
    const task = createItem('holiday-week', '2026-11-27', {
      schedule: createDefaultDateRangeTaskSchedule('2026-11-16', '2026-11-27'),
    })
    const render = (workingCalendar?: WorkItemScheduleCalendarPolicy) => renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
        onViewModeChange={() => undefined}
        t={t}
        tasks={[task]}
        teams={projectDirectoryFixtures}
        viewMode="gantt"
        workingCalendar={workingCalendar}
      />,
    )

    const html = render(createWorkspaceTaskScheduleCalendarPolicy({
      ...DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
      publicHolidays: 'japan',
    }))
    const shaded = [...html.matchAll(/aria-label="(\d{4}-\d{2}-\d{2})"[^>]*data-non-working=""/g)]
      .map((match) => match[1])
    // 11/23 (勤労感謝の日) is a Monday holiday; the weekend is off and 11/24 is a working day.
    expect(shaded).toContain('2026-11-23')
    expect(shaded).toContain('2026-11-22')
    expect(shaded).not.toContain('2026-11-24')
    expect(render()).not.toContain('data-testid="task-gantt-non-working-day"')
  })
})

describe('Team Issue working calendar notice', () => {
  test('shows a retry when the Workspace working calendar could not be read', () => {
    const render = (message?: string) => renderToStaticMarkup(
      <TeamIssueScreen
        issues={[]}
        locale="ja"
        onRetryWorkingCalendar={() => undefined}
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
        workingCalendarErrorMessage={message}
      />,
    )

    const html = render(t('tasks.workspaceCalendar.error'))
    expect(html).toContain('data-testid="team-issue-workspace-calendar-error"')
    expect(html).toContain(t('tasks.workspaceCalendar.retry'))
    expect(render()).not.toContain('team-issue-workspace-calendar-error')
  })
})

describe('Search WBS numbers', () => {
  const result = {
    entityType: 'work-item',
    highlights: [],
    id: 'team/core-team/issue/task',
    teamId: 'core-team',
    title: 'Ship the task',
    url: '/teams/core-team/issues/task',
  } satisfies WorkspaceSearchResult

  test('read the Team and Work Item from the search identity', () => {
    expect(readSearchWorkItemIdentity(result)).toEqual({ teamId: 'core-team', workItemId: 'task' })
    expect(readSearchWorkItemIdentity({ ...result, id: 'team/core-team/issue/a/issue/b' }))
      .toEqual({ teamId: 'core-team', workItemId: 'a/issue/b' })
    expect(readSearchWorkItemIdentity({ ...result, entityType: 'project' })).toBeUndefined()
    expect(readSearchWorkItemIdentity({ ...result, teamId: 'growth-team' })).toBeUndefined()
  })

  test('show the WBS number before a Work Item title', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={{ columns: ['title'], mode: 'table', sort: [{ direction: 'desc', field: 'relevance' }] }}
        locale="ja"
        onNavigate={() => undefined}
        results={[result]}
        wbsNumbers={createWorkItemWbsNumberIndex(hierarchies)}
      />,
    )

    expect(html).toContain('data-testid="search-result-wbs"')
    expect(html).toContain('1.1.1</span>')
  })
})

describe('hierarchy revalidation after list refreshes', () => {
  test('re-reads the hierarchies on a refresh or a published list, not on an optimistic edit', async () => {
    const listCalls: unknown[] = []
    let hierarchyReads = 0
    const mutateList = withHierarchyRevalidation<CanonicalWorkItem[]>(
      async (data) => {
        listCalls.push(data)
        return undefined
      },
      async () => {
        hierarchyReads += 1
      },
    )

    await mutateList((current = []) => current, { revalidate: false })
    expect(hierarchyReads).toBe(0)
    await mutateList()
    expect(hierarchyReads).toBe(1)
    await mutateList([task], { revalidate: false })
    expect(hierarchyReads).toBe(2)
    expect(listCalls).toHaveLength(3)
  })
})
