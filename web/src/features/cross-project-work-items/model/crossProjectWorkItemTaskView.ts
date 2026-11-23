import type {
  TaskViewDefinition,
  TaskViewFilters,
  TaskViewLayoutMode,
  TaskViewScope,
} from '@mukuroji/contracts'
import {
  crossProjectWorkItemLayouts,
  defaultCrossProjectWorkItemListState,
  parseCrossProjectWorkItemListState,
  type CrossProjectWorkItemLayout,
  type CrossProjectWorkItemListState,
} from './crossProjectWorkItems'

/** Resource scope of every saved view on the cross-Project Work Item list. */
export const crossProjectWorkItemTaskViewScope: TaskViewScope = { kind: 'workspace' }

/** Layout modes the cross-Project Work Item list renders. */
export const crossProjectWorkItemTaskViewLayoutModes: readonly TaskViewLayoutMode[] =
  crossProjectWorkItemLayouts

/** Fields that the cross-Project list can group by, plus the one column a definition keeps. */
export const crossProjectWorkItemTaskViewFields: readonly string[] = ['title', 'project', 'assignee']

/**
 * Query parameters of the list before views were saved on the server. A link that still carries
 * them is converted into a temporary change of the current view, and the parameters are dropped.
 */
const legacyQueryParameters = ['project', 'status', 'mine', 'member', 'role', 'group', 'layout']

/**
 * Creates the built-in view of the list: every readable Project, open Work Items only, grouped by
 * Project in a table.
 *
 * @returns The built-in task view definition of the `work-items` surface.
 */
export function createCrossProjectWorkItemBuiltInDefinition(): TaskViewDefinition {
  return crossProjectWorkItemStateToTaskViewDefinition(defaultCrossProjectWorkItemListState, {
    surface: 'work-items',
    scope: crossProjectWorkItemTaskViewScope,
    filters: {},
    layout: {
      mode: 'table',
      sort: [],
      columns: [{ field: 'title' }],
      density: 'comfortable',
      displayOptions: {},
    },
  })
}

/**
 * Reads the list state from a saved or temporary task view definition.
 *
 * The server accepts at most one contributor and one job role on this surface, matching the list.
 *
 * @param definition - Effective definition after the viewer's permissions were applied.
 * @returns The list state that drives the filters, grouping, and layout.
 */
export function taskViewDefinitionToCrossProjectWorkItemState(
  definition: TaskViewDefinition,
): CrossProjectWorkItemListState {
  const { filters, layout } = definition
  const contributorMemberId = filters.contributorUserIds?.[0]
  const contributorJobRole = filters.contributorJobRoles?.[0]
  return {
    projects: (filters.projectScopes ?? []).map(({ teamId, projectId }) => ({ teamId, projectId })),
    // The server removes Projects the viewer cannot read and keeps the emptied list, which is not
    // the same as a view without a Project condition.
    ...(filters.projectScopes?.length === 0 ? { projectsUnavailable: true } : {}),
    openOnly: layout.displayOptions.showCompleted !== true,
    mine: filters.involvement === 'mine',
    ...(contributorMemberId ? { contributorMemberId } : {}),
    ...(contributorJobRole
      ? { contributorJobRole: { teamId: contributorJobRole.teamId, jobRoleId: contributorJobRole.jobRoleId } }
      : {}),
    grouping: layout.group?.field === 'assignee' ? 'assignee' : 'project',
    layout: toCrossProjectWorkItemLayout(layout.mode),
  }
}

/**
 * Writes the list state into a task view definition, keeping the parts the list does not edit.
 *
 * @param state - Next list state.
 * @param base - Current effective definition whose other settings are kept.
 * @returns The definition to layer over the selected view.
 */
export function crossProjectWorkItemStateToTaskViewDefinition(
  state: CrossProjectWorkItemListState,
  base: TaskViewDefinition,
): TaskViewDefinition {
  // The list owns these four filters. Any other filter of the definition is kept as it is.
  const {
    projectScopes: _projectScopes,
    involvement: _involvement,
    contributorUserIds: _contributorUserIds,
    contributorJobRoles: _contributorJobRoles,
    ...otherFilters
  } = base.filters
  const filters: TaskViewFilters = {
    ...otherFilters,
    ...(state.projects.length > 0
      ? { projectScopes: state.projects.map(({ teamId, projectId }) => ({ teamId, projectId })) }
      : state.projectsUnavailable
        ? { projectScopes: [] }
        : {}),
    ...(state.mine ? { involvement: 'mine' as const } : {}),
    ...(state.contributorMemberId ? { contributorUserIds: [state.contributorMemberId] } : {}),
    ...(state.contributorJobRole
      ? {
          contributorJobRoles: [{
            teamId: state.contributorJobRole.teamId,
            jobRoleId: state.contributorJobRole.jobRoleId,
          }],
        }
      : {}),
  }
  return {
    surface: 'work-items',
    scope: crossProjectWorkItemTaskViewScope,
    filters,
    layout: {
      ...base.layout,
      mode: state.layout,
      group: { field: state.grouping, direction: 'asc' },
      displayOptions: { ...base.layout.displayOptions, showCompleted: !state.openOnly },
    },
  }
}

/**
 * Reads the list state from query parameters of an older link, if it carries any.
 *
 * @param searchParams - Current URL query parameters.
 * @returns The list state of the older link, or undefined when it has none of its parameters.
 */
export function readLegacyCrossProjectWorkItemState(
  searchParams: URLSearchParams,
): CrossProjectWorkItemListState | undefined {
  if (!legacyQueryParameters.some((name) => searchParams.has(name))) return undefined
  return parseCrossProjectWorkItemListState(searchParams)
}

/**
 * Removes the query parameters of older links.
 *
 * @param searchParams - Query parameters the task view controller is about to commit.
 * @returns A copy without the older list parameters.
 */
export function removeLegacyCrossProjectWorkItemParams(searchParams: URLSearchParams) {
  const next = new URLSearchParams(searchParams)
  for (const name of legacyQueryParameters) next.delete(name)
  return next
}

/**
 * Narrows a task view layout mode to one the list renders.
 *
 * @param mode - Layout mode of the definition.
 * @returns The same mode, or the table for a layout the list does not have.
 */
function toCrossProjectWorkItemLayout(mode: TaskViewLayoutMode): CrossProjectWorkItemLayout {
  return crossProjectWorkItemLayouts.find((layout) => layout === mode) ?? 'table'
}
