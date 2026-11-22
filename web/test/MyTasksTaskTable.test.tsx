import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  createBuiltInTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
} from '../src/task-views/model/taskViewSurfaceState'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import {
  createMyTasksTableSections,
  listMyTasksTableRowTasks,
  resolveMyTasksTableColumns,
} from '../src/workspace/model/myTaskTable'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'

const [baseFixture] = teamIssueFixtures
if (!baseFixture) throw new Error('Expected a Team Issue fixture.')

const t = createTranslator('ja')
const configurationsByTeam = { 'core-team': { configuration: teamWorkItemConfigurationFixture } }
const builtInPresentation = taskViewDefinitionToPresentationSettings(
  createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'table'),
)

/**
 * Builds a Work Item due on a date.
 *
 * @param id - Work Item ID.
 * @param dueDate - Due date.
 * @param priority - Priority of the Work Item.
 * @returns The Work Item.
 */
function createItem(
  id: string,
  dueDate: string,
  priority: CanonicalWorkItem['priority'] = 'medium',
): CanonicalWorkItem {
  return {
    ...baseFixture,
    id,
    title: `Title ${id}`,
    dueDate,
    priority,
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
  }
}

describe('My Tasks table', () => {
  test('lists the personal Work Items in the given order with their due dates', () => {
    const early = createItem('early', '2026-03-02', 'high')
    const late = createItem('late', '2026-03-20', 'low')
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={configurationsByTeam}
        onOpenTask={() => undefined}
        onTaskActionMenuOpen={() => undefined}
        onViewModeChange={() => undefined}
        presentation={builtInPresentation}
        t={t}
        tasks={[early, late]}
        teams={projectDirectoryFixtures}
        viewMode="table"
      />,
    )

    expect(html).toContain('data-testid="my-tasks-view-table"')
    expect(html).toContain('data-testid="my-tasks-table"')
    expect(html).not.toContain('data-testid="my-tasks-kanban"')
    expect(html.indexOf('my-tasks-table-row-refero-early'))
      .toBeLessThan(html.indexOf('my-tasks-table-row-refero-late'))
    expect(html).toContain('2026-03-02')
    expect(html).toContain('data-testid="my-tasks-table-open-refero-early"')
    expect(html).toContain('data-testid="my-tasks-table-actions-refero-early"')
    expect(html).toContain('data-testid="my-tasks-table-due-refero-early"')
  })

  test('shows an empty state without rows', () => {
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={configurationsByTeam}
        t={t}
        tasks={[]}
        teams={projectDirectoryFixtures}
        viewMode="table"
      />,
    )

    expect(html).toContain('data-testid="my-tasks-table-empty"')
  })

  test('keeps the title first and drops columns the table cannot show', () => {
    expect(resolveMyTasksTableColumns({
      ...builtInPresentation,
      columns: [{ field: 'priority' }, { field: 'estimate' }, { field: 'title' }, { field: 'custom:size' }],
    })).toEqual(['title', 'priority', 'custom:size'])
  })

  test('orders keyboard targets by the shown groups', () => {
    const highLate = createItem('high-late', '2026-03-20', 'high')
    const lowEarly = createItem('low-early', '2026-03-02', 'low')
    const highEarly = createItem('high-early', '2026-03-01', 'high')
    const unscheduled = {
      ...createItem('unscheduled', '2026-03-05', 'low'),
      dueDate: undefined,
      schedule: createDefaultUnscheduledWorkItemSchedule(),
    }
    const sections = createMyTasksTableSections(
      [highEarly, lowEarly, unscheduled, highLate],
      { ...builtInPresentation, groupBy: 'priority', groupDirection: 'asc' },
      configurationsByTeam,
      projectDirectoryFixtures,
      t,
    )

    expect(sections.map((section) => section.heading?.count)).toEqual([2, 2])
    expect(listMyTasksTableRowTasks(sections).map((task) => task.id))
      .toEqual(sections.flatMap((section) => section.items.map((task) => task.id)))
    expect(new Set(sections[0]?.items.map((task) => task.priority)).size).toBe(1)
  })
})
