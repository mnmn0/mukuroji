import { describe, expect, test } from 'bun:test'
import {
  createCrossProjectWorkItemBuiltInDefinition,
  crossProjectWorkItemStateToTaskViewDefinition,
  readLegacyCrossProjectWorkItemState,
  removeLegacyCrossProjectWorkItemParams,
  taskViewDefinitionToCrossProjectWorkItemState,
} from '../src/features/cross-project-work-items/model/crossProjectWorkItemTaskView'
import {
  defaultCrossProjectWorkItemListState,
  filterCrossProjectWorkItems,
  type CrossProjectWorkItemListState,
} from '../src/features/cross-project-work-items/model/crossProjectWorkItems'

describe('cross-Project Work Item task view', () => {
  test('starts from open Work Items grouped by Project in a table', () => {
    const builtIn = createCrossProjectWorkItemBuiltInDefinition()
    expect(builtIn).toMatchObject({
      surface: 'work-items',
      scope: { kind: 'workspace' },
      filters: {},
      layout: { mode: 'table', group: { field: 'project' }, displayOptions: { showCompleted: false } },
    })
    expect(taskViewDefinitionToCrossProjectWorkItemState(builtIn)).toEqual(
      defaultCrossProjectWorkItemListState,
    )
  })

  test('round-trips every list setting through the saved definition', () => {
    const state: CrossProjectWorkItemListState = {
      projects: [
        { teamId: 'core-team', projectId: 'refero' },
        { teamId: 'design-team', projectId: 'brand-refresh' },
      ],
      openOnly: false,
      mine: true,
      contributorMemberId: 'demo@example.com',
      contributorJobRole: { teamId: 'core-team', jobRoleId: 'designer' },
      grouping: 'assignee',
      layout: 'gantt',
    }
    const definition = crossProjectWorkItemStateToTaskViewDefinition(
      state,
      createCrossProjectWorkItemBuiltInDefinition(),
    )
    expect(definition.filters).toEqual({
      projectScopes: state.projects,
      involvement: 'mine',
      contributorUserIds: ['demo@example.com'],
      contributorJobRoles: [{ teamId: 'core-team', jobRoleId: 'designer' }],
    })
    expect(taskViewDefinitionToCrossProjectWorkItemState(definition)).toEqual(state)
  })

  test('shows nothing when a saved view chose only Projects the viewer cannot read', () => {
    const builtIn = createCrossProjectWorkItemBuiltInDefinition()
    // The server keeps the emptied list after removing the Projects this viewer cannot read.
    const redacted = { ...builtIn, filters: { projectScopes: [] } }
    const state = taskViewDefinitionToCrossProjectWorkItemState(redacted)
    expect(state).toMatchObject({ projects: [], projectsUnavailable: true })
    expect(filterCrossProjectWorkItems([], state, [])).toEqual([])
    // Changing another setting keeps the Project condition instead of widening it.
    const changed = crossProjectWorkItemStateToTaskViewDefinition({ ...state, layout: 'board' }, redacted)
    expect(changed.filters.projectScopes).toEqual([])
    // Picking Projects again, or clearing them, replaces it.
    const cleared = crossProjectWorkItemStateToTaskViewDefinition(
      { ...state, projectsUnavailable: false },
      redacted,
    )
    expect(cleared.filters.projectScopes).toBeUndefined()
  })

  test('keeps filters that the list does not edit', () => {
    const builtIn = createCrossProjectWorkItemBuiltInDefinition()
    const base = { ...builtIn, filters: { priorities: ['high' as const], involvement: 'mine' as const } }
    const next = crossProjectWorkItemStateToTaskViewDefinition(
      { ...defaultCrossProjectWorkItemListState, layout: 'board' },
      base,
    )
    expect(next.filters).toEqual({ priorities: ['high'] })
  })

  test('falls back to the table for a layout the list does not render', () => {
    const builtIn = createCrossProjectWorkItemBuiltInDefinition()
    expect(taskViewDefinitionToCrossProjectWorkItemState({
      ...builtIn,
      layout: { ...builtIn.layout, mode: 'calendar' },
    }).layout).toBe('table')
  })

  test('reads older list links and drops their parameters', () => {
    expect(readLegacyCrossProjectWorkItemState(new URLSearchParams('view=abc'))).toBeUndefined()
    const params = new URLSearchParams('layout=board&group=assignee&view=abc&task=CORE-1')
    expect(readLegacyCrossProjectWorkItemState(params)).toMatchObject({
      layout: 'board',
      grouping: 'assignee',
    })
    expect(removeLegacyCrossProjectWorkItemParams(params).toString()).toBe('view=abc&task=CORE-1')
  })
})
