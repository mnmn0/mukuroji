import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  PlanningSnapshot,
  ResolvedWorkItemConfiguration,
  WorkItemDependencyEndpoint,
  WorkItemRelation,
  WorkItemSchedule,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
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
  type MessageKey,
} from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import type { WorkItemDefinitionFilter } from '../../work-items/model/workItemFilters'
import { resolveWorkItemPersonOptions } from '../../work-items/model/workItemDisplay'
import type { WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import type { WorkItemDependencyCreateDraft } from '../../work-items/ui/WorkItemDependencyPanel'
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
  resolveLatestTaskSnapshot,
  resolveProjectTaskConfiguration,
  type AssigneeFilter,
  type DueDateFilter,
  type PriorityFilter,
  type TaskCreateContext,
  type StatusFilter,
  type TaskSortOrder,
  type TaskTab,
} from '../model/taskView'
import {
  formatTaskScheduleRange,
  taskScheduleModeLabelKeys,
} from '../model/taskSchedule'
import { CreateTaskPanel } from './CreateTaskPanel'
import { TaskActionFeedback } from './TaskActionFeedback'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskHeader } from './TaskHeader'
import { TaskWorkspace } from './TaskWorkspace'
import { TaskSchedulePreviewMetadata } from './TaskSchedulePreviewMetadata'
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
  /** Patch that reapplies the successful update after an undo. */
  forwardPatch: UpdateTeamIssueInput
}

/** Most recently undone task update retained for redo. */
type TaskRedoState = {
  /** Task snapshot returned by the successful undo. */
  task: ProjectTask
  /** Patch that reapplies the original update. */
  forwardPatch: UpdateTeamIssueInput
}

/** Shared feedback state for create, edit, and move actions. */
type TaskActionState = {
  /** Visual severity of the feedback. */
  kind: 'success' | 'error'
  /** Localized feedback message. */
  message: string
}

/** Result of a task update that may require an explicit schedule confirmation. */
type TaskUpdateResult = {
  /** Whether persistence ran after the user confirmed the preview. */
  applied: boolean
  /** Updated task, or the original snapshot when the preview was cancelled. */
  task: ProjectTask
}

/** One revision-bound schedule update waiting for explicit user confirmation. */
type PendingTaskScheduleUpdate = {
  /** Original schedule operation confirmed against the preview's graph revisions. */
  operation: WorkItemScheduleOperation
  /** Server-owned direct and dependency impacts shown before applying. */
  preview: WorkItemScheduleChangePreview
  /** Rejects the originating edit when persistence fails. */
  reject: (error: unknown) => void
  /** Resolves the originating edit after apply or cancellation. */
  resolve: (result: TaskUpdateResult) => void
  /** Monotonic request order used when table batch previews finish out of order. */
  sequence: number
  /** Revision snapshot against which the preview was calculated. */
  task: ProjectTask
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
  /** Authoritative canonical Work Item dependency graph shared by all task views. */
  planningSnapshot?: PlanningSnapshot
  /** Whether canonical Planning dependency data or its permission projection is loading. */
  isPlanningLoading?: boolean
  /** Planning dependency load error shown without hiding Project tasks. */
  planningErrorMessage?: string
  /** Retries the canonical Planning dependency and permission queries. */
  onRetryPlanning?: () => void
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
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
  /** Previews one schedule operation against the current server revision. */
  onPreviewScheduleChange?: (
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Atomically confirms the original schedule operation and every dependency ripple. */
  onConfirmScheduleChange?: (
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<ProjectTask>
  /** Creates a canonical Work Item schedule dependency. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical Work Item schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Updates a canonical Work Item schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
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
  canManageScheduleDependencyEndpoint,
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
  isPlanningLoading = false,
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
  planningErrorMessage,
  planningSnapshot,
  onLoadMoreProjectUsers,
  onAddRelation,
  onDeleteRelation,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onSelectedIssueChange,
  onProjectQuickAccessToggle,
  onCreateTask,
  onRetryPlanning,
  onRetryConfigurations,
  onUpdateIssue,
  onUpdateTask,
  onPreviewScheduleChange,
  onConfirmScheduleChange,
  onCreateScheduleDependency,
  onDeleteScheduleDependency,
  onUpdateScheduleDependency,
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
  const [taskRedo, setTaskRedo] = useState<TaskRedoState>()
  const [isRestoringTask, setIsRestoringTask] = useState(false)
  const [scheduleUpdateQueue, setScheduleUpdateQueue] = useState<PendingTaskScheduleUpdate[]>([])
  const [isApplyingScheduleUpdate, setIsApplyingScheduleUpdate] = useState(false)
  const nextSchedulePreviewSequenceRef = useRef(0)
  const scheduleUpdateChainRef = useRef<Promise<void>>(Promise.resolve())
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
  const detailTask = isDetailOpen
    ? resolveLatestTaskSnapshot(selectedDetailTask, selectedIssueDetail?.issue)
    : undefined
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
      ...(context?.schedule ? { schedule: context.schedule } : {}),
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

    requestAnimationFrame(() => taskContentRef.current?.scrollTo({ top: scrollTop }))
  }

  /** Persists an already-confirmed task patch and retains an inverse for undo. */
  const persistTaskUpdate = async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ) => {
    if (!onUpdateTask) {
      return task
    }

    setTaskAction(undefined)

    try {
      const updatedTask = await onUpdateTask(task, input)
      setTaskUndo({
        forwardPatch: input,
        inversePatch: createTaskInversePatch(task, input),
        task: updatedTask,
      })
      setTaskRedo(undefined)
      setTaskAction({
        kind: 'success',
        message: t('tasks.action.saved'),
      })
      return updatedTask
    } catch (error) {
      const isRevisionConflict = isTaskRevisionConflict(error)
      if (isRevisionConflict) {
        setTaskUndo(undefined)
        setTaskRedo(undefined)
      }
      setTaskAction({
        kind: 'error',
        message: resolveTaskMutationErrorMessage(error, t),
      })
      throw error
    }
  }

  /**
   * Previews every schedule patch before allowing the shared persistence path to run.
   *
   * Concurrent table paste or fill-down previews are queued in invocation order so each
   * affected Work Item receives an explicit before/after confirmation.
   *
   * @param task - Revision-bound Work Item snapshot being changed.
   * @param input - Complete update patch, including a replacement schedule when applicable.
   * @returns Whether persistence ran and the resulting or unchanged task snapshot.
   */
  const performTaskUpdate = async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ): Promise<TaskUpdateResult> => {
    if (!input.schedule) {
      return {
        applied: true,
        task: await persistTaskUpdate(task, input),
      }
    }
    if (Object.keys(input).some((field) => field !== 'schedule')) {
      throw new Error(t('tasks.action.updateError'))
    }
    if (!onPreviewScheduleChange || !onConfirmScheduleChange) {
      throw new Error(t('tasks.action.updateError'))
    }

    const requestedSchedule = input.schedule
    const operation: WorkItemScheduleOperation = {
      schedule: requestedSchedule,
      type: 'replace',
    }
    const sequence = nextSchedulePreviewSequenceRef.current
    nextSchedulePreviewSequenceRef.current += 1
    const queuedUpdate = scheduleUpdateChainRef.current.then(async (): Promise<TaskUpdateResult> => {
      try {
        const preview = await onPreviewScheduleChange(task, operation)
        const schedule = findDirectScheduleImpact(preview, task)
        if (!schedule) {
          throw new Error('Schedule preview did not contain the target Work Item.')
        }

        return await new Promise<TaskUpdateResult>((resolve, reject) => {
          setScheduleUpdateQueue((current) => [...current, {
            operation,
            preview,
            reject,
            resolve,
            sequence,
            task,
          }])
        })
      } catch (error) {
        setTaskAction({
          kind: 'error',
          message: resolveTaskMutationErrorMessage(error, t),
        })
        throw error
      }
    })
    scheduleUpdateChainRef.current = queuedUpdate.then(
      () => undefined,
      () => undefined,
    )
    return await queuedUpdate
  }

  /**
   * Routes a task patch through schedule preview when needed.
   *
   * @param task - Revision-bound Work Item snapshot being changed.
   * @param input - Complete update patch.
   * @returns The resulting task, or the original snapshot after preview cancellation.
   */
  const handleUpdateTask = async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ): Promise<ProjectTask> => (await performTaskUpdate(task, input)).task

  const pendingScheduleUpdate = scheduleUpdateQueue[0]

  /** Applies the first queued schedule preview using its original revision snapshot. */
  const handleConfirmScheduleUpdate = async () => {
    if (!pendingScheduleUpdate || isApplyingScheduleUpdate) {
      return
    }

    setIsApplyingScheduleUpdate(true)
    try {
      const confirmedTask = await onConfirmScheduleChange?.(
        pendingScheduleUpdate.task,
        pendingScheduleUpdate.operation,
        pendingScheduleUpdate.preview,
      )
      if (!confirmedTask) throw new Error(t('tasks.action.updateError'))
      setTaskUndo(undefined)
      setTaskRedo(undefined)
      setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
      pendingScheduleUpdate.resolve({ applied: true, task: confirmedTask })
    } catch (error) {
      pendingScheduleUpdate.reject(error)
    } finally {
      setScheduleUpdateQueue((current) => current.filter(
        (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
      ))
      setIsApplyingScheduleUpdate(false)
    }
  }

  /** Cancels the first queued preview without mutating its Work Item. */
  const handleCancelScheduleUpdate = () => {
    if (!pendingScheduleUpdate || isApplyingScheduleUpdate) {
      return
    }
    pendingScheduleUpdate.resolve({ applied: false, task: pendingScheduleUpdate.task })
    setScheduleUpdateQueue((current) => current.filter(
      (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
    ))
  }

  /**
   * Confirms a Gantt or Calendar operation and retains its direct schedule for undo/redo.
   *
   * @param task - Revision-bound Work Item that initiated the timeline operation.
   * @param operation - Original move, resize, or replacement operation.
   * @param preview - Authoritative direct and dependency-cascade preview.
   * @returns Updated direct Work Item returned by the atomic confirmation.
   */
  const handleConfirmTimelineScheduleChange = async (
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ): Promise<ProjectTask> => {
    if (!onConfirmScheduleChange) {
      throw new Error(t('tasks.action.updateError'))
    }

    setTaskAction(undefined)
    try {
      const updatedTask = await onConfirmScheduleChange(task, operation, preview)
      const directImpact = preview.impacts.find((impact) =>
        impact.kind === 'direct' &&
        impact.teamId === task.teamId &&
        impact.workItemId === task.id
      )
      if (directImpact) {
        setTaskUndo({
          forwardPatch: { schedule: structuredClone(directImpact.after) },
          inversePatch: { schedule: structuredClone(directImpact.before) },
          task: updatedTask,
        })
        setTaskRedo(undefined)
      }
      setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
      return updatedTask
    } catch (error) {
      if (isTaskRevisionConflict(error)) {
        setTaskUndo(undefined)
        setTaskRedo(undefined)
      }
      setTaskAction({
        kind: 'error',
        message: resolveTaskMutationErrorMessage(error, t),
      })
      throw error
    }
  }

  /** Reverses the most recent successful inline task update. */
  const handleUndoTask = async () => {
    if (!taskUndo || !onUpdateTask || isRestoringTask) {
      return
    }

    setIsRestoringTask(true)

    try {
      const result = await performTaskUpdate(taskUndo.task, taskUndo.inversePatch)
      if (!result.applied) {
        setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
        return
      }
      setTaskRedo({
        forwardPatch: taskUndo.forwardPatch,
        task: result.task,
      })
      setTaskUndo(undefined)
      setTaskAction({
        kind: 'success',
        message: t('tasks.action.saved'),
      })
    } catch (error) {
      const isRevisionConflict = isTaskRevisionConflict(error)
      if (isRevisionConflict) {
        setTaskUndo(undefined)
        setTaskRedo(undefined)
      }
      setTaskAction({
        kind: 'error',
        message: resolveTaskMutationErrorMessage(error, t),
      })
    } finally {
      setIsRestoringTask(false)
    }
  }

  /** Reapplies the most recently undone inline task update. */
  const handleRedoTask = async () => {
    if (!taskRedo || !onUpdateTask || isRestoringTask) {
      return
    }

    setIsRestoringTask(true)

    try {
      const result = await performTaskUpdate(taskRedo.task, taskRedo.forwardPatch)
      if (!result.applied) {
        setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
        return
      }
      setTaskUndo({
        forwardPatch: taskRedo.forwardPatch,
        inversePatch: createTaskInversePatch(taskRedo.task, taskRedo.forwardPatch),
        task: result.task,
      })
      setTaskRedo(undefined)
      setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
    } catch (error) {
      const isRevisionConflict = isTaskRevisionConflict(error)
      if (isRevisionConflict) {
        setTaskUndo(undefined)
        setTaskRedo(undefined)
      }
      setTaskAction({
        kind: 'error',
        message: resolveTaskMutationErrorMessage(error, t),
      })
    } finally {
      setIsRestoringTask(false)
    }
  }

  /** Routes detail schedule edits through preview while preserving pane-local errors otherwise. */
  const handleUpdateDetailIssue = detailTask && (onUpdateTask || onUpdateIssue)
    ? async (
        teamId: string,
        issueId: string,
        input: UpdateTeamIssueInput,
      ): Promise<void> => {
        if (input.schedule && onUpdateTask) {
          await handleUpdateTask(detailTask, input)
          return
        }
        if (onUpdateIssue) {
          await onUpdateIssue(teamId, issueId, input)
          return
        }
        await handleUpdateTask(detailTask, input)
      }
    : onUpdateIssue

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
            {planningErrorMessage ? (
              <div
                className="mx-[clamp(20px,3vw,34px)] mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-5 py-4"
                data-testid="project-planning-error"
                role="alert"
              >
                <span className="text-sm font-semibold text-red-700">{planningErrorMessage}</span>
                {onRetryPlanning ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    onClick={onRetryPlanning}
                    type="button"
                  >
                    {t('planning.action.retry')}
                  </button>
                ) : null}
              </div>
            ) : isPlanningLoading ? (
              <p
                className="mx-[clamp(20px,3vw,34px)] mt-5 text-sm font-semibold text-[var(--workbench-muted)]"
                data-testid="project-planning-loading"
                role="status"
              >
                {t('planning.loading')}
              </p>
            ) : null}
            {taskAction ? (
              <TaskActionFeedback
                dismissLabel={t('tasks.action.dismiss')}
                kind={taskAction.kind}
                message={isRestoringTask
                  ? taskRedo ? t('tasks.action.redoing') : t('tasks.action.undoing')
                  : taskAction.message}
                onDismiss={() => {
                  setTaskAction(undefined)
                  setTaskUndo(undefined)
                  setTaskRedo(undefined)
                }}
                onUndo={!isRestoringTask && (taskUndo || taskRedo)
                  ? () => void (taskUndo ? handleUndoTask() : handleRedoTask())
                  : undefined}
                undoLabel={!isRestoringTask
                  ? taskUndo ? t('tasks.action.undo') : taskRedo ? t('tasks.action.redo') : undefined
                  : undefined}
              />
            ) : null}
            {isCreateTaskOpen && onCreateTask ? (
              <CreateTaskPanel
                key={createTaskContextKey(createTaskContext)}
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
                    setTaskRedo(undefined)
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
                canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
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
                onCreateScheduleDependency={onCreateScheduleDependency}
                onDeleteScheduleDependency={onDeleteScheduleDependency}
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
                onUpdateScheduleDependency={onUpdateScheduleDependency}
                onConfirmScheduleChange={onConfirmScheduleChange
                  ? handleConfirmTimelineScheduleChange
                  : undefined}
                onUpdateTask={onUpdateTask ? handleUpdateTask : undefined}
                onPreviewScheduleChange={onPreviewScheduleChange}
                onVisibleTaskSelectionChange={updateVisibleTaskSelection}
                personLabels={personLabels}
                personOptions={personOptions}
                priorityFilter={priorityFilter}
                projectFiles={projectFiles}
                projectId={projectId}
                projectMembers={projectMembers}
                projectMembersErrorMessage={projectMembersErrorMessage}
                projectName={resolvedProjectName}
                planningSnapshot={planningSnapshot}
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
                  canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
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
                  onCreateScheduleDependency={onCreateScheduleDependency}
                  onDeleteScheduleDependency={onDeleteScheduleDependency}
                  onAddRelation={onAddRelation}
                  onClose={handleCloseDetail}
                  onDeleteRelation={onDeleteRelation}
                  onUpdateIssue={detailTask &&
                      configurationFailedTeamIds.includes(detailTask.teamId)
                    ? undefined
                    : handleUpdateDetailIssue}
                  onUpdateScheduleDependency={onUpdateScheduleDependency}
                  planningSnapshot={planningSnapshot}
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
        {pendingScheduleUpdate ? (
          <TaskScheduleUpdatePreview
            isApplying={isApplyingScheduleUpdate}
            onCancel={handleCancelScheduleUpdate}
            onConfirm={() => void handleConfirmScheduleUpdate()}
            pending={pendingScheduleUpdate}
            t={t}
          />
        ) : null}
    </section>
  )
}

/** Props for the schedule preview shared by Table, Board, and detail updates. */
type TaskScheduleUpdatePreviewProps = {
  /** Whether the confirmed update is currently being persisted. */
  isApplying: boolean
  /** Cancels the pending update without persistence. */
  onCancel: () => void
  /** Applies the revision-bound direct schedule from the preview. */
  onConfirm: () => void
  /** First queued schedule update shown to the user. */
  pending: PendingTaskScheduleUpdate
  /** Translator for schedule labels and actions. */
  t: (key: MessageKey) => string
}

/**
 * Shows authoritative before/after and dependency impacts for non-timeline schedule edits.
 *
 * @param props - Pending preview, actions, and localized labels.
 * @returns An accessible modal confirmation dialog.
 */
function TaskScheduleUpdatePreview({
  isApplying,
  onCancel,
  onConfirm,
  pending,
  t,
}: TaskScheduleUpdatePreviewProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#101828]/40 p-4">
      <div
        aria-labelledby="task-schedule-update-preview-title"
        aria-modal="true"
        className="w-full max-w-xl rounded-xl bg-white p-5 shadow-2xl"
        data-testid="task-schedule-update-preview"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-lg font-bold text-[#101828]" id="task-schedule-update-preview-title">
          {t('bulk.preview.title')}
        </h2>
        <ul className="mt-4 grid gap-3">
          {pending.preview.impacts.map((impact) => (
            <li className="rounded-lg border border-[#d0d5dd] p-3" key={`${impact.teamId}:${impact.workItemId}:${impact.kind}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-semibold text-[#344054]">
                  {impact.teamId} / {impact.workItemId}
                </span>
                <span className="text-xs font-bold uppercase tracking-wide text-[#667085]">
                  {impact.kind === 'direct'
                    ? t('tasks.schedule.impact.direct')
                    : t('tasks.schedule.impact.dependency')}
                </span>
              </div>
              <p className="mt-2 text-sm text-[#475467]">
                <span className="font-semibold">{t('tasks.schedule.before')}: </span>
                <span className="line-through">{describeTaskSchedule(impact.before, t)}</span>
              </p>
              <p className="mt-1 text-sm font-semibold text-[#101828]">
                <span>{t('tasks.schedule.after')}: </span>
                <span>{describeTaskSchedule(impact.after, t)}</span>
              </p>
            </li>
          ))}
        </ul>
        <TaskSchedulePreviewMetadata preview={pending.preview} t={t} />
        {pending.preview.warnings.length > 0 ? (
          <div className="mt-4 rounded-lg border border-[#f4d38b] bg-[#fffaeb] p-3" role="status">
            <p className="text-sm font-bold text-[#93370d]">{t('tasks.schedule.warnings')}</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-[#93370d]">
              {pending.preview.warnings.map((warning) => (
                <li key={warning}>{resolveTaskScheduleWarning(warning, t)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[#d0d5dd] px-4 py-2 text-sm font-semibold text-[#344054] disabled:opacity-60"
            disabled={isApplying}
            onClick={onCancel}
            type="button"
          >
            {t('tasks.create.cancel')}
          </button>
          <button
            className="rounded-lg bg-[var(--workbench-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            data-testid="task-schedule-update-confirm"
            disabled={isApplying || pending.preview.conflicts.length > 0}
            onClick={onConfirm}
            type="button"
          >
            {isApplying ? t('bulk.applying') : t('bulk.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Finds the authoritative direct schedule for the task that initiated a preview.
 *
 * @param preview - Server preview containing direct and dependency impacts.
 * @param task - Task whose requested replacement is being validated.
 * @returns The server-owned direct after-schedule, when present.
 */
function findDirectScheduleImpact(
  preview: WorkItemScheduleChangePreview,
  task: ProjectTask,
): WorkItemSchedule | undefined {
  return preview.impacts.find((impact) =>
    impact.kind === 'direct' &&
    impact.teamId === task.teamId &&
    impact.workItemId === task.id
  )?.after
}

/**
 * Formats one explicit schedule without hiding its mode from assistive technology.
 *
 * @param schedule - Canonical schedule from a preview impact.
 * @param t - Translator used for the explicit mode label.
 * @returns A compact localized description.
 */
function describeTaskSchedule(
  schedule: WorkItemSchedule,
  t: (key: MessageKey) => string,
): string {
  const range = formatTaskScheduleRange(schedule)
  return `${t(taskScheduleModeLabelKeys[schedule.mode])}${range ? `: ${range}` : ''}`
}

/**
 * Resolves a safe shared mutation error while retaining permission and conflict reasons.
 *
 * @param error - Unknown preview or persistence failure.
 * @param t - Translator used for the client-safe message.
 * @returns A localized reason suitable for the shared action alert.
 */
function resolveTaskMutationErrorMessage(
  error: unknown,
  t: (key: MessageKey) => string,
): string {
  if (error instanceof TeamIssuesApiError) {
    if (isTaskSchedulePreviewStaleCode(error.code)) {
      return t('tasks.schedule.previewStale')
    }
    if (error.code === 'WorkItemRevisionConflict') {
      return t('tasks.action.conflict')
    }
    if (error.status === 403) {
      return t('tasks.action.permission')
    }
    if (error.status === 400) {
      return t('tasks.schedule.invalid')
    }
  }
  return t('tasks.action.updateError')
}

/** Returns whether a stable API code invalidates a previously displayed schedule preview. */
function isTaskSchedulePreviewStaleCode(code: string | undefined): boolean {
  return code === 'WorkItemSchedulePreviewStale' ||
    code === 'PlanningRevisionConflict' ||
    code === 'WorkItemRelationGraphConflict' ||
    code === 'WorkItemAuthorizationChanged' ||
    code === 'WorkItemScheduleDependencyConflict' ||
    code === 'WorkItemScheduleCascadeConflict'
}

/**
 * Identifies the revision conflict that invalidates local undo and redo snapshots.
 *
 * @param error - Unknown mutation failure.
 * @returns True only for the stable Work Item revision conflict code.
 */
function isTaskRevisionConflict(error: unknown): boolean {
  return error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict'
}

/**
 * Maps a stable preview warning to localized review guidance.
 *
 * @param warning - Warning code returned by the schedule preview endpoint.
 * @param t - Translator used for known and generic warning text.
 * @returns Localized warning guidance.
 */
function resolveTaskScheduleWarning(
  warning: string,
  t: (key: MessageKey) => string,
): string {
  if (warning === 'DependencyRippleRequiresReview') {
    return t('tasks.schedule.warning.dependencyRipple')
  }
  return warning === 'SemanticBlockRelationsDoNotReschedule'
    ? t('tasks.schedule.warning.semanticBlocks')
    : t('tasks.schedule.warning.generic')
}

/**
 * Serializes the complete create context so uncontrolled schedule inputs remount on any change.
 *
 * @param context - View-derived create context or the default header context.
 * @returns A stable React key that includes every schedule field.
 */
function createTaskContextKey(context: TaskCreateContext | undefined): string {
  return JSON.stringify(context ?? { source: 'header' })
}
