import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanonicalWorkItem, WorkItemSchedule } from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { IssueTable, TEAM_ISSUE_BASELINE_DELAY_COLUMN } from '../src/issues/ui/TeamIssueTable'
import { createTranslator } from '../src/shared/i18n/i18n'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import {
  collectWorkItemBaselineProjects,
  createWorkItemBaselineLookup,
  WORK_ITEM_BASELINE_PROJECT_LIMIT,
} from '../src/work-items/model/workItemScheduleBaselines'

const t = createTranslator('ja')
const [baseFixture] = teamIssueFixtures
if (!baseFixture) throw new Error('Expected a Team Issue fixture.')

/**
 * Builds a date-range schedule.
 *
 * @param startDate - Planned start.
 * @param endDate - Planned end.
 * @returns The schedule.
 */
function range(startDate: string, endDate: string): WorkItemSchedule {
  return {
    mode: 'date-range',
    calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], holidays: [] },
    startDate,
    endDate,
    durationDays: 5,
  }
}

/**
 * Builds a Work Item of Project `p` in Team `t`.
 *
 * @param id - Work Item ID.
 * @param overrides - Fields replacing the fixture's.
 * @returns The Work Item.
 */
function createItem(id: string, overrides: Partial<CanonicalWorkItem> = {}): CanonicalWorkItem {
  return {
    ...baseFixture,
    id,
    teamId: 't',
    title: `Title ${id}`,
    assignedProjectId: 'p',
    statusCategory: 'started',
    schedule: range('2026-12-01', '2026-12-08'),
    ...overrides,
  }
}

const lookup = createWorkItemBaselineLookup([
  {
    teamId: 't',
    projectId: 'p',
    baseline: {
      revision: 1,
      capturedAt: '2026-11-20T00:00:00.000Z',
      entries: [{ workItemId: 'late', startDate: '2026-12-01', endDate: '2026-12-05' }],
    },
  },
])

describe('schedule baseline overlay', () => {
  test('collects each Team-owned Project once, in a stable order, up to the limit', () => {
    expect(collectWorkItemBaselineProjects([
      { teamId: 't2', assignedProjectId: 'p' },
      { teamId: 't', assignedProjectId: 'p' },
      { teamId: 't', assignedProjectId: 'p' },
      { teamId: 't' },
    ])).toEqual([{ teamId: 't', projectId: 'p' }, { teamId: 't2', projectId: 'p' }])
    const many = Array.from({ length: WORK_ITEM_BASELINE_PROJECT_LIMIT + 5 }, (_, index) => ({
      teamId: 't',
      assignedProjectId: `p${index}`,
    }))
    expect(collectWorkItemBaselineProjects(many)).toHaveLength(WORK_ITEM_BASELINE_PROJECT_LIMIT)
  })

  test('finds an entry only in the baseline of the Work Item own Team and Project', () => {
    expect(lookup(createItem('late'))?.endDate).toBe('2026-12-05')
    expect(lookup(createItem('late', { teamId: 'other' }))).toBeUndefined()
    expect(lookup(createItem('late', { assignedProjectId: undefined }))).toBeUndefined()
    expect(lookup(createItem('new'))).toBeUndefined()
  })

  test('draws the baseline bar and the end delay on the Gantt chart', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={{}}
        scheduleBaselineFor={lookup}
        t={t}
        tasks={[createItem('late'), createItem('new')]}
      />,
    )
    expect(html).toContain('data-testid="task-gantt-baseline-bar-late"')
    expect(html).toContain('ベースライン: 2026-12-01 – 2026-12-05, ベースライン比: 3 日遅れ')
    expect(html).toMatch(/data-testid="task-gantt-baseline-delay-late"[^>]*>\+3d</)
    // A Work Item saved after the baseline has no bar and no delay.
    expect(html).not.toContain('task-gantt-baseline-bar-new')
    expect(html).not.toContain('task-gantt-baseline-delay-new')
  })

  test('keeps the Gantt chart unchanged without baselines', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={{}}
        t={t}
        tasks={[createItem('late')]}
      />,
    )
    expect(html).not.toContain('task-gantt-baseline')
    expect(html).toContain('height:124px')
  })

  test('measures a completed Work Item by its actual end in the Team table column', () => {
    const html = renderToStaticMarkup(
      <IssueTable
        configuration={teamWorkItemConfigurationFixture}
        dependencySummaries={{}}
        isAiOperationPending={false}
        issues={[
          createItem('late'),
          createItem('done', { id: 'late', key: 'DONE', statusCategory: 'completed', actualEndDate: '2026-12-04' }),
          createItem('new'),
        ]}
        locale="ja"
        presentation={{
          columns: [{ field: 'title' }, { field: TEAM_ISSUE_BASELINE_DELAY_COLUMN }],
          display: {
            showArchived: false,
            showAssigneeAvatars: false,
            showCompleted: true,
            showEmptyGroups: false,
            showSubtasks: true,
            wrapTitles: false,
          },
        }}
        scheduleBaselineFor={lookup}
        selectedIssueKeys={[]}
        t={t}
        workspaceMembers={[]}
      />,
    )
    expect(html).toContain('ベースライン比の遅れ')
    expect(html).toContain('3 日遅れ')
    expect(html).toContain('1 日前倒し')
    expect(html).toMatch(/data-testid="team-issue-baseline-delay-new"[^>]*>—</)
  })
})
