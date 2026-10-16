import type {
  TaskViewScope,
  WorkItemRelation,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  type CurrentUser,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../../auth/session'
import { aiAssistanceUiEnabled } from '../../features/ai-assistance/model/aiAssistanceRollout'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { type FileArtifactScope, useFileArtifacts } from '../../files/mutations/useFileArtifacts'
import { createTranslator, getInitialLocale, type Locale } from '../../shared/i18n/i18n'
import {
  createTeamIssue,
  TeamIssuesApiError,
  type CreateTeamIssueInput,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../../issues/api'
import { useTeamIssueDetail, useTeamIssues } from '../../issues/queries/useWorkItems'
import { useIssueCollaboration } from '../../issues/mutations/useIssueCollaboration'
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
import {
  createWorkItemDependencyMutationController,
} from '../../planning/mutations/createWorkItemDependencyMutationController'
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
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { useOptionalWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { createWorkItemRelation, deleteWorkItemRelation } from '../../work-items/api'
import { useWorkItemConfiguration } from '../../work-items/queries/useWorkItemConfigurations'
import { type WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import {
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
  resolveConfiguredWorkflowStatuses,
  resolveWorkItemTypeWorkflowStatuses,
} from '../../work-items/model/workItemDisplay'
import {
  createBuiltInTaskViewDefinition,
  filterTaskViewAudienceTeams,
  presentationSettingsToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
  taskViewDefinitionToTeamState,
  teamStateToTaskViewDefinition,
} from '../../task-views/model/taskViewSurfaceState'
import { preserveTaskViewUrlState } from '../../task-views/model/taskViewUrlState'
import { useTaskViewController } from '../../task-views/mutations/useTaskViewController'
import { canWriteTaskViewWorkItem } from '../../task-views/model/taskViewWorkItemPermission'
import { TaskViewToolbar, type TaskViewFieldOption } from '../../task-views/ui/TaskViewToolbar'
import {
  createTaskViewOption,
  formatTaskViewMigrationWarning,
} from '../../task-views/ui/taskViewToolbarAdapter'
import { TeamIssueScreen } from '../../issues/ui/TeamIssueScreen'
import { emptyWorkspaceMembers } from '../../issues/ui/teamIssueScreenShared'

const emptyTeams: ProjectDirectoryTeam[] = []

const emptyIssues: TeamIssue[] = []

const emptyMembers: ProjectMember[] = []

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

/** Resolves the selected Team Issue using the same trimmed membership fallback as the screen. */
function resolveTeamIssueSelectionId(issues: readonly TeamIssue[], requestedIssueId?: string) {
  const trimmedIssueId = requestedIssueId?.trim()
  return trimmedIssueId && issues.some((issue) => issue.id === trimmedIssueId)
    ? trimmedIssueId
    : issues[0]?.id
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
  const commentDraftDirtyRef = useRef(false)
  const commentDraftDirtyScopeRef = useRef<string | undefined>(undefined)
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
  const resolvedSelectedIssueId = resolveTeamIssueSelectionId(issues, requestedIssueId)
  const resolvedSelectedIssue = issues.find((issue) => issue.id === resolvedSelectedIssueId)
  const commentDraftPrincipalKey = user?.username ?? user?.attributes.email ?? ''
  const commentDraftWorkspaceKey = user?.attributes['custom:workspace_id'] ??
    user?.attributes['custom:directory_id'] ?? ''
  const commentDraftScopeKey = JSON.stringify([
    teamId,
    resolvedSelectedIssueId ?? '',
    commentDraftPrincipalKey,
    commentDraftWorkspaceKey,
  ])
  const [commentDraftDirtyState, setCommentDraftDirtyState] = useState({
    isDirty: false,
    scopeKey: commentDraftScopeKey,
  })
  const isCommentDraftDirty = commentDraftDirtyState.isDirty &&
    commentDraftDirtyState.scopeKey === commentDraftScopeKey
  const navigationBlocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!getAuthSession() || !commentDraftDirtyRef.current ||
      commentDraftDirtyScopeRef.current !== commentDraftScopeKey) return false
    if (currentLocation.pathname !== nextLocation.pathname) return true
    const nextIssueId = resolveTeamIssueSelectionId(
      issues,
      new URLSearchParams(nextLocation.search).get('issueId') ?? undefined,
    )
    return nextIssueId !== resolvedSelectedIssueId
  })
  /** Reports comment input only while its exact Team Issue scope is current. */
  const reportCommentDraftDirty = useCallback((isDirty: boolean, issueId = resolvedSelectedIssueId) => {
    const reportedScopeKey = JSON.stringify([
      teamId,
      issueId ?? '',
      commentDraftPrincipalKey,
      commentDraftWorkspaceKey,
    ])
    if (reportedScopeKey !== commentDraftScopeKey) return
    commentDraftDirtyRef.current = isDirty
    commentDraftDirtyScopeRef.current = commentDraftScopeKey
    setCommentDraftDirtyState({ isDirty, scopeKey: commentDraftScopeKey })
  }, [commentDraftPrincipalKey, commentDraftScopeKey, commentDraftWorkspaceKey, resolvedSelectedIssueId, teamId])
  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return
    if (window.confirm(createTranslator(locale)('collaboration.composer.discardConfirm'))) {
      reportCommentDraftDirty(false)
      commentDraftDirtyScopeRef.current = undefined
      navigationBlocker.proceed()
    } else {
      navigationBlocker.reset()
    }
  }, [locale, navigationBlocker, reportCommentDraftDirty])
  /** Confirms a local Issue selection before the action registry mutates focus or ownership. */
  const confirmCommentDraftIssueChange = useCallback((nextIssueId: string) => {
    if (!commentDraftDirtyRef.current ||
      commentDraftDirtyScopeRef.current !== commentDraftScopeKey ||
      nextIssueId === resolvedSelectedIssueId) return true
    if (!window.confirm(createTranslator(locale)('collaboration.composer.discardConfirm'))) {
      return false
    }
    reportCommentDraftDirty(false)
    commentDraftDirtyScopeRef.current = undefined
    return true
  }, [commentDraftScopeKey, locale, reportCommentDraftDirty, resolvedSelectedIssueId])
  useEffect(() => {
    if (!isCommentDraftDirty) return
    /** Protects a dirty comment draft from browser-level navigation while authenticated. */
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!getAuthSession()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [isCommentDraftDirty])
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
      onBeforeSelectIssue={confirmCommentDraftIssueChange}
      onCommentDraftDirtyChange={reportCommentDraftDirty}
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
      key={JSON.stringify([teamId, commentDraftPrincipalKey, commentDraftWorkspaceKey])}
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

/** Resolves the normalized directory key used to match the current user to Project roles. */
function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}
