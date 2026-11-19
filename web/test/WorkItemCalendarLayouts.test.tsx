import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createDefaultDueDateWorkItemSchedule,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { TeamIssueScreen } from '../src/issues/ui/TeamIssueScreen'
import { createTranslator } from '../src/shared/i18n/i18n'
import { getCurrentTaskDate } from '../src/tasks/model/taskScheduleWindow'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'

const [baseFixture] = teamIssueFixtures
if (!baseFixture) throw new Error('Expected a Team Issue fixture.')

const t = createTranslator('ja')
// The calendars open on the current month, so the Work Item is due today.
const today = getCurrentTaskDate()

/**
 * Builds a Work Item due on a date.
 *
 * @param id - Work Item ID.
 * @param dueDate - Due date.
 * @returns The Work Item.
 */
function createItem(id: string, dueDate: string): CanonicalWorkItem {
  return {
    ...baseFixture,
    id,
    title: `Title ${id}`,
    dueDate,
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
  }
}

const dueToday = createItem('due-today', today)

describe('Team Issue calendar', () => {
  test('shows the Team Work Items on a monthly calendar', () => {
    const html = renderToStaticMarkup(
      <TeamIssueScreen
        issues={[dueToday]}
        locale="ja"
        resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
        teamId="core-team"
        teams={projectDirectoryFixtures}
        userInitial="J"
        viewState={{
          definitionFilter: { category: 'all', customFieldId: '' },
          searchQuery: '',
          statusFilter: 'all',
          viewMode: 'calendar',
          workItemTypeFilter: 'all',
        }}
      />,
    )

    expect(html).toContain('カレンダー</button>')
    expect(html).toContain('data-testid="task-calendar-month-navigation"')
    expect(html).toContain(`data-testid="task-calendar-day-${today}"`)
    expect(html).toContain('data-testid="task-calendar-item-due-today"')
    expect(html).not.toContain('data-testid="team-issue-table-group"')
  })
})

describe('My Tasks calendar', () => {
  test('switches the personal Work Items to a monthly calendar', () => {
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={{ 'core-team': { configuration: teamWorkItemConfigurationFixture } }}
        onViewModeChange={() => undefined}
        t={t}
        tasks={[dueToday]}
        teams={projectDirectoryFixtures}
        viewMode="calendar"
      />,
    )

    expect(html).toContain('data-testid="my-tasks-view-calendar"')
    expect(html).not.toContain('data-testid="my-tasks-kanban"')
    expect(html).toContain('data-testid="task-calendar-month-navigation"')
    expect(html).toContain('data-testid="task-calendar-item-due-today"')
  })
})
