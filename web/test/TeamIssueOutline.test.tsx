import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TeamWorkItemHierarchyNode } from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { TeamIssueScreen } from '../src/issues/ui/TeamIssueScreen'
import type { TaskViewPresentationSettings } from '../src/task-views/model/taskViewPresentation'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const [parentFixture, childFixture] = teamIssueFixtures
if (!parentFixture || !childFixture) throw new Error('Expected two Team Issue fixtures.')

/** Hierarchy where the second fixture is the only child of the first. */
const nodes: TeamWorkItemHierarchyNode[] = [
  {
    workItemId: parentFixture.id,
    parentWorkItemId: null,
    depth: 0,
    wbsNumber: '1',
    hierarchyRank: 'b',
    childWorkItemIds: [childFixture.id],
    rollup: {
      childCount: 1,
      descendantCount: 1,
      statusCategoryCounts: { backlog: 0, unstarted: 0, started: 1, completed: 0, canceled: 0 },
      openDescendantCount: 1,
      plannedEffortMinutes: 90,
      estimatedDescendantCount: 1,
      remainingEffortMinutes: 90,
      startDate: '2026-12-01',
      endDate: '2026-12-10',
    },
  },
  {
    workItemId: childFixture.id,
    parentWorkItemId: parentFixture.id,
    depth: 1,
    wbsNumber: '1.1',
    hierarchyRank: 'b',
    childWorkItemIds: [],
  },
]

/**
 * Builds table presentation settings with the outline turned on.
 *
 * @param overrides - Settings replacing the defaults.
 * @returns The presentation settings.
 */
function outlinePresentation(overrides: Partial<TaskViewPresentationSettings> = {}): TaskViewPresentationSettings {
  return {
    columns: [{ field: 'title' }, { field: 'status' }],
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

/**
 * Renders the Team screen with the child listed before its parent.
 *
 * @param presentation - Table presentation settings.
 * @param errorMessage - Hierarchy read failure, when any.
 * @returns Static markup of the screen.
 */
function renderOutline(presentation: TaskViewPresentationSettings, errorMessage?: string) {
  return renderToStaticMarkup(
    <TeamIssueScreen
      issueOutline={errorMessage ? { errorMessage } : { nodes, onMove: async () => undefined }}
      issues={[childFixture, parentFixture]}
      locale="ja"
      resolvedConfiguration={{ configuration: teamWorkItemConfigurationFixture }}
      taskViewPresentation={presentation}
      teamId="core-team"
      teams={projectDirectoryFixtures}
      userInitial="J"
    />,
  )
}

describe('Team Issue outline', () => {
  test('nests rows in hierarchy order with WBS numbers, a collapse toggle, and roll-ups', () => {
    const html = renderOutline(outlinePresentation())

    expect(html.indexOf(`issue-row-${parentFixture.id}"`)).toBeLessThan(html.indexOf(`issue-row-${childFixture.id}"`))
    expect(html).toContain(`data-testid="issue-row-wbs-${childFixture.id}"`)
    expect(html).toContain('1.1</span>')
    expect(html).toContain(`data-testid="issue-outline-toggle-${parentFixture.id}"`)
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain(`issue-outline-toggle-${childFixture.id}`)
    expect(html).toContain('padding-inline-start:1.25rem')
    expect(html).toContain('階層 2')
    expect(html).toContain('aria-keyshortcuts="Alt+Shift+ArrowRight')
    expect(html).toContain('data-testid="work-item-hierarchy-rollup"')
    expect(html).toContain('完了 0/1')
    expect(html).toContain('見積 1.5 時間')
  })

  test('keeps groups instead of the outline when the view is grouped', () => {
    const html = renderOutline(outlinePresentation({ groupBy: 'status' }))

    expect(html).toContain('data-testid="team-issue-table-group"')
    expect(html).not.toContain('issue-row-wbs-')
  })

  test('explains when the hierarchy could not be read', () => {
    const html = renderOutline(outlinePresentation(), '階層を読み込めませんでした。')

    expect(html).toContain('data-testid="team-issue-outline-unavailable"')
    expect(html).not.toContain('issue-row-wbs-')
  })
})
