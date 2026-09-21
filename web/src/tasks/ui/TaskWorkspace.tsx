import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  PlanningSnapshot,
  ResolvedWorkItemConfiguration,
  WorkItemDependencyEndpoint,
  WorkItemConfiguration,
  WorkItemPatch,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { createSearchWorkItemTypeKey } from '@mukuroji/contracts'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  BulkOperationProjectOption,
  BulkOperationMutationContext,
  BulkOperationSelection,
  BulkOperationTaskActionRequest,
  BulkOperationTaskActionInterruption,
} from '../../bulk-operations/ui/BulkOperationToolbar'
import type { ProjectTaskDirectScheduleHandle } from '../../task-views/model/projectTaskDirectActionRequest'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import type {
  ProjectDirectoryTeam,
  ProjectMember,
  ProjectUser,
  UpdateProjectMemberInput,
} from '../../projects/api'
import { ChevronIcon } from '../../shared/ui/icons'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import type { WorkItemDefinitionFilter } from '../../work-items/model/workItemFilters'
import {
  createWorkItemDependencySummaries,
} from '../../work-items/model/workItemDependencies'
import { WorkItemDefinitionFilters } from '../../work-items/ui/WorkItemDefinitionFilters'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  groupTaskViewItems,
  type TaskViewPresentationSettings,
} from '../../task-views/model/taskViewPresentation'
import type { CanonicalWorkItem } from '../api/tasks'
import {
  createAssigneeFilterOptions,
  resolveDueDateFilterLabelKey,
  resolveProjectTaskGroupValue,
  resolveTaskSortOrderLabelKey,
  taskDueDateFilters,
  taskPriorities,
  taskSortOrders,
  type AssigneeFilter,
  type DueDateFilter,
  type PriorityFilter,
  type ProjectTaskStatusColumn,
  type TaskCreateContext,
  type StatusFilter,
  type TaskSortOrder,
  type TaskTab,
} from '../model/taskView'
import { resolveWorkItemTypes } from '../../work-items/model/workItemDisplay'
import { TaskBoardView } from './TaskBoardView'
import { TaskCalendarView } from './TaskCalendarView'
import { TaskFileView } from './TaskFileView'
import { TaskGanttView } from './TaskGanttView'
import { TaskPermissionsView } from './TaskPermissionsView'
import { TaskTableView } from './TaskTableView'
import type { ProjectTaskActionMenuOpenHandler } from './projectTaskActionMenu'

const priorityFilterOptions: readonly PriorityFilter[] = ['all', ...taskPriorities]

/** Props accepted by the task view workspace. */
export type TaskWorkspaceProps = {
  /** Currently active task view. */
  activeTab: TaskTab
  /** Unfiltered tasks used to derive complete filter options. */
  allTasks: CanonicalWorkItem[]
  /** Projects available to bulk move operations. */
  bulkProjectOptions: BulkOperationProjectOption[]
  /** Workspace id required by bulk operations. */
  bulkWorkspaceId: string
  /** Canonical Project action requested by another action entrance. */
  bulkTaskActionRequest?: BulkOperationTaskActionRequest
  /** Stable key epoch retained after the current canonical action request is consumed. */
  bulkTaskActionEpoch: number
  /** Selected assignee filter. */
  assigneeFilter: AssigneeFilter
  /** Active Project members available to inline assignee editors. */
  assigneeOptions: ProjectMember[]
  /** Whether the current user may manage project members. */
  canManageProjectMembers: boolean
  /** Checks exact Team-qualified Project write scope for one concrete Work Item. */
  canMutateTask?: (task: CanonicalWorkItem) => boolean
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Single-Team fallback Work Item configuration. */
  configuration?: WorkItemConfiguration
  /** Team-scoped Work Item configurations. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Team ids whose Work Item configuration could not be loaded. */
  configurationFailedTeamIds: string[]
  /** Workflow category and custom-field filter. */
  definitionFilter: WorkItemDefinitionFilter
  /** Selected due-date filter. */
  dueDateFilter: DueDateFilter
  /** Whether project members are being loaded. */
  isProjectMembersLoading: boolean
  /** Whether project user candidates are being loaded. */
  isProjectUsersLoading: boolean
  /** Whether the current user is a system administrator. */
  isSystemAdmin: boolean
  /** Locale used by task views and custom-field controls. */
  locale: Locale
  /** Person identifiers mapped to display labels. */
  personLabels: Readonly<Record<string, string>>
  /** Person options shown by custom-field filters. */
  personOptions: WorkItemPersonOption[]
  /** Selected priority filter. */
  priorityFilter: PriorityFilter
  /** Selected Team-qualified Work Item Type filter key. */
  workItemTypeFilter: string | 'all'
  /** Current project id. */
  projectId: string
  /** Authoritative canonical Work Item dependency graph. */
  planningSnapshot?: PlanningSnapshot
  /** File controller scoped to the current project and Team. */
  projectFiles?: FileArtifactsController
  /** Current project members. */
  projectMembers: ProjectMember[]
  /** Project member query error shown by the permissions view. */
  projectMembersErrorMessage?: string
  /** Current project name. */
  projectName: string
  /** Team and Project directory used to label Team-qualified filter options. */
  teams: readonly ProjectDirectoryTeam[]
  /** Search query used to find project user candidates. */
  projectUserQuery: string
  /** Project user candidates loaded so far. */
  projectUsers: ProjectUser[]
  /** Project user query error shown by the permissions view. */
  projectUsersErrorMessage?: string
  /** Opaque cursor for the next project user page. */
  projectUsersNextToken?: string
  /** Composite key of the task selected for detail. */
  selectedDetailTaskKey?: string
  /** Selected task sort order. */
  sortOrder: TaskSortOrder
  /** Changes the selected assignee filter. */
  onAssigneeFilterChange: (assigneeFilter: AssigneeFilter) => void
  /** Applies a previously previewed bulk operation. */
  onBulkApply?: (
    request: BulkOperationRequest,
    preview: BulkOperationPreview,
    resumedOperation?: BulkOperation,
  ) => Promise<BulkOperation>
  /** Synchronizes selection after a bulk operation changes state. */
  onBulkOperationComplete: (operation: BulkOperation) => void
  /** Routes parameterized bulk entrances through the canonical Project action registry. */
  onBulkTaskActionRequest?: (
    actionId: BulkOperationTaskActionRequest['actionId'],
  ) => Promise<boolean>
  /** Acknowledges one canonical action request after the toolbar consumes it. */
  onBulkTaskActionRequestConsumed: (requestId: number) => void
  /** Claims the exact canonical request immediately before bulk apply dispatch. */
  onBulkTaskActionMutationStart?: (request: BulkOperationTaskActionRequest) => boolean
  /** Returns an applied operation to the exact canonical request that opened the editor. */
  onBulkTaskActionOperationComplete?: (
    request: BulkOperationTaskActionRequest,
    operation: BulkOperation,
  ) => void
  /** Returns non-apply terminal outcomes to the canonical action completion bridge. */
  onBulkTaskActionInterrupted?: (
    interruption: BulkOperationTaskActionInterruption,
  ) => void
  /** Previews validation and effects for a bulk operation. */
  onBulkPreview?: (request: BulkOperationRequest) => Promise<BulkOperationPreview>
  /** Retries failed items in a bulk operation. */
  onBulkRetry?: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
  /** Undoes successful items in a bulk operation. */
  onBulkUndo?: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
  /** Checks the exact target before an apply, retry, resume, or undo mutation. */
  onBeforeBulkMutation?: (context: BulkOperationMutationContext) => boolean
  /** Changes the selected due-date filter. */
  onDueDateFilterChange: (dueDateFilter: DueDateFilter) => void
  /** Changes the workflow/custom-field definition filter. */
  onDefinitionFilterChange: (filter: WorkItemDefinitionFilter) => void
  /** Loads the next project user page. */
  onLoadMoreProjectUsers?: () => Promise<void>
  /** Opens the inline task creation panel. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Creates a canonical Work Item schedule dependency. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical Work Item schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Changes the selected priority filter. */
  onPriorityFilterChange: (priorityFilter: PriorityFilter) => void
  /** Changes the selected Team-qualified Work Item Type filter key. */
  onWorkItemTypeFilterChange: (workItemTypeFilter: string | 'all') => void
  /** Resets every task filter in one state transition. */
  onResetFilters?: () => void
  /** Changes the project user search query. */
  onProjectUserQueryChange?: (query: string) => void
  /** Removes a member from the project. */
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  /** Changes the task search query. */
  onSearchQueryChange: (query: string) => void
  /** Selects a task for the detail pane. */
  onSelectTask: (task: CanonicalWorkItem) => void
  /** Opens the canonical action menu for one rendered task row or card. */
  onTaskActionMenuOpen?: ProjectTaskActionMenuOpenHandler
  /** Changes the selected task sort order. */
  onSortOrderChange: (sortOrder: TaskSortOrder) => void
  /** Changes the selected workflow status filter. */
  onStatusFilterChange: (statusFilter: StatusFilter) => void
  /** Changes one task's bulk selection state. */
  onTaskSelectionChange: (taskKey: string, selected: boolean) => void
  /** Changes the bulk selection state of visible tasks. */
  onVisibleTaskSelectionChange: (selectionKeys: string[], selected: boolean) => void
  /** Updates a task through the shared Work Item mutation. */
  onUpdateTask?: (task: CanonicalWorkItem, input: WorkItemPatch) => Promise<CanonicalWorkItem>
  /** Starts a canonical schedule action and returns its exact preview controller. */
  onRequestScheduleChange?: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
  /** Adds or updates a project member role. */
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
  /** Updates a canonical Work Item schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /** Current task search query. */
  searchQuery: string
  /** Composite keys of tasks selected for bulk operations. */
  selectedTaskKeys: string[]
  /** Full revision snapshots selected for bulk operations. */
  selectedBulkItems: BulkOperationSelection[]
  /** Selected Team-scoped workflow status filter. */
  statusFilter: StatusFilter
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Task list error shown in place of task views. */
  taskErrorMessage?: string
  /** Shared saved-view lifecycle and display controls. */
  taskViewToolbar?: ReactNode
  /** Columns, grouping, density, and text wrapping applied by task layouts. */
  taskViewPresentation?: TaskViewPresentationSettings
  /** Filtered and sorted tasks rendered by the active view. */
  tasks: CanonicalWorkItem[]
  /** Bulk operation snapshots for currently visible tasks. */
  visibleBulkItems: BulkOperationSelection[]
  /** Current Workspace member key used by file approvals. */
  currentWorkspaceMemberKey?: string
  /** Workspace members used by project files and custom fields. */
  workspaceMembers: WorkspaceMember[]
  /** Team-scoped workflow columns shared by filters and the board. */
  statusColumns: ProjectTaskStatusColumn[]
}

/**
 * Renders the shared task toolbar and delegates content to the active task view.
 *
 * @param props - Shared filter state, view models, and task actions.
 * @returns The active task workspace.
 */
export function TaskWorkspace({
  activeTab,
  allTasks,
  bulkProjectOptions,
  bulkTaskActionEpoch,
  bulkTaskActionRequest,
  bulkWorkspaceId,
  assigneeFilter,
  assigneeOptions,
  canManageProjectMembers,
  canManageScheduleDependencyEndpoint,
  canMutateTask,
  configuration,
  configurationsByTeam,
  configurationFailedTeamIds,
  definitionFilter,
  dueDateFilter,
  isProjectMembersLoading,
  isProjectUsersLoading,
  isSystemAdmin,
  locale,
  personLabels,
  personOptions,
  priorityFilter,
  workItemTypeFilter,
  projectId,
  planningSnapshot,
  projectFiles,
  projectMembers,
  projectMembersErrorMessage,
  projectName,
  teams,
  projectUserQuery,
  projectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  selectedDetailTaskKey,
  sortOrder,
  onAssigneeFilterChange,
  onBulkApply,
  onBulkOperationComplete,
  onBulkTaskActionRequest,
  onBulkTaskActionRequestConsumed,
  onBulkTaskActionMutationStart,
  onBulkTaskActionOperationComplete,
  onBulkTaskActionInterrupted,
  onBulkPreview,
  onBulkRetry,
  onBulkUndo,
  onBeforeBulkMutation,
  onDueDateFilterChange,
  onDefinitionFilterChange,
  onLoadMoreProjectUsers,
  onCreateTaskOpen,
  onCreateScheduleDependency,
  onDeleteScheduleDependency,
  onPriorityFilterChange,
  onWorkItemTypeFilterChange,
  onResetFilters,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onSearchQueryChange,
  onSelectTask,
  onTaskActionMenuOpen,
  onSortOrderChange,
  onStatusFilterChange,
  onTaskSelectionChange,
  onVisibleTaskSelectionChange,
  onUpdateProjectMember,
  onUpdateScheduleDependency,
  onRequestScheduleChange,
  onUpdateTask,
  searchQuery,
  selectedTaskKeys,
  selectedBulkItems,
  statusFilter,
  t,
  taskErrorMessage,
  taskViewToolbar,
  taskViewPresentation,
  tasks,
  visibleBulkItems,
  currentWorkspaceMemberKey,
  workspaceMembers,
  statusColumns,
}: TaskWorkspaceProps) {
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false)
  const [isAssigneeMenuOpen, setIsAssigneeMenuOpen] = useState(false)
  const [isPriorityMenuOpen, setIsPriorityMenuOpen] = useState(false)
  const [isWorkItemTypeMenuOpen, setIsWorkItemTypeMenuOpen] = useState(false)
  const [isDueDateMenuOpen, setIsDueDateMenuOpen] = useState(false)
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
  const assigneeFilterOptions = createAssigneeFilterOptions(allTasks, t)
  const workItemTypeOptions = useMemo(() => {
    const teamNames = new Map(teams.map((team) => [team.id, team.name]))
    const typeByKey = new Map<string, { id: string; name: string }>()
    for (const [teamId, resolved] of Object.entries(configurationsByTeam)) {
      for (const type of resolveWorkItemTypes(resolved.configuration)) {
        const filterValue = createSearchWorkItemTypeKey(teamId, type.id)
        typeByKey.set(filterValue, {
          id: filterValue,
          name: `${teamNames.get(teamId) ?? teamId} · ${type.name}`,
        })
      }
    }
    return [...typeByKey.values()].sort((first, second) =>
      first.name.localeCompare(second.name),
    )
  }, [configurationsByTeam, teams])
  const workItemTypeFilterLabel = workItemTypeFilter === 'all'
    ? t('tasks.filter.workItemType')
    : workItemTypeOptions.find((type) => type.id === workItemTypeFilter)?.name ??
      workItemTypeFilter
  const dependencySummaries = useMemo(
    () => createWorkItemDependencySummaries(planningSnapshot),
    [planningSnapshot],
  )
  const boardGroups = taskViewPresentation?.groupBy && taskViewPresentation.groupBy !== 'status'
    ? groupTaskViewItems(
        tasks,
        taskViewPresentation.groupBy,
        (task, field) => resolveProjectTaskGroupValue(
          task,
          field,
          configurationsByTeam,
          configuration,
          t,
          teams,
        ),
        taskViewPresentation.groupDirection,
      )
    : undefined

  /** Renders one complete workflow board for an optional primary group. */
  const renderBoard = (boardTasks: CanonicalWorkItem[]) => (
    <TaskBoardView
      assigneeOptions={assigneeOptions}
      configuration={configuration}
      configurationsByTeam={configurationsByTeam}
      configurationFailedTeamIds={configurationFailedTeamIds}
      dependencySummaries={dependencySummaries}
      locale={locale}
      onSelectTask={onSelectTask}
      onTaskActionMenuOpen={onTaskActionMenuOpen}
      onCreateTaskOpen={onCreateTaskOpen}
      onUpdateTask={onUpdateTask}
      canMutateTask={canMutateTask}
      personLabels={personLabels}
      personOptions={personOptions}
      presentation={taskViewPresentation}
      projectId={projectId}
      selectedDetailTaskKey={selectedDetailTaskKey}
      statusColumns={statusColumns}
      t={t}
      tasks={boardTasks}
    />
  )

  if (activeTab === 'permissions') {
    return (
      <TaskPermissionsView
        canManageProjectMembers={canManageProjectMembers}
        isProjectMembersLoading={isProjectMembersLoading}
        isProjectUsersLoading={isProjectUsersLoading}
        isSystemAdmin={isSystemAdmin}
        onLoadMoreProjectUsers={onLoadMoreProjectUsers}
        onProjectUserQueryChange={onProjectUserQueryChange}
        onRemoveProjectMember={onRemoveProjectMember}
        onUpdateProjectMember={onUpdateProjectMember}
        projectId={projectId}
        projectMembers={projectMembers}
        projectMembersErrorMessage={projectMembersErrorMessage}
        projectName={projectName}
        projectUserQuery={projectUserQuery}
        projectUsers={projectUsers}
        projectUsersErrorMessage={projectUsersErrorMessage}
        projectUsersNextToken={projectUsersNextToken}
        t={t}
      />
    )
  }

  if (activeTab === 'file') {
    return (
      <TaskFileView
        configuration={configuration}
        configurationsByTeam={configurationsByTeam}
        currentWorkspaceMemberKey={currentWorkspaceMemberKey}
        locale={locale}
        projectFiles={projectFiles}
        t={t}
        tasks={tasks}
        workspaceMembers={workspaceMembers}
      />
    )
  }

  return (
    <div className="px-[clamp(18px,2.5vw,30px)] py-4">
      {taskViewToolbar}
      <div className="workbench-toolbar flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block">
            <span className="sr-only">{t('tasks.search')}</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5f6874]" />
            <input
              aria-label={t('tasks.search')}
              className="workbench-input h-9 w-[min(250px,calc(100vw-52px))] pl-9 pr-3 placeholder:text-[var(--workbench-muted-soft)]"
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={t('tasks.search')}
              type="search"
              value={searchQuery}
            />
          </label>
          <FilterButton
            icon={<FilterIcon />}
            label={t('tasks.filter.all')}
            onClick={() => {
              setIsStatusMenuOpen(false)
              setIsAssigneeMenuOpen(false)
              setIsDueDateMenuOpen(false)
              setIsPriorityMenuOpen(false)
              setIsWorkItemTypeMenuOpen(false)
              setIsSortMenuOpen(false)
              if (onResetFilters) {
                onResetFilters()
              } else {
                onStatusFilterChange('all')
                onAssigneeFilterChange('all')
                onPriorityFilterChange('all')
                onWorkItemTypeFilterChange('all')
                onDueDateFilterChange('all')
                onDefinitionFilterChange({ category: 'all', customFieldId: '' })
              }
            }}
          />
          <FilterMenu
            active={statusFilter !== 'all'}
            buttonId="status-filter-button"
            icon={<StatusIcon />}
            isOpen={isStatusMenuOpen}
            label={t('tasks.filter.status')}
            menuId="status-filter-menu"
            onOpenChange={setIsStatusMenuOpen}
          >
            {[
              { key: 'all', label: t('tasks.filter.statusAll') },
              ...statusColumns,
            ].map((status) => (
              <MenuOption
                checked={statusFilter === status.key}
                key={status.key}
                label={status.label}
                onClick={() => {
                  onStatusFilterChange(status.key)
                  setIsStatusMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
          <FilterMenu
            active={assigneeFilter !== 'all'}
            buttonId="assignee-filter-button"
            icon={<AssigneeIcon />}
            isOpen={isAssigneeMenuOpen}
            label={t('tasks.filter.assignee')}
            menuClassName="max-h-80 w-64 overflow-auto"
            menuId="assignee-filter-menu"
            onOpenChange={setIsAssigneeMenuOpen}
          >
            {assigneeFilterOptions.map((option) => (
              <MenuOption
                checked={assigneeFilter === option.value}
                key={option.value}
                label={option.label}
                onClick={() => {
                  onAssigneeFilterChange(option.value)
                  setIsAssigneeMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
          <FilterMenu
            active={dueDateFilter !== 'all'}
            buttonId="due-date-filter-button"
            icon={<CalendarIcon />}
            isOpen={isDueDateMenuOpen}
            label={t('tasks.filter.dueDate')}
            menuId="due-date-filter-menu"
            onOpenChange={setIsDueDateMenuOpen}
          >
            {taskDueDateFilters.map((filter) => (
              <MenuOption
                checked={dueDateFilter === filter}
                key={filter}
                label={t(resolveDueDateFilterLabelKey(filter))}
                onClick={() => {
                  onDueDateFilterChange(filter)
                  setIsDueDateMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
          <FilterMenu
            active={priorityFilter !== 'all'}
            buttonId="priority-filter-button"
            icon={<FlagIcon />}
            isOpen={isPriorityMenuOpen}
            label={t('tasks.filter.priority')}
            menuId="priority-filter-menu"
            onOpenChange={setIsPriorityMenuOpen}
          >
            {priorityFilterOptions.map((priority) => (
              <MenuOption
                checked={priorityFilter === priority}
                key={priority}
                label={priority === 'all'
                  ? t('tasks.filter.priorityAll')
                  : t(`tasks.priority.${priority}`)}
                onClick={() => {
                  onPriorityFilterChange(priority)
                  setIsPriorityMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
          <FilterMenu
            active={workItemTypeFilter !== 'all'}
            buttonId="work-item-type-filter-button"
            icon={<FilterIcon />}
            isOpen={isWorkItemTypeMenuOpen}
            label={workItemTypeFilterLabel}
            menuClassName="max-h-80 w-64 overflow-auto"
            menuId="work-item-type-filter-menu"
            onOpenChange={setIsWorkItemTypeMenuOpen}
          >
            <MenuOption
              checked={workItemTypeFilter === 'all'}
              label={t('tasks.filter.workItemTypeAll')}
              onClick={() => {
                onWorkItemTypeFilterChange('all')
                setIsWorkItemTypeMenuOpen(false)
              }}
            />
            {workItemTypeOptions.map((type) => (
              <MenuOption
                checked={workItemTypeFilter === type.id}
                key={type.id}
                label={type.name}
                onClick={() => {
                  onWorkItemTypeFilterChange(type.id)
                  setIsWorkItemTypeMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterMenu
            align="right"
            buttonId="task-sort-button"
            icon={<CalendarIcon />}
            isOpen={isSortMenuOpen}
            label={t(resolveTaskSortOrderLabelKey(sortOrder))}
            menuId="task-sort-menu"
            onOpenChange={setIsSortMenuOpen}
          >
            {taskSortOrders.map((order) => (
              <MenuOption
                checked={sortOrder === order}
                key={order}
                label={t(resolveTaskSortOrderLabelKey(order))}
                onClick={() => {
                  onSortOrderChange(order)
                  setIsSortMenuOpen(false)
                }}
              />
            ))}
          </FilterMenu>
        </div>
      </div>
      <div className="workbench-toolbar mt-3 px-3 py-2">
        <WorkItemDefinitionFilters
          configuration={configuration}
          idPrefix="project-tasks"
          locale={locale}
          onChange={onDefinitionFilterChange}
          personOptions={personOptions}
          value={definitionFilter}
        />
      </div>

      {taskErrorMessage && activeTab !== 'table' ? (
        <p
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-5 py-4 text-sm font-semibold text-red-700"
          data-testid="tasks-error"
          role="alert"
        >
          {taskErrorMessage === t('tasks.error.loading')
            ? taskErrorMessage
            : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
        </p>
      ) : null}

      {activeTab === 'table' ? (
        <TaskTableView
          assigneeOptions={assigneeOptions}
          bulkProjectOptions={bulkProjectOptions}
          bulkTaskActionEpoch={bulkTaskActionEpoch}
          bulkTaskActionRequest={bulkTaskActionRequest}
          bulkWorkspaceId={bulkWorkspaceId}
          configuration={configuration}
          configurationsByTeam={configurationsByTeam}
          dependencySummaries={dependencySummaries}
          locale={locale}
          onBulkApply={onBulkApply}
          onBulkOperationComplete={onBulkOperationComplete}
          onBulkTaskActionRequest={onBulkTaskActionRequest}
          onBulkTaskActionRequestConsumed={onBulkTaskActionRequestConsumed}
          onBulkTaskActionMutationStart={onBulkTaskActionMutationStart}
          onBulkTaskActionOperationComplete={onBulkTaskActionOperationComplete}
          onBulkTaskActionInterrupted={onBulkTaskActionInterrupted}
          onBulkPreview={onBulkPreview}
          onBulkRetry={onBulkRetry}
          onBulkUndo={onBulkUndo}
          onBeforeBulkMutation={onBeforeBulkMutation}
          onCreateTaskOpen={onCreateTaskOpen}
          onUpdateTask={onUpdateTask}
          canMutateTask={canMutateTask}
          onSelectTask={onSelectTask}
          onTaskActionMenuOpen={onTaskActionMenuOpen}
          onTaskSelectionChange={onTaskSelectionChange}
          onVisibleTaskSelectionChange={onVisibleTaskSelectionChange}
          personOptions={personOptions}
          personLabels={personLabels}
          projectId={projectId}
          selectedBulkItems={selectedBulkItems}
          selectedDetailTaskKey={selectedDetailTaskKey}
          selectedTaskKeys={selectedTaskKeys}
          teams={teams}
          t={t}
          taskErrorMessage={taskErrorMessage}
          tasks={tasks}
          presentation={taskViewPresentation}
          visibleBulkItems={visibleBulkItems}
        />
      ) : null}
      {activeTab === 'board' && !taskErrorMessage ? (
        boardGroups ? (
          <div className="grid gap-5" data-testid="project-task-board-groups">
            {boardGroups.map((group) => (
              <section className="min-w-0" key={group.key}>
                <h2 className="border-b border-[var(--workbench-border)] pb-2 text-sm font-bold text-[var(--workbench-text)]">
                  {group.label}{' '}
                  <span className="font-medium text-[var(--workbench-muted)]">({group.items.length})</span>
                </h2>
                {renderBoard([...group.items])}
              </section>
            ))}
          </div>
        ) : renderBoard(tasks)
      ) : null}
      {activeTab === 'gantt' && !taskErrorMessage ? (
        <TaskGanttView
          allProjectTasks={allTasks}
          canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
          configuration={configuration}
          configurationsByTeam={configurationsByTeam}
          planningSnapshot={planningSnapshot}
          onCreateTaskOpen={onCreateTaskOpen}
          onCreateScheduleDependency={onCreateScheduleDependency}
          onDeleteScheduleDependency={onDeleteScheduleDependency}
          onRequestScheduleChange={onRequestScheduleChange}
          onSelectTask={onSelectTask}
          onUpdateScheduleDependency={onUpdateScheduleDependency}
          projectId={projectId}
          t={t}
          tasks={tasks}
        />
      ) : null}
      {activeTab === 'calendar' && !taskErrorMessage ? (
        <TaskCalendarView
          configuration={configuration}
          configurationsByTeam={configurationsByTeam}
          onCreateTaskOpen={onCreateTaskOpen}
          onRequestScheduleChange={onRequestScheduleChange}
          onSelectTask={onSelectTask}
          projectId={projectId}
          t={t}
          tasks={tasks}
        />
      ) : null}
    </div>
  )
}

/** Props accepted by a filter menu wrapper. */
type FilterMenuProps = {
  /** Whether the filter represented by the menu is active. */
  active?: boolean
  /** Side used to align the menu popover. */
  align?: 'left' | 'right'
  /** Stable id of the menu trigger. */
  buttonId: string
  /** Menu option nodes. */
  children: ReactNode
  /** Icon shown in the trigger. */
  icon: ReactNode
  /** Whether the menu is currently open. */
  isOpen: boolean
  /** Accessible and visible trigger label. */
  label: string
  /** Additional menu sizing classes. */
  menuClassName?: string
  /** Stable id of the menu element. */
  menuId: string
  /** Changes the menu open state. */
  onOpenChange: (isOpen: boolean) => void
}

/** Renders a filter trigger and its menu popover. */
function FilterMenu({
  active = false,
  align = 'left',
  buttonId,
  children,
  icon,
  isOpen,
  label,
  menuClassName = 'w-56 overflow-hidden',
  menuId,
  onOpenChange,
}: FilterMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const firstItem = menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitemradio"]:not([disabled])',
    )
    firstItem?.focus()

    /**
     * Closes this menu when pointer input begins outside its root.
     *
     * @param event - Pointer event whose target is compared with the menu root.
     * @returns Nothing.
     */
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown)
    }
  }, [isOpen, onOpenChange])

  /**
   * Closes the menu after keyboard focus leaves its trigger and items.
   *
   * @param event - Focus event whose next target determines whether the menu closes.
   * @returns Nothing.
   */
  const handleMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      onOpenChange(false)
    }
  }

  /**
   * Moves focus within the menu or closes it in response to menu keys.
   *
   * @param event - Keyboard event used to navigate or close the menu.
   * @returns Nothing.
   */
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]:not([disabled])',
      ),
    )

    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      document.getElementById(buttonId)?.focus()
      return
    }

    if (items.length === 0) {
      return
    }

    const currentIndex = items.findIndex(
      (item) => item === document.activeElement,
    )
    let nextIndex: number | undefined

    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex < 0
        ? items.length - 1
        : (currentIndex - 1 + items.length) % items.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = items.length - 1
    }

    if (nextIndex === undefined) {
      return
    }

    event.preventDefault()
    items[nextIndex]?.focus()
  }

  return (
    <div className="relative" ref={rootRef} onBlur={handleMenuBlur}>
      <FilterButton
        active={active}
        ariaControls={menuId}
        ariaExpanded={isOpen}
        ariaHaspopup="menu"
        icon={icon}
        id={buttonId}
        label={label}
        onClick={() => onOpenChange(!isOpen)}
      />
      {isOpen ? (
        <div
          aria-labelledby={buttonId}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} z-20 mt-2 rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)] ${menuClassName}`}
          id={menuId}
          ref={menuRef}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** Props accepted by an option in a task filter menu. */
type MenuOptionProps = {
  /** Whether the option is currently selected. */
  checked: boolean
  /** Visible option label. */
  label: string
  /** Selects the option. */
  onClick: () => void
}

/** Renders an accessible radio-style task filter option. */
function MenuOption({ checked, label, onClick }: MenuOptionProps) {
  return (
    <button
      aria-checked={checked}
      className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
        checked
          ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
          : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
      }`}
      onClick={onClick}
      role="menuitemradio"
      tabIndex={-1}
      type="button"
    >
      {label}
      {checked ? <CheckIcon /> : null}
    </button>
  )
}

/** Props accepted by a task filter trigger. */
type FilterButtonProps = {
  /** Whether the represented filter is active. */
  active?: boolean
  /** Id of the controlled menu. */
  ariaControls?: string
  /** Whether the controlled menu is expanded. */
  ariaExpanded?: boolean
  /** Popup role exposed by the trigger. */
  ariaHaspopup?: 'menu'
  /** Icon shown before the label. */
  icon: ReactNode
  /** Optional stable trigger id. */
  id?: string
  /** Accessible and visible label. */
  label: string
  /** Handles trigger activation. */
  onClick?: () => void
}

/** Renders a task toolbar filter trigger. */
function FilterButton({
  active = false,
  ariaControls,
  ariaExpanded,
  ariaHaspopup,
  icon,
  id,
  label,
  onClick,
}: FilterButtonProps) {
  return (
    <button
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      aria-label={label}
      className={`inline-flex h-9 min-w-[104px] items-center justify-between gap-2 rounded-md border bg-white px-3 text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
        active
          ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
          : 'border-[var(--workbench-border-strong)] text-[var(--workbench-text)] hover:border-[var(--workbench-primary)] hover:text-[var(--workbench-primary)]'
      }`}
      id={id}
      onClick={onClick}
      type="button"
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <ChevronIcon className="h-4 w-4" />
    </button>
  )
}

/** Props accepted by the common task toolbar SVG shell. */
type IconShellProps = {
  /** SVG path content. */
  children: ReactNode
  /** Optional icon size and position classes. */
  className?: string
}

/** Renders common SVG attributes for task toolbar icons. */
function IconShell({ children, className = '' }: IconShellProps) {
  return (
    <svg
      aria-hidden="true"
      className={className || 'h-5 w-5'}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  )
}

/** Renders the search icon. */
function SearchIcon({ className = 'h-5 w-5' }: { /** Icon CSS classes. */ className?: string }) {
  return <IconShell className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></IconShell>
}

/** Renders the generic filter icon. */
function FilterIcon() {
  return <IconShell><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" /></IconShell>
}

/** Renders the workflow status filter icon. */
function StatusIcon() {
  return <IconShell><path d="M6 14a6 6 0 1 0 12 0" /><path d="M12 2v6" /><path d="M8 6h8" /></IconShell>
}

/** Renders the assignee filter icon. */
function AssigneeIcon() {
  return <IconShell><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></IconShell>
}

/** Renders the date filter icon. */
function CalendarIcon() {
  return <IconShell><path d="M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" /></IconShell>
}

/** Renders the priority filter icon. */
function FlagIcon() {
  return <IconShell><path d="M5 21V5" /><path d="M5 5h12l-1.5 4L17 13H5" /></IconShell>
}

/** Renders the selected-option checkmark. */
function CheckIcon() {
  return <IconShell className="h-4 w-4"><path d="m5 12 4 4L19 6" /></IconShell>
}
