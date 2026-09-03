import type {
  AiWorkItemSource,
  PlanningSnapshot,
  ResolvedWorkItemConfiguration,
  TaskViewDefinition,
  TaskViewScope,
  TeamTaskViewScope,
  WorkItemActionContext,
  WorkItemActionId,
  WorkItemActionResult,
  WorkItemActionSelection,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  WorkItemDetailSectionId,
  WorkItemRelation,
  WorkItemDependencyEndpoint,
  WorkItemSchedule,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  WorkItemTypeChangePreview,
} from '@mukuroji/contracts'
import {
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
} from '@mukuroji/contracts'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  type CurrentUser,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../../auth/session'
import { aiAssistanceUiEnabled } from '../../features/ai-assistance/model/aiAssistanceRollout'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiSummaryAssistant } from '../../features/ai-assistance/ui/AiSummaryAssistant'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import {
  type FileArtifactScope,
  type FileArtifactsController,
  useFileArtifacts,
} from '../../files/mutations/useFileArtifacts'
import {
  MobileSidebarButton,
} from '../../shared/ui/sidebar'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import {
  createTeamIssue,
  previewTeamIssueWorkItemType,
  TeamIssuesApiError,
  type CreateTeamIssueInput,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../../issues/api'
import {
  useTeamIssueDetail,
  useTeamIssues,
} from '../../issues/queries/useWorkItems'
import {
  IssueCollaborationPanel,
  type IssueSummaryAiAssistance,
} from '../../issues/ui/IssueCollaborationPanel'
import {
  type IssueCollaborationController,
  useIssueCollaboration,
} from '../../issues/mutations/useIssueCollaboration'
import { useDocumentContextPromotion } from '../../issues/mutations/useDocumentContextPromotion'
import {
  applyIssueCollaborationTabToSearchParams,
  applyIssueCollaborationSourceToSearchParams,
  resolveIssueCollaborationTab,
  type IssueCollaborationRoute,
  type IssueCollaborationTab,
} from '../../issues/model/collaborationTabs'
import { readIssueSourceKind } from '../../issues/model/contextSources'
import {
  canManagePlanningWorkItemDependencyEndpoint,
  createPlanningAccessSnapshot,
} from '../../planning/model/permissions'
import { createWorkItemDependencyMutationController } from '../../planning/mutations/createWorkItemDependencyMutationController'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import {
  type ProjectDirectoryTeam,
  type ProjectMember,
  type ProjectMemberRole,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import {
  useActiveProjectMembers,
  usePlanningProjectRoles,
} from '../../projects/queries/useProjectMembers'
import {
  createTeamIssuesPath,
} from '../../shared/routing/paths'
import type { WorkItemPriority } from '../../tasks/api'
import {
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  formatTaskScheduleRange,
  taskScheduleModeLabelKeys,
} from '../../tasks/model/taskSchedule'
import { TaskWorkItemTypeBadge } from '../../tasks/ui/TaskViewPrimitives'
import type { WorkspaceMember } from '../../workspace/api'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { useOptionalWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import {
  createWorkItemRelation,
  deleteWorkItemRelation,
  WorkItemConfigurationApiError,
} from '../../work-items/api'
import {
  useWorkItemConfiguration,
} from '../../work-items/queries/useWorkItemConfigurations'
import { WorkItemExternalLinksPanelContainer } from '../../work-items/ui/WorkItemExternalLinksPanel'
import {
  createWorkItemDependencySummaries,
  resolveWorkItemDependencySummary,
  type WorkItemDependencyCreateDraft,
  type WorkItemDependencySummary,
} from '../../work-items/model/workItemDependencies'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
  sortCustomFieldDefinitions,
} from '../../work-items/model/customFields'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import { WorkItemDependencyChips } from '../../work-items/ui/WorkItemDependencyChips'
import {
  WorkItemDependencyPanel,
} from '../../work-items/ui/WorkItemDependencyPanel'
import {
  WorkItemDefinitionFilters,
} from '../../work-items/ui/WorkItemDefinitionFilters'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../../work-items/model/workItemFilters'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import {
  createCustomFieldErrorMessages,
  createVisibleCustomFieldValuePatch,
  formatWorkItemCustomFieldValue,
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
  resolveConfiguredWorkflowStatuses,
  resolveWorkItemTypeWorkflowStatuses,
  resolveCreateWorkflowStatuses,
  resolveEditableWorkflowStatuses,
  resolveWorkItemAssignee,
  resolveWorkItemPersonOptions,
  resolveWorkItemTitle,
  resolveWorkItemTypeLabel,
  resolveWorkItemTypeCustomFields,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeFormFields,
  resolveCreatableWorkItemTypeId,
  resolveWorkItemTypes,
  resolveWorkItemTypeWorkflow,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
  type WorkItemTypeWorkflowStatus,
} from '../../work-items/model/workItemDisplay'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import {
  createBuiltInTaskViewDefinition,
  applyTaskViewDefinitionToTasks,
  filterTaskViewAudienceTeams,
  presentationSettingsToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
  taskViewDefinitionToTeamState,
  teamStateToTaskViewDefinition,
  type TeamIssueViewState,
} from '../../task-views/model/taskViewSurfaceState'
import {
  groupTaskViewItems,
  resolveTaskViewTableColumnPlacements,
  type TaskViewGroupValue,
  type TaskViewPresentationSettings,
  type TaskViewTableColumnPlacement,
} from '../../task-views/model/taskViewPresentation'
import { preserveTaskViewUrlState } from '../../task-views/model/taskViewUrlState'
import { useTaskViewController } from '../../task-views/mutations/useTaskViewController'
import {
  createFocusedTaskViewActionSelection,
  createTaskViewActionSelection,
  createTaskViewItemKey,
  createTaskViewSelectionKeyboardAction,
  createTaskViewSelectionState,
  reduceTaskViewSelection,
  type TaskViewSelectionState,
} from '../../task-views/model/taskViewSelection'
import {
  allowTaskAction,
  createFailedTaskActionResult,
  createSucceededTaskCreateActionResult,
  createSucceededTaskActionResult,
  createSucceededTaskActionMutationResult,
  denyTaskAction,
  resolveTaskActionExecutionFailureMessage,
  type TaskActionExecutionResult,
} from '../../task-views/model/taskActionRegistry'
import {
  canDismissCompletedTaskActionOwner,
  createTaskActionCompletionBridge,
  isPendingTaskActionFocusCurrent,
  resolvePendingTaskActionContext,
} from '../../task-views/model/taskActionCompletion'
import {
  clearTaskStatusMoveRequest,
  createTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from '../../task-views/model/taskStatusMoveRequest'
import {
  executeTeamIssueDirectStatusMove,
  isTeamIssueRevisionConflict,
} from '../../task-views/model/teamIssueDirectMove'
import { canWriteTaskViewWorkItem } from '../../task-views/model/taskViewWorkItemPermission'
import {
  createTaskSurfaceActionBaseContext,
  resolveTaskSurfaceActionTarget,
  resolveTaskSurfaceActionTargets,
  useTaskSurfaceActions,
  type TaskSurfaceActionDisabledReasons,
  type TaskSurfaceActionHandlers,
  type TaskSurfaceActionLabels,
  type TaskSurfaceActionPermissions,
} from '../../task-views/mutations/useTaskSurfaceActions'
import {
  createTaskSurfaceKeyboardInput,
  formatTaskSurfaceKeyboardShortcut,
} from '../../task-views/ui/taskSurfaceKeyboard'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import { TaskActionContextMenu } from '../../task-views/ui/TaskActionContextMenu'
import {
  TaskViewToolbar,
  type TaskViewFieldOption,
} from '../../task-views/ui/TaskViewToolbar'
import {
  createTaskViewOption,
  formatTaskViewMigrationWarning,
} from '../../task-views/ui/taskViewToolbarAdapter'
import { WorkItemAssigneeAvatar } from '../../work-items/ui/WorkItemAssigneeAvatar'

const issuePriorities = ['high', 'medium', 'low'] as const satisfies readonly WorkItemPriority[]
const emptyTeams: ProjectDirectoryTeam[] = []
const emptyIssues: TeamIssue[] = []
const emptyMembers: ProjectMember[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
const emptyProjectRoles: Readonly<Record<string, ProjectMemberRole>> = {}
const taskViewBuiltInFields = [
  'title',
  'status',
  'assignee',
  'dueDate',
  'priority',
  'workItemType',
  'project',
  'team',
]
/**
 * TeamIssueScreen で切り替える Issue 表示モードです。
 */
type IssueViewMode = 'table' | 'board'

const issueViewPanelId = 'team-issue-view-panel'

/** Transient Team Issue context-menu target retained independently from keyboard selection. */
type TeamIssueActionContextMenuState = {
  /** Pointer or overflow-control position used by the responsive menu layout. */
  anchorPoint: TaskActionContextMenuAnchorPoint
  /** Element that regains focus after the menu closes. */
  returnFocusElement: HTMLElement
  /** Revision-bound target selected by this row or card entrance. */
  selection: WorkItemActionSelection
}

/**
 * Opens the canonical action menu for one Team Issue row or card.
 *
 * @param issue - Team Issue represented by the triggering row or card.
 * @param anchorPoint - Viewport coordinates used to anchor the menu.
 * @param returnFocusElement - Trigger element that regains focus after dismissal.
 * @returns Nothing.
 */
type TeamIssueActionMenuOpenHandler = (
  issue: TeamIssue,
  anchorPoint: TaskActionContextMenuAnchorPoint,
  returnFocusElement: HTMLElement,
) => void

/**
 * Evaluates whether the current user may manage one dependency endpoint.
 *
 * @param endpoint - Canonical dependency endpoint under evaluation.
 * @returns Whether the current user may manage the endpoint.
 */
type CanManageWorkItemDependencyEndpoint = (endpoint: WorkItemDependencyEndpoint) => boolean

/** Persisted Team Create outcome returned by the route-level mutation. */
type CreatedTeamIssueMutation = {
  /** Canonical Work Item created by persistence. */
  issue: TeamIssue
  /** Application-relative route opened after creation, including retained view state. */
  navigationPath: string
}

/** Context retained while a canonical Team Create action is being accepted. */
type TeamIssueCreateContext = {
  /** Optional workflow status inherited from a Board column. */
  workflowStatusId?: string
  /** Optional Work Item Type inherited from a Board column. */
  workItemTypeId?: string
}

/** Local state used to review a Team Issue Work Item Type change. */
type TeamIssueTypeChangeState = {
  /** Field IDs whose removal has been acknowledged by the operator. */
  acknowledgedLostCustomFieldIds: string[]
  /** Exact Issue revision and Project selection represented by this preview. */
  identity: string
  /** Whether the latest preview request is in flight. */
  isPreviewing: boolean
  /** Server-authoritative preview result. */
  preview?: WorkItemTypeChangePreview
  /** Replacement status selected for an invalid current status. */
  replacementWorkflowStatusId?: string
  /** Error from the latest preview request. */
  errorMessage?: string
  /** Type currently being reviewed. */
  targetWorkItemTypeId: string
}

/**
 * チーム所有 Issue 画面を描画する props です。
 */
type TeamIssueScreenProps = {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  /** Saved task view active when canonical Team actions are invoked. */
  activeTaskViewId?: string
  /** Shared saved-view lifecycle and display controls. */
  taskViewToolbar?: ReactNode
  /** Complete effective definition used for multi-value filtering and sorting. */
  taskViewDefinition?: TaskViewDefinition
  /** Presentation settings rendered by Team table and board layouts. */
  taskViewPresentation?: TaskViewPresentationSettings
  /** Optional route-controlled Team Issue view state. */
  viewState?: TeamIssueViewState
  /** Persists one complete next route-controlled Team Issue view state. */
  onViewStateChange?: (state: TeamIssueViewState) => void
  /** Checks whether one visible Team Issue belongs to a server-authorized write scope. */
  canMutateIssue?: (issue: TeamIssue) => boolean
  /** Whether the current viewer may create an unassigned Work Item in the Team scope. */
  canCreateUnassignedIssue?: boolean
  /** Project destinations where the current viewer may create a Team Issue. */
  createIssueProjects?: ProjectDirectoryTeam['projects']
  /**
   * Related Documents を取得する access token です。
   */
  accessToken?: string
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のチーム ID です。
   */
  teamId: string
  /**
   * サイドバーとプロジェクト selector に表示するチーム一覧です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示中のチーム名です。
   */
  teamName?: string
  /**
   * Issue 一覧です。
   */
  issues?: TeamIssue[]
  /**
   * Team / Workspace から解決した workflow と custom field configuration です。
   */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /**
   * 選択中 Work Item から見た relation 一覧です。
   */
  relations?: readonly WorkItemRelation[]
  /** Authoritative Planning snapshot used by every canonical dependency surface. */
  planningSnapshot?: PlanningSnapshot
  /** Whether canonical Planning dependency data is loading. */
  isPlanningLoading?: boolean
  /** Planning dependency load error shown without hiding Team Issues. */
  planningErrorMessage?: string
  /** Retries the canonical Planning dependency query. */
  onRetryPlanning?: () => void
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  /** Creates a canonical Work Item schedule dependency. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical Work Item schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Updates a canonical Work Item schedule dependency. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /**
   * 選択中 Issue の comment thread、watcher、presence です。
   */
  collaboration?: IssueCollaborationController
  /**
   * 選択中 Work Item の file/version/annotation/approval controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * mention 候補と actor 表示に使う Workspace member 一覧です。
   */
  workspaceMembers?: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentWorkspaceMemberKey?: string
  /**
   * External link read API の Bearer token です。
   */
  externalLinksAccessToken?: string
  /**
   * External link の作成、更新、解除が許可されているかどうかです。
   */
  canManageExternalLinks?: boolean
  /**
   * notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * notification deep link の reply が属する root comment ID です。
   */
  focusedRootCommentId?: string
  /** Route-owned collaboration section and deep-link state. */
  collaborationRoute?: IssueCollaborationRoute
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /**
   * タスク担当者として選択できる project member 一覧です。
   */
  assigneeOptions?: ProjectMember[]
  /**
   * ログインユーザーのアバター頭文字です。
   */
  userInitial: string
  /**
   * 認証または API 確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * Issue 一覧の取得失敗時に表示するエラーメッセージです。
   */
  issueErrorMessage?: string
  /**
   * Issue 詳細の取得失敗時に表示するエラーメッセージです。
   */
  detailErrorMessage?: string
  /**
   * Work Item configuration の取得失敗時に表示するエラーメッセージです。
   */
  configurationErrorMessage?: string
  /**
   * Relation 候補の取得中かどうかです。
   */
  isRelationsLoading?: boolean
  /**
   * Storybook などで初期表示に使う Issue 一覧モードです。
   */
  initialViewMode?: IssueViewMode
  /**
   * 初期表示時に Issue 作成フォームを開くかどうかです。
   */
  defaultCreateIssueOpen?: boolean
  /**
   * 現在選択中の Issue ID です。
   */
  selectedIssueId?: string
  /**
   * Issue を選択したときの callback です。
   */
  onSelectIssue?: (issueId: string) => void
  /**
   * Issue 作成時の callback です。
   */
  onCreateIssue?: (input: CreateTeamIssueInput) => Promise<CreatedTeamIssueMutation | void>
  /**
   * Issue 更新時の callback です。
   */
  onUpdateIssue?: (
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<TeamIssue | void>
  /**
   * 選択中 Work Item へ relation を追加する callback です。
   */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /**
   * 選択中 Work Item の relation を解除する callback です。
   */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
}

/**
 * Cognito 認証後に表示するチーム所有 Issue ページです。
 */
export function TeamIssuePage() {
  const workspaceRouteContext = useOptionalWorkspaceRouteContext()
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [mutationRequestRunner] = useState(() => createMutationRequestRunner())
  const teamId = params.teamId ?? 'core-team'
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [authenticatedApiError, setAuthenticatedApiError] = useState<unknown>()
  const requestedIssueId = searchParams.get('issueId')?.trim() || undefined
  const focusedCommentId = searchParams.get('commentId')?.trim() || undefined
  const focusedRootCommentId = searchParams.get('rootCommentId')?.trim() || undefined
  const focusedContextItemId = searchParams.get('contextItemId')?.trim() || undefined
  const focusedSourceId = searchParams.get('sourceId')?.trim() || undefined
  const focusedSourceKind = readIssueSourceKind(searchParams.get('sourceKind'))
  const focusedActivityEventId = searchParams.get('activityEventId')?.trim() || undefined
  const requestedCollaborationTab = searchParams.get('collaborationTab')
  const collaborationTab = resolveIssueCollaborationTab({
    requestedTab: requestedCollaborationTab,
    focusedContextItemId,
    focusedSourceId,
    focusedActivityEventId,
  })
  const isCreateIssueRequested = searchParams.get('create') === '1'
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken)
  const { data: workspaceAccess, error: workspaceAccessError } = useWorkspaceAccess(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const {
    data: planningSnapshot,
    error: planningError,
    isLoading: isPlanningSnapshotLoading,
    key: planningKey,
    mutate: mutatePlanning,
  } = usePlanningSnapshot(accessToken, Boolean(user && !currentUserError))
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const projectScopes = useMemo(
    () => teams.flatMap((team) => team.projects.map((project) => ({
      teamId: team.id,
      projectId: project.id,
    }))),
    [teams],
  )
  const currentUserProjectKey = resolveCurrentUserProjectKey(user)
  const {
    data: projectRolesResult,
    error: projectRolesError,
    isLoading: isProjectRolesLoading,
    key: projectRolesKey,
    mutate: mutateProjectRoles,
  } = usePlanningProjectRoles(
    accessToken,
    currentUserProjectKey,
    projectScopes,
    Boolean(
      user &&
      !currentUserError &&
      !isProjectDirectoryLoading &&
      !user.isSystemAdmin &&
      canMutateWorkspaceContent(user)
    ),
  )
  const projectRoles = projectRolesResult?.roles ?? emptyProjectRoles
  const planningAccess = useMemo(
    () => createPlanningAccessSnapshot(teams, projectRoles),
    [projectRoles, teams],
  )
  const activeTeam = teams.find((team) => team.id === teamId)
  const {
    data: issues = emptyIssues,
    error: issueError,
    isLoading: isIssuesLoading,
    mutate: mutateIssues,
  } = useTeamIssues(accessToken, teamId, Boolean(user && !currentUserError), true)
  const {
    data: resolvedConfiguration,
    error: workItemConfigurationError,
    isLoading: isWorkItemConfigurationLoading,
  } = useWorkItemConfiguration(
    accessToken,
    teamId,
    Boolean(user && !currentUserError),
  )
  const resolvedSelectedIssueId = requestedIssueId && issues.some((issue) => issue.id === requestedIssueId)
    ? requestedIssueId
    : issues[0]?.id
  const resolvedSelectedIssue = issues.find((issue) => issue.id === resolvedSelectedIssueId)
  const collaboration = useIssueCollaboration({
    accessToken,
    issueId: resolvedSelectedIssueId,
    projectId: resolvedSelectedIssue?.assignedProjectId,
    teamId,
  })
  const artifactIssueId = resolvedSelectedIssueId
  const issueFileScope = useMemo<FileArtifactScope | undefined>(() =>
    artifactIssueId
      ? { issueId: artifactIssueId, kind: 'work-item', teamId }
      : undefined,
  [artifactIssueId, teamId])
  const artifacts = useFileArtifacts({
    accessToken,
    scope: issueFileScope,
  })
  const {
    data: issueDetail,
    error: detailError,
    isLoading: isIssueDetailLoading,
    mutate: mutateIssueDetail,
    key: detailKey,
  } = useTeamIssueDetail(
    accessToken,
    teamId,
    resolvedSelectedIssueId,
  )
  const screenIssues = issueDetail?.issue
    ? issues.map((issue) => issue.id === issueDetail.issue.id ? issueDetail.issue : issue)
    : issues
  const { data: assigneeOptionsResult, error: assigneeOptionsError } = useActiveProjectMembers(
    accessToken,
    activeTeam?.projects.map((project) => project.id) ?? [],
    Boolean(activeTeam),
  )
  const assigneeOptions = assigneeOptionsResult?.members ?? emptyMembers
  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'
  const canManageStructure = canManageWorkspaceStructure(user)
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      workspaceAccessError,
      planningError,
      projectDirectoryError,
      projectRolesError,
      ...(projectRolesResult?.errors ?? []),
      issueError,
      workItemConfigurationError,
      detailError,
      assigneeOptionsError,
      ...(assigneeOptionsResult?.errors ?? []),
      authenticatedApiError,
      ...(artifacts.sessionErrors ?? []),
      ...(collaboration.sessionErrors ?? []),
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const guardEnterpriseSession = async <Result,>(request: Promise<Result>) => {
    try {
      return await request
    } catch (error) {
      setAuthenticatedApiError(() => error)
      throw error
    }
  }
  const dependencyMutations = createWorkItemDependencyMutationController({
    accessToken,
    guardEnterpriseSession,
    mutatePlanning,
    mutationRequestRunner,
    planningAccess,
    planningSnapshot,
    t,
    user,
  })
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay') ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && isIssuesLoading) ||
    Boolean(user && isWorkItemConfigurationLoading)
  const issueErrorMessage = currentUserErrorAction?.kind === 'stay' || issueError
    ? t('issues.error.loading')
    : undefined
  const detailErrorMessage = detailError
    ? t('issues.error.detail')
    : undefined
  const configurationErrorMessage = workItemConfigurationError
    ? t('workItems.configuration.loadError')
    : undefined
  const planningErrorMessage = planningError || projectRolesError ||
    (projectRolesResult?.errors.length ?? 0) > 0
    ? t('planning.error')
    : undefined
  const isPlanningLoading = Boolean(planningKey && isPlanningSnapshotLoading) ||
    Boolean(projectRolesKey && isProjectRolesLoading)
  const taskViewScope = useMemo<TaskViewScope>(
    () => ({ kind: 'team', teamId }),
    [teamId],
  )
  const taskViewConfiguration = (
    resolvedConfiguration ?? issueDetail?.resolvedConfiguration
  )?.configuration
  const taskViewCustomFields = taskViewConfiguration?.customFields ?? []
  const builtInTaskViewDefinition = useMemo(
    () => createBuiltInTaskViewDefinition(
      'team',
      taskViewScope,
      'table',
      taskViewCustomFields.length > 0 ? ['customFields'] : [],
    ),
    [taskViewCustomFields.length, taskViewScope],
  )
  const taskViewColumns = [
    ...taskViewBuiltInFields,
    ...(taskViewCustomFields.length > 0 ? ['customFields'] : []),
    ...taskViewCustomFields.map((field) => `custom:${field.id}`),
  ]
  const taskViewFields = [
    ...taskViewBuiltInFields,
    ...taskViewCustomFields.map((field) => `custom:${field.id}`),
  ]
  const taskViewWorkflowStatuses = resolveWorkItemTypeWorkflowStatuses(taskViewConfiguration).map(({
    status,
    workItemTypeId,
  }) => ({ statusId: status.id, teamId, workItemTypeId }))
  const taskViewLegacyStatusIds = resolveConfiguredWorkflowStatuses(taskViewConfiguration).map(
    (status) => status.id,
  )
  const taskViewController = useTaskViewController({
    accessToken,
    builtInDefinition: builtInTaskViewDefinition,
    capabilities: {
      columns: taskViewColumns,
      fields: taskViewFields,
      layoutModes: ['table', 'board'],
      legacyStatusIds: taskViewLegacyStatusIds,
      requiredColumns: ['title'],
      workflowStatuses: taskViewWorkflowStatuses,
    },
    enabled: Boolean(accessToken && user && !currentUserError),
    onSearchParamsChange: (nextSearchParams) => {
      setSearchParams(nextSearchParams, { replace: true })
    },
    scope: taskViewScope,
    searchParams,
    surface: 'team',
  })
  /** Checks the current Team-qualified ownership scope before exposing a Work Item mutation. */
  const canMutateTeamIssue = useCallback((issue: TeamIssue) => canWriteTaskViewWorkItem({
    writableProjectScopes: taskViewController.writableProjectScopes,
    writableTeamIds: taskViewController.writableTeamIds,
  }, issue), [
    taskViewController.writableProjectScopes,
    taskViewController.writableTeamIds,
  ])
  const hasWritableWorkItemScope = taskViewController.writableTeamIds.length > 0 ||
    taskViewController.writableProjectScopes.length > 0
  const canCreateUnassignedIssue = taskViewController.writableTeamIds.includes(teamId)
  const createIssueProjects = useMemo(() => activeTeam?.projects.filter((project) =>
    taskViewController.writableProjectScopes.some((scope) =>
      scope.teamId === teamId && scope.projectId === project.id
    )
  ) ?? [], [
    activeTeam?.projects,
    taskViewController.writableProjectScopes,
    teamId,
  ])
  const canCreateTeamIssue = canCreateUnassignedIssue || createIssueProjects.length > 0
  const taskViewState = taskViewDefinitionToTeamState(taskViewController.effectiveDefinition)
  const taskViewTeams = useMemo(
    () => {
      const writableTeamIds = new Set(taskViewController.writableTeamIds)
      return filterTaskViewAudienceTeams(
        teams.map((team) => ({ id: team.id, name: team.name })),
        taskViewScope,
      ).filter((team) => writableTeamIds.has(team.id))
    },
    [taskViewController.writableTeamIds, taskViewScope, teams],
  )

  /** Mirrors the server's manager check for one visible dependency endpoint. */
  const canManageDependencyEndpoint = (endpoint: WorkItemDependencyEndpoint) =>
    canManagePlanningWorkItemDependencyEndpoint(
      user,
      endpoint,
      planningSnapshot?.workItems ?? [],
      planningAccess,
    )

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${activeTeam?.name ?? t('issues.title')} | ${t('app.title')}`
  }, [activeTeam?.name, locale, t])

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (currentUserErrorAction?.redirectTo) {
      if (currentUserErrorAction.clearSession) {
        clearAuthSession()
      }
      navigate(currentUserErrorAction.redirectTo, { replace: true })
    }
  }, [
    currentUserErrorAction?.clearSession,
    currentUserErrorAction?.redirectTo,
    navigate,
  ])

  useEffect(() => {
    if (!isCreateIssueRequested) {
      return
    }

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('create')
    setSearchParams(nextSearchParams, { replace: true })
  }, [isCreateIssueRequested, searchParams, setSearchParams])

  const handleCreateIssue = async (input: CreateTeamIssueInput) => {
    if (!accessToken) {
      return
    }
    if (!canWriteTaskViewWorkItem({
      writableProjectScopes: taskViewController.writableProjectScopes,
      writableTeamIds: taskViewController.writableTeamIds,
    }, { assignedProjectId: input.assignedProjectId, teamId })) {
      throw new TeamIssuesApiError(
        403,
        t('taskViews.action.unavailable'),
        'TeamTaskActionAccessDenied',
      )
    }

    const issue = await guardEnterpriseSession(mutationRequestRunner.run(
      `issue:create:${teamId}`,
      JSON.stringify(input),
      (context) => createTeamIssue(teamId, accessToken, input, context),
    ))
    const navigationPath = preserveTaskViewUrlState(
      createTeamIssuesPath(teamId, issue.id),
      searchParams,
    )
    navigate(navigationPath)
    await mutateIssues()
    return { issue, navigationPath }
  }

  const handleUpdateIssue = async (issueId: string, input: UpdateTeamIssueInput) => {
    if (!accessToken) {
      return
    }

    const currentIssue = issueDetail?.issue.id === issueId
      ? issueDetail.issue
      : issues.find((issue) => issue.id === issueId)

    const nextOwnership = {
      assignedProjectId: input.assignedProjectId === undefined
        ? currentIssue?.assignedProjectId
        : input.assignedProjectId ?? undefined,
      teamId: currentIssue?.teamId ?? teamId,
    }
    if (!currentIssue || !canMutateTeamIssue(currentIssue) || !canWriteTaskViewWorkItem({
      writableProjectScopes: taskViewController.writableProjectScopes,
      writableTeamIds: taskViewController.writableTeamIds,
    }, nextOwnership)) {
      throw new TeamIssuesApiError(
        403,
        t('taskViews.action.unavailable'),
        'TeamTaskActionAccessDenied',
      )
    }

    try {
      const updatedIssue = await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:update:${teamId}:${issueId}`,
        JSON.stringify([currentIssue.revision, input]),
        (context) => updateTeamIssue(
          teamId,
          issueId,
          accessToken,
          {
            ...input,
            expectedRevision: currentIssue.revision,
          },
          context,
        ),
      ))
      await mutateIssues()
      await mutateIssueDetail()
      return updatedIssue
    } catch (error) {
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        await Promise.all([mutateIssues(), mutateIssueDetail()])
        throw new Error(t('issues.error.conflict'), { cause: error })
      }

      throw error
    }
  }

  const handleAddRelation = async (
    issueId: string,
    input: WorkItemRelationEditorInput,
  ) => {
    if (!accessToken) {
      return
    }

    const currentIssue = issueDetail?.issue.id === issueId
      ? issueDetail.issue
      : issues.find((issue) => issue.id === issueId)
    if (!currentIssue || !canMutateTeamIssue(currentIssue)) {
      throw new TeamIssuesApiError(
        403,
        t('taskViews.action.unavailable'),
        'TeamTaskActionAccessDenied',
      )
    }

    const graphRevision = readSelectedRelationGraphRevision(issueDetail, issueId, t)

    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:relation:create:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, input]),
        (context) => createWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          { ...input, expectedGraphRevision: graphRevision },
          context,
        ),
      ))
      await mutateIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateIssueDetail)
      throw error
    }
  }

  const handleDeleteRelation = async (issueId: string, relation: WorkItemRelation) => {
    if (!accessToken) {
      return
    }

    const currentIssue = issueDetail?.issue.id === issueId
      ? issueDetail.issue
      : issues.find((issue) => issue.id === issueId)
    if (!currentIssue || !canMutateTeamIssue(currentIssue)) {
      throw new TeamIssuesApiError(
        403,
        t('taskViews.action.unavailable'),
        'TeamTaskActionAccessDenied',
      )
    }

    const graphRevision = readSelectedRelationGraphRevision(issueDetail, issueId, t)

    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:relation:delete:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, relation.type, relation.targetWorkItemId]),
        (context) => deleteWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          {
            expectedGraphRevision: graphRevision,
            targetWorkItemId: relation.targetWorkItemId,
            type: relation.type,
          },
          context,
        ),
      ))
      await mutateIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateIssueDetail)
      throw error
    }
  }

  /** Persists collaboration section navigation for the selected Team Work Item. */
  const handleCollaborationTabChange = (tab: IssueCollaborationTab) => {
    setSearchParams(
      applyIssueCollaborationTabToSearchParams(searchParams, tab),
      { replace: true },
    )
  }

  /** Persists a source provenance target in the selected Work Item route. */
  const handleCollaborationSourceChange = (target: Parameters<NonNullable<IssueCollaborationRoute['onCollaborationSourceChange']>>[0]) => {
    setSearchParams(
      applyIssueCollaborationSourceToSearchParams(searchParams, target),
      { replace: true },
    )
  }

  const taskViewFieldOptions: TaskViewFieldOption[] = [
    { id: 'title', label: t('tasks.column.name') },
    { id: 'status', label: t('tasks.column.status') },
    { id: 'assignee', label: t('tasks.column.assignee') },
    { id: 'dueDate', label: t('tasks.column.dueDate') },
    { id: 'priority', label: t('tasks.column.priority') },
    { id: 'workItemType', label: t('tasks.column.workItemType') },
    { id: 'project', label: t('issues.column.project') },
    ...(taskViewCustomFields.length > 0
      ? [{ id: 'customFields', label: t('workItems.fields.title') }]
      : []),
    ...taskViewCustomFields.map((field) => ({
      id: `custom:${field.id}`,
      label: field.name,
    })),
  ]
  const taskViewGroupOptions = taskViewFieldOptions.filter(
    (option) => option.id !== 'customFields',
  )
  const taskViewOptions = taskViewController.views.map(createTaskViewOption)
  const selectedTaskView = taskViewController.activeSavedView
    ? createTaskViewOption(taskViewController.activeSavedView)
    : undefined
  const taskViewToolbar = (
    <TaskViewToolbar
      builtInName={t('issues.title')}
      canManageShared={taskViewController.canManageShared}
      canSetTeamDefault={taskViewController.canSetTeamDefault}
      canWrite={taskViewController.canWrite}
      columnOptions={taskViewFieldOptions}
      errorMessage={taskViewController.errorMessage}
      groupOptions={taskViewGroupOptions}
      isDirty={taskViewController.isDirty}
      isSaving={taskViewController.isSaving}
      migrationWarnings={taskViewController.migrationWarnings.map(
        formatTaskViewMigrationWarning,
      )}
      onCopyLink={taskViewController.copyPermalink}
      onDelete={taskViewController.deleteView}
      onDuplicate={taskViewController.duplicateView}
      onPatchPreference={taskViewController.patchPreference}
      onReset={taskViewController.resetOverrides}
      onSaveAs={taskViewController.saveAs}
      onSelectView={taskViewController.selectView}
      onSettingsChange={(settings) => {
        taskViewController.setEffectiveDefinition(
          presentationSettingsToTaskViewDefinition(
            taskViewController.effectiveDefinition,
            settings,
          ),
        )
      }}
      onUpdate={taskViewController.updateActiveView}
      selectedView={selectedTaskView}
      settings={taskViewDefinitionToPresentationSettings(
        taskViewController.effectiveDefinition,
      )}
      supportsColumnLayoutMetadata={taskViewState.viewMode === 'table'}
      supportsEmptyGroups={taskViewState.viewMode === 'board'}
      t={t}
      teams={taskViewTeams}
      views={taskViewOptions}
    />
  )

  return (
    <TeamIssueScreen
      aiAssistanceEnabled={workspaceRouteContext?.isAiAssistanceTaskEnabled?.('summary') ?? aiAssistanceUiEnabled}
      activeTaskViewId={taskViewController.activeSavedView?.id}
      accessToken={accessToken}
      assigneeOptions={assigneeOptions}
      artifacts={artifacts}
      canCreateUnassignedIssue={canCreateUnassignedIssue}
      canMutateIssue={canMutateTeamIssue}
      canManageDependencyEndpoint={canManageDependencyEndpoint}
      collaboration={collaboration}
      collaborationRoute={{
        collaborationTab,
        focusedContextItemId,
        focusedSourceId,
        focusedSourceKind,
        focusedActivityEventId,
        onCollaborationTabChange: handleCollaborationTabChange,
        onCollaborationSourceChange: handleCollaborationSourceChange,
      }}
      onAuthenticatedApiError={setAuthenticatedApiError}
      canManageExternalLinks={canManageStructure}
      configurationErrorMessage={configurationErrorMessage}
      currentWorkspaceMemberKey={workspaceAccess?.currentMember.memberKey}
      detailErrorMessage={detailErrorMessage}
      externalLinksAccessToken={accessToken}
      defaultCreateIssueOpen={isCreateIssueRequested}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      issueErrorMessage={issueErrorMessage}
      issues={screenIssues}
      isLoading={isLoading}
      isPlanningLoading={isPlanningLoading}
      isRelationsLoading={Boolean(detailKey && isIssueDetailLoading)}
      key={teamId}
      locale={locale}
      onAddRelation={hasWritableWorkItemScope ? handleAddRelation : undefined}
      createIssueProjects={createIssueProjects}
      onCreateIssue={canCreateTeamIssue && !workItemConfigurationError
        ? handleCreateIssue
        : undefined}
      onCreateScheduleDependency={accessToken && planningSnapshot
        ? dependencyMutations.create
        : undefined}
      onDeleteRelation={hasWritableWorkItemScope ? handleDeleteRelation : undefined}
      onDeleteScheduleDependency={accessToken && planningSnapshot
        ? dependencyMutations.delete
        : undefined}
      onRetryPlanning={planningErrorMessage
        ? () => void Promise.all([mutatePlanning(), mutateProjectRoles()])
            .catch(() => undefined)
        : undefined}
      onSelectIssue={(issueId) => navigate(preserveTaskViewUrlState(
        createTeamIssuesPath(teamId, issueId),
        searchParams,
      ))}
      onUpdateIssue={hasWritableWorkItemScope && !workItemConfigurationError
        ? handleUpdateIssue
        : undefined}
      onUpdateScheduleDependency={accessToken && planningSnapshot
        ? dependencyMutations.update
        : undefined}
      planningErrorMessage={planningErrorMessage}
      planningSnapshot={planningSnapshot}
      selectedIssueId={resolvedSelectedIssueId}
      relations={issueDetail && issueDetail.issue.id === resolvedSelectedIssueId
        ? issueDetail.relations ?? []
        : []}
      resolvedConfiguration={resolvedConfiguration ?? issueDetail?.resolvedConfiguration}
      taskViewToolbar={taskViewToolbar}
      taskViewDefinition={taskViewController.effectiveDefinition}
      taskViewPresentation={taskViewDefinitionToPresentationSettings(
        taskViewController.effectiveDefinition,
      )}
      teamId={teamId}
      teamName={activeTeam?.name}
      teams={teams}
      userInitial={userInitial}
      viewState={taskViewState}
      onViewStateChange={(nextViewState) => {
        taskViewController.setEffectiveDefinition(
          teamStateToTaskViewDefinition(
            taskViewController.effectiveDefinition,
            nextViewState,
          ),
        )
      }}
      workspaceMembers={workspaceAccess?.members ?? emptyWorkspaceMembers}
    />
  )
}

/**
 * チーム所有 Issue の管理 UI を描画する Storybook 兼用 screen です。
 */
export function TeamIssueScreen({
  activeTaskViewId,
  aiAssistanceEnabled = true,
  accessToken,
  assigneeOptions = [],
  artifacts,
  canCreateUnassignedIssue = true,
  canMutateIssue,
  canManageDependencyEndpoint,
  canManageExternalLinks = false,
  collaboration,
  collaborationRoute,
  onAuthenticatedApiError,
  configurationErrorMessage,
  currentWorkspaceMemberKey,
  defaultCreateIssueOpen = false,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  initialViewMode = 'table',
  issueErrorMessage,
  issues = [],
  isLoading = false,
  isPlanningLoading = false,
  isRelationsLoading = false,
  locale,
  onAddRelation,
  onCreateIssue,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onRetryPlanning,
  onSelectIssue,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningErrorMessage,
  planningSnapshot,
  createIssueProjects,
  relations = [],
  resolvedConfiguration,
  selectedIssueId,
  teamId,
  teamName,
  teams,
  taskViewToolbar,
  taskViewDefinition,
  taskViewPresentation,
  userInitial,
  viewState,
  onViewStateChange,
  workspaceMembers = emptyWorkspaceMembers,
}: TeamIssueScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const [localViewMode, setLocalViewMode] = useState<IssueViewMode>(initialViewMode)
  const [localSearchQuery, setLocalSearchQuery] = useState('')
  const [localStatusFilter, setLocalStatusFilter] = useState<string>('all')
  const [localWorkItemTypeFilter, setLocalWorkItemTypeFilter] = useState<string>('all')
  const [localDefinitionFilter, setLocalDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const [isCreateOpen, setIsCreateOpen] = useState(defaultCreateIssueOpen)
  const [createWorkflowStatusId, setCreateWorkflowStatusId] = useState<string>()
  const [createWorkItemTypeId, setCreateWorkItemTypeId] = useState<string>()
  const [createErrorMessage, setCreateErrorMessage] = useState<string | undefined>()
  const [detailUpdateError, setDetailUpdateError] = useState<readonly [string, string] | undefined>()
  const [taskViewSelection, setTaskViewSelection] = useState<TaskViewSelectionState>(
    createTaskViewSelectionState,
  )
  const [taskActionErrorMessage, setTaskActionErrorMessage] = useState<string>()
  const [taskActionContextMenuState, setTaskActionContextMenuState] = useState<
    TeamIssueActionContextMenuState
  >()
  const [taskActionCompletion] = useState(createTaskActionCompletionBridge)
  const directStatusMoveRequestSlotRef = useRef<TaskStatusMoveRequestSlot>({
    current: undefined,
  })
  const pendingCreateContextRef = useRef<TeamIssueCreateContext | undefined>(undefined)
  const onSelectIssueRef = useRef(onSelectIssue)
  const [pendingAiSummaryIssueKey, setPendingAiSummaryIssueKey] = useState<string>()
  const isAiSummaryOperationPendingRef = useRef(false)
  const activeAiSummaryIssueKey = selectedIssueId
    ? createTaskViewItemKey(teamId, selectedIssueId)
    : undefined
  const activeAiSummaryIssueKeyRef = useRef(activeAiSummaryIssueKey)
  const pendingAiSummaryIssueKeyRef = useRef<string | undefined>(undefined)
  const isAiSummaryOperationPending = pendingAiSummaryIssueKey !== undefined &&
    pendingAiSummaryIssueKey === activeAiSummaryIssueKey

  /** Reports a keyed Brief operation so Team navigation can remain fenced. */
  const reportAiSummaryOperationPending = useCallback((
    issueKey: string,
    pending: boolean,
  ) => {
    if (issueKey !== activeAiSummaryIssueKeyRef.current) return
    if (!pending && pendingAiSummaryIssueKeyRef.current !== issueKey) return
    pendingAiSummaryIssueKeyRef.current = pending ? issueKey : undefined
    isAiSummaryOperationPendingRef.current = pending
    setPendingAiSummaryIssueKey(pending ? issueKey : undefined)
    if (pending) setTaskActionContextMenuState(undefined)
  }, [])

  /** Clears the selected Team Issue only when no Brief operation owns the detail pane. */
  const clearSelectedIssueIfAllowed = useCallback(() => {
    if (isAiSummaryOperationPendingRef.current) return
    onSelectIssueRef.current?.('')
  }, [])

  useLayoutEffect(() => {
    activeAiSummaryIssueKeyRef.current = activeAiSummaryIssueKey
  }, [activeAiSummaryIssueKey])
  useEffect(() => {
    isAiSummaryOperationPendingRef.current = isAiSummaryOperationPending
    if (!isAiSummaryOperationPending) {
      pendingAiSummaryIssueKeyRef.current = undefined
    }
  }, [isAiSummaryOperationPending])
  useEffect(() => {
    onSelectIssueRef.current = onSelectIssue
  }, [onSelectIssue])
  useEffect(() => () => {
    taskActionCompletion.cancel()
  }, [taskActionCompletion])
  const viewMode = viewState?.viewMode ?? localViewMode
  const searchQuery = viewState?.searchQuery ?? localSearchQuery
  const statusFilter = viewState?.statusFilter ?? localStatusFilter
  const workItemTypeFilter = viewState?.workItemTypeFilter ?? localWorkItemTypeFilter
  const definitionFilter = viewState?.definitionFilter ?? localDefinitionFilter
  const currentViewState: TeamIssueViewState = {
    definitionFilter,
    searchQuery,
    statusFilter,
    workItemTypeFilter,
    viewMode,
  }

  /** Applies one Team Issue view state locally and forwards it to the route controller. */
  const commitViewState = (nextViewState: TeamIssueViewState) => {
    if (isAiSummaryOperationPendingRef.current) return
    setLocalDefinitionFilter(nextViewState.definitionFilter)
    setLocalSearchQuery(nextViewState.searchQuery)
    setLocalStatusFilter(nextViewState.statusFilter)
    setLocalWorkItemTypeFilter(nextViewState.workItemTypeFilter)
    setLocalViewMode(nextViewState.viewMode)
    onViewStateChange?.(nextViewState)
  }
  const activeTeam = teams.find((team) => team.id === teamId)
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId)
  const dependencySummaries = useMemo(
    () => createWorkItemDependencySummaries(planningSnapshot),
    [planningSnapshot],
  )

  useEffect(() => {
    if (defaultCreateIssueOpen) {
      queueMicrotask(() => setIsCreateOpen(true))
    }
  }, [defaultCreateIssueOpen])

  const configuration = resolvedConfiguration?.configuration
  const workflowStatusFilterOptions = useMemo(
    () => resolveConfiguredWorkflowStatuses(configuration),
    [configuration],
  )
  const workflowStatuses = useMemo(
    () => resolveWorkItemTypeWorkflowStatuses(configuration),
    [configuration],
  )
  const effectiveStatusFilter = statusFilter === 'all' ||
    workflowStatusFilterOptions.some((status) => status.id === statusFilter)
    ? statusFilter
    : 'all'
  const effectiveDefinitionFilter = useMemo(() =>
    !definitionFilter.customFieldId ||
      configuration?.customFields.some((field) => field.id === definitionFilter.customFieldId)
      ? definitionFilter
      : {
          category: definitionFilter.category,
          customFieldId: '',
        },
  [configuration?.customFields, definitionFilter])
  const personLabels = useMemo(
    () => Object.fromEntries(workspaceMembers.map((member) => [member.email, member.name ?? member.email])),
    [workspaceMembers],
  )
  const selectedIssueUpdateErrorKey = selectedIssue
    ? JSON.stringify([selectedIssue.teamId, selectedIssue.id])
    : undefined
  const detailErrorMessageLocal = detailUpdateError && detailUpdateError[0] === selectedIssueUpdateErrorKey
    ? detailUpdateError[1]
    : undefined

  /** Dismisses the Team create form without completing another invocation. */
  const dismissCreateIssueEditor = useCallback(() => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(undefined)
    setCreateWorkItemTypeId(undefined)
    setIsCreateOpen(false)
  }, [])

  /** Opens the Team create form for an already accepted canonical invocation. */
  const showCreateIssueEditor = useCallback((context?: TeamIssueCreateContext) => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(context?.workflowStatusId)
    setCreateWorkItemTypeId(context?.workItemTypeId)
    setIsCreateOpen(true)
  }, [])

  /** Closes the Team create form and clears its contextual defaults. */
  const closeCreateIssue = useCallback(() => {
    taskActionCompletion.cancel('create')
    dismissCreateIssueEditor()
  }, [dismissCreateIssueEditor, taskActionCompletion])

  const visibleIssues = useMemo(
    () => taskViewDefinition
      ? applyTaskViewDefinitionToTasks(issues, taskViewDefinition, {
          keywordMatcher: (issue, normalizedKeyword) => matchesTeamIssueKeyword(
            issue,
            normalizedKeyword,
            activeTeam,
            configuration,
            locale,
            personLabels,
            t,
          ),
        })
      : issues.filter((issue) => {
        const matchesStatus = effectiveStatusFilter === 'all' ||
          resolveWorkItemWorkflowStatusId(issue) === effectiveStatusFilter
        const matchesWorkItemType = workItemTypeFilter === 'all' ||
          createSearchWorkItemTypeKey(
            issue.teamId,
            issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
          ) === workItemTypeFilter
        const matchesDefinition = matchesWorkItemDefinitionFilter(
          issue,
          configuration,
          effectiveDefinitionFilter,
        )
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus || !matchesWorkItemType || !matchesDefinition) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return matchesTeamIssueKeyword(
          issue,
          normalizedQuery,
          activeTeam,
          configuration,
          locale,
          personLabels,
          t,
        )
      }),
    [
      activeTeam,
      configuration,
      effectiveDefinitionFilter,
      effectiveStatusFilter,
      issues,
      locale,
      personLabels,
      searchQuery,
      workItemTypeFilter,
      t,
      taskViewDefinition,
    ],
  )
  const visibleIssueActionTargets = useMemo(
    () => visibleIssues.map((issue) => ({
      expectedRevision: issue.revision,
      teamId: issue.teamId,
      workItemId: issue.id,
    })),
    [visibleIssues],
  )
  const visibleIssueKeys = useMemo(
    () => visibleIssueActionTargets.map((target) =>
      createTaskViewItemKey(target.teamId, target.workItemId)
    ),
    [visibleIssueActionTargets],
  )
  const teamActionSelection = useMemo(
    () => createTaskViewActionSelection(taskViewSelection, visibleIssueActionTargets),
    [taskViewSelection, visibleIssueActionTargets],
  )
  useEffect(() => {
    const pendingContext = taskActionCompletion.current()
    if (
      pendingContext &&
      !isPendingTaskActionFocusCurrent(pendingContext, teamActionSelection)
    ) taskActionCompletion.cancel(pendingContext.actionId)
  }, [taskActionCompletion, teamActionSelection])
  const teamActionScope = useMemo<TeamTaskViewScope>(
    () => ({ kind: 'team', teamId }),
    [teamId],
  )
  const canCreateIssueAction = onCreateIssue !== undefined && !isAiSummaryOperationPending
  const canOpenIssueAction = onSelectIssue !== undefined && !isAiSummaryOperationPending
  const canEditIssueAction = onUpdateIssue !== undefined && canOpenIssueAction
  const canAssignIssueAction = canEditIssueAction && assigneeOptions.length > 0
  const canManageIssueRelationAction = onAddRelation !== undefined && canOpenIssueAction
  /** Checks the exact persisted Work Item ownership scope. */
  const canMutateTeamIssueAction = useCallback((issue: TeamIssue) =>
    canMutateIssue?.(issue) ?? true,
  [canMutateIssue])
  /** Checks whether one visible Team Issue has a different reachable workflow status. */
  const canMoveTeamIssueAction = useCallback((issue: TeamIssue) =>
    !isAiSummaryOperationPending && canEditIssueAction && canMutateTeamIssueAction(issue) &&
      resolveEditableWorkflowStatuses(issue, configuration).some(
      (status) => status.id !== issue.workflowStatusId,
    ), [canEditIssueAction, canMutateTeamIssueAction, configuration, isAiSummaryOperationPending])
  const teamActionLabels = useMemo<TaskSurfaceActionLabels>(() => ({
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
  const teamActionDisabledReasons = useMemo<TaskSurfaceActionDisabledReasons>(() => ({
    selectionRequired: t('taskViews.action.selectionRequired'),
    singleSelectionRequired: t('taskViews.action.singleSelectionRequired'),
    unavailable: t('taskViews.action.unavailable'),
  }), [t])

  /** Opens one Team Issue detail and focuses an existing mutation control when requested. */
  const executeTeamIssueDetailAction = useCallback((
    context: WorkItemActionContext,
    controlSelector?: string,
    waitForMutation = false,
  ): Promise<WorkItemActionResult> | WorkItemActionResult => {
    const target = resolveTaskSurfaceActionTarget(context)
    if (isAiSummaryOperationPendingRef.current) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'TeamTaskAiOperationPending',
        'unavailable',
        teamActionDisabledReasons.unavailable,
      )
    }
    const issue = target
      ? visibleIssues.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    if (!target || !issue) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'TeamTaskActionTargetNotFound',
        'not-found',
        t('taskViews.action.notFound'),
      )
    }

    const completion = waitForMutation
      ? taskActionCompletion.begin(context, clearSelectedIssueIfAllowed)
      : undefined
    setDetailUpdateError(undefined)
    if (!completion) taskActionCompletion.cancel()
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(issue.teamId, issue.id),
      type: 'focus',
    }))
    onSelectIssueRef.current?.(issue.id)
    if (controlSelector) focusTeamIssueDetailControl(controlSelector)
    return completion ?? createSucceededTaskActionResult(context.actionId, target)
  }, [clearSelectedIssueIfAllowed, t, taskActionCompletion, teamActionDisabledReasons.unavailable, visibleIssues])

  const currentTeamActionTarget = teamActionSelection.targets.length === 1
    ? teamActionSelection.targets[0]
    : teamActionSelection.targets.length === 0
      ? teamActionSelection.focusedTarget
      : undefined
  const toggleIssueWatch = currentTeamActionTarget &&
      selectedIssue?.teamId === currentTeamActionTarget.teamId &&
      selectedIssue.id === currentTeamActionTarget.workItemId &&
      collaboration?.watch &&
      collaboration.capabilities.canWatch
    ? collaboration.toggleWatch
    : undefined
  const canMutateSelectedIssue = selectedIssue !== undefined &&
    canMutateTeamIssueAction(selectedIssue)

  /** Executes a destination-bearing Board Move or reveals the detail selector for other entrances. */
  const executeTeamIssueMoveAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult | Promise<WorkItemActionResult> => {
    const requestSlot = directStatusMoveRequestSlotRef.current
    if (!requestSlot.current) {
      return executeTeamIssueDetailAction(
        context,
        'select[name="workflowStatusId"]',
        true,
      )
    }

    taskActionCompletion.cancel()
    return executeTeamIssueDirectStatusMove(
      context,
      requestSlot,
      visibleIssues,
      configuration,
      onUpdateIssue,
      {
        conflict: t('tasks.action.conflict'),
        failed: t('taskViews.action.failed'),
        unavailable: teamActionDisabledReasons.unavailable,
      },
    ) ?? createFailedTaskActionResult(
      context.actionId,
      resolveTaskSurfaceActionTarget(context),
      'TeamTaskMoveRequestMismatch',
      'validation',
      teamActionDisabledReasons.unavailable,
    )
  }, [
    configuration,
    executeTeamIssueDetailAction,
    onUpdateIssue,
    t,
    taskActionCompletion,
    teamActionDisabledReasons.unavailable,
    visibleIssues,
  ])

  const teamActionHandlers = useMemo<TaskSurfaceActionHandlers>(() => ({
    ...(canCreateIssueAction
      ? {
          create: (context) => {
            const createContext = pendingCreateContextRef.current
            pendingCreateContextRef.current = undefined
            const completion = taskActionCompletion.begin(context, dismissCreateIssueEditor)
            showCreateIssueEditor(createContext)
            return completion
          },
        }
      : {}),
    ...(canOpenIssueAction
      ? {
          open: (context) => executeTeamIssueDetailAction(context),
        }
      : {}),
    ...(canEditIssueAction
      ? {
          edit: (context) => executeTeamIssueDetailAction(
            context,
            'input[name="title"]',
            true,
          ),
          move: executeTeamIssueMoveAction,
        }
      : {}),
    ...(canAssignIssueAction
      ? {
          assign: (context) => executeTeamIssueDetailAction(
            context,
            'select[name="assigneeUserId"]',
            true,
          ),
        }
      : {}),
    ...(canManageIssueRelationAction
      ? {
          relation: (context) => executeTeamIssueDetailAction(
            context,
            '[data-testid="work-item-relations-editor"] select',
            true,
          ),
        }
      : {}),
    ...(toggleIssueWatch
      ? {
          watch: async (context) => {
            const target = resolveTaskSurfaceActionTarget(context)
            if (
              !target ||
              !selectedIssue ||
              selectedIssue.teamId !== target.teamId ||
              selectedIssue.id !== target.workItemId
            ) {
              return createFailedTaskActionResult(
                context.actionId,
                target,
                'TeamTaskActionTargetNotFound',
                'not-found',
                t('taskViews.action.notFound'),
              )
            }
            const succeeded = await toggleIssueWatch()
            return succeeded
              ? createSucceededTaskActionResult(context.actionId, target)
              : createFailedTaskActionResult(
                  context.actionId,
                  target,
                  'TeamTaskWatchFailed',
                  'unknown',
                  t('taskViews.action.failed'),
                )
          },
        }
      : {}),
  }), [
    canAssignIssueAction,
    canCreateIssueAction,
    canEditIssueAction,
    canManageIssueRelationAction,
    canOpenIssueAction,
    dismissCreateIssueEditor,
    executeTeamIssueDetailAction,
    executeTeamIssueMoveAction,
    selectedIssue,
    showCreateIssueEditor,
    t,
    taskActionCompletion,
    toggleIssueWatch,
  ])

  /** Evaluates one Team detail entrance against its revision-bound visible target. */
  const evaluateTeamIssueTargetPermission = useCallback((context: WorkItemActionContext) => {
    if (isAiSummaryOperationPendingRef.current) {
      return denyTaskAction(teamActionDisabledReasons.unavailable)
    }
    const targets = resolveTaskSurfaceActionTargets(context)
    if (targets.length === 0) return allowTaskAction()
    if (targets.length !== 1) {
      return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
    }
    const target = targets[0]
    return target && visibleIssues.some((issue) =>
      issue.teamId === target.teamId && issue.id === target.workItemId
    )
      ? allowTaskAction()
      : denyTaskAction(teamActionDisabledReasons.unavailable)
  }, [teamActionDisabledReasons, visibleIssues])

  /** Evaluates one canonical mutation against the current Team-qualified Work Item scope. */
  const evaluateTeamIssueMutationPermission = useCallback((context: WorkItemActionContext) => {
    if (isAiSummaryOperationPendingRef.current) {
      return denyTaskAction(teamActionDisabledReasons.unavailable)
    }
    const targets = resolveTaskSurfaceActionTargets(context)
    if (targets.length === 0) return allowTaskAction()
    if (targets.length !== 1) {
      return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
    }
    const target = targets[0]
    const issue = target
      ? visibleIssues.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    return issue && canMutateTeamIssueAction(issue)
      ? allowTaskAction()
      : denyTaskAction(teamActionDisabledReasons.unavailable)
  }, [
    canMutateTeamIssueAction,
    teamActionDisabledReasons,
    visibleIssues,
  ])

  const teamActionPermissions = useMemo<TaskSurfaceActionPermissions>(() => ({
    assign: evaluateTeamIssueMutationPermission,
    edit: evaluateTeamIssueMutationPermission,
    move: (context) => {
      if (isAiSummaryOperationPendingRef.current) {
        return denyTaskAction(teamActionDisabledReasons.unavailable)
      }
      const targets = resolveTaskSurfaceActionTargets(context)
      if (targets.length === 0) return allowTaskAction()
      if (targets.length !== 1) {
        return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
      }
      const target = targets[0]
      const issue = target
        ? visibleIssues.find((candidate) =>
            candidate.teamId === target.teamId && candidate.id === target.workItemId
          )
        : undefined
      return issue && canMoveTeamIssueAction(issue)
        ? allowTaskAction()
        : denyTaskAction(teamActionDisabledReasons.unavailable)
    },
    open: evaluateTeamIssueTargetPermission,
    relation: evaluateTeamIssueMutationPermission,
    watch: (context) => {
      if (isAiSummaryOperationPendingRef.current) {
        return denyTaskAction(teamActionDisabledReasons.unavailable)
      }
      const target = resolveTaskSurfaceActionTarget(context)
      return target && selectedIssue && toggleIssueWatch &&
          selectedIssue.teamId === target.teamId && selectedIssue.id === target.workItemId
        ? allowTaskAction()
        : denyTaskAction(teamActionDisabledReasons.unavailable)
    },
  }), [
    canMoveTeamIssueAction,
    evaluateTeamIssueMutationPermission,
    evaluateTeamIssueTargetPermission,
    selectedIssue,
    teamActionDisabledReasons,
    toggleIssueWatch,
    visibleIssues,
  ])

  /**
   * Projects normalized Team action failures into an accessible local notice.
   *
   * @param result - Canonical action execution result to present.
   * @returns Nothing.
   */
  const handleTeamActionExecution = useCallback((result: TaskActionExecutionResult) => {
    setTaskActionErrorMessage(resolveTaskActionExecutionFailureMessage(
      result,
      t('taskViews.action.failed'),
    ))
  }, [t])

  const teamActions = useTaskSurfaceActions({
    ...(activeTaskViewId !== undefined ? { activeViewId: activeTaskViewId } : {}),
    disabledReasons: teamActionDisabledReasons,
    handlers: teamActionHandlers,
    labels: teamActionLabels,
    onExecutionResult: handleTeamActionExecution,
    permissions: teamActionPermissions,
    registrationId: `team-task-actions:${teamId}`,
    scope: teamActionScope,
    selection: teamActionSelection,
    surface: 'team',
  })

  /** Routes a Team Board status selection or drop through the canonical Move registry. */
  const handleTeamIssueStatusMove = useCallback(async (
    issue: TeamIssue,
    destinationWorkflowStatusId: string,
  ): Promise<void> => {
    if (isAiSummaryOperationPendingRef.current) return
    const target = {
      expectedRevision: issue.revision,
      teamId: issue.teamId,
      workItemId: issue.id,
    }
    const request = createTaskStatusMoveRequest(target, destinationWorkflowStatusId)
    const requestSlot = directStatusMoveRequestSlotRef.current
    requestSlot.current = request
    setTaskActionErrorMessage(undefined)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(issue.teamId, issue.id),
      type: 'focus',
    }))

    try {
      await teamActions.execute(
        'move',
        'click',
        undefined,
        createFocusedTaskViewActionSelection(target),
      )
    } finally {
      clearTaskStatusMoveRequest(requestSlot, request)
    }
  }, [teamActions])

  /**
   * Routes header and Board-column Create clicks through the canonical Team registry.
   *
   * @param workflowStatusId - Optional Board-column status default for the create editor.
   * @param workItemTypeId - Optional Board-column Work Item Type default for the create editor.
   */
  const handleTeamCreateClick = useCallback((workflowStatusId?: string, workItemTypeId?: string) => {
    if (isAiSummaryOperationPendingRef.current) return
    pendingCreateContextRef.current = { workflowStatusId, workItemTypeId }
    void teamActions.execute(
      'create',
      'click',
      undefined,
      { mode: 'none', targets: [] },
    )
  }, [teamActions])

  /**
   * Returns a detail-form mutation outcome to a pending Edit, Move, or Assign action.
   *
   * @param issueId - Team Issue persisted by the existing detail form.
   * @param input - Validated detail patch submitted by the form.
   * @returns Nothing after the existing mutation and completion bridge settle.
   */
  const handleTeamIssueActionUpdate = useCallback(async (
    issueId: string,
    input: UpdateTeamIssueInput,
  ): Promise<void> => {
    if (!onUpdateIssue || isAiSummaryOperationPendingRef.current) return
    const pendingCandidate = resolvePendingTaskActionContext(
      taskActionCompletion,
      ['assign', 'edit', 'move', 'relation'],
      { teamId, workItemId: issueId },
    )
    const currentIssue = selectedIssue?.id === issueId ? selectedIssue : undefined
    const pendingContext = pendingCandidate && (
      pendingCandidate.actionId === 'edit' ||
      (pendingCandidate.actionId === 'move' &&
        currentIssue !== undefined &&
        input.workflowStatusId !== resolveWorkItemWorkflowStatusId(currentIssue)) ||
      (pendingCandidate.actionId === 'assign' &&
        input.assigneeUserId !== undefined &&
        input.assigneeUserId !== currentIssue?.assigneeUserId)
    )
      ? pendingCandidate
      : undefined
    if (pendingCandidate && !pendingContext) {
      taskActionCompletion.cancelContext(pendingCandidate)
    }
    const target = pendingContext
      ? resolveTaskSurfaceActionTarget(pendingContext)
      : undefined
    const claimedContext = pendingContext && target && taskActionCompletion.claim(pendingContext)
      ? pendingContext
      : undefined
    setDetailUpdateError(undefined)

    try {
      const updatedIssue = await onUpdateIssue(issueId, input)
      if (claimedContext && target) {
        taskActionCompletion.settle(claimedContext, createSucceededTaskActionMutationResult(
          claimedContext.actionId,
          target,
          updatedIssue?.revision,
        ))
      }
    } catch (error) {
      if (claimedContext) {
        const isConflict = isTeamIssueRevisionConflict(error)
        const canDismissOwner = canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        )
        taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
          claimedContext.actionId,
          target,
          isConflict ? 'WorkItemRevisionConflict' : 'TeamTaskActionMutationFailed',
          isConflict ? 'conflict' : 'unknown',
          isConflict ? t('tasks.action.conflict') : t('taskViews.action.failed'),
          isConflict,
        ))
        if (canDismissOwner) clearSelectedIssueIfAllowed()
      }
      if (
        selectedIssueUpdateErrorKey &&
        (!claimedContext || canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        ))
      ) {
        setDetailUpdateError([
          selectedIssueUpdateErrorKey,
          error instanceof Error ? error.message : t('issues.error.update'),
        ])
      }
    }
  }, [
    onUpdateIssue,
    selectedIssueUpdateErrorKey,
    selectedIssue,
    t,
    taskActionCompletion,
    teamId,
    clearSelectedIssueIfAllowed,
  ])

  /**
   * Returns a relation editor mutation to a pending canonical Relation action.
   *
   * @param issueId - Team Issue whose relation graph is being changed.
   * @param mutate - Existing add or delete relation mutation.
   * @returns Nothing after the relation graph refresh completes.
   */
  const handleTeamIssueActionRelation = useCallback(async (
    issueId: string,
    mutate: () => Promise<void>,
  ): Promise<void> => {
    if (isAiSummaryOperationPendingRef.current) return
    const pendingCandidate = resolvePendingTaskActionContext(
      taskActionCompletion,
      ['assign', 'edit', 'move', 'relation'],
      { teamId, workItemId: issueId },
    )
    const pendingContext = pendingCandidate?.actionId === 'relation'
      ? pendingCandidate
      : undefined
    if (pendingCandidate && !pendingContext) {
      taskActionCompletion.cancelContext(pendingCandidate)
    }
    const target = pendingContext
      ? resolveTaskSurfaceActionTarget(pendingContext)
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
          isConflict ? 'WorkItemRelationGraphConflict' : 'TeamTaskRelationMutationFailed',
          isConflict ? 'conflict' : 'unknown',
          t('taskViews.action.failed'),
          isConflict,
        ))
        if (canDismissOwner) clearSelectedIssueIfAllowed()
      }
      throw error
    }
  }, [clearSelectedIssueIfAllowed, t, taskActionCompletion, teamId])

  const taskActionContextMenuContext = useMemo(() => {
    if (!taskActionContextMenuState) return undefined
    return createTaskSurfaceActionBaseContext(
      'team',
      teamActionScope,
      taskActionContextMenuState.selection,
      activeTaskViewId,
    )
  }, [
    activeTaskViewId,
    taskActionContextMenuState,
    teamActionScope,
  ])

  useEffect(() => {
    queueMicrotask(() => {
      setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
        availableKeys: visibleIssueKeys,
        type: 'prune',
      }))
    })
  }, [visibleIssueKeys])

  /**
   * Opens one clicked Team Issue through the canonical action registry.
   *
   * @param issue - Visible Team Issue activated by pointer input.
   * @returns Nothing.
   */
  const handleOpenIssue = useCallback((issue: TeamIssue) => {
    if (isAiSummaryOperationPendingRef.current) return
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: issueKey,
      type: 'focus',
    }))
    void teamActions.execute(
      'open',
      'click',
      undefined,
      createFocusedTaskViewActionSelection({
        expectedRevision: issue.revision,
        teamId: issue.teamId,
        workItemId: issue.id,
      }),
    )
  }, [teamActions])

  /** Opens a revision-bound Team Issue menu without inheriting unrelated selection. */
  const handleTeamIssueActionMenuOpen = useCallback<TeamIssueActionMenuOpenHandler>((
    issue,
    anchorPoint,
    returnFocusElement,
  ) => {
    if (isAiSummaryOperationPendingRef.current) return
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: issueKey,
      type: 'focus',
    }))
    setTaskActionContextMenuState({
      anchorPoint,
      returnFocusElement,
      selection: createFocusedTaskViewActionSelection({
        expectedRevision: issue.revision,
        teamId: issue.teamId,
        workItemId: issue.id,
      }),
    })
  }, [])

  /** Routes one Team Issue menu activation through the canonical action registry. */
  const handleTeamIssueActionMenuExecute = useCallback((actionId: WorkItemActionId) => {
    if (isAiSummaryOperationPendingRef.current || !taskActionContextMenuState) return
    void teamActions.execute(
      actionId,
      'context-menu',
      undefined,
      taskActionContextMenuState.selection,
    )
  }, [taskActionContextMenuState, teamActions])

  useEffect(() => {
    /**
     * Routes Team navigation and action shortcuts through shared reducers and registry policy.
     *
     * @param event - Document keydown event to normalize and route.
     * @returns Nothing.
     */
    const handleTeamKeyboard = (event: KeyboardEvent) => {
      if (isAiSummaryOperationPendingRef.current) return
      const input = createTaskSurfaceKeyboardInput(
        event,
        isCreateOpen || Boolean(taskActionContextMenuState),
      )
      const selectionAction = createTaskViewSelectionKeyboardAction(
        input,
        taskViewSelection,
        visibleIssueKeys,
      )
      if (selectionAction) {
        event.preventDefault()
        taskActionCompletion.cancel()
        setTaskActionErrorMessage(undefined)
        setTaskViewSelection(reduceTaskViewSelection(taskViewSelection, selectionAction))
        return
      }

      const definition = teamActions.resolveShortcut(input)
      if (!definition) return
      event.preventDefault()
      void teamActions.execute(
        definition.id,
        'keyboard',
        definition.shortcut
          ? formatTaskSurfaceKeyboardShortcut(definition.shortcut)
          : undefined,
      )
    }

    document.addEventListener('keydown', handleTeamKeyboard)
    return () => document.removeEventListener('keydown', handleTeamKeyboard)
  }, [
    isCreateOpen,
    taskActionContextMenuState,
    taskActionCompletion,
    taskViewSelection,
    teamActions,
    visibleIssueKeys,
  ])

  return (
    <>
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={openMobileSidebar}
              />
              <div className="min-w-0">
                <p className="workbench-eyebrow">
                  {t('issues.eyebrow')}
                </p>
                <h1
                  className="workbench-title mt-2 truncate text-page-title"
                  data-testid="team-issues-heading"
                >
                  {teamName ?? t('issues.title')}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {t('issues.description')}
                </p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              {onCreateIssue ? (
                <button
                  aria-expanded={isCreateOpen}
                  className="workbench-button-primary inline-flex h-10 items-center gap-2 px-4"
                  disabled={isAiSummaryOperationPending}
                  onClick={() => isCreateOpen ? closeCreateIssue() : handleTeamCreateClick()}
                  type="button"
                >
                  + {t('issues.action.new')}
                </button>
              ) : null}
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                {userInitial}
              </div>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(360px,440px)] gap-0 max-[1080px]:grid-cols-1">
              <section className="min-w-0 px-[clamp(20px,3vw,34px)] py-5">
                {configurationErrorMessage ? (
                  <p
                    className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
                    role="alert"
                  >
                    {configurationErrorMessage}
                  </p>
                ) : null}
                {isCreateOpen && onCreateIssue ? (
                  <CreateIssuePanel
                    key={`create-issue-${createWorkItemTypeId ?? ''}-${createWorkflowStatusId ?? ''}`}
                    assigneeOptions={assigneeOptions}
                    canCreateUnassignedIssue={canCreateUnassignedIssue}
                    configuration={configuration}
                    errorMessage={createErrorMessage}
                    workItemTypeId={createWorkItemTypeId}
                    workflowStatusId={createWorkflowStatusId}
                    locale={locale}
                    onCancel={() => {
                      closeCreateIssue()
                    }}
                    onSubmit={async (input) => {
                      if (!onCreateIssue || isAiSummaryOperationPendingRef.current) {
                        return
                      }

                      setCreateErrorMessage(undefined)

                      const pendingContext = resolvePendingTaskActionContext(
                        taskActionCompletion,
                        ['create'],
                      )
                      const claimedContext = pendingContext &&
                          taskActionCompletion.claim(pendingContext)
                        ? pendingContext
                        : undefined
                      try {
                        const createdMutation = await onCreateIssue(input)
                        const canDismissOwner = claimedContext
                          ? canDismissCompletedTaskActionOwner(
                              taskActionCompletion,
                              claimedContext,
                            )
                          : true
                        if (claimedContext) {
                          taskActionCompletion.settle(claimedContext, createSucceededTaskCreateActionResult(
                            createdMutation
                              ? {
                                  expectedRevision: createdMutation.issue.revision,
                                  teamId: createdMutation.issue.teamId,
                                  workItemId: createdMutation.issue.id,
                                }
                              : undefined,
                            createdMutation?.navigationPath,
                          ))
                        }
                        if (canDismissOwner) dismissCreateIssueEditor()
                      } catch (error) {
                        if (claimedContext) {
                          const canDismissOwner = canDismissCompletedTaskActionOwner(
                            taskActionCompletion,
                            claimedContext,
                          )
                          taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
                            claimedContext.actionId,
                            undefined,
                            'TeamTaskCreateFailed',
                            'unknown',
                            t('issues.error.create'),
                          ))
                          if (canDismissOwner) dismissCreateIssueEditor()
                        }
                        if (!claimedContext) {
                          setCreateErrorMessage(
                            error instanceof Error ? error.message : t('issues.error.create'),
                          )
                        }
                      }
                    }}
                    projects={createIssueProjects ?? activeTeam?.projects ?? []}
                    t={t}
                    workspaceMembers={workspaceMembers}
                  />
                ) : null}
                {taskViewToolbar}
                <IssueToolbar
                  onSearchQueryChange={(nextSearchQuery) => commitViewState({
                    ...currentViewState,
                    searchQuery: nextSearchQuery,
                  })}
                  onStatusFilterChange={(nextStatusFilter) => commitViewState({
                    ...currentViewState,
                    statusFilter: nextStatusFilter,
                  })}
                  onWorkItemTypeFilterChange={(nextWorkItemTypeFilter) => commitViewState({
                    ...currentViewState,
                    workItemTypeFilter: nextWorkItemTypeFilter,
                  })}
                  onViewModeChange={(nextViewMode) => commitViewState({
                    ...currentViewState,
                    viewMode: nextViewMode,
                  })}
                  searchQuery={searchQuery}
                  statusFilter={effectiveStatusFilter}
                  teamId={teamId}
                  t={t}
                  viewMode={viewMode}
                  workItemTypeFilter={workItemTypeFilter}
                  workItemTypes={resolveWorkItemTypes(configuration)}
                  workflowStatuses={workflowStatusFilterOptions}
                />
                <div className="workbench-toolbar mt-3 px-3 py-2">
                  <WorkItemDefinitionFilters
                    configuration={configuration}
                    idPrefix="team-issues"
                    locale={locale}
                    onChange={(nextDefinitionFilter) => commitViewState({
                      ...currentViewState,
                      definitionFilter: nextDefinitionFilter,
                    })}
                    personOptions={resolveWorkItemPersonOptions(workspaceMembers)}
                    value={effectiveDefinitionFilter}
                  />
                </div>
                {issueErrorMessage ? (
                  <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
                    {issueErrorMessage}
                  </p>
                ) : null}
                {planningErrorMessage ? (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
                    <p className="text-sm font-bold text-red-700">{planningErrorMessage}</p>
                    {onRetryPlanning ? (
                      <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetryPlanning} type="button">
                        {t('planning.action.retry')}
                      </button>
                    ) : null}
                  </div>
                ) : isPlanningLoading ? (
                  <p className="mt-5 text-sm font-semibold text-[var(--workbench-muted)]">
                    {t('planning.loading')}
                  </p>
                ) : null}
                {taskActionErrorMessage ? (
                  <p
                    className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
                    role="alert"
                  >
                    {taskActionErrorMessage}
                  </p>
                ) : null}
                <div
                  aria-label={t(`issues.view.${viewMode}`)}
                  id={issueViewPanelId}
                  role="region"
                >
                  {viewMode === 'table' ? (
                    <IssueTable
                      activeTeam={activeTeam}
                      configuration={configuration}
                      dependencySummaries={dependencySummaries}
                      focusedIssueKey={taskViewSelection.focusedKey}
                      isAiOperationPending={isAiSummaryOperationPending}
                      issues={visibleIssues}
                      presentation={taskViewPresentation}
                      locale={locale}
                      onIssueActionMenuOpen={handleTeamIssueActionMenuOpen}
                      onOpenIssue={canOpenIssueAction ? handleOpenIssue : undefined}
                      selectedIssueKeys={taskViewSelection.selectedKeys}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workspaceMembers={workspaceMembers}
                    />
                  ) : (
                    <IssueBoard
                      activeTeam={activeTeam}
                      configuration={configuration}
                      dependencySummaries={dependencySummaries}
                      focusedIssueKey={taskViewSelection.focusedKey}
                      isAiOperationPending={isAiSummaryOperationPending}
                      issues={visibleIssues}
                      presentation={taskViewPresentation}
                      locale={locale}
                      canMoveIssueStatus={canMoveTeamIssueAction}
                      onCreateIssueOpen={onCreateIssue ? handleTeamCreateClick : undefined}
                      onIssueActionMenuOpen={handleTeamIssueActionMenuOpen}
                      onMoveIssueStatus={canEditIssueAction
                        ? handleTeamIssueStatusMove
                        : undefined}
                      onOpenIssue={canOpenIssueAction ? handleOpenIssue : undefined}
                      selectedIssueKeys={taskViewSelection.selectedKeys}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workflowStatuses={workflowStatuses}
                      workspaceMembers={workspaceMembers}
                    />
                  )}
                </div>
              </section>
              <IssueDetailPane
                aiAssistanceEnabled={aiAssistanceEnabled}
                accessToken={accessToken}
                assigneeOptions={assigneeOptions}
                artifacts={artifacts}
                canManageDependencyEndpoint={canManageDependencyEndpoint}
                canManageExternalLinks={canManageExternalLinks}
                collaboration={collaboration}
                collaborationRoute={collaborationRoute}
                configuration={configuration}
                currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                detailErrorMessage={detailErrorMessage ?? detailErrorMessageLocal}
                externalLinksAccessToken={externalLinksAccessToken}
                focusedCommentId={focusedCommentId}
                focusedRootCommentId={focusedRootCommentId}
                issue={selectedIssue}
                isAiSummaryOperationPending={isAiSummaryOperationPending}
                isRelationsLoading={isRelationsLoading}
                locale={locale}
                onAuthenticatedApiError={onAuthenticatedApiError}
                onAiSummaryOperationPendingChange={reportAiSummaryOperationPending}
                onAddRelation={canMutateSelectedIssue && onAddRelation
                  ? (issueId, input) => handleTeamIssueActionRelation(
                      issueId,
                      () => onAddRelation(issueId, input),
                    )
                  : undefined}
                onCreateScheduleDependency={canMutateSelectedIssue
                  ? onCreateScheduleDependency
                  : undefined}
                onDeleteRelation={canMutateSelectedIssue && onDeleteRelation
                  ? (issueId, relation) => handleTeamIssueActionRelation(
                      issueId,
                      () => onDeleteRelation(issueId, relation),
                    )
                  : undefined}
                onDeleteScheduleDependency={canMutateSelectedIssue
                  ? onDeleteScheduleDependency
                  : undefined}
                onUpdateIssue={canMutateSelectedIssue && onUpdateIssue
                  ? handleTeamIssueActionUpdate
                  : undefined}
                onUpdateScheduleDependency={canMutateSelectedIssue
                  ? onUpdateScheduleDependency
                  : undefined}
                planningSnapshot={planningSnapshot}
                canAssignUnassigned={canCreateUnassignedIssue}
                projects={createIssueProjects ?? activeTeam?.projects ?? []}
                relationCandidates={issues}
                relations={relations}
                t={t}
                workspaceMembers={workspaceMembers}
              />
            </div>
          </div>
        )}
        {taskActionContextMenuState && taskActionContextMenuContext ? (
          <TaskActionContextMenu
            anchorPoint={taskActionContextMenuState.anchorPoint}
            context={taskActionContextMenuContext}
            labels={teamActionLabels}
            menuLabel={t('tasks.action.more')}
            onClose={() => setTaskActionContextMenuState(undefined)}
            onExecute={handleTeamIssueActionMenuExecute}
            registry={teamActions.registry}
            returnFocusElement={taskActionContextMenuState.returnFocusElement}
            testId="team-issue-action-context-menu"
          />
        ) : null}
    </>
  )
}

/**
 * Issue 一覧の検索、status filter、表示切り替えをまとめた toolbar です。
 */
function IssueToolbar({
  onSearchQueryChange,
  onStatusFilterChange,
  onWorkItemTypeFilterChange,
  onViewModeChange,
  searchQuery,
  statusFilter,
  teamId,
  t,
  viewMode,
  workItemTypeFilter,
  workItemTypes,
  workflowStatuses,
}: {
  /**
   * 検索 query を更新する callback です。
   */
  onSearchQueryChange: (query: string) => void
  /**
   * Workflow status filter を更新する callback です。
   */
  onStatusFilterChange: (status: string) => void
  /** Team-qualified Work Item Type filter callback. */
  onWorkItemTypeFilterChange: (workItemTypeKey: string) => void
  /**
   * Issue 表示 mode を更新する callback です。
   */
  onViewModeChange: (mode: IssueViewMode) => void
  /**
   * 検索 input の現在値です。
   */
  searchQuery: string
  /**
   * Status select の現在値です。
   */
  statusFilter: string
  /** Team-qualified Work Item Type key or the all-type sentinel. */
  workItemTypeFilter: string
  /** Team owning the Work Item Type definitions shown in this toolbar. */
  teamId: string
  /**
   * 画面文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * 現在表示中の Issue view mode です。
   */
  viewMode: IssueViewMode
  /** Work Item Types available to the Team. */
  workItemTypes: ReturnType<typeof resolveWorkItemTypes>
  /**
   * Status filter に表示する workflow status です。
   */
  workflowStatuses: readonly WorkflowStatusDefinition[]
}) {
  return (
    <div className="workbench-toolbar flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1">
          <span className="sr-only">{t('issues.search')}</span>
          <input
            aria-label={t('issues.search')}
            className="workbench-input h-9 w-[min(260px,calc(100vw-52px))] px-3.5 placeholder:text-[var(--workbench-muted-soft)]"
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={t('issues.search')}
            type="search"
            value={searchQuery}
          />
        </label>
        <select
          aria-label={t('issues.filter.status')}
          className="workbench-input h-9 px-3"
          onChange={(event) => onStatusFilterChange(event.target.value)}
          value={statusFilter}
        >
          <option value="all">{t('tasks.filter.statusAll')}</option>
          {workflowStatuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t('tasks.filter.workItemType')}
          className="workbench-input h-9 px-3"
          onChange={(event) => onWorkItemTypeFilterChange(event.target.value)}
          value={workItemTypeFilter}
        >
          <option value="all">{t('tasks.filter.workItemTypeAll')}</option>
          {workItemTypes.map((type) => (
            <option
              key={createSearchWorkItemTypeKey(teamId, type.id)}
              value={createSearchWorkItemTypeKey(teamId, type.id)}
            >
              {type.name}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-flex h-9 overflow-hidden rounded-[7px] border border-[var(--workbench-border-strong)] bg-white">
        {(['table', 'board'] as const).map((mode) => (
          <button
            aria-controls={issueViewPanelId}
            aria-pressed={viewMode === mode}
            className={`px-3.5 text-sm font-semibold transition ${
              viewMode === mode ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            key={mode}
            onClick={() => onViewModeChange(mode)}
            type="button"
          >
            {t(`issues.view.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

function CreateIssuePanel({
  assigneeOptions,
  canCreateUnassignedIssue,
  configuration,
  errorMessage,
  locale,
  onCancel,
  onSubmit,
  projects,
  t,
  workItemTypeId,
  workflowStatusId,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  /** Whether an unassigned Team-owned Work Item is an authorized create destination. */
  canCreateUnassignedIssue: boolean
  configuration?: WorkItemConfiguration
  errorMessage?: string
  locale: Locale
  onCancel: () => void
  onSubmit: (input: CreateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
  /** Initial Work Item Type inherited from a Board column. */
  workItemTypeId?: string
  workflowStatusId?: string
  workspaceMembers: WorkspaceMember[]
}) {
  const today = formatLocalDateInputValue()
  const [selectedProjectId, setSelectedProjectId] = useState(
    canCreateUnassignedIssue ? '' : projects[0]?.id ?? '',
  )
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workItemTypes = resolveWorkItemTypes(configuration)
  const creatableWorkItemTypes = workItemTypes.filter((type) => type.status === 'active')
  const hasCreatableWorkItemType = creatableWorkItemTypes.length > 0
  const contextualWorkItemTypeId = workItemTypeId && creatableWorkItemTypes.some((type) =>
    type.id === workItemTypeId,
  )
    ? workItemTypeId
    : undefined
  const [selectedWorkItemTypeId, setSelectedWorkItemTypeId] = useState(
    contextualWorkItemTypeId ?? creatableWorkItemTypes[0]?.id ?? 'default',
  )
  const effectiveWorkItemTypeId = resolveCreatableWorkItemTypeId(
    workItemTypes,
    selectedWorkItemTypeId,
  )
  const selectedWorkItemType = resolveWorkItemTypeDefinition(configuration, effectiveWorkItemTypeId) ??
    creatableWorkItemTypes[0]
  const customFieldDefinitions = resolveWorkItemTypeFormFields(
    configuration,
    effectiveWorkItemTypeId,
  )
  const selectedWorkflow = resolveWorkItemTypeWorkflow(configuration, effectiveWorkItemTypeId)
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration, effectiveWorkItemTypeId)
  const contextualWorkflowStatusId = workflowStatusId && workflowStatuses.some((status) => status.id === workflowStatusId)
    ? workflowStatusId
    : undefined
  const initialWorkflowStatusId = contextualWorkflowStatusId ?? selectedWorkflow?.initialStatusId ??
    workflowStatuses[0]?.id ?? ''
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(customFieldDefinitions, selectedProjectId || undefined)
    : {}
  const hasCustomFields = customFieldDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  ) ?? false

  return (
    <section className="workbench-panel mb-5 min-w-0 p-5">
      <form
        className="grid min-w-0 gap-4"
        data-testid="create-issue-form"
        onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const description = String(formData.get('description') ?? '').trim()
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? '').trim()
          const schedule = dueDate
            ? createDefaultDueDateTaskSchedule(dueDate)
            : createDefaultUnscheduledTaskSchedule()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? initialWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, customFieldDefinitions, {
                applyDefaults: true,
                projectId: assignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (!workflowStatus || parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              customFieldDefinitions,
              locale,
            ))
            return
          }

          setFieldErrors({})

          void onSubmit({
            title,
            description,
            assignedProjectId: assignedProjectId || undefined,
            assigneeUserId,
            customFieldValues: parsedCustomFields.values,
            priority: resolveIssuePriority(formData.get('priority')),
            schedule,
            workItemTypeId: effectiveWorkItemTypeId,
            workflowStatusId,
          })
        }}
      >
        <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.title')}
            <input
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="title"
              placeholder={t('issues.create.titlePlaceholder')}
              required
            />
          </label>
          {configuration ? (
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.create.workItemType')}
              <select
                className="workbench-input h-10 w-full min-w-0 px-3"
                data-testid="create-issue-work-item-type"
                disabled={!hasCreatableWorkItemType}
                name="workItemTypeId"
                onChange={(event) => setSelectedWorkItemTypeId(event.target.value)}
                value={effectiveWorkItemTypeId}
              >
                {workItemTypes.map((type) => (
                  <option disabled={type.status === 'archived'} key={type.id} value={type.id}>
                    {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
                  </option>
                ))}
              </select>
              {selectedWorkItemType?.description ? (
                <span className="text-xs font-medium text-[var(--workbench-muted)]">
                  {selectedWorkItemType.description}
                </span>
              ) : null}
              {!hasCreatableWorkItemType ? (
                <span className="text-xs font-semibold text-amber-700">
                  {t('tasks.create.noActiveWorkItemTypes')}
                </span>
              ) : null}
            </label>
          ) : null}
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.project')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="assignedProjectId"
              onChange={(event) => setSelectedProjectId(event.target.value)}
              value={selectedProjectId}
            >
              {canCreateUnassignedIssue ? (
                <option value="">{t('issues.project.unassigned')}</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.assignee')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" name="assigneeUserId" required>
              <option disabled hidden value="">
                {t('tasks.create.assigneeSelectPlaceholder')}
              </option>
              {assigneeOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {formatProjectMemberOption(member)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.dueDate')}
            <input className="workbench-input h-10 w-full min-w-0 px-3" defaultValue={today} name="dueDate" type="date" />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.status')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              defaultValue={initialWorkflowStatusId}
              key={effectiveWorkItemTypeId}
              name="workflowStatusId"
            >
              {workflowStatuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.priority')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" defaultValue="medium" name="priority">
              {issuePriorities.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`tasks.priority.${priority}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {t('issues.create.description')}
          <textarea
            className="workbench-input min-h-20 w-full min-w-0 px-3 py-2"
            name="description"
            placeholder={t('issues.create.descriptionPlaceholder')}
          />
        </label>
        {hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={customFieldDefinitions}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={selectedProjectId || undefined}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button className="workbench-button-primary h-10 px-4 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300" disabled={!hasCreatableWorkItemType} type="submit">
            {t('issues.create.submit')}
          </button>
          <button className="workbench-button-secondary h-10 px-4" onClick={onCancel} type="button">
            {t('tasks.create.cancel')}
          </button>
          {errorMessage ? <p className="text-sm font-bold text-red-600">{errorMessage}</p> : null}
        </div>
      </form>
    </section>
  )
}

function IssueTable({
  activeTeam,
  configuration,
  dependencySummaries,
  focusedIssueKey,
  issues,
  isAiOperationPending,
  locale,
  onIssueActionMenuOpen,
  onOpenIssue,
  presentation,
  selectedIssueKeys,
  selectedIssueId,
  t,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  configuration?: WorkItemConfiguration
  dependencySummaries: Readonly<Record<string, WorkItemDependencySummary>>
  focusedIssueKey?: string
  issues: TeamIssue[]
  /** Whether Team Issue navigation and row actions are fenced during an AI operation. */
  isAiOperationPending: boolean
  locale: Locale
  /** Opens the canonical action menu for one Team Issue row. */
  onIssueActionMenuOpen?: TeamIssueActionMenuOpenHandler
  onOpenIssue?: (issue: TeamIssue) => void
  presentation?: TaskViewPresentationSettings
  selectedIssueKeys: readonly string[]
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
  const visibleColumns = (presentation?.columns ?? [
    { field: 'title' },
    { field: 'project' },
    { field: 'assignee' },
    { field: 'status' },
    { field: 'customFields' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).filter((column) => isSupportedTeamIssueColumn(column.field))
  const renderedColumns = visibleColumns.some((column) => column.field === 'title')
    ? visibleColumns
    : [{ field: 'title' }, ...visibleColumns]
  const tableColumnPlacements = resolveTaskViewTableColumnPlacements(renderedColumns)
  const tableMinimumWidth = Math.max(
    720,
    tableColumnPlacements.reduce((total, placement) => total + placement.width, 0),
  )
  const cellPadding = resolveIssueTableCellPadding(presentation?.density)
  const titleCellPadding = resolveIssueTableCellPadding(presentation?.density, true)
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatar = presentation?.display.showAssigneeAvatars ?? false
  const groups = presentation?.groupBy
    ? groupTaskViewItems(
        issues,
        presentation.groupBy,
        (issue, field) => resolveTeamIssueGroupValue(issue, field, configuration, activeTeam, t),
        presentation.groupDirection,
      )
    : undefined

  /** Renders one Team Issue row under its current table presentation. */
  const renderIssueRow = (issue: TeamIssue) => {
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    const focusedForAction = focusedIssueKey === issueKey
    const selectedForAction = selectedIssueKeys.includes(issueKey)
    const customFieldEntries = new Map(
      resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels).map(
        (entry) => [entry.definition.id, entry.value],
      ),
    )
    return (
      <tr
        className={`border-b border-slate-100 transition last:border-b-0 ${
          selectedIssueId === issue.id ? 'workbench-row-selected' : ''
        } ${selectedForAction ? 'bg-blue-50/70' : ''} ${
          focusedForAction ? 'outline outline-2 -outline-offset-2 outline-blue-500/40' : ''
        }`}
        data-task-view-focused={focusedForAction ? 'true' : 'false'}
        data-task-view-selected={selectedForAction ? 'true' : 'false'}
        key={issue.id}
        onContextMenu={(event) => {
          if (isAiOperationPending || !onIssueActionMenuOpen) return
          event.preventDefault()
          onIssueActionMenuOpen(
            issue,
            { x: event.clientX, y: event.clientY },
            event.currentTarget,
          )
        }}
        tabIndex={-1}
      >
        {tableColumnPlacements.map((placement) => {
          const field = placement.column.field
          const columnCellProps = {
            'data-column-field': field,
            'data-column-pin': placement.column.pin,
            style: resolveIssueTableColumnCellStyle(placement),
          }
          switch (field) {
            case 'title': return (
              <td {...columnCellProps} className={`${titleCellPadding} text-sm font-semibold text-[var(--workbench-text)]`} key={field}>
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    aria-pressed={selectedForAction || selectedIssueId === issue.id}
                    className={`min-w-0 flex-1 rounded-sm text-left font-semibold transition hover:text-[var(--workbench-primary)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#2563eb]/10 disabled:cursor-default disabled:text-[var(--workbench-text)] ${
                      wrapText ? 'whitespace-normal break-words' : 'truncate'
                    }`}
                    data-testid={`issue-row-${issue.id}`}
                    disabled={isAiOperationPending || !onOpenIssue}
                    onClick={() => onOpenIssue?.(issue)}
                    type="button"
                  >
                    {resolveIssueTitle(issue, t)}
                  </button>
                  {onIssueActionMenuOpen ? (
                    <button
                      aria-label={`${t('tasks.action.more')}: ${resolveIssueTitle(issue, t)}`}
                      className="grid h-9 w-9 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
                      data-testid={`team-issue-row-actions-${issue.id}`}
                      disabled={isAiOperationPending}
                      onClick={(event) => {
                        if (isAiOperationPending) return
                        const returnFocusElement = event.currentTarget
                        const bounds = returnFocusElement.getBoundingClientRect()
                        onIssueActionMenuOpen(
                          issue,
                          { x: bounds.right, y: bounds.bottom },
                          returnFocusElement,
                        )
                      }}
                      type="button"
                    >
                      <MoreHorizontalIcon className="h-5 w-5" />
                    </button>
                  ) : null}
                </div>
                <WorkItemDependencyChips
                  className="pt-2"
                  summary={resolveWorkItemDependencySummary(
                    dependencySummaries,
                    { teamId: issue.teamId, workItemId: issue.id },
                  )}
                  t={t}
                />
              </td>
            )
            case 'project': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {resolveAssignedProjectName(issue, activeTeam, t)}
              </td>
            )
            case 'assignee': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                <div className="flex min-w-0 items-center gap-2">
                  {showAssigneeAvatar ? (
                    <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(issue)} />
                  ) : null}
                  <span className="truncate">{resolveWorkItemAssignee(issue)}</span>
                </div>
              </td>
            )
            case 'status': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <IssueStatusBadge configuration={configuration} issue={issue} />
              </td>
            )
            case 'workItemType': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <TaskWorkItemTypeBadge configuration={configuration} task={issue} />
              </td>
            )
            case 'customFields': return (
              <td {...columnCellProps} className={`max-w-64 ${cellPadding}`} key={field}>
                <IssueCustomFieldSummary
                  configuration={configuration}
                  issue={issue}
                  locale={locale}
                  personLabels={personLabels}
                />
              </td>
            )
            case 'dueDate': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {issue.dueDate}
              </td>
            )
            case 'priority': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <IssuePriorityBadge priority={issue.priority} t={t} />
              </td>
            )
            case 'team': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {issue.teamId}
              </td>
            )
            default: {
              const customFieldId = field.slice('custom:'.length)
              return (
                <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                  {customFieldEntries.get(customFieldId) ?? '—'}
                </td>
              )
            }
          }
        })}
      </tr>
    )
  }

  return (
    <section className="workbench-table mt-5 overflow-hidden">
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed border-collapse"
          style={{ minWidth: tableMinimumWidth }}
        >
          <colgroup>
            {tableColumnPlacements.map((placement) => (
              <col key={placement.column.field} style={{ width: placement.width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="workbench-table-head text-left">
              {tableColumnPlacements.map((placement) => (
                <th
                  className={`${placement.column.field === 'title' ? 'px-5 py-3' : 'px-4 py-3'} ${
                    placement.column.pin ? 'bg-[var(--workbench-surface-muted)]' : ''
                  }`}
                  data-column-field={placement.column.field}
                  data-column-pin={placement.column.pin}
                  key={placement.column.field}
                  scope="col"
                  style={resolveIssueTableColumnCellStyle(placement, true)}
                >
                  {resolveIssueTableColumnLabel(placement.column.field, configuration, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issues.length > 0 ? (
              groups ? groups.map((group) => {
                const subgroups = presentation?.subgroupBy
                  ? groupTaskViewItems(
                      group.items,
                      presentation.subgroupBy,
                      (issue, field) => resolveTeamIssueGroupValue(
                        issue,
                        field,
                        configuration,
                        activeTeam,
                        t,
                      ),
                      presentation.subgroupDirection,
                    )
                  : undefined
                return (
                  <Fragment key={group.key}>
                    <IssueTableGroupRow columnCount={tableColumnPlacements.length} count={group.items.length} label={group.label} />
                    {subgroups ? subgroups.map((subgroup) => (
                      <Fragment key={`${group.key}:${subgroup.key}`}>
                        <IssueTableGroupRow columnCount={tableColumnPlacements.length} count={subgroup.items.length} label={subgroup.label} secondary />
                        {subgroup.items.map(renderIssueRow)}
                      </Fragment>
                    )) : group.items.map(renderIssueRow)}
                  </Fragment>
                )
              }) : issues.map(renderIssueRow)
            ) : (
              <tr>
                <td className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]" colSpan={tableColumnPlacements.length} data-testid="team-issues-empty">
                  {t('issues.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-[var(--workbench-border)] px-5 py-3 text-sm font-medium text-[var(--workbench-muted)]" data-testid="team-issues-count">
        {t('issues.count').replace('{count}', String(issues.length))}
      </div>
    </section>
  )
}

/** Props for one primary or secondary Team Issue table group heading. */
type IssueTableGroupRowProps = {
  /** Number of visible columns spanned by the heading. */
  columnCount: number
  /** Number of Issues in the group. */
  count: number
  /** Human-readable group value. */
  label: string
  /** Whether the heading represents a subgroup. */
  secondary?: boolean
}

/** Renders an accessible count-bearing Team Issue group heading. */
function IssueTableGroupRow({
  columnCount,
  count,
  label,
  secondary = false,
}: IssueTableGroupRowProps) {
  return (
    <tr data-testid={secondary ? 'team-issue-table-subgroup' : 'team-issue-table-group'}>
      <th
        className={secondary
          ? 'bg-slate-50 px-7 py-2 text-left text-xs font-semibold text-[var(--workbench-muted)]'
          : 'border-y border-[var(--workbench-border)] bg-[#f2f8f7] px-5 py-2.5 text-left text-sm font-bold text-[var(--workbench-text)]'}
        colSpan={columnCount}
        scope="rowgroup"
      >
        {label} <span className="font-medium text-[var(--workbench-muted)]">({count})</span>
      </th>
    </tr>
  )
}

/** Reports whether a canonical field can be rendered as a Team Issue table column. */
function isSupportedTeamIssueColumn(field: string): boolean {
  return [
    'title',
    'project',
    'assignee',
    'status',
    'customFields',
    'dueDate',
    'priority',
    'workItemType',
    'team',
  ].includes(field) || field.startsWith('custom:')
}

/** Resolves the localized or configured heading for one supported Team Issue table field. */
function resolveIssueTableColumnLabel(
  field: string,
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
): string {
  switch (field) {
    case 'title': return t('issues.column.title')
    case 'project': return t('issues.column.project')
    case 'assignee': return t('tasks.column.assignee')
    case 'status': return t('tasks.column.status')
    case 'customFields': return t('workItems.fields.title')
    case 'dueDate': return t('tasks.column.dueDate')
    case 'priority': return t('tasks.column.priority')
    case 'workItemType': return t('tasks.column.workItemType')
    case 'team': return t('workspace.column.team')
    default: {
      const customFieldId = field.slice('custom:'.length)
      return configuration?.customFields.find((item) => item.id === customFieldId)?.name ??
        customFieldId
    }
  }
}

/** Resolves table-cell padding from the effective Team Issue density. */
function resolveIssueTableCellPadding(
  density: TaskViewPresentationSettings['density'] | undefined,
  titleCell = false,
): string {
  const horizontalPadding = titleCell ? 'px-5' : 'px-4'
  const verticalPadding = density === 'compact'
    ? 'py-2'
    : density === 'spacious'
      ? 'py-5'
      : 'py-3'
  return `${horizontalPadding} ${verticalPadding}`
}

/**
 * Focuses and reveals a control after React commits a selected Team Issue detail update.
 *
 * @param selector - Selector scoped to the active Team Issue detail pane.
 * @returns Nothing.
 */
function focusTeamIssueDetailControl(selector: string): void {
  requestAnimationFrame(() => {
    const detailPane = document.querySelector<HTMLElement>(
      '[data-testid="team-issue-detail-pane"]',
    )
    const control = detailPane?.querySelector<HTMLElement>(selector)
    control?.focus()
    control?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Resolves width and sticky-edge styles for a persisted Team Issue table column.
 *
 * @param placement - Column width and cumulative pin offsets.
 * @param header - Whether the style is applied to a table heading.
 * @returns Inline table-cell styles that reproduce the saved layout.
 */
function resolveIssueTableColumnCellStyle(
  placement: TaskViewTableColumnPlacement,
  header = false,
): CSSProperties {
  const width = `${placement.width}px`
  const baseStyle: CSSProperties = { maxWidth: width, minWidth: width, width }
  if (placement.column.pin === 'start') {
    return {
      ...baseStyle,
      backgroundColor: 'inherit',
      left: placement.startOffset ?? 0,
      position: 'sticky',
      zIndex: header ? 20 : 10,
    }
  }
  if (placement.column.pin === 'end') {
    return {
      ...baseStyle,
      backgroundColor: 'inherit',
      position: 'sticky',
      right: placement.endOffset ?? 0,
      zIndex: header ? 20 : 10,
    }
  }
  return baseStyle
}

/** Resolves a stable key and visible label for one Team Issue grouping field. */
function resolveTeamIssueGroupValue(
  issue: TeamIssue,
  field: string,
  configuration: WorkItemConfiguration | undefined,
  activeTeam: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
): TaskViewGroupValue {
  let value: string
  switch (field) {
    case 'title': value = resolveIssueTitle(issue, t); break
    case 'status': value = resolveWorkItemWorkflowStatusLabel(issue, configuration); break
    case 'assignee': value = resolveWorkItemAssignee(issue); break
    case 'dueDate': value = issue.dueDate || '—'; break
    case 'priority': value = t(`tasks.priority.${issue.priority}`); break
    case 'workItemType': value = resolveWorkItemTypeLabel(issue, configuration); break
    case 'project': value = resolveAssignedProjectName(issue, activeTeam, t); break
    case 'team': value = activeTeam?.name ?? issue.teamId; break
    default: {
      const customValue = field.startsWith('custom:')
        ? issue.customFieldValues[field.slice('custom:'.length)]
        : undefined
      value = Array.isArray(customValue)
        ? customValue.join(', ')
        : customValue === undefined || customValue === null || customValue === ''
          ? '—'
          : String(customValue)
    }
  }
  return { key: value, label: value }
}

/** Creates a collision-safe identity for one Team Board workflow column. */
function createTeamIssueStatusColumnKey(column: WorkItemTypeWorkflowStatus): string {
  return [column.workItemTypeId, column.status.id].join('\u0000')
}

/** Creates a stable DOM token for one Team Board workflow column. */
function createTeamIssueStatusTestToken(column: WorkItemTypeWorkflowStatus): string {
  const value = column.workItemTypeId === DEFAULT_WORK_ITEM_TYPE_ID
    ? column.status.id
    : `${column.workItemTypeId}-${column.status.id}`
  return value.replaceAll(/[^a-z0-9-]+/giu, '-').toLowerCase()
}

function IssueBoard({
  activeTeam,
  canMoveIssueStatus,
  configuration,
  dependencySummaries,
  focusedIssueKey,
  issues,
  isAiOperationPending,
  locale,
  onCreateIssueOpen,
  onIssueActionMenuOpen,
  onMoveIssueStatus,
  onOpenIssue,
  presentation,
  selectedIssueKeys,
  selectedIssueId,
  t,
  workflowStatuses,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  /** Checks whether one Team Issue belongs to a server-authorized status mutation scope. */
  canMoveIssueStatus?: (issue: TeamIssue) => boolean
  configuration?: WorkItemConfiguration
  dependencySummaries: Readonly<Record<string, WorkItemDependencySummary>>
  focusedIssueKey?: string
  issues: TeamIssue[]
  /** Whether Team Issue navigation and board actions are fenced during an AI operation. */
  isAiOperationPending: boolean
  locale: Locale
  onCreateIssueOpen?: (workflowStatusId: string, workItemTypeId: string) => void
  /** Opens the canonical action menu for one Team Issue card. */
  onIssueActionMenuOpen?: TeamIssueActionMenuOpenHandler
  /** Routes one Board status selection or drop through the canonical Move action. */
  onMoveIssueStatus?: (issue: TeamIssue, workflowStatusId: string) => Promise<void>
  onOpenIssue?: (issue: TeamIssue) => void
  presentation?: TaskViewPresentationSettings
  selectedIssueKeys: readonly string[]
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workflowStatuses: readonly WorkItemTypeWorkflowStatus[]
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
  const [draggedIssueId, setDraggedIssueId] = useState<string>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string>()
  const [movingIssueIds, setMovingIssueIds] = useState<ReadonlySet<string>>(() => new Set())
  /** Checks the Board callback and the current issue-specific write scope together. */
  const canMoveIssue = (issue: TeamIssue) => Boolean(
    !isAiOperationPending && onMoveIssueStatus && (canMoveIssueStatus?.(issue) ?? true),
  )
  const visibleFields = new Set((presentation?.columns ?? [
    { field: 'title' },
    { field: 'project' },
    { field: 'assignee' },
    { field: 'status' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).map((column) => column.field))
  const cardPadding = presentation?.density === 'compact'
    ? 'p-2.5'
    : presentation?.density === 'spacious'
      ? 'p-5'
      : 'p-4'
  const cardListSpacing = presentation?.density === 'compact'
    ? 'gap-2 p-2'
    : presentation?.density === 'spacious'
      ? 'gap-4 p-4'
      : 'gap-3 p-3'
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatars = presentation?.display.showAssigneeAvatars ?? false
  const showEmptyGroups = presentation?.display.showEmptyGroups ?? true
  const showTypeName = new Set(workflowStatuses.map(({ workItemTypeId }) => workItemTypeId)).size > 1
  const visibleWorkflowStatuses = showEmptyGroups
    ? workflowStatuses
    : workflowStatuses.filter(({ status, workItemTypeId }) =>
        issues.some((issue) =>
          (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) === workItemTypeId &&
          resolveWorkItemWorkflowStatusId(issue) === status.id,
        )
      )

  /** Validates and requests a Team workflow status change. */
  const moveIssueToStatus = (issue: TeamIssue, workflowStatus: WorkItemTypeWorkflowStatus) => {
    const issueWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
    if (
      !onMoveIssueStatus ||
      !canMoveIssue(issue) ||
      issueWorkItemTypeId !== workflowStatus.workItemTypeId ||
      issue.workflowStatusId === workflowStatus.status.id
    ) {
      return
    }

    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)

    if (!editableStatuses.some((status) => status.id === workflowStatus.status.id)) {
      return
    }

    const issueId = issue.id
    setMovingIssueIds((currentIds) => new Set(currentIds).add(issueId))
    void onMoveIssueStatus(issue, workflowStatus.status.id)
      .catch(() => undefined)
      .finally(() => {
        setMovingIssueIds((currentIds) => {
          const nextIds = new Set(currentIds)
          nextIds.delete(issueId)
          return nextIds
        })
      })
  }

  /** Starts a native drag for a Team Work Item. */
  const handleDragStart = (event: DragEvent<HTMLElement>, issue: TeamIssue) => {
    if (!canMoveIssue(issue)) {
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-team-issue-id', issue.id)
    event.dataTransfer.setData('text/plain', issue.id)
    setDraggedIssueId(issue.id)
  }

  /** Resolves a dropped Team Work Item and requests a validated status change. */
  const handleDrop = (event: DragEvent<HTMLElement>, workflowStatus: WorkItemTypeWorkflowStatus) => {
    event.preventDefault()
    if (isAiOperationPending) {
      setDraggedIssueId(undefined)
      setDropTargetColumnKey(undefined)
      return
    }
    const issueId = event.dataTransfer.getData('application/x-mukuroji-team-issue-id') ||
      event.dataTransfer.getData('text/plain') ||
      draggedIssueId
    const issue = issueId ? issues.find((candidate) => candidate.id === issueId) : undefined

    setDraggedIssueId(undefined)
    setDropTargetColumnKey(undefined)

    if (issue) {
      moveIssueToStatus(issue, workflowStatus)
    }
  }

  return (
    <section className="mt-5 grid min-w-0 gap-3">
      <div className="flex min-w-0 gap-4 overflow-x-auto pb-2">
        {visibleWorkflowStatuses.map((workflowStatus) => {
          const { status, workItemTypeId } = workflowStatus
          const columnKey = createTeamIssueStatusColumnKey(workflowStatus)
          const statusTestToken = createTeamIssueStatusTestToken(workflowStatus)
          const workItemTypeName = resolveWorkItemTypeDefinition(configuration, workItemTypeId)?.name ??
            workItemTypeId
          const columnIssues = issues.filter(
            (issue) =>
              (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) === workItemTypeId &&
              resolveWorkItemWorkflowStatusId(issue) === status.id,
          )
          const primaryCardGroupField = presentation?.groupBy === 'status'
            ? presentation.subgroupBy
            : presentation?.groupBy
          const secondaryCardGroupField = presentation?.groupBy !== 'status'
            ? presentation?.subgroupBy
            : undefined
          const primaryCardGroups = primaryCardGroupField
            ? groupTaskViewItems(
                columnIssues,
                primaryCardGroupField,
                (issue, field) => resolveTeamIssueGroupValue(
                  issue,
                  field,
                  configuration,
                  activeTeam,
                  t,
                ),
                presentation?.groupBy === 'status'
                  ? presentation.subgroupDirection
                  : presentation?.groupDirection,
              )
            : []
          const orderedColumnIssues: TeamIssue[] = []
          const primaryHeadingByIssueId = new Map<string, (typeof primaryCardGroups)[number]>()
          const secondaryHeadingByIssueId = new Map<string, string>()
          for (const primaryGroup of primaryCardGroups) {
            const firstIssue = primaryGroup.items[0]
            if (firstIssue) primaryHeadingByIssueId.set(firstIssue.id, primaryGroup)
            const secondaryGroups = secondaryCardGroupField
              ? groupTaskViewItems(
                  primaryGroup.items,
                  secondaryCardGroupField,
                  (issue, field) => resolveTeamIssueGroupValue(
                    issue,
                    field,
                    configuration,
                    activeTeam,
                    t,
                  ),
                  presentation?.subgroupDirection,
                )
              : []
            if (secondaryGroups.length > 0) {
              for (const secondaryGroup of secondaryGroups) {
                const firstSecondaryIssue = secondaryGroup.items[0]
                if (firstSecondaryIssue) {
                  secondaryHeadingByIssueId.set(
                    firstSecondaryIssue.id,
                    `${secondaryGroup.label} (${secondaryGroup.items.length})`,
                  )
                }
                orderedColumnIssues.push(...secondaryGroup.items)
              }
            } else {
              orderedColumnIssues.push(...primaryGroup.items)
            }
          }
          if (primaryCardGroups.length === 0) orderedColumnIssues.push(...columnIssues)

          return (
            <div
              className={`workbench-panel min-h-[420px] w-[min(320px,82vw)] flex-none transition ${dropTargetColumnKey === columnKey ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''}`}
              data-testid={`team-issue-column-${statusTestToken}`}
              key={columnKey}
              onDragLeave={() => setDropTargetColumnKey(undefined)}
              onDragOver={(event) => {
                if (isAiOperationPending || !onMoveIssueStatus || !draggedIssueId) {
                  return
                }

                const issue = issues.find((candidate) => candidate.id === draggedIssueId)

                if (
                  !issue ||
                  !canMoveIssue(issue) ||
                  (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) !== workItemTypeId ||
                  !resolveEditableWorkflowStatuses(issue, configuration).some(
                    (candidate) => candidate.id === status.id,
                  )
                ) {
                  return
                }

                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetColumnKey(columnKey)
              }}
              onDrop={(event) => handleDrop(event, workflowStatus)}
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3">
                <span className="grid min-w-0 gap-0.5">
                  <IssueStatusBadge status={status} />
                  {showTypeName ? (
                    <span className="truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
                      {workItemTypeName}
                    </span>
                  ) : null}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--workbench-muted)]">{columnIssues.length}</span>
                  {onCreateIssueOpen && resolveWorkItemTypeDefinition(configuration, workItemTypeId)?.status === 'active' ? (
                    <button
                      aria-label={`${t('tasks.board.addInColumn')}: ${showTypeName ? `${workItemTypeName} · ` : ''}${status.name}`}
                      className="grid h-7 w-7 place-items-center rounded-md border border-[var(--workbench-border-strong)] bg-white text-lg leading-none text-[var(--workbench-primary)] hover:border-[#99d7cf] hover:bg-[#e5f7f4]"
                      data-testid={`team-issue-add-${statusTestToken}`}
                      disabled={isAiOperationPending}
                      onClick={() => onCreateIssueOpen(status.id, workItemTypeId)}
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </div>
              <div className={`grid ${cardListSpacing}`}>
                {columnIssues.length > 0 ? (
                  orderedColumnIssues.map((issue) => {
                    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
                    const focusedForAction = focusedIssueKey === issueKey
                    const selectedForAction = selectedIssueKeys.includes(issueKey)
                    const isMoving = movingIssueIds.has(issue.id)
                    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)
                    const canMoveCurrentIssue = canMoveIssue(issue)
                    const primaryHeading = primaryHeadingByIssueId.get(issue.id)
                    const secondaryHeading = secondaryHeadingByIssueId.get(issue.id)
                    const customFieldEntries = new Map(
                      resolveIssueCustomFieldEntries(
                        issue,
                        configuration,
                        locale,
                        personLabels,
                      ).map((entry) => [entry.definition.id, entry.value]),
                    )
                    const customColumns = [...visibleFields].flatMap((field) => {
                      if (!field.startsWith('custom:')) return []
                      const fieldId = field.slice('custom:'.length)
                      return [{
                        id: fieldId,
                        label: configuration?.customFields.find(
                          (definition) => definition.id === fieldId,
                        )?.name ?? fieldId,
                        value: customFieldEntries.get(fieldId) ?? '—',
                      }]
                    })

                    return (
                      <Fragment key={issue.id}>
                      {primaryHeading ? (
                        <h3 className="rounded bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-[var(--workbench-muted)]">
                          {primaryHeading.label} ({primaryHeading.items.length})
                        </h3>
                      ) : null}
                      {secondaryHeading ? (
                        <h4 className="px-2.5 py-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                          {secondaryHeading}
                        </h4>
                      ) : null}
                      <article
                        aria-grabbed={draggedIssueId === issue.id || undefined}
                        className={`rounded-lg border ${cardPadding} text-left transition ${
                          selectedIssueId === issue.id
                            ? 'border-[#99d7cf] bg-[#e5f7f4]'
                            : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                        } ${selectedForAction ? 'bg-blue-50/70' : ''} ${
                          focusedForAction ? 'ring-2 ring-blue-500/40' : ''
                        } ${draggedIssueId === issue.id ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
                        data-task-view-focused={focusedForAction ? 'true' : 'false'}
                        data-task-view-selected={selectedForAction ? 'true' : 'false'}
                        data-testid={`team-issue-card-${issue.id}`}
                        draggable={canMoveCurrentIssue && !isMoving}
                        onDragEnd={() => {
                          setDraggedIssueId(undefined)
                          setDropTargetColumnKey(undefined)
                        }}
                        onDragStart={(event) => handleDragStart(event, issue)}
                        onContextMenu={(event) => {
                          if (isAiOperationPending || !onIssueActionMenuOpen) return
                          event.preventDefault()
                          onIssueActionMenuOpen(
                            issue,
                            { x: event.clientX, y: event.clientY },
                            event.currentTarget,
                          )
                        }}
                        tabIndex={-1}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <button
                            aria-pressed={selectedForAction || selectedIssueId === issue.id}
                            className={`min-w-0 flex-1 text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:cursor-default disabled:text-[var(--workbench-text)] ${
                              wrapText ? 'whitespace-normal break-words' : 'truncate'
                            }`}
                            disabled={isAiOperationPending || !onOpenIssue}
                            onClick={() => onOpenIssue?.(issue)}
                            type="button"
                          >
                            {resolveIssueTitle(issue, t)}
                          </button>
                          {onIssueActionMenuOpen ? (
                            <button
                              aria-label={`${t('tasks.action.more')}: ${resolveIssueTitle(issue, t)}`}
                              className="grid h-9 w-9 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
                              data-testid={`team-issue-card-actions-${issue.id}`}
                              disabled={isAiOperationPending}
                              onClick={(event) => {
                                if (isAiOperationPending) return
                                const returnFocusElement = event.currentTarget
                                const bounds = returnFocusElement.getBoundingClientRect()
                                onIssueActionMenuOpen(
                                  issue,
                                  { x: bounds.right, y: bounds.bottom },
                                  returnFocusElement,
                                )
                              }}
                              type="button"
                            >
                              <MoreHorizontalIcon className="h-5 w-5" />
                            </button>
                          ) : null}
                        </div>
                        <WorkItemDependencyChips
                          className="mt-2"
                          summary={resolveWorkItemDependencySummary(
                            dependencySummaries,
                            { teamId: issue.teamId, workItemId: issue.id },
                          )}
                          t={t}
                        />
                        {visibleFields.has('workItemType') ? (
                          <div className="mt-2 w-fit">
                            <TaskWorkItemTypeBadge configuration={configuration} task={issue} />
                          </div>
                        ) : null}
                        {visibleFields.has('project') ? (
                          <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveAssignedProjectName(issue, activeTeam, t)}</p>
                        ) : null}
                        {!presentation || visibleFields.has('customFields') ? <div className="mt-3">
                          <IssueCustomFieldSummary
                            configuration={configuration}
                            issue={issue}
                            locale={locale}
                            personLabels={personLabels}
                          />
                        </div> : null}
                        {customColumns.length > 0 ? (
                          <dl className="mt-3 grid gap-1.5 text-xs text-[var(--workbench-muted)]">
                            {customColumns.map((item) => (
                              <div className="flex min-w-0 items-baseline justify-between gap-2" key={item.id}>
                                <dt className="truncate font-semibold">{item.label}</dt>
                                <dd className={wrapText ? 'break-words text-right' : 'truncate text-right'}>
                                  {item.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {visibleFields.has('assignee') ? (
                          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]">
                            {showAssigneeAvatars ? (
                              <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(issue)} />
                            ) : null}
                            <span className="truncate">{resolveWorkItemAssignee(issue)}</span>
                          </div>
                        ) : null}
                        {visibleFields.has('priority') || visibleFields.has('dueDate') ? (
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            {visibleFields.has('priority') ? <IssuePriorityBadge priority={issue.priority} t={t} /> : null}
                            {visibleFields.has('dueDate') ? <span className="text-xs font-semibold text-[var(--workbench-muted)]">{issue.dueDate}</span> : null}
                          </div>
                        ) : null}
                        {visibleFields.has('team') ? (
                          <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{issue.teamId}</p>
                        ) : null}
                        {visibleFields.has('status') && canMoveCurrentIssue && editableStatuses.length > 0 ? (
                          <select
                            aria-label={`${resolveIssueTitle(issue, t)}: ${t('tasks.column.status')}`}
                            className="workbench-input mt-3 h-8 w-full px-2 text-xs"
                            disabled={isAiOperationPending || isMoving}
                            onChange={(event) => {
                              const issueWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
                              const nextWorkflowStatus = workflowStatuses.find((candidate) =>
                                candidate.workItemTypeId === issueWorkItemTypeId &&
                                candidate.status.id === event.target.value,
                              )
                              if (nextWorkflowStatus) moveIssueToStatus(issue, nextWorkflowStatus)
                            }}
                            value={issue.workflowStatusId}
                          >
                            {editableStatuses.map((editableStatus) => (
                              <option key={editableStatus.id} value={editableStatus.id}>
                                {editableStatus.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {canMoveCurrentIssue ? (
                          <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                            {t('tasks.board.dragHint')}
                          </p>
                        ) : null}
                      </article>
                      </Fragment>
                    )
                  })
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                    {t('tasks.board.empty')}
                  </p>
                )}
              </div>
            </div>
          )
        })}
        {visibleWorkflowStatuses.length === 0 ? (
          <p className="w-full rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('tasks.board.empty')}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function IssueDetailPane({
  aiAssistanceEnabled = true,
  accessToken,
  assigneeOptions,
  artifacts,
  canAssignUnassigned,
  canManageDependencyEndpoint,
  canManageExternalLinks,
  collaboration,
  collaborationRoute,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isAiSummaryOperationPending,
  isRelationsLoading,
  locale,
  onAddRelation,
  onAuthenticatedApiError,
  onAiSummaryOperationPendingChange,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningSnapshot,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  accessToken?: string
  assigneeOptions: ProjectMember[]
  artifacts?: FileArtifactsController
  /** Whether the current viewer may move this Work Item out of a Project. */
  canAssignUnassigned: boolean
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  canManageExternalLinks: boolean
  collaboration?: IssueCollaborationController
  collaborationRoute?: IssueCollaborationRoute
  configuration?: WorkItemConfiguration
  currentWorkspaceMemberKey?: string
  detailErrorMessage?: string
  externalLinksAccessToken?: string
  focusedCommentId?: string
  focusedRootCommentId?: string
  issue?: TeamIssue
  /** Whether the mounted Brief assistant currently fences Team Issue navigation. */
  isAiSummaryOperationPending: boolean
  isRelationsLoading: boolean
  locale: Locale
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports the keyed Brief operation state to the Team Issue screen. */
  onAiSummaryOperationPendingChange?: (issueKey: string, pending: boolean) => void
  /** Creates a canonical schedule dependency. */
  onCreateScheduleDependency?: TeamIssueScreenProps['onCreateScheduleDependency']
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: TeamIssueScreenProps['onDeleteScheduleDependency']
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /** Updates a canonical schedule dependency. */
  onUpdateScheduleDependency?: TeamIssueScreenProps['onUpdateScheduleDependency']
  /** Authoritative canonical dependency graph. */
  planningSnapshot?: PlanningSnapshot
  projects: ProjectDirectoryTeam['projects']
  relationCandidates: TeamIssue[]
  relations: readonly WorkItemRelation[]
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  if (!issue) {
    return (
      <aside className="workbench-detail-pane min-h-0 min-w-0 px-6 py-7 max-[1080px]:border-l-0 max-[1080px]:border-t">
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('issues.detail.empty')}</p>
      </aside>
    )
  }

  return (
    <IssueDetailContent
      aiAssistanceEnabled={aiAssistanceEnabled}
      accessToken={accessToken}
      assigneeOptions={assigneeOptions}
      artifacts={artifacts}
      canAssignUnassigned={canAssignUnassigned}
      canManageDependencyEndpoint={canManageDependencyEndpoint}
      canManageExternalLinks={canManageExternalLinks}
      collaboration={collaboration}
      collaborationRoute={collaborationRoute}
      configuration={configuration}
      currentWorkspaceMemberKey={currentWorkspaceMemberKey}
      detailErrorMessage={detailErrorMessage}
      externalLinksAccessToken={externalLinksAccessToken}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      issue={issue}
      isAiSummaryOperationPending={isAiSummaryOperationPending}
      isRelationsLoading={isRelationsLoading}
      key={issue.id}
      locale={locale}
      onAddRelation={onAddRelation}
      onAuthenticatedApiError={onAuthenticatedApiError}
      onAiSummaryOperationPendingChange={onAiSummaryOperationPendingChange}
      onCreateScheduleDependency={onCreateScheduleDependency}
      onDeleteRelation={onDeleteRelation}
      onDeleteScheduleDependency={onDeleteScheduleDependency}
      onUpdateIssue={onUpdateIssue}
      onUpdateScheduleDependency={onUpdateScheduleDependency}
      planningSnapshot={planningSnapshot}
      projects={projects}
      relationCandidates={relationCandidates}
      relations={relations}
      t={t}
      workspaceMembers={workspaceMembers}
    />
  )
}

function IssueDetailContent({
  aiAssistanceEnabled = true,
  accessToken,
  assigneeOptions,
  artifacts,
  canAssignUnassigned,
  canManageDependencyEndpoint,
  canManageExternalLinks,
  collaboration,
  collaborationRoute,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isAiSummaryOperationPending,
  isRelationsLoading,
  locale,
  onAddRelation,
  onAuthenticatedApiError,
  onAiSummaryOperationPendingChange,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningSnapshot,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  /** Related Documents を取得する access token です。 */
  accessToken?: string
  /** 担当者 selector の候補です。 */
  assigneeOptions: ProjectMember[]
  /** 選択中 Issue の file/version/annotation/approval controller です。 */
  artifacts?: FileArtifactsController
  /** Whether the current viewer may move this Work Item out of a Project. */
  canAssignUnassigned: boolean
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  /** External link の作成、更新、解除が許可されているかどうかです。 */
  canManageExternalLinks: boolean
  /** 選択中 Issue の discussion controller です。 */
  collaboration?: IssueCollaborationController
  /** Collaboration section selected by route state. */
  collaborationRoute?: IssueCollaborationRoute
  /** 選択中 Issue に適用する configuration です。 */
  configuration?: WorkItemConfiguration
  /** 現在の Workspace member key です。 */
  currentWorkspaceMemberKey?: string
  /** Detail mutation error の表示文言です。 */
  detailErrorMessage?: string
  /** External link management API の Bearer token です。 */
  externalLinksAccessToken?: string
  /** notification deep link から focus する comment ID です。 */
  focusedCommentId?: string
  /** notification deep link の reply が属する root comment ID です。 */
  focusedRootCommentId?: string
  /** 編集対象 Issue です。 */
  issue: TeamIssue
  /** Whether the mounted Brief assistant currently fences Team Issue navigation. */
  isAiSummaryOperationPending: boolean
  /** Relation 候補の取得中かどうかです。 */
  isRelationsLoading: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** Relation 追加 callback です。 */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports the keyed Brief operation state to the Team Issue screen. */
  onAiSummaryOperationPendingChange?: (issueKey: string, pending: boolean) => void
  /** Creates a canonical schedule dependency. */
  onCreateScheduleDependency?: TeamIssueScreenProps['onCreateScheduleDependency']
  /** Relation 解除 callback です。 */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: TeamIssueScreenProps['onDeleteScheduleDependency']
  /** Issue 更新 callback です。 */
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /** Updates a canonical schedule dependency. */
  onUpdateScheduleDependency?: TeamIssueScreenProps['onUpdateScheduleDependency']
  /** Authoritative canonical dependency graph. */
  planningSnapshot?: PlanningSnapshot
  /** Project selector の候補です。 */
  projects: ProjectDirectoryTeam['projects']
  /** Relation target の候補です。 */
  relationCandidates: TeamIssue[]
  /** 選択中 Issue の relation 一覧です。 */
  relations: readonly WorkItemRelation[]
  /** i18n translator です。 */
  t: (key: MessageKey) => string
  /** Person field と discussion で使う Workspace member 一覧です。 */
  workspaceMembers: WorkspaceMember[]
}) {
  const aiSummarySource = {
    expectedRevision: issue.revision,
    teamId: issue.teamId,
    type: 'work-item',
    workItemId: issue.id,
  } satisfies AiWorkItemSource
  const collaborationAiAssistance = aiAssistanceEnabled && accessToken
    ? {
        renderBrief: (
          onAdopt: Parameters<IssueSummaryAiAssistance['renderBrief']>[0],
          onOperationPendingChange: Parameters<IssueSummaryAiAssistance['renderBrief']>[1],
        ) => (
          <AiSummaryAssistant
            accessToken={accessToken}
            adoptLabel={t('ai.summary.adoptContext')}
            key={createAiAssistantSessionKey(aiSummarySource)}
            locale={locale}
            onAdopt={onAdopt}
            onAuthenticatedApiError={onAuthenticatedApiError}
            onOperationPendingChange={(pending) => {
              onAiSummaryOperationPendingChange?.(
                createTaskViewItemKey(issue.teamId, issue.id),
                pending,
              )
              onOperationPendingChange?.(createAiAssistantSessionKey(aiSummarySource), pending)
            }}
            sources={[aiSummarySource]}
            t={t}
          />
        ),
        sessionKey: createAiAssistantSessionKey(aiSummarySource),
      }
    : undefined
  const [selectedProject, setSelectedProject] = useState({
    revision: issue.revision,
    value: issue.assignedProjectId ?? '',
  })
  const selectedProjectId = selectedProject.revision === issue.revision
    ? selectedProject.value
    : issue.assignedProjectId ?? ''
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const currentWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
  const workItemTypes = resolveWorkItemTypes(configuration)
  const typeChangeRequestSequenceRef = useRef(0)
  const [selectedWorkItemType, setSelectedWorkItemType] = useState({
    revision: issue.revision,
    value: currentWorkItemTypeId,
  })
  const selectedWorkItemTypeId = selectedWorkItemType.revision === issue.revision
    ? selectedWorkItemType.value
    : currentWorkItemTypeId
  const workItemTypeSelectionIdentity = `${issue.teamId}:${issue.id}:${issue.revision}`
  const typeChangePreviewIdentity = `${workItemTypeSelectionIdentity}:${selectedProjectId}`
  const [typeChangeState, setTypeChangeState] = useState<TeamIssueTypeChangeState>({
    acknowledgedLostCustomFieldIds: [],
    identity: typeChangePreviewIdentity,
    isPreviewing: false,
    targetWorkItemTypeId: currentWorkItemTypeId,
  })
  const activeTypeChangeState = typeChangeState.identity === typeChangePreviewIdentity &&
      typeChangeState.targetWorkItemTypeId === selectedWorkItemTypeId
    ? typeChangeState
    : {
        acknowledgedLostCustomFieldIds: [],
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId: selectedWorkItemTypeId,
      }
  const documentContextPromotion = useDocumentContextPromotion(
    Boolean(collaboration?.context.capabilities.canCreate && !isAiSummaryOperationPending),
    `${issue.teamId}:${issue.id}`,
    collaborationRoute?.onCollaborationTabChange,
  )
  const isIssueReadOnly = !onUpdateIssue
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === issue.assigneeUserId)
  const currentWorkflowStatusId = resolveWorkItemWorkflowStatusId(issue)
  const selectedWorkItemTypeDefinition = resolveWorkItemTypeDefinition(
    configuration,
    selectedWorkItemTypeId,
  )
  const visibleDetailSections = selectedWorkItemTypeDefinition
    ? new Set(selectedWorkItemTypeDefinition.detailSections)
    : undefined
  /** Returns whether a configured detail-pane section should be rendered. */
  const isDetailSectionVisible = (section: WorkItemDetailSectionId) =>
    visibleDetailSections === undefined || section === 'overview' || visibleDetailSections.has(section)
  const selectedTypeCustomFieldDefinitions = resolveWorkItemTypeFormFields(
    configuration,
    selectedWorkItemTypeId,
  )
  const customFieldEditorDefinitions = isDetailSectionVisible('custom-fields')
    ? selectedTypeCustomFieldDefinitions
    : selectedTypeCustomFieldDefinitions.filter((definition) => definition.required)
  const selectedTypeWorkflow = resolveWorkItemTypeWorkflow(
    configuration,
    selectedWorkItemTypeId,
  )
  const workflowStatuses = selectedWorkItemTypeId === currentWorkItemTypeId
    ? resolveEditableWorkflowStatuses(issue, configuration)
    : resolveCreateWorkflowStatuses(configuration, selectedWorkItemTypeId)
  const selectedTypeStatusFallback = workflowStatuses.some((status) => status.id === currentWorkflowStatusId)
    ? currentWorkflowStatusId
    : selectedTypeWorkflow?.initialStatusId ?? workflowStatuses[0]?.id ?? currentWorkflowStatusId
  const typeChangePreview = activeTypeChangeState.preview
  const isWorkItemTypeChangeRequested = selectedWorkItemTypeId !== currentWorkItemTypeId
  const typeChangeLostFields = typeChangePreview?.lostCustomFieldIds.map((fieldId) =>
    configuration?.customFields.find((definition) => definition.id === fieldId) ?? {
      id: fieldId,
      name: fieldId,
    },
  ) ?? []
  const selectedTypeWorkflowStatusId = activeTypeChangeState.replacementWorkflowStatusId ??
    selectedTypeStatusFallback
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const hasCustomFields = customFieldEditorDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  )

  /** Requests a server-authoritative preview before saving a Team Issue type change. */
  async function requestWorkItemTypePreview(targetWorkItemTypeId: string) {
    typeChangeRequestSequenceRef.current += 1
    const requestSequence = typeChangeRequestSequenceRef.current
    if (!onUpdateIssue || !accessToken || targetWorkItemTypeId === currentWorkItemTypeId) return
    setTypeChangeState({
      acknowledgedLostCustomFieldIds: [],
      identity: typeChangePreviewIdentity,
      isPreviewing: true,
      targetWorkItemTypeId,
    })
    try {
      const preview = await previewTeamIssueWorkItemType(
        issue.teamId,
        issue.id,
        accessToken,
        {
          expectedRevision: issue.revision,
          targetWorkItemTypeId,
          assignedProjectId: selectedProjectId || null,
        },
      )
      if (typeChangeRequestSequenceRef.current !== requestSequence) return
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        isPreviewing: false,
        identity: typeChangePreviewIdentity,
        preview,
        replacementWorkflowStatusId: preview.invalidWorkflowStatusId === undefined
          ? undefined
          : preview.targetInitialWorkflowStatusId,
        targetWorkItemTypeId,
      })
    } catch {
      if (typeChangeRequestSequenceRef.current !== requestSequence) return
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        errorMessage: t('tasks.detail.typeChange.previewError'),
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId,
      })
    }
  }

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1080px]:border-l-0 max-[1080px]:border-t"
      data-testid="team-issue-detail-pane"
    >
      <form
        className="grid min-w-0 gap-4 px-6 py-7"
        key={`${issue.id}:${issue.revision}`}
        onSubmit={(event) => {
          event.preventDefault()

          if (!onUpdateIssue || isAiSummaryOperationPending) {
            return
          }

          if (isWorkItemTypeChangeRequested && !typeChangePreview) {
            if (!activeTypeChangeState.isPreviewing) {
              void requestWorkItemTypePreview(selectedWorkItemTypeId)
            }
            return
          }

          const formData = new FormData(event.currentTarget)
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const formWorkflowStatusId = String(
            formData.get('workflowStatusId') ?? currentWorkflowStatusId,
          ).trim()
          const workflowStatusId = isWorkItemTypeChangeRequested && typeChangePreview?.invalidWorkflowStatusId
            ? String(
                formData.get('typeChangeWorkflowStatusId') ?? selectedTypeWorkflowStatusId,
              ).trim()
            : formWorkflowStatusId
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, customFieldEditorDefinitions, {
                projectId: assignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              customFieldEditorDefinitions,
              locale,
            ))
            return
          }

          if (isWorkItemTypeChangeRequested && typeChangePreview) {
            const acknowledgedIds = new Set(activeTypeChangeState.acknowledgedLostCustomFieldIds)
            const missingAcknowledgements = typeChangePreview.lostCustomFieldIds.filter((fieldId) =>
              !acknowledgedIds.has(fieldId),
            )
            if (missingAcknowledgements.length > 0) {
              setFieldErrors({
                typeChange: t('tasks.detail.typeChange.acknowledge'),
              })
              return
            }
          }

          setFieldErrors({})
          const customFieldValues = createVisibleCustomFieldValuePatch(
            isDetailSectionVisible('custom-fields'),
            customFieldEditorDefinitions,
            issue.customFieldValues,
            parsedCustomFields.values,
            assignedProjectId || undefined,
          )
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: assignedProjectId || null,
            priority: resolveIssuePriority(formData.get('priority')),
            title: String(formData.get('title') ?? '').trim(),
            workflowStatusId,
            ...(isDetailSectionVisible('description')
              ? { description: String(formData.get('description') ?? '').trim() }
              : {}),
            ...(customFieldValues === undefined ? {} : { customFieldValues }),
          }

          if (isWorkItemTypeChangeRequested && typeChangePreview) {
            nextIssueInput.workItemTypeId = selectedWorkItemTypeId
            nextIssueInput.typeChangeResolution = {
              discardCustomFieldIds: [...activeTypeChangeState.acknowledgedLostCustomFieldIds].sort(),
              ...(typeChangePreview.invalidWorkflowStatusId === undefined
                ? {}
                : { workflowStatusId }),
            }
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(issue.id, nextIssueInput).catch(() => undefined)
        }}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('tasks.detail.title')}</p>
            <p className="mt-1 truncate text-lg font-semibold leading-6 text-[var(--workbench-text)]">
              {resolveIssueTitle(issue, t)}
            </p>
          </div>
          <IssuePriorityBadge priority={issue.priority} t={t} />
        </div>
        <fieldset className="contents" disabled={isIssueReadOnly || isAiSummaryOperationPending}>
          {configuration ? (
            <section className="workbench-panel-muted grid min-w-0 gap-3 p-3" data-testid="team-issue-detail-work-item-type">
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('tasks.create.workItemType')}
                <select
                  className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  disabled={activeTypeChangeState.isPreviewing}
                  name="workItemTypeId"
                  onChange={(event) => {
                    const nextWorkItemTypeId = event.target.value
                    setSelectedWorkItemType({
                      revision: issue.revision,
                      value: nextWorkItemTypeId,
                    })
                    setFieldErrors((current) => ({ ...current, typeChange: undefined }))
                    if (nextWorkItemTypeId === currentWorkItemTypeId) {
                      typeChangeRequestSequenceRef.current += 1
                      setTypeChangeState({
                        acknowledgedLostCustomFieldIds: [],
                        identity: typeChangePreviewIdentity,
                        isPreviewing: false,
                        targetWorkItemTypeId: nextWorkItemTypeId,
                      })
                      return
                    }
                    void requestWorkItemTypePreview(nextWorkItemTypeId)
                  }}
                  value={selectedWorkItemTypeId}
                >
                  {workItemTypes
                    .filter((type) => type.status === 'active' || type.id === currentWorkItemTypeId)
                    .map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
                      </option>
                    ))}
                </select>
                {selectedWorkItemTypeDefinition?.description ? (
                  <span className="text-xs font-medium text-[var(--workbench-muted)]">
                    {selectedWorkItemTypeDefinition.description}
                  </span>
                ) : null}
              </label>
              {isWorkItemTypeChangeRequested ? (
                <div className="grid gap-2 rounded-md border border-[var(--workbench-border-strong)] bg-white p-3 text-sm" data-testid="team-issue-detail-work-item-type-preview">
                  <p className="font-semibold text-[var(--workbench-text)]">
                    {t('tasks.detail.typeChange.title')}
                  </p>
                  {activeTypeChangeState.isPreviewing ? (
                    <p className="text-[var(--workbench-muted)]">{t('tasks.detail.typeChange.previewing')}</p>
                  ) : typeChangePreview ? (
                    <>
                      <p className="text-[var(--workbench-muted)]">
                        {t('tasks.detail.typeChange.preview')}
                      </p>
                      {typeChangeLostFields.length > 0 ? (
                        <div className="grid gap-2">
                          <p className="font-semibold text-[var(--workbench-text)]">
                            {t('tasks.detail.typeChange.lostFields')}
                          </p>
                          {typeChangeLostFields.map((field) => {
                            const checked = activeTypeChangeState.acknowledgedLostCustomFieldIds.includes(field.id)
                            return (
                              <label className="flex items-start gap-2 font-medium text-[var(--workbench-muted)]" key={field.id}>
                                <input
                                  checked={checked}
                                  className="mt-0.5"
                                  onChange={(event) => {
                                    const nextIds = event.target.checked
                                      ? [...activeTypeChangeState.acknowledgedLostCustomFieldIds, field.id]
                                      : activeTypeChangeState.acknowledgedLostCustomFieldIds.filter((id) => id !== field.id)
                                    setTypeChangeState((current) => ({
                                      ...current,
                                      acknowledgedLostCustomFieldIds: [...new Set(nextIds)].sort(),
                                    }))
                                    setFieldErrors((current) => ({ ...current, typeChange: undefined }))
                                  }}
                                  type="checkbox"
                                />
                                <span>{field.name}</span>
                              </label>
                            )
                          })}
                        </div>
                      ) : null}
                      {typeChangePreview.invalidWorkflowStatusId ? (
                        <label className="grid gap-1.5 font-semibold text-[var(--workbench-text)]">
                          {t('tasks.detail.typeChange.invalidStatus')}
                          <select
                            className="workbench-input h-9 px-3"
                            name="typeChangeWorkflowStatusId"
                            onChange={(event) => setTypeChangeState((current) => ({
                              ...current,
                              replacementWorkflowStatusId: event.target.value,
                            }))}
                            value={selectedTypeWorkflowStatusId}
                          >
                            {resolveCreateWorkflowStatuses(
                              configuration,
                              selectedWorkItemTypeId,
                            ).map((status) => (
                              <option key={status.id} value={status.id}>{status.name}</option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {typeChangePreview.missingRequiredCustomFieldIds.length > 0 ? (
                        <p className="text-amber-700">
                          {t('tasks.detail.typeChange.missingRequired')}
                        </p>
                      ) : null}
                    </>
                  ) : activeTypeChangeState.errorMessage ? (
                    <p className="text-red-700" role="alert">{activeTypeChangeState.errorMessage}</p>
                  ) : null}
                  {fieldErrors.typeChange ? (
                    <p className="font-semibold text-red-700" role="alert">{fieldErrors.typeChange}</p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.column.title')}
            <input className="workbench-input w-full min-w-0 px-3 py-2 text-lg font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={resolveIssueTitle(issue, t)} name="title" required />
          </label>
          {isDetailSectionVisible('description') ? (
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.description')}
              <textarea className="workbench-input min-h-28 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.description} name="description" />
            </label>
          ) : null}
          <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.project')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                name="assignedProjectId"
                onChange={(event) => setSelectedProject({
                  revision: issue.revision,
                  value: event.target.value,
                })}
                value={selectedProjectId}
              >
                {canAssignUnassigned ? (
                  <option value="">{t('issues.project.unassigned')}</option>
                ) : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.assignee')}
              <select className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.assigneeUserId} name="assigneeUserId">
                {!hasSelectedAssigneeOption ? (
                  <option value={issue.assigneeUserId}>{resolveWorkItemAssignee(issue)}</option>
                ) : null}
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                ))}
              </select>
            </label>
            {isDetailSectionVisible('workflow') ? (
              <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                {t('tasks.column.status')}
                <select
                  className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  defaultValue={isWorkItemTypeChangeRequested ? selectedTypeWorkflowStatusId : currentWorkflowStatusId}
                  key={`${issue.revision}:${selectedWorkItemTypeId}`}
                  name="workflowStatusId"
                >
                  {workflowStatuses.map((status) => (
                    <option key={status.id} value={status.id}>{status.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.priority')}
              <select className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.priority} name="priority">
                {issuePriorities.map((priority) => (
                  <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </label>
            {isDetailSectionVisible('schedule') ? (
              <div className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                <span>{t('tasks.schedule.title')}</span>
                <output className="min-h-9 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 font-medium text-[var(--workbench-muted)]">
                  {describeTeamIssueSchedule(issue.schedule, t)}
                </output>
              </div>
            ) : null}
          </div>
          {hasCustomFields ? (
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={customFieldEditorDefinitions}
                errors={fieldErrors}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue.customFieldValues}
                key={`${issue.revision}:${selectedWorkItemTypeId}:${selectedProjectId}`}
              />
            </div>
          ) : null}
        </fieldset>
        <button className="workbench-button-primary h-10 px-4 disabled:border-slate-300 disabled:bg-slate-300" disabled={isIssueReadOnly || isAiSummaryOperationPending} type="submit">
          {t('issues.detail.save')}
        </button>
        {isIssueReadOnly ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.detail.readOnlyPermission')}
          </p>
        ) : null}
        {detailErrorMessage ? <p className="text-sm font-bold text-red-600">{detailErrorMessage}</p> : null}
      </form>
      {isDetailSectionVisible('relations') && planningSnapshot ? (
        <div className="border-t border-[var(--workbench-border)] bg-white px-6 py-6">
          <WorkItemDependencyPanel
            canManageEndpoint={canManageDependencyEndpoint}
            currentEndpoint={{ teamId: issue.teamId, workItemId: issue.id }}
            onCreate={isAiSummaryOperationPending ? undefined : onCreateScheduleDependency}
            onDelete={isAiSummaryOperationPending ? undefined : onDeleteScheduleDependency}
            onUpdate={isAiSummaryOperationPending ? undefined : onUpdateScheduleDependency}
            snapshot={planningSnapshot}
            t={t}
          />
        </div>
      ) : null}
      {isDetailSectionVisible('files') && artifacts ? (
        <IssueArtifactsPanel
          completionTransitions={workflowStatuses.filter(
            (status) => status.id !== currentWorkflowStatusId,
          )}
          controller={artifacts}
          currentMemberKey={currentWorkspaceMemberKey}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
      {isDetailSectionVisible('files') && externalLinksAccessToken ? (
        <WorkItemExternalLinksPanelContainer
          accessToken={externalLinksAccessToken}
          canManage={canManageExternalLinks && !isAiSummaryOperationPending}
          locale={locale}
          teamId={issue.teamId}
          workItemId={issue.id}
        />
      ) : null}
      {isDetailSectionVisible('relations') ? (
        <div className="border-t border-[var(--workbench-border)] px-6 py-6">
          <WorkItemRelationsEditor
            candidates={relationCandidates.map((candidate) => ({
              id: candidate.id,
              title: resolveIssueTitle(candidate, t),
            }))}
            currentWorkItemId={issue.id}
            isLoading={isRelationsLoading}
            locale={locale}
            onAddRelation={onAddRelation && !isAiSummaryOperationPending
              ? (input) => onAddRelation(issue.id, input)
              : undefined}
            onDeleteRelation={onDeleteRelation && !isAiSummaryOperationPending
              ? (relation) => onDeleteRelation(issue.id, relation)
              : undefined}
            readOnly={isAiSummaryOperationPending || (!onAddRelation && !onDeleteRelation)}
            relations={relations}
          />
        </div>
      ) : null}
      {isDetailSectionVisible('files') ? (
        <RelatedDocuments
          accessToken={accessToken}
          onPromoteToContext={documentContextPromotion.onPromoteToContext}
          t={t}
          targetId={`team/${issue.teamId}/issue/${issue.id}`}
          targetKind="work-item"
        />
      ) : null}
      {isDetailSectionVisible('activity') && collaboration ? (
        <IssueCollaborationPanel
          aiAssistance={collaborationAiAssistance}
          route={collaborationRoute}
          artifacts={artifacts}
          contextDraft={documentContextPromotion.documentContextDraft}
          key={`${issue.teamId}:${issue.id}`}
          controller={collaboration}
          currentMemberKey={currentWorkspaceMemberKey}
          focusedCommentId={focusedCommentId}
          focusedRootCommentId={focusedRootCommentId}
          locale={locale}
          members={workspaceMembers}
          onAiSummaryOperationPendingChange={(pending) => {
            onAiSummaryOperationPendingChange?.(
              createTaskViewItemKey(issue.teamId, issue.id),
              pending,
            )
          }}
          onContextDraftConsumed={documentContextPromotion.onContextDraftConsumed}
        />
      ) : null}
    </aside>
  )
}

function formatLocalDateInputValue(date = new Date()) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/** Resolves the normalized directory key used to match the current user to Project roles. */
function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}

function resolveIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  void t
  return resolveWorkItemTitle(issue)
}

/**
 * Formats an explicit schedule without collapsing its mode into a deadline projection.
 *
 * @param schedule - Canonical schedule displayed by the read-only Team detail summary.
 * @param t - Translator used for the schedule mode label.
 * @returns A compact localized mode and date-range description.
 */
function describeTeamIssueSchedule(
  schedule: WorkItemSchedule,
  t: (key: MessageKey) => string,
): string {
  const range = formatTaskScheduleRange(schedule)
  return `${t(taskScheduleModeLabelKeys[schedule.mode])}${range ? `: ${range}` : ''}`
}

function resolveAssignedProjectName(
  issue: TeamIssue,
  team: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
) {
  if (!issue.assignedProjectId) {
    return t('issues.project.unassigned')
  }

  return team?.projects.find((project) => project.id === issue.assignedProjectId)?.name ?? issue.assignedProjectId
}

function resolveIssuePriority(value: FormDataEntryValue | null): WorkItemPriority {
  return typeof value === 'string' && issuePriorities.includes(value as WorkItemPriority)
    ? value as WorkItemPriority
    : 'medium'
}

function formatProjectMemberOption(member: ProjectMember) {
  return member.name ? `${member.name} (${member.email})` : member.email
}

function IssueStatusBadge({
  configuration,
  issue,
  status,
}: {
  /** Status definition の解決に使う configuration です。 */
  configuration?: WorkItemConfiguration
  /** 一覧で status を表示する Issue です。 */
  issue?: TeamIssue
  /** Board column で直接表示する status definition です。 */
  status?: WorkflowStatusDefinition
}) {
  const resolvedStatus = status ?? (issue
    ? resolveWorkflowStatusDefinition(issue, configuration)
    : undefined)
  const category = resolvedStatus?.category ?? (issue
    ? resolveWorkflowStatusCategory(issue)
    : 'backlog')
  const label = resolvedStatus?.name ?? (issue
    ? resolveWorkItemWorkflowStatusLabel(issue, configuration)
    : '')

  return (
    <span className={resolveWorkflowCategoryToneClassName(category)}>
      {label}
    </span>
  )
}

function IssueCustomFieldSummary({
  configuration,
  issue,
  locale,
  personLabels,
}: {
  /** Custom field definition を含む configuration です。 */
  configuration?: WorkItemConfiguration
  /** 表示対象 Issue です。 */
  issue: TeamIssue
  /** 値の format locale です。 */
  locale: Locale
  /** Person field ID を表示名へ解決する map です。 */
  personLabels: Readonly<Record<string, string>>
}) {
  const values = resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)

  if (values.length === 0) {
    return null
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {values.slice(0, 2).map(({ definition, value }) => (
        <span
          className="workbench-badge max-w-full truncate"
          key={definition.id}
          title={`${definition.name}: ${value}`}
        >
          {definition.name}: {value}
        </span>
      ))}
      {values.length > 2 ? (
        <span className="workbench-badge">+{values.length - 2}</span>
      ) : null}
    </div>
  )
}

function IssuePriorityBadge({ priority, t }: { priority: WorkItemPriority; t: (key: MessageKey) => string }) {
  const classes: Record<WorkItemPriority, string> = {
    high: 'workbench-badge-danger',
    low: 'workbench-badge-success',
    medium: 'workbench-badge-warning',
  }

  return (
    <span className={classes[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

function resolveIssueCustomFieldEntries(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  if (!configuration) {
    return []
  }

  const t = createTranslator(locale)

  return sortCustomFieldDefinitions(
    resolveWorkItemTypeCustomFields(configuration, issue.workItemTypeId),
  ).flatMap((definition) => {
    const value = issue.customFieldValues?.[definition.id]

    if (
      value === undefined ||
      !isCustomFieldApplicable(definition, issue.assignedProjectId)
    ) {
      return []
    }

    return [{
      definition,
      value: formatWorkItemCustomFieldValue(issue, definition, {
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

function resolveIssueCustomFieldSearchValues(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  return resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)
    .flatMap(({ definition, value }) => [definition.name, value])
}

/**
 * Identifies the canonical relation graph conflict returned by relation persistence.
 *
 * @param error - Unknown relation mutation failure.
 * @returns Whether the failure invalidated the retained relation graph revision.
 */
function isWorkItemRelationGraphConflict(error: unknown): boolean {
  return error instanceof WorkItemConfigurationApiError &&
    error.code === 'WorkItemRelationGraphConflict'
}

/**
 * Matches the localized and formatted display values exposed by the Team Issue surface.
 *
 * @param issue - Team Work Item evaluated by keyword filtering.
 * @param normalizedKeyword - Trimmed lower-case keyword from the active task view.
 * @param team - Active Team directory entry used to resolve Project names.
 * @param configuration - Team workflow and custom-field configuration.
 * @param locale - Locale used to format typed custom-field values.
 * @param personLabels - Person identities mapped to display labels.
 * @param t - Translator used for priority, schedule, and fallback labels.
 * @returns Whether any Team-visible display value contains the keyword.
 */
function matchesTeamIssueKeyword(
  issue: TeamIssue,
  normalizedKeyword: string,
  team: ProjectDirectoryTeam | undefined,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
  t: (key: MessageKey) => string,
): boolean {
  return [
    resolveIssueTitle(issue, t),
    resolveWorkItemAssignee(issue),
    resolveAssignedProjectName(issue, team, t),
    resolveWorkItemWorkflowStatusLabel(issue, configuration),
    resolveWorkItemTypeLabel(issue, configuration),
    t(`tasks.priority.${issue.priority}`),
    issue.dueDate,
    issue.schedule ? describeTeamIssueSchedule(issue.schedule, t) : '',
    ...resolveIssueCustomFieldSearchValues(
      issue,
      configuration,
      locale,
      personLabels,
    ),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedKeyword))
}
