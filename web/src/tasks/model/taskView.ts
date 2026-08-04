import type {
  CustomFieldDefinition,
  ResolvedWorkItemConfiguration,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  WorkItemPatch,
} from '@mukuroji/contracts'
import type { BulkOperationSelection } from '../../bulk-operations/model/bulkOperation'
import type { ProjectDirectoryTeam } from '../../projects/api/directory'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api/access'
import {
  isCustomFieldApplicable,
  sortCustomFieldDefinitions,
} from '../../work-items/model/customFields'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../../work-items/model/workItemFilters'
import {
  formatWorkItemCustomFieldValue,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowStatusCategory,
  sortWorkflowStatuses,
} from '../../work-items/model/workItemDisplay'
import type { ProjectTask, TaskPriority } from '../api/tasks'

/** Task views available within the project task workspace. */
export const taskTabs: readonly ['table', 'board', 'gantt', 'calendar', 'file', 'permissions'] = [
  'table',
  'board',
  'gantt',
  'calendar',
  'file',
  'permissions',
]

/** Priorities accepted by task create and edit forms. */
export const taskPriorities: readonly ['high', 'medium', 'low'] = ['high', 'medium', 'low']

/** Due-date filters available to the task list. */
export const taskDueDateFilters: readonly ['all', 'overdue', 'upcoming', 'no-date'] = [
  'all',
  'overdue',
  'upcoming',
  'no-date',
]

/** Due-date sort orders available to the task list. */
export const taskSortOrders: readonly ['due-date-asc', 'due-date-desc'] = [
  'due-date-asc',
  'due-date-desc',
]

/** Task view selected within the project task workspace. */
export type TaskTab = (typeof taskTabs)[number]

/** Team-scoped workflow status filter value or the all-status sentinel. */
export type StatusFilter = string | 'all'

/** Assignee identity filter value or the all-assignee sentinel. */
export type AssigneeFilter = string | 'all'

/** Task priority filter value or the all-priority sentinel. */
export type PriorityFilter = TaskPriority | 'all'

/** Due-date bucket selected in the task list. */
export type DueDateFilter = (typeof taskDueDateFilters)[number]

/** Due-date ordering selected in the task list. */
export type TaskSortOrder = (typeof taskSortOrders)[number]

/**
 * Context inherited when a Work Item is created from a task view.
 */
export type TaskCreateContext = {
  /** Project receiving the new Work Item. */
  projectId: string
  /** Team owning the destination workflow. */
  teamId?: string
  /** Workflow status inherited from a Board column or other status surface. */
  workflowStatusId?: string
  /** Due date inherited from a Calendar or planning surface. */
  dueDate?: string
  /** Assignee inherited from an assignee-oriented surface. */
  assigneeUserId?: string
  /** Surface that initiated the create action. */
  source: 'header' | 'table' | 'board' | 'gantt' | 'calendar' | 'assignee'
}

/** A selectable assignee filter option derived from visible task data. */
export type AssigneeFilterOption = {
  /** Stable assignee identity used as the filter value. */
  value: AssigneeFilter
  /** Human-readable assignee label shown in the filter menu. */
  label: string
}

/** A Team-scoped workflow status column used by filters and boards. */
export type ProjectTaskStatusColumn = {
  /** Composite Team and status identity used as a React key and filter value. */
  key: string
  /** Team that owns the workflow status. */
  teamId: string
  /** Workflow status represented by the column. */
  status: WorkflowStatusDefinition
  /** Column label, optionally prefixed with the Team name. */
  label: string
}

/** A formatted custom-field value displayed for a task. */
export type TaskCustomFieldEntry = {
  /** Custom-field definition that owns the displayed value. */
  definition: CustomFieldDefinition
  /** Locale-aware display value. */
  value: string
}

/** A due-date group rendered by the task calendar. */
export type TaskCalendarDay = {
  /** Stable calendar group identity. */
  id: string
  /** Human-readable date label. */
  label: string
  /** Stored due-date value represented by the group. */
  date: string
  /** Tasks whose due date exactly matches the group date. */
  items: ProjectTask[]
}

/** Calendar grouping for scheduled and unscheduled tasks. */
export type TaskCalendarModel = {
  /** Chronologically sorted groups of non-empty due-date values. */
  days: TaskCalendarDay[]
  /** Tasks whose due date is empty after trimming whitespace. */
  unscheduledTasks: ProjectTask[]
}

/** Aggregate task counts displayed in the task header and summary card. */
export type TaskSummary = {
  /** Total number of tasks in the source list. */
  totalCount: number
  /** Tasks outside completed and canceled workflow categories. */
  openCount: number
  /** Tasks in the started workflow category. */
  inProgressCount: number
  /** Tasks in the completed workflow category. */
  doneCount: number
  /** Rounded percentage of completed tasks among all tasks. */
  completionRate: number
}

/**
 * Returns the optimistic task projection for a canonical Work Item patch.
 *
 * @param task - Current Work Item snapshot.
 * @param patch - Fields that will be sent to the Work Item API.
 * @param configuration - Workflow configuration used to resolve a status category.
 * @returns A task projection with the patch applied locally.
 */
export function applyTaskPatchOptimistically(
  task: ProjectTask,
  patch: WorkItemPatch,
  configuration?: WorkItemConfiguration,
) {
  const nextCustomFieldValues = { ...task.customFieldValues }

  for (const [fieldId, value] of Object.entries(patch.customFieldValues ?? {})) {
    if (value === null) {
      delete nextCustomFieldValues[fieldId]
      continue
    }

    nextCustomFieldValues[fieldId] = value
  }

  const nextStatus = patch.workflowStatusId && configuration
    ? configuration.workflow.statuses.find((status) => status.id === patch.workflowStatusId)
    : undefined

  return {
    ...task,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.assignedProjectId === undefined
      ? {}
      : patch.assignedProjectId === null
        ? { assignedProjectId: undefined }
        : { assignedProjectId: patch.assignedProjectId }),
    ...(patch.assigneeUserId === undefined ? {} : { assigneeUserId: patch.assigneeUserId }),
    ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.workflowStatusId === undefined ? {} : { workflowStatusId: patch.workflowStatusId }),
    ...(nextStatus ? { statusCategory: nextStatus.category } : {}),
    ...(patch.customFieldValues === undefined ? {} : { customFieldValues: nextCustomFieldValues }),
  }
}

/**
 * Creates the inverse patch used by the common inline-edit undo action.
 *
 * @param task - Snapshot before the optimistic update.
 * @param patch - Patch that was applied to the snapshot.
 * @returns A patch that restores every field touched by the original patch.
 */
export function createTaskInversePatch(
  task: ProjectTask,
  patch: WorkItemPatch,
): WorkItemPatch {
  const inverseCustomFieldValues = patch.customFieldValues === undefined
    ? undefined
    : Object.fromEntries(
        Object.keys(patch.customFieldValues).map((fieldId) => [
          fieldId,
          task.customFieldValues[fieldId] ?? null,
        ]),
      )

  return {
    ...(patch.title === undefined ? {} : { title: task.title }),
    ...(patch.description === undefined ? {} : { description: task.description ?? '' }),
    ...(patch.assignedProjectId === undefined
      ? {}
      : { assignedProjectId: task.assignedProjectId ?? null }),
    ...(patch.assigneeUserId === undefined ? {} : { assigneeUserId: task.assigneeUserId }),
    ...(patch.dueDate === undefined ? {} : { dueDate: task.dueDate }),
    ...(patch.priority === undefined ? {} : { priority: task.priority }),
    ...(patch.workflowStatusId === undefined ? {} : { workflowStatusId: task.workflowStatusId }),
    ...(inverseCustomFieldValues === undefined
      ? {}
      : { customFieldValues: inverseCustomFieldValues }),
  }
}

/** A deduplicated Project option available to bulk move operations. */
export type BulkProjectOption = {
  /** Project ID sent to the bulk operation API. */
  id: string
  /** Human-readable Project name shown by the bulk toolbar. */
  label: string
}

/** Inputs that control project task filtering and due-date sorting. */
export type FilterAndSortProjectTasksOptions = {
  /** Assignee identity to retain, or all assignees. */
  assigneeFilter: AssigneeFilter
  /** Single-Team fallback configuration used when no Team map is available. */
  configuration?: WorkItemConfiguration
  /** Team-specific resolved configurations used by aggregate Project views. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Workflow category and custom-field filter. */
  definitionFilter: WorkItemDefinitionFilter
  /** Due-date bucket to retain. */
  dueDateFilter: DueDateFilter
  /** Locale used to format custom-field search values. */
  locale: Locale
  /** Person-field identities mapped to display labels. */
  personLabels: Readonly<Record<string, string>>
  /** Priority to retain, or all priorities. */
  priorityFilter: PriorityFilter
  /** Free-text query matched against task display fields. */
  searchQuery: string
  /** Due-date order applied after filtering. */
  sortOrder: TaskSortOrder
  /** Team-scoped status columns available to the Project view. */
  statusColumns: readonly ProjectTaskStatusColumn[]
  /** Team-scoped status filter value, or all statuses. */
  statusFilter: StatusFilter
  /** Translator used for localized priority and fallback assignee labels. */
  t: TaskTranslator
  /** Optional reference time used for deterministic due-date filtering. */
  today?: Date
}

/** Translator accepted by task view model helpers. */
type TaskTranslator = (key: MessageKey) => string

/**
 * Creates the composite identity shared by task rows, detail selection, and bulk selection.
 *
 * @param task - Task whose Project, Team, and local ID form the identity.
 * @returns A composite key that distinguishes equal local IDs across Teams and Projects.
 */
export function createTaskKey(task: ProjectTask) {
  return task.assignedProjectId || task.teamId
    ? `${task.assignedProjectId ?? ''}:${task.teamId ?? ''}:${task.id}`
    : task.id
}

/**
 * Finds a route-selected task, optionally disambiguating equal local IDs by Team.
 *
 * @param tasks - Candidate Project tasks.
 * @param selectedTaskId - Local Work Item ID from route state.
 * @param selectedTeamId - Optional owning Team ID from route state.
 * @returns The first matching task, or undefined when no selection resolves.
 */
export function findTaskBySelection(
  tasks: readonly ProjectTask[],
  selectedTaskId?: string,
  selectedTeamId?: string,
) {
  if (!selectedTaskId) {
    return undefined
  }

  return tasks.find((task) =>
    task.id === selectedTaskId && (!selectedTeamId || task.teamId === selectedTeamId)
  )
}

/**
 * Converts a task into the revision snapshot required by bulk operations.
 *
 * @param task - Task selected for a bulk operation.
 * @param t - Current translator retained for compatibility with task view call sites.
 * @returns Bulk operation identity, label, and expected revision.
 */
export function createBulkOperationSelection(
  task: ProjectTask,
  t: TaskTranslator,
): BulkOperationSelection {
  void t

  return {
    expectedRevision: task.revision,
    label: task.title,
    selectionKey: createTaskKey(task),
    teamId: task.teamId,
    workItemId: task.id,
  }
}

/**
 * Formats a date as the local calendar value accepted by a date input.
 *
 * @param date - Date-like value whose local year, month, and day are formatted.
 * @returns A `YYYY-MM-DD` value based on local calendar components.
 */
export function formatTaskDateInputValue(
  date: Pick<Date, 'getDate' | 'getFullYear' | 'getMonth'>,
) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/**
 * Parses the task storage date format into a local midnight Date.
 *
 * @param value - Date stored as a slash-delimited year, month, and day.
 * @returns Parsed local Date, or null when required numeric parts are missing.
 */
export function parseTaskDueDate(value: string) {
  const [year, month, day] = value.split('/').map(Number)

  if (!year || !month || !day) {
    return null
  }

  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Determines whether an incomplete task is before the reference day.
 *
 * @param task - Task whose due date and workflow category are evaluated.
 * @param now - Reference time; defaults to the current time for existing UI behavior.
 * @returns True only for a parsed past date on a non-completed task.
 */
export function isTaskOverdue(task: ProjectTask, now: Date = new Date()) {
  const dueDate = parseTaskDueDate(task.dueDate)

  if (resolveWorkflowStatusCategory(task) === 'completed' || !dueDate) {
    return false
  }

  const today = createLocalStartOfDay(now)
  return dueDate < today
}

/**
 * Tests a task against the selected due-date bucket.
 *
 * @param task - Task evaluated against the due-date filter.
 * @param filter - Selected due-date bucket.
 * @param now - Reference time; defaults to the current time for existing UI behavior.
 * @returns True when the task belongs to the requested bucket.
 */
export function matchesTaskDueDateFilter(
  task: ProjectTask,
  filter: DueDateFilter,
  now: Date = new Date(),
) {
  if (filter === 'all') {
    return true
  }

  const dueDate = parseTaskDueDate(task.dueDate)

  if (filter === 'no-date') {
    return !dueDate
  }

  if (resolveWorkflowStatusCategory(task) === 'completed' || !dueDate) {
    return false
  }

  const today = createLocalStartOfDay(now)

  if (filter === 'overdue') {
    return dueDate < today
  }

  return dueDate >= today
}

/**
 * Sorts tasks by parsed due date without mutating the source list.
 *
 * Missing dates retain the existing TaskPage behavior: last in ascending order and first in
 * descending order. Equal dates use the local Work Item ID as a deterministic tie-breaker.
 *
 * @param tasks - Tasks to sort.
 * @param sortOrder - Ascending or descending due-date order.
 * @returns A new sorted task array.
 */
export function sortTasksByDueDate(
  tasks: readonly ProjectTask[],
  sortOrder: TaskSortOrder,
) {
  return [...tasks].sort((firstTask, secondTask) => {
    const firstTime = parseTaskDueDate(firstTask.dueDate)?.getTime()
    const secondTime = parseTaskDueDate(secondTask.dueDate)?.getTime()
    const firstSortTime = firstTime ?? Number.MAX_SAFE_INTEGER
    const secondSortTime = secondTime ?? Number.MAX_SAFE_INTEGER

    if (firstSortTime === secondSortTime) {
      return firstTask.id.localeCompare(secondTask.id)
    }

    if (sortOrder === 'due-date-desc') {
      return secondSortTime - firstSortTime
    }

    return firstSortTime - secondSortTime
  })
}

/**
 * Resolves the localized message key for a due-date filter option.
 *
 * @param filter - Due-date filter whose menu label is required.
 * @returns Message key for the selected due-date bucket.
 */
export function resolveDueDateFilterLabelKey(filter: DueDateFilter): MessageKey {
  const labelKeys: Record<DueDateFilter, MessageKey> = {
    all: 'tasks.filter.dueDateAll',
    overdue: 'tasks.filter.dueDateOverdue',
    upcoming: 'tasks.filter.dueDateUpcoming',
    'no-date': 'tasks.filter.dueDateNoDate',
  }

  return labelKeys[filter]
}

/**
 * Resolves the localized message key for a due-date sort option.
 *
 * @param sortOrder - Due-date ordering whose menu label is required.
 * @returns Message key for the selected due-date ordering.
 */
export function resolveTaskSortOrderLabelKey(sortOrder: TaskSortOrder): MessageKey {
  return sortOrder === 'due-date-desc'
    ? 'tasks.sort.dueDateDesc'
    : 'tasks.sort.dueDateAsc'
}

/**
 * Builds deduplicated and label-sorted assignee filter options from tasks.
 *
 * @param tasks - Tasks whose canonical assignee identities become options.
 * @param t - Translator used for all-assignee and unassigned labels.
 * @returns The all-assignee option followed by unique assignee options.
 */
export function createAssigneeFilterOptions(
  tasks: readonly ProjectTask[],
  t: TaskTranslator,
): AssigneeFilterOption[] {
  const assigneeOptionsByValue = new Map<string, AssigneeFilterOption>()

  for (const task of tasks) {
    const value = resolveTaskAssigneeFilterValue(task, t)

    if (!value || assigneeOptionsByValue.has(value)) {
      continue
    }

    assigneeOptionsByValue.set(value, {
      label: resolveTaskAssignee(task) || t('tasks.detail.unassigned'),
      value,
    })
  }

  return [
    {
      label: t('tasks.filter.assigneeAll'),
      value: 'all',
    },
    ...Array.from(assigneeOptionsByValue.values()).sort((firstOption, secondOption) =>
      firstOption.label.localeCompare(secondOption.label)
    ),
  ]
}

/**
 * Resolves the canonical identity compared by the assignee filter.
 *
 * @param task - Task whose assignee identity is required.
 * @param t - Translator used for the final unassigned fallback.
 * @returns User ID, email, display label, or localized unassigned fallback in that order.
 */
export function resolveTaskAssigneeFilterValue(
  task: ProjectTask,
  t: TaskTranslator,
) {
  return task.assigneeUserId ??
    task.assigneeEmail ??
    resolveTaskAssignee(task) ??
    t('tasks.detail.unassigned')
}

/**
 * Resolves the configuration applicable to a task in single-Team and aggregate Project views.
 *
 * @param task - Task whose owning Team selects a configuration.
 * @param configurationsByTeam - Resolved configuration map for aggregate views.
 * @param fallbackConfiguration - Single-Team configuration used only when the map is empty.
 * @returns Applicable Work Item configuration, or undefined when unavailable.
 */
export function resolveProjectTaskConfiguration(
  task: ProjectTask,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  fallbackConfiguration?: WorkItemConfiguration,
) {
  const teamConfiguration = configurationsByTeam[task.teamId]?.configuration

  if (teamConfiguration) {
    return teamConfiguration
  }

  return Object.keys(configurationsByTeam).length === 0
    ? fallbackConfiguration
    : undefined
}

/**
 * Creates Team-scoped workflow columns for a Project task board and status filter.
 *
 * @param tasks - Project tasks that contribute owning Team IDs.
 * @param configurationsByTeam - Resolved configurations for aggregate Project Teams.
 * @param teams - Project directory entries used to resolve Team labels.
 * @param fallbackTeamId - Team ID used by a single-Team Project view.
 * @param fallbackConfiguration - Configuration used by a single-Team Project view.
 * @returns Workflow columns ordered by Team ID and configured status order.
 */
export function createProjectTaskStatusColumns(
  tasks: readonly ProjectTask[],
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
  fallbackTeamId?: string,
  fallbackConfiguration?: WorkItemConfiguration,
): ProjectTaskStatusColumn[] {
  const statusTeamIds = fallbackTeamId && fallbackConfiguration
    ? [fallbackTeamId]
    : Array.from(new Set([
        ...Object.keys(configurationsByTeam),
        ...tasks.map((task) => task.teamId),
      ])).sort()
  const showTeamName = statusTeamIds.length > 1

  return statusTeamIds.flatMap((teamId) => {
    const configuration = configurationsByTeam[teamId]?.configuration ??
      (teamId === fallbackTeamId ? fallbackConfiguration : undefined)

    if (!configuration) {
      return []
    }

    const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId

    return sortWorkflowStatuses(configuration.workflow.statuses)
      .map((status): ProjectTaskStatusColumn => ({
        key: `${teamId}:${status.id}`,
        label: showTeamName ? `${teamName} · ${status.name}` : status.name,
        status,
        teamId,
      }))
  })
}

/**
 * Tests whether a task belongs to a Team-scoped workflow status column.
 *
 * @param task - Task evaluated for column membership.
 * @param column - Team-scoped workflow status column.
 * @returns True when both Team ID and workflow status ID match.
 */
export function isTaskInProjectStatusColumn(
  task: ProjectTask,
  column: ProjectTaskStatusColumn,
) {
  return column.teamId === task.teamId && column.status.id === task.workflowStatusId
}

/**
 * Converts a status column key into the token used by existing test IDs.
 *
 * @param value - Team-scoped status column key.
 * @returns Lowercase token with non-alphanumeric runs replaced by hyphens.
 */
export function createProjectStatusTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

/**
 * Formats configured custom-field values that apply to a task's Project assignment.
 *
 * @param task - Task containing custom-field values.
 * @param configuration - Configuration containing field definitions.
 * @param locale - Locale used by typed value formatters.
 * @param personLabels - Person identities mapped to display labels.
 * @param t - Translator reused by the task view.
 * @returns Applicable and populated fields in configured display order.
 */
export function resolveTaskCustomFieldEntries(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
  t: TaskTranslator,
): TaskCustomFieldEntry[] {
  if (!configuration) {
    return []
  }

  return sortCustomFieldDefinitions(configuration.customFields).flatMap((definition) => {
    const value = task.customFieldValues[definition.id]

    if (value === undefined || !isCustomFieldApplicable(definition, task.assignedProjectId)) {
      return []
    }

    return [{
      definition,
      value: formatWorkItemCustomFieldValue(task, definition, {
        durationUnitLabels: {
          days: t('workItems.durationUnit.days'),
          hours: t('workItems.durationUnit.hours'),
          minutes: t('workItems.durationUnit.minutes'),
        },
        falseLabel: t('workItems.fields.booleanFalse'),
        locale,
        personLabels,
        trueLabel: t('workItems.fields.booleanTrue'),
      }),
    }]
  })
}

/**
 * Flattens formatted custom-field names and values into searchable text.
 *
 * @param task - Task containing custom-field values.
 * @param configuration - Configuration containing field definitions.
 * @param locale - Locale used by typed value formatters.
 * @param personLabels - Person identities mapped to display labels.
 * @param t - Translator reused by the task view.
 * @returns Alternating definition names and formatted values.
 */
export function resolveTaskCustomFieldSearchValues(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
  t: TaskTranslator,
) {
  return resolveTaskCustomFieldEntries(
    task,
    configuration,
    locale,
    personLabels,
    t,
  )
    .flatMap(({ definition, value }) => [definition.name, value])
}

/**
 * Groups tasks by their stored due-date value for the calendar view.
 *
 * @param tasks - Tasks displayed by the calendar.
 * @returns Sorted date groups and the tasks without a trimmed due date.
 */
export function createTaskCalendarModel(
  tasks: readonly ProjectTask[],
): TaskCalendarModel {
  const dates = Array.from(new Set(tasks.map((task) => task.dueDate)))
    .filter((date) => date.trim().length > 0)
    .sort()

  return {
    days: dates.map((date) => ({
      date,
      id: date,
      items: tasks.filter((task) => task.dueDate === date),
      label: date,
    })),
    unscheduledTasks: tasks.filter((task) => !task.dueDate.trim()),
  }
}

/**
 * Creates the person-label lookup used to display person custom fields.
 *
 * @param workspaceMembers - Workspace members available to the task view.
 * @returns Email identities mapped to member names with email fallback.
 */
export function createTaskPersonLabels(
  workspaceMembers: readonly WorkspaceMember[],
) {
  return Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
}

/**
 * Creates deduplicated and label-sorted Project options for bulk move operations.
 *
 * Repeated Project IDs preserve the existing TaskPage behavior in which the last Team entry
 * supplies the display name.
 *
 * @param teams - Project directory Teams containing available Projects.
 * @returns Unique Project options ordered by display label.
 */
export function createBulkProjectOptions(
  teams: readonly ProjectDirectoryTeam[],
): BulkProjectOption[] {
  const projectsById = new Map<string, BulkProjectOption>()

  for (const team of teams) {
    for (const project of team.projects) {
      projectsById.set(project.id, { id: project.id, label: project.name })
    }
  }

  return [...projectsById.values()].sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * Filters Project tasks across every task toolbar criterion and applies due-date sorting.
 *
 * @param tasks - Source Project tasks.
 * @param options - Filter, display, configuration, and sorting inputs.
 * @returns A new array containing only matching tasks in the selected due-date order.
 */
export function filterAndSortProjectTasks(
  tasks: readonly ProjectTask[],
  options: FilterAndSortProjectTasksOptions,
) {
  const effectiveStatusFilter = resolveEffectiveStatusFilter(
    options.statusFilter,
    options.statusColumns,
  )
  const effectiveDefinitionFilter = resolveEffectiveDefinitionFilter(
    options.definitionFilter,
    options.configuration,
  )
  const normalizedQuery = options.searchQuery.trim().toLowerCase()
  const today = options.today ?? new Date()
  const filteredTasks = tasks.filter((task) => {
    const resolvedTaskConfiguration = resolveProjectTaskConfiguration(
      task,
      options.configurationsByTeam,
      options.configuration,
    )
    const matchesStatus = effectiveStatusFilter === 'all' ||
      options.statusColumns.some((column) =>
        column.key === effectiveStatusFilter && isTaskInProjectStatusColumn(task, column)
      )
    const matchesAssignee = options.assigneeFilter === 'all' ||
      resolveTaskAssigneeFilterValue(task, options.t) === options.assigneeFilter
    const matchesPriority = options.priorityFilter === 'all' ||
      task.priority === options.priorityFilter
    const matchesDueDate = matchesTaskDueDateFilter(task, options.dueDateFilter, today)
    const matchesDefinition = matchesWorkItemDefinitionFilter(
      task,
      resolvedTaskConfiguration,
      effectiveDefinitionFilter,
    )

    if (
      !matchesStatus ||
      !matchesAssignee ||
      !matchesPriority ||
      !matchesDueDate ||
      !matchesDefinition
    ) {
      return false
    }

    if (!normalizedQuery) {
      return true
    }

    return [
      task.title,
      resolveTaskAssignee(task),
      resolveWorkItemWorkflowStatusLabel(task, resolvedTaskConfiguration),
      options.t(`tasks.priority.${task.priority}`),
      task.dueDate,
      ...resolveTaskCustomFieldSearchValues(
        task,
        resolvedTaskConfiguration,
        options.locale,
        options.personLabels,
        options.t,
      ),
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  return sortTasksByDueDate(filteredTasks, options.sortOrder)
}

/**
 * Falls back to all statuses when a selected status column is no longer available.
 *
 * @param statusFilter - Current Team-scoped status filter value.
 * @param statusColumns - Currently available Team-scoped status columns.
 * @returns The current filter when valid, otherwise the all-status sentinel.
 */
export function resolveEffectiveStatusFilter(
  statusFilter: StatusFilter,
  statusColumns: readonly ProjectTaskStatusColumn[],
): StatusFilter {
  return statusFilter === 'all' || statusColumns.some((column) => column.key === statusFilter)
    ? statusFilter
    : 'all'
}

/**
 * Removes a stale custom-field ID while retaining the workflow category filter.
 *
 * @param definitionFilter - Current workflow category and custom-field filter.
 * @param configuration - Configuration currently available to the filter UI.
 * @returns The original filter when valid, otherwise a copy without the stale field ID.
 */
export function resolveEffectiveDefinitionFilter(
  definitionFilter: WorkItemDefinitionFilter,
  configuration?: WorkItemConfiguration,
): WorkItemDefinitionFilter {
  return !definitionFilter.customFieldId ||
      configuration?.customFields.some((field) => field.id === definitionFilter.customFieldId)
    ? definitionFilter
    : {
        category: definitionFilter.category,
        customFieldId: '',
      }
}

/**
 * Creates the task counts shared by the task header and summary card.
 *
 * @param tasks - Tasks included in the Project summary.
 * @returns Total, open, started, completed, and completion-rate values.
 */
export function createTaskSummary(tasks: readonly ProjectTask[]): TaskSummary {
  const totalCount = tasks.length
  const openCount = tasks.filter((task) => {
    const category = resolveWorkflowStatusCategory(task)
    return category !== 'completed' && category !== 'canceled'
  }).length
  const inProgressCount = tasks.filter(
    (task) => resolveWorkflowStatusCategory(task) === 'started',
  ).length
  const doneCount = tasks.filter(
    (task) => resolveWorkflowStatusCategory(task) === 'completed',
  ).length

  return {
    completionRate: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
    doneCount,
    inProgressCount,
    openCount,
    totalCount,
  }
}

/**
 * Narrows an unknown form value to a supported task priority.
 *
 * @param value - Value read from a form or another untrusted input boundary.
 * @returns A supported priority, defaulting to medium for invalid input.
 */
export function resolveTaskPriority(value: unknown): TaskPriority {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value
  }

  return 'medium'
}

/**
 * Returns a copy of a reference time normalized to local midnight.
 *
 * @param value - Reference time to normalize without mutation.
 * @returns A new Date at the start of the same local day.
 */
function createLocalStartOfDay(value: Date) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Resolves the canonical assignee display fallback used by TaskPage.
 *
 * @param task - Task whose assignee label is required.
 * @returns Name, email, or user ID in canonical fallback order.
 */
function resolveTaskAssignee(task: ProjectTask) {
  return task.assigneeName ?? task.assigneeEmail ?? task.assigneeUserId
}
