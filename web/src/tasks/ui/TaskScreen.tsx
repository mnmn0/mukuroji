import {
  type ProjectTaskViewScope,
  type WorkItemActionContext,
  type WorkItemActionId,
  type WorkItemActionResult,
  type WorkItemActionSelection,
  type WorkItemActionTarget,
  type BulkOperation,
  type BulkOperationPreview,
  type BulkOperationRequest,
  type PlanningSnapshot,
  type ResolvedWorkItemConfiguration,
  type TaskViewDefinition,
  type WorkItemDependencyEndpoint,
  type WorkItemRelation,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleOperation,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  clearSucceededBulkSelection,
  updateBulkItemSelection,
  type BulkOperationSelection,
} from '../../bulk-operations/model/bulkOperation'
import {
  createBulkOperationTaskActionResult,
  createBulkPreviewTaskActionResult,
} from '../../bulk-operations/model/bulkOperationTaskAction'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import type { IssueCollaborationController } from '../../issues/mutations/useIssueCollaboration'
import type { IssueCollaborationRoute } from '../../issues/model/collaborationTabs'
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
import { WorkItemConfigurationApiError } from '../../work-items/api'
import { resolveWorkItemPersonOptions } from '../../work-items/model/workItemDisplay'
import type { WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import {
  createTaskViewActionSelection,
  createFocusedTaskViewActionSelection,
  createTaskViewItemKey,
  createTaskViewSelectionKeyboardAction,
  createTaskViewSelectionState,
  reduceTaskViewSelection,
  type TaskViewSelectionState,
} from '../../task-views/model/taskViewSelection'
import { applyTaskViewDefinitionToTasks } from '../../task-views/model/taskViewSurfaceState'
import type { TaskViewPresentationSettings } from '../../task-views/model/taskViewPresentation'
import {
  allowTaskAction,
  createCancelledTaskActionResult,
  createFailedTaskActionResult,
  createFailedTaskActionResults,
  createSucceededTaskCreateActionResult,
  createSucceededTaskActionResult,
  createSucceededTaskActionMutationResult,
  denyTaskAction,
  resolveTaskActionExecutionFailureMessage,
  type TaskActionExecutionResult,
} from '../../task-views/model/taskActionRegistry'
import {
  beginProjectTaskDirectSchedulePreview,
  cancelAwaitingProjectTaskDirectSchedule,
  claimProjectTaskDirectActionTarget,
  clearProjectTaskDirectActionRequest,
  completeProjectTaskDirectScheduleMutation,
  consumeProjectTaskDirectActionRequest,
  createProjectTaskDirectPatchRequest,
  createProjectTaskDirectScheduleHandle,
  createProjectTaskDirectScheduleRequest,
  failProjectTaskDirectSchedule,
  isSupportedProjectTaskDirectPatch,
  publishProjectTaskDirectSchedulePreview,
  readProjectTaskDirectSchedulePhase,
  releaseProjectTaskDirectActionTarget,
  resolveProjectTaskDirectActionTarget,
  waitForProjectTaskDirectScheduleDecision,
  type ProjectTaskDirectActionInFlight,
  type ProjectTaskDirectActionRequest,
  type ProjectTaskDirectActionRequestSlot,
  type ProjectTaskDirectScheduleHandle,
} from '../../task-views/model/projectTaskDirectActionRequest'
import {
  cancelPendingTaskActionContext,
  canDismissCompletedTaskActionOwner,
  createTaskActionCompletionBridge,
  isPendingTaskActionFocusCurrent,
  isPendingTaskActionExplicitSelectionCurrent,
  resolvePendingTaskActionContext,
} from '../../task-views/model/taskActionCompletion'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import {
  resolveProjectTaskActionTarget,
  resolveProjectTaskActionTargets,
  useProjectTaskActions,
  type ProjectTaskActionDisabledReasons,
  type ProjectTaskActionHandlers,
  type ProjectTaskActionLabels,
  type ProjectTaskActionPermissions,
} from '../../task-views/mutations/useProjectTaskActions'
import { createTaskSurfaceActionBaseContext } from '../../task-views/mutations/useTaskSurfaceActions'
import { TaskActionContextMenu } from '../../task-views/ui/TaskActionContextMenu'
import {
  createTaskSurfaceKeyboardInput,
  formatTaskSurfaceKeyboardShortcut,
} from '../../task-views/ui/taskSurfaceKeyboard'
import type {
  BulkOperationTaskActionInterruption,
  BulkOperationTaskActionRequest,
} from '../../bulk-operations/ui/BulkOperationToolbar'
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
  matchesProjectTaskKeyword,
  resolveEffectiveDefinitionFilter,
  resolveEffectiveStatusFilter,
  resolveLatestTaskSnapshot,
  resolveProjectTaskConfiguration,
  type AssigneeFilter,
  type DueDateFilter,
  type PriorityFilter,
  type TaskCreateContext,
  type TaskScreenViewState,
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
import type { ProjectTaskActionMenuOpenHandler } from './projectTaskActionMenu'
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
  /** Opaque token returned by the canonical action result and consumed by this undo state. */
  undoToken: string
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

/** Transient context-menu target retained independently from bulk selection. */
type TaskActionContextMenuState = {
  /** Pointer or overflow-control position used by the responsive menu layout. */
  anchorPoint: TaskActionContextMenuAnchorPoint
  /** Element that regains focus after dismissal. */
  returnFocusElement: HTMLElement
  /** Revision-bound target selected by this specific row or card entrance. */
  selection: WorkItemActionSelection
}

/** Result of a task update that may require an explicit schedule confirmation. */
type TaskUpdateResult = {
  /** Whether persistence ran after the user confirmed the preview. */
  applied: boolean
  /** Updated task, or the original snapshot when the preview was cancelled. */
  task: ProjectTask
}

/** Persisted Project Create outcome returned by the route-level mutation. */
type CreatedProjectTaskMutation = {
  /** Canonical Work Item created by persistence. */
  task: ProjectTask
  /** Application-relative route opened after creation, including retained view state. */
  navigationPath: string
}

/** One revision-bound schedule update waiting for explicit user confirmation. */
type PendingTaskScheduleUpdate = {
  /** Exact canonical Schedule invocation that owns this preview, when registry-initiated. */
  actionContext?: WorkItemActionContext
  /** Exact direct patch request that owns this preview, when installed by a surface control. */
  directRequest?: ProjectTaskDirectActionRequest
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
  /** Saved task view active when canonical actions are invoked. */
  activeTaskViewId?: string
  /** Shared saved-view lifecycle and display controls rendered above task filters. */
  taskViewToolbar?: ReactNode
  /** Complete effective definition used for multi-value filtering and sorting. */
  taskViewDefinition?: TaskViewDefinition
  /** Presentation settings rendered by table and board layouts. */
  taskViewPresentation?: TaskViewPresentationSettings
  /** Optional route-controlled task view state. */
  viewState?: TaskScreenViewState
  /** Persists one complete next route-controlled task view state. */
  onViewStateChange?: (state: TaskScreenViewState) => void
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
  /** Checks exact Team-qualified Project write scope for one concrete Work Item. */
  canMutateTask?: (task: ProjectTask) => boolean
  /** Whether the current Workspace member may read Team Triage source links. */
  canAccessTriage?: boolean
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
  /** Detail, relations, and activity for the selected Work Item. */
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
  /** Route-owned collaboration section and deep-link state. */
  collaborationRoute?: IssueCollaborationRoute
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
  ) => Promise<ProjectTask | void>
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
  onCreateTask?: (
    input: CreateProjectTaskInput,
    context?: TaskCreateContext,
  ) => Promise<CreatedProjectTaskMutation | void>
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
  onBulkRetry?: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
  /** Undoes successful items in a bulk operation. */
  onBulkUndo?: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
}

/**
 * Renders the task management screen and owns its transient view state.
 *
 * @param props - Route data, controllers, and mutation callbacks for the task experience.
 * @returns The complete task screen with sidebar, views, and selected-task detail.
 */
export function TaskScreen({
  activeTaskViewId,
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
  canAccessTriage = false,
  canManageProjectMembers = false,
  canMutateTask,
  canManageScheduleDependencyEndpoint,
  collaboration,
  collaborationRoute,
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
  taskViewToolbar,
  taskViewDefinition,
  taskViewPresentation,
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
  onViewStateChange,
  viewState,
  workspaceMembers = emptyWorkspaceMembers,
}: TaskScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const [localActiveTab, setLocalActiveTab] = useState<TaskTab>(initialTab)
  const [localSearchQuery, setLocalSearchQuery] = useState('')
  const [localStatusFilter, setLocalStatusFilter] = useState<StatusFilter>('all')
  const [localDefinitionFilter, setLocalDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const [localAssigneeFilter, setLocalAssigneeFilter] = useState<AssigneeFilter>('all')
  const [localPriorityFilter, setLocalPriorityFilter] = useState<PriorityFilter>('all')
  const [localDueDateFilter, setLocalDueDateFilter] = useState<DueDateFilter>('all')
  const [localSortOrder, setLocalSortOrder] = useState<TaskSortOrder>('due-date-asc')
  const [bulkSelection, setBulkSelection] = useState<TaskBulkSelectionState>({
    items: [],
    projectId,
  })
  const [bulkTaskActionRequest, setBulkTaskActionRequest] = useState<
    BulkOperationTaskActionRequest
  >()
  const [bulkTaskActionEpoch, setBulkTaskActionEpoch] = useState(0)
  const [taskViewSelection, setTaskViewSelection] = useState<TaskViewSelectionState>(
    createTaskViewSelectionState,
  )
  const [localSelectedDetailTaskKey, setLocalSelectedDetailTaskKey] = useState<string>()
  const [isDetailOpen, setIsDetailOpen] = useState(true)
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(defaultCreateTaskOpen)
  const [createTaskContext, setCreateTaskContext] = useState<TaskCreateContext>()
  const [createTaskError, setCreateTaskError] = useState<string>()
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [taskAction, setTaskAction] = useState<TaskActionState>()
  const [taskActionContextMenuState, setTaskActionContextMenuState] = useState<
    TaskActionContextMenuState
  >()
  const [taskActionCompletion] = useState(createTaskActionCompletionBridge)
  const [taskUndo, setTaskUndo] = useState<TaskUndoState>()
  const [taskRedo, setTaskRedo] = useState<TaskRedoState>()
  const [isRestoringTask, setIsRestoringTask] = useState(false)
  const [scheduleUpdateQueue, setScheduleUpdateQueue] = useState<PendingTaskScheduleUpdate[]>([])
  const [isApplyingScheduleUpdate, setIsApplyingScheduleUpdate] = useState(false)
  const scheduleUpdateQueueRef = useRef<PendingTaskScheduleUpdate[]>([])
  const isApplyingScheduleUpdateRef = useRef(false)
  const nextSchedulePreviewSequenceRef = useRef(0)
  const nextBulkTaskActionRequestIdRef = useRef(0)
  const nextBulkTaskActionEpochRef = useRef(0)
  const bulkTaskActionContextsRef = useRef(new Map<number, WorkItemActionContext>())
  const directTaskActionRequestSlotRef = useRef<ProjectTaskDirectActionRequestSlot>({
    current: undefined,
  })
  const directTaskActionsInFlightRef = useRef<ProjectTaskDirectActionInFlight>(new Map())
  const directTaskActionResultsRef = useRef(
    new WeakMap<ProjectTaskDirectActionRequest, ProjectTask>(),
  )
  const directTaskActionErrorsRef = useRef(
    new WeakMap<ProjectTaskDirectActionRequest, unknown>(),
  )
  const scheduleUpdateChainRef = useRef<Promise<void>>(Promise.resolve())
  const detailScrollTopRef = useRef(0)
  const taskContentRef = useRef<HTMLDivElement>(null)
  const pendingCreateTaskContextRef = useRef<TaskCreateContext | undefined>(undefined)
  const onSelectedIssueChangeRef = useRef(onSelectedIssueChange)
  const onConfirmScheduleChangeRef = useRef(onConfirmScheduleChange)
  const onPreviewScheduleChangeRef = useRef(onPreviewScheduleChange)
  const onUpdateTaskRef = useRef(onUpdateTask)
  const tasksRef = useRef(tasks)
  const performTaskUpdateRef = useRef<(
    task: ProjectTask,
    input: UpdateTeamIssueInput,
    actionContext?: WorkItemActionContext,
    directRequest?: ProjectTaskDirectActionRequest,
  ) => Promise<TaskUpdateResult>>(undefined)

  useEffect(() => {
    onSelectedIssueChangeRef.current = onSelectedIssueChange
  }, [onSelectedIssueChange])
  useEffect(() => {
    onConfirmScheduleChangeRef.current = onConfirmScheduleChange
    onPreviewScheduleChangeRef.current = onPreviewScheduleChange
    onUpdateTaskRef.current = onUpdateTask
    tasksRef.current = tasks
  }, [onConfirmScheduleChange, onPreviewScheduleChange, onUpdateTask, tasks])
  useEffect(() => {
    scheduleUpdateQueueRef.current = scheduleUpdateQueue
  }, [scheduleUpdateQueue])
  useEffect(() => {
    isApplyingScheduleUpdateRef.current = isApplyingScheduleUpdate
  }, [isApplyingScheduleUpdate])
  useEffect(() => () => {
    taskActionCompletion.cancel()
    const applyingSequence = isApplyingScheduleUpdateRef.current
      ? scheduleUpdateQueueRef.current[0]?.sequence
      : undefined
    for (const request of directTaskActionsInFlightRef.current.values()) {
      const ownsApplyingPreview = scheduleUpdateQueueRef.current.some((pending) =>
        pending.sequence === applyingSequence && pending.directRequest === request
      )
      if (ownsApplyingPreview) continue
      cancelAwaitingProjectTaskDirectSchedule(request)
    }
    for (const pending of scheduleUpdateQueueRef.current) {
      if (pending.sequence === applyingSequence) continue
      pending.resolve({ applied: false, task: pending.task })
    }
  }, [taskActionCompletion])

  const activeTab = localActiveTab === 'file' || localActiveTab === 'permissions'
    ? localActiveTab
    : viewState?.activeTab ?? localActiveTab
  const assigneeFilter = viewState?.assigneeFilter ?? localAssigneeFilter
  const definitionFilter = viewState?.definitionFilter ?? localDefinitionFilter
  const dueDateFilter = viewState?.dueDateFilter ?? localDueDateFilter
  const priorityFilter = viewState?.priorityFilter ?? localPriorityFilter
  const searchQuery = viewState?.searchQuery ?? localSearchQuery
  const sortOrder = viewState?.sortOrder ?? localSortOrder
  const statusFilter = viewState?.statusFilter ?? localStatusFilter
  const currentViewState: TaskScreenViewState = {
    activeTab,
    assigneeFilter,
    definitionFilter,
    dueDateFilter,
    priorityFilter,
    searchQuery,
    sortOrder,
    statusFilter,
  }

  /** Applies one complete view state locally and forwards it to the route controller. */
  const commitViewState = (nextViewState: TaskScreenViewState) => {
    setLocalActiveTab(nextViewState.activeTab)
    setLocalAssigneeFilter(nextViewState.assigneeFilter)
    setLocalDefinitionFilter(nextViewState.definitionFilter)
    setLocalDueDateFilter(nextViewState.dueDateFilter)
    setLocalPriorityFilter(nextViewState.priorityFilter)
    setLocalSearchQuery(nextViewState.searchQuery)
    setLocalSortOrder(nextViewState.sortOrder)
    setLocalStatusFilter(nextViewState.statusFilter)
    onViewStateChange?.(nextViewState)
  }
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
    () => taskViewDefinition
      ? applyTaskViewDefinitionToTasks(tasks, taskViewDefinition, {
          keywordMatcher: (task, normalizedKeyword) => matchesProjectTaskKeyword(
            task,
            normalizedKeyword,
            configuration,
            resolvedConfigurationsByTeam,
            locale,
            personLabels,
            t,
          ),
        })
      : filterAndSortProjectTasks(tasks, {
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
      taskViewDefinition,
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
  const visibleActionTargets = useMemo<WorkItemActionTarget[]>(
    () => visibleTasks.map((task) => ({
      expectedRevision: task.revision,
      teamId: task.teamId,
      workItemId: task.id,
    })),
    [visibleTasks],
  )
  const visibleTaskViewKeys = useMemo(
    () => visibleActionTargets.map((target) =>
      createTaskViewItemKey(target.teamId, target.workItemId)
    ),
    [visibleActionTargets],
  )
  const selectedBulkTaskViewKeys = useMemo(
    () => selectedBulkItems.map((item) =>
      createTaskViewItemKey(item.teamId, item.workItemId)
    ),
    [selectedBulkItems],
  )
  const taskActionSelection = useMemo(
    () => createTaskViewActionSelection(taskViewSelection, visibleActionTargets),
    [taskViewSelection, visibleActionTargets],
  )
  const bulkTaskActionSelection = useMemo<WorkItemActionSelection>(() => ({
    mode: selectedBulkItems.length === 0
      ? 'none'
      : selectedBulkItems.length === 1
        ? 'single'
        : 'multiple',
    targets: selectedBulkItems.map((item) => ({
      expectedRevision: item.expectedRevision,
      teamId: item.teamId,
      workItemId: item.workItemId,
    })),
    ...(taskActionSelection.focusedTarget
      ? { focusedTarget: taskActionSelection.focusedTarget }
      : {}),
    ...(taskActionSelection.anchorTarget
      ? { anchorTarget: taskActionSelection.anchorTarget }
      : {}),
  }), [selectedBulkItems, taskActionSelection.anchorTarget, taskActionSelection.focusedTarget])

  useEffect(() => {
    const pendingContext = taskActionCompletion.current()
    if (pendingContext && pendingContext.actionId !== 'create') {
      const isCurrent = isBulkTaskActionId(pendingContext.actionId)
        ? isPendingTaskActionExplicitSelectionCurrent(pendingContext, bulkTaskActionSelection)
        : isPendingTaskActionFocusCurrent(pendingContext, taskActionSelection)
      if (!isCurrent) {
        taskActionCompletion.cancel(pendingContext.actionId)
      }
    }
    const focusedTarget = taskActionSelection.focusedTarget
    for (const request of directTaskActionsInFlightRef.current.values()) {
      if (request.input.kind !== 'schedule-operation') continue
      const focusCurrent = focusedTarget?.teamId === request.target.teamId &&
        focusedTarget.workItemId === request.target.workItemId &&
        focusedTarget.expectedRevision === request.target.expectedRevision
      if (!focusCurrent && cancelAwaitingProjectTaskDirectSchedule(request)) {
        releaseProjectTaskDirectActionTarget(directTaskActionsInFlightRef.current, request)
      }
    }
  }, [bulkTaskActionSelection, taskActionCompletion, taskActionSelection])

  useEffect(() => {
    const visibleKeySet = new Set(visibleTaskViewKeys)
    queueMicrotask(() => {
      setBulkSelection((currentSelection) => {
        if (currentSelection.projectId !== projectId) return currentSelection
        const items = currentSelection.items.filter((item) => visibleKeySet.has(
          createTaskViewItemKey(item.teamId, item.workItemId),
        ))
        return items.length === currentSelection.items.length
          ? currentSelection
          : { items, projectId }
      })
    })
  }, [projectId, visibleTaskViewKeys])

  useEffect(() => {
    const selectedKeySet = new Set(selectedBulkTaskViewKeys)
    queueMicrotask(() => {
      setTaskViewSelection((currentSelection) => {
        const prunedSelection = reduceTaskViewSelection(currentSelection, {
          availableKeys: visibleTaskViewKeys,
          type: 'prune',
        })
        const selectedKeys = visibleTaskViewKeys.filter((key) => selectedKeySet.has(key))
        const nextSelection = { ...prunedSelection, selectedKeys }
        return areTaskViewSelectionsEqual(currentSelection, nextSelection)
          ? currentSelection
          : nextSelection
      })
    })
  }, [selectedBulkTaskViewKeys, visibleTaskViewKeys])

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
  const canMutateDetailTask = detailTask !== undefined &&
    (canMutateTask?.(detailTask) ?? true)
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

  /**
   * Selects a task locally or delegates route-controlled selection to the caller.
   *
   * @param task - Task that becomes the focused detail owner.
   * @param preservePendingAction - Whether an accepted action already owns this exact selection.
   */
  const handleSelectDetailTask = useCallback((
    task: ProjectTask,
    preservePendingAction = false,
  ) => {
    if (!preservePendingAction) taskActionCompletion.cancel()
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(task.teamId, task.id),
      type: 'focus',
    }))
    setIsDetailOpen(true)
    if (!onSelectedIssueChangeRef.current) {
      setLocalSelectedDetailTaskKey(createTaskKey(task))
    }

    onSelectedIssueChangeRef.current?.(task)
    const scrollTop = detailScrollTopRef.current
    if (scrollTop !== 0) {
      requestAnimationFrame(() => taskContentRef.current?.scrollTo({ top: scrollTop }))
    }
  }, [taskActionCompletion])

  /** Dismisses a superseded create editor without completing another invocation. */
  const dismissCreateTaskEditor = useCallback(() => {
    setCreateTaskError(undefined)
    setCreateTaskContext(undefined)
    setIsCreateTaskOpen(false)
  }, [])

  /**
   * Dismisses a superseded detail editor and any preview owned by its exact invocation.
   *
   * @param context - Exact awaiting action whose editor no longer owns user input.
   */
  const dismissTaskDetailEditor = useCallback((context: WorkItemActionContext) => {
    setIsDetailOpen(false)
    setScheduleUpdateQueue((current) => {
      const cancelled = current.filter((candidate) => candidate.actionContext === context)
      for (const candidate of cancelled) {
        candidate.resolve({ applied: false, task: candidate.task })
      }
      return cancelled.length === 0
        ? current
        : current.filter((candidate) => candidate.actionContext !== context)
    })
  }, [])

  /** Closes the detail pane without losing the current list position. */
  const handleCloseDetail = () => {
    taskActionCompletion.cancel()
    detailScrollTopRef.current = taskContentRef.current?.scrollTop ?? 0
    setIsDetailOpen(false)
  }

  /** Opens the shared create panel without cancelling its newly accepted invocation. */
  const showCreateTaskEditor = useCallback((context?: TaskCreateContext) => {
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
  }, [activeProjectTeamId, projectId, teams])

  /** Persists an already-confirmed task patch and retains an inverse for undo. */
  const persistTaskUpdate = useCallback(async (
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
        undoToken: createTaskUpdateUndoToken(updatedTask),
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
  }, [onUpdateTask, t])

  /**
   * Previews every schedule patch before allowing the shared persistence path to run.
   *
   * Concurrent table paste or fill-down previews are queued in invocation order so each
   * affected Work Item receives an explicit before/after confirmation.
   *
   * @param task - Revision-bound Work Item snapshot being changed.
   * @param input - Complete update patch, including a replacement schedule when applicable.
   * @param actionContext - Exact canonical Schedule invocation that owns this preview.
   * @param directRequest - Exact surface request cancelled if preview ownership is lost.
   * @returns Whether persistence ran and the resulting or unchanged task snapshot.
   */
  const performTaskUpdate = useCallback(async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
    actionContext?: WorkItemActionContext,
    directRequest?: ProjectTaskDirectActionRequest,
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
        if (directRequest && readProjectTaskDirectSchedulePhase(directRequest) === 'cancelled') {
          return { applied: false, task }
        }
        const preview = await onPreviewScheduleChange(task, operation)
        const schedule = findDirectScheduleImpact(preview, task)
        if (!schedule) {
          throw new Error('Schedule preview did not contain the target Work Item.')
        }
        if (
          (actionContext && taskActionCompletion.current() !== actionContext) ||
          (directRequest && readProjectTaskDirectSchedulePhase(directRequest) === 'cancelled')
        ) {
          return { applied: false, task }
        }

        return await new Promise<TaskUpdateResult>((resolve, reject) => {
          const pendingUpdate: PendingTaskScheduleUpdate = {
            ...(actionContext !== undefined ? { actionContext } : {}),
            ...(directRequest !== undefined ? { directRequest } : {}),
            operation,
            preview,
            reject,
            resolve,
            sequence,
            task,
          }
          scheduleUpdateQueueRef.current = [
            ...scheduleUpdateQueueRef.current,
            pendingUpdate,
          ]
          setScheduleUpdateQueue((current) => [...current, pendingUpdate])
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
  }, [
    onConfirmScheduleChange,
    onPreviewScheduleChange,
    persistTaskUpdate,
    t,
    taskActionCompletion,
  ])
  useEffect(() => {
    performTaskUpdateRef.current = performTaskUpdate
  }, [performTaskUpdate])

  const pendingScheduleUpdate = scheduleUpdateQueue[0]

  /** Applies the first queued schedule preview using its original revision snapshot. */
  const handleConfirmScheduleUpdate = async () => {
    if (!pendingScheduleUpdate || isApplyingScheduleUpdate) {
      return
    }

    const pendingActionContext = pendingScheduleUpdate.actionContext
    if (pendingActionContext && !taskActionCompletion.claim(pendingActionContext)) return
    isApplyingScheduleUpdateRef.current = true
    setIsApplyingScheduleUpdate(true)
    try {
      const confirmedTask = await onConfirmScheduleChange?.(
        pendingScheduleUpdate.task,
        pendingScheduleUpdate.operation,
        pendingScheduleUpdate.preview,
      )
      if (!confirmedTask) throw new Error(t('tasks.action.updateError'))
      const directImpact = pendingScheduleUpdate.preview.impacts.find((impact) =>
        impact.kind === 'direct' &&
        impact.teamId === pendingScheduleUpdate.task.teamId &&
        impact.workItemId === pendingScheduleUpdate.task.id
      )
      if (directImpact) {
        setTaskUndo({
          forwardPatch: { schedule: structuredClone(directImpact.after) },
          inversePatch: { schedule: structuredClone(directImpact.before) },
          task: confirmedTask,
          undoToken: createTaskUpdateUndoToken(confirmedTask),
        })
      } else {
        setTaskUndo(undefined)
      }
      setTaskRedo(undefined)
      setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
      pendingScheduleUpdate.resolve({ applied: true, task: confirmedTask })
    } catch (error) {
      pendingScheduleUpdate.reject(error)
    } finally {
      scheduleUpdateQueueRef.current = scheduleUpdateQueueRef.current.filter(
        (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
      )
      setScheduleUpdateQueue((current) => current.filter(
        (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
      ))
      isApplyingScheduleUpdateRef.current = false
      setIsApplyingScheduleUpdate(false)
    }
  }

  /** Cancels the first queued preview without mutating its Work Item. */
  const handleCancelScheduleUpdate = () => {
    if (!pendingScheduleUpdate || isApplyingScheduleUpdate) {
      return
    }
    if (pendingScheduleUpdate.actionContext) {
      taskActionCompletion.cancelContext(pendingScheduleUpdate.actionContext)
    }
    pendingScheduleUpdate.resolve({ applied: false, task: pendingScheduleUpdate.task })
    scheduleUpdateQueueRef.current = scheduleUpdateQueueRef.current.filter(
      (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
    )
    setScheduleUpdateQueue((current) => current.filter(
      (candidate) => candidate.sequence !== pendingScheduleUpdate.sequence,
    ))
  }

  /** Reverses the most recent successful inline task update. */
  const handleUndoTask = async () => {
    if (
      !taskUndo ||
      !onUpdateTask ||
      isRestoringTask ||
      !isTaskUpdateUndoTokenForTask(taskUndo.undoToken, taskUndo.task)
    ) {
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
        undoToken: createTaskUpdateUndoToken(result.task),
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
        const pendingCandidate = resolvePendingTaskActionContext(
          taskActionCompletion,
          ['edit', 'relation', 'schedule'],
          { teamId, workItemId: issueId },
        )
        const pendingContext = pendingCandidate && (
          (pendingCandidate.actionId === 'schedule' && input.schedule !== undefined) ||
          (pendingCandidate.actionId === 'edit' && input.schedule === undefined)
        )
          ? pendingCandidate
          : undefined
        if (pendingCandidate && !pendingContext) {
          taskActionCompletion.cancelContext(pendingCandidate)
        }
        const target = pendingContext
          ? resolveProjectTaskActionTarget(pendingContext)
          : undefined
        const claimedContext = pendingContext && !input.schedule && target &&
            taskActionCompletion.claim(pendingContext)
          ? pendingContext
          : input.schedule
            ? pendingContext
            : undefined

        try {
          let updatedTask: ProjectTask | undefined
          if (input.schedule && onUpdateTask) {
            const result = await performTaskUpdate(detailTask, input, pendingContext)
            if (!result.applied) {
              if (pendingContext) taskActionCompletion.cancelContext(pendingContext)
              return
            }
            updatedTask = result.task
          } else if (onUpdateIssue) {
            const result = await onUpdateIssue(teamId, issueId, input)
            if (result) {
              updatedTask = result
              setTaskUndo({
                forwardPatch: input,
                inversePatch: createTaskInversePatch(detailTask, input),
                task: result,
                undoToken: createTaskUpdateUndoToken(result),
              })
              setTaskRedo(undefined)
              setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
            }
          } else {
            updatedTask = (await performTaskUpdate(detailTask, input)).task
          }
          if (claimedContext && target) {
            taskActionCompletion.settle(claimedContext, createSucceededTaskActionMutationResult(
              claimedContext.actionId,
              target,
              updatedTask?.revision,
              updatedTask ? createTaskUpdateUndoToken(updatedTask) : undefined,
            ))
          }
        } catch (error) {
          if (claimedContext) {
            const isConflict = isTaskRevisionConflict(error)
            const canDismissOwner = canDismissCompletedTaskActionOwner(
              taskActionCompletion,
              claimedContext,
            )
            taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
              claimedContext.actionId,
              target,
              isConflict ? 'WorkItemRevisionConflict' : 'ProjectTaskActionMutationFailed',
              isConflict ? 'conflict' : 'unknown',
              resolveTaskMutationErrorMessage(error, t),
              isConflict,
            ))
            if (canDismissOwner) dismissTaskDetailEditor(claimedContext)
          }
          throw error
        }
      }
    : undefined
  /** Cancels an accepted Schedule action when explicit save detects no mutation. */
  const handleProjectScheduleNoChange = useCallback((teamId: string, issueId: string) => {
    cancelPendingTaskActionContext(
      taskActionCompletion,
      ['schedule'],
      { teamId, workItemId: issueId },
    )
  }, [taskActionCompletion])
  const bulkTaskActionsAvailable = Boolean(
    workspaceId && onBulkPreview && onBulkApply,
  )
  const canCreateTaskAction = onCreateTask !== undefined
  const canDirectTaskAction = onUpdateTask !== undefined
  const canEditTaskAction = onUpdateTask !== undefined || onUpdateIssue !== undefined
  const canManageTaskRelationAction = onAddRelation !== undefined

  const projectTaskActionLabels = useMemo<ProjectTaskActionLabels>(() => ({
    archive: t('taskViews.action.archive'),
    assign: t('taskViews.action.assign'),
    create: t('taskViews.action.create'),
    edit: t('taskViews.action.edit'),
    move: t('taskViews.action.move'),
    open: t('taskViews.action.open'),
    relation: t('taskViews.action.relation'),
    schedule: t('taskViews.action.schedule'),
    watch: t('taskViews.action.watch'),
  }), [t])
  const projectTaskActionDisabledReasons = useMemo<ProjectTaskActionDisabledReasons>(
    () => ({
      selectionRequired: t('taskViews.action.selectionRequired'),
      singleSelectionRequired: t('taskViews.action.singleSelectionRequired'),
      unavailable: t('taskViews.action.unavailable'),
    }),
    [t],
  )

  /** Cancels every direct Schedule request that still awaits preview or user confirmation. */
  const cancelAwaitingDirectTaskScheduleActions = useCallback(() => {
    for (const request of directTaskActionsInFlightRef.current.values()) {
      if (cancelAwaitingProjectTaskDirectSchedule(request)) {
        releaseProjectTaskDirectActionTarget(directTaskActionsInFlightRef.current, request)
      }
    }
  }, [])

  /** Opens one permission-safe task and optionally focuses a detail control. */
  const executeTaskDetailAction = useCallback((
    context: WorkItemActionContext,
    controlSelector?: string,
    waitForMutation = false,
  ): Promise<WorkItemActionResult> | WorkItemActionResult => {
    cancelAwaitingDirectTaskScheduleActions()
    const target = resolveProjectTaskActionTarget(context)
    const task = target
      ? tasks.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    if (!target || !task) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'ProjectTaskActionTargetNotFound',
        'not-found',
        t('taskViews.action.notFound'),
      )
    }

    const completion = waitForMutation
      ? taskActionCompletion.begin(
          context,
          dismissTaskDetailEditor,
        )
      : undefined
    if (!completion) taskActionCompletion.cancel()
    handleSelectDetailTask(task, true)
    if (controlSelector) focusTaskDetailControl(controlSelector)
    return completion ?? createSucceededTaskActionResult(context.actionId, target)
  }, [
    cancelAwaitingDirectTaskScheduleActions,
    dismissTaskDetailEditor,
    handleSelectDetailTask,
    t,
    taskActionCompletion,
    tasks,
  ])

  /**
   * Consumes and executes a direct patch before falling back to detail or bulk action controls.
   *
   * Consumption, current-revision validation, and per-target ownership all finish before the
   * first asynchronous preview or persistence call. An installed mismatch is terminal and never
   * opens a selector or bulk editor intended for a different invocation.
   *
   * @param context - Canonical context accepted by shared permission and validation.
   * @returns Canonical direct mutation result, or undefined when no direct request was installed.
   */
  const executeProjectTaskDirectAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult | Promise<WorkItemActionResult> | undefined => {
    const requestSlot = directTaskActionRequestSlotRef.current
    const installedRequest = requestSlot.current
    if (!installedRequest) return undefined

    const contextTarget = resolveProjectTaskDirectActionTarget(context)
    const sameWorkItem = contextTarget !== undefined &&
      installedRequest.target.teamId === contextTarget.teamId &&
      installedRequest.target.workItemId === contextTarget.workItemId
    const request = consumeProjectTaskDirectActionRequest(requestSlot, context)
    if (!request || !contextTarget) {
      const conflict = sameWorkItem &&
        installedRequest.target.expectedRevision !== contextTarget?.expectedRevision
      const message = conflict
        ? t('tasks.action.conflict')
        : projectTaskActionDisabledReasons.unavailable
      failProjectTaskDirectSchedule(installedRequest, new Error(message))
      return createFailedTaskActionResult(
        context.actionId,
        contextTarget,
        conflict ? 'WorkItemRevisionConflict' : 'ProjectTaskDirectRequestMismatch',
        conflict ? 'conflict' : 'validation',
        message,
        conflict,
      )
    }

    const task = tasksRef.current.find((candidate) =>
      candidate.teamId === contextTarget.teamId &&
      candidate.id === contextTarget.workItemId
    )
    if (!task) {
      const error = new Error(t('taskViews.action.notFound'))
      failProjectTaskDirectSchedule(request, error)
      return createFailedTaskActionResult(
        context.actionId,
        contextTarget,
        'ProjectTaskActionTargetNotFound',
        'not-found',
        error.message,
      )
    }
    if (task.revision !== contextTarget.expectedRevision) {
      const error = new TeamIssuesApiError(
        409,
        t('tasks.action.conflict'),
        'WorkItemRevisionConflict',
      )
      failProjectTaskDirectSchedule(request, error)
      return createFailedTaskActionResult(
        context.actionId,
        contextTarget,
        'WorkItemRevisionConflict',
        'conflict',
        error.message,
        true,
      )
    }
    if (!claimProjectTaskDirectActionTarget(directTaskActionsInFlightRef.current, request)) {
      const error = new Error(t('tasks.action.conflict'))
      failProjectTaskDirectSchedule(request, error)
      return createFailedTaskActionResult(
        context.actionId,
        contextTarget,
        'ProjectTaskDirectActionInFlight',
        'conflict',
        error.message,
        true,
      )
    }

    taskActionCompletion.cancel()
    const confirmScheduleChange = onConfirmScheduleChangeRef.current
    const previewScheduleChange = onPreviewScheduleChangeRef.current
    const updateTask = onUpdateTaskRef.current
    const runTaskUpdate = performTaskUpdateRef.current

    /** Executes persistence after the synchronous request and target claims above. */
    const executeMutation = async (): Promise<WorkItemActionResult> => {
      try {
        if (request.input.kind === 'schedule-operation') {
          if (!previewScheduleChange || !confirmScheduleChange) {
            const error = new Error(projectTaskActionDisabledReasons.unavailable)
            failProjectTaskDirectSchedule(request, error)
            return createFailedTaskActionResult(
              context.actionId,
              contextTarget,
              'ProjectTaskDirectScheduleUnavailable',
              'unavailable',
              error.message,
            )
          }
          if (!beginProjectTaskDirectSchedulePreview(request)) {
            return createCancelledTaskActionResult(context.actionId, [contextTarget])
          }
          const preview = await previewScheduleChange(task, request.input.operation)
          const directImpact = preview.impacts.find((impact) =>
            impact.kind === 'direct' &&
            impact.teamId === task.teamId &&
            impact.workItemId === task.id
          )
          if (!directImpact) {
            throw new Error('Schedule preview did not contain the target Work Item.')
          }
          if (!publishProjectTaskDirectSchedulePreview(request, preview)) {
            return createCancelledTaskActionResult(context.actionId, [contextTarget])
          }
          const decision = await waitForProjectTaskDirectScheduleDecision(request)
          if (decision === 'cancelled') {
            return createCancelledTaskActionResult(context.actionId, [contextTarget])
          }
          const updatedTask = await confirmScheduleChange(
            task,
            request.input.operation,
            preview,
          )
          completeProjectTaskDirectScheduleMutation(request, updatedTask)
          directTaskActionResultsRef.current.set(request, updatedTask)
          setTaskUndo({
            forwardPatch: { schedule: structuredClone(directImpact.after) },
            inversePatch: { schedule: structuredClone(directImpact.before) },
            task: updatedTask,
            undoToken: createTaskUpdateUndoToken(updatedTask),
          })
          setTaskRedo(undefined)
          setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
          return createSucceededTaskActionMutationResult(
            context.actionId,
            contextTarget,
            updatedTask.revision,
            createTaskUpdateUndoToken(updatedTask),
          )
        }
        if (!isSupportedProjectTaskDirectPatch(request)) {
          const error = new Error(t('tasks.action.updateError'))
          failProjectTaskDirectSchedule(request, error)
          return createFailedTaskActionResult(
            context.actionId,
            contextTarget,
            'ProjectTaskDirectPatchUnsupported',
            'validation',
            error.message,
          )
        }
        if (!updateTask || !runTaskUpdate) {
          const error = new Error(projectTaskActionDisabledReasons.unavailable)
          failProjectTaskDirectSchedule(request, error)
          return createFailedTaskActionResult(
            context.actionId,
            contextTarget,
            'ProjectTaskDirectMutationUnavailable',
            'unavailable',
            error.message,
          )
        }

        const result = await runTaskUpdate(task, request.input.patch, undefined, request)
        if (!result.applied) {
          cancelAwaitingProjectTaskDirectSchedule(request)
          return createCancelledTaskActionResult(context.actionId, [contextTarget])
        }
        directTaskActionResultsRef.current.set(request, result.task)
        return createSucceededTaskActionMutationResult(
          context.actionId,
          contextTarget,
          result.task.revision,
          createTaskUpdateUndoToken(result.task),
        )
      } catch (error) {
        if (readProjectTaskDirectSchedulePhase(request) === 'cancelled') {
          return createCancelledTaskActionResult(context.actionId, [contextTarget])
        }
        directTaskActionErrorsRef.current.set(request, error)
        failProjectTaskDirectSchedule(request, error)
        const conflict = isTaskRevisionConflict(error)
        if (conflict) {
          setTaskUndo(undefined)
          setTaskRedo(undefined)
        }
        return createFailedTaskActionResult(
          context.actionId,
          contextTarget,
          conflict ? 'WorkItemRevisionConflict' : 'ProjectTaskActionMutationFailed',
          conflict ? 'conflict' : 'unknown',
          resolveTaskMutationErrorMessage(error, t),
          conflict,
        )
      } finally {
        releaseProjectTaskDirectActionTarget(directTaskActionsInFlightRef.current, request)
      }
    }

    return executeMutation()
  }, [
    projectTaskActionDisabledReasons.unavailable,
    t,
    taskActionCompletion,
  ])

  const currentTaskActionTarget = taskActionSelection.targets.length === 1
    ? taskActionSelection.targets[0]
    : taskActionSelection.targets.length === 0
      ? taskActionSelection.focusedTarget
      : undefined
  const toggleTaskWatch = currentTaskActionTarget &&
      detailTask?.teamId === currentTaskActionTarget.teamId &&
      detailTask.id === currentTaskActionTarget.workItemId &&
      collaboration?.watch &&
      collaboration.capabilities.canWatch
    ? collaboration.toggleWatch
    : undefined

  /** Evaluates access against every concrete target instead of the currently open detail pane. */
  const evaluateProjectTaskTargetPermission = useCallback((
    context: WorkItemActionContext,
    requiresConfiguration: boolean,
    requiresMutation = true,
  ) => {
    const targets = resolveProjectTaskActionTargets(context)
    if (targets.length === 0) return allowTaskAction()
    const allowed = targets.every((target) => visibleTasks.some((task) =>
      task.teamId === target.teamId &&
      task.id === target.workItemId &&
      (!requiresMutation || !canMutateTask || canMutateTask(task)) &&
      (!requiresConfiguration || !configurationFailedTeamIds.includes(task.teamId))
    ))
    return allowed
      ? allowTaskAction()
      : denyTaskAction(projectTaskActionDisabledReasons.unavailable)
  }, [
    configurationFailedTeamIds,
    canMutateTask,
    projectTaskActionDisabledReasons.unavailable,
    visibleTasks,
  ])

  /** Resets the bulk editor owned by one terminal or superseded canonical request. */
  const dismissBulkTaskActionEditor = useCallback((requestId: number) => {
    bulkTaskActionContextsRef.current.delete(requestId)
    setBulkTaskActionRequest((current) =>
      current?.requestId === requestId ? undefined : current
    )
    nextBulkTaskActionEpochRef.current += 1
    setBulkTaskActionEpoch(nextBulkTaskActionEpochRef.current)
  }, [])

  /** Reveals a parameterized bulk-operation entrance after registry checks succeed. */
  const executeBulkTaskActionEntrance = useCallback((
    context: WorkItemActionContext,
  ): Promise<WorkItemActionResult> | WorkItemActionResult => {
    cancelAwaitingDirectTaskScheduleActions()
    if (!isBulkTaskActionId(context.actionId)) {
      return createFailedTaskActionResult(
        context.actionId,
        undefined,
        'ProjectBulkTaskActionUnavailable',
        'unavailable',
        projectTaskActionDisabledReasons.unavailable,
      )
    }
    const targets = resolveProjectTaskActionTargets(context)
    const requestedItems = targets.flatMap((target) => {
      const task = visibleTasks.find((candidate) =>
        candidate.teamId === target.teamId && candidate.id === target.workItemId
      )
      if (!task) return []
      return [{
        ...createBulkOperationSelection(task, t),
        expectedRevision: target.expectedRevision ?? task.revision,
      }]
    })
    setBulkSelection({ items: requestedItems, projectId })
    nextBulkTaskActionRequestIdRef.current += 1
    const request: BulkOperationTaskActionRequest = {
      actionId: context.actionId,
      projectId,
      requestId: nextBulkTaskActionRequestIdRef.current,
    }
    const completion = taskActionCompletion.begin(context, () => {
      dismissBulkTaskActionEditor(request.requestId)
    })
    const invocationContext = taskActionCompletion.current()
    if (invocationContext) {
      bulkTaskActionContextsRef.current.set(request.requestId, invocationContext)
    }
    nextBulkTaskActionEpochRef.current += 1
    setBulkTaskActionEpoch(nextBulkTaskActionEpochRef.current)
    setBulkTaskActionRequest(request)
    void completion.then(
      () => bulkTaskActionContextsRef.current.delete(request.requestId),
      () => bulkTaskActionContextsRef.current.delete(request.requestId),
    )
    return completion
  }, [
    cancelAwaitingDirectTaskScheduleActions,
    dismissBulkTaskActionEditor,
    projectId,
    projectTaskActionDisabledReasons.unavailable,
    t,
    taskActionCompletion,
    visibleTasks,
  ])

  /** Acknowledges one toolbar entrance without changing the remount epoch. */
  const handleBulkTaskActionRequestConsumed = useCallback((requestId: number) => {
    setBulkTaskActionRequest((currentRequest) =>
      currentRequest?.requestId === requestId ? undefined : currentRequest
    )
  }, [])

  /** Claims one exact toolbar request immediately before its irreversible apply dispatch. */
  const handleBulkTaskActionMutationStart = useCallback((
    request: BulkOperationTaskActionRequest,
  ): boolean => {
    const context = bulkTaskActionContextsRef.current.get(request.requestId)
    return Boolean(
      context &&
      context.actionId === request.actionId &&
      taskActionCompletion.claim(context)
    )
  }, [taskActionCompletion])

  /** Returns one applied durable operation to the exact invocation that started it. */
  const handleBulkTaskActionOperationComplete = useCallback((
    request: BulkOperationTaskActionRequest,
    operation: BulkOperation,
  ) => {
    const context = bulkTaskActionContextsRef.current.get(request.requestId)
    if (!context || context.actionId !== request.actionId) return
    taskActionCompletion.settle(context, createBulkOperationTaskActionResult(
      context.actionId,
      operation,
      t('taskViews.action.failed'),
    ))
  }, [t, taskActionCompletion])

  /** Returns preview cancellation or failure to the pending bulk action executor. */
  const handleBulkTaskActionInterrupted = useCallback((
    interruption: BulkOperationTaskActionInterruption,
  ) => {
    if (interruption.requestId === undefined) return
    const pendingContext = bulkTaskActionContextsRef.current.get(interruption.requestId)
    if (!pendingContext || !isBulkTaskActionId(pendingContext.actionId)) return
    if (interruption.kind === 'cancelled') {
      taskActionCompletion.cancelContext(pendingContext)
      return
    }
    if (interruption.kind === 'preview-rejected') {
      taskActionCompletion.settle(pendingContext, createBulkPreviewTaskActionResult(
        pendingContext.actionId,
        interruption.preview,
        t('taskViews.action.failed'),
      ))
      dismissBulkTaskActionEditor(interruption.requestId)
      return
    }
    taskActionCompletion.settle(pendingContext, createFailedTaskActionResults(
      pendingContext.actionId,
      resolveProjectTaskActionTargets(pendingContext),
      'ProjectBulkTaskActionFailed',
      'unknown',
      t('taskViews.action.failed'),
      true,
    ))
    dismissBulkTaskActionEditor(interruption.requestId)
  }, [dismissBulkTaskActionEditor, t, taskActionCompletion])

  /** Executes a direct Assign or Move request before retaining the existing bulk fallback. */
  const executeProjectTaskParameterizedAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult | Promise<WorkItemActionResult> => {
    const directResult = executeProjectTaskDirectAction(context)
    if (directResult) return directResult
    if (bulkTaskActionsAvailable) return executeBulkTaskActionEntrance(context)
    return createFailedTaskActionResult(
      context.actionId,
      resolveProjectTaskActionTarget(context),
      'ProjectTaskActionUnavailable',
      'unavailable',
      projectTaskActionDisabledReasons.unavailable,
    )
  }, [
    bulkTaskActionsAvailable,
    executeBulkTaskActionEntrance,
    executeProjectTaskDirectAction,
    projectTaskActionDisabledReasons.unavailable,
  ])

  const projectTaskActionHandlers = useMemo<ProjectTaskActionHandlers>(() => ({
    ...(canCreateTaskAction
      ? {
          create: (context) => {
            cancelAwaitingDirectTaskScheduleActions()
            const createContext = pendingCreateTaskContextRef.current
            pendingCreateTaskContextRef.current = undefined
            const completion = taskActionCompletion.begin(context, dismissCreateTaskEditor)
            showCreateTaskEditor(createContext)
            return completion
          },
        }
      : {}),
    open: (context) => executeTaskDetailAction(context),
    ...(canEditTaskAction
      ? {
          edit: (context) => executeProjectTaskDirectAction(context) ??
            executeTaskDetailAction(
              context,
              'input[name="title"]',
              true,
            ),
          schedule: (context) => executeProjectTaskDirectAction(context) ??
            executeTaskDetailAction(
              context,
              'select[name="scheduleMode"]',
              true,
            ),
        }
      : {}),
    ...(bulkTaskActionsAvailable || canDirectTaskAction
      ? {
          ...(bulkTaskActionsAvailable ? { archive: executeBulkTaskActionEntrance } : {}),
          assign: executeProjectTaskParameterizedAction,
          move: executeProjectTaskParameterizedAction,
        }
      : {}),
    ...(canManageTaskRelationAction
      ? {
          relation: (context) => executeTaskDetailAction(
            context,
            '[data-testid="work-item-relations-editor"] select',
            true,
          ),
        }
      : {}),
    ...(toggleTaskWatch
      ? {
          watch: async (context) => {
            cancelAwaitingDirectTaskScheduleActions()
            const target = resolveProjectTaskActionTarget(context)
            if (
              !target ||
              !detailTask ||
              detailTask.teamId !== target.teamId ||
              detailTask.id !== target.workItemId
            ) {
              return createFailedTaskActionResult(
                context.actionId,
                target,
                'ProjectTaskActionTargetNotFound',
                'not-found',
                t('taskViews.action.notFound'),
              )
            }
            const succeeded = await toggleTaskWatch()
            return succeeded
              ? createSucceededTaskActionResult(context.actionId, target)
              : createFailedTaskActionResult(
                  context.actionId,
                  target,
                  'ProjectTaskWatchFailed',
                  'unknown',
                  t('taskViews.action.failed'),
                )
          },
        }
      : {}),
  }), [
    bulkTaskActionsAvailable,
    cancelAwaitingDirectTaskScheduleActions,
    canCreateTaskAction,
    canDirectTaskAction,
    canEditTaskAction,
    canManageTaskRelationAction,
    detailTask,
    executeBulkTaskActionEntrance,
    executeProjectTaskDirectAction,
    executeProjectTaskParameterizedAction,
    executeTaskDetailAction,
    dismissCreateTaskEditor,
    showCreateTaskEditor,
    t,
    taskActionCompletion,
    toggleTaskWatch,
  ])

  /** Keeps command and context Assign/Move disabled unless their bulk editor is available. */
  const evaluateProjectTaskParameterizedPermission = useCallback((
    context: WorkItemActionContext,
  ) => {
    const directRequest = directTaskActionRequestSlotRef.current.current
    if (
      !bulkTaskActionsAvailable &&
      (!directRequest || directRequest.actionId !== context.actionId)
    ) return denyTaskAction(projectTaskActionDisabledReasons.unavailable)
    return evaluateProjectTaskTargetPermission(context, false)
  }, [
    bulkTaskActionsAvailable,
    evaluateProjectTaskTargetPermission,
    projectTaskActionDisabledReasons.unavailable,
  ])

  const projectTaskActionPermissions = useMemo<ProjectTaskActionPermissions>(() => ({
    archive: (context) => evaluateProjectTaskTargetPermission(context, false),
    assign: evaluateProjectTaskParameterizedPermission,
    edit: (context) => evaluateProjectTaskTargetPermission(context, true),
    move: evaluateProjectTaskParameterizedPermission,
    open: (context) => evaluateProjectTaskTargetPermission(context, false, false),
    relation: (context) => evaluateProjectTaskTargetPermission(context, true),
    schedule: (context) => evaluateProjectTaskTargetPermission(context, true),
    watch: (context) => {
      const target = resolveProjectTaskActionTarget(context)
      return target && detailTask && toggleTaskWatch &&
          detailTask.teamId === target.teamId && detailTask.id === target.workItemId
        ? allowTaskAction()
        : denyTaskAction(projectTaskActionDisabledReasons.unavailable)
    },
  }), [
    detailTask,
    evaluateProjectTaskTargetPermission,
    evaluateProjectTaskParameterizedPermission,
    projectTaskActionDisabledReasons.unavailable,
    toggleTaskWatch,
  ])

  /** Projects normalized action failures into the existing reversible-action feedback surface. */
  const handleProjectTaskActionExecution = useCallback((result: TaskActionExecutionResult) => {
    const errorMessage = resolveTaskActionExecutionFailureMessage(
      result,
      t('taskViews.action.failed'),
    )
    if (errorMessage) {
      setTaskAction({ kind: 'error', message: errorMessage })
      return
    }
    if (result.status === 'executed' && result.actionId === 'watch') {
      setTaskAction({ kind: 'success', message: t('tasks.action.saved') })
    }
  }, [t])

  const projectTaskActions = useProjectTaskActions({
    ...(activeTaskViewId !== undefined ? { activeViewId: activeTaskViewId } : {}),
    disabledReasons: projectTaskActionDisabledReasons,
    handlers: projectTaskActionHandlers,
    labels: projectTaskActionLabels,
    onExecutionResult: handleProjectTaskActionExecution,
    permissions: projectTaskActionPermissions,
    projectId,
    selection: taskActionSelection,
    ...(activeProjectTeamId !== undefined ? { teamId: activeProjectTeamId } : {}),
  })

  /**
   * Routes Table, Board, inline, paste, and fill patches through one canonical action registry.
   *
   * The existing persistence and schedule-preview primitive remains private so canonical handlers,
   * detail saves, undo, and redo cannot recursively dispatch a second action.
   *
   * @param task - Revision-bound Work Item selected by the direct mutation control.
   * @param input - Complete atomic patch emitted by that control.
   * @returns Persisted task, or the original snapshot after an explicit preview cancellation.
   */
  const handleUpdateTask = useCallback(async (
    task: ProjectTask,
    input: UpdateTeamIssueInput,
  ): Promise<ProjectTask> => {
    const target = {
      expectedRevision: task.revision,
      teamId: task.teamId,
      workItemId: task.id,
    }
    const request = createProjectTaskDirectPatchRequest(projectId, target, input)
    const requestSlot = directTaskActionRequestSlotRef.current
    requestSlot.current = request

    try {
      const execution = await projectTaskActions.execute(
        request.actionId,
        'click',
        undefined,
        createFocusedTaskViewActionSelection(target),
      )
      const updatedTask = directTaskActionResultsRef.current.get(request)
      if (updatedTask) return updatedTask
      const mutationError = directTaskActionErrorsRef.current.get(request)
      if (mutationError !== undefined) throw mutationError
      if (execution.status === 'executed' && execution.result.status === 'cancelled') {
        return task
      }
      const message = resolveTaskActionExecutionFailureMessage(
        execution,
        t('tasks.action.updateError'),
      ) ?? t('tasks.action.updateError')
      const error = new Error(message)
      failProjectTaskDirectSchedule(request, error)
      throw error
    } finally {
      clearProjectTaskDirectActionRequest(requestSlot, request)
    }
  }, [projectId, projectTaskActions, t])

  /**
   * Starts a Gantt or Calendar Schedule action before requesting its server preview.
   *
   * @param task - Revision-bound Work Item selected by the timeline gesture.
   * @param operation - Move, resize, or replacement operation selected by that gesture.
   * @returns Synchronous invocation handle owned before the preview network request settles.
   */
  const handleRequestTimelineScheduleChange = useCallback((
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
  ): ProjectTaskDirectScheduleHandle => {
    const target = {
      expectedRevision: task.revision,
      teamId: task.teamId,
      workItemId: task.id,
    }
    const request = createProjectTaskDirectScheduleRequest(projectId, target, operation)
    const requestSlot = directTaskActionRequestSlotRef.current
    requestSlot.current = request
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(task.teamId, task.id),
      type: 'focus',
    }))

    const execution = projectTaskActions.execute(
      'schedule',
      'click',
      undefined,
      createFocusedTaskViewActionSelection(target),
    )
    void execution.then(
      (result) => {
        clearProjectTaskDirectActionRequest(requestSlot, request)
        const message = resolveTaskActionExecutionFailureMessage(
          result,
          t('tasks.action.updateError'),
        )
        if (message) failProjectTaskDirectSchedule(request, new Error(message))
      },
      (error: unknown) => {
        clearProjectTaskDirectActionRequest(requestSlot, request)
        failProjectTaskDirectSchedule(request, error)
      },
    )
    const handle = createProjectTaskDirectScheduleHandle(request)
    return {
      ...handle,
      cancel: () => {
        const cancelled = handle.cancel()
        if (cancelled) {
          releaseProjectTaskDirectActionTarget(directTaskActionsInFlightRef.current, request)
        }
        return cancelled
      },
    }
  }, [projectId, projectTaskActions, t])

  /**
   * Routes header, Board, and other direct Create clicks through the canonical registry.
   *
   * @param context - Existing view-aware defaults consumed by the accepted Create handler.
   */
  const handleProjectCreateClick = useCallback((context?: TaskCreateContext) => {
    pendingCreateTaskContextRef.current = context
    void projectTaskActions.execute(
      'create',
      'click',
      undefined,
      { mode: 'none', targets: [] },
    )
  }, [projectTaskActions])

  /**
   * Returns an existing relation editor mutation to a pending canonical Relation action.
   *
   * @param issueId - Work Item whose relation graph is being changed.
   * @param mutate - Existing add or delete relation mutation.
   * @returns Nothing after the relation mutation and detail refresh complete.
   */
  const handleProjectTaskActionRelation = useCallback(async (
    issueId: string,
    mutate: () => Promise<void>,
  ): Promise<void> => {
    const teamId = detailTask?.teamId
    const pendingCandidate = teamId
      ? resolvePendingTaskActionContext(
          taskActionCompletion,
          ['edit', 'relation', 'schedule'],
          { teamId, workItemId: issueId },
        )
      : undefined
    const pendingContext = pendingCandidate?.actionId === 'relation'
      ? pendingCandidate
      : undefined
    if (pendingCandidate && !pendingContext) {
      taskActionCompletion.cancelContext(pendingCandidate)
    }
    const target = pendingContext
      ? resolveProjectTaskActionTarget(pendingContext)
      : undefined
    const claimedContext = pendingContext && target && taskActionCompletion.claim(pendingContext)
      ? pendingContext
      : undefined

    try {
      await mutate()
      if (claimedContext && target) {
        taskActionCompletion.settle(claimedContext, createSucceededTaskActionMutationResult(
          claimedContext.actionId,
          target,
        ))
      }
    } catch (error) {
      if (claimedContext) {
        const isConflict = isWorkItemRelationGraphConflict(error)
        const canDismissOwner = canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        )
        taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
          claimedContext.actionId,
          target,
          isConflict ? 'WorkItemRelationGraphConflict' : 'ProjectTaskRelationMutationFailed',
          isConflict ? 'conflict' : 'unknown',
          t('taskViews.action.failed'),
          isConflict,
        ))
        if (canDismissOwner) dismissTaskDetailEditor(claimedContext)
      }
      throw error
    }
  }, [detailTask?.teamId, dismissTaskDetailEditor, t, taskActionCompletion])

  const taskActionContextMenuContext = useMemo(() => {
    if (!taskActionContextMenuState) return undefined
    const scope: ProjectTaskViewScope = {
      kind: 'project',
      projectId,
      ...(activeProjectTeamId !== undefined ? { teamId: activeProjectTeamId } : {}),
    }
    return createTaskSurfaceActionBaseContext(
      'project',
      scope,
      taskActionContextMenuState.selection,
      activeTaskViewId,
    )
  }, [
    activeProjectTeamId,
    activeTaskViewId,
    projectId,
    taskActionContextMenuState,
  ])

  /** Executes a normal row or card open through the same canonical action pipeline. */
  const handleOpenTask = useCallback((task: ProjectTask) => {
    void projectTaskActions.execute(
      'open',
      'click',
      undefined,
      createFocusedTaskViewActionSelection({
        expectedRevision: task.revision,
        teamId: task.teamId,
        workItemId: task.id,
      }),
    )
  }, [projectTaskActions])

  /**
   * Opens a revision-bound row or card menu without inheriting unrelated bulk selection.
   *
   * @param task - Project task represented by the triggering row or card.
   * @param anchorPoint - Viewport coordinates used to anchor the menu.
   * @param returnFocusElement - Trigger element that regains focus after dismissal.
   * @returns Nothing.
   */
  const handleTaskActionMenuOpen = useCallback<ProjectTaskActionMenuOpenHandler>(
    (task, anchorPoint, returnFocusElement) => {
      const taskKey = createTaskViewItemKey(task.teamId, task.id)
      setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
        key: taskKey,
        type: 'focus',
      }))
      setTaskActionContextMenuState({
        anchorPoint,
        returnFocusElement,
        selection: createFocusedTaskViewActionSelection({
          expectedRevision: task.revision,
          teamId: task.teamId,
          workItemId: task.id,
        }),
      })
    },
    [],
  )

  /**
   * Routes a context-menu activation through the same canonical registry executor.
   *
   * @param actionId - Canonical Work Item action selected from the menu.
   * @returns Nothing.
   */
  const handleTaskActionMenuExecute = useCallback((actionId: WorkItemActionId) => {
    if (!taskActionContextMenuState) return
    void projectTaskActions.execute(
      actionId,
      'context-menu',
      undefined,
      taskActionContextMenuState.selection,
    )
  }, [projectTaskActions, taskActionContextMenuState])

  /** Lets the bulk toolbar request Move, Assign, or Archive through the shared registry. */
  const handleBulkTaskActionRequest = useCallback(async (
    actionId: BulkOperationTaskActionRequest['actionId'],
  ): Promise<boolean> => {
    const result = await projectTaskActions.execute(
      actionId,
      'bulk-action',
      undefined,
      bulkTaskActionSelection,
    )
    return result.status === 'executed' && result.result.status === 'succeeded'
  }, [bulkTaskActionSelection, projectTaskActions])

  useEffect(() => {
    /** Routes global task shortcuts through guarded selection or the canonical action pipeline. */
    const handleTaskKeyboard = (event: KeyboardEvent) => {
      const input = createTaskSurfaceKeyboardInput(
        event,
        isCreateTaskOpen ||
          Boolean(pendingScheduleUpdate) ||
          Boolean(taskActionContextMenuState),
      )
      const selectionAction = activeTab === 'file' || activeTab === 'permissions'
        ? undefined
        : createTaskViewSelectionKeyboardAction(
            input,
            taskViewSelection,
            visibleTaskViewKeys,
          )

      if (selectionAction) {
        event.preventDefault()
        const nextSelection = reduceTaskViewSelection(taskViewSelection, selectionAction)
        const selectedKeys = new Set(nextSelection.selectedKeys)
        setTaskViewSelection(nextSelection)
        setBulkSelection({
          items: visibleBulkItems.filter((item) => selectedKeys.has(
            createTaskViewItemKey(item.teamId, item.workItemId),
          )),
          projectId,
        })
        const focusedTask = nextSelection.focusedKey
          ? visibleTasks.find((task) =>
              createTaskViewItemKey(task.teamId, task.id) === nextSelection.focusedKey
            )
          : undefined
        if (focusedTask) handleSelectDetailTask(focusedTask)
        return
      }

      const definition = projectTaskActions.resolveShortcut(input)
      if (!definition) return
      event.preventDefault()
      const keyboardShortcut = definition.shortcut
        ? formatTaskSurfaceKeyboardShortcut(definition.shortcut)
        : undefined
      void projectTaskActions.execute(
        definition.id,
        'keyboard',
        keyboardShortcut,
      )
    }

    document.addEventListener('keydown', handleTaskKeyboard)
    return () => document.removeEventListener('keydown', handleTaskKeyboard)
  }, [
    activeTab,
    handleSelectDetailTask,
    isCreateTaskOpen,
    pendingScheduleUpdate,
    projectId,
    projectTaskActions,
    taskActionContextMenuState,
    taskViewSelection,
    visibleBulkItems,
    visibleTasks,
    visibleTaskViewKeys,
  ])

  return (
    <section aria-busy={isLoading} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TaskHeader
          activeTab={activeTab}
          isProjectQuickAccess={isProjectQuickAccess}
          isProjectQuickAccessSaving={isProjectQuickAccessSaving}
          isCreateTaskOpen={isCreateTaskOpen}
          onCreateTaskOpenChange={onCreateTask ? (isOpen) => {
            if (isOpen) {
              handleProjectCreateClick()
            } else {
              taskActionCompletion.cancel('create')
              dismissCreateTaskEditor()
            }
          } : undefined}
          onMobileSidebarOpen={openMobileSidebar}
          onProjectQuickAccessToggle={onProjectQuickAccessToggle}
          onTabChange={(nextActiveTab) => commitViewState({
            ...currentViewState,
            activeTab: nextActiveTab,
          })}
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
                  taskActionCompletion.cancel('create')
                  setCreateTaskError(undefined)
                  setCreateTaskContext(undefined)
                  setIsCreateTaskOpen(false)
                }}
                onSubmit={async (input) => {
                  const pendingContext = resolvePendingTaskActionContext(
                    taskActionCompletion,
                    ['create'],
                  )
                  const claimedContext = pendingContext &&
                      taskActionCompletion.claim(pendingContext)
                    ? pendingContext
                    : undefined
                  setCreateTaskError(undefined)
                  setIsCreatingTask(true)

                  try {
                    const createdMutation = await onCreateTask(input, createTaskContext)
                    const canDismissOwner = claimedContext
                      ? canDismissCompletedTaskActionOwner(taskActionCompletion, claimedContext)
                      : true
                    if (claimedContext) {
                      const createdTarget = createdMutation
                        ? {
                            expectedRevision: createdMutation.task.revision,
                            teamId: createdMutation.task.teamId,
                            workItemId: createdMutation.task.id,
                          }
                        : undefined
                      taskActionCompletion.settle(claimedContext, createSucceededTaskCreateActionResult(
                        createdTarget,
                        createdMutation?.navigationPath,
                      ))
                    }
                    setTaskUndo(undefined)
                    setTaskRedo(undefined)
                    setTaskAction({
                      kind: 'success',
                      message: t('tasks.action.saved'),
                    })
                    if (canDismissOwner) {
                      setCreateTaskContext(undefined)
                      setIsCreateTaskOpen(false)
                    }
                  } catch (error) {
                    if (claimedContext) {
                      const canDismissOwner = canDismissCompletedTaskActionOwner(
                        taskActionCompletion,
                        claimedContext,
                      )
                      taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
                        claimedContext.actionId,
                        undefined,
                        'ProjectTaskCreateFailed',
                        'unknown',
                        t('tasks.create.error'),
                      ))
                      if (canDismissOwner) dismissCreateTaskEditor()
                    }
                    if (!claimedContext) {
                      setCreateTaskError(
                        error instanceof Error ? error.message : t('tasks.create.error'),
                      )
                    }
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
                bulkTaskActionEpoch={bulkTaskActionEpoch}
                bulkTaskActionRequest={bulkTaskActionRequest}
                bulkWorkspaceId={workspaceId}
                canManageProjectMembers={canManageProjectMembers}
                canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
                canMutateTask={canMutateTask}
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
                onAssigneeFilterChange={(nextAssigneeFilter) => commitViewState({
                  ...currentViewState,
                  assigneeFilter: nextAssigneeFilter,
                })}
                onBulkApply={onBulkApply}
                onBulkOperationComplete={handleBulkOperationComplete}
                onBulkPreview={onBulkPreview}
                onBulkRetry={onBulkRetry}
                onBulkTaskActionRequest={handleBulkTaskActionRequest}
                onBulkTaskActionRequestConsumed={handleBulkTaskActionRequestConsumed}
                onBulkTaskActionInterrupted={handleBulkTaskActionInterrupted}
                onBulkTaskActionMutationStart={handleBulkTaskActionMutationStart}
                onBulkTaskActionOperationComplete={handleBulkTaskActionOperationComplete}
                onBulkUndo={onBulkUndo}
                onCreateTaskOpen={onCreateTask ? handleProjectCreateClick : undefined}
                onCreateScheduleDependency={onCreateScheduleDependency}
                onDeleteScheduleDependency={onDeleteScheduleDependency}
                onDefinitionFilterChange={(nextDefinitionFilter) => commitViewState({
                  ...currentViewState,
                  definitionFilter: nextDefinitionFilter,
                })}
                onDueDateFilterChange={(nextDueDateFilter) => commitViewState({
                  ...currentViewState,
                  dueDateFilter: nextDueDateFilter,
                })}
                onLoadMoreProjectUsers={onLoadMoreProjectUsers}
                onPriorityFilterChange={(nextPriorityFilter) => commitViewState({
                  ...currentViewState,
                  priorityFilter: nextPriorityFilter,
                })}
                onResetFilters={() => commitViewState({
                  ...currentViewState,
                  assigneeFilter: 'all',
                  definitionFilter: { category: 'all', customFieldId: '' },
                  dueDateFilter: 'all',
                  priorityFilter: 'all',
                  statusFilter: 'all',
                })}
                onProjectUserQueryChange={onProjectUserQueryChange}
                onRemoveProjectMember={onRemoveProjectMember}
                onSearchQueryChange={(nextSearchQuery) => commitViewState({
                  ...currentViewState,
                  searchQuery: nextSearchQuery,
                })}
                onSelectTask={handleOpenTask}
                onTaskActionMenuOpen={handleTaskActionMenuOpen}
                onSortOrderChange={(nextSortOrder) => commitViewState({
                  ...currentViewState,
                  sortOrder: nextSortOrder,
                })}
                onStatusFilterChange={(nextStatusFilter) => commitViewState({
                  ...currentViewState,
                  statusFilter: nextStatusFilter,
                })}
                onTaskSelectionChange={updateTaskSelection}
                onUpdateProjectMember={onUpdateProjectMember}
                onUpdateScheduleDependency={onUpdateScheduleDependency}
                onRequestScheduleChange={onPreviewScheduleChange && onConfirmScheduleChange
                  ? handleRequestTimelineScheduleChange
                  : undefined}
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
                taskViewToolbar={taskViewToolbar}
                taskViewPresentation={taskViewPresentation}
                tasks={visibleTasks}
                visibleBulkItems={visibleBulkItems}
                workspaceMembers={workspaceMembers}
              />
              {activeTab === 'permissions' || activeTab === 'file' ? null : (
                <TaskDetailPane
                  accessToken={accessToken}
                  assigneeOptions={assigneeOptions}
                  artifacts={artifacts}
                  canAccessTriage={canAccessTriage}
                  canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
                  collaboration={collaboration}
                  collaborationRoute={collaborationRoute}
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
                  onCreateScheduleDependency={canMutateDetailTask
                    ? onCreateScheduleDependency
                    : undefined}
                  onDeleteScheduleDependency={canMutateDetailTask
                    ? onDeleteScheduleDependency
                    : undefined}
                  onScheduleNoChange={handleProjectScheduleNoChange}
                  onAddRelation={canMutateDetailTask && onAddRelation
                    ? (issueId, input) => handleProjectTaskActionRelation(
                        issueId,
                        () => onAddRelation(issueId, input),
                      )
                    : undefined}
                  onClose={handleCloseDetail}
                  onDeleteRelation={canMutateDetailTask && onDeleteRelation
                    ? (issueId, relation) => handleProjectTaskActionRelation(
                        issueId,
                        () => onDeleteRelation(issueId, relation),
                      )
                    : undefined}
                  onUpdateIssue={!canMutateDetailTask || !detailTask ||
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
        {taskActionContextMenuState && taskActionContextMenuContext ? (
          <TaskActionContextMenu
            anchorPoint={taskActionContextMenuState.anchorPoint}
            context={taskActionContextMenuContext}
            labels={projectTaskActionLabels}
            menuLabel={t('tasks.action.more')}
            onClose={() => setTaskActionContextMenuState(undefined)}
            onExecute={handleTaskActionMenuExecute}
            registry={projectTaskActions.registry}
            returnFocusElement={taskActionContextMenuState.returnFocusElement}
            testId="project-task-action-context-menu"
          />
        ) : null}
    </section>
  )
}

/**
 * Creates the opaque token returned with a reversible inline task mutation.
 *
 * @param task - Persisted Work Item snapshot retained by the existing undo feedback state.
 * @returns Team-qualified revision token consumed only by this screen's undo entrance.
 */
function createTaskUpdateUndoToken(task: ProjectTask): string {
  return `task-update:${task.teamId}:${task.id}:${task.revision}`
}

/**
 * Validates that an opaque inline-update undo token still owns the retained task snapshot.
 *
 * @param undoToken - Token exposed by the successful canonical action result.
 * @param task - Persisted task snapshot about to be restored.
 * @returns Whether the existing undo state may consume the token.
 */
function isTaskUpdateUndoTokenForTask(undoToken: string, task: ProjectTask): boolean {
  return undoToken === createTaskUpdateUndoToken(task)
}

/** Narrows canonical actions to the parameterized operations backed by the bulk toolbar. */
function isBulkTaskActionId(
  actionId: WorkItemActionId,
): actionId is BulkOperationTaskActionRequest['actionId'] {
  return actionId === 'move' || actionId === 'assign' || actionId === 'archive'
}

/**
 * Compares focus, anchor, and ordered selected keys without relying on object identity.
 *
 * @param first - First shared task-view selection.
 * @param second - Second shared task-view selection.
 * @returns Whether both selections describe the same interaction state.
 */
function areTaskViewSelectionsEqual(
  first: TaskViewSelectionState,
  second: TaskViewSelectionState,
): boolean {
  return first.focusedKey === second.focusedKey &&
    first.anchorKey === second.anchorKey &&
    first.selectedKeys.length === second.selectedKeys.length &&
    first.selectedKeys.every((key, index) => key === second.selectedKeys[index])
}

/**
 * Focuses and reveals a control after React commits a selected-task detail update.
 *
 * @param selector - Selector scoped to the active task detail pane.
 */
function focusTaskDetailControl(selector: string): void {
  requestAnimationFrame(() => {
    const detailPane = document.querySelector<HTMLElement>('[data-testid="task-detail-pane"]')
    const control = detailPane?.querySelector<HTMLElement>(selector)
    control?.focus()
    control?.scrollIntoView({ block: 'nearest' })
  })
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
 * Identifies a relation graph conflict that invalidates the retained graph revision.
 *
 * @param error - Unknown relation mutation failure.
 * @returns Whether the canonical relation graph revision conflicted.
 */
function isWorkItemRelationGraphConflict(error: unknown): boolean {
  return error instanceof WorkItemConfigurationApiError &&
    error.code === 'WorkItemRelationGraphConflict'
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
