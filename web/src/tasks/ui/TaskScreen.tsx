import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  ResolvedWorkItemConfiguration,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  clearSucceededBulkSelection,
  updateBulkItemSelection,
  type BulkOperationSelection,
} from '../../bulk-operations/model/bulkOperation'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import type { IssueCollaborationController } from '../../issues/mutations/useIssueCollaboration'
import { TeamIssuesApiError, type TeamIssue, type TeamIssueDetail, type UpdateTeamIssueInput } from '../../issues/api'
import type {
  ProjectDirectoryTeam,
  ProjectMember,
  ProjectUser,
  UpdateProjectMemberInput,
} from '../../projects/api'
import {
  createTranslator,
  type Locale,
} from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import type { WorkItemDefinitionFilter } from '../../work-items/model/workItemFilters'
import { resolveWorkItemPersonOptions } from '../../work-items/model/workItemDisplay'
import type { WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import type { CreateProjectTaskInput, ProjectTask } from '../api/tasks'
import {
  createBulkOperationSelection,
  createBulkProjectOptions,
  createProjectTaskStatusColumns,
  createTaskKey,
  createTaskInversePatch,
  createTaskPersonLabels,
  filterAndSortProjectTasks,
  findTaskBySelection,
  resolveEffectiveDefinitionFilter,
  resolveEffectiveStatusFilter,
  resolveProjectTaskConfiguration,
  type AssigneeFilter,
  type DueDateFilter,
  type PriorityFilter,
  type TaskCreateContext,
  type StatusFilter,
  type TaskSortOrder,
  type TaskTab,
} from '../model/taskView'
import { CreateTaskPanel } from './CreateTaskPanel'
import { TaskActionFeedback } from './TaskActionFeedback'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskHeader } from './TaskHeader'
import { TaskWorkspace } from './TaskWorkspace'
import { createTaskTabId, taskTabPanelId } from './taskTabAccessibility'

const emptyProjectMembers: ProjectMember[] = []
const emptyProjectUsers: ProjectUser[] = []
const emptyTeamIssues: TeamIssue[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
const emptyResolvedWorkItemConfigurations: Record<string, ResolvedWorkItemConfiguration> = {}
const emptyConfigurationTeamIds: string[] = []
const emptyBulkOperationSelections: BulkOperationSelection[] = []

/** Bulk task selection scoped to one Project route. */
type TaskBulkSelectionState = {
  /** Revision snapshots selected for a bulk operation. */
  items: BulkOperationSelection[]
  /** Project whose task snapshots are selected. */
  projectId: string
}

/** Last successful inline update retained for a reversible task action. */
type TaskUndoState = {
  /** Task snapshot returned by the successful update. */
  task: ProjectTask
  /** Patch that restores every field touched by the update. */
  inversePatch: UpdateTeamIssueInput
}

/** Shared feedback state for create, edit, and move actions. */
type TaskActionState = {
  /** Visual severity of the feedback. */
  kind: 'success' | 'error'
  /** Localized feedback message. */
  message: string
}

/** Props accepted by the task management screen. */
export type TaskScreenProps = {
  /** Workspace ID included in bulk operation requests. */
  workspaceId?: string
  /** Access token used to load related documents. */
  accessToken?: string
  /** Locale used for labels, dates, and form validation. */
  locale: Locale
  /** Project currently displayed by the screen. */
  projectId: string
  /** Whether the displayed Project is currently available from quick access. */
  isProjectQuickAccess?: boolean
  /** Whether a quick-access change is currently being persisted. */
  isProjectQuickAccessSaving?: boolean
  /** Initial displayed in the current-user avatar. */
  userInitial: string
  /** Team and Project hierarchy shown by the sidebar. */
  teams: ProjectDirectoryTeam[]
  /** Display name of the current Project. */
  projectName?: string
  /** Display name of the current Project's selected Team. */
  teamName?: string
  /** Team through which the current Project was selected. */
  activeProjectTeamId?: string
  /** Whether the task route is still loading its required data. */
  isLoading?: boolean
  /** Project tasks loaded from the API. */
  tasks?: ProjectTask[]
  /** Project members available as task assignees. */
  assigneeOptions?: ProjectMember[]
  /** Whether assignee candidates are being loaded. */
  isAssigneeOptionsLoading?: boolean
  /** Error shown when assignee candidates could not be loaded. */
  assigneeErrorMessage?: string
  /** Project members shown by the permissions tab. */
  projectMembers?: ProjectMember[]
  /** Workspace users available to add to the Project. */
  projectUsers?: ProjectUser[]
  /** Whether Project user candidates are being loaded. */
  isProjectUsersLoading?: boolean
  /** Error shown when Project user candidates could not be loaded. */
  projectUsersErrorMessage?: string
  /** Opaque cursor for the next Project user page. */
  projectUsersNextToken?: string
  /** Current Project user search query. */
  projectUserQuery?: string
  /** Whether the current user is a system administrator. */
  isSystemAdmin?: boolean
  /** Whether the current user may manage Project member roles. */
  canManageProjectMembers?: boolean
  /** Error shown when Project permissions could not be loaded or changed. */
  projectMembersErrorMessage?: string
  /** Error shown when Project tasks could not be loaded. */
  taskErrorMessage?: string
  /** Task view selected when the screen first mounts. */
  initialTab?: TaskTab
  /** Whether the inline create form should open on initial render. */
  defaultCreateTaskOpen?: boolean
  /** Work Item ID selected by the route when the screen first renders. */
  initialSelectedTaskId?: string
  /** Detail, relations, comments, and activity for the selected Work Item. */
  selectedIssueDetail?: TeamIssueDetail
  /** Single-Team Work Item configuration used by list and create controls. */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /** Team-scoped Work Item configurations used by aggregate Project views. */
  resolvedConfigurationsByTeam?: Record<string, ResolvedWorkItemConfiguration>
  /** Team IDs whose Work Item configuration failed to load. */
  configurationFailedTeamIds?: string[]
  /** Error shown when one or more Work Item configurations could not be loaded. */
  configurationErrorMessage?: string
  /** Retries failed Work Item configuration requests. */
  onRetryConfigurations?: () => void
  /** Same-Team Work Items available as relation targets. */
  relationCandidates?: TeamIssue[]
  /** Whether relation target candidates are being loaded. */
  isRelationCandidatesLoading?: boolean
  /** Error shown when relation target candidates could not be loaded. */
  relationCandidatesErrorMessage?: string
  /** Controller for selected Work Item comments, watchers, and presence. */
  collaboration?: IssueCollaborationController
  /** File controller scoped to the selected Work Item. */
  artifacts?: FileArtifactsController
  /** File controller scoped to the current Project. */
  projectFiles?: FileArtifactsController
  /** Workspace members used by mention, actor, and person-field controls. */
  workspaceMembers?: WorkspaceMember[]
  /** Current Workspace member key used by collaboration and file approvals. */
  currentWorkspaceMemberKey?: string
  /** Comment selected by a notification deep link. */
  focusedCommentId?: string
  /** Root comment containing the selected reply. */
  focusedRootCommentId?: string
  /** Whether the selected Work Item detail is being loaded. */
  isSelectedIssueDetailLoading?: boolean
  /** Error shown when selected Work Item detail could not be loaded or updated. */
  detailErrorMessage?: string
  /** Changes the Work Item selected by the detail pane. */
  onSelectedIssueChange?: (task: ProjectTask) => void
  /** Adds or removes the displayed Project from quick access. */
  onProjectQuickAccessToggle?: () => void
  /** Updates editable fields on the selected Work Item. */
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  /** Updates any visible Work Item through the shared optimistic action. */
  onUpdateTask?: (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ) => Promise<ProjectTask>
  /** Creates a relation from the selected Work Item. */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Deletes a relation from the selected Work Item. */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Creates a Project task from a view-aware inline form. */
  onCreateTask?: (input: CreateProjectTaskInput, context?: TaskCreateContext) => Promise<void>
  /** Loads the next page of Project user candidates. */
  onLoadMoreProjectUsers?: () => Promise<void>
  /** Changes the Project user search query. */
  onProjectUserQueryChange?: (query: string) => void
  /** Adds or updates a Project member role. */
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
  /** Removes a member from the Project. */
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  /** Previews validation and effects for a bulk operation. */
  onBulkPreview?: (request: BulkOperationRequest) => Promise<BulkOperationPreview>
  /** Applies a previously previewed bulk operation. */
  onBulkApply?: (
    request: BulkOperationRequest,
    preview: BulkOperationPreview,
  ) => Promise<BulkOperation>
  /** Retries retryable failed items in a bulk operation. */
  onBulkRetry?: (operationId: string) => Promise<BulkOperation>
  /** Undoes successful items in a bulk operation. */
  onBulkUndo?: (operationId: string) => Promise<BulkOperation>
}

/**
 * Renders the task management screen and owns its transient view state.
 *
 * @param props - Route data, controllers, and mutation callbacks for the task experience.
 * @returns The complete task screen with sidebar, views, and selected-task detail.
 */
export function TaskScreen({
  workspaceId = '',
  accessToken,
  locale,
  projectId,
  isProjectQuickAccess = false,
  isProjectQuickAccessSaving = false,
  userInitial,
  teams,
  projectName,
  teamName,
  activeProjectTeamId,
  assigneeErrorMessage,
  assigneeOptions = emptyProjectMembers,
  canManageProjectMembers = false,
  collaboration,
  artifacts,
  configurationErrorMessage,
  currentWorkspaceMemberKey,
  defaultCreateTaskOpen = false,
  detailErrorMessage,
  focusedCommentId,
  focusedRootCommentId,
  initialSelectedTaskId,
  initialTab = 'table',
  isAssigneeOptionsLoading = false,
  isProjectUsersLoading = false,
  isRelationCandidatesLoading = false,
  isSelectedIssueDetailLoading = false,
  isSystemAdmin = false,
  isLoading = false,
  projectMembers = emptyProjectMembers,
  projectFiles,
  projectMembersErrorMessage,
  projectUserQuery = '',
  projectUsers = emptyProjectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  relationCandidates = emptyTeamIssues,
  relationCandidatesErrorMessage,
  resolvedConfiguration,
  resolvedConfigurationsByTeam = emptyResolvedWorkItemConfigurations,
  configurationFailedTeamIds = emptyConfigurationTeamIds,
  selectedIssueDetail,
  tasks = [],
  taskErrorMessage,
  onLoadMoreProjectUsers,
  onAddRelation,
  onDeleteRelation,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onSelectedIssueChange,
  onProjectQuickAccessToggle,
  onCreateTask,
  onRetryConfigurations,
  onUpdateIssue,
  onUpdateTask,
  onUpdateProjectMember,
  onBulkPreview,
  onBulkApply,
  onBulkRetry,
  onBulkUndo,
  workspaceMembers = emptyWorkspaceMembers,
}: TaskScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const [activeTab, setActiveTab] = useState<TaskTab>(initialTab)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [definitionFilter, setDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [dueDateFilter, setDueDateFilter] = useState<DueDateFilter>('all')
  const [sortOrder, setSortOrder] = useState<TaskSortOrder>('due-date-asc')
  const [bulkSelection, setBulkSelection] = useState<TaskBulkSelectionState>({
    items: [],
    projectId,
  })
  const [localSelectedDetailTaskKey, setLocalSelectedDetailTaskKey] = useState<string>()
  const [isDetailOpen, setIsDetailOpen] = useState(true)
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(defaultCreateTaskOpen)
  const [createTaskContext, setCreateTaskContext] = useState<TaskCreateContext>()
  const [createTaskError, setCreateTaskError] = useState<string>()
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [taskAction, setTaskAction] = useState<TaskActionState>()
  const [taskUndo, setTaskUndo] = useState<TaskUndoState>()
  const [isUndoingTask, setIsUndoingTask] = useState(false)
  const detailScrollTopRef = useRef(0)
  const taskContentRef = useRef<HTMLDivElement>(null)
  const resolvedProjectName = projectName ?? projectId
  const resolvedActiveTeam = activeProjectTeamId
    ? teams.find((team) =>
        team.id === activeProjectTeamId &&
        team.projects.some((project) => project.id === projectId)
      )
    : undefined
  const resolvedActiveTeamId = activeProjectTeamId
  const resolvedTeamName = teamName ?? resolvedActiveTeam?.name ?? ''
  const activeTeamProjects = resolvedActiveTeam?.projects ?? []
  const configuration = resolvedConfiguration?.configuration
  const statusColumns = useMemo(
    () => createProjectTaskStatusColumns(
      tasks,
      resolvedConfigurationsByTeam,
      teams,
      resolvedActiveTeamId,
      configuration,
    ),
    [configuration, resolvedActiveTeamId, resolvedConfigurationsByTeam, tasks, teams],
  )
  const personLabels = useMemo(
    () => createTaskPersonLabels(workspaceMembers),
    [workspaceMembers],
  )
  const personOptions = useMemo(
    () => resolveWorkItemPersonOptions(workspaceMembers),
    [workspaceMembers],
  )

  useEffect(() => {
    if (defaultCreateTaskOpen) {
      queueMicrotask(() => setIsCreateTaskOpen(true))
    }
  }, [defaultCreateTaskOpen])

  useEffect(() => {
    if (bulkSelection.projectId !== projectId) {
      queueMicrotask(() => setBulkSelection((currentSelection) =>
        currentSelection.projectId === projectId
          ? currentSelection
          : { items: [], projectId }
      ))
    }
  }, [bulkSelection.projectId, projectId])

  const effectiveStatusFilter = resolveEffectiveStatusFilter(statusFilter, statusColumns)
  const effectiveDefinitionFilter = useMemo(
    () => resolveEffectiveDefinitionFilter(definitionFilter, configuration),
    [configuration, definitionFilter],
  )
  const visibleTasks = useMemo(
    () => filterAndSortProjectTasks(tasks, {
      assigneeFilter,
      configuration,
      configurationsByTeam: resolvedConfigurationsByTeam,
      definitionFilter: effectiveDefinitionFilter,
      dueDateFilter,
      locale,
      personLabels,
      priorityFilter,
      searchQuery,
      sortOrder,
      statusColumns,
      statusFilter: effectiveStatusFilter,
      t,
    }),
    [
      assigneeFilter,
      configuration,
      dueDateFilter,
      effectiveDefinitionFilter,
      effectiveStatusFilter,
      locale,
      personLabels,
      priorityFilter,
      resolvedConfigurationsByTeam,
      searchQuery,
      sortOrder,
      statusColumns,
      t,
      tasks,
    ],
  )
  const bulkProjectOptions = useMemo(() => createBulkProjectOptions(teams), [teams])
  const selectedBulkItems = bulkSelection.projectId === projectId
    ? bulkSelection.items
    : emptyBulkOperationSelections
  const selectedTaskKeys = useMemo(
    () => selectedBulkItems.map((item) => item.selectionKey),
    [selectedBulkItems],
  )
  const visibleBulkItems = useMemo(
    () => visibleTasks.map((task) => createBulkOperationSelection(task, t)),
    [t, visibleTasks],
  )
  const selectedDetailTask =
    (localSelectedDetailTaskKey
      ? tasks.find((task) => createTaskKey(task) === localSelectedDetailTaskKey)
      : undefined) ??
    findTaskBySelection(tasks, initialSelectedTaskId, activeProjectTeamId) ??
    visibleTasks[0] ??
    tasks[0]
  const detailTask = isDetailOpen ? selectedDetailTask : undefined
  const selectedDetailTaskKey = selectedDetailTask
    ? createTaskKey(selectedDetailTask)
    : undefined
  const selectedDetailTeamProjects = detailTask
    ? teams.find((team) => team.id === detailTask.teamId)?.projects ?? activeTeamProjects
    : activeTeamProjects
  const createConfiguration = createTaskContext?.teamId
    ? resolvedConfigurationsByTeam[createTaskContext.teamId]?.configuration ?? configuration
    : configuration

  /** Updates one task's Project-scoped bulk selection snapshot. */
  const updateTaskSelection = (taskKey: string, selected: boolean) => {
    const task = tasks.find((candidate) => createTaskKey(candidate) === taskKey)
    const availableItems = task ? [createBulkOperationSelection(task, t)] : []

    setBulkSelection((currentSelection) => ({
      items: updateBulkItemSelection(
        currentSelection.projectId === projectId ? currentSelection.items : [],
        availableItems,
        [taskKey],
        selected,
      ),
      projectId,
    }))
  }

  /** Updates bulk selection snapshots for the currently visible tasks. */
  const updateVisibleTaskSelection = (selectionKeys: string[], selected: boolean) => {
    setBulkSelection((currentSelection) => ({
      items: updateBulkItemSelection(
        currentSelection.projectId === projectId ? currentSelection.items : [],
        visibleBulkItems,
        selectionKeys,
        selected,
      ),
      projectId,
    }))
  }

  /** Removes successfully processed tasks from the current bulk selection. */
  const handleBulkOperationComplete = (operation: BulkOperation) => {
    setBulkSelection((currentSelection) => {
      if (currentSelection.projectId !== projectId) {
        return currentSelection
      }

      const currentItems = currentSelection.items
      const nextSelectionKeys = new Set(clearSucceededBulkSelection(
        currentItems.map((item) => item.selectionKey),
        currentItems,
        operation,
      ))

      return {
        items: currentItems.filter((item) => nextSelectionKeys.has(item.selectionKey)),
        projectId,
      }
    })
  }

  /** Selects a task locally or delegates route-controlled selection to the caller. */
  const handleSelectDetailTask = (task: ProjectTask) => {
    setIsDetailOpen(true)
    if (!onSelectedIssueChange) {
      setLocalSelectedDetailTaskKey(createTaskKey(task))
    }

    onSelectedIssueChange?.(task)
    restoreDetailScrollTop()
  }

  /** Closes the detail pane without losing the current list position. */
  const handleCloseDetail = () => {
    detailScrollTopRef.current = taskContentRef.current?.scrollTop ?? 0
    setIsDetailOpen(false)
  }

  /** Opens the shared create panel with context inherited from a task view. */
  const handleCreateTaskOpen = (context?: TaskCreateContext) => {
    const defaultTeamId = activeProjectTeamId ?? teams.find((team) =>
      team.projects.some((project) => project.id === projectId),
    )?.id
    const resolvedContext: TaskCreateContext = {
      projectId: context?.projectId ?? projectId,
      source: context?.source ?? 'header',
      ...(context?.assigneeUserId ? { assigneeUserId: context.assigneeUserId } : {}),
      ...(context?.dueDate ? { dueDate: context.dueDate } : {}),
      ...(context?.teamId ?? defaultTeamId
        ? { teamId: context?.teamId ?? defaultTeamId }
        : {}),
      ...(context?.workflowStatusId
        ? { workflowStatusId: context.workflowStatusId }
        : {}),
    }
    setCreateTaskError(undefined)
    setCreateTaskContext(resolvedContext)
    setIsCreateTaskOpen(true)
    taskContentRef.current?.scrollTo({ top: 0 })
  }

  /** Restores the list scroll position captured when the detail pane closed. */
  const restoreDetailScrollTop = () => {
    const scrollTop = detailScrollTopRef.current

    if (scrollTop === 0) {
      return
    }

    queueMicrotask(() => taskContentRef.current?.scrollTo({ top: scrollTop }))
  }

  /** Updates a task through the shared action and retains an inverse for undo. */
  const handleUpdateTask = async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ) => {
    if (!onUpdateTask) {
      return task
    }

    setTaskAction(undefined)
    setTaskUndo(undefined)

    try {
      const updatedTask = await onUpdateTask(task, input)
      setTaskUndo({
        inversePatch: createTaskInversePatch(task, input),
        task: updatedTask,
      })
      setTaskAction({
        kind: 'success',
        message: t('tasks.action.saved'),
      })
      return updatedTask
    } catch (error) {
      setTaskAction({
        kind: 'error',
        message: error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict'
          ? t('tasks.action.conflict')
          : t('tasks.action.updateError'),
      })
      throw error
    }
  }

  /** Reverses the most recent successful inline task update. */
  const handleUndoTask = async () => {
    if (!taskUndo || !onUpdateTask || isUndoingTask) {
      return
    }

    setIsUndoingTask(true)
    setTaskAction(undefined)

    try {
      await onUpdateTask(taskUndo.task, taskUndo.inversePatch)
      setTaskUndo(undefined)
      setTaskAction({
        kind: 'success',
        message: t('tasks.action.saved'),
      })
    } catch (error) {
      setTaskAction({
        kind: 'error',
        message: error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict'
          ? t('tasks.action.conflict')
          : t('tasks.action.updateError'),
      })
    } finally {
      setIsUndoingTask(false)
    }
  }

  return (
    <section aria-busy={isLoading} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TaskHeader
          activeTab={activeTab}
          isProjectQuickAccess={isProjectQuickAccess}
          isProjectQuickAccessSaving={isProjectQuickAccessSaving}
          isCreateTaskOpen={isCreateTaskOpen}
          onCreateTaskOpenChange={onCreateTask ? (isOpen) => {
            if (isOpen) {
              handleCreateTaskOpen()
            } else {
              setIsCreateTaskOpen(false)
            }
          } : undefined}
          onMobileSidebarOpen={openMobileSidebar}
          onProjectQuickAccessToggle={onProjectQuickAccessToggle}
          onTabChange={setActiveTab}
          projectName={resolvedProjectName}
          t={t}
          tasks={tasks}
          teamName={resolvedTeamName}
          userInitial={userInitial}
        />

        {isLoading ? (
          <div
            className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-semibold text-[#5f6874]"
            role="status"
          >
            {t('tasks.loading')}
          </div>
        ) : (
          <div
            className="workbench-main min-h-0 flex-1 overflow-auto overscroll-contain"
            data-testid="task-main-scroll"
            ref={taskContentRef}
          >
            {configurationErrorMessage ? (
              <div
                className="mx-[clamp(20px,3vw,34px)] mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-5 py-4 text-sm font-semibold text-red-700"
                data-testid="project-configuration-error"
                role="alert"
              >
                <span>{configurationErrorMessage}</span>
                {onRetryConfigurations ? (
                  <button
                    className="underline underline-offset-2"
                    onClick={onRetryConfigurations}
                    type="button"
                  >
                    {t('collaboration.retry')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {taskAction ? (
              <TaskActionFeedback
                dismissLabel={t('tasks.action.dismiss')}
                kind={taskAction.kind}
                message={isUndoingTask ? t('tasks.action.undoing') : taskAction.message}
                onDismiss={() => {
                  setTaskAction(undefined)
                  setTaskUndo(undefined)
                }}
                onUndo={taskUndo && !isUndoingTask ? () => void handleUndoTask() : undefined}
                undoLabel={taskUndo && !isUndoingTask ? t('tasks.action.undo') : undefined}
              />
            ) : null}
            {isCreateTaskOpen && onCreateTask ? (
              <CreateTaskPanel
                key={`${createTaskContext?.source ?? 'header'}:${createTaskContext?.teamId ?? ''}:${createTaskContext?.workflowStatusId ?? ''}:${createTaskContext?.dueDate ?? ''}`}
                assigneeErrorMessage={assigneeErrorMessage}
                assigneeOptions={assigneeOptions}
                configuration={createConfiguration}
                context={createTaskContext}
                errorMessage={createTaskError}
                isAssigneeOptionsLoading={isAssigneeOptionsLoading}
                isSubmitting={isCreatingTask}
                locale={locale}
                onCancel={() => {
                  setCreateTaskError(undefined)
                  setCreateTaskContext(undefined)
                  setIsCreateTaskOpen(false)
                }}
                onSubmit={async (input) => {
                  setCreateTaskError(undefined)
                  setIsCreatingTask(true)

                  try {
                    await onCreateTask(input, createTaskContext)
                    setTaskUndo(undefined)
                    setTaskAction({
                      kind: 'success',
                      message: t('tasks.action.saved'),
                    })
                    setCreateTaskContext(undefined)
                    setIsCreateTaskOpen(false)
                  } catch (error) {
                    setCreateTaskError(
                      error instanceof Error ? error.message : t('tasks.create.error'),
                    )
                  } finally {
                    setIsCreatingTask(false)
                  }
                }}
                projectId={projectId}
                t={t}
                workspaceMembers={workspaceMembers}
              />
            ) : null}
            <RelatedDocuments
              accessToken={accessToken}
              t={t}
              targetId={projectId}
              targetKind="project"
            />
            <div
              aria-labelledby={createTaskTabId(activeTab)}
              className={`grid min-h-full ${activeTab === 'permissions' || activeTab === 'file' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(360px,440px)] max-[1180px]:grid-cols-1'}`}
              id={taskTabPanelId}
              role="tabpanel"
            >
              <TaskWorkspace
                activeTab={activeTab}
                allTasks={tasks}
                assigneeOptions={assigneeOptions}
                assigneeFilter={assigneeFilter}
                bulkProjectOptions={bulkProjectOptions}
                bulkWorkspaceId={workspaceId}
                canManageProjectMembers={canManageProjectMembers}
                configuration={configuration}
                configurationFailedTeamIds={configurationFailedTeamIds}
                configurationsByTeam={resolvedConfigurationsByTeam}
                currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                definitionFilter={effectiveDefinitionFilter}
                dueDateFilter={dueDateFilter}
                isProjectMembersLoading={isAssigneeOptionsLoading}
                isProjectUsersLoading={isProjectUsersLoading}
                isSystemAdmin={isSystemAdmin}
                locale={locale}
                onAssigneeFilterChange={setAssigneeFilter}
                onBulkApply={onBulkApply}
                onBulkOperationComplete={handleBulkOperationComplete}
                onBulkPreview={onBulkPreview}
                onBulkRetry={onBulkRetry}
                onBulkUndo={onBulkUndo}
                onCreateTaskOpen={onCreateTask ? handleCreateTaskOpen : undefined}
                onDefinitionFilterChange={setDefinitionFilter}
                onDueDateFilterChange={setDueDateFilter}
                onLoadMoreProjectUsers={onLoadMoreProjectUsers}
                onPriorityFilterChange={setPriorityFilter}
                onProjectUserQueryChange={onProjectUserQueryChange}
                onRemoveProjectMember={onRemoveProjectMember}
                onSearchQueryChange={setSearchQuery}
                onSelectTask={handleSelectDetailTask}
                onSortOrderChange={setSortOrder}
                onStatusFilterChange={setStatusFilter}
                onTaskSelectionChange={updateTaskSelection}
                onUpdateProjectMember={onUpdateProjectMember}
                onUpdateTask={onUpdateTask ? handleUpdateTask : undefined}
                onVisibleTaskSelectionChange={updateVisibleTaskSelection}
                personLabels={personLabels}
                personOptions={personOptions}
                priorityFilter={priorityFilter}
                projectFiles={projectFiles}
                projectId={projectId}
                projectMembers={projectMembers}
                projectMembersErrorMessage={projectMembersErrorMessage}
                projectName={resolvedProjectName}
                projectUserQuery={projectUserQuery}
                projectUsers={projectUsers}
                projectUsersErrorMessage={projectUsersErrorMessage}
                projectUsersNextToken={projectUsersNextToken}
                searchQuery={searchQuery}
                selectedBulkItems={selectedBulkItems}
                selectedDetailTaskKey={selectedDetailTaskKey}
                selectedTaskKeys={selectedTaskKeys}
                sortOrder={sortOrder}
                statusColumns={statusColumns}
                statusFilter={effectiveStatusFilter}
                t={t}
                taskErrorMessage={taskErrorMessage}
                tasks={visibleTasks}
                visibleBulkItems={visibleBulkItems}
                workspaceMembers={workspaceMembers}
              />
              {activeTab === 'permissions' || activeTab === 'file' ? null : (
                <TaskDetailPane
                  accessToken={accessToken}
                  assigneeOptions={assigneeOptions}
                  artifacts={artifacts}
                  collaboration={collaboration}
                  configuration={detailTask
                    ? resolveProjectTaskConfiguration(
                        detailTask,
                        resolvedConfigurationsByTeam,
                        configuration,
                      )
                    : configuration}
                  currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                  detail={selectedIssueDetail}
                  errorMessage={detailErrorMessage}
                  focusedCommentId={focusedCommentId}
                  focusedRootCommentId={focusedRootCommentId}
                  isLoading={isSelectedIssueDetailLoading}
                  isRelationCandidatesLoading={isRelationCandidatesLoading}
                  key={`${detailTask?.teamId ?? ''}:${detailTask?.id ?? ''}`}
                  locale={locale}
                  onAddRelation={onAddRelation}
                  onClose={handleCloseDetail}
                  onDeleteRelation={onDeleteRelation}
                  onUpdateIssue={detailTask &&
                      configurationFailedTeamIds.includes(detailTask.teamId)
                    ? undefined
                    : onUpdateIssue}
                  projects={selectedDetailTeamProjects}
                  relationCandidates={relationCandidates}
                  relationCandidatesErrorMessage={relationCandidatesErrorMessage}
                  t={t}
                  task={detailTask}
                  workspaceMembers={workspaceMembers}
                />
              )}
            </div>
          </div>
        )}
    </section>
  )
}
