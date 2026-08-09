import type {
  SearchCustomFieldFilter,
  SearchCustomFieldValue,
  TaskViewDefinition,
  TaskViewLayoutMode,
  TaskViewScope,
  TaskViewSurface,
  TaskViewUrlOverride,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../../tasks/api'
import {
  matchesTaskDueDateFilter,
  type TaskScreenViewState,
} from '../../tasks/model/taskView'
import type { WorkItemDefinitionFilter } from '../../work-items/model/workItemFilters'
import type { TaskViewPresentationSettings } from './taskViewPresentation'

const defaultTaskViewColumns = [
  'title',
  'status',
  'assignee',
  'dueDate',
  'priority',
]
const taskLayoutModes: readonly TaskViewLayoutMode[] = [
  'table',
  'board',
  'gantt',
  'calendar',
]

/** Task layouts rendered by the primary Project collection panel. */
type ProjectTaskLayoutMode = 'table' | 'board' | 'gantt' | 'calendar'

/** Surface-specific matcher that supplements canonical raw Work Item keyword fields. */
export type TaskViewKeywordMatcher = (
  task: ProjectTask,
  normalizedKeyword: string,
) => boolean

/** Optional evaluation dependencies supplied by a task-view surface. */
export type TaskViewEvaluationContext = {
  /** Matcher for localized or formatted display values unavailable to the canonical model. */
  keywordMatcher?: TaskViewKeywordMatcher
  /** Reference time used by relative due-date filters. */
  now?: Date
}

/** Reproducible Team Issue collection state controlled by a task-view definition. */
export type TeamIssueViewState = {
  /** Workflow category and custom-field filter. */
  definitionFilter: WorkItemDefinitionFilter
  /** Case-insensitive Issue search query. */
  searchQuery: string
  /** Workflow status identifier or the all-status sentinel. */
  statusFilter: string
  /** Active Team Issue layout. */
  viewMode: 'table' | 'board'
}

/**
 * Restricts Team save targets to the Team already bound to a scoped task view.
 *
 * @param teams - Team options visible to the current viewer.
 * @param scope - Route and authorization boundary of the current task view.
 * @returns Team options that cannot move the saved definition outside its scope.
 */
export function filterTaskViewAudienceTeams<TTeam extends { id: string }>(
  teams: readonly TTeam[],
  scope: TaskViewScope,
): TTeam[] {
  const scopeTeamId = scope.kind === 'team'
    ? scope.teamId
    : scope.kind === 'project'
      ? scope.teamId
      : undefined
  return scopeTeamId
    ? teams.filter((team) => team.id === scopeTeamId)
    : [...teams]
}

/**
 * Resolves whether the viewer may assign a Team default for one Team surface.
 *
 * @param canManageWorkspace - Whether Workspace-level administration is available.
 * @param projectIds - Projects currently contained by the scoped Team.
 * @param projectRoles - Current viewer role keyed by Project ID.
 * @returns Whether Workspace administration or any scoped Project manager role grants access.
 */
export function canSetTeamTaskViewDefault(
  canManageWorkspace: boolean,
  projectIds: readonly string[],
  projectRoles: Readonly<Record<string, 'manager' | 'member' | 'viewer'>>,
): boolean {
  return canManageWorkspace || projectIds.some((projectId) =>
    projectRoles[projectId] === 'manager'
  )
}

/**
 * Creates the built-in definition used when no saved or default view is available.
 *
 * @param surface - Product surface consuming the definition.
 * @param scope - Route and authorization boundary for the view.
 * @param mode - Initial layout supported by the surface.
 * @param additionalColumns - Surface-specific columns appended to the common defaults.
 * @returns A complete reproducible task-view definition.
 */
export function createBuiltInTaskViewDefinition(
  surface: TaskViewSurface,
  scope: TaskViewScope,
  mode: TaskViewLayoutMode,
  additionalColumns: readonly string[] = [],
): TaskViewDefinition {
  return {
    surface,
    scope,
    filters: {},
    layout: {
      mode,
      sort: [{ direction: 'asc', field: 'dueDate' }],
      columns: [...defaultTaskViewColumns, ...additionalColumns].map((field) => ({ field })),
      density: 'comfortable',
      displayOptions: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: true,
        showEmptyGroups: true,
        showSubItems: true,
        wrapText: false,
      },
    },
  }
}

/**
 * Converts a canonical definition into the controlled state consumed by Project tasks.
 *
 * @param definition - Effective task-view definition.
 * @returns Project task filters, sort order, and active layout.
 */
export function taskViewDefinitionToProjectState(
  definition: TaskViewDefinition,
): TaskScreenViewState {
  const workflowStatus = definition.filters.workflowStatuses?.[0]
  const customField = definition.filters.customFields?.[0]
  return {
    activeTab: isProjectTaskLayout(definition.layout.mode)
      ? definition.layout.mode
      : 'table',
    assigneeFilter: definition.filters.assigneeUserIds?.[0] ?? 'all',
    definitionFilter: {
      category: definition.filters.workflowCategories?.[0] ?? 'all',
      customFieldId: customField?.fieldId ?? '',
    },
    dueDateFilter: readProjectDueDateFilter(definition.filters.dueDatePreset),
    priorityFilter: definition.filters.priorities?.[0] ?? 'all',
    searchQuery: definition.filters.keyword ?? '',
    sortOrder: definition.layout.sort.find((sort) => sort.field === 'dueDate')?.direction === 'desc'
      ? 'due-date-desc'
      : 'due-date-asc',
    statusFilter: workflowStatus
      ? `${workflowStatus.teamId}:${workflowStatus.statusId}`
      : 'all',
  }
}

/**
 * Applies controlled Project task state to a canonical definition.
 *
 * @param definition - Current effective definition whose unsupported fields are retained.
 * @param state - Next Project task screen state.
 * @returns A complete next canonical definition.
 */
export function projectStateToTaskViewDefinition(
  definition: TaskViewDefinition,
  state: TaskScreenViewState,
): TaskViewDefinition {
  const currentState = taskViewDefinitionToProjectState(definition)
  const filters = { ...definition.filters }
  const layout = { ...definition.layout }

  if (state.searchQuery !== currentState.searchQuery) {
    const keyword = state.searchQuery.trim()
    if (keyword) filters.keyword = keyword
    else delete filters.keyword
  }
  if (state.assigneeFilter !== currentState.assigneeFilter) {
    if (state.assigneeFilter === 'all') delete filters.assigneeUserIds
    else {
      filters.assigneeUserIds = updatePrimaryFilterValue(
        definition.filters.assigneeUserIds,
        state.assigneeFilter,
      )
    }
  }
  if (state.statusFilter !== currentState.statusFilter) {
    const workflowStatus = parseProjectStatusFilter(state.statusFilter)
    if (workflowStatus) {
      filters.workflowStatuses = updatePrimaryFilterValue(
        definition.filters.workflowStatuses,
        workflowStatus,
      )
    } else delete filters.workflowStatuses
  }
  if (state.definitionFilter.category !== currentState.definitionFilter.category) {
    if (state.definitionFilter.category === 'all') delete filters.workflowCategories
    else {
      filters.workflowCategories = updatePrimaryFilterValue(
        definition.filters.workflowCategories,
        state.definitionFilter.category,
      )
    }
  }
  if (state.definitionFilter.customFieldId !== currentState.definitionFilter.customFieldId) {
    if (!state.definitionFilter.customFieldId) delete filters.customFields
    else {
      filters.customFields = updatePrimaryCustomFieldFilter(
        definition.filters.customFields,
        state.definitionFilter.customFieldId,
      )
    }
  }
  if (state.priorityFilter !== currentState.priorityFilter) {
    if (state.priorityFilter === 'all') delete filters.priorities
    else {
      filters.priorities = updatePrimaryFilterValue(
        definition.filters.priorities,
        state.priorityFilter,
      )
    }
  }
  if (state.dueDateFilter !== currentState.dueDateFilter) {
    if (state.dueDateFilter === 'all') delete filters.dueDatePreset
    else filters.dueDatePreset = state.dueDateFilter
  }
  if (state.activeTab !== currentState.activeTab && isProjectTaskLayout(state.activeTab)) {
    layout.mode = state.activeTab
  }
  if (state.sortOrder !== currentState.sortOrder) {
    layout.sort = updateDueDateSort(
      definition.layout.sort,
      state.sortOrder === 'due-date-desc' ? 'desc' : 'asc',
    )
  }

  return {
    ...definition,
    filters,
    layout,
  }
}

/**
 * Converts a canonical definition into the controlled state consumed by Team Issues.
 *
 * @param definition - Effective task-view definition.
 * @returns Team Issue filters and active layout.
 */
export function taskViewDefinitionToTeamState(
  definition: TaskViewDefinition,
): TeamIssueViewState {
  const workflowStatus = definition.filters.workflowStatuses?.[0]
  return {
    definitionFilter: {
      category: definition.filters.workflowCategories?.[0] ?? 'all',
      customFieldId: definition.filters.customFields?.[0]?.fieldId ?? '',
    },
    searchQuery: definition.filters.keyword ?? '',
    statusFilter: workflowStatus?.statusId ?? 'all',
    viewMode: definition.layout.mode === 'board' ? 'board' : 'table',
  }
}

/**
 * Applies controlled Team Issue state to a canonical definition.
 *
 * @param definition - Current effective definition whose unsupported fields are retained.
 * @param state - Next Team Issue screen state.
 * @returns A complete next canonical definition.
 */
export function teamStateToTaskViewDefinition(
  definition: TaskViewDefinition,
  state: TeamIssueViewState,
): TaskViewDefinition {
  const currentState = taskViewDefinitionToTeamState(definition)
  const teamId = definition.scope.kind === 'team' ? definition.scope.teamId : undefined
  const primaryWorkflowStatus = definition.filters.workflowStatuses?.[0]
  const filters = { ...definition.filters }

  if (state.searchQuery !== currentState.searchQuery) {
    const keyword = state.searchQuery.trim()
    if (keyword) filters.keyword = keyword
    else delete filters.keyword
  }
  if (
    state.statusFilter !== currentState.statusFilter ||
    Boolean(teamId && primaryWorkflowStatus && primaryWorkflowStatus.teamId !== teamId)
  ) {
    if (state.statusFilter === 'all' || !teamId) delete filters.workflowStatuses
    else {
      filters.workflowStatuses = updatePrimaryFilterValue(
        definition.filters.workflowStatuses,
        { statusId: state.statusFilter, teamId },
      )
    }
  }
  if (state.definitionFilter.category !== currentState.definitionFilter.category) {
    if (state.definitionFilter.category === 'all') delete filters.workflowCategories
    else {
      filters.workflowCategories = updatePrimaryFilterValue(
        definition.filters.workflowCategories,
        state.definitionFilter.category,
      )
    }
  }
  if (state.definitionFilter.customFieldId !== currentState.definitionFilter.customFieldId) {
    if (!state.definitionFilter.customFieldId) delete filters.customFields
    else {
      filters.customFields = updatePrimaryCustomFieldFilter(
        definition.filters.customFields,
        state.definitionFilter.customFieldId,
      )
    }
  }

  return {
    ...definition,
    filters,
    layout: {
      ...definition.layout,
      mode: state.viewMode,
    },
  }
}

/**
 * Converts canonical layout settings into the presentation model used by the toolbar.
 *
 * @param definition - Effective task-view definition.
 * @returns Grouping, columns, density, and display flags.
 */
export function taskViewDefinitionToPresentationSettings(
  definition: TaskViewDefinition,
): TaskViewPresentationSettings {
  return {
    columns: definition.layout.columns.map((column) => ({ ...column })),
    density: definition.layout.density,
    sort: definition.layout.sort.map((sort) => ({ ...sort })),
    display: {
      showArchived: Boolean(
        definition.filters.includeArchived &&
        definition.layout.displayOptions.showArchived,
      ),
      showAssigneeAvatars:
        definition.layout.displayOptions.showAssigneeAvatars ?? true,
      showCompleted: definition.layout.displayOptions.showCompleted ?? true,
      showEmptyGroups: definition.layout.displayOptions.showEmptyGroups ?? true,
      showSubtasks: definition.layout.displayOptions.showSubItems ?? true,
      wrapTitles: definition.layout.displayOptions.wrapText ?? false,
    },
    ...(definition.layout.group ? { groupBy: definition.layout.group.field } : {}),
    ...(definition.layout.group
      ? { groupDirection: definition.layout.group.direction }
      : {}),
    ...(definition.layout.subgroup ? { subgroupBy: definition.layout.subgroup.field } : {}),
    ...(definition.layout.subgroup
      ? { subgroupDirection: definition.layout.subgroup.direction }
      : {}),
  }
}

/**
 * Applies toolbar presentation settings without discarding persisted column metadata.
 *
 * @param definition - Current effective task-view definition.
 * @param settings - Next presentation settings from the toolbar.
 * @returns A complete next canonical definition.
 */
export function presentationSettingsToTaskViewDefinition(
  definition: TaskViewDefinition,
  settings: TaskViewPresentationSettings,
): TaskViewDefinition {
  const currentlyShowsArchived = Boolean(
    definition.filters.includeArchived &&
    definition.layout.displayOptions.showArchived,
  )
  const archivedVisibilityChanged =
    settings.display.showArchived !== currentlyShowsArchived
  const filters = archivedVisibilityChanged
    ? {
        ...definition.filters,
        includeArchived: settings.display.showArchived,
      }
    : definition.filters
  return {
    ...definition,
    filters,
    layout: {
      ...definition.layout,
      columns: settings.columns.map((column) => ({ ...column })),
      density: settings.density,
      sort: settings.sort?.map((sort) => ({ ...sort })) ?? definition.layout.sort,
      displayOptions: {
        ...definition.layout.displayOptions,
        ...(archivedVisibilityChanged
          ? { showArchived: settings.display.showArchived }
          : {}),
        showAssigneeAvatars: settings.display.showAssigneeAvatars,
        showCompleted: settings.display.showCompleted,
        showEmptyGroups: settings.display.showEmptyGroups,
        showSubItems: settings.display.showSubtasks,
        wrapText: settings.display.wrapTitles,
      },
      ...(settings.groupBy
        ? { group: { direction: settings.groupDirection ?? 'asc', field: settings.groupBy } }
        : { group: undefined }),
      ...(settings.subgroupBy
        ? {
            subgroup: {
              direction: settings.subgroupDirection ?? 'asc',
              field: settings.subgroupBy,
            },
          }
        : { subgroup: undefined }),
    },
  }
}

/**
 * Creates the smallest top-level temporary override needed to reproduce a next definition.
 *
 * @param baseline - Selected or default definition before temporary route changes.
 * @param next - Effective definition after a user changes filters or presentation.
 * @returns A contract URL override, or undefined when the definitions are equivalent.
 */
export function createTaskViewUrlOverride(
  baseline: TaskViewDefinition,
  next: TaskViewDefinition,
): TaskViewUrlOverride | undefined {
  const layout: NonNullable<TaskViewUrlOverride['layout']> = {}
  if (!valuesEqual(baseline.layout.mode, next.layout.mode)) layout.mode = next.layout.mode
  if (!valuesEqual(baseline.layout.group, next.layout.group)) {
    layout.group = next.layout.group ? { ...next.layout.group } : null
  }
  if (!valuesEqual(baseline.layout.subgroup, next.layout.subgroup)) {
    layout.subgroup = next.layout.subgroup ? { ...next.layout.subgroup } : null
  }
  if (!valuesEqual(baseline.layout.sort, next.layout.sort)) {
    layout.sort = next.layout.sort.map((sort) => ({ ...sort }))
  }
  if (!valuesEqual(baseline.layout.columns, next.layout.columns)) {
    layout.columns = next.layout.columns.map((column) => ({ ...column }))
  }
  if (!valuesEqual(baseline.layout.density, next.layout.density)) {
    layout.density = next.layout.density
  }
  if (!valuesEqual(baseline.layout.displayOptions, next.layout.displayOptions)) {
    layout.displayOptions = { ...next.layout.displayOptions }
  }
  const filtersChanged = !valuesEqual(baseline.filters, next.filters)
  const layoutChanged = Object.keys(layout).length > 0
  if (!filtersChanged && !layoutChanged) return undefined
  return {
    ...(filtersChanged ? { filters: cloneTaskViewFilters(next.filters) } : {}),
    ...(layoutChanged ? { layout } : {}),
  }
}

/**
 * Applies a canonical task-view definition to the assigned Work Items shown by My Tasks.
 *
 * @param tasks - Permission-filtered tasks already assigned to the current viewer.
 * @param definition - Effective My Tasks definition.
 * @param context - Optional relative-date reference and surface keyword matcher.
 * @returns Tasks retained by shared filters and display options.
 */
export function filterMyTasksByTaskViewDefinition(
  tasks: readonly ProjectTask[],
  definition: TaskViewDefinition,
  context: TaskViewEvaluationContext = {},
): ProjectTask[] {
  return filterTasksByTaskViewDefinition(tasks, definition, context)
}

/**
 * Applies a canonical task-view definition to a permission-filtered Work Item collection.
 *
 * @param tasks - Work Items already constrained to the current resource scope.
 * @param definition - Effective task-view definition.
 * @param context - Optional relative-date reference and surface keyword matcher.
 * @returns Work Items retained by every canonical filter and display option.
 */
export function filterTasksByTaskViewDefinition(
  tasks: readonly ProjectTask[],
  definition: TaskViewDefinition,
  context: TaskViewEvaluationContext = {},
): ProjectTask[] {
  const keyword = definition.filters.keyword?.trim().toLocaleLowerCase() ?? ''
  const now = context.now ?? new Date()
  const showCompleted = definition.layout.displayOptions.showCompleted ?? true
  const showArchived = definition.layout.displayOptions.showArchived ?? false
  return tasks.filter((task) => {
    if (!showCompleted && task.statusCategory === 'completed') return false
    if (
      definition.filters.entityTypes?.length &&
      !definition.filters.entityTypes.includes('work-item')
    ) return false
    if ((!definition.filters.includeArchived || !showArchived) && task.archivedAt) return false
    if (definition.filters.teamIds?.length && !definition.filters.teamIds.includes(task.teamId)) {
      return false
    }
    if (
      definition.filters.projectIds?.length &&
      (!task.assignedProjectId || !definition.filters.projectIds.includes(task.assignedProjectId))
    ) return false
    if (
      definition.filters.assigneeUserIds?.length &&
      (!task.assigneeUserId || !definition.filters.assigneeUserIds.includes(task.assigneeUserId))
    ) return false
    if (
      definition.filters.creatorUserIds?.length &&
      !definition.filters.creatorUserIds.includes(task.creatorMemberKey)
    ) return false
    if (
      definition.filters.statuses?.length &&
      !definition.filters.statuses.some((status) =>
        status === task.workflowStatusId || status === task.statusCategory
      )
    ) return false
    if (
      definition.filters.priorities?.length &&
      !definition.filters.priorities.includes(task.priority)
    ) return false
    if (
      definition.filters.workflowCategories?.length &&
      !definition.filters.workflowCategories.includes(task.statusCategory)
    ) return false
    if (
      definition.filters.workflowStatuses?.length &&
      !definition.filters.workflowStatuses.some((status) =>
        status.teamId === task.teamId && status.statusId === task.workflowStatusId
      )
    ) return false
    if (
      definition.filters.dueDatePreset &&
      !matchesTaskDueDateFilter(task, definition.filters.dueDatePreset, now)
    ) return false
    if (definition.filters.customFields?.some((filter) =>
      !matchesSearchCustomFieldFilter(task.customFieldValues[filter.fieldId], filter)
    )) return false
    if (
      definition.filters.relationIds?.length &&
      !definition.filters.relationIds.some((relationId) => task.relationIds.includes(relationId))
    ) return false
    if (definition.filters.date && !matchesTaskDateRange(task, definition.filters.date)) {
      return false
    }
    if (!keyword) return true
    return matchesCanonicalTaskViewKeyword(task, keyword) ||
      context.keywordMatcher?.(task, keyword) === true
  })
}

/**
 * Applies every persisted sort rule to a filtered Work Item collection.
 *
 * @param tasks - Filtered Work Items to order.
 * @param definition - Effective definition owning the ordered sort rules.
 * @returns A stable sorted copy of the input Work Items.
 */
export function sortTasksByTaskViewDefinition(
  tasks: readonly ProjectTask[],
  definition: TaskViewDefinition,
): ProjectTask[] {
  const indexedTasks = tasks.map((task, index) => ({ index, task }))
  indexedTasks.sort((left, right) => {
    for (const sort of definition.layout.sort) {
      const comparison = compareTaskViewValues(
        resolveTaskViewFieldValue(left.task, sort.field),
        resolveTaskViewFieldValue(right.task, sort.field),
      )
      if (comparison !== 0) return sort.direction === 'desc' ? -comparison : comparison
    }
    return left.index - right.index
  })
  return indexedTasks.map(({ task }) => task)
}

/**
 * Filters and sorts Work Items with one complete effective task-view definition.
 *
 * @param tasks - Permission-filtered Work Items in the current scope.
 * @param definition - Effective task-view definition.
 * @param context - Optional relative-date reference and surface keyword matcher.
 * @returns Reproducible Work Item results ready for rendering.
 */
export function applyTaskViewDefinitionToTasks(
  tasks: readonly ProjectTask[],
  definition: TaskViewDefinition,
  context: TaskViewEvaluationContext = {},
): ProjectTask[] {
  return sortTasksByTaskViewDefinition(
    filterTasksByTaskViewDefinition(tasks, definition, context),
    definition,
  )
}

/**
 * Matches stable raw Work Item fields that every task-view surface can search safely.
 *
 * @param task - Work Item evaluated by the canonical filter.
 * @param normalizedKeyword - Trimmed lower-case keyword from the persisted definition.
 * @returns Whether a canonical raw field contains the keyword.
 */
function matchesCanonicalTaskViewKeyword(
  task: ProjectTask,
  normalizedKeyword: string,
): boolean {
  return [
    task.title,
    task.assigneeName,
    task.assigneeEmail,
    task.assigneeUserId,
    task.assignedProjectId,
    task.workflowStatusId,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedKeyword))
}

/** Returns whether a Work Item falls inside one persisted inclusive date range. */
function matchesTaskDateRange(
  task: ProjectTask,
  filter: NonNullable<TaskViewDefinition['filters']['date']>,
): boolean {
  const value = filter.field === 'createdAt'
    ? task.createdAt
    : filter.field === 'updatedAt'
      ? task.updatedAt
      : task.dueDate
  if (!value) return false
  if (filter.from && value < filter.from) return false
  return !filter.to || value <= filter.to
}

/** Resolves one built-in or custom task-view field to a sortable primitive. */
function resolveTaskViewFieldValue(
  task: ProjectTask,
  field: string,
): string | number | boolean | readonly string[] | null | undefined {
  if (field.startsWith('custom:')) return task.customFieldValues[field.slice('custom:'.length)]
  switch (field) {
    case 'title': return task.title
    case 'status': return task.workflowStatusId
    case 'assignee': return task.assigneeName ?? task.assigneeEmail ?? task.assigneeUserId
    case 'dueDate': return task.dueDate
    case 'priority': return ['low', 'medium', 'high'].indexOf(task.priority)
    case 'project': return task.assignedProjectId
    case 'team': return task.teamId
    case 'createdAt': return task.createdAt
    case 'updatedAt': return task.updatedAt
    default: return undefined
  }
}

/** Compares two nullable task-view values using stable numeric-aware text ordering. */
function compareTaskViewValues(
  left: string | number | boolean | readonly string[] | null | undefined,
  right: string | number | boolean | readonly string[] | null | undefined,
): number {
  if (left === right) return 0
  if (left === undefined || left === null || left === '') return 1
  if (right === undefined || right === null || right === '') return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/**
 * Retains an existing represented predicate while applying the surface's field picker.
 *
 * @param filters - Canonical predicates before the surface state change.
 * @param fieldId - Single primary field represented by the current surface.
 * @returns Preserved predicates, a new presence predicate, or an empty selection.
 */
function updatePrimaryCustomFieldFilter(
  filters: readonly SearchCustomFieldFilter[] | undefined,
  fieldId: string,
): SearchCustomFieldFilter[] {
  if (!fieldId) return []
  if (filters?.[0]?.fieldId === fieldId) return filters.map((filter) => ({ ...filter }))
  return [
    { fieldId, operator: 'is-not-empty' },
    ...(filters ?? [])
      .slice(1)
      .filter((filter) => filter.fieldId !== fieldId)
      .map((filter) => ({ ...filter })),
  ]
}

/**
 * Replaces the primary surface-controlled filter while retaining additional predicates.
 *
 * @param values - Canonical ordered values before the surface change.
 * @param value - New primary value selected by the surface control.
 * @returns Ordered values with duplicate copies of the new primary removed.
 */
function updatePrimaryFilterValue<TValue>(
  values: readonly TValue[] | undefined,
  value: TValue,
): TValue[] {
  return [
    value,
    ...(values ?? []).slice(1).filter((candidate) => !valuesEqual(candidate, value)),
  ]
}

/**
 * Updates the represented due-date rule without discarding secondary sort rules.
 *
 * @param sort - Canonical ordered sort rules before the surface change.
 * @param direction - New direction selected by the Project task control.
 * @returns Ordered sort rules with the primary due-date direction updated.
 */
function updateDueDateSort(
  sort: TaskViewDefinition['layout']['sort'],
  direction: 'asc' | 'desc',
): TaskViewDefinition['layout']['sort'] {
  const dueDateIndex = sort.findIndex((rule) => rule.field === 'dueDate')
  if (dueDateIndex < 0) {
    return [{ direction, field: 'dueDate' }, ...sort.map((rule) => ({ ...rule }))]
  }
  return sort.map((rule, index) => index === dueDateIndex
    ? { ...rule, direction }
    : { ...rule }
  )
}

/**
 * Applies the canonical Workspace Search custom-field comparison semantics.
 *
 * @param actual - Value stored on a visible Work Item.
 * @param filter - Persisted custom-field predicate.
 * @returns Whether the Work Item value satisfies the predicate.
 */
function matchesSearchCustomFieldFilter(
  actual: SearchCustomFieldValue | undefined,
  filter: SearchCustomFieldFilter,
): boolean {
  const empty = actual === undefined ||
    actual === null ||
    actual === '' ||
    Array.isArray(actual) && actual.length === 0
  if (filter.operator === 'is-empty') return empty
  if (filter.operator === 'is-not-empty') return !empty
  if (empty) return false
  if (filter.operator === 'equals') {
    return canonicalSearchValue(actual) === canonicalSearchValue(filter.value)
  }
  if (filter.operator === 'not-equals') {
    return canonicalSearchValue(actual) !== canonicalSearchValue(filter.value)
  }
  if (filter.operator === 'contains') {
    if (Array.isArray(actual)) {
      return Array.isArray(filter.value)
        ? filter.value.every((candidate) => actual.includes(candidate))
        : typeof filter.value === 'string' && actual.includes(filter.value)
    }
    return typeof actual === 'string' &&
      typeof filter.value === 'string' &&
      actual.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())
  }
  if (typeof actual !== 'number' || typeof filter.value !== 'number') return false
  if (filter.operator === 'greater-than') return actual > filter.value
  if (filter.operator === 'greater-than-or-equal') return actual >= filter.value
  if (filter.operator === 'less-than') return actual < filter.value
  return actual <= filter.value
}

/**
 * Serializes a supported custom-field value for exact comparison.
 *
 * @param value - JSON-safe value from a Work Item or filter.
 * @returns Stable comparison text.
 */
function canonicalSearchValue(value: SearchCustomFieldValue | undefined): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSearchValue(item)).join(',')}]`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Returns whether a canonical layout can be rendered by Project tasks. */
function isProjectTaskLayout(value: string): value is ProjectTaskLayoutMode {
  return taskLayoutModes.some((mode) => mode === value)
}

/** Parses the Team-qualified status key used by Project task controls. */
function parseProjectStatusFilter(value: string) {
  if (value === 'all') return undefined
  const separatorIndex = value.lastIndexOf(':')
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return undefined
  return {
    teamId: value.slice(0, separatorIndex),
    statusId: value.slice(separatorIndex + 1),
  }
}

/** Narrows a canonical due-date preset to the Project screen's available buckets. */
function readProjectDueDateFilter(
  value: TaskViewDefinition['filters']['dueDatePreset'],
): TaskScreenViewState['dueDateFilter'] {
  if (
    value === 'overdue' ||
    value === 'today' ||
    value === 'upcoming' ||
    value === 'no-date'
  ) return value
  return 'all'
}

/** Clones filter arrays and nested filter records for URL ownership. */
function cloneTaskViewFilters(filters: TaskViewDefinition['filters']): TaskViewDefinition['filters'] {
  return {
    ...filters,
    ...(filters.entityTypes ? { entityTypes: [...filters.entityTypes] } : {}),
    ...(filters.assigneeUserIds ? { assigneeUserIds: [...filters.assigneeUserIds] } : {}),
    ...(filters.creatorUserIds ? { creatorUserIds: [...filters.creatorUserIds] } : {}),
    ...(filters.statuses ? { statuses: [...filters.statuses] } : {}),
    ...(filters.customFields ? {
      customFields: filters.customFields.map((filter) => ({
        ...filter,
        ...(Array.isArray(filter.value) ? { value: [...filter.value] } : {}),
      })),
    } : {}),
    ...(filters.relationIds ? { relationIds: [...filters.relationIds] } : {}),
    ...(filters.projectIds ? { projectIds: [...filters.projectIds] } : {}),
    ...(filters.teamIds ? { teamIds: [...filters.teamIds] } : {}),
    ...(filters.workflowStatuses ? {
      workflowStatuses: filters.workflowStatuses.map((status) => ({ ...status })),
    } : {}),
    ...(filters.workflowCategories
      ? { workflowCategories: [...filters.workflowCategories] }
      : {}),
    ...(filters.priorities ? { priorities: [...filters.priorities] } : {}),
    ...(filters.date ? { date: { ...filters.date } } : {}),
  }
}

/** Compares JSON-compatible task-view values independent of object key order. */
function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJsonValue(left)) === JSON.stringify(normalizeJsonValue(right))
}

/** Recursively sorts object keys before deterministic comparison. */
function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJsonValue(value[key])]),
  )
}

/** Narrows an unknown value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
